import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptOtherPayerRequirementInquiry } from './business-information-answer-plan';

// Offline-only: never run with real provider or database credentials in the environment.
process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'ODINLINK_SHARED_PG']) delete process.env[key];

// Genuine planner obligation for Arabic ar:2 (knowledge-ar-followup-only-e30258c2).
const genuineEnglish = 'whether the payment receipt must be brought when another person made the payment';
const arabicObligation = 'هل يجب إحضار إيصال الدفع إذا دفع شخص آخر؟';

test('receipt obligation parser admits only a payment-receipt requirement inquiry under the other-payer condition', () => {
  for (const ok of [genuineEnglish, 'Whether the payment receipt must be brought when someone else made the payment.',
    'Must I bring the payment receipt when someone else paid?', 'Is the payment receipt required if another person paid?',
    'Do I need to bring the payment receipt if a third party paid?', 'whether it is mandatory to present the payment receipt when another person paid'])
    assert.equal(receiptOtherPayerRequirementInquiry(ok), true, ok);
  for (const bad of [
    'the payment receipt must be brought when another person made the payment',       // assertion, not inquiry
    'the payment receipt is mandatory when another person paid',
    'whether it must be brought when another person made the payment',                 // unresolved pronoun
    'whether a passport must be brought when another person made the payment',        // wrong referent
    'whether the payment receipt or passport must be brought when another person paid',
    'whether the payment receipt must be brought',                                     // condition dropped
    'whether the payment receipt must be brought when the customer paid',              // wrong payer
    'whether the payment receipt must be brought when another person did not pay',
    'whether the payment receipt should be brought when another person paid',          // recommendation wording
    genuineEnglish + ' and whether identification is required',
    arabicObligation, undefined, 42])
    assert.equal(receiptOtherPayerRequirementInquiry(bad), false, String(bad));
});

type Case = { name: string; description: string; questionType?: string; unitText?: string; modality?: string; status?: string };
async function runFollowUp(c: Case) {
  const { HELD_OUT } = await import('./brain/phase4/held-out');
  const { runCustomerEntry } = await import('../../tests/helpers/brain-v2-swedish-customer');
  const { swedishKnowledgeFixture } = await import('../../tests/helpers/brain-v2-knowledge');
  const { fiveWire } = await import('../../tests/helpers/brain-v2-native-wires');
  const [first, follow] = HELD_OUT.find(row => row.language === 'ar')!.turns;
  const quote = swedishKnowledgeFixture.sources[1];
  const advice = 'يُنصح بإحضار إيصال الدفع عند الزيارة.';
  let history: { role: 'user' | 'assistant'; content: string }[] = [];
  const stages: string[] = [];
  const result = await runCustomerEntry(async request => {
    const following = history.length > 0;
    const { stage } = fiveWire(request, following ? follow.text : first.text, 'ar', history);
    stages.push(stage);
    const input = stage === 'language' ? undefined : JSON.parse(request.messages[0].content);
    const make: Record<string, () => unknown> = {
      language: () => ({ language: 'ar', requestedReplyLanguage: null, confidence: 0.99 }),
      planning: () => ({ canonicalMeaning: c.description, queries: [arabicObligation, 'betalningskvitto'],
        queryLanguages: [{ query: arabicObligation, language: 'ar' }, { query: 'betalningskvitto', language: 'sv' }],
        requestKind: 'BUSINESS_INFORMATION', referenceResolution: 'RESOLVED',
        requestedFacets: [{ subject: 'payment receipt', attribute: 'requirement to bring it when someone else paid', questionType: 'requirement',
          obligations: [{ description: c.description, questionType: c.questionType ?? 'requirement' }] }] }),
      extraction: () => {
        const evidence = input.evidence.find((item: { businessId: number; text: string }) => item.businessId === 77 && item.text.includes(quote));
        assert.ok(evidence);
        return { oversized: false, units: [{ facetIds: ['f1'], subject: 'visitor', predicate: 'bring', value: 'payment receipt', scope: 'visit',
          modality: following ? c.modality ?? 'recommended' : 'recommended', negation: false, qualifiers: [], language: 'ar',
          text: following ? c.unitText ?? advice : advice, evidenceRefs: [{ evidenceId: evidence.id, exactQuote: quote }] }] };
      },
      // Mock verdicts exercise local publication safety only; they are never genuine verification.
      verification: () => {
        const ids = input.units.map((unit: { id: string }) => unit.id);
        const status = following ? c.status ?? 'UNRESOLVED' : 'COVERED';
        return { decisions: input.units.map((unit: { id: string; facetIds: string[] }) => ({ unitId: unit.id, facetIds: unit.facetIds,
          relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true,
          explicitAbsenceEvidence: false, negativeAbsence: false })),
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: !following, incompletenessReason: following ? 'MISSING_CONDITION' : 'NONE',
            materialUnitIds: ids, obligations: [{ obligationId: 'f1.o1', status, unitIds: status === 'UNRESOLVED' ? [] : ids }] }] };
      },
    };
    if (!make[stage]) throw Error('UNEXPECTED_STAGE:' + stage);
    return { text: JSON.stringify(make[stage]()), functionCalls: [] };
  }, { channel: 'whatsapp', conversation: [first.text, follow.text], foreign: true, continuityPlannerTiming: true,
    beforeFollowUp(reply, publication) {
      assert.equal(publication, 'verified_manifest');
      history = [{ role: 'user', content: first.text }, { role: 'assistant', content: reply }];
    } });
  // A refusal may fail closed before extraction; a publication must traverse every native stage.
  const full = ['language', 'extraction', 'verification', 'language', 'planning', 'extraction', 'verification'];
  assert.deepEqual(stages, full.slice(0, stages.length), c.name);
  assert.ok(stages.length >= 5, c.name);
  return { ...result, stages };
}

const notice = /لا أستطيع تأكيد ما إذا كان إحضار إيصال الدفع إلزاميًا إذا دفع شخص آخر/u;

test('native Arabic follow-up publishes the verified recommendation and unresolved other-payer requirement from an English or Arabic obligation', async () => {
  for (const c of [{ name: 'arabic', description: arabicObligation }, { name: 'genuine-english', description: genuineEnglish },
    { name: 'english-question', description: 'Must I bring the payment receipt when someone else paid?' }]) {
    const result = await runFollowUp(c);
    assert.equal(result.stages.length, 7, c.name);
    assert.equal(result.publication, 'partial_manifest', c.name);
    assert.match(result.candidate, /يُنصح بإحضار إيصال الدفع/u, c.name);
    assert.match(result.candidate, notice, c.name);
    assert.doesNotMatch(result.candidate, /يجب إحضار/u, c.name);
    assert.ok(result.sources.every(source => source.sourceId !== 'decoy'));
  }
});

test('native Arabic follow-up refuses partial publication for unsupported referents, conditions or mandatory-receipt claims', async () => {
  for (const c of [
    { name: 'assertion', description: 'the payment receipt must be brought when another person made the payment' },
    { name: 'pronoun', description: 'whether it must be brought when another person made the payment' },
    { name: 'passport', description: 'whether a passport must be brought when another person made the payment' },
    { name: 'no-condition', description: 'whether the payment receipt must be brought' },
    { name: 'self-payer', description: 'whether the payment receipt must be brought when the customer paid' },
    { name: 'recommendation-type', description: genuineEnglish, questionType: 'recommendation' },
    { name: 'mandatory-unit-text', description: genuineEnglish, unitText: 'يجب إحضار إيصال الدفع عند الزيارة.' },
    { name: 'required-modality', description: genuineEnglish, modality: 'required' },
  ]) {
    const result = await runFollowUp(c);
    assert.notEqual(result.publication, 'partial_manifest', c.name);
    assert.doesNotMatch(result.candidate, notice, c.name);
    assert.doesNotMatch(result.candidate, /يجب إحضار إيصال الدفع/u, c.name);
  }
});

test('a verifier COVERED claim on incomplete facts is downgraded to the unresolved notice, never a requirement answer', async () => {
  const result = await runFollowUp({ name: 'covered-requirement', description: genuineEnglish, status: 'COVERED' });
  assert.match(result.candidate, notice);
  assert.doesNotMatch(result.candidate, /يجب إحضار إيصال الدفع/u);
  assert.ok(result.events.some(event => event.stage === 'publication' && Array.isArray(event.facets) &&
    event.facets.every((facet: { status: string }) => facet.status !== 'VERIFIED')));
});
