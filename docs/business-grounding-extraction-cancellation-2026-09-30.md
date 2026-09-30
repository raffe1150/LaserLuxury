# Grounding extraction deadline and cancellation audit — 2026-09-30

## Outcome and limits

Implemented real deadline cancellation for OpenAI generation, including grounding extraction and entailment. Timed-out queued requests are removed before execution; timed-out running HTTP requests are aborted and release their queue slot once the SDK settles. The failed result stays failed. No timeout, model, prompt, evidence source or grounding safety rule was changed.

**This fixes abandonment/cancellation, not the underlying extraction speed.** The supplied production evidence establishes a 21,422 ms execution versus a 20,000 ms deadline, with zero queue wait. It does not establish the provider-internal reason for that duration. No live OpenAI key is available in the permitted hotfix environment, so repeated live latency measurements, output/reasoning token usage, and an exact server-processing/transfer breakdown remain unavailable. The six-run measurements below use simulated transport latency through the actual SDK and server grounding path. They are not live-model performance claims.

## 1. Proven extraction bottleneck

The exact late run stopped in `business_support_grounding_verification`: extraction had not produced an assessment before the deadline, so no claim entailment could begin. The claim cache cannot help when no assessment exists. The application had already sent its safe partial catalog response when the provider request finally completed approximately 1,422 ms late.

The execution diagnostic encompasses the SDK request, full response/body decoding and adapter normalization. It is not a measurement of model computation alone. Existing production diagnostics do not provide response headers, first byte, output/reasoning token counts, or parse timings. Consequently neither reasoning effort, output volume, input size nor network delay can be identified as the exact cause of the provider's 21.422 seconds from this evidence. Claiming one would be speculation.

## 2. Exact request path and configuration

`guardBusinessSupportGrounding` → snapshot → `assessBusinessSupportGrounding` → `generateContentWithFallback` → `runAiProviderRequest` → AI queue → `generateWithConfiguredProvider` → OpenAI adapter → `client.responses.create` → SDK JSON decoding → `parseBusinessGroundingAssessment`.

| Item | Current behavior, unchanged |
|---|---|
| Model supplied by extractor | `gemini-2.5-flash`, an existing shared call-site identifier |
| Effective OpenAI model | Router clears that Gemini identifier; adapter selects `OPENAI_MODEL`, otherwise `gpt-5.6-luna` |
| Model in local SDK reproduction | `gpt-5.6-luna`; the newest supplied timing record does not identify its live model, so the current production env value is unverified |
| Instructions | One `instructions` string, 2,371 characters in the initial extraction |
| Explicit system/developer input items | None; instructions use the Responses instruction parameter |
| User input | One `{role:"user", content:JSON.stringify(...)}` item |
| User JSON fields | `customerMessage`, `candidateReply`, `groundingEvidence`; repair passes additionally include `previousAssessment` |
| Initial local user content | 6,645 characters |
| Initial local instruction + user content | 9,016 characters, before and after |
| Initial local candidate/evidence | 393 / 5,657 characters |
| Supplied latest production candidate/evidence | 281 / 5,847 characters; contents/escaping were not provided, so total serialized live input cannot be measured exactly |
| Tokens | Not measured; no matching local tokenizer/live input-token result is available. Character counts are not token counts |
| Output limit | No explicit `max_output_tokens` |
| Reasoning/effort | No explicit `reasoning` or effort setting; effective provider default is not measured |
| Structured output | No API `text.format` / JSON schema or JSON mode; the prompt requests JSON and the local parser validates its shape |
| Tools | None |
| Streaming | Not enabled. Responses supports streaming, but partial JSON cannot authorize a grounded answer |
| SDK retries/timeout | `maxRetries:0`; installed SDK default HTTP timeout is 600,000 ms, independent of the application's 20,000 ms deadline |

The requested JSON contains `hasBusinessFactualClaims`, `allBusinessClaimsSupported`, and atomic claims with `claim`, `candidateQuote`, `claimKind`, `requiresBusinessEvidence`, `supported`, and exact source/quote evidence citations. This data remains unchanged. Independent entailment remains mandatory after exact local citation and coverage checks.

By default Responses delivers the full generated result, while `stream:true` permits incremental events. Streaming was not enabled here: it would allow earlier observability, but does not prove that complete validated extraction would arrive faster. [Official streaming documentation](https://developers.openai.com/api/docs/guides/streaming-responses).

## 3. Cancellation root cause and available SDK behavior

Previously `runAiProviderRequest` raced a timeout against the queued provider promise. Rejecting the timeout did not cancel its competing promise. No AbortSignal reached `responses.create`. The queue retained timed-out waiters and running slots until the original job finished.

The installed OpenAI SDK exposes `RequestOptions.signal`, accepts it as the second argument to `responses.create`, and bridges it to the fetch AbortController. Aborting interrupts the HTTP request/body read. Verified with both the real SDK plus a controlled transport and an actual loopback HTTP server plus native Node fetch.

The API's separate response-cancel endpoint applies only to background responses. This request uses foreground Responses, so the repair uses HTTP AbortSignal cancellation and does not change it into a background job. It does not claim a measured server-side compute/billing cancellation guarantee. [Official response cancellation reference](https://developers.openai.com/api/reference/go/resources/beta/subresources/responses/methods/cancel).

## 4. Minimal repair

- Reliability creates a fresh AbortController per attempt only when `cancelOnTimeout` is enabled. Its deadline rejects with TIMEOUT first, then aborts. Abort cannot turn the deadline into a retryable network error or late success.
- OpenAI generation enables that option and passes the attempt signal through the unified request and queue to the SDK's request options. Signal is never inserted into the JSON body, prompts or tools.
- The extracted queue reserves slots when admitting jobs, maintains FIFO waiters, removes aborted waiters, and checks abort again immediately before execution. Cancellation after admission but before the execution microtask also prevents the job from starting.
- A running slot is released in `finally` after the provider promise settles from abort. Slots are not prematurely released for a non-cooperative transport that ignores cancellation.
- Gemini does not enable cancellation and receives no new provider request fields. Shared queue plumbing retains its capacity/FIFO behavior and now reserves an admission before waking it, avoiding an admission race.

Scope is the shared generation boundary. Audio transcription/embedding implementations are untouched. Existing provider selection, key rotation, retry categories, maximum attempts and delay remain unchanged. There is no OpenAI→Gemini fallback. TIMEOUT remains non-retryable.

## 5. Evidence and prompt audit

The local verified tenant-3 snapshot breaks down as follows. This is an exact local measurement, not an invented allocation of the latest production run's 5,847 characters.

| Source | Local characters | Composition |
|---|---:|---|
| `business_system_prompt` | 3,307 | Existing factual-prompt extraction from the tenant's 4,543-character business prompt; FAQ/service/platform/turnaround/sample and broader business/workflow text |
| `structured_business_config` | 2,055 | Pretty-printed sanitized affirmative tenant configuration, including all six services with prices/durations/currency and other populated business fields |
| `verified_booking_state` | 6 | `(none)` in this business-information fixture; no verified booking facts |
| `retrieved_knowledge` | 158 | Tenant-3 source identifier plus its verified 110-character Knowledge text |
| Source labels and separators | 131 | Four source labels and source boundaries |
| **Total evidence corpus** | **5,657** | No source omitted |

The 190-character difference from the supplied production corpus cannot be assigned to particular sources without that run's full immutable snapshot. Runtime logs must not expose those contents.

Some broader business/workflow facts are unrelated to the two requested topics; that alone does not prove they are irrelevant to every candidate assertion or conflict. Repeated structural keys and repeated mentions of business/service concepts do not establish duplicate evidence: different values, source authority, source identity and citation boundaries matter.

No pruning was implemented. Removing repeated source text can change contiguous exact-citation opportunities or discard conflicting/contextual evidence. Minifying structured JSON changes exact quotes. Topic-based exclusion cannot prove coverage for every candidate claim. No byte-for-byte redundant source block with equivalent citation semantics was demonstrated for this snapshot.

The extraction prompt duplicates some later work: it asks for support decisions and complete exact citations, while deterministic code checks exactness/coverage and a later model independently checks entailment. Those checks serve separate gates. Extraction's support flags and exact candidate spans also determine repair and partial recovery; removing those instructions would alter the current safety/quality contract without proof of equivalent results. Independent entailment was retained.

Authoritative deterministic service catalog construction does not by itself prove every assertion in the final generated candidate, which can add or translate factual claims. **Catalog evidence remains verbatim** for extraction and later citation/entailment checks. No change to this behavior was made without the requested prior report.

## 6. Six-run before/after measurements

The exact German question and verified tenant-3 fixture were run through the real server guard, provider adapter, installed SDK and parsers. Only HTTP latency was simulated. Source baseline was `HEAD` (`f4f784b`) for server, reliability and provider files; the temporary bundled baseline was removed afterward.

Scale is **1/20**, including a test-only 1,000 ms deadline representing the unchanged 20,000 ms production deadline. No application timeout was increased. Request start, first response/first byte, transport completion and extraction parse completion were instrumented inside the offline test. Synthetic headers/first byte occur at transport completion in this benchmark; a separate test supplies early headers then aborts the unfinished body.

| Modeled provider latency | Before extraction completion (ms) | After extraction completion (ms) | Before total grounding (ms) | After total grounding (ms) | Calls before/after | Address result |
|---:|---:|---:|---:|---:|---:|---|
| 16,000 | 801 | 802 | 845 | 830 | 3 / 3 | grounded success |
| 18,000 | 904 | 902 | 934 | 929 | 3 / 3 | grounded success |
| 19,000 | 952 | 951 | 982 | 967 | 3 / 3 | grounded success |
| 19,500 | 976 | 976 | 999 | 990 | 3 / 3 | grounded success |
| 20,500 | 1,026, late | aborted at deadline | 1,007 | 1,003 | 1 / 1 | withheld |
| 21,422 | 1,072, late | aborted at deadline | 1,009 | 1,003 | 1 / 1 | withheld |

Before successful extraction parse completion: 804, 906, 954, 979 ms. After: 805, 905, 952, 977 ms. Timed-out extraction reaches no grounding parse or entailment, before or after. Four of six simulated extractions finish within the scaled deadline; two correctly fail closed in both versions. Successful paths still make one extraction plus two independent entailment calls.

Input size remains **9,016 characters** total / **5,657 evidence characters**, before and after. Successful latency is effectively unchanged; small measured differences are test/runtime variance, not demonstrated model speed gains. The repair eliminates late transport completion for timed-out requests. It cannot make the supplied 21.422-second extraction produce a grounded address within 20 seconds.

A separate regression uses the actual **20,000 ms** application deadline, asserts transport abort, and retains the catalog while withholding the address. The loopback HTTP test verifies that an actual unfinished response body connection closes and the queue slot becomes available.

## 7. Safety and tests

Unchanged: factual coverage, exact source/candidate quote checks, independent entailment, contradictions/unsupported filtering, tenant isolation, per-turn result reuse, compound partial recovery, recommendations, semantic retrieval, tool schemas, temperature compatibility, models and booking behavior. Late output cannot become success; failures are not cached as entailment evidence.

Added nine tests:

- Five queue/reliability tests: abandoned FIFO work, running abort/slot release and no retry, non-cooperative late completion, abort after admission/capacity reservation, fresh retry signals/default behavior.
- Three SDK/server integration tests: extraction cancellation with three occupied slots and secret-safe diagnostics/no Gemini fallback; cancellation after headers during body consumption; six-run latency/input/parse distributions with independent entailment on successful paths.
- One real SDK/native fetch/loopback HTTP test: unfinished body connection closes and its slot is released.

Updated two timing regressions to require transport abort and no abandoned queued execution; updated two existing provider source-contract assertions for the new signal argument. Existing catalog/address, contradictions, fabricated evidence, recommendations, tenant isolation and reuse tests remain passing.

Results:

- Focused cancellation/queue/timing: **11/11 pass**; real HTTP loopback: **1/1 pass**.
- Broad grounding/compound/OpenAI/provider integration/reliability/queue/knowledge/WhatsApp regressions: **289/291 pass**. The two failures are the previously reproduced HEAD failures in `channel-reliability.test.ts` (source-proximity regex) and `whatsapp-swedish-tomorrow-regression.integration.test.ts` (selected-date assertion).
- Targeted provider/reliability/queue TypeScript: pass. Server-inclusive comparison: **16 existing diagnostics before and after; zero introduced**.
- `npm run build`: pass, existing bundle-size warning.
- `git diff --check`: pass.

## 8. Files and operational confirmation

Changed: `server.ts`, `src/ai/reliability.ts`, `src/ai/providers/provider.ts`, `src/ai/providers/openai.ts`, `src/ai/business-grounding-timing.integration.test.ts`, `src/ai/providers/server-integration.test.ts`.

Added: `src/ai/request-queue.ts`, `src/ai/request-queue.test.ts`, `src/ai/business-grounding-cancellation.integration.test.ts`, `tests/openai-cancellation-loopback.ts`, this report.

All work is in `/Users/raffe/Documents/OdinLink/.production-hotfix`. No commit, push, deployment, Render setting change or timeout increase. No changes to protected diagnostics, model/provider configuration, prompt/evidence content, booking, retrieval, temperature compatibility, tool schemas or key rotation.

Remaining required evidence for a verified extraction-speed repair: an authorized local OpenAI key, the effective production model, and sufficiently repeatable live measurements with response/usage timing. The absence of that evidence is reported rather than replaced with a guessed latency fix.
