# Arabic Instagram regressions — local investigation and fixes

Primary evidence: `/Users/raffe/Downloads/AIBlackBoxTestPlatform/artifacts/full-booking-matrix/full-booking-matrix-2026-09-07T22-07-40-573Z.json`, scenario `instagram-ar`, turns 2 and 6–7. Both failures reproduced locally before the fixes.

## Contact root cause and path

Both `extractNameAndPhone` and `extractNameOnly` used an Arabic pattern accepting only one word, followed immediately by a limited connector or end of input. Consequently neither `اسمي لينا اختبار ورقم هاتفي 0700001106.` nor `اسمي لينا اختبار.` yielded a name. The name-only sentence also ended in punctuation not admitted by that pattern. The general name cleaner truncates to two words, so merely expanding that capture would still truncate longer Arabic names.

At shared booking entry, `extractNameAndPhone` / `extractPendingBookingCustomerName` feed `resolveAuthoritativeContact`. The phone-only fallback correctly captured the number, while the missing name remained null in pending state. `getMissingBookingContact` therefore continued requesting the name and prevented finalization. The reproduced defect is extraction, not selected-slot loss or a failed Calendar mutation.

A shared `extractExplicitArabicCustomerName` now handles anchored Arabic self-identification, with an optional short affirmative or “أنا” lead, terminal punctuation and a bounded phone suffix. It preserves one-to-six-word Arabic-script names and diacritics without passing through the truncating cleaner. It rejects embedded/quoted self-identification, questions, numeric names, field contamination and booking instructions rather than trimming them into plausible names. Localized phone digits still use the existing phone normalization.

The existing authoritative contact resolver remains unchanged: configured services cannot become customer names, including Arabic service names. Tests also seed an Arabic service as contaminated pending customer data and verify it is removed. Contact collection and finalization continue through the existing shared state and mutation paths.

## Unsupported-service root cause and path

`extractConcreteRequestedService` recognized Arabic “في” as a date delimiter but omitted “بتاريخ”. In `أريد حجز تصوير زفاف بتاريخ الاثنين، 14 سبتمبر 2026.`, the dated-service rule could not isolate `تصوير زفاف`, and the fallback rule could not consume the date's digits. `resolveAuthoritativeBookingService` therefore received no concrete service evidence and selected the missing-service response, not unsupported-service rejection.

Adding “بتاريخ” to the existing delimiter list isolates the requested service without editing the original date-bearing message. Existing catalog matching now returns unsupported, presents only configured choices, and retains September 14. The tests verify that selecting `test` later preserves that date and that no availability read occurs for the unsupported request.

## Changed files

- `server.ts`: routes Arabic name extraction in `extractNameAndPhone` and `extractNameOnly` through the shared helper; removes the two obsolete Arabic patterns; adds the date delimiter in `extractConcreteRequestedService`.
- `src/ai/arabic-customer-name.ts`: new deterministic Arabic self-identification helper.
- `src/ai/arabic-booking-intake.integration.test.ts`: exact artifact contact replies, multi-word/diacritic variants, combined affirmative contact, localized digits, negative cases, service-name validation, and 16 mocked contact journeys across four channels.
- `src/ai/unsupported-service-explicit-date.integration.test.ts`: exact artifact request, including clean, unresolved and stale-availability contexts on Instagram and WhatsApp.
- This report.

## Exact validation results

Each suite was run with `npx tsx src/ai/<filename>`.

| Suite | Result |
|---|---|
| `arabic-booking-intake.integration.test.ts` | PASS — extraction assertions and 16 shared contact journeys |
| `unsupported-service-explicit-date.integration.test.ts` | PASS — 48 service/date recovery cases plus 2 time-retention cases |
| `channel-contact.test.ts` | PASS |
| `customer-intake-service-isolation.integration.test.ts` | PASS |
| `service-resolution-before-availability.integration.test.ts` | PASS |
| `unsupported-service-booking.integration.test.ts` | PASS |
| `service-clarification-presentation.integration.test.ts` | PASS |
| `multilingual-slot-confirmation.test.ts` | PASS |
| `full-matrix-confirmation.integration.test.ts` | PASS — 24 channel/language cases |
| `multichannel-booking-progression.integration.test.ts` | PASS |
| `selected-slot-confirmation.integration.test.ts` | Existing baseline FAIL at line 289 |

The failing suite expects `/only need your name/`, but receives `To complete the booking, please provide your name.` Restoring `server.ts` to HEAD and rerunning reproduced the identical failure; the local fix was then restored. No new suite failure remains.

The new contact journeys assert no mutation while required contact is missing; selected start, selected end and service remain intact; complete contact causes exactly one mocked Calendar creation and one mocked database insertion with the same interval and correct customer name. No external persistence is used in that fixture.

`npm run build`: PASS, with the existing large-bundle warning. `git diff --check`: PASS.

## Limits and change controls

Production behavior after these local changes has not been tested. The artifact itself lacks authoritative Instagram sender identity, so its booking verification was unavailable. Deterministic name intake intentionally supports bounded explicit self-identification, not arbitrary prose or every possible name format; unsupported formats continue to request clarification.

No availability filtering, Calendar conflict checks, holds, buffers, idempotency, booking mutation safety or unrelated architecture was changed. No real booking, production conversation reset, commit, push or deployment was performed. No broader architectural change was required.
