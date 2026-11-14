# Brain V2 Phase 4 offline shadow decision and recovery

**GO for continued offline evaluation in Phase 5. HOLD for live shadow and controlled rollout.** The integrated path preserves independently supported obligations and recovers a reviewed answer within budget. Deterministic interpretation matched only 2 of 12 held-out turns in full. The production Knowledge path also needs a trusted way to associate a verification and coverage result with the exact semantic obligation before this pipeline can consume live evidence.

## Integration map

| Boundary | Existing authority | Phase 4 integration |
| --- | --- | --- |
| Semantic understanding | Phase 3 validates bounded span-based readings and uses shared literal booking and language signals. | `shadowTurn` calls `prepareTurn` and `finishTurn`, accepts one local proposal, and passes the same TurnFrame to later turns. |
| Conversation state and booking | Phase 3 owns the offline frame. Existing booking tools and state machines own all booking actions. | References and corrections flow through the existing frame. Booking guidance carries a route and cannot read Knowledge through this pipeline or execute an operation. |
| Evidence and verification | `answerEvidenceBindings` ties retrieved chunks to tenant and revision. `currentAnswerEvidence` rechecks source and context ownership. `AnswerUnit` and facet coverage describe entailment and completeness within the Knowledge plan. | Bind the exact semantic scope, unit, chunk and source revision to a separate trusted receipt and current inventory. Evidence without that binding stays indeterminate. |
| Observability | Phase 1 records bounded source coverage, obligation ordinals, checks and guard outcomes. | Compare those concepts offline. The diagnostic record lacks the identity and content bindings needed to serve as a receipt. |
| Recovery | The native answer path has one-shot re-extraction for narrowly classified rejections, with permit, time, inventory and cost checks. | The offline read port uses the same fail-closed principle. It admits one attempt per explicitly eligible unresolved obligation, with a cap of three per turn. The existing re-extraction path is outside this experiment. |
| Decision and publication | `decideTurn` checks bound facts. `publishableKnowledgeManifest` owns the existing send-time decision and guarded partials. | Assemble the existing decision input. The result is `OFFLINE_ONLY` and carries no publication token, rendered reply or booking mutation capability. |

The evidence scope includes tenant, conversation, turn, obligation ID, language, question type, and a digest of the exact turn, reading and available reference context. Each independently issued receipt covers the exact reviewed unit set, entailment, modality, negation, material qualifiers, completeness and conflicts. The binder compares the full unit digest, exact quote and constituent boundaries, chunk identity, tenant and the unique current revision. It requires a fresh receipt and inventory within a 60-second offline window and rechecks freshness after recovery. Verified unit IDs and raw model verification flags carry no authority on their own. Question coverage checks are conservative, including a rejection when a recommendation is the only support for a requirement.

The receipt and inventory are trusted inputs. Hashes establish content equality. They do not authenticate the caller, establish entailment or prove that a source is the latest on their own. The fixture receipts stand in for an independent reviewer. A future upstream change should emit backend-owned, turn-scoped receipts at the existing post-verification boundary, after joining stable semantic obligation IDs to actual Knowledge facets and checking request alignment. Carry the validated unit/quote digest and full scope with the receipt, obtain unique current revisions from the existing authoritative revalidation path, and keep it inside the trusted request. Generic coverage grades, sampled logs, and historical verifier verdicts alone remain indeterminate. Eventual publication would still require the existing guard.

## Evaluation

The deterministic held-out evaluation ran before integration. Expectations were authored separately from the implementation and checked for overlap against Phase 2. Exact match covers the ordered obligation readings and their annotated modality, negation, condition, premise, reference or missing field where applicable. The report includes each held-out turn and its expected and actual obligations. Language results test continuity and trusted switch propagation.

| Language | Held-out exact | Held-out primary intent | Language policy |
| --- | ---: | ---: | ---: |
| Swedish | 0/2 | 0/2 | 2/2 |
| English | 2/2 | 2/2 | 2/2 |
| German | 0/1 | 0/1 | 1/1 |
| Spanish | 0/3 | 0/3 | 3/3 |
| Persian | 0/2 | 1/2 | 2/2 |
| Arabic | 0/2 | 0/2 | 2/2 |

- **Deterministic on Phase 2.** The integrated runner processed all 344 cases, replaying earlier turns for multi-turn cases. It emitted 335 generic clarification turns, nine handoffs whose routes matched at least one expected route, and zero answers without receipts. It emitted a clarification on all ten explicit clarification cases, versus zero V1 deterministic clarification signals on those ten. The 325 other V2 clarification turns show why this signal is insufficient to establish clarification accuracy. The report keeps the V1 and V2 obligation inventories separate because their IDs and interpretation scopes differ.
- **Scripted with bound evidence.** The Swedish Phase 2 arrival case supplied a source-catalog fixture, and the German case supplied a recorded arrival unit with an independent source review. Both produced ANSWER plus DISCLOSE. The standard V1 policy oracle supported partial answers in both cases. Its source-exhaustive configuration fell back in both. The broader previous policy-only results were 8/14 and 0/14 for the two V1 oracles versus 14/14 for V2. Those numbers come from the existing policy comparison and are separate from the integrated pipeline's two reviewed examples.
- **Genuine recorded output.** The German no-drift V1 replay published zero units. The offline pipeline retained the unchanged recorded arrival claim after the existing digest-pinned source review, using the exact re-bound citation and explicit qualifiers. It disclosed the unresolved sibling requirement. This is one independently verified false fallback opportunity. The segmentation and receipt are offline inputs. Genuine model interpretation of the new turns was not evaluated. Seven other recorded attempts lacked independently rebound evidence, including three V1 replays with input drift. Delivery results retain their original provenance.
- **Context and clarification.** The deterministic booking-to-Friday transition preserves service, staff and time. Repeating an unresolved clarification produces a wait marker. The held-out report includes actual reference options and retained booking parameters for each scenario, including cases that the deterministic path missed.

Fifteen new evidence controls returned zero unsafe answer recommendations. They cover foreign tenant and conversation bindings, stale inventory and revision, forged citation, altered text, unsupported number, missing qualifiers, reversed negation, conflict, incomplete coverage, replayed scope, recommendation versus requirement, and an unsupported premise. The suite also exercised hostile interpretation fields, conservation of booking preferences, replay of frames across conversations, and escalation isolation. All 14 historical Shadow Decision controls passed.

Ten recovery scenarios cover verified recovery, unavailable evidence, contradiction, attempt and budget limits, a deterministic clock timeout, an aborting wall-clock timeout, excess reported cost, and ineligibility. Each performed at most one read and preserved an independently valid answer. Recovery reserves worst-case time and cost before dispatch, validates the returned usage, and never retries an obligation. The fake read sees only the scoped request and cannot expand its review to siblings. The abort stops admission to further reads on timeout. Any future external implementation must honor the signal and enforce the reserved cost internally. The offline wrapper can validate a reported charge and discard a result, but cannot undo a charge. Recovery reuses the pinned inventory and cannot introduce an unreviewed new source. No providers, channels, or calendars were contacted.

## Reproduction and changed files

Baseline `0ec7ba15ee4d8cbd97bc831585fb0eaf23676fcb` was clean for tracked files. The existing focused suite passed 312 tests. With Phase 4 it passed 319. TypeScript logs matched byte for byte with the baseline 12 diagnostics in 10 files. Two report runs produced identical bytes. Report SHA-256 is `e251972551fa4cee3bad9ea8b767925699371f39b54eefbebf72207ad16edf2e`.

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test \
  src/ai/brain/{evaluation,shadow,semantic,phase4}/*.test.ts \
  src/ai/{booking-intelligence,language-brain,conversation-context-window,conversation-intent-continuity,source-coverage-decision-record,business-information-answer-plan,source-exhaustive-publication,knowledge-timing-policy}.test.ts
node --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --pretty false
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
  src/ai/brain/phase4/run-report.ts /tmp/odin-p4-reproduced.json
cmp /tmp/odin-p4-reproduced.json docs/validation/brain-v2-phase4-shadow-recovery/report.json
```

Exactly these files were added locally.

- `src/ai/brain/evidence/bind.ts`
- `src/ai/brain/phase4/pipeline.ts`
- `src/ai/brain/phase4/held-out.ts`
- `src/ai/brain/phase4/semantic-eval.ts`
- `src/ai/brain/phase4/fixtures.ts`
- `src/ai/brain/phase4/safety-eval.ts`
- `src/ai/brain/phase4/phase4.test.ts`
- `src/ai/brain/phase4/report.ts`
- `src/ai/brain/phase4/run-report.ts`
- `docs/validation/brain-v2-phase4-shadow-recovery/README.md`
- `docs/validation/brain-v2-phase4-shadow-recovery/report.json`

For Phase 5, evaluate genuine semantic interpretations on held-out multilingual turns and grade missed obligations, mistaken references and false clarifications separately. Then test a backend-owned receipt at the existing verification boundary using a read-only harness. Require evidence binding and adapter-level verification before authorizing controlled rollout.
