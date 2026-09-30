# Verified compound topics lost during final presentation — 2026-09-30

## Root cause

**The verified location survives `recoverCompoundBusinessInformation`; it is subsequently removed by final sentence/word trimming in the channel handler.** This is a final reply composition bug controlled by presentation-budget classification. It is not a claim-topic mapping, recovery-ordering, recovery early-return, evidence or entailment failure.

`getFinalConversationConcisionBudget` previously returned 90 words only for a pure service-catalog question or recommendation question. `isServiceCatalogQuestion` defaults to `allowAdditionalTopics=false`, so the correct services + contact/location classification makes the pure-catalog check return false. The German compound question is not a recommendation; it therefore fell through to **45 words**.

After recovery prepends the authoritative tenant catalog, `enforceFinalConversationConcision` retains complete sentences until the budget is exhausted. The tenant-3 German recovered answer has 65 words: 57 in the formatted catalog plus its conversational follow-up, then eight in the verified location quote. The first catalog sentence contains 43 words. The following sentence exceeds the remaining two-word allowance, so the loop executes `break`. Everything after it—including the independently ENTAILED address—is discarded. The output keeps 43 words of catalog and omits the location.

Earlier guard-only tests stopped before this final channel concision stage, which explains why successful extraction/entailment and recovery tests did not catch the omission.

## Production-shaped reproduction

Uses the exact German customer question, the existing verified tenant-3 fixture and three claims: catalog ENTAILED, extra structured claim UNKNOWN after retry/adjudication, location ENTAILED. The full assessment has verified evidence but fails entailment. Compound recovery safely drops the extra assertion, keeps the catalog and keeps the exact location quote.

The reconstructed location fields match the previously observed production fingerprints as well as the newly supplied lengths:

| Field | Length | Fingerprint |
|---|---:|---|
| Location atomic claim | 52 | `ba16d238433d` |
| Location candidate quote | 40 | `de3879a711b8` |
| Exact retrieved Knowledge quote | 39 | `829d6071a335` |

The address is derived from `tests/fixtures/business-information-tenant3.json`; no address is hardcoded in runtime code. The reproduction does not claim the entire generated candidate is verbatim production text. Its verified location spans match, and the final authoritative catalog is constructed by the existing production formatter.

Before editing runtime code, the new tests reproduced the omission in all six supported languages: German, English, Swedish, Spanish, Persian and Arabic. Eleven tests failed on the baseline; the unchanged single-topic/recommendation-budget tests passed. After the fix all fifteen pass.

## Exact call path

1. `assessmentClaimsAreEntailed` runs independent checks in parallel against exact citations. The location is ENTAILED; the unrelated structured claim remains UNKNOWN after independent retry and adjudication.
2. The aggregate `results.every(result => result.entailed)` fails. `guardBusinessSupportGrounding` cannot return the whole candidate and enters `recoverCompoundBusinessInformation`.
3. `businessInformationTopics(customerMessage)` identifies `services` and `contact`; recommendation exclusion does not apply.
4. Each claim must still be a contiguous candidate quotation and pass `assessmentHasVerifiedEvidence` before entailment. Operation-local reuse preserves the already completed exact verdicts; UNKNOWN stays rejected.
5. The location's atomic claim contains the location cue recognized by the contact pattern. `claimTopics` therefore includes `contact` even though its candidate quote uses different wording. Topic mapping is correct in this production-shaped case.
6. The catalog replacement condition requires all cited sources to be `structured_business_config` with service/price-field quotes. The location cites `retrieved_knowledge`, so it cannot be replaced by the catalog.
7. Recovery adds the exact verified location quote, prepends the authoritative catalog, records both supported topics, and adds no location knowledge gap. Exact-string deduplication cannot equate these different parts. There is no early return dropping the location.
8. The channel then runs repetition/CTA/identity presentation, followed by `enforceFinalConversationConcision(reply, getFinalConversationConcisionBudget(question))`.
9. The old 45-word budget trims the recovered answer before the location sentence. This is the actual demonstrated loss point.

WhatsApp, Telegram, Messenger and Instagram use the same final budget and concision functions after grounding. The regression runs the actual server guard/recovery and those same final functions; OpenAI Responses is mocked to provide the prescribed verdicts, while the evidence, parsers, entailment/retry/adjudication, result reuse and composition code run normally. No live Blackbox replay or deployment was performed.

## Exact minimal repair

Eight inserted lines in `getFinalConversationConcisionBudget`:

```ts
if (
  isBusinessInformationQuestion(latestCustomerMessage) &&
  businessInformationTopics(latestCustomerMessage).length > 1 &&
  !isBusinessRecommendationQuestion(latestCustomerMessage)
) return Number.POSITIVE_INFINITY;
```

This is a **word-trimming exemption**, not a timeout. It preserves the complete already-grounded compound answer, including later requested topics and explicit missing-information notices. A larger finite word budget could repeat the same bug with a longer verified quote; a regression exceeding 90 words demonstrates why simply using the catalog's 90-word budget is insufficient for the required preservation rule.

The rule uses the existing shared multilingual business-information/topic recognizers. Neither recognizer nor semantic routing was modified. It applies across channels without a German/tenant/address special case. The existing pure service-catalog budget remains 90, single-topic location remains 45, recommendation remains 90, and actual booking-action requests do not enter this business-information exemption.

## Safety remains equivalent

Only presentation after grounding changes. Extraction coverage, exact evidence/candidate checks, independent entailment, UNKNOWN retries/adjudication, negative-absence gates, contradiction rejection, unsupported filtering, tenant snapshot boundaries and operation-local verifier reuse are untouched. The UNKNOWN extra clause is never emitted; catalog facts still come from the authoritative tenant config. Failed/fabricated location evidence never reaches location entailment and never reaches the reply.

Missing location continues to produce the explicit location/address knowledge-gap notice. That notice now survives final presentation instead of being accidentally trimmed along with later facts. Recommendation handling and its budgets are unchanged. Single-topic replies still use their prior budgets and require exact evidence plus independent entailment.

## Tests added

`src/ai/compound-business-information-final.integration.test.ts` contains fifteen regressions:

- Six language cases preserving both authoritative catalog and independently ENTAILED location after unrelated UNKNOWN retry/adjudication.
- Unsupported location rejection with a preserved location-gap notice.
- Contradicted location rejection.
- Fabricated location evidence rejection before location entailment.
- Reversed English topic/claim ordering.
- A long verified compound quote exceeding 90 words, preserving the entire quote.
- Unchanged recommendation, single-service, single-location and booking-action budgets.
- Unchanged single-topic service/location replies with required independent entailment.
- Unsupported extra structured assertion excluded without suppressing the verified location.
- Recommendation catalog and natural clarification unchanged through final presentation.

Tests assert one extraction, one actual location entailment, three distinct UNKNOWN phases for the extra claim, no extra-clause emission, each displayed service only once, complete canonical catalog, and no fabricated missing-location disclaimer when location is verified. The actual-path OpenAI harness fails if Gemini executes.

## Verification

- New focused tests: **15/15 pass**.
- Broad grounding/entailment, compound/multilingual business information, recommendation, WhatsApp, provider, knowledge, queue and reliability regressions: **304/306 pass**. The two failures are previously reproduced baseline failures in `channel-reliability.test.ts` (source-proximity regex) and `whatsapp-swedish-tomorrow-regression.integration.test.ts` (selected-date assertion). Their affected code was not changed.
- Targeted business-information TypeScript: pass.
- Server plus new test TypeScript: **16 existing diagnostics on HEAD and modified source; zero introduced**.
- `npm run build`: pass, existing large-bundle warning.
- `git diff --check`: pass.

## Files and scope

- `server.ts`: eight added lines in final presentation-budget selection.
- `src/ai/compound-business-information-final.integration.test.ts`: 169 new lines / fifteen tests.
- This report.

All work stayed in `/Users/raffe/Documents/OdinLink/.production-hotfix`. Nothing was committed, pushed or deployed. No Render, timeout, model or provider settings changed. No edits to booking logic, semantic retrieval, recovery/entailment logic, temperature compatibility, tool schemas, protected diagnostic blocks or key rotation.
