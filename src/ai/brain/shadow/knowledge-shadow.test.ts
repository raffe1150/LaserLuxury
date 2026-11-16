import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, type AnswerManifest, type AnswerUnit, type Evidence,
} from '../../business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from '../../knowledge-timing-policy';
import {
  attestSameTurnManifest, KNOWLEDGE_SHADOW_FLAG, KNOWLEDGE_SHADOW_TENANTS, knowledgeShadowConfig, runKnowledgeShadow,
  type KnowledgeShadowInput, type KnowledgeShadowRecord, type ShadowObligation,
} from './knowledge-shadow';

// Offline only. Manifests come from the real product builder with scripted model
// outputs; scripted verdicts exercise the shadow contract, never genuine quality.
const TENANT = 77;
const AT = 1_800_000_000_000;
const ON = Object.freeze({ [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: String(TENANT) });
const ev = (id: string, sourceId: string, text: string, version = 'r1', businessId = TENANT): Evidence =>
  Object.freeze({ id, businessId, sourceId, chunkId: 'c-' + sourceId, version, text });
const SV_RECOMMEND = 'Vi rekommenderar att du tar med ditt betalningskvitto till besöket.';
const SV_MOBILE = 'Du kan visa ditt betalningskvitto på mobilen.';
const EVIDENCE = [ev('e1', 'bring', SV_RECOMMEND), ev('e2', 'mobile', SV_MOBILE)];
const current = Object.freeze({ checkedAtMs: AT, evidence: EVIDENCE });
const EN_QUESTION = 'Do you recommend bringing the payment receipt, and can I show it on my phone?';
const EN_TEXTS = ['The business recommends that you bring your payment receipt to the visit.', 'You may show your payment receipt on your phone.'];
const AR_QUESTION = 'وهل يجب إحضاره إذا دفع شخص آخر؟';
const AR_PRIOR_USER = 'لا تلغ موعدي. هل تنصحون بإحضار إيصال الدفع؟';
const AR_ADVICE = 'توصي الجهة المقدمة للخدمة بإحضار إيصال الدفع إلى الموعد.';
const unit = (text: string, language: string, modality: string, evidenceId: string, quote: string, facetId = 'f1') => ({
  facetIds: [facetId], subject: 'visitor', predicate: 'payment receipt', value: 'payment receipt', scope: 'visit',
  modality, negation: false, qualifiers: [], language, text, evidenceRefs: [{ evidenceId, exactQuote: quote }] });
const verdict = (data: any, relation: string, coverage: (facetId: string, ids: string[]) => Record<string, unknown>) => ({
  decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation, meaningPreserved: relation === 'ENTAILED',
    modalityPreserved: relation === 'ENTAILED', qualifiersPreserved: relation === 'ENTAILED', relevant: relation === 'ENTAILED',
    languageCorrect: true, explicitAbsenceEvidence: false, negativeAbsence: false })),
  coverage: data.facets.map((f: any) => coverage(f.id, data.units.filter((u: any) => u.facetIds.includes(f.id)).map((u: any) => u.id))) });
const arPriorUnit: AnswerUnit = Object.freeze({ id: 'u1', facetIds: ['f1'], subject: 'visitor', predicate: 'payment receipt', value: 'payment receipt',
  verification: 'ENTAILED', modality: 'recommended', negation: false, scope: 'visit', qualifiers: [], language: 'ar', text: AR_ADVICE,
  evidenceRefs: [{ evidenceId: 'e1', sourceId: 'bring', chunkId: 'c-bring', version: 'r1', exactQuote: SV_RECOMMEND }] });

type Scenario = 'verified' | 'partial' | 'notice';
const SCENARIOS: Record<Scenario, { question: string; language: string; facets: unknown; history?: unknown; prior?: boolean;
  extraction: () => unknown; verification: (data: any) => unknown; obligations: ShadowObligation[] }> = {
  verified: { question: EN_QUESTION, language: 'en', facets: [
      { subject: 'payment receipt', attribute: 'recommendation to bring it', questionType: 'recommendation' },
      { subject: 'payment receipt', attribute: 'showing it on a phone', questionType: 'permission' }],
    extraction: () => ({ oversized: false, units: [unit(EN_TEXTS[0], 'en', 'recommended', 'e1', SV_RECOMMEND, 'f1'),
      unit(EN_TEXTS[1], 'en', 'permitted', 'e2', SV_MOBILE, 'f2')] }),
    verification: data => verdict(data, 'ENTAILED', (facetId, ids) => ({ facetId, requestAligned: true, materialFactsComplete: true,
      incompletenessReason: 'NONE', materialUnitIds: ids, obligations: [{ obligationId: facetId + '.o1', status: 'COVERED', unitIds: ids }] })),
    obligations: [{ obligationId: 'v2-o1', questionType: 'recommendation' }, { obligationId: 'v2-o2', questionType: 'permission' }] },
  partial: arabic('ENTAILED'),
  notice: arabic('UNKNOWN'),
};
function arabic(relation: 'ENTAILED' | 'UNKNOWN') {
  return { question: AR_QUESTION, language: 'ar', prior: true, facets: [{ subject: 'payment receipt', attribute: 'requirement to bring it when someone else paid',
      questionType: 'requirement', obligations: [{ description: 'whether the payment receipt must be brought when another person made the payment', questionType: 'requirement' }] }],
    history: [{ role: 'user', content: AR_PRIOR_USER }, { role: 'assistant', content: AR_ADVICE }],
    extraction: () => ({ oversized: false, units: [unit(AR_ADVICE, 'ar', 'recommended', 'e1', SV_RECOMMEND)] }),
    verification: (data: any) => verdict(data, relation, (facetId, ids) => ({ facetId, requestAligned: true, materialFactsComplete: false,
      incompletenessReason: 'MISSING_CONDITION', materialUnitIds: relation === 'ENTAILED' ? ids : [],
      obligations: [{ obligationId: facetId + '.o1', status: 'UNRESOLVED', unitIds: [] }] })),
    obligations: [{ obligationId: 'v2-ar', questionType: 'requirement' as const }] };
}

/** Runs the product builder in a native turn, then `inTurn` inside that same turn. */
async function turn<T>(name: Scenario, inTurn: (manifest: AnswerManifest) => T): Promise<{ manifest: AnswerManifest; value: T }> {
  const s = SCENARIOS[name];
  let out: { manifest: AnswerManifest; value: T } | undefined;
  let failure: unknown;
  // runAccuracyFirstNative deliberately swallows work errors; surface in-turn assertion failures.
  await runAccuracyFirstNative(async () => {
    const manifest = await buildEvidenceFirstAnswer({
      question: s.question, language: s.language, facets: parseRequestedFacets(s.facets).facets, evidence: EVIDENCE, businessId: TENANT,
      foreground: true, languageSafe: () => true, verificationProtocol: 'v2', extractionProtocol: 'v2', omitModelEvidenceVersions: true,
      authoritativeEvidence: '{}', businessTone: {}, history: s.history ?? [],
      priorVerifiedReply: s.prior ? { user: AR_PRIOR_USER, reply: AR_ADVICE, units: [arPriorUnit] } : undefined,
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => EVIDENCE,
      generate: async (stage, _instruction, data: any) => {
        if (stage === 'extraction') return { text: JSON.stringify(s.extraction()) };
        if (stage === 'verification') return { text: JSON.stringify(s.verification(data)) };
        if (stage === 'composition') return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
        throw new Error('unscripted ' + stage);
      },
    });
    try { out = { manifest, value: inTurn(manifest) }; } catch (error) { failure = error; }
    return manifest;
  }, async () => { throw new Error('native timing failed'); });
  if (failure) throw failure;
  if (!out) throw new Error('native turn produced no result');
  return out;
}
const input = (name: Scenario, manifest: AnswerManifest, extra: Partial<KnowledgeShadowInput> = {}): KnowledgeShadowInput => ({
  tenantId: TENANT, conversationId: 'conv-1', turn: 2, requestDigest: 'a'.repeat(64), manifest, current,
  obligations: SCENARIOS[name].obligations, env: ON, ...extra });
const attestAndRun = (name: Scenario, extra: (m: AnswerManifest) => Partial<KnowledgeShadowInput> = () => ({})) =>
  turn(name, manifest => { assert.equal(attestSameTurnManifest(manifest, TENANT), true); return runKnowledgeShadow(input(name, manifest, extra(manifest))); });
const reason = (r: KnowledgeShadowRecord) => r.status === 'REJECTED' && 'reason' in r ? r.reason : r.status;

test('configuration is OFF unless exactly "on" with a valid non-empty tenant allowlist', () => {
  assert.equal(knowledgeShadowConfig({}).enabled, false);
  for (const env of [{ [KNOWLEDGE_SHADOW_FLAG]: 'ON', [KNOWLEDGE_SHADOW_TENANTS]: '77' }, { [KNOWLEDGE_SHADOW_FLAG]: '1', [KNOWLEDGE_SHADOW_TENANTS]: '77' },
    { [KNOWLEDGE_SHADOW_FLAG]: 'on' }, { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '' },
    { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '77,abc' }, { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '0' },
    { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '-77' }, { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '99999999999999999' }])
    assert.equal(knowledgeShadowConfig(env).enabled, false, JSON.stringify(env));
  assert.deepEqual([...knowledgeShadowConfig({ [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: ' 77 , 3 ' }).tenants], [77, 3]);
  // The live process environment does not enable it.
  assert.equal(knowledgeShadowConfig().enabled, false);
});

test('disabled flag and non-allowlisted tenant do no shadow work at all', async () => {
  const { manifest, value } = await turn('verified', m => [
    runKnowledgeShadow(input('verified', m, { env: {} })),                                            // flag OFF, not even attested
    runKnowledgeShadow(input('verified', m, { env: { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '3' } })),
    runKnowledgeShadow(input('verified', m, { env: undefined })),                                     // default: process env
  ]);
  assert.deepEqual(value.map(r => r.status), ['DISABLED', 'NOT_ALLOWLISTED', 'DISABLED']);
  assert.ok(Object.isFrozen(manifest));
});

test('eligible tenant with the same-turn manifest produces a deterministic, content-free comparison', async () => {
  const verified = (await attestAndRun('verified')).value;
  assert.equal(verified.status, 'COMPARED');
  assert.ok(verified.status === 'COMPARED');
  assert.equal(verified.publication, 'VERIFIED');
  assert.equal(verified.agreement, true);
  assert.deepEqual(verified.obligations.map(o => [o.questionType, o.v1Coverage, o.v2Status]),
    [['recommendation', 'COMPLETE', 'BOUND'], ['permission', 'COMPLETE', 'BOUND']]);
  assert.deepEqual((await attestAndRun('verified')).value, verified, 'deterministic across independent turns');
  for (const [name, publication] of [['partial', 'QUALIFIED_PARTIAL'], ['notice', 'UNRESOLVED_NOTICE']] as const) {
    const r = (await attestAndRun(name)).value;
    assert.ok(r.status === 'COMPARED', name + ' ' + JSON.stringify(r));
    assert.equal(r.publication, publication);
    assert.equal(r.agreement, true);
    assert.deepEqual(r.obligations.map(o => [o.v1Coverage, o.v2Status]), [['INCOMPLETE', 'INDETERMINATE']], name);
  }
  // No customer question, business source or reply text in any record.
  const serialized = JSON.stringify([verified, (await attestAndRun('notice')).value]);
  for (const sensitive of [EN_QUESTION, ...EN_TEXTS, SV_RECOMMEND, SV_MOBILE, AR_QUESTION, AR_ADVICE, 'payment receipt', 'conv-1'])
    assert.ok(!serialized.includes(sensitive), sensitive);
});

test('serialized, cloned, cross-turn, cross-tenant or unattested manifests are rejected for provenance', async () => {
  const { manifest, value } = await turn('verified', m => {
    attestSameTurnManifest(m, TENANT);
    const clone = JSON.parse(JSON.stringify(m));
    return [
      runKnowledgeShadow(input('verified', Object.freeze(clone))),                                   // serialized copy
      runKnowledgeShadow(input('verified', Object.freeze({ ...m }))),                                // shallow clone
      runKnowledgeShadow(input('verified', m, { tenantId: 3, env: { [KNOWLEDGE_SHADOW_FLAG]: 'on', [KNOWLEDGE_SHADOW_TENANTS]: '3,77' } })),
      attestSameTurnManifest(m, TENANT),                                                             // no re-attestation
      attestSameTurnManifest({ ...m } as AnswerManifest, TENANT),                                     // unfrozen object
    ];
  });
  assert.deepEqual(value.map(r => typeof r === 'boolean' ? r : reason(r)), ['PROVENANCE', 'PROVENANCE', 'PROVENANCE', false, false]);
  // Outside the native turn: neither attestation nor comparison is possible.
  assert.equal(attestSameTurnManifest(manifest, TENANT), false);
  assert.equal(reason(runKnowledgeShadow(input('verified', manifest))), 'PROVENANCE');
  // A manifest attested in another turn is rejected in this turn.
  const other = await turn('verified', m => { assert.equal(attestSameTurnManifest(m, TENANT), true); return m; });   // attested in turn A
  await turn('verified', () => assert.equal(reason(runKnowledgeShadow(input('verified', other.manifest))), 'PROVENANCE'));
  await turn('notice', m => assert.equal(reason(runKnowledgeShadow(input('notice', m))), 'PROVENANCE'));   // never attested
});

test('stale, foreign or ambiguous evidence and missing or mismatched obligation mappings fail closed', async () => {
  const run = (extra: (m: AnswerManifest) => Partial<KnowledgeShadowInput>) => attestAndRun('verified', extra).then(r => reason(r.value));
  const results = [
    await run(() => ({ current: { checkedAtMs: AT, evidence: [ev('e1', 'bring', SV_RECOMMEND, 'r2'), EVIDENCE[1]] } })),
    await run(() => ({ current: { checkedAtMs: AT, evidence: [EVIDENCE[0], ev('e2', 'mobile', SV_MOBILE, 'r1', 78)] } })),
    await run(() => ({ current: { checkedAtMs: AT, evidence: [...EVIDENCE, ev('e3', 'bring', SV_RECOMMEND, 'r2')] } })),
    await run(() => ({ current: { checkedAtMs: AT, evidence: [EVIDENCE[0]] } })),
    await run(() => ({ obligations: [SCENARIOS.verified.obligations[0]] })),
    await run(() => ({ obligations: [...SCENARIOS.verified.obligations].reverse() })),
    await run(() => ({ obligations: [{ obligationId: 'x', questionType: 'recommendation' }, { obligationId: 'x', questionType: 'permission' }] })),
    await run(() => ({ obligations: [] })),
    await run(() => ({ requestDigest: 'not-a-digest' })),
  ];
  assert.deepEqual(results, ['STALE_OR_UNKNOWN_EVIDENCE', 'TENANT_MISMATCH', 'AMBIGUOUS_SOURCE_REVISION', 'STALE_OR_UNKNOWN_EVIDENCE',
    'MAPPING_UNAVAILABLE', 'MAPPING_UNAVAILABLE', 'MAPPING_UNAVAILABLE', 'MAPPING_UNAVAILABLE', 'INVALID_INPUT']);
});

test('shadow failure never throws and never changes the product manifest; no provider calls are made', async () => {
  const fetchBefore = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => { network++; throw new Error('OFFLINE'); }) as typeof fetch;
  try {
    const { manifest, value } = await turn('verified', m => {
      const before = JSON.stringify(m);
      attestSameTurnManifest(m, TENANT);
      const hostile = { checkedAtMs: AT, get evidence(): readonly Evidence[] { throw new Error('boom'); } };
      const results = [runKnowledgeShadow(input('verified', m, { current: hostile })),
        runKnowledgeShadow(undefined as unknown as KnowledgeShadowInput), runKnowledgeShadow(input('verified', m))];
      assert.equal(JSON.stringify(m), before);
      return results.map(r => r.status);
    });
    assert.deepEqual(value, ['ERROR', 'DISABLED', 'COMPARED']);
    assert.ok(Object.isFrozen(manifest) && manifest.text.includes(EN_TEXTS[0]), 'the product reply is untouched');
    assert.equal(network, 0);
  } finally { globalThis.fetch = fetchBefore; }
});
