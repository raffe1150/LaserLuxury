# Sol semantic validation final safety review

**HOLD for live execution.** The rehearsal now enforces a count for the exact wire bytes and continuously checks ownership of the shared ledger lock at write boundaries. Live execution remains blocked because there is no verified local Sol counter for the complete billed request, and legacy workers can spend against the experimental credential outside the shared lock. Actual project eligibility is also unverified.

The starting HEAD was `30b6097f7906c828666aa2c0fa2144819a372735` with a clean tracked tree. The runner, helper and evaluation artifacts were already untracked. The existing manifest and approval proposal remain intact. This review supersedes the proposal's description of the former byte-length screen.

## Input admission

The runner removed the byte-length proxy. Before any reservation it requires a positive safe-integer count bound to both the exact wire SHA-256 and model. The wire includes the full instructions, current turn, redacted context, JSON format and billing settings. Missing or mismatched evidence fails closed. At 16,000 the guarded simulation is admitted. At 16,001 it is rejected before either a hold or transport call. It checks the billed input in the receipt against that same bound and enforces 1,600 total output tokens, including reasoning. No automatic truncation or extra calls are used.

The only count accepted by the current entry point is explicitly simulated. The rehearsal accepts protected files under a dedicated temporary directory only. There is no production credential transmission or installed provider transport. An exact count of message text alone would omit provider-side formatting and other billed input. OpenAI documents exact counting via a separate [Responses input-token endpoint](https://developers.openai.com/api/docs/guides/token-counting). This task prohibited that call and the proposed validation allows only 18 provider requests, so no counting call was made. A verified local tokenizer with full wire framing, or a justified provider-backed upper bound for every dynamic request, is still necessary for a one-request-per-turn run.

## Ledger and exclusion

The canonical primary ledger resolves through the answer-recovery worktree link to the shared audit worktree file. Its 426-row prefix is intact. The separate resumed ledger is counted once, plus the documented $0.00000780 probe.

| Pin or amount | Current verified local value |
| --- | --- |
| Primary SHA-256 | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Historical 426-row JSON prefix SHA-256 | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed SHA-256 | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Manifest SHA-256 | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Reserved before validation | $2.76992243 |
| Remaining under $4.00 | $1.23007757 |
| Proposed request and run exposure | $0.056 × 18 = $1.008 |
| Remaining after full run reservation | $0.22207757 |

The compatible writer uses one canonical lock for either known ledger. It retains the exclusive-create descriptor, checks the lock's filesystem identity before replacing a ledger and immediately before invoking the simulator, and leaves a replacement writer's lock alone. Hash drift on either ledger blocks settlement. Duplicate request IDs and reuse of a run authorization are blocked. Even after a lock is lost, a persisted hold remains. Tests verified same-directory writer contention, alias rejection, lock replacement, and companion-ledger drift.

This remains a cooperative lock. `scripts/shared-core-real-provider.ts` and `scripts/knowledge-four-case-provider-gate.ts` have direct ledger writes, and `scripts/knowledge-aen-single-provider.ts` can read the experimental key. The process-local owner cannot exclude those programs or a separate process with credential access. Do not enable execution until all processes authorized to use the credential must go through one reserving boundary. This may require isolating or rotating the credential and granting it only to that boundary. A convention to pause writers is insufficient evidence by itself.

## Rehearsal and legacy controls

All seven runner tests passed. The complete 18-turn rehearsal also ran on protected temporary byte copies of both canonical ledgers, using per-wire simulated counts and synthetic credentials. It recorded 18 exact request hashes, appended 36 rows to the copy of the primary ledger, preserved all 426 historical rows and left the original hashes unchanged. Responses were scripted to exercise the admission and grading path. They do not establish model quality.

The combined targeted run reported 81 passed and 10 failed. The ten legacy failures still stop before mock transport: the Persian incident fixture accepts extraction, then rejects a unit as contradicted and falls back with `INVALID_COVERAGE`. Its historical planner expects an extraction-stage trigger and a publishable result. This is outside the semantic-only runner. Separately, the old transport's settlement ordering is unsuitable because it can settle before checking provider identity. No production verification rule or fixture expectation was relaxed. The new controls directly exercise reservation before dispatch, exact input/output limits, timeout and late completion, invalid identity and usage, duplicate execution, cross-writer contention, budget and credential checks, and prefix preservation. The TypeScript output matches the prior baseline with 12 errors across 10 files.

## Requirements for separate owner approval

Use one short-lived, single-use authorization for the manifest and source pins in the runner, the current canonical ledger paths, both hashes and the historical prefix, the verified experimental project and credential identity, the documented probe carry, and the exact standard-rate wire settings. Its ceiling must remain $4.00 cumulative, $0.15 per request and $1.008 for the 18 listed interpretation requests. Allow zero retries, fallbacks, extra calls, customer writes or booking operations. Revalidate within the exclusive credential and writer boundary before reserving anything. Keep full exposure on timeout, access errors, identity mismatch or unverifiable usage.

The [Sol model card](https://developers.openai.com/api/docs/models/gpt-6.1-sol) confirms Responses support. The local credential matched project `proj_FyeEDfyaHLfKjmWj4hZHoU2z` by file permissions and fingerprint. No key was displayed and no eligibility probe was made. Project access must be confirmed through approved non-dispatch evidence, and a future access error must stop the run and retain the hold.

## Files changed

- `scripts/sol-semantic-runner.ts` adds the source pins and fail-closed simulated input admission.
- `scripts/sol-semantic-runner.test.ts` adds admission boundaries and lost-lock/ledger-drift controls.
- `tests/helpers/semantic-recovery-experiment.ts` checks shared lock ownership and duplicate request identities.
- `docs/validation/brain-v2-sol-readiness/FINAL-SAFETY-CLOSURE.md` records this review.
