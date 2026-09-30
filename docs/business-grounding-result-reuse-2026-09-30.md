# Business grounding verifier reuse — 2026-09-30

## Finding and evidence

The tenant-3 German services/location request performed **11 AI verifier calls**, plus one preceding conversation generation. Queue wait was zero. The expensive extraction succeeded; the latency multiplication came from compound recovery restarting verification already completed against the same claim, candidate quote and cited evidence.

Read-only production Render logs for 19:22:45–19:23:31 CEST show three extracted claims: catalog, an additional structured factual claim, and location. Initial catalog and location results were ENTAILED; the additional claim remained UNKNOWN after an independent retry and adjudication. Consequently the full assessment failed entailment and entered partial compound recovery. Recovery rechecked both entailed claims and repeated the additional claim's entire three-call sequence. WhatsApp sent successfully afterward.

The additional claim is identified by fingerprint `72a9e1b044aa`; logs establish its structured source and lengths, not its full text. The local reproduction uses a fixture-derived service-price assertion to reproduce this UNKNOWN sequence; it does not claim that assertion is the verbatim production claim.

## Exact observed order after knowledge retrieval

Lengths below are diagnostic candidate/quote length and evidence length, in characters. Times identify starts except the conversation completion. The extraction's evidence is the full grounding snapshot; entailment receives only the claim's exact citations.

| # | Start CEST | Stage / purpose | Scheduling | Candidate | Evidence | Repeated information / safety necessity |
|---|---|---|---|---:|---:|---|
| 0 | completed 19:22:45 | conversation: generate candidate | before grounding | output 306; input not logged | not logged | Necessary draft; not a verifier |
| 1 | 19:22:45 | grounding extraction / coverage and citation assessment | sequential first | 306 | 5847 | Necessary; cannot replace independent entailment |
| 2 | 19:23:00 | initial catalog entailment | parallel with 3 and 4 | 219 | 700 | Necessary first semantic check |
| 3 | 19:23:00 | initial extra structured claim entailment | parallel with 2 and 4 | 32 | 138 | Necessary first semantic check |
| 4 | 19:23:00 | initial location entailment | parallel with 2 and 3 | 40 | 39 | Necessary first semantic check |
| 5 | 19:23:03 | extra claim UNKNOWN retry | after 3 | 32 | 138 | Deliberate independent check; preserved |
| 6 | 19:23:06 | extra claim adjudication | after 5 | 32 | 138 | Different adjudication instruction; preserved |
| 7 | 19:23:12 | catalog entailment in compound recovery | recovery loop, sequential | 219 | 700 | Duplicate of 2; reuse its completed verdict |
| 8 | 19:23:14 | extra initial entailment in recovery | after 7 | 32 | 138 | Duplicate of 3 |
| 9 | 19:23:18 | extra UNKNOWN retry in recovery | after 8 | 32 | 138 | Duplicate of 5 |
| 10 | 19:23:19 | extra adjudication in recovery | after 9 | 32 | 138 | Duplicate of 6 |
| 11 | 19:23:28 | location entailment in recovery | after 10 | 40 | 39 | Duplicate of 4 |

Extraction took 14,353 ms. Observed repeated extra-claim executions were approximately 3,999 ms, 1,441 ms and 9,338 ms; the repeated location execution was 1,514 ms. The second verification pass consumed approximately 18 seconds. The first pass's three initial claims already run in parallel; retry/adjudication are sequential dependencies.

Before: draft → extraction → parallel(catalog, extra initial→retry→adjudication, location) → sequential recovery(catalog, extra initial→retry→adjudication, location) → send.

After: draft → extraction → the same parallel first pass → recovery's exact-evidence checks and reuse of completed phase verdicts → send. The recovery's local safety decisions still run.

## Code path and minimal change

`guardBusinessSupportGrounding` builds one immutable snapshot, calls `assessBusinessSupportGrounding`, checks coverage and exact citations, then calls `assessmentClaimsAreEntailed`. Atomic checks call `assessBusinessClaimEntailment` → `generateContentWithFallback` → `runAiProviderRequest` → `runWithAiQueue` → configured provider/router → OpenAI adapter → `client.responses.create`.

`recoverCompoundBusinessInformation` previously called `assessmentClaimsAreEntailed` again for every individually exact-supported claim. The later filtered-claim recovery can do the same. Both now share an operation-local map with the initial assessment. There is no module-level cache or cache reachable by another turn.

The key is the exact serialized pair `[verificationPhase, BusinessClaimEntailmentRequest]`. The request includes business ID, customer question, language, workflow/service context, claim text/kind, candidate quote, ordered source/quote citations and adjudication mode. Different claim, candidate quote, evidence, context, business or phase cannot match. Snapshot lifetime is limited to one grounding invocation. Pending identical checks within a phase also coalesce.

Only parsed results are retained. Null results and rejected promises are evicted. UNKNOWN/NEUTRAL remain inconclusive and cannot authorize a fact; their completed initial/retry/adjudication results can be reused in the corresponding phase during recovery. The first UNKNOWN retry is still a separate provider execution, and adjudication is still a separate execution with its different instruction.

Context-sensitive derived decisions are **not** cached: exact candidate coverage, exact evidence, unsupported-claim filtering, negative/absence gates and single-claim address recovery conditions are evaluated again. Reuse stores the atomic semantic verdict only. The extractor's `supported` flag never replaces entailment.

Quote repair remains unchanged and runs when citation/coverage checks require it. Different repaired claim/citation inputs require fresh entailment. In this production trace there was no quote repair and no later filtered-claim recovery because compound recovery returned first. Recommendation behavior is unchanged.

## Counts and local measurements

| Scenario | Version | Extraction | Regular entailment | Repair/adjudication | Total verifier calls |
|---|---|---:|---:|---:|---:|
| Production-shaped three-claim UNKNOWN sequence | BEFORE | 1 | 8 | 2 | **11** |
| Same sequence | AFTER | 1 | 4 | 1 | **6** |
| Fully entailed catalog + location | before and after | 1 | 2 | 0 | 3 |
| Two-claim partial recovery | BEFORE | 1 | 4 | 0 | 5 |
| Same partial recovery | AFTER | 1 | 2 | 0 | 3 |

The two repair/adjudication calls in the production-shaped BEFORE count are adjudication calls; quote repairs are zero. Including unchanged conversation generation, the production-shaped post-retrieval graph falls from **12 to 7** AI calls.

The real server grounding path, tenant-3 verified fixture and exact German question were exercised with mocked OpenAI Responses latency. The fixture provides the current verified address; it is not hardcoded into runtime code. Local candidate/citation wording differs from the live candidate, whose contents were not logged. The graph and verdict sequence match the production diagnostics. This is not a new live production replay.

At one tenth of observed latency, isolated measurements against HEAD source and modified source were **4,995 ms BEFORE → 2,949 ms AFTER**, approximately **41% shorter**, with 11 → 6 verifier calls. The two-claim partial benchmark measured 2,408 → 1,859 ms. Baseline execution used a temporary bundled test with `HEAD:server.ts`; the temporary bundle was removed. Measurements do not change application timeouts.

## Evidence pruning and remaining latency

No extraction evidence pruning was implemented. Requested-topic detection alone cannot prove that every candidate assertion, workflow condition, price, negative claim or conflicting source remains covered. Full-snapshot extraction preserves the current quality and safety contract; semantic retrieval is untouched.

Extraction still took 14.353 seconds in production with 5,847 evidence characters; the first extra claim's retry/adjudication chain remained a further latency contributor. The optimization removes the duplicated recovery pass, not those necessary first-pass checks. It does not guarantee a reply within Blackbox's deadline, and post-change production latency is unmeasured. Actual transport failures remain fail-closed and can require fresh recovery verification; failed calls are not memoized as evidence.

General generation, extraction and entailment retain the same configured `AI_PROVIDER_TIMEOUT_MS` budget: default 20,000 ms, clamped to 1,000–60,000 ms. This production request recorded 20,000 ms. The reliability timer includes queue wait plus execution because it races the queue promise. There is no separate turn-wide grounding deadline. Reliability allows at most two attempts for rate-limit/provider-unavailable/network failures with 500 ms delay; TIMEOUT is not retried by that wrapper. Semantic UNKNOWN retry/adjudication is distinct from transport retry. Queue/retry semantics are unchanged.

## Tests and verification

Added ten actual-path OpenAI integration tests covering:

- Grounded tenant-3 German catalog/address and required independent entailment.
- Exact-result compound reuse and both call-count/latency benchmarks.
- Three-claim UNKNOWN→retry→adjudication sequence completed once per phase.
- Contradicted address rejection.
- Fabricated citation rejection before address entailment, with quote repair retained.
- In-flight identical request reuse and different exact evidence requiring fresh verification.
- Separate turns, sessions and businesses requiring fresh verification.
- Independent UNKNOWN retry and adjudication preserved.
- Timeout failures not cached, no unverified address, supported catalog retained.
- Recommendation catalog/clarification safety unchanged.

The SDK-level harness asserts unchanged OpenAI model, absence of tools/unsupported temperature, and fails if Gemini executes. Existing provider failure diagnostics, provider integration, grounding/timing, compound information, knowledge, recommendation, multilingual, WhatsApp and reliability regressions were also run.

Results: focused **10/10 pass**. Broad suite **281/283 pass**, with two pre-existing failures reproduced against HEAD: `channel-reliability.test.ts`'s source-proximity regex and `whatsapp-swedish-tomorrow-regression.integration.test.ts`'s awaiting-contact selected-date assertion. Neither failing behavior was modified.

Provider/reliability targeted TypeScript passes. Server-inclusive targeted TypeScript retains the same **16 existing diagnostics** as HEAD, with **zero introduced**. `npm run build` passes with its existing large-bundle warning. `git diff --check` passes.

## Files and scope

- `server.ts`: 43 insertions / 5 deletions; exact atomic verdict reuse and map threading only.
- `src/ai/business-grounding-reuse.integration.test.ts`: ten regressions and scaled latency measurement.
- This report.

No changes to semantic retrieval, models, provider selection, temperature compatibility, tool schemas, booking logic, protected diagnostic blocks or key rotation. No timeout was increased. Nothing was committed, pushed or deployed; no Render settings were changed.
