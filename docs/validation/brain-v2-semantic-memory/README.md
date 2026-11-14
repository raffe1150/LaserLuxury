# Brain V2 Phase 3 semantic understanding and conversation memory

## Architecture findings

The baseline was `cf9552af4b2ef785c691b2b48b015f463e809420` with a clean tracked worktree. The standalone Phase 0 findings and original Brain V2 roadmap were unavailable in the repository, local worktrees and recent Codex chat index. The current task supplied the phase ordering. The runtime trace and available repository records supplied the architecture evidence, including the pre-P2 routing correction, the Phase 1 coverage records, the Phase 2 evaluation corpus and the existing offline decision engine. The earlier report directory retains its original name. Its decision engine belongs to Phase 4 under the current roadmap.

| Runtime boundary | Finding |
| --- | --- |
| Conversation ingress | `server.ts` scopes channel sessions and calls `handleUnifiedBookingEngine`. `executePreparedLiteralTurn` can split independently recognizable information and action clauses. |
| Intent and language | `understandBookingTurn` wraps the shared booking normalizer and can observe structured understanding without replacing the deterministic result. `resolveConversationLanguageForTurn` uses the server's explicit-switch and continuity policy with `resolveLanguageBrain`. |
| Memory | Recent history, pending booking, active business information and recent completions live in separate paths. The pre-P2 WhatsApp audit shows why a tenant-scoped conversation key matters and why a known pending parameter should survive an ambiguous wrapper classification. |
| Knowledge | `retrieveBusinessKnowledgeForQuestion` uses business-scoped configuration and retrieval. The evidence-first path validates revisions and checks coverage before publication. Phase 1 exposes bounded `source-coverage-decision-v1` diagnostics. Diagnostic states and model coverage labels carry no authority into the new semantic frame. |
| Booking | The shared booking engine and state machines own booking progression and verification. A date, service or staff reference in semantic memory is a customer preference. |
| Phase 4 | The existing `decideTurn` expects independently verified facts, coverage and conflict status. Semantic understanding can supply obligation IDs and route categories. Its preview defaults to unknown coverage and conflicts and supplies an empty fact set. |

The production paths have separate sources of context and no shared structured turn frame. Integrating another state owner or using history as current evidence could cause conflicting booking state, repeated prompts, or unsafe reuse of factual claims. Phase 3 therefore uses an isolated, ordered reducer with caller-owned state and explicit authority boundaries.

## Semantic and state contracts

`prepareTurn` accepts an ordered turn, clock, tenant and conversation binding, catalog and optional language signals from a trusted caller. It produces a bounded request for one interpretation with current text and structured reference options. `finishTurn` consumes the handle once and validates one JSON proposal. Shared deterministic logic supplies date and time parsing, catalog matching, literal booking signals and limited exact continuations. The semantic port is a contract that accepts an abort signal. There is no provider implementation or dispatch. The offline request and response limits are 2,400 and 8,192 characters, with six obligations and three conditions per obligation.

Readings carry ordered primary and secondary intents, question modality, scoped negation, suspected premise spans, explicit or implied conditions, entity spans and reference indexes. The reducer accepts service and staff parameters only from exact scoped catalog matches. It derives booking dates and clocks from current-turn spans through the shared parser. Spans are ephemeral. The frame stores coarse condition markers and semantic summaries. A future interpreter would need to resolve detailed references from these summaries or request the missing context. A suspected premise remains unverified until the relevant Knowledge authority can assess it.

| Layer | Retained state and transitions |
| --- | --- |
| Short-term | Up to eight turn summaries for 15 minutes. The current and previous intent, recent obligation IDs and referenced goals survive without retaining raw messages. An in-process digest of the latest information question flags a normalized repeat. |
| Active tasks | Up to four recent goals with eight obligations each and a 30-minute lifetime. Individual booking preferences also expire after 30 minutes. The reducer removes stale dates and catalog IDs that no longer identify a unique item. An explicit reference can return to an earlier goal. A correction replaces only supplied, validated fields and retains up to six superseded values. Conflicts preserve earlier parameters and require clarification. |
| Durable business context | The caller supplies scoped catalog identifiers and language policy. The existing tenant-scoped Knowledge Library, revision checks and business configuration remain the durable authorities. Answer text, availability, appointment IDs, contact names, phone numbers and free-text conditions do not enter the frame. |

The version 1 frame is immutable, bound to one tenant and conversation, and limited to 16 KiB. Reset discards earlier goals and preference state. Closure clears goals, recent turns and corrections. A closed frame can preserve the active language for a later message. A process-local brand rejects serialized or caller-modified frames. The caller owns serialization of successive turns and lifetime of the frame reference. This prototype has no persistent storage or wall-clock eviction service.

| Guidance | Interpretation |
| --- | --- |
| `CHECK_KNOWLEDGE` | The question is understood well enough to request evidence. |
| `ANSWER_CANDIDATE` or `DISCLOSE_UNSUPPORTED` | The trusted assessment seam marked this obligation for the current turn. The existing guard still owns any publication decision. Status resets on the next turn. |
| `ASK` or `WAIT_FOR_CLARIFICATION` | A field, reference, intent or conflict requires clarification. The same pending field on the same goal returns a wait marker. A known relevant value already in the task satisfies a repeated request for that field unless the current turn supplies contradictory or unresolved input. |
| `REFER_TO_BOOKING_AUTHORITY` | The turn requests a booking operation or availability lookup. Guidance carries only the route and obligation ID. |
| `CORRECTION` or `CLOSE` | A goal preference changed, or the conversation ended. Neither is an appointment operation. |

The trusted Knowledge assessment seam checks frame identity, tenant, conversation, turn and obligation. Its caller must perform the real evidence and revision validation. The semantic wire schema admits no assessments, permissions, tenant IDs, booking IDs, arbitrary values, tool names or verified facts. A structurally valid but mistaken proposal can still misclassify meaning. Tool and publication authorities must continue to reject actions and claims independently.

## Offline examples and results

- **Booking and date correction.** “Please book a haircut with Alex tomorrow at 15:00” followed by “Actually, make it Friday” changes only the date. A separate alternative between Friday and Saturday stays unresolved.
- **Clarification and continuity.** The scripted reading of “Can I book a haircut tomorrow at three?” preserves the haircut and tomorrow and asks about the clock. “Around three” does not repeat the ask. An exact clock in Persian digits fills the pending time via shared normalization and leaves execution with booking authority.
- **Independent obligations.** Early arrival and bringing a booking confirmation preserve separate requirement and recommendation questions. A policy question alongside a cancellation request produces separate Knowledge and booking guidance.
- **Return to an earlier topic.** The German Phase 2 Video Consultation exchange retains the selected catalog service when the follow-up asks about duration. The frame requests Knowledge evidence for duration.
- **Language coverage.** Six tests use Phase 2 prompts and trusted language signals for Swedish, English, German, Spanish, Persian and Arabic. All preserve language across an ambiguous clock turn and honor explicit and policy-driven switches. The semantic tests use one channel-independent interface. Instagram, WhatsApp, Telegram, Messenger and website adapters were outside this validation.

The security and integrity tests cover foreign tenant and conversation bindings, modified and out-of-order state, invalid wire shapes and oversize payloads, injected instructions, attempted permission or fact promotion, multiple competing actions, rejected booking instructions, expired preferences, removed catalog entries, and a 70-turn compression check. Raw contact data in the input is absent from memory. An ephemeral interpreter request still contains the current user text. A future connected provider will need its own data handling and admission policy.

The baseline focused suite passed 295 tests. The expanded suite passed 312, including 17 new tests. The TypeScript before and after logs matched byte for byte with 12 pre-existing diagnostics across 10 files. The Phase 2 evaluation and the Phase 4 decision comparison ran as part of the suite with the network containment hook.

```sh
NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test \
  src/ai/brain/{evaluation,shadow,semantic}/*.test.ts \
  src/ai/{booking-intelligence,language-brain,conversation-context-window,conversation-intent-continuity,source-coverage-decision-record,business-information-answer-plan,source-exhaustive-publication,knowledge-timing-policy}.test.ts
node --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --pretty false
```

## Files added

- `src/ai/brain/semantic/contracts.ts` for the bounded interpretation request, candidate readings and parameter contracts.
- `src/ai/brain/semantic/interpret.ts` for response validation and deterministic parsing.
- `src/ai/brain/memory/turn-frame.ts` for the versioned frame and guidance schema.
- `src/ai/brain/memory/conversation-memory.ts` for scope, reduction, retention, assessments and the Phase 4 bridge.
- `src/ai/brain/semantic/semantic-memory.test.ts` for independent offline scenarios.
- `docs/validation/brain-v2-semantic-memory/README.md` for this report.

## Phase 4

Evaluate the interpreter separately on held-out multilingual turns, including false premises, conflicting constraints, resumed tasks and real references. The current scripted results validate transport shape and reducer behavior. They do not measure genuine model understanding, end-to-end multilingual accuracy, or production response quality. No historical model output was used as a substitute for a semantic interpretation recording.

When separately authorized, the smallest integration to evaluate is a read-only hook on the existing ordered shared-turn boundary. Feed the frame authoritative language and catalog context, keep it out of persisted customer state initially, and correlate obligation IDs with the Phase 1 diagnostics and independently validated evidence. Compare ambiguous cases and false task continuations before considering broader adapter tests. The existing Phase 4 decision engine should still require independent coverage, entailment, conflict and source-revision checks.
