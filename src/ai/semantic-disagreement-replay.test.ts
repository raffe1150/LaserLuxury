import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildEvidenceFirstAnswer,parseRequestedFacets,InformationBudget,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-core-verifier-disagreements.json',import.meta.url),'utf8'));
const en=fixture.cases[0],de=fixture.cases[1];
const clone=<T>(x:T):T=>structuredClone(x);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function evidenceFor(c:any):Evidence[]{
 const evidence:Evidence[]=c.wireDocumentEvidence.map((e:any)=>({...e,sourceId:'offline-replay-pdf',chunkId:hash(e.text),version:hash(e.text)}));
 const catalogUnit=c.verifierUnits.find((u:any)=>u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services'));
 if(catalogUnit)evidence.push(configuredServiceEvidence(77,[JSON.parse(catalogUnit.evidenceRefs[0].exactQuote)])!);
 return evidence;
}
async function replay(c:any,options:{proposal?:(x:any)=>void;verdict?:(x:any)=>void;revokeDocument?:boolean}={}){
 const evidence=evidenceFor(c),facets=parseRequestedFacets(c.facetsReconstructed).facets;
 let extracted=false;const events:any[]=[],verificationInputs:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:c.questionFromRunFixture,language:c.language,facets,evidence,
  // The old full authority envelope was NOT captured. This replay verifies
  // accounting of saved verdicts, not independent semantics or an old request.
  authoritativeEvidence:'{}',history:[],businessTone:{},foreground:true,omitModelEvidenceVersions:true,
  budget:new InformationBudget(),current:async()=>true,languageSafe:()=>true,
  revalidateEvidence:async()=>options.revokeDocument&&extracted?evidence.filter(e=>e.id==='configured-services'):evidence,
  diagnostic:e=>events.push(e),generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction'){
    const proposal=clone(c.extractionOutput);options.proposal?.(proposal);extracted=true;
    return{text:JSON.stringify(proposal)};
   }
   if(stage==='verification'){
    verificationInputs.push(clone(data));const verdict=clone(c.verifierOutput);options.verdict?.(verdict);
    return{text:JSON.stringify(verdict)};
   }
   assert.equal(stage,'composition');
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 return{manifest,events,verificationInputs};
}

test('saved evidence and verdicts remain byte/content bound to the original artifact',()=>{
 const original=readFileSync(new URL('../../docs/validation/shared-core-2026-10-22/real-source-aware-routing-focus-one.json',import.meta.url));
 assert.equal(hash(original.toString()),fixture.sourceArtifactSha256);
 const artifact=JSON.parse(original.toString());
 for(const c of fixture.cases){
  const saved=artifact.cases.find((x:any)=>x.language===c.language&&x.questionIndex===c.questionIndex);
  assert.deepEqual(c.verifierUnits,saved.providerCalls.find((x:any)=>x.kind==='verification').verificationUnits);
  assert.deepEqual(c.verifierOutput,JSON.parse(saved.providerCalls.find((x:any)=>x.kind==='verification').structuredText));
  for(const e of c.wireDocumentEvidence)assert.equal(hash(e.text),c.documentMapping.find((m:any)=>m.wireId===e.id).sha256);
 }
});

test('English B replay preserves the exact parsed unit payload; UNKNOWN cannot publish a complete-looking proposal',async()=>{
 const {manifest,events,verificationInputs}=await replay(en);
 assert.deepEqual(verificationInputs[0].units,en.verifierUnits);
 assert.equal(verificationInputs[0].question,en.questionFromRunFixture);
 assert.equal(manifest.units.length,1);assert.equal(manifest.units[0].id,'u1');
 assert.match(manifest.text,/300 SEK and lasts 60 minutes/);
 assert.doesNotMatch(manifest.text,/used only for initial information/);
 assert.match(manifest.text,/cannot confirm whether/);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.ok(events.some(e=>e.unitId==='u2'&&e.reason==='UNKNOWN'));
});

test('German A replay preserves all three units and the actual incomplete verdict; no local false-negative decoder',async()=>{
 const {manifest,events,verificationInputs}=await replay(de);
 assert.deepEqual(verificationInputs[0].units,de.verifierUnits);
 assert.equal(manifest.units.length,3);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.equal(manifest.outcomes[0].requestAligned,true);
 assert.deepEqual(manifest.outcomes[0].materialUnitIds,['u1','u2','u3']);
 assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'&&e.incompletenessReason==='MISSING_RELEVANT_FACT'));
 assert.ok(!events.some(e=>e.reason==='INVALID_COVERAGE'));
});

test('genuinely missing conditional instruction remains incomplete even when the other units are entailed',async()=>{
 const {manifest}=await replay(de,{proposal:x=>x.units.pop(),verdict:x=>{
  x.decisions.pop();x.coverage[0].materialUnitIds=['u1','u2'];x.coverage[0].obligations[0].unitIds=['u1','u2'];
 }});
 assert.equal(manifest.units.length,2);assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.doesNotMatch(manifest.text,/müssen Sie diese befolgen/);
});

test('an entailed recommendation cannot answer an unconditional requirement even with mocked positive coverage',async()=>{
 const c=clone(de);
 c.facetsReconstructed=[{subject:'visitor',attribute:'required items',questionType:'requirement',obligations:[{description:'Must I bring a booking confirmation?',questionType:'requirement'}]}];
 c.extractionOutput.units=[clone(de.extractionOutput.units[1])];
 c.verifierOutput.decisions=[clone(de.verifierOutput.decisions[0])];
 c.verifierOutput.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]}];
 const {manifest}=await replay(c);
 assert.equal(manifest.units.length,1);assert.equal(manifest.units[0].modality,'recommended');
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');
});

test('a missing-coverage verdict cannot become complete merely because every supplied unit is entailed',async()=>{
 const {manifest}=await replay(de,{verdict:x=>{x.coverage=[];}});
 assert.equal(manifest.units.length,3);assert.equal(manifest.outcomes[0].status,'PARTIAL');
});

test('mocked positive coverage is honored only with accepted material units; this is not a real-provider pass',async()=>{
 const {manifest}=await replay(de,{verdict:x=>{
  x.coverage[0].materialFactsComplete=true;x.coverage[0].incompletenessReason='NONE';
  x.coverage[0].obligations[0].status='COVERED';
 }});
 assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.units.length,3);
});

test('a complete-coverage claim referencing an UNKNOWN sibling cannot promote it',async()=>{
 const {manifest,events}=await replay(en,{verdict:x=>{
  const c=x.coverage[0];c.materialFactsComplete=true;c.incompletenessReason='NONE';c.materialUnitIds=['u1','u2'];
  c.obligations[0]={obligationId:'f1.o1',status:'COVERED',unitIds:['u1','u2']};
 }});
 assert.equal(manifest.units.length,1);assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.ok(events.some(e=>e.reason==='INVALID_COVERAGE'));
});

test('swapping a documentary citation to the wrong item cannot survive parsing or borrow catalog authority',async()=>{
 const {manifest,events}=await replay(en,{proposal:x=>{x.units[0].evidenceRefs[0].evidenceId='e2';}});
 assert.equal(manifest.units.length,1);assert.equal(manifest.units[0].id,'u1');
 assert.ok(events.some(e=>e.stage==='extraction'&&e.unitId==='u2'&&e.reason==='INVALID_CITATION'&&e.citationSubtype==='QUOTE_NOT_FOUND'));
});

test('unsupported documentary identity with the configured service is vetoed independently',async()=>{
 const {manifest,events}=await replay(en,{proposal:x=>{x.units[0].subject='Video Consultation';}});
 assert.equal(manifest.units.length,1);assert.equal(manifest.units[0].id,'u1');
 assert.ok(events.some(e=>e.unitId==='u2'&&e.reason==='SOURCE_SCOPE'));
});

test('document revocation cannot erase the independently current catalog or publish revoked clauses',async()=>{
 const {manifest}=await replay(en,{revokeDocument:true});
 assert.equal(manifest.units.length,1);assert.match(manifest.text,/300 SEK and lasts 60 minutes/);
 assert.doesNotMatch(manifest.text,/digital informational conversations/);
});
