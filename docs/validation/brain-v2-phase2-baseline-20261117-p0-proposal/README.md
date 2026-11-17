# Brain V2 Phase 2 oracle baseline — P0 proposal (2026-11-17)

**Status: PROPOSAL. Not adopted.** The original `../brain-v2-phase2-baseline-20261114/report.json` is unchanged
(sha256 `c92b7958b6f1c02bb4b36b9aac8d108f25dbd7db1e157607b86f7e59e676d37a`) and is still the pin used by `src/ai/brain/shadow/compare.ts`.

This report (sha256 `6edbf350b2df4c526fb57fef6393c6d4d1a59496a6c438b9e944bc84c459a4e1`) is the same offline runner on the P0 Knowledge fix for the 2026-11-17 Persian first-visit
incident: contextual multi-question planning, facet-scoped GUARD_12, and arrival lead-time routing. See the project doc
`brain-v2/p0-persian-first-visit-fix-20261117.md`.

## Provenance

- **Code:** `84eb67c` plus the uncommitted P0 fix. No network, provider, database or messaging access.
- **Environment control:** `git archive 84eb67c`, run with the same runner and environment, reproduces the 2026-11-14 report
  **byte-for-byte** (0 differing values). Every difference below is therefore caused by the code change, not the environment.
- **Reproduce** (macOS, from the repo root):

      NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
        src/ai/brain/evaluation/run-baseline.ts /tmp/p0-report.json

## Comparison against the 2026-11-14 baseline

Per-case changes: **16**, all improvements. **Regressions: 0.** tier2 (recorded genuine outputs) and the corpus are unchanged.

| Case | Protocol | Change |
|---|---|---|
| cmp-01, cmp-09, cmp-11, cmp-26, cmp-27 | source-exhaustive-v2 | false_fallback FAIL→PASS, safe_partial FAIL→PASS |
| pre-14, pre-25, pre-26 | source-exhaustive-v2 | false_fallback FAIL→PASS, safe_partial FAIL→PASS |
| rep-04 (recorded production question, de) | source-exhaustive-v2 | false_fallback FAIL→PASS, safe_partial FAIL→PASS |
| var-cmp-01-en, -sv, -es, -fa | source-exhaustive-v2 | false_fallback FAIL→PASS, safe_partial FAIL→PASS |
| num-15 | v2 and source-exhaustive-v2 | correct_complete INDETERMINATE→PASS (now recognised as information); adds false_fallback PASS |
| num-15 | deterministic | action_routing INDETERMINATE→PASS |

The oracle changes above count as 15 improvements (14 cases under source-exhaustive-v2 plus num-15 under v2).
num-15's deterministic routing change is the 16th per-case change.

Aggregate oracle scores (PASS/graded):

| Protocol | Metric | 2026-11-14 | Proposal |
|---|---|---|---|
| v2 | false_fallback | 164/180 (0.911) | 165/181 (0.912) |
| v2 | safe_partial | 16/32 (0.5) | 16/32 (0.5) |
| v2 | correct_complete | 148/148 (1) | 149/149 (1) |
| source-exhaustive-v2 | false_fallback | 148/180 (0.822) | 162/181 (0.895) |
| source-exhaustive-v2 | safe_partial | 0/32 (0) | 13/32 (0.406) |
| source-exhaustive-v2 | correct_complete | 148/148 (1) | 149/149 (1) |

Deterministic action_routing, overall: 302/312 → 303/313.

## Adoption (owner decision; not applied)

Adoption is a one-line change in `src/ai/brain/shadow/compare.ts`, `readBaseline()`:

    - 'docs/validation/brain-v2-phase2-baseline-20261114/report.json'
    + 'docs/validation/brain-v2-phase2-baseline-20261117-p0-proposal/report.json'

Until it is adopted, `src/ai/brain/shadow/comparison.test.ts` reports `V1 oracle drift`. That is intentional: it detects
exactly the 15 oracle changes listed above.
