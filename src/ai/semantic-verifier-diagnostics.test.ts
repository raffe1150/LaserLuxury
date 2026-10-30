import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureSyntheticVerifierRequest,captureSyntheticVerifierDecision,type SyntheticVerifierPolicy} from '../../tests/helpers/semantic-verifier-diagnostics';
import {knowledgeStructuredOutput} from './knowledge-answer-protocol';
import {configuredServiceEvidence} from './configured-service-evidence';
import {parseRequestedFacets} from './business-information-answer-plan';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-core-verifier-disagreements.json',import.meta.url),'utf8'));
const copy=<T>(x:T):T=>structuredClone(x);
function setup(index=0){
 const c=fixture.cases[index],evidence=copy(c.wireDocumentEvidence),catalog=c.verifierUnits.find((u:any)=>u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services'));
 if(catalog){const e=configuredServiceEvidence(77,[JSON.parse(catalog.evidenceRefs[0].exactQuote)])!;evidence.push({id:e.id,businessId:77,text:e.text});}
 const authority={businessName:'Synthetic diagnostic business'};
 const input={question:c.questionFromRunFixture,requestedLanguage:c.language,units:copy(c.verifierUnits),facets:parseRequestedFacets(c.facetsReconstructed).facets,evidence,
  authoritativeEvidence:{business_system_prompt:'',structured_business_config:JSON.stringify(authority),verified_booking_state:''}};
 const body={model:'gpt-5.6-luna',instructions:'OdinLink EVIDENCE-FIRST BATCH ENTAILMENT. Unmodified test instruction.',reasoning:{effort:'low'},input:[{role:'user',content:JSON.stringify(input)}],text:{format:{type:'json_schema',name:knowledgeStructuredOutput('verification').name,strict:true,schema:knowledgeStructuredOutput('verification').schema}}};
 const policy:SyntheticVerifierPolicy={enabled:true,nodeEnv:'test',question:input.question,allowedEvidence:new Set(evidence.map((e:any)=>e.text)),structuredAuthority:authority,secrets:['synthetic-secret-value']};
 return{c,input,body,policy};
}
test('capture retains the complete unmodified semantic request and strict output schema without headers',()=>{
 const {body,policy}=setup(),before=JSON.stringify(body),capture=captureSyntheticVerifierRequest(body,policy);
 assert.equal(capture.captureStatus,'COMPLETE');assert.deepEqual(capture.request,body);assert.equal(JSON.stringify(body),before);
 assert.equal(capture.request.text.format.strict,true);assert.equal(capture.input.question,policy.question);
 assert.equal(capture.requestSha256.length,64);assert.equal(capture.inputSha256.length,64);
});
test('English rejection categories come only from reported flags; the exact narrower reason stays unknown',()=>{
 const {c,body,policy}=setup(),capture=captureSyntheticVerifierRequest(body,policy),before=JSON.stringify(c.verifierOutput);
 const result:any=captureSyntheticVerifierDecision(capture,before,policy),unit=result.units.find((u:any)=>u.unitId==='u2');
 assert.deepEqual(unit.observableCategories,['ENTAILMENT_RELATION','SEMANTIC_PRESERVATION']);assert.equal(unit.reasonStatus,'UNKNOWN');
 assert.equal(unit.exactRejectedSubproposition,null);assert.equal(unit.semanticExplanation,null);
 assert.equal(unit.proposition.text,c.verifierUnits[1].text);assert.equal(unit.evidenceBindings[0].evidenceAlias,'e3');
 const b=unit.evidenceBindings[0],e=capture.input.evidence.find((e:any)=>e.id==='e3');
 assert.equal(b.bindingStatus,'EXACT');assert.equal(e.text.slice(b.sourceStartUtf16,b.sourceEndUtf16),b.quotedSpan);
 assert.equal(result.noDecisionMutation,true);assert.equal(JSON.stringify(c.verifierOutput),before);
});
test('German incomplete coverage cannot invent which requested proposition was missing',()=>{
 const {c,body,policy}=setup(1),capture=captureSyntheticVerifierRequest(body,policy);
 const result:any=captureSyntheticVerifierDecision(capture,JSON.stringify(c.verifierOutput),policy);
 assert.equal(result.coverage[0].reportedCoverage.incompletenessReason,'MISSING_RELEVANT_FACT');
 assert.equal(result.coverage[0].missingRequestedProposition.status,'UNKNOWN');assert.equal(result.coverage[0].missingRequestedProposition.text,null);
 assert.deepEqual(result.coverage[0].reportedMaterialUnits,['u1','u2','u3']);
 assert.ok(result.units.every((u:any)=>u.reportedDecision.relation==='ENTAILED'));
});
test('UNKNOWN with true preservation flags is not relabeled as a semantic-preservation or source-scope rejection',()=>{
 const {c,body,policy}=setup(),capture=captureSyntheticVerifierRequest(body,policy),output=copy(c.verifierOutput);
 output.decisions[1].meaningPreserved=true;
 const result:any=captureSyntheticVerifierDecision(capture,JSON.stringify(output),policy);
 assert.deepEqual(result.units[1].observableCategories,['ENTAILMENT_RELATION']);
 assert.equal(result.units[1].reportedDecision.relation,'UNKNOWN');
 assert.equal(result.units[1].reasonStatus,'UNKNOWN');assert.equal(result.units[1].semanticExplanation,null);
});
for(const field of ['modalityPreserved','qualifiersPreserved','relevant','languageCorrect']as const)test(`observed ${field} disagreement is categorized without supplying a reason`,()=>{
 const {c,body,policy}=setup(1),capture=captureSyntheticVerifierRequest(body,policy),output=copy(c.verifierOutput);
 output.decisions[0][field]=false;
 const result:any=captureSyntheticVerifierDecision(capture,JSON.stringify(output),policy);
 assert.equal(result.units[0].observableCategories.length,1);assert.equal(result.units[0].reasonStatus,'UNKNOWN');
});
test('wrong source alias or quote is visible in the witness, never silently repaired',()=>{
 const {c,body,policy,input}=setup();input.units[1].evidenceRefs[0].evidenceId='missing';body.input[0].content=JSON.stringify(input);
 let result:any=captureSyntheticVerifierDecision(captureSyntheticVerifierRequest(body,policy),JSON.stringify(c.verifierOutput),policy);
 assert.equal(result.units[1].evidenceBindings[0].bindingStatus,'EVIDENCE_ALIAS_UNKNOWN');
 input.units[1].evidenceRefs[0]={evidenceId:'e2',exactQuote:'An unsupported quotation.'};body.input[0].content=JSON.stringify(input);
 result=captureSyntheticVerifierDecision(captureSyntheticVerifierRequest(body,policy),JSON.stringify(c.verifierOutput),policy);
 assert.equal(result.units[1].evidenceBindings[0].bindingStatus,'QUOTE_NOT_FOUND');
});
test('duplicate or absent verdict and malformed output record unknown rather than an invented explanation',()=>{
 const {c,body,policy}=setup(),capture=captureSyntheticVerifierRequest(body,policy),output=copy(c.verifierOutput);output.decisions.push(copy(output.decisions[1]));
 let result:any=captureSyntheticVerifierDecision(capture,JSON.stringify(output),policy);
 assert.equal(result.units[1].reportedDecision,null);assert.equal(result.units[1].reasonStatus,'UNKNOWN');
 result=captureSyntheticVerifierDecision(capture,'not JSON',policy);assert.equal(result.reasonStatus,'UNKNOWN');
});
for(const mode of ['disabled','production','foreign-tenant','unknown-source','authority','question','headers','oversized','credential','personal-info']as const)test(`unsafe capture is refused without echoing content: ${mode}`,()=>{
 const {body,policy,input}=setup();
 if(mode==='disabled')policy.enabled=false;
 if(mode==='production')policy.nodeEnv='production';
 if(mode==='foreign-tenant')input.evidence[0].businessId=88;
 if(mode==='unknown-source')input.evidence[0].text='Unapproved live content';
 if(mode==='authority')input.authoritativeEvidence.structured_business_config=JSON.stringify({businessName:'Other real business'});
 if(mode==='question')input.question='Unapproved customer question';
 if(mode==='headers')(body as any).headers={authorization:'sensitive'};
 if(mode==='oversized')body.instructions+='x'.repeat(128001);
 if(mode==='credential')input.units[0].text=policy.secrets[0];
 if(mode==='personal-info')input.units[0].text='Contact real.person@example.com';
 body.input[0].content=JSON.stringify(input);
 assert.throws(()=>captureSyntheticVerifierRequest(body,policy),{message:'Synthetic verifier capture rejected'});
});
test('sensitive or oversized output is refused instead of storing a misleading truncated capture',()=>{
 const {body,policy}=setup(),capture=captureSyntheticVerifierRequest(body,policy);
 for(const text of [policy.secrets[0],'x'.repeat(32001),'person@example.com'])assert.throws(()=>captureSyntheticVerifierDecision(capture,text,policy),{message:'Synthetic verifier capture rejected'});
});
