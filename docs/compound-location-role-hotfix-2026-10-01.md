# Compound business-information location audit — 1 October 2026

Worktree: `/Users/raffe/Documents/OdinLink/.production-hotfix`.
Base HEAD: `8ded7e5` (includes `458c924`). No commit, push, deployment, live message, Render setting change, or Blackbox change was made.

## Findings and limits

Two deterministic defects are reproduced and fixed. The exact upstream cause of the latest German reply's complete address omission remains unresolved. This change must not be described as proving or resolving that entire live failure.

1. **Swedish request role loss.** `businessInformationTopics("Hej! Vilka tjänster erbjuder ni och var finns ni?")` returned only `services`. `isBusinessAddressQuestion` returned false. The same missing recognition affected the standalone question `Var finns ni?`. The central classifier recognized `var ligger`, but not the equivalent `var finns ni`.
2. **Shared verified-claim role loss.** Partial recovery separately verifies contiguous candidate quotes and then reconstructs supported topics from `claim.claim + candidateQuote`. Natural business-location relationships such as `Sie finden uns in der Aurora Street 742.` had no recognized contact/location keyword. The independently grounded location quote survived, but `contact` remained missing from supported topics; the code appended a false location-unavailable statement. This reproduced in EN, SV, DE, ES, AR and FA. Existing German tests used a normalized atomic claim containing `Standort`, masking the failure when extraction uses the natural wording for both the atomic claim and candidate quote.

**Swedish and German therefore do not have the same confirmed request-routing defect.** The exact German request is already recognized as both services and contact, and already enables address lookup bridges. German shares the claim-role defect, but that defect alone yields an address followed by a false gap, rather than the saved address-free reply.

## Saved production evidence

Read-only history inspection found the following tenant-3 question/reply pairs. Times below are UTC; Stockholm was UTC+2.

| Question → reply ID | Time on 1 October | Language | Result |
| --- | --- | --- | --- |
| 14718 → 14719 | 14:59:49 | DE | Complete catalog, localized help, location gap; no address |
| 14702 → 14703 | 14:57:26 | SV | Catalog and help; no address |
| 14698 → 14699 | 14:56:44 | EN | Catalog, help, `Our customer entrance is at Aurora Street 742.` |
| 14690 → 14691 | 14:54:52 | DE | Same German request succeeded with Aurora Street 742 |
| 14674 → 14675 | 14:52:24 | SV | Same Swedish request omitted the address |
| 14670 → 14671 | 14:51:40 | EN | Same English request also produced a location gap |

Consequently, the German omission is intermittent, and English is not consistently successful either. The saved German fallback proves that no location survived as a supported recovered fact. It does **not** identify whether the address was absent from retrieval, omitted during generation/extraction, rejected by citation validation, or rejected by entailment. A new deterministic diagnostic test reproduces the same catalog-plus-gap output for missing retrieval, missing extraction assessment, and contradicted location entailment. Missing assessment does not establish a timeout; no timeout cause is inferred from older incidents.

No runtime log lines for request 14718 are available. A local replay can distinguish these conditions but cannot reconstruct the historical inputs. No temporary runtime instrumentation was added to production code, and existing safety gates were preserved.

## Runtime path before the fix

1. `handleUnifiedBookingEngineTurn` (`server.ts:15819`) routes an informational turn and stores its requested language, configuration and retrieved knowledge without advancing booking state.
2. `retrieveBusinessKnowledgeForQuestion` (`7959`) obtains semantic query candidates and `buildBusinessKnowledgeQueries` (`7938`) appends the existing multilingual address bridges only when `isBusinessAddressQuestion` is true. Semantic and lexical hits remain tenant scoped.
3. `buildBusinessInformationInstruction` (`8157`) supplies configured services and retrieved facts to response generation.
4. `guardBusinessSupportGrounding` (`9401`) selects the grounding snapshot, extracts claims/citations, checks coverage and exact source quotes, and independently verifies entailment. An incomplete **services-only** catalog can return `currentBusinessSupportGap` (`9469`) before claim extraction.
5. A fully supported compound response passes through catalog role normalization (`9792`). Otherwise, `recoverCompoundBusinessInformation` (`9336`) emits independently verified quotes, replaces represented service clauses with the configured catalog, computes missing topics, and appends their localized gap.
6. Channel handlers apply repetition/CTA and identity processing, then `getFinalConversationConcisionBudget` (`13290`) and final concision. Verified compound catalogs have an unlimited budget; services-only catalogs have 90 words.

For Swedish, the missing request role disabled deterministic address bridges, enabled the services-only shortcut, and selected the shorter budget. Depending on retrieval and candidate completeness, the location could disappear before grounding or fail to survive verification. No independent claim assessment ran in the reproduced incomplete-catalog case.

For German, request recognition, compound routing and address bridges already worked. The shared claim-role defect could append a false gap to a surviving location. The latest saved address-free reply exited through the compound fallback, but its exact upstream failure cannot be determined from the final reply alone.

## Runtime path after the fix

The same central helpers now recognize the business-location relationship as `contact`, even without an address/location noun. `businessInformationTopics` uses `isBusinessAddressQuestion` for that role, preventing those two detectors from disagreeing.

- The Swedish request now has `services + contact`, activates the existing address bridges, avoids the services-only early return, and keeps the compound presentation budget.
- Independently verified natural location claims now satisfy the requested contact role in all six languages, so recovery retains the quote without appending a false location gap.
- The existing canonical catalog still replaces only catalog-role content and appears once. Localized help remains the existing formatter output; the location remains the independently verified candidate wording.
- Missing, unsupported or contradicted facts still fail closed. This is especially important for the unresolved German address-free fallback.

The fix changes shared linguistic role recognition, not response templates. There are no new hard-coded answers or translations. Retrieval implementation, model/provider selection, deadlines, grounding extraction, citation/entailment safety, recommendation logic, booking/contact logic and `server.ts` were not edited. Recognition activates existing address bridges for newly recognized location requests.

## Diff and tests

Changed files:

- `src/ai/business-information.ts`: 9 additions, 2 deletions; recognize business-location relationship phrases and share address recognition with the contact topic.
- `src/ai/multilingual-compound-location.integration.test.ts`: 30 new offline deterministic tests running the actual engine entry, retrieval query construction, grounding/recovery and final presentation helpers.
- `docs/compound-location-role-hotfix-2026-10-01.md`: this audit.

New tests cover all six languages' compound request roles and retrieval, fully grounded normalization and partial recovery. Each final-response case checks one catalog, Aurora Street 742 once, no false location gap, exact localized catalog/help plus the verified localized location, and exclusion of unsupported prose. Additional cases cover Swedish incomplete catalogs, single-service and single-location routing and final replies, unknown factual requests, six unrelated service/appointment phrases, and the German fallback ambiguity described above.

On unchanged HEAD the new tests produced **20 passed / 10 failed**. The helper was temporarily restored from HEAD within this worktree for that baseline and then restored to the tested fix. With the fix, the focused suite produced **105 passed / 0 failed**, comprising the 30 new tests and existing location/inline-catalog tests. Existing unknown-heading, qualifier, negation and Arabic attached-conjunction cases passed.

The broader suite produced **210 passed / 0 failed**, including business-information/evidence, compound final/recovery, shared multilingual support, grounding reuse/deadline/cancellation safety, contact provenance/selected slot, booking language continuity, multilingual contact/service collisions, multichannel progression and booking completion. The legacy shared suite assumes Gemini for its mocked generator; it passed all 51 tests with `AI_PROVIDER=gemini`. An initial broad invocation using the ambient provider setting was stopped after that suite did not finish promptly; the complete broad suite then passed with the explicit test setting. OpenAI-specific tests set their own offline provider and SDK mocks. No application provider configuration changed.

Commands, run only from the hotfix worktree:

```sh
node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test src/ai/multilingual-compound-location.integration.test.ts src/ai/business-information.location.test.ts src/ai/business-information-inline-catalog.test.ts
AI_PROVIDER=gemini node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test src/ai/business-information.test.ts src/ai/business-information-evidence.integration.test.ts src/ai/compound-business-information.integration.test.ts src/ai/compound-business-information-final.integration.test.ts src/ai/shared-business-information.integration.test.ts src/ai/business-grounding-reuse.integration.test.ts src/ai/business-grounding-timing.integration.test.ts src/ai/business-grounding-cancellation.integration.test.ts src/ai/channel-contact.test.ts src/ai/contact-phone-provenance.integration.test.ts src/ai/contact-submission-selected-slot.integration.test.ts src/ai/booking-language-continuity.integration.test.ts src/ai/multilingual-contact-service-collision.integration.test.ts src/ai/multichannel-booking-progression.integration.test.ts src/ai/booking-completion-regressions.integration.test.ts
npm run build
git diff --check
```

Build: passed; bundle-size warnings only. Diff whitespace check: passed.

Authoritative WhatsApp sender-phone behavior was not changed. Its regressions passed, including the exact German AIBB message, six-language name messages, arbitrary prose digits, no channel phone, intentional labeled override, retained slot/contact state, persisted phone and final confirmation.

## Recommended next step

Review only the three files listed above. Suggested eventual commit title: `Recognize compound business location roles`. Keep the German live omission investigation open; obtain retrieval, candidate/extraction, grounding diagnostic and entailment lines for a failing request before changing its safety fallback or claiming full production resolution. No commit has been created.

The dirty main worktree was not used or modified. HEAD remains `8ded7e5`. No timeout/model/provider/retrieval implementation, Blackbox, analytics, voice, dashboard or roadmap code was changed. Nothing was pushed or deployed, and no live production messages were sent.
