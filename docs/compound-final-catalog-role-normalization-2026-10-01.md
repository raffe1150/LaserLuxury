# Final compound catalog-role normalization — 2026-10-01

## Outcome and local reproduction

The exact German question `Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?` reproduces the remaining production-shaped duplicate against unchanged HEAD (`15c4d79`). The reconstructed candidate contains the complete `Verfügbare Dienstleistungen:` enumeration, a location quotation, and an extra structured assertion which remains UNKNOWN. The enumeration and location are together in one exact contiguous recovered quotation, with exact configured service objects plus the retrieved location citation. Recovery outputs:

```text
Unsere buchbaren Dienstleistungen sind:
• Video Consultation (60 Minuten, 300 SEK)
• test (40 Minuten, 150 SEK)
• video for tiktok (15 Minuten, 900 SEK)
• Golden video (60 Minuten, 1500 SEK)
• Reklam (60 Minuten, 1200 SEK)
Wir haben noch weitere Leistungen. Sagen Sie mir, wonach Sie suchen, dann helfe ich Ihnen, die passende zu finden.
Verfügbare Dienstleistungen: Video Consultation – 60 min / SEK 300.00; test – 40 min / SEK 150.00; video for tiktok – 15 min / SEK 900.00; Golden video – 60 min / SEK 1500.00; Reklam – 60 min / SEK 1200.00.
Unser Kundeneingang befindet sich in der Aurora Street 742.
```

This reproduces the supplied observable shape: one deterministic catalog, a differently worded/formatted second catalog, and one location. The supplied final reply cannot establish the actual production candidate, extraction spans, or verifier decisions; the local candidate/verdicts are a controlled reconstruction, not claimed production telemetry. The existing read-only production fixture supplies the service values and address. External provider responses are mocked and network access is blocked.

With the fix, the same path returns the deterministic catalog once followed by `Unser Kundeneingang befindet sich in der Aurora Street 742.` once. The UNKNOWN assertion is absent. Before the change, 15 of the final 60 focused tests fail on the unchanged server; afterward all 60 pass.

## Exact root cause and why the previous fix missed it

There are two composition paths without final catalog-role normalization:

1. In recovery, `recoveredClaimIsRepresentedByCatalog` intentionally returns false for a mixed catalog/location quotation: its topics contain `contact`, and its citations include `retrieved_knowledge`. This protects the location, but `parts.push(decision.deterministicReply || quote)` retains the entire catalog too. `parts.unshift(catalog)` then inserts another complete authoritative catalog.
2. A completely grounded candidate can return from `guardBusinessSupportGrounding` before recovery. `compoundCatalogComplete` checks service coverage, ordering and configured facts, not uniqueness. A candidate already containing bullet and inline catalogs can therefore bypass the previous replacement predicate altogether.

The previous fix compares semantic service scope only at recovered-claim level. Its final `new Set(parts)` compares complete strings, so different preambles, list formatting, decimal prices, and unit labels defeat whole-part equality. No final reply-level role check existed. The final presentation stages do not reinsert a catalog in the reproduced path; the compound infinite word budget correctly preserves later topics, and also preserved the duplicate before this repair.

## Exact end-to-end composition path

1. Active business-information state supplies the current tenant configuration and retrieved Knowledge. `buildBusinessInformationInstruction` supplies the authoritative customer-facing catalog plan and grounding corpus to general generation.
2. The provider's generated `chatResponse.text` passes through `guardCustomerFacingReply`, including the existing integrity/language and booking-CTA guards.
3. `guardBusinessSupportGrounding` builds the tenant-local snapshot and verification request. The extractor returns atomic claims and exact contiguous candidate/evidence quotations. Existing candidate coverage, citation membership, supported flags and repair checks run unchanged.
4. `assessmentClaimsAreEntailed` checks the full assessment. In the recovery reproduction, the catalog/location proposition is ENTAILED and the unrelated timezone-policy proposition remains UNKNOWN through initial verification, retry and adjudication. The full candidate fails entailment and is not emitted. Operation-local completed verdict reuse remains unchanged.
5. `recoverCompoundBusinessInformation` identifies the separately requested services/contact topics, excludes recommendation recovery, and builds/formats the deterministic catalog from the current configuration.
6. Each recovered claim still needs contiguous candidate membership, exact verified evidence and successful entailment. UNKNOWN, unsupported and contradicted claims are omitted. The existing claim-level catalog predicate still removes simple redundant catalog claims. Mixed catalog/location claims survive that predicate intact, which was the missing case.
7. Recovery prepends the authoritative catalog, records supported topics, adds any requested knowledge gaps, and applies its existing exact complete-part `Set` deduplication. **New:** the completed grounded reply is normalized by catalog role before returning.
8. For the fully grounded early-return path, the existing evidence, entailment and catalog-coverage gates still precede emission. **New:** eligible compound catalog replies select and normalize the same authoritative plan before returning; single-topic and recommendation behavior is unchanged.
9. `guardGeneralAiReplyRepetition` returns relevant business-information replies directly. Its greeting-only replacement calls `currentBusinessSupportGap`; that is a whole-response fallback, not a second catalog appended to the normal answer.
10. Telegram, WhatsApp, Messenger and Instagram then apply `suppressRepeatedPromotionalCta`, `enforceAssistantIdentityLifecycle`, and `enforceFinalConversationConcision`. CTA/identity processing removes text; it does not append catalogs. The existing compound budget remains infinite, so sentence/word trimming cannot remove later verified facts. Orphan-marker cleanup is unchanged. `settleHumanHandoffReply` returns this ordinary business reply unchanged because it has no explicit handoff assertion.
11. Delivery/history recording follows. The service-information timestamp/key deduplication elsewhere is a repeated-message delivery guard, not an intra-reply semantic catalog deduplicator.

## Exact code change

`src/ai/business-information.ts` adds `normalizeGroundedCompoundCatalogReply`. It accepts the already-grounded reply, selected tenant catalog plan, reply language, configured business name, and independently verified location quotations.

It identifies catalog-role spans using exact configured service names, configured price/duration values, configured currencies, localized numeric presentation, and localized unit/list labels supplied by `Intl`. It accepts minute/hour and decimal/grouped number presentation, bullet rows and inline enumerations, and service/company headings. A unit abbreviation's period is preserved inside the catalog span rather than mistaken for a sentence boundary. It removes those catalog spans and emits the selected deterministic catalog once. Canonical catalog surrounding prose/clarification is also emitted once.

Other lexical propositions remain intact. Numeric service facts outside configured catalog values remain intact. Contiguous non-catalog prose retains its separators, so long verified passages survive. Repeated exact location spans are suppressed using existing address-topic recognition and verified claim-role quotations; this also handles natural wording that does not itself contain an address keyword. This is presentation-only and makes no new evidence or entailment decision.

`server.ts` invokes this helper at the recovery composition return and the fully grounded compound early return. Recovery records location quotations only after their existing gates succeed. The previous evidence-based claim replacement remains in place.

The code uses tenant-provided names/values, existing shared topic recognizers, existing catalog formatting and `Intl` localization for German, English, Swedish, Spanish, Arabic and Persian. It contains no hardcoded German reply, tenant ID, location, channel branch, new provider call, or provider/model/timeout setting.

## Safety invariants and tests

Exact evidence membership, full candidate coverage, independent entailment, UNKNOWN retry/adjudication, contradiction rejection, negative-absence filtering, tenant-local snapshots, verifier-result reuse and unsupported filtering are unchanged. Catalog facts still come only from the selected tenant's authoritative configuration. The normalizer cannot promote a rejected claim because it runs after grounded composition. Recommendation recovery remains excluded; single-topic handling is unchanged. Booking and semantic retrieval code are untouched.

25 focused tests were added, bringing the file from 35 to 60 tests. The previous mixed-quotation test now requires preservation of the location role and one catalog instead of requiring the entire redundant catalog quotation. The long-reply test now uses a long separately evidenced service-description passage, rather than repeating the same location eight times; it still verifies more than 90 words and complete passage preservation.

Coverage includes six languages on both recovery and fully grounded paths; a complete candidate catalog; bullet plus inline duplicates; decimal/grouped prices and localized hour abbreviations; company preambles; idempotence; recovery-generated duplication; mixed catalog/location extraction spans; unsupported/contradicted location; UNKNOWN attached to a catalog and its three verifier phases; unrelated numeric service facts; separate service description, preparation, hours, contact, company and package-scope facts; services outside the displayed subset; recommendations; single-topic queries; and long compound replies.

The explicit catalog-role invariant independently inspects enumeration structure and counts Unicode-bounded occurrences of each displayed configured service name in catalog spans. Each must appear exactly once. It does not compare literal whole catalog strings and permits legitimate service-name references in separate factual prose.

## Verification results

- Focused final-composition suite: **60/60 pass**.
- Broad compound, multilingual/shared business-information, grounding/entailment/cancellation/reuse, recommendation, WhatsApp, provider/reliability/queue, Knowledge, concision, and additional language/channel regressions: **364/367 pass**.
- Three broad failures also reproduce with the unchanged HEAD server:
  - `channel-reliability.test.ts`: existing source-proximity regex requires the ambiguous clarification formatter within 200 characters of the routing condition.
  - `whatsapp-swedish-tomorrow-regression.integration.test.ts`: selected date is undefined instead of `2026-08-31`.
  - `persian-instagram-post-booking-continuation.integration.test.ts`: calendar-read count is 6 instead of 5 at line 212.
- Unchanged-server focused baseline: **45 pass / 15 fail**. The combined baseline log also includes the first two known regression failures (62 total, 17 fail); the Persian failure has its own baseline log.
- Targeted business-information TypeScript: **pass**.
- Server plus changed integration-test TypeScript: **16 existing diagnostics**, identical to unchanged HEAD after source-file/position normalization; **zero introduced**. The broader server type check is not clean on HEAD.
- `npm run build`: **pass**, with the existing large-bundle warning.
- `git diff --check`: **pass**.

Logs are local `.catalog-role-*.log` files. Legacy tests use their documented offline Gemini process environment; the production-shaped harness explicitly mocks OpenAI and rejects Gemini execution. No application/provider configuration file was changed. Temporary baseline source/test copies were removed after verification.

## Files and scope

- `server.ts`: two grounded composition call sites and verified location-role metadata.
- `src/ai/business-information.ts`: shared presentation normalizer.
- `src/ai/compound-business-information-final.integration.test.ts`: added regressions and final presentation harness coverage.
- This report.

The starting checkout was clean. Work remained in `/Users/raffe/Documents/OdinLink/.production-hotfix`. HEAD remains `15c4d79`. Nothing was committed, pushed or deployed. Render settings, timeout/model/provider configuration, AI Blackbox Test, booking logic, semantic retrieval, grounding, exact evidence, entailment, tenant isolation and unsupported-claim filtering were not changed.
