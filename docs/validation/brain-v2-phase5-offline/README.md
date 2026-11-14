# Brain V2 Phase 5 semantic interpretation and response composition

**GO for an owner-approved model evaluation. HOLD for Phase 6 controlled rollout.** The offline composer preserved verified facts and localized uncertainty in the tested cases. Model understanding, independent language quality, trusted production receipts and end-to-end adapter behavior still need validation.

## Architecture and scope

The tracked baseline was clean at `4471652edb939b97ee0f62cbb1e556525566835f`. Phase 5 reuses the independent Phase 2 corpus, Phase 3 parser and TurnFrame, and Phase 4 evidence binding, recovery and decision engine. The existing provider interface already uses unknown output and abort signals. Its booking-specific request shape does not cover all semantic obligations. The new provider-agnostic adapter wraps the existing `InterpretationPort` and strict parser. It takes one injected transport, sends bounded current-turn text and redacted reference summaries, and accepts only validated UTF-16 spans, intent and obligation fields. The host language resolver retains authority. Invalid proposals, timeouts, cancellation and transport errors produce a clarification path. No production provider handles the new packet.

The existing `grounded-knowledge-composition.ts` checks optional free-form prose with a separate verdict on both entailment and completeness. `publishableKnowledgeManifest` retains publication authority. The Phase 5 composer instead assembles exact reviewed sentences with small localized uncertainty, clarification, correction, handoff and closing blocks. This makes the offline path independent of a model's ability to paraphrase without changing the meaning. It offers a narrower range of expression than free-form generation.

The only change to an existing implementation file adds a process-local association between each Phase 4 decision, its validated semantic result, and the evidence batches accepted for it. Composition accepts the original turn pair and independently rebinds saved receipts against a current inventory supplied by the trusted caller. The binder checks tenant, exact semantic scope, source and chunk revision and freshness, exact reviewed unit and citations, obligation coverage, contradiction, material qualifiers, modality and negation. Text is emitted only when the re-bound factual payloads exactly match the decision. A stale or mismatched obligation is withheld and disclosed without discarding an independently valid sibling. Identical clauses can share one block while retaining both obligation bindings. Oversize responses fail closed instead of truncating authorized statements. A repeated clarification can produce an empty candidate, which the offline consumer treats as a wait state.

The composer has no send path and emits `OFFLINE_ONLY`. It cannot establish the authenticity of a receiver's current inventory without the trusted upstream boundary identified in Phase 4. Booking guidance is informational, and operation-success text is defensively screened with existing guards. This does not make a heuristic success filter a substitute for entailment or the production publication guard.

## Semantic evaluation

The evaluation reuses the independently labeled Phase 4 held-out turns and adds one independently written completion turn per language. The Arabic follow-up label is mapped to the information-goal index after the scripted reducer creates separate booking and information goals. The Phase 4 fixture and report retain their original numbering. The scripted lane encodes the answer key to exercise transport, decoding and reduction. Genuine model accuracy is unmeasured.

| Language | Turns | Deterministic exact | Scripted round trips |
| --- | ---: | ---: | ---: |
| Swedish | 3 | 0 | 3 |
| English | 3 | 2 | 3 |
| German | 2 | 0 | 2 |
| Spanish | 4 | 0 | 4 |
| Persian | 3 | 0 | 3 |
| Arabic | 3 | 0 | 3 |

Of the original 12 turns, deterministic interpretation fully matched two English booking/correction turns. It matched the generic unknown intent on the Persian scenario's date-alternative turn but missed that the clarification should resolve a conflict. The literal path abstains on most policy questions and does not decompose the Swedish, German and Arabic multipart turns. This loses the German negated premise and cancellation request, the Swedish requirement and conditional wording, and the Arabic negated action and separate recommendation. It misses the Spanish booking request with an ambiguous clock and fails to resolve Swedish, Spanish and Arabic references. The current literal path also abstains on all six new completion turns. These are specific coverage gaps. The small sample cannot isolate a language effect from the kinds of requests tested.

Both lanes followed the supplied language policy on 18/18 turns and proposed zero booking handoffs outside the annotated cases. Those checks establish behavior on the evaluation set. The strict schema can reject injected tenant IDs and booking authorization fields, but a structurally valid model can still choose the wrong intent, scope or reference. Booking authority and evidence validation remain independent.

## Response evaluation

- **Verified partial response.** The drift-free German V1 replay published zero units. V2 expressed the independently rebound first-visit recommendation with its approximate 10-minute offset and purpose intact. It used a short transition to disclose only the unresolved bring-along requirement. The recording supplied reviewed claim wording, and the semantic interpretation and receipt came from offline fixtures.
- **Booking and correction.** “Can you book a haircut for tomorrow at three?” yields “What time did you have in mind?” Friday updates only the requested date. The exact 15:00 follow-up retains the haircut and Friday and yields booking-system guidance. The initial time remains unresolved until supplied. Repeating the ambiguous clock does not repeat the question.
- **False premise and closure.** A separate source-backed English fixture preserves courtyard location and exclusion of the street entrance. Closing turns use a brief response in the active language.
- **Obligation safety.** Tests block missing, stale and foreign inventories, edited source content and changed current revisions, forged or transplanted decisions, altered numbers, qualifiers, modality and negation, and booking-success language. Shared wording covers two independently bound obligations once. The tests verify scope, coverage, exact text, compactness, language selection and no question echo. No unsafe response was observed in these controls.
- **Subjective quality.** There has been no independent native-speaker scoring or genuine generated response evaluation. The current quality evidence consists of inspectable examples and deterministic structural checks.

## Separate model-validation proposal

After explicit owner approval, run one call per turn on the 18 fictional turns listed in the report, under their actual conversation order. Freeze a run manifest with model ID, fixture and packet hashes, token limits, exact attempt count and verified rates. Keep the answer keys outside model input. Use the same adapter and exact-match grader, and have a bilingual reviewer adjudicate paraphrase, ambiguous references and obligation boundaries. Compare primary and secondary intent, obligation completeness, condition and polarity, false clarifications, context and unsafe routing by language. Grade naturalness separately with blinded native-language review of authorized candidate responses.

The proposal uses one candidate model, `gpt-6.1-sol`, and no retries or fallback calls. Using the checked-in rate snapshot, the planning bound is 18 × ((16,000 × $2.50 + 1,600 × $10.00) / 1,000,000) = **$1.008**, rounded up to a **proposed $1.01 ceiling**. Use the conservative highest input rate in the snapshot, count reasoning inside the output cap, and reserve the full worst-case charge before each attempt. Before approval and execution, independently verify rates, billing unit and model access. If request bytes and framing cannot be bounded by the input reserve, provider billing exceeds the estimate, or usage cannot be reconciled inside the reserved maximum, stop and submit a revised plan. No fresh provider pricing or model availability was queried during this offline phase. The plan module provides the arithmetic and disabled dispatch metadata. A runnable connected harness and exact wire manifest remain approval-gated. The proposal budgets interpretation only and contains no paid generation or judge for response prose.

## Files and reproduction

Modified `src/ai/brain/phase4/pipeline.ts` to retain and recheck offline composition provenance. Added:

- `src/ai/brain/semantic/model-adapter.ts`
- `src/ai/brain/response/compose.ts`
- `src/ai/brain/response/phrases.ts`
- `src/ai/brain/phase5/semantic-eval.ts`
- `src/ai/brain/phase5/response-eval.ts`
- `src/ai/brain/phase5/live-plan.ts`
- `src/ai/brain/phase5/phase5.test.ts`
- `src/ai/brain/phase5/run-report.ts`
- `docs/validation/brain-v2-phase5-offline/README.md`
- `docs/validation/brain-v2-phase5-offline/report.json`

395 existing regression tests and 10 new tests passed, for 405 total. The TypeScript diagnostics matched the baseline byte for byte with 12 existing errors in 10 files. The report reproduced byte for byte with SHA-256 `a6537f4c3fdd26a9c242ef543b3ff6099ba3e352dacaa96ad9d0161071f6de71`.

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test \
  src/ai/brain/{evaluation,shadow,semantic,phase4,phase5}/*.test.ts \
  src/ai/{booking-intelligence,language-brain,conversation-context-window,conversation-intent-continuity,source-coverage-decision-record,business-information-answer-plan,source-exhaustive-publication,knowledge-timing-policy,grounded-knowledge-composition,grounded-booking-composition,response-concision-policy}.test.ts
node --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --pretty false
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
  src/ai/brain/phase5/run-report.ts /tmp/odin-phase5-reproduced.json
cmp /tmp/odin-phase5-reproduced.json docs/validation/brain-v2-phase5-offline/report.json
```
