# Diagnostic-Only Release Report

## Status

**DIAGNOSTIC-ONLY PATCH READY**

Worktree: `/Users/raffe/Documents/OdinLink-calendar-diagnostic-only`

Detached HEAD: `21cbcdbe564853b5bbccb3fe1eb933fea5fd9bec` (exact production baseline21cbcdb). No commit, push or deployment. Existing P1 and dirty main worktrees were not edited. Live calendar compatibility remains unverified; this patch only enables the protected metadata probe.

## Runtime scope

Exactly two runtime files differ from production:

1. `server.ts`: one import; `GenericCalendarAdapter.inspectContractEnvelope`; `GoogleCalendarAdapter.inspectContractEnvelope`; temporary registration in `startServer`; optional `diagnosticQuiet=false` in `getCalendarAdapter`, suppressing its identifier-bearing logs only for the diagnostic caller.
2. `src/calendar/contract-diagnostic.ts` (new): `CalendarDiagnosticFailure`, `inspectCalendarEnvelope`, `createCalendarContractDiagnosticRouter` and a safe field-name allowlist.

The selector's provider conditions/credentials/fallback behavior are unchanged. Every existing caller retains diagnosticQuiet=false. New methods are invoked only by the new endpoint; existing getEvents/checkSlots/mutation methods are untouched.

`diagnostic-only-runtime.patch` includes both tracked server changes and the new module. Ordinary git diff omits the untracked module: include it when reviewing the release patch. Do not deploy the full P1 worktree.

## Isolation proof

`isolation-verification.json` records:

- The only changed existing tracked file isserver.ts; all other production tracked files are byte-identical.
- Removing exactly the diagnostic import, two new provider methods, route registration and optional log guards reconstructs productionserver.tsbyte-for-byte.
- No `src/calendar/read-contract.ts` file or dependency.
- No P1 auth/session changes; existing auth modules/tests remain production originals.
- No P1 website integrity module or containment changes.
- No P1 privacy minimization or support-message projection changes.
- No schema, migration, booking-state or authority changes.
- No unrelated P0 test overlays.

This is stronger than relying only on passing tests: ordinary booking, calendar normalization, auth, website and privacy source is unchanged. Existing production defects intentionally remain in this diagnostic-only tree.

## Endpoint/security

`GET /api/businesses/:businessId/diagnostics/calendar-contract?date=YYYY-MM-DD`

Reuse production `createRequireAuth` and `createRequireBusinessPermission('settings.manage')` unchanged. Authorization resolves the exact requested business; unauthorized/wrong-role/wrong-tenant requests cannot load provider data. The loader performs only a scoped businesses SELECT and existing normalizeBusinessConfig. No caller-supplied provider credentials, URL or calendar ID.

Valid date required; one local business day through the existing zonedLocalIso helper and end-of-day convention. DefaultEurope/Stockholm; invalid timezone rejected. Generic uses the same date for startDate/endDate at the configured HTTPS/events endpoint. No writes, booking engine, analytics, customer history or notifications. Google events.list only; generic GET only. Explicit HEAD rejection prevents implicit Express GET execution. Cache-Control:no-store is set before auth.20-second provider deadline; no diagnostic retry or pagination fabrication.

Response contains adapter, success/category, allowlisted top-level field names,items presence/type/count,pagination presence and latency only. Valid Google omitted-items envelope is reported withitemCount:null, not normalized to empty. Generic events arrays are counted whileitemsFieldPresentremainsfalse. No event content, IDs, customer contacts, calendar IDs, secrets, raw errors or continuation values returned/logged. Unknown field names are omitted to avoid sensitive dynamic keys. A pagination marker reports incomplete observation; this endpoint reads only the natural first page.

## Validation

`validation-results.json` and corresponding logs: all PASS.

- Focused diagnostic authorization/tenant/permission/envelope/privacy/timeout/read-only tests.
- Ordinary calendar baseline test: non-strict provider500 still returns[]; strict legacy option throws; Google omitteditems still normalizes to[]and does not follow pagination. These deliberately preserve21cbcdb behavior, not endorse it as safe for later P1 release.
- Original production auth foundation suite passes, including original outage semantics.
- Original production WhatsApp Arabic/multilingual regression passes with test-only Date fixed to2026-09-14T08:00Z. Original test file unchanged.
- Production build passes using existing dependencies.
- git diff --check passes.

No live channel/provider tests or real bookings. Full typecheck was not rerun; known productionpatch_key_rotation.tsfailure remains separate. No broad baseline cleanup.

## Test/support files

Only diagnostic-related test utilities were ported/added:

- tests/p1/calendar-diagnostic.test.ts
- tests/p1/calendar-baseline.test.ts
- tests/p1/run-server-test.cjs (exports only the two provider classes in a disposable test bundle)
- tests/p1/offline-network.cjs (blocks network and config loading during tests)
- Report-directory validation runner, logs, result JSON, isolation proof and runtime patch.

Localnode_modulessymlink points to existing main dependencies; it is **not a release file**. Ignore generateddistbuild outputs. No dependencies/lockfile updated.

## After separately authorized deployment

An authorized settings manager calls the GET endpoint for already-known empty and non-empty dates using their existing authenticated session. Return metadata only for contract review. Do not create events to force results or pagination. No paid Render Shell required. Deployment is not performed or authorized by this report.

After verification, remove this route/import, diagnostic module, two provider methods, quiet parameter/log guards and dedicated tests. Preserve the evidence. Do not remove any production booking code or assume this patch contains the four P1 fixes.

## Git status

See `git-status.txt` for exact status at report completion. The tree remains detached and uncommitted. Onlyserver.tsis modified among production tracked files; diagnostic module, tests and evidence are untracked additions. No staging occurred.
