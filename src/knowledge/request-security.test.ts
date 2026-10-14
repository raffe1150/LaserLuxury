import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestSecurity } from './request-security';
import { DocumentEvidenceRegistry } from './evidence-registry';
test('captured evidence is immutable and survives registry expiry/eviction; missing snapshots fail closed',async()=>{
  const registry=new DocumentEvidenceRegistry();const text='untrusted_document_text: synthetic';
  const matches=[{sourceId:'doc',businessId:1,text:'Synthetic fact',metadata:{source:'document',documentRevision:'1'}}];
  registry.register(1,text,matches);const snapshot=registry.capture(1,text)!;
  matches[0].text='tampered';assert.equal(snapshot.matches[0].text,'Synthetic fact');assert.ok(Object.isFrozen(snapshot.matches[0].metadata));
  registry.clear();assert.equal(await registry.validate(snapshot,1,text,async(_id,m)=>m),true);
  assert.equal(await registry.validate(null,1,text,async(_id,m)=>m),false);
  assert.equal(await registry.validate(snapshot,2,text,async(_id,m)=>m),false);
});
test('tool permissions never expand with state changes; document requests offer no tools',async()=>{
  const security=new RequestSecurity<any>();
  await security.run(async()=>{security.bind('same');security.capture({businessId:1},false,null);security.offer(['checkSlots']);
    assert.deepEqual(security.authorize(['checkSlots','logSystemAnalysis'],['checkSlots','logSystemAnalysis']),['checkSlots']);
    assert.deepEqual(security.authorize(['checkSlots'],[]),[]);
  });
  await security.run(async()=>{security.bind('same');security.capture({businessId:1},true,null);security.offer(['logSystemAnalysis']);assert.deepEqual(security.authorize(['logSystemAnalysis'],['logSystemAnalysis']),[]);});
  assert.equal(security.active('same'),false);
});
test('overlapping requests are isolated and old/expired invocations cannot dispatch',async()=>{
  const security=new RequestSecurity<any>();let enter!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>enter=r),done=new Promise<void>(r=>release=r);
  const first=security.run(async()=>{security.bind('same');security.capture(null,false,null);security.offer(['checkSlots']);enter();await done;assert.equal(security.current(),false);assert.deepEqual(security.authorize(['checkSlots'],['checkSlots']),[]);});
  await started;
  await security.run(async()=>{security.bind('same');security.capture(null,false,null);security.offer(['logSystemAnalysis']);assert.deepEqual(security.authorize(['checkSlots'],['checkSlots','logSystemAnalysis']),[]);assert.equal(security.active('same'),true);});
  release();await first;assert.equal(security.active('same'),false);
  await security.run(async()=>{security.bind('expiry');security.capture(null,false,null);security.offer(['checkSlots']);const original=Date.now,start=Date.now();try{Date.now=()=>start+300001;assert.deepEqual(security.authorize(['checkSlots'],['checkSlots']),[]);}finally{Date.now=original;}});
});
