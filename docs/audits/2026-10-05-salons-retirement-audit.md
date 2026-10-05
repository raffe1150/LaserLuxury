# Salons dependency and retirement audit

Date: 2026-10-05. Checkpoint: `hotfix/reminder-delivery-safety`, `f473c84b58f32fc472b7884302658e2de4493d80`.

**Verdict: STILL REQUIRED for the currently exposed legacy API contract.** No identified core dashboard, onboarding, channel, booking, analytics, notification, or worker feature needs this table. However, the production server still registers two handlers that query it. Removing the table today would break those handlers. External consumer retirement has not been established, and database statistics show historical anonymous Data API use. This is a dependency verdict, not a recommendation to retain the duplicate directory permanently.

This task changed only this report. Production inspection was read-only. No row, access control, schema, reminder, or application behavior changed; no migration, RLS enablement, deployment, commit, push, or merge occurred.

## 1. Complete repository reference inventory

Before adding this report, a case-insensitive repository scan for `salons`, `salon_id`, `salonid`, `salon_name`, and `salonname` found eight files. A supplementary singular `salon` scan found three additional documentation/label files. Source, SQL, scripts, hidden non-secret files, and tracked deployment/configuration paths were included. Dependency caches, Git internals, build output, lockfile, and secret environment files were excluded from the broad scan. The generated frontend/backend bundles were inspected separately. Locally available JSON/config files were inspected through names and dependency/identity flags without printing secret values; this checkout has no `agent-config.json` or backup to inspect.

| File / function or reference group | Operation / dependent data | Current production reachability and live need | Does businesses replace the purpose? |
| --- | --- | --- | --- |
| [server.ts:258](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:258), `DASHBOARD_SALON_COLUMNS` | Projection: `id,salon_name,business_id,status`; includes the salon UUID | Used by both live API handlers below | Business projection is separate; changing this response to businesses would change the contract |
| [server.ts:30762](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30762), anonymous handler registered by `startServer`, GET `/api/salons` | SELECT active `business_memberships` for the verified user, then SELECT salons with `.in('business_id', businessIds)` | Registered unconditionally during normal server startup; requires authentication. Required if this legacy endpoint is called; no repository frontend caller found | Current dashboard obtains the business directory from `/api/businesses`; no salon query is needed there |
| [server.ts:30797](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:30797), POST `/api/salons` handler | INSERT `salon_name`, raw text `business_id`, `status`; SELECT the safe projection for its response | Registered during startup; `requireAuth` and body `settings.manage` authorization. Required if a legacy caller creates a salon. No repository caller found | Current business creation uses `/api/businesses` and the atomic owner-membership RPC, not salon INSERT |
| [src/AppLegacy.tsx:45](/Users/raffe/Documents/OdinLink/.production-hotfix/src/AppLegacy.tsx:45), `fetchSalons`, `Salon` type, state and display | GET `/api/businesses`; maps `item.id.toString()` to both view `id` and `businessId`, and business name to view name | Not imported by the current frontend entry graph; not a salon table read even if mounted | Yes; the misleading salon name already denotes business data |
| [src/AppLegacy.tsx:88](/Users/raffe/Documents/OdinLink/.production-hotfix/src/AppLegacy.tsx:88), `handleSaveConfig` | POST `/api/businesses` | Same unmounted legacy component; no salon write | Yes |
| [src/AppLegacy.tsx:126](/Users/raffe/Documents/OdinLink/.production-hotfix/src/AppLegacy.tsx:126), `handleAddSalon` | POST `/api/businesses` or PUT `/api/businesses/:id`; updates local view state | Same unmounted component; uses business IDs, not salon UUIDs | Yes |
| [src/AppLegacy.tsx:248](/Users/raffe/Documents/OdinLink/.production-hotfix/src/AppLegacy.tsx:248), `handleEditInit`, `handleDeleteSalon`, translations/tab/table/form labels | Local state; deletion calls DELETE `/api/businesses/:id` | Unmounted; all remaining salon references in this file are view state, labels, or these business operations | Yes |
| [src/components/ConfigPanel.tsx:11](/Users/raffe/Documents/OdinLink/.production-hotfix/src/components/ConfigPanel.tsx:11), `ConfigPanel` | Three hardcoded example centers in local React state; display labels; save handler shows an alert | No importer found; no fetch, Supabase query, persistence, or salon UUID dependency | Demo only; examples are not authoritative mappings to either table |
| [src/components/Landing/LandingMarkup.ts:1](/Users/raffe/Documents/OdinLink/.production-hotfix/src/components/Landing/LandingMarkup.ts:1) | Three plural salon words in English/German marketing text; no table operation | Public landing content is live; it does not depend on database salons | Describes customer industry, not an entity/storage model |
| [src/auth/auth.test.ts:239](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/auth.test.ts:239) | Reads server source, asserts safe salon projection and SELECT wiring; no DB access | Test only; will need adjustment when handlers are explicitly retired | No runtime dependency; currently protects API response safety |
| [tests/security/businesses-salons-rls-model.sql:1](/Users/raffe/Documents/OdinLink/.production-hotfix/tests/security/businesses-salons-rls-model.sql:1) | Synthetic CREATE, INSERT, SELECT, UPDATE, DELETE, TRUNCATE-denial, GRANT/REVOKE, and RLS experiments | Disposable local model guarded by database name/empty schema; rollback at end. Not a migration, startup hook, or deployed RPC. Not executed in this task | Test fixture models both tables; not evidence of production ownership |
| [RLS safety report](/Users/raffe/Documents/OdinLink/.production-hotfix/docs/audits/2026-10-05-businesses-salons-rls-safety.md:1) | Documentation references to schema, grants, endpoints, test model, rollout | Documentation only | Historical audit, not an application dependency |
| [RLS prerequisite report](/Users/raffe/Documents/OdinLink/.production-hotfix/docs/audits/2026-10-05-businesses-salons-rls-prerequisites.md:40) | Documentation of the unresolved mapping and API dependency | Documentation only | Historical audit, not a runtime dependency |
| [docs/security/Auth-Foundation.md:147](/Users/raffe/Documents/OdinLink/.production-hotfix/docs/security/Auth-Foundation.md:147) | Singular salon listing description | Documentation only | Describes the still-registered membership-scoped endpoint |
| [src/components/dashboard/GeneratePromptModal.tsx:24](/Users/raffe/Documents/OdinLink/.production-hotfix/src/components/dashboard/GeneratePromptModal.tsx:24) | Hair/Nail/Beauty Salon industry choices | Live business prompt-generation UI; no table access | Business industry labels |
| [src/i18n/dashboard.tsx:400](/Users/raffe/Documents/OdinLink/.production-hotfix/src/i18n/dashboard.tsx:400) | Translations of those industry choices | Live localization; no table access | Labels only |

The server's missing-input and error-message references at 30791, 30806–30809, 30816, and 30828 belong to the same two handlers; there is no additional persistence/recovery path. No salon UPDATE or DELETE handler exists. No repository code fetches `/api/salons`. The salon UUID is returned by those APIs but is not used as a lookup key, routing key, tenant identity, or foreign key by any inspected application path.

## 2. Architecture paths without a salon dependency

| Area inspected | Actual source of business identity/data |
| --- | --- |
| Active frontend/dashboard | `src/main.tsx → src/App.tsx → src/pages/dashboard.tsx → src/services/api.ts`; `loadDashboardData` calls `api.getBusinesses`, then business-scoped APIs. Business CRUD uses `/api/businesses`; no browser table query for salons |
| Authentication and business access | Verified Supabase Auth UID and active `business_memberships` with numeric business IDs. `parseBusinessId('chi')` fails. No salon lookup proves ownership |
| Onboarding/business creation/deletion | `create_business_with_owner` inserts businesses and memberships atomically; `delete_business_with_memberships` deletes memberships/business. Neither SQL function accesses salons |
| Channel setup/connection callbacks | Businesses, `channel_connections`, `channel_authorization_sessions`, calendar connection/session tables; legacy Telegram setup selects the explicitly authorized business |
| Booking/continuation/recovery | Businesses/config, appointments/leads/conversation state and booking reservation/outbox tables. No salon reads or ID linkage |
| Analytics | Business-scoped analytics and appointment loaders; dynamic loader table selection is limited to analytics/appointment sources, not salons |
| Notifications | Business-scoped notifications and business configuration; no salon source |
| Provider webhooks | Business/provider routing and channel connections; no salon source. Netlify Telegram webhook has no salon dependency |
| Cron/background workers | Business configuration, appointments, reminders and outbox; Telegram startup reads businesses. No salon dependency; worker/reminder code was not modified |
| SQL RPCs / migrations | No salon reference in repository migrations, including the prepared, unapplied membership hardening migration |
| Legacy config/import/deployment | No salon dependency in `fix_config.ts`, scripts, Netlify function, Render/Vite config, or inspected available JSON configuration. Runtime config uses business identities rather than the salon UUID |

The build includes both salon handlers in `dist/server.cjs`. The emitted frontend JavaScript has no `/api/salons`, `salon_id`, `salon_name`, `newSalonName`, or ConfigPanel demo-ID markers. Public marketing salon words remain expected. IDs in ConfigPanel examples and AppLegacy must not be confused with production `salons.id`: the examples use local strings and AppLegacy derives numeric business IDs.

## 3. Production database dependency inventory

Project `blknxpoeaqrvvdhixrau` was inspected using read-only transactions, metadata, and aggregate-only identity checks. No customer messages, credentials, salon UUID value, or unrelated row data were printed.

| Object / dependency class | Observed state |
| --- | --- |
| Relation | `public.salons`, ordinary table owned by postgres; RLS and FORCE RLS disabled |
| Columns | `id uuid NOT NULL DEFAULT gen_random_uuid()`; `salon_name text NOT NULL`; `business_id text NOT NULL`; nullable `status text` |
| Rows / mapping | Exactly one row. User-supplied legacy name/key: `chichi` / `chi`. Aggregate recheck: zero canonical numeric keys and zero exact matches to `businesses.id::text` |
| Primary key / index | `salons_pkey`, UNIQUE btree on `id` |
| Business-key constraint / index | `salons_business_id_key`, UNIQUE btree on text `business_id` |
| Other constraints | None; no foreign keys into or out of salons, no business FK |
| Views / materialized views / rules | None referencing salons; no rule attached to it |
| Functions / procedures / RPCs | No non-system function source or identity arguments mentioning salon table/ID/name; no tracked dependency on table or row type from a function |
| Triggers | None on salons. Function-source search found no other trigger function mentioning salon identifiers |
| Policies | None on salons; no policy expression on another table mentioning salons |
| Sequences | None. UUID default does not use an identity/serial sequence |
| Other tracked dependencies | Own table row type, array row type, internal TOAST storage, UUID default, and the two own constraints/indexes; no external dependent application object |
| Realtime publications / foreign tables | Salons is not listed in a publication. No foreign tables were present in the inspected database |
| Comments / ownership model | No table/column comments explaining a mapping; no owner UID, creation audit fields, branch key, provider config, or membership relation on salons |
| Grants | anon/authenticated/service_role have table CRUD and surplus table privileges; public schema USAGE is allowed for anon/authenticated. Read-only `SET LOCAL ROLE anon` sees the one row. Backend membership middleware does not protect direct table access |
| Scheduled SQL | Installed extensions do not include pg_cron/pg_net. Repository scheduling is in the application; no salon dependency found |
| Deployed Supabase Edge Function | One active function, `calendar-agent` version 7, `index.ts` (220 lines). Retrieved source has no salon table/identity reference or Supabase table/RPC call; its inspected fetch operations concern Google calendar/token APIs |

Catalog inspection covered `pg_depend` for both table and row type, constraints, indexes, triggers, rules, views/materialized views, policies, sequences and publications. Source/argument scans supplement catalog tracking because PostgreSQL does not necessarily track references inside string-defined function bodies. This is documented in [PostgreSQL 17 dependency tracking](https://www.postgresql.org/docs/17/ddl-depend.html). No DROP or CASCADE probe was used.

### Other table identities

No other non-system column is named for a salon. All 18 other identified tenant/business-key columns are bigint `business_id`, in:

`analytics_events`, `appointments`, `appointments_leads`, `booking_result_outbox`, `booking_slot_reservations`, `business_conversation_sessions`, `business_memberships`, `business_notifications`, `business_usage_stats`, `calendar_authorization_sessions`, `calendar_connections`, `channel_authorization_sessions`, `channel_connections`, `chat_history`, `knowledge_chunks`, `knowledge_sources`, `message_usage`, and `odin_shadow_evaluations`.

These bigint fields cannot contain text `chi` or the salon UUID. Aggregate exact-match checks across all 18 UUID columns and 29 text identity columns in other public tables found zero occurrences of the existing salon UUID; the text identity checks also found zero exact `chi` matches. These include user/provider/operation/session/booking/calendar identities, not only tenant columns. This proves absence in the inspected relational identity fields; it is not a claim about arbitrary free text/JSON payloads, external databases, exported files, or unseen consumer state. No application code references the existing `chichi`/`chi` row as a tenant mapping.

## 4. Production reachability and historical use

The [Render live deployment](https://dashboard.render.com/web/srv-d8mvqhernols73d4skhg/deploys/dep-db13ms7avr4c73a41kpg) reports commit `e634610c865d2baf654870f403adab754ce9deeb`, “Preserve booking context across language guard.” It is older than the audit checkpoint; this task did not deploy the hotfix.

The locally available deployed commit contains the same salon projection and handlers at server lines 254, 30461, and 30496. The diff from that commit to `f473c84` has no salon-handler changes. A credential-free GET to the observed live service, `https://laserluxury.onrender.com/api/salons`, returned **401** with `{"error":"unauthenticated"}`. Combined with deployment/source evidence, this establishes the route is live and protected; it does not test an authenticated query or execute a write. POST reachability is established from the deployed source, not by a production write probe.

For a valid member, GET still performs a salon query even when the result is empty. Since `chi` is not a numeric membership/business key, that row is not returned by the current membership-filtered GET and cannot be created/selected as an authorized business through the numeric middleware. An empty result is not proof that the table can be absent: missing table access would make a member's GET fail. POST can still create new salon metadata for a numeric authorized business.

Two PostgREST-shaped statement entries in retained `pg_stat_statements` record **6 anonymous read calls (6 rows) and 1 anonymous insert call (1 row)** involving salons. Statistics reset is `2026-06-05T20:48:20.700677+00:00`; individual calls have no timestamps/caller identities in this evidence and may predate the current deployment. They do not establish who inserted the row or whether a caller remains active. The historical anon role could reflect a direct client or an older backend using anon credentials. Query text and request payloads were not printed.

The available last-24-hour Supabase log search returned no entries containing `/rest/v1/salons`. That limited result does not prove a full retention-period absence, complete logging coverage, absence of `/api/salons` server calls, or consumer retirement. Unknown external clients/automations remain a compatibility gate. No external consumer contact or authenticated-user session was used.

## 5. Domain conclusion and retirement risk

**Businesses already supersedes the salon table for all identified core features.** It supplies the business directory, numeric tenant identity, business settings/provider configuration, membership-backed creation and the keys for operational data. Neither active frontend nor booking architecture uses salon UUIDs.

Evidence supports a former standalone salon/center directory with name/status and a unique external-looking text key. Current endpoints attempt to associate that key with authorized business IDs, but no database relation enforces this. The unique key permits at most one row per exact text value; UI words “branches” do not prove a multi-branch model. No evidence establishes what `chi` means or who owns it. Converting, assigning, or merging it into businesses is unjustified.

Retirement risk is primarily API/client compatibility and preservation of unresolved legacy data, rather than a known core operational dependency. Dropping or denying service access today would break authenticated GET/POST handlers. Revoking client grants could also break an untracked client; historical anon use makes that possibility concrete. Current broad table grants expose the legacy row and allow direct client mutation independently of server authorization. [Supabase documents grants and RLS as separate access boundaries](https://supabase.com/docs/guides/api/securing-your-api); an API auth guard alone is not a table boundary.

If a genuine continuing salon-specific feature is confirmed, treat a salon as optional tenant metadata with its own UUID and an explicitly verified numeric business relation. A conservative future foundation is an **additive nullable bigint `tenant_business_id` FK to businesses**, keeping the original text key unchanged. Leave `chi` unassigned and inaccessible to tenant APIs until ownership is proven. New writes must take the canonical middleware-authorized business ID; normal reads must use the verified FK. If one-per-business is the approved domain, enforce uniqueness on non-null typed business IDs. Do not assume a branch model or cast/backfill the legacy key. This is a design option only; no migration or code was prepared/applied here.

## 6. Exact recommended next action

Start a separately scoped **legacy salon API consumer/deprecation task**, retaining the table and row:

1. Identify owners of any direct Data API clients, `/api/salons` consumers, integrations and exported UUID references; review retained access logs across an agreed representative window. Historical anonymous use needs attribution or an explicit operator decision that it is unsupported. Record whether the two endpoints remain a supported contract.
2. If legitimate direct clients remain, move them to authenticated backend access before removing table grants. In staging, verify service-backed startup and both endpoint contracts, then prepare a separately approved salon-only revoke of PUBLIC/anon/authenticated access while preserving the minimum required service privileges. Check role inheritance/column grants as well. This can make it backend-only without assigning ownership or changing the row; do not enable RLS in this task.
3. Decide retention/archive handling for the unresolved legacy row. Optionally produce an access-controlled export with schema/grants/UUID and restoration verification in the separately authorized task. No export containing the row was made here.
4. If the endpoints have no required consumers, explicitly deprecate/remove them and their projection, updating the source assertion/test documentation. Replacing salon UUID responses with business IDs is a contract migration, not an automatic alias. Leave core business, channel, booking and reminder behavior unchanged.
5. Validate dashboard/business creation/settings, onboarding/connections, workers, and formerly supported callers in staging. Require no remaining application or database dependency and an operator retention decision before declaring SAFE TO RETIRE.
6. Only later consider a separate, explicitly approved table-drop migration after a fresh catalog/source/traffic audit and backup verification. Prefer dependency-restricted removal; never use CASCADE to bypass an unexpected dependency. Restore the table/export and prior compatible application release if retirement validation fails; avoid restoring broad public grants as the routine compatibility rollback.

No immediate bigint conversion, ownership repair, row rewrite, RLS enablement, permission mutation, or table removal is justified by this audit. The conservative next step is deprecating the still-exposed API contract with consumer evidence, not inventing a business mapping.

## 7. Validation

No tests were added/updated and no production code changed. Existing focused tests ran with synthetic/local test dependencies and environment loading disabled:

```text
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test
  src/auth/auth.test.ts
  src/auth/backend-supabase.test.ts
  src/dashboard/api-router.test.ts
  src/dashboard/summary.test.ts
  src/business/business-tone-update.test.ts
  src/components/dashboard/DashboardShell.test.tsx
  src/components/dashboard/tone-save.test.ts
  src/i18n/dashboard.test.ts
```

Results: **20 Node test entries; 19 passed, 1 unrelated baseline failure**. The failing `business-tone-update.test.ts:82` invokes the browser API under plain Node; `supabase-browser.ts:7` raises a TypeError because `import.meta.env` is undefined. The same test was rerun in an isolated `git archive f473c84` copy with the same installed dependencies and reproduced the exact error/call path. No out-of-scope test or frontend fix was made. Auth, credential selection, dashboard summary/access, shell, save coordinator and localization checks passed. The separate baseline reproduction is one additional execution of the same failing test, not a new distinct test.

`npm run build`: **passed** (Vite frontend and bundled server), with the existing >500 kB frontend chunk warning. Frontend asset hashes remained `index-BBjYuo-D.css` and `index-Bs0F8ghL.js`.

`git diff --check`: **passed**. The new report was also checked independently because it is untracked. Final repository status contains only this report as untracked; final tracked diff stat is empty. Report addition: 141 lines, one file. No schema or application file changed.
