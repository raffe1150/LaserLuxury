/** Frozen synthetic experiment, never a production atomizer or authority. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildEvidenceFirstAnswer,parseRequestedFacets,InformationBudget,type Evidence} from '../../src/ai/business-information-answer-plan';
import {configuredServiceEvidence} from '../../src/ai/configured-service-evidence';
import {compactKnowledgeVerifierInput} from '../../src/ai/knowledge-verifier-input';
import {captureSyntheticVerifierRequest,type SyntheticVerifierPolicy} from './semantic-verifier-diagnostics';

export type AtomicArm='compound'|'atomic';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function loadAtomicComparison(){
 const artifact=JSON.parse(readFileSync(new URL('../../docs/validation/shared-core-2026-10-22/real-source-aware-decision-diagnostics.json',import.meta.url),'utf8'));
 const c=artifact.cases.find((c:any)=>c.language==='en'&&c.questionIndex===1&&c.channel==='telegram');
 const call=c.providerCalls.find((x:any)=>x.kind==='verification');
 assert.equal(call.verifierRequest.captureStatus,'COMPLETE');assert.equal(call.requestBytesUnchanged,true);
 assert.equal(hash(JSON.stringify(call.verifierRequest.request)),call.verifierRequest.requestSha256);
 assert.equal(hash(JSON.stringify(call.verifierRequest.input)),call.verifierRequest.inputSha256);
 const input=structuredClone(call.verifierRequest.input),request=structuredClone(call.verifierRequest.request);
 const timeoutMs=c.decisions.find((x:any)=>x.eventType==='transport'&&x.stage==='verification').timeoutMs;
 assert.equal(timeoutMs,11960,'Use the captured allowance, never a larger budget');
 const source=input.evidence.find((e:any)=>e.id==='e3');
 assert.ok(source&&source.businessId===77);
 const q1='AdMotion Studio erbjuder i detta test digitala informationssamtal för kunder som behöver allmän vägledning inför ett första besök.';
 const q2='Digitala informationssamtal används endast för inledande information.';
 const q3='De ersätter inte automatiskt ett fysiskt besök, och alla ärenden kan inte hanteras digitalt.';
 for(const quote of [q1,q2,q3])assert.ok(source.text.includes(quote));
 // For pronoun-bearing constraints, retain the contiguous offering/purpose
 // context as well. Both arms still provide the identical full source corpus.
 const context=source.text.slice(source.text.indexOf(q2),source.text.indexOf(q3)+q3.length);
 const make=(id:string,subject:string,predicate:string,value:string,scope:string,negation:boolean,text:string,quote:string)=>({id,facetIds:['f1'],subject,predicate,value,modality:'descriptive',negation,scope,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e3',exactQuote:quote}]});
 const units=[structuredClone(input.units[0]),
  make('u2','AdMotion Studio','offers digital information calls','general guidance before a first visit','customers who need general guidance before a first visit',false,
   'AdMotion Studio offers digital information calls for customers who need general guidance before a first visit.',q1),
  make('u3','AdMotion Studio digital information calls','are used','only for initial information','AdMotion Studio digital information calls',false,
   "AdMotion Studio's digital information calls are used only for initial information.",q2),
  make('u4','AdMotion Studio digital information calls','replace a physical visit','not automatically','AdMotion Studio digital information calls',true,
   "AdMotion Studio's digital information calls do not automatically replace a physical visit.",context),
  make('u5','matters','can be handled digitally','not all matters','documented digital information context',true,
   'Not all matters can be handled digitally.',context)];
 assert.equal(units.length,5);assert.equal(input.units[0].id,'u1');
 const atomicInput={...structuredClone(input),units};
 const atomicRequest=structuredClone(request);atomicRequest.input[0].content=JSON.stringify(atomicInput);
 const policy:SyntheticVerifierPolicy={enabled:true,nodeEnv:'test',question:input.question,
  allowedEvidence:new Set(input.evidence.map((e:any)=>e.text)),structuredAuthority:JSON.parse(input.authoritativeEvidence.structured_business_config),secrets:[]};
 captureSyntheticVerifierRequest(request,policy);captureSyntheticVerifierRequest(atomicRequest,policy);
 return{input,request,atomicInput,atomicRequest,timeoutMs,policy,baselineRequestSha256:call.verifierRequest.requestSha256,
  changedFields:['input[0].content.units'],
  dependencies:{documentaryInventory:['u2','u3','u4','u5'],guidanceRequiresPurposeRestriction:['u2','u3'],
   scope:'Fixture assessment only; no configured-service relationship and no publication authority'}};
}

/** Exact fixture integrity, NOT a general semantic verifier. Negative mutations
 * must not silently become the proposed source-faithful experimental arm. */
export function assertControlledRepresentation(arm:AtomicArm,candidate:any){
 const frozen=loadAtomicComparison();assert.deepEqual(candidate,arm==='compound'?frozen.input:frozen.atomicInput,'Controlled source-faithful fixture drift');
}

/** Replay actual verdicts through unchanged production acceptance/accounting.
 * Fresh synthetic bindings and mocked generation; no channel or provider call. */
export async function accountAtomicVerdict(input:any,output:any){
 const evidence:Evidence[]=input.evidence.map((e:any)=>e.id==='configured-services'
  ?configuredServiceEvidence(77,JSON.parse(e.text).services)!
  :{...e,sourceId:'atomic-feasibility-pdf',chunkId:hash(e.text),version:hash(e.text)});
 const events:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:input.question,language:'en',facets:parseRequestedFacets(input.facets).facets,evidence,
  authoritativeEvidence:JSON.stringify(input.authoritativeEvidence),businessTone:{},history:[],foreground:true,omitModelEvidenceVersions:true,
  budget:new InformationBudget(),current:async()=>true,languageSafe:()=>true,diagnostic:e=>events.push(e),
  generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction')return{text:JSON.stringify({oversized:false,units:input.units.filter((u:any)=>u.id!=='u1')})};
   if(stage==='verification'){
    assert.deepEqual(compactKnowledgeVerifierInput(data),input,'Replay must preserve the complete verifier contract');
    return{text:JSON.stringify(output)};
   }
   assert.equal(stage,'composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 const accepted=new Set(manifest.units.map(u=>u.id)),documentIds=input.units.filter((u:any)=>u.id!=='u1').map((u:any)=>u.id);
 return{catalogAccepted:accepted.has('u1'),documentaryIds:documentIds,acceptedDocumentaryIds:documentIds.filter((id:string)=>accepted.has(id)),
  allDocumentaryPropositionsAccepted:documentIds.every((id:string)=>accepted.has(id)),reportedCoverage:output.coverage,
  fullQuestionOutcomes:manifest.outcomes,sourceScopeNotice:manifest.sourceScopeNotice??null,
  interpretation:'Offline verdict-accounting replay; not a latency or outbound-delivery result',events};
}
