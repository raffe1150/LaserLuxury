# Compound service catalog duplication — 2026-09-30

## Root cause and emitting path

The compound recovery composer inserts an authoritative catalog without recognizing every equivalent recovered catalog claim. The defect is in catalog replacement during composition, followed by exact-string deduplication. It is not a retrieval, entailment, location mapping, or final word-budget defect.

The path through `server.ts` is:

1. The model candidate contains its natural service list, another structured assertion, and a location quote. The claim extractor keeps the coordinated catalog enumeration as one atomic offering proposition with a complete contiguous quotation.
2. `guardBusinessSupportGrounding` checks exact candidate/evidence coverage and runs independent entailment. The unrelated structured assertion remains UNKNOWN after retry and adjudication. Therefore, the whole candidate cannot be returned.
3. The guard calls `recoverCompoundBusinessInformation`. The shared question recognizers identify services and contact/location, and the recommendation exclusion does not apply.
4. Recovery builds the authoritative tenant catalog with `buildConfiguredServiceCatalogPlan` and `formatConfiguredServiceCatalogPlan`.
5. Each recovered claim still needs an exact contiguous candidate quote, `assessmentHasVerifiedEvidence`, and `assessmentClaimsAreEntailed`. The UNKNOWN claim fails; the catalog and location pass. Operation-local reuse retains the completed verdicts.
6. The old `replacedByCatalog` condition accepts only individual JSON field citations matching its leaf-line regex. A complete exact service object or services-array fragment fails that regex. Independently, it requires every detected topic to be services/prices; a catalog atomic claim such as “The business offers the listed services…” also detects `company`, and fails that condition even with leaf citations.
7. With replacement false, `parts.push(decision.deterministicReply || quote)` appends the natural model catalog. The independently verified location is also appended.
8. `parts.unshift(catalog)` inserts the deterministic authoritative catalog. These are the two distinct catalog-emitting statements.
9. `[...new Set(parts)].join("\n")` removes only identical complete strings. The authoritative “Unsere buchbaren Dienstleistungen sind:” and natural “AdMotion Studio bietet an:” blocks have different preambles; even if their factual rows agree, they are different strings.
10. The reply returns through the grounding guard and the repetition guard. The channel handlers apply CTA/identity presentation and shared final concision. The existing compound exemption preserves the complete reply, including both catalog blocks and the verified location. Concision does not cause or safely solve this duplication.

The supplied production evidence contains the final reply, not the raw model candidate, extracted claims, or citations. It confirms the output shape. It cannot establish whether the production replacement predicate failed on citation shape, the extra company topic, or both. Both failures are independently reproduced locally; no reconstructed candidate is represented as verbatim production data.

## Local reproduction

The tests use the existing read-only production fixture and exact German question:

> Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?

The candidate uses “AdMotion Studio bietet an:” plus the configured service rows, an unrelated assertion that all customer communications use Europe/Stockholm time, and the verified address. Its catalog evidence consists of complete exact service objects. The unrelated assertion cites the exact configured timezone field but remains UNKNOWN because that setting does not entail the asserted communications policy. Location is independently ENTAILED against the exact tenant Knowledge quote.

The real extractor/verifier orchestration, evidence gates, retry/adjudication, result reuse, guard, recovery, repetition guard, and shared final concision functions execute; external Responses results are mocked and network access is blocked. Final output has one authoritative catalog, one location quotation, and no UNKNOWN assertion.

Equivalent German, English, Swedish, Spanish, Arabic, and Persian cases reproduce the old duplicate and pass with the fix. Running the final 35-case focused file against unchanged HEAD produces 23 passes and 12 failures. With the fix, all 35 pass.

## Minimal fix

Only the compound catalog-replacement predicate changes in runtime code. A local helper, `recoveredClaimIsRepresentedByCatalog`, recognizes already represented catalog facts after exact evidence and entailment have succeeded:

- Accept exact JSON leaf fragments, multi-field service objects, arrays, and services-field fragments.
- Require structured configuration citations containing only catalog fields and, optionally, the matching business name/container.
- Match each service object's facts together against one displayed authoritative service, including name, duration, price, currency, and affirmative active status. Numeric fields use the same numeric interpretation as the catalog plan.
- Allow the company topic in a catalog offering preamble, while retaining quotes containing other topics.
- Recognize individual named catalog entries even when their wording has no services/prices keyword.
- Retain a configured service named in the quote outside the displayed subset, including when it shares a price value with a displayed service.
- Retain non-catalog fields, other evidence sources, broader scopes, and mixed-topic quotations.

The caller omits only a redundant verified catalog claim when an authoritative catalog will be inserted. The existing topic bookkeeping, deterministic catalog insertion, exact-string deduplication, and missing-topic handling remain in place. Broad or unparseable evidence is conservatively retained.

The helper uses the current tenant's catalog plan, existing multilingual topic recognizers, and structured field values. It contains no German text, address, tenant ID, channel-specific branch, new model call, or new provider option. WhatsApp, Telegram, Messenger, and Instagram share this guard/recovery path.

## Safety and previous fix

Exact evidence membership, contiguous candidate checks, extraction coverage, independent entailment, UNKNOWN retry/adjudication, contradiction rejection, negative-absence handling, unsupported-claim filtering, and tenant snapshot boundaries are unchanged. A presentation omission cannot promote a rejected claim to an accepted one. The authoritative facts still come only from the same tenant configuration.

Recommendation recovery remains excluded before this helper. Single-topic handling remains outside compound recovery. No changes were made to `getFinalConversationConcisionBudget` or `enforceFinalConversationConcision`; the compound infinity word budget and long-reply preservation remain intact.

## Regression coverage

Twenty tests added to the existing final-presentation suite, plus improvements to its harness and negative-location cases:

- Six languages: natural model catalog with full-object citations becomes one authoritative catalog; every displayed service and the verified location occur once; UNKNOWN remains excluded and retains its three verifier phases.
- Leaf citations with company/services wording, full service objects, and a complete services-field fragment, including reversed claim ordering.
- Separate verified service description, preparation, company history, contact, and hours facts survive.
- Services outside the displayed subset survive, including shared-price evidence.
- Mixed catalog/location quotes retain their separate factual scope.
- Independently extracted individual duration entries are not repeated.
- A separate package-price proposition survives, using a different tenant ID.

Existing checks remain for unsupported/contradicted/fabricated location omission, UNKNOWN filtering, recommendations and natural clarification, single-topic service/location behavior, reversed topics, and complete verified replies longer than 90 words. Negative-location tests now also use the production-shaped natural catalog.

## Verification

- Focused final-presentation file: **35/35 pass**; unchanged HEAD: **23 pass, 12 fail**.
- Broad compound, multilingual/shared business information, grounding/entailment, recommendation, WhatsApp, provider, Knowledge, and concision regressions: **324/325 pass**.
- The sole broad failure is the existing `whatsapp-swedish-tomorrow-regression.integration.test.ts` awaiting-contact selected-date assertion: actual undefined, expected `2026-08-31`. A copy of that test importing unchanged HEAD reproduces the same failure. Booking code was not modified.
- Targeted business-information TypeScript: **pass**.
- Server plus changed integration test TypeScript: **16 existing diagnostics**, exactly equal to unchanged HEAD after normalizing source filename/line positions; **zero introduced**. This broader type check is not clean on HEAD.
- `npm run build`: **pass**, with the existing large-bundle warning.
- `git diff --check`: **pass**.

The broad suite runs with the repository's documented offline Gemini test default; the production-shaped harness explicitly mocks OpenAI and rejects Gemini execution. These are temporary test-process selections, not changes to application/provider configuration. Verification logs are local `.catalog-duplication-*.log` files. Temporary baseline source/test copies were removed after verification.

## Files and scope

- `server.ts`: 56 insertions, six deletions; one local predicate helper and its compound-recovery call.
- `src/ai/compound-business-information-final.integration.test.ts`: 140 insertions, eight deletions; twenty additional tests and harness updates.
- This report.

All writes and execution stayed inside `/Users/raffe/Documents/OdinLink/.production-hotfix`. Nothing was committed, pushed, or deployed. Render settings, timeout/model/provider configuration, booking logic, and semantic retrieval were not changed.
