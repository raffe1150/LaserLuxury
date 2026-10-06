# Booking availability broadening audit

Baseline: `d765786dc3fee303845fdaf76b1adb123bd42ba1`.
Changes are local in `/Users/raffe/.codex/worktrees/booking-availability-broadening/OdinLink`.
The original checkout and its unrelated edits were preserved. No commit, push,
deployment, migration, or production-data access was performed.

## A–B. Root cause and reproduction

Classification: **E — multiple linked shared issues: B → A/C → D**.

The canonical schema already has `timeConstraint.kind = 'none'`, but ordinary
explicit flexibility did not produce it. The normalizer omitted the time field.
`mergeBookingRequest` intentionally treats an omitted time as inheritance, so
the previous normalized exact time survived. The runtime then passed that old
time as the authoritative current time whenever `pending.requestedTime` existed.
`deriveCanonicalAvailabilityConstraint` returned it before the later whole-day
branch could widen the search. The unchanged fingerprint reused the cached
no-availability result instead of reading the calendar again.

On untouched baseline, the equivalent sequence with “How about **at** 14:00
tomorrow?” followed by the exact reported broadening message produced:

| State/trace after broadening | Baseline |
| --- | --- |
| Canonical kind / exactTime | `exact_time` / `14:00` |
| Normalized time | `exact`, `startMinutes: 840` |
| pending.requestedTime | `14:00` |
| Date / service | `2026-10-07` / `Video Consultation` |
| min/max, boundary, daypart | Absent; the surviving restriction was exact time |
| Offers | Empty cached result from the narrow request |
| BookingNormalizedState.stateReplaced | `false` |
| Calendar reads before / after third turn | **4 / 4** |
| Fresh BookingRefinement / CombinedAvailabilityConstraint traces | None |

The literal “How about 14:00 tomorrow?” revealed an additional earlier bug:
the shared clock parser did not recognize the “How about” cue. In the baseline
deterministic harness it retained **13:00**, rather than replacing it with 14:00.
The explicit “at” variant isolates and proves the reported stale-14:00 defect.
Both variants pass after this patch. No production session state or logs were
read; these are deterministic baseline reproductions of the supplied incident.

The fingerprint cache itself is not incorrectly calculated. The parser and
authoritative constraint fed it an unchanged narrow request; caching amplified
that stale-state error. This patch changes state semantics, not reply wording.

## C. Shared channel path

Instagram, Messenger, WhatsApp and Telegram all dispatch booking turns through
`handleUnifiedBookingEngine` / `handleUnifiedBookingEngineTurn`. Their transport
identity and sending functions differ; normalization, merging, fingerprinting,
pending-state persistence and canonical availability generation are shared.

The defect affects **all four channels**. The new shared harness runs the literal
three-turn sequence for every channel × en/sv/de/es/fa/ar combination (24 cases),
using channel-owned session identifiers. It also exercises durable pending-state
restoration for each channel with intercepted, synthetic lead-store requests.

## D. Shared fix

1. Move the existing multilingual whole-day recognizer into booking intelligence
   and extend its existing grammar for availability enumeration and flexibility.
   Explicit broadening emits the existing `none` sentinel; omission continues to
   mean inheritance. A newly parsed clock, boundary or daypart wins over `none`.
2. Recognize “How about” / “What about” clock replacements in the existing parser.
   Restated multilingual dayparts are recognized on explicit broadening turns;
   ordinary turns retain their existing parsing and bounds.
3. Translate `none` into canonical whole-day or date-range availability instead
   of the old fall-through `daypart: 'none'`. Keep a retained range's end date.
4. Reuse the existing state-machine replacement path to clear offers, selection
   and fingerprints and launch a new canonical scan. Clear `requestedTime` in
   the provisional scan state too, so a failed scan cannot save the old clock.
5. Keep explicit availability refinement in the active booking flow when the
   user changes language. Avoid the business-information route for a genuine
   availability query (Spanish “horarios disponibles” previously entered it).
   A broadening turn does not become a fresh booking or clear validated contacts.
6. Allow explicit broadening to change an owned selected slot. Unrelated contact,
   parking, policy and opening-hours questions remain informational detours.
7. Tighten the shared Swedish leg-service token: German “haben” contained “ben”
   and was falsely inferred as `Benbehandling`, preventing German availability
   refinement from preserving `Video Consultation`.

No channel-specific booking implementation was added. Reminder code and
WhatsApp provisioning were not changed. Calendar and database booking mutations
are rejected by the new availability fixtures.

## E–F. Files and tests

- `server.ts`: canonical `none`, range continuity, routing/selected-slot guards,
  provisional requested-time clearing and the German false-service correction.
- `src/ai/booking-intelligence.ts`: shared flexibility recognition and normalization,
  current-clock recognition and safe restated-daypart handling.
- `src/ai/availability-broadening.test.ts`: new parser/merge tests.
- `src/ai/availability-broadening.integration.test.ts`: new shared engine tests.
- This audit report.

**83 new tests** cover A–K: exact/daypart/boundary/window removal, exact replacement,
new after/before/between/daypart constraints, unrestricted initial requests,
ambiguous and negated follow-ups, stale cached offers and fingerprints, all four
channels, all six languages, date/service/contact/tenant/user continuity,
confirmed selected slots, durable restoration, retained ranges and scan failure.

The full-day fixture verifies all **35** valid working-hours candidates are free
and **zero** are rejected by time constraints after broadening. It does not
mistake the three ranked offers for the full set of scanned candidates.

## G. Validation

- New tests plus existing multilingual date and Spanish mañana suites: **85/85 pass**.
- Build: **pass**, with the existing bundle-size warning.
- Targeted parser and new unit-test TypeScript check: **pass**.
- `git diff --check`: **pass**.
- Full project TypeScript check: blocked by six pre-existing syntax diagnostics in
  `patch_key_rotation.ts` (lines 47, 94 and 99). Identical on untouched baseline.
- Wider AI/runtime suite, identical 60-second test timeout in both checkouts:

| Checkout | Pass | Fail | Timed out/cancelled | Total |
| --- | ---: | ---: | ---: | ---: |
| Untouched `d765786` | 975 | 64 | 1 | 1,040 |
| Final patch | 1,058 | 64 | 1 | 1,123 |

The failed/cancelled test-name sets are identical (65 entries); **no additional
failures**. The extra 83 passing tests are this patch's new coverage. Build and
targeted type checks were rerun after the final source changes.

| Required validation area | Result |
| --- | --- |
| New replacement, channel × language parity, restored state | Pass |
| `booking-intelligence`, strict time constraints, weekday refinement, earliest availability | Pass |
| `multichannel-booking-progression`, `booking-progression-reliability`, booking language continuity | Pass |
| Multilingual date normalization, Spanish mañana, selected-slot confirmation, contact-submission/selected-slot | Pass |
| Messenger pending-lead and pending-booking-lead tests | Pass |
| All `src/runtime/*reminder*` suites | Pass |
| WhatsApp booking/contact, multilingual production regressions, active-slot routing, Arabic intake | Pass |
| `booking-state-machine`, `booking-completion-regressions`, `full-matrix-confirmation`, `priority-1j-channel-parity`, `priority-1k-range-availability`, `spanish-booking-boundaries` | Existing failures; repeated on baseline |
| Shared business-information suite | Timed out in both checkouts |

Examples of confirmed baseline failures: the state-machine suite has a stale
source-code regex assertion; booking-completion has a Swedish contact-name
assertion failure. Other unrelated business-information and presentation failures
also occur in both runs. No existing test was edited to conceal these failures.

The wider run includes booking progression, multilingual progression, exact-time,
strict boundaries/dayparts, earliest availability, selected-slot confirmation,
contact capture, WhatsApp booking/contact, channel parity, Messenger pending-lead
restoration and all runtime reminder regression suites. Existing failing suites
were reproduced on untouched `d765786`; their scope was not expanded into this fix.
The unrelated `shared-business-information.integration.test.ts` did not finish on
either baseline or patch and was bounded. The final run uses a 60-second test timeout.

Validation logs are local under `/tmp/odinlink-broadening-*`, including baseline
reproduction, full baseline, final full run, focused tests, build and type checks.

## H. Remaining edges

- Deterministic language recognition is deliberately conservative, not unrestricted
  natural-language interpretation. Unrecognized or ambiguous flexibility
  retains an active time preference; existing clarification handling still applies.
- Mixed availability and business-information questions may keep the informational
  route; ask a separate explicit availability question when retesting.
- Tests cover the shared deterministic engine and persistence seam, not live provider
  delivery, live calendar data or channel provisioning. Those remain live-retest work.
- The repository's baseline failures prevent claiming the entire project is green.

## I. Recommended live retest

After a separately authorized release, repeat in a test conversation on each channel:

1. “I want to book a Video Consultation for tomorrow around 13:00.”
2. “How about 14:00 tomorrow?”
3. “Could you check if you have any available times for me tomorrow?”

Use an appropriate test tenant/calendar where the narrow clocks are unavailable.
Verify turn 2 replaces 13:00 with 14:00. On turn 3 verify normalized time is `none`,
canonical availability is whole-day, requestedTime is null, bounds/daypart are absent,
offers/fingerprint are replaced, and a fresh scan occurs while date, service and
validated contacts remain intact. The scan should find any genuinely free same-day
slots; if the day is full, the response must describe the whole day, not an old clock.

Then repeat after a morning/before/after restriction, followed by “any time after
15:00” and “any time tomorrow afternoon.” Repeat representative wording from the
six-language test matrix. Finally confirm a slot and ask an unrelated opening-hours
or contact question: the selected slot must survive. Stop before a booking mutation
if the retest is intended to remain read-only.

## J. Git state

Detached HEAD remains at `d765786`; two production files modified, two new test
files and one audit report. No commit, push or deployment. The original main
checkout's local edits were not changed.
