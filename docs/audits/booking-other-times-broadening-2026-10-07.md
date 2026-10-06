# Shared alternative availability follow-ups

Baseline: `4dd45518a036ff7d5434b73c120319a221338a94`.
Local worktree: `/Users/raffe/.codex/worktrees/booking-other-times/OdinLink`.
No commit, push, deployment, migration or production-data changes.

## Reproduction and exact root cause

The deterministic shared-engine harness reproduces the live sequence with an
occupied calendar interval from 13:00 to 14:30 tomorrow and other free slots:

1. `I want to book a Video Consultation for tomorrow around 13:00.`
2. `How about 14:00 tomorrow?`
3. `Do you have any other times available tomorrow?`

On untouched production code, the third turn retains canonical `exact_time`,
`exactTime = 14:00`, normalized `exact` / 840 minutes and `requestedTime = 14:00`.
`stateReplaced` is false. Calendar reads remain 4 before and 4 after. The reply is
exactly `Which proposed time would you like? I can show the list again if you ask.`

`isWholeDayAvailabilityRequest` recognized `any times`, `available times` and
`what times`, but did not recognize the intervening alternative modifier in
`any other times`, `what other times`, or reversed `times available`. Therefore
`normalizeBookingRequest` omitted a time constraint instead of emitting `none`.
`mergeBookingRequest` intentionally inherits omitted fields. In the unified
engine, the exact canonical constraint and offer fingerprint consequently remain
unchanged; the cached-offer branch returns the selection prompt without scanning.

Multilingual reproduction exposed another shared routing conflict: Swedish
`andra tider` matched the ordinal `andra` (second) in slot selection. An apparent
owned-slot selection bypassed normalized state merging and selected slot two.

Classification: missing alternative-enumeration semantics in the recognizer,
plus an ordinal-selection precedence conflict. The merge/cache behavior is
correct once explicit removal is represented; neither needs a redesign.
The paths are shared by Instagram, Messenger, WhatsApp and Telegram.

## Narrow shared fix

- Extend the existing recognizer with request cues paired with alternative
  time/slot nouns in English, Swedish, German, Spanish, Persian and Arabic.
  Availability ellipsis such as `Anything else available tomorrow?` is recognized.
  Bare `other`, `another`, `different` or `else` does not revoke restrictions.
- Keep existing business-information exclusions and reject negated requests for
  alternatives before fallback broadening patterns can match.
- Let explicit availability broadening bypass owned-slot ordinal selection.
  Ordinary ordinal and exact slot selections retain their normal behavior.
- Recognize the explicit exact-clock availability question `Is 18:00 available?`
  in the existing contextual exact-time parser. This safety case also failed on
  untouched 4dd4551, retaining 14:00; it now becomes an exact request for 18:00.

The existing normalization/state transition then emits `timeConstraint.kind =
none`, invalidates owned/text offers and the narrow fingerprint, clears the
requested clock/bounds/daypart and launches a fresh scan. A restated clock,
boundary or daypart wins over `none`. Service, resolved date, validated contacts,
operation, tenant, recipient and channel remain intact.

## Changed files and tests

- `src/ai/booking-intelligence.ts`: shared recognition and exact-question parsing.
- `server.ts`: shared owned-slot selection guard.
- `src/ai/availability-broadening.test.ts`: parser/merge and ambiguity coverage.
- `src/ai/availability-broadening.integration.test.ts`: calendar-backed shared
  harness with narrow cached alternatives, channel/language parity and guards.
- This audit report.

122 added cases: 38 unit/state cases and 84 shared-engine cases. The resulting
focused suite contains 205 cases. It covers every requested English formulation
except the deliberately ambiguous `Do you have something else tomorrow?`, which
preserves the active restriction. Representative sv/de/es/fa/ar formulations run
through every channel. Calendar changes prove that cached offers are replaced;
a separate four-channel scenario leaves both clocks busy and proves that every
returned offer is actually free. New boundaries/dayparts survive; bare alternative
words, unrelated payment/parking/contact questions and negative flexibility do
not clear constraints. Existing confirmed-slot and durable-state tests remain.

`Can you show those times again?` preserves the exact constraint, same fingerprint
and offers and displays the list. The baseline revalidates the narrow calendar
on this wording; this patch preserves that behavior rather than converting it
to whole-day broadening.

## Validation

- Final focused broadening suite: **205 passed**, including **122 new cases**.
- Required regression group: **437 passed / 438**, covering booking intelligence,
  exact/boundary/daypart and weekday refinement, earliest availability, booking
  progression and language continuity, selected-slot confirmation/contact, Messenger
  pending leads, all reminder suites, WhatsApp booking/identity/proactive safety and
  voice ordering. The sole failing WhatsApp Swedish tomorrow suite fails identically
  on untouched `4dd4551` at its line 117 (`selectedDate` undefined instead of
  `2026-08-31` in awaiting-contact state). Four additional still-busy calendar cases
  pass separately and are included in the final 205-case focused suite.
- Full AI/runtime/provider comparison before the last negative-case additions:
  patch **1,178 passed, 64 failed, 1 cancelled** / 1,243; baseline **1,063 passed,
  64 failed, 1 cancelled** / 1,128. All **65 failing/cancelled TAP names are identical**.
  Existing failures include source assertions, booking completion/confirmation,
  channel parity/date-range cases, business-information/provider/presentation cases
  and a shared-business-information test timeout. No new failing name.
- Final full AI/runtime/provider run: **1,185 passed, 64 failed, 1 cancelled** /
  **1,250**. The same **65 failing/cancelled names match untouched baseline**;
  this run includes all final guard changes and all 122 added cases.
- Build: **passed**, with existing bundle/chunk size warnings.
- Targeted TypeScript check of booking intelligence and broadening unit tests:
  **passed**.
- Full-project TypeScript check: blocked by the same six syntax errors in
  `patch_key_rotation.ts` on patch and untouched baseline (lines 47, 94 and 99).
- `git diff --check`: **passed**.

Commands used (local mocked fixtures; no production database/calendar writes):

```sh
node_modules/.bin/tsx --test src/ai/availability-broadening.test.ts src/ai/availability-broadening.integration.test.ts
node_modules/.bin/tsx --test --test-concurrency=4 --test-timeout=60000 src/ai/*.test.ts src/runtime/*.test.ts src/ai/providers/whatsapp-voice-ordering.test.ts
npm run build
node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --isolatedModules src/ai/booking-intelligence.ts src/ai/availability-broadening.test.ts
npm run lint
git diff --check
```

Baseline comparison uses a separate detached checkout with production code and tests
restored to `4dd4551`. Targeted reproductions additionally copied the new tests into
that checkout without changing production code. Log artifacts are local under
`/tmp/odinlink-other-times-*.log`.

## Final Git scope

Detached at `4dd4551`: four modified source/test files and this new audit report.
Production changes comprise 30 added lines across two files. No tracked baseline
files outside this scope were edited; the user's dirty primary checkout was left
untouched. Temporary dependency links and the comparison checkout are removed
when validation is complete.

## Ambiguity limits

The recognizer remains deterministic and intentionally conservative. An elliptical
`Do you have something else tomorrow?` without time/slot/availability semantics
could mean another service; it does not broaden. Negated alternative requests and
unrelated information stay outside broadening. This is representative multilingual
coverage, not a guarantee for every paraphrase, mixed intent or complex negation.
Broadening enumerates valid availability and does not promise to exclude every
previously offered free slot; an unchanged calendar may yield some of the same
valid alternatives from a fresh scan.

## Recommended live retest after an authorized release

On each channel, use a test conversation and a known busy tomorrow at 13:00 and
14:00, with other free slots. Request Video Consultation at 13:00, then
`How about 14:00 tomorrow?`, then the exact reported `Do you have any other times
available tomorrow?`. Confirm actual available alternatives and no selection
clarification. In diagnostic logs, verify normalized `none`, canonical whole-day,
null requested time, replaced fingerprint and `freshScanStarted = true` with the
same service/date/contact/owner context. Repeat representative language wording,
then `any other times after 15:00 tomorrow` and `Is 18:00 available?` to verify
restated restrictions. Re-list offers and ask an unrelated question after choosing
a slot; verify the selected slot survives. Do not finish a real booking unless
that test booking is separately authorized.
