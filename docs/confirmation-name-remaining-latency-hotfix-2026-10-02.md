OdinLink confirmation/contact and remaining latency audit — 2 October 2026

Base: `fea4c0f` — Optimize business info latency and RTL catalog.
All work was performed inside `/Users/raffe/Documents/OdinLink/.production-hotfix`.
Local changes only. No commit, push, deployment or production message.

1. Confirmation and name root cause

`extractPendingBookingCustomerName` and `extractNameOnly` returned null before explicit-name parsing when the entire message was a positive booking confirmation. There were two routes to this rejection: a direct `isPositiveBookingConfirmation` check and an indirect `isAffirmativeBookingText` → `isCompoundAffirmativeReply` → `isPositiveBookingConfirmation` check. Simply removing the direct check would leave the bug intact.

The selected-slot confirmation handler already attempts same-turn contact consumption after setting `status = awaiting_contact`. Therefore this was not a missing state transition or a general requirement that the previous state already be awaiting-name. Explicit names are supported before contact collection; bare standalone names deliberately remain gated to contact collection. The positive-confirmation guards defeated explicit-name extraction both at entry and after the transition.

Before, for the confirmed Persian structure: load pending owned booking → entry contact extraction returns no name → recognize positive confirmation → preserve and canonically validate the selected owned slot → set awaiting_contact → attempt contact extraction again, receive no name → save pending contact/slot → getMissingBookingContact reports name → return early with the missing-name prompt. A separate standalone-name turn then completes through normal finalization.

After: the same entry/confirmation/slot validation path runs, but positive confirmation permits bounded explicit self-identification. The existing name parsers and cleaners validate the candidate; confirmation never enables bare-name or natural-prose fallback. The pending booking receives the name before missing-contact evaluation. With complete contact, execution continues through the existing awaiting-contact finalization, calendar/database verification, operation claim/settlement and final confirmation in the same turn. No additional booking mutation path was introduced.

The fix is shared across English, Swedish, German, Spanish, Persian and Arabic. No example customer name is hard-coded. The Arabic recognizer also had a normalization mismatch: its input folds Arabic yeh to Persian yeh, while its self-identification/phone-field pattern still used Arabic yeh. That pattern now matches the recognizer's normalized input. This explains an additional inconsistent Arabic confirmation route.

Safety: require explicit self-identification at the beginning of the contact continuation, preserve existing Arabic/Unicode validation and Latin/Persian cleanup, reject conversational booking tokens and ambiguous leftover text, and retain the standalone-name state gate. A name-plus-phone confirmation uses the same explicit-name validation to avoid a quoted-identity side door. Diagnostic cleanup now also runs during selected-slot confirmation, so marker metadata cannot donate incidental services/dates/times. Existing Arabic AIBB cleanup code is unchanged. Unrelated stress sentences are ignored only after a independently valid explicit name clause; invalid human input still requires contact clarification.

2. Phone audit

The baseline already consumes explicit phones at entry and again after confirmation through `extractPhoneOnly` and `resolveAuthoritativeContact`. The combined name/phone parser also previously bypassed the name-only positive-confirmation rejection, so many combined messages already worked. There was no general phone-loss transition bug to repair.

Five deterministic phone integrations cover confirmation plus phone with and without a stored name and confirmation plus name/phone in English, Arabic and Persian. Their pre-existing successful behavior is preserved. The resolver's precedence was not changed: verified WhatsApp sender metadata remains authoritative over untrusted stored or diagnostic digits; deliberate explicit customer phone overrides remain supported exactly as before. Name-only WhatsApp tests seed an untrusted stale number and assert the verified sender wins. Both calendar and database mutation counters remain exactly one after a repeated confirmation.

3. Proven latency work and orchestration

The previous configured catalog/address shortcut was already effective for accepted simple questions. This change does not invent a second business-info optimization: with explicit configured services and address, information handling performs no retrieval, candidate generation, extraction or entailment. The normal language classifier remains one serial provider request for these representative meaningful questions. It must continue supporting semantic language requests and language continuity.

Business-info before and after this change:

- Configuration/history and conversation language preparation → pending-state/information gate.
- Own catalog + explicit own address: existing deterministic formatter/direct configured trust → response guard/concision → response readiness → dispatch/assistant identity preparation → channel HTTP send. Zero information-stage AI/search requests, one measured language request in each of six languages.
- Own catalog + retrieved address evidence: language → retrieval planner → lexical and semantic search concurrently → one independent location entailment → deterministic catalog/location or conservative unavailable notice → same guards/send. Existing tests count one planner, one entailment, one semantic search and seven lexical searches for EN/SV/DE/ES or eight for AR/FA. Those tests stub language resolution; the language-inclusive production path additionally retains its classifier when eligible.
- Unknown location or richer/unrecognized question: retain the full existing grounding path. Candidate text never establishes address trust.

Recommendation clarification previously entered full retrieval and returned unhandled, allowing a candidate generation and grounding graph even when the useful response was only a few configured services and a goal question. The measured fixture order was language → planner → concurrent searches → candidate generation → claim extraction → candidate-quote repair → entailment where the remaining candidate passed coverage. The repair request has a different purpose/input; it is not described as an identical duplicated verifier call. No second conversation generation or repeated identical entailment occurred in these fixtures.

After: the shared whole-question recognizer accepts only a generic recommendation/first-visit request, optionally with a generic service overview. The same rule applies to all languages and channels. It excludes named services, goals, comparisons, additional factual questions and booking instructions. A prior non-generic customer message or an active booking also prevents the shortcut. With an active configured catalog, render up to three services with the existing shared formatter and append the existing goal clarification. There is no recommendation claim. Retrieval, embedding/search work, candidate generation, extraction, quote repair and entailment are all unnecessary for that deterministic output and are skipped. Guards, concision, readiness and dispatch diagnostics remain active. Missing/inactive catalogs and richer context retain the original retrieval/verification flow.

The shortcut does not verify arbitrary facts less strictly. Its only factual content is its own configured catalog. Any substantive recommendation, business description, retrieved address, policy or other unknown fact retains support verification. Existing tests for supported recommendations, unsupported recommendations, absent evidence, cross-tenant retrieval and verifier failures remain included in broader validation.

4. Exact local counts and timing limits

These are offline SDK fixtures with 10 ms injected SDK delays and 5 ms search delays. The baseline uses snapshots of the server and changed shared modules from fea4c0f, copied inside this worktree. External fetch was blocked for final focused/broader validation. Existing older Gemini dependency fixtures use Gemini only in the test process; measured OpenAI tests explicitly select OpenAI and mock its Responses SDK. No production provider setting changed.

| Language | AI calls before → after | Lexical / semantic searches before → after | Synthetic elapsed ms before → after |
| --- | --- | --- | --- |
| en | 6 → 1 | 1 / 1 → 0 / 0 | 146 → 48 |
| sv | 5 → 1 | 1 / 1 → 0 / 0 | 84 → 16 |
| de | 6 → 1 | 1 / 1 → 0 / 0 | 81 → 17 |
| es | 5 → 1 | 1 / 1 → 0 / 0 | 70 → 14 |
| fa | 6 → 1 | 2 / 1 → 0 / 0 | 100 → 24 |
| ar | 6 → 1 | 2 / 1 → 0 / 0 | 85 → 14 |

Before recommendation counts, including language: EN/DE/FA/AR each have language 1 + planner 1 + candidate generation 1 + extraction 1 + quote repair 1 + entailment 1 = 6. SV/ES have the same first five requests but no entailment because the fixture's residual candidate fails coverage and returns the safe clarification fallback. All six after counts are language 1 and every other category 0. The differences in retained baseline coverage are fixture/candidate-dependent, not proof of a language-specific orchestration design. AR/FA had two concurrent lexical queries rather than one in these generic fixtures; ES did not have an extra retrieval/provider stage.

Configured business-info in all six languages: one language request before and after, zero information-stage AI requests, zero lexical/semantic searches. Measured total synthetic times were 13–21 ms before and 12–15 ms after, with no application optimization claimed for that already-short path. Retrieved location remains planner 1 + independent verifier 1, excluding language/embedding SDK calls, with unchanged search counts above.

Semantic search is mocked at its boundary, so actual embedding SDK counts are not claimed from these fixtures. Source tracing proves one `embedQuery` invocation per eligible semantic search. OpenAI can additionally embed corpus documents in batches on a cold index; the amount depends on corpus size/cache state and was not exercised here. There was no duplicate query embedding in the inspected information path. Configured facts and the new clarification execute no semantic search and therefore no query/corpus embeddings.

Measured internal queue waits were 0–1 ms and mocked provider execution about 10–16 ms per request. Conversation-candidate test generation lacks the parent timing context in this isolated harness; its duration is counted, but separate queue/execution fields are not claimed. Production channel candidates carry that existing context. Independent lexical/semantic searches and independent atomic verifier checks already run concurrently; no parallelism change was needed.

There are no correlated production logs for the supplied 17–49 second examples. It is not possible to assign those seconds to provider execution, network, internal queue, retrieval, configuration, assistant identity or channel send. The remaining explicit configured-info wait includes its language classifier, not a hidden catalog verifier. Real execution/network/provider-side queue time is external. `[AIRequest].queueWaitMs` measures OdinLink's internal AI queue, not the provider's private queue; scheduling/contention there is application-controlled. Configuration/history work before language preparation, identity/database preparation, and outbound HTTP also require real timing evidence. ProviderExecutionMs includes the SDK/network/provider wait and cannot separate them. No claim that most live latency is external is made without those logs.

Application work proven removable was the generic recommendation graph. Remaining richer retrieval/trust work is intentional. Post-processing follows dispatch and cannot explain content that already reached the channel. No timeout was increased, no diagnostics were removed, and no fallback/provider/model configuration was changed.

5. Exact changed files and tests

Production:

- `server.ts`: shared explicit contact/confirmation parsing, confirmation-state diagnostic cleanup, and the narrow clarification gate in the existing information orchestration branch. No broad server refactor.
- `src/ai/booking-state-machine.ts`: normalized Arabic self-identification/phone-field recognition.
- `src/ai/business-information.ts`: conservative whole-question generic clarification recognition. Catalog and RTL formatting code is unchanged.

New tests:

- `src/ai/confirmation-contact.integration.test.ts`: 43 deterministic integrations: 13 valid confirmation/name variants across six languages including punctuation, AIBB metadata and language-stress sentences; 21 confirmation-only/invalid/ambiguous/quoted-input variants; 4 existing standalone-name flows; 5 phone/combined-contact flows. Every successful same-turn fixture checks service/start, sender phone, final response, cleared pending state, one calendar insert, one database insert and repeat-confirmation idempotency. Missing-contact fixtures retain selected date/time/service and do not mutate bookings.
- `src/ai/recommendation-clarification-latency.integration.test.ts`: 60 tests: 6 measured recommendation traces, 6 configured-info traces including the real mocked language SDK boundary, 12 recognized generic phrasing variants, 18 extra-clause exclusions, 9 specific/compound exclusions, 4 shared-channel/dynamic-currency checks and 5 retained-path guards for prior goals, active booking, missing/inactive catalogs and specific goals.
- This audit document.

6. Validation and existing limitations

Final focused suite: **163/163 passed**, six files, no skips/cancellations.

Broader offline suite: **708/709 passed across 49 files**, no skips/cancellations. The single failure is the pre-existing `spanish-booking-boundaries.integration.test.ts:206` assertion for `Sí, reserva las 09:15.`: it expects status not awaiting_contact, while both fea4c0f and the current code reach awaiting_contact. The separately executed baseline reproduces the same assertion and zero contact-less mutation behavior. This out-of-scope boundary expectation/behavior is not repaired here, and a fully green broader suite is not claimed. New Spanish same-turn name completion and existing Spanish mañana tests pass.

Two additional older source-text tests were checked and fail on the baseline too: `booking-state-machine.test.ts:296` expects an old two-argument/one-line confirmation call; `channel-reliability.test.ts:67` expects an old two-argument WhatsApp ambiguity call. They were left unchanged and excluded from the 49-file runnable regression total. Their preceding deterministic assertions ran before reaching those stale source-string checks. Baseline comparison output is retained in ignored logs.

Build: passed after final production edits. Existing large-bundle warning remains.
Changed shared modules TypeScript: zero diagnostics. New test files TypeScript: zero diagnostics. Server/transitive check: 16 baseline, 16 current, zero new diagnostics. Repository `npm run lint`: existing syntax errors in unchanged `patch_key_rotation.ts` at 47/94/99; that file is identical to HEAD. `git diff --check`: passed, including new artifact whitespace checks.

Regression coverage includes selected slots, contact submission, exactly-once booking, six-language booking continuity, Arabic/Persian/Spanish names, authoritative WhatsApp phone, unsupported services and service matching, business info, locations and unknown locations, recommendation grounding, catalog completeness/deduplication, RTL formatting/currency, all four text-channel payload adapters, provider routing/cancellation, and absence of automatic OpenAI-to-Gemini fallback.

7. Protected scope

Unknown-fact and retrieved-location trust rules remain intact. RTL metadata remains `<duration> min, <price> <configured currency>` with the existing isolation controls. Service-record currency remains dynamic; no conversion or hard-coded currency was introduced. Existing Arabic AIBB name-cleanup source is unchanged. Existing standalone-name behavior and phone resolver are unchanged. Spanish direct completion is now covered, with the separate baseline boundary failure explicitly disclosed above.

Blackbox and its evaluators were untouched. No main-worktree source/index inspection or editing was performed; all commands used the hotfix checkout. No main-worktree modification, commit, push, deployment, production message or live production validation was performed. Temporary baseline/code harness artifacts were removed after validation; ignored local audit logs remain.

8. Exact targeted live validation after a separately authorized deployment

- In each of EN/SV/DE/ES/FA/AR, select a known configured service and a specific future owned slot, reach explicit confirmation, then send the exact six confirmation/name messages supplied in the request. Expect one immediate final confirmation, no repeated name request, exact service/date/time, verified WhatsApp sender phone and exactly one calendar/database booking. Repeat the confirmation to check idempotency.
- Repeat with confirmation only, an invalid/ambiguous name, a quoted third-party identity, valid name + AIBB marker + incidental date/service metadata, and a valid name followed by the separate “hej” stress sentence. Missing/invalid names must require clarification; metadata must not change the slot/name/phone.
- On Telegram or another channel requiring an explicit phone, test confirmation + phone with and without a stored name and confirmation + name + phone. Separately check the current intentional WhatsApp explicit-phone override policy; do not assume marker digits can override sender identity.
- For all six equivalent simple services/location questions and a business with an explicit configured address, collect inbound timestamp and correlated BusinessInformationTiming/AIRequest/BusinessInformationProviderTiming events through actual delivery. Expect the existing language classifier only, zero information-stage planner/generation/extraction/entailment/search work, the configured address once and the unchanged catalog/currencies.
- With address available only in Knowledge, expect planner + one independent location entailment and lexical/semantic retrieval. With unknown location, provider failure, contradiction or inconclusive evidence, require the existing conservative answer without an invented address.
- In a fresh conversation, test all six generic recommendation questions from the latency fixture, plus the generic service-overview/first-visit variants. Expect three configured service examples and exactly one goal question; information-stage AI/search counts must be zero. Expect grounding_complete disposition configured_catalog_clarification and response_ready/dispatch/delivery events.
- Then provide a real goal, ask a substantive comparison/recommendation or add a location/policy question. Confirm those requests retain retrieval/support verification and do not get absorbed into the generic scaffold. Repeat after a prior stated goal and with an active booking; booking state must remain intact.
- Compare same-correlation received/language_complete/retrieval/grounding/response_ready/dispatch/delivery boundaries. Attribute internal queue, SDK execution, identity preparation and channel HTTP gaps from logs; do not infer them from Blackbox language or booking-completion evaluator results. Obtain AR/FA client screenshots to confirm unchanged two-line catalog metadata and configured currencies.
