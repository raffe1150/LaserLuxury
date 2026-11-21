/** Tier B natural composer (shadow only): pure gates and the bounded runner.
 * Every provider call is a deterministic MOCK; nothing here is a genuine model result. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composerProposalReason, composerRequestData, composerSnapshot, naturalComposerConfig, previousCustomerMessage,
  resetNaturalComposerBounds, runNaturalComposer, runNaturalComposerShadow, type ResolvedNaturalModels } from './natural-composer-shadow';
import { routeNaturalComposerModels } from './model-routing';
import { recordingNaturalBudget, type BudgetLogEntry } from '../../tests/helpers/natural-composer-test-budget';
import { naturalContractHash, parseNaturalProposal, NATURAL_FLAGS } from './grounded-knowledge-composition';

const ARRIVAL = 'For a first visit, we recommend arriving about 10 minutes before your appointment.';
const CONFIRM = 'We recommend bringing your booking confirmation digitally or on paper.';
const NOTICE = 'The full answer to “do I need to bring anything?” cannot be confirmed from the available information.';
const QUESTION = "I'm coming for the first time. How many minutes before my appointment should I arrive, and do I need to bring anything with me?";
const unit = (id: string, facet: string, text: string, modality = 'recommended') => ({ id, facetIds: [facet], text, modality, negation: false,
  subject: 's', predicate: 'p', value: 'v', scope: 'first visit', qualifiers: [], language: 'en', verification: 'ENTAILED',
  evidenceRefs: [{ evidenceId: 'e1', sourceId: 'src-secret', chunkId: 'c', version: 'v', exactQuote: 'Kunder som besöker studion' }] });
const facets = [{ id: 'f1', subject: 's', attribute: 'a', questionType: 'description', obligations: [{ id: 'f1.o1', description: 'd', questionType: 'description' }] },
  { id: 'f2', subject: 's', attribute: 'b', questionType: 'requirement', obligations: [{ id: 'f2.o1', description: 'r', questionType: 'requirement' }] }];
function manifest(over: Record<string, unknown> = {}): any {
  return { language: 'en', facets, units: [unit('u1', 'f1', ARRIVAL), unit('u2', 'f2', CONFIRM)],
    outcomes: [{ facetId: 'f1', status: 'VERIFIED', requestAligned: true, materialFactsComplete: true, unitIds: ['u1'], materialUnitIds: ['u1'], obligations: [{ obligationId: 'f1.o1', status: 'COVERED', unitIds: ['u1'] }] },
      { facetId: 'f2', status: 'UNAVAILABLE', requestAligned: true, materialFactsComplete: false, unitIds: [], materialUnitIds: [], obligations: [{ obligationId: 'f2.o1', status: 'UNRESOLVED', unitIds: [] }] }],
    presentation: { unitIds: ['u1', 'u2'], prefix: 'none', addition: false }, sourceLimitations: [{ facetId: 'f2', obligationId: 'f2.o1', text: NOTICE }],
    text: `${ARRIVAL} ${CONFIRM}\n\n${NOTICE}`, presentationFallback: false, presentationPath: 'direct_verified_units', fallbackReason: null, ...over };
}
const snapshot = () => composerSnapshot(manifest()).snapshot!;
const block = (kind: string, text: string, ords: number[] = [], obligations: string[] = []) => ({ kind, text, proposedUnitOrdinals: ords, obligationIds: obligations });
const GOOD = [block('courtesy', 'Welcome, happy to help!'), block('fact', 'For your first visit, it’s best to arrive about 10 minutes ahead of your appointment.', [1]),
  block('fact', 'Bringing your booking confirmation, on your phone or printed, is a good idea.', [2]), block('uncertainty', NOTICE, [], ['f2.o1'])];
const proposal = (blocks: unknown[]) => parseNaturalProposal({ blocks }, facets as any)!;
const safe = () => true;

test('config: default OFF, "active" without a tenant list is OFF, kill switch wins, strict allowlist and bounded daily cap', () => {
  assert.equal(naturalComposerConfig({}).mode, 'off');
  for (const v of ['active', 'on', 'true', 'SHADOW']) assert.equal(naturalComposerConfig({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: v }).mode, 'off', v);
  assert.equal(naturalComposerConfig({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'shadow' }).mode, 'shadow');
  assert.equal(naturalComposerConfig({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'shadow', ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_KILL: 'true' }).mode, 'off');
  assert.deepEqual([...naturalComposerConfig({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS: '3,x,0, 9' }).tenants], [3, 9]);
  assert.equal(naturalComposerConfig({}).dailyCap, 20);
  assert.equal(naturalComposerConfig({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_MAX_DAILY: '9999' }).dailyCap, 500);
  const models = routeNaturalComposerModels({});
  assert.ok(models.ok && models.composer === 'gpt-6.1-sol' && models.validator === 'gpt-5.6-luna', 'shared router: Sol composer, distinct Luna validator');
});

test('eligibility: verified units required; every unresolved obligation needs a verbatim backend notice', () => {
  assert.ok(snapshot());
  assert.equal(composerSnapshot(manifest({ units: [] })).reason, 'NO_VERIFIED_UNITS');
  assert.equal(composerSnapshot(manifest({ language: 'fr' })).reason, 'UNSUPPORTED_LANGUAGE');
  assert.equal(composerSnapshot(manifest({ sourceLimitations: undefined })).reason, 'UNSUPPORTED_SHAPE');
  assert.equal(composerSnapshot(manifest({ clarification: {} })).reason, 'UNSUPPORTED_SHAPE');
  assert.equal(composerSnapshot(manifest({ units: [unit('u7', 'f1', ARRIVAL)] })).reason, 'UNSUPPORTED_SHAPE');
});

test('the composer receives verified meanings only: no evidence quotes, source IDs or other data', () => {
  const data = composerRequestData(snapshot(), { channel: 'telegram', question: QUESTION, previousCustomerMessage: 'Hello' });
  const json = JSON.stringify(data);
  for (const forbidden of ['src-secret', 'Kunder som besöker', 'evidenceRefs', 'exactQuote', 'chunkId']) assert.ok(!json.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(data).sort(), ['channel', 'customerQuestion', 'language', 'notices', 'previousCustomerMessage', 'schemaVersion', 'tone', 'units']);
  assert.deepEqual(data.notices, [{ obligationIds: ['f2.o1'], text: NOTICE }]);
});

test('deterministic gate accepts a faithful natural rephrasing', () => {
  assert.equal(composerProposalReason(proposal(GOOD), snapshot(), QUESTION, safe), null);
});

const BAD: [string, unknown[], string][] = [
  ['changed quantity', [GOOD[1], GOOD[2], GOOD[3]].map((b: any, i) => i === 0 ? { ...b, text: b.text.replace('10', '15') } : b), 'QUANTITY_CHANGED'],
  ['dropped quantity', [block('fact', 'For your first visit, arrive a little early.', [1]), GOOD[2], GOOD[3]], 'QUANTITY_CHANGED'],
  ['optional item made mandatory', [GOOD[1], block('fact', 'You must bring your booking confirmation, digital or printed.', [2]), GOOD[3]], 'MODALITY_ESCALATION'],
  ['recommendation made a requirement', [block('fact', 'First-time visitors are required to arrive 10 minutes before the appointment.', [1]), GOOD[2], GOOD[3]], 'MODALITY_ESCALATION'],
  ['implies nothing else is needed', [GOOD[1], block('fact', 'Your booking confirmation, digital or printed, is the only thing worth bringing.', [2]), GOOD[3]], 'EXCLUSIVITY_ADDED'],
  ['notice paraphrased', [GOOD[1], GOOD[2], block('uncertainty', 'I am not sure what else you need.', [], ['f2.o1'])], 'NOTICE_ALTERED'],
  ['notice dropped', [GOOD[1], GOOD[2]], 'NOTICE_BINDINGS'],
  ['unit dropped', [GOOD[1], GOOD[3]], 'UNIT_BINDINGS'],
  ['unit duplicated', [GOOD[1], GOOD[2], block('fact', 'Again: about 10 minutes early.', [1]), GOOD[3]], 'UNIT_BINDINGS'],
  ['factual courtesy', [block('courtesy', 'Parking is free for you!'), GOOD[1], GOOD[2], GOOD[3]], 'COURTESY_FACTUAL'],
  ['booking offer in courtesy', [block('courtesy', 'Shall I book you in?'), GOOD[1], GOOD[2], GOOD[3]], 'COURTESY_FACTUAL'],
  ['operation claim', [GOOD[1], GOOD[2], GOOD[3], block('courtesy', 'I have booked your appointment.')], 'COURTESY_FACTUAL'],
  ['question echo', [block('courtesy', 'You asked: ' + QUESTION.slice(31, 120)), GOOD[1], GOOD[2], GOOD[3]], 'COURTESY_FACTUAL'],
];
for (const [name, blocks, reason] of BAD) test(`deterministic gate rejects: ${name}`, () => {
  const p = proposal(blocks);
  assert.ok(p, 'parses');
  assert.equal(composerProposalReason(p, snapshot(), QUESTION, safe), reason);
});
test('deterministic gate rejects wrong language and question echo in a fact block', () => {
  assert.equal(composerProposalReason(proposal(GOOD), snapshot(), QUESTION, () => false), 'LOCAL_LANGUAGE');
  const echo = [block('fact', `How many minutes before my appointment should I arrive? About 10 minutes, recommended for a first visit.`, [1]), GOOD[2], GOOD[3]];
  assert.equal(composerProposalReason(proposal(echo), snapshot(), 'How many minutes before my appointment should I arrive', safe), 'QUESTION_ECHO');
});

test('previousCustomerMessage returns only the earlier customer turn', () => {
  assert.equal(previousCustomerMessage([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'b' }]), 'a');
  assert.equal(previousCustomerMessage([{ role: 'user', content: 'b' }]), undefined);
});

// A rule-based validator mock: approves only when every unit's digits appear in its block
// and no block strengthens modality. It is NOT a genuine model verdict.
function validator(data: any, approve = true) {
  const p = data.proposal, contract = data.contract;
  const okBlocks = p.blocks.every((b: any) => b.kind !== 'fact' || b.unitIds.every((id: string) => {
    const u = contract.units.find((x: any) => x.id === id); return (u.text.match(/\d+/gu) || []).every((d: string) => b.text.includes(d));
  }) && !/\bmust\b|\brequired\b/iu.test(b.text));
  const pass = approve && okBlocks;
  return { contractHash: data.contractHash, proposalHash: data.proposalHash,
    blocks: p.blocks.map((b: any) => ({ blockId: b.id, relation: pass ? 'ENTAILED' : 'UNKNOWN', noUnsupportedFacts: pass, meaningPreserved: pass, uncertaintyAccurate: true })),
    unitCoverage: contract.units.map((u: any) => ({ unitId: u.id, blockIds: p.blocks.filter((b: any) => b.unitIds.includes(u.id)).map((b: any) => b.id), complete: true })),
    obligationCoverage: contract.outcomes.flatMap((o: any) => o.obligations.filter((d: any) => d.status === 'UNRESOLVED')).map((d: any) => ({ obligationId: d.obligationId,
      blockIds: p.blocks.filter((b: any) => b.obligationIds.includes(d.obligationId)).map((b: any) => b.id), accurate: true })),
    flags: Object.fromEntries(NATURAL_FLAGS.map(f => [f, pass])) };
}
function mockProvider(composerBlocks: unknown[] | string | Error | 'tool', opts: { approve?: boolean; validatorText?: string } = {}) {
  const calls: any[] = [];
  const generate = async (request: any) => {
    calls.push(request);
    const data = JSON.parse(request.messages[0].content);
    if (request.structuredOutput.name === 'odinlink_tierb_composer_v1') {
      if (composerBlocks instanceof Error) throw composerBlocks;
      if (composerBlocks === 'tool') return { text: '{}', functionCalls: [{ id: 't', function: { name: 'book', arguments: '{}' } }] };
      return { text: typeof composerBlocks === 'string' ? composerBlocks : JSON.stringify({ blocks: composerBlocks }), functionCalls: [], usage: { inputTokens: 900, outputTokens: 250 } };
    }
    return { text: opts.validatorText ?? JSON.stringify(validator(data, opts.approve ?? true)), functionCalls: [], usage: { inputTokens: 1400, outputTokens: 300 } };
  };
  return { calls, generate };
}
const MODELS = routeNaturalComposerModels({}) as ResolvedNaturalModels;
let turn = 0;
const runWith = (generate: any, over: Record<string, unknown> = {}, log: BudgetLogEntry[] = []) => runNaturalComposerShadow({ snapshot: snapshot(), businessId: 3, channel: 'telegram',
  question: QUESTION, turnId: over.turnId as string ?? `t${++turn}`, generate, languageSafe: safe, dailyCap: 20, models: MODELS, budget: recordingNaturalBudget(log), ...over });

test('runner: validated proposal, exactly two pinned no-tool calls, content-free record, never published', async () => {
  resetNaturalComposerBounds();
  const m = mockProvider(GOOD);
  const r = await runWith(m.generate, { turnId: 't1' });
  assert.deepEqual([r.outcome, r.reason, r.publication, r.modelCalls, r.model, r.validatorModel, r.inputTokens, r.outputTokens],
    ['validated', 'VALIDATED', 'never_published', 2, 'gpt-6.1-sol', 'gpt-5.6-luna', 2300, 550]);
  assert.deepEqual(m.calls.map(c => c.model), ['gpt-6.1-sol', 'gpt-5.6-luna'], 'routed composer and distinct validator');
  assert.ok(m.calls.every(c => Array.isArray(c.tools) && c.tools.length === 0 && c.signal instanceof AbortSignal && c.naturalComposerAdmission));
  const json = JSON.stringify(r);
  for (const text of [ARRIVAL, CONFIRM, NOTICE, QUESTION, 'arrive about 10']) assert.ok(!json.includes(text), 'record is content-free');
  // The validator is bound to the same contract the server would publish against.
  const validatorData = JSON.parse(m.calls[1].messages[0].content);
  assert.equal(validatorData.contractHash, naturalContractHash(snapshot(), { turnId: 't1', businessId: 3, question: QUESTION, tone: null }));
});

for (const [name, provider, expected, calls] of [
  ['malformed composer output', mockProvider('not json'), ['rejected', 'MALFORMED_PROPOSAL'], 1],
  ['tool call', mockProvider('tool'), ['error', 'TOOL_OUTPUT'], 1],
  ['provider failure', mockProvider(new Error('boom')), ['error', 'PROVIDER_FAILURE'], 1],
  ['timeout', mockProvider(Object.assign(new Error('t'), { name: 'TimeoutError' })), ['error', 'TIMEOUT'], 1],
  ['deterministic gate (escalation)', mockProvider([GOOD[1], block('fact', 'You must bring your booking confirmation, digital or printed.', [2]), GOOD[3]]), ['rejected', 'MODALITY_ESCALATION'], 1],
  ['independent validator rejects', mockProvider(GOOD, { approve: false }), ['rejected', 'NATURAL_SEMANTIC_REJECTION'], 2],
  ['malformed verdict', mockProvider(GOOD, { validatorText: '<html>' }), ['rejected', 'MALFORMED_VERDICT'], 2],
  ['verdict for another contract', mockProvider(GOOD, { validatorText: JSON.stringify({ ...validator({ proposal: { blocks: [] }, contract: { units: [], outcomes: [] }, contractHash: 'x', proposalHash: 'y' }) }) }), ['rejected', 'NATURAL_VERDICT_INVALID'], 2],
] as const) test(`runner: ${name} -> ${expected.join('/')}, bounded calls, never throws`, async () => {
  resetNaturalComposerBounds();
  const r = await runWith(provider.generate);
  assert.deepEqual([r.outcome, r.reason, r.modelCalls], [...expected, calls]);
});

test('runner bounds: one in flight per process, per-process daily cap', async () => {
  resetNaturalComposerBounds();
  let release!: () => void;
  let blocked = true, entered!: () => void;
  const inside = new Promise<void>(r => { entered = r; });
  // Only the first dispatch blocks (dispatch now follows an async reservation).
  const slow = async (request: any) => { if (blocked) { blocked = false; entered(); await new Promise<void>(r => { release = r; }); } return mockProvider(GOOD).generate(request); };
  const first = runWith(slow);
  await inside;
  const second = await runWith(mockProvider(GOOD).generate);
  assert.deepEqual([second.outcome, second.reason, second.modelCalls], ['skipped', 'BUSY', 0]);
  release(); await first;
  resetNaturalComposerBounds();
  for (let i = 0; i < 2; i++) await runWith(mockProvider(GOOD).generate, { dailyCap: 2 });
  const capped = await runWith(mockProvider(GOOD).generate, { dailyCap: 2 });
  assert.deepEqual([capped.outcome, capped.reason, capped.modelCalls], ['skipped', 'DAILY_CAP', 0]);
});

// ---------------------------------------------------------------------------
// Financial admission (2026-11-17). All provider calls are mocks; the budget is
// an in-memory test ledger. Proves reserve-before-dispatch, zero calls on any
// financial refusal, no downgrade, no retry and conservative unknown exposure.
const ops = (log: BudgetLogEntry[]) => log.map(e => `${e.op}:${e.stage.replace('knowledge_natural_', '')}:${e.model}`);

test('budget: every call is reserved before dispatch and settled from reported usage', async () => {
  resetNaturalComposerBounds();
  const log: BudgetLogEntry[] = [], order: string[] = [];
  const m = mockProvider(GOOD);
  const generate = async (request: any) => { order.push(`dispatch:${request.model}:${log.length}`); return m.generate(request); };
  const r = await runWith(generate, {}, log);
  assert.equal(r.outcome, 'validated');
  assert.deepEqual(ops(log), ['reserve:composition:gpt-6.1-sol', 'settle:composition:gpt-6.1-sol', 'reserve:validation:gpt-5.6-luna', 'settle:validation:gpt-5.6-luna']);
  assert.deepEqual(order, ['dispatch:gpt-6.1-sol:1', 'dispatch:gpt-5.6-luna:3'], 'each dispatch happens only after its own reservation');
  assert.deepEqual(m.calls.map(c => [c.routingStage, c.maxOutputTokens, c.reasoningEffort]),
    [['knowledge_natural_composition', 2000, 'low'], ['knowledge_natural_validation', 1200, 'low']]);
  // Settled = upper-bound usage cost (no cache discount): Sol 900*2500 + 250*10000; Luna 1400*250 + 300*1200.
  assert.deepEqual([log[1].nano, log[3].nano], [900 * 2500 + 250 * 10000, 1400 * 250 + 300 * 1200]);
  assert.equal(r.settledNanoUsd, log[1].nano + log[3].nano);
  assert.equal(r.reservations, 2); assert.equal(r.unknownRetainedNanoUsd, 0);
  assert.ok(r.reservedNanoUsd > 0 && r.reservedNanoUsd <= 2 * 150_000_000);
});

test('budget: missing ledger, unapproved rate version, denial and ledger failure => zero model calls, no downgrade', async () => {
  for (const [name, over, reason] of [
    ['no ledger', { budget: undefined }, 'LEDGER_UNAVAILABLE'],
    ['unapproved rate version', { budget: recordingNaturalBudget([], { approvedRateVersions: ['openai-sol-standard-30m-2026-10-28'] }) }, 'RATE_VERSION_UNAPPROVED'],
    ['reservation denied', { budget: recordingNaturalBudget([], { deny: () => true }) }, 'BUDGET_DENIED'],
    ['budget exhausted (historical exposure)', { budget: recordingNaturalBudget([], { historicalNanoUsd: 3_990_000_000 }) }, 'BUDGET_DENIED'],
    ['ledger state unknown', { budget: recordingNaturalBudget([], { throwOn: () => true }) }, 'RESERVATION_FAILED'],
  ] as const) {
    resetNaturalComposerBounds();
    const m = mockProvider(GOOD);
    const r = await runWith(m.generate, over as any);
    assert.deepEqual([r.outcome, r.reason, r.modelCalls, m.calls.length], ['skipped', reason, 0, 0], name);
  }
});

test('budget: validator denial after composition leaves the composer settled and dispatches nothing else', async () => {
  resetNaturalComposerBounds();
  const log: BudgetLogEntry[] = [];
  const m = mockProvider(GOOD);
  const r = await runWith(m.generate, { budget: recordingNaturalBudget(log, { deny: q => q.role === 'validator' }) });
  assert.deepEqual([r.outcome, r.reason, r.modelCalls, m.calls.length], ['error', 'BUDGET_DENIED', 1, 1]);
  assert.deepEqual(ops(log), ['reserve:composition:gpt-6.1-sol', 'settle:composition:gpt-6.1-sol', 'deny:validation:gpt-5.6-luna']);
});

test('budget: timeout, missing usage and over-reservation usage retain the FULL ceiling as unknown; never retried', async () => {
  for (const [name, provider, expected] of [
    ['timeout', mockProvider(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'DISPATCH_OUTCOME_UNKNOWN'],
    ['provider failure', mockProvider(new Error('boom')), 'DISPATCH_OUTCOME_UNKNOWN'],
  ] as const) {
    resetNaturalComposerBounds();
    const log: BudgetLogEntry[] = [];
    const r = await runWith(provider.generate, {}, log);
    assert.equal(provider.calls.length, 1, `${name}: exactly one dispatch, no retry`);
    assert.deepEqual(log.map(e => [e.op, e.reason]), [['reserve', undefined], ['unknown', expected]], name);
    assert.equal(log[1].nano, log[0].nano, 'full reservation retained');
    assert.equal(r.unknownRetainedNanoUsd, log[0].nano);
  }
  for (const [name, usage, reason] of [['missing usage', undefined, 'USAGE_MISSING'], ['over reservation', { inputTokens: 10_000_000, outputTokens: 0 }, 'USAGE_OVER_RESERVATION']] as const) {
    resetNaturalComposerBounds();
    const log: BudgetLogEntry[] = [];
    const m = mockProvider(GOOD);
    const generate = async (request: any) => ({ ...await m.generate(request), usage });
    await runWith(generate, {}, log);
    assert.deepEqual(log.filter(e => e.op === 'unknown').map(e => e.reason), [reason, reason], name);
  }
});

test('budget: duplicate turn id (replay/retry) is refused by the ledger before any dispatch', async () => {
  resetNaturalComposerBounds();
  const log: BudgetLogEntry[] = [], budget = recordingNaturalBudget(log);
  const first = mockProvider(GOOD), second = mockProvider(GOOD);
  await runWith(first.generate, { turnId: 'same-turn', budget });
  const replay = await runWith(second.generate, { turnId: 'same-turn', budget });
  assert.deepEqual([replay.outcome, replay.reason, second.calls.length], ['skipped', 'BUDGET_DENIED', 0]);
});

test('models: explicit Luna composer, separate validator, same-model only with owner override', async () => {
  for (const [env, composer, validator, independence] of [
    [{ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_MODEL: 'gpt-5.6-luna' }, 'gpt-5.6-luna', 'gpt-6.1-sol', 'distinct_model'],
    [{ ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_MODEL: 'gpt-6.1-sol', ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_ALLOW_SAME_MODEL: 'true' }, 'gpt-6.1-sol', 'gpt-6.1-sol', 'same_model_owner_override'],
  ] as const) {
    resetNaturalComposerBounds();
    const models = routeNaturalComposerModels(env) as ResolvedNaturalModels;
    const m = mockProvider(GOOD);
    const r = await runWith(m.generate, { models });
    assert.deepEqual([r.outcome, r.model, r.validatorModel, r.validatorIndependence], ['validated', composer, validator, independence]);
    assert.deepEqual(m.calls.map(c => c.model), [composer, validator]);
  }
});

// --- Active (customer-facing) mode: validated text only, otherwise canonical fallback ----------
test('config: active needs an explicit tenant list; the kill switch still wins', () => {
  const env = { ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'active', ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS: '3' };
  assert.equal(naturalComposerConfig(env).mode, 'active');
  assert.deepEqual([...naturalComposerConfig(env).tenants], [3]);
  assert.equal(naturalComposerConfig({ ...env, ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_TENANTS: 'x,0' }).mode, 'off');
  assert.equal(naturalComposerConfig({ ...env, ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_KILL: 'true' }).mode, 'off');
});
const runActive = (generate: any, over: Record<string, unknown> = {}, log: BudgetLogEntry[] = []) => runNaturalComposer({ snapshot: snapshot(), businessId: 3, channel: 'telegram',
  question: QUESTION, turnId: `a${++turn}`, generate, languageSafe: safe, dailyCap: 20, models: MODELS, budget: recordingNaturalBudget(log), publish: true, ...over });

test('active: a validated proposal returns its text for publication, with the backend notice verbatim', async () => {
  resetNaturalComposerBounds();
  const m = mockProvider(GOOD), r = await runActive(m.generate);
  assert.deepEqual([r.record.outcome, r.record.mode, r.record.publication], ['validated', 'active', 'published_validated']);
  assert.ok(r.text && r.text.includes(NOTICE) && r.text.includes('10 minutes'));
  assert.ok(!JSON.stringify(r.record).includes('10 minutes'), 'record stays content-free');
});

test('active: gate rejection, validator rejection, malformed verdict and provider failure return NO text (canonical fallback)', async () => {
  for (const [generate, reason] of [[mockProvider([GOOD[1], GOOD[2]]).generate, 'NOTICE_BINDINGS'], [mockProvider(GOOD, { approve: false }).generate, null],
    [mockProvider(GOOD, { validatorText: 'not json' }).generate, 'MALFORMED_VERDICT'], [mockProvider(new Error('boom')).generate, null]] as const) {
    resetNaturalComposerBounds();
    const r = await runActive(generate);
    assert.equal(r.text, undefined);
    assert.equal(r.record.publication, 'canonical_fallback');
    assert.notEqual(r.record.outcome, 'validated');
    if (reason) assert.equal(r.record.reason, reason);
  }
});

test('active: stage timeouts of the calling profile are applied to each call', async () => {
  resetNaturalComposerBounds();
  const seen: number[] = [];
  const m = mockProvider(GOOD);
  const r = await runActive(async (req: any) => { seen.push(req.signal ? 1 : 0); return m.generate(req); }, { timeouts: { composerMs: 9000, validatorMs: 7000 } });
  assert.equal(r.record.outcome, 'validated');
  resetNaturalComposerBounds();
  const keepAlive = setInterval(() => {}, 5); // AbortSignal.timeout timers are unref'd
  const slow = await runActive(async (req: any) => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    { timeouts: { composerMs: 30, validatorMs: 30 } });
  clearInterval(keepAlive);
  assert.deepEqual([slow.record.outcome, slow.record.reason, slow.text, slow.record.publication], ['error', 'TIMEOUT', undefined, 'canonical_fallback']);
});

test('active: a failed pre-dispatch attempt reservation dispatches nothing and keeps the hold as unknown', async () => {
  resetNaturalComposerBounds();
  const log: BudgetLogEntry[] = [], m = mockProvider(GOOD);
  const r = await runActive(m.generate, { beforeDispatch: async () => { throw new Error('attempt budget exhausted'); } }, log);
  assert.equal(m.calls.length, 0);
  assert.deepEqual([r.record.outcome, r.record.modelCalls, r.text], ['skipped', 0, undefined]);
  assert.deepEqual(log.map(e => [e.op, e.reason]), [['reserve', undefined], ['unknown', 'NOT_DISPATCHED_ATTEMPT']]);
});

test('active: durable accounting requires the message request key before any reservation', async () => {
  resetNaturalComposerBounds();
  const log: BudgetLogEntry[] = [], m = mockProvider(GOOD);
  const durable = { ...recordingNaturalBudget(log), accounting: 'durable-cross-instance' as const };
  const r = await runActive(m.generate, { budget: durable });
  assert.deepEqual([r.record.outcome, r.record.reason, m.calls.length, log.length], ['skipped', 'REQUEST_KEY_MISSING', 0, 0]);
});
