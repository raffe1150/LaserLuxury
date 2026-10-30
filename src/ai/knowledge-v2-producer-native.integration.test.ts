/** Reuses accepted final-three native fixture; adds producer wire assertions.
 * All generations are SCRIPTED controls, not real prompt efficacy or acceptance. */
import test,{after,type TestContext} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Responses} from 'openai/resources/responses';
import {KnowledgeService} from '../../knowledge';
import {prepareDatabase} from '../../docs/validation/shared-core-2026-10-22/semantic-only-nibble-diagnostic-20261025/diagnostic';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from '../knowledge/embedding-backfill';
import {nativeKnowledgeTiming} from './knowledge-timing-policy';
import {FOREGROUND_UNIT_EXTRACTION_INSTRUCTION,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION,NATIVE_V2_PRODUCER_GUIDANCE,NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE}from'./business-information-answer-plan';
import {incidentFlags,incidentConfig,incidentInbound,incidentChannels,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {documentaryQuotes,documentaryStatements} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {getAiProviderAdapter} from './providers/router';
import {diagnosticProviderStage,assertDiagnosticDispatch,optionalQueryEmbeddingCancelled,DiagnosticStageNotAuthorized} from '../../scripts/knowledge-native-diagnostic-guards';
const base='docs/validation/shared-core-2026-10-22/native-four-language-revalidation-20261027';
const saved=(id:string)=>JSON.parse(readFileSync(`${base}/${id}/result.json`,'utf8'));
const record:any={};let unexpectedNetwork=0;
incidentFlags();Object.assign(process.env,{OPENAI_API_KEY:'synthetic-offline-only',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2'});
delete process.env.ODINLINK_SHARED_PG;delete process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY;
const network=globalThis.fetch;globalThis.fetch=async()=>{unexpectedNetwork++;throw Error('OFFLINE: network disabled');};
const prepared=await prepareDatabase(record),results:unknown[]=[];
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
after(()=>{prepared.close();globalThis.fetch=network;assert.equal(unexpectedNetwork,0);if(process.env.ODINLINK_V2_PRODUCER_NATIVE_RESULTS)writeFileSync(process.env.ODINLINK_V2_PRODUCER_NATIVE_RESULTS,JSON.stringify({mode:'OFFLINE_SCRIPTED_GENERATIONS_SAVED_GENUINE_VECTORS_ACTUAL_PG_NATIVE_ADAPTERS',newProviderRequests:0,vectorProvenance:{sources:'saved genuine vectors',PersianQuery:'saved genuine vector'},purpose:'Scripted contract/rejection proof; not model responsiveness to the changed prompt',preparation:record.preparation,results},null,2),{flag:'wx'});});
const vector=(id:string)=>{if(id==='B-de')return{...identity,values:Array.from({length:768},(_,i)=>i===0?1:0)};const c=saved(id).state.calls.find((c:any)=>c.stage==='embedding');return{...identity,values:c.rawProviderResponse.data[0].embedding};};
const projection=(s:string)=>s.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
const allowed=['language','embedding','extraction','verification'] as const;
type Mode='success'|'optional-timeout'|'parent-cancel'|'captured-parse-loss'|'valid-only-control'|'recovery-denied'|'candidate-control'|'foreign-evidence'|'revoked-source';
let serial=46910000000;
async function exercise(t:TestContext,id:'B-de'|'C-fa'|'B-ar',channel:typeof incidentChannels[number],mode:Mode){
 const f=saved(id),question=f.spec.question,language=f.spec.language,caseC=new AbortController(),stages:string[]=[],events:any[]=[],metrics:any[]=[],inputs:any[]=[],replies:string[]=[],optional:any[]=[],denied:string[]=[];let actions=0,embeddings=0,terminal=false;
 const old=structuredClone(incidentConfig);b.reset();incidentConfig.language='sv';incidentConfig.services=structuredClone(JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/prepared-gate-final.json','utf8')).catalog);
 if(mode==='candidate-control')process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY='candidate-top5-v1';else delete process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY;
 for(const name of ['log','info','warn','error']as const)t.mock.method(console,name,()=>{});
 const tenant=(id:number)=>assert.equal(id,77),forbidden=async()=>{actions++;throw Error('Forbidden business action');};
 const context=(signal?:AbortSignal)=>({caseSignal:caseC.signal,nativeSignal:nativeKnowledgeTiming()?.signal,requestSignal:signal});
 const embed=async(texts:string[],options:any)=>{
  embeddings++;assert.equal(embeddings,1,'No extra query batch or customer corpus embeddings');assert.equal(projection(texts[0]),projection(question));assert.equal(texts.length,1);
  assertDiagnosticDispatch('embedding',allowed,context(options.signal));
  if(mode==='optional-timeout'||mode==='parent-cancel')return new Promise<any[]>((_resolve,reject)=>{
   options.signal.addEventListener('abort',()=>{const e=new DOMException('Cancelled','AbortError');if(optionalQueryEmbeddingCancelled('embedding',e,context(options.signal)))optional.push('retained unknown usage; lexical continuation');else terminal=true;reject(e);},{once:true});
   if(mode==='parent-cancel')setTimeout(()=>nativeKnowledgeTiming()!.fail(),5);
  });
  return texts.map(()=>structuredClone(vector(id)));
 };
 const service=new KnowledgeService(prepared.storage,prepared.storage,{supportsLocalSemanticSearch:true,embedDocuments:embed,embedQuery:async(q,opts)=>(await embed([q],opts))[0]},true);
 const originalGenerate=getAiProviderAdapter('openai')!.generate!.bind(getAiProviderAdapter('openai'));
 t.mock.method(getAiProviderAdapter('openai')!,'generate',r=>originalGenerate(r.structuredOutput?.name==='odinlink_knowledge_verification_v2'?{...r,model:'gpt-6.1-sol',reasoningEffort:'low'}:r));
 t.mock.method(Responses.prototype,'create',async(p:any)=>{
  const stage=diagnosticProviderStage(p,'/v1/responses');
  try{assertDiagnosticDispatch(stage,allowed,context());}catch(e){if(e instanceof DiagnosticStageNotAuthorized){denied.push(e.stage);terminal=true;}throw e;}
  if(terminal)throw Error('Mandatory stage closed');stages.push(stage);
  const data=p.input?.[0]?.content?JSON.parse(p.input[0].content):null;inputs.push({stage,data,instruction:p.instructions,model:p.model,format:p.text?.format,reasoning:p.reasoning,request:p});
  let text:string;
  if(stage==='language')text=JSON.stringify({language,requestedReplyLanguage:null,confidence:.99});
  else if(stage==='extraction'){
   assert.equal(p.instructions,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION+'\n'+NATIVE_V2_PRODUCER_GUIDANCE+'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE);
   if(id==='C-fa'){const original=f.state.calls.find((c:any)=>c.stage==='extraction').request;assert.deepEqual(JSON.parse(JSON.stringify({...p,max_output_tokens:p.max_output_tokens??8192,service_tier:'default',prompt_cache_options:{mode:'implicit',ttl:'30m'}})),{...original,instructions:original.instructions+'\n'+NATIVE_V2_PRODUCER_GUIDANCE+'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE},'Reviewed SDK-wire body differs only by the reviewed producer and responsiveness adjuncts');}
   assert.equal(p.text.format.name,'odinlink_knowledge_extraction_v2');assert.equal(p.text.format.strict,true);assert.deepEqual(p.reasoning,{effort:'low'});
   if(id==='C-fa')assert.deepEqual(data,JSON.parse(f.state.calls.find((c:any)=>c.stage==='extraction').request.input[0].content),'The complete original producer payload is unchanged');
   if(id==='C-fa')assert.equal(projection(data.question),projection(question));else assert.equal(projection(data.question),projection(question).replaceAll('Video Consultation','[question subject]'),'Existing catalog-name masking is extraction-only; verifier receives the full question');assert.ok(data.evidence.every((e:any)=>e.businessId===77));
   if(id==='C-fa'){
    const raw=JSON.parse(f.state.calls.find((c:any)=>c.stage==='extraction').outputText);
    if(mode!=='captured-parse-loss')raw.units=raw.units.slice(1); // New scripted producer control, NOT a repair/regrade of the capture.
    text=JSON.stringify(raw);
   }else text=JSON.stringify({units:documentaryStatements.B[language].map((text,i)=>{
    const quote=documentaryQuotes.B[i],e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e,'Required original documentary quote');
    return{facetIds:['f1'],subject:'Digital information calls',predicate:`fact ${i+1}`,value:text,scope:'documentary offering only',modality:'descriptive',negation:i>1,qualifiers:[],language,text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};
   })});
  }else if(stage==='verification'){
   assert.equal(p.instructions,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION+(id==='C-fa'?'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE:''));assert.equal(p.model,'gpt-6.1-sol');assert.deepEqual(p.reasoning,{effort:'low'});assert.equal(p.text.format.name,'odinlink_knowledge_verification_v2');
   assert.equal(projection(data.question),projection(question));
   for(const u of data.units)for(const ref of u.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===ref.evidenceId&&e.businessId===77)?.text.includes(ref.exactQuote));
   if(id==='C-fa'&&mode==='captured-parse-loss')text=f.state.calls.find((c:any)=>c.stage==='verification').outputText;
   else text=JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:id==='C-fa',explicitAbsenceEvidence:id==='C-fa'})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:data.units.map((u:any)=>u.id),obligations:data.facets[0].obligations.map((o:any,i:number)=>({obligationId:o.id,status:id==='C-fa'&&i===1?'COVERED':'UNRESOLVED',unitIds:id==='C-fa'&&i===0?[]:data.units.map((u:any)=>u.id)}))}]});
  }else throw Error('Extra stage not permitted');
  if(mode==='revoked-source'&&stage==='extraction')prepared.db.sql("UPDATE public.knowledge_sources SET status='disabled' WHERE business_id=77;");
  return {output_text:text,status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}as any;
 });
 const recipient=String(++serial);
 t.mock.method(globalThis,'fetch',async(input,options)=>{
  const url=new URL(String(input));assert.ok(['api.telegram.org','graph.facebook.com','graph.instagram.com'].includes(url.hostname),'No provider network');
  const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);
  if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';
  replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}],message_id:'offline'}));
 });
 b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),knowledgeSearch:async(id,q,limit)=>{tenant(id);const matches=await service.search(id,q,limit);return mode==='foreign-evidence'?matches.map(m=>({...m,businessId:88})):matches;},knowledgeSourceLanguages:id=>{tenant(id);return service.sourceLanguageHints(id);},completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),semanticKnowledgeSearchQueries:(id,q,limit,opts)=>{tenant(id);return service.semanticSearchQueries(id,q,limit,opts);},validateKnowledgeMatches:async(id,m)=>{tenant(id);return service.validateMatches(id,m,{strictSources:true,captureRevision:true,signal:nativeKnowledgeTiming()?.signal});},knowledgeServiceCatalog:async id=>{tenant(id);return incidentConfig.services;},knowledgeRetrievalDiagnostic:e=>metrics.push(e),evidenceFirstDiagnostic:e=>inputs.push({stage:'manifest',data:e}),evidenceFirstDecisionDiagnostic:e=>events.push(e),calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
 try{
  await incidentInbound(b,channel,question,recipient);assert.equal(actions,0);assert.ok(replies.length<=1);assert.equal(stages.filter(s=>s==='language').length,1);assert.equal(stages.filter(s=>s==='planning').length,0);
  const publication=[...events].reverse().find(e=>e.stage==='publication');
  results.push({id,channel,mode,stages,embeddings,optional,denied,metrics,replies,events,inputs,publication,actions});
  if(['optional-timeout','success','valid-only-control','candidate-control'].includes(mode)){
   assert.equal(publication?.route,'partial_manifest');assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(stages.filter(s=>s==='verification').length,1);
   const expectedFacts=id==='C-fa'?JSON.parse(f.state.calls.find((c:any)=>c.stage==='extraction').outputText).units.slice(1).map((u:any)=>u.text):documentaryStatements.B[language];
   for(const fact of expectedFacts)assert.ok(replies[0].includes(fact),'Every source-backed requested fact must survive rendering');
   if(id==='C-fa'){assert.match(replies[0],/هزینه پارکینگ Nordpark/u);assert.match(replies[0],/نمی‌توانم/u);assert.doesNotMatch(replies[0],/\d+\s*(?:SEK|EUR)/iu);}
   if(mode==='optional-timeout'){assert.equal(optional.length,1);assert.equal(metrics[0].retrievalOrigins.strictSemantic,0);assert.ok(metrics[0].retrievalOrigins.lexical>0);}
   if(mode==='candidate-control'){assert.equal(metrics[0].candidateEligible,true);assert.equal(metrics[0].retrievalOrigins.lexical,0);assert.equal(metrics[0].retrievalOrigins.strictSemantic,0);assert.ok(metrics[0].retrievalOrigins.candidate<=5&&metrics[0].retrievalOrigins.candidate>0);}
  }else{
   assert.ok(!['verified_manifest','partial_manifest'].includes(publication?.route));
   if(mode==='captured-parse-loss'){assert.ok(events.some(e=>e.reason==='INVALID_CITATION'));assert.equal(stages.filter(s=>s==='verification').length,1);}
   if(mode==='recovery-denied'){assert.deepEqual(denied,['source_language_recovery']);assert.equal(stages.filter(s=>s==='extraction').length,0);assert.equal(stages.filter(s=>s==='verification').length,0);assert.equal(metrics[0].matchCount,0);}
   if(mode==='parent-cancel'){assert.equal(optional.length,0);assert.ok(!stages.includes('extraction'));}
   if(mode==='revoked-source')assert.equal(stages.filter(s=>s==='verification').length,0,'Revoked evidence cannot reach verification/publication');
  }
 }finally{if(mode==='revoked-source')prepared.db.sql("UPDATE public.knowledge_sources SET status='ready' WHERE business_id=77;");b.reset();Object.assign(incidentConfig,old);delete process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY;}
}
for(const channel of incidentChannels)test(`native producer C-fa/${channel}: scripted two-fact response, full source and strict-v2 pipeline`,async t=>exercise(t,'C-fa',channel,'valid-only-control'));
test('native producer: original real invalid quote remains a safe failure',async t=>exercise(t,'C-fa','whatsapp','captured-parse-loss'));
test('native producer: foreign evidence remains excluded',async t=>exercise(t,'C-fa','whatsapp','foreign-evidence'));
test('native producer: source revoked after extraction cannot publish',async t=>exercise(t,'C-fa','whatsapp','revoked-source'));
