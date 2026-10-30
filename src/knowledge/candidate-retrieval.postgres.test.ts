/** Original genuine vector replay through actual disposable PostgreSQL. No
 * new embeddings, source changes, migration authoring or real provider calls. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {KnowledgeService} from '../../knowledge';
import {prepareDatabase} from '../../docs/validation/shared-core-2026-10-22/semantic-only-nibble-diagnostic-20261025/diagnostic';
test('candidate-top5-v1 uses current genuine canonical-v1 generation proofs in disposable PostgreSQL',{timeout:120000},async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No external network');});
 const base='docs/validation/shared-core-2026-10-22',original=JSON.parse(readFileSync(base+'/semantic-only-nibble-diagnostic-20261025/query.result.json','utf8'));
 const variants=JSON.parse(readFileSync(base+'/semantic-query-enrichment-comparison-20261025/comparison.result.json','utf8'));
 const queries=[original.query,...variants.variants],vectors=[original.queryVector,...variants.newVectors],record:any={};
 const prepared=await prepareDatabase(record);let embeddings=0;
 try{
  assert.equal(record.preparation.readinessAfterRestart.complete,true);assert.deepEqual(record.preparation.savedRealVectorReplayBatches,[5,1]);
  const service=new KnowledgeService(prepared.storage,prepared.storage,{supportsLocalSemanticSearch:true,embedQuery:async q=>{embeddings++;return vectors[queries.indexOf(q)];},embedDocuments:async qs=>{embeddings++;return qs.map(q=>vectors[queries.indexOf(q)]);}},true);
  for(const batch of [false,true])for(const q of queries){
   const options={candidateFallback:{policy:'candidate-top5-v1' as const,lexicalEmpty:Promise.resolve(true)}};
   const before=embeddings,matches=await(batch?service.semanticSearchQueries(77,[q],5,options):service.semanticSearch(77,q,5,.55,options));
   assert.equal(embeddings-before,1);assert.ok(matches.length<=5&&matches.length>0);assert.ok(matches.some(m=>m.text?.includes('enklare mellanmål är tillåtna i väntrummet.')));
   assert.ok(matches.every(m=>m.indexProof?.candidatePolicy==='candidate-top5-v1'));assert.deepEqual(await service.validateMatches(88,matches,{strictSources:true}),[]);
   assert.deepEqual(await service.validateMatches(77,matches,{strictSources:true}),matches);
  }
  t.diagnostic(JSON.stringify({savedGenuineVectors:true,newProviderRequests:0,queryAdapterInvocations:embeddings,sourceVectorReplayBatches:[5,1],readyAfterRestart:6}));
 }finally{prepared.close();}
});
