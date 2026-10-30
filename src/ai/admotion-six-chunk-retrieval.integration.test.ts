import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createClient} from '@supabase/supabase-js';
import {KnowledgeService,SupabaseKnowledgeStorage,InMemoryKnowledgeStorage,type KnowledgeSource} from '../../knowledge';
import type {EmbeddingVector,EmbeddingRequestOptions} from './embeddings';
import {CompatibleSemanticIndex} from '../knowledge/semantic-index';
import {PERSISTENT_SEARCH_RPC} from '../knowledge/persistent-search';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {literalInformationFallback} from './knowledge-planning';
import {answerEvidence,buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets} from './business-information-answer-plan';

// No real SDK, credential, production database or non-intercepted transport.
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_SHARED_PG:'true',
 ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',
 ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
// Existing helper loads the unmodified production extraction and TXT, and runs
// the repository lexical RPC in a disposable TCP-disabled PostgreSQL cluster.
const canonical=await sharedCorpus(false,true),sources=await canonical.storage.list(77);
const raw=JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8'));
const canonicalTexts=new Set([...raw.chunks.map((c:any)=>c.content),sources.find(s=>s.id==='incident-txt')!.content]);
const results:any[]=[];
after(()=>{canonical.cleanup();if(process.env.ODINLINK_ADMOTION_RESULTS)writeFileSync(process.env.ODINLINK_ADMOTION_RESULTS,JSON.stringify({kind:'Synthetic vectors and scripted extraction/verification; actual service, Supabase adapter, disposable lexical SQL and native inbound paths. Zero external requests.',sourceHashes:sources.map(s=>({id:s.id,businessId:s.businessId,sha256:createHash('sha256').update(JSON.stringify(s)).digest('hex')})),results},null,2),{flag:'wx'});});
type Mode='normal'|'empty'|'query-failure'|'search-failure'|'query-timeout'|'search-timeout';
const vector=(axis=0,model='text-embedding-3-small',provider='openai',version=1,dimensions=768):EmbeddingVector=>({provider,model,version,dimensions,values:Array.from({length:dimensions},(_,i)=>i===axis?1:0)});
async function fixture(mode:Mode='normal'){
 const memory=new InMemoryKnowledgeStorage();for(const s of sources)await memory.create(structuredClone(s));
 const calls:any[]=[],backend:any[]=[];let model='text-embedding-3-small';
 // Explicit local off-request completion; no customer fixture may rebuild vectors.
 for(const source of sources){
  const chunks=source.id==='incident-pdf'?raw.chunks:[{chunk_index:0,content:source.content,metadata:{source:'document',section:'Text'}}];
  await memory.replaceChunks(77,source.id,chunks.map((c:any)=>({chunkIndex:c.chunk_index,content:c.content,metadata:c.metadata})));
  memory.completeSemanticIndex(77,source.id,memory.indexSnapshot(77,source.id)!,chunks.map(()=>vector()));
 }
 const storage=new SupabaseKnowledgeStorage(createClient('https://synthetic.invalid','synthetic-offline-only',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input)),method=init?.method||'GET';assert.equal(url.hostname,'synthetic.invalid');backend.push({path:url.pathname,query:url.search,method});
  if(url.pathname==='/rest/v1/knowledge_sources'){
   assert.equal(method,'GET');const tenant=url.searchParams.get('business_id');if(!tenant)assert.equal(url.searchParams.get('select'),'id');
   const rows=(await memory.list(tenant?Number(tenant.slice(3)):77)).map(s=>({id:s.id,business_id:s.businessId,type:s.type,title:s.title,status:s.status,content:s.content,metadata:s.metadata,created_at:s.createdAt,updated_at:s.updatedAt}));
   const limit=Number(url.searchParams.get('limit')||1000);return new Response(JSON.stringify(rows.slice(0,limit)),{headers:{'Content-Type':'application/json','Content-Range':`0-${Math.max(0,Math.min(rows.length,limit)-1)}/${rows.length}`}});
  }
  if(url.pathname==='/rest/v1/rpc/'+PERSISTENT_SEARCH_RPC){
   const p=JSON.parse(String(init?.body));const record=backend.at(-1);
   if(mode==='search-failure')throw Error('Synthetic persisted-search outage');
   if(mode==='search-timeout')return new Promise<Response>((_resolve,reject)=>{const abort=()=>{record.aborted=true;reject(new Error('Synthetic persisted-search abort'));};if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});});
   const result=await memory.persistentSemanticSearch({businessId:p.p_business_id,embeddings:p.p_queries.map((values:number[])=>({provider:p.p_identity.provider,model:p.p_identity.model,dimensions:768,version:1,values})),limit:p.p_limit,minSimilarity:p.p_min_similarity,excludedChunks:p.p_excluded_chunks});
   if(mode==='empty')result.matches=result.matches.map(()=>[]);
   return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
  }
  assert.equal(url.pathname,'/rest/v1/rpc/search_knowledge_chunks');assert.equal(method,'POST');const p=JSON.parse(String(init?.body));assert.equal(p.p_business_id,77);
  const matches=await canonical.storage.search(77,p.p_query,p.p_limit);
  return new Response(JSON.stringify(matches.map(m=>({source_id:m.sourceId,business_id:m.businessId,score:m.score,content:m.text,metadata:m.metadata}))),{headers:{'Content-Type':'application/json'}});
 }}}));
 const provider={supportsLocalSemanticSearch:true,embedQuery:async()=>vector(),embedDocuments:async(texts:string[],options?:EmbeddingRequestOptions)=>{
  assert.ok(texts.length<=3&&texts.every(text=>!canonicalTexts.has(text)),'Customer requests may embed only bounded queries');
  const kind='query',call:any={kind,texts:[...texts],model,aborted:false,start:performance.now()};calls.push(call);
  try{
   if(mode===`${kind}-failure`)throw Error('Synthetic embedding outage');
   await new Promise<void>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const abort=()=>{if(timer)clearTimeout(timer);call.aborted=true;reject(Object.assign(new Error('Synthetic embedding abort'),{name:'AbortError'}));};
    if(options?.signal?.aborted){abort();return;}options?.signal?.addEventListener('abort',abort,{once:true});
    if(mode===`${kind}-timeout`)return;
    timer=setTimeout(()=>{options?.signal?.removeEventListener('abort',abort);resolve();},20);
   });
   return texts.map(text=>vector(0,model));
  }finally{call.durationMs=performance.now()-call.start;}
 }};
 const service=new KnowledgeService(storage,storage,provider,true);await service.initialize();
 return {service,memory,provider,calls,backend,setModel:(m:string)=>{model=m;},clear:()=>{calls.length=0;backend.length=0;}};
}
const questions={
 parking:'Where is the Nordpark parking garage located, and how far is it from the studio?',
 preparation:'What preparation instructions apply to my first visit at AdMotion Studio?',
 contradiction:'Should I arrive five or ten minutes early at AdMotion Studio?',
 mixed:'What does Video Consultation cost, how long does it last, and can it replace a physical visit? Please explain the documented purpose and limits of digitala informationssamtal.',
 missing:'What is the Nordpark parking fee?',
 insufficient:'For my first visit to AdMotion Studio, what should I bring if an access permit is required?',
} as const;
const facts={
 parking:[['Garagets infart ligger på Stjärngatan 14 . Från garaget tar det ungefär fem minuter att gå till studions entré.','The Nordpark garage entrance is at Stjärngatan 14, approximately a five-minute walk from the studio.']],
 preparation:[['Ta gärna med din bokningsbekräftelse, digitalt eller på papper. Om du har fått särskilda förberedelseinstruktioner inför ditt besök ska du\nfölja dessa.','Please bring your booking confirmation, digitally or on paper. If you have received special preparation instructions, you must follow them.']],
 mixed:[['Digitala informationssamtal används endast för inledande information.','Digital information calls are only for initial information.'],['De ersätter inte automatiskt ett fysiskt besök, och alla ärenden kan inte hanteras digitalt.','They do not automatically replace a physical visit, and not all matters can be handled digitally.']],
 contradiction:[['Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig\ni lugn och ro.','First-time visitors are advised to arrive approximately ten minutes early.'],['Kom gärna fem minuter före din bokade tid.','Please arrive five minutes early.']],
 missing:[],insufficient:[],
} as const;
let serial=46706000000;
async function native(t:any,mode:Mode,warm:boolean,key:keyof typeof questions,channel:typeof incidentChannels[number]='whatsapp'){
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 const f=await fixture(mode),question=questions[key],recipient=String(++serial),stages:string[]=[],inputs:any[]=[],events:any[]=[],replies:string[]=[],lexical:any[]=[];let diagnostic:any,actions=0;
 b.reset();const original={...incidentConfig};let preparation:any[]=[];
 if(warm){await f.service.semanticSearchQueries(77,[question]);preparation=structuredClone(f.calls);f.clear();}
 const forbidden=async()=>{actions++;throw Error('Unauthorized booking/calendar/notification action');};
 const start=performance.now();
 try{
  Object.assign(incidentConfig,{language:'en',services:[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true}]});
  t.mock.method(globalThis,'fetch',async(input:any,options:any)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),knowledgeRetrievalDiagnostic:e=>{diagnostic=e;},evidenceFirstDecisionDiagnostic:e=>events.push(e),
   knowledgeSearch:async(id,q,limit)=>{const rows=await f.service.search(id,q,limit);lexical.push({question:q,rows});return rows;},
   knowledgeSourceLanguages:id=>f.service.sourceLanguageHints(id),completeKnowledgeCorpus:(id,matches)=>f.service.completeSmallCorpus(id,matches),
   semanticKnowledgeSearchQueries:(id,q,limit,options)=>f.service.semanticSearchQueries(id,q,limit,options),
   validateKnowledgeMatches:(id,m)=>f.service.validateMatches(id,m,{strictSources:true,captureRevision:true}),knowledgeServiceCatalog:async()=>incidentConfig.services,
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:'{"language":"en","requestedReplyLanguage":null,"confidence":0.99}'};}
    const data=JSON.parse(p.contents[0].parts[0].text);inputs.push({instruction,data});
    if(instruction.includes('retrieval query planner')){stages.push('planning');return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');assert.ok(data.evidence.length);assert.ok(data.evidence.every((e:any)=>e.businessId===77&&e.id!=='configured-services'));
     const units=facts[key].map(([quote,text],i)=>{const e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e,`Required exact source span missing: ${quote}`);return {facetIds:['f1'],subject:key==='mixed'?'Digital information calls':'Visitors',predicate:'documented information',value:text,scope:key==='mixed'?'documentary offering only':'documented visitor policy',modality:'descriptive',negation:key==='mixed'&&i===1,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};});
     return{text:JSON.stringify({units})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');assert.equal(data.question,question);for(const u of data.units)for(const r of u.evidenceRefs){assert.ok(data.evidence.find((e:any)=>e.id===r.evidenceId)?.text.includes(r.exactQuote));}
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:key==='contradiction'?'CONTRADICTED':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:!['mixed','missing','insufficient','contradiction'].includes(key),incompletenessReason:['mixed','missing','insufficient','contradiction'].includes(key)?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:['mixed','missing','insufficient','contradiction'].includes(key)?'UNRESOLVED':'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
    }
    if(instruction.includes('Translate'))throw Error('Unexpected extra translation stage');
    stages.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question,recipient);
  results.push({type:'native',mode,warm,key,channel,question,preparation,embeddings:f.calls,backend:f.backend,lexical,diagnostic,stages,inputs,events,replies,actions,wallMs:performance.now()-start});
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(diagnostic.completeCorpusUsed,false,'Six chunks must not opt into the five-chunk proof');
  assert.equal(stages.filter(s=>s==='extraction').length,1);if(key==='missing'){assert.ok(!stages.includes('legacy_missing_support'),'Parking-fee routing is evidence-first after the accepted routing repair');assert.equal(stages.filter(s=>s==='verification').length,0,'No supported extracted fee means no claim can be passed to verification');}assert.ok(lexical.some(r=>r.rows.some((m:any)=>m.sourceId==='incident-pdf')),'Actual lexical SQL must retain relevant PDF');
  if(!['missing','insufficient'].includes(key))assert.equal(stages.filter(s=>s==='verification').length,1,'Optional failure must not latch off verification');
  if(key==='parking'||key==='preparation')for(const [,text]of facts[key])assert.ok(replies[0].includes(text),replies[0]);
  if(key==='mixed'){for(const [,text]of facts.mixed)assert.ok(replies[0].includes(text),replies[0]);assert.match(replies[0],/300 SEK/);assert.match(replies[0],/60 minutes/);assert.match(replies[0],/cannot confirm whether the document's information applies to Video Consultation/);assert.ok(events.some(e=>e.stage==='publication'&&e.route==='partial_manifest'));}
  if(['missing','insufficient'].includes(key))assert.doesNotMatch(replies[0],/\d+\s*(SEK|EUR)|free|per hour|required permit|must bring a permit/iu);
  if(key==='contradiction')assert.doesNotMatch(replies[0],/arrive (?:five|ten)|10 minutes|5 minutes/iu);
  assert.equal(f.calls.filter(c=>c.kind==='query').length,1);assert.equal(f.calls.filter(c=>c.kind==='corpus').length,0);
  if(mode.endsWith('timeout')){assert.ok(mode==='query-timeout'?f.calls.some(c=>c.aborted):f.backend.some(c=>c.aborted));assert.ok(diagnostic.searchDurationMs>=2400&&diagnostic.searchDurationMs<4000);}
  if(mode!=='normal')assert.equal(diagnostic.mergeStrategy,'lexical_fallback');
 }finally{Object.assign(incidentConfig,original);b.reset();}
}
for(const channel of incidentChannels)for(const warm of [false,true])test(`AdMotion native ${channel}/${warm?'warm':'cold'}/parking`,t=>native(t,'normal',warm,'parking',channel));
for(const mode of ['empty','query-failure','search-failure','query-timeout','search-timeout']as const)test(`AdMotion optional ${mode} still reaches extraction and verification`,t=>native(t,mode,false,'parking'));
for(const key of ['preparation','mixed','contradiction','missing','insufficient']as const)for(const warm of [false,true])test(`AdMotion obligations ${key}/${warm?'warm':'cold'}`,t=>native(t,'normal',warm,key));

test('AdMotion six canonical chunks, completed persistent index, exact bound and query-only cold/warm retrieval',async()=>{
 const f=await fixture(),lexical=await f.service.search(77,questions.parking);assert.equal(sources.length,2);assert.equal(raw.chunks.length,5);assert.equal(canonicalTexts.size,6);assert.ok(raw.chunks.every((c:any)=>c.has_embedding===false));
 assert.equal(await f.service.completeSmallCorpus(77,lexical),null);
 const cold=await f.service.semanticSearchQueries(77,[questions.parking]);assert.ok(cold.length);const coldCalls=structuredClone(f.calls);f.clear();
 const warm=await f.service.semanticSearchQueries(77,[questions.parking]);assert.deepEqual(warm,cold);assert.deepEqual(f.calls.map(c=>c.kind),['query']);assert.deepEqual(coldCalls.map(c=>c.kind),['query']);
 assert.ok(coldCalls.every((c:any)=>c.texts.every((text:string)=>!canonicalTexts.has(text))));results.push({type:'cold-warm',coldCalls,warmCalls:f.calls,cold,warm,lexical});
});
for(const mutation of ['changed-content','changed-provenance','revoked','deleted','foreign-row','in-flight-revision']as const)test(`AdMotion canonical source authority / ${mutation}`,async()=>{
 const f=await fixture(),before=await f.service.semanticSearchQueries(77,[questions.parking]);assert.ok(before.some(m=>m.sourceId==='incident-pdf'));f.clear();
 const pdf=structuredClone(sources.find(s=>s.id==='incident-pdf')!);
 if(mutation==='changed-content')pdf.content=pdf.content.replace('Stjärngatan 14','Stjärngatan 15');
 if(mutation==='changed-provenance'){assert.ok(Array.isArray(pdf.metadata.segments));pdf.metadata.segments=pdf.metadata.segments.map((s:any)=>({...s,page:s.page+1}));}
 if(mutation==='revoked')pdf.status='disabled';
 if(mutation==='foreign-row')pdf.businessId=88;
 if(mutation==='deleted')await f.memory.delete(77,pdf.id);else if(mutation!=='in-flight-revision')await f.memory.create(pdf);
 if(mutation==='in-flight-revision'){const embed=f.provider.embedDocuments;f.provider.embedDocuments=async(texts,options)=>{const v=await embed(texts,options);if(texts[0]===questions.parking)await f.memory.create({...pdf,status:'disabled'});return v;};}
 const after=await f.service.semanticSearchQueries(77,[questions.parking]);
 const oldPdf=before.filter(m=>m.sourceId==='incident-pdf');assert.deepEqual(await f.service.validateMatches(77,oldPdf,{strictSources:true,captureRevision:true}),[]);
 const currentLexical=await f.service.search(77,questions.parking);
 if(mutation==='changed-content')assert.ok(currentLexical.every(m=>!m.text?.includes('Stjärngatan 14')),'Reject the changed chunk; unchanged canonical chunks may remain searchable');
 if(['changed-provenance','revoked','deleted','foreign-row'].includes(mutation))assert.ok(currentLexical.every(m=>m.sourceId!=='incident-pdf'),'Stale intercepted RPC rows cannot restore revoked authority/provenance');
 if(['revoked','deleted','foreign-row','in-flight-revision'].includes(mutation))assert.ok(after.every(m=>m.sourceId!=='incident-pdf'));
 if(mutation==='changed-content')assert.ok(after.every(m=>m.sourceId!=='incident-pdf'),'Changed document awaits off-request re-indexing; lexical current facts remain available');
 if(mutation==='changed-provenance')assert.ok(after.every(m=>m.sourceId!=='incident-pdf'),'Changed provenance cannot reuse the old generation');
 assert.ok(f.calls.every(c=>!c.texts.some((text:string)=>text.includes('Stjärngatan 14')&&mutation==='foreign-row')));results.push({type:'revision',mutation,calls:f.calls,before,after});
});
test('AdMotion tenant isolation and exact model compatibility never rebuild a corpus',async()=>{
 const f=await fixture();await f.service.semanticSearchQueries(77,[questions.parking]);f.clear();
 assert.deepEqual(await f.service.semanticSearchQueries(88,[questions.parking]),[]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);f.clear();
 f.setModel('incompatible-model');assert.deepEqual(await f.service.semanticSearchQueries(77,[questions.parking]),[]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);f.clear();
 f.setModel('text-embedding-3-small');await f.service.semanticSearchQueries(77,[questions.parking]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);
});
test('Compatible index identity guards provider/model/dimensions/version and cache expiry',async t=>{
 const index=new CompatibleSemanticIndex(),chunks=[{sourceId:'incident-pdf',businessId:77,text:raw.chunks[0].content,metadata:{}}];let query=vector(),calls=0;
 const provider={embedQuery:async()=>query,embedDocuments:async(texts:string[])=>{calls++;return texts.map(()=>structuredClone(query));}};
 for(const q of [vector(),vector(0,'v2'),vector(0,'v2','google'),vector(0,'v2','google',2),vector(0,'v2','google',2,3)]){query=q;assert.equal((await index.searchQueries(77,chunks,[q],provider,5,.55))[0].length,1);}
 assert.equal(calls,5);await index.searchQueries(77,chunks,[query],provider,5,.55);assert.equal(calls,5);
 const now=Date.now();t.mock.method(Date,'now',()=>now+300001);await index.searchQueries(77,chunks,[query],provider,5,.55);assert.equal(calls,6);
 await assert.rejects(()=>index.searchQueries(88,chunks,[query],provider,5,.55),/tenant mismatch/);
 const bad={...provider,embedDocuments:async()=>[vector(0,'wrong-model')]};await assert.rejects(()=>new CompatibleSemanticIndex().searchQueries(77,chunks,[query],bad,5,.55),/identity mismatch/);
});
test('Aborted persistent search leaves lexical evidence intact and starts no corpus embedding',async()=>{
 const f=await fixture('search-timeout');
 for(let i=0;i<2;i++){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),80);try{assert.deepEqual(await f.service.semanticSearchQueries(77,[questions.parking],5,{signal:controller.signal,timeoutMs:80}),[]);}finally{clearTimeout(timer);}}
 assert.deepEqual(f.calls.map(c=>c.kind),['query','query']);assert.ok(f.backend.filter(c=>c.path.endsWith(PERSISTENT_SEARCH_RPC)).every(c=>c.aborted));assert.ok((await f.service.search(77,questions.parking)).some(m=>m.sourceId==='incident-pdf'));
 results.push({type:'aborted-cache',calls:f.calls,note:'80ms persisted RPC cancellation probe only; native tests separately exercise the unchanged actual 2500ms budget.'});
});
test('Simultaneous cold requests use persistent generations with zero corpus embeddings',async()=>{
 const f=await fixture();await Promise.all([f.service.semanticSearchQueries(77,[questions.parking]),f.service.semanticSearchQueries(77,[questions.parking])]);assert.equal(f.calls.filter(c=>c.kind==='corpus').length,0);f.clear();await f.service.semanticSearchQueries(77,[questions.parking]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);results.push({type:'concurrent-cold',queryCalls:2,corpusCalls:0,subsequent:f.calls});
});

test('AdMotion timestamp-only update and new process reuse the persistent generation',async()=>{
 const f=await fixture();await f.service.semanticSearchQueries(77,[questions.parking]);f.clear();
 await f.memory.create({...structuredClone(sources[0]),updatedAt:'2026-10-24T12:00:00Z'});
 await f.service.semanticSearchQueries(77,[questions.parking]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);f.clear();
 const restarted=new KnowledgeService(f.memory,f.memory,f.provider);
 const matches=await restarted.semanticSearchQueries(77,[questions.parking]);assert.ok(matches.length);assert.deepEqual(f.calls.map(c=>c.kind),['query']);
});
test('No lexical evidence plus no semantic match remains NO_EVIDENCE without extraction or publication',async()=>{
 const f=await fixture('empty'),question='Zorblax quuxite';
 const lexical=await f.service.search(77,question),semantic=await f.service.semanticSearchQueries(77,[question]);assert.deepEqual(lexical,[]);assert.deepEqual(semantic,[]);
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets:parseRequestedFacets([{subject:'business',attribute:question,questionType:'description'}]).facets,
  evidence:answerEvidence(77,[...lexical,...semantic]),authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,generate:async()=>{throw Error('No evidence must not start extraction or verification');}});
 assert.equal(manifest.units.length,0);assert.equal(manifest.outcomes[0].status,'NO_EVIDENCE');results.push({type:'no-evidence',question,lexical,semantic,manifest,calls:f.calls});
});
test('Missing parking fee: lexical and semantic context cannot verify an unsupported amount',async()=>{
 const f=await fixture(),question=questions.missing,lexical=await f.service.search(77,question),semantic=await f.service.semanticSearchQueries(77,[question]);
 const evidence=answerEvidence(77,[...lexical,...semantic]);let verified=0;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets:parseRequestedFacets([{subject:'parking',attribute:question,questionType:'description'}]).facets,
  evidence,authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction'){const e=data.evidence.find((e:any)=>e.text.includes('Nordpark'));assert.ok(e);return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'Nordpark parking fee',predicate:'price',value:'50 SEK',scope:'parking garage',modality:'descriptive',negation:false,qualifiers:[],language:'en',text:'Nordpark parking costs 50 SEK.',evidenceRefs:[{evidenceId:e.id,exactQuote:'Garagets infart ligger på Stjärngatan 14 .'}]}]})};}
   if(stage==='verification'){verified++;return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'UNKNOWN',meaningPreserved:false,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:[],obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]}]}]})};}
   throw Error('Unsupported fee cannot reach composition');
  }});
 assert.ok(verified===1||manifest.units.length===0,'Numerical guard may reject earlier than the independent verdict');assert.equal(manifest.units.length,0);assert.notEqual(manifest.outcomes[0].status,'VERIFIED');assert.doesNotMatch(manifest.text,/50 SEK/);results.push({type:'unsupported-fee',lexical,semantic,verified,manifest,calls:f.calls});
});
