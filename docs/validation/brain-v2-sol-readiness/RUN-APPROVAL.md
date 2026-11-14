# Proposed Sol semantic run for owner review

**Status: HOLD. Execution approval has not been issued.** This document pins the proposed scope and cost. No provider transport or live execution path is installed. The offline runner uses only protected temporary ledgers and an injected simulator.

| Approval field | Pinned value |
| --- | --- |
| Baseline | `30b6097f7906c828666aa2c0fa2144819a372735`, clean tracked tree at entry |
| Manifest SHA-256 | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Provider and project | OpenAI Responses, `gpt-6.1-sol`, `proj_FyeEDfyaHLfKjmWj4hZHoU2z` |
| Primary ledger SHA-256 | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Primary 426-row prefix SHA-256 | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Separate resumed ledger SHA-256 | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Separate documented probe outside ledger | `$0.00000780` |
| Proposed request count | 18 maximum, one per listed turn, zero retries, fallbacks or extra calls |
| Maximum exposure | $0.056 per request and $1.008 for the run. Owner limits are $0.15 per request and $4.00 cumulative |
| Authorization ID, issuer, issue time and expiry | Pending separate owner approval after blockers are resolved |

The primary and resumed files are `source-aware-usage.json` and `budget-resumed-usage.json` under `/Users/raffe/.codex/worktrees/shared-knowledge-core-audit/OdinLink/docs/validation/shared-core-2026-10-22/`. The other worktree path resolves to the same primary file. The known local total is $2.43327206 + $0.33664257 + $0.00000780 = **$2.76992243**, leaving **$1.23007757**. The full approved scope would bring this to $3.77792243 and leave $0.22207757. Reconcile and re-pin the ledgers at any future execution. Do not reuse this snapshot as an authorization.

Public [model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) confirms Responses support. OpenAI's [standard pricing](https://developers.openai.com/api/docs/pricing) lists $2 input, $0.10 cache reads, $2.50 30-minute cache writes, $5 12-hour writes, and $10 output per million. The proposed wire fixes default tier, 30-minute cache, and 1,600 total output tokens. The [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create) confirms the output limit includes reasoning. The reserve uses 16,000 × $2.50/M plus 1,600 × $10/M. It depends on the selected tier and cache policy. Local credential owner, modes, key fingerprint and configured project match were checked without displaying the key. Actual project eligibility and billed tier were not tested with a provider.

## Scope and scoring

The manifest embeds independent fictional-turn labels and per-row SHA-256 digests. Counts are Swedish 3, English 3, German 2, Spanish 4, Persian 3 and Arabic 3. It includes multipart and conditional questions, reference resolution, booking correction, modality, negation, false premises, language continuity and closure. Only the current turn and redacted prior goal summaries reach the simulated transport. Labels remain local. Later request bytes depend on the earlier output and therefore cannot be precomputed. Approval pins the ordered turn recipes and instruction hash. Before each simulated call, the ledger durably records the hash of the exact generated wire body. Grading records exact normalized readings and unexpected handoff guidance. It excludes scripted output from genuine accuracy. A real run should adjudicate semantically equivalent span boundaries and reference index changes caused by earlier model mistakes.

## Verified locally and blockers

- The shared writer canonicalizes aliases, rejects duplicate ledger identities, and uses one lock within the shared ledger directory regardless of which ledger a compatible writer selects. It checks the historical prefix and current hashes, fsyncs the replacement and parent directory, and rejects settlement above the reserve. The rehearsal keeps a full hold on timeout, status or identity mismatch, duplicate response ID, unverified usage, and invalid interpretation. No late result can settle a timed-out reservation. Test ledgers and synthetic credentials are confined to a temporary directory.
- Historical scripts can still write directly or use other conventions. A lock file cannot exclude such writers. Before execution, require exclusive access to both ledgers through one canonical writer, pause or disable bypass writers, and pin the starting hashes under that lock. No historic records should be copied into a second spending authority or released without verified settlement.
- The request size check uses serialized UTF-8 length plus 2,048 as a conservative local screen. The public endpoint documents an output limit but this screen is not a provider input-token guarantee. Before enabling any transport, prove an exact or contractual pre-send input bound of 16,000 for the complete wire and framing without adding a provider request. Verify project eligibility through approved non-paid evidence. Bind transport endpoint, response project and credential fingerprint to the approval. Keep the execution feature blocked if any requirement is unresolved.
- Ten legacy tests fail because their Persian recovery planner expects a publishable replacement. Current replay accepts extraction, rejects one unit as contradicted at verification, and falls back with invalid coverage. Its old recovery trigger expects extraction-stage rejection and reports `REJECTION_COUNT`. The tests fail before their intended simulated dispatch checks. No production gate was relaxed. Separately, the older dispatch helper settles usage before checking response identity, so that path cannot be reused unchanged for semantic execution. The semantic rehearsal validates identity, usage and output before settling and reuses the shared ledger and credential reader.
- No live provider client, tools, booking logic, production configuration, database writes or delivery path are present in the rehearsal. The public documentation lookup made no inference request.

## Reproduction and files

Run the new tests with the network-denying preload.

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test scripts/sol-semantic-runner.test.ts
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx scripts/sol-semantic-manifest.ts /tmp/sol-semantic-manifest-reproduced.json
cmp /tmp/sol-semantic-manifest-reproduced.json docs/validation/brain-v2-sol-readiness/manifest.json
```

Added `scripts/sol-semantic-runner.ts`, `scripts/sol-semantic-runner.test.ts`, `scripts/sol-semantic-manifest.ts`, `docs/validation/brain-v2-sol-readiness/manifest.json`, and this approval proposal. Modified the existing experimental `tests/helpers/semantic-recovery-experiment.ts` writer. No historical ledger or production file changed.
