import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',
 ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',
 ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const questions={
 en:['Please book a Video Consultation tomorrow.','Please cancel my appointment.','Where is parking, and please book an appointment for me.'],
 sv:['Boka en Video Consultation i morgon.','Avboka min bokning.','Var finns parkering? Boka en tid åt mig.'],
 de:['Bitte buchen Sie eine Video Consultation für morgen.','Bitte stornieren Sie meinen Termin.','Wo kann ich parken? Bitte buchen Sie einen Termin.'],
 es:['Quiero reservar una Video Consultation para mañana.','Por favor cancelar mi cita.','¿Dónde puedo aparcar? Quiero reservar una cita.'],
 fa:['لطفاً برای فردا Video Consultation رزرو کنید.','لطفاً نوبت من را لغو کنید.','پارکینگ کجاست؟ لطفاً برای من نوبت رزرو کنید.'],
 ar:['أريد حجز Video Consultation غداً.','أريد إلغاء موعدي.','أين موقف السيارات؟ احجز لي موعداً.'],
};
for(const [language,texts] of Object.entries(questions))for(const channel of incidentChannels)for(const [i,question] of texts.entries())
test(`timing booking exclusion ${language}/${channel}/${i}`,async t=>{
 b.reset();let actions=0,languageChecks=0;const policies:any[]=[];const original={...incidentConfig};
 for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,(label,data)=>{if(label==='[KnowledgeTimingPolicy]')policies.push(data);});
 const forbidden=async()=>{actions++;throw Error('No booking mutation without confirmation');};
 try {
  incidentConfig.language=language;
  t.mock.method(globalThis,'fetch',async(input,options)=>{assert.equal(nativeKnowledgeTiming(),undefined);interceptedIncidentSend(input,options);return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({semanticLanguageResolver:async()=>{languageChecks++;assert.equal(nativeKnowledgeTiming(),undefined);return{language,confidence:1};},
   postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),knowledgeSearch:async()=>[],semanticKnowledgeSearch:async()=>[],
   geminiGenerate:async()=>{assert.equal(nativeKnowledgeTiming(),undefined);return{text:'Please provide the booking details.'};},
   calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>[],checkSlots:async()=>[],insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
   recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  await incidentInbound(b,channel,question);
  assert.ok(languageChecks>0);assert.equal(policies.length,0);assert.equal(actions,0);
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
