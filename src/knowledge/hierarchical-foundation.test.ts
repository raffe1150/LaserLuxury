import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalAdapterContent,canonicalDocument,planCanonicalCoverage,canonicalTraversalComplete} from './documents/canonical';
import {HierarchicalSearchIndex,InMemorySearchGenerations} from './hierarchical-search';
import {hierarchicalFixture,policy} from '../../tests/helpers/hierarchical-foundation';
import {DocumentService} from './documents/service';
import {answerEvidence,parseAnswerUnits,parseRequestedFacets} from '../ai/business-information-answer-plan';
process.env.NODE_ENV='test';
process.env.ODINLINK_HIERARCHICAL_SEARCH='hierarchical-search-v1';
for(const format of ['pdf','txt','docx','html'])test(`shared canonical adapter boundary / ${format}`,async()=>{
  const f=await hierarchicalFixture(4,0,format);assert.equal(f.document.format,format);assert.equal(f.document.nodes.length,4);
  assert.equal(f.document.qualificationCompleteness,'UNCLASSIFIED');
  assert.equal(canonicalDocument(f.source).inventoryRoot,f.document.inventoryRoot);
  const structured=canonicalAdapterContent({format,adapterVersion:'v2',blocks:[{text:'Rules',kind:'heading'},
    {text:'Item | Condition\nA | B',kind:'table',parent:0,references:[2],cells:[{row:0,column:0,rowSpan:1,columnSpan:1,start:0,end:4,header:true}]},{text:'An exception applies.',kind:'exception',parent:0,references:[1]}]});
  const doc=canonicalDocument({...f.source,...structured});assert.equal(doc.nodes[1].parentId,doc.nodes[0].id);
  assert.deepEqual(doc.nodes[1].references,[doc.nodes[2].id]);assert.ok(doc.chunks.some(c=>c.text.includes('A | B')));assert.equal(doc.nodes[1].cells?.[0].header,true);
});
test('legacy segments remain compatible and do not invent hierarchy or scope classifications',async()=>{
 const f=await hierarchicalFixture();const source={...f.source,metadata:{segments:f.source.metadata.segments}};
 const doc=canonicalDocument(source);assert.equal(doc.structure,'legacy-flat');assert.equal(doc.qualificationCompleteness,'UNCLASSIFIED');
 assert.deepEqual(doc.chunks.map(c=>c.text),f.document.chunks.map(c=>c.text));
});
test('malformed hierarchy, cross-reference and source coverage maps fail closed',async()=>{
 const f=await hierarchicalFixture();
 for(const fault of ['cycle','foreign-reference','gap','scope','table-cell'] as const){
  const source=structuredClone(f.source),segments=source.metadata.segments as any[];
  if(fault==='cycle')segments[0].parent=1;
  if(fault==='foreign-reference')segments[0].references=[999];
  if(fault==='gap')segments.splice(1,1);
  if(fault==='scope')segments[0].scope='authoritative-complete';
  if(fault==='table-cell'){segments[0].kind='table';segments[0].cells=[{row:0,column:0,rowSpan:1,columnSpan:1,start:0,end:999999,header:true}];}
  assert.throws(()=>canonicalDocument(source),/canonical_document_invalid/);
 }
});
test('large inventory traversal accounts for distant conditions without claiming semantic completeness',async()=>{
 const f=await hierarchicalFixture(50),plan=planCanonicalCoverage(f.document);assert.equal(plan.batches.length,10);
 assert.equal(canonicalTraversalComplete(f.document,plan,f.document.chunks.map(c=>c.id)),true);
 assert.equal(canonicalTraversalComplete(f.document,plan,f.document.chunks.slice(0,49).map(c=>c.id)),false);
 assert.equal(canonicalTraversalComplete(f.document,{...plan,batches:plan.batches.slice(1)},f.document.chunks.map(c=>c.id)),false);
 assert.equal(plan.reviewState,'NOT_REVIEWED');
 for(const batch of plan.batches){assert.ok(batch.chunkIds.length<=5);assert.ok(batch.chunkIds.reduce((n,id)=>n+f.document.chunks.find(c=>c.id===id)!.text.length,0)<=9000);}
});
for(const count of [4,50])test(`off-request indexing and untranslated new customer requests / ${count}`,async()=>{
 const f=await hierarchicalFixture(count);const worker=new DocumentService(null,undefined,f.index);
 assert.equal((await worker.recoverIndex() as any[])[0].status,'ready');
 for(const q of ['اشیای باارزش چگونه ثبت می‌شوند؟','¿Cómo se registran los objetos de valor?']){
  const hit=await f.service.search(77,q);assert.ok(hit.length);assert.ok(hit.every(m=>m.text?.includes(policy)));
  const complete=await f.service.completeSelectedDocuments(77,hit,hit);assert.equal(complete?.length,count);
  const evidence=answerEvidence(77,complete!);assert.ok(evidence.length<=5&&evidence.every(e=>e.text.length<=2400));
  assert.ok(evidence.reduce((n,e)=>n+e.text.length,0)<=9000);assert.ok(complete!.every(m=>evidence.some(e=>e.text.includes(m.text!))));
  assert.ok(evidence.every(e=>!e.text.includes('objetos de valor')&&!e.text.includes('اشیای باارزش')),'Hints are never evidence');
 }
 assert.deepEqual(await f.service.search(77,'lost password recovery'),[]);assert.deepEqual(await f.service.search(88,'objetos de valor'),[]);
 const before=f.calls();await worker.recoverIndex();assert.equal(f.calls(),before,'No duplicate generation');
});
test('same contract supports Swedish canonical text with SCRIPTED Persian and Spanish hints',async()=>{
 const f=await hierarchicalFixture();const adapted=canonicalAdapterContent({format:'txt',adapterVersion:'SCRIPTED-sv',blocks:[
  {text:'Alla uppgifter är fiktiva och avsedda för test.',scope:'document'},
  {text:'Värdesaker registreras separat.'},{text:'Farliga föremål är undantagna.'},{text:'Föremålet måste beskrivas innan det lämnas ut.'}]});
 await f.storage.create({...f.source,...adapted,updatedAt:'2'});await f.index.recover();
 for(const q of ['اشیای باارزش چگونه ثبت می‌شوند؟','¿Cómo se registran los objetos de valor?']){
  const hit=await f.service.search(77,q);assert.ok(hit[0].text?.includes('Värdesaker registreras separat.'));
  assert.equal((await f.service.completeSelectedDocuments(77,hit,hit))?.length,4);
 }
});
test('source overflow keeps the full model boundary closed',async()=>{
 const f=await hierarchicalFixture(50,300);await f.index.recover();const hit=await f.service.search(77,'objetos de valor');assert.ok(hit.length);
 assert.equal(await f.service.completeSelectedDocuments(77,hit,hit),null);
});
for(const fault of ['stale','revoked','foreign','missing','competing-pending'] as const)test(`freshness denies ${fault}`,async()=>{
 const f=await hierarchicalFixture();await f.index.recover();const hit=await f.service.search(77,'objetos de valor');
 if(fault==='stale')await f.storage.create({...f.source,updatedAt:'2'});
 if(fault==='revoked')await f.storage.create({...f.source,status:'disabled'});
 if(fault==='missing')await f.storage.delete(77,f.source.id);
 if(fault==='foreign')hit[0]={...hit[0],businessId:88};
 if(fault==='competing-pending')await f.storage.create({...f.source,id:'other'});
 assert.deepEqual(await f.service.validateMatches(77,hit,{strictSources:true,requireCompleteDocumentContext:true}),[]);
});
test('unverified or forged producer output never becomes ready and is not retried',async()=>{
 const f=await hierarchicalFixture();f.producer.verify=async()=>({acceptedIds:[],reviewedChunkIds:[]});
 assert.equal((await f.index.recover())[0].status,'failed');assert.deepEqual(await f.service.search(77,'objetos de valor'),[]);
 const before=f.calls();await f.index.recover();assert.equal(f.calls(),before);
});
test('revocation removes a generation; restoring old bytes cannot reactivate the observed revoked generation',async()=>{
 const f=await hierarchicalFixture();await f.index.recover();await f.storage.create({...f.source,status:'disabled'});
 assert.deepEqual(await f.service.search(77,'objetos de valor'),[]);await f.storage.create(f.source);
 assert.deepEqual(await f.service.search(77,'objetos de valor'),[]);
});
test('late injected producer results cannot publish or start duplicate work',async()=>{
 const f=await hierarchicalFixture();let release!:(value:any)=>void;
 const producer={...f.producer,generate:async()=>new Promise(resolve=>{release=resolve;})};
 const index=new HierarchicalSearchIndex(id=>f.storage.list(id),f.repository,producer,{enabled:true,businessIds:[77],maxRequests:10,stageMs:5});
 const keepAlive=setTimeout(()=>{},50);
 try{
  assert.equal((await index.recover())[0].status,'failed');assert.equal(index.usage().requests,1);
  assert.deepEqual(await index.recover(),[]);release({hints:[]});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.repository.read(77,f.source.id),undefined);assert.equal(index.usage().requests,1);
 }finally{clearTimeout(keepAlive);index.stop();}
});
test('disabled worker, request budget and fabricated hint citations cannot grant authority',async()=>{
 const f=await hierarchicalFixture();const disabled=new HierarchicalSearchIndex(id=>f.storage.list(id),new InMemorySearchGenerations(),f.producer,{enabled:false,businessIds:[77],maxRequests:0});
 assert.deepEqual(await disabled.recover(),[]);assert.deepEqual(await disabled.discover(77,'objetos de valor'),[]);
 const limited=new HierarchicalSearchIndex(id=>f.storage.list(id),new InMemorySearchGenerations(),f.producer,{enabled:true,businessIds:[77],maxRequests:1});
 assert.deepEqual(await limited.recover(),[]);assert.equal(f.calls(),0);
 await f.index.recover();const hit=await f.service.search(77,'objetos de valor'),full=await f.service.completeSelectedDocuments(77,hit,hit);
 const evidence=answerEvidence(77,full!),facets=parseRequestedFacets([{subject:'valuables',attribute:'registration',questionType:'description'}]).facets;
 assert.equal(parseAnswerUnits({units:[{subject:'valuables',predicate:'registration',value:'separate',scope:'document',modality:'descriptive',negation:false,
  qualifiers:[],language:'es',text:'Los objetos de valor se registran por separado.',facetIds:['f1'],evidenceRefs:[{evidenceId:'hint-id',exactQuote:'objetos de valor'}]}]},facets,evidence,'es').units.length,0);
});

test('concurrent tenant searches cannot reuse another tenant generation or canonical anchor',async()=>{
 const f=await hierarchicalFixture();await f.index.recover();
 await f.storage.create({...f.source,businessId:88});
 const own=await f.service.search(77,'objetos de valor');
 const result=await Promise.all(Array.from({length:12},(_,i)=>f.service.search(i%2?88:77,'objetos de valor')));
 result.forEach((rows,i)=>i%2?assert.deepEqual(rows,[]):assert.ok(rows.every(r=>r.businessId===77)));
 assert.deepEqual(await f.service.validateMatches(88,own,{strictSources:true,captureRevision:true}),[]);
});
