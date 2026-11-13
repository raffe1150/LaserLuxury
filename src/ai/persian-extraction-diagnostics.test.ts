import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnswerUnits, parseRequestedFacets, type Evidence } from './business-information-answer-plan';
import { assessNumericalConstraint } from './numerical-constraints';
import type { KnowledgeDecision } from './knowledge-answer-protocol';

// SYNTHETIC proposals; actual public test-business policy wording.
const quote = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const sourceId = '2ac009ba-c913-48bc-b13d-c09adf34c8e0';
const revision = '4b86e3e3f6b07821689017b9a1d996c7c884ff7a8be96d8607a2a203af2cdaf1';
const evidence: Evidence[] = [{ id:'e1', sourceId, chunkId:'backend-chunk', version:revision, businessId:3, text:quote }];
const facets = parseRequestedFacets([{subject:'first-time visitors',attribute:'arrival recommendation',questionType:'description'}]).facets;
const scope = { businessId:3, question:'PRIVATE_QUESTION_SENTINEL', language:'fa' };
const text = (digits = '۱۰') => `به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ${digits} دقیقه قبل از نوبت رزروشده خود حاضر شوند.`;
const proposal = (candidate = text(), exactQuote = quote, evidenceId = 'e1') => ({ units:[{facetIds:['f1'],subject:'first-time visitors',predicate:'arrival recommendation',
  value:'approximately ten minutes before appointment',scope:'first-time visitors',qualifiers:['approximately'],modality:'recommended',negation:false,
  language:'fa',text:candidate,evidenceRefs:[{evidenceId,exactQuote}]}] });
function parse(raw: unknown, items = evidence, requestScope: typeof scope | undefined = scope) {
  const events: KnowledgeDecision[] = [];
  const result = parseAnswerUnits(raw,facets,items,'fa',event=>events.push(event),'quotation',requestScope);
  assert.deepEqual(result,parseAnswerUnits(raw,facets,items,'fa'), 'Diagnostic scope/callback must not alter decisions or units');
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 4000, 'Bound total diagnostics in this single-unit probe');
  assert.ok(!JSON.stringify(events).includes(scope.question));
  return {result,events};
}
for (const digits of ['۱۰','10','١٠']) test(`accept Persian numeric script ${digits}`,()=> {
  const {result,events}=parse(proposal(text(digits)));
  assert.equal(result.units.length,1); assert.ok(!events.some(e=>e.numericalMismatchReason));
});
for (const [name,candidate] of [['wrong quantity',text('۲۰')],['wrong temporal direction',text().replace('قبل','بعد')]] as const)
  test(`unchanged rejection with assessor category: ${name}`,()=> {
    const {result,events}=parse(proposal(candidate));assert.equal(result.units.length,0);
    const event=events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!;
    assert.equal(event.stage,'extraction');assert.equal(event.unitId,'u1');
    assert.equal(event.numericalMismatchReason,assessNumericalConstraint(candidate,candidate,[quote]).reason);
    assert.deepEqual(event.evidenceBindings,[{evidenceId:'e1',sourceId,sourceRevision:revision}]);
    assert.ok(!JSON.stringify(events).includes(candidate));assert.ok(!JSON.stringify(events).includes(quote));
  });
test('invalid Swedish quotation retains category and current backend binding, without text',()=> {
  const {result,events}=parse(proposal(text(),quote.replace('10 minuter','20 minuter')));
  assert.equal(result.units.length,0);
  const event=events.find(e=>e.citationSubtype==='QUOTE_NOT_FOUND')!;
  assert.equal(event.reason,'INVALID_CITATION');assert.equal(event.unitId,'u1');
  assert.deepEqual(event.evidenceBindings,[{evidenceId:'e1',sourceId,sourceRevision:revision}]);
  assert.ok(!JSON.stringify(events).includes('Kunder'));assert.ok(!JSON.stringify(events).includes('20 minuter'));
});
test('unknown model evidence identifier is never echoed',()=> {
  const {result,events}=parse(proposal(text(),quote,'PRIVATE_MODEL_ID_SENTINEL'));
  assert.equal(result.units.length,0);assert.ok(events.some(e=>e.citationSubtype==='EVIDENCE_ID'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_MODEL_ID_SENTINEL'));
});
for (const businessId of [9,0]) test(`cross-tenant or invalid-tenant metadata omitted (${businessId})`,()=> {
  const {events}=parse(proposal(text('۲۰')),[{...evidence[0],businessId}]);
  assert.deepEqual(events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!.evidenceBindings,[]);
  assert.ok(!JSON.stringify(events).includes(sourceId));assert.ok(!JSON.stringify(events).includes(revision));
});
test('metadata omitted without an explicit trusted request tenant',()=> {
  const events:KnowledgeDecision[]=[];
  parseAnswerUnits(proposal(text('۲۰')),facets,evidence,'fa',e=>events.push(e));
  assert.deepEqual(events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!.evidenceBindings,[]);
});
test('duplicate ID cannot substitute same-tenant metadata for a foreign first binding',()=> {
  const {events}=parse(proposal(text('۲۰')),[{...evidence[0],businessId:9},evidence[0]]);
  assert.deepEqual(events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!.evidenceBindings,[]);
});
test('free-form source and revision strings are not logged',()=> {
  const {events}=parse(proposal(text('۲۰')),[{...evidence[0],sourceId:'PRIVATE_SOURCE_SECRET',version:'PRIVATE_REVISION_SECRET'}]);
  assert.deepEqual(events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!.evidenceBindings,[{evidenceId:'e1'}]);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
});
test('four-reference payload remains bounded without quotes or proposed fields',()=> {
  const items=Array.from({length:4},(_,i)=>({...evidence[0],id:`e${i+1}`}));
  const raw=proposal(text('۲۰'));raw.units[0].evidenceRefs=items.map(e=>({evidenceId:e.id,exactQuote:quote}));
  const {events}=parse(raw,items);const event=events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!;
  assert.equal(event.evidenceBindings!.length,4);assert.ok(Buffer.byteLength(JSON.stringify(event))<1000);
  assert.deepEqual(Object.keys(event).sort(),['stage','unitId','reason','numericalMismatchReason','numericalComparisons','evidenceBindings'].sort());
});
test('constituent-range rejection retains fail-closed category and metadata',()=> {
  const {result,events}=parse(proposal(),[{...evidence[0],citationRanges:[{start:0,end:5}]}]);
  assert.equal(result.units.length,0);
  assert.ok(events.some(e=>e.citationSubtype==='QUOTE_NOT_FOUND'&&e.citationRangeRejected&&e.evidenceBindings?.[0].sourceId===sourceId));
});

test('same-tenant comparison shapes retain evidence ordinals without private text',()=> {
  const {events}=parse(proposal(text().replace('حدود','حداقل')));
  const event=events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!;
  assert.equal(event.numericalComparisons?.[0].candidateBound,'minimum');
  assert.equal(event.numericalComparisons?.[0].boundTriggerCategory,'explicit_minimum');
  assert.equal(event.numericalComparisons?.[0].boundTriggerPosition,'before_quantity');
  assert.equal(event.numericalComparisons?.[0].purposeClauseGuardMatched,false);
  assert.equal(event.numericalComparisons?.[0].boundDecisionBranch,'explicit_bound');
  assert.equal(event.numericalComparisons?.[0].sourceBound,'unbounded');
  assert.equal(event.numericalComparisons?.[0].sourceIndex,0);
  assert.equal(event.evidenceBindings?.[0].evidenceId,'e1');
  assert.ok(!JSON.stringify(event).includes(quote));assert.ok(!JSON.stringify(event).includes('seconds'));
});
test('comparison shapes are omitted for foreign metadata',()=> {
  const {events}=parse(proposal(text().replace('حدود','حداقل')),[{...evidence[0],businessId:9}]);
  assert.equal(events.find(e=>e.reason==='NUMERICAL_CONSTRAINT')!.numericalComparisons,undefined);
});

const ambiguityCases = [
  ['en', 'Arrive about 10 minutes before your appointment', ', not exactly', ['negation', 'exactness']],
  ['sv', 'Kom cirka 10 minuter före din bokade tid', ', inte exakt', ['negation', 'exactness']],
  ['de', 'Kommen Sie etwa 10 Minuten vor Ihrem Termin', ', nicht genau', ['negation', 'exactness']],
  ['es', 'Llegue unos 10 minutos antes de su cita', ', no exactamente', ['negation', 'exactness']],
  ['fa', 'حدود ۱۰ دقیقه قبل از نوبت رزروشده حاضر شوید', '، نه دقیقا', ['exactness']],
  ['ar', 'ينصح بالوصول قبل موعدك المحجوز بحوالي 10 دقائق', '، أو لا تصل بالضبط عند الزيارة 1', ['alternative', 'negation', 'extra_digit', 'exactness']],
] as const;

for (const [language, faithful, suffix, expected] of ambiguityCases) {
  test(`${language}: ambiguity diagnostic identifies overlapping parser predicates without text`, () => {
    const candidate = faithful + suffix + ' PRIVATE_CANDIDATE_SENTINEL.';
    const events: KnowledgeDecision[] = [];
    const raw = proposal(candidate);
    raw.units[0].language = language;
    const diagnosticScope = { ...scope, language };
    assert.equal(assessNumericalConstraint(faithful, faithful, [quote]).safe, true);
    const recoveryTally = { ambiguousConnective: 0, citationOmitsQuantity: 0 };
    const result = parseAnswerUnits(raw, facets, evidence, language, event => events.push(event), 'quotation',
      diagnosticScope, undefined, undefined, recoveryTally);
    assert.deepEqual(result, parseAnswerUnits(raw, facets, evidence, language));
    assert.deepEqual(recoveryTally, {
      ambiguousConnective: 0, citationOmitsQuantity: 0, ...(language === 'fa' ? { numericalExactness: 1 } : {}),
    });
    assert.equal(result.units.length, 0);
    const event = events.find(e => e.reason === 'NUMERICAL_CONSTRAINT')!;
    assert.equal(event.unitId, 'u1');
    assert.equal(event.numericalMismatchReason, 'CLAIM_AMBIGUOUS');
    assert.deepEqual(event.ambiguityReasons, expected);
    assert.equal(event.numericalComparisons?.length, 2);
    assert.ok(event.numericalComparisons?.every(row => row.candidateAmbiguous && !row.sourceAmbiguous &&
      row.candidateBound === 'unbounded' && row.sourceBound === 'unbounded' && row.temporalAnchorCompatible));
    assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(events).includes(quote));
  });
}
