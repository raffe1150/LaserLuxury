# Businesses and salons backend-only rollout preparation

Checkpoint: `hotfix/reminder-delivery-safety`, `374c8428402a886a8ed5abb896829073aa44ba53`. Date: 2026-10-05.

**Verdict: NOT READY for production rollout yet.** The ownership/schema design blockers are resolved or avoidable for backend-only access, and the authorized code/migration preparation is complete. The remaining gates are releasing the reviewed server hardening, validating the proposed SQL and real deployed flows in staging, and explicitly deciding compatibility for unverified historical direct Data API consumers. Neither table's RLS nor any production grant changed. Nothing was committed, pushed, deployed, dropped, assigned, converted or applied.

## 1. GET /api/salons analysis

The registered GET remains behind verified `createRequireAuth`. It does not need a single requested business ID: it lists salon rows for **all of this verified user's active memberships**. It queries `business_memberships` by server-verified Auth UID and active status, then selects salons by those business IDs. Query/body tenant IDs and user IDs cannot override that scope. The role constraint on memberships limits persisted roles to the recognized authorized roles; all recognized roles have business.read permission.

Only `id,salon_name,business_id,status` is selected. UUID remains the salon resource identity for compatibility, not a tenant identity. There are no provider credentials in this projection. No active membership returns `[]` without querying salons; valid members with no matching salon also receive `[]`. Multiple legitimately managed businesses return all matching rows, without limit(1) or choosing a single tenant.

The handler now lives in [salons-api.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/business/salons-api.ts:16), with the same protected registration in [server.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30766). Membership IDs are validated with the existing positive-safe-integer parser and converted to canonical text for the text salon column. Malformed membership scope fails closed. Authorization query errors now have the structured `salon_authorization_failed` log category; list query errors retain `salon_list_failed`, without raw error/token/body logging.

No core dashboard caller uses this endpoint. It is retained as an authenticated legacy API contract. The unmapped `chi` row is never substituted for or assigned to a numeric member business.

## 2. POST /api/salons analysis and exact fix

POST retains verified Auth and `requireBodyBusinessPermission('settings.manage')`. That middleware parses `businessId ?? business_id` as a positive safe integer and requires an active membership for the verified UID and that exact numeric business. Owner/admin/manager retain settings.manage access; viewer/agent do not.

Before the change, the INSERT used the raw `req.body.businessId`. Thus an authorized owner of business 2 could write `"02"` or `" 002 "` as a distinct text key even though authorization checked numeric 2. The table's text UNIQUE constraint does not consider those spellings equal to `"2"`, and canonical membership reads do not find them. This is a canonical scope/persistence weakness; the audit did **not** reproduce a preexisting cross-business authorization bypass. Nonnumeric `chi`/injection/object IDs already fail in middleware. A conflicting secondary business_id was ignored by the old handler, not used to write the other tenant.

After the change, [createSalonCreateHandler](/Users/raffe/Documents/OdinLink/.production-hotfix/src/business/salons-api.ts:55):

- Requires the explicit middleware-authorized `businessAccess.businessId` and verified Auth context.
- Rejects any supplied businessId/business_id alias that parses differently from the authorized ID. Equivalent aliases remain accepted.
- Persists **only `String(authorizedBusinessId)`**. Extra request `id`, user_id, tokens or tenant fields are not persisted.
- Supports the existing successful businessId forms and additionally the middleware-supported business_id alias. Keeps name/status handling, default active status, UUID creation, successful response shape and safe projection.
- Preserves unique-conflict visibility as an error; never upserts, overwrites, broadens a lookup, or silently changes another row.
- Logs only the existing structured failure category and canonical authorized business ID.

The handlers were extracted to make their actual behavior testable with Express and the installed Supabase client. Only their registrations/projection moved in server.ts; no reminder or unrelated business/channel/booking behavior changed. The existing auth source assertion was updated to follow the extracted projection and verify both middleware registrations.

## 3. Prepared salon grant migration

[20261005111021_restrict_salons_to_backend_access.sql](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20261005111021_restrict_salons_to_backend_access.sql:1) was created with the installed CLI's migration-new command and is **unapplied**:

- Transactional, bounded lock/statement timeouts.
- Revoke ALL salon table privileges from PUBLIC, anon and authenticated, including surplus privileges outside normal CRUD.
- Keep explicit service_role SELECT/INSERT/UPDATE/DELETE; remove its unnecessary TRUNCATE/REFERENCES/TRIGGER-style table privileges.
- Refuse an unexpected service role without BYPASSRLS, client role inheritance, or column-level grants rather than silently leaving an alternate privilege path.
- No RLS enablement, FK, type conversion, owner assignment, UPDATE/DELETE/TRUNCATE, archive, or DROP. The UUID and legacy text key/row remain unchanged.

The protected GET/POST use server service-role clients and therefore do not require direct authenticated table privileges. No verified existing authenticated direct SELECT client was found in the frontend or repository. Browser Supabase use is Auth/session management; dashboard data uses authenticated application APIs. The previous audit's six anon Data API reads and one insert are historical evidence, without caller identity/timestamps sufficient to prove current usage. That is a compatibility gate for the approved grant rollout, not evidence that broad client access is architecturally necessary. No broad authenticated SELECT grant is proposed as a workaround.

## 4. Current businesses readiness and effective backend access

Read-only production revalidation found:

| Check | Result |
| --- | --- |
| Current businesses | 2 |
| Business 2 active owners / authorized members with existing Auth user | 1 / 1 |
| Business 3 active owners / authorized members with existing Auth user | 1 / 1 |
| All orphan memberships / active orphan memberships | 0 / 0 |
| Memberships referencing missing Auth users | 0 |
| Target table RLS | businesses=false, salons=false |
| Membership RLS | true; own-active SELECT policy unchanged |
| Target/member column ACL overrides / anon-auth role inheritance | None observed |
| Service role | BYPASSRLS; CRUD on all three tables, business identity sequence USAGE |
| Service role read-only role probe | 2 businesses, 1 salon, 2 memberships visible |
| Lifecycle RPC execution | Service allowed; anon/authenticated denied; invoker security |
| Business identity | bigint GENERATED BY DEFAULT identity, sequence public.businesses_id_seq |

The two owner memberships currently belong to the same Auth UID. A read-only authenticated policy probe sees one active membership for each business because that user legitimately owns both; this is not a cross-tenant policy leak. Tests use distinct synthetic A/B users to validate isolation. No UID/token/private config was printed in this audit.

Shared server and authorization clients select only SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY through the already-hardened credential helper, reject missing/public/malformed service credentials and disable session persistence/refresh. Analytics/loaders/reconciliation/backfill clients likewise require the service variable with no anon fallback. The separate SUPABASE_ANON_KEY client verifies human tokens through Auth.getUser only; browser VITE public keys manage Auth. Neither needs unrestricted businesses table privileges. The helper's JWT decoding classifies configuration type; Supabase authenticates the actual credential.

No required repository tenant-data path uses anonymous business access. This includes provider routing, callbacks, startup pollers, business APIs, operational workers and cron, which use the shared server client or explicit service clients. A helper named publicBusinesses selects the public **schema**, not an anon credential. No shared-client user-session setter was found. Core dashboard uses businesses through application APIs and safe response projections, not direct table SELECT.

Read-only Render inspection still identifies live commit `e634610c865d2baf654870f403adab754ce9deeb`, older than this checkpoint. The last-seven-day filtered startup view contains 50 displayed SERVICE_ROLE initialization occurrences and no ANON initialization occurrence. That supports the effective deployed credential path, but **does not mean the committed startup/Telegram hardening or this salon fix has been released**. Deploying the reviewed code and verifying actual outgoing privileged access is a prerequisite in the future authorized rollout.

## 5. Prepared businesses backend-only RLS migration

[20261005111029_prepare_businesses_backend_only_rls.sql](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20261005111029_prepare_businesses_backend_only_rls.sql:1) is **unapplied**. Its proposed model is:

- Revoke ALL businesses table and business identity sequence privileges from PUBLIC, anon, authenticated.
- Retain service_role CRUD and sequence USAGE, with no unnecessary sequence UPDATE/table maintenance privileges.
- Enable businesses RLS with **no client policies**. Application requests go through verified membership-checked APIs; BYPASSRLS service role remains the backend actor.
- No USING(true), user_metadata ownership claims, request business-ID DB authorization policy, provider-column grants or destructive data changes.
- Abort if the validated membership-business FK is absent, business active-membership coverage is incomplete, orphans exist, target policies/column ACLs/client inheritance have appeared, sequence identity changed, or service role lost BYPASSRLS.
- Transactional with bounded lock/statement timeouts. No salons RLS change.

This design needs no salon-to-business mapping: direct clients lose salon access, protected routes stay numeric-membership-scoped, and the unresolved legacy row remains backend-only data. No mapping migration or conversion of chi is needed for this boundary.

## 6. Membership migration revalidation

The existing [20261005095355_harden_business_membership_integrity.sql](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20261005095355_harden_business_membership_integrity.sql:1) is unchanged and unapplied. Current production supports its intended FK validation: both sides are bigint, zero orphan memberships, and no business FK already exists. User/created_by Auth FKs, role/status constraints and unique business/user constraint are already present. Existing business-leading indexes cover referencing-key lookups, so no extra index is necessary.

Revoke ALL client/default privileges and restore authenticated SELECT preserves the existing own-active membership policy and legitimate membership reads, while removing surplus TRUNCATE/REFERENCES/TRIGGER privileges. Service CRUD remains sufficient for authorization and lifecycle RPCs. ON DELETE CASCADE matches business-owned membership lifecycle; the existing delete RPC already deletes memberships before the parent, and create RPC inserts parent before membership. The FK does not itself require owner coverage; the rollout guard separately checks coverage.

**Data checks support validation; this is not an executed FK/lock/cascade test.** Production-shaped staging must verify actual validation, atomic business creation/deletion, cascade behavior and grants before approval. No migration was run locally or in production in this task.

## 7. Tests and results

Added [salons-api.test.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/business/salons-api.test.ts:1): **27 passing tests**, real Express Auth/permission middleware and installed Supabase/PostgREST client with intercepted deterministic HTTP. Covers anonymous/invalid sessions, both tenant directions, malicious query scope, multiple legitimate memberships, no membership/row, inactive memberships, safe columns, numeric/canonical/leading-zero/trimmed IDs, conflicting aliases, arbitrary/unsafe/injected keys, settings roles, default/custom status, uniqueness failure without overwrite, service headers/no anon fallback, unavailable DB, safe categorized errors.

Added [backend-access-security.test.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/business/backend-access-security.test.ts:1): **6 passing tests**. TypeScript AST extracts the actual existing server business-list and update registrations into a local Express harness without starting pollers/cron. These are not reimplemented handlers. Real Auth/membership middleware and intercepted SDK requests prove scoped reads, credential-free projections, both-direction mutation denial before business access, authorized update despite spoofed body tenant aliases, anonymous denial, inactive/insufficient membership denial, and service-role headers. Cache invalidation is isolated; no provider credential update/startup is exercised.

Updated [auth.test.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/auth.test.ts:239) for salon projection location and explicit auth/settings middleware registration. Existing membership, credential-selection, Telegram isolation, dashboard summary/access, connections, dashboard shell/save/i18n tests ran as well.

| Validation | Result |
| --- | --- |
| Smallest salon/auth set first | 28/28 passed |
| New salon/business tests plus auth | 34/34 passed; 33 new cases |
| Final focused 13-file set | 98 entries: 96 passed, 2 unrelated baseline failures |
| Final salon rerun after test assertion cleanup | 27/27 passed |
| Initial untouched checkpoint set | 65 entries: 63 passed, same 2 failures |
| Isolated git-archive 374c842 failure reproduction | 9 entries: 7 passed, same 2 failures |
| Prepared SQL scope/transaction checks | Passed; no migration execution or SQL runtime privilege proof claimed |
| npm run build | Passed; existing frontend chunk warning; frontend asset hashes unchanged |
| git diff --check | Passed; untracked files checked separately |

Final focused command: `NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test` over auth/auth, auth/backend-supabase, business/salons-api, business/backend-access-security, dashboard/api-router, dashboard/summary, channels/telegram-setup, channels/connections/connections, channels/connections/meta-compliance, components/dashboard/DashboardShell, components/dashboard/tone-save, i18n/dashboard, and business/business-tone-update (all .test.ts/.tsx).

Baseline failures reproduced from an isolated unchanged 374c842 archive with the same installed dependencies:

1. business-tone-update.test.ts:82 calls browser Auth under plain Node; supabase-browser.ts:7 fails because import.meta.env is undefined.
2. meta-compliance.test.ts:209 expects the old static webhook-secret guard text, which the checkpoint no longer contains. No webhook/reminder/booking correction was made.

## 8. Remaining gates and controlled rollout order

1. Review/release the committed backend/Telegram hardening and this salon change through a separately authorized deployment. Recheck startup rejects missing/public service credentials and actually sends privileged authorization without a user-session override.
2. Resolve historical direct-client compatibility: no authenticated table reader is verified/required, but external consumers cannot be excluded from repository evidence. An operator must accept denial of unsupported direct clients or migrate any legitimate client to the protected API. This does not require guessing chi ownership.
3. In a disposable production-shaped staging environment, separately authorize applying the prepared migrations. Validate FK creation/validation, authenticated own-active membership SELECT, denied foreign/suspended membership reads, lifecycle RPCs/identity sequence and business deletion/cascade without guessed data.
4. Verify salon anon/authenticated table operations fail, service CRUD and protected API GET/POST succeed, and the legacy row/UUID/key remain unchanged. Test canonicalized new inserts and both tenant directions.
5. Apply businesses proposal in staging only after membership FK validation. Verify anon/authenticated SELECT cannot expose any provider credential; cross-tenant updates fail; service CRUD/RPC and membership-checked dashboard/onboarding/connections/webhooks/workers remain functional.
6. Require all staging checks, effective deployment identity, fresh coverage/orphan/ACL/policy checks, explicit production approval, bounded transactions and monitoring before production. Proposed order: membership hardening → salon grants → businesses RLS/grants. Salons RLS is a separate later approved decision and is not prepared here.
7. Record pre-change schema/grants/policies, deployment version and backup. A failed migration transaction must roll back completely. Restore compatible service grants/code if a backend regression appears; do not restore unrestricted client/provider access as the routine rollback. Escalate an unexpected dependency and pause rollout instead of deleting data or broadening client policies.

No unresolved ownership primitive or salon mapping is needed for the proposed backend-only boundary. The explicit NOT READY verdict reflects the **unreleased code, unexecuted staging SQL/flow validation and direct-client compatibility decision**, not an invented new schema requirement. Prepared files are reviewable; production remains unchanged.
