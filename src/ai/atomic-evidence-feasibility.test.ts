import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAtomicComparison,assertControlledRepresentation,accountAtomicVerdict,type AtomicArm} from '../../tests/helpers/atomic-evidence-feasibility';
import {parseAnswerUnits,parseRequestedFacets,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
const comparison=loadAtomicComparison();
const verdict=(input:any,rejected?:string,complete=false)=>({decisions:input.units.map((u:any)=>({unitId:u.id,relation:u.id===rejected?'UNKNOWN':'ENTAILED',facetIds:u.facetIds,
 meaningPreserved:u.id!==rejected,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,explicitAbsenceEvidence:false,negativeAbsence:false})),
 coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:complete,incompletenessReason:complete?'NONE':'UNRESOLVED',materialUnitIds:input.units.filter((u:any)=>u.id!==rejected).map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:complete?'COVERED':'UNRESOLVED',unitIds:input.units.filter((u:any)=>u.id!==rejected).map((u:any)=>u.id)}]}]});
function parse(input:any){
 const evidence:Evidence[]=input.evidence.map((e:any)=>e.id==='configured-services'?configuredServiceEvidence(77,JSON.parse(e.text).services):({...e,sourceId:'fixture-pdf',chunkId:e.id,version:'fixture'}));
 const events:any[]=[];return{...parseAnswerUnits({units:input.units},parseRequestedFacets(input.facets).facets,evidence,'en',e=>events.push(e)),events};
}
test('control is the exact captured request; only units change in the atomic arm',()=>{
 assert.equal(JSON.stringify(comparison.request.input[0].content),JSON.stringify(JSON.stringify(comparison.input)));
 assert.equal(comparison.timeoutMs,11960);
 const {units:_c,...control}=comparison.input,{units:_a,...atomic}=comparison.atomicInput;
 assert.deepEqual(atomic,control);
 const modified=structuredClone(comparison.atomicRequest);modified.input[0].content=comparison.request.input[0].content;
 assert.deepEqual(modified,comparison.request);assert.deepEqual(comparison.atomicInput.units[0],comparison.input.units[0]);
});
test('four source propositions preserve purpose restriction, negative universal and independent documentary scope',()=>{
 const atoms=comparison.atomicInput.units.slice(1);
 assert.equal(atoms.length,4);assert.ok(atoms.every((u:any)=>u.modality==='descriptive'&&!JSON.stringify(u).includes('Video Consultation')));
 assert.deepEqual(atoms.map((u:any)=>u.negation),[false,false,true,true]);
 assert.match(atoms[0].scope,/customers who need general guidance before a first visit/);
 assert.match(atoms[1].text,/only for initial information/);assert.match(atoms[2].text,/do not automatically replace/);
 assert.equal(atoms[3].text,'Not all matters can be handled digitally.');
 for(const u of atoms)for(const r of u.evidenceRefs)assert.ok(comparison.input.evidence.find((e:any)=>e.id===r.evidenceId).text.includes(r.exactQuote));
});
for(const arm of ['compound','atomic']as AtomicArm[]){
 const source=arm==='compound'?comparison.input:comparison.atomicInput;
 test(`${arm}: both source-faithful fixtures pass the unchanged parser and bound checks`,()=>{
  assertControlledRepresentation(arm,source);const p=parse(source);assert.equal(p.units.length,source.units.length);assert.equal(p.oversized,false);
 });
 test(`${arm}: unsupported configured-service equivalence is independently vetoed`,()=>{
  const changed=structuredClone(source);changed.units[1].subject='Video Consultation';changed.units[1].text='Video Consultation is the same offering as the documented digital information calls.';
  assert.throws(()=>assertControlledRepresentation(arm,changed));const p=parse(changed);
  assert.ok(p.events.some(e=>e.reason==='SOURCE_SCOPE'));assert.ok(!p.units.some(u=>u.id==='u2'));
 });
 test(`${arm}: wrong evidence alias cannot support an otherwise exact quote`,()=>{
  const changed=structuredClone(source);changed.units[1].evidenceRefs[0].evidenceId='e2';
  assert.throws(()=>assertControlledRepresentation(arm,changed));const p=parse(changed);
  assert.ok(p.events.some(e=>e.reason==='INVALID_CITATION'));assert.ok(!p.units.some(u=>u.id==='u2'));
 });
 test(`${arm}: changed quantifier is outside the source-faithful fixture and a rejected unit cannot complete coverage`,async()=>{
  const changed=structuredClone(source),unit=changed.units.at(-1);
  unit.text=arm==='compound'?unit.text.replace('cannot handle every matter digitally','can handle every matter digitally'):'All matters can be handled digitally.';
  unit.value='all matters can be handled digitally';unit.negation=false;
  assert.throws(()=>assertControlledRepresentation(arm,changed));
  // A parser proves citation presence, not semantic entailment. This mock
  // rejection tests accounting; it is not a real-provider negative-control pass.
  const result=await accountAtomicVerdict(changed,verdict(changed,unit.id));
  assert.equal(result.allDocumentaryPropositionsAccepted,false);assert.equal(result.fullQuestionOutcomes[0].status,'PARTIAL');
 });
 test(`${arm}: missing ONLY condition is not accepted as the controlled representation`,async()=>{
  const changed=structuredClone(source),unit=changed.units[arm==='compound'?1:2];
  unit.text=unit.text.replace('only for initial information','for initial information');unit.value=unit.value.replace('only for initial information','for initial information');
  assert.throws(()=>assertControlledRepresentation(arm,changed));
  const result=await accountAtomicVerdict(changed,verdict(changed,unit.id));
  assert.equal(result.allDocumentaryPropositionsAccepted,false);assert.equal(result.fullQuestionOutcomes[0].status,'PARTIAL');
 });
 test(`${arm}: even all-ENTAILED plus mocked complete coverage cannot invent a configured-service relationship`,async()=>{
  const result=await accountAtomicVerdict(source,verdict(source,undefined,true));
  assert.equal(result.allDocumentaryPropositionsAccepted,true);assert.equal(result.catalogAccepted,true);
  assert.equal(result.fullQuestionOutcomes[0].status,'PARTIAL');assert.equal(result.fullQuestionOutcomes[0].materialFactsComplete,false);
  assert.match(result.sourceScopeNotice!,/cannot confirm whether the document's information applies to Video Consultation/);
 });
 test(`${arm}: independently incomplete coverage is preserved even if every unit is entailed`,async()=>{
  const result=await accountAtomicVerdict(source,verdict(source));
  assert.equal(result.allDocumentaryPropositionsAccepted,true);assert.equal(result.fullQuestionOutcomes[0].status,'PARTIAL');
 });
}
