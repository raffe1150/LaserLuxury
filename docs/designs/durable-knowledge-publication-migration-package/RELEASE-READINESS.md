# AI Brain V2 durable publication release readiness

**READY for a staged tenant 3 deployment with feature-flag rollback.** Validation used disposable PostgreSQL and mocked provider traffic. Returning to the legacy binary is blocked once a V2 partial or safe result exists.

## Behavior

- Complete results retain the original protocol, digest, source revision checks, task/outbox identities and delivery semantics. Independently verified partials use a distinct protocol and false completeness flag. The existing current-run publication policy must authorize the manifest. Tier B can change wording only after its independent validator passes. Mandatory notices must match exactly. Partial shapes whose notices cannot be bound to the composer still publish canonical text.
- Unavailable results use six fixed translations bound to the stored turn language in both TypeScript and SQL. They carry zero sources, false verification/completeness flags and no business claims. Failure before verification, provider overload, an expired compute window with delivery time left, and exhausted-run recovery can all use the normal final outbox. If a persisted factual result loses source authority, the guarded withdrawal records the original facts and digest and uses the safe response through the same outbox. A send that was definitively unsent can retry under its existing attempt and deadline limits. Current recipient, provider and conversation checks still apply at finalization and send.
- Tenant 3 gets four durable reservations by default even when V2 publication is selected. Its fifth reservation is a separate opt-in and is persisted at acceptance, including across duplicate intake and recovery of a prepared handoff. Recovery reuses the same financial message key regardless of run fence. Final-only recovery cannot spend or increment the run budget.
- The canary uses zero paid attempts for deterministic planning and lexical retrieval. The existing AI Money scope has no permitted query-planner or retrieval-embedding quote for this lane. Requests that need a model planner get the localized unavailable response. The Sol extraction, optional re-extraction and verification stages and the Tier B composer and validator consume up to five reservations. An admitted model request has both a lifecycle reservation and an AI Money hold. Core model reservations occur before the financial check, so a denial may conservatively count toward the ceiling. Financial settings and caps are unchanged.
- With fewer than two attempt slots, insufficient optional time, a missing owner, validator rejection, or unknown Tier B settlement, Tier B returns to the verified canonical result when that result remains current. The full unconfirmed financial exposure stays held. The existing worker limit stays at two. An opted-in provider request sheds overload instead of joining the shared provider queue, and the worker scans at most 16 durable task IDs per cycle.

## Regression gate

The supplied independent production check confirmed all six lifecycle function bodies and application-role privileges. The new intake V2 function is absent. The lifecycle fingerprint blocker is resolved.

| Identical offline command on both trees | Baseline at `9ed4b92` | Patched |
| --- | ---: | ---: |
| Native, executor and Smart Waiting failures, including parent suites | 127 | 118 |
| Cancellations | 2 | 2 |
| Full-workspace TypeScript diagnostics | 12 | 12 |

All 118 patched failures and both cancellations matched baseline by name and type. They include 53 legacy executor failures and 65 broad native failures. The native failures include 48 adapter/provider matrix cases whose mocks reject the extraction prompt on both trees. Other failures include existing routing and coverage expectations and failures that cascade from that mock. The shutdown case waits for a provider-start promise that the fixture never reaches, which also cancels its parent. The nine baseline-only failures were eight Persian/Arabic Smart Waiting fixture cases and their parent.

The TypeScript output was byte-identical:

- Six missing diagnostic imports (`TS2307`) in `scripts/knowledge-native-diagnostic-guards.test.ts:7`, `src/ai/final-three-native-reliability.integration.test.ts:7`, `src/ai/knowledge-v2-producer-native.integration.test.ts:7`, `src/ai/literal-evidence-native.integration.test.ts:5`, `src/knowledge/candidate-retrieval.postgres.test.ts:5` and `tests/helpers/controlled-trial-fixture.ts:3`.
- Two mocks missing `functionCalls` (`TS2322`) in `src/ai/booking-status-admission.integration.test.ts:198` and `src/ai/mixed-canonical-inventory.integration.test.ts:236`.
- Four `DefaultModelResult.errors` narrowing errors (`TS2339`) in `src/ai/model-routing.test.ts:10` and `src/ai/model-routing.ts:89,123,150`.

A disposable test with the baseline repository confirmed that duplicate ingress can return a historical V2 result after the original SQL rollback. The old reader rejects that result. The rollback SQL now refuses the downgrade while any retained partial or safe result exists. Before V2 publication, rollback still restores the original intake body. Its OID, argument names, argument defaults, invoker mode and ACL are unchanged across installation and rollback.

## Installation order for a separately authorized release

1. Confirm the existing lifecycle, intake, recovery and progress-safety prerequisites. Read-check the production AI Money core MD5 and SHA-256 against its manifest, confirm stage uniqueness and zero Tier B rows, and verify the existing owner, provider project and caps. Keep the proposed activation controls off.
2. In a quiet window, install lifecycle SQL first and the unchanged Tier B AI Money SQL second. Lifecycle takes exclusive DDL locks on inbox and tasks and can scan them for CHECK validation. Its rollback locks inbox, tasks and outbox exclusively. Tier B replaces one existing function with its security-definer mode, fixed search path and ACL retained. Both packages use five-second lock and thirty-second statement timeouts.
3. Ship the code in `release-files.sha256` with the flags off. Confirm V2 RPC visibility to the backend and retire every old worker before enabling tenant 3. Old workers can claim or decode V2 work in a mixed fleet. Keep spending controls unchanged.
4. After activation, roll back using flags. Stop new V2 intake, kill Tier B, keep the current reader and SQL installed, and drain existing work. Before any historical V2 result exists, the guarded lifecycle SQL can restore the exact preceding function bodies after active work drains. It retains the withdrawal audit column. A Tier B SQL downgrade also requires quiescing dispatch and settlement. Its guard refuses held rows. Unknown rows keep their full exposure but cannot settle through the old pricing body, and retained Tier B rows block reapplying the unchanged forward package. Keep the money SQL in place for ordinary operational rollback.

| Artifact | SHA-256 |
| --- | --- |
| `durable-publication-v2.sql` | `464c6d8b0f38279776dfd99a71152953a2c9b80b5e64b0af1245322c1d168dbd` |
| `rollback-durable-publication-v2.sql` | `2fee8f80c662da70671f71139e3d8bfa1f5765df6ca5d59a4d9662980865bfa4` |
| `../tierb-natural-ai-money-migration-package/tierb-natural-stages-v1.sql` | `1edd54bcd3d80d0644eb9320e21fd6896a70a6d4b359cb922262f9e2bbdc2256` |
| `../tierb-natural-ai-money-migration-package/rollback-tierb-natural-stages-v1.sql` | `16cd25c28dfac2484264b358270f2e200515747245650057651d6dd669f182e9` |

`manifest.json` lists exact function signatures and before/after body lengths, MD5 and SHA-256. The lifecycle package checks effective EXECUTE access for anon, authenticated, PUBLIC and service_role and checks security invoker in both directions. Both packages are outside automatic migration discovery.

## Proposed tenant 3 settings

Use the existing OpenAI provider project, AI Money account, approval, credentials and service-role access. Preserve the approved financial limits and model settings. Active Tier B uses Sol for composition and Luna for validation. The independent attempt opt-in can be omitted to keep four attempts.

```dotenv
AI_PROVIDER=openai
ODINLINK_ASYNC_KNOWLEDGE_ADMISSION=true
ODINLINK_ASYNC_KNOWLEDGE_ADMISSION_TENANTS=3
ODINLINK_ASYNC_KNOWLEDGE_PROCESSING=true
ODINLINK_ASYNC_KNOWLEDGE_DELIVERY=true
ODINLINK_ASYNC_KNOWLEDGE_PUBLICATION_V2=true
ODINLINK_ASYNC_KNOWLEDGE_FIVE_ATTEMPTS=true
ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS=75000
ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_TENANTS=3
ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=true
ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL=v2
ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL=source-exhaustive-v2
ODINLINK_KNOWLEDGE_NATURAL_COMPOSER=active
ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_KILL=false
ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS=3
ODINLINK_SMART_WAITING=true
ODINLINK_SMART_WAITING_DELAY_MS=5000
```

An installation with existing async tenants should preserve their admission allowlist. The five-attempt and V2 publication settings still affect tenant 3 only. Preserve `ODINLINK_AI_DEFAULT_MODEL=gpt-6.1-sol` for existing production route checks, including the re-extraction gate. Required configuration inputs include the existing `ODINLINK_AI_MONEY_ACCOUNT`, `ODINLINK_AI_MONEY_APPROVAL`, and `P2_CONVERSATION_KEY_SECRET`. Tier B retains its existing default of 20 daily starts per host and one in-flight composition. The SQL owner is the cross-host monetary authority.

## Mac PostgreSQL 17 verification

Run from the worktree root. The fixtures use Homebrew PostgreSQL 17 via `/opt/homebrew/opt/postgresql@17/bin/`, create private Unix sockets and disable TCP. The Node preloader blocks external network access.

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs \
  --import tsx --test --test-concurrency=2 --test-timeout=80000 \
  src/p2/durable-knowledge-publication.postgres.test.ts \
  src/p2/knowledge-recovery-phase2.test.ts \
  src/p2/supabase-knowledge-lifecycle-repository.postgres.test.ts \
  src/ai/tierb-natural-stages-migration.test.ts \
  src/p2/native-intake-phase1.test.ts
```

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs \
  --import tsx --test --test-timeout=165000 \
  src/p2/smart-waiting.native.integration.test.ts
```

The baseline comparison used this command on each checkout with the same Node, dependencies and Homebrew PostgreSQL version.

```sh
NODE_ENV=test AI_PROVIDER=gemini node --require ./tests/pre-p2-routing/offline-network.cjs \
  --import tsx --test --test-concurrency=2 --test-timeout=210000 \
  src/p2/knowledge-execution.integration.test.ts \
  src/p2/native-knowledge.integration.test.ts \
  src/p2/smart-waiting.native.integration.test.ts
```

## Offline results

| Suite | Results |
| --- | --- |
| Focused lifecycle, database, Tier B money, booking, worker and overload regressions | 268 passed |
| Contextual publication and Tier B natural publication | 633 passed |
| Smart Waiting through actual WhatsApp, Telegram, Instagram and Messenger adapters using fake HTTP and PostgreSQL | 42 passed |

The lifecycle PostgreSQL suite exercises exact guards in both directions, historical complete rows, pending intake restart, five model reservations with a rejected sixth, four for the default/other tenant, six fallback strings, one final delivery, stale source withdrawal before finalization, after a definitely-unsent attempt and during a competing claim, archived facts after withdrawal, ambiguous-send quarantine, and supersession. The natural-publication tests exercise complete and verified partial publication in all six languages and four channels, metered stages, approval/rejection, canonical fallback when only one slot remains, financial denial and unknown settlement. The Smart Waiting suite exercises both verified finals and safe finals after waiting in all 24 combinations of the six languages and four adapters. It also checks duplicate ingress, worker restart, delivery authority and a foreground booking that commits once.

The final gate reran 683 focused application tests and 49 disposable PostgreSQL 17.11 tests. The compared Smart Waiting suite passed 42 tests on the patched worktree, including all 24 language/channel combinations for safe finals after waiting.

`git diff --check` and the runtime file checksum verification passed. The Tier B money SQL hashes match its existing package manifest.
