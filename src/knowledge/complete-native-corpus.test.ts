import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryKnowledgeStorage,KnowledgeService,SupabaseKnowledgeStorage} from '../../knowledge';
import {documentChunks} from './documents/service';
import {packDocumentEvidence} from './document-evidence-packing';
async function fixture(){
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage,storage,null);
 for(const [id,texts] of [['pdf',Array.from({length:5},(_,i)=>'Section '+i+' '+(i===2?'Normally up to 21 days. Valuables registered separately. Describe before collection.':'Fictional test conditions.'))],['txt',['Independent competing source conditions.']]] as const){
  const parsed=documentChunks(texts.map((text,i)=>({text,page:i+1})),id+'.txt');
  await storage.create({id,businessId:77,type:'document',title:id+'.txt',status:'ready',content:parsed.content,metadata:parsed.metadata,createdAt:'2026',updatedAt:'2026'});
 }
 return{storage,service};
}
test('native exhaustive inventory admits five PDF chunks plus TXT without a lexical anchor',async()=>{
 const f=await fixture(),before=JSON.stringify(await f.storage.list(77));
 assert.equal(await f.service.completeSmallCorpus(77,[]),null,'Legacy lexical opt-in stays unchanged');
 const result=await f.service.completeSmallCorpus(77,[],undefined,'native-documentary');
 assert.equal(result?.length,6);assert.ok(packDocumentEvidence(result!)!.length<=5);
 assert.deepEqual(new Set(result?.map(m=>m.sourceId)),new Set(['pdf','txt']));
 assert.ok(result?.every(m=>m.businessId===77&&m.metadata?.documentRevision));
 assert.equal(JSON.stringify(await f.storage.list(77)),before);
});
for(const fault of ['foreign','broken-map','chunk-overflow','character-overflow','non-document','inventory-truncated'] as const)
 test('native exhaustive inventory declines '+fault,async()=>{
  const f=await fixture(),sources=await f.storage.list(77),pdf=sources.find(s=>s.id==='pdf')!;
  if(fault==='foreign')f.storage.listReadyComplete=async()=>sources.map(s=>({...s,businessId:88}));
  if(fault==='broken-map')await f.storage.create({...pdf,metadata:{segments:[]}});
  if(fault==='chunk-overflow'){const parsed=documentChunks(Array.from({length:6},(_,i)=>({text:'Section '+i,page:i+1})),pdf.title);await f.storage.create({...pdf,content:parsed.content,metadata:parsed.metadata});}
  if(fault==='character-overflow')await f.storage.create({...pdf,content:'x'.repeat(9001)});
  if(fault==='non-document')await f.storage.create({...pdf,type:'text'});
  if(fault==='inventory-truncated')f.storage.listReadyComplete=async()=>null;
  assert.equal(await f.service.completeSmallCorpus(77,[],undefined,'native-documentary'),null);
 });
test('native inventory read errors remain distinguishable from declined inventory',async()=>{
 const f=await fixture();f.storage.listReadyComplete=async()=>{throw Error('read failure');};
 await assert.rejects(f.service.completeSmallCorpus(77,[],undefined,'native-documentary'));
});

for(const fault of ['error','truncated','foreign','duplicate'] as const)test('Supabase complete-inventory proof '+fault,async()=>{
 const row={id:'pdf',business_id:fault==='foreign'?88:77,type:'document',title:'Guide',status:'ready',content:'Policy',metadata:{segments:[{start:0,end:6}]},created_at:'2026',updated_at:'2026'};
 const response={data:fault==='duplicate'?[row,row]:[row],error:fault==='error'?{message:'private database detail'}:null,count:fault==='truncated'?6:fault==='duplicate'?2:1};
 const query:any={select(_columns:string,options:any){assert.equal(options.count,'exact');return this;},eq(key:string,id:number){assert.equal(key,'business_id');assert.equal(id,77);return this;},neq(key:string,value:string){assert.equal(key,'status');assert.equal(value,'deleted');return this;},order(){return this;},limit(n:number){assert.equal(n,5);return this;},retry(value:boolean){assert.equal(value,false);return this;},then(resolve:any,reject:any){return Promise.resolve(response).then(resolve,reject);}};
 const storage=new SupabaseKnowledgeStorage({from(name:string){assert.equal(name,'knowledge_sources');return query;}});
 if(fault==='error'){
  assert.equal(await storage.listReadyComplete(77,5),null,'Legacy callers keep null-on-error behavior');
  await assert.rejects(storage.listReadyComplete(77,5,undefined,true),/knowledge_inventory_read/);
 }else assert.equal(await storage.listReadyComplete(77,5,undefined,true),null);
});
