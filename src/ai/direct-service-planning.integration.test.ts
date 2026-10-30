import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {directServiceQuestions,serviceQuestionLanguages,serviceFactText} from '../../tests/fixtures/direct-service-questions';
import {literalInformationFallback} from './knowledge-planning';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await sharedCorpus(false);after(()=>corpus.cleanup());
const cedar=JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8'));
for(const[i,doc]of cedar.documents.entries()){
 const id=`cedar-${i}`;await corpus.storage.create({id,businessId:88,type:'document',status:'ready',title:doc.sourceId,content:doc.text,metadata:{segments:[{start:0,end:doc.text.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'});
 await corpus.storage.replaceChunks(88,id,[{chunkIndex:0,content:doc.text,metadata:{source:'document',section:'Text'}}]);
}
const before=process.env.ODINLINK_SERVICE_COMPARISON==='before',measurements:any[]=[];
let recipientSerial=46701000000;
const normalizedQuestion=(q:string)=>q.replace(/؟/gu,'?');
after(()=>{if(process.env.ODINLINK_SERVICE_MEASUREMENTS)writeFileSync(process.env.ODINLINK_SERVICE_MEASUREMENTS,JSON.stringify({phase:before?'before':'after',provider:'offline scripted transport; no provider inference',controlledPlannerDelayMs:40,measurements},null,2));});
for(const id of [77,88])for(const channel of incidentChannels)for(const language of before?['en']as const:serviceQuestionLanguages)for(const attribute of before?[2]:[0,1,2])test(`direct service ${id}/${channel}/${language}/${attribute}`,async t=>{
 const original={...incidentConfig};b.reset();const recipient=String(++recipientSerial);const stages:string[]=[],replies:string[]=[],payloads:any[]=[],decisions:any[]=[];let actions=0,lookups=0,semantic=0,catalogReads=0,plannerMs=0,firstCatalogMs:number|null=null;
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 const service=id===77?{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true}:cedar.services[0];
 const question=directServiceQuestions[language](service.name)[attribute],expected=serviceFactText[language](service.name,service.price,service.currency,service.durationMinutes,attribute),started=performance.now();
 const forbidden=async()=>{actions++;throw Error('Catalog information cannot operate bookings');};
 try{
  Object.assign(incidentConfig,{id,businessId:id,businessName:id===77?'AdMotion Studio':cedar.businessName,services:[service],language});
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});});
  b.configure({evidenceFirstDecisionDiagnostic:e=>{decisions.push(e);},postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(tenant,q,limit)=>{lookups++;assert.equal(tenant,id);return corpus.service.search(tenant,q,limit);},
   knowledgeSourceLanguages:tenant=>corpus.service.sourceLanguageHints(tenant),semanticKnowledgeSearchQueries:async tenant=>{semantic++;assert.equal(tenant,id);return[];},
   knowledgeServiceCatalog:async tenant=>{catalogReads++;firstCatalogMs??=performance.now()-started;assert.equal(tenant,id);return [service];},
   validateKnowledgeMatches:(tenant,matches)=>corpus.service.validateMatches(tenant,matches,{strictSources:true,captureRevision:true}),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction,raw=p.contents[0].parts[0].text;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:JSON.stringify({language,requestedReplyLanguage:null,confidence:.99})};}
    const data=JSON.parse(raw);
    if(instruction.includes('retrieval query planner')){stages.push('planning');const at=performance.now();await new Promise(r=>setTimeout(r,40));plannerMs=performance.now()-at;return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');payloads.push({stage:'extraction',data});
     if(before)return{text:'{"units":[]}'};
     assert.equal(normalizedQuestion(data.question),normalizedQuestion(question));assert.equal(data.evidence.length,1);const e=data.evidence[0];assert.equal(e.businessId,id);assert.equal(e.id,'configured-services');
     const s=JSON.parse(e.text).services[0];assert.equal(s.name,service.name);assert.equal(s.price,service.price);assert.equal(s.durationMinutes,service.durationMinutes);
     return{text:JSON.stringify({units:[{facetIds:['f1'],subject:s.name,predicate:attribute===0?'configured price':'configured duration',value:attribute===0?`${s.price} ${s.currency}`:`${s.durationMinutes} minutes`,modality:'descriptive',negation:false,scope:'configured service only',qualifiers:[],language,text:expected,evidenceRefs:[{evidenceId:e.id,exactQuote:JSON.stringify(s)}]}]})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');payloads.push({stage:'verification',data});assert.equal(normalizedQuestion(data.question),normalizedQuestion(question));assert.equal(normalizedQuestion(data.facets[0].obligations[0].description),normalizedQuestion(question));assert.equal(data.units.length,1);
     const e=data.evidence.find((e:any)=>e.id==='configured-services');assert.ok(e);assert.ok(data.evidence.every((e:any)=>e.businessId===id));
     const s=JSON.parse(e.text).services[0];assert.equal(s.name,service.name);assert.equal(s.price,service.price);assert.equal(s.currency,service.currency);assert.equal(s.durationMinutes,service.durationMinutes);
     assert.equal(data.units[0].text,expected);assert.equal(data.units[0].evidenceRefs[0].evidenceId,e.id);assert.equal(data.units[0].evidenceRefs[0].exactQuote,JSON.stringify(s));
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]}]})};
    }
    throw Error('Unexpected model work');
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question,recipient);
  measurements.push({businessId:id,channel,language,attribute,question,stages,lookups,semantic,catalogReads,plannerMs,firstCatalogMs,wallMs:performance.now()-started,replies,payloads,decisions});
  assert.deepEqual(replies,[expected]);assert.equal(actions,0);assert.equal(stages.filter(s=>s==='planning').length,before?1:0);assert.equal(stages.filter(s=>s==='verification').length,1);
  assert.equal(stages.filter(s=>s==='extraction').length,before||attribute<2?1:0);assert.ok(catalogReads>=2,'Catalog authority must be revalidated through publication');
  if(!before){assert.equal(lookups,0);assert.equal(semantic,0);assert.ok(payloads.every(p=>p.data.evidence.length===1));}
 }finally{Object.assign(incidentConfig,original);b.reset();}
});

if(!before)for(const channel of incidentChannels)for(const mode of ['unknown','incomplete','changed','wrong-citation','mixed','alias','ambiguous','missing']as const)test(`catalog guard ${channel}/${mode}`,async t=>{
 const original={...incidentConfig},recipient=String(++recipientSerial);b.reset();let actions=0,planners=0,verifiers=0,catalogReads=0,lookups=0;const replies:string[]=[],decisions:any[]=[];
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 const service:any={name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true,aliases:['Remote Session']};
 if(mode==='missing')delete service.durationMinutes;
 const question=mode==='mixed'?'What is the price of Video Consultation and how long does it last, and can it replace a physical visit?':mode==='alias'?'What does Remote Session cost and how long does it last?':mode==='ambiguous'?'What does Consultation cost and how long does it last?':directServiceQuestions.en(service.name)[mode==='wrong-citation'?0:2];
 const forbidden=async()=>{actions++;throw Error('No booking/calendar/notification action permitted');};
 try{
  Object.assign(incidentConfig,{id:77,businessId:77,businessName:'AdMotion Studio',services:[service],language:'en'});
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),evidenceFirstDecisionDiagnostic:e=>{decisions.push(e);},
   knowledgeSearch:async()=>{lookups++;return [{sourceId:'foreign',businessId:88,text:'Video Consultation costs 999 SEK and lasts 99 minutes.',metadata:{source:'document'}}];},
   semanticKnowledgeSearchQueries:async()=>[],
   knowledgeServiceCatalog:async id=>{assert.equal(id,77);catalogReads++;return mode==='changed'&&catalogReads>=2?[{...service,price:999}]:[service];},
   validateKnowledgeMatches:async()=>[],
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier'))return{text:'{"language":"en","requestedReplyLanguage":null,"confidence":0.99}'};
    const data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('retrieval query planner')){planners++;return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     assert.ok(data.evidence.every((e:any)=>e.businessId===77));
     if(mode!=='wrong-citation')return{text:'{"units":[]}'};
     const e=data.evidence.find((e:any)=>e.id==='configured-services');assert.ok(e);
     return{text:JSON.stringify({units:[{facetIds:['f1'],subject:service.name,predicate:'configured price',value:'300 SEK',modality:'descriptive',negation:false,scope:'configured service only',qualifiers:[],language:'en',text:'Video Consultation costs 300 SEK.',evidenceRefs:[{evidenceId:e.id,exactQuote:'An invented quote costs 300 SEK.'}]}]})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     verifiers++;assert.ok(data.evidence.every((e:any)=>e.businessId===77));assert.ok(data.evidence.every((e:any)=>e.id==='configured-services'));
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='incomplete'?'ENTAILED':'UNKNOWN',meaningPreserved:mode==='incomplete',modalityPreserved:mode==='incomplete',qualifiersPreserved:mode==='incomplete',relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:mode==='incomplete'?['u1']:[],obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]}]}]})};
    }
    throw Error('No unrestricted generation');
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question,recipient);
  assert.equal(actions,0);assert.equal(replies.length,1);assert.doesNotMatch(replies[0],/999|99 minutes/);
  if(['mixed','alias','ambiguous','missing'].includes(mode)){assert.equal(planners,1);assert.ok(lookups>0);}else{assert.equal(planners,0);assert.equal(lookups,0);}
  if(mode==='incomplete'){assert.equal(verifiers,1);assert.ok(decisions.some(d=>d.eventType==='coverage'&&d.incompletenessReason==='MISSING_RELEVANT_FACT'&&d.facets?.some((f:any)=>f.status!=='VERIFIED')),JSON.stringify(decisions));assert.ok(decisions.some(d=>d.stage==='publication'&&d.route==='partial_manifest'));assert.notEqual(replies[0],'Video Consultation costs 300 SEK and lasts 60 minutes.');}
  else assert.doesNotMatch(replies[0],/300|60|costs|lasts/);
  if(mode==='unknown')assert.equal(verifiers,1);
  if(mode==='wrong-citation')assert.equal(verifiers,0,'Invalid citations cannot reach publication through a mocked ENTAILED verdict');
  if(mode==='changed')assert.ok(catalogReads>=2);
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
