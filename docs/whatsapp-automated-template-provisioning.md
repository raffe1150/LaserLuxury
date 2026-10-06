# WhatsApp automated template provisioning

## One-click flow and rollout boundary

Customer authorizes Meta → existing tenant/browser-bound token exchange → read-only
preflight → gated existing phone registration/app subscription → persist authorized
connection → queue template setup → worker preflight → canonical template inventory
→ create missing languages → selected-WABA reconciliation → approval
tracking → generate mappings → atomic publication → refresh independent readiness.

`WHATSAPP_TEMPLATE_PROVISIONING_ENABLED=true` wires this lifecycle into both embedded
and manual completion, the signed WhatsApp webhook, and a one-minute polling worker.
It is **off by default**. Every automated queue/worker/publisher entry additionally checks
the read-only schema capability RPC. Missing storage/permissions fail closed before
Meta creation or mapping writes. No production configuration is changed by this revision.
When enabled, failed template provisioning does not discard the authorized channel:
completion returns the safe lifecycle state beside the connection. Managers can
read it through `GET /api/channel-connections/:businessId/whatsapp/provisioning`.
Customers keep the existing Connect WhatsApp flow; they never configure Meta IDs,
template languages, or hooks. Other channel completion paths are unchanged.
The browser request performs no template creation. A non-secret job is queued
after credential storage, and the worker resumes it independently of that request.
Queueing is atomic per tenant and does not wait for an asset creation lease.
Superseded authorization cannot overwrite a newer queued snapshot. Workers verify
the current tenant connection again before each create and before generating mappings.

## Canonical assets and conflicts

The source of truth is `appointment-reminder-templates.ts`: exact supplied text for
en/sv/de/es/fa/ar, `appointment_reminder`, UTILITY, POSITIONAL, BODY only. Samples
are synthetic facts indexed by parameter number, not text occurrence order:
customer_name, service, date, time, business_name. German's textual occurrence
order does not change the positional array.

Automatic reuse requires canonical BODY wording as well as the shared runtime
contract. A different five-placeholder body might mean different facts or a fixed
reminder interval; it is a conflict, not a safe inferred mapping. Only APPROVED
and compatible PENDING/IN_APPEAL variants are reused. Rejected, paused/disabled,
wrong category/components/format/body, unknown status, and duplicates are blocked.
Existing assets are never edited, deleted, renamed, or borrowed from another WABA.
Other missing languages may proceed around a language conflict; the mapping bundle
remains blocked until all six are usable. Conflict remediation requires a separately
authorized owner/operator decision; this revision has no destructive resolution.

Only new provider write: `POST /{selected-waba-id}/message_templates`. No send,
template edit/delete, or app webhook configuration endpoint is used. Existing gated
registration/subscription remain in their original completion boundary.

## Approval, reconciliation and independent readiness

Every creation call is followed by a selected-WABA `message_templates` edge read.
Creation response IDs/statuses are tracking hints, never proof of ownership or
approval. A conflicting returned ID blocks mapping generation. Unknown/incomplete
inventories remain unverified. Permissions/membership are rechecked before each
creation. Billing does not prevent an otherwise authorized template creation.

Each language stores ID, name, language, status, category, parameter format,
component/canonical compatibility, lifecycle state/code, safe provider error code,
last_checked_at, last_provider_event_at, and quality where reported. Tokens,
provider error descriptions, customer samples and raw event payloads are excluded.

Existing raw-body signature verification guards webhook handling. Recognized fields:
`message_template_status_update`, `template_category_update`,
`message_template_quality_update`, and `message_template_components_update`.
Events match both WABA and tracked template ID (and language when provided), ignore
older timestamps, invalidate candidates, and schedule authoritative reconciliation.
They never directly mark approval or create templates. Busy/storage failures return
503 for Meta retry. The worker also rereads pending/blocked targets every minute
and approved targets every 15 minutes, bounded to 25 targets per run. Repeated
events cannot create duplicate assets. Unknown WABAs/assets do not create jobs.
Expired status snapshots are displayed as unverified rather than ready.

Pending → APPROVED/compatible generates exactly 12 deterministic candidate mappings
for 24h and 2h. The canonical bodies use absolute date/time, so the same assets
serve both intervals. Partial approval, rejection, category drift, or revocation
clears the candidate bundle. `mapping_ready`/`reminder_ready` remain separate from
phone, billing, business verification, app subscription and `delivery_ready`.

`mapping_ready` means a complete verified candidate exists. `mappings_persisted`
means the locked publisher installed that exact bundle. `ready` also requires
current authorization, connection and delivery readiness. Publication is allowed
while billing/verification blocks delivery; it never upgrades delivery health.
Incomplete business verification or LIMITED sending health conservatively keeps
automated delivery readiness false, without changing existing send-time behavior.

The worker invokes `reminder-mapping-publisher.ts` after authoritative reconciliation.
It validates all six approved canonical assets against the shared runtime mapping
contract and submits one service-role-only RPC. That transaction locks the tenant's
current WhatsApp connection, business row, then provisioning snapshot; compares
WABA, phone, app, authorizer and authorization revision; verifies exact snapshot
content and at most 180-second-old evidence; and replaces all 12 mappings or none.
Provider events newer than template checks, duplicate IDs/languages, pending assets,
incorrect fields, wrong tenant/asset, invalid parameters and partial bundles block
publication. A failed later receipt/snapshot update rolls back the business update.
The provider API itself cannot participate in this database transaction: current
Meta approval and ownership are still verified by the runtime before sending.

The authorization revision is a SHA-256 digest of the encrypted credential envelope
and connection authorization fields (including connected_at/scopes/app/authorizer).
The database returns only the opaque digest; no credential/token leaves that RPC.
Queueing captures this revision, and workers verify it before each provider write.
Credential rotation/reconnection, including unchanged WABA/phone/user IDs, supersedes
old jobs. Existing unversioned jobs require fresh authorization/queueing.

SHA-256 over PostgreSQL's canonical JSONB bundle plus a monotonic publication version
is stored in private `reminder_publications` and the snapshot receipt. Identical
retries perform no business, receipt or snapshot update. Fresh reconciliation may
refresh receipt evidence without rewriting unchanged mappings. Changed verified
bundles atomically replace only that tenant's configuration and increment version.
Health status compares the current business column, receipt, authorization revision
and live snapshot. Webhook invalidation or stale evidence makes that status unready;
previously stored mappings are retained, and runtime Meta validation blocks revoked
assets. No destructive cleanup is performed.

## Idempotency and durable storage

Generic `channels/provisioning` handles leases and durable creation intents without
Meta rules. A WABA-wide lease serializes workers even across phones/tenants; fenced
writes reject stale owners. Each WABA/name/language has a durable intent committed
before POST. A crash after reservation, transport timeout, malformed success, or
5xx is uncertain: subsequent calls only reconcile; they never blindly POST again.
This favors safe interruption over guessing whether Meta accepted a request.
Unresolved intents require explicit operator review and proof that no asset exists
before a future audited reset; no reset endpoint is implemented here.

A definitive rate-limit rejection may reclaim its intent after cooldown and a
fresh complete inventory. Permission/other definitive failures remain blocked;
review/reauthorization and a separately audited retry decision are required.
There is no assumed Meta idempotency header, no process-local production fallback,
and no repeated mapping write for an unchanged verified bundle.

Prepared migration `20261006160042_whatsapp_template_provisioning_state.sql` creates
private RLS-enabled snapshots, leases and intents plus a service-role-only invoker
RPC. It stores no secrets and does not update `businesses`. Apply it only after
review together with the mapping-column migration and the new
`20261006164644_whatsapp_reminder_mapping_publication.sql`. All schema support,
service-role privileges and selected-tenant preflight must pass before automated
writes. Existing connections can enter this lifecycle through fresh authorization;
legacy secrets are not imported. See [the migration review and rollout order](whatsapp-provisioning-rollout.md).
No migration is applied to production here. Tests use mocks and an isolated temporary
PostgreSQL cluster reached through a private Unix socket with TCP disabled.

## Stable codes

Template codes: `template_already_ready`, `template_created_pending`,
`template_approval_pending`, `template_rejected`, `template_paused_disabled`,
`template_incompatible_existing`, `template_duplicate_conflict`,
`template_creation_failed`, `template_creation_permission_denied`,
`template_creation_rate_limited`, `template_meta_error`,
`template_creation_unconfirmed`, `template_reconciliation_unverified`,
`template_creation_id_mismatch`, `template_missing_for_selected_waba`,
`template_provider_event_reconciliation_required`.

Orchestration codes: `provisioning_preflight_blocked`, `provisioning_busy`,
`provisioning_storage_unavailable`, `provisioning_lease_lost`,
`provisioning_connection_changed`, `provisioning_queued`.
Publication/gate codes: `reminder_mappings_published`, `reminder_mappings_already_current`,
`reminder_mapping_bundle_invalid`, `provisioning_rollout_disabled`, `provisioning_schema_missing`. Existing preflight health reasons remain visible.
Template lifecycle states: missing, pending, approved_compatible, rejected,
paused_disabled, conflict, unverified, creation_failed. Durable intent states:
reserved, submitted, uncertain, retryable, failed.

## Meta-required actions and Business 3

Owners must consent to Meta authorization/asset access and complete any required
phone verification/PIN, business verification, payment setup, or policy remediation.
OdinLink cannot grant itself access, force template approval/category, bypass billing
or account restrictions, or resolve owner template conflicts destructively. Template
creation is a request for review, not guaranteed approval even with validated text.
The developer app needs verified production onboarding permissions/access and
template-management webhook subscriptions; this revision does not alter them.

Based on prior evidence, Business 3's live WABA/phone, scopes and MANAGE assignment
support attempting canonical provisioning after fresh preflight. Its six test-WABA
assets remain irrelevant. It can create/track live-WABA assets even while billing
blocks delivery; approval, payment remediation, rollout and mapping installation
are all needed for reminder delivery. No fresh production audit is performed here.

References: [Meta's official creation example](https://www.postman.com/meta/whatsapp-business-platform/request/ep5w4rc/create-template-w-document-header-text-body-a-phone-number-button-and-a-url-button),
[template status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update),
[category webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update),
[Supabase RPC](https://supabase.com/docs/reference/javascript/rpc).
Meta webhook documentation was rate-limited during this implementation; fixtures
use conservative event hints and authoritative reads. Verify subscriptions and
real signed event delivery during the controlled rollout.
