# Ordered Admission V2 SQL Editor package — NOT APPLIED

## Decision

**GO for separately authorized manual schema-only installation preparation.** The operator reports reviewing Render Production settings: no new async control variables are listed and the implementation has not been deployed/activated. This is operator-reported evidence, not independent runtime proof. Local defaults and the targeted no-work test are verified. See `../../validation/ordered-v2-migration-readiness-2026-10-19/operator-runtime-evidence.md`. This supersedes the earlier missing-control-evidence blocker. No migration or activation is authorized by this package. Refresh target/hash/quiet-state checks immediately before a separately approved execution.

## Exact artifact

- Source: `../ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft`
- Source SHA-256: `0a4c40d4092f74d0b87f2f331657dca69cf05f5f2065477d6fc097409efe1197`
- Source size: 13,428 bytes.
- Execution file: `ordered-admission-v2.sql`
- Full payload SHA-256: `b385b90405829a6c1ad8c8e4f3d297d2ee4d6bcd9814c83d8fcc62d41595dca3`
- Full payload size: 13,489 bytes.
- Source begins at byte offset 61 and is the exact complete suffix. `manifest.json` records both identities. `build.py` refuses a changed source hash before writing outputs; the original source remains untouched.

The only prefix is:

```sql
BEGIN;
SET LOCAL odin.approved_ordered_knowledge_v2 = 'yes';
```

The original draft follows byte-for-byte, including its own BEGIN, approval check, LOCAL lock_timeout=5s, LOCAL statement_timeout=30s and COMMIT. PostgreSQL warns about an already active transaction; it does not nest transactions. The original COMMIT ends the one transaction and restores LOCAL settings. There is no suffix or session-global approval. No safeguards are removed. Do not paste/run fragments or add further statements. SQL Editor must execute the entire payload on one connection; on any error stop, roll back/discard the failed connection, inspect state read-only and do not retry blindly.

Creation order: already-installed Foundation → already-installed Slice 1 → **this V2 payload only**. Never replay either prerequisite. No changes to existing tables, columns, indexes, policies, V1 function definitions/ACLs or Booking objects are in the V2 draft. It adds two SECURITY INVOKER service-only functions and three triggers on existing P2 tables. Enrolled V2 conversations gain ordering guards intentionally; they cannot safely be switched back to V1.

## Evidence and production safeguards

Production read-only inspection: project `blknxpoeaqrvvdhixrau`, Odinlink, eu-west-1, ACTIVE_HEALTHY; database postgres, role postgres, PostgreSQL 17.6. Evidence snapshot at 2026-10-19 17:45:11 UTC. All four P2 tables empty; four V1 lifecycle functions and two guards remain installed, V2 absent. Existing P2 column/default/nullability inventories, 49 constraints, 17 indexes, function definitions/ACLs and guards match the prior post-installation evidence. RLS on all four; no P2 policies or effective client CRUD; service-only lifecycle functions. Tenant keys remain bigint businesses(id), with existing composite scope constraints. No schema drift blocks the draft.

Five Booking function definitions/ACLs and four Booking table column/RLS/ACL inventories match the earlier post-installation record. Current Booking constraints/indexes/policies are captured for exact future comparison. The old record does not support a complete historical canonical table/index/policy fingerprint assertion. No Booking data was read or changed. V2 SQL targets no Booking objects.

At inspection there were no other active/idle-in-transaction sessions or blocking transactions; P2 locks were only this inspection's granted AccessShare locks. This is a point-in-time observation. CREATE TRIGGER acquires SHARE ROW EXCLUSIVE locks on conversations, inbox and tasks, conflicts with writers and can briefly block traffic; it is not lock-free. Use a quiet coordinated interval, no competing DDL, verify current inactivity and retain original 5s/30s limits. No index build/table rewrite is required. Production PostgreSQL 17.6 supports the core JSONB, row locks, PL/pgSQL, triggers and SET LOCAL constructs used; disposable testing is 17.11, not a hosted gateway proof.

Before a separately authorized application, reconfirm project/host identity, both hashes, absent V2/no partial conflicts, empty P2 tables, known disabled host controls, current privileges and quiet locks. Capture a fresh snapshot and function fingerprint query from the validation directory. Stop on any mismatch, unsupported privilege, nonempty task/outbox state, contention, timeout or SQL error. Do not weaken guards/timeouts, repair history or activate workers.

## Local tests

`PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH PYTHONDONTWRITEBYTECODE=1 python3 docs/designs/ordered-v2-migration-package/validate.py`

41 passed: all 36 existing ordered admission/foundation/Booking SQL scenarios, plus five wrapper/postcheck tests for exact bytes/hash mismatch, restored LOCAL approval/timeouts, atomic rollback, safe rerun refusal and execution of the read-only postcheck/comparator against the disposable schema. Tests apply the complete payload on a private disposable PostgreSQL 17.11 cluster with TCP disabled. Raw-source and wrapped schema-only dumps, including grants, RLS and functions, are identical after excluding pg_dump's random control tokens. No existing project or customer database is used. No hosted migration-tool history guarantees are claimed.

## Read-only post-application procedure

1. Reconfirm the intended project. Run `post-application-snapshot.sql` through the read-only inspection path; it uses catalog SELECTs and four count queries only. Export its snapshot JSON (object, or `{ "catalog": snapshot }`) without changing customer data.
2. Run `python3 docs/designs/ordered-v2-migration-package/verify_snapshot.py /path/to/post.json` offline. Every check must be true: exact added V2 function bodies and service-only/invoker security, three exact enabled guards, unchanged old functions/triggers, unchanged table definitions/RLS/grants/policies/constraints/indexes/Booking metadata and empty P2 tables. Compare a refreshed pre-execution snapshot too if installation is delayed; unrelated drift is a stop condition, not permission to ignore a failed check.
3. Rerun the retained `function-fingerprint-query.sql` and compare the same representation with its pre-execution record. Do not substitute differently canonicalized hashes. Recheck live host controls separately; database counts cannot prove them.
4. Stale/ambiguous rejection, scope, duplicate identity, atomicity and fencing are proven by the disposable behavioral suite and exact installed definitions. Do not call a mutating RPC in Production to demonstrate those outcomes. Read-only catalogs cannot prove every future runtime behavior.
5. Inspect official history read-only; SQL Editor does not establish a managed migration record. Record operator-reported actual execution time/order and outcome separately, with these exact hashes. Byte identity in SQL Editor remains operator-attested unless a reliable exact-byte execution record is available. Do not infer execution time from this preflight or object existence.

## History and recovery

Foundation/Extension remain manually applied and unreconciled. The 23-entry official migration inventory ends at `20261014193039 restrict_appointments_leads_to_backend_access`; V2 is absent. This package and source remain outside `supabase/migrations`; neither is referenced by a runner. Do not run db push/reset/repair/replay or insert fabricated history. Future history reconciliation for all three manual applications requires a separately approved, truthful procedure before automated migration execution. Supabase documents that remote SQL Editor changes bypass managed history: https://supabase.com/docs/guides/deployment/database-migrations.

On an execution failure, stop and explicitly roll back any uncommitted transaction or discard its connection. Inspect whether any V2 objects committed. Transactional failure should leave no new V2 objects, but uncertain SQL Editor outcomes require metadata verification before any retry. On postcheck failure leave execution controls off and retain evidence; do not drop objects or delete order metadata automatically. After V2 enrollment, rollback requires stopping admission/processing/delivery and retaining fences; reverting to V1 is unsafe. No destructive rollback SQL is provided.

Minimum next action: obtain nonsecret read-only confirmation of deployed controls/worker inactivity, then refresh preflight and request explicit approval of the full payload hash. This is schema preparation only, not live async approval.
