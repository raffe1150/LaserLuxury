import assert from 'node:assert/strict';
import test from 'node:test';
import { ARABIC_OTHER_PAYER_RECEIPT_UNRESOLVED, publishableKnowledgeManifest } from './business-information-answer-plan';

// Offline-only: never run with real provider or database credentials in the environment.
process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'ODINLINK_SHARED_PG']) delete process.env[key];

// Mock verdicts below exercise local publication safety only; they are never genuine verification.
const NOTICE = ARABIC_OTHER_PAYER_RECEIPT_UNRESOLVED;
const GENERIC_AR = 'لا أستطيع التحقق من إجابة بشأن التفاصيل المطلوبة الآن. يمكن للمنشأة تأكيد ما ينطبق.';
const ARABIC_OBLIGATION = 'هل يجب إحضار إيصال الدفع إذا دفع شخص آخر؟';
const ENGLISH_OBLIGATION = 'whether the payment receipt must be brought when another person made the payment';
const ADVICE = 'توصي الجهة المقدمة للخدمة بإحضار إيصال الدفع إلى الموعد.';

type Unit = { text: string; quote?: number; modality?: string; negation?: boolean; evidenceId?: string };
type Scenario = {
  language?: 'ar' | 'sv'; second?: string; description?: string;
  units?: Unit[]; relations?: string[]; coverage?: Record<string, unknown>;
  verify?: 'throw' | 'malformed'; firstRelation?: string; staleDuringVerification?: boolean;
};

async function run(s: Scenario) {
  const { HELD_OUT } = await import('./brain/phase4/held-out');
  const { runCustomerEntry } = await import('../../tests/helpers/brain-v2-swedish-customer');
  const { swedishKnowledgeFixture: fx } = await import('../../tests/helpers/brain-v2-knowledge');
  const language = s.language ?? 'ar';
  const [first, follow] = HELD_OUT.find(row => row.language === language)!.turns;
  const second = s.second ?? follow.text;
  const description = s.description ?? (language === 'ar' ? ARABIC_OBLIGATION : follow.text);
  let following = false;
  const stages: string[] = [];
  const result = await runCustomerEntry(async (request, storage) => {
    const instruction = request.systemInstruction ?? '';
    const stage = instruction.includes('language-routing classifier') ? 'language'
      : request.structuredOutput?.name === 'odinlink_knowledge_planning_v2' ? 'planning'
      : request.routingStage === 'knowledge_extraction' ? 'extraction'
      : request.routingStage === 'knowledge_verification' ? 'verification' : 'other:' + request.routingStage;
    stages.push((following ? 'f-' : '') + stage);
    const input = stage === 'language' ? undefined : JSON.parse(request.messages[0].content);
    const evidenceFor = (quote: string) => input.evidence.find((e: { businessId: number; text: string }) => e.businessId === 77 && e.text.includes(quote))?.id;
    const unit = (u: Unit) => ({ facetIds: ['f1'], subject: 'visitor', predicate: 'bring', value: 'payment receipt', scope: 'visit',
      modality: u.modality ?? 'recommended', negation: u.negation ?? false, qualifiers: [], language, text: u.text,
      evidenceRefs: [{ evidenceId: u.evidenceId ?? evidenceFor(fx.sources[u.quote ?? 1]), exactQuote: fx.sources[u.quote ?? 1] }] });
    let out: unknown;
    if (stage === 'language') out = { language, requestedReplyLanguage: null, confidence: 0.99 };
    else if (stage === 'planning') out = { canonicalMeaning: following ? description : first.text, queries: ['betalningskvitto'],
      queryLanguages: [{ query: 'betalningskvitto', language: 'sv' }], requestKind: 'BUSINESS_INFORMATION',
      referenceResolution: following ? 'RESOLVED' : 'NOT_REQUIRED',
      requestedFacets: [{ subject: 'payment receipt', attribute: following ? description : first.text, questionType: 'requirement',
        obligations: [{ description: following ? description : first.text, questionType: 'requirement' }] }] };
    else if (stage === 'extraction') out = { oversized: false, units: following
      ? (s.units ?? [{ text: language === 'ar' ? ADVICE : fx.sources[1] }]).map(unit)
      : [unit({ text: language === 'ar' ? ADVICE : fx.sources[1] })] };
    else if (stage === 'verification') {
      if (following && s.verify === 'throw') throw Error('OFFLINE_PROVIDER_FAILURE');
      if (following && s.verify === 'malformed') return { text: '{"decisions":', functionCalls: [] };
      if (following && s.staleDuringVerification) assert.equal(await storage.delete(77, 'bring'), true);
      const ids = input.units.map((u: { id: string }) => u.id);
      const decisions = input.units.map((u: { id: string; facetIds: string[] }, i: number) => {
        const relation = following ? s.relations?.[i] ?? 'UNKNOWN' : s.firstRelation ?? 'ENTAILED';
        const ok = relation === 'ENTAILED';
        return { unitId: u.id, facetIds: u.facetIds, relation, meaningPreserved: ok, modalityPreserved: ok, qualifiersPreserved: ok,
          relevant: ok, languageCorrect: true, explicitAbsenceEvidence: false, negativeAbsence: false };
      });
      const firstOk = (s.firstRelation ?? 'ENTAILED') === 'ENTAILED';
      out = { decisions, coverage: [following
        ? { facetId: 'f1', requestAligned: true, materialFactsComplete: false, incompletenessReason: 'MISSING_CONDITION', materialUnitIds: [],
            obligations: [{ obligationId: 'f1.o1', status: 'UNRESOLVED', unitIds: [] }], ...s.coverage }
        : { facetId: 'f1', requestAligned: true, materialFactsComplete: firstOk, incompletenessReason: firstOk ? 'NONE' : 'MISSING_RELEVANT_FACT',
            materialUnitIds: firstOk ? ids : [], obligations: [{ obligationId: 'f1.o1', status: firstOk ? 'COVERED' : 'UNRESOLVED', unitIds: firstOk ? ids : [] }] }] };
    } else throw Error('UNEXPECTED_STAGE:' + stage);
    return { text: JSON.stringify(out), functionCalls: [] };
  }, { channel: language === 'ar' ? 'whatsapp' : 'telegram', conversation: [first.text, second], foreign: true, continuityPlannerTiming: true,
    beforeFollowUp() { following = true; } });
  return { ...result, stages };
}

const noFacts = (candidate: string) => {
  assert.doesNotMatch(candidate, /توصي|يُنصح|ينصح|نوصي/u, 'no recommendation published');
  assert.doesNotMatch(candidate, /يجب إحضار|لا يلزم|غير مطلوب/u, 'no requirement or exemption asserted');
};

test('notice-only manifests cannot be forged or altered', () => {
  const forged = { language: 'ar', presentation: { unitIds: [], prefix: 'none', addition: false }, facets: [], units: [], outcomes: [],
    text: NOTICE, presentationFallback: false, unresolvedRequirements: [{ facetId: 'f1', obligationId: 'f1.o1', text: NOTICE }],
    unresolvedNoticeOnly: {} } as never;
  assert.equal(publishableKnowledgeManifest(forged, 77), false);
});

test('Arabic other-payer follow-up: all-UNKNOWN verdict publishes only the backend unresolved notice', async () => {
  for (const [name, scenario] of [
    ['arabic-obligation', {}],
    ['english-obligation', { description: ENGLISH_OBLIGATION }],
    ['invented-exemption', { units: [{ text: 'لا يلزم إحضار إيصال الدفع إذا دفع شخص آخر.', modality: 'required', negation: true }] }],
    ['unsupported-mandatory', { units: [{ text: 'يجب إحضار إيصال الدفع إذا دفع شخص آخر.', modality: 'required' }] }],
    ['recommendation-plus-exemption', { units: [{ text: ADVICE }, { text: 'لا يلزم إحضار إيصال الدفع إذا دفع شخص آخر.', quote: 2, modality: 'required', negation: true }],
      relations: ['UNKNOWN', 'UNKNOWN'] }],
  ] as const) {
    const result = await run(scenario as Scenario);
    assert.equal(result.publication, 'unresolved_notice', name);
    assert.equal(result.candidate, NOTICE, name);
    assert.equal(result.replies.length, 2, name);
    noFacts(result.candidate);
  }
});

test('every other zero-verified Arabic follow-up keeps the existing generic unavailable reply', async () => {
  for (const [name, scenario] of [
    ['contradicted', { relations: ['CONTRADICTED'] }],
    ['not-applicable', { relations: ['NOT_APPLICABLE'] }],
    ['mixed-unknown-contradicted', { units: [{ text: ADVICE }, { text: 'يجب إحضار إيصال الدفع إذا دفع شخص آخر.', modality: 'required' }],
      relations: ['UNKNOWN', 'CONTRADICTED'] }],
    ['provider-failure', { verify: 'throw' }],
    ['malformed-verifier', { verify: 'malformed' }],
    ['no-extracted-units', { units: [] }],
    ['coverage-claims-covered', { coverage: { obligations: [{ obligationId: 'f1.o1', status: 'COVERED', unitIds: ['u1'] }] } }],
    ['coverage-complete', { coverage: { materialFactsComplete: true, incompletenessReason: 'NONE' } }],
    ['coverage-not-aligned', { coverage: { requestAligned: false } }],
    ['foreign-tenant-citation', { units: [{ text: ADVICE, evidenceId: 'foreign-decoy' }] }],
    ['stale-evidence', { staleDuringVerification: true }],
    ['assertion-obligation', { description: 'the payment receipt must be brought when another person made the payment' }],
    ['passport-obligation', { description: 'whether a passport must be brought when another person made the payment' }],
    ['unrelated-question', { second: 'وهل يجب إحضار بطاقة الهوية؟', description: 'هل يجب إحضار بطاقة الهوية؟' }],
    ['condition-dropped', { second: 'وهل يجب إحضاره؟', description: 'هل يجب إحضار إيصال الدفع؟' }],
    ['unverified-referent', { firstRelation: 'UNKNOWN' }],
  ] as const) {
    const result = await run(scenario as Scenario);
    assert.notEqual(result.publication, 'unresolved_notice', name);
    assert.notEqual(result.candidate, NOTICE, name);
    if (name !== 'unverified-referent') assert.equal(result.candidate, GENERIC_AR, name);
    noFacts(result.candidate);
  }
});

test('other languages keep their existing zero-verified behavior', async () => {
  const result = await run({ language: 'sv' });
  assert.notEqual(result.publication, 'unresolved_notice');
  assert.doesNotMatch(result.candidate, /[؀-ۿ]/u);
});
