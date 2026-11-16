import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, type AnswerManifest, type Evidence, type Facet,
} from '../../business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from '../../knowledge-timing-policy';
import { attestSameTurnManifest, KNOWLEDGE_SHADOW_FLAG, KNOWLEDGE_SHADOW_TENANTS, runKnowledgeShadow } from './knowledge-shadow';
import { produceShadowObligations, SHADOW_OBLIGATION_LIMIT, type ObligationProducerInput } from './obligation-producer';

// Offline only: no provider, database or network. Product facets come from the
// real planner parser; the end-to-end case uses the real product builder with
// scripted model outputs.
const TENANT = 77;
const PLAN = [
  { subject: 'payment receipt', attribute: 'recommendation to bring it', questionType: 'recommendation' },
  { subject: 'payment receipt', attribute: 'showing it on a phone', questionType: 'permission',
    obligations: [{ description: 'whether it may be shown on a phone', questionType: 'permission' },
      { description: 'whether a printed copy is recommended', questionType: 'recommendation' }] },
];
const planned = () => parseRequestedFacets(PLAN).facets;
const manifestOf = (facets: readonly Facet[], language = 'en') =>
  Object.freeze({ language, facets, units: [], outcomes: [], text: '', presentationFallback: false }) as unknown as AnswerManifest;
const base = (over: Partial<ObligationProducerInput> = {}): ObligationProducerInput => {
  const facets = planned();
  return { tenantId: TENANT, conversationId: 'c-opaque-1', turn: 3, language: 'en', planned: facets, manifest: manifestOf(facets), ...over };
};
const why = (r: ReturnType<typeof produceShadowObligations>) => 'reason' in r ? r.reason : 'ok';
const forge = (f: Facet, patch: Record<string, unknown>) => Object.freeze({ ...f, ...patch }) as Facet;
const forgeObligation = (f: Facet, j: number, patch: Record<string, unknown>) =>
  forge(f, { obligations: Object.freeze(f.obligations.map((o, k) => k === j ? Object.freeze({ ...o, ...patch }) : o)) });

test('maps every product obligation to one Brain V2 obligation with the exact ID, type and order', () => {
  const r = produceShadowObligations(base());
  assert.ok(r.ok);
  assert.deepEqual(r.obligations, [
    { obligationId: 'f1.o1', questionType: 'recommendation' },
    { obligationId: 'f2.o1', questionType: 'permission' },
    { obligationId: 'f2.o2', questionType: 'recommendation' }]);
  assert.equal(r.tenantId, TENANT); assert.equal(r.language, 'en'); assert.equal(r.turn, 3);
  assert.match(r.requestDigest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.obligations) && r.obligations.every(o => Object.isFrozen(o)));
});

test('deterministic, scoped and content-free scope digest', () => {
  const a = produceShadowObligations(base()), b = produceShadowObligations(base());
  assert.deepEqual(a, b);
  assert.ok(a.ok);
  const digest = (over: Partial<ObligationProducerInput>) => { const r = produceShadowObligations(base(over)); assert.ok(r.ok); return r.requestDigest; };
  for (const over of [{ tenantId: 78 }, { conversationId: 'c-opaque-2' }, { turn: 4 }])
    assert.notEqual(digest(over), a.requestDigest, JSON.stringify(over));
  // Wording never enters the digest: only identifiers and structure.
  const reworded = parseRequestedFacets(PLAN.map(f => ({ ...f, subject: 'kvitto' }))).facets;
  assert.equal(digest({ planned: reworded, manifest: manifestOf(reworded) }), a.requestDigest);
  assert.ok(!JSON.stringify(a).includes('payment receipt') && !JSON.stringify(a).includes('phone'));
});

test('invalid, unfrozen or hostile input fails closed without throwing', () => {
  const facets = planned();
  const hostile = new Proxy({}, { get() { throw new Error('hostile'); } });
  for (const [input, expected] of [
    [undefined, 'INVALID_INPUT'], [null, 'INVALID_INPUT'], [hostile, 'INVALID_INPUT'],
    [base({ tenantId: 0 }), 'INVALID_INPUT'], [base({ tenantId: 1.5 }), 'INVALID_INPUT'], [base({ turn: -1 }), 'INVALID_INPUT'],
    [base({ conversationId: '' }), 'INVALID_INPUT'], [base({ conversationId: 'x'.repeat(257) }), 'INVALID_INPUT'],
    [base({ manifest: { ...manifestOf(facets) } as AnswerManifest }), 'INVALID_INPUT'],          // unfrozen copy
    [base({ planned: facets.map(f => ({ ...f })) as Facet[], manifest: manifestOf(facets) }), 'INVALID_INPUT'],  // unfrozen facet
    [base({ planned: facets.map(f => Object.freeze({ ...f, obligations: f.obligations.map(o => ({ ...o })) })) as Facet[], manifest: manifestOf(facets) }), 'INVALID_INPUT'],  // unfrozen obligation
  ] as const) assert.equal(why(produceShadowObligations(input as ObligationProducerInput)), expected);
});

test('language must be supported and equal to the manifest language', () => {
  assert.equal(why(produceShadowObligations(base({ language: 'xx' }))), 'LANGUAGE_UNSUPPORTED');
  assert.equal(why(produceShadowObligations(base({ language: 'sv' }))), 'LANGUAGE_MISMATCH');
  const facets = planned();
  assert.equal(why(produceShadowObligations(base({ planned: facets, manifest: manifestOf(facets, 'ar') }))), 'LANGUAGE_MISMATCH');
});

test('missing, extra, reordered or altered obligations fail closed', () => {
  const facets = planned();
  const run = (p: readonly Facet[], m: readonly Facet[] = p) => why(produceShadowObligations(base({ planned: p, manifest: manifestOf(m) })));
  assert.equal(run([]), 'NO_OBLIGATIONS');
  assert.equal(run(facets, facets.slice(0, 1)), 'PLAN_MANIFEST_MISMATCH');                 // facet missing from manifest
  assert.equal(run(facets.slice(0, 1), facets), 'PLAN_MANIFEST_MISMATCH');                 // extra manifest facet
  assert.equal(run(facets, [facets[1], facets[0]]), 'PLAN_MANIFEST_MISMATCH');             // reordered
  assert.equal(run(facets, [facets[0], forge(facets[1], { obligations: Object.freeze(facets[1].obligations.slice(0, 1)) })]), 'PLAN_MANIFEST_MISMATCH');
  assert.equal(run(facets, [facets[0], forgeObligation(facets[1], 1, { questionType: 'requirement' })]), 'PLAN_MANIFEST_MISMATCH');
  assert.equal(run(facets, [facets[0], forgeObligation(facets[1], 0, { description: 'something else' })]), 'PLAN_MANIFEST_MISMATCH');
  assert.equal(run(facets, [forge(facets[0], { subject: 'other' }), facets[1]]), 'PLAN_MANIFEST_MISMATCH');
  assert.equal(run(facets, [forge(facets[0], { questionType: 'requirement' }), facets[1]]), 'PLAN_MANIFEST_MISMATCH');
  assert.equal(run([facets[0], forge(facets[1], { obligations: Object.freeze([]) })]), 'NO_OBLIGATIONS');
});

test('forged or ambiguous IDs and unsupported obligations fail closed', () => {
  const facets = planned();
  const run = (p: readonly Facet[]) => why(produceShadowObligations(base({ planned: p, manifest: manifestOf(p) })));
  assert.equal(run([forge(facets[0], { id: 'f9' }), facets[1]]), 'INVALID_OBLIGATION_ID');
  // A consistently renumbered facet (f9 with f9.o1) is still not the planner's ID.
  assert.equal(run([forge(forgeObligation(facets[0], 0, { id: 'f9.o1' }), { id: 'f9' }), facets[1]]), 'INVALID_OBLIGATION_ID');
  assert.equal(run([facets[0], forgeObligation(facets[1], 1, { id: 'f2.o1' })]), 'INVALID_OBLIGATION_ID');   // duplicate ID
  assert.equal(run([facets[0], forgeObligation(facets[1], 0, { id: 'v2-anything' })]), 'INVALID_OBLIGATION_ID');
  assert.equal(run([facets[0], forgeObligation(facets[1], 0, { questionType: 'opinion' })]), 'UNSUPPORTED_QUESTION_TYPE');
  assert.equal(run([forge(facets[0], { questionType: 'opinion' }), facets[1]]), 'UNSUPPORTED_QUESTION_TYPE');
  const catalog = (businessId: number) => [facets[0], forgeObligation(facets[1], 0,
    { catalogRequirement: Object.freeze({ businessId, serviceName: 'Cut', attributes: ['price', 'duration'] }) })];
  assert.equal(run(catalog(TENANT)), 'UNSUPPORTED_OBLIGATION');
  assert.equal(run(catalog(3)), 'TENANT_MISMATCH');
  const many = Array.from({ length: 5 }, (_, i) => Object.freeze({ id: `f${i + 1}`, subject: 's', attribute: 'a', questionType: 'description',
    obligations: Object.freeze([1, 2].map(j => Object.freeze({ id: `f${i + 1}.o${j}`, description: 'd', questionType: 'description' }))) }) as Facet);
  assert.ok(many.flatMap(f => f.obligations).length > SHADOW_OBLIGATION_LIMIT);
  assert.equal(run(many), 'OBLIGATION_LIMIT');
});

test('pure: inputs unchanged, no network, no logging', () => {
  const input = base();
  const before = JSON.stringify(input);
  const saved = { fetch: globalThis.fetch, info: console.info, log: console.log, warn: console.warn, error: console.error };
  const calls: string[] = [];
  globalThis.fetch = (async () => { calls.push('fetch'); throw new Error('network'); }) as typeof fetch;
  for (const k of ['info', 'log', 'warn', 'error'] as const) console[k] = () => { calls.push(k); };
  try { produceShadowObligations(input); produceShadowObligations(base({ language: 'sv' })); }
  finally { Object.assign(globalThis, { fetch: saved.fetch }); Object.assign(console, { info: saved.info, log: saved.log, warn: saved.warn, error: saved.error }); }
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(input), before);
});

// End to end with the real product builder: the producer output drives the
// Phase 6B shadow comparison inside the same native turn.
const AT = 1_800_000_000_000;
const ev = (id: string, sourceId: string, text: string): Evidence => Object.freeze({ id, businessId: TENANT, sourceId, chunkId: 'c-' + sourceId, version: 'r1', text });
const SV_RECOMMEND = 'Vi rekommenderar att du tar med ditt betalningskvitto till besöket.';
const SV_MOBILE = 'Du kan visa ditt betalningskvitto på mobilen.';
const EVIDENCE = [ev('e1', 'bring', SV_RECOMMEND), ev('e2', 'mobile', SV_MOBILE)];
const unit = (text: string, modality: string, evidenceId: string, quote: string, facetId: string) => ({
  facetIds: [facetId], subject: 'visitor', predicate: 'payment receipt', value: 'payment receipt', scope: 'visit',
  modality, negation: false, qualifiers: [], language: 'en', text, evidenceRefs: [{ evidenceId, exactQuote: quote }] });

test('end to end: producer output yields a deterministic same-turn shadow comparison', async () => {
  const facets = parseRequestedFacets([PLAN[0], { subject: 'payment receipt', attribute: 'showing it on a phone', questionType: 'permission' }]).facets;
  let result: unknown; let failure: unknown;
  await runAccuracyFirstNative(async () => {
    const manifest = await buildEvidenceFirstAnswer({
      question: 'Do you recommend bringing the payment receipt, and can I show it on my phone?', language: 'en', facets, evidence: EVIDENCE,
      businessId: TENANT, foreground: true, languageSafe: () => true, verificationProtocol: 'v2', extractionProtocol: 'v2',
      omitModelEvidenceVersions: true, authoritativeEvidence: '{}', businessTone: {}, history: [],
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => EVIDENCE,
      generate: async (stage, _i, data: any) => {
        if (stage === 'extraction') return { text: JSON.stringify({ oversized: false, units: [
          unit('The business recommends that you bring your payment receipt to the visit.', 'recommended', 'e1', SV_RECOMMEND, 'f1'),
          unit('You may show your payment receipt on your phone.', 'permitted', 'e2', SV_MOBILE, 'f2')] }) };
        if (stage === 'verification') return { text: JSON.stringify({
          decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true,
            qualifiersPreserved: true, relevant: true, languageCorrect: true, explicitAbsenceEvidence: false, negativeAbsence: false })),
          coverage: data.facets.map((f: any) => { const ids = data.units.filter((u: any) => u.facetIds.includes(f.id)).map((u: any) => u.id);
            return { facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: ids,
              obligations: [{ obligationId: f.id + '.o1', status: 'COVERED', unitIds: ids }] }; }) }) };
        if (stage === 'composition') return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
        throw new Error('unscripted ' + stage);
      },
    });
    try {
      const produced = produceShadowObligations({ tenantId: TENANT, conversationId: 'c-opaque-1', turn: 2, language: 'en', planned: facets, manifest });
      assert.ok(produced.ok, JSON.stringify(produced));
      assert.equal(attestSameTurnManifest(manifest, TENANT), true);
      const run = () => runKnowledgeShadow({ tenantId: TENANT, conversationId: produced.conversationId, turn: produced.turn,
        requestDigest: produced.requestDigest, manifest, current: { checkedAtMs: AT, evidence: EVIDENCE }, obligations: produced.obligations,
        env: { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: String(TENANT) } });
      result = [run(), run()];
    } catch (error) { failure = error; }
    return manifest;
  }, async () => { throw new Error('native timing failed'); });
  if (failure) throw failure;
  const [first, second] = result as any[];
  assert.deepEqual(first, second);
  assert.equal(first.status, 'COMPARED');
  assert.equal(first.agreement, true);
  assert.deepEqual(first.obligations.map((o: any) => [o.questionType, o.v1Coverage, o.v2Status]),
    [['recommendation', 'COMPLETE', 'BOUND'], ['permission', 'COMPLETE', 'BOUND']]);
});
