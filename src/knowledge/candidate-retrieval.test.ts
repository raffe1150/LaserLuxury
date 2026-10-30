/** Saved genuine vectors prove mechanical recall only. Controlled verdicts and
 * synthetic query/source pairings below are not new model acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {KnowledgeService,InMemoryKnowledgeStorage,type KnowledgeSearchMatch} from '../../knowledge';
import {CANDIDATE_RETRIEVAL_POLICY as policy,selectCandidateRetrievalPolicy,type RetrievalObservation} from './candidate-retrieval';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from './embedding-backfill';
import {answerEvidence,buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets,publishableKnowledgeManifest,completeKnowledgeManifest} from '../ai/business-information-answer-plan';
import {runAccuracyFirstNative,nativeKnowledgeTiming} from '../ai/knowledge-timing-policy';
import type {SemanticStatus,KnowledgeSemanticOptions} from './persistent-search';
const base='docs/validation/shared-core-2026-10-22',read=(f:string)=>JSON.parse(readFileSync(`${base}/${f}`,'utf8'));
const saved=read('aen-accuracy-first-acceptance-20261025/A-en.result.json'),original=read('semantic-only-nibble-diagnostic-20261025/query.result.json');
const variants=read('semantic-query-enrichment-comparison-20261025/comparison.result.json');
const queries=[original.query,...variants.variants],vectors=[original.queryVector,...variants.newVectors];
const completions=saved.databaseCalls.filter((c:any)=>c.name==='complete_knowledge_source_index_v1').map((c:any)=>c.args);
async function fixture(vector=vectors[0]) {
 const storage=new InMemoryKnowledgeStorage();
 for(const [i,s]of saved.sourceBindings.entries()){
  await storage.create({id:s.databaseId,businessId:77,type:'document',status:'ready',title:s.title,content:s.content,metadata:s.metadata,createdAt:'2026',updatedAt:'2026'});
  await storage.replaceChunks(77,s.databaseId,s.chunks.map((c:any)=>({chunkIndex:c.chunk_index,content:c.content,metadata:c.metadata})));
  storage.completeSemanticIndex(77,s.databaseId,storage.indexSnapshot(77,s.databaseId)!,completions[i].p_chunks.map((c:any)=>({...identity,values:c.embedding})));
 }
 let embeddings=0;const requests:number[]=[],readSearch=storage.persistentSemanticSearch.bind(storage);
 storage.persistentSemanticSearch=async(r,o)=>{if(r.embeddings.length)requests.push(r.minSimilarity);return readSearch(r,o);};
 const service=new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,
  embedQuery:async()=>{embeddings++;return vector;},embedDocuments:async qs=>{embeddings++;assert.ok(qs.length<=3);return qs.map(q=>vectors[queries.indexOf(q)]||vector);}});
 return{storage,service,requests,readSearch,embeddings:()=>embeddings};
}
const trial=(lexicalEmpty:Promise<boolean>=Promise.resolve(true)):KnowledgeSemanticOptions=>({candidateFallback:{policy,lexicalEmpty}});
test('backend policy is off by default and unknown values are rejected',()=>{
 assert.equal(selectCandidateRetrievalPolicy(undefined),undefined);assert.equal(selectCandidateRetrievalPolicy(''),undefined);
 assert.equal(selectCandidateRetrievalPolicy(policy),policy);assert.throws(()=>selectCandidateRetrievalPolicy('true'));assert.throws(()=>selectCandidateRetrievalPolicy('top100'));
});
for(const batch of [false,true])for(const [qi,q]of queries.entries())test(`saved genuine snack query ${qi}/${batch?'batch':'single'}: default empty, opt-in within five, one query request`,async()=>{
 const f=await fixture(vectors[qi]);assert.equal((await f.service.search(77,queries[0],5)).length,0);
 const run=(options?:KnowledgeSemanticOptions)=>batch?f.service.semanticSearchQueries(77,[q],5,options):f.service.semanticSearch(77,q,5,.55,options);
 assert.deepEqual(await run(),[]);assert.deepEqual(f.requests,[.55]);assert.equal(f.embeddings(),1);
 const events:RetrievalObservation[]=[];const matches=await run({...trial(),onRetrieval:e=>events.push(e)});
 assert.ok(matches.length<=5&&matches.length>0);assert.ok(matches.some(m=>m.text===completions[0].p_chunks[2].content));
 assert.deepEqual(f.requests,[.55,.55,-1]);assert.equal(f.embeddings(),2,'One request per turn, no second query embedding');
 assert.equal(events.at(-1)?.origin,'candidate');assert.ok(matches.every(m=>m.businessId===77&&m.indexProof?.source.ready));
 assert.ok(answerEvidence(77,matches).reduce((n,e)=>n+e.text.length,0)<=9000);
 assert.deepEqual(await f.service.validateMatches(77,matches,{strictSources:true}),matches);
});
test('genuine three-query batch retains original, existing RRF, total five and one embedding batch',async()=>{
 const f=await fixture(),matches=await f.service.semanticSearchQueries(77,[queries[0],queries[2],queries[1]],10,trial());
 assert.equal(f.embeddings(),1);assert.equal(matches.length,5);assert.ok(matches.some(m=>m.text===completions[0].p_chunks[2].content));assert.deepEqual(f.requests,[.55,-1]);
});
test('nonempty lexical evidence prevents fallback; failed/unknown lexical lookup does not authorize candidates',async()=>{
 for(const rejected of [false,true]){
  const f=await fixture();const options=trial(rejected?Promise.reject(Error('lexical unavailable')):Promise.resolve(false));assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,options),[]);
  assert.deepEqual(f.requests,[.55]);assert.equal(f.embeddings(),1);
 }
});
test('normal strict result is unchanged and never waits for lexical-empty admission',async()=>{
 // A source vector used as a query is a controlled high-score guard, not a real query.
 const vector={...identity,values:completions[0].p_chunks[0].embedding};
 const f=await fixture(vector),normal=await f.service.semanticSearch(77,'strict control',5,.55);
 const got=await f.service.semanticSearch(77,'strict control',5,.55,{...trial(new Promise(()=>{})),timeoutMs:100});
 assert.ok(normal.length>0);assert.deepEqual(got,normal);assert.deepEqual(f.requests,[.55,.55]);
 assert.deepEqual(await f.service.semanticSearch(77,'strict control',5,.55,trial(Promise.reject(Error('late lexical failure')))),normal);
 assert.deepEqual(f.requests,[.55,.55,.55]);
});
test('unsupported trial combinations fail before embedding dispatch',async()=>{
 const f=await fixture();assert.deepEqual(await f.service.semanticSearch(77,queries[0],5,.5,trial()),[]);
 assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,{candidateFallback:{policy:'other' as any,lexicalEmpty:Promise.resolve(true)}}),[]);
 assert.equal(f.embeddings(),0);assert.deepEqual(f.requests,[]);
});
test('missing/incomplete indexing cannot authorize a candidate fallback',async()=>{
 const f=await fixture();await f.storage.create({id:'unindexed',businessId:77,type:'text',status:'ready',title:'Missing index',content:'Other policy.',metadata:{},createdAt:'2026',updatedAt:'2026'});
 let status:SemanticStatus|undefined;assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,{...trial(),onStatus:s=>status=s}),[]);
 assert.equal(status?.status,'incomplete');assert.deepEqual(f.requests,[.55]);
});
for(const change of ['revision','revoked','deleted']as const)test(`snapshot change between strict and candidate searches: ${change}`,async()=>{
 const f=await fixture(),source=(await f.storage.list(77))[0],read=f.storage.persistentSemanticSearch.bind(f.storage);
 f.storage.persistentSemanticSearch=async(r,o)=>{
  if(r.minSimilarity===-1){if(change==='deleted')await f.storage.delete(77,source.id);else await f.storage.create({...source,...(change==='revoked'?{status:'disabled' as const}:{content:source.content+' Changed.'})});}
  return read(r,o);
 };
 let status:SemanticStatus|undefined;assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,{...trial(),onStatus:s=>status=s}),[]);
 assert.deepEqual(status,{status:'unavailable',reason:'source_changed'});
});
test('foreign proof/citation payload fails closed, even with a high injected score',async()=>{
 const f=await fixture(),read=f.storage.persistentSemanticSearch.bind(f.storage);
 f.storage.persistentSemanticSearch=async(r,o)=>{const data=await read(r,o);if(r.minSimilarity===-1)data.matches[0][0]={...data.matches[0][0],businessId:88,score:.99};return data;};
 assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,trial()),[]);
});
test('exact citation membership rejects substituted current text despite a valid generation proof',async()=>{
 const f=await fixture(),read=f.storage.persistentSemanticSearch.bind(f.storage);
 f.storage.persistentSemanticSearch=async(r,o)=>{const data=await read(r,o);if(r.minSimilarity===-1)data.matches[0].forEach(m=>m.text='An invented policy.');return data;};
 assert.deepEqual(await f.service.semanticSearchQueries(77,[queries[0]],5,trial()),[]);
});
test('candidate inventory binding survives to publication; a new source invalidates captured candidates',async()=>{
 const f=await fixture(),matches=await f.service.semanticSearchQueries(77,[queries[0]],5,trial());assert.ok(matches.length);
 assert.ok(matches.every(m=>m.indexProof?.candidatePolicy===policy));
 await f.storage.create({id:'new-policy',businessId:77,type:'text',status:'ready',title:'New policy',content:'Potential counterevidence.',metadata:{},createdAt:'2026',updatedAt:'2026'});
 assert.deepEqual(await f.service.validateMatches(77,matches,{strictSources:true}),[]);
});
test('workflow exclusions apply before candidate top five, including the single-query API',async()=>{
 const f=await fixture(),s={id:'staff-only',businessId:77,type:'text' as const,status:'ready' as const,title:'Staff',content:'Staff parking only for staff training; not for customers.',metadata:{},createdAt:'2026',updatedAt:'2026'};
 await f.storage.create(s);await f.storage.replaceChunks(77,s.id,[{chunkIndex:0,content:s.content}]);f.storage.completeSemanticIndex(77,s.id,f.storage.indexSnapshot(77,s.id)!,[vectors[0]]);
 const got=await f.service.semanticSearch(77,queries[0],5,.55,trial());assert.ok(got.length>0);assert.ok(got.every(m=>m.sourceId!==s.id));
});
test('candidate RPC and lexical admission waits share the same timeout, with no late result',async()=>{
 for(const wait of ['lexical','rpc']){
  const f=await fixture(),read=f.storage.persistentSemanticSearch.bind(f.storage);let rpcSignal:AbortSignal|undefined;
  if(wait==='rpc')f.storage.persistentSemanticSearch=async(r,o)=>{if(r.minSimilarity===-1){rpcSignal=o?.signal;return new Promise(()=>{});}return read(r,o);};
  const start=performance.now(),events:RetrievalObservation[]=[];
  const result=await f.service.semanticSearchQueries(77,[queries[0]],5,{...trial(wait==='lexical'?new Promise(()=>{}):Promise.resolve(true)),timeoutMs:25,onRetrieval:e=>events.push(e)});
  assert.deepEqual(result,[]);assert.ok(performance.now()-start<500);assert.equal(f.embeddings(),1);assert.deepEqual(events,[]);
  if(wait==='rpc')assert.equal(rpcSignal?.aborted,true);
 }
});
test('evidence assembly never slices away a condition to meet the existing 9000-character limit',()=>{
 const m:KnowledgeSearchMatch={businessId:77,sourceId:'synthetic',text:'x'.repeat(8990)+' Only if available.'};assert.equal(answerEvidence(77,[m]).length,0);
});
for(const fault of ['none','unrelated','missing-attribute','lost-condition','contradiction','wrong-citation','verification-timeout']as const)
test(`candidate origin grants no publication authority: ${fault} (scripted judgments)`,async()=>{
 const f=await fixture();
 if(fault==='contradiction'){
  const q=vectors[0].values,norm=Math.hypot(...q),unit=q.map(x=>x/norm),axis=unit.map((x,i)=>(i===0?1:0)-unit[0]*x),an=Math.hypot(...axis);
  const opposite={id:'counterevidence',businessId:77,type:'text' as const,status:'ready' as const,title:'Opposing policy',content:'Food is permitted in treatment and work rooms.',metadata:{},createdAt:'2026',updatedAt:'2026'};
  await f.storage.create(opposite);await f.storage.replaceChunks(77,opposite.id,[{chunkIndex:0,content:opposite.content}]);
  f.storage.completeSemanticIndex(77,opposite.id,f.storage.indexSnapshot(77,opposite.id)!,[{...identity,values:unit.map((x,i)=>.4*x+Math.sqrt(.84)*axis[i]/an)}]);
 }
 const matches=await f.service.semanticSearchQueries(77,[queries[0]],5,trial());assert.ok(matches.length>0);
 const quote='Mat får inte förtäras i behandlings- eller arbetsrummen, men enklare mellanmål är tillåtna i väntrummet.';
 if(fault==='contradiction'){assert.ok(matches.some(m=>m.text=== 'Food is permitted in treatment and work rooms.'));assert.ok(matches.some(m=>m.text?.includes(quote)));}
 const question=fault==='unrelated'?'Does the studio provide pet boarding?':fault==='missing-attribute'?"What is Nordpark's hourly parking fee?":queries[0];
 const text=fault==='lost-condition'?'Visitors may eat snacks anywhere.':fault==='missing-attribute'?'Nordpark costs 99 SEK.':'Light snacks are permitted in the waiting room.';
 await runAccuracyFirstNative(async()=>{
  const evidence=answerEvidence(77,matches),facets=parseRequestedFacets([{subject:'customer request',attribute:question,questionType:'description'}]).facets;
  const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,budget:new InformationBudget(undefined,nativeKnowledgeTiming()),foreground:true,
   authoritativeEvidence:'{}',businessTone:{},history:[],current:async()=>true,languageSafe:()=>true,revalidateEvidence:async()=>{
    assert.deepEqual(await f.service.validateMatches(77,matches,{strictSources:true}),matches);return evidence;
   },generate:async(stage,_instruction,data:any)=>{
    if(stage==='extraction'){
     const source=evidence.find(e=>e.text.includes(quote));assert.ok(source);
     return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'Visitors',predicate:'eat light snacks',value:text,scope:'waiting room',modality:'permitted',negation:false,qualifiers:['in the waiting room'],language:'en',text,
      evidenceRefs:[{evidenceId:fault==='wrong-citation'?'foreign':source.id,exactQuote:quote}]}]})};
    }
    assert.equal(stage,'verification');if(fault==='verification-timeout')throw Error('information_deadline');
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:fault==='contradiction'?'CONTRADICTED':fault==='missing-attribute'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:fault!=='lost-condition',relevant:fault!=='unrelated',languageCorrect:true,explicitAbsenceEvidence:false,negativeAbsence:false})),
     // Even an erroneous COMPLETE coverage cannot turn a rejected unit into a fact.
     coverage:facets.map(f=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map(o=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))})};
   }});
  assert.equal(publishableKnowledgeManifest(manifest,77),fault==='none');assert.equal(completeKnowledgeManifest(manifest),fault==='none');
  if(fault!=='none')assert.ok(!manifest.units.some(u=>u.text===text));
 },async()=>{});
});
