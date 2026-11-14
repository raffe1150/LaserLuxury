# Sol semantic runner dependency isolation

**GO to commit the isolated runner for offline use. HOLD for live execution.**

At HEAD `30b6097f7906c828666aa2c0fa2144819a372735`, the runner imported `ExperimentLedger`, `actualUsd`, `ENDPOINT`, `loadCredential` and the `LedgerPins` type from the historical recovery helper. The focused tests also imported `pinsFromCurrent`. Those imports loaded recovery planning and fixture modules. The runner's Phase 4 context import independently loaded the evidence fixture module, which reads the source inventory at import time.

The shared accounting module now owns these APIs, plus the existing experiment limits. Its only imports are Node's filesystem, crypto and path modules. The runner uses the same fictional context values locally. The historical experiment file remains in place with its original public API. Its generic definitions were moved to the shared module and re-exported so there is one ledger implementation. Its planning, dispatch and settlement call order, and the historical fixtures, were left as they were. Runtime assertions verified identity of the shared and historical exports, including the ledger constructor.

An esbuild bundle dependency walk found one source file for the accounting helper, 16 for the runner, and 17 for the test entry. The runner closure contains no historical test helpers, Phase 4 evidence fixtures, or third-party packages. Its remaining local imports are the semantic parser, adapter, TurnFrame reducer and their shared language and booking utilities.

To verify clean-source reproducibility, a temporary tree was populated from a Git archive of the pinned HEAD. Only the three runner source files and the existing pinned manifest were overlaid. The installed Node dependencies were linked as the test toolchain. The historical helper, historical re-extraction plan and untracked current-source fixture were absent. With the network-denying preload, all seven runner tests passed in that tree and in the original worktree. The seven include the full 18-turn rehearsal, with the exact request hash and $0.056 reservation checked for every call, along with input limits, invalid receipts, timeouts, duplicate approval, shared lock contention and historical prefix preservation. Two additional targeted checks passed for the existing ledger writer and disabled Tier 3 dispatch. Full compiler diagnostics matched the previous log byte for byte with 12 existing errors across 10 files.

The manifest SHA-256 remains `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d`. The historical ledger hashes remain `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` and `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070`. The rehearsal used simulated token counts and synthetic credentials. Live eligibility, full-wire token proof and exclusion of writers outside the shared accounting boundary remain open.

Files for this change:

- Added `scripts/experiment-accounting.ts`.
- Modified `scripts/sol-semantic-runner.ts` and `scripts/sol-semantic-runner.test.ts`.
- Modified `tests/helpers/semantic-recovery-experiment.ts` only to extract the shared definitions and keep compatibility imports and re-exports.
- Added this report. The pre-existing manifest is required when packaging the runner.
