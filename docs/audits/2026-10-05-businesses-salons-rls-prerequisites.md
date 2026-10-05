# Businesses/salons RLS prerequisites

Checkpoint: `hotfix/reminder-delivery-safety`, `eb61a3bb68e315404f4dda2676bd1be52638873c`. Date: 2026-10-05.

**Verdict: NOT READY for an RLS enablement task.** Independent backend credential and legacy Telegram authorization fixes are prepared and tested. Ownership repair and salon mapping remain blocked on authoritative operator decisions. Production was inspected read-only; no migration, grant change, RLS enablement, deployment, commit, push, or merge occurred.

## 1. Missing membership: facts and limits

Production still has two businesses and one membership. One business has **no membership at all**, not merely a suspended/invited/revoked owner. There are zero orphan memberships. The uncovered business has no channel or calendar authorization-session history. Neither businesses nor salons has an ownership UID column or creation audit field. No business creation trigger supplies an owner. A count-only check found no auth user with the inspected business ownership app-metadata keys; application authorization does not use those claims anyway.

The authoritative model is the active `(business_id, verified auth.users UID, role)` membership. Membership `user_id` has an auth.users FK; `created_by` is an optional auth.users FK. Customer `user_id` fields in appointments/leads/history/sessions are provider/customer identities, not business ownership evidence. Connection authorizers would prove a past authorization, not necessarily owner role; none exists for the uncovered business.

[Current business creation](/Users/raffe/Documents/OdinLink/.production-hotfix/server.ts:33406) passes the authenticated user's UID to `create_business_with_owner`, which inserts the business and active owner membership atomically. Signup/Google OAuth do not automatically join an existing business. There is no application membership insert/update path outside the create RPC; the delete RPC removes memberships during authorized business deletion. Membership status/role changes require privileged administration.

Repository history proves that the pre-auth business POST directly inserted businesses without membership creation. Commit `094dff8` introduced the membership foundation and atomic creation; its migration deliberately contains no guessed legacy owner backfill. Auth user deletion also cascades membership deletion, and unrestricted public business INSERT is another possible origin while RLS/grants remain permissive.

**Specific historical root cause cannot be proven from retained evidence.** The demonstrated gap is that business existence has never guaranteed owner coverage. Legacy creation without backfill, later privileged changes, public insertion, or auth-user deletion cannot be distinguished for this row. It would be incorrect to label one as the proven event.

## 2. Ownership repair: operator decision required

No safe deterministic owner was established. No ownership repair or assignment migration was generated.

The operator must identify the uncovered business and provide an authoritative record binding it to an existing Supabase Auth UID, with an explicit owner/active assignment decision. A matching name/email, sole remaining auth user, provider token, customer conversation, or arbitrary request business ID is insufficient. If this is intentionally unmanaged legacy/test data, the operator must explicitly decide its lifecycle/access model rather than invent a user mapping.

After a verified assignment is approved, a separately reviewed repair can verify the business and auth user, lock the business row, recheck membership state, and insert the approved active owner membership transactionally. It must refuse conflicting existing state instead of silently upserting/changing another user's role. That work is stopped pending evidence; the independent code fixes below do not depend on guessing the owner.

## 3. Membership FK readiness and prepared proposal

[Prepared migration](/Users/raffe/Documents/OdinLink/.production-hotfix/supabase/migrations/20261005095355_harden_business_membership_integrity.sql):

- Add `business_memberships.business_id → businesses.id` as a bigint FK with `ON DELETE CASCADE`, initially NOT VALID, then validate existing rows.
- Cascade preserves the original migration's intent that membership must not block operational business deletion. The existing delete RPC already locks the business, deletes its memberships, then deletes the business. Atomic creation inserts the parent before the membership, so both operations remain compatible.
- Existing unique `(business_id,user_id)` and `(business_id,status,user_id)` indexes already cover the FK's leading business ID. No redundant index is proposed.
- Replace the obsolete column comment. Revoke ALL membership privileges from PUBLIC/anon/authenticated, restore authenticated SELECT only, and explicitly retain service-role CRUD. The existing own-active SELECT policy remains unchanged. Production has no explicit membership column ACLs to clear.

Current data supports FK validation: **zero orphan memberships** and matching bigint types. Missing ownership coverage does not violate this FK; a FK cannot require every business to have an owner. The grant change removes surplus TRUNCATE/REFERENCES/TRIGGER privileges; it does not enable target-table RLS or create wider policies.

The filename was generated by `supabase migration new harden_business_membership_integrity` (CLI 2.116.0). The migration has **not been applied anywhere**. Before any approved application, recheck orphan count/constraints/grants, test both RPCs and cascade behavior in a disposable production-shaped database, and bound lock/statement timeouts in the migration execution session. A validation failure must abort, never delete or rewrite rows. A future rollback can drop this named FK and restore the captured column comment/grants if separately approved; restoring surplus public privileges is a security regression.

## 4. Salon purpose and mapping conclusion

Live `salons` has UUID PK, text `business_id`, unique `business_id`, name/status, and no ownership/FK. Its one key is **not a canonical positive integer** and has no exact match to `businesses.id::text`. No authoritative evidence identifies what that text means or which current business owns it. It may be a legacy external identifier, but that interpretation is unproven.

Current runtime access remains only:

- GET `/api/salons`: verified user → active membership IDs → backend safe-column SELECT filtered by those IDs.
- POST `/api/salons`: verified user plus body `settings.manage` authorization → backend INSERT. The authorization parser accepts leading-zero/trimmed numeric strings but the INSERT preserves the raw text. Canonicalization of future writes should use the already-authorized business ID in a separate salon decision/change.

No salon UPDATE/DELETE/RPC/cron/reminder/booking lookup was found. The active frontend's dashboard uses businesses through authenticated APIs, not this table. Legacy UI labels use "salons/branches" for businesses; ConfigPanel examples are local state. Repository evidence does not establish external API consumers, so retirement/removal cannot be approved from lack of internal calls alone.

**No bigint conversion or salon FK migration is safe/proven today.** Keep the existing data unchanged. Recommended interim classification is backend-only legacy data, pending an explicit operator decision about retention and verified ownership. If salons is confirmed to be a tenant directory, use a verified mapping and either canonical numeric text or an additive nullable bigint tenant FK while retaining the legacy text. Do not automatically cast, rewrite, assign, drop, or broaden queries to make the row match. Existing unique business_id permits only one exact text key, so do not invent multi-branch cardinality either. No salon migration was generated.

## 5. Backend credential audit and deployed evidence

| Context | Environment/selection | Prior fallback / current behavior |
| --- | --- | --- |
| Shared `server.ts` database client | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Previously service key OR `SUPABASE_ANON_KEY`; production could start anonymously or completely unconfigured. Now requires the privileged server credential and URL before startup |
| Authorization/membership client | Same server URL/service variable | Already required service variable; now shares the credential-type validation |
| User token verification | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Separate client calls `auth.getUser(token)`; unchanged, no privileged fallback |
| Analytics/loaders/reconciliation and knowledge backfill | URL/service variable | Already service-only; no anon fallback. Server routes also pass through the hardened shared startup |
| Browser Auth | VITE URL and publishable/anonymous variables | Unchanged; user sessions are intentionally enabled there, no backend credential imports |

If the old shared client used anon under backend-only RLS, business/salon lists and settings writes, provider routing, Telegram startup scans, health/notification config loading, outbox and cron business config reads could fail or return empty scopes. Some legacy readers have global fallback behavior, making silent missing rows a rollout concern. Those reader/reminder functions were not changed.

**Deployed path verified read-only:** the existing [Render service logs](https://dashboard.render.com/web/srv-d8mvqhernols73d4skhg/logs), filtered to startup credential events over the last seven days, show `Supabase client initialized with SERVICE_ROLE key.` No ANON event was observed in that filtered view. The [Render environment](https://dashboard.render.com/web/srv-d8mvqhernols73d4skhg/env) has the required server variables. Credential classification confirmed a service-role JWT in `SUPABASE_SERVICE_ROLE_KEY`; `SUPABASE_ANON_KEY` and `VITE_SUPABASE_ANON_KEY` contain publishable public keys. Values were not printed/copied into reports or persisted; controls were returned to masked state. No Edit/Save/deploy/restart action was used.

The deployed client path selects the service variable; source has no shared-client user-session setter. Production's service role has BYPASSRLS and table privileges, as previously checked. This is configuration/selection evidence, not a new deployed health probe or proof of every historical instance. The working-tree changes remain **undeployed**. Future rollout must recheck effective outgoing authorization and service-only table access after releasing them.

## 6. Credential hardening implemented

[backend-supabase.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/auth/backend-supabase.ts:1) trims and requires URL/service credential, accepts a legacy JWT whose top-level role is service_role or a modern `sb_secret_` credential in the existing server-only variable, and rejects public, malformed, blank, or missing credentials. It never consults anon or frontend variables. Errors contain category names, not keys. Decoding checks configuration type only; Supabase still verifies authenticity on actual requests. These claims are never used to authenticate a human or grant business membership.

Shared server initialization and `getAuthorizationClient` use this helper with persisted sessions and refresh disabled. Missing/mislabeled credentials throw before production startup. Only completely unconfigured `NODE_ENV=test` imports retain a null client for isolated tests; test mode does not permit a configured anon fallback and does not start the production server. No frontend behavior or credential variables changed.

The key classes and backend-only use follow [Supabase API-key documentation](https://supabase.com/docs/guides/api/api-keys); the existing leading-column indexes satisfy the [PostgreSQL FK indexing guidance](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK). Supabase's changelog was checked for relevant breaking changes; no key-system migration or dependency upgrade was undertaken.

Tests cover whitespace/precedence, missing/blank/invalid credentials, mislabeled anon/authenticated JWTs, modern secrets, missing URL, installed SDK outgoing apikey/Authorization headers, actual server import rejecting anonymous configuration, and production refusing startup when entirely unconfigured. Test HTTP is intercepted and credentials are synthetic.

## 7. Exact Telegram issue and fix

Before: `/api/setup-telegram` authorized body business A, saved the arbitrary request into shared config, then globally resolved the supplied token. Token B could load/hydrate business B and start its poller without rechecking A. Writes occurred before resolution.

After: [telegram-setup.ts](/Users/raffe/Documents/OdinLink/.production-hotfix/src/channels/telegram-setup.ts:19) remains mounted behind verified `requireAuth` and body `settings.manage`, takes **only the middleware-authorized business ID**, rejects conflicting ID aliases, and performs:

```ts
client.from('businesses').select('*').eq('id', businessId).maybeSingle()
```

It verifies the returned ID and compares the normalized request token against this row's stored token **before hydration, persistence, or polling**. No global token query, scan, other-tenant recovery, or limit(1) exists in this handler. Missing row, ambiguous/query error, wrong returned/built identity, unavailable database, or token mismatch fails closed. Responses never include database config/tokens/raw errors.

The server builds config from the verified row using `normalizeBusinessConfig(row, {})`, so no other business's active config is inherited. The helper's default fallback for all preexisting callers remains unchanged. Request-supplied provider credentials and unrelated settings cannot be persisted through this legacy setup path; authenticated business settings APIs remain the supported settings writer. The config file and active state are saved only after successful verification, with canonical ID aliases. The endpoint still uses the existing poller, token normalization, and calendar hydration for the same authorized business. No-token save remains scoped without starting a poller. Background provider resolution, reminder logic, and booking functions are unchanged.

Tests use actual Express auth/membership middleware and the installed Supabase/PostgREST client with intercepted responses. They cover owner/admin/manager success, both business isolation directions, foreign token, conflicting aliases, inactive/foreign memberships, anonymous access, missing/duplicate/wrong business results, database/build failures, invalid input, no-token save, absence of credential exposure, and absence of side effects on rejected requests.

## 8. Tests and validation

| Check | Result |
| --- | --- |
| New credential-selection + Telegram setup tests | 38 passed |
| Focused auth/security/dashboard/connection/calendar/test-bridge set including new tests | 66 Node entries: 65 passed, 1 baseline failure |
| Additional Telegram Persian, earliest-range, reminder-delivery regressions | 3 Node entries: 2 passed, 1 baseline failure |
| Combined distinct executed entries | 69: 67 passed, 2 unrelated baseline failures |
| Build | `npm run build` passed; existing large frontend chunk warning; frontend asset hashes unchanged |
| Diff whitespace | `git diff --check` passed; new files checked separately as well |
| Database | Read-only recheck: businesses/salons RLS still disabled, membership business FK still absent, ownership/mapping gaps unchanged |
| Migration execution | Not performed locally or in production; staging execution/RPC/cascade verification remains future work |

Baseline comparisons against `eb61a3b`:

1. `src/channels/connections/meta-compliance.test.ts:209`, static assertion expecting `if (!secret) return res.sendStatus(503)`. The untouched source checkpoint's seven-file security set had 27/28 passing before application edits; same failure after changes. No out-of-scope correction made.
2. `src/ai/telegram-earliest-range-parity.integration.test.ts:48`, `production.pending` is null when checking `availabilityConstraint`. Reran in an isolated `git archive eb61a3b` copy with the same installed dependencies: same TypeError/failing line. The first archive run could not resolve tsx because the hotfix's partial node_modules was linked; corrected the isolated dependency link and reran before assigning baseline status. No booking fix made.

Commands: `NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test` over auth/auth, auth/backend-supabase, channels/telegram-setup, connections/connections, connections/meta-compliance, dashboard/api-router, dashboard/summary, ai/google-calendar-oauth-runtime.integration, runtime/test-bridge-security.integration. Additional run: ai/telegram-persian-booking-runtime.integration, ai/telegram-earliest-range-parity.integration, runtime/reminder-delivery-policy.integration. Each filename ends in `.test.ts`.

## 9. Remaining gates and handoff

1. Operator-proven uncovered-business ownership/lifecycle decision; separately reviewed repair, with no guessed UID.
2. Operator-proven salon mapping or explicit backend-only legacy retention decision; canonical future-write plan and external-consumer inventory before any schema conversion/retirement.
3. Approve and execute the prepared membership FK/grant migration only after production-shaped staging checks, current orphan/grant rechecks, and bounded lock timeouts. No schema application is authorized in this task.
4. Separately release the reviewed code hardening, then verify service-backed startup, authorization headers, dashboard settings, channel setup/callbacks, workers, and denied cross-tenant requests in the actual deployment.
5. Prepare/test target-table backend-only RLS and table/sequence grants in non-production, then seek explicit production rollout authorization. Preserve service-only RPCs and safe dashboard projections. Do not use broad client policies to compensate for missing ownership or anonymous backend configuration.

Until those gates pass: **NOT READY; both target tables remain without RLS.** No business/user mapping or production data was rewritten. Final diff/stat/status are in the accompanying completion report; all changes remain unstaged/uncommitted.
