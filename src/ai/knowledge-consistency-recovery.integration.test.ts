import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'synthetic-offline-only';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['telegram','whatsapp','instagram','messenger'] as const;
const now = new Date('2026-10-15T15:44:00Z');
const config = {id:77,businessId:77,businessName:'Synthetic studio',language:'sv',timezone:'Europe/Stockholm',
 services:[{id:'video',name:'Video Consultation',durationMinutes:60}],defaultBookingService:'Video Consultation',calendarProvider:'custom',
 workingHours:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d=>[d,[{start:'09:00',end:'17:00'}]]))};
const parking='Det finns parkering nära studion.';
const digital='Vissa tjänster kan genomföras som digitala möten.';
const policy='Vi rekommenderar att boka tid i förväg.';
const evidence=[parking,digital,policy].join('\n');
const q={parking:'Hej! Finns det parkering i närheten av er studio?',policy:'Kan jag komma utan att boka tid i förväg?',
 compound:'Jag har två frågor: Finns det parkering nära er studio, och erbjuder ni digitala möten?',
 intro:'Innan vi bokar, kan du berätta om ni erbjuder digitala möten?',direct:'Erbjuder ni digitala möten?',
 availability:'Hej! Jag vill boka Video Consultation. Vilka tider har ni lediga nästa vecka?',
 detour:'Tack! Innan jag väljer en tid, kan du berätta om det finns parkering nära studion?',
 resume:'Okej, låt oss fortsätta med bokningen. Kan du visa lediga tider nästa vecka igen?'};
let deps:Parameters<typeof b.configure>[0], reads:number,repairs:number,current:boolean,mode:string;
const configure=(d:Parameters<typeof b.configure>[0])=>{deps={...deps,...d};b.configure(deps);};
const forbidden=async()=>assert.fail('No appointment mutation authorized');
const claim=(quote:string,citation=quote)=>({claim:quote,candidateQuote:quote,claimKind:'OTHER' as const,requiresBusinessEvidence:true,supported:true,
 evidence:[{source:'retrieved_knowledge' as const,quote:citation}]});
const assessment=(claims:any[])=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims});
beforeEach((t:any)=>{
 b.reset();deps={};reads=0;repairs=0;current=true;mode='present';
 for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,()=>{});
 configure({semanticLanguageResolver:async()=>({language:'sv',confidence:1}),
 knowledgeSearch:async(id)=>{assert.equal(id,77);return mode==='absent'?[]:[{businessId:mode==='foreign'?88:77,sourceId:'synthetic',text:evidence,score:1,metadata:{source:'document'}}];},
 semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(_id,m)=>current?m:[],
 geminiGenerate:async()=>({text:'{"canonicalMeaning":"business information","queries":[]}'}),
 assessBusinessClaimEntailment:async()=>({relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false}),
 calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>{reads++;return [];},checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
 recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100})});
});
afterEach(()=>b.reset());
const turn=(id:string,ch:typeof channels[number],text:string)=>b.turn({sessionId:id,recipientUserId:id,platformName:ch,text,businessConfig:config,now});
function recovery(fact:string){configure({geminiGenerate:async p=>{assert.match(p.config.systemInstruction,/COMPLETENESS REPAIR/);assert.equal(p.config.tools,undefined);repairs++;return {text:fact};},
 assessBusinessSupportGrounding:async r=>assessment([claim(r.candidateReply===fact?fact:fact.slice(0,-1),fact)])});}
const incomplete=(fact:string)=>`Ja, ${fact} Kontakta oss gärna för mer information.`;
async function finalize(id:string,text:string,candidate:string){return b.finalizeGeneralAiReply(id,text,candidate,'sv');}

for(const ch of channels)test(`${ch}: production sequence uses grounded facts through introductions and resumes a fresh read`,async()=>{
 const id=`sequence-${ch}`;
 for(const [text,facts] of [[q.parking,[parking]],[q.policy,[policy]],[q.compound,[parking,digital]],[q.intro,[digital]],[q.direct,[digital]]] as const){
  await turn(id,ch,text);const count=reads;recovery(facts[0]);
  if(facts.length>1)configure({assessBusinessSupportGrounding:async()=>assessment(facts.map(f=>claim(f)))});
  const result=await finalize(id,text,facts.length>1?facts.join('\n'):text===q.direct?digital:incomplete(facts[0]));
  for(const fact of facts)assert.ok(result.includes(fact),result);
  assert.doesNotMatch(result,/hittar ingen|kan inte verifiera|måste|krävs/iu);assert.equal(reads,count);
 }
 const first=await turn(id,ch,q.availability);const before=reads;assert.ok(before>0);const slots=first.pending?.offeredSlots;
 await turn(id,ch,q.detour);recovery(parking);assert.equal(await finalize(id,q.detour,incomplete(parking)),parking);
 const pending=b.businessInformationState(id);assert.ok(pending);
 const resumed=await turn(id,ch,q.resume);assert.ok(reads>before);assert.equal(resumed.pending?.service,'Video Consultation');
 assert.equal(resumed.pending?.dateTime,null);assert.equal(resumed.pending?.availabilityStartDate,'2026-10-19');
 assert.deepEqual(resumed.pending?.offeredSlots,slots,'fresh reads may return identical slots');
});
for(const active of [false,true])for(const [key,fact] of [['policy',policy],['intro',digital],['detour',parking]] as const)
 test(`${active?'active':'fresh'} ${key}: coverage failure can repair a verified clause without publishing uncovered prose`,async()=>{
 const id=`${active}-${key}`;if(active)await turn(id,'telegram',q.availability);await turn(id,'telegram',q[key]);recovery(fact);
 assert.equal(await finalize(id,q[key],incomplete(fact)),fact);assert.equal(repairs,1);
});
for(const state of ['absent','foreign','revoked-before','revoked-during','stale-during'] as const)test(`${state}: unavailable evidence never authorizes a repair answer`,async()=>{
 mode=state;const id=state;await turn(id,'telegram',q.intro);recovery(digital);
 if(state==='revoked-before')current=false;
 if(state==='revoked-during'||state==='stale-during')configure({geminiGenerate:async()=>{repairs++;current=false;return {text:digital};}});
 const result=await finalize(id,q.intro,incomplete(digital));assert.equal(result.includes(digital),false);
 if(state==='absent'||state==='foreign'||state==='revoked-before')assert.equal(repairs,0);
});
for(const failure of ['unknown-seed','bad-source','unknown-repair','mandatory-upgrade','wrong-service','prefix-identifier','tool-call','provider-error','unrelated','missing-assessment'] as const)
 test(`${failure}: recovery does not bypass grounding`,async()=>{
 const id=failure;await turn(id,'telegram',q.intro);
 const proposal=failure==='mandatory-upgrade'?'Alla digitala möten måste bokas i förväg.':failure==='wrong-service'?'Video Consultation genomförs alltid digitalt.':failure==='prefix-identifier'?'Digitala möten har kod BLÅ-742.5.':failure==='unrelated'?parking:digital;
 recovery(digital);
 configure({geminiGenerate:async()=>{repairs++;if(failure==='provider-error')throw Error('offline provider failure');return {text:proposal,...(failure==='tool-call'?{functionCalls:[{name:'createBooking',args:{}}]}:{})};},
 assessBusinessSupportGrounding:async r=>failure==='missing-assessment'?null:assessment([claim(r.candidateReply===proposal?(failure==='prefix-identifier'?'Digitala möten har kod BLÅ-742.':proposal):digital.slice(0,-1),failure==='bad-source'?'INVENTED CITATION':digital)]),
 assessBusinessClaimEntailment:async r=>({relation:failure==='unknown-seed'||(r.candidateQuote===proposal&&['unknown-repair','mandatory-upgrade','wrong-service'].includes(failure))?'UNKNOWN':'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false})});
 const result=await finalize(id,q.intro,incomplete(digital));assert.equal(result.includes(digital),false,result);assert.equal(result.includes(proposal),false,result);
 assert.ok(repairs<=2);if(['unknown-seed','bad-source','missing-assessment'].includes(failure))assert.equal(repairs,0);
});
for(const [language,question,fact] of [
 ['sv',q.intro,digital],['en','Before we book, are digital meetings possible?','Some services are offered as digital meetings.'],
 ['de','Bevor wir buchen: Bieten Sie digitale Treffen an?','Einige Leistungen werden als digitale Treffen angeboten.'],
 ['es','Antes de reservar, ¿hay reuniones digitales?','Algunos servicios se ofrecen como reuniones digitales.'],
 ['fa','قبل از رزرو، آیا جلسات آنلاین ارائه می‌دهید؟','برخی خدمات به صورت جلسات آنلاین ارائه می‌شوند.'],
 ['ar','قبل الحجز، هل تقدمون اجتماعات رقمية؟','تُقدَّم بعض الخدمات عبر اجتماعات رقمية.'],
] as const)test(`${language}: the same bounded repair respects language and evidence`,async()=>{
 configure({semanticLanguageResolver:async()=>({language,confidence:1}),knowledgeSearch:async()=>[{businessId:77,sourceId:'synthetic',text:fact,score:1,metadata:{source:'document'}}]});
 await turn(language,'telegram',question);assert.ok(b.businessInformationState(language),'information routing');recovery(fact);
 const result=await b.finalizeGeneralAiReply(language,question,`${({sv:'Ja,',en:'Yes,',de:'Ja,',es:'Sí,',fa:'بله،',ar:'نعم،'}[language])} ${fact} ${({sv:'Kontakta oss gärna.',en:'Please contact us.',de:'Bitte kontaktieren Sie uns.',es:'Puede contactarnos.',fa:'با ما تماس بگیرید.',ar:'اتصل بنا.'}[language])}` ,language);assert.equal(result,fact);assert.equal(repairs,1);
});

for(const text of ['ما رقم الهاتف في الحجز؟','ما رقمي في الحجز؟','ما رقمكم في الحجز؟','ما الرقم في الحجز؟'])test(`Arabic genuine phone request: ${text}`,()=>{
 b.seedRecentCompletedBooking('phone','ar',{ok:true,bookingId:'synthetic',businessId:'77',serviceName:'Video Consultation',startTime:'2026-10-19T09:00:00+02:00',customerName:'Synthetic',customerPhone:'0700000000',sourceChannel:'telegram'},60);
 assert.equal(b.recentCompletionClassification('phone',text,config,now)?.requestedDetails.phone,true);
});
test('Arabic digital adjective cannot become a phone request during a booking',async()=>{
 const id='arabic-active';await turn(id,'telegram',q.availability);
 configure({semanticLanguageResolver:async()=>({language:'ar',confidence:1})});
 const question='قبل الحجز، هل تقدمون اجتماعات رقمية؟';await turn(id,'telegram',question);
 assert.ok(b.businessInformationState(id));assert.equal(b.pendingStateSnapshot(id)?.service,'Video Consultation');assert.equal(b.pendingStateSnapshot(id)?.continuationPaused,true);
});
for(const bad of ['unrelated-policy','mandatory-booking'])test(`${bad}: policy repair requires exact requested-fact relevance and preserves recommendation scope`,async()=>{
 await turn(bad,'telegram',q.policy);recovery(policy);
 const proposed=bad==='mandatory-booking'?'يجب حجز جميع الخدمات مسبقًا.':'Vi rekommenderar att boka tid i förväg.';
 configure({geminiGenerate:async()=>{repairs++;return {text:proposed};},assessBusinessSupportGrounding:async r=>assessment([claim(r.candidateReply===proposed?proposed:policy.slice(0,-1),policy)]),
 assessBusinessClaimEntailment:async r=>({relation:r.requireRequestedFact||r.candidateQuote===proposed&&bad==='mandatory-booking'?'UNKNOWN':'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false})});
 const result=await finalize(bad,q.policy,incomplete(policy));assert.equal(result.includes(proposed),false);assert.ok(repairs>0);
});
