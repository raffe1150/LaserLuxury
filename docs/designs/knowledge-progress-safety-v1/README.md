# Atomic Knowledge progress safety v1 — UNAPPLIED DRAFT

## Contract

This bounded additive contract fixes progress claims, not Smart Waiting presentation or transport. It adds only:

- `odin_claim_knowledge_progress_v1(bigint,uuid,uuid,text,text,text,text,bigint,text,jsonb,integer)`.
- `odin_guard_knowledge_progress_dispatch_v1()` and its BEFORE INSERT/UPDATE trigger on `odin_outbox`.

No existing function is replaced, no pinned migration is edited, and no table, column, queue, index or client policy is added. It reuses the existing progress/final unique key, attempt/fence/lease fields and bounded `artifact.progress_execution_v1` metadata. No token, raw recipient, message history or factual evidence is stored in that metadata. The task's original acceptance, expiry, attempts and result are never rewritten by the new RPC.

Claims lock **conversation → task → progress outbox**, matching the existing transition RPC. A claim requires an active Ordered V2 conversation, current tenant/channel/account/key and sequence, RUNNING processing state, no verified result, current processing owner/fence, live processing lease, original task expiry and a persisted processing checkpoint. A fresh progress-purpose receipt must match the current binding MAC stored in the conversation. Unknown/stale/terminal scope returns no claim. Text is server-controlled, at most 240 characters; an existing progress row's text cannot silently change on a retry.

The outbox guard applies to legacy as well as new RPC transitions into progress SENDING. VERIFIED/FINALIZED/terminal tasks cannot obtain progress dispatch ownership through the old claim path. Direct privileged outbox updates are not a supported dispatch API: backend operators remain trusted and must use the RPC lock order. The trigger does not read/lock task rows for final or generic non-progress outbox operations.

A live SENDING progress item cannot be reclaimed. An expired SENDING lease becomes UNCERTAIN when a valid recovering execution attempts a new progress claim; existing recovery/settlement also retains its quarantine behavior. API_ACCEPTED/SENT and UNCERTAIN cannot be retried. Only bounded definitively-unsent retries while the task is still RUNNING may reacquire the same progress identity. Retry attempts and original expiry survive restart and processing-lease takeover.

## Separate trusted authority adapter

`src/p2/knowledge-progress-authority.ts` exports `NativeKnowledgeProgressAuthority` with `claim`, `dispatchTarget` and `settle`. It is not imported into application startup/native handling. Without an explicit trusted server `enabled` callback returning true, claim/dispatch do no work. No environment variable, scheduler or transport is added.

The adapter reloads the real scoped task; verifies RUNNING state, processing token/fence/lease and checkpoint; resolves the existing HMAC-signed recipient binding and current tenant-owned connection; runs the existing channel-specific eligibility checks; then rereads ownership, binding and connection before issuing a private `knowledge-progress-v1` receipt. SQL checks the scope, processing fence, expiry and binding MAC atomically again. Its reader/settlement repository is deliberately instantiated with final authority always false. No final-verification receipt is reused or weakened. Final source-revision/completeness authorization code remains byte-identical.

`dispatchTarget` rechecks current recipient/provider eligibility, outbox lease/fence/text and active processing immediately before a future transport use. It never sends. `settle` accepts only the same scoped progress identity and delegates to unchanged fenced settlement. Turning optional waiting off does not suppress factual settlement of an operation already begun. Valid in-flight outcomes may settle after finalization; stale/expired lease settlement is rejected and remains subject to UNCERTAIN recovery, never blind retry.

Provider reads receive a one-second abort signal. This is not a promise that every SDK/database read is physically cancellable or completes in one second. No provider check/model call occurs inside the claim transaction. Future waiting orchestration must run independently and must not await optional progress from the final-answer path. No current runner or finalization path awaits this adapter.

## Final-answer priority and unavoidable delivery limit

Finalization does not wait for the progress send lease, provider response or a waiting-model call. It uses the existing short transactional row locks; these can briefly serialize with a progress claim. This is not a claim of lock-free execution. Concurrent finalization/claim tests establish either a valid pre-verification progress claim or rejection after the task advances. The five-second progress lease does not hold a database lock for five seconds.

The RPC grants local fenced ownership; it cannot recall a provider request already transmitted before finalization/supersession. Such an operation may be accepted/displayed later and must be settled factually within the existing valid settlement lease. No physical external arrival order or exactly-once customer receipt is promised. No new progress claim is allowed after verification or finalization. This distinction must remain explicit in Smart Waiting.

## Migration review, compatibility and rollback

Source draft: `progress-safety-v1.sql.draft`. SHA-256 and byte size are recorded in `manifest.json`. It is outside `supabase/migrations` and is neither discoverable by automatic migration replay nor invoked by application code.

Required creation order: already-installed Foundation → Slice 1 → Ordered V2 → separately approved progress safety draft. Never replay prerequisites or repair their unreconciled manual history implicitly. The draft checks required signatures and refuses conflicts/reruns. It uses BEGIN/COMMIT, LOCAL 5-second lock and 30-second statement timeouts, and requires transaction-local `odin.approved_knowledge_progress_safety_v1=yes`. No executable SQL Editor approval wrapper or production authorization is supplied in this slice.

Both new functions are SECURITY INVOKER, fixed search_path, PUBLIC/anon/authenticated EXECUTE revoked, service_role EXECUTE granted. Existing table RLS/ACLs and function bodies/privileges are unchanged. Service credentials remain trusted; SQL cannot independently verify remote platform permissions or HMAC secrets and relies on the trusted server bridge for those fresh attestations.

Tested on private PostgreSQL 17.11. Uses core PostgreSQL 17 constructs compatible in principle with 17.6; hosted schema/role/schema-cache compatibility needs a separate read-only preflight before application. Capture exact existing function/ACL/constraint/security fingerprints, no conflicting guard, known task/outbox state and quiet locks. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the P2 outbox and can briefly block its writers; this does not touch the separate Booking outbox. See [PostgreSQL locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [Supabase functions](https://supabase.com/docs/guides/database/functions).

Rollback before application: remove only this slice's new files if desired. After a future separately approved installation: stop/disable optional progress claim/dispatch first and preserve outcomes; leave the additive guard installed while final-only operation continues. Do not automatically drop a guard or weaken claim predicates to restore unsafe retries. No destructive rollback SQL, production migration-history operation or activation is provided.

## Validation and next step

See `../../validation/progress-safety-v1-2026-10-19/README.md` for results and isolated patch. Original gap reproduced on unchanged prerequisites; corrected SQL passes concurrency, retry, restart, finalization, settlement, tenant, privilege, rollback and unchanged Booking/final tests.

**GO for separate migration review only.** NO-GO for production application or live Smart Waiting in this task. Next implement the small default-disabled waiting coordinator/presentation after review of this prerequisite, keeping source-current verified final publication independent and testing actual native handoffs. No broad framework, calendar/Booking change or new platform activity adapter is part of this correction.
