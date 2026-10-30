import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Responses} from 'openai/resources/responses';
import {KnowledgeService,SupabaseKnowledgeStorage} from '../../knowledge';
import {DisposableSourceIndexDatabase,indexSqlLiteral as lit} from '../../tests/helpers/disposable-source-index-db';
import {SourceIndexCoordinator,SupabaseSourceIndexRepository} from '../knowledge/documents/indexing';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from '../knowledge/embedding-backfill';

import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {preliminaryAcceptancePlan,documentaryQuotes,documentaryStatements,type AcceptanceFamily} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {serviceFactText} from '../../tests/fixtures/direct-service-questions';
import {serviceScopeUncertainty} from './source-aware-service-proposal';
import {wholeQuestionInformationPlan} from './knowledge-planning';
import {getAiProviderAdapter} from './providers/router';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const solTrial=process.env.ODINLINK_TEST_SOL_VERIFICATION==='true';
if(solTrial||process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY==='candidate-top5-v1')Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-offline-only'});
delete process.env.ODINLINK_SHARED_PG;
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const pg=new DisposableSourceIndexDatabase(['20261024161901_persistent_knowledge_search_snapshot.sql']);
const witnessProtocol=process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL==='coverage-witness-v1';
const candidateTrial=process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY==='candidate-top5-v1';
const storage=new SupabaseKnowledgeStorage(pg.client),records:any[]=[],sourceBindings:any[]=[],embeddingCalls:string[][]=[],indexingCalls:string[][]=[];
const v={...identity,values:Array.from({length:768},(_,i)=>i===0?1:0)};
const coordinator=new SourceIndexCoordinator(new SupabaseSourceIndexRepository(pg.client),{embedDocuments:async texts=>{indexingCalls.push(texts);return texts.map(()=>structuredClone(v));}},identity,
 {allowedBusinessIds:[77],maxSources:2,maxRequests:2,maxInputChars:200000,maxInputBytes:800000});
const gate=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/prepared-gate-final.json','utf8'));
const pdf=JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8'));
try {
 for(const [i,s] of gate.sources.entries()){
  const id=randomUUID();sourceBindings.push({alias:s.id,databaseId:id,businessId:77,title:s.title,contentSha256:createHash('sha256').update(s.content).digest('hex')});pg.sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES(${lit(id)},77,'document',${lit(s.title)},'ready',${lit(s.content)},${lit(s.metadata)});
    SELECT public.replace_knowledge_chunks(77,${lit(id)},${lit(i===0?pdf.chunks:[{chunk_index:0,content:s.content,metadata:{source:'document',section:'Text'}}])});`);
  assert.equal((await coordinator.indexSource({businessId:77,sourceId:id})).status,'ready');
 }
 assert.deepEqual(indexingCalls.map(c=>c.length),[5,1]);
} catch(error){coordinator.stop();pg.close();throw error;}
after(()=>{coordinator.stop();pg.close();if(process.env.ODINLINK_PERSISTENT_NATIVE_RESULTS)writeFileSync(process.env.ODINLINK_PERSISTENT_NATIVE_RESULTS,JSON.stringify({provider:'scripted generation, synthetic vectors, actual PostgreSQL, intercepted sends',realProviderRequests:0,sourceBindings,indexingCalls:indexingCalls.map(c=>c.length),queryEmbeddingCalls:embeddingCalls,records},null,2),{flag:'wx'});});
const normalizeBoundary=(s:string)=>s.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
let serial=46707000000;
for(const prepared of preliminaryAcceptancePlan)for(const channel of incidentChannels){const spec={...prepared,channel};test(`persistent native ${spec.id}/${spec.channel}`,async t=>{
 // Preserve the existing guarded Persian reference contract. A separate
 // six-language conditional matrix exercises eligible candidate turns.
 const forceCandidate=candidateTrial&&spec.family==='A'&&!!wholeQuestionInformationPlan(normalizeBoundary(spec.question),true,false,gate.catalog);
 let generate: (p:any)=>Promise<any>;
 const original={...incidentConfig};b.reset();const recipient=String(++serial),stages:string[]=[],inputs:any[]=[],events:any[]=[],replies:string[]=[],lookups:any[]=[];let actions=0,unhandled:any;
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 // Equal synthetic query vectors test transport/isolation; they do not prove linguistic recall.
 const before=embeddingCalls.length;
 const service=new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>structuredClone(v),embedDocuments:async texts=>{
   assert.ok(texts.length<=3&&normalizeBoundary(texts[0])===normalizeBoundary(spec.question),'Only bounded customer queries may be embedded');
   embeddingCalls.push([...texts]);return texts.map(()=>forceCandidate?{...v,values:Array.from({length:768},(_,i)=>i===0?.2:i===1?Math.sqrt(.96):0)}:structuredClone(v));
 }});
 const forbidden=async()=>{actions++;throw Error('Unauthorized booking/calendar/notification action');};
 const start=performance.now();
 try{
  // Keep the business locale Swedish. Only the classifier's current-message
  // language judgment selects the expected customer language in this rehearsal.
  incidentConfig.language='sv';incidentConfig.services=structuredClone(gate.catalog);
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(id,q,limit)=>{assert.equal(id,77);const matches=await service.search(id,q,limit);lookups.push({id,q,matches});return forceCandidate?[]:matches;},
   knowledgeRetrievalDiagnostic:diagnostic=>inputs.push({stage:'retrieval_diagnostic',data:diagnostic}),
   knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),
   semanticKnowledgeSearchQueries:(id,q,limit,options)=>service.semanticSearchQueries(id,q,limit,options),
   validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m,{strictSources:true,captureRevision:true}),knowledgeServiceCatalog:async id=>{assert.equal(id,77);return incidentConfig.services;},
   evidenceFirstDiagnostic:e=>inputs.push({stage:'manifest',data:e}),evidenceFirstDecisionDiagnostic:e=>events.push(e),
   geminiGenerate:generate=async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:JSON.stringify({language:spec.language,requestedReplyLanguage:null,confidence:.99})};}
    if(!/retrieval query planner|UNIT EXTRACTION|BATCH ENTAILMENT|VERIFIED-UNIT PRESENTATION/u.test(instruction)){
     unhandled={instruction,contents:p.contents};throw Error('Preparation requires reviewed independent evidence-first execution, not an unsupported scripted legacy response');
    }
    const data=JSON.parse(p.contents[0].parts[0].text);inputs.push({instruction,data});
    if(instruction.includes('retrieval query planner')){stages.push('planning');return{text:JSON.stringify({canonicalMeaning:data.question,queries:[data.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'customer information request',attribute:data.question,questionType:'description',obligations:[{description:data.question,questionType:'description'}]}]})};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');assert.ok(data.evidence.every((e:any)=>e.businessId===77&&e.sourceId!=='configured-services:77'));
     return{text:JSON.stringify({units:documentaryStatements[spec.family][spec.language].map((text,i)=>{
      const quote=documentaryQuotes[spec.family][i],e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e,`Missing exact quote: ${spec.id}/${i}`);
      return{facetIds:['f1'],subject:spec.family==='B'?'Digital information calls':'AdMotion Studio visitor policy',predicate:`document fact ${i+1}`,value:text,
       scope:spec.family==='B'?'documentary offering only':'documented visitor conditions',modality:spec.family==='A'?(i===0?'required':i===1?'recommended':i===3?'prohibited':'permitted'):'descriptive',negation:spec.family==='C'||spec.family==='B'&&i>1||spec.family==='A'&&i===3,
       qualifiers:[],language:spec.language,text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};
     })})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');assert.equal(normalizeBoundary(data.question),normalizeBoundary(spec.question));assert.equal(data.requestedLanguage,spec.language);
     assert.ok(data.evidence.every((e:any)=>e.businessId===77));
     if(spec.id==='C-fa')assert.deepEqual(data.facets[0].obligations.map((o:any)=>o.description),normalizeBoundary(spec.question).split(/(?<=[?؟])\s+/u));
     for(const u of data.units)for(const r of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===r.evidenceId);assert.ok(e?.text.includes(r.exactQuote));}
     if(spec.family==='B'){assert.equal(data.units[0].text,serviceFactText[spec.language]('Video Consultation',300,'SEK',60,2));const catalog=data.evidence.find((e:any)=>e.id==='configured-services');assert.ok(catalog);assert.equal(JSON.parse(catalog.text).services[0].name,'Video Consultation');}
     const verdict:any={decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:spec.family==='A',incompletenessReason:spec.family==='A'?'NONE':'MISSING_RELEVANT_FACT',materialUnitIds:data.units.map((u:any)=>u.id),obligations:data.facets[0].obligations.map((o:any,i:number)=>({obligationId:o.id,status:spec.family==='A'||spec.family==='C'&&data.facets[0].obligations.length===2&&i===1?'COVERED':'UNRESOLVED',unitIds:spec.family==='C'&&data.facets[0].obligations.length===2&&i===0?[]:data.units.map((u:any)=>u.id)}))}]};
     if(witnessProtocol){
      assert.match(instruction,/Coverage witness v1/u);
      // Scripted diagnostic witnesses, not new real-verifier explanations.
      // Copy from the exact retained verifier input, not the pre-adapter
      // fixture: existing native punctuation/ZWNJ normalization is unchanged.
      const clauses=data.question.split(/(?<=[?؟])\s+/u);
      const quote=clauses[spec.family==='B'?1:0];
      verdict.coverageWitnesses=verdict.coverage.flatMap((c:any)=>c.obligations.filter((o:any)=>o.status==='UNRESOLVED')
       .map((o:any)=>({facetId:c.facetId,obligationId:o.obligationId,reason:c.incompletenessReason,location:{kind:'QUESTION_SPAN',quote}})));
     }else assert.doesNotMatch(instruction,/Coverage witness v1/u);
     return{text:JSON.stringify(verdict)};
    }
    stages.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  if(solTrial){
   const adapter=getAiProviderAdapter('openai')!,originalGenerate=adapter.generate!.bind(adapter);
   t.mock.method(adapter,'generate',r=>originalGenerate(r.structuredOutput?.name==='odinlink_knowledge_verification_v2'?{...r,model:'gpt-6.1-sol',reasoningEffort:'low'}:r));
  }
  if(candidateTrial||solTrial)t.mock.method(Responses.prototype,'create',async(p:any)=>{
   if(solTrial&&p.instructions.includes('BATCH ENTAILMENT')){assert.equal(p.model,'gpt-6.1-sol');assert.deepEqual(p.reasoning,{effort:'low'});assert.equal(p.text.format.name,'odinlink_knowledge_verification_v2');assert.equal(p.text.format.strict,true);}
   return{output_text:(await generate({config:{systemInstruction:p.instructions},contents:[{parts:[{text:p.input[0].content}]}]})).text,status:'completed',output:[],usage:{input_tokens:10,output_tokens:10}}as any;
  });
  await incidentInbound(b,spec.channel,spec.question,recipient);
  records.push({spec,stages,inputs,events,replies,lookups,unhandled,actions,wallMs:performance.now()-start});
  assert.equal(embeddingCalls.length-before,1,'One customer query batch, zero corpus embeddings');
  assert.equal(indexingCalls.length,2,'No customer turn re-indexed the corpus');
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(stages.filter(s=>s==='extraction').length,1,'Every preliminary case must reach real-path independent evidence extraction');
  if(['B-de','C-fa','B-ar','A-es','A-en','A-sv'].includes(spec.id))assert.equal(stages.filter(s=>s==='planning').length,0,'Reviewed direct admission must not call the preliminary Planner');
  assert.equal(stages.filter(s=>s==='verification').length,1,'Scripted legacy output is not semantic acceptance');
  if(forceCandidate){
   const d=inputs.find(e=>e.stage==='retrieval_diagnostic')?.data;
   assert.equal(d?.candidateEligible,true);assert.equal(d.retrievalOrigins.lexical,0);assert.equal(d.retrievalOrigins.strictSemantic,0);
   assert.ok(d.retrievalOrigins.candidate>0&&d.retrievalOrigins.candidate<=5);assert.equal(stages.filter(s=>s==='planning').length,0);
  }
  for(const text of documentaryStatements[spec.family][spec.language])assert.ok(replies[0].includes(text),`Missing requested proposition: ${text}`);
  const publication=[...events].reverse().find(e=>e.stage==='publication');assert.equal(publication?.route,spec.family==='A'?'verified_manifest':'partial_manifest');
  if(witnessProtocol){const w=events.find(e=>e.coverageWitness);assert.equal(w?.coverageWitness.state,'VALID');assert.ok(w.coverageWitness.claimedMissing.every((c:any)=>c.semanticTruth==='UNCONFIRMED_MODEL_CLAIM'));assert.ok(!JSON.stringify(w.coverageWitness).includes('quote'));}
  if(spec.family==='B')assert.ok(replies[0].includes(serviceScopeUncertainty('Video Consultation',spec.language)!));
  if(spec.family==='C'){
   assert.doesNotMatch(replies[0],/\d+\s*(?:SEK|EUR)|\b(?:per hour|pro Stunde)\b/iu);
   if(process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY==='accuracy-first-v1'){
    const labels:Record<string,string>={en:"Nordpark's parking fee",sv:'parkeringsavgiften i Nordpark',de:'die Parkgebühr für Nordpark',es:'la tarifa del aparcamiento Nordpark',fa:'هزینه پارکینگ Nordpark',ar:'رسوم موقف Nordpark'};
    const uncertainty:Record<string,RegExp>={en:/cannot verify/u,sv:/inte verifiera/u,de:/nicht verifizieren/u,es:/No puedo verificar/u,fa:/نمی‌توانم/u,ar:/لا أستطيع التحقق/u};
    const notice=replies[0].split('\n\n')[1];assert.ok(notice?.includes(labels[spec.language]),'Missing attribute must be named explicitly');assert.match(notice,uncertainty[spec.language]);
   }
  }
 }finally{Object.assign(incidentConfig,original);b.reset();}
});

}
