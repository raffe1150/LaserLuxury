# Businesses and salons: production-safety audit

Date: 2026-10-05. Source checkpoint: `hotfix/reminder-delivery-safety`, `2fdcf7c493be46068438ea4003593c7062d1c1e2`.

**Decision: do not enable RLS yet.** The membership primitive exists, so a backend-only access boundary can be designed. Production ownership coverage, salon ownership mapping, and deployed backend credentials are not sufficiently verified for rollout. No production policy, grant, migration, application code, reminder behavior, or booking behavior was changed. Only this report and a disposable local database experiment were added.

## 1. Evidence and current RLS status

Read-only Supabase metadata and aggregate queries verified the repository-associated active project. No credentials, row contents, customer messages, user identifiers, or business identities were retrieved for this report. Production role probes ran inside `BEGIN READ ONLY` / `ROLLBACK`, returning counts only. No production write probes were run.

| Table | RLS / forced RLS | Policies | Effective anon / authenticated privileges |
| --- | --- | --- | --- |
| `public.businesses` | Disabled / disabled | None | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER |
| `public.salons` | Disabled / disabled | None | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER |

The live `service_role` has `BYPASSRLS`, is not a superuser, and has CRUD privileges on both tables. Both tables are owned by `postgres`.

A read-only service-role probe sees both businesses and the salon. Neither target table has explicit column ACLs. `public.businesses_id_seq` exists; anon, authenticated, and service_role currently have sequence USAGE. The proposed rollout must revoke public/client sequence privileges while preserving the service-role privileges required by the create RPC.

Observed production counts:

| Check | Result |
| --- | --- |
| Businesses | 2 |
| Active membership coverage gaps | 1 business has no active member and no active owner |
| Membership rows / orphan memberships | 1 / 0 |
| Salons | 1 |
| Salons without an exact `businesses.id::text = salons.business_id` match | 1 |
| Rows visible under `anon` | All 2 businesses and the 1 salon |
| Rows visible under `authenticated` with a synthetic UID and zero visible active memberships | All 2 businesses and the 1 salon |

These are database-role proofs, not HTTP probes of the deployed Data API configuration. If these public tables are exposed through the Data API, the database permits unscoped access with public client credentials. Updates/deletes are authorized at the database layer, subject to ordinary constraints/triggers; they were not attempted in production.

## 2. Credential contexts shared by the access paths

[server.ts:427](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:427) creates the shared server client using `SUPABASE_SERVICE_ROLE_KEY`, **falling back to `SUPABASE_ANON_KEY`**. Sessions and refresh are disabled. `requireAuth` verifies a user's token separately; it does not install that user's session on this shared client. Selecting `.schema('public')` in the Telegram resolver changes the schema, not the client's credential role.

All shared-server paths below should use privileged backend credentials. They do not need RLS disabled when service-role access is configured correctly. **Every shared-server path conditionally relies on disabled RLS when the anonymous fallback is used.** The deployed effective role has not been verified; local environment configuration is not evidence of production configuration.

[getAuthorizationClient](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/supabase-auth.ts:27) and the [analytics client](/Users/raffe/Documents/OdinLink/.production-hotfix/src/analytics/queries/business-loader.ts:28) require a service-role key and have no anonymous fallback. RPCs below are security invoker and executable only by service_role. No broad security-definer bypass is needed.

## 3. Every current businesses query path

`S` below means the shared server client with the conditional anonymous-fallback risk described above. `P` means service-role required. Every path in this table should remain backend-only; provider/global scans are intentionally privileged routing operations, never dashboard-visible scans.

| File/function or route | Exact operation/query | Actor and context | Required tenant binding | Client |
| --- | --- | --- | --- | --- |
| [server.ts:328](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:328), `findBusinessByChannelConnection` | SELECT `*`, `.eq('id', connection.business_id).maybeSingle()` | Signed WhatsApp/Meta webhook processing and provider routing | Business comes from the resolved authoritative provider connection | S |
| [server.ts:14987](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:14987), `loadFreshBusinessConfigByTelegramToken` | SELECT `*` by exact normalized `telegram_bot_token`; SELECT `id,business_name,telegram_bot_token` where token not null for normalized matching; SELECT `*` by matched `id` | Telegram startup/poller, inbound processing; setup/settings/create follow-up | Exact token ownership with ambiguous normalized matches rejected; global fallback scan stays backend-only. Human-triggered setup needs an additional binding check, below | S |
| [server.ts:15671](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:15671), `startAllBusinessTelegramPollers` | SELECT `*` where `telegram_bot_token` not null | Server startup/background polling | All configured businesses intentionally scanned by backend; each poller resolved by its token | S |
| [server.ts:25515](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:25515), `loadBusinessConfigById` | SELECT `*`, exact `id`, `.maybeSingle()` | Result-outbox worker at 25546; reminder processing at 26576; authenticated manual conversation send at 31626 | Worker-owned business ID or caller-authorized conversation business; lookup failure currently falls back to `activeConfig` | S |
| [server.ts:27427](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:27427), `processWhatsAppUpdateClaimed` legacy fallback | SELECT `*`, exact `whatsapp_phone_number_id`, `.maybeSingle()` | Provider webhook | Exact recipient phone identity, after authoritative connection resolution | S |
| [server.ts:28259](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:28259), `findMessengerBusinessByPageId` | SELECT `*` globally, then JS match legacy page aliases; reject non-unique matches | Signed Meta webhook/provider routing | Exact page identity; inactive authoritative connections must not fall back | S |
| [server.ts:28386](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:28386), `findMetaCommentBusiness` | SELECT `*` globally, then match Facebook/Instagram owner identity; reject non-unique matches | Signed Meta comment callback | Exact provider owner identity | S |
| [server.ts:29426](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:29426), `processInstagramUpdateClaimed` legacy fallback | SELECT `*`, exact `instagram_account_id`, `.maybeSingle()` | Signed Meta webhook | Exact Instagram recipient identity, after connection resolution | S |
| [server.ts:30838](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30838), GET `/api/businesses` | SELECT `DASHBOARD_BUSINESS_COLUMNS`, `.in('id', activeMembershipBusinessIds)`, order `id` | Authenticated dashboard/list | Membership IDs queried using verified user UID and active status; safe response columns | S |
| [server.ts:32215](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:32215), `loadHealthBusiness` / `loadHydratedHealthBusiness` | SELECT `*`, exact `id`, `.maybeSingle()` | Integration-health reads/refresh, notification projection, dashboard operational sources | Caller has `business.read` or the mounted dashboard's `analytics.read`; one authorized business | S |
| [server.ts:32517](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:32517), POST integration test | SELECT `*`, exact `id` at 32563 | Authenticated operator integration test | `requireAuth` + `settings.manage` for route business | S |
| [server.ts:32885](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:32885), GET cancellation settings | SELECT explicit cancellation fields, exact `id` | Authenticated settings | `requireAuth` + `settings.manage` | S |
| [server.ts:32916](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:32916), GET admin notification settings | SELECT `id,admin_notification_channel,admin_whatsapp_number,admin_telegram_chat_id`, exact `id` | Authenticated settings | `requireAuth` + `settings.manage` | S |
| [server.ts:32945](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:32945), PUT `/api/businesses/:id` | UPDATE allowlisted payload, exact `id`; SELECT `DASHBOARD_BUSINESS_COLUMNS`, `.maybeSingle()` at 33322 | Authenticated dashboard/settings; legacy manual connection configuration | `settings.manage` permits owner/admin/manager; legacy channel credential writes further restricted to owner/admin | S |
| [server.ts:33411](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:33411), POST `/api/businesses`; [migration:65](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20260801120000_create_business_memberships.sql:65), `create_business_with_owner` | Backend RPC INSERT businesses and active owner membership atomically; safe JSON response | Authenticated onboarding/new business creation | Owner UID taken from verified auth, never request-supplied owner/role; existing business updates rejected | P |
| [server.ts:33388](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:33388), DELETE `/api/businesses/:id`; [migration:147](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20260801120000_create_business_memberships.sql:147), `delete_business_with_memberships` | Backend RPC SELECT business FOR UPDATE, DELETE memberships, DELETE exact business | Authenticated owner administration | `business.delete` is owner-only; authorized business ID passed to service-only RPC | P |
| [business-loader.ts:66](/Users/raffe/Documents/OdinLink/.production-hotfix/src/analytics/queries/business-loader.ts:66), `loadBusinessAnalyticsContext` | SELECT `id,timezone,services`, exact validated business ID, `.maybeSingle()` | Backend analytics/dashboard | Mounted APIs require `analytics.read`; positive safe-integer business ID | P |

No other runtime business query sites were found in repository source/scripts. Other SQL references are schema additions or foreign keys from tenant tables, not extra application readers/writers. Business deletion can cascade to dependent tenant tables. The salon table has no business foreign key and can remain orphaned after deletion.

### Legacy setup binding gap

[POST `/api/setup-telegram`](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30679) requires authentication and `settings.manage` for the body business ID. It then resolves the **request-supplied token** globally and starts the resolved poller without checking that the resolved business equals the authorized business. This is not an anonymous table query, but the downstream business lookup is not bound to the human caller's membership. Service-role RLS bypass will not repair this. Record a separate, narrowly reviewed tenant-binding prerequisite; no reminder/channel behavior was changed in this audit.

## 4. Every current salons query path

| File/route | Exact operation/query | Actor | Tenant binding | Backend-only / reliance |
| --- | --- | --- | --- | --- | --- |
| [server.ts:30767](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30767), GET `/api/salons` | SELECT `id,salon_name,business_id,status`, `.in('business_id', activeMembershipBusinessIds)` at 30786 | Authenticated dashboard/legacy API client | Verified UID's active memberships; no body-controlled tenant list | Yes; shared client S |
| [server.ts:30802](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30802), POST `/api/salons` | INSERT `salon_name,business_id,status`, SELECT safe salon columns at 30818 | Authenticated operator | `requireAuth` + body business `settings.manage`; inserted key remains raw request input after numeric authorization | Yes; shared client S |

No salon UPDATE, DELETE, RPC, worker, or direct frontend database path was found. The POST guard parses numeric IDs after trimming/accepting leading zeroes, while INSERT uses raw `req.body.businessId`. A string such as `"03"` can therefore be authorized as business 3 yet stored as a distinct text key. This is a canonicalization/integrity gap; it must not be resolved by broadening membership queries or permissive casts.

## 5. Ownership and authentication source of truth

The durable source is **`public.business_memberships`**, not customer/session identifiers, arbitrary business input, email matching, or user-editable metadata. Live schema and [membership migration](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20260801120000_create_business_memberships.sql:1) agree:

- `business_id bigint`, `user_id uuid` referencing `auth.users(id)` with cascade deletion; optional `created_by` also references auth.users.
- Unique `(business_id,user_id)`; positive business ID; roles `owner/admin/manager/agent/viewer`; statuses `active/invited/suspended/revoked`.
- RLS SELECT for authenticated users only when `auth.uid() = user_id AND status = 'active'`; direct membership writes revoked.
- There is intentionally **no foreign key from membership.business_id to businesses.id**. No ownership UID exists on businesses or salons. Production has zero orphan memberships today, but this relationship is not structurally enforced.
- Production grants leave TRUNCATE/REFERENCES/TRIGGER available to anon/authenticated on memberships. RLS does not govern TRUNCATE; ordinary PostgREST CRUD does not expose a truncate endpoint. Harden these grants before treating memberships as a complete database-level boundary.

[requireAuth](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/require-auth.ts:1) verifies Bearer tokens through Supabase `auth.getUser(token)`. [require-business-access](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/require-business-access.ts:1) loads the exact active `(business_id, verified UID)` membership and validates role permission, denying missing membership and failing closed on lookup errors. [permissions](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/permissions.ts:1) grants business read to all valid active roles; settings write to owner/admin/manager; deletion only to owner. Agent/viewer cannot manage settings. New business creation atomically records the verified UID as owner. No client-provided claim authorizes an arbitrary business.

**The primitive exists, but coverage is incomplete:** one production business has no active owner/member, and the existing salon cannot be bound to a business through the current exact key. There is no safe inferred ownership for those rows.

## 6. Frontend, callbacks, and existing RLS patterns

[supabase-browser.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/supabase-browser.ts:1) uses only a publishable/anonymous browser key for Supabase Auth. The active frontend does not `.from('businesses')` or `.from('salons')`; [services/api.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/services/api.ts:1) attaches the authenticated Bearer token to backend business/settings APIs. `AppLegacy.tsx` has bare backend fetches and is not mounted by the current App; it does not establish a need for anonymous database policies. ConfigPanel salon examples are local state. The Netlify Telegram function uses environment configuration and no Supabase table access.

[channel connection router](/Users/raffe/Documents/OdinLink/.production-hotfix/src/channels/connections/api-router.ts:1) and [calendar connection router](/Users/raffe/Documents/OdinLink/.production-hotfix/src/integrations/calendar-connections/api-router.ts:1) do not query either target table directly. Initiation/list/disconnect require authenticated settings access. Provider callbacks use consumed, hashed, cookie-bound authorization state and recheck the session user's active membership and owner/admin/manager role. Channel webhook routing later loads businesses through the helpers above. Meta POST webhooks verify provider signatures; subscription handshakes do not require anonymous table reads.

Live patterns:

| Table | Live pattern | Reuse assessment |
| --- | --- | --- |
| `channel_connections`, `calendar_connections` | RLS enabled; no policies; anon/auth CRUD revoked; service CRUD allowed | Appropriate backend-only credential-table precedent |
| `knowledge_sources` | RLS enabled; authenticated SELECT requires active membership for the exact business; authenticated writes denied; anon denied | Useful for non-secret data; cannot copy whole-row access onto credential-bearing businesses |
| `appointments`, `analytics_events` | RLS enabled; no policies; anon/auth CRUD grants remain | Default deny through RLS, service bypass; explicit grant hardening is preferable |
| `chat_history` | RLS enabled; `allow_all` FOR ALL TO PUBLIC, USING true / WITH CHECK true; anon/auth CRUD granted | Unsafe cross-tenant precedent. Out of this task's implementation scope; do not copy |
| `business_memberships` | Own active membership SELECT only, writes denied; surplus non-CRUD grants remain | Correct identity primitive after grant hardening and coverage verification |

No public views depending on either target table were found. Live functions referencing them are the two service-only business create/delete RPCs above.

## 7. Exposure and breakage assessment

`businesses` contains legacy `telegram_bot_token`, Instagram access/verification tokens, WhatsApp access/verification tokens, and Messenger page access tokens, alongside prompts, services, hours, provider IDs, calendar IDs, and operator notification contacts. Unscoped table SELECT exposes these columns across tenants if the Data API exposes the tables. The safe dashboard projection does not protect direct database access. Writes allow cross-tenant configuration/credential replacement and deletion subject to constraints. No evidence of exploitation or credential values was collected.

`salons` exposes names, status, business linkage, and UUIDs across tenants; unrestricted writes allow tampering/deletion. There are no credential columns on salons, but business linkage is tenant data.

Enabling RLS without policies is default deny for anon/authenticated. Correctly configured service-role access continues to work. The server's anonymous fallback would lose scans/row reads and writes, potentially breaking startup polling, provider resolution, dashboard settings, salons, and background config lookup. Some reads may silently return no rows rather than a visible error; the config helper's existing fallback makes this a material rollout risk. Create/delete and analytics clients require service role independently. A blanket enable cannot be certified safe from repository evidence alone.

The real `salons.business_id text` versus `businesses.id bigint` mismatch forbids a direct FK and makes naive `salons.business_id::bigint` policy casts unsafe: nonnumeric/overflow strings error and noncanonical variants can become unintended aliases. The sole existing salon fails exact matching; its intended meaning is unknown. Do not assume it is a numeric tenant ID or invent a match.

## 8. Minimum conditional access design

For **both tables**, use the same backend-only model once prerequisites pass:

1. Enable RLS with **no anon/authenticated table policies**. Revoke ALL table privileges from PUBLIC, anon, authenticated, including existing column grants if present. Revoke public/client privileges on the business ID sequence. Confirm schema/API grants separately. Explicitly preserve necessary service-role CRUD and required sequence privileges for business creation.
2. Keep authenticated business/salon access through the current verified-UID, active-membership backend API. Only authorized owner/admin/manager roles may write allowlisted settings; owner alone deletes; new owners come from verified auth. API response projections never include credential fields. The service role's global reach makes API tenant checks mandatory.
3. Keep the create/delete RPCs security invoker and executable only by service_role. Do not grant them to authenticated users merely because their parameters contain user/business IDs.
4. Retain privileged backend provider scans and worker loads. Never add an anonymous routing policy, `USING (true)`, or a business-ID-parameter policy to support them.

This permits rightful users through protected backend operations while denying even a rightful owner direct credential-bearing table access. It follows the existing application's architecture and requires no new ownership table.

If direct authenticated database reads become a separately approved requirement, design a safe projection with column privileges excluding every secret and membership-based SELECT using `(select auth.uid())`, exact business equality, and active status. For canonical confirmed salon keys, compare `membership.business_id::text = salons.business_id`, never cast untrusted text to bigint. Keep writes backend-only unless field privileges and role-specific USING/WITH CHECK are independently validated. **This optional variant is not the selected rollout and cannot be completed for current unmapped salons.**

## 9. Prerequisites and missing integrity foundations

- Verify effective service-role authorization on every deployed server/worker client and both RPC callers; do not rely on the permissive anonymous fallback. No frontend bundle may contain privileged credentials.
- Resolve the uncovered business's ownership from trusted administrative evidence. Do not infer ownership from names, messages, provider tokens, or matching email alone. Require explicit attestation if no authoritative record exists. No data backfill is proposed with invented identities.
- Resolve the salon's intended relationship from authoritative evidence. If `business_id` is confirmed to mean numeric tenant ID, normalize new writes from the already-authorized ID in a separately reviewed change and plan a verified mapping for existing text. If it is an external legacy identifier, the smallest additive foundation is a nullable `tenant_business_id bigint` FK to businesses; populate only verified mappings, switch authorized APIs, then consider NOT NULL/uniqueness after checking actual branch cardinality. Do not rewrite/drop the legacy text column or automatically cast all data.
- Revoke surplus membership privileges; retain authenticated own-active SELECT and service-only membership administration. Adding a membership.business_id FK with staged NOT VALID/VALIDATE is a small optional hardening after checking deletion behavior and orphan counts; it does not establish missing ownership by itself.
- Review the legacy Telegram setup resolution-to-authorized-business binding separately. Do not claim table RLS fixes a service-role route authorization gap.

No executable production migration was generated. The proposed backend-only RLS boundary does not require changing business/salon column types. Additional ownership binding work remains conditional on facts not available in the schema.

## 10. Staged rollout and exact go/no-go checks

1. **Prerequisites:** resolve/attest missing ownership and salon mapping; verify active owners and zero orphan/mismatched canonical bindings; verify surplus grants removed in the plan, service role present/effective everywhere, create/delete RPC ACLs remain service-only, and legacy setup binding resolved. Inspect public API exposure and identify external clients beyond the repository. Save exact prior grants/policies/RLS flags for rollback. No rollout while these checks are unresolved.
2. **Non-production policy test:** use a disposable production-shaped schema, constraints, sequences, trigger/RPC definitions, and synthetic fixtures. Apply the reviewed grant/RLS proposal there. Verify actual PostgREST behavior, not only SQL role simulation.
3. **Backend service check:** confirm non-superuser service role can perform required exact-ID and global provider reads, both RPCs, permitted CRUD, default/sequence-backed creation, and safe response projections. Verify its outgoing authorization is not replaced by a user JWT.
4. **Dashboard auth matrix:** users A/B with owner/admin/manager/agent/viewer plus suspended/revoked/no-membership users. A cannot list/read/update/delete B; body/path spoofing cannot authorize B; invalid IDs fail closed; rightful roles can read/update only permitted fields; viewer/agent writes and admin deletion fail; credential keys are absent from all responses. Creation creates one authenticated owner atomically; deletion cleans intended memberships/dependents; repeated calls remain safe.
5. **Salon matrix:** verified mapping gives A only A's salon; B is denied; unmapped and noncanonical keys do not alias another business; insert uses the authorized canonical ID or reviewed FK; duplicate behavior honors existing unique business_id semantics. Do not grant salon access just because the client supplies a key.
6. **Onboarding/connections:** channel/calendar initiation, list, callback, refresh and disconnect pass for authorized business only; stale/replayed/wrong-cookie/wrong-user/wrong-business callback fails. Legacy Telegram setup cannot start a different authorized user's business. Confirm encrypted credential stores remain backend-only. No secret values enter logs/responses.
7. **Workers:** startup Telegram scan, signed WhatsApp/Messenger/Instagram routing, cron config load, result outbox and notification/health reads pass using synthetic fixtures. Compare resulting reminder behavior with unchanged checkpoint; changing reminder behavior is not part of rollout. Verify no anonymous fallback and no new missing-row/fallback routing.
8. **Enablement:** after explicit approval for a separately reviewed migration, enable RLS and tighten grants together for both target tables. No such approval or migration execution occurred in this audit.
9. **Production validation:** read-only role counts/permissions show anon and unrelated authenticated users denied; rightful dashboard list/settings reads succeed with no secrets; service-backed health/worker reads succeed; monitor authorization failures, empty scopes, webhook routing, and worker errors. Any write smoke check requires a separately authorized synthetic business, never an existing tenant's data.
10. **Rollback:** fix credential configuration/client role first if that is the cause. If rollback is necessary, restore only the saved target-table policy/grant/RLS metadata under explicit production authorization. Restoring disabled RLS/full public grants restores the critical exposure, so it is not a safe default. Do not grant USING true, delete ownership data, or undo unrelated tenant security. Avoid DDL changes unless separately reviewed; preserve all business/salon data.

## 11. Validation actually performed

| Validation | Result / limit |
| --- | --- |
| Production anon and nonmember authenticated reads | **Isolation fails today:** count-only probes see all current businesses/salons |
| Production updates | Not attempted; effective grants + disabled RLS demonstrate authorization risk, not an executed write |
| Existing auth/channel/Meta/calendar-runtime/test-bridge tests | 26 Node test entries: 25 passed, 1 existing failure |
| Existing dashboard API/summary tests | 2 Node test entries: 2 passed |
| Disposable PostgreSQL 17.11 model | 29 assertions passed: default-deny RLS, both directions of tenant read denial, cross-tenant updates denied, credentials denied, non-CRUD grants denied, non-superuser service-role CRUD preserved |
| Rightful owner API access and field restrictions | Existing auth tests verify middleware permissions and static API/RPC safety; source audit verifies allowlists. No full post-enable HTTP/API field matrix was executed |
| Channel onboarding / dashboard / calendar | Relevant existing tests passed except baseline Meta source-pattern test. Full deployed post-enable flow remains a rollout gate |
| Build | `npm run build` passed on untouched source checkpoint; existing large frontend chunk warning |
| Whitespace | `git diff --check` passed; new files additionally checked through no-index diffs |

Added [local SQL experiment](/Users/raffe/Documents/OdinLink/.production-hotfix/tests/security/businesses-salons-rls-model.sql:1), **not a migration**. It refuses a nonempty target-table database or any database not named `odinlink_rls_audit`; execution was on a fresh Unix-socket-only local cluster with synthetic data, rolled back and stopped afterward. It models the proposed boundary with reduced fixture tables, not production RPCs, Supabase API, membership completeness, or end-to-end dashboard behavior.

To replay, initialize a fresh local PostgreSQL cluster with no TCP listener, create empty database `odinlink_rls_audit`, then use `psql -X -v ON_ERROR_STOP=1 -h <private-local-socket> -d odinlink_rls_audit -f tests/security/businesses-salons-rls-model.sql`. Never point it at a managed/live project. The test transaction rolls back its fixture DDL/data; stop the disposable server afterward.

Existing test commands used `NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test` with:

- `src/auth/auth.test.ts`
- `src/channels/connections/connections.test.ts`
- `src/channels/connections/meta-compliance.test.ts`
- `src/ai/google-calendar-oauth-runtime.integration.test.ts`
- `src/runtime/test-bridge-security.integration.test.ts`
- Separately: `src/dashboard/api-router.test.ts`, `src/dashboard/summary.test.ts`

The unrelated failing entry is `compliance migration is backend-only with durable idempotent intake` at `src/channels/connections/meta-compliance.test.ts:209`: a static regex expects `if (!secret) return res.sendStatus(503)` in server.ts. Its suite was rerun separately **before any tracked/untracked audit changes**, on clean exact `2fdcf7c`: 7 passed / 1 failed, same assertion. It is a checkpoint failure, not a new runtime regression; no out-of-scope code/test correction was made.

## 12. Change boundary

Changed files: this audit report and the standalone local SQL experiment. No application source or migration files changed. Final diff/stat/status are included in the accompanying completion report; neither file was staged or committed. No push, merge, deployment, or production migration occurred.
