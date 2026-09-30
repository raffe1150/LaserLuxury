# Business grounding timeout audit — 2026-09-30

## Status

The exact failed assessment and its deadline are established. The historical
logs do **not** establish whether queue waiting or provider execution exhausted
that deadline. Both causes were reproduced locally through the actual tenant-3
grounding path. No production latency fix is claimed. This patch adds the
permitted temporary diagnostics needed to distinguish the causes; it changes
no timeout, model, request payload, retry policy, queue policy, or safety decision.

## Production evidence

Read-only Render logs for September 30, 16:10–16:13:30 Europe/Stockholm show:

- Conversation generation completed at 16:11:48, attempt 1, elapsed 4,105 ms,
  correlation `b566066a-3e6c-4908-b628-6b115a2df57e`.
- The following no-tools assessment ended at 16:12:08, attempt 1, TIMEOUT,
  elapsed **20,000 ms**, stage `business_support_grounding_verification`,
  business 3, correlation `84ffa1bf-8bbc-45f1-9a6b-e99bf5dbddee`.
- Candidate length was **314 characters**; evidence corpus length **5,847**.
  The assessment was absent, so no claims reached entailment verification.
- WhatsApp delivery succeeded at 16:12:09.

These are lengths, not token counts. They do not demonstrate an unusually large
prompt or establish prompt size as the latency cause. The logs contain no
provider-start timestamp, queue-wait measurement, or late-completion timestamp.
They therefore cannot distinguish a provider that used 20 seconds from a request
that spent its budget waiting for a slot. Mock latency cannot establish what
happened at OpenAI for the historical request.

## Exact code path and budgets

`guardBusinessSupportGrounding` creates the snapshot and calls
`assessBusinessSupportGrounding` for extraction. That function invokes
`generateContentWithFallback` with stage `business_support_grounding_verification`.
The unified request goes through `runAiProviderRequest` → `runWithAiQueue` →
`generateWithConfiguredProvider` → model normalization → `generateWithOpenAi` →
`client.responses.create`. Only after an assessment passes local coverage and
exact-citation checks does `assessmentClaimsAreEntailed` call
`assessBusinessClaimEntailment`, using the same wrappers with stage
`business_support_grounding_entailment`.

| Layer | Effective behavior, unchanged by this patch |
| --- | --- |
| General generation | `AI_PROVIDER_TIMEOUT_MS`, default 20,000 ms, clamped to 1,000–60,000 ms; invalid values use 20,000 ms |
| Grounding extraction | Same general budget; observed production attempt was 20,000 ms |
| Claim entailment | Same general budget; no dedicated override |
| Reliability attempt | Timer begins **before queue acquisition**, so wait and execution share the budget |
| Reliability retry | At most two attempts; 500 ms delay for NETWORK, RATE_LIMIT, PROVIDER_UNAVAILABLE; TIMEOUT never retries |
| Queue | Shared concurrency, default 3 unless overridden; no separate wait deadline/cancellation |
| OpenAI SDK | `maxRetries: 0`; adapter does not set timeout, so installed SDK default is **600,000 ms** |

The SDK default is confirmed in the installed `openai/client.js`, not guessed
from an error category. The application Promise.race does not cancel its losing
provider promise or remove its queued callback. A timed-out running job can keep
a slot until the SDK settles; a timed-out queued job can later start. This is a
confirmed structural latency risk, **not proof of the incident's cause**.

There is no shared per-turn deadline in these wrappers. Each subsequent request
gets a fresh budget. Long-lived timed-out jobs can nevertheless starve later
requests of shared queue slots.

## Call counts and order

Counts are unchanged before and after this diagnostic patch:

- Reported failure: one extraction attempt; zero entailment calls; no timeout
  retry and no quote-repair pass because there is no assessment. The
  post-retrieval path logs one conversation generation plus this one assessment.
  Retrieval/planning/embedding operations are outside this count.
- Valid two-claim catalog+location reply: one extraction, then two independent
  entailment calls in parallel (`Promise.all`), subject to queue capacity.
  Three verifier requests, or four including conversation generation.
- Conditional repairs may reprocess extraction when quotes are invalid.
  UNKNOWN/NEUTRAL entailment permits one further check and conditional
  adjudication; partial recovery may verify filtered claims again. These
  branches did not cause the initial extraction timeout. No unproven caching,
  consolidation, or removal of these safety checks was introduced.

## Temporary diagnostics

`[BusinessSupportVerifierTiming]` is emitted only for OpenAI grounding extraction
and entailment. Stage suffixes identify `provider_start`, `provider_complete`,
`attempt_complete`, or `attempt_timeout`. Fields are limited to stage,
correlation ID, business ID, elapsed ms, queue wait ms, provider execution ms,
attempt, candidate/evidence lengths, claim count when known, and timeout budget.

On timeout, `providerExecutionMs: null` means the request has not acquired a
slot. A numeric execution time separates wait from execution. Late start and
completion use the original correlation and attempt, exposing work continuing
after the application has already rejected it. No prompt, customer text,
Knowledge, evidence text, key, header, tool argument, or raw provider error is
logged by this diagnostic. Existing diagnostic blocks remain unchanged.

## Local reproduction and safety

Three new tests use the existing verified tenant-3 fixture and actual extraction,
local evidence checks, entailment decisions, and partial recovery. Only the SDK
transport is mocked; the address is derived from the fixture, not hardcoded.

1. An assessment with 1,200 ms mocked latency followed by independent 500 ms
   entailment calls preserves catalog and address. Exactly one extraction and
   one call per claim occur; the entailment calls overlap. This is a bounded
   latency regression, not a measurement of live OpenAI performance.
2. A 20,100 ms assessment reproduces the production **20,000 ms** application
   timeout. No retry or entailment occurs, no unverified address is emitted, and
   the supported catalog survives. Late provider completion is measured without
   altering the already-returned reply.
3. Three held queue slots reproduce an assessment timing out before any SDK
   extraction starts. A test-only 1,000 ms deadline scales this case. Releasing
   the slots proves the existing queue starts the abandoned job later. The
   returned catalog remains safe and the address remains absent.

All new timing events are checked against an exact field allowlist and against
private-content/key sentinels. Existing secret-safe OpenAI failure diagnostics
are also rerun. Verification, unsupported-claim filtering, recommendations,
tenant isolation, routing, lexical fallback, and temperature compatibility are
unchanged.

## Validation and diff

The combined grounding/entailment, compound business-info, OpenAI provider,
provider integration, reliability, knowledge, and WhatsApp suite finished with
**271 passed / 2 failed / 273 total**. All three new regressions passed.
The failures are existing baseline assertions:

- `whatsapp-swedish-tomorrow-regression.integration.test.ts:117`: awaiting_contact
  selectedDate is undefined rather than `2026-08-31`.
- `channel-reliability.test.ts`: a source-pattern assertion expects
  `shouldReturnWhatsAppAmbiguousClarification` to be followed within 200 characters
  by `formatAmbiguousBookingIntentClarification`.

Both failures were reproduced against unchanged HEAD server source. An initial
unrestricted-concurrency suite run was stopped after heavy local resource
pressure; the completed run used two workers and the same test coverage.

Targeted provider and reliability TypeScript passed. The server-inclusive compiler-host comparison
reports the same 16 baseline diagnostics and zero introduced errors.
The build passed with the existing bundle-size warning.

Changed files: `server.ts` (timing hooks and numeric metadata only),
`src/ai/business-grounding-timing.integration.test.ts` (three regressions), and
this report. No adapter, retrieval, booking/contact logic, compound recovery,
named diagnostic block, model selection, or prohibited patch script changed.

The production cause remains unresolved until an actual failing or completing
request supplies the new timing split. If wait dominates, queue cancellation or
separate wait/execution budgets can be evaluated. If execution dominates, its
actual completion duration and request characteristics are needed to justify a
bounded verifier-specific change. Neither is selected on speculation.

Work stayed in `.production-hotfix`; the dirty main worktree and Render settings
were not modified. Nothing was committed, pushed, or deployed.
