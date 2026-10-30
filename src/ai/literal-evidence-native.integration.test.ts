/** Actual native adapters, saved genuine document/query vectors and disposable
 * PostgreSQL. SDK generations are SCRIPTED and never model acceptance. */
import test,{after,type TestContext}from'node:test';import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';
import{Responses}from'openai/resources/responses';import{KnowledgeService}from'../../knowledge';
import{prepareDatabase}from'../../docs/validation/shared-core-2026-10-22/semantic-only-nibble-diagnostic-20261025/diagnostic';
import{incidentFlags,incidentConfig,incidentInbound,incidentChannels,interceptedIncidentSend}from'../../tests/helpers/p0-incident-knowledge';
import{nativeKnowledgeTiming}from'./knowledge-timing-policy';import{getAiProviderAdapter}from'./providers/router';
import{OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity}from'../knowledge/embedding-backfill';import{documentaryQuotes,documentaryStatements}from'../../tests/fixtures/multilingual-knowledge-acceptance';
const base='docs/validation/shared-core-2026-10-22',read=(p:string)=>JSON.parse(readFileSync(`${base}/${p}`,'utf8'));
incidentFlags();Object.assign(process.env,{OPENAI_API_KEY:'synthetic-offline-only',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'v2'});delete process.env.ODINLINK_SHARED_PG;
const network=globalThis.fetch;let unexpectedNetwork=0;globalThis.fetch=async()=>{unexpectedNetwork++;throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const preparation:any={},pg=await prepareDatabase(preparation),records:any[]=[];
const{priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
after(()=>{pg.close();globalThis.fetch=network;assert.equal(unexpectedNetwork,0);if(process.env.ODINLINK_LITERAL_NATIVE_RESULTS)writeFileSync(process.env.ODINLINK_LITERAL_NATIVE_RESULTS,JSON.stringify({mode:'SCRIPTED_SDK_RESPONSES_ACTUAL_NATIVE_ACTUAL_PG_SAVED_GENUINE_VECTORS',providerCalls:0,preparation,records},null,2),{flag:'wx'});});
let serial=46909000000;
async function exercise(t:TestContext,channel:typeof incidentChannels[number],id:'C-fa'|'B-ar',protocol:'v2'|'literal-evidence-v1',fault?:'unknown-id'|'revoked'){
 const saved=read(`native-four-language-revalidation-20261027/${id}/result.json`),question=saved.spec.question,language=saved.spec.language,proposal=id==='C-fa'?JSON.parse(saved.state.calls.find((c:any)=>c.stage==='extraction').outputText):null;
 const query=saved.state.calls.find((c:any)=>c.stage==='embedding').rawProviderResponse.data[0].embedding;
 const old=structuredClone(incidentConfig);b.reset();incidentConfig.language='sv';incidentConfig.services=structuredClone(read('multilingual-acceptance-preparation-20261024/prepared-gate-final.json').catalog);
 process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL=protocol;if(id==='B-ar')process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY='candidate-top5-v1';else delete process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY;
 const stages:string[]=[],events:any[]=[],wires:any[]=[],replies:string[]=[],retrieval:any[]=[];let embeds=0,actions=0;
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 const tenant=(id:number)=>assert.equal(id,77),forbidden=async()=>{actions++;throw Error('Forbidden side effect');};
 const service=new KnowledgeService(pg.storage,pg.storage,{supportsLocalSemanticSearch:true,embedDocuments:async(texts,opts)=>{opts?.signal?.throwIfAborted();assert.equal(texts.length,1);assert.equal(++embeds,1);return[{...identity,values:query}];},embedQuery:async()=>{throw Error('Unexpected second embedding path');}},true);
 const adapter=getAiProviderAdapter('openai')!,original=adapter.generate!.bind(adapter);t.mock.method(adapter,'generate',r=>original(r.structuredOutput?.name==='odinlink_knowledge_verification_v2'?{...r,model:'gpt-6.1-sol',reasoningEffort:'low'}:r));
 t.mock.method(Responses.prototype,'create',async(p:any)=>{
  const data=p.input?.[0]?.content?JSON.parse(p.input[0].content):null;let output:string,stage:string;
  if(p.instructions.includes('language-routing classifier')){stage='language';output=JSON.stringify({language,requestedReplyLanguage:null,confidence:.99});}
  else if(p.instructions.includes('UNIT EXTRACTION')){
   stage='extraction';const literal=protocol==='literal-evidence-v1';assert.equal(p.text.format.name,literal?'odinlink_knowledge_extraction_literal_v1':'odinlink_knowledge_extraction_v2');assert.equal(p.instructions.includes('literal-evidence-v1'),literal);assert.equal(p.text.format.strict,true);
   const refs=p.text.format.schema.properties.units.items.properties.evidenceRefs.items.properties;assert.deepEqual(Object.keys(refs),literal?['evidenceId']:['evidenceId','exactQuote']);
   const raw=proposal?structuredClone(proposal):{units:documentaryStatements.B.ar.map((text,i)=>{const e=data.evidence.find((e:any)=>e.text.includes(documentaryQuotes.B[i]));assert.ok(e);return{facetIds:['f1'],subject:'Digital information calls',predicate:`fact ${i}`,value:text,scope:'documentary offering only',modality:'descriptive',negation:i>1,qualifiers:[],language,text,evidenceRefs:[{evidenceId:e.id,exactQuote:documentaryQuotes.B[i]}]};})};
   if(literal)for(const u of raw.units)u.evidenceRefs=u.evidenceRefs.map((r:any)=>({evidenceId:r.evidenceId}));
   if(fault==='unknown-id')raw.units[0].evidenceRefs[0].evidenceId='e99';
   if(fault==='revoked')pg.db.sql("UPDATE public.knowledge_sources SET status='disabled' WHERE business_id=77;");
   output=JSON.stringify(raw);process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL='v2'; // Captured request decision must survive.
  }else if(p.instructions.includes('BATCH ENTAILMENT')){
   stage='verification';assert.equal(p.model,'gpt-6.1-sol');assert.deepEqual(p.reasoning,{effort:'low'});assert.equal(p.text.format.name,'odinlink_knowledge_verification_v2');assert.equal(p.text.format.strict,true);
   for(const u of data.units)for(const ref of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===ref.evidenceId);assert.equal(e.businessId,77);assert.ok(e.text.includes(ref.exactQuote));if(protocol==='literal-evidence-v1'&&ref.evidenceId!=='configured-services')assert.equal(ref.exactQuote,e.text);}
   if(id==='C-fa'&&protocol==='literal-evidence-v1')assert.equal(data.units.length,3,'No original material proposal may be lost');
   output=JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:!(id==='C-fa'&&u.id==='u1'),languageCorrect:true,negativeAbsence:id==='C-fa'&&u.id!=='u1',explicitAbsenceEvidence:id==='C-fa'&&u.id!=='u1'})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:data.units.filter((u:any)=>!(id==='C-fa'&&u.id==='u1')).map((u:any)=>u.id),obligations:data.facets[0].obligations.map((o:any,i:number)=>({obligationId:o.id,status:id==='C-fa'&&i===1?'COVERED':'UNRESOLVED',unitIds:id==='C-fa'&&i===0?[]:data.units.filter((u:any)=>!(id==='C-fa'&&u.id==='u1')).map((u:any)=>u.id)}))}]});
  }else throw Error('No Planner, recovery or optional model allowed');
  stages.push(stage);wires.push({stage,model:p.model,inputBytes:Buffer.byteLength(JSON.stringify(p)),request:p,responseBytes:Buffer.byteLength(output)});
  return{output_text:output,status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}as any;
 });
 const recipient=String(++serial);t.mock.method(globalThis,'fetch',async(input,opts)=>{const u=new URL(String(input));assert.ok(['api.telegram.org','graph.facebook.com','graph.instagram.com'].includes(u.hostname));const body=JSON.parse(String(opts?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...opts,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}],message_id:'offline'}));});
 b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),knowledgeSearch:async(id,q,l)=>{tenant(id);return service.search(id,q,l);},knowledgeSourceLanguages:id=>{tenant(id);return service.sourceLanguageHints(id);},completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),semanticKnowledgeSearchQueries:(id,q,l,opts)=>{tenant(id);return service.semanticSearchQueries(id,q,l,opts);},validateKnowledgeMatches:async(id,m)=>{tenant(id);return service.validateMatches(id,m,{strictSources:true,captureRevision:true,signal:nativeKnowledgeTiming()?.signal});},knowledgeServiceCatalog:async id=>{tenant(id);return incidentConfig.services;},knowledgeRetrievalDiagnostic:e=>retrieval.push(e),evidenceFirstDecisionDiagnostic:e=>events.push(e),calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
 try{await incidentInbound(b,channel,question,recipient);const publication=[...events].reverse().find(e=>e.stage==='publication');records.push({id,channel,protocol,fault,stages,wires,events,retrieval,replies,publication,actions,embeds});assert.equal(actions,0);assert.equal(embeds,1);assert.equal(stages.filter(s=>s==='extraction').length,1);assert.ok(stages.filter(s=>s==='verification').length<=1);assert.equal(replies.length,1);
  if(fault){assert.ok(!['verified_manifest','partial_manifest'].includes(publication?.route),'Invalid source/ref cannot acquire publication permission');assert.ok(!replies[0].includes('300 SEK'));}
  else if(protocol==='literal-evidence-v1'){assert.ok(!events.some(e=>e.reason==='INVALID_CITATION'),'Model quotation rewriting is removed');assert.equal(publication?.route,'partial_manifest','Supported facts must still reach a correctly qualified answer');assert.equal(stages.filter(s=>s==='verification').length,1);if(id==='C-fa'){assert.match(replies[0],/هزینه پارکینگ Nordpark/u);assert.match(replies[0],/پارکینگ رایگان ارائه نمی‌کند/u);}else{assert.match(replies[0],/300 SEK/);assert.match(replies[0],/60/);}}
  else{assert.ok(events.some(e=>e.reason==='INVALID_CITATION'));assert.ok(!['verified_manifest','partial_manifest'].includes(publication?.route));}
 }finally{if(fault==='revoked')pg.db.sql("UPDATE public.knowledge_sources SET status='ready' WHERE business_id=77;");b.reset();Object.assign(incidentConfig,old);delete process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL;delete process.env.ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY;}
}
for(const channel of incidentChannels)test(`literal C-fa native ${channel}: exact OCR source and qualified PARTIAL required`,async t=>exercise(t,channel,'C-fa','literal-evidence-v1'));
test('C-fa v2 original invalid quote still fails closed',async t=>exercise(t,'whatsapp','C-fa','v2'));
test('B-ar existing candidate/catalog path remains native qualified PARTIAL with literal refs',async t=>exercise(t,'instagram','B-ar','literal-evidence-v1'));

test('literal native unknown documentary reference cannot survive as a catalog-only PARTIAL escape',async t=>exercise(t,'instagram','B-ar','literal-evidence-v1','unknown-id'));
test('literal native source revoked during extraction cannot publish facts',async t=>exercise(t,'instagram','B-ar','literal-evidence-v1','revoked'));
