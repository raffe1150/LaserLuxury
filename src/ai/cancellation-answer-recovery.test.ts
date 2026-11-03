import test from 'node:test';
import assert from 'node:assert/strict';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseAnswerUnits, parseRequestedFacets, publishableKnowledgeManifest } from './business-information-answer-plan';
import { configuredCancellationEvidence } from './configured-cancellation-evidence';
import { captureLiteralEvidence, hydrateLiteralEvidenceReferences, resolveEvidenceQuote } from './knowledge-citation';
import { cancellationPolicyNoticePlan, literalInformationFallback } from './knowledge-planning';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';

// Recovered from the Nov 2 production extraction response; no customer identity.
const question = 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?';
const source = 'Detta dokument innehåller inte uppgifter om: \n• Priser på studions tjänster \n• Tjänsternas längd \n• Lediga bokningstider \n• Ordinarie öppettider \n• Vilka betalningsmetoder som accepteras \n• Fullständiga avbokningsvillkor';
const stitched = 'Detta dokument innehåller inte uppgifter om: \n• Fullständiga avbokningsvillkor';
const config = configuredCancellationEvidence(3, { id: 3, allow_cancellation: true, cancellation_fee_enabled: false,
  cancellation_deadline_minutes: 1440, cancellation_fee_amount: 0, cancellation_fee_currency: 'SEK' })!;
const documents = answerEvidence(3, [{ businessId: 3, sourceId: 'incident-document', text: source, metadata: { documentRevision: 'r1' } }]);
const evidence = [...documents, config];
const documentUnit = { facetIds: ['f1'], subject: 'the supplied customer-information document', predicate: 'contains information about full cancellation terms',
  value: 'no', modality: 'descriptive', negation: true, scope: 'the supplied document', qualifiers: [], language: 'en',
  text: 'The supplied customer-information document does not contain the full cancellation terms.', evidenceRefs: [{ evidenceId: 'e1', exactQuote: stitched }] };

test('recovered u2 deletes five intervening list entries; whitespace repair must still reject it', () => {
  assert.deepEqual(resolveEvidenceQuote(source, stitched), { subtype: 'QUOTE_NOT_FOUND', typographyHint: false });
  const facets = parseRequestedFacets(literalInformationFallback(question, true)!.requestedFacets).facets;
  assert.equal(parseAnswerUnits({ units: [documentUnit] }, facets, evidence, 'en').units.length, 0);
  const bound = hydrateLiteralEvidenceReferences({ units: [{ ...documentUnit, evidenceRefs: [{ evidenceId: 'e1' }] }] }, captureLiteralEvidence(3, evidence)!, evidence);
  assert.equal(parseAnswerUnits(bound, facets, evidence, 'en').units.length, 1);
});

test('planner timeout contract preserves policy and mandatory-notice obligations without inventing a rule', () => {
  const plan = literalInformationFallback(question, true)!;
  assert.deepEqual(plan.requestedFacets.map(f => f.questionType), ['description', 'requirement']);
  assert.equal(plan.canonicalMeaning, question);
  assert.equal(plan.requestedFacets[1].attribute, 'mandatory advance notice');
  assert.doesNotMatch(JSON.stringify(plan), /1440|24 hours|free cancellation/);
});

async function recovery(fault = 'none') {
  let answer: any, failure: unknown;
  await runAccuracyFirstNative(async () => {
    const facets = parseRequestedFacets(literalInformationFallback(question, true)!.requestedFacets).facets;
    let reads = 0;
    const manifest = await buildEvidenceFirstAnswer({ question, language: 'en', businessId: 3, facets, evidence,
      cancellationEvidence: fault === 'foreign' ? { ...config, businessId: 4 } : config,
      foreground: true, extractionProtocol: 'literal-evidence-v1', verificationProtocol: 'v2',
      authoritativeEvidence: '', businessTone: {}, history: [], budget: new InformationBudget(undefined, nativeKnowledgeTiming()),
      current: async () => true, languageSafe: () => true,
      revalidateEvidence: async () => {
        reads++;
        if (fault === 'missing-source' || fault === 'revoked' && reads > 1) return documents;
        if (fault === 'stale' && reads > 1) return [...documents, {...config, version: 'changed-revision'}];
        if (fault === 'foreign-current' && reads > 1) return [...documents, {...config, businessId: 4}];
        return evidence;
      },
      generate: async (stage: string, _instruction: string, data: any) => {
        if (stage === 'extraction') {
          // The producer omits chat cancellation and both canonical configuration
          // sentences. Existing backend authority must propose them for verification.
          if (['none','foreign','revoked','stale','missing-source','foreign-current','missing-verdict'].includes(fault)) return { text: JSON.stringify({ oversized: false, units: [] }) };
          const bad = { ...documentUnit, text: fault === 'deadline' ? 'You must cancel at least 24 hours before your appointment.' : 'All cancellations are always free.',
            evidenceRefs: [{ evidenceId: fault === 'invalid-id' ? 'foreign' : 'e1' }] };
          return { text: JSON.stringify({ oversized: false, units: [bad] }) };
        }
        assert.equal(stage, 'verification');
        const units = data.units as any[];
        return { text: JSON.stringify({ decisions: units.filter((_, i) => fault !== 'missing-verdict' || i !== 0).map(u => ({ unitId: u.id, facetIds: u.facetIds,
          relation: u.text.includes('24 hours') || u.text.includes('always free') ? 'UNKNOWN' : 'ENTAILED', meaningPreserved: true,
          modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: u.negation, explicitAbsenceEvidence: u.negation })),
          coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: f.questionType === 'description',
            incompletenessReason: f.questionType === 'description' ? 'NONE' : 'UNRESOLVED', materialUnitIds: f.questionType === 'description' ? units.map(u => u.id) : [],
            obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: o.questionType === 'requirement' ? 'UNRESOLVED' : 'COVERED',
              unitIds: o.questionType === 'requirement' ? [] : units.map(u => u.id) })) })) }) };
      } });
    answer = { manifest, allowed: publishableKnowledgeManifest(manifest, 3) };
  }, async () => { failure = new Error('unexpected timing failure'); });
  assert.equal(failure, undefined);
  return answer;
}

test('omitted configuration facts become independently verified proposals and an authorized explicit partial answer', async () => {
  const { manifest, allowed } = await recovery();
  assert.equal(allowed, true);
  assert.equal(manifest.units.length, 2);
  assert.match(manifest.text, /Automatic appointment cancellation through chat is enabled\./);
  assert.match(manifest.text, /The optional late cancellation fee is disabled\./);
  assert.match(manifest.text, /The required advance notice for cancelling an appointment could not be confirmed\./);
  assert.doesNotMatch(manifest.text, /cannot verify an answer|24 hours|always free/);
});
for (const fault of ['foreign', 'revoked', 'stale', 'missing-source', 'foreign-current', 'missing-verdict', 'invalid-id', 'deadline', 'free'])
  test(`recovery cannot bypass source, entailment or inventory authority/${fault}`, async () => assert.equal((await recovery(fault)).allowed, false));

for (const [kind, current] of Object.entries({ missing: documents, stale: [...documents, {...config, version: 'changed'}],
  rewritten: [...documents, {...config, text: config.text + ' '}], foreign: [...documents, {...config, businessId: 4}] }))
  test(`incident literal binding rejects ${kind} current evidence`, () => {
    const raw = {units: [{...documentUnit, evidenceRefs: [{evidenceId: config.id}]}]};
    const snapshot = captureLiteralEvidence(3, evidence)!;
    if (kind === 'foreign') assert.throws(() => hydrateLiteralEvidenceReferences(raw, snapshot, current));
    else assert.deepEqual((hydrateLiteralEvidenceReferences(raw, snapshot, current) as typeof raw).units[0].evidenceRefs, []);
  });

for (const q of [
  'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
  'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
  '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
  'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
  'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
  'Tell me about the cancellation terms and how much notice do I need to cancel an appointment?',
]) test(`bounded timeout grammar retains two obligations/${q}`, () => {
  assert.deepEqual(cancellationPolicyNoticePlan(q, true)?.requestedFacets.map(f => f.questionType), ['description','requirement']);
});
for (const q of [question.replace('appointment?', 'appointment if I arrive late?'),
  question.replace('appointment?', 'appointment and is parking free?'),
  question.replace('your cancellation policy', 'the cancellation policy for groups'),
  'Cancel my appointment and explain the cancellation policy?', 'What is it and how far in advance must I cancel it?'])
  test(`timeout grammar does not erase qualifiers, siblings, actions or references/${q}`, () => assert.equal(cancellationPolicyNoticePlan(q, true), null));
test('timeout grammar requires prior information admission and reference safety', () => {
  assert.equal(cancellationPolicyNoticePlan(question, false), null);
  assert.equal(cancellationPolicyNoticePlan(question, true, true), null);
});
