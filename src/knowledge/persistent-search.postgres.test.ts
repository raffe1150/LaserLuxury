import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {KnowledgeService,SupabaseKnowledgeStorage} from '../../knowledge';
import {DisposableSourceIndexDatabase,indexSqlLiteral as lit} from '../../tests/helpers/disposable-source-index-db';
import {documentChunks} from './documents/service';
import {SourceIndexCoordinator,SupabaseSourceIndexRepository} from './documents/indexing';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from './embedding-backfill';
import {PERSISTENT_SEARCH_RPC,type SemanticStatus,type IndexCoverage} from './persistent-search';
import {mixedBusinesses} from '../../tests/fixtures/mixed-source-questions';
const migration='20261024161901_persistent_knowledge_search_snapshot.sql';
const vector=(axis=0)=>({...identity,values:Array.from({length:768},(_,i)=>i===axis?1:0)});
const limits={allowedBusinessIds:[77,88,99],maxSources:50,maxRequests:100,maxInputChars:1_000_000,maxInputBytes:4_000_000};

test('persistent customer retrieval uses actual PostgreSQL generation proofs; synthetic providers only',{timeout:120_000},async t=>{
 const pg=new DisposableSourceIndexDatabase([migration]);
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
 const indexingCalls:string[][]=[],queryCalls:string[][]=[];
 const indexer=new SourceIndexCoordinator(new SupabaseSourceIndexRepository(pg.client),{embedDocuments:async texts=>{indexingCalls.push([...texts]);return texts.map(()=>vector());}},identity,limits);
 const questions=new Set<string>();
 const query=(q:string)=>{questions.add(q);return q;};
 const provider={supportsLocalSemanticSearch:true,
   embedQuery:async(q:string)=>{assert.ok(questions.has(q),'query-only single request');queryCalls.push([q]);return vector();},
   embedDocuments:async(qs:string[])=>{assert.ok(qs.length<=3&&qs.every(q=>questions.has(q)),'query-only bounded batch');queryCalls.push([...qs]);return qs.map(()=>vector());}};
 const storage=new SupabaseKnowledgeStorage(pg.client);
 let service=new KnowledgeService(storage,storage,provider,true);
 const seed=(businessId=77,text='Bring the device only if one is available.',type='document')=>{
   const id=randomUUID(),d=documentChunks([{text,section:'Instructions'}],'fixture.txt');
   pg.sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES(${lit(id)},${businessId},${lit(type)},'fixture.txt','ready',${lit(d.content)},${lit(d.metadata)});
     SELECT public.replace_knowledge_chunks(${businessId},${lit(id)},${lit(d.chunks)});`);return{businessId,sourceId:id};
 };
 const reset=()=>{pg.sql('DELETE FROM public.knowledge_sources;');indexingCalls.length=0;queryCalls.length=0;};
 const run=async(q:string,batch=true,businessId=77)=>{
   let status:SemanticStatus|undefined;const started=performance.now();query(q);
   const matches=batch?await service.semanticSearchQueries(businessId,[q],10,{onStatus:s=>status=s}):await service.semanticSearch(businessId,q,10,.55,{onStatus:s=>status=s});
   return{matches,status,ms:performance.now()-started};
 };
 const ready=async(s:{businessId:number;sourceId:string})=>assert.equal((await indexer.indexSource(s)).status,'ready');
 try {
  await t.test('additive migration is backend-only, stable and invoker; old RPC remains unchanged',()=>{
   assert.equal(pg.sql(`SELECT provolatile::text||':'||prosecdef::text FROM pg_proc WHERE oid='public.${PERSISTENT_SEARCH_RPC}(bigint,jsonb,jsonb,integer,real,jsonb)'::regprocedure;`),'s:false');
   for(const role of ['anon','authenticated'])assert.equal(pg.sql(`SELECT has_function_privilege('${role}','public.${PERSISTENT_SEARCH_RPC}(bigint,jsonb,jsonb,integer,real,jsonb)','EXECUTE');`),'f');
   assert.equal(pg.sql(`SELECT has_function_privilege('service_role','public.${PERSISTENT_SEARCH_RPC}(bigint,jsonb,jsonb,integer,real,jsonb)','EXECUTE');`),'t');
   assert.equal(pg.sql("SELECT to_regprocedure('public.search_knowledge_chunks_semantic(bigint,extensions.vector,integer,real,text,text,integer)') IS NOT NULL;"),'t');
  });
  await t.test('SQL rejects incompatible identities, bad vector shapes, nonnumeric values and excess queries',async()=>{
   reset();const s=seed();await ready(s);
   for(const [target,qs] of [[{...identity,provider:'google'},[vector().values]],[identity,[[1,0]]],
     [identity,[Array(768).fill('NaN')]],[identity,[Array(768).fill(0)]],[identity,Array(4).fill(vector().values)]]){
    await assert.rejects(pg.backendSql(`SELECT public.${PERSISTENT_SEARCH_RPC}(77,${lit(target)},${lit(qs)},5,0.55,'[]');`));
   }
   for(const role of ['anon','authenticated'])assert.throws(()=>pg.sql(`SET ROLE ${role};SELECT public.${PERSISTENT_SEARCH_RPC}(77,${lit(identity)},'[]');`),/permission denied/);
  });
  await t.test('empty inventory proofs remain tenant scoped and never imply complete coverage',async()=>{
   reset();const request={businessId:77,embeddings:[],limit:1,minSimilarity:.55,excludedChunks:[]};
   const own=await storage.persistentSemanticSearch(request),foreign=await storage.persistentSemanticSearch({...request,businessId:88});
   assert.equal(own.coverage.businessId,77);assert.equal(own.coverage.complete,false);
   assert.notEqual(own.coverage.inventoryToken,foreign.coverage.inventoryToken);
   assert.equal(await service.validateSemanticCoverage(77,own.coverage),true);
   assert.equal(await service.validateSemanticCoverage(88,own.coverage),false);
  });
  await t.test('original AdMotion six chunks: cold, warm and restarted turns embed queries only',async()=>{
   reset();const gate=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/prepared-gate-final.json','utf8'));
   const pdf=JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8'));
   for(const [i,s] of gate.sources.entries()){
    const id=randomUUID();pg.sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES(${lit(id)},77,'document',${lit(s.title)},'ready',${lit(s.content)},${lit(s.metadata)});
      SELECT public.replace_knowledge_chunks(77,${lit(id)},${lit(i===0?pdf.chunks:[{chunk_index:0,content:s.content,metadata:{source:'document',section:'Text'}}])});`);
    await ready({businessId:77,sourceId:id});
   }
   assert.deepEqual(indexingCalls.map(c=>c.length),[5,1]);const before=indexingCalls.length;
   const results=[];
   for(const [label,batch] of [['cold',false],['warm',true],['restart',true]] as const){
    if(label==='restart'){pg.restart();service=new KnowledgeService(new SupabaseKnowledgeStorage(pg.client),storage,provider,true);}
    const out=await run('What preparation guidance applies, with its restrictions?',batch);results.push({label,ms:out.ms,calls:queryCalls.length});
    assert.equal(out.status?.status,'complete');assert.equal(out.matches.length,6);
    assert.deepEqual(new Set(out.matches.map(m=>m.text)),new Set([...pdf.chunks.map((c:any)=>c.content),gate.sources[1].content]));
    assert.ok(out.matches.every(m=>m.businessId===77&&m.indexProof?.source.ready&&m.metadata?.documentRevision));
    assert.ok(out.matches.some(m=>m.text!.includes('10 minuter')),'original PDF facts retained');
    assert.ok(out.matches.some(m=>m.text!.includes('fem minuter')),'competing TXT/PDF facts retained for independent verification');
   }
   assert.equal(indexingCalls.length,before);assert.equal(queryCalls.length,3);
   t.diagnostic(JSON.stringify({synthetic:true,customerCorpusCalls:0,queryRequests:3,offRequestBatches:[5,1],timings:results}));
  });
  for(const business of mixedBusinesses)await t.test(`${business.name}: semantic-only six-language requests and parallel turns stay tenant scoped`,async()=>{
   reset();const s=seed(business.id,business.source);await ready(s);const foreign=seed(business.id===88?99:88,'Unrelated foreign tenant source.');await ready(foreign);
   const before=indexingCalls.length;
   const qs=['What guidance is offered remotely?','Vilken vägledning erbjuds på distans?','Welche Fernberatung ist vorgesehen?','چه راهنمایی از راه دور ارائه می‌شود؟','¿Qué orientación se ofrece a distancia?','ما الإرشادات المقدمة عن بعد؟'];
   const outs=await Promise.all(qs.map(q=>run(q,true,business.id)));
   for(const out of outs){assert.equal(out.status?.status,'complete');assert.equal(out.matches.length,1);assert.equal(out.matches[0].sourceId,s.sourceId);assert.equal(out.matches[0].text,business.source);}
   assert.equal(queryCalls.length,6);assert.equal(indexingCalls.length,before);
  });
  await t.test('configured OpenAI SDK transport: cold/warm/restart/concurrent single and batch requests contain queries only',async st=>{
   reset();const s=seed();await ready(s);const oldProvider=process.env.AI_PROVIDER,oldKey=process.env.OPENAI_API_KEY;
   process.env.AI_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-offline-unused';
   try {
    const {Embeddings}=await import('openai/resources/embeddings');const {ConfiguredEmbeddingProvider}=await import('../ai/providers/embeddings');
    const seen:string[][]=[];const allowed=new Set(['What guidance applies?','documentary guidance']);
    st.mock.method(Embeddings.prototype,'create',async(params:any,options:any)=>{
     assert.equal(params.model,identity.model);assert.equal(params.dimensions,768);assert.equal(params.encoding_format,'float');
     assert.ok(params.input.length<=3&&params.input.every((q:string)=>allowed.has(q)));assert.ok(options.signal);assert.ok(options.timeout<=2500);
     seen.push([...params.input]);return{data:params.input.map((_q:string,index:number)=>({index,embedding:vector().values}))} as any;
    });
    const make=()=>new KnowledgeService(storage,storage,new ConfiguredEmbeddingProvider(()=>{throw Error('Google credential callback forbidden');}),true);
    let k=make();assert.equal((await k.semanticSearch(77,'What guidance applies?')).length,1);
    assert.equal((await k.semanticSearchQueries(77,['What guidance applies?'])).length,1);
    pg.restart();k=make();assert.equal((await k.semanticSearchQueries(77,['What guidance applies?'])).length,1);
    const parallel=await Promise.all([k.semanticSearch(77,'What guidance applies?'),k.semanticSearchQueries(77,['What guidance applies?'])]);assert.ok(parallel.every(m=>m.length===1));
    assert.equal((await k.semanticSearchQueries(77,['What guidance applies?','documentary guidance'])).length,1);
    assert.equal(seen.length,6);assert.deepEqual(seen.map(q=>q.length),[1,1,1,1,1,2]);assert.equal(indexingCalls.length,1);
    st.diagnostic('Actual configured OpenAI adapter + intercepted SDK: 6 query requests / 7 query inputs, 0 corpus inputs, 0 fetch calls; one separate synthetic off-request batch.');
   } finally {if(oldProvider===undefined)delete process.env.AI_PROVIDER;else process.env.AI_PROVIDER=oldProvider;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
  });
  await t.test('missing, incomplete and blocked generations do not hide independently usable matches',async()=>{
   reset();const a=seed(),b=seed(77,'Second source awaiting indexing.');await ready(a);
   let out=await run('Can I get the documented preparation instructions?');assert.equal(out.status?.status,'incomplete');assert.deepEqual(out.matches.map(m=>m.sourceId),[a.sourceId]);
   assert.equal(out.status?.coverage.sources.find(s=>s.sourceId===b.sourceId)?.state,'unknown');
   pg.sql(`UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(vector().values))}::extensions.vector,embedding_provider='google',embedding_model='gemini-embedding-2',embedding_dimensions=768,embedding_version=1 WHERE source_id=${lit(b.sourceId)};`);
   assert.equal((await indexer.indexSource(b)).status,'skipped'); // incompatible pre-existing vectors never adopted
   out=await run('Can I get the documented preparation instructions?');assert.equal(out.status?.status,'incomplete');assert.equal(out.matches.length,1);
   assert.equal(indexingCalls.length,1);
  });
  for(const mutation of ['content','metadata','chunk','vector','provider','model','version','missing-vector','missing-chunk','generation','disabled','deleted','delete'] as const)
   await t.test(`changed/revoked/incompatible ${mutation} invalidates captured evidence at publication`,async()=>{
    reset();const s=seed();await ready(s);const initial=await run('What should I bring?');assert.equal(initial.matches.length,1);
    const fields:Record<string,string>={content:"content=content||' changed'",metadata:"metadata=metadata||'{\"revision\":2}'",disabled:"status='disabled'",deleted:"status='deleted'"};
    const chunkFields:Record<string,string>={chunk:"content=content||' changed'",vector:`embedding=${lit(JSON.stringify(vector(1).values))}::extensions.vector`,provider:"embedding_provider='google'",model:"embedding_model='other'",version:'embedding_version=2','missing-vector':'embedding=NULL'};
    pg.sql(mutation==='delete'?`DELETE FROM public.knowledge_sources WHERE id=${lit(s.sourceId)};`:mutation==='missing-chunk'?`DELETE FROM public.knowledge_chunks WHERE source_id=${lit(s.sourceId)};`:mutation==='generation'?`UPDATE public.knowledge_source_index_state SET completed_revision=repeat('0',64) WHERE source_id=${lit(s.sourceId)};`:fields[mutation]?`UPDATE public.knowledge_sources SET ${fields[mutation]} WHERE id=${lit(s.sourceId)};`:`UPDATE public.knowledge_chunks SET ${chunkFields[mutation]} WHERE source_id=${lit(s.sourceId)};`);
    assert.deepEqual(await service.validateMatches(77,initial.matches,{strictSources:true}),[]);
    assert.deepEqual((await run('What should I bring?')).matches,[]);
    assert.equal(indexingCalls.length,1);
   });
  await t.test('adding a source changes inventory completeness but preserves current independent facts',async()=>{
   reset();const s=seed();await ready(s);const initial=await run('What should I bring?');assert.equal(initial.status?.status,'complete');
   const coverage=(initial.status as {coverage:IndexCoverage}).coverage;seed(77,'Additional document.');
   assert.equal(await service.validateSemanticCoverage(77,coverage),false);
   assert.deepEqual(await service.validateMatches(77,initial.matches,{strictSources:true}),initial.matches);
   assert.equal((await run('What should I bring?')).status?.status,'incomplete');
  });
  await t.test('one statement retains its readiness/search snapshot during a concurrent source change',async()=>{
   reset();const s=seed();await ready(s);
   const sql=`WITH pause AS MATERIALIZED (SELECT pg_sleep(0.25)) SELECT public.${PERSISTENT_SEARCH_RPC}(77,${lit(identity)},${lit([vector().values])},5,0.55,'[]') FROM pause;`;
   const pending=pg.backendSql(sql);await new Promise(r=>setTimeout(r,80));pg.sql(`UPDATE public.knowledge_sources SET content=content||' revised' WHERE id=${lit(s.sourceId)};`);
   const result=await pending;assert.equal(result.coverage.complete,true);assert.equal(result.matches[0].length,1);
   assert.equal((await run('What should I bring?')).matches.length,0);
  });
  await t.test('empty results are compatible-index coverage, not proof of absent relevant knowledge',async()=>{
   reset();const s=seed();await ready(s);
   const request={p_business_id:77,p_identity:identity,p_queries:[vector(1).values],p_limit:5,p_min_similarity:.55,p_excluded_chunks:[]};
   const response=await pg.client.rpc(PERSISTENT_SEARCH_RPC,request);assert.equal(response.error,null);
   assert.equal(response.data.coverage.complete,true);assert.deepEqual(response.data.matches,[[]]);
  });
  await t.test('workflow exclusions occur before top-N, preserving the unchanged cosine threshold',async()=>{
   reset();const wrong=seed(77,'Staff training requires a notice period; not for customers.');await ready(wrong);
   const right=seed(77,'Customer parking is behind the studio.');await ready(right);
   const out=await service.semanticSearchQueries(77,[query('Where is customer parking?')],1);
   assert.equal(out.length,1);assert.equal(out[0].sourceId,right.sourceId);
  });
  await t.test('a newly completed revision cannot race the workflow exclusion snapshot',async()=>{
   reset();const s=seed(77,'Customer parking is behind the studio.');await ready(s);
   const real=storage.persistentSemanticSearch.bind(storage);let changed=false;
   const replacement=documentChunks([{text:'Staff training requires notice; not for customers.',section:'Instructions'}],'fixture.txt');
   storage.persistentSemanticSearch=async(request,options)=>{
    if(request.embeddings.length&&!changed){changed=true;pg.sql(`UPDATE public.knowledge_sources SET content=${lit(replacement.content)},metadata=${lit(replacement.metadata)} WHERE id=${lit(s.sourceId)};
      SELECT public.replace_knowledge_chunks(77,${lit(s.sourceId)},${lit(replacement.chunks)});`);await ready(s);}
    return real(request,options);
   };
   try {
    let status:SemanticStatus|undefined;const hooked=new KnowledgeService(storage,storage,provider,true);
    const matches=await hooked.semanticSearchQueries(77,[query('Where is customer parking?')],5,{onStatus:s=>status=s});
    assert.equal(changed,true,'The race hook must bind the active primary storage, including after restart');
    assert.deepEqual(matches,[]);assert.deepEqual(status,{status:'unavailable',reason:'source_changed'});
   }
   finally{storage.persistentSemanticSearch=real;}
  });
  await t.test('missing RPC safely degrades, retains lexical evidence and never rebuilds corpus vectors',async()=>{
   reset();const s=seed();await ready(s);const original=pg.client.rpc;
   const broken={...pg.client,rpc:(name:string,args:any)=>name===PERSISTENT_SEARCH_RPC?Promise.resolve({data:null,error:{code:'PGRST202'}}):original(name,args)};
   const st=new SupabaseKnowledgeStorage(broken);const k=new KnowledgeService(st,st,provider,true);
   let status:SemanticStatus|undefined;assert.deepEqual(await k.semanticSearchQueries(77,[query('Bring device')],5,{onStatus:s=>status=s}),[]);
   assert.equal(status?.status,'unavailable');assert.equal(indexingCalls.length,1);
   assert.equal((await k.search(77,'Bring device')).length,1);
  });
  await t.test('actual missing schema / missing RPC both retain lexical evidence without corpus regeneration',async()=>{
   reset();const s=seed();await ready(s);
   pg.sql('ALTER TABLE public.knowledge_source_index_state RENAME TO source_index_temporarily_unavailable;');
   try {const out=await run('Bring device');assert.equal(out.status?.status,'unavailable');assert.deepEqual(out.matches,[]);assert.equal((await service.search(77,'Bring device')).length,1);}
   finally{pg.sql('ALTER TABLE public.source_index_temporarily_unavailable RENAME TO knowledge_source_index_state;');}
   pg.sql('DROP FUNCTION public.search_knowledge_index_snapshot_v1(bigint,jsonb,jsonb,integer,real,jsonb);');
   try {const out=await run('Bring device');assert.equal(out.status?.status,'unavailable');assert.deepEqual(out.matches,[]);assert.equal((await service.search(77,'Bring device')).length,1);}
   finally{pg.sql(readFileSync('supabase/migrations/'+migration,'utf8'));}
   assert.equal(indexingCalls.length,1);
  });
  await t.test('query timeout/cancellation in both paths starts no search or corpus work',async()=>{
   reset();seed();const seen:AbortSignal[]=[];const hanging={supportsLocalSemanticSearch:true,
    embedDocuments:async(_q:string[],o:any)=>{seen.push(o.signal);return new Promise<any>(()=>{});},
    embedQuery:async(_q:string,o:any)=>{seen.push(o.signal);return new Promise<any>(()=>{});}};
   const k=new KnowledgeService(storage,storage,hanging,true);
   for(const batch of [true,false]){let status:SemanticStatus|undefined;const before=pg.calls.length;const o={timeoutMs:25,onStatus:(s:SemanticStatus)=>status=s};
    assert.deepEqual(await(batch?k.semanticSearchQueries(77,['What should I bring?'],5,o):k.semanticSearch(77,'What should I bring?',5,.55,o)),[]);
    assert.equal(status?.status,'unavailable');assert.equal((status as any).reason,'timeout');assert.equal(pg.calls.length,before);assert.ok(seen.at(-1)?.aborted);
   }assert.equal(indexingCalls.length,0);
  });
  assert.equal(network.mock.callCount(),0);
 } finally {indexer.stop();pg.close();}
});
