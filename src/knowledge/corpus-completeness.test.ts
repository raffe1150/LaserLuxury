import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {KnowledgeService, SupabaseKnowledgeStorage} from '../../knowledge';

const row=(id:string,status='ready',businessId=77,content='Customer access is available.')=>({
 id,business_id:businessId,type:'document',title:id+'.txt',status,content,created_at:'2026-10-20',updated_at:'2026-10-20',
 metadata:{segments:[{start:0,end:content.length,page:1}]},
});
type Row=ReturnType<typeof row>;
type Fault='none'|'missing-count'|'invalid-count'|'error'|'network'|'partial-page'|'duplicate'|'foreign'|'revoked'|'under-count';
function backend(rows:Row[],cap=1000,fault:Fault='none') {
 const calls:Array<{url:URL,prefer:string}>=[];
 const client=createClient('https://synthetic.invalid','synthetic-local-only',{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:async(input,init)=>{
   const url=new URL(String(input)),prefer=new Headers(init?.headers).get('prefer')||'';calls.push({url,prefer});
   assert.equal(url.pathname,'/rest/v1/knowledge_sources');assert.equal(init?.method||'GET','GET');
   if(url.searchParams.has('business_id'))assert.equal(url.searchParams.get('business_id'),'eq.77');
   else assert.equal(url.searchParams.get('select'),'id','Only the existing availability probe may be unscoped');
   const proof=prefer.includes('count=exact');
   if(proof&&fault==='network')throw Error('synthetic offline transport failure');
   if(proof&&fault==='error')return new Response(JSON.stringify({code:'XX000',message:'synthetic backend error'}),{status:400});
   let filtered=rows.filter(r=>r.business_id===77);
   if(url.searchParams.has('status'))filtered=filtered.filter(r=>'eq.'+r.status===url.searchParams.get('status'));
   const count=filtered.length;
   let data=filtered.slice(0,Math.min(cap,Number(url.searchParams.get('limit')||cap)));
   if(proof&&fault==='partial-page')data=data.slice(1);
   if(proof&&fault==='duplicate'&&data.length>1)data=[data[0],data[0]];
   if(proof&&fault==='foreign')data=data.map(r=>({...r,business_id:88}));
   if(proof&&fault==='revoked')data=data.map(r=>({...r,status:'disabled'}));
   const headers:Record<string,string>={'Content-Type':'application/json'};
   if(fault!=='missing-count'||!proof)headers['Content-Range']=`0-${Math.max(0,data.length-1)}/${proof&&fault==='invalid-count'?'*':proof&&fault==='under-count'?0:count}`;
   return new Response(JSON.stringify(data),{status:200,headers});
  }},
 });
 const storage=new SupabaseKnowledgeStorage(client),service=new KnowledgeService(storage,storage,null,true);
 return {storage,service,calls};
}
const anchor={sourceId:'visible',businessId:77,text:'Customer access is available.',score:1,metadata:{page:1}};
for(const total of [999,1000,1001,1500])test(`inventory overflow retains semantic retrieval rather than hide a conflicting ready source / ${total} rows`,async()=>{
 const conflict='Customer access is unavailable during building work.';
 const rows=[row('visible'),...Array.from({length:total-2},(_,i)=>row('deleted-'+i,'deleted')),row('older-conflict','ready',77,conflict)];
 const {storage,service,calls}=backend(rows);
 const oldReady=(await storage.list(77)).filter(s=>s.status==='ready');
 assert.equal(oldReady.length,total>1000?1:2,'Reproduce the old all-status listing cap');
 assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
 const proofs=calls.filter(c=>c.prefer.includes('count=exact'));
 assert.equal(proofs.length,1,'One bounded data+count request, not a count-only query or pagination loop');
 assert.equal(proofs[0].url.searchParams.has('status'),false,'Prove the same all-status inventory used by freshness checks');
 assert.equal(proofs[0].url.searchParams.get('limit'),'5');
});
test('small complete production corpus retains a conflicting source through freshness validation',async()=>{
 const conflict='Customer access is unavailable during building work.';
 const {service,calls}=backend([row('visible'),row('conflict','ready',77,conflict)]);
 const complete=await service.completeSmallCorpus(77,[anchor]);assert.ok(complete);
 assert.deepEqual(new Set(complete.map(m=>m.sourceId)),new Set(['visible','conflict']));
 const current=await service.validateMatches(77,complete,{strictSources:true});
 assert.equal(current.length,2);assert.ok(current.some(m=>m.text===conflict));
 assert.equal(calls.filter(c=>c.prefer.includes('count=exact')).length,1);
});
for(const fault of ['missing-count','invalid-count','error','network','partial-page','duplicate','foreign','revoked','under-count']as const)
 test(`incomplete or unproven ready-source inventory fails closed / ${fault}`,async()=>{
  const {service,calls}=backend([row('visible'),row('condition','ready',77,'Advance approval is required.')],1000,fault);
  assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
  assert.equal(calls.filter(c=>c.prefer.includes('count=exact')).length,1,'Proof failures never start a retry');
 });
test('backend cap smaller than the exact ready count cannot opt in',async()=>{
 const {service}=backend([row('visible'),row('condition')],1);
 assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
});
for(const ready of [6,999,1000,1001])test(`ready inventory overflow fails closed even when only five rows are returned / ${ready} ready`,async()=>{
 const {service}=backend([row('visible'),...Array.from({length:ready-1},(_,i)=>row('other-'+i))]);
 assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
});
test('deleted, disabled and foreign rows never leak into ready-source context',async()=>{
 const {service}=backend([row('visible'),row('deleted','deleted'),row('revoked','disabled'),row('foreign','ready',88)]);
 const complete=await service.completeSmallCorpus(77,[anchor]);assert.ok(complete);
 assert.deepEqual(complete.map(m=>m.sourceId),['visible']);
 assert.equal(await service.completeSmallCorpus(77,[{...anchor,businessId:88}]),null);
});
test('stale and revoked lexical anchors cannot establish a complete corpus',async()=>{
 const {service}=backend([row('visible'),row('revoked','disabled')]);
 assert.equal(await service.completeSmallCorpus(77,[{...anchor,metadata:{page:1,documentRevision:'old-revision'}}]),null);
 assert.equal(await service.completeSmallCorpus(77,[{...anchor,sourceId:'revoked'}]),null);
});
test('custom storage without exhaustive inventory capability never falls back to trusting list()',async()=>{
 const {storage}=backend([row('visible')]);
 const unknown=Object.create(storage);Object.defineProperty(unknown,'listReadyComplete',{value:undefined});
 const service=new KnowledgeService(unknown,unknown,null,true);
 assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
});
test('ready-only completeness must not opt in when the ordinary freshness inventory is capped',async t=>{
 const {service}=backend([row('visible'),...Array.from({length:999},(_,i)=>row('deleted-'+i,'deleted')),row('older-conflict')]);
 const complete=await service.completeSmallCorpus(77,[anchor]);
 if(complete){
  const current=await service.validateMatches(77,complete,{strictSources:true});
  t.diagnostic(JSON.stringify({completeSourceIds:complete.map(m=>m.sourceId),currentSourceIds:current.map(m=>m.sourceId)}));
 }
 assert.equal(complete,null,'Retain semantic retrieval unless ordinary source reads can see the same bounded inventory');
});
