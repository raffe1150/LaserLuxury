import test from 'node:test';
import assert from 'node:assert/strict';
import {languagePolarityCases} from '../../tests/fixtures/language-polarity-cases';
import {incidentChannels,incidentConfig,incidentInbound,incidentSession,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
for(const channel of incidentChannels)for(const row of languagePolarityCases)test(`native polarity and continuity: ${channel}/${row.language}`,async t=>{
 b.reset();let semanticCalls=0,sends=0,actions=0;
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 const forbidden=async()=>{actions++;throw Error('language_request_cannot_operate_booking');};
 t.mock.method(globalThis,'fetch',async(input,options)=>{
  interceptedIncidentSend(input,options);sends++;
  return new Response(JSON.stringify({ok:true,result:{message_id:sends},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});
 });
 b.configure({semanticLanguageResolver:async()=>{semanticCalls++;return{language:row.language,requestedReplyLanguage:row.language,confidence:.99};},geminiGenerate:async()=>({text:'OK.'}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
 const session=incidentSession(b,channel,'46700000001');b.resolveConversationLanguage(session,'Please reply in English.',incidentConfig);
 for(const text of [...row.negative,row.uncertain]){
  const before=sends;await incidentInbound(b,channel,text);
  assert.equal(sends,before+1,'One intercepted reply, no silent negative instruction');
  assert.equal(b.resolveConversationLanguage(session,'OK.',incidentConfig),'en',text);
 }
 assert.equal(semanticCalls,0,'Rejected language instructions never reach semantic reauthorization');
 await incidentInbound(b,channel,row.positive[0]);assert.equal(b.resolveConversationLanguage(session,'OK.',incidentConfig),row.language);
 await incidentInbound(b,channel,'Please reply in English.');assert.equal(b.resolveConversationLanguage(session,'OK.',incidentConfig),'en');
 assert.equal(actions,0);b.reset();
});
