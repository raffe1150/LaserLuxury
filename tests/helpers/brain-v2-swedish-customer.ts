import assert from 'node:assert/strict';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision } from '../../knowledge';
import type { UnifiedAiGenerationRequest, UnifiedAiGenerationResponse } from '../../src/ai/providers/provider';
import { sharedCorpus } from './shared-core-incident';
import { swedishKnowledgeFixture as fixture } from './brain-v2-knowledge';
import { incidentConfig, incidentFlags, incidentInbound, incidentSession, interceptedIncidentSend, type IncidentChannel } from './p0-incident-knowledge';

const question = fixture.first + ' ' + fixture.second;
const questionFacets = [fixture.first, fixture.second].map((text, index) =>
  ({ subject: text, attribute: text, questionType: index ? 'recommendation' : 'requirement' }));
let serial = 46708000000;

export async function runSwedishCustomerEntry(
  generate: (request: UnifiedAiGenerationRequest, storage: InMemoryKnowledgeStorage, decisions: readonly Record<string, unknown>[]) => Promise<UnifiedAiGenerationResponse>,
  { channel = 'telegram', missing = false, foreign = false }: { channel?: IncidentChannel; missing?: boolean; foreign?: boolean } = {},
) {
  return runCustomerEntry(generate, { channel, missing, foreign });
}

export async function runCustomerEntry(
  generate: (request: UnifiedAiGenerationRequest, storage: InMemoryKnowledgeStorage, decisions: readonly Record<string, unknown>[]) => Promise<UnifiedAiGenerationResponse>,
  { channel, missing, foreign, genuineQuestion, conversation, beforeFollowUp, continuityPlannerTiming }: {
    channel: IncidentChannel; missing?: boolean; foreign?: boolean; genuineQuestion?: string;
    conversation?: readonly [string] | readonly [string, string];
    continuityPlannerTiming?: true;
    beforeFollowUp?: (reply: string, publication: unknown, sessionHistory: unknown, sessionId: string) => void;
  },
) {
  if (process.env.NODE_ENV !== 'test' || process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY || process.env.OPENAI_API_KEY || process.env.ODINLINK_SHARED_PG) throw Error('ISOLATED_KNOWLEDGE_PROCESS_REQUIRED');
  if (continuityPlannerTiming && (!conversation || (channel !== 'telegram' && channel !== 'whatsapp')))
    throw Error('CONTINUITY_FIXTURE_REQUIRED');
  incidentFlags();
  Object.assign(process.env, { ODINLINK_AI_DEFAULT_MODEL: 'gpt-5.6-luna',
    ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
    ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2', ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'v2' });
  const originalServices = incidentConfig.services;
  const corpus = genuineQuestion ? await sharedCorpus(false, true) : undefined;
  incidentConfig.services = originalServices;
  const storage = corpus?.storage ?? new InMemoryKnowledgeStorage();
  const customerQuestion = conversation?.[0] ?? genuineQuestion ?? question;
  const queries: { tenant: number; query: string; sources: string[] }[] = [];
  const service = new KnowledgeService(storage, storage, null);
  const config = { ...incidentConfig, services: [] };
  const replies: string[] = [];
  const events: Record<string, unknown>[] = [];
  const recipient = String(++serial);
  const captureErrors: unknown[] = [];
  const forbidAction = async () => { captureErrors.push(Error('BOOKING_ACTION')); throw Error('BOOKING_ACTION'); };
  for (const [i, id] of ['arrival', 'bring', 'receipt', 'decoy'].entries()) {
    if (genuineQuestion && i !== 3 || missing && i > 0 || i === 3 && !foreign) continue;
    const content = i === 3 ? fixture.decoy : fixture.sources[i];
    const businessId = i === 3 ? 78 : 77;
    await storage.create({ id, businessId, content, title: id, type: 'document', status: 'ready',
      createdAt: '2026-11-15', updatedAt: '2026-11-15', metadata: { segments: [{ start: 0, end: content.length, section: 'Text' }] } });
    await storage.replaceChunks(businessId, id, [{ chunkIndex: 0, content, metadata: { source: 'document', section: 'Text' } }]);
  }
  const sources = (await storage.list(77)).map(source => ({ sourceId: source.id, revision: knowledgeSourceRevision(source) }));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(String(body.chat_id ?? body.to ?? body.recipient?.id), recipient);
    if (body.chat_id) body.chat_id = '46700000001';
    else if (body.to) body.to = '46700000001';
    else body.recipient.id = '46700000001';
    replies.push(interceptedIncidentSend(url, { ...options, body: JSON.stringify(body) }));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  };
  try {
    const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
    boundary.reset();
    try {
      boundary.configure({
        continuityPlannerTiming, offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
        knowledgeSearch: async (id, query, limit) => {
          assert.equal(id, 77);
          const matches = await service.search(id, query, limit);
          queries.push({ tenant: id, query, sources: matches.map(match => match.sourceId) });
          return matches;
        },
        knowledgeSourceLanguages: id => service.sourceLanguageHints(id),
        ...(genuineQuestion || conversation ? {
          completeKnowledgeCorpus: service.completeSmallCorpus.bind(service),
          completeKnowledgeDocuments: service.completeSelectedDocuments.bind(service),
        } : {}),
        semanticKnowledgeSearchQueries: (id, queries, limit, options) => service.semanticSearchQueries(id, queries, limit, options),
        validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches,
          { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true }),
        knowledgeServiceCatalog: async () => [],
        evidenceFirstDecisionDiagnostic: event => events.push(event),
        aiGenerate: async request => {
          if (genuineQuestion || conversation) return generate(request, storage, events);
          const instruction = request.systemInstruction ?? '';
          if (instruction.includes('language-routing classifier'))
            return { text: '{"language":"sv","requestedReplyLanguage":null,"confidence":0.99}', functionCalls: [] };
          if (instruction.includes('retrieval query planner'))
            return { text: JSON.stringify({ canonicalMeaning: question, queries: [question], queryLanguages: {},
              requestKind: 'BUSINESS_INFORMATION', referenceResolution: 'NOT_REQUIRED', requestedFacets: questionFacets }), functionCalls: [] };
          if (instruction.includes('VERIFIED-UNIT PRESENTATION')) {
            const data = JSON.parse(request.messages[0].content);
            return { text: JSON.stringify({ unitIds: data.units.map((u: { id: string }) => u.id), prefix: 'none', addition: false }), functionCalls: [] };
          }
          return generate(request, storage, events);
        },
        calendarAdapter: { getCalendarId: () => 'fixture', getEvents: forbidAction, checkSlots: forbidAction,
          insertAppointment: forbidAction, cancelAppointment: forbidAction, updateAppointment: forbidAction },
        recordAppointment: forbidAction, cancelAppointmentRow: forbidAction, updateAppointmentRow: forbidAction,
      });
      await incidentInbound(boundary, channel, customerQuestion, recipient);
      let finalTurnEventStart = 0;
      if (conversation?.[1] !== undefined) {
        assert.equal(replies.length, 1);
        assert.deepEqual(captureErrors, []);
        const sessionId = incidentSession(boundary, channel, recipient);
        beforeFollowUp?.(replies[0], events.filter(e => e.stage === 'publication').at(-1)?.route,
          boundary.promptAuditHistory(sessionId), sessionId);
        finalTurnEventStart = events.length;
        await incidentInbound(boundary, channel, conversation[1], recipient);
      }
      assert.deepEqual(captureErrors, []);
      assert.equal(replies.length, conversation?.length ?? 1);
      return { question: customerQuestion, sources, queries, candidate: replies.at(-1)!, replies, publication: events.slice(finalTurnEventStart).filter(e => e.stage === 'publication').at(-1)?.route, events };
    } finally { boundary.reset(); }
  } finally { globalThis.fetch = fetchBefore; corpus?.cleanup(); }
}
