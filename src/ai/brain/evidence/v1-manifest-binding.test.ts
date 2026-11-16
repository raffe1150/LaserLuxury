import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, type AnswerManifest, type AnswerUnit, type Evidence,
} from '../../business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from '../../knowledge-timing-policy';
import { bindEvidence, type Scope } from './bind';
import { bindV1Manifest, type ObligationLink, type V1BindingInput } from './v1-manifest-binding';

// Offline only. Manifests come from the real product builder with scripted model
// outputs; the scripted verdicts exercise translation, never genuine verification.
const TENANT = 77;
const AT = 1_800_000_000_000;
const ev = (id: string, sourceId: string, text: string, version = 'r1'): Evidence =>
  Object.freeze({ id, businessId: TENANT, sourceId, chunkId: 'c-' + sourceId, version, text });
const SV_RECOMMEND = 'Vi rekommenderar att du tar med ditt betalningskvitto till besöket.';
const SV_MOBILE = 'Du kan visa ditt betalningskvitto på mobilen.';
const EVIDENCE = [ev('e1', 'bring', SV_RECOMMEND), ev('e2', 'mobile', SV_MOBILE)];
const scope = (obligationId: string, questionType: Scope['questionType'], language: string, tenantId = TENANT): Scope =>
  Object.freeze({ tenantId, conversationId: 'conv-1', turn: 2, obligationId, requestDigest: 'd'.repeat(64), language, questionType });
const unit = (text: string, language: string, modality: string, evidenceId: string, quote: string, facetId = 'f1') => ({
  facetIds: [facetId], subject: 'visitor', predicate: 'payment receipt', value: 'payment receipt', scope: 'visit',
  modality, negation: false, qualifiers: [], language, text, evidenceRefs: [{ evidenceId, exactQuote: quote }] });
const verdict = (data: any, relation: string, coverage: (facetId: string, ids: string[]) => Record<string, unknown>) => ({
  decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation, meaningPreserved: relation === 'ENTAILED',
    modalityPreserved: relation === 'ENTAILED', qualifiersPreserved: relation === 'ENTAILED', relevant: relation === 'ENTAILED',
    languageCorrect: true, explicitAbsenceEvidence: false, negativeAbsence: false })),
  coverage: data.facets.map((f: any) => coverage(f.id, data.units.filter((u: any) => u.facetIds.includes(f.id)).map((u: any) => u.id))) });
const covered = (facetId: string, ids: string[]) => ({ facetId, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
  materialUnitIds: ids, obligations: [{ obligationId: facetId + '.o1', status: 'COVERED', unitIds: ids }] });

type Built = { manifest: AnswerManifest; bind: (input: Omit<V1BindingInput, 'manifest'>) => ReturnType<typeof bindV1Manifest> };
/** Builds a manifest in the native timing scope and binds it inside that same scope. */
async function build(input: { question: string; language: string; facets: unknown; history?: unknown;
  priorVerifiedReply?: Parameters<typeof buildEvidenceFirstAnswer>[0]['priorVerifiedReply'];
  extraction: (data: any) => unknown; verification: (data: any) => unknown },
  bindings: readonly Omit<V1BindingInput, 'manifest'>[]) {
  const results: ReturnType<typeof bindV1Manifest>[] = [];
  let built: AnswerManifest | undefined;
  await runAccuracyFirstNative(async () => {
    const manifest = await buildEvidenceFirstAnswer({
      question: input.question, language: input.language, facets: parseRequestedFacets(input.facets).facets, evidence: EVIDENCE,
      businessId: TENANT, foreground: true, languageSafe: () => true, verificationProtocol: 'v2', extractionProtocol: 'v2',
      omitModelEvidenceVersions: true, authoritativeEvidence: '{}', businessTone: {}, history: input.history ?? [],
      priorVerifiedReply: input.priorVerifiedReply, budget: new InformationBudget(undefined, nativeKnowledgeTiming()),
      current: async () => true, revalidateEvidence: async () => EVIDENCE,
      generate: async (stage, _instruction, data: any) => {
        if (stage === 'extraction') return { text: JSON.stringify(input.extraction(data)) };
        if (stage === 'verification') return { text: JSON.stringify(input.verification(data)) };
        if (stage === 'composition') return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
        throw new Error('unscripted ' + stage);
      },
    });
    built = manifest;
    for (const binding of bindings) results.push(bindV1Manifest({ ...binding, manifest }));
    return manifest;
  }, async () => { throw new Error('native timing failed'); });
  assert.ok(built);
  return { manifest: built!, results };
}

const EN_QUESTION = 'Do you recommend bringing the payment receipt, and can I show it on my phone?';
const EN_FACETS = [
  { subject: 'payment receipt', attribute: 'recommendation to bring it', questionType: 'recommendation' },
  { subject: 'payment receipt', attribute: 'showing it on a phone', questionType: 'permission' }];
const enVerified = (bindings: readonly Omit<V1BindingInput, 'manifest'>[]) => build({ question: EN_QUESTION, language: 'en', facets: EN_FACETS,
  extraction: () => ({ oversized: false, units: [
    unit('The business recommends that you bring your payment receipt to the visit.', 'en', 'recommended', 'e1', SV_RECOMMEND, 'f1'),
    unit('You may show your payment receipt on your phone.', 'en', 'permitted', 'e2', SV_MOBILE, 'f2')] }),
  verification: data => verdict(data, 'ENTAILED', covered) }, bindings);
const enLinks = (): ObligationLink[] => [
  { scope: scope('v2-o1', 'recommendation', 'en'), facetId: 'f1', obligationId: 'f1.o1' },
  { scope: scope('v2-o2', 'permission', 'en'), facetId: 'f2', obligationId: 'f2.o1' }];
const current = { checkedAtMs: AT, evidence: EVIDENCE };

// Arabic other-payer follow-up: verified recommendation (partial) or UNKNOWN (zero-fact notice).
const AR_PRIOR_USER = 'لا تلغ موعدي. هل تنصحون بإحضار إيصال الدفع؟';
const AR_ADVICE = 'توصي الجهة المقدمة للخدمة بإحضار إيصال الدفع إلى الموعد.';
const arPriorUnit: AnswerUnit = Object.freeze({ id: 'u1', facetIds: ['f1'], subject: 'visitor', predicate: 'payment receipt', value: 'payment receipt',
  verification: 'ENTAILED', modality: 'recommended', negation: false, scope: 'visit', qualifiers: [], language: 'ar', text: AR_ADVICE,
  evidenceRefs: [{ evidenceId: 'e1', sourceId: 'bring', chunkId: 'c-bring', version: 'r1', exactQuote: SV_RECOMMEND }] });
const arFollowUp = (relation: 'ENTAILED' | 'UNKNOWN', bindings: readonly Omit<V1BindingInput, 'manifest'>[]) => build({
  question: 'وهل يجب إحضاره إذا دفع شخص آخر؟', language: 'ar',
  facets: [{ subject: 'payment receipt', attribute: 'requirement to bring it when someone else paid', questionType: 'requirement',
    obligations: [{ description: 'whether the payment receipt must be brought when another person made the payment', questionType: 'requirement' }] }],
  history: [{ role: 'user', content: AR_PRIOR_USER }, { role: 'assistant', content: AR_ADVICE }],
  priorVerifiedReply: { user: AR_PRIOR_USER, reply: AR_ADVICE, units: [arPriorUnit] },
  extraction: () => ({ oversized: false, units: [unit(AR_ADVICE, 'ar', 'recommended', 'e1', SV_RECOMMEND)] }),
  verification: data => verdict(data, relation, (facetId, ids) => ({ facetId, requestAligned: true, materialFactsComplete: false,
    incompletenessReason: 'MISSING_CONDITION', materialUnitIds: relation === 'ENTAILED' ? ids : [],
    obligations: [{ obligationId: facetId + '.o1', status: 'UNRESOLVED', unitIds: [] }] })) }, bindings);
const arLink = (): ObligationLink[] => [{ scope: scope('v2-ar', 'requirement', 'ar'), facetId: 'f1', obligationId: 'f1.o1' }];

test('fully verified answer binds every obligation and Brain V2 accepts it as current, reviewed evidence', async () => {
  const { manifest, results: [result] } = await enVerified([{ tenantId: TENANT, current, links: enLinks() }]);
  assert.equal(manifest.outcomes.every(o => o.status === 'VERIFIED'), true);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.publication, 'VERIFIED');
  assert.deepEqual(result.obligations.map(o => o.coverage), ['COMPLETE', 'COMPLETE']);
  for (const link of enLinks()) {
    const bound = bindEvidence(link.scope, AT + 1, result.inventory, result.candidates, result.receipts);
    assert.equal(bound.status, 'BOUND', link.scope.obligationId + ' ' + bound.reason);
    assert.ok(bound.proposals.every(p => p.citation.tenantId === TENANT && p.citation.revision === 'r1'));
  }
  // Deterministic: identical input, identical output.
  const again = (await enVerified([{ tenantId: TENANT, current, links: enLinks() }])).results[0];
  assert.deepEqual(again, result);
});

test('verified partial answer with an uncertainty notice stays unresolved for the unanswered obligation', async () => {
  const { manifest, results: [result] } = await arFollowUp('ENTAILED', [{ tenantId: TENANT, current, links: arLink() }]);
  assert.ok(manifest.qualifiedPartial && manifest.unresolvedRequirements?.length, 'product issued a qualified partial');
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.publication, 'QUALIFIED_PARTIAL');
  assert.deepEqual(result.obligations.map(o => o.coverage), ['INCOMPLETE']);
  assert.deepEqual(result.candidates[0].units, [], 'the recommendation is never promoted into requirement coverage');
  assert.equal(bindEvidence(arLink()[0].scope, AT + 1, result.inventory, result.candidates, result.receipts).status, 'INDETERMINATE');
});

test('zero-fact unresolved notice binds without any factual authority', async () => {
  const { manifest, results: [result] } = await arFollowUp('UNKNOWN', [{ tenantId: TENANT, current, links: arLink() }]);
  assert.ok(manifest.unresolvedNoticeOnly && manifest.units.length === 0, 'product issued the zero-fact notice');
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.publication, 'UNRESOLVED_NOTICE');
  assert.deepEqual(result.candidates[0].units, []);
  assert.deepEqual(result.receipts[0].units, []);
  assert.equal(result.receipts[0].coverage, 'INCOMPLETE');
  const bound = bindEvidence(arLink()[0].scope, AT + 1, result.inventory, result.candidates, result.receipts);
  assert.notEqual(bound.status, 'BOUND');
  assert.deepEqual(bound.proposals, []);
});

test('cross-tenant, stale and ambiguous evidence fail closed', async () => {
  const stale = EVIDENCE.map(e => e.id === 'e1' ? ev('e1', 'bring', SV_RECOMMEND, 'r2') : e);
  const { results } = await enVerified([
    { tenantId: TENANT, current: { checkedAtMs: AT, evidence: [...EVIDENCE.slice(0, 1), { ...EVIDENCE[1], businessId: 78 }] }, links: enLinks() },
    { tenantId: 78, current, links: enLinks() },
    { tenantId: TENANT, current, links: enLinks().map((l, i) => i ? { ...l, scope: scope('v2-o2', 'permission', 'en', 78) } : l) },
    { tenantId: TENANT, current: { checkedAtMs: AT, evidence: stale }, links: enLinks() },
    { tenantId: TENANT, current: { checkedAtMs: AT, evidence: [...EVIDENCE, { ...ev('e3', 'bring', SV_RECOMMEND, 'r2') }] }, links: enLinks() },
    { tenantId: TENANT, current: { checkedAtMs: AT, evidence: [EVIDENCE[0]] }, links: enLinks() },
    { tenantId: TENANT, current: { checkedAtMs: AT, evidence: [EVIDENCE[0], ev('e2', 'mobile', 'Du kan visa kvittot.')] }, links: enLinks() },
  ]);
  assert.deepEqual(results.map(r => 'reason' in r ? r.reason : 'ok'), ['TENANT_MISMATCH', 'TENANT_MISMATCH', 'TENANT_MISMATCH',
    'STALE_OR_UNKNOWN_EVIDENCE', 'AMBIGUOUS_SOURCE_REVISION', 'STALE_OR_UNKNOWN_EVIDENCE', 'STALE_OR_UNKNOWN_EVIDENCE']);
});

test('unknown facet, unknown obligation, missing, duplicate or mistyped mappings fail closed', async () => {
  const [o1, o2] = enLinks();
  const { results } = await enVerified([
    { tenantId: TENANT, current, links: [o1, { ...o2, facetId: 'f9' }] },
    { tenantId: TENANT, current, links: [o1, { ...o2, obligationId: 'f2.o9' }] },
    { tenantId: TENANT, current, links: [o1] },
    { tenantId: TENANT, current, links: [o1, { ...o2, facetId: 'f1', obligationId: 'f1.o1' }] },
    { tenantId: TENANT, current, links: [o1, { ...o2, scope: { ...o2.scope, obligationId: 'v2-o1' } }] },
    { tenantId: TENANT, current, links: [o1, { ...o2, scope: { ...o2.scope, questionType: 'requirement' } }] },
    { tenantId: TENANT, current, links: [o1, { ...o2, scope: { ...o2.scope, language: 'sv' } }] },
    { tenantId: TENANT, current, links: [] },
  ]);
  assert.deepEqual(results.map(r => 'reason' in r ? r.reason : 'ok'), ['UNKNOWN_FACET', 'UNKNOWN_OBLIGATION', 'OBLIGATION_MAPPING_INCOMPLETE',
    'OBLIGATION_MAPPING_AMBIGUOUS', 'OBLIGATION_MAPPING_AMBIGUOUS', 'QUESTION_TYPE_MISMATCH', 'LANGUAGE_MISMATCH', 'INVALID_INPUT']);
});

test('forged or mismatched authority tokens and promoted unsupported claims fail closed', async () => {
  const partial = (await arFollowUp('ENTAILED', [])).manifest;
  const notice = (await arFollowUp('UNKNOWN', [])).manifest;
  const verified = (await enVerified([])).manifest;
  const outcomes: string[] = [];
  await runAccuracyFirstNative(async () => {
    const attempt = (manifest: AnswerManifest) => {
      const r = bindV1Manifest({ tenantId: TENANT, manifest, current, links: arLink() });
      outcomes.push('reason' in r ? r.reason : 'ok');
    };
    attempt({ ...partial, qualifiedPartial: {} });                                  // forged partial token
    attempt({ ...notice, unresolvedNoticeOnly: {} });                               // forged notice token
    attempt({ ...partial, text: partial.text + ' يجب إحضاره.' });                   // genuine token, altered contract
    attempt({ ...notice, unresolvedNoticeOnly: partial.qualifiedPartial });         // token from another manifest
    attempt({ ...notice, units: [arPriorUnit] });                                   // notice promoted to a fact
    return verified;
  }, async () => { throw new Error('native timing failed'); });
  assert.deepEqual(outcomes, ['NOT_PUBLISHABLE', 'NOT_PUBLISHABLE', 'NOT_PUBLISHABLE', 'NOT_PUBLISHABLE', 'NOT_PUBLISHABLE']);
  // A structurally complete manifest whose extra "verified" claim cites text absent from current evidence.
  const fabricated: AnswerUnit = Object.freeze({ ...verified.units[0], id: 'u9', text: 'You must bring the receipt.', modality: 'required',
    evidenceRefs: [{ ...verified.units[0].evidenceRefs[0], exactQuote: 'Du måste ta med kvittot.' }] });
  const promoted = { ...verified, units: [...verified.units, fabricated],
    outcomes: verified.outcomes.map(o => o.facetId === 'f1' ? { ...o, unitIds: [...o.unitIds, 'u9'], materialUnitIds: [...o.materialUnitIds, 'u9'],
      obligations: o.obligations.map(d => ({ ...d, unitIds: [...d.unitIds, 'u9'] })) } : o) };
  const unverified = { ...verified, units: verified.units.map((u, i) => i ? u : { ...u, verification: 'PROPOSED' as const }) };
  assert.deepEqual([promoted, unverified].map(manifest => {
    const r = bindV1Manifest({ tenantId: TENANT, manifest, current, links: enLinks() });
    return 'reason' in r ? r.reason : 'ok';
  }), ['STALE_OR_UNKNOWN_EVIDENCE', 'NOT_PUBLISHABLE']);
});

test('binding is read-only: inputs are not mutated and nothing is sent or written', async () => {
  const before = JSON.stringify(EVIDENCE);
  const fetchBefore = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => { network++; throw new Error('OFFLINE'); }) as typeof fetch;
  try {
    const { manifest, results: [result] } = await enVerified([{ tenantId: TENANT, current, links: enLinks() }]);
    const snapshot = JSON.stringify(manifest);
    assert.ok(result.ok);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.receipts) && Object.isFrozen(result.inventory));
    assert.equal(JSON.stringify(manifest), snapshot);
    assert.equal(JSON.stringify(EVIDENCE), before);
    assert.equal(network, 0);
  } finally { globalThis.fetch = fetchBefore; }
});

test('a covered obligation inside a partial facet is conservatively kept unbound (facet-level completeness not attested)', async () => {
  const links: ObligationLink[] = [
    { scope: scope('v2-rec', 'recommendation', 'en'), facetId: 'f1', obligationId: 'f1.o1' },
    { scope: scope('v2-req', 'requirement', 'en'), facetId: 'f1', obligationId: 'f1.o2' }];
  const { manifest, results: [result] } = await build({ question: 'Do you recommend bringing the payment receipt, and is it required?', language: 'en',
    facets: [{ subject: 'payment receipt', attribute: 'recommendation and requirement', questionType: 'recommendation', obligations: [
      { description: 'whether the payment receipt is recommended', questionType: 'recommendation' },
      { description: 'whether the payment receipt is required', questionType: 'requirement' }] }],
    extraction: () => ({ oversized: false, units: [unit('The business recommends that you bring your payment receipt to the visit.', 'en', 'recommended', 'e1', SV_RECOMMEND)] }),
    verification: data => verdict(data, 'ENTAILED', (facetId, ids) => ({ facetId, requestAligned: true, materialFactsComplete: false,
      incompletenessReason: 'UNRESOLVED', materialUnitIds: ids, obligations: [
        { obligationId: facetId + '.o1', status: 'COVERED', unitIds: ids }, { obligationId: facetId + '.o2', status: 'UNRESOLVED', unitIds: [] }] })) },
    [{ tenantId: TENANT, current, links }]);
  assert.ok(manifest.qualifiedPartial, 'product issued a qualified partial');
  assert.deepEqual(manifest.outcomes[0].obligations.map(o => o.status), ['COVERED', 'UNRESOLVED']);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.publication, 'QUALIFIED_PARTIAL');
  assert.deepEqual(result.obligations.map(o => o.coverage), ['INCOMPLETE', 'INCOMPLETE']);
  for (const link of links) assert.notEqual(bindEvidence(link.scope, AT + 1, result.inventory, result.candidates, result.receipts).status, 'BOUND');
});
