import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { answerEvidence, buildEvidenceFirstAnswer, completeKnowledgeManifest, InformationBudget, parseRequestedFacets,
  pruneAnswerManifest, publishableKnowledgeManifest, type AnswerManifest, type Evidence } from './business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import { configuredCancellationEvidence } from './configured-cancellation-evidence';

const languages = [
  { language: 'en', question: 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?',
    facts: ['Automatic appointment cancellation through chat is enabled.', 'The optional late cancellation fee is disabled.'],
    unknown: 'required advance notice', labels: ['advance notice', 'identification requirements'],
    many: 'What is your cancellation policy, including advance notice and identification requirements?',
    action: 'Please cancel my appointment.', reschedule: 'Please reschedule my appointment.' },
  { language: 'sv', question: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
    facts: ['Automatisk avbokning av tider via chatt är aktiverad.', 'Den valfria avgiften för sen avbokning är inaktiverad.'],
    unknown: 'hur långt i förväg', labels: ['framförhållning', 'krav på legitimation'], many: 'Vad är er avbokningspolicy, inklusive framförhållning och krav på legitimation?',
    action: 'Jag vill avboka min tid.', reschedule: 'Jag vill flytta min tid.' },
  { language: 'de', question: 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
    facts: ['Die automatische Terminabsage per Chat ist aktiviert.', 'Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.'],
    unknown: 'Vorankündigungsfrist', labels: ['Vorankündigung', 'Ausweispflicht'], many: 'Was ist Ihre Stornierungsrichtlinie, einschließlich Vorankündigung und Ausweispflicht?',
    action: 'Bitte stornieren Sie meinen Termin.', reschedule: 'Bitte verschieben Sie meinen Termin.' },
  { language: 'es', question: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
    facts: ['La cancelación automática de citas por chat está habilitada.', 'El cargo opcional por cancelación tardía está desactivado.'],
    unknown: 'con cuánta antelación', labels: ['antelación necesaria', 'requisitos de identificación'], many: '¿Cuál es su política de cancelación, incluida la antelación necesaria y los requisitos de identificación?',
    action: 'Quiero cancelar mi cita.', reschedule: 'Quiero reprogramar mi cita.' },
  { language: 'fa', question: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
    facts: ['لغو خودکار نوبت از طریق چت فعال است.', 'هزینه اختیاری لغو دیرهنگام غیرفعال است.'],
    unknown: 'چه مدت قبل', labels: ['مهلت اطلاع قبلی', 'الزامات شناسایی'], many: 'سیاست لغو شما درباره مهلت اطلاع قبلی و الزامات شناسایی چیست؟',
    action: 'لطفاً نوبتم را لغو کنید.', reschedule: 'لطفاً وقت من را تغییر دهید.' },
  { language: 'ar', question: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
    facts: ['إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.', 'رسوم الإلغاء المتأخر الاختيارية معطّلة.'],
    unknown: 'الإشعار المسبق', labels: ['مهلة الإشعار المسبق', 'متطلبات إثبات الهوية'], many: 'ما هي سياسة الإلغاء بشأن مهلة الإشعار المسبق ومتطلبات إثبات الهوية؟',
    action: 'أريد إلغاء موعدي.', reschedule: 'أريد تغيير موعدي.' },
];
type Spec = typeof languages[number];
type Options = {
  spec?: Spec; tenant?: number; question?: string; multiple?: boolean; sameFacet?: boolean; complete?: boolean;
  modality?: string; text?: string; evidenceText?: string; noUnits?: boolean; requireCompleteCoverage?: boolean;
  native?: boolean; foreground?: boolean; inputTenant?: number; languageSafe?: (text: string) => boolean;
  requirementLabel?: string;
  mutateProposal?: (raw: any) => void; mutateVerdict?: (raw: any) => void;
  evidence?: (items: Evidence[]) => Evidence[]; fresh?: (items: Evidence[], read: number) => Evidence[];
  inspect?: (manifest: AnswerManifest, evidence: Evidence[]) => void; stageFailure?: string;
};
async function exercise(options: Options = {}) {
  const spec = options.spec || languages[0], tenant = options.tenant || 77;
  const question = options.question || (options.multiple ? spec.many : spec.question);
  const known = options.text ? [options.text] : spec.facts;
  let evidence = answerEvidence(tenant, [{ businessId: tenant, sourceId: 'configured-policy-fixture',
    text: options.evidenceText || known.join('\n'), metadata: { sourceRevision: 'v1' } }]);
  evidence = options.evidence?.(evidence) || evidence;
  const requested = options.complete ? [{ subject: 'business configuration', attribute: 'known settings', questionType: 'description' }] : options.sameFacet ? [
    { subject: 'cancellation', attribute: 'cancellation policy', questionType: 'description', obligations: [
      { description: 'known settings', questionType: 'description' }, { description: spec.labels[0], questionType: 'requirement' }] },
  ] : [ { subject: 'business configuration', attribute: 'known settings', questionType: 'description' },
    { subject: 'requested requirement', attribute: options.multiple ? spec.labels[0] : options.requirementLabel || 'mandatory advance notice', questionType: 'requirement',
      ...(options.multiple ? { obligations: spec.labels.map(description => ({ description, questionType: 'requirement' })) } : {}) },
  ];
  const facets = parseRequestedFacets(requested).facets, stages: string[] = [], diagnostics: any[] = [];
  let reads = 0;
  let stoppedResult: { manifest: AnswerManifest; allowed: boolean; stages: string[]; diagnostics: any[] } | undefined;
  const work = async () => {
    const timing = options.native === false ? undefined : nativeKnowledgeTiming();
    const manifest = await buildEvidenceFirstAnswer({ question, language: spec.language, businessId: options.inputTenant ?? tenant,
      facets, evidence, authoritativeEvidence: '', businessTone: {}, history: [], foreground: options.foreground !== false,
      extractionProtocol: 'v2', verificationProtocol: 'v2', requireCompleteCoverage: options.requireCompleteCoverage,
      budget: new InformationBudget(undefined, timing), current: async () => true,
      revalidateEvidence: async () => options.fresh ? options.fresh(evidence, ++reads) : evidence,
      languageSafe: unit => options.languageSafe ? options.languageSafe(unit.text) : true, diagnostic: d => diagnostics.push(d),
      generate: async (stage, _instruction, data: any) => {
        stages.push(stage); if (options.stageFailure === stage) throw Error('scripted provider failure');
        if (stage === 'extraction') {
          const raw = { oversized: false, units: options.noUnits ? [] : known.map((text, i) => ({ facetIds: ['f1'], subject: 'business configuration',
            predicate: 'states', value: text, modality: options.modality || 'descriptive', negation: false,
            scope: 'configured optional cancellation policy only', qualifiers: ['preserve source conditions'], language: spec.language, text,
            evidenceRefs: [{ evidenceId: evidence[0]?.id || 'absent', exactQuote: options.evidenceText || text }] })) };
          options.mutateProposal?.(raw); return { text: JSON.stringify(raw) };
        }
        if (stage === 'verification') {
          const raw = { decisions: data.units.map(u => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true,
            modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
            coverage: data.facets.map(f => { const ids = data.units.filter(u => u.facetIds.includes(f.id)).map(u => u.id);
              const unknown = f.obligations.some(o => o.questionType === 'requirement');
              return { facetId: f.id, requestAligned: true, materialFactsComplete: !unknown, incompletenessReason: unknown ? 'UNRESOLVED' : 'NONE',
                materialUnitIds: ids, obligations: f.obligations.map(o => ({ obligationId: o.id, status: o.questionType === 'requirement' ? 'UNRESOLVED' : 'COVERED',
                  unitIds: o.questionType === 'requirement' ? [] : ids })) };
            }) };
          options.mutateVerdict?.(raw); return { text: JSON.stringify(raw) };
        }
        assert.ok(!data.units.some(u => u.text.includes('invented')), 'Presentation receives only verified text');
        return { text: JSON.stringify({ unitIds: data.units.map(u => u.id), prefix: 'none', addition: false }) };
      } });
    options.inspect?.(manifest, evidence);
    return stoppedResult = { manifest, allowed: publishableKnowledgeManifest(manifest, tenant), stages, diagnostics };
  };
  if (options.native === false) return work();
  let failure: unknown;
  const result = await runAccuracyFirstNative(async () => { try { return await work(); } catch (e) { failure = e; throw e; } }, async () => {});
  if (failure) throw failure;
  assert.ok(result || stoppedResult); return result || { ...stoppedResult!, allowed: false };
}

for (const spec of languages) for (const sameFacet of [false, true])
test(`${spec.language}: verified facts and genuinely unresolved requirement/${sameFacet ? 'same facet' : 'separate facet'}`, async () => {
  const { manifest, allowed, stages } = await exercise({ spec, sameFacet });
  assert.equal(allowed, true); assert.equal(completeKnowledgeManifest(manifest), false);
  assert.equal(manifest.units.length, 2); for (const text of spec.facts) assert.ok(manifest.text.includes(text));
  assert.ok(manifest.text.includes(spec.unknown)); assert.deepEqual(stages, ['extraction','verification']);
  const requirement = manifest.facets.flatMap(f => f.obligations).find(o => o.questionType === 'requirement')!;
  const decision = manifest.outcomes.flatMap(o => o.obligations).find(o => o.obligationId === requirement.id)!;
  assert.equal(decision.status, 'UNRESOLVED'); assert.deepEqual(decision.unitIds, []);
  assert.equal(requirement.questionType, 'requirement'); assert.equal(manifest.unresolvedRequirements?.length, 1);
  assert.doesNotMatch(manifest.text, /24|1440|۲۴|٢٤/u);
});

for (const spec of languages)
test(`${spec.language}: multiple unresolved requirements are individually disclosed`, async () => {
  const { manifest, allowed } = await exercise({ spec, multiple: true });
  assert.equal(allowed, true); assert.equal(manifest.unresolvedRequirements?.length, 2);
  assert.equal(manifest.text.includes(spec.unknown),true,'Advance notice is named explicitly');
  assert.equal(manifest.text.includes(spec.labels[1]),true,'Other unresolved requirement keeps its distinct literal label');
  for(const obligation of manifest.outcomes[1].obligations){assert.equal(obligation.status,'UNRESOLVED');assert.deepEqual(obligation.unitIds,[]);}
  assert.equal(manifest.outcomes[1].status, 'UNAVAILABLE'); assert.equal(manifest.outcomes[1].requestAligned, true);
});
for (const spec of languages) for (const action of [spec.action, spec.reschedule])
test(`${spec.language}: operational and mixed turns cannot acquire new partial authority/${action}`, async () => {
  for (const question of [action, `${spec.question} ${action}`, `${action} ${spec.question}`, `${spec.question} ${action} ${action}`])
    assert.equal((await exercise({ spec, question })).allowed, false);
});
for (const [name, options] of Object.entries({
  noFacts: { noUnits: true }, failedExtraction: { stageFailure: 'extraction' }, failedVerification: { stageFailure: 'verification' },
  noForeground: { foreground: false }, noNativeOwner: { native: false }, durableCompleteOnly: { requireCompleteCoverage: true },
  wrongTenant: { inputTenant: 88 }, foreignEvidence: { evidence: e => e.map(x => ({ ...x, businessId: 88 })) },
  duplicateEvidence: { evidence: e => [...e, ...e] },
  revokedBeforeExtraction: { fresh: () => [] }, revokedAfterExtraction: { fresh: (e, n) => n === 1 ? e : [] },
  revokedAfterVerification: { fresh: (e, n) => n < 3 ? e : [] },
  changedRevision: { fresh: (e, n) => n < 3 ? e : e.map(x => ({ ...x, version: 'v2' })) },
} satisfies Record<string, Options>))
test(`partial authorization fails closed/${name}`, async () => assert.equal((await exercise(options)).allowed, false));

for (const [name, mutateVerdict] of Object.entries({
  unsupported: v => { v.decisions[0].relation = 'UNKNOWN'; }, contradictory: v => { v.decisions[0].relation = 'CONTRADICTED'; },
  changedMeaning: v => { v.decisions[0].meaningPreserved = false; }, wrongLanguage: v => { v.decisions[0].languageCorrect = false; },
  changedModality: v => { v.decisions[0].modalityPreserved = false; }, unsupportedAbsence: v => { v.decisions[0].negativeAbsence = true; },
  missingQualifier: v => { v.decisions[0].qualifiersPreserved = false; }, missingCondition: v => { v.coverage[1].incompletenessReason = 'MISSING_CONDITION'; },
  missingRecommendation: v => { v.coverage[1].incompletenessReason = 'MISSING_RECOMMENDATION'; },
  missingKnownFact: v => { v.coverage[1].incompletenessReason = 'MISSING_RELEVANT_FACT'; },
  malformedCoverage: v => { v.coverage[1].obligations = []; }, missingCoverage: v => { v.coverage.pop(); },
  duplicateCoverage: v => { v.coverage.push(v.coverage[1]); }, misaligned: v => { v.coverage[1].requestAligned = false; },
  falseComplete: v => { v.coverage[1].materialFactsComplete = true; v.coverage[1].incompletenessReason = 'NONE'; },
  fakeCoveredRequirement: v => { v.coverage[1].obligations[0].status = 'COVERED'; v.coverage[1].obligations[0].unitIds = ['u1']; },
  missingDecision: v => { v.decisions.pop(); }, duplicateDecision: v => { v.decisions.push(v.decisions[0]); },
  hiddenMaterialUnit: v => { v.coverage[0].materialUnitIds = ['u1']; },
  permissionGap: v => { v.coverage[0].obligations[0].status = 'UNRESOLVED'; v.coverage[0].obligations[0].unitIds = []; v.coverage[0].materialFactsComplete = false; v.coverage[0].incompletenessReason = 'UNRESOLVED'; },
})) test(`bad semantic/coverage contract cannot authorize partial/${name}`, async () => assert.equal((await exercise({ mutateVerdict })).allowed, false));

for (const [name, mutateProposal] of Object.entries({
  forgedQuote: p => { p.units[0].evidenceRefs[0].exactQuote = 'invented'; }, foreignCitation: p => { p.units[0].evidenceRefs[0].evidenceId = 'foreign-tenant'; },
  noCitation: p => { p.units[0].evidenceRefs = []; }, unsupportedDeadline: p => { p.units[0].text = 'You must cancel at least 24 hours in advance.'; },
  bookingSuccess: p => { p.units[0].text = 'Your appointment is cancelled.'; }, oversized: p => { p.oversized = true; },
})) test(`invalid candidate cannot obtain partial authority/${name}`, async () => assert.equal((await exercise({ mutateProposal })).allowed, false));

test('unresolved-only rows cannot bind a known factual unit to an unanswered requirement', async () => {
  const result = await exercise({ sameFacet: true, mutateVerdict: v => { v.coverage[0].obligations[1].unitIds = ['u1']; } });
  assert.equal(result.allowed, false);
});
test('a falsely COVERED requirement cannot become genuine uncertainty through modality downgrade', async () => {
  const result = await exercise({ sameFacet: true, mutateVerdict: v => {
    v.coverage[0].obligations[1].status = 'COVERED'; v.coverage[0].obligations[1].unitIds = ['u1'];
  } });
  assert.equal(result.allowed, false);
});
test('multiple ambiguous/nonliteral requirement labels cannot collapse into one generic disclosure', async () => {
  assert.equal((await exercise({ multiple: true, question: languages[0].question })).allowed, false);
  assert.equal((await exercise({ multiple: true, languageSafe: text => languages[0].facts.includes(text) })).allowed, false);
});
test('Arabic conjunction handling cannot admit arbitrary word suffixes or identifier prefixes', async () => {
  const spec = languages[5];
  for (const changed of [`س${spec.labels[1]}`, `وو${spec.labels[1]}`, `${spec.labels[1]}Extra`]) {
    assert.equal((await exercise({ spec, multiple: true, question: spec.many.replace(`و${spec.labels[1]}`, changed) })).allowed, false);
  }
});
test('source qualifiers, conditions, service scope and quantities remain verbatim', async () => {
  const text = 'For Video Consultation only, visitors under 12 must be accompanied by one adult if attending in person.';
  const { manifest, allowed } = await exercise({ text, modality: 'required', mutateVerdict: v => {
    // This is a known requirement, distinct from the unresolved notice rule.
    v.coverage[0].obligations[0].status = 'COVERED';
  } });
  assert.equal(allowed, true); assert.ok(manifest.text.startsWith(text)); assert.equal(manifest.units[0].modality, 'required');
  assert.equal(manifest.units[0].evidenceRefs[0].exactQuote, text);
});
test('conditional service-specific unresolved requirements keep their literal requested scope', async () => {
  const spec = { ...languages[0], labels: ['advance notice for Video Consultation if I arrive late', 'identification requirements for Video Consultation'],
    many: 'What is the advance notice for Video Consultation if I arrive late, and the identification requirements for Video Consultation?' };
  const { manifest, allowed } = await exercise({ spec, multiple: true });
  assert.equal(allowed, true); for (const label of spec.labels) assert.ok(manifest.text.includes(label));
});

test('partial proof binds disclosures, facts, statuses, tenant and current owner', async () => {
  const { manifest } = await exercise({ inspect: (m, evidence) => {
    assert.equal(publishableKnowledgeManifest({ ...m, unresolvedRequirements: [] }, 77), false);
    assert.equal(publishableKnowledgeManifest({ ...m, text: m.units.map(u => u.text).join(' ') }, 77), false);
    assert.equal(publishableKnowledgeManifest({ ...m, units: m.units.slice(1) }, 77), false);
    assert.equal(publishableKnowledgeManifest({ ...m, outcomes: m.outcomes.map(o => ({ ...o, status: 'VERIFIED', materialFactsComplete: true,
      obligations: o.obligations.map(d => ({ ...d, status: 'COVERED', unitIds: ['u1'] })) })) } as any, 77), false);
    assert.equal(publishableKnowledgeManifest(JSON.parse(JSON.stringify(m)), 77), false);
    assert.equal(publishableKnowledgeManifest(m, 88), false);
    const pruned = pruneAnswerManifest(m, evidence.map(e => ({ ...e, text: e.text + ' changed' })));
    assert.equal(publishableKnowledgeManifest(pruned, 77), false);
    assert.equal(publishableKnowledgeManifest(pruneAnswerManifest(pruned, evidence), 77), false);
  } });
  assert.equal(publishableKnowledgeManifest(manifest, 77), false);
  await runAccuracyFirstNative(async () => { assert.equal(publishableKnowledgeManifest(manifest, 77), false); }, async () => assert.fail());
});
for (const mode of ['revoked','revision','foreign'] as const)
test(`final publication pruning withdraws partial authority permanently/${mode}`, async () => {
  await exercise({ inspect: (m, e) => {
    const fresh = mode === 'revoked' ? [] : e.map(item => ({ ...item, ...(mode === 'revision' ? { version: 'v2' } : { businessId: 88 }) }));
    const pruned = pruneAnswerManifest(m, fresh);
    assert.equal(publishableKnowledgeManifest(pruned, 77), false);
    assert.equal(publishableKnowledgeManifest(pruneAnswerManifest(pruned, e), 77), false);
  } });
});
test('abort/deadline owner cannot publish an otherwise qualified partial', async () => {
  await exercise({ inspect: m => { assert.equal(publishableKnowledgeManifest(m, 77), true);
    nativeKnowledgeTiming()!.fail(); assert.equal(publishableKnowledgeManifest(m, 77), false); } });
});

for (const spec of languages)
test(`${spec.language}: ordinary complete publication is unchanged`, async () => {
  const { manifest, allowed } = await exercise({ spec, complete: true });
  assert.equal(allowed, true); assert.equal(completeKnowledgeManifest(manifest), true);
  assert.equal(manifest.qualifiedPartial, undefined); assert.equal(manifest.unresolvedRequirements, undefined);
  assert.equal(manifest.text, spec.facts.join(' '));
});

test('cancellation configuration fixture can publish known facts with notice explicitly unresolved, without runtime integration', async () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json', import.meta.url), 'utf8'));
  const e = configuredCancellationEvidence(snapshot.business.id, snapshot.business)!;
  const quotes = JSON.parse(e.text).statements;
  const result = await exercise({ tenant: snapshot.business.id, evidence: () => [e],
    requirementLabel: 'how far in advance do I need to cancel my appointment', mutateProposal: raw => {
    raw.units.forEach((u, i) => { u.evidenceRefs = [{ evidenceId: e.id, exactQuote: quotes[i] }]; });
  } });
  assert.equal(result.allowed, true); assert.equal(result.manifest.units.length, 2);
  assert.match(result.manifest.text, /Regarding “how far in advance do I need to cancel my appointment”: However, I cannot confirm what is required/u);
  assert.equal(result.manifest.outcomes[1].obligations[0].status, 'UNRESOLVED');
  if (process.env.ODINLINK_REQUIREMENT_PARTIAL_RECEIPT) writeFileSync(process.env.ODINLINK_REQUIREMENT_PARTIAL_RECEIPT,
    JSON.stringify({ evidenceKind: 'OFFLINE_SCRIPTED_INTERFACE_EVIDENCE_ONLY', realProviderCalls: 0, allowedDuringCurrentOwner: true,
      finalCustomerVisibleAnswer: result.manifest.text, stages: result.stages, units: result.manifest.units,
      facets: result.manifest.facets, outcomes: result.manifest.outcomes, disclosures: result.manifest.unresolvedRequirements }, null, 2) + '\n', { flag: 'wx' });
});

for(const spec of languages)test(`${spec.language}: notice localization cannot bind an unrelated requirement`,async()=>{
 const {manifest,allowed}=await exercise({spec,requirementLabel:'identification requirements'});
 assert.equal(allowed,true);assert.equal(manifest.text.includes(spec.unknown),false,'No advance-notice label without the corresponding typed obligation');
});
test('multiple nonliteral labels remain inadmissible even when one names advance notice',async()=>{
 const {allowed}=await exercise({multiple:true,question:languages[0].question});assert.equal(allowed,false);
});
test('fee windows and permission questions do not create a mandatory-notice disclosure',async()=>{
 for(const question of ['Can I cancel my appointment for free?','What is your cancellation policy and its free-cancellation window?']){
  const {manifest}=await exercise({question});assert.equal(manifest.text.includes('required advance notice'),false);
 }
});

for(const spec of languages)test(`${spec.language}: localized notice is canonical proof-bound text for multiple requirements`,async()=>{
 await exercise({spec,multiple:true,inspect:m=>{
  const notices=m.unresolvedRequirements!;assert.equal(notices.length,2);
  assert.equal(publishableKnowledgeManifest({...m,unresolvedRequirements:notices.map((n,i)=>i? n:{...n,text:'Unconfirmed.'})},77),false);
  assert.equal(publishableKnowledgeManifest({...m,text:m.text.replace(notices[0].text,'')},77),false);
 }});
});
