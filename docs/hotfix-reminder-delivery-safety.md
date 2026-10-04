# Appointment reminder delivery safety

This document records the safety checkpoint now committed as `98313d4`.
The subsequent local WhatsApp Utility-template feature and its latest validation
are documented in [reminder-utility-template-readiness.md](reminder-utility-template-readiness.md).
Statements below about missing WhatsApp template integration describe that checkpoint.

Audited on 2026-10-04 in the production-hotfix worktree. This change is local,
uncommitted, and undeployed.

## Audit findings and root causes

The reminder worker selects the existing 24h and 2h candidates, performs strict
Calendar verification, calls `sendAppointmentReminder`, and previously forwarded
every reminder directly to `sendCustomerMessage(..., "proactive")`. The flag was
updated after a boolean sender success, without determining delivery eligibility.

- **WhatsApp:** the sender always constructs `type: "text"`. Its proactive
  acceptance check already required HTTP success and a `wamid`, but the reminder
  path never called the existing customer-service-window helper. The manual
  dashboard route does call that helper. A provider message ID is acceptance of
  a request, not proof that the customer received it.
- **Messenger:** reminders previously used `messaging_type: "RESPONSE"` without
  checking the standard messaging window. HTTP success alone returned true.
- **Instagram:** reminders previously used ordinary text without checking the
  messaging window. HTTP success alone returned true.
- **Telegram:** normal Bot API `sendMessage` already implements the expected
  reminder transport; no Meta window or template defect was found.

`postProcessMessage` persists canonical platform/user IDs, `sender: "user"` for
customer input, and `sender: "bot"` for replies, together with `business_id`.
Older customer rows can use `sender: "customer"`. Messenger and Instagram
handlers exclude message echoes. The original chat-history write stored only local
`created_at`, which does not prove provider event time after delayed processing.

The revision uses WhatsApp `message.timestamp` (seconds), Messenger
`webhookEvent.timestamp` (milliseconds), and Instagram `webhook_event.timestamp`
(milliseconds). Analytics and optional P2 shadow records already receive these
values, but their shared normalizer falls back to local time when missing; those
records cannot prove window eligibility. A nullable `chat_history.provider_event_at`
column now stores only validated actual inbound event time. Missing, malformed,
non-positive or future webhook values store null. Existing rows are not backfilled.

A small per-webhook async scope carries the timestamp through existing persistence
calls, including queued booking turns, and binds it to the resolved business and
actual customer/platform. It cannot leak between concurrent tenants or later
writes. Legacy Messenger/Instagram writes that pass a session ID persist the real
provider customer ID only when that session exactly matches the current event and
resolved business. Booking state is unchanged.

Repository searches found no WhatsApp reminder template configuration, template
sender, generic Meta template sender, Messenger Utility template integration,
notification-token storage, or ad-entry window state. Business normalization
explicitly supplies canonical tenant credentials, and existing channel connection
hydration resolves credentials by business and provider. Some low-level senders
have global credential fallbacks; reminders now require canonical tenant fields
before entering those senders.

The WhatsApp `/webhook` branch reads `value.messages`, but does not process
`value.statuses`. Reminder provider message IDs are not persisted or associated
with appointment IDs/reminder types. Later failed/delivered events cannot currently
reconcile reminder flags.

## Provider policy verified before implementation

Official Meta documentation was read directly; the web reader returned rate
limits on several pages, so the public official pages were also fetched directly.

| Channel | Current rule | Rule implemented |
| --- | --- | --- |
| WhatsApp | Free-form service messages require an open 24-hour customer service window. Outside it, a pre-approved template is required. Customer messages or calls can reset the window. | Reuse the existing helper with the latest business/customer/WhatsApp inbound history. No call history is inferred. If closed, return template-required/missing and make no provider request. |
| Messenger | Standard messages use the 24-hour window; proactive standard messages use the Updates message type. `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, and `POST_PURCHASE_UPDATE` return error 100 from 2026-04-27. Utility templates support appointments but require approved Page-owned templates and `page_utility_messaging`; one-time notifications require explicit permission tokens. | Fail closed for automated reminders even inside the ordinary window: the exact current wire enum is unverified. Outside the supported window, fail closed; no approved Utility template or notification-token integration exists. |
| Instagram | Instagram Login messaging requires user initiation and allows a standard 24-hour response window. Human-agent extensions are for human responses. | Allow ordinary automated reminder text only with a legitimate recent inbound within 24 hours. Otherwise fail closed. No special tag is used. |
| Telegram | Bot API `sendMessage` sends text to an accessible bot chat. No Meta template/window requirement applies. | Keep the existing sender and HTTP-success/failure behavior. Require the selected business's bot credential at the reminder boundary. |

Meta's Developer Policies also describe a possible seven-day standard window for
eligible Click-to-Messenger/Instagram-Direct ad entry. OdinLink does not persist
verified ad-entry eligibility; this fix conservatively supports only the ordinary
24-hour inbound-message window, using provider event time plus the explicitly
bounded legacy rollout compatibility described below. This is not an exhaustive model of Instagram eligibility. It does not infer an extension from a booking,
an outbound message, a comment, or the mere presence of a customer ID.

The official Messenger **Messaging types** section documents semantic “Updates”
and requires the standard window, but does not conclusively verify the current
literal `UPDATE` enum. The local package manifest, installed dependency types,
repository provider definitions and generated-schema searches contain no Meta
SDK/current Graph Send API enum contract. Repository literals are not authoritative
provider verification. Automated Messenger reminders therefore return
`unsupported_proactive_delivery_path` with reason
`messenger_reminder_wire_type_unverified`, without a provider request. Normal
Messenger conversations retain their existing `RESPONSE` payload; no reminder is
silently reclassified as a reply.

Sources:

- [WhatsApp service messages and acceptance semantics](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)
- [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)
- [Messenger message types, standard window, tag retirement](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)
- [Messenger Utility templates and permissions](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages)
- [Messenger and Instagram policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/)
- [Instagram Login Send Messages](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Meta Developer Policies, including ad-entry extensions](https://developers.facebook.com/devpolicy/)
- [Telegram Bot API sendMessage](https://core.telegram.org/bots/api#sendmessage)

## Behavior and result semantics

Strict Calendar verification is unchanged. It still precedes any delivery attempt.
The schedule, language formatting, service/date/time calculations, booking state,
and conversational reply paths are unchanged.

Reminder eligibility reads only the latest matching `chat_history` row using
business ID, an exact canonical/same-business-scoped customer ID allowlist, exact canonical platform and inbound
`user`/`customer` senders, ordered by `provider_event_at` descending with nulls last.
Provider time is authoritative on each row, including when expired, malformed or
future; it never falls back to that row's local timestamp. Only a temporary,
migration-marked legacy cohort may use `created_at` as described below. Missing
history, missing evidence on new rows, and lookup errors fail closed. The existing
WhatsApp helper's reminder policy mode enforces this rule; the manual dashboard's
legacy helper mode is unchanged. Outbound and other-tenant rows cannot open a window.
If provider evidence does not open the window, a separate latest-legacy lookup uses
the identical business/customer/channel/inbound filters, requires provider time to
be null and an unexpired migration marker, and orders by `created_at`. An old
provider row cannot hide a different eligible legacy inbound.
Eligibility is rechecked after credential hydration immediately before sending.

- WhatsApp inside the window: existing localized text path; HTTP success plus a
  nonempty `wamid.*`, with no error payload, is required.
- WhatsApp outside the window: `whatsapp_template_required`, with reason
  `whatsapp_template_missing`; no ordinary text request is sent. There is no
  supported template configuration contract, so even an arbitrary template-name
  field cannot enable sending. A valid approved template is not integrated by
  this change; it requires a separate tenant-scoped, language-specific integration.
- Messenger inside the ordinary window: fail closed with
  `unsupported_proactive_delivery_path` / `messenger_reminder_wire_type_unverified`.
  No wire value or exception is inferred from the semantic Updates category.
- Instagram inside the proven ordinary window: ordinary text, requiring HTTP
  success, no error payload, nonempty `message_id`, and matching `recipient_id`.
- Messenger/Instagram outside the window: `channel_policy_window_closed`, with
  reason `unsupported_proactive_delivery_path`; no provider call or flag update.
- Telegram: same Bot API payload and HTTP-result semantics, with no history read.

The caller receives delivery categories for acceptance, provider non-acceptance,
policy/template failures, history lookup failure, missing credentials, unsupported
channels, invalid recipient, and local delivery failure. Existing Calendar failure
categories remain intact. Success retains `category: "verified"` and adds
`deliveryCategory: "accepted"`.

Flags change only after policy eligibility and synchronous provider acceptance.
The update is scoped by appointment and business IDs and must return exactly one
row. Error, thrown error, or zero rows returns `flag_update_failed`, with
`sent: true`/`deliveryCategory: "accepted"` describing the provider acceptance
separately from flag persistence. A retry after flag persistence failure can still
duplicate an accepted send; durable deduplication is outside this fix.

Structured reminder logs include appointment ID, business ID, channel, reminder
type, acceptance, category, safe reason, and a categorical required action when
appropriate. They do not include customer names, message text, tokens, or raw
errors. Policy-blocked retries never claim that a reminder was sent.

## Tests and validation

The new policy integration test was added before production code changes and
failed on the old behavior: a closed-window WhatsApp reminder made a text request.
The initial patch passed 98 scenarios covering both reminders and all four channels, window
boundaries, scoped history, invalid/future timestamps, customer sender variants,
lookup errors, provider rejection/missing acknowledgment, credential fallback
prevention, unsupported channels, privacy, and flag-write failures. No template
payload tests apply because no template sender/configuration was added.

The revised focused test freezes Date at `2026-10-04T12:00:00.000Z` and separates
provider-documented ordinary windows, OdinLink's conservative equality expiration,
and the unverified Messenger wire behavior. It covers just inside (24h minus 1ms),
exact expiration, and just outside (24h plus 1ms) for all three Meta channels.
WhatsApp and Instagram can send just inside; Messenger still fails closed for its
unverified wire type. Persistence tests cover seconds/milliseconds, old provider
event plus recent database time, missing/malformed/future events, exact scoped
identities, cross-customer/platform/business isolation and concurrent tenants.

The Calendar test's database mock was extended for the business-scoped update and
returned-row check; its original cases and assertions remain.

| Validation | Result |
| --- | --- |
| Initial focused policy test | PASS, 98 scenarios |
| Six directly related existing reminder/WhatsApp/Instagram/outbound tests | PASS, 6/6 |
| Expanded related runtime/channel/Telegram/language suite | 29 passed, 2 failed out of 31; both failures also occur on HEAD |
| Broader runtime, channel, booking, AI provider and understanding suites, offline | 852 passed, 71 failed, 1 cancelled out of 924 |
| Same broader suite on untouched HEAD | 851 passed, 71 failed, 1 cancelled out of 923; identical failing/cancelled test names |
| Existing pre-P2 routing runner | FAIL; identical HEAD failure: expected awaiting_service, got awaiting_time_selection |
| Legacy Telegram capabilities test | 1 passed, 4 failed; identical HEAD failures |
| npm run lint | FAIL, exit 2; six existing parser errors in unchanged patch_key_rotation.ts, identical on HEAD |
| Additional typecheck excluding that unchanged parser blocker | Same 65 errors on HEAD and hotfix; no added diagnostics |
| npm run build | PASS; existing bundle-size warning |
| git diff --check | PASS |

Tests use isolated subprocesses, `NODE_ENV=test`, local test mode, and disabled
dotenv loading. The broad comparison additionally uses the existing offline-network
preload, a synthetic Gemini key, four test workers and a 30-second test timeout.
An initial broad run without the offline preload stalled in an unrelated existing
test and was stopped; the completed comparison above uses the controlled profile.

The expanded related failures are the existing Telegram earliest-range parity
test and the existing compliance-migration assertion. The broader cancelled test
is recorded in the full TAP logs. HEAD comparisons used an archive snapshot and
the same dependencies; the requested worktree was never switched or reset.

These results verify local behavior and payload acceptance checks. They do not
prove production delivery or provider-side permissions, templates, billing, or
account health. No real customer messages or production database writes were made.

The revision's validation results are recorded separately below; the broader and
lint results above describe the original patch, not additional reruns in this revision.

## Revision validation

| Revision validation | Result |
| --- | --- |
| Focused policy test | PASS, 162 scenarios with frozen Date |
| Focused reminder/Calendar/WhatsApp/Instagram/outbound suite | PASS, 7/7 test files |
| Additional channel, Telegram, idempotency and analytics checks | 15 passed, 3 failed out of 18 |
| Same additional checks on untouched HEAD | Identical 15 passed / 3 failed and failing test-file names |
| npm run build | PASS; existing large-bundle warning |
| git diff --check | PASS |

The three existing failing files are `src/ai/channel-reliability.test.ts` (legacy
source-pattern assertion), `src/ai/priority-1j-channel-parity.integration.test.ts`
(expected awaiting_service, got awaiting_time_selection), and
`src/ai/telegram-earliest-range-parity.integration.test.ts`. No new related-suite
failure was found. No unrelated lint/typecheck repairs or reruns are included.
These are results from the preceding provider-time revision. Its migration was
not applied to an existing database. Final transition validation is recorded below.

## Temporary rollout transition and schema prerequisite

Migration `20261004130125_add_chat_history_provider_event_time.sql` adds two nullable
columns: `provider_event_at` and `reminder_provider_time_cutover_at`. It changes no
RLS/grants, existing timestamps, booking state, Calendar verification or channel
selection. The production migration remains unapplied.

The migration runs in one transaction and explicitly locks chat history against
concurrent writes. After adding the marker column, it captures `clock_timestamp()`
once from the database as cutover C. It marks only already-existing canonical Meta
customer/user inbound rows with null provider time and `C - 24h < created_at < C`.
This limits writes to the cohort whose existing local window could still be open.
New inserts receive NULL, including delayed or backdated writes from the previous
server. The marker column's existence guards one-time initialization; replaying the
migration cannot mark new rows or reset/extend expiration. No environment variable,
process start time, or developer's local timestamp defines C.

For a migration-marked legacy row with null provider time, `created_at` may be used
only while `C <= now < C + 24h`, `created_at < C`, and its own ordinary age satisfies
`0 <= now - created_at < 24h`. Both expiration boundaries are conservative and
exclusive. A non-null provider timestamp always takes precedence on that row;
expired, malformed and future values cannot use the legacy exception. After C+24h,
only provider event time may authorize Meta reminder eligibility. Missing or invalid
markers fail closed. Credential hydration is followed by a fresh time check.

Migration timestamps have PostgreSQL precision; application comparisons use
milliseconds and can expire a fraction of a millisecond earlier, never intentionally
later than the marker's 24-hour deadline. This transition is an OdinLink rollout
compatibility rule, not proof of a reconstructed provider event timestamp.

Legacy analytics events can be correlated to conversation identity, but historical
`occurred_at` could be fallback local time from `normalizeAcceptedMessageTimestamp`.
Neither deterministic identity correlation nor P2 shadow data proves the provider
window. No historical provider-time backfill is performed from either source.

Apply the migration immediately before the updated server in a separately reviewed
rollout. Grace starts at database cutover, not deployment or restart; any gap consumes
it. Post-cutover writes from the old server without provider time remain ineligible,
as required. The migration must precede server use because history persistence and
reminder reads require the new columns. No deployment or production writes have
been performed in this task.

The appointment's booking channel remains the reminder channel. A blocked WhatsApp,
Messenger or Instagram reminder is never rerouted to Telegram or any other channel.
Messenger remains fail-closed for its unverified wire type even when window
eligibility passes through the temporary transition.

## Provider setup and follow-up

Outside-window WhatsApp delivery needs an approved Utility reminder template in
each required appointment language, customer opt-in, tenant-owned account/phone
identity, and a safe configuration/parameter-mapping integration. Approving a
template alone will not activate a sender that does not yet exist.

Outside-window Messenger delivery can use the officially documented Utility
template mechanism after a separate integration for approved Page templates,
language/parameter mappings and `page_utility_messaging`. It must not reuse the
retired event tag or HUMAN_AGENT. Instagram has no configured automated
outside-window reminder path in OdinLink.

WhatsApp asynchronous reconciliation requires persisted provider-message-ID to
appointment/reminder association and tenant-scoped processing of delivery-status
webhooks. No existing small connection could be reused, so this remains follow-up.
This revision retains provider inbound event time separately from local persistence time.
Messenger reminder sending remains disabled until an authoritative current wire
contract is verified or a separately approved Utility-template integration is built.

## Final transition validation

| Final transition validation | Result |
| --- | --- |
| Focused policy test | PASS, 236 scenarios with frozen Date |
| Focused reminder/Calendar/WhatsApp/Instagram/outbound + migration suite | PASS, 8/8; no skips |
| Disposable local PostgreSQL migration test | PASS: recent legacy cohort only, NULL new/backdated defaults, common cutover, provider values preserved, replay does not reset or extend |
| Additional channel/Telegram/idempotency/analytics checks | 15 passed, 3 pre-existing failures out of 18; same failure names as previously compared untouched HEAD |
| npm run build | PASS; existing large-bundle warning |
| git diff --check | PASS |

No existing local or production database was changed. The migration test creates,
uses and removes its own isolated PostgreSQL cluster; the production migration
remains unapplied. No unrelated lint/typecheck fixes or reruns were performed.

New deterministic policy cases cover provider precedence, marked legacy eligibility for both reminder types,
just-before/equal/after expiration, new and delayed rows, missing/invalid/future
markers, identity/sender/tenant isolation, and same-channel delivery. The migration
integration test uses a disposable private local PostgreSQL cluster with no TCP
listener; it verifies the actual SQL, cohort selection, no provider-time backfill,
new/backdated insert defaults and migration replay without resetting the cutover.
It skips with a stated reason on hosts without local PostgreSQL binaries.

## Final reminder identity compatibility

Reminder history queries now use a deduplicated exact allowlist: the canonical
provider recipient and the same business/channel/customer session ID generated by
`getScopedChannelSessionId`. Both provider-time and bounded legacy-cutover queries
use `in(user_id, candidates)` together with unchanged exact business/platform and
user/customer sender filters.

| Channel | Exact identities accepted |
| --- | --- |
| WhatsApp | canonical recipient R; `wa_<encoded-current-business-scope>:R` |
| Messenger | canonical recipient R; `ms_<encoded-current-business-scope>:R` |
| Instagram | canonical recipient R; `ig_<encoded-current-business-scope>:R` |

Returned rows are checked again for exact business, platform, inbound sender and
raw identity membership before being copied with canonical user_id in memory for
the existing window helper. No scoped-ID parsing, arbitrary prefix removal, numeric
overlap inference, fuzzy matching, cross-business compatibility or use of the
unrelated `getKnownWhatsAppScopedIdentityRemainder` helper is introduced. Historical
rows are not rewritten. Newly persisted rows retain canonical IDs and provider time.
Provider precedence, strict expiration, the 24-hour maximum legacy transition and
same-channel reminder sending remain unchanged. No migration/schema change is
needed in this revision, and no migration is applied.

Identity tests freeze Date and cover canonical/scoped historical rows for both
reminder types, provider-time precedence, exact provider/transition expiration,
wrong tenants/scopes/channels/senders, malformed scoped identities, mixed canonical
and scoped history ordering, unchanged canonical persistence, and same-channel
provider payload recipients. Tests also inject unfiltered storage responses to
verify exact tuple validation before helper normalization.

| Final identity validation | Result |
| --- | --- |
| Focused policy integration test | PASS, 419 scenarios with frozen Date |
| Focused reminder/Calendar/WhatsApp/Instagram/outbound suite | PASS, 7/7; no skips |
| npm run build | PASS; existing bundle-size warning |
| git diff --check | PASS |

The unchanged SQL migration test is not rerun in this revision because no migration
application is authorized. No schema/persistence-format edits, migration application,
commit, push or deployment were performed in this revision.
