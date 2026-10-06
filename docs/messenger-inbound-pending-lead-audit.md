# Messenger inbound pending-lead crash audit

Baseline: `82c4806`. Worktree: `/Users/raffe/.codex/worktrees/messenger-reminder-audit/OdinLink`.
No commit, push, deployment, migration, or production data mutation was performed.

## Root cause and production evidence

Classification **G: expired legacy pending payloads participate in ambiguity before expiry is evaluated**.
Ordinary messages also enter pending-state recovery first (class F is the trigger, not a reason to bypass recovery).
This is not duplicate *active* Messenger bookings, empty-shell ambiguity, idempotency contamination, or missing tenant/channel filters.

Read-only inspection of Business 3's scoped Messenger session, derived from its latest persisted Messenger customer identity, found:

| Runtime candidate rows | Count |
| --- | ---: |
| Exact `ms_3:<sender>` session, Messenger, NULL business column | 142 |
| Empty `ai_summary` shells (already ignored by baseline) | 129 |
| Legacy `type=pending_booking` payloads with embedded Business 3 ownership | 13 |
| Explicitly Business-3-scoped Messenger rows | 0 |
| Pending payloads older than the default 45-minute TTL at the observed inbound time | 13 |

Pending payload creation times range from **2026-10-03 22:08:32.595 UTC** to **2026-10-04 11:42:51.202 UTC**.
The observed fresh inbound analytics event was **2026-10-06 20:16:28.912 UTC**.
Two older payloads retain service/date/contact state; eleven are at service intake. None is within the default TTL.
The latest prior persisted exchange and assistant-delivery analytics were on October 4.

The earlier query looking only for `business_id=3` Messenger leads misses these legacy NULL-column rows.
The runtime intentionally supports them by verifying the business inside `ai_summary`.
The Render environment's TTL override was not independently inspected: the code defaults to 45 minutes, and the repair honors its existing configured TTL rather than hard-coding that default.
Analytics correlation is hashed; this audit does not claim a direct SQL identity join between the fresh analytics event and the lead session.
The durable state, exact runtime lookup, and production-shaped reproduction account for the reported exception.

## Exact path before the fix

1. `processMessengerUpdate` (`server.ts:28900`) validates the event ID/Page and acquires an inbound claim.
   Echo/unsupported input, missing claim scope, and duplicate/unavailable claims stop processing.
   Claims use separate `idempotency:messenger` rows with hashed storage IDs.
2. `withMetaInboundEventTime` captures the actual Meta millisecond timestamp around the claimed handler.
3. `processMessengerUpdateClaimed` (`server.ts:28918`) resolves the exact Page through the channel connection/business lookup.
   An unverified business scope is rejected. The scoped session becomes `ms_<business>:<sender>`;
   the provider-time context is bound to that resolved business. Accepted-message analytics precede booking dispatch.
4. For every nonempty text, including `Hi, are you available?`, `handleUnifiedBookingEngine` enters
   `handleUnifiedBookingEngineTurn` (`server.ts:16039`) and calls `loadPendingBooking` (`server.ts:11374`).
   Owned in-memory state is checked first; durable candidates come only from `appointments_leads`.
5. `lookupPendingBookingLead` (`server.ts:11186`) executes:

   ```ts
   from("appointments_leads")
     .select("id,user_id,platform,business_id,ai_summary")
     .eq("user_id", scopedSession)
     .eq("platform", "messenger")
     .or("business_id.eq.3,business_id.is.null")
   ```

   There is no limit or first-row fallback. Noncanonical/missing business scope fails before the query.
   Query failures remain visible. NULL-column non-pending summaries are ignored.
   Legacy pending summaries must prove embedded tenant scope; a different tenant is ignored,
   absent scope throws `pending_lead_scope_unverifiable`. Embedded channel/customer mismatches
   throw `pending_lead_owner_mismatch`; missing row IDs throw `pending_lead_identity_missing`.
6. **Before repair, all 13 owned pending payloads are counted before TTL checking.** More than one throws
   `PendingBookingLeadIntegrityError("ambiguous_pending_lead")`.
   The existing `isPendingBookingExpired` check (`server.ts:6582`) is reached later in restoration, after selection,
   and cannot retire these candidates before ambiguity. State-version/structural checks also occur after selection.
7. `loadPendingBooking` logs and rethrows integrity errors. Messenger's deterministic-dispatch catch logs the
   reported crash and returns. The general assistant, Messenger sender, and `postProcessMessage` are never reached.
   This explains both the missing reply and missing fresh history/provider timestamp.

The ordering explains why ordinary input crashes without having created a new booking.
Recovery must still precede classification so a real active booking can consume continuation input safely.

## Narrow repair and integrity guarantees

After all existing ownership and row-identity checks, exclude a candidate only when it is:

- Messenger, with a NULL legacy business column;
- an actual `pending_booking` payload;
- carrying a numeric/string creation time that is finite and positive;
- expired under the existing `isPendingBookingExpired` TTL rule.

No row is deleted, cleared, merged, ranked, or selected arbitrarily. Row timestamps and `updatedAt` do not decide authority.
Missing, invalid, coercible non-timestamp values, future timestamps, and the exact TTL boundary do not qualify for exclusion.
Bad ownership is still rejected even on an expired payload. Two active matching leads still fail closed on load and save.
Explicitly business-scoped Messenger duplicates and all other channels retain their previous behavior.
One active exact-owner lead survives alongside expired legacy payloads and continues with its service/date/contact state.
If all real candidates have expired, ordinary conversation handling proceeds without fabricating pending state.

The whole existing production-code region after this lookup and before the test boundary is byte-identical to `82c4806`.
That includes booking progression, Messenger inbound/sender, provider-time persistence, reminder scheduling/policy, and WhatsApp provisioning.

The repaired path reaches `postProcessMessage` (`server.ts:1134`) within the existing event-time context.
Its exact business/session/event-customer match persists the original sender ID, canonical Messenger platform,
Business 3, and the actual Meta `provider_event_at`. No timestamp is invented from processing time.

## Files and tests

| File | Change |
| --- | --- |
| `server.ts` | Narrow legacy Messenger expiry filter; guarded test-only entry point to the existing Messenger handler |
| `tests/helpers/pending-lead-store.ts` | Optional non-lead transport fixture and realistic PATCH/select responses for existing idempotency settlement |
| `src/runtime/messenger-pending-lead.integration.test.ts` | 31 focused tests |
| `docs/messenger-inbound-pending-lead-audit.md` | This audit and release validation plan |

Tests use the installed Supabase/PostgREST client with intercepted storage, encrypted synthetic Page credentials,
intercepted Graph/analytics transports, and deterministic AI. No live send is performed.
They cover production-shaped 129+13 rows; no state/empty shells/expired state through the full inbound handler;
internal rows; wrong tenant/channel/customer; unprovable ownership; creation-time validity/TTL equality;
active restoration and booking continuation; genuine ambiguity on load/save/full inbound;
exact provider timestamp and customer persistence; no channel fallback or ordinary-message booking side effect;
unchanged WhatsApp empty-shell and other-channel duplicate behavior.

Before the production fix, the first 22 focused lookup tests produced **20 passes and two failures**:
the production-shaped case and active-plus-expired case both threw `ambiguous_pending_lead`.

## Validation

| Check | Result |
| --- | --- |
| New Messenger + existing pending-lead integration tests | 59/59 passed (31 new, 28 existing) |
| Existing Messenger reminder scheduler integration | Passed, unchanged |
| Existing reminder delivery policy integration | Passed, 538 scenarios, unchanged |
| Existing WhatsApp proactive delivery safety integration | Passed, unchanged |
| Booking progression, multichannel progression, partial continuation, WhatsApp contact, pending-hold lifecycle | 129/129 passed |
| Channel connections, WhatsApp preflight boundary/provisioning preflight, template provisioning | 56/56 passed |
| Build | Passed; existing bundle-size warnings |
| `git diff --check` | Passed |
| Full type check | Six existing syntax errors in `patch_key_rotation.ts`; reproduced on untouched `82c4806` |
| Targeted server/new-test/helper type check | Same 16 baseline diagnostics, no new diagnostics |
| Additional `booking-state-machine.test.ts` | Existing source-regex assertion failure, reproduced on untouched `82c4806` |

Targeted checking used TypeScript with ES2022, ESNext modules, bundler resolution, DOM libraries,
skipLibCheck, allowImportingTsExtensions, esModuleInterop, and react-jsx.
Baseline comparisons normalize source line/column offsets and compare diagnostic multisets.
The additional booking-state test expects `isPendingSlotConfirmation(text, pending)`, which is already absent in `82c4806`.

## Remaining live risk and validation after a separately authorized release

Live delivery is not claimed: no release or provider action was performed. Runtime TTL overrides and actual
Page token/provider acceptance require confirmation in the release environment. Genuine active ambiguity,
unverifiable ownership, and unproven expiry deliberately remain blocked. Expired legacy rows remain stored.
Messenger reminder policy, its verified provider-window requirement, and outside-window blocking are unchanged.

1. Confirm the release includes this patch on top of `82c4806` and the intended positive pending-booking TTL.
2. From the affected real Messenger user, send a **new** `Hi, are you available?` to Business 3's connected Page.
   Use a new event/message ID; do not replay the previously settled inbound claim.
3. Confirm Page/Business 3 resolution and an ordinary Messenger reply, with no `ambiguous_pending_lead`,
   fallback channel, pending booking, appointment creation, or reminder send caused by that text.
4. Read-only inspect that new exchange: `business_id=3`, `platform=messenger`, `user_id` equals the event sender,
   inbound text matches, and `provider_event_at` equals the Meta event timestamp in UTC, not insertion time.
5. Confirm existing legacy pending rows are untouched. For a separately agreed booking test, verify one active
   Messenger booking continues with its existing service/contact/date state. Do not create conflicting production leads.
6. Keep reminder validation separate: a real due Messenger booking must still satisfy the already-deployed
   window/Page/credential rules. Confirm its normal provider acceptance and same-channel logs without bypassing policy.

Final intended Git state: detached `82c4806`; two modified files and two new files listed above, all uncommitted.
