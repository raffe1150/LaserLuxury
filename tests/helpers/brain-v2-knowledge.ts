import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSearchMatch } from '../../knowledge';
import { answerEvidence, answerJson, parseRequestedFacets } from '../../src/ai/business-information-answer-plan';
import { hashRecord, type Candidate, type Inventory, type Receipt } from '../../src/ai/brain/evidence/bind';
import { shadowTurn, type AsyncEvidencePort } from '../../src/ai/brain/phase4/pipeline';
import { revalidateKnowledgeSourceIds } from '../../src/knowledge/evidence-registry';

import type { UnifiedAiGenerationRequest, UnifiedAiGenerationResponse } from '../../src/ai/providers/provider';
import { composeResponse } from '../../src/ai/brain/response/compose';
import { incidentFlags } from './p0-incident-knowledge';

type NativeBoundary = Pick<typeof import('../../server').priority1hUnifiedEngineTestBoundary,
  'nativeKnowledgeEvidenceRequest'>;

/** Imported only by integration tests. The caller owns fixture storage and
 * provider admission. No HTTP route or channel delivery is registered here. */
export function fixtureKnowledgePort(boundary: NativeBoundary, service: KnowledgeService,
  tenantId: number, question: string, verificationEvents: readonly Record<string, unknown>[],
  wires?: () => { extraction: unknown; verification: unknown }) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test-only');
  let captured: KnowledgeSearchMatch[] = [];
  const validate = (id: number, matches: KnowledgeSearchMatch[]) =>
    service.validateMatches(id, matches, { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true });

  async function refresh(): Promise<Inventory> {
    const current = await revalidateKnowledgeSourceIds(tenantId, captured, validate);
    // Keep the native evidence IDs stable even when a sibling source disappears.
    const chunks = answerEvidence(tenantId, captured).filter(chunk => current.has(chunk.sourceId));
    return { tenantId, checkedAtMs: Date.now(), chunks,
      revisions: [...new Map(chunks.map(chunk => [chunk.sourceId, chunk.version]))]
        .map(([sourceId, revision]) => ({ sourceId, revision })) };
  }

  const evidence: AsyncEvidencePort = { async load(scopes, semantic) {
    const candidates: Candidate[] = [];
    const receipts: Receipt[] = [];
    const batch = { candidates, receipts };
    if (scopes.some(scope => scope.tenantId !== tenantId)) return { batch };
    const requested = scopes.map(scope => {
      const reading = semantic.readings[semantic.guidance.findIndex(item => item.obligationId === scope.obligationId)];
      const text = question.slice(reading.span.start, reading.span.end);
      return { subject: text, attribute: text, questionType: scope.questionType };
    });
    const { facets } = parseRequestedFacets(requested);
    if (facets.length !== scopes.length) return { batch };

    const queried = await service.search(tenantId, question);
    captured = await validate(tenantId, queried);
    const sessionId = semantic.frame.binding.conversationId;
    await boundary.nativeKnowledgeEvidenceRequest({ sessionId, businessConfig: { id: tenantId, businessId: tenantId, services: [] },
      question, language: scopes[0].language, facets: requested, matches: captured }, async runtime => {
      const firstEvent = verificationEvents.length;
      await runtime.generate();
      const events = verificationEvents.slice(firstEvent);
      const observed = events.filter(event => event.stage === 'verification');
      const totals = observed.filter(event => event.eventType === 'unit_counts');
      const verdicts = observed.filter(event => event.eventType === 'unit_verdict');
      const total = totals[0]?.counts as { proposed?: number } | undefined;
      // A VERIFIED facet alone can omit a contradicted sibling unit. Require
      // an observed verdict for every proposal before asserting conflict clear.
      if (totals.length !== 1 || !verdicts.length || total?.proposed !== verdicts.length ||
          new Set(verdicts.map(event => event.unitId)).size !== verdicts.length ||
          verdicts.some(event => !['ENTAILED', 'NOT_APPLICABLE', 'UNKNOWN'].includes(String(event.relation)))) return;
      const unknown = verdicts.filter(event => event.relation === 'UNKNOWN');
      const capturedWires = wires?.();
      const submitted = (capturedWires?.verification as { units?: unknown } | null)?.units;
      const blockedFacets = new Set<string>();
      for (const verdict of unknown) {
        const matches = Array.isArray(submitted) ? submitted.filter(unit => unit?.id === verdict.unitId) : [];
        const ids = matches[0]?.facetIds;
        if (matches.length !== 1 || !Array.isArray(ids) || !ids.length ||
            ids.some(id => !facets.some(facet => facet.id === id))) return;
        ids.forEach(id => blockedFacets.add(id));
      }
      const manifest = runtime.manifest();
      if (!manifest || manifest.language !== scopes[0].language || hashRecord(manifest.facets) !== hashRecord(facets)) return;
      const fresh = await runtime.refresh();
      if (!runtime.current()) return;
      for (const [index, scope] of scopes.entries()) {
        const facet = facets[index];
        if (blockedFacets.has(facet.id)) continue;
        const outcome = manifest.outcomes.find(row => row.facetId === facet.id);
        const covered = outcome?.obligations.find(row => row.obligationId === facet.obligations[0].id);
        const reading = semantic.readings[semantic.guidance.findIndex(item => item.obligationId === scope.obligationId)];
        if (reading.premise || !outcome?.requestAligned ||
            covered?.status !== 'COVERED' || !covered.unitIds.length ||
            hashRecord([...covered.unitIds].sort()) !== hashRecord([...outcome.materialUnitIds].sort())) continue;
        const complete = outcome.status === 'VERIFIED' && outcome.materialFactsComplete;
        if (!complete && !(outcome.status === 'PARTIAL' && !outcome.materialFactsComplete &&
            siblingNumericalRejection(facet.id, facets.map(f => f.id), events, capturedWires?.extraction, verdicts))) continue;
        const units = manifest.units.filter(unit => covered.unitIds.includes(unit.id));
        if (units.length !== covered.unitIds.length || units.some(unit => unit.verification !== 'ENTAILED' ||
            !unit.facetIds.includes(facet.id) || !unit.evidenceRefs.length ||
            unit.evidenceRefs.some(ref => !fresh.some(chunk => chunk.id === ref.evidenceId &&
              chunk.businessId === tenantId && chunk.sourceId === ref.sourceId &&
              chunk.chunkId === ref.chunkId && chunk.version === ref.version)))) continue;

        candidates.push({ obligationId: scope.obligationId, units });
        receipts.push({ scope, checkedAtMs: Date.now(), coverage: 'COMPLETE', conflict: 'CLEAR', correctPremise: false,
          units: units.map(unit => ({ id: unit.id, digest: hashRecord(unit), relation: 'ENTAILED',
            modality: unit.modality, negated: unit.negation, conditions: unit.qualifiers,
            citations: [...new Set(unit.evidenceRefs.map(ref => ref.evidenceId))].map(evidenceId =>
              ({ evidenceId, digest: hashRecord(fresh.find(chunk => chunk.id === evidenceId)!) })) })) });
      }
    });
    return { batch, inventory: await refresh() };
  } };
  return { evidence, refresh };
}


// The native answer plan deliberately downgrades the manifest after an
// incomplete extraction. Only restore the isolated receipt when every
// missing unit is accounted for by a different facet's citation rejection.
function siblingNumericalRejection(facetId: string, facetIds: readonly string[],
  events: readonly Record<string, unknown>[], extraction: unknown, verdicts: readonly Record<string, unknown>[]) {
  const proposed = (extraction as { oversized?: unknown; units?: unknown } | null)?.units;
  if (!Array.isArray(proposed) || (extraction as { oversized?: unknown }).oversized !== false ||
      proposed.length <= verdicts.length) return false;
  const history = events.filter(e => e.stage === 'verification' && e.facetId === facetId);
  const first = history[0];
  if (history.length !== 2 || first?.reason !== 'ACCEPTED' || first.incompletenessReason !== 'NONE' ||
      (first.facets as { status?: unknown }[] | undefined)?.[0]?.status !== 'VERIFIED' ||
      history[1].reason !== 'MATERIAL_FACTS_MISSING' || history[1].facets !== undefined) return false;
  return proposed.every((unit, i) => {
    const id = 'u' + (i + 1);
    if (verdicts.some(v => v.unitId === id)) return true;
    return Array.isArray(unit?.facetIds) && unit.facetIds.length > 0 &&
      unit.facetIds.every((other: unknown) => typeof other === 'string' && other !== facetId && facetIds.includes(other)) &&
      events.some(e => e.stage === 'extraction' && e.unitId === id && e.reason === 'NUMERICAL_CONSTRAINT' &&
        e.numericalMismatchReason === 'QUANTITY_NOT_IN_CITATION');
  }) && verdicts.every(v => proposed.some((_, i) => v.unitId === 'u' + (i + 1)));
}

export const swedishKnowledgeFixture = {
    first: 'Måste jag komma 15 minuter tidigt om jag redan har fyllt i formuläret?',
    second: 'Vad ska jag ta med till besöket?',
    follow: 'Måste jag fortfarande ta med det?',
    sources: [
      'Kom 15 minuter tidigt om du inte har fyllt i formuläret. Om du redan har fyllt i formuläret behöver du inte komma tidigt.',
      'Vi rekommenderar att du tar med ditt betalningskvitto till besöket.',
      'Du kan visa ditt betalningskvitto på mobilen.',
    ],
    decoy: 'Du måste komma 90 minuter tidigt och ta med passet till besöket.',
} as const;

/** Single fixture for the dedicated preflight and supervised experiment. */
export async function runSwedishKnowledgeFixture(
  generate: (request: UnifiedAiGenerationRequest) => Promise<UnifiedAiGenerationResponse>,
  fixture?: { missingBring?: boolean; foreignBring?: boolean; revokeBringAfterVerification?: boolean },
) {
  // Run in a dedicated process. Never initialize server.ts with a DB credential.
  if (process.env.NODE_ENV !== 'test' || process.env.SUPABASE_URL || process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.OPENAI_API_KEY)
    throw new Error('ISOLATED_KNOWLEDGE_PROCESS_REQUIRED');
  incidentFlags();
  Object.assign(process.env, { ODINLINK_AI_DEFAULT_MODEL: 'gpt-5.6-luna',
    ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2', ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'v2' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN'); };
  try {
    const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
    const spec = swedishKnowledgeFixture;
    const tenantId = 77;
    const storage = new InMemoryKnowledgeStorage();
    const service = new KnowledgeService(storage, storage, null);
    const events: Record<string, unknown>[] = [];
    for (const [index, id] of ['arrival', 'bring', 'receipt'].entries()) {
      if (id === 'bring' && fixture?.missingBring) continue;
      const content = spec.sources[index];
      const owner = id === 'bring' && fixture?.foreignBring ? tenantId + 1 : tenantId;
      await storage.create({ id, businessId: owner, content, type: 'document', title: id, status: 'ready',
        createdAt: '2026-11-15', updatedAt: '2026-11-15',
        metadata: { segments: [{ start: 0, end: content.length, section: 'Text' }] } });
      await storage.replaceChunks(owner, id, [{ chunkIndex: 0, content, metadata: { source: 'document', section: 'Text' } }]);
    }
    boundary.reset();
    try {
      let extraction: unknown;
      let verification: unknown;
      boundary.configure({ offlineAi: true, evidenceFirstDecisionDiagnostic: event => events.push(event),
        validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches, {
          strictSources: true, requireCompleteDocumentContext: true,
        }), aiGenerate: async request => {
          if (request.routingStage === 'knowledge_verification')
            verification = answerJson(request.messages[0]?.content ?? '');
          const response = await generate(request);
          if (request.routingStage === 'knowledge_extraction') extraction = answerJson(response.text);
          if (request.routingStage === 'knowledge_verification' && fixture?.revokeBringAfterVerification) {
            const source = (await storage.list(tenantId)).find(row => row.id === 'bring');
            if (source) await storage.create({ ...source, title: 'bring-revised', updatedAt: '2026-11-16' });
          }
          return response;
        } });
      const text = spec.first + ' ' + spec.second;
      const port = fixtureKnowledgePort(boundary, service, tenantId, text, events, () => ({ extraction, verification }));
      const binding = { tenantId, conversationId: 'knowledge-sv-complete' };
      const result = await shadowTurn({ text, wire: JSON.stringify({ version: 1, readings: [
        { intent: 'general_question', questionType: 'requirement', span: { start: 0, end: spec.first.length },
          conditions: [{ kind: 'if', explicit: true, span: { start: spec.first.indexOf('om '), end: spec.first.length - 1 } }] },
        { intent: 'general_question', questionType: 'recommendation', span: { start: spec.first.length + 1, end: text.length } },
      ] }), evidence: port.evidence, context: { binding, turn: 1, nowMs: Date.now(), timezone: 'Europe/Stockholm',
        catalog: { services: [], staff: [] }, language: { deterministicLanguage: 'sv' } } });
      const inventory = await port.refresh();
      const candidate = composeResponse({ ...result, swedishRequirementSubject: {
        obligationId: 't1o1', clause: 'om du måste komma 15 minuter tidigare när formuläret redan är ifyllt',
      }, current: { ...binding, turn: 1, nowMs: Date.now(), language: 'sv', inventory } });
      return { question: text, inventory, decision: result.decision, bindings: result.bindings, candidate };
    } finally { boundary.reset(); }
  } finally { globalThis.fetch = originalFetch; }
}
