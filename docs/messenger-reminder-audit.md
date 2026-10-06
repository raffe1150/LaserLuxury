# Messenger appointment reminder audit and repair

Audit date: 6 October 2026 (Europe/Stockholm). Release baseline: `52d961b`.
Worktree: `/Users/raffe/.codex/worktrees/messenger-reminder-audit/OdinLink` (detached HEAD).
No commits, pushes, deployments, migrations or production-data writes were performed.
Production inspection used read-only Supabase queries; all delivery tests used mocked providers and storage.

## A. Root cause and ranked blockers

1. **All Messenger reminders: intentional blanket policy block.** At baseline,
   `sendAppointmentReminder` (`server.ts:26752`) returns
   `unsupported_proactive_delivery_path / messenger_reminder_wire_type_unverified`
   even with an open window. `sendMessengerMessage` (`server.ts:28124`) independently
   returns false whenever `reminderDelivery` is true. No Graph request is made.
   This is classification **B**, rather than missing scheduler routing or a missing
   ordinary sender. The previous hardening could not verify the proactive wire enum.
2. **Current Business 3: no eligible provider evidence.** All 924 persisted
   Messenger customer messages have NULL `provider_event_at` and NULL cutover
   markers. The latest persistence is 4 October 2026, 13:43:10 Stockholm time.
   Local persistence time, booking creation and an outbound reply cannot authorize
   a window. This is an independent evidence blocker (**E**). At audit time there
   were zero Messenger candidates in either scheduler window.
3. **Outside the standard window: unsupported provider mechanism.** OdinLink has
   no Messenger Utility-template integration. This remains blocked for every
   business. WhatsApp template provisioning cannot serve Messenger.
4. **Individual connections:** inactive, missing, expired, undecryptable,
   wrong-tenant or wrong-Page credentials remain fail-closed. Business 3's stored
   status is connected, but current token validity and subscription were not
   independently checked with Meta because the local environment has no channel
   credential decryption key or Meta app credentials.

One historical Business 3 Messenger appointment (216, created 8 September) has
both reminder flags true. Those legacy flags contain no provider receipt and do
not prove live reminder delivery under this hardened baseline.

## B. Exact path and fail-closed branches

References below identify functions in the repaired `server.ts`; baseline blocking
line numbers above refer to unchanged `52d961b`.

| Stage | Runtime path and refusal conditions |
| --- | --- |
| Inbound | Signed Meta webhook -> `processMessengerUpdate` -> exact Page/message idempotency claim; echoes, absent message/Page IDs and unsupported payloads are ignored. `findMessengerBusinessByPageId` resolves the explicit connection first; ambiguous/unscoped legacy routing is refused. |
| Provider time | `withMetaInboundEventTime` captures webhook milliseconds; `bindMetaInboundEventBusiness` binds the resolved tenant. `postProcessMessage` persists canonical platform/customer identity and `provider_event_at` only for that exact async event/tenant tuple. Missing, malformed or future times become NULL. Delayed events keep their original time. Analytics fallback times do not authorize reminders. |
| Booking | Unified booking -> verified Calendar creation -> `recordAppointmentFromBooking`. The appointment stores business, booking platform, provider customer ID, language and start/end times, with both reminder flags false. The row is verified against the same tenant/channel/customer before booking success. No booking logic was edited. |
| Selection | `setupDailyReminders`: cron every five minutes; status booked, matching flag false, inclusive 23.5–24.5 hours or 1.75–2.25 hours before appointment start; limit 25 per type. No channel filter excludes Messenger. |
| Calendar proof | `processAppointmentReminderCandidate` -> `verifyAppointmentCalendarForReminder`: exact tenant/calendar, valid times/channel/customer/service, and exactly one active matching Calendar appointment. Missing, ambiguous, stale or unreadable Calendar evidence refuses delivery before any provider call. |
| Recipient/channel | `sendAppointmentReminder`: appointment platform is normalized, recipient derived only from its stored provider ID; missing recipient, unsupported channel or tenant mismatch refuses delivery. No phone-based or cross-channel fallback. |
| Window proof | Exact business/platform/customer-or-current-scoped-session history tuple; user/customer sender only; most recent actual provider event. Query error refuses delivery. Messenger requires a real provider timestamp, age >= 0 and < 24 hours, and event time at/after the current connection's `connected_at`. NULL timestamps, legacy cutover-only rows, stale/backdated/future events, other tenants/channels/senders and pre-connection history cannot authorize Messenger. |
| Connection | `resolveConnectionForBusiness`: explicit connected Messenger connection with reconnect false; decrypted Page token; exact returned tenant/provider; Page ID; `pages_messaging`; valid nonfuture connection epoch; unexpired known token expiry. No ENV, Instagram token, legacy manual alias or other-business fallback authorizes this new reminder path. Lookup/decryption failure returns failure. |
| Text | Existing `formatReminderMessage`: stored booking language and service, tenant name/timezone and 24h/2h wording. Existing proactive outbound context preserves reminder text. |
| Page proof | `sendCustomerMessage` selects Messenger only. Reminder sender requires request-local authorization bound to tenant/Page/recipient/token/window. GET `v25.0/me?fields=id` with the resolved Page token must return exactly the connected Page ID, without errors. Invalid response, redirect or transport failure blocks POST. Known expiry and window are rechecked after lookup. |
| Send | POST `v25.0/{resolved-page-id}/messages`, bearer Page token, recipient PSID, `messaging_type: UPDATE`, plain reminder text, no tag/template/agent extension. Ordinary conversation payload and endpoint remain unchanged (`RESPONSE`, `/me/messages`). |
| Acceptance | HTTP success, no provider error, nonblank string `message_id`, and exact `recipient_id` are all required. Missing/invalid IDs, wrong recipient, malformed JSON, HTTP errors and transport errors return false. A bare 200 cannot mark a reminder sent. |
| Logging/flags | `[ReminderDelivery]` logs tenant, appointment, channel, type, acceptance/category/reason. `[ChannelSend]` logs the accepted Messenger provider message ID; Page binding failures and send errors are sanitized. Only acceptance updates the matching appointment and tenant flag. Provider auth errors retain the existing reconnect-required update. |
| Retry | Failures leave flags false and are retried by subsequent five-minute sweeps while the appointment remains in that timing band. Every attempt repeats policy/Page proof. No inline retry or fallback. After accepted delivery, flag persistence failure logs `flag_update_failed`; the unchanged scheduler can resend in that case. There is no new exactly-once guarantee or concurrency claim. |

## C–D. Provider support and smallest repair

Inside-window proactive updates are supported by Meta. The literal enum is now
verified in Meta's **official generated SDK version 25.0.0**, matching this sender's
Graph version: `Page.MessagingType.update = UPDATE`, used by `Page.create_message`
for the `/messages` edge. This resolves the previous verification gap without
misclassifying an automated reminder as an immediate response.

- [Meta v25 SDK Page send contract](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.0/facebook_business/adobjects/page.py)
- [Meta standard messaging window and proactive Updates](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)

Outside-window sending remains unsupported **in OdinLink**. Meta separately
provides Page-owned Utility templates, an approval flow and the
`page_utility_messaging` permission; the existing Messenger connection does not
request that permission or implement the template lifecycle/send contract.
Retired `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` tags
must not be introduced. Automated reminders do not use `HUMAN_AGENT`.

- [Meta Messenger Utility messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages)

| Difference | Telegram | Instagram | WhatsApp | Repaired Messenger |
| --- | --- | --- | --- | --- |
| Scheduler/Calendar | Same timing and exact linkage checks | Same | Same | Same |
| Window | No Meta window | Verified 24h evidence; bounded existing legacy transition | Verified 24h evidence; bounded existing legacy transition | Actual provider event only, within current Page connection epoch |
| Credential | Existing tenant bot selection | Existing tenant account hydration | Existing tenant phone/WABA hydration | Explicit active tenant Page connection plus provider token/Page identity proof |
| Proactive send | Existing Bot API semantics | Existing untagged send | Existing text or verified Utility template | Normal Messenger adapter, `UPDATE` on named Page endpoint |
| Outside window | Existing behavior | Blocked | Existing safe template contract | Blocked |
| Acknowledgement/retry | Unchanged HTTP contract | Existing ID/recipient validation | Existing valid WhatsApp ID validation | ID/recipient validation now reachable; same scheduler retry |

## Live Business 3 connection findings

- Authoritative self-service connection: `08bf9030-9239-4e0b-8eea-93cd80f1b9b7`.
- Page ID: `1206339572553466`; encrypted credential is present.
- Authorizing Meta user: `122095247583493180`.
- Connected and last verified: 24 September 2026, 23:47:09 Stockholm time.
- Status connected, reconnect_required false, token_expires_at NULL. NULL means
  no stored expiry; it does not prove perpetual validity.
- Stored scopes: pages_show_list, pages_messaging, pages_manage_metadata.
- Legacy business fields have no Page/token and messenger_enabled is false.
  Explicit connection resolution supplies the Page/token; that legacy flag does
  not block the reminder or inbound connection route.
- `completeMessenger` exchanges OAuth credentials for META_APP_ID/META_APP_SECRET,
  resolves the authorizer, requires exactly one messaging-capable Page, and
  subscribes messages/messaging_postbacks/feed before saving the encrypted Page
  token. The code uses configured Graph v26 by default for connection setup and
  existing v25 for sends. No version changes were made.
- Page subscription and originating app identity are assumed from successful
  connection setup, rather than continuously verified in the repository resolver.
  The repair verifies the token's Page identity at send time. It does not claim a
  live debug_token or subscription check was performed.
- Ordinary Messenger sending is supported and has live application acceptance
  evidence: 150 assistant_response_sent events (58 general responses, 92 booking
  replies), latest 4 October at 13:43:09 Stockholm time. Those events follow the
  existing HTTP-success conversation contract; they are not device delivery/read
  receipts and do not prove reminder acceptance.

## E–F. Files and tests

- `server.ts`: replaces the two blanket reminder blocks with explicit Messenger
  authorization/Page verification; strict acknowledgement and same-channel routing;
  adds two guarded test-boundary conveniences. Other channel send paths are unchanged.
- `src/runtime/reminder-delivery-policy.integration.test.ts`: 538 frozen-time
  scenarios, including both Messenger reminder types, provider persistence time,
  canonical/scoped history, exact expiry, missing evidence, old events, wrong
  tenant/Page, inactive/expired/invalid credentials, no fallback, provider failures
  and invalid acknowledgements. Retains Telegram/Instagram/WhatsApp regressions;
  legacy local-time transition remains available only on its already-working paths.
- `src/runtime/messenger-reminder-scheduler.integration.test.ts`: actual mocked
  cron callback through Calendar verification and Messenger provider adapter;
  inclusive timing edges, outside-edge exclusions, cancelled/already-sent rows,
  provider rejection followed by next-sweep retry, flags and no repeat after success;
  direct sender reminder flag cannot bypass authorization.
- `docs/messenger-reminder-audit.md`: this audit, limitations and live validation plan.

No dependencies, schema, migrations, WhatsApp rollout or booking implementation changed.

## G. Validation

| Check | Result |
| --- | --- |
| Messenger scheduler/send/retry integration | PASS |
| Reminder delivery policy integration | PASS, 538 scenarios |
| Calendar reminder verification and reminder language | PASS |
| WhatsApp proactive safety, Instagram outbound/inbound, Meta outbound context | PASS |
| Channel connections, WhatsApp provisioning preflight/boundary, template provisioning, mapping publisher, Telegram setup | PASS |
| Verified booking confirmation, Telegram Persian booking, Instagram Arabic booking, WhatsApp canonical identity | PASS |
| Build | PASS; existing bundle-size warnings |
| git diff --check | PASS |
| Full type checking | Existing six syntax errors in patch_key_rotation.ts; identical to untouched 52d961b |
| Targeted server/changed-test type checking | Existing 16 diagnostics; identical diagnostic multiset to baseline, zero new errors |
| Additional local-test-mode check | FAIL: stale source assertion expects an inline /api/chat handler; same failure on baseline |
| Additional priority-1j channel parity check | FAIL: existing assertion at line 814; same failure on baseline |
| Additional Meta compliance source assertion | FAIL: expects old single-secret webhook code; same failure on baseline |

Across the two test runs: 141/144 tests passed, three existing failures, no skips.
The seven required reminder/channel suites all passed. The three failures were
reproduced in the untouched release checkout; unrelated code/tests were not repaired.
No PostgreSQL migration tests or live sends were run.

## H–I. Remaining limitations and recommended live validation

The patch is local and has not established live Messenger reminder delivery.
Historical provider times must not be fabricated or backfilled from created_at.
Fresh legitimate inbound activity is required. Reconnecting a Page conservatively
requires new inbound evidence after the new connection epoch. Legacy-only Messenger
credentials cannot authorize this new path.

After a separately authorized release, use this exact operator-run plan:

1. Inspect Business 3's resolved encrypted connection in the backend environment.
   Read-only Meta calls: /me?fields=id must equal 1206339572553466; debug_token must
   show a valid Page token for the intended app and messaging scope; GET the Page's
   subscribed_apps and confirm that same app subscribes to messages. Inspect app
   live mode/access and the webhook signature secret. Do not print credentials.
2. Send a fresh ordinary message from a controlled Messenger tester to that Page.
   Confirm the reply, exact tenant/channel/customer history tuple, and non-NULL
   provider_event_at matching the webhook event time, after connected_at and <24h
   old. A recent created_at alone is insufficient.
3. Through that same Messenger conversation, book two real, available controlled
   test appointments: one roughly 24h10m ahead and another roughly 2h10m ahead.
   Use the booking flow; verify exact Calendar linkage, Messenger platform/PSID,
   tenant, and false matching reminder flags. Do not edit flags/timestamps or
   create appointments directly in the database to simulate eligibility.
4. Allow the next natural five-minute sweep. For each reminder type require the
   Page GET proof, Messenger UPDATE send, provider message ID, exact recipient,
   accepted ReminderDelivery log for its appointment, matching flag update, and
   the tester's visible message from the expected Page. Check the following sweep
   does not duplicate accepted reminders. No other channel should be contacted.
5. Validate the closed-window and error cases in the local mocked tests already
   provided. If an additional live closed-window observation is desired, use a
   separately approved controlled booking with naturally expired inbound evidence;
   observe policy refusal and no POST. Never replay/backdate a production webhook
   or force an expired-window provider request.

Current runtime logs are not available in this session; deployment revision and
actual device receipts remain part of that operator validation.

## J. Git state

HEAD remains detached at 52d961b. Two tracked files modified and two new files:
server.ts, reminder-delivery-policy.integration.test.ts,
messenger-reminder-scheduler.integration.test.ts and this audit.
No commit/push/deployment or production-data modification.
