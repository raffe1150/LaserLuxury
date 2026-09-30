# Compound grounded business information hotfix

All changes are confined to `.production-hotfix`. No commit, push, deployment,
Render setting change, production data write, or AI Blackbox modification occurred.

## Proven cause and production-trace limitation

The shared final-response guard has whole-response failure semantics that lose
otherwise supported compound facts:

1. `assessmentHasVerifiedEvidence` requires complete candidate coverage and all
   claims to be supported. A supported factual clause followed by an unverified
   clause or a limitation sentence can fail this whole-candidate gate.
2. The existing partial-answer branch also requires whole-candidate coverage
   (or a safe recommendation clarification). Uncovered limitation text therefore
   prevents recovery of a supported factual clause. It also does not recover
   independently entailed claims when another apparently supported claim fails
   entailment: its entry condition requires a claim with unverified evidence.
3. `currentBusinessSupportGap` calls `isServiceCatalogQuestion`; that helper rejects
   services questions when contact, hours, prices, policies, or parking are also
   present. Consequently the last fallback omits even the configured service list
   and formats a gap for all recognized topics.
4. Compound catalog replies previously bypassed the standalone catalog completeness
   contract and could return an incomplete list despite an available authoritative plan.

Before the fix, offline tests using tenant 3's production snapshot reproduced the
reported total-fallback text in English, German and Swedish. After the fix these
same cases preserve services and report only the location gap. Another regression
demonstrates independently supported location surviving a failed price entailment.

These are proven source-level defects and controlled local reproductions. The
original live candidate, extractor response, and fallbackReason were not available.
The production address lookup is real; local OpenAI SDK responses, claim extraction,
and entailment are mocked. This report does **not** assert which verifier condition
fired in the original production incident or claim a live OpenAI end-to-end replay.

## Runtime path

`processWhatsAppMessageClaimed` routes through `handleUnifiedBookingEngine` /
`handleUnifiedBookingEngineTurn`. `isBusinessInformationQuestion` recognizes the
English/German/Swedish compound questions. The information branch resolves the
reply language, retrieves Knowledge, and constructs `businessInformationTurns`.

`retrieveBusinessKnowledgeForQuestion` calls the provider-routed query planner,
adds existing multilingual address bridge queries, and runs lexical and semantic
search. Tenant filters, deduplication, and reciprocal-rank fusion retain source IDs.
`buildBusinessGroundingSnapshot` unions structured configuration, factual prompt
evidence, retrieved Knowledge, and verified booking state where relevant.

`buildBusinessInformationInstruction` supplies this union and the current question
to generation. The shared `guardBusinessSupportGrounding` verifies candidate
coverage, exact source quotes, and semantic entailment. Before this patch its
whole-response and partial-response gates could both reject a supported clause,
then `currentBusinessSupportGap` selected the generic total fallback.

## Production Knowledge verification

Read-only Supabase lookup: project `blknxpoeaqrvvdhixrau`, business ID **3**,
business name **admotion studio**. Services include Video Consultation, test,
video for tiktok, Golden video, Reklam, and video for Instagram, with actual
configured durations/prices retained in the fixture.

Ready source ID: `7f61b8c0-0f2c-4f7f-9d61-d632fa8a5a58`.
Exact source/chunk text:

> För detta tillfälliga produktionstest gäller följande kundinformation: kundentrén ligger på Aurora Street 742.

This is explicitly marked **temporary production-runtime smoke-test knowledge**.
It is the current tenant's test entrance information, not independent verification
of a permanent physical business address.

The production `search_knowledge_chunks(3, query, 5)` RPC returns no matches for
the raw English/German compound questions. The existing `kundentré adress` bridge
returns this source with score **0.51**; `Kundeneingang Adresse` also returns it.
Thus the address is reachable through the existing shared retrieval path, even
without semantic retrieval. Recorded RPC results are replayed through the real
`SupabaseKnowledgeStorage.search` adapter in two OpenAI-outage tests.

The address is never hardcoded in runtime code. Regression answers derive it from
the exact read-only production fixture.

## Semantic migration

Compared `abfb687` with its parent. The query-building/retrieval/merge functions,
`currentBusinessSupportGap`, and `guardBusinessSupportGrounding` are byte-for-byte
unchanged across that migration. The migration selected `ConfiguredEmbeddingProvider`
instead of the Google-only provider and added a compatible OpenAI semantic index.
No defect in that provider selection was demonstrated and nothing was reverted.

OpenAI semantic retrieval remains OpenAI-only. Existing provider and new compound
tests retain lexical fallback under OpenAI failure and assert no Gemini invocation.

## Minimal shared fix and partial answers

`recoverCompoundBusinessInformation` operates after full-reply validation fails
for multiple factual topics, excluding recommendation questions. It emits only
exact contiguous candidate quotations that pass the existing exact-source and
semantic-entailment gates independently. It discards uncovered/unverified text.
A failure in one claim no longer invalidates another independently verified claim.

A compound catalog component uses the existing authoritative localized catalog
plan, retaining configured names, durations, prices and the bounded display limit.
Recovered catalog clauses are replaced by that plan where their exact citations
identify only catalog fields; other factual clauses remain separate. The full-reply
branch also checks compound catalog completeness before preserving the candidate.

Missing topics receive a localized gap restricted to those topics, including an
address-specific label for a location question. Singular named-service questions
cannot acquire an unrelated catalog merely because another topic is present.
Recommendation handling, exact-evidence rules, tenant filters, and prohibited
diagnostics/files are unchanged.

## Files changed

- `server.ts`: independent compound recovery and compound catalog completeness.
- `src/ai/business-information.ts`: recognize a catalog component without treating
  it as a sufficient standalone answer; support focused topic labels.
- `src/ai/compound-business-information.integration.test.ts`: 18 new regressions.
- `tests/fixtures/business-information-tenant3.json`: read-only production factual snapshot.
- `tests/fixtures/business-information-tenant3-retrieval.json`: read-only production lexical RPC results.
- This report.

## Validation

18 new tests cover English/German/Swedish services + location, source union,
partial/inverse support, unsupported and uncovered text, independent entailment,
catalog recovery without an assessment, exact citation and candidate-quote safety,
cross-tenant isolation, OpenAI-only semantics, lexical RPC replay during OpenAI
outage, services + hours, contact + hours, service + preparation, and negative absence.

The combined knowledge, semantic/provider, grounding, catalog, multilingual business
information and relevant WhatsApp run finished with **240 passed / 1 failed / 241 total**.
The failure is `whatsapp-swedish-tomorrow-regression.integration.test.ts:117`:
the `awaiting_contact` case expects `2026-08-31` but gets undefined. The identical
failure was verified using an esbuild bundle with the untouched HEAD versions
of both changed runtime files; no existing test was changed or weakened.

Legacy Gemini-mocked tests were run with `AI_PROVIDER=gemini`; the new compound
tests explicitly set `AI_PROVIDER=openai`. The repository's existing offline
network harness prevented external requests. Initial default-provider combined
runs stalled in legacy Gemini-mocked tests and were stopped before rerunning
under the correct fixture provider setting.

Focused business-information TypeScript check passes. The server-inclusive check
reports the same **16 baseline errors**, with **zero introduced diagnostics**,
using a TypeScript compiler-host comparison against untouched HEAD sources.
The project-wide `tsc --noEmit` stops on six pre-existing syntax diagnostics in
`patch_key_rotation.ts`; that prohibited file was not edited.

`npm run build` passes, retaining the existing bundle-size warnings.
`git diff --check` passes. Runtime diff: 100 insertions / 7 deletions across
the two existing source files; the new tests, two fixtures, and this report are untracked.

Combined test command:

```sh
AI_PROVIDER=gemini node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test knowledge.test.ts src/knowledge/*.test.ts src/ai/business-information*.test.ts src/ai/business-support-gap.integration.test.ts src/ai/compound-business-information.integration.test.ts src/ai/shared-business-information.integration.test.ts src/ai/service-catalog-presentation.integration.test.ts src/ai/post-completion-business-support-response.integration.test.ts src/ai/providers/*.test.ts src/ai/embeddings.test.ts src/ai/presentation-fact-integrity.test.ts src/ai/whatsapp-*.test.ts
```

Remaining production diagnostic: obtain the failed live reply's
`BusinessSupportGroundingDiagnostic` and `unsupported reply replaced` fallbackReason
to distinguish extraction coverage, exact citation, and entailment failures for
that specific incident. No production change is needed to read those existing logs.
