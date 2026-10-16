import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSearchMatch } from '../../knowledge';
import { revalidateKnowledgeSourceIds } from './evidence-registry';

const a = { businessId: 77, sourceId: 'a', text: 'Parking nearby.', metadata: { source: 'document', documentRevision: 'v1' } };
const a2 = { ...a, text: 'Visits by agreement.' };
const b = { ...a, sourceId: 'b', text: 'Some services are digital.' };
for (const fault of ['missing', 'stale', 'foreign', 'duplicate', 'changed-text', 'missing-chunk'] as const) test(`source batch/${fault}: quarantine the entire affected source, preserve independent source`, async () => {
 const original = [a, a2, b]; let calls = 0;
 const valid = await revalidateKnowledgeSourceIds(77, original, async (id, matches) => {
  calls++; assert.equal(id, 77); assert.notEqual(matches, original);
  return matches.flatMap(m => m.sourceId === 'b' ? [m] : fault === 'missing' ? [] :
   fault === 'stale' ? [{ ...m, metadata: { ...m.metadata, documentRevision: 'v2' } }] :
   fault === 'foreign' ? [{ ...m, businessId: 88 }] : fault === 'duplicate' ? [m, m] :
   fault === 'changed-text' ? [{ ...m, text: `${m.text} Changed.` }] : m.text === a2.text ? [] : [m]);
 });
 assert.deepEqual([...valid], ['b']); assert.equal(calls, 1); assert.equal(a.metadata.documentRevision, 'v1');
});
test('source batch: ordering is immaterial and unexpected rows cannot expand authority', async () => {
 const valid = await revalidateKnowledgeSourceIds(77, [a,a2,b], async (_id,m) => [...m.reverse(), { ...b, sourceId:'unexpected' }]);
 assert.deepEqual([...valid].sort(), ['a','b']);
});
for (const fault of ['error','malformed','mutating-validator'] as const) test(`source batch/${fault}: fail closed without mutating captured authority`, async () => {
 const original = structuredClone([a,b]);
 const valid = await revalidateKnowledgeSourceIds(77, original, async (_id,m):Promise<KnowledgeSearchMatch[]> => {
  if(fault === 'error') throw new Error('synthetic');
  if(fault === 'malformed') return null as any;
  m.forEach(row => { row.text = 'Unsupported replacement.'; }); return m;
 });
 assert.equal(valid.size,0); assert.deepEqual(original,[a,b]);
});
test('source batch: captured foreign rows cannot be authorized by a validator', async () => {
 assert.equal((await revalidateKnowledgeSourceIds(77,[{...a,businessId:88}],async(_id,m)=>m)).size,0);
});

for(const type of ['text','website'] as const) for(const fault of ['content','outside-chunk','revision','revoked','deleted','foreign'] as const) test(`${type}/${fault}: real storage revalidation rejects changed source while preserving independent source and legacy contract`, async () => {
 const storage = new InMemoryKnowledgeStorage(), service = new KnowledgeService(storage);
 const source = await service.addSource({businessId:77,type,title:'Synthetic',content:`Parking nearby. ${'Additional information. '.repeat(150)}`,status:'ready'});
 const other = await service.addSource({businessId:77,type,title:'Other',content:'Some services are digital.',status:'ready'});
 const retrieved = await service.search(77,'Parking nearby'); assert.ok(retrieved.some(m=>m.sourceId===source.id));
 const first = retrieved.find(m=>m.sourceId===source.id)!;
 const captured = await service.validateMatches(77,[first,{businessId:77,sourceId:other.id,text:other.content,metadata:{source:type}}],{strictSources:true,captureRevision:true});
 assert.equal(captured.length,2); assert.match(String(captured[0].metadata?.sourceRevision),/^[a-f0-9]{64}$/);
 assert.equal((await service.validateMatches(77,[first],{strictSources:true})).length,0,'unbound strict source cannot be used');
 if(fault==='deleted') await storage.delete(77,source.id);
 else await storage.create({...source,
  ...(fault==='content'?{content:'There is no parking.'}:{}),
  ...(fault==='outside-chunk'?{content:source.content+' Changed outside cited chunk.'}:{}),
  ...(fault==='revision'?{updatedAt:'2099-01-01T00:00:00.000Z'}:{}),
  ...(fault==='revoked'?{status:'disabled' as const}:{}),
  ...(fault==='foreign'?{businessId:88}:{}),
 });
 const rejections:Array<{id:string;reason:string}>=[];
 const fresh = await service.validateMatches(77,captured,{strictSources:true,onRejected:(id,reason)=>rejections.push({id,reason})});
 assert.deepEqual(fresh.map(m=>m.sourceId),[other.id]);
 assert.deepEqual(rejections,[{id:source.id,reason:fault==='content'?'SOURCE_CHUNK':fault==='revoked'?'SOURCE_NOT_READY':fault==='deleted'||fault==='foreign'?'SOURCE_MISSING_OR_UNAUTHORIZED':'SOURCE_REVISION'}]);
 if(['content','outside-chunk','revision'].includes(fault)) assert.equal((await service.validateMatches(77,[first])).length,1,'OFF legacy contract unchanged');
 assert.equal((await service.validateMatches(88,captured,{strictSources:true})).length,0);
});
