# Brain V2 Phase 3 — offline decision comparison

**GO on the offline policy result. HOLD on live shadow execution in Phase 4.** The engine preserved separately supportable answers that V1 suppressed, including one independently checked unit from a genuine recording. Before live shadow, establish how to authenticate obligation and fact reviews, bind them to current tenant sources, and measure how often real inputs can supply them. Review the indeterminate recordings and the multilingual question mappings, then validate the actual adapters and the existing publication guard under a separately authorized plan.

## Decision policy

| Outcome | When | What the decision carries |
| --- | --- | --- |
| ANSWER | Every required fact is individually reviewed as entailed, binds to this tenant and the unique current source revision, and matches the reviewed payload, conditions, modality and negation. The set covers the entire obligation and no conflict affects it. | Obligation ID, checks and source-bound facts. An independently resolved false premise is flagged for correction. |
| DISCLOSE | Evidence or coverage is missing, unsafe, or conflicted and no recovery qualifies. | Obligation ID, failed checks and a disclosure requirement. No answer facts from this obligation. Recommendations cannot establish requirements or non-requirements; silence cannot establish absence or permission. |
| RECOVER | An explicit evidence recovery candidate fits the remaining time, cost and attempt limits; no cited fact was rejected and the conflict check is clear. | A candidate and disclosure requirement. Budgets are reserved in obligation order; the engine never executes recovery. |
| CLARIFY | Obligation resolution remains ambiguous. | An obligation ID and clarification reason. No selection or answer is inferred. |
| HANDOFF | The resolved obligation requires booking authority. | Obligation ID and the requested route only. No confirmation, provider call or booking mutation. |

A partial candidate carries the complete independent obligations and explicit disclosure markers for unresolved siblings. The core is pure and receives independent coverage, conflict and entailment attestations as inputs. It does not make those attestations, interpret model prose, render replies, create guard tokens or grant permission to publish. Every result is marked `OFFLINE_ONLY`. Nothing imports it into production.

## What the evidence supports

Phase 2's source-authored corpus supplied the verified obligation mappings for the policy-only comparison. The sources and report hash were checked, and the Phase 2 report reproduced byte for byte from pinned HEAD `b8f2f5537dece788c002b0a358afdcb21021e8ca` before edits. The same V1 shared-core routing predicates and policy oracles ran again for the comparison. The V1 oracle still substitutes model stages, and V2's catalog lane also provides ideal upstream inputs; neither is a measure of live language understanding, extraction or verification.

| Safe partial comparison | V1 | V2 offline candidate |
| --- | ---: | ---: |
| Matched corpus opportunities, V1 `v2` oracle | 8/14 | 14/14 |
| Same opportunities, V1 `source-exhaustive-v2` oracle | 0/14 | 14/14 |
| All corpus opportunities with at least one complete obligation and one unresolved sibling | 14/20 have comparable V1 grades | 20/20 |

The 14 comparable instances span 10 Phase 2 scenarios; the six remaining instances are excluded from the matched comparison. The 14 exclude V1's broader safe-partial category for turns that have only related background and no complete obligation. Against the less restrictive oracle configuration, V2 preserved six additional opportunities without losing any. One example is `cmp-36`, a repository fixture in Arabic. Every partial count requires the complete obligations and disclosure together.

The genuine recording lane uses the original Phase 2 outputs and preserves capture, replay and delivery provenance separately. In the German first-visit case (`rep-04`), the V1 replay had no input drift, published zero units and failed its safe-partial grade. V2 independently checked the unchanged recorded arrival recommendation, pinned its exact unit and evidence by digest, checked a whitespace-only citation normalization, and rebound it to the full exact excerpt in the current Phase 2 snapshot. It preserved the first-visit scope, approximate 10-minute timing, recommendation and preparation purpose, while disclosing that a bring-along requirement was unresolved. The review applies to one unit; its result does not approve the other units or a rendered reply. The Phase 2 delivered grading remains separate. Seven other recordings have no independently rebound facts; three V1 replays have input drift and a fourth is graded indeterminate without drift. Those are evidence gaps, not evidence of failure by a live V2 system.

Across 344 cases and 414 obligations, V2 made 303 ANSWER, 74 DISCLOSE, 27 HANDOFF and 10 CLARIFY decisions on the catalog inputs. No unsafe candidates were observed in the corpus or recording comparison; all 14 injected faults were blocked, with complete siblings retained where applicable. The controls include unsupported claims and numbers, lost conditions, changed modality or negation, foreign and stale evidence, unresolved conflict state and missing or rejected entailment. The corpus includes actual synthetic source conflict fixtures, false premise cases and booking actions. All six language labels (sv, en, de, es, fa, ar) and four channel labels (Telegram, WhatsApp, Instagram, Messenger) are covered. **No channel adapters ran.** No model calls were made and spend was $0. Recovery limits were tested with deterministic time, cost and attempt inputs. Historical replay timings are kept in the report: two captured stage sums exceeded the 20-second V1 deadline; there is no V2 live latency measurement.

## Reproduction

From the pinned worktree with its existing dependencies and Phase 2 experimental fixtures:

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
  src/ai/brain/evaluation/run-baseline.ts /tmp/odin-phase2-reproduced.json
cmp /tmp/odin-phase2-reproduced.json docs/validation/brain-v2-phase2-baseline-20261114/report.json

NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
  src/ai/brain/shadow/run-comparison.ts /tmp/odin-phase3-reproduced.json
cmp /tmp/odin-phase3-reproduced.json docs/validation/brain-v2-phase3-offline/comparison.json

NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test \
  src/ai/brain/evaluation/*.test.ts src/ai/brain/shadow/*.test.ts \
  src/ai/{business-information-answer-plan,source-exhaustive-publication,knowledge-timing-policy}.test.ts

node --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --pretty false
```

The baseline suite passed 195 tests (including all 16 Phase 2 tests); the expanded suite passed 198. The default TypeScript heap was exhausted on the baseline; the direct compiler invocation with a larger heap produced 12 existing diagnostics, with an identical before/after diagnostic log. No tracked files, experimental artifacts or ledgers were changed. The comparison JSON SHA-256 is `18c07c15fec6da2b7fac0209323b661a906cf2bd8d5e6f2a08643d00436d1594`. It includes per-obligation decisions, supporting facts, safety checks, unmatched cases, and the recorded, replayed and delivered evidence lanes.
