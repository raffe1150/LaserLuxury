# WhatsApp provisioning persistence and production rollout review

Prepared locally; no production migration, configuration, data, deployment or
provider write was performed. The existing preflight, template orchestrator and
approval tracker feed the new atomic publication boundary. No changes to booking,
other channels, ordinary conversations or inside-window reminders are required.

## Migration review

### 20261004130125_add_chat_history_provider_event_time.sql

Exact changes: nullable `chat_history.provider_event_at timestamptz` and nullable
`reminder_provider_time_cutover_at timestamptz`, both without defaults. Comments
explain authoritative provider time and the one-time compatibility cutoff.
An explicit transaction acquires ACCESS EXCLUSIVE on `public.chat_history` before
DDL. The lock remains through a database-clock snapshot UPDATE and commit. This
blocks reads as well as writes; queued lock acquisition can also disrupt traffic.

Only existing legacy inbound rows are updated: platforms whatsapp/messenger/instagram,
senders user/customer, provider_event_at NULL, and created_at strictly within the
24 hours preceding the captured cutover. Their marker is set to the same timestamp.
There is NO fabricated provider-event backfill from created_at. Inserts after the
cutover retain NULL even if backdated. The new marker column itself prevents replay
from extending the transition or marking later rows. The UPDATE creates WAL/dead
row versions; the eligible recent-row filter may still scan the whole table if the
production access path is unsuitable. Nullable column additions need no table rewrite.

**Change recommended before production:** add bounded LOCAL lock_timeout and
statement_timeout after BEGIN (for example 5 seconds and an operator-approved
statement budget), inspect current table/index sizes, explain the UPDATE's equivalent
SELECT and count eligible rows read-only, and rehearse against representative staging
data. Schedule a controlled low-traffic cutover with abort/retry on lock timeout.
Do not remove the lock or split the cutover into asynchronous batches: that changes
the proven snapshot semantics. This file was reviewed, not changed or applied here.

Rollback: any pre-commit error rolls back both DDL and marker updates. After commit,
prefer rolling back application code while retaining additive columns/evidence.
Dropping them loses provider-time/cutover evidence and takes another exclusive lock;
re-running after a drop can create a new compatibility window. Do not use drop/replay
as a casual rollback. This migration remains the largest operational rollout risk.

### 20261004201036_add_whatsapp_reminder_template_config.sql

Exact changes: nullable `businesses.whatsapp_reminder_templates jsonb`, no default,
plus its configuration comment. No backfill, row UPDATE, template approval or
activation. ADD COLUMN requires ACCESS EXCLUSIVE on businesses but is a short
metadata operation with no table rewrite. Lock waiting remains possible. Use bounded
lock/statement timeouts and one controlled transaction in the migration executor;
the prepared file itself has no explicit BEGIN/COMMIT and was not edited here.

Rollback: keeping the column is safest. Removing it takes an exclusive lock and
loses any stored mappings; the schema gate then disables automation. Null still
means no outside-window template configuration. Back up each prior tenant mapping
before enabling publication because subsequent rollout can replace it.

### 20261006160042_whatsapp_template_provisioning_state.sql

Exact changes: private `channel_provisioning` schema; `leases` (resource key, UUID
owner/fence, expiry), `snapshots` (target key, tenant FK, provider/asset, target/state
JSONB, due time, updated time), and `creation_intents` (intent key, resource, JSONB,
updated time). Two snapshot indexes support due/asset lookup. All three tables use
RLS, public/anon/authenticated privileges are revoked, service_role gets access.
`public.channel_provisioning_store(text,jsonb)` is SECURITY INVOKER with empty search
path and service-role-only execution; it manages durable queue, fenced leases,
snapshots and crash-safe intents. Snapshot saves now reject superseded authorization
revisions even if the authorizer ID is unchanged. The prepared migration now has an
explicit transaction, LOCAL 5-second lock timeout and 30-second statement timeout.

No existing tenant rows are updated/backfilled, no secrets imported, no mappings
written. Creating the snapshot FK acquires SHARE ROW EXCLUSIVE on referenced
businesses (blocks competing writes, permits ordinary reads) until commit. Other
DDL/index/RLS locks affect only newly created private tables. Runtime RPCs use row
locks on fenced leases and intent/snapshot rows; they do not lock whole business
or chat tables. New tables/indexes are empty during rollout.

Rollback: before commit all schema changes roll back. After use, preserve private
state and disable the flag; dropping state loses uncertain/reserved creation intents
and could permit duplicate provider submissions on a later restart. Provider assets
cannot be rolled back by a database rollback. Destructive cleanup is not supplied.

### 20261006164644_whatsapp_reminder_mapping_publication.sql (new)

Creates private RLS-enabled `reminder_publications`: one tenant FK/PK, snapshot target
key, selected WABA/phone, opaque authorization revision, SHA-256 mapping fingerprint,
positive monotonic version, reconciled_at and published_at. Adds service-role-only
SECURITY INVOKER `public.whatsapp_reminder_mapping_boundary(text,jsonb)` with empty
search path. Operations: read-only gate, binding revision, current mapping health;
and one atomic publish transaction. No new businesses columns, no backfill, no data
activation. New-table FK takes SHARE ROW EXCLUSIVE on businesses. DDL is wrapped in
one transaction with 5-second lock / 30-second statement timeouts.

Runtime publish locks the selected tenant's connection → business → snapshot →
publication rows, with a 5-second lock timeout. It rereads authoritative connection
identity/revision and exact durable evidence before writing. All 12 JSONB mappings,
receipt and snapshot publication flag commit together; any exception rolls all back.
No full-table ACCESS EXCLUSIVE lock is used during runtime publication. Exact retry
skips updates; changed approved bundles replace only the selected business column.
Only tenant authorization hashes/fingerprints are stored, never plaintext credentials.

Rollback: disable automated writes and retain schema/state. Already-published mappings
remain active under existing runtime verification when the flag is disabled; stopping
reminder activation also requires separately authorized tenant config restoration.
Dropping this RPC/table disables automation through the fail-closed schema gate but
does not undo published mappings or remote templates. Restore a backed-up tenant
mapping only through an explicit operational rollback; this change executes none.

PostgreSQL lock semantics were checked against official documentation:
[ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html),
[foreign-key creation locks](https://www.postgresql.org/docs/current/sql-createtable.html),
[explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html).
The publisher uses [Supabase database RPC](https://supabase.com/docs/reference/javascript/rpc).

## Required production rollout order (not executed)

1. Review/approve the chat-history timeout/lock plan and rehearse all four migrations,
   service-role privileges, atomic publication and rollback with representative staging
   data. Verify the encryption key/app configuration and actual signed template events.
2. Keep WHATSAPP_TEMPLATE_PROVISIONING_ENABLED absent/false. Capture tenant mapping
   backups. Apply 20261004130125 during its controlled cutover; then 20261004201036;
   then revised 20261006160042; then 20261006164644. Required earlier channel-connection
   schema/permissions must already exist. Do not blindly run unrelated pending migrations.
3. Refresh/confirm Supabase schema cache and verify gate protocol 1/support, RLS,
   service-role RPC execution, mapping column and durable tables read-only. Deploy
   this code with automation still off; smoke-check existing conversation/booking paths.
4. Verify Meta app permissions, subscribed template event fields/callback, current
   WABA/phone membership and effective MANAGE assignment. Obtain fresh customer
   authorization through Connect WhatsApp to create a current versioned tenant job.
   Rehearse template creation/approval and mapping publication in staging first.
5. Only after those checks, explicitly authorize enabling the production flag in a
   controlled rollout. The current flag is global, so verify the intended tenant cohort
   and fresh connections before enablement. Reauthorize the pilot tenant after enablement
   to queue provisioning; old unversioned snapshots deliberately fail closed.
6. Observe selected-WABA creation/reconciliation, all six approvals, exactly 12
   mappings, fingerprint/version and independent delivery readiness. Billing, business
   verification and other Meta restrictions require owner remediation. Do not infer
   fully-ready from published mappings or account_mode=LIVE. Expand only after these
   checks; monitor signed events, overdue reconciliation and publication health.

Business 3: based on the prior audit only, its live WABA/phone and management access
support this path after fresh tenant authorization/preflight and schema rollout.
The six test-WABA assets are irrelevant. Live-WABA assets can be provisioned and
published while billing blocks sending. Payment/verification/phone/subscription health
must satisfy delivery readiness before calling it fully ready. No new production
readiness claim or live probe is made by this implementation.

## Files changed for this persistence boundary

- `src/channels/whatsapp/reminder-mapping-publisher.ts` (new publisher/gate)
- `src/channels/whatsapp/reminder-mapping-publisher.test.ts` (new admission/gate tests)
- `src/channels/whatsapp/reminder-mapping-publisher.integration.test.ts` (new isolated SQL/concurrency/runtime tests)
- `src/channels/whatsapp/reminder-mapping-publisher.test-fixture.ts` (new synthetic evidence fixture)
- `src/channels/whatsapp/provisioning-runtime.ts` (queue/worker/status gate and publication wiring)
- `src/channels/whatsapp/template-provisioning.ts` (stronger complete-bundle contract, persisted state/receipt types; obsolete placeholder publisher removed)
- `src/channels/whatsapp/template-provisioning.test.ts` (obsolete placeholder-publisher test replaced by the new boundary suite)
- `src/channels/whatsapp/approval-tracking.ts` (authorization revision continuity)
- `src/channels/whatsapp/appointment-template-contract.ts` (existing runtime mapping validation shared without behavior changes)
- `src/runtime/whatsapp-reminder-template.ts` (uses the same extracted mapping validator)
- `src/channels/provisioning/orchestration.ts` (optional generic authorization revision)
- `src/channels/connections/provisioning-readiness.ts` (authorization context revision)
- `supabase/migrations/20261006160042_whatsapp_template_provisioning_state.sql` (supersession/transaction safeguards)
- `supabase/migrations/20261006164644_whatsapp_reminder_mapping_publication.sql` (new prepared publication migration)
- `docs/whatsapp-automated-template-provisioning.md` (lifecycle/publisher update)
- `docs/whatsapp-provisioning-rollout.md` (this review and rollout order)

Existing local edits from the preceding preflight/provisioning implementation are
retained; server.ts, connection completion/router code and production settings were
not additionally changed for this boundary.
