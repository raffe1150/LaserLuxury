import test from 'node:test';
import assert from 'node:assert/strict';
import {incidentFlags,incidentConfig,incidentChannels,incidentInbound,incidentSession,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {nativeKnowledgeTiming} from './knowledge-timing-policy';

// Real native handlers, in-memory completion evidence and intercepted delivery.
// No provider, database, embedding or calendar write is permitted.
incidentFlags();
Object.assign(process.env,{AI_PROVIDER:'gemini',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3',ODINLINK_KNOWLEDGE_MODEL_PROFILE:'off',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:''});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const questions={
  sv:{book:'Boka en Video Consultation i morgon.',move:'Flytta min bokning till i morgon.',cancel:'Avboka min bokning eftersom jag blir sen.',lookup:'Har jag en bokning?',status:'Kan du bekräfta min bokning?',header:'Ja, bokningen är verifierad.'},
  en:{book:'Please book a Video Consultation tomorrow.',move:'Please reschedule my appointment to tomorrow.',cancel:'Please cancel my appointment because I will be late.',lookup:'Do I have an appointment?',status:'Can you please confirm my booking?',header:'Yes, the booking is verified.'},
  de:{book:'Bitte buchen Sie eine Video Consultation für morgen.',move:'Bitte verschieben Sie meinen Termin auf morgen.',cancel:'Bitte stornieren Sie meinen Termin, weil ich zu spät komme.',lookup:'Habe ich einen Termin?',status:'Können Sie bitte meine Buchung bestätigen?',header:'Ja, die Buchung ist bestätigt.'},
  es:{book:'Quiero reservar Video Consultation mañana.',move:'Quiero cambiar mi cita para mañana.',cancel:'Por favor cancelar mi cita porque llegaré tarde.',lookup:'¿Puedes comprobar mi cita?',status:'¿Puedes confirmar mi reserva?',header:'Sí, la reserva está verificada.'},
  fa:{book:'لطفاً برای فردا Video Consultation رزرو کنید.',move:'لطفاً نوبتم را تغییر دهید.',cancel:'لطفاً نوبت من را لغو کنید چون دیر می‌رسم.',lookup:'آیا وقت دارم؟',status:'بله، رزرو من را تأیید کن.',header:'بله، رزرو تأیید شده است.'},
  ar:{book:'أريد حجز Video Consultation غداً.',move:'أريد تغيير موعدي إلى الغد.',cancel:'أريد إلغاء موعدي لأنني سأتأخر.',lookup:'هل لدي حجز قادم؟',status:'هل يمكنك تأكيد الحجز من فضلك؟',header:'نعم، الحجز مؤكد.'},
};
type Operation='book'|'move'|'cancel'|'lookup'|'status'|'unverified_status';
for(const [language,copy] of Object.entries(questions))for(const channel of incidentChannels)
for(const operation of ['book','move','cancel','lookup','status','unverified_status'] as Operation[])
test(`booking authority excludes Knowledge ${language}/${channel}/${operation}`,async t=>{
  b.reset();const saved={...incidentConfig};const replies:string[]=[],policies:any[]=[];
  let knowledgeReads=0,mutations=0;
  const forbidden=async()=>{mutations++;throw Error('No mutation authority');};
  for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,(label,data)=>{
    if(label==='[KnowledgeTimingPolicy]')policies.push(data);
  });
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    assert.equal(nativeKnowledgeTiming(),undefined,'A booking/status delivery must not require a Knowledge manifest');
    replies.push(interceptedIncidentSend(input,options));
    return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));
  });
  try{
    Object.assign(incidentConfig,{id:3,businessId:3,language});
    b.configure({semanticLanguageResolver:async()=>{
      assert.equal(nativeKnowledgeTiming(),undefined,'Policy admission must exclude appointment operations');
      return{language,confidence:1};
    },postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
    knowledgeSearch:async()=>{knowledgeReads++;return[];},semanticKnowledgeSearch:async()=>{knowledgeReads++;return[];},
    geminiGenerate:async p=>{
      assert.doesNotMatch(p.config.systemInstruction||'',/UNIT EXTRACTION|BATCH ENTAILMENT|retrieval query planner/u);
      return{text:'Please provide the appointment details.'};
    },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>[],checkSlots:async()=>[],
      insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
    recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
    const session=incidentSession(b,channel,'46700000001');
    if(operation==='status'){
      b.seedRecentCompletedBooking(session,language,{ok:true,bookingId:'synthetic-booking',businessId:3,
        serviceName:'Consultation',startTime:'2026-10-31T18:30:00+01:00',customerName:'Synthetic',sourceChannel:channel});
      const classified=b.recentCompletionClassification(session,copy.status,incidentConfig);
      assert.equal(classified?.category,'current_booking_status');
      if(language==='ar')assert.equal(classified?.statusSemantics,true,'Arabic confirmation survives normalized kaf/yeh');
    }
    await incidentInbound(b,channel,operation==='unverified_status'?copy.status:copy[operation]);
    assert.equal(knowledgeReads,0,'Genuine appointment operations cannot be intercepted by Knowledge');
    assert.equal(policies.length,0);assert.equal(mutations,0);
    assert.equal(replies.length,1,'One native delivery');
    if(operation==='status'){
      assert.ok(replies[0].startsWith(copy.header+'\n\n'),replies[0]);
      assert.match(replies[0],/18:30/u);
      assert.equal(b.conversationState(session).pending,null);
    }else if(operation==='unverified_status'){
      assert.equal(replies[0].includes(copy.header),false,'No verified status without completion evidence');
      assert.doesNotMatch(replies[0],/18:30/u);
    }
  }finally{Object.assign(incidentConfig,saved);b.reset();}
});
