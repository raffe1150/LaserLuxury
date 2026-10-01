# WhatsApp contact phone hotfix — 1 October 2026

All file changes and local commands were confined to `/Users/raffe/Documents/OdinLink/.production-hotfix`. Production database inspection used read-only SELECT queries. No records were repaired, no AI Blackbox Test files were changed, and nothing was committed, pushed or deployed.

## Root cause and exact resolution path

Before this fix, both `extractNameAndPhone` and `extractPhoneOnly` in `server.ts` selected the first match of `/(?:\+?\d[\d\s\-()]{6,}\d)/` anywhere in the message. They did not require a phone label or a bounded contact reply. `93414557` therefore qualified solely because it contained eight digits.

For the reported German message, the combined extractor independently matched `Mein Name ist Mira Testmann`, producing `{ name: 'Mira Testmann', phone: '93414557' }`. The name was correct; the claimed provenance of the phone was wrong.

The live engine path, with line numbers in the final source:

1. Slot confirmation resolves contact in `resolvedConfirmationContact` (`server.ts:21823`), saves `awaiting_contact`, and requests the missing name. The verified WhatsApp sender phone is already known.
2. On the name turn, `authoritativeSenderPhone` is derived from the WhatsApp conversation identity. The entry handler invokes `extractNameAndPhone` and `extractPhoneOnly`, then `resolveAuthoritativeContact` (`server.ts:16511`). It writes the result to `pending.customerName`, `pending.customerPhone`, and `pending.contactPhoneSource` (`server.ts:16524`). This is the first overwrite in the reported turn.
3. The shared new-booking branch resolves `currentTurnBookingContact` (`server.ts:20256`). The `awaiting_contact` finalization branch resolves contact again through `resolvedContact` (`server.ts:21913`). All three resolutions consume the same contact extractors; the numeric token previously won each time.
4. Complete contact proceeds through the existing selected-slot ownership, confirmation, availability, reservation and transaction guards. The pending phone is saved during finalization, supplied to `adapter.insertAppointment` (`server.ts:22454`), then to `recordAppointmentFromBooking` (`server.ts:22720`). The database payload writes it to `appointments.phone_number` (`server.ts:24981`).
5. `bookingOperationResult.customerPhone` comes from the same pending value (`server.ts:22818`). The verified confirmation and durable result outbox use that result. The completed-booking memory retains it after pending state is cleared. `notifyAdminAboutBooking` receives that pending phone (`server.ts:23010`).

## Precedence before and after

The resolver's rank order is preserved because the existing product test in `src/ai/channel-contact.test.ts` explicitly requires intentional customer phone overrides of WhatsApp sender metadata:

1. Current explicit customer phone.
2. Stored explicit customer phone.
3. Verified WhatsApp sender phone.
4. Eligible stored phone: a verified sender source on WhatsApp; validated stored contact on other channels.
5. Missing phone.

**Before:** any sufficiently long numeric token extracted from prose was falsely classified as item 1 and could become item 2 on a subsequent resolution.

**After:** only clearly identified phone input qualifies as current explicit contact. Otherwise the verified WhatsApp sender remains authoritative. Labeled customer phone fields, phone-only replies, and the existing bounded compact name/contact forms remain supported. Incidental name suffixes and free-text numbers have no phone precedence.

The source contract and this intentional override policy are documented in `src/ai/channel-contact.ts`. The precedence implementation itself is unchanged.

## Minimal implementation

- Add one shared `findExplicitContactPhone` helper used by both existing extractors. Require a phone-only reply, an immediately preceding multilingual phone label, or a bounded existing compact contact form with local/international phone syntax. Validate 7–15 digits and token boundaries. Scan all candidates so an earlier run identifier cannot hide a later labeled phone.
- Apply the same contact validation to structured understanding phone candidates: they must match explicit deterministic contact input or an already known pending phone. This changes contact acceptance only; it does not change provider invocation, provider selection, model, timeout or retrieval settings.
- Pass existing notification arguments into the test dependency so tests can inspect the actual notification input.
- Keep the existing contact-name parsers, business/catalog resolution and booking state transitions intact.

The exact reported German message now produces `Mira Testmann`, retains the verified WhatsApp sender phone, and completes the selected booking normally. Its `AIBB 93414557` suffix does not become a phone.

## Persistence audit

Read-only inspection identified live appointment **285**, business **3**, created **1 October 2026 at 11:29:59 Europe/Stockholm**. Its name is `Mira Testmann`, its stored phone is `93414557`, and its sender identity ends in **2287**. Earlier Mira Testmann bookings retain the verified sender phone ending in 2287.

| Destination | Finding | Evidence / limit |
| --- | --- | --- |
| Booking record | **Confirmed persisted corruption.** Appointment 285 has `phone_number = '93414557'`. | Direct production SELECT. |
| Calendar event | Wrong phone is supplied to insertion and stored in the Google event summary by this path. | Source trace and local baseline reproduction confirm the wrong summary. Live result outbox records verified event `eqjs9ljkpbbcmt01fvfi40c3pc`; the remote event summary was not directly read. |
| Customer confirmation/result outbox | **Confirmed persisted and delivered corruption.** | Live `booking_result_outbox` for booking 285 has `customerPhone = '93414557'`, `Mobil: 93414557`, and status `delivered`. The bot confirmation is also present in live chat history. |
| Admin notification payload | Wrong phone reaches `notifyAdminAboutBooking` and the formatted notification payload. | Source trace and captured baseline notification input confirm the bad phone. Actual admin delivery was not independently verified; no matching run token was found in `business_notifications`, which is not an admin-message delivery ledger. |
| CRM/contact state | The current matching lead **3925** has null `customer_name`, `phone_number`, and `ai_summary`; no surviving wrong phone in those lead fields was observed. | Direct production SELECT. The pending booking summary temporarily persists the pending phone during finalization, then `clearPendingBooking` clears `ai_summary`. Completed-booking memory and the durable terminal result retain the phone; the live terminal result is confirmed corrupted. |

This was a persistence defect, not a display-only defect. Existing production data remains unchanged by this hotfix task.

## Regression coverage

Added **16 regression cases** across the new `src/ai/contact-phone-provenance.integration.test.ts` and the existing `src/ai/contact-submission-selected-slot.integration.test.ts`:

- Verified WhatsApp phone with an unlabelled numeric name suffix and with the exact German AIBB message.
- German, English, Swedish, Spanish, Arabic and Persian name messages, including localized digits.
- Ordinary prose and reference/order numbers do not become phone contact.
- Explicit multilingual phone labels, phone-only replies, and compact contact replies remain accepted.
- A numeric name identifier without any channel phone keeps contact incomplete; a subsequent legitimate phone completes booking on WhatsApp, Telegram, Messenger and Instagram.
- Intentional labeled customer phone override on WhatsApp still works.
- Structured understanding cannot promote a run identifier to phone, with or without a known sender phone.
- Calendar creation, booking-record input, notification input, completed-booking contact state and final confirmation contain the correct name and phone. Selected service/date/time/duration and slot ownership remain intact; no new availability scan or reset to slot selection occurs.

An isolated local reproduction using the old numeric extractors confirmed `93414557` in the calendar summary, booking-record input, notification input, completed state and final confirmation. Temporary reproduction source files were removed.

## Checks and results

All test runs used the repository's offline network guard; no live provider requests or live booking writes were made by tests.

| Check | Result |
| --- | --- |
| Booking contact/state, WhatsApp, multilingual and wider booking regressions | **50 passed / 56 reported tests; six baseline failures.** |
| Provider-independent booking/contact/multilingual suite with `AI_PROVIDER=gemini` | **29/29 passed.** |
| Same suite with `AI_PROVIDER=openai` | **29/29 passed.** |
| `npm run build` | **Passed.** Existing bundle-size warnings only. |
| `git diff --check` | **Passed.** |

The six remaining failures were reproduced with the original `HEAD:server.ts` restored temporarily, then the hotfix source was restored in `finally`:

- `booking-state-machine.test.ts`: stale source-text assertion for the slot-confirmation expression.
- `customer-intake-service-isolation.integration.test.ts`: single-line date/time regex against a multiline confirmation.
- `priority-1i-live-recovery.integration.test.ts`: expected reschedule operation versus none.
- `priority-1j-channel-parity.integration.test.ts`: expected `awaiting_service` versus `awaiting_time_selection`.
- `spanish-booking-boundaries.integration.test.ts`: existing contact-transition expectation.
- `whatsapp-swedish-tomorrow-regression.integration.test.ts`: expected legacy selected-date field absent.

The untouched baseline run passed German multifactual contact and booking-language continuity tests. Those tests also pass with the final fix. No unrelated failing expectations were changed.

Local logs: `.contact-phone-booking-suite.log`, `.contact-phone-baseline-suite.log`, `.contact-phone-provider-gemini.log`, `.contact-phone-provider-openai.log`, `.contact-phone-reproduction.log`, `.contact-phone-build.log`.

## Files changed

1. `server.ts`: shared explicit phone extraction, contact candidate validation, notification test input.
2. `src/ai/channel-contact.ts`: explicit provenance and precedence comments only.
3. `src/ai/contact-submission-selected-slot.integration.test.ts`: booking/contact regressions and payload capture.
4. `src/ai/contact-phone-provenance.integration.test.ts`: extraction and multilingual explicit phone regressions.
5. `docs/whatsapp-contact-phone-hotfix-2026-10-01.md`: this audit.

No commit, push, deployment, production write, business-info/catalog change, contact-name parser change, model/provider configuration change, timeout change or retrieval change was performed.
