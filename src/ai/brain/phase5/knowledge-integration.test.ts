import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../../../knowledge';
import { fixtureKnowledgePort, swedishKnowledgeFixture } from '../../../../tests/helpers/brain-v2-knowledge';
import { incidentFlags } from '../../../../tests/helpers/p0-incident-knowledge';
import { shadowTurn } from '../phase4/pipeline';
import { composeResponse } from '../response/compose';
import type { TurnFrame } from '../memory/turn-frame';

incidentFlags();
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../../../server');

const suites = {
  en: {
    first: 'Do I need to arrive 15 minutes early if I already completed the form?',
    second: 'What should I bring to the visit?',
    follow: 'Do I still need to bring it?',
    sources: [
      'Arrive 15 minutes early if you have not completed the form. If you have already completed the form, early arrival is not required.',
      'We recommend you bring your payment receipt to the visit.',
      'The payment receipt can be shown on your phone.',
    ],
    decoy: 'You must arrive 90 minutes early and bring your passport to the visit.',
  },
  sv: swedishKnowledgeFixture,
} as const;

const tenantId = 77;
const sourceIds = ['arrival', 'bring', 'receipt'] as const;

for (const language of ['en', 'sv'] as const) test(`real fixture retrieval and fail-closed V2 composition, ${language}`, async t => {
  const spec = suites[language];
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage, storage, null);
  const providerStages: string[] = [];
  const runtimeEvidence: string[][] = [];
  const verificationEvents: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', () => assert.fail('Network prohibited'));
  t.after(() => boundary.reset());
  boundary.reset();
  boundary.configure({
    offlineAi: true,
    evidenceFirstDecisionDiagnostic: event => verificationEvents.push(event),
    validateKnowledgeMatches: async (id, matches) => {
      assert.equal(id, tenantId);
      assert.ok(matches.every(match => match.businessId === id));
      const current = await service.validateMatches(id, matches, { strictSources: true, requireCompleteDocumentContext: true });
      runtimeEvidence.push(current.map(match => match.sourceId));
      return current;
    },
    aiGenerate: async request => {
      providerStages.push(request.systemInstruction);
      throw new Error('GENUINE_PROVIDER_APPROVAL_REQUIRED');
    },
  });

  async function document(businessId: number, id: string, content: string) {
    await storage.create({ id, businessId, content, type: 'document', title: id, status: 'ready',
      createdAt: '2026-11-15', updatedAt: '2026-11-15',
      metadata: { segments: [{ start: 0, end: content.length, section: 'Text' }] } });
    await storage.replaceChunks(businessId, id, [{ chunkIndex: 0, content, metadata: { source: 'document', section: 'Text' } }]);
  }
  for (const [i, id] of sourceIds.entries()) await document(tenantId, id, spec.sources[i]);

  const question = spec.first + ' ' + spec.second;
  const wire = JSON.stringify({ version: 1, readings: [
    { intent: 'general_question', questionType: 'requirement', span: { start: 0, end: spec.first.length },
      conditions: [{ kind: 'if', explicit: true, span: {
        start: spec.first.indexOf(language === 'en' ? 'if ' : 'om '), end: spec.first.length - 1,
      } }] },
    { intent: 'general_question', questionType: 'recommendation', span: { start: spec.first.length + 1, end: question.length } },
  ] });
  async function run(name: string, text = question, output = wire, frame?: TurnFrame) {
    const binding = frame?.binding ?? { tenantId, conversationId: `knowledge-${language}-${name}` };
    const port = fixtureKnowledgePort(boundary, service, tenantId, text, verificationEvents);
    const result = await shadowTurn({ text, wire: output, frame, evidence: port.evidence,
      context: { binding, turn: frame ? frame.turn + 1 : 1, nowMs: Date.now(), timezone: 'Europe/Stockholm',
        catalog: { services: [], staff: [] }, language: { deterministicLanguage: language } } });
    const inventory = await port.refresh();
    const candidate = composeResponse({ ...result, current: {
      ...binding, turn: result.semantic.frame.turn, nowMs: Date.now(), language, inventory,
    } });
    assert.ok(candidate);
    assert.equal(candidate.publication, 'OFFLINE_ONLY');
    assert.equal(candidate.language, language);
    assert.ok(!result.semantic.guidance.some(item => item.kind === 'REFER_TO_BOOKING_AUTHORITY'));
    assert.ok(candidate.blocks.every(block => block.factIds.length === 0));
    return { result, inventory, candidate };
  }

  const complete = await run('complete');
  const sources = (inventory: typeof complete.inventory) => inventory.chunks.map(chunk => chunk.sourceId).sort();
  assert.deepEqual(sources(complete.inventory), [...sourceIds].sort());
  assert.equal(complete.result.semantic.readings[0].conditions?.[0].kind, 'if');
  assert.deepEqual(complete.candidate.blocks.map(block => block.kind), ['uncertainty', 'uncertainty']);
  assert.ok(runtimeEvidence.some(ids => sourceIds.every(id => ids.includes(id))));
  assert.ok(providerStages.some(instruction => instruction.includes('UNIT EXTRACTION')));

  await document(tenantId + 1, 'decoy', spec.decoy);
  const foreignMatches = await service.search(tenantId + 1, question);
  assert.ok(foreignMatches.some(row => row.sourceId === 'decoy'));
  assert.deepEqual(await service.validateMatches(tenantId, foreignMatches, { strictSources: true }), []);
  const foreign = await run('foreign');
  assert.deepEqual(foreign.inventory.chunks, complete.inventory.chunks);
  assert.equal(foreign.candidate.text, complete.candidate.text);
  assert.ok(runtimeEvidence.every(ids => !ids.includes('decoy')));

  assert.ok(await storage.delete(tenantId, 'bring'));
  const missing = await run('missing');
  assert.deepEqual(sources(missing.inventory), ['arrival', 'receipt']);
  assert.equal(missing.candidate.text, complete.candidate.text);

  const beforeFollow = providerStages.length;
  const follow = await run('follow', spec.follow, JSON.stringify({ version: 1, readings: [{
    intent: 'general_question', questionType: 'requirement', span: { start: 0, end: spec.follow.length }, missing: 'reference',
  }] }), complete.result.semantic.frame);
  assert.deepEqual(follow.candidate.blocks.map(block => block.kind), ['clarification']);
  assert.equal(follow.candidate.text, language === 'en' ? 'Which one do you mean?' : 'Vilken menar du?');
  assert.equal(follow.result.semantic.frame.goals.at(-1)?.pending?.field, 'reference');
  assert.equal(providerStages.length, beforeFollow);
});
