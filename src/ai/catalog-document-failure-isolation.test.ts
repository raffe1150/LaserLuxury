import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configuredServiceEvidence } from './configured-service-evidence';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, pruneAnswerManifest,
  type Evidence, type ProviderResult } from './business-information-answer-plan';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';

const cedar=JSON.parse(readFileSync(new URL('../../tests/fixtures/cedar-repair-knowledge.json',import.meta.url),'utf8'));
const production=JSON.parse(readFileSync(new URL('../../tests/fixtures/admotion-production-document.json',import.meta.url),'utf8'));
const businesses=[
 {id:77,name:'Video Consultation',price:300,currency:'SEK',minutes:60,docs:production.chunks.map((c:any)=>({businessId:77,sourceId:'admotion-pdf',text:c.content,metadata:c.metadata}))},
 {id:cedar.businessId,name:cedar.services[0].name,price:145,currency:'EUR',minutes:25,docs:cedar.documents.map((d:any)=>({businessId:88,...d}))},
];
// Deliberately scripted judgments exercise runtime publication/freshness guards.
// They do not measure an actual model's entailment or answer quality.
const decision=(u:any,relation='ENTAILED')=>({unitId:u.id,facetIds:u.facetIds,relation,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false});

for(const business of businesses)for(const mode of ['malformed-json','empty-response','truncated','missing-units','invalid-array','timeout','provider-failure','no-document','false-complete','reject-catalog','changed-catalog','revoked-catalog','blocked','refusal','tool-output'] as const)
test(`${business.id}: independent catalog authority survives only safe documentary failure: ${mode}`,async()=>{
 const catalog=configuredServiceEvidence(business.id,[{name:business.name,price:business.price,currency:business.currency,durationMinutes:business.minutes}])!;
 const docs=mode==='no-document'?[]:answerEvidence(business.id,business.docs);
 const evidence=[...docs,catalog],question=`What does ${business.name} cost, how long does it last, and can it replace a visit in person?`;
 const facets=parseRequestedFacets([{subject:'requested information',attribute:question,questionType:'description'}]).facets;
 let extracted=false;const stages:string[]=[],events:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,facets,language:'en',evidence,history:[],authoritativeEvidence:'{}',businessTone:{},foreground:true,budget:new InformationBudget(),current:async()=>true,
  diagnostic:e=>events.push(e),
  revalidateEvidence:async()=>extracted&&['changed-catalog','revoked-catalog'].includes(mode)
    ? mode==='changed-catalog'?[...docs,{...catalog,version:'changed'}]:docs:evidence,
  generate:async(stage,_instruction,data:any):Promise<ProviderResult>=>{
   stages.push(stage);
   if(stage==='extraction'){
    extracted=true;assert.ok(docs.length>0,'Do not ask a document extractor to process an empty source set');
    assert.equal(data.authorityScope,'document_only');assert.deepEqual(data.evidence.map((e:any)=>e.text),docs.map(e=>e.text));
    if(mode==='timeout')throw Error('information_deadline');
    if(mode==='provider-failure')throw Error('controlled_provider_failure');
    if(mode==='empty-response')throw Object.assign(Error('No usable provider content'),{category:'MALFORMED_RESPONSE'});
    if(mode==='truncated')return{text:'{"units":[',structuredFailure:'TRUNCATED'};
    if(mode==='missing-units')return{text:'{}'};
    if(mode==='invalid-array')return{text:'{"units":null}'};
    if(mode==='blocked')return{text:'',structuredFailure:'BLOCKED'};
    if(mode==='refusal')return{text:'',structuredFailure:'REFUSAL'};
    if(mode==='tool-output')return{text:'{}',functionCalls:[{name:'insertAppointment'}]};
    return{text:'invalid-json'};
   }
   assert.equal(stage,'verification','One surviving catalog unit needs no composition');
   assert.equal(data.question,question);assert.deepEqual(data.facets,facets);
   assert.equal(data.units.length,1);assert.deepEqual(data.units[0].evidenceRefs.map((r:any)=>r.evidenceId),['configured-services']);
   assert.equal(data.evidence.find((e:any)=>e.id==='configured-services').text,catalog.text);
   return{text:JSON.stringify({decisions:data.units.map((u:any)=>decision(u,mode==='reject-catalog'?'UNKNOWN':'ENTAILED')),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode==='false-complete',incompletenessReason:mode==='false-complete'?'NONE':'UNRESOLVED',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:mode==='false-complete'?'COVERED':'UNRESOLVED',unitIds:mode==='false-complete'?['u1']:[]}]}]})};
  }});
 const denied=['blocked','refusal','tool-output','reject-catalog','changed-catalog','revoked-catalog'].includes(mode);
 assert.equal(manifest.units.length,denied?0:1);
 if(denied)assert.doesNotMatch(manifest.text,new RegExp(`${business.price} ${business.currency}`));
 else {
  assert.equal(manifest.units[0].text,`${business.name} costs ${business.price} ${business.currency} and lasts ${business.minutes} minutes.`);
  assert.equal(manifest.outcomes[0].status,'PARTIAL');
  assert.match(manifest.text,/cannot confirm whether the document's information applies/);
  assert.equal(manifest.units[0].verification,'ENTAILED');
  assert.ok(stages.includes('verification'),'Known catalog facts must still be independently verified');
  assert.equal(pruneAnswerManifest(manifest,docs).units.length,0,'Publication still removes revoked catalog');
 }
 if(mode==='no-document')assert.deepEqual(stages,['verification']);
 if(['blocked','refusal','tool-output'].includes(mode))assert.deepEqual(stages,['extraction']);
 if(mode==='malformed-json')assert.ok(events.some(e=>e.reason==='MALFORMED_JSON'));
});

test('second business actual local document retrieval is scoped, complete and revocable',async()=>{
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage,storage,null);
 for(const b of businesses)for(const [i,doc]of b.docs.entries()){
  const id=`${b.id}-${i}`;
  await storage.create({id,businessId:b.id,type:'document',title:doc.sourceId,status:'ready',content:doc.text,metadata:{segments:[{start:0,end:doc.text.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'});
  await storage.replaceChunks(b.id,id,[{chunkIndex:0,content:doc.text,metadata:{source:'document',section:'Text'}}]);
 }
 const matches=await service.search(88,'photo briefing inspection safety-critical photographs serial number');
 assert.ok(matches.length>0);assert.ok(matches.every(m=>m.businessId===88));
 assert.ok(matches.some(m=>m.text.includes('if one is available')),'Retrieval must not truncate the condition');
 assert.ok(matches.every(m=>!m.text.includes('Stjärngatan')&&!m.text.includes('AdMotion')));
 const captured=await service.validateMatches(88,matches,{strictSources:true,captureRevision:true});assert.ok(captured.length>0);
 assert.deepEqual(await service.validateMatches(77,captured,{strictSources:true}),[]);
 for(const m of captured)await storage.delete(88,m.sourceId);
 assert.deepEqual(await service.validateMatches(88,captured,{strictSources:true}),[]);
});

for(const b of businesses)test(`${b.id}: catalog-only proposal skips extraction but cannot self-verify completeness`,async()=>{
 const question=`What does ${b.name} cost and how long does it last?`;
 const facets=parseRequestedFacets([{subject:b.name,attribute:'price and duration',questionType:'description'}]).facets;
 const catalog=configuredServiceEvidence(b.id,[{name:b.name,price:b.price,currency:b.currency,durationMinutes:b.minutes}])!;
 const stages:string[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:[catalog],history:[],businessTone:{},authoritativeEvidence:'{}',foreground:true,budget:new InformationBudget(),current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  stages.push(stage);assert.equal(stage,'verification');
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>decision(u)),coverage:[]})};
 }});
 assert.deepEqual(stages,['verification']);assert.equal(manifest.units.length,1);
 assert.equal(manifest.outcomes[0].status,'PARTIAL','Entailment is not a coverage verdict');
});

test('missing catalog attributes, duplicate identity and foreign tenants do not authorize deterministic proposals',async()=>{
 const {independentServiceProposal}=await import('./source-aware-service-proposal');
 const question='What does Remote Assessment cost and how long does it last?';
 const facets=parseRequestedFacets([{subject:'Remote Assessment',attribute:'price and duration',questionType:'description'}]).facets;
 for(const records of [[{name:'Remote Assessment',currency:'EUR',durationMinutes:25}],[...cedar.services,...cedar.services],[{...cedar.services[0],active:false}]]){
  const catalog=configuredServiceEvidence(88,records);
  assert.equal(independentServiceProposal(question,'en',facets,catalog?[catalog]:[]),null);
 }
 const catalog=configuredServiceEvidence(88,cedar.services)!;
 assert.equal(independentServiceProposal(question,'en',facets,[catalog,...answerEvidence(77,businesses[0].docs)]),null);
});

for(const mode of ['complete','condition-omitted','reversed-negation','wrong-citation','unrelated-rejected-sibling','conflict','revoked','changed']as const)
test(`second business knowledge-only immutable propositions and publication: ${mode}`,async()=>{
 const evidence=answerEvidence(88,businesses[1].docs);
 const question=mode==='unrelated-rejected-sibling'?'What should I bring, and what are photo briefings for?':'Should I bring the serial number if I have one?';
 const facets=parseRequestedFacets([{subject:'visitor',attribute:question,questionType:'description'}]).facets;
 const expected='Visitors should bring the device serial number if one is available.';
 const unit=(text:string,quote=expected)=>({facetIds:['f1'],subject:'Visitors',predicate:'bring device serial number',value:'serial number',modality:'recommended',negation:false,scope:'visitors with an available serial number',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e1',exactQuote:quote}]});
 let verified=false,verificationCalls=0;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,authoritativeEvidence:'{}',businessTone:{},history:[],foreground:true,budget:new InformationBudget(),current:async()=>true,
 revalidateEvidence:async()=>verified&&['revoked','changed'].includes(mode)?mode==='revoked'?[]:evidence.map(e=>({...e,version:'changed'})):evidence,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction'){
   assert.deepEqual(data.evidence.map((e:any)=>e.text),evidence.map(e=>e.text),'Complete source context constrains immutable claims');
   const first=unit(mode==='condition-omitted'?'Visitors should bring the device serial number.':mode==='reversed-negation'?'Visitors should not bring the device serial number.':expected);
   if(mode==='wrong-citation')first.evidenceRefs[0].evidenceId='e2';
   const units=[first];
   if(mode==='unrelated-rejected-sibling')units.push(unit('Photo briefings replace inspections.','A photo briefing does not automatically replace a workshop inspection.'));
   return{text:JSON.stringify({units})};
  }
  assert.equal(stage,'verification');verificationCalls++;verified=true;
  // Explicit adversarial test decisions, not a fabricated perfect semantic model.
  const rejected=['condition-omitted','reversed-negation','conflict'].includes(mode);
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>decision(u,rejected||u.id==='u2'?mode==='conflict'?'CONTRADICTED':'UNKNOWN':'ENTAILED')),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode==='complete',incompletenessReason:mode==='complete'?'NONE':'MISSING_CONDITION',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:mode==='complete'?'COVERED':'UNRESOLVED',unitIds:mode==='complete'?['u1']:[]}]}]})};
 }});
 if(['complete','unrelated-rejected-sibling'].includes(mode)){
  assert.deepEqual(manifest.units.map(u=>u.text),[expected]);assert.equal(manifest.outcomes[0].status,mode==='complete'?'VERIFIED':'PARTIAL');
 }else assert.equal(manifest.units.length,0);
 assert.equal(verificationCalls,mode==='wrong-citation'?0:1);
 if(mode==='complete')assert.equal(manifest.text,expected,'No generic fallback added to a complete supported fact');
});
