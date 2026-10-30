import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {directConditionalQuestions,preparationQuestion} from '../../tests/fixtures/direct-conditional-questions';
import {literalInformationFallback} from './knowledge-planning';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await sharedCorpus(false);after(()=>corpus.cleanup());
const cedar=JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8'));
for(const [i,doc]of cedar.documents.entries()){
 const id=`cedar-${i}`;
 await corpus.storage.create({id,businessId:88,type:'document',status:'ready',title:doc.sourceId,content:doc.text,metadata:{segments:[{start:0,end:doc.text.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'});
 await corpus.storage.replaceChunks(88,id,[{chunkIndex:0,content:doc.text,metadata:{source:'document',section:'Text'}}]);
}
const before=process.env.ODINLINK_PLAN_COMPARISON==='before',measurements:any[]=[];
after(()=>{if(process.env.ODINLINK_PLAN_MEASUREMENTS)writeFileSync(process.env.ODINLINK_PLAN_MEASUREMENTS,JSON.stringify({phase:before?'before':'after',provider:'scripted offline transport; not model inference',controlledPlannerDelayMs:40,measurements},null,2)+'\n');});
for(const id of [88,77])for(const channel of incidentChannels)test(`direct conditional contract ${id}/${channel}`,async t=>{
 b.reset();const original={...incidentConfig};const stages:string[]=[],queries:string[]=[],replies:string[]=[],payloads:any[]=[];
 let semanticCalls=0,actions=0,firstRetrievalMs:number|null=null,plannerMs=0;
 const question=id===88?directConditionalQuestions[0][1]:preparationQuestion;
 const text=id===88?'Visitors should bring the device serial number if one is available.':'If you have received special preparation instructions for your visit, you must follow them.';
 for(const name of ['log','info','warn','error']as const)t.mock.method(console,name,()=>{});
 const forbidden=async()=>{actions++;throw Error('Information cannot operate appointments');};const started=performance.now();
 try{
  Object.assign(incidentConfig,{id,businessId:id,language:'en',businessName:id===88?cedar.businessName:'AdMotion Studio',services:id===88?cedar.services:original.services});
  t.mock.method(globalThis,'fetch',async(input,options)=>{replies.push(interceptedIncidentSend(input,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   knowledgeSearch:async(tenant,q,limit)=>{assert.equal(tenant,id);firstRetrievalMs??=performance.now()-started;queries.push(q);return corpus.service.search(tenant,q,limit);},
   knowledgeSourceLanguages:tenant=>corpus.service.sourceLanguageHints(tenant),
   semanticKnowledgeSearchQueries:async(tenant,planned)=>{semanticCalls++;assert.equal(tenant,id);assert.ok(planned.includes(question));return[];},
   validateKnowledgeMatches:(tenant,matches)=>corpus.service.validateMatches(tenant,matches,{strictSources:true,captureRevision:true}),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction,raw=p.contents[0].parts[0].text;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:'{"language":"en","requestedReplyLanguage":null,"confidence":0.99}'};}
    const data=JSON.parse(raw);
    if(instruction.includes('retrieval query planner')){stages.push('planning');const at=performance.now();await new Promise(r=>setTimeout(r,40));plannerMs=performance.now()-at;return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');assert.equal(data.question,question);assert.equal(data.facets[0].obligations[0].description,question);assert.ok(data.evidence.every((e:any)=>e.businessId===id));
     const evidence=data.evidence.find((e:any)=>id===88?e.text.includes(text):/Om du har fått[^.]+\./u.test(e.text));assert.ok(evidence);
     const quote=id===88?text:evidence.text.match(/Om du har fått[^.]+\./u)[0];
     payloads.push({stage:'extraction',question:data.question,facets:data.facets,evidence:data.evidence});
     return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'Visitors',predicate:'preparation advice',value:'conditional source guidance',modality:id===88?'recommended':'required',negation:false,scope:'visitors satisfying the explicit condition',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:evidence.id,exactQuote:quote}]}]})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');payloads.push({stage:'verification',question:data.question,facets:data.facets,units:data.units,evidence:data.evidence});
     assert.equal(data.question,question);assert.equal(data.units[0].text,text);
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1'],incompletenessReason:'NONE',obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]}]})};
    }
    throw Error('No other model work is allowed');
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question);
  assert.equal(stages.filter(s=>s==='planning').length,before?1:0);assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(stages.filter(s=>s==='verification').length,1);
  assert.equal(semanticCalls,1,'Direct question preservation does not disable semantic retrieval');
  // The pre-change semantic planner bounds lexical probes to 120 characters;
  // full question preservation is asserted separately at extraction/verification.
  assert.ok(queries.some(q=>q===question||before&&q===question.slice(0,120)));
  assert.deepEqual(replies,[text]);assert.equal(actions,0);
  measurements.push({businessId:id,channel,question,stages,firstRetrievalMs,plannerMs,wallMs:performance.now()-started,queries,semanticCalls,replies,payloads});
 }finally{Object.assign(incidentConfig,original);b.reset();}
});

for(const channel of incidentChannels)for(const kind of ['ambiguous','mixed-service']as const)test(`planning retained ${kind}/${channel}`,async t=>{
 b.reset();const original={...incidentConfig};let planners=0,extractions=0,verifications=0,lookups=0,actions=0;const replies:string[]=[];
 const question=kind==='ambiguous'?'What should I bring if it is available?':'What does Remote Assessment cost and how long does it last, and what should I bring if a serial number is available?';
 for(const name of ['log','info','warn','error']as const)t.mock.method(console,name,()=>{});
 const forbidden=async()=>{actions++;throw Error('Information cannot operate appointments');};
 try{
  Object.assign(incidentConfig,{id:88,businessId:88,language:'en',businessName:cedar.businessName,services:cedar.services});
  t.mock.method(globalThis,'fetch',async(input,options)=>{replies.push(interceptedIncidentSend(input,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}),{status:200});});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   knowledgeSearch:async()=>{lookups++;return[];},semanticKnowledgeSearchQueries:async()=>[],
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier'))return{text:'{"language":"en","requestedReplyLanguage":null,"confidence":0.99}'};
    const data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('retrieval query planner')){planners++;assert.equal(data.question,question);return{text:JSON.stringify(kind==='ambiguous'?{requestKind:'BUSINESS_INFORMATION',referenceResolution:'UNRESOLVED',canonicalMeaning:'unspecified object',queries:[],requestedFacets:[]}:literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){extractions++;return{text:'{"units":[]}'};}
    if(instruction.includes('BATCH ENTAILMENT')){verifications++;assert.equal(data.question,question);return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'UNKNOWN',meaningPreserved:false,modalityPreserved:false,qualifiersPreserved:false,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[]})};}
    throw Error('No unrestricted generation permitted');
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question);
  assert.equal(planners,1);assert.equal(extractions,0);assert.equal(replies.length,1);assert.equal(actions,0);
  if(kind==='ambiguous'){assert.equal(lookups,0);assert.equal(verifications,0);assert.match(replies[0],/referring|specific place|which place/iu);}
  else {assert.ok(lookups>0);assert.equal(verifications,1);assert.doesNotMatch(replies[0],/145|25/);}
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
