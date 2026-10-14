import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { DocumentEvidenceRegistry } from './evidence-registry';
const texts = {
  sv: 'Avbokningar kräver 24 timmars framförhållning.', en: 'Cancellations require 24 hours notice.',
  de: 'Stornierungen erfordern eine Vorlaufzeit von 24 Stunden.', es: 'Las cancelaciones requieren un aviso de 24 horas.',
  fa: 'لغو به اطلاع ۲۴ ساعت قبل نیاز دارد.', ar: 'يتطلب الإلغاء إشعاراً قبل ٢٤ ساعة.',
};
const questions = {
  sv: 'Hur lång framförhållning krävs för avbokning?', en: 'How much notice is required for cancellation?',
  de: 'Welche Frist gilt für eine Stornierung?', es: '¿Con cuánto tiempo de antelación debo cancelar?',
  fa: 'برای لغو چقدر زود باید اطلاع دهم؟', ar: 'كم من الوقت يجب أن أخطركم قبل الإلغاء؟',
};
function document(content: string, id='doc', businessId=1, status:KnowledgeSource['status']='ready'):KnowledgeSource {
  return {id,businessId,type:'document',title:'Synthetic policy.pdf',status,content,createdAt:'2026-10-13',updatedAt:'2026-10-13',
    metadata:{segments:[{start:0,end:content.length,page:2}]}};
}
const vector=(provider:string, axis=0)=>({provider,model:'synthetic-multilingual',dimensions:2,version:1,values:axis?[0,1]:[1,0]});
for(const provider of ['openai','gemini']) test(`${provider}: six question languages retrieve all six document languages (simulated embeddings)`,async()=>{
  const storage=new InMemoryKnowledgeStorage();const calls:string[]=[];
  const embeddings={supportsLocalSemanticSearch:true,
    embedQuery:async(q:string)=>vector(provider,Object.values(questions).includes(q)?0:1),
    embedDocuments:async(batch:string[])=>{calls.push(...batch);return batch.map(text=>vector(provider,Object.values(texts).includes(text)?0:1));}};
  const service=new KnowledgeService(storage,storage,embeddings);
  for(const [language,text] of Object.entries(texts))await storage.create(document(text,language));
  await storage.create(document('Foreign private policy','foreign',2));
  for(const question of Object.values(questions)) {
    const matches=await service.semanticSearch(1,question,10);
    assert.equal(matches.length,6);
    for(const match of matches){assert.equal(match.businessId,1);assert.equal(match.metadata?.page,2);assert.equal(match.metadata?.untrusted,true);assert.ok(match.metadata?.documentRevision);}
  }
  assert.deepEqual(await service.semanticSearch(1,'Unrelated question about Bitcoin payments'),[]);
  assert.equal(calls.includes('Foreign private policy'),false);
});
test('current document publication rejects stale text, forged provenance and every non-ready/foreign state',async()=>{
  const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);
  const original=document(texts.en);await storage.create(original);
  storage.search=async()=>[{sourceId:'doc',businessId:1,text:texts.en,metadata:{page:2}}];
  const matches=await service.search(1,'cancellations');assert.equal(matches.length,1);
  await storage.create(document('Cancellations now require 48 hours notice.'));
  assert.deepEqual(await service.validateMatches(1,matches),[]);
  await storage.create(original);storage.search=async()=>[{sourceId:'doc',businessId:1,text:texts.en,metadata:{page:99}}];
  assert.deepEqual(await service.search(1,'cancellations'),[]);
  for(const status of ['pending','processing','failed','deleted','disabled','error'] as const){await storage.create(document(texts.en,'doc',1,status));assert.deepEqual(await service.validateMatches(1,matches),[]);}
  await storage.create(document(texts.en,'doc',2));assert.deepEqual(await service.validateMatches(1,matches),[]);
});
test('document evidence registry excludes changed, deleted, foreign and expired captured evidence',async()=>{
  const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);
  await storage.create(document(texts.en));storage.search=async()=>[{sourceId:'doc',businessId:1,text:texts.en,metadata:{page:2}}];
  const matches=await service.search(1,'policy');const registry=new DocumentEvidenceRegistry();const text='untrusted_document_text: synthetic';
  registry.register(1,text,matches);const validate=(id:number,m:any[])=>service.validateMatches(id,m);
  assert.equal(await registry.current(1,text,validate),true);assert.equal(await registry.current(2,text,validate),false);
  const now=Date.now;const captured=Date.now();
  try{Date.now=()=>captured+120001;assert.equal(await registry.current(1,text,validate),false);}finally{Date.now=now;}
  await storage.delete(1,'doc');assert.equal(await registry.current(1,text,validate),false);
  assert.equal(await registry.current(1,'untrusted_document_text: unregistered',validate),false);
  assert.equal(await registry.current(1,'manual knowledge',validate),true);
});
test('embedding failure is safe and lexical/manual Knowledge continues working',async()=>{
  const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage,{embedQuery:async()=>{throw Error('offline failure');},embedDocuments:async()=>[]});
  const manual=await service.addSource({businessId:1,type:'text',title:'Manual',content:'Parking is behind the studio.',status:'ready'});
  assert.equal((await service.search(1,'parking'))[0].sourceId,manual.id);
  assert.deepEqual(await service.semanticSearch(1,questions.fa),[]);
});

test('document index failure preserves existing persisted manual semantic matches',async()=>{
  const storage=new InMemoryKnowledgeStorage();const manual={...document('Manual parking fact','manual'),type:'text' as const,metadata:{}};
  await storage.create(manual);await storage.create(document(texts.en));
  const primary:any=storage;primary.semanticSearch=async()=>[{sourceId:'manual',businessId:1,text:manual.content,score:1,metadata:{}}];
  const service=new KnowledgeService(primary,storage,{embedQuery:async()=>vector('google'),embedDocuments:async()=>{throw Error('synthetic document index outage');}});
  assert.equal((await service.semanticSearch(1,'parking'))[0].sourceId,'manual');
});
