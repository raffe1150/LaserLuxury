# Transaction-local Knowledge migration wrapper — LOCAL CANDIDATE, NO-GO for hosted use

No production/staging database was contacted or changed. This is not approval to run either payload. Both pinned source drafts are unchanged. Neither `.sql.payload` file is in migration discovery or referenced by an application runner.

## Exact construction

Foundation prefix, followed immediately by every byte of the pinned Foundation draft:

```sql
BEGIN;
SET LOCAL odin.approved_p2_knowledge_foundation = 'yes';
```

Extension prefix, followed immediately by every byte of the pinned extension draft:

```sql
BEGIN;
SET LOCAL odin.approved_knowledge_slice1 = 'yes';
```

No suffix, stripping, normalization, interpolation, source rewrite or BEGIN/COMMIT removal is used. The source is the complete payload suffix at byte offset 64 for Foundation and 57 for extension. PostgreSQL does not implement nested transactions: the source's BEGIN produces a warning and does not establish a second boundary. Its existing COMMIT ends the transaction and restores LOCAL settings. Its existing LOCAL 5-second lock timeout and 30-second statement timeout remain inside that same transaction. A failure before COMMIT leaves the transaction aborted; the executor must stop immediately and roll back or discard the connection. An aborted connection must never be returned to a pool without rollback.

`python3 tests/p2/knowledge-migration-wrapper.py` verifies both source pins before writing any review artifacts. It has no database execution or network capability. `manifest.json` identifies exact source/payload hashes, source offsets and lengths. Wrong pins raise before artifact generation, not after a database write.

| Artifact | SHA-256 |
|---|---|
| Original Foundation | `a2f25ecc98bb273e3e9d7eaa3449dfc890201e31f45d932503a3b0bc78e2f525` |
| Foundation full payload | `89472b7d676dfc005ec9345c3810225422f38fa688be47df6d3089e224e29b49` |
| Original extension | `564f6f88e87db9f4577b9bff174c0087dcc348ee72c06c86a2e52dd4d4c2f1fb` |
| Extension full payload | `269dfd172d21840b9f610da4697479a8176052d9faafff45e02d5210b365f038` |

## Connected migration interface and truthful history

The connected `apply_migration` interface takes `project_id`, `name`, `query`; it has no separately supplied connection-local setup context. The [public official MCP implementation](https://github.com/supabase/mcp/blob/main/packages/mcp-server-supabase/src/platform/api-platform.ts) forwards `{name, query}` to `POST /v1/projects/{ref}/database/migrations`. It reports API failure but does not itself establish database transaction/history ordering. The [Management API reference](https://supabase.com/docs/reference/api/v1-apply-a-migration) documents the payload fields, not the server's explicit-COMMIT and history-write transaction contract. Public source inspection is not proof of the connected hosted deployment's implementation/version.

A truthful future submission would use a name explicitly identifying a wrapper (for example `foundation_wrapped_v1` / `extension_wrapped_v1`) and submit the **entire `.sql.payload` content**. Its history/audit must not claim the source draft alone was submitted. Preserve both source and payload hashes and actual application order. Never rename/move the pinned files or stamp old versions as if their raw files were applied. If the history API normalizes SQL or cannot retain the exact full payload, that limitation needs a separately reviewed audit representation; do not silently equate normalized statements with identical bytes.

Local MODEL tests prove a history row can store the entire payload byte-for-byte and show Foundation then extension order. They model inserting that row before executing the payload in the same transaction. A failed source then rolls back both history and schema; a successful source commits both. These tests do not prove Supabase's hosted manager follows that ordering.

## Confirmed remaining blocker

A second real-PostgreSQL MODEL simulates a manager which begins a transaction, executes the payload, and then writes history. The pinned source's COMMIT ends that manager's transaction. A forced history insert failure afterward leaves **four committed Foundation tables and zero history rows**, despite an overall error. An outer BEGIN alone does not protect against this.

This is a tested PostgreSQL counterexample, **not a claim that Supabase implements that model**. The supplied interface and published implementation/reference do not resolve which model the hosted endpoint uses, whether it permits the nested-BEGIN warning, or its exact history-content preservation. No safely auditable hosted execution path is established yet. Neither dropping the original transaction controls nor using session-global approval settings is an acceptable workaround.

**NO-GO for production application through the connected migration tool until its explicit-transaction/history contract is established.** A separate, explicitly approved disposable Supabase Management API probe (success, source failure, and forced history-write failure) or an authoritative provider contract is required. No existing project may be used as an experiment; no disposable hosted service is created in this task.

## Disposable validation

Run `PYTHONDONTWRITEBYTECODE=1 python3 tests/p2/knowledge-migration-wrapper.test.py`.

All **29 tests pass** on PostgreSQL 17.11 in the existing private local-cluster harness: the original 22 SQL contract scenarios are inherited unchanged and run against the wrapped migrations, plus seven wrapper/history scenarios. These cover exact suffix preservation and hash rejection, commit restoration of prior approval/timeout values, stop-on-error rollback, rerun refusal, exact full-payload history roundtrip/order, the unsafe late-history counterexample, and same-backend rollback recovery using installed libpq. The persistent connection test confirms aborted transaction state, explicit ROLLBACK, restored prior settings and absence of ghost history/schema. No new dependency was installed.

Schema-only pg_dump output (including functions, ACLs, RLS and constraints) matches an independently built reference database using the original validated execution. Only pg_dump's random `\\restrict`/`\\unrestrict` control-token lines are omitted from comparison. Normalized schema SHA-256: `f8c7331facbc48a028afa1c95f191b2a02fb84093d03dc1a846b83c15a6b1380`. Existing Booking fingerprints and the local Booking claim/settlement smoke test remain unchanged. The clean PostgreSQL restart/attempt/expiry scenarios are inherited unchanged. Local PostgreSQL 17.11 is not hosted 17.6, and no Supabase gateway/JWT behavior is tested.

## Future procedure — conditional, not authorized or currently ready

1. First establish the hosted endpoint's explicit-COMMIT, stop-on-error, warning and history-content/transaction behavior in a separately approved disposable setting. Resolve the late-history counterexample; retain its actual results, not a fake manager's outcome.
2. Obtain new production authorization for the **full payload hashes above**, exact target and truthful history representation. The previous source-only authorization does not authorize these different payloads.
3. Immediately before each write, reconfirm the project/database identity, both source and payload hashes, expected absent/installed schema stage, idle/no-blocking conditions and scoped Booking fingerprints. Keep runner/admission/dispatch disabled.
4. Submit Foundation's full payload once via the approved history-recording path. Preserve the original SQL and timeouts. Verify schema, valid scoped constraints/indexes, empty tables, RLS/effective privilege denial and unchanged Booking metadata; read back and verify its actual history before proceeding.
5. Only after every Foundation gate passes, submit extension's full payload once and repeat lifecycle/schema/permission/empty-table/Booking/history checks. Record actual application order, not original filename sorting (the extension's source timestamp sorts first).
6. On any error or uncertain history state, stop, roll back an uncommitted transaction and inspect committed schema/history read-only. Never blindly retry or falsely repair history. If Foundation is committed, leave it empty/inactive until separately approved recovery. Do not automatically drop objects, alter Booking or activate work.

Until step 1 passes, this is a candidate procedure only. The smallest next action is approval of a disposable hosted-interface compatibility probe; no production application is recommended.
