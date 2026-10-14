import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeService, InMemoryKnowledgeStorage, SupabaseKnowledgeStorage } from '../../../knowledge';
import { DOCUMENT_TEXT, DOCUMENT_TRANSLATIONS, documentErrorMessage } from '../../i18n/knowledge-documents';

test('lexical retrieval rejects missing/foreign ownership, unknown source IDs and every non-ready state', async () => {
  const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage,storage);
  const source = await service.addSource({businessId:1,type:'text',title:'Manual',content:'Policy notice 24 hours',status:'ready'});
  storage.search=async()=>[
    {sourceId:source.id,businessId:1,text:'Policy notice'},
    {sourceId:source.id,businessId:2,text:'Foreign'},
    {sourceId:source.id,businessId:undefined!,text:'Unowned'},
    {sourceId:'unknown',businessId:1,text:'Missing source'},
  ];
  assert.equal((await service.search(1,'Policy')).length,1);
  for (const status of ['pending','processing','failed','deleted','disabled','error'] as const) {
    await storage.create({...source,status}); assert.deepEqual(await service.search(1,'Policy'),[]);
  }
});
test('enabled document ingestion cannot initialize a fallback store',async()=>{
  const fallback=new InMemoryKnowledgeStorage();let used=false;fallback.initialize=async()=>{used=true;};
  await assert.rejects(new KnowledgeService(new InMemoryKnowledgeStorage(),fallback,null,true).initialize());
  const primary=new SupabaseKnowledgeStorage({from:()=>({select:()=>({limit:async()=>({error:{message:'unavailable'}})})})});
  await assert.rejects(new KnowledgeService(primary,fallback,null,true).initialize());assert.equal(used,false);
});
test('manual creation/deletion remains available; generic paths reject document ingestion',async()=>{
  const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);
  await assert.rejects(service.addSource({businessId:1,type:'document',title:'bad',status:'ready',content:'bad'}));
  const source=await service.addSource({businessId:1,type:'text',title:'Manual',content:'Policy',status:'ready'});
  assert.equal((await service.search(1,'Policy')).length,1);
  assert.equal(await service.deleteSource(2,source.id),false);assert.equal(await service.deleteSource(1,source.id),true);
});
test('document messages have complete distinct translations for all five non-English locales',()=>{
  for (const [locale,values] of Object.entries(DOCUMENT_TRANSLATIONS)) {
    assert.equal(values.length,DOCUMENT_TEXT.length,locale);assert.ok(values.every((v,i)=>v.length>0 && v!==DOCUMENT_TEXT[i]),locale);
  }
  assert.equal(documentErrorMessage(new Error('{"error":"document_size"}')),DOCUMENT_TEXT[11]);
  assert.equal(documentErrorMessage({code:'document_sensitive'}),DOCUMENT_TEXT[18]);
});
