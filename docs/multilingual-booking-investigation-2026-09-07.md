# Multilingual booking investigation — September 7, 2026

Scope: local changes only, using Blackbox artifact `full-booking-matrix-2026-09-07T20-20-32-485Z.json`. No live booking, full live matrix, commit, push or deployment was performed. Production has not received these fixes.

## 1. Runner causes and fixes

All changes are shared by Instagram, WhatsApp, Messenger and Telegram.

- German: service detection omitted **Leistung**. The exact reply “Gerne. Welche Leistung möchten Sie buchen?” is now recognized.
- Spanish: confirmation detection included **reservar**, but not the conjugated request “¿Quieres que lo reserve?”. The shared rule now recognizes that request and closely related polite forms.
- Persian dates: `Intl.DateTimeFormat('fa', ...)` used the default Persian calendar to derive the expected month, although scenario dates are Gregorian. Explicit Gregorian month formatting now recognizes “جمعه 18 سپتامبر”. Persian/Arabic digits, compatibility Unicode and directional formatting markers are normalized.
- English/Instagram: the generic service pattern **which one** matched “Which one should we go with?” following an actual time list. Shared service detection now disambiguates that phrase using concrete offered times. Explicit “which service” questions still fail after service selection.
- Additional artifact failure: Persian “چه خدماتی” was missed because the service vocabulary lacked **خدمات**. Added it.
- Daily limits: replies now stop at any stage as `INCONCLUSIVE`, with `failureCategory: channel-daily-limit`. The final Telegram DE/FA/AR scenarios are limit evidence, not language failures.

Failure, selected-time/date contradiction, future/conditional success rejection, combined name+phone detection and bounded no-retry behavior remain in place. No LLM judgment was introduced.

## 2. Exact changed files/functions

Blackbox root: `/Users/raffe/Downloads/AIBlackBoxTestPlatform`.

- `odinlink-service-matrix-support.mjs`: `asciiDigits`, `languageCases`, new `isServiceRequest`, new `isDailyLimitReply`, and `nextBookingAction`.
- `odinlink-service-matrix.mjs`: exported `dateIsPreserved` with Gregorian month lookup; `runFullScenario` uses shared service detection and its `send` helper stops on daily limits.
- `tests/odinlink-service-matrix-full-booking.test.mjs`: exact artifact reply regressions, localized digits, contradictory service/date checks, limit classification, and updated 24 mocked journeys.
- `docs/odinlink-full-booking-runner.md`: duration evidence, target requirements and focused next command.

OdinLink root: `/Users/raffe/Documents/OdinLink`.

- `src/ai/booking-state-machine.ts`: `isPositiveBookingConfirmation` adds Swedish imperative **slutför**, German **schließen/schliessen**, Arabic completion vocabulary in the parser's normalized alphabet.
- `src/ai/booking-intelligence.ts`: `normalizeBookingRequest` requires word boundaries for Persian correction terms.
- `server.ts`: only the Persian expression in `isPendingSelectionRejectionRequest` changes, requiring word boundaries. No server refactor.
- `src/ai/multilingual-slot-confirmation.test.ts`: exact confirmations, normalized Arabic variants, Persian correction and negative-confirmation regressions.
- `src/ai/full-matrix-confirmation.integration.test.ts`: new shared production-boundary test covering all 24 channel/language pairs.
- This report.

## 3. Confirmed confirmation defects

Swedish “Ja, slutför bokningen tack.” was not accepted because the parser recognized the infinitive **slutföra**, not imperative **slutför**. Arabic “نعم، يرجى إتمام الحجز.” lacked the **إتمام** continuation. Existing Arabic confirmation expressions also used letters inconsistent with the parser's hamza removal and kaf/yeh normalization.

The shared path is `normalizeBookingRequest` → `isPendingSlotConfirmation` / `isPositiveBookingConfirmation` → owned-slot continuation and state transition → contact collection. The local boundary reproduced the Swedish loop with the selected slot still present. The cause is affirmative recognition, not demonstrated loss of state. Matching the normalized completion vocabulary lets the existing shared path advance. Production logs were not available to exclude additional causes for every historical turn.

The all-language test exposed an additional confirmed Persian defect: **نهایی** (“finalize”) contains **نه** (“no”). Both correction and selected-slot rejection expressions matched that substring. The selected-slot rejection guard caused a fresh availability search even though confirmation had been recognized. Word boundaries fix that false rejection while tests retain actual Persian rejection/correction behavior.

All 24 shared boundary cases now select an offered slot, confirm using the runner's exact localized confirmation, retain the selected start/end, and enter `awaiting_contact` without Calendar or database creation. Contact requirements, owned-slot validation and final mutation protections remain in the existing path. No changes were made to holds, buffer rules, conflict filtering or duplicate-booking protection.

## 4. Availability: insufficient evidence for the reported regression

A read-only Google Calendar query covered September 14–October 16. It returned 20 events, no further page, timezone **Europe/Stockholm**. A read-only business lookup matched that Calendar to business **3**. Relevant confirmed events:

| Calendar event ID | Local interval (+02:00) | Created (UTC, September 7) |
|---|---|---|
| `51o1mbvlvqdn46uiqehbj8uk7g` | September 14, 14:00–14:30 | 19:00:37 |
| `kba6dg1r8ftt7lqgjadgl0mv4k` | September 14, 13:15–13:45 | 19:07:26 |
| `647aul39mibba6k2jvv52b1ecs` | September 14, 14:45–15:15 | 20:08:59 |
| `u329vktf1aho9hgslqg0eiab88` | October 8, 14:00–14:30 | 20:19:58 |

The latest Instagram/EN scenario ran 20:11:00–20:11:21 UTC and offered **September 14 at 15:30, 15:45 and 16:00**. Thus the proposed September 14 14:00 re-offer is disproven for this reply. Later 14:00 offers in this matrix use different dates. A comparison of all its offered 30-minute intervals against retrieved events created before each scenario found **zero overlaps**.

The October 8 event was created during Telegram/EN's 20:19:42–20:20:00 scenario, consistent with its conversational completion. This retrospective event evidence does not replace the unavailable before/after observer verification.

Code inspection: `loadCanonicalAvailabilitySnapshot` reads Calendar events and pending holds; canonical candidate validation checks buffered Calendar events and pending events through shared interval checks. Language affects parsing/presentation, not overlap arithmetic. No availability defect was reproduced, so no availability logic or speculative conflict test was added.

Still missing for the user's separate observation: the exact later reply and timestamp, its real date and channel/business identity, and the specific occupied event it allegedly overlapped. Historical Calendar edits/deletions, the runtime snapshot, hold state, service configuration and buffer configuration at that time are not captured by this JSON. The current Calendar read cannot reconstruct all historical state.

## 5. Observer and duration

`createBookingObserver` exits before target setup when neither `--service-duration-minutes` nor `AIBB_TEST_SERVICE_DURATION_MINUTES` supplies a positive integer. That explains the artifact's duration message.

Read-only business configuration explicitly lists active service **test**, `durationMinutes: 30`. This is structured service evidence, not inference from its name. The four events above also last 30 minutes. The safe existing option is **`--service-duration-minutes 30`**, subject to the service configuration remaining unchanged.

The checked-in local target's `defaultDurationMinutes: 60` is not a service-specific value and was not adopted. Its localhost URL also does not prove production booking state. A production Test Bridge target, correct business, authentication and verified channel sender identity remain necessary for authoritative validation.

## 6. Validation

- Blackbox focused suites: **21/21 tests passed**, including **24/24 mocked complete journeys**. Recorded openings/availability/confirmation replies are used where available; unsupported-service rejection, contact and completion are synthetic. Mock success does not erase production assertion failures.
- OdinLink new shared boundary: **24/24 confirmation cases passed**.
- Existing multilingual confirmation, canonical availability, business booking buffer, and multichannel booking progression suites passed.
- Production build passed. Existing large-bundle warnings remain.
- `git diff --check` passed.

Four existing suites failed identically when rerun with the three production files restored to HEAD, then the fixes were restored:

| Baseline suite | Failure |
|---|---|
| `booking-state-machine.test.ts:296` | Source-text assertion expects an obsolete two-argument call. |
| `pending-hold-lifecycle.integration.test.ts:131` | Fixture produces null pending state before `.status` access. |
| `canonical-availability-observability.integration.test.ts:178` | Expected positive pending-hold blocked count is false. |
| `selected-slot-confirmation.integration.test.ts:289` | Expected “only need your name”, actual “To complete the booking, please provide your name.” |

No new failing suite was observed. These baseline failures were left outside this focused fix.

## 7. Remaining limitations

WhatsApp EN/AR returned an operation-clarification question after selecting a slot; the runner correctly stopped rather than inventing a response. Their production root cause remains unconfirmed. Messenger/EN timed out awaiting the supported-service reply; that alone cannot distinguish transport/channel failure from application failure. Some unsupported-service turns did not explicitly reject the request; those assertion failures remain preserved. Arbitrary paraphrases and mixed-language replies remain bounded by deterministic vocabulary. No deployed behavior was validated after these local changes.

## 8. Exact next live test — documented, not executed

After separate deployment, the daily limit reset, and configuration of the verified production Test Bridge target and Instagram sender identity:

```sh
cd /Users/raffe/Downloads/AIBlackBoxTestPlatform
: "${AIBB_INSTAGRAM_TEST_BRIDGE_USER_ID:?Set the verified Instagram sender identity}"
node odinlink-service-matrix.mjs --full-booking --channels instagram --languages sv --service-duration-minutes 30 --target-config "${AIBB_PRODUCTION_TARGET_CONFIG:?Set the production Test Bridge target config path}" --acknowledge-real-bookings --acknowledge-no-cleanup
```

This is one scenario, not the 24-case live matrix. It can create a real booking. A production target file path was not invented; the shell requires it explicitly.

## 9. Change controls

No commit, push, deployment, real booking, cleanup mutation or full live matrix was performed. Calendar and business configuration access was read-only. No blind retry behavior was added.
