import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {KnowledgeService, SupabaseKnowledgeStorage} from '../../knowledge';
import {capturedSources} from '../../tests/helpers/multidoc-production-inventory';

const row=(id:string,status='ready',businessId=77,content='Customer access is available.')=>({
 id,business_id:businessId,type:'document',title:id+'.txt',status,content,created_at:'2026-10-20',updated_at:'2026-10-20',
 metadata:{segments:[{start:0,end:content.length,page:1}]},
});
type Row=ReturnType<typeof row>;
type Fault='none'|'missing-count'|'invalid-count'|'error'|'network'|'partial-page'|'duplicate'|'foreign'|'revoked'|'under-count';
function backend(rows:Row[],cap=1000,fault:Fault='none',businessId=77) {
 const calls:Array<{url:URL,prefer:string}>=[];
 const client=createClient('https://synthetic.invalid','synthetic-local-only',{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:async(input,init)=>{
   const url=new URL(String(input)),prefer=new Headers(init?.headers).get('prefer')||'';calls.push({url,prefer});
   assert.equal(url.pathname,'/rest/v1/knowledge_sources');assert.equal(init?.method||'GET','GET');
   if(url.searchParams.has('business_id'))assert.equal(url.searchParams.get('business_id'),'eq.'+businessId);
   else assert.equal(url.searchParams.get('select'),'id','Only the existing availability probe may be unscoped');
   const proof=prefer.includes('count=exact');
   if(proof&&fault==='network')throw Error('synthetic offline transport failure');
   if(proof&&fault==='error')return new Response(JSON.stringify({code:'XX000',message:'synthetic backend error'}),{status:400});
   let filtered=rows.filter(r=>r.business_id===businessId);
   const status=url.searchParams.get('status');
   if(status) {
    assert.ok(status.startsWith('eq.')||status.startsWith('neq.'));
    filtered=filtered.filter(r=>status.startsWith('neq.')?r.status!==status.slice(4):r.status===status.slice(3));
   }
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
for(const total of [999,1000,1001,1500])test(`deleted rows cannot hide either conflicting ready source / ${total} rows`,async()=>{
 const conflict='Customer access is unavailable during building work.';
 const rows=[row('visible'),...Array.from({length:total-2},(_,i)=>row('deleted-'+i,'deleted')),row('older-conflict','ready',77,conflict)];
 const {storage,service,calls}=backend(rows);
 const ready=(await storage.list(77)).filter(s=>s.status==='ready');
 assert.equal(ready.length,2,'Exclude tombstones before the backend response cap');
 const complete=await service.completeSmallCorpus(77,[anchor]);assert.ok(complete);
 assert.deepEqual(new Set(complete.map(m=>m.sourceId)),new Set(['visible','older-conflict']));
 assert.equal((await service.validateMatches(77,complete,{strictSources:true})).length,2);
 const proofs=calls.filter(c=>c.prefer.includes('count=exact'));
 assert.equal(proofs.length,1,'One bounded data+count request, not a count-only query or pagination loop');
 assert.equal(proofs[0].url.searchParams.get('status'),'neq.deleted','Proof and freshness use the same non-deleted inventory');
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
test('proof and ordinary freshness both retain older conditions behind tombstones',async()=>{
 const {service}=backend([row('visible'),...Array.from({length:999},(_,i)=>row('deleted-'+i,'deleted')),row('older-conflict')]);
 const complete=await service.completeSmallCorpus(77,[anchor]);
 assert.ok(complete);
 const current=await service.validateMatches(77,complete,{strictSources:true});
 assert.deepEqual(new Set(current.map(m=>m.sourceId)),new Set(['visible','older-conflict']));
});

test('captured two-PDF inventory survives soft deletion of only the old PDF',async t=>{
 const rows:Row[]=[...structuredClone(capturedSources),...Array.from({length:5},(_,i)=>row('tombstone-'+i,'deleted',3,''))];
 const {service,storage}=backend(rows,1000,'none',3);
 const before=await service.completeSmallCorpus(3,[],undefined,'native-documentary');
 const old=rows.find(r=>r.id==='8eec8b5c-87bc-4a7b-9789-b65d977b5ae4')!;
 // Local-only equivalent of the deployed transition RPC; no database calls.
 old.status='deleted';old.content='';old.metadata={segments:[]};
 const after=await service.completeSmallCorpus(3,[],undefined,'native-documentary');
 t.diagnostic(JSON.stringify({before:before?.length??null,after:after?.length??null}));
 assert.equal(before?.length,8);
 assert.equal(after?.length,3);
 assert.ok(after!.every(m=>m.sourceId==='2ac009ba-c913-48bc-b13d-c09adf34c8e0'&&m.businessId===3));
 assert.ok(after!.some(m=>m.text.includes('cirka 10 minuter före')));
 const current=await service.validateMatches(3,after!,{strictSources:true,captureRevision:true,requireCompleteDocumentContext:true});
 assert.equal(current.length,3);
 assert.equal((await storage.list(3)).length,1);
 const remaining=rows.find(r=>r.id==='2ac009ba-c913-48bc-b13d-c09adf34c8e0')!;
 remaining.status='deleted';remaining.content='';remaining.metadata={segments:[]};
 assert.deepEqual(await service.validateMatches(3,after!,{strictSources:true}),[]);
 assert.equal(await service.completeSmallCorpus(3,[],undefined,'native-documentary'),null);
});

for(const status of ['pending','failed','disabled','error'])test(`non-deleted ${status} rows still count toward the bounded inventory`,async()=>{
 const {service}=backend([row('visible'),...Array.from({length:5},(_,i)=>row('unready-'+i,status))]);
 assert.equal(await service.completeSmallCorpus(77,[anchor]),null);
});

test('integration keeps the five-active-source limit despite deleted rows',async()=>{
 const rows=[...Array.from({length:5},(_,i)=>row('ready-'+i)),...Array.from({length:6},(_,i)=>row('deleted-'+i,'deleted'))];
 const {service}=backend(rows);
 const five=await service.completeSmallCorpus(77,[],undefined,'native-documentary');
 assert.equal(five?.length,5);
 assert.deepEqual(new Set(five!.map(m=>m.sourceId)),new Set(rows.filter(r=>r.status==='ready').map(r=>r.id)));
 assert.equal((await service.validateMatches(77,five!,{strictSources:true,requireCompleteDocumentContext:true})).length,5);
 rows.push(row('sixth-ready'));
 assert.equal(await service.completeSmallCorpus(77,[],undefined,'native-documentary'),null);
});

test('complete corpus keeps five canonical chunks but rejects an otherwise small sixth chunk', async () => {
 const text = anchor.text;
 const content = Array.from({length: 6}, (_, index) => index ? `Additional customer condition ${index}.` : text).join('\n');
 const lines = content.split('\n');
 const fixture = (count:number) => {
  let start = 0;
  const segments = lines.slice(0,count).map((line,index) => {
   const segment = {start,end:start+line.length,page:index+1};
   start=segment.end+1;
   return segment;
  });
  return backend([{...row('visible'),content:content.slice(0,segments.at(-1)!.end),metadata:{segments}}]).service;
 };
 const five = await fixture(5).completeSmallCorpus(77,[anchor]);
 assert.equal(five?.length,5);
 assert.deepEqual(five?.map(m=>m.text),lines.slice(0,5));
 assert.equal(await fixture(6).completeSmallCorpus(77,[anchor]),null);
 assert.equal(await fixture(5).completeSmallCorpus(77,[]),null);
});

test('complete corpus rejects oversized source text even when the canonical evidence is short', async () => {
 const content = anchor.text.padEnd(9001,' ');
 const source = {...row('visible'),content,metadata:{segments:[{start:0,end:anchor.text.length,page:1}]}};
 assert.equal(await backend([source]).service.completeSmallCorpus(77,[anchor]),null);
});
