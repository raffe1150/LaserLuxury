# Security-only release on the deployed production commit

Prepared 2026-10-05 on branch `release/security-hardening-live`, from exactly `e634610c865d2baf654870f403adab754ce9deeb` (Render OdinLink, production branch `frontend-routing`). The managed checkout is `/Users/raffe/.codex/worktrees/odinlink-security-live/OdinLink`. The final local commit is reported by Git and in the delivery response.

This report supersedes release identity, readiness and unresolved operator gates in the five copied historical audits. Those files retain the earlier investigation and its then-current results; their old checkpoint paths and verdicts are historical. Do not deploy the obsolete `release/security-hardening` artifact at `693ecfc11e6b0deb7285957a93b18c00f2285f06` or use its old `dd5a51d` base.

## Verdict and evidence limits

**READY FOR CONTROLLED PRODUCTION ROLLOUT** as a prepared security-only release. No new integration blocker was found. This is not deployment authorization or a claim that this fresh commit has already been deployed or smoke-tested on Render. The earlier hosted staging migration, rollback/reapplication and application smoke validation were reported passed; the exact three migrations and rollback scripts are retained byte-for-byte. This task additionally executed the integrated release against an isolated production-shaped local PostgreSQL cluster and preserved the current production runtime sources.

The operator explicitly accepts that unidentified historical direct clients of `public.salons` may stop working. Keep backend-only access, the table, the legacy `chichi` / `chi` row and its UUID; never delete, remap or infer ownership. Prior preflight found historical anonymous salons traffic but no identified current caller. That compatibility decision is resolved; a loss of unsupported direct client access is expected, rather than an automatic rollback trigger.

Before a later authorized rollout, recheck Render's exact live commit and Supabase identity `blknxpoeaqrvvdhixrau`, schema, memberships, grants and unapplied migration state. If production has advanced beyond this base, stop and integrate against the new exact live commit. No production or staging access was required for this release preparation.

## Surgical integration and preserved functionality

No commit was blindly cherry-picked. Only the old security additions were copied, and matching security hunks were applied to the exact live source. The old whole-server patch does not cleanly match the newer production import/runtime layout, so the integration was performed directly against the live file.

- `server.ts`: privileged backend bootstrap with no anonymous fallback; authorized tenant-scoped Telegram setup; protected extracted salons GET/POST handlers. The business normalizer accepts an optional fallback solely so authorized Telegram setup can avoid unrelated global tenant configuration. Its default behavior, every production field, and the production `row.language || "en"` default remain unchanged. Calendar hydration remains wired into setup.
- `src/auth/supabase-auth.ts`: only privileged authorization-client configuration changes. Production token verification and its newer verification-error classification remain unchanged.
- `src/auth/auth.test.ts`: projection/source assertions follow the extracted salon handlers and retain checks for Auth and settings permission middleware.

All other 480 pre-existing files are byte-identical to the 483-file base. A preservation test compares their Git blob hashes, compares the whole server AST after restoring only the permitted security spans, exercises production business normalization, and checks unchanged Auth verification. Booking, channel connection, calendar/OAuth, OpenAI/provider, frontend, operational worker, package and lockfile sources remain intact. No separate PGRST116 correction was imported; existing single/maybeSingle behavior is retained exactly outside the intended security handlers.

The two reminder migrations below are absent and not required. Existing reminder runtime behavior already present in the production base is preserved without modification.

- `20261004130125_add_chat_history_provider_event_time.sql`
- `20261004201036_add_whatsapp_reminder_template_config.sql`

## Validation

Tests ran with `NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null`; no production credentials were loaded. The rollout harness creates and removes an isolated local PostgreSQL cluster, uses synthetic data and intercepted provider/Auth HTTP, and does not consume production database environment variables. It validates actual SQL privileges and actual extracted API/bootstrap/startup code; it does not prove live provider credentials or external provider availability.

| Check | Result |
| --- | --- |
| `NODE_ENV=production DOTENV_CONFIG_PATH=/dev/null npm run build` | Passed; existing frontend chunk-size warning |
| Production-mode frontend build versus untouched exact base, with the same dependencies/environment | Every emitted frontend asset, HTML and logo is byte-identical |
| Dedicated security tests | 71 passed, zero failures |
| Broader focused security/dashboard/channel set | 94 entries: 93 passed, one unchanged baseline failure |
| Production-shaped security rollout | 18 entries: 17 passed, zero failures; one reminder coexistence check skipped because the migrations are intentionally absent |
| Live production preservation | 5 passed, zero failures |
| Booking/channel/calendar/provider/dashboard targeted regressions | 111 entries: 109 passed, two unchanged baseline failures |
| Untouched exact-base regression comparison | Same 111 entries, same 109 passes and same two failures |
| Exact-base focused failure reproduction | Same Meta compliance and plain-Node browser-environment failures reproduced |
| `git diff --check e634610..HEAD` | Passed; final committed-diff result also recorded in delivery |

Dedicated security command:

```sh
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test src/auth/backend-supabase.test.ts src/business/backend-access-security.test.ts src/business/salons-api.test.ts src/channels/telegram-setup.test.ts
```

Production-shaped and preservation commands:

```sh
PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test tests/security/rollout-preflight.test.ts
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test tests/security/live-production-preservation.test.ts
```

Broader focused command:

```sh
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test src/auth/auth.test.ts src/auth/backend-supabase.test.ts src/business/backend-access-security.test.ts src/business/salons-api.test.ts src/channels/telegram-setup.test.ts src/dashboard/api-router.test.ts src/dashboard/summary.test.ts src/channels/connections/connections.test.ts src/channels/connections/meta-compliance.test.ts
```

Regression command, run identically in the release and an untouched `git archive` of the exact base:

```sh
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --test src/ai/providers/*.test.ts src/ai/google-calendar-oauth-runtime.integration.test.ts src/ai/booking-presentation-language-guard.integration.test.ts src/ai/grounded-booking-repetition.integration.test.ts src/ai/authoritative-booking-temporal-continuity.integration.test.ts src/ai/telegram-persian-booking-runtime.integration.test.ts src/runtime/reminder-calendar-verification.integration.test.ts src/runtime/reminder-language.integration.test.ts src/components/dashboard/DashboardShell.test.tsx src/components/dashboard/tone-save.test.ts src/business/business-tone-update.test.ts src/integrations/integration-center.test.tsx
```

Separate baseline failures, left untouched:

1. `src/channels/connections/meta-compliance.test.ts`: source assertion expects the older `if (!secret) return res.sendStatus(503)` webhook guard; current production uses `usableSecrets`.
2. `src/business/business-tone-update.test.ts`: plain Node evaluates browser Auth with undefined `import.meta.env.VITE_SUPABASE_URL`.
3. `src/ai/providers/semantic-knowledge.test.ts`: OpenAI compound service/recommendation test expects a trailing question mark; the same baseline reply ends in a list.

The production-shaped checks cover dependency-order rejection, orphan failure atomicity, migration reruns, client access denial, authenticated own-active memberships, service CRUD/identity sequence, lifecycle RPCs, membership cascade and appointment delete blocking, safe business APIs, protected salon APIs, scoped Telegram setup/background reads, exact reverse rollback and reapplication without legacy data loss.

## Safest later manual rollout

No action in this sequence was performed here. Do not run an automatic whole-directory migration push: select only these three security SQL files, and do not apply reminder migrations. The membership SQL has no internal transaction wrapper, so execute its exact contents in a single explicitly bounded transaction (`BEGIN`, local 5-second lock timeout and 30-second statement timeout, file contents, `COMMIT`), as in the tested harness. Salons and businesses files already include their own bounded transactions. Record migration history only after the corresponding successful commit using the established controlled process.

1. Save current schema/grants/policies, migration history and deployment identity; verify a recoverable backup. Reconfirm healthy Auth-backed active memberships for every business, no orphan/missing Auth references, expected sequence and no unexpected policies, column ACLs or role inheritance.
2. After separate deployment authorization, release this exact reviewed commit through the normal Render process with valid production `SUPABASE_URL` and privileged `SUPABASE_SERVICE_ROLE_KEY`. **Deploy code before migrations.** Confirm successful privileged bootstrap and health, login/membership reads, scoped business read/write, both tenant-isolation directions, booking, connections, calendar OAuth, provider paths and Telegram startup. If code fails, restore the prior Render commit before any SQL and stop.
3. Apply only `20261005095355_harden_business_membership_integrity.sql`. Check `business_memberships_business_id_fkey` exists, validates and cascades; rows unchanged; Auth/user FKs remain valid; zero orphans; active coverage retained; authenticated own-active SELECT works and client mutation/TRUNCATE is denied; service authorization and lifecycle operations work.
4. Apply only `20261005111021_restrict_salons_to_backend_access.sql`. Check PUBLIC/anon/authenticated have no effective salon table/column privilege; service CRUD works; RLS remains at its intended unchanged state; exact legacy UUID/name/key/status and row count are unchanged; protected GET/POST and tenant isolation work. Any deliberately destructive write probes must use an isolated test environment, not the legacy production row.
5. Apply only `20261005111029_prepare_businesses_backend_only_rls.sql`. Check businesses RLS enabled with zero client policies; no client table/column/sequence privileges; service CRUD and identity USAGE retained; business IDs/count/contents unchanged; membership coverage and lifecycle behavior retained; authenticated application APIs, login, booking, channel/calendar/provider/Telegram runtime remain healthy. Use read-only production checks unless separate authorization expressly covers a scoped operational smoke write.
6. Observe startup/provider/webhook/worker and API logs through a complete operational cycle. Pause immediately at a failed checkpoint; do not continue to the next migration.

Rollback triggers: failed SQL transaction or timeout; unexpected grants/policy/schema/role changes; missing or invalid FK/Auth references or membership coverage; any unexpected data loss/change; authorized backend access or identity/lifecycle failure; credential exposure or cross-tenant access; regression in the current production booking/channel/calendar/provider/Telegram runtime attributable to this integration. An expected denial of unidentified direct salon clients alone is the explicitly accepted risk.

A failed transaction rolls back without later steps. For a committed migration requiring reversal, compare fresh state to the saved baseline, then use the tested scripts in reverse applied order: `tests/security/rollback-businesses.sql`, `tests/security/rollback-salons.sql`, `tests/security/rollback-memberships.sql`. Skip scripts for migrations never applied. These restore earlier broad privileges and require a deliberate operator rollback decision; they never delete or remap the legacy row. If reverting code, preserve privileged backend compatibility until the relevant schema rollback has been verified, then restore the prior Render deployment and repeat checks. Keep scripts available throughout monitoring.

## Exact changed files versus the live base

Modified existing files (3):

```text
server.ts
src/auth/auth.test.ts
src/auth/supabase-auth.ts
```

Added security implementation, validation and audit files (24):

```text
docs/audits/2026-10-05-backend-only-rollout-preparation.md
docs/audits/2026-10-05-businesses-salons-rls-prerequisites.md
docs/audits/2026-10-05-businesses-salons-rls-safety.md
docs/audits/2026-10-05-salons-retirement-audit.md
docs/audits/2026-10-05-security-rollout-preflight.md
docs/audits/2026-10-05-security-live-release.md
src/auth/backend-supabase.test.ts
src/auth/backend-supabase.ts
src/business/backend-access-security.test.ts
src/business/salons-api.test.ts
src/business/salons-api.ts
src/channels/telegram-setup.test.ts
src/channels/telegram-setup.ts
supabase/migrations/20261005095355_harden_business_membership_integrity.sql
supabase/migrations/20261005111021_restrict_salons_to_backend_access.sql
supabase/migrations/20261005111029_prepare_businesses_backend_only_rls.sql
tests/security/businesses-salons-rls-model.sql
tests/security/live-production-preservation.test.ts
tests/security/production-shaped-fixture.sql
tests/security/rollback-businesses.sql
tests/security/rollback-memberships.sql
tests/security/rollback-salons.sql
tests/security/rollout-checks.sql
tests/security/rollout-preflight.test.ts
```

No existing file was deleted. The diff is narrowly security-only: privileged backend access, tenant isolation, protected legacy salons access, the three migrations and their tests/audits/rollback material. No production mutation, production migration, deployment, push, merge, Tappay action or staging modification occurred. Local synthetic SQL tests, builds and the local release commit are the only execution/writes involved in preparation.
