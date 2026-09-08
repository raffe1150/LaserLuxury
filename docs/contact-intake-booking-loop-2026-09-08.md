# Contact intake booking loop investigation — September 8, 2026

Evidence: `aiblackbox-evidence-ec9d648a-2075-4128-b7be-478b8e10e68b.json`, read from Downloads. The artifact records Instagram/German only and has an INCONCLUSIVE final verdict because clean state and authoritative booking outcomes were not verified. Its six customer turns are reproduced verbatim in the new local test. No live requests, bookings, production mutations, conversation resets, deployment, commits or pushes were performed.

## Root cause and trace

The shared `findConfiguredBookingService` matcher accepted substrings in both directions. The evidence's catalog contains `test`; the contact surname `Testsson` therefore matched that service. The authoritative service gate treated the contact turn as a service change from `Video Consultation` to `test`. Its correct service-change cleanup cleared offered/owned slots, selected start/end and availability identity, then regenerated availability using the preserved date. This bypassed the awaiting-contact finalization handler.

Contact extraction itself preserved Alex Testsson and 0701234567 in the German reproduction. Selection and confirmation had successfully reached `awaiting_contact` with the selected September 9 14:15 slot. The date survived the erroneous service change, explaining the repeated same-day availability. The old matcher reproduced the exact six-turn failure from empty mocked state: service `test`, status `awaiting_time_selection`, no selected start/end. Existing/stale state is therefore not necessary. The production artifact has no internal state snapshot or deployed revision, so this is a source-level deterministic reproduction consistent with the evidence, not a retrospective production trace.

## Fix

`server.ts`: require Unicode letter/mark/number boundaries around configured service phrases in both containment directions. Exact service names, whole-word partial names and names embedded in booking requests remain supported. Arbitrary fragments inside words are no longer service evidence. This is one shared matcher change; no language-specific booking patch or finalization bypass was added.

The service gate's real service-change behavior and the existing contact policy, owned-slot validation, final Calendar validation, holds, buffers, duplicate protection and idempotency remain in place.

## Language scope

Before the fix, deterministic diagnostics reproduced the collision for English, Swedish, Spanish, German, Persian and Arabic on Instagram, WhatsApp, Messenger and Telegram: all 24 cases changed to `test` and returned to time selection. No tested language was immune to the collision. Persian/Arabic diagnostic turns used localized labels with the Latin surname; the final regression journeys use bare Latin name plus phone, since those labelled mixed-script forms have separate existing name-extraction limitations.

After the fix, all 24 regression journeys preserve Video Consultation and the selected September 9 14:15 start/end, complete exactly one mocked Calendar creation and database record with the correct name, phone and duration, and create no duplicates when the contact reply is repeated. The exact German six-turn sequence also completes from empty mocked state.

Existing localized contact coverage in `full-matrix-confirmation.integration.test.ts` passes for all 24 language/channel pairs. These are bounded mocked cases, not proof that every phrase in a language is healthy. Production languages other than German were not observed in this artifact; no post-fix live behavior was tested.

## Files changed for this task

- `server.ts`: configured service matching only.
- `src/ai/multilingual-contact-service-collision.integration.test.ts`: 24 contact collision journeys, exact German transcript, repeated-contact protection, Calendar conflict rejection, whole-word/Unicode matching checks.
- This report.

Pre-existing edits in `server.ts`, `full-matrix-confirmation.integration.test.ts` and `unsupported-service-explicit-date.integration.test.ts` were preserved and are not attributed to this task.

## Validation

Passed:

- New multilingual contact/service collision suite, including the exact German transcript and Calendar conflict case.
- `full-matrix-confirmation.integration.test.ts`
- `booking-completion-regressions.integration.test.ts`
- `multichannel-booking-progression.integration.test.ts`
- `canonical-availability.test.ts`
- `business-booking-buffer.integration.test.ts`
- `service-resolution-before-availability.integration.test.ts`
- `customer-intake-service-isolation.integration.test.ts`
- `unsupported-service-booking.integration.test.ts`
- `configured-service-duration-parity.integration.test.ts`
- `booking-language-continuity.integration.test.ts`
- `src/runtime/durable-idempotency.integration.test.ts`
- `npm run build` (existing bundle-size warnings only).
- `git diff --check`.

`pending-hold-lifecycle.integration.test.ts` fails at line 131 because its selected pending state is null. Removing only this task's matcher fix reproduces the same failure; the fix was restored afterward. Thus hold lifecycle does not have a passing suite here, although availability and buffer suites pass and hold code was not changed.

## Remaining limitations

- Actual historical conversation state, provider output, Calendar/hold contents and deployed revision are unavailable in the artifact.
- Separate existing mixed-script contact parsing: Persian `نام من Alex Testsson ...` extracted `من` as the name, while Arabic `اسمي Alex Testsson ...` left the name missing. Those forms are not fixed by this narrowly scoped service-matching change; ordinary localized-name coverage passes.
- Names that exactly equal a complete catalog service word, arbitrary paraphrases, additional languages, voice flows and concurrent production delivery were not established healthy by this regression.
- No deployment or production validation was performed.
