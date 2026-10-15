import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { businessInformationTopics, isBusinessInformationQuestion } from './business-information';
import { detectNormalizedIntent, normalizeBookingRequest, getZonedSlotParts } from './booking-intelligence';
import { isBookingResumeRequest } from './booking-interruption';
import { composeGroundedBookingReply } from './grounded-booking-composition';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'synthetic-offline-only';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const now = new Date('2026-10-15T10:00:00Z');
const config = { id: 77, businessId: 77, businessName: 'Synthetic studio', language: 'sv', timezone: 'Europe/Stockholm',
  services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 60 }], defaultBookingService: 'Video Consultation', calendarProvider: 'custom',
  toneConfig: { tonePreset: 'professional', emojiUsage: 'none' },
  workingHours: Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d => [d,[{start:'09:00',end:'17:00'}]])) };
const questions = {
  A: 'Hej! Finns det parkering i närheten av er studio?',
  B: 'Kan jag komma utan att boka tid i förväg?',
  C: 'Jag har två frågor: Finns det parkering nära er studio, och erbjuder ni digitala möten?',
  D: 'Innan vi bokar, kan du berätta om ni erbjuder digitala möten?',
  E: 'Hej! Jag vill boka Video Consultation. Vilka tider har ni lediga nästa vecka?',
  F: 'Okej, låt oss fortsätta med bokningen av Video Consultation. Jag vill se lediga tider nästa vecka.',
  G: 'Du har inte visat några tider för nästa vecka. Kan du kontrollera kalendern och visa vilka tider som är lediga mellan 19 och 25 oktober?',
};
const parking = 'Det finns parkering nära studion.';
const digital = 'Vissa tjänster erbjuds som digitala möten.';
const booking = 'Besök behöver bokas i förväg.';
const evidence = [parking, digital, booking].join('\n');
let searches: string[], reads: any[], diagnostics: any[], presentation: any[];
let dependencies: Parameters<typeof b.configure>[0];
const configure = (value: Parameters<typeof b.configure>[0]) => { dependencies = {...dependencies,...value}; b.configure(dependencies); };
const forbidden = async () => { assert.fail('No appointment mutation is authorized'); };
beforeEach((t: any) => {
  b.reset(); dependencies={}; searches=[]; reads=[]; diagnostics=[]; presentation=[];
  for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,()=>{});
  configure({ semanticLanguageResolver: async()=>({language:'sv',confidence:1}),
    knowledgeSearch: async(id,q)=>{assert.equal(id,77); searches.push(q); return [{businessId:77,sourceId:'synthetic',text:evidence,score:1,metadata:{source:'document',filename:'synthetic.txt'}}];},
    semanticKnowledgeSearch: async()=>[], validateKnowledgeMatches:async(_id,m)=>m,
    geminiGenerate: async()=>({text:'{"canonicalMeaning":"business information","queries":[]}'}),
    calendarAdapter: {getCalendarId:()=> 'synthetic', getEvents: async(...args:any[])=>{reads.push(args);return [];},checkSlots: async()=>({available_slots_string:''}),
      insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
    recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden,postProcess:async()=>{},
    incrementUsage:async()=>({allowed:true,count:1,limit:100}),
    knowledgeRetrievalDiagnostic:d=>diagnostics.push(d),bookingPresentationDiagnostic:d=>presentation.push(d),
    assessBusinessClaimEntailment: async()=>({relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false}),
  });
});
afterEach(()=>b.reset());
const turn=(id:string,ch:typeof channels[number],text:string)=>b.turn({sessionId:id,recipientUserId:id,platformName:ch,text,businessConfig:config,now});
function seed(id:string,ch:typeof channels[number],slots=true){
  const start='2026-10-16T09:00:00+02:00',end='2026-10-16T08:00:00.000Z';
  b.seedPending(id,{businessConfig:config,businessId:'77',platform:ch,userId:id,operation:'new_booking',status:'awaiting_time_selection',expectedInput:'slot_selection',
    service:'Video Consultation',serviceId:'video',serviceResolution:'authoritative',language:'sv',selectedDate:'2026-10-16',
    availabilityStartDate:'2026-10-16',availabilityEndDate:'2026-10-16',
    availabilityConstraint:{kind:'exact_date',startDate:'2026-10-16',endDate:'2026-10-16'},
    normalizedBookingRequest:{intent:'new_booking',language:'sv',requiresClarification:false,date:{kind:'exact_date',value:'2026-10-16',confidence:'high'}},
    offeredSlots:slots?[`fredag 16 oktober kl 09:00 (ISO: ${start})`]:[],
    ownedOfferedSlots:slots?[{start,end,businessId:'77',platform:ch,userId:id,service:'Video Consultation',serviceId:'video',durationMinutes:60,generatedAt:Date.now()-3600_000}]:[],
    dateTime:null,selectedSlotEnd:null});
}
const claim=(text:string,supported=true,quote=text)=>({claim:text,candidateQuote:text,claimKind:'OTHER' as const,requiresBusinessEvidence:true,supported,
  evidence:supported?[{source:'retrieved_knowledge' as const,quote}]:[]});
function assessment(claims:any[]){configure({assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:claims.every(c=>c.supported),claims})});}

const languages = [
 ['sv','Kan jag komma utan att boka tid i förväg?','Jag vill boka Video Consultation.','nästa vecka','Har ni parkering och erbjuder ni digitala möten?'],
 ['en','Can I come without booking in advance?','I want to book Video Consultation.','next week','Do you have parking and offer digital meetings?'],
 ['de','Kann ich ohne vorherige Buchung vorbeikommen?','Ich möchte Video Consultation buchen.','nächste Woche','Haben Sie Parkplätze und bieten Sie digitale Treffen an?'],
 ['es','¿Puedo venir sin reservar con antelación?','Quiero reservar Video Consultation.','la próxima semana','¿Hay aparcamiento y ofrecen reuniones digitales?'],
 ['fa','آیا می‌توانم بدون رزرو قبلی مراجعه کنم؟','می‌خواهم Video Consultation رزرو کنم.','هفته آینده','آیا پارکینگ دارید و جلسات آنلاین ارائه می‌دهید؟'],
 ['ar','هل يمكنني الحضور بدون حجز مسبق؟','أريد حجز Video Consultation.','الأسبوع القادم','هل توجد مواقف وتقدمون اجتماعات رقمية؟'],
] as const;
for(const [language,policy,action,week,compound] of languages){
 test(`${language}: booking requirements are information, creation remains an action`,()=>{
   assert.equal(isBusinessInformationQuestion(policy),true);assert.equal(detectNormalizedIntent(policy),'general_question');
   const withoutQuestionMark=policy.replace(/[?؟¿]/gu,'');
   assert.equal(isBusinessInformationQuestion(withoutQuestionMark),true);assert.equal(detectNormalizedIntent(withoutQuestionMark),'general_question');
   assert.equal(isBusinessInformationQuestion(action),false);assert.equal(detectNormalizedIntent(action),'new_booking');
   assert.equal(isBusinessInformationQuestion(`${policy} ${action}`),false,'an independently stated creation request remains actionable');
 });
 test(`${language}: next calendar week uses the business timezone and Monday–Sunday boundaries`,()=>{
   const r=normalizeBookingRequest({businessId:'77',channel:'telegram',conversationKey:'synthetic',text:`${action} ${week}`,timezone:config.timezone,activeLanguage:language,inputMode:'text',now});
   assert.deepEqual(r.date,{kind:'date_range',value:'2026-10-19',endValue:'2026-10-25',confidence:'high'});
 });
 test(`${language}: parking and digital delivery have independent requested roles`,()=>{
   assert.ok(businessInformationTopics(compound).includes('parking'));
   assert.ok(businessInformationTopics(compound).includes('meetings'));
 });
}
test('inflected Swedish resume instruction is recognized',()=>assert.equal(isBookingResumeRequest(questions.F),true));
for(const ch of channels){
 for(const active of [false,true])for(const key of ['A','B','C','D'] as const)test(`${ch}/${active?'active':'fresh'}: recorded Swedish ${key} reaches authorized Knowledge`,async()=>{
   const id=`${ch}-${active}-${key}`;if(active)seed(id,ch);
   const r=await turn(id,ch,questions[key]);assert.equal(r.handled,false);assert.ok(searches.length>0);assert.equal(reads.length,0);
   assert.ok(b.businessInformationState(id)?.retrievedKnowledge.includes(digital));
   if(active){assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.continuationPaused,true);}
   assert.deepEqual(b.geminiToolNames(id),[]);
   const expected = key==='A'?[parking]:key==='B'?[booking]:key==='C'?[parking,digital]:[digital];
   assessment(expected.map(f=>claim(f)));
   const final = await b.finalizeGeneralAiReply(id,questions[key],expected.join('\n'),'sv');
   for(const fact of expected)assert.ok(final.includes(fact));
   assert.doesNotMatch(final,/ingen specifik uppgift|kan inte verifiera/iu);
 });
 test(`${ch}: initial next-week request reads Calendar and offers only that week`,async()=>{
   const r=await turn(`week-${ch}`,ch,questions.E);assert.ok(reads.length>0);assert.equal(searches.length,0);
   assert.equal(r.pending?.availabilityConstraint?.startDate,'2026-10-19');assert.equal(r.pending?.availabilityConstraint?.endDate,'2026-10-25');
   assert.ok(r.pending?.ownedOfferedSlots.length>0);
   assert.ok(r.pending.ownedOfferedSlots.every((s:any)=>{const d=getZonedSlotParts(s.start,config.timezone)!.date;return d>='2026-10-19'&&d<='2026-10-25';}));
   assert.equal(r.pending?.dateTime,null);assert.doesNotMatch(r.replies.join(' '),/vilket datum|vilken dag/iu);
 });
 for(const oldOffers of [false,true])test(`${ch}: detour and explicit resume honors fresh week (${oldOffers?'old offers':'no offers'})`,async()=>{
   const id=`resume-${ch}-${oldOffers}`;seed(id,ch,oldOffers);await turn(id,ch,questions.D);const before=reads.length;
   const r=await turn(id,ch,questions.F);assert.equal(r.handled,true);assert.ok(reads.length>before,'resume must read Calendar');
   assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.availabilityConstraint?.startDate,'2026-10-19');
   assert.equal(r.pending?.availabilityConstraint?.endDate,'2026-10-25');assert.ok(r.pending?.ownedOfferedSlots.length>0);
   assert.equal(r.pending?.continuationPaused,undefined);assert.doesNotMatch(r.replies.join(' '),/vilken av de föreslagna tiderna|16 oktober/iu);
 });
 test(`${ch}: correction receives fresh Calendar evidence and safe acknowledgment`,async()=>{
   const id=`correction-${ch}`;seed(id,ch);const r=await turn(id,ch,questions.G);
   assert.ok(reads.length>0);assert.equal(r.pending?.availabilityConstraint?.startDate,'2026-10-19');
   assert.match(r.replies.join(' '),/förtydligandet/iu);assert.equal(r.pending?.dateTime,null);
   assert.doesNotMatch(r.replies.join(' '),/bokning är bekräftad|😊/iu);
 });
}
for(const [label,q,candidate,claims,expected,missing] of [
 ['A contradiction',questions.A,`${parking} Alla platser är gratis.`,[claim(parking),claim('Alla platser är gratis.',false)],[parking],[]],
 ['C independent answers',questions.C,`${parking}\n${digital}`, [claim(parking),claim(digital)],[parking,digital],[]],
 ['D incomplete extraction coverage',questions.D,`Ja! ${digital} Det fungerar bra.`,[claim(digital)],[digital],[]],
 ['C scoped unknown',questions.C,`${parking} Vi erbjuder digitala möten utan begränsningar.`,[claim(parking),claim('Vi erbjuder digitala möten utan begränsningar.',false)],[parking],['digital']],
] as const)test(`${label}: independently grounded facts survive; uncertainty is scoped`,async()=>{
 const id=label;await turn(id,'telegram',q);assessment([...claims]);
 const reply=await b.finalizeGeneralAiReply(id,q,candidate,'sv');
 for(const fact of expected)assert.ok(reply.includes(fact),reply);
 assert.doesNotMatch(reply,/Alla platser är gratis|utan begränsningar|Det fungerar bra/u);
 if(!missing.length)assert.doesNotMatch(reply,/kan inte|hittar ingen|saknar.*uppgift|ingen specifik/iu);
 else{assert.match(reply,/digital/iu);assert.doesNotMatch(reply,/om parkering|uppgift.*parkering/iu);}
 const sent=b.finalConversationConcision(reply,b.finalConversationConcisionBudget(q));
 for(const fact of expected)assert.ok(sent.includes(fact));
});
test('compound missing digital answer is repaired once from evidence and independently grounded',async()=>{
 const id='repair';await turn(id,'telegram',questions.C);let repairs=0;
 configure({geminiGenerate:async p=>{assert.match(p.config.systemInstruction,/COMPLETENESS REPAIR/);repairs++;return {text:digital};},
   assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[claim(r.candidateReply)]})});
 const reply=await b.finalizeGeneralAiReply(id,questions.C,parking,'sv');
 assert.equal(repairs,1);assert.ok(reply.includes(parking));assert.ok(reply.includes(digital));assert.equal(reads.length,0);
});
for(const mode of ['lexical','semantic','absent','foreign','stale','provider-error'] as const)test(`${mode}: document provenance and final grounding remain independent`,async()=>{
 const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);
 const extracted=documentChunks([{text:evidence}],'synthetic.txt');
 await storage.create({id:'doc',businessId:77,type:'document',status:'ready',title:'synthetic.txt',content:extracted.content,metadata:extracted.metadata,createdAt:now.toISOString(),updatedAt:now.toISOString()});
 await storage.replaceChunks(77,'doc',extracted.chunks.map((c:any,i:number)=>({chunkIndex:i,content:c.content,metadata:c.metadata})));
 const matches=await service.search(77,'parkering',5);
 configure({knowledgeSearch:async()=>mode==='lexical'||mode==='stale'?matches:mode==='foreign'?matches.map(m=>({...m,businessId:88})):[],
  semanticKnowledgeSearch:async()=>{if(mode==='provider-error')throw Error('offline semantic failure');return mode==='semantic'?matches:[];},
  validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m)});
 await turn(mode,'telegram',questions.A);assessment([claim(parking)]);
 if(mode==='stale')await storage.delete(77,'doc');
 const reply=await b.finalizeGeneralAiReply(mode,questions.A,parking,'sv');
 assert.equal(reply.includes(parking),mode==='lexical'||mode==='semantic');
 const d=diagnostics.at(-1);assert.equal(d.semanticMatchCount,mode==='semantic'?1:0);
 assert.equal(d.mergeStrategy,mode==='semantic'?'reciprocal_rank_fusion':'lexical_fallback');
 assert.equal(reads.length,0);
});
for(const [timezone,instant,start,end] of [
 ['Europe/Stockholm','2026-10-18T22:30:00Z','2026-10-26','2026-11-01'],
 ['America/Los_Angeles','2026-10-19T02:30:00Z','2026-10-19','2026-10-25'],
 ['Europe/Stockholm','2026-12-31T11:00:00Z','2027-01-04','2027-01-10'],
] as const)test(`next-week boundary ${timezone} ${instant}`,()=>{
 const r=normalizeBookingRequest({businessId:'77',channel:'telegram',conversationKey:'synthetic',text:'next week',timezone,activeLanguage:'en',inputMode:'text',now:new Date(instant)});
 assert.equal(r.date?.value,start);assert.equal(r.date?.endValue,end);
});

for (const [language,text,ack] of [
 ['sv','Du har inte visat några tider.','förtydligandet'], ['en',"You have not shown any times.",'clarifying'],
 ['de','Sie haben keine Zeiten gezeigt, nicht gezeigt.','Klarstellung'], ['es','No has mostrado horarios.','aclararlo'],
 ['fa','شما زمان‌ها را نشان ندادید.','توضیحتان'], ['ar','لم تعرض أي مواعيد.','التوضيح'],
] as const)test(`${language}: correction acknowledgment changes presentation only`,async()=>{
 const compose=(slots:string[])=>composeGroundedBookingReply({scope:language,facts:{kind:'availability',language,slots},fallback:'VERIFIED FALLBACK',
   latestText:text,history:[],toneConfig:{emojiUsage:'none'},languageMatches:()=>true});
 assert.ok((await compose(['EXACT VERIFIED SLOT'])).text.includes(ack));
 assert.equal((await compose([])).text,'VERIFIED FALLBACK','no claim of a successful new search on error/no evidence');
});

for(const ch of channels)test(`${ch}: complete E → D → F → G sequence and repeated correction keep fresh owned offers`,async()=>{
 const id=`sequence-${ch}`;await turn(id,ch,questions.E);await turn(id,ch,questions.D);
 for(const text of [questions.F,questions.G,questions.G]){
   const previousReads=reads.length;const r=await turn(id,ch,text);assert.ok(reads.length>previousReads);
   assert.equal(r.pending?.language,'sv');assert.equal(r.pending?.availabilityConstraint?.startDate,'2026-10-19');
   assert.equal(r.pending?.availabilityConstraint?.endDate,'2026-10-25');assert.equal(r.pending?.dateTime,null);
   assert.ok(r.pending?.ownedOfferedSlots.length>0);assert.doesNotMatch(r.replies.join(' '),/vilken av de föreslagna tiderna/iu);
 }
});
for(const ch of channels)test(`${ch}: Calendar failure → information → fresh resume stays fail-closed`,async()=>{
 configure({calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>{reads.push('error');throw Error('synthetic Calendar outage');},checkSlots:forbidden,insertAppointment:forbidden} as any});
 const id=`outage-${ch}`;await turn(id,ch,questions.E);const before=reads.length;
 assert.equal((await turn(id,ch,questions.D)).handled,false);assert.equal(reads.length,before);
 const resumed=await turn(id,ch,questions.F);assert.ok(reads.length>before);
 assert.equal(resumed.pending?.dateTime??null,null);assert.equal(resumed.pending?.ownedOfferedSlots?.length??0,0);
 assert.doesNotMatch(resumed.replies.join(' '),/föreslagna tiderna|bokning är bekräftad/iu);
});
for(const outcome of ['invented-citation','wrong-service','unsupported-absence','provider-failure','tool-call','unrelated-fact'] as const)test(`completeness repair ${outcome} cannot publish unverified facts`,async()=>{
 const id=`repair-${outcome}`;await turn(id,'telegram',questions.C);let calls=0;
 const bad=outcome==='wrong-service'?'Video Consultation erbjuds alltid digitalt.':outcome==='unsupported-absence'?'Digitala möten kräver ingen bokning.':outcome==='unrelated-fact'?'Vi erbjuder gratis parkering.':digital;
 configure({geminiGenerate:async p=>{assert.match(p.config.systemInstruction,/COMPLETENESS REPAIR/);assert.equal(p.config.tools,undefined);calls++;
   if(outcome==='provider-failure')throw Error('synthetic provider outage');
   return {text:bad,...(outcome==='tool-call'?{functionCalls:[{name:'createBooking',args:{}}]}:{})};},
   assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,
     claims:[{...claim(r.candidateReply,true,outcome==='invented-citation'&&r.candidateReply===bad?'THIS CITATION DOES NOT EXIST':r.candidateReply===bad?digital:parking),
       ...(outcome==='unsupported-absence'&&r.candidateReply===bad?{claimKind:'NEGATIVE_ABSENCE' as const}:{})}]}),
   assessBusinessClaimEntailment:async r=>({relation:r.atomicClaim===bad&&(outcome==='wrong-service'||outcome==='unsupported-absence'||outcome==='unrelated-fact')?'UNKNOWN':'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false})});
 const reply=await b.finalizeGeneralAiReply(id,questions.C,parking,'sv');
 assert.ok(calls<=2,'one logical repair request; provider wrapper permits at most its bounded retry');
 assert.ok(reply.includes(parking));assert.equal(reply.includes(bad),false);assert.match(reply,/digital/iu);assert.equal(reads.length,0);
});
test('a document revoked during completeness repair cannot authorize publication',async()=>{
 const id='revoked-during-repair';let current=true;configure({validateKnowledgeMatches:async(_id,m)=>current?m:[]});
 await turn(id,'telegram',questions.C);
 configure({geminiGenerate:async()=>{current=false;return {text:digital};},
   assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[claim(r.candidateReply)]})});
 const reply=await b.finalizeGeneralAiReply(id,questions.C,parking,'sv');assert.equal(reply.includes(parking),false);assert.equal(reply.includes(digital),false);
});
test('Calendar date precedence survives a relative-week mention',()=>{
 const r=normalizeBookingRequest({businessId:'77',channel:'telegram',conversationKey:'precedence',text:'next week, 23 October 2026',timezone:config.timezone,activeLanguage:'en',inputMode:'text',now});
 assert.equal(r.date?.kind,'exact_date');assert.equal(r.date?.value,'2026-10-23');
});
