# Minimal P2 Knowledge foundation — review candidate

**GO for later migration approval review; not production application or activation.**

Production evidence supplied/confirmed before this task: project `blknxpoeaqrvvdhixrau`, PostgreSQL 17.6, has no `odin_conversations`, `odin_inbox`, `odin_tasks` or `odin_outbox`. Its deployed shadow evaluations and Booking outbox are separate and remain untouched. No production/staging connection is made by the new test harness.

## Creation and compatibility

1. Confirm `public.businesses(id bigint PRIMARY KEY/UNIQUE)`, PostgreSQL 17, backend roles and absence of all four P2 relations. The foundation fails rather than merging an unknown partial schema. The deployment operator must recheck schema state immediately before any separately approved application.
2. Apply `20261019084642_minimal_p2_knowledge_foundation.sql.draft` only after separate approval. Within its transaction it creates conversations, inbox, tasks, then outbox, with repository-compatible fields. All four tables have UUID primary keys and bigint tenant FKs. The default denies client access even when hosted default privileges would initially grant it.
3. Apply the corrected `../async-knowledge-slice1/20261019081511_async_knowledge_lifecycle_slice1.sql.draft` afterward, under its own separate approval gate. The second draft adds Knowledge identity, watermark, attempts, expiry, lease/fence and atomic publication/delivery transitions. Both SQL files remain outside `supabase/migrations`; no migration discovery or runner is enabled.

No additional base table, operation/reservation engine, queue, scheduler or network function is installed. No existing Booking RPC or outbox is replaced or renamed. The foundation preserves P2 contract fields (`revision`, `lease_owner`, `fence_epoch`, etc.) as reserved compatibility fields; it does **not** install old P2 conversation lease/finalization RPCs or enable `P2ProcessingCoordinator`. Authoritative Knowledge processing uses only the extension's dedicated watermark and task/delivery fences. `operation_id` in the base outbox is an opaque nullable compatibility field with no executor or missing-table FK.

## Constraints, indexes and permissions

- Conversation identity: unique `(business_id, conversation_key)`. The future trusted adapter must generate the existing canonical tenant/channel/account-scoped P2 key; raw customer-supplied keys are not accepted authority.
- Event identity: unique `(business_id, channel, provider_scope, provider_event_id)` before and after the extension. Duplicate delivery does not increment the Knowledge watermark or create another task.
- Conversation-scoped composite FKs prevent cross-tenant base inbox/task/outbox links. Extension composite FKs additionally bind task-to-inbox and outbox-to-task to the same tenant **and conversation**.
- Task and inbox composite unique indexes support those FKs. Outbox has one additional conversation FK-support index; no extra duplicate inbox/task prefix index is installed. Existing Slice 1 indexes provide task/turn/notification uniqueness and expiry/recovery lookup.
- Four supported channel values, version-one contracts, JSON object payload/artifact checks and nonnegative base revisions/attempts. Knowledge-specific bounds/terminal states remain in the extension.
- RLS enabled on all four tables. No client policies. All PUBLIC/anon/authenticated table grants revoked; only service_role gets data access, apart from database owner/admin. The extension's RPCs are SECURITY INVOKER, service-executable only, with fixed search paths; no new SECURITY DEFINER privilege boundary is introduced.
- Service role is trusted and bypasses RLS as in Supabase; it is not isolated per tenant. Correct scoped RPC calls, composite constraints and the future trusted authentication/authorization bridge are required. This is backend-only storage, never a customer-facing Data API.

## Real PostgreSQL validation

Run `python3 tests/p2/knowledge-foundation-postgres.py`. It creates a unique local initdb cluster using installed PostgreSQL tools, enables fsync by default, disables TCP listeners and uses an owner-only private Unix socket. It does not consume a database URL, load project environment files, contact Supabase or reuse any running database. PostgreSQL is stopped and its temporary cluster removed during cleanup. The explicit restart test restarts only that owned cluster.

Validated on local PostgreSQL **17.11 (Homebrew)**, against a clean synthetic `businesses(id bigint PRIMARY KEY)` baseline, the repository's real Booking reservation/outbox migration and its real local functions. No production/customer data is copied.

**22 SQL tests pass**: both migrations apply; anon/authenticated SELECT/INSERT/UPDATE/DELETE and RPC execution fail; hosted-style default client grants are removed; no client policies exist; concurrent duplicate acceptance, competing task claims, finalization and send claims produce a single winner; lease transfer increases fences and rejects stale workers; finalization/outbox commit atomically; injected failure after tentative outbox creation rolls back both; progress and final have independent keys; supersession/wrong scopes cannot publish; ambiguous/expired delivery cannot be reclaimed; definitively unsent retries remain bounded; acceptance-relative 30/35/40-second expiry survives later handoff; real expiry and PostgreSQL restart preserve limits/counters/checkpoints; cross-tenant and cross-conversation references fail; malformed verification flags/digest binding fail; UTF-8 digest framing agrees with the contract; partial non-lifecycle rows cannot be claimed; unapproved and mid-failure DDL roll back. Booking schema/function/grant/index/row fingerprints remain unchanged, and its original local delivery claim/settlement path still works inside a rolled-back transaction.

Initial real SQL execution exposed the Slice 1 draft's PostgreSQL-incompatible regex `{1,256}` (PostgreSQL bounds repetition counts to 255). Replaced it with an explicit 1–256 length check plus an unbounded allowed-character regex, retaining the intended contract. Added the composite scope FKs, notification shape constraint and complete-identity claim predicate noted above. Existing TypeScript source/test files were not changed.

## Risks and rollback

- These are transactional, fail-closed, non-idempotent DDL drafts. Running twice or on a partial/unknown P2 schema aborts instead of silently using incompatible objects. Use approved migration history to ensure once-only application; do not add `IF NOT EXISTS` to suppress incompatible schemas.
- New empty tables/indexes have no customer-row backfill. Creation of tenant FKs takes metadata locks on `businesses`; the extension takes ALTER TABLE locks on the new P2 tables. Apply foundation then extension while they are unused, with lock timeout 5s and statement timeout 30s. A timeout/error rolls back that migration. Foundation may remain safely empty/inactive if the independently applied extension fails.
- Supabase production is 17.6, while local tests use 17.11. This validates real PostgreSQL 17 semantics, not identical hosted patch version, Supabase gateway/JWT behavior, deployment tooling or production workload/lock contention.
- Authorization receipts are synthetic service-only test attestations. The real Evidence-first verifier/current source, tenant and channel eligibility bridge is still mandatory; stored verification flags cannot substitute for it. No paid inference, remote provider or real channel delivery was tested.
- The real DB restart test is a clean restart. Transaction-failure injection establishes rollback; this is not an operating-system power-loss test.
- No application feature flag is changed or newly required to keep these drafts inactive: both are outside migration discovery and no application caller/runner is introduced. Custom SQL approval GUCs are accidental-application guards, **not** security authorization or a runtime activation switch. A future runner must have separately reviewed disabled-by-default admission controls before activation.
- Before first use, reversing an approved foundation would require a separately reviewed dependent-object drop in reverse order: extension, outbox, tasks, inbox, conversations. Do not execute such a rollback on populated tables. After use, stop admission, drain/cancel safely and preserve unresolved-send records; never replay Booking or blindly resend uncertain entries.

## Smallest next action

Review and separately approve the **foundation + corrected extension** migration bundle, after a fresh scoped production metadata preflight. This task authorizes neither application nor activation. Slice 2 next needs a real repository adapter and authorization bridge tested against this local schema before any native traffic hook. Current production Knowledge deadline, Booking consent/mutations, Release 1 telemetry and partial Release 2 behavior remain unchanged.
