import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chunkKnowledgeContent } from '../../../knowledge';
import { DisposableSourceIndexDatabase, indexSqlLiteral as lit } from '../../../tests/helpers/disposable-source-index-db';
import { mixedBusinesses } from '../../../tests/fixtures/mixed-source-questions';
import { SourceIndexCoordinator, SupabaseSourceIndexRepository, type IndexScope, type SourceIndexLimits } from './indexing';
import { DocumentService, documentChunks } from './service';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as openai, KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY as google } from '../embedding-backfill';
import type { EmbeddingVector, EmbeddingRequestOptions } from '../../ai/embeddings';

const limits: SourceIndexLimits = { allowedBusinessIds: [77,88,99], maxSources: 50, maxRequests: 100, maxInputChars: 1_000_000, maxInputBytes: 4_000_000 };
const values = Array.from({length:768},(_,i)=>i===0?1:0);
const vectors = (texts: string[], identity: any = openai): EmbeddingVector[] => texts.map(()=>({ ...identity, values: [...values] }));
const sections = (n=1) => Array.from({length:n},(_,i)=>({text:`Section ${i}: bring the item only if one is available. Do not assume permission.`,page:i+1}));

test('off-request indexing coordinator + actual PostgreSQL contracts, synthetic providers only', {timeout:120_000},async t=>{
  const pg=new DisposableSourceIndexDatabase();
  const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('NETWORK FORBIDDEN');});
  const coordinators: SourceIndexCoordinator[]=[];
  const repo=()=>new SupabaseSourceIndexRepository(pg.client);
  const indexer=(provider: {embedDocuments(texts:string[],options?:EmbeddingRequestOptions):Promise<EmbeddingVector[]>},policy=limits,identity:any=openai,repository=repo())=>{
    const c=new SourceIndexCoordinator(repository,provider,identity,policy);coordinators.push(c);return c;
  };
  const fake=(impl?: (texts:string[],options?:EmbeddingRequestOptions)=>Promise<EmbeddingVector[]>)=>{
    const calls:string[][]=[];
    return {calls,async embedDocuments(texts:string[],options?:EmbeddingRequestOptions){calls.push([...texts]);assert.equal(options?.timeoutMs,20_000);assert.equal(options?.signal?.aborted,false);return impl?impl(texts,options):vectors(texts);}};
  };
  const insert=(businessId:number,type:string,title:string,content:string,metadata:any,chunks:any[],id:string=randomUUID()):IndexScope=>{
    pg.sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES(${lit(id)},${businessId},${lit(type)},${lit(title)},'ready',${lit(content)},${lit(metadata)});
      SELECT public.replace_knowledge_chunks(${businessId},${lit(id)},${lit(chunks)});`);return{businessId,sourceId:id};
  };
  const seed=(businessId=77,n=1)=>{const d=documentChunks(sections(n),'synthetic.txt');return insert(businessId,'document','synthetic.txt',d.content,d.metadata,d.chunks);};
  const state=(s:IndexScope)=>JSON.parse(pg.sql(`SELECT to_jsonb(s) FROM public.knowledge_source_index_state s WHERE business_id=${s.businessId} AND source_id=${lit(s.sourceId)};`)||'null');
  const ready=(s:IndexScope,identity:any=openai)=>JSON.parse(pg.sql(`SELECT public.knowledge_source_index_readiness_v1(${s.businessId},${lit(s.sourceId)},${lit(identity)});`));
  const stored=(s:IndexScope)=>JSON.parse(pg.sql(`SELECT jsonb_agg(jsonb_build_array(content,metadata,embedding::text,embedding_provider) ORDER BY chunk_index) FROM public.knowledge_chunks WHERE business_id=${s.businessId} AND source_id=${lit(s.sourceId)};`));
  const expire=(s:IndexScope)=>pg.sql(`UPDATE public.knowledge_source_index_state SET lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE source_id=${lit(s.sourceId)};`);
  const retry=(s:IndexScope)=>pg.sql(`UPDATE public.knowledge_source_index_state SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE source_id=${lit(s.sourceId)};`);
  const reset=()=>pg.sql('DELETE FROM public.knowledge_sources; DELETE FROM public.knowledge_document_cleanup;');
  try {
    await t.test('new upload → extraction Ready → off-request indexing preserves extraction state and text',async()=>{
      reset();const object=new Map<string,Buffer>();const bytes=Buffer.from('Synthetic preparation text');const user=randomUUID();
      pg.sql(`INSERT INTO public.business_memberships VALUES(77,${lit(user)},'active','owner');`);
      const p=fake();const c=indexer(p);
      const client={...pg.client,storage:{getBucket:async()=>({data:{public:false,file_size_limit:5*1024*1024},error:null}),from:()=>({
        upload:async(key:string,data:Buffer)=>{object.set(key,data);return{error:null};},
        download:async(key:string)=>({data:new Blob([object.get(key)!]),error:null}),
      })}};
      const service=new DocumentService(client as any,async()=>sections(),c);
      const id=await service.upload(77,user,bytes,'new.txt','text/plain',true);await service.process(77,id);
      const s={businessId:77,sourceId:id};assert.equal(p.calls.length,0,'Upload/extraction never invoke embeddings');
      const before=pg.sql(`SELECT to_jsonb(s)||jsonb_build_object('document',to_jsonb(d)) FROM public.knowledge_sources s JOIN public.knowledge_documents d ON d.source_id=s.id WHERE s.id=${lit(id)};`);
      assert.equal(ready(s).ready,false);assert.deepEqual(await service.recoverIndex(),[{status:'ready',reason:'committed'}]);
      assert.equal(p.calls.length,1);assert.equal(ready(s).ready,true);
      assert.equal(pg.sql(`SELECT to_jsonb(s)||jsonb_build_object('document',to_jsonb(d)) FROM public.knowledge_sources s JOIN public.knowledge_documents d ON d.source_id=s.id WHERE s.id=${lit(id)};`),before);
    });
    await t.test('historical ready source, warm recovery and process restart make 1 → 0 → 0 synthetic embedding calls',async()=>{
      reset();const s=seed(88);const p=fake();const c=indexer(p);
      assert.equal((await c.indexSource(s)).status,'ready');assert.equal(p.calls.length,1);
      assert.equal((await c.indexSource(s)).status,'skipped');assert.equal(p.calls.length,1);
      pg.restart();const restarted=fake();assert.equal((await indexer(restarted).indexSource(s)).status,'skipped');assert.equal(restarted.calls.length,0);
      t.diagnostic('historical-source synthetic counts: cold=1, warm=0 additional, restarted=0; no vector cache required');
    });
    await t.test('unchanged AdMotion six-chunk PDF/TXT corpus indexes all original bytes/provenance',async()=>{
      reset();const prepared=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/prepared-gate-final.json','utf8'));
      const pdf=JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8'));
      const ids=['77000000-0000-4000-8000-000000000001','77000000-0000-4000-8000-000000000002'];
      const sources=prepared.sources.map((s:any,i:number)=>insert(77,'document',s.title,s.content,s.metadata,i===0?pdf.chunks:
        [{chunk_index:0,content:s.content,metadata:{source:'document',section:'Text'}}],ids[i]));
      const before=sources.map(stored);const p=fake();const c=indexer(p);
      for(const s of sources)assert.equal((await c.indexSource(s)).status,'ready');
      assert.deepEqual(p.calls.map(c=>c.length),[5,1]);assert.equal(sources.every(s=>ready(s).ready),true);
      for(let i=0;i<sources.length;i++)assert.deepEqual(stored(sources[i]).map((r:any[])=>r.slice(0,2)),before[i].map((r:any[])=>r.slice(0,2)));
      for(const s of sources)await c.indexSource(s);assert.equal(p.calls.length,2);
      const warm=fake();const next=indexer(warm);for(const s of sources)await next.indexSource(s);assert.equal(warm.calls.length,0);
      t.diagnostic('AdMotion aliases incident-pdf→'+ids[0]+', incident-txt→'+ids[1]+'; synthetic cold batches=[5,1], warm/restarted=0; canonical fixture files unchanged');
    });
    await t.test('Cedar and Summit remain independently tenant/source scoped',async()=>{
      reset();const p=fake();const c=indexer(p);
      for(const business of mixedBusinesses){const d=documentChunks([{text:business.source,section:'Information'}],business.name+'.txt');
        const s=insert(business.id,'document',business.name+'.txt',d.content,d.metadata,d.chunks);
        assert.equal((await c.indexSource(s)).status,'ready');assert.ok(p.calls.at(-1)!.every(text=>text===business.source));
        const foreign={...s,businessId:business.id===88?99:88};assert.equal((await c.indexSource(foreign)).status,'skipped');
      }
      assert.equal(p.calls.length,2);
    });
    await t.test('legacy text/FAQ null vectors use canonical legacy chunking and the same readiness',async()=>{
      reset();const p=fake();const c=indexer(p);
      for(const type of ['text','faq']){const text='Only preliminary guidance; not an inspection.';
        const s=insert(88,type,'Legacy',text,{},chunkKnowledgeContent(text).map(x=>({chunk_index:x.chunkIndex,content:x.content,metadata:x.metadata})));
        assert.equal((await c.indexSource(s)).status,'ready');assert.equal(ready(s).ready,true);
      }assert.equal(p.calls.length,2);
    });
    await t.test('competing coordinators yield one provider generation and one publication',async()=>{
      reset();const s=seed();let release!:()=>void;let entered!:()=>void;const start=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
      const p=fake(async texts=>{entered();await wait;return vectors(texts);});const a=indexer(p),b=indexer(p);
      const runs=[a.indexSource(s),b.indexSource(s)];await Promise.race([start,Promise.all(runs).then(out=>{throw new Error('Provider never entered: '+JSON.stringify(out));})]);release();const out=await Promise.all(runs);
      assert.equal(out.filter(r=>r.status==='ready').length,1);assert.equal(out.filter(r=>r.status==='skipped').length,1);
      assert.equal(p.calls.length,1);assert.equal(state(s).attempts,1);assert.equal(pg.calls.filter(c=>c.name==='complete_knowledge_source_index_v1'&&c.args.p_source_id===s.sourceId).length,1);
    });
    await t.test('unfinished ownership survives database/coordinator restart and recovers after expiry',async()=>{
      reset();const s=seed();const original=await repo().claim(s,openai,new AbortController().signal);pg.restart();
      const p=fake();const c=indexer(p);assert.equal((await c.indexSource(s)).status,'skipped');assert.equal(p.calls.length,0);
      expire(s);assert.equal((await c.indexSource(s)).status,'ready');assert.equal(p.calls.length,1);
      assert.notEqual(state(s).completed_token,original.lease_token);assert.equal(state(s).attempts,2);
    });
    await t.test('partial multi-batch failure publishes nothing; backoff gates recovery and retry succeeds',async()=>{
      reset();const s=seed(77,25);let calls=0;const p=fake(async texts=>{if(++calls===2)throw Object.assign(new Error('synthetic'),{status:503});return vectors(texts);});const c=indexer(p);
      assert.deepEqual(await c.indexSource(s),{status:'failed',reason:'provider_failure'});assert.deepEqual(p.calls.map(c=>c.length),[20,5]);
      assert.equal(state(s).state,'retry_wait');assert.ok(stored(s).every((r:any[])=>r[2]===null));
      await c.indexSource(s);assert.equal(p.calls.length,2);retry(s);
      assert.equal((await c.indexSource(s)).status,'ready');assert.equal(p.calls.length,4);assert.equal(state(s).attempts,2);
    });
    await t.test('source revision changed during generation never reaches completion',async()=>{
      reset();const s=seed();const p=fake(async texts=>{pg.sql(`UPDATE public.knowledge_sources SET content=content||' revised' WHERE id=${lit(s.sourceId)};`);return vectors(texts);});
      assert.deepEqual(await indexer(p).indexSource(s),{status:'failed',reason:'stale'});assert.ok(stored(s).every((r:any[])=>r[2]===null));assert.equal(ready(s).ready,false);
    });
    await t.test('a newly published canonical revision recovers after stale ownership expires',async()=>{
      reset();const s=seed();const d=documentChunks([{text:'Follow separate instructions only if supplied.',page:2}],'synthetic.txt');
      const old=fake(async texts=>{pg.sql(`UPDATE public.knowledge_sources SET content=${lit(d.content)},metadata=${lit(d.metadata)} WHERE id=${lit(s.sourceId)};
        SELECT public.replace_knowledge_chunks(77,${lit(s.sourceId)},${lit(d.chunks)});`);return vectors(texts);});
      assert.equal((await indexer(old).indexSource(s)).reason,'stale');expire(s);
      const p=fake();assert.equal((await indexer(p).indexSource(s)).status,'ready');assert.deepEqual(p.calls,[['Follow separate instructions only if supplied.']]);
      assert.equal(state(s).attempts,1);assert.equal(ready(s).ready,true);
    });
    await t.test('revoked source during embedding retains text but cannot publish vectors',async()=>{
      reset();const s=seed();const p=fake(async texts=>{pg.sql(`UPDATE public.knowledge_sources SET status='disabled' WHERE id=${lit(s.sourceId)};`);return vectors(texts);});
      assert.equal((await indexer(p).indexSource(s)).status,'failed');assert.ok(stored(s).every((r:any[])=>r[2]===null));
      assert.equal(pg.sql(`SELECT length(content)>0 FROM public.knowledge_sources WHERE id=${lit(s.sourceId)};`),'t');
    });
    await t.test('canonical provenance or missing condition mismatch blocks before any provider call',async()=>{
      for(const mutation of ['metadata','content','filename','trust','section']){reset();const s=seed();
        const fields:Record<string,any>={metadata:{page:99},filename:{filename:'wrong.txt'},trust:{untrusted:false},section:{section:'invented'}};
        pg.sql(mutation!=='content'?`UPDATE public.knowledge_chunks SET metadata=metadata||${lit(fields[mutation])} WHERE source_id=${lit(s.sourceId)};`:
          `UPDATE public.knowledge_chunks SET content='Bring the item.' WHERE source_id=${lit(s.sourceId)};`);
        const p=fake();const c=indexer(p);assert.deepEqual(await c.indexSource(s),{status:'failed',reason:'configuration'});
        assert.equal(p.calls.length,0);assert.equal(state(s).state,'blocked');assert.equal(pg.sql(`SELECT status FROM public.knowledge_sources WHERE id=${lit(s.sourceId)};`),'ready');
        const claims=pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length;await c.indexSource(s);
        assert.equal(pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length,claims);
      }
    });
    await t.test('a source edit between snapshot and source reads is stale, not a terminal canonical failure',async()=>{
      reset();const s=seed();let changed=false;const base=pg.client;
      const client={...base,rpc:(name:string,args:any)=>{const q=base.rpc(name,args);
        if(name!=='read_knowledge_embedding_backfill_source'||changed)return q;
        return Promise.resolve(q).then(result=>{changed=true;pg.sql(`UPDATE public.knowledge_sources SET title='Revised title' WHERE id=${lit(s.sourceId)};`);return result;});}};
      const p=fake();assert.deepEqual(await indexer(p,limits,openai,new SupabaseSourceIndexRepository(client)).indexSource(s),{status:'failed',reason:'stale'});
      assert.equal(state(s),null);assert.equal(p.calls.length,0);
    });
    for(const kind of ['count','dimensions','NaN','Infinity','zero','provider','model','version'])await t.test(`malformed ${kind} vectors block without partial publication`,async()=>{
      reset();const s=seed();const p=fake(async texts=>{const v=vectors(texts);
        if(kind==='count')v.pop();else if(kind==='dimensions')v[0].values.pop();else if(kind==='NaN')v[0].values[0]=NaN;
        else if(kind==='Infinity')v[0].values[0]=Infinity;else if(kind==='zero')v[0].values.fill(0);
        else if(kind==='provider')v[0].provider='google';else if(kind==='model')v[0].model='other';else v[0].version=2;
        return v;});const c=indexer(p);
      assert.deepEqual(await c.indexSource(s),{status:'failed',reason:'invalid_vectors'});assert.equal(state(s).state,'blocked');
      assert.equal(ready(s).ready,false);assert.ok(stored(s).every((r:any[])=>r[2]===null));await c.indexSource(s);assert.equal(p.calls.length,1);
    });
    await t.test('pre-existing Google vectors and provider conversion remain blocked with no model calls',async()=>{
      reset();const s=seed();pg.sql(`UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(values))}::extensions.vector,
        embedding_provider='google',embedding_model='gemini-embedding-2',embedding_dimensions=768,embedding_version=1 WHERE source_id=${lit(s.sourceId)};`);
      const before=stored(s);const p=fake();const c=indexer(p);assert.equal((await c.indexSource(s)).reason,'existing_vectors_require_review');
      assert.equal(p.calls.length,0);assert.deepEqual(stored(s),before);assert.equal(ready(s).ready,false);
      const claims=pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length;await c.indexSource(s);assert.equal(pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length,claims);
    });
    await t.test('new Google identity is explicit, and later OpenAI targeting does not overwrite it',async()=>{
      reset();const s=seed();const p=fake(async texts=>vectors(texts,google));assert.equal((await indexer(p,limits,google).indexSource(s)).status,'ready');
      assert.equal(ready(s,google).ready,true);const before=stored(s);const other=fake();await indexer(other).indexSource(s);
      assert.equal(other.calls.length,0);assert.deepEqual(stored(s),before);assert.equal(ready(s,google).ready,true);
    });
    await t.test('expired old owner stops before a second batch and cannot fail the replacement owner',async()=>{
      reset();const s=seed(77,25);let replacement:any;
      const p=fake(async texts=>{expire(s);replacement=await repo().claim(s,openai,new AbortController().signal);return vectors(texts);});
      assert.deepEqual(await indexer(p).indexSource(s),{status:'failed',reason:'stale'});assert.equal(p.calls.length,1);
      assert.equal(state(s).lease_token,replacement.lease_token);assert.equal(state(s).state,'indexing');assert.ok(stored(s).every((r:any[])=>r[2]===null));
    });
    await t.test('shutdown aborts and fences publication; a fresh coordinator recovers after expiry',async()=>{
      reset();const s=seed();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
      const p=fake((_,options)=>new Promise((_,reject)=>{entered();options!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));
      const c=indexer(p);const running=c.indexSource(s);await Promise.race([started,running.then(out=>{throw new Error('Provider never entered: '+JSON.stringify(out));})]);c.stop();assert.equal((await running).reason,'cancelled');
      assert.ok(stored(s).every((r:any[])=>r[2]===null));await c.indexSource(s);assert.equal(p.calls.length,1);
      expire(s);const next=fake();assert.equal((await indexer(next).indexSource(s)).status,'ready');assert.equal(next.calls.length,1);
    });
    await t.test('watchdog quarantines an abort-ignoring call until it settles; no restart loop',async child=>{
      reset();const s=seed();let release!:()=>void;let count=0;
      const p=fake(texts=>++count===1?new Promise(resolve=>release=()=>resolve(vectors(texts))):Promise.resolve(vectors(texts)));
      const real=globalThis.setTimeout;
      child.mock.method(globalThis,'setTimeout',((fn:any,ms:number,...args:any[])=>real(fn,ms===20_000?20:ms,...args)) as any);
      const c=indexer(p);assert.equal((await c.indexSource(s)).reason,'provider_timeout');retry(s);
      await c.indexSource(s);assert.equal(p.calls.length,1);assert.ok(stored(s).every((r:any[])=>r[2]===null));
      release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await c.indexSource(s)).status,'ready');assert.equal(p.calls.length,2);
      assert.equal(c.usage().reservedRequests,2,'Unknown/aborted reservations are never refunded');
    });
    await t.test('three transient attempts exhaust durably; terminal credentials do not spin',async()=>{
      reset();const s=seed();const p=fake(async()=>{throw Object.assign(new Error('synthetic'),{status:503});});const c=indexer(p);
      for(let i=0;i<3;i++){assert.equal((await c.indexSource(s)).reason,'provider_failure');if(i<2)retry(s);}
      assert.equal(state(s).state,'failed');const claims=pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length;
      await c.indexSource(s);await indexer(p).indexSource(s);assert.equal(p.calls.length,3);assert.equal(pg.calls.filter(x=>x.name==='claim_knowledge_source_index_v1').length,claims);
      reset();const next=seed();const credentials=fake(async()=>{throw Object.assign(new Error('synthetic'),{status:401});});const other=indexer(credentials);
      assert.equal((await other.indexSource(next)).reason,'credentials');assert.equal(state(next).state,'blocked');await other.indexSource(next);assert.equal(credentials.calls.length,1);
    });
    await t.test('whole-job request/input admission occurs before claim; per-instance source cap is finite',async()=>{
      reset();const s=seed(77,25),p=fake();const c=indexer(p,{...limits,maxRequests:1});
      assert.equal((await c.indexSource(s)).reason,'budget_exhausted');assert.equal(state(s),null);assert.equal(p.calls.length,0);
      const small=indexer(p,{...limits,maxInputChars:1,maxInputBytes:1});assert.equal((await small.indexSource(s)).reason,'budget_exhausted');assert.equal(state(s),null);
      const one=indexer(p,{...limits,maxSources:1});assert.equal((await one.indexSource(seed())).status,'ready');await one.indexSource(seed());assert.equal(one.usage().sources,1);
      assert.equal(p.calls.length,1);assert.equal((await one.indexSource({...s,businessId:999})).status,'skipped');
    });
    await t.test('source allowlist and malformed cross-tenant snapshots stop before generation',async()=>{
      reset();const s=seed(88),p=fake();const c=indexer(p,{...limits,allowedBusinessIds:[77]});assert.equal((await c.indexSource(s)).reason,'scope');assert.equal(p.calls.length,0);
      const bad=repo();const prepare=bad.prepare.bind(bad);bad.prepare=async(...args)=>{const result=await prepare(...args);result.snapshot.chunks[0].businessId=99;return result;};
      assert.equal((await indexer(p,limits,openai,bad).indexSource(s)).reason,'stale');assert.equal(p.calls.length,0);
    });
    await t.test('keyset discovery moves beyond a blocked first page without claim/provider retries',async()=>{
      reset();for(let i=0;i<21;i++){const d=documentChunks(sections(),'synthetic.txt');const s=insert(77,'document','synthetic.txt',d.content,d.metadata,d.chunks,`11000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
        if(i<20)pg.sql(`INSERT INTO public.knowledge_source_index_state(business_id,source_id,state,target_revision,target_identity) VALUES(77,${lit(s.sourceId)},'blocked',public.knowledge_source_index_revision_v1(77,${lit(s.sourceId)}),${lit(openai)});`);
      }
      const p=fake();const c=indexer(p,{...limits,allowedBusinessIds:[77]});assert.equal((await c.recover()).length,20);assert.equal(p.calls.length,0);
      assert.deepEqual(await c.recover(),[{status:'ready',reason:'committed'}]);assert.equal(p.calls.length,1);
    });
    await t.test('lost completion acknowledgement retries only the identical SQL publication, not embeddings',async()=>{
      reset();const s=seed();let lost=true;const base=pg.client;
      const client={...base,rpc:(name:string,args:any)=>{const q=base.rpc(name,args);return name==='complete_knowledge_source_index_v1'&&lost?
        Promise.resolve(q).then(result=>{lost=false;return {...result,error:{message:'synthetic lost acknowledgement'}};}):q;}};
      const p=fake();assert.equal((await indexer(p,limits,openai,new SupabaseSourceIndexRepository(client)).indexSource(s)).status,'ready');
      assert.equal(p.calls.length,1);assert.equal(pg.calls.filter(x=>x.name==='complete_knowledge_source_index_v1'&&x.args.p_source_id===s.sourceId).length,2);assert.equal(state(s).attempts,1);
    });
    await t.test('two lost SQL acknowledgements preserve durable Ready and do not regenerate on restart',async()=>{
      reset();const s=seed();const base=pg.client;
      const client={...base,rpc:(name:string,args:any)=>{const q=base.rpc(name,args);return name==='complete_knowledge_source_index_v1'?
        Promise.resolve(q).then(result=>({...result,error:{message:'synthetic lost acknowledgement'}})):q;}};
      const p=fake();assert.equal((await indexer(p,limits,openai,new SupabaseSourceIndexRepository(client)).indexSource(s)).reason,'storage');
      assert.equal(ready(s).ready,true);assert.equal(p.calls.length,1);
      const next=fake();assert.equal((await indexer(next).indexSource(s)).status,'skipped');assert.equal(next.calls.length,0);
    });
    await t.test('accepted Phase 1 migration remains byte-identical and no customer/provider network ran',()=>{
      const validation=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/persistent-index-phase1-20261024/validation.json','utf8'));
      for(const [path,expected]of Object.entries(validation.new_implementation_test_files))
        assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),expected);
      assert.ok(pg.calls.every(c=>!/(booking|appointment|notify|sendMessage)/u.test(c.name)));
      assert.equal(network.mock.callCount(),0);
    });
  } finally {for(const c of coordinators)c.stop();pg.close();}
});
