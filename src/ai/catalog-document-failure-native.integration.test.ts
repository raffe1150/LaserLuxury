import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env,{NODE_ENV:'test',AI_PROVIDER:'gemini',DOTENV_CONFIG_PATH:'/dev/null',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const cedar=JSON.parse(readFileSync(new URL('../../tests/fixtures/cedar-repair-knowledge.json',import.meta.url),'utf8'));
const tenants=[{id:77,name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60},{id:88,...cedar.services[0]}];
for(const tenant of tenants)for(const channel of incidentChannels)for(const mode of ['no-document','malformed-document']as const)
test(`native separate authorities ${tenant.id}/${channel}/${mode}`,async t=>{
 b.reset();const original={...incidentConfig};let actions=0;const stages:string[]=[],replies:string[]=[],events:any[]=[];
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 const forbidden=async()=>{actions++;throw Error('information_cannot_operate_calendar');};
 try{
  Object.assign(incidentConfig,{id:tenant.id,businessId:tenant.id,language:'en',defaultBookingService:tenant.name,services:[tenant]});
  t.mock.method(globalThis,'fetch',async(input,options)=>{replies.push(interceptedIncidentSend(input,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}),{status:200});});
  b.configure({semanticLanguageResolver:async()=>({language:'en',confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   knowledgeSearch:async id=>{assert.equal(id,tenant.id);return mode==='no-document'?[]:[{businessId:tenant.id,sourceId:'synthetic-current-document',text:cedar.documents[0].text,score:1,metadata:{source:'document',documentRevision:'synthetic-current-v1'}}];},
   semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(id,matches)=>{assert.equal(id,tenant.id);return matches;},
   evidenceFirstDiagnostic:e=>events.push(e),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction,data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('retrieval query planner'))return{text:JSON.stringify({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:data.question,referenceResolution:'NOT_REQUIRED',queries:[],requestedFacets:[{subject:'customer request',attribute:data.question,questionType:'description'}]})};
    if(instruction.includes('UNIT EXTRACTION')){stages.push('extraction');return{text:'invalid-json'};}
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');assert.equal(data.units.length,1);assert.ok(data.evidence.every((e:any)=>e.businessId===tenant.id));
     assert.equal(data.units[0].subject,tenant.name);assert.equal(data.units[0].evidenceRefs[0].evidenceId,'configured-services');
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'UNRESOLVED',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]}]}]})};
    }
    throw Error('No unrestricted prose or action generation expected');
   },
   calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,`What does ${tenant.name} cost, how long does it last, and can it replace an in-person visit?`);
  assert.deepEqual(stages,mode==='no-document'?['verification']:['extraction','verification']);
  assert.equal(replies.length,1);assert.ok(replies[0].includes(`${tenant.name} costs ${tenant.price} ${tenant.currency} and lasts ${tenant.durationMinutes} minutes.`));
  assert.match(replies[0],/cannot confirm whether the document's information applies/);
  assert.equal(events.at(-1)?.completeness[0].status,'PARTIAL');
  assert.equal(actions,0);
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
