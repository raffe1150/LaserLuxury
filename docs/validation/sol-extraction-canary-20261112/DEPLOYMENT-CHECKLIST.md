# Sol extraction canary: deployment dependency checklist

Status: implementation complete locally and NOT enabled. The database migration is ALREADY APPLIED to production Supabase project `blknxpoeaqrvvdhixrau` (migration-history version `20261112123601`, SQL SHA-256 `e3ae5e1ebbdbea474c2bb2d92f6bbd9d63c5be84f53cc72f2a38283e2adf1cc2`, post-apply `md5(prosrc)`: `transition_core_v2` = `e54c7052fd6ad27b10983d7d78cda9b4`, `trial_transition` = `d3843e85695b84cbf92c8d48e48a5a78`). It must NOT be applied, repaired or replayed again. The application code is not yet committed or deployed, and no flag or budget authority is configured.

## What ships

| Piece | Effect when the flags are OFF (default) |
|---|---|
| Migration `20261112123601_knowledge_re_extraction_stage.sql` (ALREADY APPLIED in production) | Adds the stage name `re_extraction` to two allowlists. Changes no data or limits and grants no new privilege. The local filename matches the production migration-history version, so `supabase db push` treats it as applied. Re-running it would abort on its own guard (expected pre-apply hashes `8560…`/`091d…`, production now has `e54c…`/`d384…`) without changing anything. |
| Profile `sol-extraction-v1` (`knowledge-model-policy.ts`) | Never selected. `captureKnowledgeModelProfile` returns the same default object as before. |
| One-shot re-extraction (`business-information-answer-plan.ts`) | Inactive: the host passes no `reExtraction` hook. |
| Shadow and telemetry (`sol-extraction-canary.ts`, `server.ts`) | Never scheduled and nothing emitted. |

## Migration review checks (completed before the production apply)

1. The migration is forward-only and replaces exactly two function bodies:
   - `ai_money.transition_core_v2`: the `re_extraction` stage is added to the Sol stage allowlist and to the trial knowledge-stage allowlist (2 lines).
   - `ai_money.trial_transition`: a knowledge case may carry either the existing four stage caps or the same four plus `re_extraction` (1 line becomes 2).
2. A precondition guard aborts the whole transaction (`ai_money_re_extraction_unexpected_function_body`) unless the deployed bodies have these hashes:
   - `transition_core_v2`: `md5(prosrc) = 8560db6ba67fbc9792b2b63326d9712d`
   - `trial_transition`: `md5(prosrc) = 091dc2a4bf5d34dce43229ca65835ac8`

   These are the `20261029082649` bodies. If production was hotfixed out of band, the migration refuses to run.
3. It also asserts that `UNIQUE (account_id, business_id, request_key, stage)` still exists on `ai_money.reservations`. This constraint is the invariant that allows only one `re_extraction` per message.
4. The following are unchanged:
   - All tables, counters and caps: account, period, tenant, tenant-period and the per-message `turn` bucket.
   - Rates, the reservation envelope, receipt validation, settle/unknown handling, append-only events, `security definer`, `search_path` and grants.

## Required order (when separately approved)

1. DONE: migration reviewed and applied to production (`blknxpoeaqrvvdhixrau`, version `20261112123601`). Do not apply, repair or replay it. Before any future `supabase db push`, run `supabase migration list` (read-only) and confirm local and remote histories match.
2. DONE: the local file is named `20261112123601_knowledge_re_extraction_stage.sql` to match production history. The migration tests (`src/ai/re-extraction-stage-migration.test.ts`) run only against a disposable local database.
3. Deploy the application code. The Sol flags stay OFF, so no Sol request is possible. One intended Luna change ships with this code: the fail-closed `QUANTITY_NOT_IN_CITATION` gate (approved), which can only reject a unit whose own citation lacks a quantity it states.
4. Financial authority (separate approval):
   - Set `ODINLINK_AI_MONEY_ACCOUNT` and `ODINLINK_AI_MONEY_APPROVAL`.
   - Set up the operator, period, entitlement and plan rows.
   - Size the per-message `turn_nano_usd` for at least two worst-case Sol requests (extraction + re_extraction). Verification stays on Luna, outside the Sol owner. One worst-case Sol request = (inputProxy × 2,500 + 81,920,000) nanoUSD. For the recorded incident requests (~18 KB wire) that is about $0.13 each, so the per-message turn cap needs at least ~$0.27 (extraction + re_extraction), with headroom for larger inventories.
   - The `request_nano_usd` cap must be at least one worst-case request (≥ ~$0.14 for the incident inventory). Actual recorded Sol costs were far lower than this ceiling.
5. Keep `ODINLINK_KNOWLEDGE_MODEL_PROFILE` unset or `off`.
   - Any other value makes the source-exhaustive verifier throw for every tenant.
   - It also forces the canary OFF.
6. Shadow first:
   - Set `ODINLINK_SOL_EXTRACTION_MODE=shadow` and `ODINLINK_SOL_EXTRACTION_TENANT_IDS=3`.
   - Allowed values: positive integers, at most 10 entries. Anything else is OFF.
   - Prerequisite for an eligible turn: `ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL=source-exhaustive-v2`, the accuracy-first timing allowlist covers the tenant, and the turn is a native foreground Knowledge document question.
7. Active only after a separate GO: `ODINLINK_SOL_EXTRACTION_MODE=active`.

## Rollback behaviour

- **Flags:** set `ODINLINK_SOL_EXTRACTION_MODE=off`, or remove the tenant from the allowlist.
  - New turns immediately use the unchanged Luna path.
  - A turn already running on Sol finishes on Sol. Its re-extraction is skipped at the final pre-dispatch check (`flag_disabled`), and there is never a mid-turn model switch.
- **Code:** reverting the application code leaves any `re_extraction` reservations in the database. They remain counted.
- **Code rollback:** redeploy the previous commit (`b7a9889`). The applied migration stays; it is inert for code that never sends `re_extraction`.
- **Migration:** `docs/validation/sol-extraction-canary-20261112/rollback-re-extraction-stage.sql` is a review draft that restores the exact previous bodies (tested). It is not needed for a code rollback and must not be run without a separate decision.
  - After a rollback, any `re_extraction` hold that is still held or unknown can no longer be settled. Its full maximum stays reserved: over-counting is fail-safe, never a release.
  - Drain or settle those holds before rolling back where possible.
- **Owner:** an unavailable budget owner means new turns fall back to Luna before the turn starts (`budget_owner_unavailable`). A turn that already selected Sol fails closed.

## Telemetry (content-free)

Each eligible canary turn emits one `[SolExtractionCanary]` line (`schema: sol-extraction-canary-v1`) containing:

- mode, tenant id, channel, language tag and profile;
- the pre-turn fallback reason;
- per stage: model, duration, success and actual Sol cost in nanoUSD;
- extraction rejection-reason counts;
- the re-extraction trigger, outcome and skip/failure reason, with first-pass and replacement counts;
- the publication outcome (`published`, `safe_fallback` or `never_published` for shadow).

No question text, evidence, quotation, unit text, reply, recipient or credential is ever included.
