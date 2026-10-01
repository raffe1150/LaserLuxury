# Business verification failure fallback — 1 October 2026

Worktree: `/Users/raffe/Documents/OdinLink/.production-hotfix`.
Base: `f40e7e3394a5425e074d8dc6bb8b41ed6e48791f`.

## Outcome

Fixed the confirmed conversion of **verification unavailable** into **business fact unavailable**. A timeout, provider error or malformed verifier result now produces a localized verification-failure message for unresolved topics. Configured services and independently verified recovered facts remain available; unverified candidate prose is withheld.

This does not fix or claim to explain the provider-internal latency. The 20-second deadline, model, provider configuration, prompts, request parameters, evidence construction, retrieval, retries and safety gates are unchanged. A complete extraction timeout can still withhold the address, but it can no longer claim the address is missing from business information.

## Production evidence and what it proves

The supplied Swedish WhatsApp run correctly selected `sv`, business 3, and the conversation stage. Ordinary candidate generation completed successfully. The grounding extractor then had `candidateLength:290`, `evidenceLength:5847` and `timeoutBudgetMs:20000`. Its `elapsedMs` and `providerExecutionMs` were both approximately 20002; the application classified TIMEOUT and no extraction assessment reached grounding.

| Question | Conclusion |
| --- | --- |
| Where did the deadline expire? | Inside grounding extraction's provider execution, before an assessment and before independent entailment. The supplied execution/elapsed measurements do not indicate a material queue wait. |
| Why exactly 20 seconds? | `generateContentWithFallback` passes the existing 20000 ms budget to `runAiProviderRequest`. Its timer rejects with TIMEOUT, then aborts the attempt signal. |
| Why did the provider take longer than that? | **Unproven.** The logs do not separate model processing, first-byte delay, transport, full body consumption or decoding. They contain no output/reasoning usage or provider response. |
| Did retrieval contain Aurora Street 742? | **Not established for this live run.** An evidence corpus length of 5847 includes configuration and prompt facts; it does not identify retrieved chunks or their contents. The caller confirmed no additional retrieval record is available. |
| Did the candidate contain the address? | **Not established for this live run.** Length 290 proves only that a nonempty candidate reached extraction. Its content was not captured. |
| Does local replay include the address in both? | Yes, explicitly asserted in offline requests built from the existing tenant-3 fixture. That is local evidence, not retroactive proof of the live inputs. |
| Was the verifier request malformed or too large? | No malformed construction is found in the code or local SDK replay. The supplied logs show no HTTP validation/context-size rejection. They do not prove that prompt size caused latency. |
| Is gpt-5.6-luna intended? | It is the explicit application fallback model for OpenAI when `OPENAI_MODEL` is absent. The live diagnostic confirms the effective model. Whether production selected it via the environment or that default is not shown; there is no dedicated verifier-model override. |
| Is 20 seconds an appropriate production deadline? | It is the existing bounded-request policy, not a demonstrated model completion guarantee. One timeout cannot establish a suitable replacement budget; no latency distribution or end-to-end response target was supplied. No budget change is justified here. |

The earlier German address-free live reply remains historically unresolved. This Swedish run establishes a concrete timeout path, but does not establish that the earlier German run failed for the same reason.

## OpenAIProviderFailure and causal relationship

The application rejects the attempt before aborting its signal. The installed SDK then settles the unfinished `responses.create` transport. The adapter's catch emits `[OpenAIProviderFailure]` and rethrows. Its diagnostic hard-codes `stage: generation` for **every** Responses generation operation, including internal grounding extraction. Non-HTTP abort errors have none of the allowlisted HTTP status, type, code or request ID, so the summary becomes `OpenAI generation failed` with null metadata.

This explains why the application timeout, failed grounding diagnostic, and later adapter failure can describe **one cancelled verifier request**. The offline regression uses the installed SDK, a mocked HTTP transport, and a fake clock advancing the actual unchanged 20000 ms deadline. It reproduces the later diagnostic after grounding returns, with a matching correlation ID, null HTTP metadata and exactly one HTTP request. It does not create a second conversation-generation request.

The supplied production excerpts omit correlation IDs, so they do not independently link the two log entries. Their order and fields match the cancellation chain; a separate provider incident is not established by the generic `generation` label. The ordinary WhatsApp response path performs no further conversation generation after the grounding guard; handoff settlement and message persistence do not generate another response.

## Runtime path before the fix

1. The unified information route recognizes services + location and invokes tenant-scoped semantic/lexical knowledge retrieval. The existing multilingual address bridges are active after f40e7e3.
2. `buildBusinessInformationInstruction` supplies the structured service catalog and `buildBusinessGroundingSnapshot` evidence to candidate generation.
3. The WhatsApp handler generates a candidate through `generateContentWithFallback` and the configured provider, then calls `guardBusinessSupportGrounding`.
4. `assessBusinessSupportGrounding` sends one JSON user input with `customerMessage`, `candidateReply` and `groundingEvidence`, plus the strict extractor instruction.
5. Router normalization clears the shared call-site identifier `gemini-2.5-flash` for OpenAI. The adapter selects `OPENAI_MODEL` or `gpt-5.6-luna`, and calls `responses.create` with the attempt's AbortSignal.
6. `runAiProviderRequest` reaches the deadline, rejects TIMEOUT and aborts the signal. TIMEOUT is not retryable. The extractor catches the failure and returns null; the guard logs `verifierReturnedAssessment:false`, no claims, and failed coverage/evidence/entailment.
7. `recoverCompoundBusinessInformation` can still construct the trusted configured catalog, but has no extracted claims to verify. It incorrectly treats every remaining requested topic as missing information and appends `formatBusinessSupportKnowledgeGap`. A non-compound failed guard similarly calls `currentBusinessSupportGap`.
8. Repetition, CTA, identity and concision handling retain the fallback. The handler sends and persists that final text. The SDK abort can emit its adapter diagnostic after fallback construction; late output cannot authorize a reply.

Retrieval alone is not a completed citation/entailment decision for an arbitrary translated candidate sentence. The old fallback conflated failure to establish a supported answer with proof that information was absent.

## Runtime path after the fix

Steps 1–6 and all safety checks remain unchanged.

- Compound recovery chooses the shared localized `formatBusinessSupportVerificationUnavailable` when extraction returned no assessment or any entailment phase was unavailable.
- The entailment result map tracks an operation-local failure boolean independently of factual verdicts. Null/failed verdicts are still evicted; failed transport is never cached as evidence, and existing recovery/retry behavior remains intact.
- Unresolved topics use verification-failure wording. Supported quotes and the canonical catalog still follow the existing recovery and normalization path.
- The final non-compound fallback uses the same distinction. Valid non-outage grounding rejection retains its existing handling; this change does not loosen contradiction, negative-absence, exact-citation or unsupported-claim rules.

For the Swedish compound request, a complete verifier outage now yields the existing catalog/help plus:

> Jag kan inte verifiera ett svar om platsen/adressen just nu. Verksamheten kan bekräfta vad som gäller.

The address is returned when it passes the existing grounding gates. On a complete verifier outage, the fix conservatively withholds an unverified address; it does not translate or promote raw retrieval, invent an address, strip qualifiers/negation, or claim the business lacks a location. A separately verified location survives an outage for another requested fact.

`server.ts` changes are necessary because the confirmed defect is in its private fallback/recovery and entailment-result bookkeeping. No channel handler, booking/contact/phone function, retrieval implementation or provider file was edited.

## Request audit and configuration

Exact local fixture measurement, not the unavailable live payload:

| Field | Local value |
| --- | --- |
| Effective model | gpt-5.6-luna |
| Extractor instruction length | 2371 characters |
| User JSON length | 6589 characters |
| Input items / role | 1 / user |
| Candidate / evidence length | 339 / 5675 characters |
| Business prompt / configuration source length | 3307 / 2055 characters |
| Verified booking source / retrieved source length | 6 (`(none)`) / 176 characters |
| Tools, temperature | Omitted |
| Reasoning, max_output_tokens | No explicit settings |
| API text.format / streaming | Omitted; JSON shape is prompt requested and locally parsed |

The local user input is well-formed JSON with the exact expected fields and verbatim fixture evidence. These are character counts, not measured token counts. The difference from the live 5847-character corpus cannot be assigned to a source without that run's snapshot.

The conversation and verifier use the same configured OpenAI adapter and model resolution; there is no OpenAI-to-Gemini fallback. SDK automatic retries remain disabled. Application NETWORK, RATE_LIMIT and PROVIDER_UNAVAILABLE failures retain their existing bounded two-attempt policy and 500 ms retry delay; TIMEOUT remains non-retryable. The offline 503 regression checks both attempts; the SDK deadline regression checks one aborted request and no late success.

Official model documentation identifies gpt-5.6-luna as a supported Responses model and lists medium as its default reasoning effort. An omitted effort is not proof that reasoning caused this timeout. No effort/output/model tuning was made. [Official OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

## Diagnostics for the next validation

Existing timing, AI request, extraction, entailment and provider diagnostics remain. The primary grounding diagnostic adds:

- `retrievedKnowledgeLength` and `retrievedKnowledgeFingerprint`;
- `retrievedAddressPhrasePresent`, `retrievedAddressPhraseCount` and up to 20 `retrievedAddressPhraseFingerprints`;
- `candidateContainsRetrievedAddressPhrase` and up to 20 `candidateAddressPhraseFingerprints`;
- `verificationUnavailable` at the primary grounding gate.

The phrase detector excludes chunk/source wrappers and requires location-related source wording. It is **diagnostic only**: matching an address-like token sequence does not prove an affirmative location proposition or entailment. A false flag is not a semantic proof that no location exists; unsupported formats and truncated fingerprint lists can be inconclusive.

For the expected normalized literal `aurora street 742`, the existing twelve-character SHA-256 fingerprint is **`8d8c35e49831`**. Its presence in both phrase lists proves the literal reached retrieved evidence and the candidate respectively, without logging it in plaintext. Citation/entailment gates still decide whether it can be asserted. Retain `[KnowledgeRetrieval]` source IDs and match counts, and correlate `[AIRequest]`, `[BusinessSupportVerifierTiming]` and `[OpenAIProviderFailure]` by correlation ID. Do not infer a second generation solely from the adapter's stage label.

## Files and verification

Changed production files:

- `server.ts`: select the conservative fallback, retain operation-local failure status, and add bounded diagnostic presence/fingerprint fields.
- `src/ai/business-information.ts`: localized verification-unavailable formatter shared across EN/SV/DE/ES/AR/FA.

Tests/docs:

- `src/ai/business-verification-unavailable.integration.test.ts`: 41 new deterministic offline cases. Six-language success, timeout, provider failure, malformed extraction, entailment outage, unknown location; verified partial location; real SDK fake-clock abort/late diagnostic; omitted candidate address; metadata exclusion; existing bounded retry policy.
- `src/ai/multilingual-compound-location.integration.test.ts`: update the former indistinguishable-fallback assertion to require an explicit distinction for unavailable verification.
- `src/ai/business-information-evidence.integration.test.ts`: update one null-assessment fallback assertion; unsupported facts remain forbidden.
- `src/ai/shared-business-information.integration.test.ts`: update one null-assessment fallback assertion; all four channels remain consistent.
- `docs/business-verification-unavailable-hotfix-2026-10-01.md`: this report.

Results:

- Unchanged f40e7e3: **6 passed / 35 failed** on the new 41-test suite. Source files were temporarily restored from HEAD only inside this worktree, then restored byte-for-byte to the fix before final checks.
- Focused/nearby suite: **89 passed / 0 failed**.
- Initial broader safe suite: **345 passed / 0 failed**.
- Final combined suite on the final code: **416 passed / 0 failed**, including all new tests, multilingual compounds, catalog/inline-role/unknown-heading/negation/qualifier/Arabic-conjunction tests, grounding cancellation/reuse/deadline safety, OpenAI adapter/configuration/diagnostics, reliability/queue, multilingual booking and contact/phone regressions.
- `npm run build`: passed; bundle-size warnings only.
- Targeted business-information TypeScript check: passed.
- `git diff --check`: passed.

All test HTTP requests are mocked, with the offline network guard active. The real 20000 ms deadline is advanced with a fake clock in the new SDK regression; no real OpenAI call or production message was used. The existing timing suite also checks the real deadline using its offline transport. No model or timeout was changed to obtain passing results.

Service catalogs remain deduplicated. Booking/contact/phone behavior and authoritative WhatsApp sender preservation were not edited; their regressions pass, including the exact German AIBB name message and retained contact/slot state.

## Next live validation and operational status

After review and a separately authorized deployment, validate the same Swedish WhatsApp question. Record source IDs, the two address fingerprint lists and request correlation IDs. On successful verification, expect one catalog and Aurora Street 742. On an outage, expect the catalog and an honest verification-failure notice, never a fact-absence claim or unverified candidate prose. Apply the same checks to EN/DE/ES/AR/FA and an unknown-location control. Keep the underlying extraction-latency investigation open until provider timing/usage evidence identifies its cause; keep the historical German run's upstream cause open too.

No commit, push, deployment, Render setting change or production message was made in this task. HEAD remains f40e7e3. The dirty main worktree and AI Blackbox Test Platform were not used or modified. No analytics, voice, dashboard, booking, contact or phone code was changed.
