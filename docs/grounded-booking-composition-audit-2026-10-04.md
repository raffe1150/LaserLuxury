# Grounded booking composition hotfix — review report

Date: 2026-10-04. Working directory: `/Users/raffe/Documents/OdinLink/.production-hotfix`.
Baseline: `84163c2cfa2ddfbe56b5d345254ed142220b1480`.

No deployment, Render trigger, commit, or push was performed. The dirty main worktree was not used. These are local results; production behavior remains unvalidated until manual deployment and live checks.

## 1. Root cause

The unified deterministic booking engine frequently handed formatter output straight to `replyAndRecord` and the channel send function. The formatters knew the current booking fact but did not have conversation history or remember that the same constraint had already been explained. Cached empty availability and repeated service-resolution branches therefore reused the same presentation.

There was a separate service-only rewriting path, with a Gemini-named generation contract and no useful recent dialogue in its composition request. Its validator broadly prohibited availability vocabulary, including legitimate configured-service explanations. This was neither a shared booking presentation layer nor a reliable normal path for all booking outcomes.

Additional concrete presentation defects compounded the problem: an `awaiting_service` continuation could return a missing-service prompt despite retaining a concrete unsupported request; and the tool-containment continuation could format an empty offered-slot array as no availability after an actual selected slot had advanced to confirmation. A bare first service answer also lacked explicit service evidence, and an older extraction could retain a relative-date suffix in the service label. The narrow awaiting-service label check now retains the actual answer without granting bookability; date suffix normalization affects presentation facts/outcome identity only when the engine has already resolved the date.

## 2. End-to-end audit

The audit followed inbound channel handling, serialized unified booking turns, deterministic state/service/availability resolution, formatter branches, the final reply guard, send/history recording, verified booking settlement/outbox delivery, and each channel's residual AI tool adapter. The appendix inventories all **133** send/reply callsites within `handleUnifiedBookingEngineTurn`; the table below also covers indirect formatter variables, confirmation/outbox delivery, guards, and adapters outside that function.

| Customer-facing branch | Result of audit / final presentation path |
| --- | --- |
| Unsupported service, first request | Verified requested label and configured choices → shared composer → guard → send |
| Repeated unsupported service, including a bare service label | Retained unsupported request → same composition layer with delivered-outcome memory and recent history |
| Missing service | Deterministic missing-service outcome → composer; explicit unsupported requests are no longer presented as missing |
| Ambiguous service | Verified candidate set → composer; all supplied candidates must remain in the reply |
| Supported service without a date; requested time without a day | Verified service/requested-time facts → date composition |
| General service/date recovery | Typed service-and-date next-step outcome → composer |
| Available slots, exact time, range, nearest alternatives | Canonical deterministic slot results → approved absolute display pairs → composer |
| No availability, cached empty availability, repeated same constraint | Empty verified offers + normalized constraint → composer; repetition-aware fallback when necessary |
| Contact supplied while availability remains empty | Contact cannot create a slot; the same no-availability outcome is composed |
| Closed requested day, with or without nearest offers | Explicit verified closed-date fact plus verified offers/empty result → composer |
| Selected slot becomes unavailable | Verified unavailable requested time and actual alternatives → composer |
| Slot-selection clarification, unclear ordinal/confirmation | Stored deterministic offers → choose-slot composition |
| Selected-slot confirmation before creation | Confirmation-request outcome; never a completed-booking outcome |
| Missing name, phone, or service | Deterministic list of missing fields → composition requiring each field and a request |
| Voice contact readback | Exact existing deterministic readback retained |
| Date/time clarification in reschedule flow | Existing selected appointment/state facts → date/time/choose-slot/confirmation composition |
| Explicit weekday/date conflict | Dedicated deterministic conflict clarification and existing suppression/state rules retained |
| Verified new-booking completion | Compose from verified calendar/database operation result; freeze the final reply in the durable result outbox before sending |
| Failed confirmation delivery / replay | Replay the exact frozen outbox reply; no new composition or booking operation |
| Calendar/database/idempotency failure and rollback | Existing deterministic transactional recovery retained |
| Appointment lookup, appointment identity, multiple appointments, stale owner, phone mismatch | Existing deterministic security/identity presentation retained |
| Cancellation reason, enabled/disabled policy, fee/confirmation, rejection, verified result/replay | Existing deterministic cancellation presentation retained |
| Verified reschedule result, failure, rejected time, retaining appointment | Existing deterministic transactional presentation retained |
| Recent completed booking status, requirements, integrity conflict | Existing deterministic verified-status/integrity presentation retained |
| Greeting/thanks during a flow, stopped-draft acknowledgment, service-duration information | Existing deterministic courtesy/information presentation retained |
| Channel limits/configuration, voice decoding failure, initial assistant identity, ambiguous operation, generic guard repair | Existing entry/recovery presentation retained |
| Telegram, Instagram, WhatsApp, Messenger `checkSlots` adapter | Each adapter now composes the verified canonical offer result, including empty offers |
| Telegram, Instagram, WhatsApp, Messenger `insertAppointment` adapter containment | Each adapter now composes the authoritative continuation; direct tool creation remains blocked |
| Four-channel reschedule tool routing | Still routes into the unified deterministic engine; migrated prompts use the shared composition layer there |
| Four-channel appointment-lookup tool result | Exact deterministic lookup/identity result retained |
| Web booking containment, reminders, admin notifications | Audited; outside this four-channel conversational migration and retained |

## 3. Migrated branches and formatters

The shared composition seam is `composeBookingPresentationForTurn`, called at `replyAndRecord`, the adapter helper, and verified completion before outbox settlement. Turn-local `AsyncLocalStorage` associates a formatter's fallback string with cloned verified **input facts**. The code does not infer facts by parsing a formatted sentence, and formatters retain their original engine-facing call signatures.

Migrated formatter families:

- `formatUnsupportedServiceBookingReply` / `renderUnsupportedServiceBookingReply`.
- `formatMissingServiceBookingReply` / `renderMissingServiceBookingReply`.
- `formatAmbiguousServiceBookingReply` / `renderAmbiguousServiceBookingReply`.
- `formatConfiguredServiceDatePrompt` and the new `formatNewBookingServiceDatePrompt`.
- `formatSwedishTimeSlots`, `formatRangeAvailabilityReply`, `formatSlotNoLongerAvailable`, `formatNoAvailabilityRecovery`.
- `formatChooseStoredSlotClarification`, `formatSelectedSlotConfirmationPrompt`, `formatMissingBookingDetailsMessage`.
- `formatChooseRescheduleTime`, `formatAskRescheduleTarget`, `formatAskRescheduleDayForTime`, `formatAskRescheduleTimeForDate`, `formatRescheduleConfirmation`.
- Verified new-booking completion derived from `formatBookingSavedMessage` and the verified operation result.
- Explicit closed-day prefix/result branches, which previously concatenated deterministic strings.
- The eight four-channel `checkSlots` and `insertAppointment` containment returns. The shared adapter also checks residual tool-supplied service labels against the deterministic configured catalog before presenting calculated slots as an offer.

The old service-only generator/validator was removed. Existing normalization and language utilities used by other grounding paths remain. There is no booking-engine rewrite or slot/calendar algorithm change.

## 4. Deterministic formatters that remain

For the migrated branches, the existing localized bodies are retained as `fallbackUnsupportedServiceBookingReply`, `fallbackMissingServiceBookingReply`, `fallbackAmbiguousServiceBookingReply`, `fallbackConfiguredServiceDatePrompt`, `fallbackRangeAvailabilityReply`, `fallbackSlotNoLongerAvailable`, `fallbackSelectedSlotConfirmationPrompt`, `fallbackChooseStoredSlotClarification`, `fallbackNoAvailabilityRecovery`, and the five reschedule fallback formatters. `buildLocalizedSlotReply`, `renderDeterministicAvailabilityReply`, `renderDeterministicMissingDetailsReply`, and `renderDeterministicBookingConfirmation` remain recovery presentation. `src/ai/deterministic-booking-presentation.ts` is unchanged.

They are used when OpenAI composition is unavailable/not configured, times out, throws, returns malformed or extra JSON fields, emits a tool call, repeats a recent reply, or fails grounding/language validation. They also remain available to the existing integrity/language guard's recovery path. In `NODE_ENV=test`, tests without an injected composer deliberately exercise the deterministic fallback and do not call a live provider.

The branch table above identifies deterministic presentation that remains the normal path. Specifically, this includes `formatDeterministicRecovery`, `getErrorMessageByLanguage`, secure/stale identity prompts, appointment lookup/selection/name/past-appointment summaries, cancellation reason/policy/fee/confirmation/result formatters, verified reschedule result/failure/rejected-time formatters, voice contact readback, recent-completion status/requirements/integrity, greeting/thanks, and inline secure recovery/retaining-booking acknowledgments. One legacy inline later-time reschedule question also remains. These contracts were kept incremental because they involve precise transaction, identity, policy, or specialized recovery state, or are outside the requested four-channel booking presentation path. They are not represented as migrated.

## 5. Repetition / loop prevention

One narrow shared memory records the **last delivered booking outcome**, its reply, and repeat count. Its scope includes business, channel, normalized recipient, and session. Its fact key omits language/name/phone so contact information alone does not reset an unchanged failed availability result. Changed date, constraint, supported service, or offers produces a different outcome key. Recognized relative-date suffixes retained by older service extraction are removed from presentation labels only when the deterministic date is already resolved, so a subsequent bare service label still matches the same factual outcome; pending booking state is untouched by that normalization. Memory expires after 30 minutes and is capped at 10,000 scopes.

The model receives `repeatedOutcome`, count, and previous reply alongside recent dialogue. Identical normalized replies to the last delivered outcome or the last three assistant messages are rejected. For repeated unsupported/empty-availability fallback, six-language alternatives explicitly maintain the constraint and useful next step; alternating lead text avoids adjacent identical fallback sentences.

Composition is staged separately. Only successful delivery followed by recording the exact composed text commits presentation memory. A rejected send or guard-replaced text does not count as an explanation the customer received. Booking confirmation retries replay the durable outbox text rather than composing or creating again.

## 6. Conversation history and deterministic-state separation

Composition receives at most ten recent user/assistant messages, capped at 1,200 characters each, plus the latest customer message capped at 1,200 characters. Tool messages are excluded. Existing local history is used when it is at least as complete as the supplied history; otherwise supplied history is used.

History and customer text are JSON user data explicitly labeled untrusted context for wording. Verified formatter inputs and deterministic pending/availability/reschedule snapshots provide authoritative facts in the instruction. The model has no tools and returns only `{ "reply": "..." }`; it cannot return or update booking state. No model output enters service resolution, availability computation, contact validation, slot ownership, calendar/database mutation, confirmation authorization, or idempotency settlement.

## 7. Factual/state grounding after composition

The existing provider/capability router performs one OpenAI Responses request with strict JSON schema and no tools. The configured OpenAI model is preserved. The eight-second deadline includes the existing AI queue, and the abort signal reaches the provider. No Gemini fallback, second verification call, or retry cascade was introduced. A runtime provider other than OpenAI uses deterministic presentation here.

The post-composition deterministic guard checks actual reply text, not model self-reported compliance:

- A concrete unsupported label must be present and explicitly negated; positive or contradictory availability/booking clauses are rejected.
- Candidate/catalog offers must use the supplied configured entities; unknown offering/choice language fails the catalog checks.
- Empty availability requires a negative availability statement and another-date next action. It cannot become positive availability or a completion claim.
- Narrow time searches cannot be described as the whole day being unavailable. “Fully booked” is rejected because an empty search does not establish that cause; “closed” needs an explicit verified closed-date fact.
- Unknown numbers, complete date/clock values, relative dates/weekdays, prices/policy language, and mutation claims are rejected. Offered date/time pairs must remain exact approved display labels, including protection against recombination with words or punctuation between a date and time.
- Required next actions and missing contact fields must be present in the locked language.
- A selected slot cannot imply completion. Completed-booking claims require `kind=confirmed`, `verified=true`, and every supplied service/name/phone/date/time confirmation value; negated completion is rejected.
- Malformed/oversized output, extra schema fields, tool calls, URLs, and markup are rejected.

The existing customer-facing booking-integrity and language guard still follows composition on the shared reply path. Verified completion has its dedicated fact validator and is frozen into the outbox; actual sending still requires the existing successful durable settlement. Failure/rollback gates are unchanged.

This is conservative text validation, not a proof of arbitrary natural-language entailment. Unanticipated paraphrases can be rejected, and novel adversarial wording remains a live-validation risk. Deterministic fallback is preferable to relaxing authoritative booking correctness.

## 8. Multilingual consistency

The composer uses the same resolved active-flow language as the final send guard, with existing language-switch/lock rules. Existing tone controls are reused through `buildBusinessPromptWithTone`; no tone settings or presets changed. English, Swedish, Spanish, German, Persian, and Arabic are covered.

Exact configured service names and verified identity values are removed only from the language probe, not from factual checks. This prevents English catalog names from causing a native-language explanation to be replaced by a generic English repair. Opposing-language markers and the existing classifier reject drift; Persian and Arabic retain separate language evidence. Slots use deterministic Stockholm absolute date/time labels, and localized completion dates explicitly use the Gregorian calendar.

## 9. Regression changes

- `service-clarification-presentation.integration.test.ts`: replaced the old service-only rewriter tests with **76** semantic/grounding checks across six languages. Coverage includes required next actions, unsupported contradictions, invented services/price/policy/slots, incorrect dates/pairs, language drift, missing contacts, false completion, malformed schema/tool calls/provider errors/timeout, scope isolation, concurrent turn metadata, and unchanged tone behavior.
- `grounded-booking-repetition.integration.test.ts`: **197** real-engine state/conversation scenarios across all four channels and all six languages: unsupported → repeated bare label; supported-service switch; no availability → repeated request; flexible same-day request; contact while still unavailable; changed date; missing service → bare unsupported label; switching to a different unsupported label; language stability; unsuccessful delivery not counted; plus four adapter cases that reject an unconfigured tool-supplied service even when slots exist. Tests require the injected OpenAI composition path to be accepted and check calendar reads/mutations and deterministic state.
- `selected-slot-confirmation.integration.test.ts`: preserved existing state/fallback coverage; added composed verified completions in all six languages and failed-delivery outbox replay without an additional model call or booking creation.
- `providers/grounded-booking-responses.integration.test.ts`: mocks the actual OpenAI Responses SDK and asserts one routed request, configured model, strict JSON, no tools, bounded history, abort signal, and immutable facts.
- `tone-controls.test.ts`: adapted only a source-call-count assertion to include the extracted shared composer; no tone behavior changed.

Exact deterministic wording tests that exercise deliberate fallback remain meaningful and were preserved. Composition tests check facts, next actions, language, state, and anti-repetition; exact equality is required only where outbox replay must preserve the frozen result.

## 10. Exact test results

Final figures and commands are recorded below after completion of the final rerun. TAP file-level tests contain additional internal assertion/scenario loops, so the 197 and 76 counts are not separate TAP test counts.

| Run | Result | Runner exit / duration |
| --- | --- | --- |
| Focused changed areas, OpenAI offline mocks, five test files | 5 passed, 0 failed; 197 state/conversation scenarios and 76 semantic/grounding checks | 0 / 3,060.958292 ms |
| Selected previously-passing broader OpenAI suites, 135 files | 887 passed, 0 failed | 0 / 76,339.496 ms |
| Complete relevant offline regression set, 162 files | 1,011 passed, 60 failed, 0 cancelled, 0 skipped; 1,071 total | 1 / 87,872.384334 ms |
| Untouched baseline complete offline regression set, 160 files | 1,009 passed, 60 failed, 0 cancelled, 0 skipped; 1,069 total | 1 / 90,100.401875 ms |
| Full baseline/current failure-name comparison | All 60 failure names identical; no additional failure names | Pass |
| New composer TypeScript check | Passed | 0 |
| Direct server/import TypeScript comparison | Same 16 existing diagnostics as untouched baseline; no added diagnostics | 2 |
| Repository `npm run lint` | Fails with six existing syntax diagnostics in `patch_key_rotation.ts`; identical baseline diagnostics | 2 |

The complete legacy offline fixture comparison explicitly sets `AI_PROVIDER=gemini` because older tests mock that pre-existing fixture path. This is a **test-only compatibility run**, not a new runtime fallback. The provider test itself selects and mocks OpenAI Responses. The 135-file OpenAI run is explicitly a subset of previously-passing suites, not a claim that the entire repository is green.

An earlier full default/OpenAI run produced 997 passes / 73 failures / 1,070 total. Its initial baseline comparison was incomplete because a long shared-business-information child was terminated. It is not used as proof of failure parity; the complete offline baseline/current run above supplies that comparison. The existing shared-business-information suite separately passes all 51 tests under its legacy offline provider fixtures. One interim OpenAI subset rerun had 886 passes / 1 failure in the unchanged credential-envelope tamper test (`src/channels/connections/connections.test.ts`, “Missing expected exception”). Its tampering replaces the final encrypted character with a fixed `x`, which can fail to alter the randomized value. This intermittent unrelated result is recorded rather than concealed; the final results above are from the final rerun.

Focused command:

```sh
NODE_ENV=test AI_PROVIDER=openai node --import tsx --test \
  src/ai/grounded-booking-repetition.integration.test.ts \
  src/ai/selected-slot-confirmation.integration.test.ts \
  src/ai/service-clarification-presentation.integration.test.ts \
  src/ai/providers/grounded-booking-responses.integration.test.ts \
  src/ai/tone-controls.test.ts
```

Broader commands use the file manifests in the appendices with `node --import tsx --test --test-concurrency=4`, `NODE_ENV=test`, and the provider setting stated above. Baseline was a temporary archive of the starting commit inside this authorized hotfix directory, with the same local dependencies. The new composition/provider tests use injected or SDK mocks; no live production conversation was exercised.

The six repository lint errors are TS1127 and TS1134 at `patch_key_rotation.ts:47`, TS1005 and two TS1443 errors at line 94, and TS1160 at line 99. They were not repaired as part of this task. The extra direct server check exposes the baseline TimeBoundaryKind/argument-count/booking_support typing issues, test-bridge category typing, missing WhatsApp send helper, unknown channel payload properties/string conversion, structured-understanding result narrowing, and connection-platform union typing.

## 11. Production build

`npm run build` passes: Vite frontend build and esbuild production server bundle. The existing large browser chunk warning remains. No deployment configuration changed, and the build was not deployed.

## 12. Whitespace / patch integrity

`git diff --check` passes. Final working-tree inspection includes only the eight intended files below; temporary baseline/debug scripts and manifests were removed. Ignored local validation logs remain as evidence.

## 13. Exact files changed

1. `server.ts` — shared composition wiring, typed fallback registration, adapter parity, retained unsupported request, continuation correction, staged delivered memory, verified outbox composition.
2. `src/ai/grounded-booking-composition.ts` — new bounded OpenAI composition, fact guard, history/tone/language integration, repetition memory/fallback.
3. `src/ai/grounded-booking-repetition.integration.test.ts` — new four-channel/six-language repeated-turn state coverage.
4. `src/ai/providers/grounded-booking-responses.integration.test.ts` — new native Responses adapter contract test.
5. `src/ai/service-clarification-presentation.integration.test.ts` — redesigned semantic grounding coverage.
6. `src/ai/selected-slot-confirmation.integration.test.ts` — verified composition/outbox replay coverage.
7. `src/ai/tone-controls.test.ts` — existing source-wiring assertion updated for extraction.
8. `docs/grounded-booking-composition-audit-2026-10-04.md` — this report and audit/test appendices.

No provider implementation, deployment configuration, migration, dependency manifest, calendar correctness module, or deterministic-presentation module changed.

## 14. Remaining risks and limitations

- Live OpenAI output and provider latency are not simulated perfectly by offline mocks. Review the actual accepted/fallback rate after manual deployment; `[BookingPresentation]` logs expose outcome kind, source, repeated flag, channel, and safe fallback reason.
- Conservative vocabulary/next-action guards may reject valid paraphrases and return a deterministic fallback. They intentionally forbid some natural relative-date wording and inferential “fully booked” language. They do not establish formal semantic correctness for every possible phrase.
- Composition adds one bounded model request, including up to eight seconds of queue/provider waiting. Verified completion composition occurs after calendar/database verification and before durable outbox settlement; existing settlement failure/rollback gates still apply.
- Delivered-outcome memory is process-local, capped, and expires after 30 minutes. It does not persist across a restart or synchronize across multiple workers. Supplied recent history still allows the model to recognize earlier explanations, but deterministic repeat-aware recovery is strongest within the same process.
- Repeated recovery alternatives prevent an adjacent exact loop, not unlimited semantic repetition. If the customer supplies no new feasible input, the real constraint still has to be reiterated.
- The exact normal-path deterministic exceptions are listed in sections 2 and 4. They may still sound canned, particularly cancellation/secure transaction recovery, the remaining later-time reschedule question, and web containment. Expanding those contracts is separate incremental work.
- The complete regression set and repository lint are not green at baseline. The report identifies the unchanged failures rather than treating local passes as production proof.

## 15. Live-validation checklist after manual deployment

Run the following on **Telegram, Instagram, WhatsApp, and Messenger**, using separate conversations and a known test calendar/service catalog. Cover English, Swedish, Spanish, German, Persian, and Arabic; include short/bare-label continuations in each language.

1. Ask for an unsupported service such as haircut, repeat the same request, then send just the unsupported label. Expect explicit unavailable-service meaning, stable language, adapted wording, and useful bookable-service choice; no slot query/creation for the unsupported service.
2. Start with an unspecified booking, then name an unsupported service. Expect an unsupported explanation rather than another missing-service question. Switch to a configured service and verify normal deterministic progress.
3. Request a supported service on a known unavailable date. Repeat the request and ask for any time that day. Expect the original date/constraint to remain, no invented slot/reason, adapted wording, and another-date next step.
4. Provide name/phone while that date remains unavailable. Expect contact not to create availability, no false confirmation, and no booking mutation.
5. Change to a known available date. Expect fresh canonical slots for that date, no stale no-availability reply, and exact approved date/time pairs. Select an ambiguous time/ordinal and check a useful slot clarification.
6. Select a real slot; verify required contact collection and explicit confirmation authorization. After confirmation, verify exactly one calendar event, one appointment record, and a completion message matching the persisted service/date/time/name/phone.
7. If a delivery retry can be safely simulated, verify the exact persisted completion reply is resent without another booking or model composition. Check `[BookingPresentation]` accepted/fallback diagnostics without logging customer content.
8. Spot-check a closed date, stale slot, contradictory weekday/date, voice phone readback, cancellation policy/fee flow, and reschedule recovery. Ensure the preserved deterministic safeguards remain intact.

Do not interpret these local results as a production fix until the manually deployed revision passes these live checks.

## Appendix A — unified-engine customer reply inventory

Line numbers refer to the final local `server.ts`. Variables and conditional formatter calls are included; their final classification is in section 2. `send guardedReply` is the shared post-composition send; `send claimed.response_text` is frozen outbox replay.

| Line | Send seam | Formatter / argument |
| --- | --- | --- |
| 16374 | `send` | `clarification` |
| 17019 | `send` | `guardedReply` |
| 17064 | `send` | `claimed.response_text` |
| 17132 | `replyAndRecord` | `replies[language] \|\| replies.en` |
| 17213 | `replyAndRecord` | `formatConfiguredServiceDatePrompt` |
| 17229 | `replyAndRecord` | `renderAmbiguousServiceBookingReply, renderMissingServiceBookingReply, renderUnsupportedServiceBookingReply` |
| 17288 | `replyAndRecord` | `renderUnsupportedServiceBookingReply` |
| 17327 | `replyAndRecord` | `formatThanksReply` |
| 17334 | `replyAndRecord` | `formatRecentCompletionRequirementsReply` |
| 17347 | `replyAndRecord` | `formatRecentCompletedStatusReply` |
| 17420 | `replyAndRecord` | `formatChooseStoredSlotClarification` |
| 17425 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 17444 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 17472 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 17484 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 17490 | `replyAndRecord` | `formatPastAppointmentMutationReply` |
| 17503 | `replyAndRecord` | `context.language === "sv" ? "Jag hittade bokningen, men den saknar ett kalender-id för säker avbokning. En medarbetare behöver hjälpa till. 🙏" : context.language === "fa" ? "رزرو پیدا شد، اما شناسه تقویم لازم برای لغو ا` |
| 17581 | `replyAndRecord` | `formatDeterministicRecovery` |
| 17695 | `replyAndRecord` | `formatDeterministicRecovery` |
| 17859 | `send` | `successReply` |
| 17941 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 17953 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 17964 | `replyAndRecord` | `lockedLanguage === "fa" ? "رزرو پیدا شد، اما شناسه دقیق تقویم برای تغییر امن موجود نیست. یک همکار باید کمک کند. 🙏" : lockedLanguage === "sv" ? "Jag hittade bokningen, men det exakta kalender-id:t saknas för en säker omb` |
| 18005 | `replyAndRecord` | `getErrorMessageByLanguage` |
| 18019 | `replyAndRecord` | `msg` |
| 18053 | `replyAndRecord` | `formatRescheduleConfirmation` |
| 18158 | `replyAndRecord` | `formatRescheduleConfirmation` |
| 18174 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 18189 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 18204 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 18214 | `replyAndRecord` | `formatRescheduleFailure` |
| 18242 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 18350 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 18373 | `replyAndRecord` | `formatDeterministicRecovery` |
| 18435 | `replyAndRecord` | `formatRescheduleFailure` |
| 18491 | `replyAndRecord` | `formatRescheduleFailure` |
| 18529 | `replyAndRecord` | `formatRescheduleFailure` |
| 18547 | `replyAndRecord` | `formatRescheduleFailure` |
| 18615 | `replyAndRecord` | `formatRescheduleSuccess` |
| 18637 | `replyAndRecord` | `formatCancellationDisabledDuringFlow` |
| 18643 | `replyAndRecord` | `lockedLanguage === "sv" ? "Okej, bokningen behålls." : lockedLanguage === "fa" ? "باشه، رزرو شما حفظ می‌شود." : lockedLanguage === "de" ? "Okay, der Termin bleibt bestehen." : lockedLanguage === "es" ? "De acuerdo, la ci` |
| 18661 | `replyAndRecord` | `formatInvalidCancellationReason` |
| 18668 | `replyAndRecord` | `formatCancellationConfirmation` |
| 18685 | `replyAndRecord` | `formatCancellationConfirmation` |
| 18732 | `replyAndRecord` | `recentlyCancelled.successReply` |
| 18766 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 18784 | `replyAndRecord` | `formatPastAppointmentMutationReply` |
| 18824 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 18936 | `replyAndRecord` | `formatRescheduleTimeRejected` |
| 18956 | `replyAndRecord` | `formatChooseRescheduleTime` |
| 18970 | `replyAndRecord` | `formatRescheduleConfirmation` |
| 18979 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 18989 | `replyAndRecord` | `formatAskRescheduleTarget` |
| 19015 | `replyAndRecord` | `formatAskRescheduleTarget` |
| 19106 | `replyAndRecord` | `formatNewBookingServiceDatePrompt` |
| 19123 | `replyAndRecord` | `formatGreetingDuringActiveBooking` |
| 19177 | `replyAndRecord` | `reply` |
| 19211 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 19248 | `replyAndRecord` | `lockedLanguage === "fa" ? "این شماره با رزرو انتخاب‌شده مطابقت نداشت. لطفاً همان شماره‌ای را بفرستید که با آن رزرو کرده‌اید." : lockedLanguage === "sv" ? "Numret matchade inte den valda bokningen. Skicka numret som använ` |
| 19291 | `replyAndRecord` | `formatRescheduleConfirmation` |
| 19307 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 19315 | `replyAndRecord` | `ask` |
| 19422 | `replyAndRecord` | `formatPastAppointmentMutationReply` |
| 19483 | `replyAndRecord` | `formatPastAppointmentMutationReply` |
| 19563 | `replyAndRecord` | `formatSecureRecoveryPrompt` |
| 19581 | `replyAndRecord` | `formatAppointmentLookupReply` |
| 19589 | `replyAndRecord` | `formatAppointmentNameReply` |
| 19603 | `replyAndRecord` | `formatCancellationDisabled` |
| 19608 | `replyAndRecord` | `lockedLanguage === "sv" ? "Den tiden har redan börjat eller passerat och kan inte avbokas automatiskt." : lockedLanguage === "fa" ? "این نوبت شروع شده یا گذشته است و به‌صورت خودکار قابل لغو نیست." : "That appointment has` |
| 19612 | `replyAndRecord` | `formatCancellationReasonQuestion` |
| 19657 | `replyAndRecord` | `ask` |
| 19689 | `replyAndRecord` | `formatStaleAppointmentStateMessage` |
| 19696 | `replyAndRecord` | `lockedLanguage === "sv" ? "Okej, bokningen behålls på sin nuvarande tid." : lockedLanguage === "fa" ? "باشه، رزرو در زمان فعلی باقی می‌ماند." : "Okay, the appointment will remain at its current time."` |
| 19715 | `replyAndRecord` | `formatChooseRescheduleTime` |
| 19723 | `replyAndRecord` | `lockedLanguage === "fa" ? "حتماً 😊 برای کدوم روز زمان دیرتری می‌خواهید؟" : lockedLanguage === "sv" ? "Absolut 😊 Vilken dag vill du ha en senare tid?" : "Of course 😊 Which day would you like a later time?"` |
| 19826 | `replyAndRecord` | `ask` |
| 19850 | `replyAndRecord` | `formatMissedPastAppointmentsReply` |
| 19863 | `replyAndRecord` | `message` |
| 19877 | `replyAndRecord` | `formatCancellationDisabled` |
| 19881 | `replyAndRecord` | `formatCancellationReasonQuestion` |
| 19921 | `replyAndRecord` | `formatAskRescheduleTarget` |
| 19924 | `replyAndRecord` | `formatAppointmentLookupReply` |
| 19934 | `replyAndRecord` | `formatAppointmentSelectionPrompt, formatAllAppointmentsSelectedReply` |
| 20006 | `replyAndRecord` | `formatSecureRecoveryPrompt` |
| 20027 | `replyAndRecord` | `formatSecureRecoveryPrompt` |
| 20045 | `replyAndRecord` | `formatNewBookingServiceDatePrompt` |
| 20050 | `replyAndRecord` | `formatSecureRecoveryPrompt, formatUnverifiedPhoneLookupReply, formatVerifiedPhoneNoAppointment` |
| 20102 | `replyAndRecord` | `formatSecureRecoveryPrompt` |
| 20154 | `replyAndRecord` | `formatPastAppointmentMutationReply` |
| 20177 | `replyAndRecord` | `formatAppointmentSelectionPrompt, formatAllAppointmentsSelectedReply` |
| 20195 | `replyAndRecord` | `formatAskRescheduleTarget` |
| 20201 | `replyAndRecord` | `formatCancellationDisabled` |
| 20210 | `replyAndRecord` | `formatCancellationReasonQuestion` |
| 20270 | `replyAndRecord` | `formatSecureRecoveryPrompt, formatAppointmentLookupReply` |
| 20377 | `replyAndRecord` | `formatSecureRecoveryPrompt, formatAppointmentLookupReply` |
| 20500 | `replyAndRecord` | `reply` |
| 20506 | `replyAndRecord` | `formatThanksReply` |
| 20798 | `replyAndRecord` | `renderAmbiguousServiceBookingReply, renderUnsupportedServiceBookingReply, renderMissingServiceBookingReply` |
| 20884 | `replyAndRecord` | `formatConfiguredServiceDatePrompt` |
| 20968 | `replyAndRecord` | `(cachedOfferCountBefore > 0 ? formatChooseStoredSlotClarification : formatNoAvailabilityRecovery)( getFlowReplyLanguage(pending.language, language, text) )` |
| 21422 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 21520 | `replyAndRecord` | `prefix + nearestSlotsReply` |
| 21537 | `replyAndRecord` | `closedDayReply + ' ' + fallbackNoAvailabilityRecovery(lockedLanguage)` |
| 21550 | `replyAndRecord` | `formatRangeAvailabilityReply, formatSwedishTimeSlots` |
| 21630 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 21749 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 21762 | `replyAndRecord` | `reply` |
| 21868 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 21960 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 21972 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 22050 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 22138 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 22163 | `replyAndRecord` | `formatDeterministicRecovery` |
| 22246 | `replyAndRecord` | `formatMissingBookingDetailsMessage` |
| 22270 | `replyAndRecord` | `formatVoiceContactConfirmation` |
| 22310 | `replyAndRecord` | `getErrorMessageByLanguage` |
| 22442 | `replyAndRecord` | `formatDeterministicRecovery` |
| 22497 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 22548 | `replyAndRecord` | `getErrorMessageByLanguage` |
| 22567 | `replyAndRecord` | `getErrorMessageByLanguage` |
| 22608 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 22643 | `replyAndRecord` | `formatDeterministicRecovery` |
| 22658 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 22759 | `replyAndRecord` | `formatSlotNoLongerAvailable` |
| 22801 | `replyAndRecord` | `formatDeterministicRecovery` |
| 22946 | `replyAndRecord` | `formatDeterministicRecovery` |
| 23052 | `replyAndRecord` | `formatDeterministicRecovery` |
| 23163 | `replyAndRecord` | `formatDeterministicRecovery` |
| 23287 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 23298 | `replyAndRecord` | `formatChooseStoredSlotClarification` |
| 23305 | `replyAndRecord` | `formatSwedishTimeSlots` |
| 23318 | `replyAndRecord` | `(findOwnedOfferedSlot(pending, String(pending.dateTime \|\| "")) ? formatSelectedSlotConfirmationPrompt : formatChooseStoredSlotClarification)( getFlowReplyLanguage(pending.language, language, text), )` |
| 23355 | `replyAndRecord` | `formatDeterministicRecovery` |

## Appendix B — complete broader regression manifest (162 files)

```text
src/ai/ambiguous-date.integration.test.ts
src/ai/arabic-booking-intake.integration.test.ts
src/ai/arabic-instagram-booking-routing.integration.test.ts
src/ai/authoritative-booking-temporal-continuity.integration.test.ts
src/ai/availability-weekday-refinement.integration.test.ts
src/ai/booking-completion-regressions.integration.test.ts
src/ai/booking-intelligence.test.ts
src/ai/booking-language-continuity.integration.test.ts
src/ai/booking-state-machine.test.ts
src/ai/booking-time-constraint.integration.test.ts
src/ai/business-booking-buffer.integration.test.ts
src/ai/business-grounding-cancellation.integration.test.ts
src/ai/business-grounding-reuse.integration.test.ts
src/ai/business-grounding-timing.integration.test.ts
src/ai/business-information-evidence.integration.test.ts
src/ai/business-information-inline-catalog.test.ts
src/ai/business-information-latency.integration.test.ts
src/ai/business-information.location.test.ts
src/ai/business-information.test.ts
src/ai/business-support-gap.integration.test.ts
src/ai/business-verification-unavailable.integration.test.ts
src/ai/calendar-read-safety.test.ts
src/ai/canonical-availability-observability.integration.test.ts
src/ai/canonical-availability.test.ts
src/ai/channel-contact.test.ts
src/ai/channel-reliability.test.ts
src/ai/completed-operation-and-service-routing.integration.test.ts
src/ai/compound-business-information-final.integration.test.ts
src/ai/compound-business-information.integration.test.ts
src/ai/configured-service-duration-linkage.test.ts
src/ai/configured-service-duration-parity.integration.test.ts
src/ai/confirmation-contact.integration.test.ts
src/ai/contact-phone-provenance.integration.test.ts
src/ai/contact-submission-selected-slot.integration.test.ts
src/ai/context-pipeline.integration.test.ts
src/ai/conversation-context-window.test.ts
src/ai/customer-intake-service-isolation.integration.test.ts
src/ai/customer-name-diagnostic-suffix.test.ts
src/ai/customer-reply-guard-diagnostic.test.ts
src/ai/date-conflict-clarification.test.ts
src/ai/date-conflict-loop.integration.test.ts
src/ai/deterministic-booking-presentation.test.ts
src/ai/deterministic-booking-tone-guard.test.ts
src/ai/earliest-availability.integration.test.ts
src/ai/embeddings.test.ts
src/ai/english-instagram-live-routing.integration.test.ts
src/ai/final-response-concision.test.ts
src/ai/full-matrix-confirmation.integration.test.ts
src/ai/german-initial-booking-intent.test.ts
src/ai/german-instagram-live-routing.integration.test.ts
src/ai/german-multifact-booking.integration.test.ts
src/ai/german-named-date.integration.test.ts
src/ai/google-calendar-oauth-runtime.integration.test.ts
src/ai/grounded-booking-repetition.integration.test.ts
src/ai/initial-turn-mixed-entity-language.integration.test.ts
src/ai/language-brain.test.ts
src/ai/language-lock-stability.integration.test.ts
src/ai/language-switch-intent.test.ts
src/ai/launch-critical-conversation-hardening.integration.test.ts
src/ai/launch-critical-migration.test.ts
src/ai/mixed-language-entity-language.integration.test.ts
src/ai/multichannel-booking-progression.integration.test.ts
src/ai/multichannel-language-isolation.integration.test.ts
src/ai/multilingual-compound-location.integration.test.ts
src/ai/multilingual-contact-service-collision.integration.test.ts
src/ai/multilingual-date-normalization.integration.test.ts
src/ai/multilingual-explicit-date.integration.test.ts
src/ai/multilingual-meaningful-language-switch.integration.test.ts
src/ai/multilingual-slot-confirmation.test.ts
src/ai/owned-slot-selection-normalization.test.ts
src/ai/partial-booking-continuation.integration.test.ts
src/ai/pending-hold-lifecycle.integration.test.ts
src/ai/pending-language-entity-selection.integration.test.ts
src/ai/persian-arabic-reply-guard.integration.test.ts
src/ai/persian-instagram-post-booking-continuation.integration.test.ts
src/ai/post-completion-business-support-response.integration.test.ts
src/ai/presentation-fact-integrity.test.ts
src/ai/priority-1h-regressions.test.ts
src/ai/priority-1h-unified-engine.integration.test.ts
src/ai/priority-1i-live-recovery.integration.test.ts
src/ai/priority-1j-channel-parity.integration.test.ts
src/ai/priority-1k-range-availability.integration.test.ts
src/ai/priority-2-1-multilingual-time.test.ts
src/ai/providers/audio.test.ts
src/ai/providers/gemini.test.ts
src/ai/providers/grounded-booking-responses.integration.test.ts
src/ai/providers/openai-diagnostic.test.ts
src/ai/providers/openai-temperature.integration.test.ts
src/ai/providers/openai-tool-schema.test.ts
src/ai/providers/openai.test.ts
src/ai/providers/provider.test.ts
src/ai/providers/semantic-knowledge.test.ts
src/ai/providers/server-integration.test.ts
src/ai/providers/whatsapp-voice-ordering.test.ts
src/ai/recent-completed-booking-follow-up.integration.test.ts
src/ai/recent-completed-booking-status.integration.test.ts
src/ai/recent-completion-presentation-language.integration.test.ts
src/ai/receptionist-quality.integration.test.ts
src/ai/recommendation-clarification-latency.integration.test.ts
src/ai/reliability.test.ts
src/ai/request-queue.test.ts
src/ai/response-concision-policy.test.ts
src/ai/rtl-service-catalog-channels.integration.test.ts
src/ai/rtl-service-catalog.test.ts
src/ai/selected-slot-completion-availability.integration.test.ts
src/ai/selected-slot-confirmation.integration.test.ts
src/ai/sequential-booking-operation-lifecycle.integration.test.ts
src/ai/service-catalog-presentation.integration.test.ts
src/ai/service-clarification-presentation.integration.test.ts
src/ai/service-resolution-before-availability.integration.test.ts
src/ai/shared-business-information.integration.test.ts
src/ai/shared-post-completion-routing.integration.test.ts
src/ai/spanish-booking-boundaries.integration.test.ts
src/ai/spanish-manana-disambiguation.integration.test.ts
src/ai/staging-readiness.test.ts
src/ai/sv-de-service-date-normalization.integration.test.ts
src/ai/swedish-generic-booking-service-date.integration.test.ts
src/ai/telegram-earliest-range-parity.integration.test.ts
src/ai/telegram-persian-booking-runtime.integration.test.ts
src/ai/tone-controls.test.ts
src/ai/understanding/adoption.test.ts
src/ai/understanding/providers/gemini.test.ts
src/ai/understanding/providers/openai.test.ts
src/ai/understanding/providers/wire.test.ts
src/ai/understanding/shadow.test.ts
src/ai/understanding/structured-understanding.test.ts
src/ai/unsupported-service-booking.integration.test.ts
src/ai/unsupported-service-explicit-date.integration.test.ts
src/ai/whatsapp-active-slot-routing.integration.test.ts
src/ai/whatsapp-arabic-initial-booking.integration.test.ts
src/ai/whatsapp-multilingual-production-regressions.integration.test.ts
src/ai/whatsapp-recent-completion-boundary.integration.test.ts
src/ai/whatsapp-swedish-tomorrow-regression.integration.test.ts
src/channels/connections/connections.test.ts
src/channels/connections/meta-compliance.test.ts
src/p2/capacity-policy.test.ts
src/p2/conversation-key.test.ts
src/p2/execution-boundary.test.ts
src/p2/live-shadow-runtime.test.ts
src/p2/processing-coordinator.test.ts
src/p2/resource-resolution.test.ts
src/p2/shadow-evaluator.test.ts
src/p2/shadow-runtime.test.ts
src/p2/structured-understanding-shadow-analyzer.test.ts
src/p2/supabase-conversation-finalization-repository.test.ts
src/p2/supabase-conversation-lease-repository.test.ts
src/p2/supabase-core-repositories.test.ts
src/p2/supabase-inbox-repository.test.ts
src/p2/supabase-operation-repository.test.ts
src/p2/supabase-outbox-repository.test.ts
src/p2/supabase-reservation-repository.test.ts
src/p2/supabase-resource-repository.test.ts
src/p2/supabase-shadow-recorder.test.ts
src/runtime/durable-idempotency.integration.test.ts
src/runtime/english-booking-contact-phrase.test.ts
src/runtime/instagram-outbound-inbound-boundary.integration.test.ts
src/runtime/local-test-mode.test.ts
src/runtime/meta-outbound-context.integration.test.ts
src/runtime/reminder-calendar-verification.integration.test.ts
src/runtime/reminder-language.integration.test.ts
src/runtime/whatsapp-canonical-identity.integration.test.ts
src/runtime/whatsapp-proactive-delivery-safety.integration.test.ts
```

## Appendix C — OpenAI subset manifest (135 files)

These suites were selected from the previously-passing set; baseline failures were not silently treated as passes.

```text
src/ai/ambiguous-date.integration.test.ts
src/ai/arabic-booking-intake.integration.test.ts
src/ai/arabic-instagram-booking-routing.integration.test.ts
src/ai/authoritative-booking-temporal-continuity.integration.test.ts
src/ai/availability-weekday-refinement.integration.test.ts
src/ai/booking-intelligence.test.ts
src/ai/booking-language-continuity.integration.test.ts
src/ai/booking-time-constraint.integration.test.ts
src/ai/business-booking-buffer.integration.test.ts
src/ai/business-grounding-cancellation.integration.test.ts
src/ai/business-grounding-reuse.integration.test.ts
src/ai/business-grounding-timing.integration.test.ts
src/ai/business-information-inline-catalog.test.ts
src/ai/business-information-latency.integration.test.ts
src/ai/business-information.location.test.ts
src/ai/business-information.test.ts
src/ai/business-support-gap.integration.test.ts
src/ai/business-verification-unavailable.integration.test.ts
src/ai/calendar-read-safety.test.ts
src/ai/canonical-availability.test.ts
src/ai/channel-contact.test.ts
src/ai/completed-operation-and-service-routing.integration.test.ts
src/ai/compound-business-information-final.integration.test.ts
src/ai/configured-service-duration-linkage.test.ts
src/ai/configured-service-duration-parity.integration.test.ts
src/ai/confirmation-contact.integration.test.ts
src/ai/contact-phone-provenance.integration.test.ts
src/ai/contact-submission-selected-slot.integration.test.ts
src/ai/conversation-context-window.test.ts
src/ai/customer-name-diagnostic-suffix.test.ts
src/ai/customer-reply-guard-diagnostic.test.ts
src/ai/date-conflict-clarification.test.ts
src/ai/date-conflict-loop.integration.test.ts
src/ai/deterministic-booking-presentation.test.ts
src/ai/deterministic-booking-tone-guard.test.ts
src/ai/earliest-availability.integration.test.ts
src/ai/embeddings.test.ts
src/ai/english-instagram-live-routing.integration.test.ts
src/ai/final-response-concision.test.ts
src/ai/german-instagram-live-routing.integration.test.ts
src/ai/german-named-date.integration.test.ts
src/ai/google-calendar-oauth-runtime.integration.test.ts
src/ai/grounded-booking-repetition.integration.test.ts
src/ai/initial-turn-mixed-entity-language.integration.test.ts
src/ai/language-brain.test.ts
src/ai/language-lock-stability.integration.test.ts
src/ai/language-switch-intent.test.ts
src/ai/launch-critical-conversation-hardening.integration.test.ts
src/ai/launch-critical-migration.test.ts
src/ai/mixed-language-entity-language.integration.test.ts
src/ai/multichannel-booking-progression.integration.test.ts
src/ai/multilingual-contact-service-collision.integration.test.ts
src/ai/multilingual-date-normalization.integration.test.ts
src/ai/multilingual-explicit-date.integration.test.ts
src/ai/multilingual-meaningful-language-switch.integration.test.ts
src/ai/multilingual-slot-confirmation.test.ts
src/ai/owned-slot-selection-normalization.test.ts
src/ai/partial-booking-continuation.integration.test.ts
src/ai/pending-hold-lifecycle.integration.test.ts
src/ai/pending-language-entity-selection.integration.test.ts
src/ai/persian-arabic-reply-guard.integration.test.ts
src/ai/post-completion-business-support-response.integration.test.ts
src/ai/presentation-fact-integrity.test.ts
src/ai/priority-1h-regressions.test.ts
src/ai/priority-1h-unified-engine.integration.test.ts
src/ai/priority-2-1-multilingual-time.test.ts
src/ai/providers/audio.test.ts
src/ai/providers/gemini.test.ts
src/ai/providers/grounded-booking-responses.integration.test.ts
src/ai/providers/openai-diagnostic.test.ts
src/ai/providers/openai-temperature.integration.test.ts
src/ai/providers/openai-tool-schema.test.ts
src/ai/providers/openai.test.ts
src/ai/providers/provider.test.ts
src/ai/providers/server-integration.test.ts
src/ai/providers/whatsapp-voice-ordering.test.ts
src/ai/recent-completed-booking-follow-up.integration.test.ts
src/ai/recent-completed-booking-status.integration.test.ts
src/ai/recommendation-clarification-latency.integration.test.ts
src/ai/reliability.test.ts
src/ai/request-queue.test.ts
src/ai/response-concision-policy.test.ts
src/ai/rtl-service-catalog.test.ts
src/ai/selected-slot-completion-availability.integration.test.ts
src/ai/selected-slot-confirmation.integration.test.ts
src/ai/sequential-booking-operation-lifecycle.integration.test.ts
src/ai/service-catalog-presentation.integration.test.ts
src/ai/service-clarification-presentation.integration.test.ts
src/ai/service-resolution-before-availability.integration.test.ts
src/ai/shared-post-completion-routing.integration.test.ts
src/ai/spanish-manana-disambiguation.integration.test.ts
src/ai/staging-readiness.test.ts
src/ai/sv-de-service-date-normalization.integration.test.ts
src/ai/swedish-generic-booking-service-date.integration.test.ts
src/ai/telegram-persian-booking-runtime.integration.test.ts
src/ai/understanding/adoption.test.ts
src/ai/understanding/providers/gemini.test.ts
src/ai/understanding/providers/openai.test.ts
src/ai/understanding/providers/wire.test.ts
src/ai/understanding/shadow.test.ts
src/ai/understanding/structured-understanding.test.ts
src/ai/unsupported-service-booking.integration.test.ts
src/ai/unsupported-service-explicit-date.integration.test.ts
src/ai/whatsapp-active-slot-routing.integration.test.ts
src/ai/whatsapp-arabic-initial-booking.integration.test.ts
src/ai/whatsapp-multilingual-production-regressions.integration.test.ts
src/ai/whatsapp-recent-completion-boundary.integration.test.ts
src/channels/connections/connections.test.ts
src/p2/capacity-policy.test.ts
src/p2/conversation-key.test.ts
src/p2/execution-boundary.test.ts
src/p2/live-shadow-runtime.test.ts
src/p2/processing-coordinator.test.ts
src/p2/resource-resolution.test.ts
src/p2/shadow-evaluator.test.ts
src/p2/shadow-runtime.test.ts
src/p2/structured-understanding-shadow-analyzer.test.ts
src/p2/supabase-conversation-finalization-repository.test.ts
src/p2/supabase-conversation-lease-repository.test.ts
src/p2/supabase-core-repositories.test.ts
src/p2/supabase-inbox-repository.test.ts
src/p2/supabase-operation-repository.test.ts
src/p2/supabase-outbox-repository.test.ts
src/p2/supabase-reservation-repository.test.ts
src/p2/supabase-resource-repository.test.ts
src/p2/supabase-shadow-recorder.test.ts
src/runtime/durable-idempotency.integration.test.ts
src/runtime/english-booking-contact-phrase.test.ts
src/runtime/instagram-outbound-inbound-boundary.integration.test.ts
src/runtime/meta-outbound-context.integration.test.ts
src/runtime/reminder-calendar-verification.integration.test.ts
src/runtime/reminder-language.integration.test.ts
src/runtime/whatsapp-canonical-identity.integration.test.ts
src/runtime/whatsapp-proactive-delivery-safety.integration.test.ts
src/ai/tone-controls.test.ts
```

## Appendix D — 60 unchanged baseline/current failure names

```text
German fallback distinguishes an unavailable verifier from rejected evidence or contradiction
OpenAI semantic evidence preserves grounded compound service/recommendation behavior
Swedish incomplete catalog must still independently recover a verified location
ar: compound request keeps services and location roles before generation
ar: verified natural location role survives fully grounded normalization without false gap
ar: verified natural location role survives partial recovery without false gap
compliance migration is backend-only with durable idempotent intake
compound services + recommendation fallback presents verified services and asks a clarification
customer/history instructions remain user/model data, not Gemini system instructions
de: compound request keeps services and location roles before generation
de: exact compound WhatsApp path merges structured services and tenant location
de: verified natural location role survives fully grounded normalization without false gap
de: verified natural location role survives partial recovery without false gap
en: compound request keeps services and location roles before generation
en: exact compound WhatsApp path merges structured services and tenant location
en: verified natural location role survives fully grounded normalization without false gap
en: verified natural location role survives partial recovery without false gap
es: compound request keeps services and location roles before generation
es: verified natural location role survives fully grounded normalization without false gap
es: verified natural location role survives partial recovery without false gap
exact evidence safety rejects fabricated citations while preserving real structured evidence
fa: compound request keeps services and location roles before generation
fa: verified natural location role survives fully grounded normalization without false gap
fa: verified natural location role survives partial recovery without false gap
instagram/ar: shared grounded multiline catalog survives real text adapter JSON serialization
instagram/fa: shared grounded multiline catalog survives real text adapter JSON serialization
localized deterministic clarification is used when no safe clarification survives
messenger/ar: shared grounded multiline catalog survives real text adapter JSON serialization
messenger/fa: shared grounded multiline catalog survives real text adapter JSON serialization
provider retry preserves full request including system, tool schema, history and language
representative final requests preserve selected style and language across turns
src/ai/booking-completion-regressions.integration.test.ts
src/ai/booking-state-machine.test.ts
src/ai/canonical-availability-observability.integration.test.ts
src/ai/channel-reliability.test.ts
src/ai/customer-intake-service-isolation.integration.test.ts
src/ai/full-matrix-confirmation.integration.test.ts
src/ai/german-initial-booking-intent.test.ts
src/ai/german-multifact-booking.integration.test.ts
src/ai/multichannel-language-isolation.integration.test.ts
src/ai/persian-instagram-post-booking-continuation.integration.test.ts
src/ai/priority-1i-live-recovery.integration.test.ts
src/ai/priority-1j-channel-parity.integration.test.ts
src/ai/priority-1k-range-availability.integration.test.ts
src/ai/recent-completion-presentation-language.integration.test.ts
src/ai/spanish-booking-boundaries.integration.test.ts
src/ai/telegram-earliest-range-parity.integration.test.ts
src/ai/whatsapp-swedish-tomorrow-regression.integration.test.ts
src/runtime/local-test-mode.test.ts
sv: compound request keeps services and location roles before generation
sv: exact compound WhatsApp path merges structured services and tenant location
sv: verified natural location role survives fully grounded normalization without false gap
sv: verified natural location role survives partial recovery without false gap
telegram/ar: shared grounded multiline catalog survives real text adapter JSON serialization
telegram/fa: shared grounded multiline catalog survives real text adapter JSON serialization
tool loop and no-tools fallback preserve prompt and history without executing real tools
unsafe factual or booking clarification candidate is not preserved
web requests cannot read another channel history with a supplied chat ID
whatsapp/ar: shared grounded multiline catalog survives real text adapter JSON serialization
whatsapp/fa: shared grounded multiline catalog survives real text adapter JSON serialization
```
