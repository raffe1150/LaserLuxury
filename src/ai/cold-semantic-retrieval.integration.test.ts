import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createClient} from '@supabase/supabase-js';
import {InMemoryKnowledgeStorage,SupabaseKnowledgeStorage,KnowledgeService,type KnowledgeSource,type KnowledgeSearchMatch} from '../../knowledge';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {mixedBusinesses,mixedQuestion} from '../../tests/fixtures/mixed-source-questions';
import {serviceFactText} from '../../tests/fixtures/direct-service-questions';
import {literalInformationFallback} from './knowledge-planning';

Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const before=process.env.ODINLINK_COLD_COMPARISON==='before';
const {priority1hUnifiedEngineTestBoundary:b}=await import(process.env.ODINLINK_COLD_BASELINE?'../../server.cold-before.ts':'../../server.ts');
const measurements:any[]=[];let serial=46703000000;
after(()=>{if(process.env.ODINLINK_COLD_MEASUREMENTS)writeFileSync(process.env.ODINLINK_COLD_MEASUREMENTS,JSON.stringify({phase:before?'before':'after',provider:'offline scripted generation and vectors; no external network',measurements},null,2));});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
type Business=typeof mixedBusinesses[number];
type Mode='cold'|'warm'|'unproved-cold'|'unproved-warm'|'slow-proof'|'slow-lexical'|'large'|'empty-lexical'|'empty-semantic'|'query-timeout'|'semantic-failure'|'corpus-failure'|'revoked'|'changed'|'foreign';
async function fixture(business:Business,kind:'memory'|'supabase',mode:Mode){
 const sources:KnowledgeSource[]=[{id:`guide-${business.id}`,businessId:business.id,type:'document',title:'visitor-guide',status:'ready',content:business.source,metadata:{segments:[{start:0,end:business.source.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'},
  {id:`limits-${business.id}`,businessId:business.id,type:'document',title:'loan-policy',status:'ready',content:business.id===88?JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8')).documents[1].text:'Loan tools require prior staff approval.',metadata:{segments:[]},createdAt:'2026',updatedAt:'2026'}];
 sources[1].metadata={segments:[{start:0,end:sources[1].content.length,section:'Text'}]};
 if(mode==='large')for(let i=0;i<4;i++)sources.push({...sources[0],id:'extra-'+i,content:'Unrelated source '+i,metadata:{segments:[{start:0,end:18,section:'Text'}]}});
 const memory=new InMemoryKnowledgeStorage();
 for(const s of sources){await memory.create(s);await memory.replaceChunks(s.businessId,s.id,[{chunkIndex:0,content:s.content,metadata:{source:'document',section:'Text'}}]);}
 const foreign='Foreign secret workshop inspection photo briefings.';await memory.create({...sources[0],id:'foreign',businessId:555,content:foreign,metadata:{segments:[{start:0,end:foreign.length,section:'Text'}]}});await memory.replaceChunks(555,'foreign',[{chunkIndex:0,content:foreign,metadata:{source:'document',section:'Text'}}]);
 const backend:any[]=[];
 const storage=kind==='memory'?memory:new SupabaseKnowledgeStorage(createClient('https://synthetic.invalid','synthetic-only',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input)),method=init?.method||'GET';backend.push({path:url.pathname,method,query:url.search});
  if(url.pathname==='/rest/v1/knowledge_sources'){
   assert.equal(method,'GET');if(url.searchParams.has('business_id'))assert.equal(url.searchParams.get('business_id'),`eq.${business.id}`);else assert.equal(url.searchParams.get('select'),'id');
   const data=(await memory.list(business.id)).map(s=>({id:s.id,business_id:s.businessId,type:s.type,title:s.title,status:s.status,content:s.content,metadata:s.metadata,created_at:s.createdAt,updated_at:s.updatedAt}));
   const limit=Number(url.searchParams.get('limit')||1000),headers={'Content-Type':'application/json','Content-Range':`0-${Math.max(0,Math.min(data.length,limit)-1)}/${data.length}`};
   return new Response(JSON.stringify(data.slice(0,limit)),{headers});
  }
  assert.equal(url.pathname,'/rest/v1/rpc/search_knowledge_chunks');assert.equal(method,'POST');const params=JSON.parse(String(init?.body));assert.equal(params.p_business_id,business.id);
  const matches=await memory.search(business.id,params.p_query,params.p_limit);
  return new Response(JSON.stringify(matches.map(m=>({source_id:m.sourceId,business_id:m.businessId,score:m.score,content:m.text,metadata:m.metadata}))),{headers:{'Content-Type':'application/json'}});
 }}}));
 let stopped=false;const embeddings:any[]=[];
 const vector=(axis:number)=>({provider:'openai',model:'synthetic-embedding',dimensions:2,version:1,values:axis?[0,1]:[1,0]});
 const provider={supportsLocalSemanticSearch:true,embedQuery:async()=>vector(0),embedDocuments:async(texts:string[],options?:any)=>{
  const query=texts[0]===mixedQuestion(business,'en'),entry:any={kind:query?'query':'corpus',texts:[...texts],aborted:false,startedAtMs:performance.now()};embeddings.push(entry);
  if(mode==='semantic-failure'&&query||mode==='corpus-failure'&&!query)throw Error('Synthetic optional semantic outage');
  await new Promise<void>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>;const abort=()=>{clearTimeout(timer);entry.aborted=true;stopped=true;reject(Object.assign(new Error('Synthetic embedding cancelled'),{name:'AbortError'}));};
   if(options?.signal?.aborted){abort();return;}options?.signal?.addEventListener('abort',abort,{once:true});
   if(mode==='query-timeout')return;
   timer=setTimeout(()=>{options?.signal?.removeEventListener('abort',abort);resolve();},query?20:40);
  }).finally(()=>{entry.durationMs=performance.now()-entry.startedAtMs;});
  return texts.map(()=>vector(mode==='empty-semantic'&&!query?1:0));
 }};
 const service=new KnowledgeService(storage,storage,provider,kind==='supabase');await service.initialize();
 return {sources,memory,service,backend,embeddings,stopped:()=>stopped,clear:()=>{embeddings.length=0;backend.length=0;},revoke:async(changed:boolean)=>{await memory.create({...sources[0],...(changed?{content:'The former policy has changed.',updatedAt:'2027'}:{status:'disabled' as const})});}};
}
const scenarios=mixedBusinesses.flatMap(business=>(['memory','supabase']as const).flatMap(kind=>incidentChannels.flatMap(channel=>(before?['cold']as const:['cold','warm']as const).map(mode=>({business,kind,channel,mode:mode as Mode})))));
if(!before)for(const business of mixedBusinesses)for(const kind of ['memory','supabase']as const)for(const mode of ['unproved-cold','unproved-warm','slow-proof','slow-lexical','large','empty-lexical','empty-semantic','query-timeout','semantic-failure','corpus-failure','revoked','changed','foreign']as const)scenarios.push({business,kind,channel:'whatsapp',mode});

for(const {business,kind,channel,mode}of scenarios)test(`cold semantic ${business.id}/${kind}/${channel}/${mode}`,async t=>{
 const config={...incidentConfig};b.reset();const recipient=String(++serial),question=mixedQuestion(business,'en'),stages:string[]=[],replies:string[]=[],events:any[]=[],queries:string[]=[],verifierInputs:any[]=[];let actions=0,retrieval:any,proofs=0;
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 const f=await fixture(business,kind,mode),preparation:any[]=[];
 if(mode==='warm'||mode==='unproved-warm'){await f.service.semanticSearchQueries(business.id,[question]);preparation.push(...f.embeddings);f.clear();}
 const forbidden=async()=>{actions++;throw Error('Read-only information cannot operate bookings');};const started=performance.now();
 try{
  Object.assign(incidentConfig,{id:business.id,businessId:business.id,businessName:business.name,services:[business.service],language:'en'});
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),knowledgeRetrievalDiagnostic:e=>{retrieval=e;},evidenceFirstDecisionDiagnostic:e=>events.push(e),
   knowledgeSearch:async(id,q,limit)=>{assert.equal(id,business.id);assert.equal(q,question);queries.push(q);if(mode==='slow-lexical')await pause(150);if(mode==='empty-lexical')return[];const rows=await f.service.search(id,q,limit);return mode==='foreign'?rows.map(row=>({...row,businessId:555})):rows;},
   knowledgeSourceLanguages:id=>f.service.sourceLanguageHints(id),semanticKnowledgeSearchQueries:(id,q,limit,options)=>f.service.semanticSearchQueries(id,q,limit,options),
   ...(!mode.startsWith('unproved-')?{completeKnowledgeCorpus:async(id:number,matches:KnowledgeSearchMatch[])=>{proofs++;if(mode==='slow-proof')await pause(150);if(['empty-semantic','query-timeout','semantic-failure','corpus-failure'].includes(mode))return null;return f.service.completeSmallCorpus(id,matches);}}:{}),
   knowledgeServiceCatalog:async id=>{assert.equal(id,business.id);return [business.service];},validateKnowledgeMatches:(id,matches)=>f.service.validateMatches(id,matches,{strictSources:true,captureRevision:true}),
   geminiGenerate:async p=>{
    if(f.stopped())throw Error('Synthetic first-failure gate latch');
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:'{"language":"en","requestedReplyLanguage":null,"confidence":0.99}'};}
    const data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('retrieval query planner')){stages.push('planning');return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');assert.equal(data.authorityScope,'document_only');assert.ok(data.evidence.every((e:any)=>e.businessId===business.id&&e.id!=='configured-services'));
     const e=data.evidence.find((e:any)=>e.text===business.source);assert.ok(e);const sentences=business.source.match(/[^.]+\./gu)!;
     if(mode==='revoked'||mode==='changed')await f.revoke(mode==='changed');
     return{text:JSON.stringify({units:sentences.map((quote,i)=>({facetIds:['f1'],subject:i===3?'Visitors':business.subject,predicate:['purpose','replacement','assessment limit','conditional advice'][i],value:quote.trim(),scope:'documentary offering only',modality:i===3?'recommended':'descriptive',negation:i===1||i===2,qualifiers:[],language:'en',text:quote.trim(),evidenceRefs:[{evidenceId:e.id,exactQuote:quote.trim()}]}))})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');verifierInputs.push(data);assert.equal(data.question,question);assert.equal(data.facets[0].obligations[0].description,question);assert.ok(data.evidence.every((e:any)=>e.businessId===business.id));
     const cat=data.evidence.find((e:any)=>e.id==='configured-services');assert.ok(cat);assert.equal(JSON.parse(cat.text).services[0].name,business.service.name);
     assert.equal(data.units[0].text,serviceFactText.en(business.service.name,business.service.price,business.service.currency,business.service.durationMinutes,2));
     if(mode==='revoked'||mode==='changed')assert.ok(data.units.every((u:any)=>u.evidenceRefs.every((ref:any)=>ref.evidenceId==='configured-services')));
     for(const unit of data.units)for(const ref of unit.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===ref.evidenceId)?.text.includes(ref.exactQuote));
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
    }
    stages.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question,recipient);
  const complete=['cold','warm','revoked','changed'].includes(mode),stopped=before||mode==='query-timeout';
  measurements.push({businessId:business.id,kind,channel,mode,question,preparation,foregroundEmbeddings:f.embeddings.map(e=>({...e,startedAfterTurnMs:e.startedAtMs-started})),stages,replies,proofs,queries,retrieval,verifierInputs,events,backend:f.backend,actions,wallMs:performance.now()-started,expectedGatePass:!stopped});
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(stages.includes('planning'),false);assert.equal(retrieval.completeCorpusUsed,complete);
  if(stopped){assert.equal(f.stopped(),true);assert.equal(stages.includes('verification'),false);assert.deepEqual(replies,['I cannot verify that part right now.']);assert.ok(f.embeddings.some(e=>e.aborted));}
  else{
   assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(stages.filter(s=>s==='verification').length,1);assert.ok(replies[0].includes(serviceFactText.en(business.service.name,business.service.price,business.service.currency,business.service.durationMinutes,2)));
   if(mode==='revoked'||mode==='changed')assert.doesNotMatch(replies[0],/initial orientation|automatically replace|Visitors should/);
   else assert.ok(replies[0].includes(business.source),'Source restrictions and conditional advice remain intact');
   assert.ok(events.some(e=>e.stage==='publication'&&e.route==='partial_manifest'),'A complete retrieval corpus never grants service applicability or question coverage');
   if(mode==='slow-lexical')assert.ok(f.embeddings[0].startedAtMs-started<145,'Semantic startup must not wait for the 150ms lexical read');
   if(complete)assert.equal(f.embeddings.length,0,'Proven complete evidence must not start any embedding work');
   else assert.equal(f.embeddings.length,mode==='unproved-warm'||mode==='semantic-failure'?1:2);
  }
  if(kind==='supabase'&&complete)assert.ok(f.backend.some(c=>c.method==='GET'&&c.query.includes('limit=5')),'Use the actual bounded exact-count inventory contract');
  assert.ok(f.embeddings.every(e=>!JSON.stringify(e.texts).includes('Foreign secret')));
 }finally{Object.assign(incidentConfig,config);b.reset();}
});
