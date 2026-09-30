# Literal inline catalog hotfix — 2026-10-01


## Pre-commit heading fallback audit (latest)

The audit confirmed the vacuous `.every()` risk in the pending live fix: an unrelated factual heading with no recognized topics was discarded when followed inline by all configured catalog entries. Six such headings and nine headings containing offering verbs plus additional facts/negation failed before refinement. The isolated pre-refinement suite was **27/42 passing, 15 failing**.

The smallest refinement adds a positive, local offering-preamble predicate. An empty topic list now requires an offering verb in the selected language with only grammatical framing remaining. Conjugation/framing rules handle German, English, Swedish, Spanish, Arabic and Persian; no exact German phrase is hardcoded. Extra factual words, qualifiers and negation remain unrecognized as pure offering preambles and therefore survive. Numeric/other-topic guards and the catalog-body value/unit/currency checks are unchanged. Recognized-topic heading behavior is unchanged; this audit narrows the new empty-topic fallback only.

Examples now retained include `A written creative brief is included:`, `We provide only remote sessions:` and `Wir bieten nicht an:` followed by a complete configured enumeration. An ambiguous inline scope is conservatively preserved intact. Separately placed factual headings also survive. The literal `Wir bieten an:` catalog still disappears, with the canonical catalog, clarification and location each retained once. Variants such as `Ich biete an:` demonstrate lexical recognition rather than one phrase exception.

29 more tests were added: twelve unknown-heading cases across six languages and inline/separate-line layouts, nine factual/negative offering-word cases, six positive framing variants, and two actual guard-return regressions preserving a verified unknown factual heading through recovery and fully grounded early return. Final focused results: **122/122 pass**. Relevant broad results: **426/429 pass**, with the same three previously baseline-reproduced failures listed below. Targeted TypeScript, `npm run build`, and `git diff --check` pass.

This refinement changes 17 net runtime lines within the existing normalizer. No server, grounding, entailment, booking, provider, timeout, retrieval or Blackbox code changed. Temporary audit baseline copies were removed. Nothing was committed, pushed or deployed.

## 1. Exact failed predicate

Starting HEAD: `fa30dfe` (`Normalize grounded compound service catalogs`); checkout initially clean.

The exact supplied reply is permanently stored in `tests/fixtures/compound-catalog-inline-production-de.txt`, including hyphen bullets, blank lines, `Wir bieten an:`, `Min.,`, grouped prices and the location. It was fed directly into the unchanged `normalizeGroundedCompoundCatalogReply` before runtime edits. The first focused regression failed: Video Consultation occurred twice instead of once.

Instrumentation in a temporary copy of the HEAD helper established:

| Check | Observed result on the literal inline sentence |
| --- | --- |
| Heading detection | **Fails:** `businessInformationTopics("Wir bieten an:")` returns `[]`; `isCatalogHeading` returns false. |
| Configured name matching | All five configured names match. |
| Localized numbers | All tokens pass; German readers interpret `1.500` as 1500 and `1.200` as 1200. |
| Duration/unit recognition | `Min.` is removed successfully. |
| Currency recognition | `SEK` is removed successfully. |
| List/punctuation handling | `und` is removed; punctuation is accepted. |
| Segmentation | The inline sentence remains one span. The comma immediately after `Min.` prevents a sentence split there. |
| Final catalog-role predicate | Fails because the unstripped `Wir bieten an:` still contains letters. |

The instrumented remainder was exactly:

```text
Wir bieten an:  (60 , 300 ),  (40 , 150 ),  (15 , 900 ),  (60 , 1.500 )   (60 , 1.200 ).
```

The immediate rejection is `return !/[\p{L}\p{M}]/u.test(remainder)`, caused by the earlier heading predicate leaving the preamble attached. Changing **only** that heading to the recognized canonical heading makes every service occur once. This isolates the cause; it is not a price, unit, punctuation, location or grounding defect.

## 2. Why 60/60 missed it

The previous inline tests used preambles such as `Verfügbare Dienstleistungen:` which explicitly contain a services topic. Company-heading tests supplied a matching configured business name. The literal `Wir bieten an:` production output was absent. The old German inline factory used `min` and decimal prices, not this exact observed sentence.

The original 60 tests still pass against unchanged HEAD. Of the expanded 93 tests, **22 fail on HEAD** and all 93 pass after the repair. The old invariant would reject this literal reply if it were exercised; a separate diagnostic confirmed that. Therefore the exact live escape was a missing-input coverage problem, not an assertion that falsely accepted this literal output. The strengthened invariant now examines complete lines rather than splitting at unit periods, and its own six controls require rejection of the duplicate input in every language.

## 3. Exact minimal code fix

Only the presentation helper changes in runtime code (`src/ai/business-information.ts`, 38 added / 3 removed lines including the pre-commit refinement). `server.ts` is unchanged.

The normalizer still uses recognized service/company headings. Additionally, when a colon precedes an inline body containing **all configured displayed service names**, the body can establish the catalog role without a topic word in its preamble only when the preamble has a positive offering verb and no additional factual prose. This fallback rejects numeric/scoped headings and headings identifying another topic. Existing configured-value, localized-number, unit, currency and residual-prose checks still run before a span is omitted. This avoids hardcoding `Wir bieten an:` or any other translated offering sentence.

The requested Arabic equivalent exposed a separate exact presentation condition: `Intl.ListFormat('ar')` emits the literal connector ` و`, producing `وtest`, `وvideo for tiktok`, etc. HEAD's Unicode word-boundary matcher sees those names as attached to a letter and does not match them. The helper now uses the literal connectors supplied by `Intl.ListFormat` to separate a connector only immediately before a configured name during role parsing. No global name matcher, topic recognizer, booking routing or grounding code changes.

Both existing callers continue to use the same helper: recovery's completed grounded composition and the fully grounded compound early return. The new integration tests confirm those paths through the real guard/recovery functions and verify the actual composition return before channel presentation, then verify the presented reply again.

## 4. Exact before/after helper output

These are captured executions against the same literal fixture and existing tenant snapshot. HEAD already renders the authoritative block with `•`, so its helper output differs from the supplied input's hyphen bullet glyphs even before this repair.

Before, using unchanged HEAD:

```text
Unsere buchbaren Dienstleistungen sind:
• Video Consultation (60 Minuten, 300 SEK)
• test (40 Minuten, 150 SEK)
• video for tiktok (15 Minuten, 900 SEK)
• Golden video (60 Minuten, 1500 SEK)
• Reklam (60 Minuten, 1200 SEK)
Wir haben noch weitere Leistungen. Sagen Sie mir, wonach Sie suchen, dann helfe ich Ihnen, die passende zu finden.
Wir bieten an: Video Consultation (60 Min., 300 SEK), test (40 Min., 150 SEK), video for tiktok (15 Min., 900 SEK), Golden video (60 Min., 1.500 SEK) und Reklam (60 Min., 1.200 SEK).

Sie finden uns in der Aurora Street 742.
```

After:

```text
Unsere buchbaren Dienstleistungen sind:
• Video Consultation (60 Minuten, 300 SEK)
• test (40 Minuten, 150 SEK)
• video for tiktok (15 Minuten, 900 SEK)
• Golden video (60 Minuten, 1500 SEK)
• Reklam (60 Minuten, 1200 SEK)
Wir haben noch weitere Leistungen. Sagen Sie mir, wonach Sie suchen, dann helfe ich Ihnen, die passende zu finden.
Sie finden uns in der Aurora Street 742.
```

The location sentence and canonical clarification each remain exactly once.

## 5. Safety invariants

- No change to evidence membership, candidate coverage, extraction, retries, grounding, independent entailment, contradiction rejection, negative-absence filtering, UNKNOWN filtering or tenant isolation.
- No change to booking, timeout, model, provider or semantic retrieval behavior. Recommendation and single-topic routing are unchanged.
- The helper operates only on an already grounded reply with a selected authoritative catalog. All authoritative facts still come from that tenant's configured plan.
- Separate descriptions, preparation, opening hours and contact facts remain. Other-topic/numeric headings and incomplete enumerations cannot establish this new preamble fallback.
- Location remains unchanged and occurs once. The canonical more-services clarification occurs once. UNKNOWN extra assertions still fail their existing verification gates and never reach presentation.
- No hardcoded German phrase, address, tenant ID or channel special case in runtime code. `Intl` supplies localized numeric, unit and list syntax.

## 6. Tests added and final boundary invariant

62 added tests in total: 42 in the new pure normalizer suite and 20 in the existing integration suite. The focused total is 122; the latest audit added 29 of these.

- Exact permanent German production fixture passed directly to the helper.
- Equivalent English, Swedish, Spanish, Arabic and Persian offering preambles, localized units/grouped prices and list connectors, including Arabic attached conjunctions.
- Four separate legitimate factual-prose preservation cases.
- Preparation/hours/contact/numeric heading protection and incomplete-enumeration protection.
- Six controls proving the final boundary invariant rejects a complete duplicate representation despite abbreviated units.
- Twelve real guard/composition regressions: six languages × compound recovery / fully grounded early return. Assessment diagnostics assert which path executed. UNKNOWN assertions remain excluded.

At the actual post-normalization return, assertions count exact configured names in independently identified bullet rows and complete inline representations. They inspect complete lines and recognize localized list boundaries. A second full enumeration makes the counts fail regardless of bullet/inline form; no literal whole-catalog equality is used for this invariant. Exact output equality is an additional regression assertion, not the deduplication invariant.

The previous compound, long-reply, unsupported/contradicted location, recommendation, single-topic and cross-topic regressions remain in the suite.

## 7. Test/build results

- First literal-only regression before editing runtime: **0/1 pass**, expected failure reproducing the defect.
- Expanded focused suite against unchanged HEAD: **71/93 pass, 22 fail**; original 60 remain passing.
- Literal-only repaired regression: **1/1 pass**.
- Focused repaired suite after heading refinement: **122/122 pass**.
- Broad compound/multilingual, grounding/entailment/cancellation/reuse, recommendation, WhatsApp, Knowledge, provider/reliability/queue, concision and additional channel regressions: **426/429 pass**.
- All three broad failures also reproduce with the unchanged HEAD server/helper:
  - `channel-reliability.test.ts`: existing source-proximity regex for ambiguous clarification.
  - `whatsapp-swedish-tomorrow-regression.integration.test.ts`: selected date undefined rather than `2026-08-31`.
  - `persian-instagram-post-booking-continuation.integration.test.ts`: calendar-read count 6 rather than 5.
- Targeted helper/new-unit-test TypeScript: **pass**.
- `npm run build`: **pass**, existing large-bundle warning.
- `git diff --check`: **pass**.

Legacy Gemini-mocked tests use their existing offline test-process selection; the final-path harness explicitly mocks OpenAI and rejects Gemini execution. Application configuration is unchanged. Network access is blocked during integration runs. Logs are local `.inline-live-*.log` and `.heading-safety-*.log` files. Temporary instrumented/baseline source and test copies were removed.

## 8. Files changed

1. `src/ai/business-information.ts` — local catalog preamble/list-connector recognition.
2. `src/ai/compound-business-information-final.integration.test.ts` — stronger final boundary invariant and six-language two-path regressions.
3. `src/ai/business-information-inline-catalog.test.ts` — new focused normalizer regressions.
4. `tests/fixtures/compound-catalog-inline-production-de.txt` — exact supplied live final reply.
5. This report.

## 9. Git diff summary

Two existing tracked files: **101 insertions / 9 deletions** including the latest refinement. Three new files: focused tests, literal fixture and this report. No other source files changed.

## 10. Scope confirmation

All project work stayed in `/Users/raffe/Documents/OdinLink/.production-hotfix`. HEAD remains `fa30dfe`. Nothing was committed, pushed or deployed. AI Blackbox Test, Render settings, booking, timeout, model, provider, retrieval, grounding and entailment behavior were not modified.
