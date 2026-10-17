import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource, type KnowledgeSearchMatch, type LexicalRetrievalMetrics } from '../../knowledge';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets } from '../ai/business-information-answer-plan';

const recommendation = 'Contact the business for alternative parking information.';
const queries = [' parking ', 'ENTRANCE', 'alternatives'];
async function fixture() {
  const storage = new InMemoryKnowledgeStorage();
  const paragraphs = Array.from({length:100},(_,i)=>`Visitor parking section ${i}: use the designated entrance and observe the posted conditions. `+ 'Source-backed conditions remain applicable. '.repeat(4));
  const content = paragraphs.join('\n'); let offset=0;
  const segments=paragraphs.map((text,i)=>{const segment={start:offset,end:offset+text.length,page:i+1};offset+=text.length+1;return segment;});
  const doc:KnowledgeSource={id:'doc',businessId:77,type:'document',title:'Synthetic document',status:'ready',content,metadata:{segments},createdAt:'1',updatedAt:'1'};
  const txt:KnowledgeSource={...doc,id:'txt',type:'text',title:'Supplement',content:recommendation,metadata:{}};
  await storage.create(doc);await storage.create(txt);
  const rows:KnowledgeSearchMatch[]=[...paragraphs.slice(0,4).map((text,i)=>({businessId:77,sourceId:'doc',text,score:1-i/10,metadata:{page:i+1}})),
    {businessId:77,sourceId:'txt',text:recommendation,score:.5,metadata:{}}];
  const calls:Array<{id:number;query:string;limit:number|undefined}>=[];let lists=0;
  const list=storage.list.bind(storage);storage.list=async id=>{lists++;return list(id);};
  storage.search=async(id,query,limit)=>{calls.push({id,query,limit});return structuredClone(rows.slice(0,limit));};
  const service=new KnowledgeService(storage,storage);await service.initialize();
  return {storage,service,doc,txt,rows,calls,lists:()=>lists,reset:()=>{lists=0;calls.length=0;}};
}
async function legacy(f:Awaited<ReturnType<typeof fixture>>, qs=queries, limit=5) {
  const metrics:Readonly<LexicalRetrievalMetrics>[]=[];
  const sets=await Promise.all(qs.map(q=>f.service.search(77,q,limit,m=>metrics.push(m)).catch(()=>[])));
  return {sets,metrics};
}

test('ordered per-query evidence, scores, provenance, recommendations and limits are identical',async()=>{
  const f=await fixture();const old=await legacy(f);assert.equal(f.lists(),3);f.reset();
  let metrics!:Readonly<LexicalRetrievalMetrics>;
  const batched=await f.service.searchLexicalQueries(77,queries,5,m=>{metrics=m;});
  assert.deepEqual(batched,old.sets);assert.equal(f.lists(),1);
  assert.deepEqual(f.calls,queries.map(query=>({id:77,query:query.trim(),limit:5})));
  assert.equal(metrics.documentReconstructions,1);
  assert.equal(old.metrics.reduce((n,m)=>n+m.documentReconstructions,0),12);
  assert.equal(batched[2][4].text,recommendation);
  for(const limit of [1,10,99,0])assert.deepEqual(await f.service.searchLexicalQueries(77,queries,limit),(await legacy(f,queries,limit)).sets);
});

test('query completion order, repeated queries and duplicate rows do not reorder or deduplicate per-query results',async()=>{
  const f=await fixture();
  f.storage.search=async(_id,q)=>{
    if(q==='first')await new Promise(r=>setTimeout(r,10));
    const row={...f.rows[q==='first'?0:1],score:q==='first'?.3:.9};return [row,row];
  };
  const qs=['first','second','first'];
  assert.deepEqual(await f.service.searchLexicalQueries(77,qs),(await legacy(f,qs)).sets);
  const sets=await f.service.searchLexicalQueries(77,qs);
  assert.equal(sets[0][0].score,.3);assert.equal(sets[1][0].score,.9);assert.equal(sets[2].length,2);
});

for(const id of [0,-1,NaN,1.5])test(`invalid tenant ${id}: no storage access`,async()=>{
  const f=await fixture();assert.deepEqual(await f.service.searchLexicalQueries(id,queries),[[],[],[]]);assert.equal(f.lists(),0);assert.equal(f.calls.length,0);
});
test('empty queries retain their positions and foreign/missing/provenance-forged rows are rejected',async()=>{
  const f=await fixture();
  f.storage.search=async()=>[...f.rows,{...f.rows[0],businessId:88},{...f.rows[0],sourceId:'absent'},{...f.rows[0],metadata:{page:99}}];
  const sets=await f.service.searchLexicalQueries(77,['',' parking ','  ']);assert.deepEqual(sets,[[],(await legacy(f,['parking'])).sets[0],[]]);
  assert.equal(sets[1].length,5);assert.deepEqual(await f.service.searchLexicalQueries(88,['parking']),[[]]);
  assert.deepEqual(await f.service.searchLexicalQueries(77,[]),[]);
});

for(const fault of ['deleted','modified','disabled'] as const)test(`source ${fault} during a slow search: validate only after all search results arrive`,async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  f.storage.search=async(_id,q)=>{if(q==='slow')await gate;return structuredClone(f.rows);};
  const pending=f.service.searchLexicalQueries(77,['fast','slow']);await new Promise(r=>setImmediate(r));assert.equal(f.lists(),0);
  if(fault==='deleted')await f.storage.delete(77,'doc');
  else await f.storage.create({...f.doc,...(fault==='disabled'?{status:'disabled' as const}:{content:f.doc.content.replaceAll('Visitor','Changed')})});
  release();const sets=await pending;assert.equal(f.lists(),1);
  for(const set of sets)assert.deepEqual(set.map(m=>m.sourceId),['txt']);
});

test('one query failure preserves independent results; source-list failure fails the whole batch closed',async()=>{
  const f=await fixture();f.storage.search=async(_id,q)=>{if(q==='fail')throw Error('synthetic');return structuredClone(f.rows);};
  assert.deepEqual(await f.service.searchLexicalQueries(77,['parking','fail','alternatives']),(await legacy(f,['parking','fail','alternatives'])).sets);
  f.storage.list=async()=>{throw Error('private storage failure');};let m!:Readonly<LexicalRetrievalMetrics>;
  assert.deepEqual(await f.service.searchLexicalQueries(77,queries,5,d=>{m=d;}),[[],[],[]]);assert.equal(m.sourceListFailures,1);
});

test('malformed query results fail only that query, matching the legacy dispatch catch',async()=>{
  const f=await fixture();f.storage.search=async(_id,q)=>q==='malformed'?null as any:structuredClone(f.rows);
  let metrics!:Readonly<LexicalRetrievalMetrics>;
  const sets=await f.service.searchLexicalQueries(77,['parking','malformed'],5,m=>{metrics=m;});
  assert.deepEqual(sets,(await legacy(f,['parking','malformed'])).sets);assert.equal(metrics.validationFailures,1);
});

test('snapshot never survives a retrieval call or replaces later strict validation',async()=>{
  const f=await fixture();const [matches]=await f.service.searchLexicalQueries(77,['parking']);
  const captured=await f.service.validateMatches(77,matches,{strictSources:true,captureRevision:true});
  assert.equal(captured.length,5);const reads=f.lists();
  await f.storage.create({...f.doc,content:f.doc.content.replaceAll('Visitor','Changed')});
  const current=await f.service.validateMatches(77,captured,{strictSources:true});assert.equal(f.lists(),reads+1);assert.deepEqual(current.map(m=>m.sourceId),['txt']);
  await f.storage.delete(77,'txt');assert.deepEqual(await f.service.searchLexicalQueries(77,['parking']),[[]]);
});

test('revocation during verification cannot publish request-local cached evidence',async()=>{
  const f=await fixture();const [matches]=await f.service.searchLexicalQueries(77,['parking']);
  const captured=answerEvidence(77,matches);const facets=parseRequestedFacets([{subject:'parking',attribute:'location',questionType:'description'}]).facets;
  const manifest=await buildEvidenceFirstAnswer({question:'Where is visitor parking?',language:'en',facets,evidence:captured,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
    revalidateEvidence:async()=>answerEvidence(77,await f.service.validateMatches(77,matches,{strictSources:true,captureRevision:true})),
    generate:async(stage,_instruction,data:any)=>{
      if(stage==='extraction')return {text:JSON.stringify({units:[{facetIds:['f1'],subject:'parking',predicate:'location',value:f.rows[0].text,modality:'descriptive',negation:false,scope:'visitors',qualifiers:[],language:'en',text:f.rows[0].text,evidenceRefs:[{evidenceId:'e1',exactQuote:f.rows[0].text}]}]})};
      assert.equal(stage,'verification');await f.storage.delete(77,'doc');
      return {text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,relation:'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]}]})};
    }});
  assert.equal(manifest.units.length,0);assert.equal(manifest.text.includes(String(f.rows[0].text)),false);
});

test('diagnostics contain only counts and durations; throwing observers do not change results',async()=>{
  const f=await fixture();let m!:Readonly<LexicalRetrievalMetrics>;
  const sets=await f.service.searchLexicalQueries(77,queries,5,d=>{m=d;throw Error('observer');});assert.equal(sets.length,3);
  assert.equal(Object.values(m).every(v=>typeof v==='number'||v==='batch'),true);assert.equal(Object.isFrozen(m),true);
});

test('local equivalent-work benchmark: report measured wall time and actual operation counts',async t=>{
  t.mock.method(console,'log',()=>{}); // Equivalent no-op logging sink for both paths.
  const f=await fixture();const samples:{legacy:number[];batch:number[]}={legacy:[],batch:[]};let last:any;
  for(let round=0;round<13;round++)for(const path of round%2?['batch','legacy'] as const:['legacy','batch'] as const){
    f.reset();const started=performance.now();let metrics:Readonly<LexicalRetrievalMetrics>[]=[];
    const result=path==='legacy'?await legacy(f):{sets:await f.service.searchLexicalQueries(77,queries,5,m=>metrics.push(m)),metrics};
    const elapsed=performance.now()-started;metrics=result.metrics;
    assert.equal(result.sets.flat().length,15);
    if(round>2)samples[path].push(elapsed);
    last={...last,[path]:{sourceListReads:f.lists(),storageSearchCalls:f.calls.length,documentReconstructions:metrics.reduce((n,m)=>n+m.documentReconstructions,0),
      durations:metrics.map(m=>({lexicalSearchMs:m.lexicalSearchMs,sourceListMs:m.sourceListMs,validationMs:m.validationMs,documentReconstructionMs:m.documentReconstructionMs,totalMs:m.totalMs}))}};
  }
  const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  t.diagnostic('LOCAL_SYNTHETIC_BENCHMARK '+JSON.stringify({fixture:'3 queries, 5 rows/query, 1 document with 100 segments plus 1 supplementary text source; in-memory storage; no injected delay',rounds:10,medianWallMs:{legacy:median(samples.legacy),batch:median(samples.batch)},samples,last}));
  assert.equal(last.legacy.sourceListReads,3);assert.equal(last.batch.sourceListReads,1);
  assert.equal(last.legacy.documentReconstructions,12);assert.equal(last.batch.documentReconstructions,1);
});
