# Pre-P2 WhatsApp routing correction

## 1. Final status and baseline

**ROUTING FIX READY**

Prepared on 2026-09-15 in `/Users/raffe/Documents/OdinLink-prep2-routing-fix`, detached from confirmed production P1 commit `e866f8123860a76f56904650e7a0c3360fc3169d`. Only the changes listed below were made. No commit, push, deployment, live provider operation, schema change, or P2 work occurred. The dirty main tree and existing P1 tree were not edited.

The focused regression passes with the correction and fails on an untouched archive of `e866f81`. All required focused P1 checks, Arabic production regression, relevant multilingual suites, and production build pass. Two known baseline checks remain failing: the synthetic phone expectation and the unrelated `patch_key_rotation.ts` syntax errors. Neither is treated as a new routing-release blocker or silently changed.

## 2. Root cause confirmed — with a correction to earlier evidence

`processWhatsAppMessageClaimed` uses `getScopedChannelSessionId`, including business/channel identity. The earlier loop-classification replay inspected `wa_46700000000`, not that scoped key. Its claim that no pending state existed after the service question was therefore not established. This replay uses the actual `channelSessionId` boundary and observes **awaiting_service already persisted** after the first availability question in a two-service catalog. No new service-prompt state is needed.

The underlying routing finding remains valid: `classifyMessagingIntent` sees `Video Consultation` as ambiguous, and the wrapper returns the operation clarification before the engine can consume existing service-selection state. `isDeterministicActiveNewBookingContinuation` previously admitted owned slots and confirmations/contact, but not service selection. `detectNormalizedIntent` also failed to recognize the exact operation label `Ny bokning` offered by the clarification itself.

Admitting the operation label exposed a directly adjacent baseline null dereference: in the missing-service branch, `latestAvailabilityConstraint?.startDate === latestAvailabilityConstraint?.endDate` is true when both are undefined, then accesses `latestAvailabilityConstraint.startDate`. A missing date now safely falls back to pending date or null. This small correction is necessary for the newly admitted date-less choice; it does not change valid date constraints.

## 3. Exact files and functions changed

| Runtime file | Function / location | Correction |
|---|---|---|
| `server.ts` | `isDeterministicActiveNewBookingContinuation`, around 4503 | Allow awaiting-service continuation only for existing new-booking ownership, no competing lookup/reschedule/cancellation, no business-information question, successful existing configured-service resolution, and full normalized configured name/alias match. |
| `server.ts` | `handleUnifiedBookingEngineTurn`, missing-service branch around 17136 | Require a present availability constraint before comparing and reading its single-day start date. |
| `src/ai/booking-intelligence.ts` | `detectNormalizedIntent`, around 266 | Recognize exact six-language new-booking operation labels, optional articles and terminal statement punctuation; Arabic diacritics are removed only in this local label comparison. |

Additional files:

- `tests/pre-p2-routing/run.cjs`: disposable bundle exposes the actual private WhatsApp wrapper only to the test process; cleans the bundle afterward and launches with a sanitized environment.
- `tests/pre-p2-routing/routing.test.cjs`: controlled-clock semantic wrapper regressions with synthetic reads, outbound transport capture, and forbidden mutation counters.
- `tests/pre-p2-routing/offline-network.cjs`: local test containment inherited from P1; blocks sockets/fetch and local agent-config discovery. The test replaces fetch only with an asserted synthetic Meta-send mock.
- This report, `evidence/validation.json`, and `evidence/routing-transitions.json`: evidence artifacts.
- Local `.log` files under `evidence/` contain detailed offline output; these are ignored by the existing repository ignore policy. No real customer data was used.

No other runtime file differs from `e866f81`. No auth/calendar/website/privacy P1 logic was edited. No booking-state type, persistence format, operation authority, provider tool or schema was changed.

## 4. Why the correction is narrow

The ambiguity gate remains. It gains one state-backed exception, using the same existing service resolver as the engine. A full configured label match is additionally required because the existing fuzzy resolver can map `Unknown Consultation` to `Video Consultation`. The new exception does not admit that unsupported reply merely because the generic word “Consultation” overlaps.

The exact operation alternatives are `ny bokning`, `new booking`, `neue Buchung`, `nueva reserva`, `رزرو جدید`, and `حجز جديد`, with the articles used by the existing clarification prompts. They are whole-input matches, not arbitrary mentions of “booking.” Questions and negations are excluded from the added rule. Existing longer explicit creation phrases continue through existing vocabulary. This is shared intent normalization, so exact-label recognition intentionally applies beyond WhatsApp; the service-admission exception is WhatsApp-specific.

There is no repetition counter or new authoritative state. A valid service answer advances to offers; a valid operation label selects the existing new-booking flow and requests the missing prerequisite. Repeating an operation label while service is missing may repeat the **service question**, which is actionable by supplying a configured service; it no longer returns the operation-ambiguity question. This is not a general solution for every repetitive conversation.

## 5. Before / after state and intent

Fixture: actual WhatsApp wrapper, Swedish initial turn, business `admotion studio`, `Video Consultation` plus one other configured service, empty synthetic calendar, clock `2026-09-15T08:00:00Z`, no seeded conversation/history/pending state.

| Turn | Untouched e866f81 | Corrected behavior |
|---|---|---|
| `Vilka tider är lediga imorgon?` | Service question; scoped state awaiting_service | Same; requested date 2026-09-16 retained |
| `Video Consultation` | Ambiguous pre-dispatch return; unresolved service remains | State-backed admission; authoritative canonical service; awaiting_time_selection with owned offers for tomorrow |
| `Ny bokning` | Stateless normalization clarification; wrapper ambiguity loop (prior baseline classification) | new_booking; existing explicit-new-request policy starts a new request and asks for service |
| Repeated `Ny bokning` | Same operation ambiguity | Keeps new-booking ownership; actionable service question, no operation ambiguity |
| Configured service after the operation/service question | Could be intercepted | Authoritative service; awaits date when none is retained |

An explicit new-booking label after existing offers follows the existing explicit-new-request reset policy; it does not select an offered slot, preserve a previous task by inventing new semantics, or confirm a booking. Single-service/default behavior may still use the existing model presentation fallback for a date-less request; the new tests prove admission/state, not a new guaranteed deterministic presentation path there.

The unmodified-baseline negative control in this task stops at the first failing service-adoption assertion. It independently proves that regression; it does not claim to re-run all later baseline turns after the assertion. Earlier baseline-versus-P1 loop classification supplies the repeated-ambiguity comparison, with the session-state inspection limitation corrected above.

## 6. Regression coverage and invariants

The new wrapper test covers:

1. Exact live user sequence plus repeated `Ny bokning`, with a two-service catalog.
2. Actual scoped pending state, retained tomorrow date, canonical service identity, authoritative service resolution, owned slot offers and next phase.
3. Unknown `Unknown Consultation` not silently adopted; awaiting_service retained.
4. Generic price question mentioning booking and price question naming the service: no service adoption or availability reads.
5. Standalone service without pending ownership still hits the ambiguity gate; the subsequent operation choice advances.
6. Six-language exact operation alternatives at both normalization and wrapper boundaries; existing `jag vill boka en ny tid` normalization unchanged.
7. Negative questions/negations not recognized by the new exact-label rule.
8. Single-service catalog and an alias already recognized by the existing resolver (`Remote Consultation`). This does not promise support for every arbitrary alias beyond existing resolver behavior.
9. All create/update/cancel, record/claim/notification counters remain zero before required prerequisites. No synthetic mutation method may be invoked in this new suite.

Existing multi-channel booking progression and confirmation matrices separately cover normal slot/confirmation/contact progression, including successful **mocked** operations when prerequisites are satisfied. Arabic continuation, service-name preservation, Swedish/German/Persian and other supported-language regressions remain passing.

Preserved invariants: ambiguity remains fail-closed outside the narrow exception; no service adoption without configured evidence in the new admission path; owned-slot validation unchanged; confirmation/contact prerequisites unchanged; calendar failure semantics and verified-success guards unchanged; no model-driven mutation authority added.

## 7. Validation results

Environment: Node v22.17.1; existing local dependencies reused without installing packages or reading production credentials. New wrapper fixture clock: Sep 15, 2026. Existing suites use the P1 controlled clock Sep 14, 2026 to preserve their fixture assumptions. All provider traffic is mocked/blocked. Synthetic outbound delivery is captured, not sent.

| Check | Result |
|---|---|
| New actual-wrapper routing regression | PASS |
| Same regression on untouched e866f81 | Expected FAIL: service stays `Bokning`, not `Video Consultation` |
| P1 auth | PASS |
| P1 browser API + browser session | PASS / PASS |
| P1 strict calendar | PASS |
| P1 website containment | PASS |
| P1 privacy | PASS |
| whatsapp-multilingual-production-regressions.integration.test.ts | PASS |
| full-matrix-confirmation.integration.test.ts | PASS |
| multichannel-booking-progression.integration.test.ts | PASS |
| multichannel-language-isolation.integration.test.ts | PASS |
| configured-service-duration-parity.integration.test.ts | PASS |
| booking-completion-regressions.integration.test.ts | PASS |
| shared-post-completion-routing.integration.test.ts | PASS, expectations unchanged |
| priority-1h-unified-engine.integration.test.ts | Known baseline FAIL at line 145: expected 46700000000; synthetic explicit contact yields 03585353563 |
| npm run build | PASS |
| npm run lint | Known unrelated FAIL: patch_key_rotation.ts syntax errors at 47, 94, 99 |
| git diff --check | PASS |

`evidence/validation.json` records check exit codes; `evidence/routing-transitions.json` records scoped phase/service/intent/language/offer count and read/model/write counters. No typecheck-green claim is made: the unrelated syntax errors prevent a full successful typecheck.

Focused P1 tests are not present in the production commit's tracked test tree. They were copied unchanged from `/Users/raffe/Documents/OdinLink-p1-error-contracts/tests/p1` into temporary `tests/.p1-validation` and run against this worktree's source; that temporary directory was removed. They are not part of the routing patch. No P0 overlay or stale expectation was imported into runtime code.

To re-run the newly added suite with dependencies installed: `node tests/pre-p2-routing/run.cjs` from the worktree root. Production build: `npm run build`. Existing integration suites require the same offline blocker and controlled clock described above; never run them with production provider configuration.

## 8. Remaining risks and limitations

- Production business configuration and live delivery were not exercised. No deployment or production-verification claim is made.
- Exact operation labels intentionally select a new task even without a remembered operation-choice prompt; they are explicit intent, never mutation authorization.
- Explicit new task requests can reset prior offers/service under existing policy. Interruption/resumption redesign remains outside scope.
- Unknown/partial service phrases can still receive the existing ambiguity response. Arbitrary alias resolution and general fuzzy-service behavior were not redesigned.
- Existing response generation can still use a model for some date-less/single-service paths. The exact two-service service-answer progression is deterministic in the fixture.
- Baseline phone assertion and TypeScript syntax errors remain visible, unchanged, and separate. No safety/privacy expectations were weakened.
- The previous audit's unscoped snapshot mistake is corrected here; do not use its null pending state as proof of missing persistence.

## 9. Rollback and next action

Review only these two runtime-file hunks and the added tests/docs. No commit/push/deploy was performed. Keep P2 blocked on its own ownership/schema/topology gates; this fix does not satisfy those prerequisites.

For a future deployed rollback, revert this patch's three runtime hunks as one unit (service admission, exact labels, null guard), preserving all P1 changes in `e866f81`. The test/docs additions can remain as regression evidence. No database, calendar, state-format, data-backfill or migration rollback is required. Reverting restores the known baseline routing loop, so choose rollback only for an evidenced regression.

In the current isolated worktree, discard only these task-owned hunks after reviewing the diff if rollback is requested; never reset the dirty main tree or remove unrelated work. Dependencies were reused through a temporary node_modules symlink during validation and it is not part of the patch.

**ROUTING FIX READY**
