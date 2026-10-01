# Business-information latency and compact RTL catalog audit

Worktree: `/Users/raffe/Documents/OdinLink/.production-hotfix`.
Base: `33a79bd` — Fix Arabic contact and shared RTL catalog.
Status: local, uncommitted changes; no push, deployment, or production messages.

## Evidence and limits

The exact cause of the reported approximately 180-second live Arabic delay remains **open**. There are no correlated timing logs for that request. Its eventual valid response does not identify the expensive stage, prove the live retrieval contents, or prove that a configured `address` field existed. No production requests were made during this investigation.

The local investigation proves unnecessary work in the shared production path, including when facts are already directly configured. It also proves that recovery could repeat the identical failed entailment request. These are fixed without attributing the entire live delay to them.

The saved tenant-3 test fixture contains Aurora Street 742 in retrieved Swedish prose. Tests separately add an explicit business-owned `address` to exercise the existing direct-trust rule. Retrieved prose does not inherit that direct trust.

## Runtime path and call counts

Before: inbound channel handler loads configuration/history, resolves conversation language, loads pending booking state, recognizes the business-information turn, asks the semantic retrieval planner, searches lexical and semantic knowledge concurrently, generates a candidate, extracts factual claims, verifies atomic claims concurrently, possibly repairs/rechecks/adjudicates or recovers, applies response guards/concision, resolves assistant identity, and hands text to the channel sender. Message post-processing follows delivery.

The configured address was previously usable through `recoverUnavailableBusinessLocation`, but only after the normal candidate/verification graph. Configured facts could therefore wait for work that did not establish their trust.

After: the same language/state and business-information gates run. A conservative whole-question check accepts only plain services-plus-location requests. Extra questions, recommendations, booking instructions, and unrecognized wording retain the full existing path.

- With an own configured catalog and explicit own `address`, render those facts using the existing formatter and direct-trust rule; skip retrieval, candidate generation, and verification.
- With an own catalog and a retrieved address candidate, use the existing independent location entailment gate once, with complete retrieved/configured/prompt sources. Only `ENTAILED` with `claimKind: OTHER` allows the address. Timeout, provider failure, inconclusive, contradiction, or negative-absence output yields the configured catalog and the existing verification-unavailable notice.
- With no eligible address evidence, keep the full existing safe grounding path. A provider candidate cannot supply a trusted address.
- The existing guards/concision and shared channel send callbacks still run. Pending booking state remains available for the next turn.

The whole-question gate covers EN/SV/DE/ES/AR/FA with the same trust decisions. It is deliberately conservative rather than treating recognized topic words as proof that no other factual request exists.

Measured SDK request counts for the same deterministic two-claim fixture:

| Scenario | Retrieval planner | Conversation generation | Claim extraction | Entailment | Total AI requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before, configured or retrieved address | 1 | 1 | 1 | 2 | 5 |
| After, explicit configured address | 0 | 0 | 0 | 0 | 0 |
| After, independently verified retrieved address | 1 | 0 | 0 | 1 | 2 |

These counts exclude embedding/search implementation calls and any unchanged semantic language-classifier call. The fixtures use deterministic language resolution. Before, and after for retrieved facts, there is one semantic search and 7 lexical searches (EN/SV/DE/ES) or 8 (AR/FA), concurrently. Configured facts now use none. The lexical count difference comes from query wording/deduplication, not an Arabic serial provider path.

On the retained full grounding path, an injected failed-transport case previously made 1 extraction plus 4 entailment calls; it now makes 1 extraction plus 3. The identical failed atomic check is reused as an **unavailable status**, never as a factual verdict. Distinct independent recovery checks remain allowed. A fresh turn creates a fresh map and can verify again.

## Deterministic timing evidence

Baseline tests used the HEAD server source copied inside this worktree. Each mocked SDK request waits 10 ms; searches wait 5 ms concurrently. Twelve baseline cases passed. The actual provider request order was planner → conversation → extraction → two parallel entailments. No live network was used.

Representative measured stage times from the focused run, in milliseconds:

| Case | Language | Retrieval/state path | Candidate | Grounding | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Arabic retrieved, before | 1 | 18 | 11 | 28 | 59 |
| Arabic retrieved, after | 3 | 45, including retrieval and narrow grounding | skipped | included | 49 |
| English retrieved, before | 0 | 18 | 11 | 29 | 58 |
| English retrieved, after | 0 | 29, including retrieval and narrow grounding | skipped | included | 29 |
| Swedish configured, before | 1 | 17 | 11 | 30 | 59 |
| Swedish configured, after | 0 | 1 | skipped | direct configured trust | 1 |

The Arabic after trace separately recorded retrieval 24 ms and independent grounding 12 ms. Local startup/JIT, test concurrency and event-loop overhead vary: the first configured Arabic case took 98 ms despite zero AI/search calls. These timings are local diagnostics, not production latency promises. The stable evidence is removal of provider/search work and identical failed waits.

Existing provider behavior is preserved: default per-attempt deadline 20,000 ms, environment clamp 1,000–60,000 ms; timeout is not retried; retryable transport/rate/provider-unavailable failures retain their existing attempt/backoff rules. Queue cancellation and OpenAI abort handling already existed. There is no newly imposed or increased timeout. Serial stages can each have their own deadline on the retained full path; this is a potential live contributor, not proof of the reported incident.

## Temporary correlated diagnostics

Business-information turns get an opaque `businessInfoTurnId`, business ID, and truncated question hash. The bounded, expiring diagnostic map stores no customer text, recipient, credentials, evidence, or factual verdict. Non-information turns clear their diagnostic entry.

- `[BusinessInformationTiming]`: received at language preparation, language completion, intent/state readiness, retrieval start/end, grounding start/end, response readiness, response dispatch handoff/end, actual channel HTTP handoff/end.
- `[KnowledgeRetrieval]`: parent turn ID plus total, query-planning and search duration, retaining existing source diagnostics.
- `[AIRequest]`: parent turn ID, request correlation ID, provider queue wait and execution duration.
- `[BusinessInformationProviderTiming]`: provider-start event distinguishes queue time from actual execution.
- `[BusinessSupportVerifierTiming]`: same parent turn ID on existing verifier attempt/timeout diagnostics.
- Delivery completion includes HTTP status and success, without payloads or recipients. It measures HTTP response completion, not the customer's device receipt.

`response_dispatch` surrounds the send callback on the early path, while actual `delivery` surrounds only HTTP. Their gap can expose assistant-identity lookup/preparation before HTTP. On the full path, grounding completion and delivery handoff expose that gap. Configuration/history loading before language preparation is outside this trace; capture the inbound webhook timestamp too. Post-processing is after sending and cannot account for a reply already handed off to the provider.

## Compact RTL representation and shared delivery

Previous output used five lines per service: name, duration label, duration, price label, price. It avoided interleaving but was unnecessarily heavy. The shared formatter now uses two lines, with a blank line between services:

Arabic, visible text:

```text
• Video Consultation
  60 min, 300 SEK
```

Persian, visible text:

```text
• Video Consultation
  60 min, 300 SEK
```

The formatter follow-up uses the literal `min` for both Arabic and Persian, with one LRI/PDI pair around the entire comma-separated metadata line. Duration, price and currency come deterministically from the configured service record; currency is neither inferred nor converted, and SEK is not hard-coded. EUR, USD and other configured codes are preserved. The stored service name has its own line. Names, numeric values, currency, service order and existing catalog limit are unchanged. Missing values are omitted, not invented. EN/SV/DE/ES formatting is unchanged.

The prior offline Chromium visual/geometry check covered the earlier localized two-segment layout. The follow-up replaces that layout with a single fully LTR metadata segment. Updated deterministic formatter and adapter tests cover its exact structure and currencies; actual messaging-client screenshots still require validation.

Shared path: `formatConfiguredServiceRow` → configured catalog/recommendation formatter → shared business grounding/catalog normalization and final guards/concision → channel send callback → `sendCustomerMessage` → channel sender → plain-text JSON.

- WhatsApp: `sendWhatsAppMessage`, payload `text.body`.
- Messenger: `sendMessengerMessage`, payload `message.text`.
- Instagram: `sendInstagramMessage`, payload `message.text`.
- Telegram: `sendCustomerMessage` Telegram branch, payload `text`, no parse mode.

Adapters do not translate or independently format catalog facts. All eight AR/FA-by-channel tests assert exact content, breaks, controls, punctuation and mixed SEK/EUR/USD values after real adapter JSON serialization. Adapter edits are timing wrappers only; payload behavior is unchanged. Normalization removes duplicate compact catalog blocks and recognizes exact legacy five-line or localized two-line details only adjacent to their own configured service heading; unrelated factual headings and qualifiers survive.

## Files and regression coverage

Production files:

1. `server.ts`: early trusted catalog/location completion, operation-local unavailable-check reuse, and timing correlation/HTTP measurement at existing boundaries. These orchestration points reside in this file; no broad booking/provider refactor.
2. `src/ai/business-information.ts`: conservative compound-question coverage, compact shared AR/FA rows, and narrow catalog normalization.
3. `src/ai/business-information-timing.ts` (new): temporary bounded timing diagnostics.

Tests:

4. `src/ai/business-information-latency.integration.test.ts` (new): 23 cases covering six-language configured/retrieved call counts, stage timing/correlation/privacy, timeout/provider failure/inconclusive/contradictory/negative-absence output, unknown location, extra question exclusion, and all four channels' selected-state/name preservation.
5. `src/ai/business-grounding-reuse.integration.test.ts`: failed-call reuse, unavailable diagnostics, and fresh-turn retry safety.
6. `src/ai/rtl-service-catalog.test.ts`: two-line exact fields, service order, missing fields, control balance, shared recommendation formatting, duplicate/legacy normalization, unknown headings/qualifiers, unchanged LTR formatting.
7. `src/ai/rtl-service-catalog-channels.integration.test.ts`: eight adapter-preservation cases plus correlated successful HTTP delivery diagnostics.
8. `src/ai/business-verification-unavailable.integration.test.ts`: expected compact fields.
9. `src/ai/multilingual-compound-location.integration.test.ts`: independent entailment stub and early-completion expectations; full candidate grounding regressions remain exercised.
10. `src/ai/compound-business-information.integration.test.ts`: early-completion expectations with retained retrieval/tenant isolation checks.
11. This audit document.

## Validation and protected scope

- Baseline path comparison: 12/12 passed; failed-transport baseline comparison: 1/1 passed.
- Focused suite: **167/167 passed**, no failures, skips, or cancellations.
- Broader safe suite: **574/574 passed across 40 verified test files**, no failures, skips, or cancellations. Covers multilingual business information/location, unknown/negated/qualified facts, catalog deduplication, recommendation clarification, provider cancellation/routing, all current text adapters, booking completion/state/selected slots, Arabic/Persian names, authoritative WhatsApp phone and contact provenance. Four stale provider-test paths were corrected during final review; this result is from the corrected complete run.
- `npm run build`: passed; existing large-bundle warning remains.
- Business-information modules' TypeScript check: **0 diagnostics**.
- Server/transitive TypeScript comparison: **16 baseline, 16 current, 0 new diagnostics**.
- Repository `npm run lint` (`tsc --noEmit`): blocked by existing syntax errors in unchanged `patch_key_rotation.ts` at 47/94/99. That file is byte-identical to HEAD. A clean repository-wide typecheck is not claimed.
- `git diff --check`: passed, including checks of new files.
- Formatter-only follow-up: **92/92 focused tests and 580/580 broader regressions across 40 files passed**; build, business-information module TypeScript check (zero diagnostics), and whitespace checks passed. Updated only `business-information.ts`, the RTL formatter tests, RTL channel-preservation tests, the service-only formatter expectation in verification-unavailable tests, and this document. Existing latency, timing diagnostics, and Arabic name code are unchanged.

No timeout/model/provider routing, retrieval algorithm, booking availability, service matching, unsupported-service handling, Arabic name parsing, contact capture or phone precedence code was changed. The previous Arabic name fix and its runtime integration tests are preserved; its live completion remains unvalidated, not disproven. Catalog deduplication and six-language location safety pass. There is no globally bypassed verifier or candidate-derived trust.

AI Blackbox, dashboard, analytics and voice source files were untouched. All source changes are inside the production-safe worktree. The main checkout source/index was not edited. Temporary baseline/browser/compiler artifacts were removed; ignored local result logs remain for audit. Nothing was committed, pushed, deployed, or sent to production.

## Targeted live validation after separately authorized deployment

1. Capture inbound timestamp, outbound receipt timestamp, and all events sharing `businessInfoTurnId` for `مرحباً! ما الخدمات التي تقدمونها وأين موقعكم؟`. Repeat the same request and the equivalent English query. Identify queue, provider, retrieval, grounding, preparation or delivery time from the trace; do not infer it from the Blackbox receive deadline.
2. Confirm actual address provenance. With explicit configured catalog/address, expect no information-stage planner/generation/verifier calls. With retrieved prose, expect one planner and one independent location entailment, excluding embedding and any separate language classifier. Verify Aurora Street 742 appears once. Check an unknown-location tenant still emits no invented address.
3. Obtain Arabic and Persian catalog screenshots in WhatsApp and Telegram (or another current non-WhatsApp channel). Expect at most two logical lines per service, clear duration/price, exact stored names/order/SEK, no duplicates, and retained address. Check narrow devices' natural wrapping separately.
4. Then validate the preserved Arabic booking fix separately: select service/date/slot, supply `اسمي` plus a valid human name and diagnostic/channel/trailing-stress structure, and confirm one booking completion without another name prompt. Verify selected slot and authoritative WhatsApp phone. The latency failure did not reach this stage, so this validation remains necessary.

Recommended review scope is this exact 11-file diff. The 180-second incident and real-client visual acceptance remain pending correlated live validation. No commit is requested or created here.
