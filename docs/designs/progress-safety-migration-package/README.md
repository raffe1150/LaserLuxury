# Progress Safety V1 — manual installation review package

Prepared 2026-10-19. NOT APPLIED. No feature activation. This package is outside automatic migration discovery. Separate explicit installation authorization remains required.

## Exact payload

`progress-safety-v1.sql`: 9,064 bytes; SHA-256
`a79756b1878b5709117dcd3f2e7f508b9ba77ff2a435187c6776315b655912f2`.

The first 69 bytes establish `BEGIN;` and transaction-local `odin.approved_knowledge_progress_safety_v1 = 'yes'`. All remaining 8,995 bytes are the unchanged source draft, SHA-256 `d93ee49ec845dcef99abc8e0f5e663b04b32a4338dc83809f85720e394aa8b04`. `build.py` refuses a mismatched source. It is a local packaging tool, not an installer.

The source's BEGIN inside the existing transaction produces an expected “already a transaction in progress” warning on PostgreSQL. There is one effective transaction; the source COMMIT ends it. Its 5-second lock timeout and 30-second statement timeout remain LOCAL. Successful completion restores prior settings. On error, stop; roll back/discard the failed session. Never execute selected fragments or continue past errors. Never remove guards.

## Read-only Production preflight

Confirmed through project API: Odinlink, `blknxpoeaqrvvdhixrau`, eu-west-1, ACTIVE_HEALTHY, host `db.blknxpoeaqrvvdhixrau.supabase.co`. SQL snapshot at 2026-10-19 19:29:11 UTC: PostgreSQL 17.6, database postgres. `production-before.json` and `preflight-checks.json` retain scoped metadata only.

Foundation/Slice 1/V2 are installed: all six existing function bodies match source exactly; all are invoker/service-only. Four P2 tables exist, are empty, have RLS, no client CRUD or policies, and service-role CRUD. Constraints and indexes valid. Progress functions and trigger absent. No other active transactions were visible; captured P2 AccessShare locks belonged to the snapshot itself. This is a point-in-time observation, not a future lock guarantee.

Official migration history still has 23 entries, latest `20261014193039 restrict_appointments_leads_to_backend_access`; manually applied prerequisite DDL is not reconciled. Do not run migration tooling that could replay it or fabricate history. This package does not write history. A later human-readable application record must distinguish operator-attested submitted bytes from independently observed schema, and use actual execution times.

## Separately authorized execution precautions

1. Reconfirm project ref/name/host in SQL Editor and independently verify connected target. Refresh the read-only snapshot, compare prerequisite definitions and ensure all P2 rows remain zero. Reconfirm no async admission, processing, delivery or Smart Waiting is active. Earlier operator reports are not independent runtime proof; legacy P2 flags must not be assumed inactive from their names alone.
2. Recalculate both hashes and verify the entire payload is selected. Preserve original source and prior migrations. Obtain separate application authorization.
3. Use a quiet maintenance window. CREATE TRIGGER takes a lock on odin_outbox; schema/function creation also locks catalogs. Not lock-free. Do not run if unknown active task/worker activity or competing DDL exists.
4. Run the complete file once through SQL Editor, on one connection. No managed migration API or history repair. SQL Editor must stop on error. Never retry blindly after timeout or ambiguous UI outcome: inspect schema read-only first.
5. Keep features off. No mutating RPC tests, task inserts or channel sends in Production.

The bundled PostgreSQL tests prove SQL transactional behavior on 17.11, not hosted SQL Editor UI failure handling on 17.6. No version-specific newer PostgreSQL feature is required. SQL Editor byte identity remains operator-attested unless independently captured.

## Read-only post-installation gates

Run all of `post-installation-snapshot.sql` (SELECT only), save the returned `snapshot` JSON object, then locally run:

```
python3 docs/designs/progress-safety-migration-package/verify_post_installation.py /absolute/path/snapshot.json
```

The comparator requires exactly the two new invoker/service-only functions with exact source bodies and fixed search_path, exactly the enabled outbox guard trigger, unchanged existing function definitions/ACLs, tables, columns, constraints, indexes, RLS/policies, scoped Booking metadata and empty counts. It compares against this preflight; refresh and separately review if time has passed or unrelated changes occurred. Postchecks must also show no unexpected activity. Do not invoke operational RPCs.

Stop on any mismatch. Before COMMIT, errors roll back the transaction. After a successful COMMIT, do not automatically drop functions/trigger or revert schema; leave all controls off, capture evidence, and separately approve recovery. Removing the trigger would restore the unsafe legacy progress-claim path, so application rollback alone is preferable while retaining this additive protection.

## Offline evidence

`validate.py` uses private disposable PostgreSQL with no TCP/customer database access. It reuses the existing progress/ordered/Foundation/Booking tests, applies the exact wrapper, compares full normalized public schema/ACL/RLS against raw-source installation, and tests local-setting restoration, pre-COMMIT rollback, rerun rejection, hash mismatch refusal and the read-only postchecker. `disposable-tests.log` records exact results: 57 tests passed on disposable PostgreSQL 17.11, zero failures. `git diff --check` passed; all 884 captured pre-existing file hashes remained unchanged. TypeScript was not rerun because no TypeScript files changed.

No application source, existing tests or pinned SQL was changed. No production/staging writes or runtime controls were used. Package readiness is GO for separate migration review; installation and Smart Waiting activation remain separate approvals.
