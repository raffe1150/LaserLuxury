/** Active Tier B in the durable async executor (offline). Knowledge stages and Tier B calls are deterministic MOCKS;
 * the Tier B budget is the in-memory test ledger. Nothing here is a genuine model result or a production write. */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { naturalLocationCases } from '../../tests/fixtures/knowledge-natural-location';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { recordingNaturalBudget, type BudgetLogEntry } from '../../tests/helpers/natural-composer-test-budget';
import { KnowledgeRunner } from './knowledge-runner';
import { NATURAL_FLAGS } from '../ai/grounded-knowledge-composition';
import { resetNaturalComposerBounds } from '../ai/natural-composer-shadow';
import { routeNaturalComposerModels } from '../ai/model-routing';
process.env.NODE_ENV = 'test'; process.env.GEMINI_API_KEY = 'synthetic-only'; process.env.AI_PROVIDER = 'gemini'; // Knowledge stages: Gemini mock
const { executeDurableKnowledgeTask, priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => b.reset());

const FLAGS = ['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE', 'ODINLINK_GROUNDED_NATURAL_RESPONSES', 'ODINLINK_KNOWLEDGE_NATURAL_COMPOSER',
  'ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS', 'ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_KILL'] as const;
function verdict(data: any, approve: boolean) {
  const p = data.proposal, contract = data.contract;
  return { contractHash: data.contractHash, proposalHash: data.proposalHash,
    blocks: p.blocks.map((x: any) => ({ blockId: x.id, relation: approve ? 'ENTAILED' : 'UNKNOWN', noUnsupportedFacts: approve, meaningPreserved: approve, uncertaintyAccurate: true })),
    unitCoverage: contract.units.map((u: any) => ({ unitId: u.id, blockIds: p.blocks.filter((x: any) => x.unitIds.includes(u.id)).map((x: any) => x.id), complete: true })),
    obligationCoverage: [], flags: Object.fromEntries(NATURAL_FLAGS.map(f => [f, approve])) };
}
type Mode = { supersedeAfterTierB?: boolean; env?: Record<string, string>; approve?: boolean; courtesy?: string; composerError?: Error; maxModelAttempts?: number; executionMs?: number };
async function run(channel: 'whatsapp' | 'telegram' | 'instagram' | 'messenger', language: string, question: string, fact: string, mode: Mode, t: any) {
  const previous = FLAGS.map(k => process.env[k]);
  process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true'; process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES = 'false';
  for (const k of FLAGS.slice(2)) delete process.env[k];
  Object.assign(process.env, mode.env ?? {});
  t.after(() => FLAGS.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }));
  for (const level of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, level, () => {});
  resetNaturalComposerBounds();
  const stages: string[] = [], tierB: string[] = [], records: any[] = [], log: BudgetLogEntry[] = [];
  b.configure({ knowledgeSearch: async () => [{ businessId: 77, sourceId: 'doc', text: fact, score: 1, metadata: { source: 'document', documentRevision: 'v1' } }],
    semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id, matches) => matches,
    geminiGenerate: async (p: any) => {
      const instruction = p.config.systemInstruction, data = JSON.parse(p.contents[0].parts[0].text);
      if (instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')) { stages.push('extraction'); return { text: JSON.stringify({ units: [{ facetIds: ['f1'], subject: 'studio',
        predicate: 'offers', value: fact, modality: 'descriptive', negation: false, scope: 'this business', qualifiers: [], language, text: fact, evidenceRefs: [{ evidenceId: 'e1', exactQuote: fact }] }] }) }; }
      if (instruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')) { stages.push('verification'); return { text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id,
        relation: 'ENTAILED', facetIds: u.facetIds, meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true,
        negativeAbsence: false, explicitAbsenceEvidence: false })), coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true,
        materialUnitIds: data.units.map((u: any) => u.id), obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })) }) }; }
      assert.fail('unexpected Knowledge call');
    },
    naturalComposerGenerate: async (request: any) => {
      const data = JSON.parse(request.messages[0].content);
      assert.deepEqual(request.tools, []); assert.ok(request.naturalComposerAdmission && request.signal instanceof AbortSignal);
      if (request.structuredOutput.name === 'odinlink_tierb_composer_v1') {
        tierB.push('composer'); if (mode.composerError) throw mode.composerError;
        const blocks = [...(mode.courtesy ? [{ kind: 'courtesy', text: mode.courtesy, proposedUnitOrdinals: [], obligationIds: [] }] : []),
          { kind: 'fact', text: data.units[0].text, proposedUnitOrdinals: [1], obligationIds: [] }];
        return { text: JSON.stringify({ blocks }), functionCalls: [], usage: { inputTokens: 900, outputTokens: 120 } };
      }
      tierB.push('validator');
      return { text: JSON.stringify(verdict(data, mode.approve ?? true)), functionCalls: [], usage: { inputTokens: 1400, outputTokens: 200 } };
    },
    naturalComposerBudget: recordingNaturalBudget(log), naturalComposerRecord: r => records.push(r),
    naturalComposerModels: routeNaturalComposerModels({}), naturalComposerBinding: { businessId: 77, turnId: 'durable-turn', requestKey: 'a'.repeat(64) },
    calendarAdapter: { getCalendarId: () => 'unused', getEvents: async () => assert.fail('No Booking reads'), insertAppointment: async () => assert.fail('No Booking mutations'),
      cancelAppointment: async () => assert.fail('No Booking mutations'), updateAppointment: async () => assert.fail('No Booking mutations'), checkSlots: async () => assert.fail('No Booking mutations') },
  } as any);
  const db = new FakeKnowledgeDatabase(), repo = new FakeKnowledgeLifecycle(db, Date.now, async () => true);
  const scope = { businessId: 77, channel, providerAccount: 'account', conversationId: randomUUID() };
  const accepted = await repo.accept(scope, randomUUID(), { question, language, history: [] },
    { executionMs: mode.executionMs ?? 75_000, ...(mode.maxModelAttempts ? { maxModelAttempts: mode.maxModelAttempts } : {}) });
  const delivery = await new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, context,
    { id: 77, businessId: 77, businessName: 'Synthetic studio', language, toneConfig: { tonePreset: 'warm' } },
    async () => !(mode.supersedeAfterTierB && tierB.length === 2)), 'worker').run(scope, accepted.task!.id);
  const task = (await repo.get(scope, accepted.task!.id))!;
  return { delivery, task, stages, tierB, records, log, deliveries: db.rows.deliveries.size };
}
// Six languages. fa/ar use native-script facts (the shared location fixture's Latin street names fail this mock's
// Phase 1 language check, independent of Tier B).
const LANGUAGE_CASES = [...naturalLocationCases.slice(3, 7).map(([l, q, f]) => [l, q, f] as const),
  ['fa', naturalLocationCases[7][1], 'پارکینگ رایگان در حیاط پشت استودیو قرار دارد.'] as const,
  ['ar', naturalLocationCases[8][1], 'يوجد موقف مجاني في الفناء الخلفي للاستوديو.'] as const];
const ACTIVE = { ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'active', ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS: '77' };
const [, enQuestion, enFact] = naturalLocationCases[3];

test('active: validated Tier B text is published once, after verification, with two extra durable attempts', async t => {
  const r = await run('telegram', 'en', enQuestion, enFact, { env: ACTIVE, courtesy: 'Happy to help!' }, t);
  assert.deepEqual([r.stages, r.tierB], [['extraction', 'verification'], ['composer', 'validator']]);
  assert.ok(r.delivery && r.delivery.text.includes('Happy to help!') && r.delivery.text.includes(enFact), r.delivery?.text);
  assert.equal(r.task.modelAttempts, 4); assert.equal(r.deliveries, 1); assert.equal(r.task.state, 'FINALIZED');
  assert.deepEqual(r.records.map(x => [x.mode, x.outcome, x.publication]), [['active', 'validated', 'published_validated']]);
  assert.deepEqual(r.log.map(e => e.op), ['reserve', 'settle', 'reserve', 'settle'], 'reserved before each dispatch, settled from usage');
});

test('active: validator rejection, composer failure and timeout publish the canonical verified answer', async t => {
  for (const mode of [{ approve: false }, { composerError: new Error('boom') }, { composerError: Object.assign(new Error('t'), { name: 'TimeoutError' }) }]) {
    const r = await run('whatsapp', 'en', enQuestion, enFact, { env: ACTIVE, courtesy: 'Happy to help!', ...mode }, t);
    assert.equal(r.delivery?.text, enFact); assert.equal(r.deliveries, 1);
    assert.equal(r.records.length, 1); assert.equal(r.records[0].publication, 'canonical_fallback');
  }
});

test('active: attempt budget that cannot hold both Tier B calls falls back canonically with zero Tier B calls', async t => {
  const r = await run('instagram', 'en', enQuestion, enFact, { env: ACTIVE, maxModelAttempts: 3 }, t);
  assert.equal(r.delivery?.text, enFact); assert.deepEqual(r.tierB, []); assert.equal(r.task.modelAttempts, 2);
  assert.deepEqual(r.records.map(x => [x.reason, x.publication]), [['ATTEMPT_BUDGET', 'canonical_fallback']]);
  assert.deepEqual(r.log, []);
});

test('active: a window whose compute share cannot hold the Tier B reserve falls back canonically', async t => {
  const r = await run('messenger', 'en', enQuestion, enFact, { env: ACTIVE, executionMs: 20_000 }, t);
  assert.equal(r.delivery?.text, enFact); assert.deepEqual(r.tierB, []);
  assert.deepEqual(r.records.map(x => x.reason), ['TIME_BUDGET']);
});

test('off by default, other tenants and kill switch: byte-identical canonical publication and zero Tier B calls', async t => {
  for (const env of [{}, { ...ACTIVE, ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS: '3' }, { ...ACTIVE, ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_KILL: 'true' },
    { ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'active' }]) {
    const r = await run('telegram', 'en', enQuestion, enFact, { env, courtesy: 'Happy to help!' }, t);
    assert.equal(r.delivery?.text, enFact, JSON.stringify(env)); assert.deepEqual(r.tierB, []); assert.deepEqual(r.records, []); assert.equal(r.task.modelAttempts, 2);
  }
});

for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const)
  for (const [language, question, fact] of LANGUAGE_CASES) test(`active ${channel}/${language}: validated text published exactly once`, async t => {
    const r = await run(channel, language, question, fact, { env: ACTIVE }, t);
    if (process.env.TIERB_DEBUG) process.stdout.write('DBG '+JSON.stringify({ stages: r.stages, state: r.task.state, attempts: r.task.modelAttempts, d: r.delivery?.text, fact })+'\n');
    assert.deepEqual([r.tierB, r.records.map(x => x.reason)], [["composer", "validator"], ["VALIDATED"]]);
    assert.equal(r.delivery?.text, fact); assert.equal(r.deliveries, 1);
    assert.equal(r.records[0].publication, 'published_validated');
  });

test('active: a turn superseded while Tier B ran publishes nothing (no stale or duplicate reply)', async t => {
  const r = await run('telegram', 'en', enQuestion, enFact, { env: ACTIVE, courtesy: 'Happy to help!', supersedeAfterTierB: true }, t);
  assert.deepEqual(r.tierB, ['composer', 'validator']);
  assert.equal(r.delivery, null); assert.equal(r.deliveries, 0); assert.equal(r.task.state, 'FAILED');
  assert.deepEqual(r.log.map(e => e.op), ['reserve', 'settle', 'reserve', 'settle'], 'spend stays accounted even though nothing is published');
});
