const assert=require('node:assert/strict');
require('node:test').mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-15T08:00:00Z')});
const {routingProbe:p,priority1hUnifiedEngineTestBoundary:b}=require('./.server.cjs');
const base={id:'7',businessName:'admotion studio',timezone:'Europe/Stockholm',language:'sv',calendarProvider:'google',services:[{name:'Video Consultation',durationMinutes:30},{name:'Other Service',durationMinutes:60}],whatsappPhoneNumberId:'synthetic-receiver',whatsappAccessToken:'synthetic',apiKey:'synthetic'};
const ambiguity='Menar du en ny bokning, ombokning, avbokning eller att kontrollera en tidigare bokning?';
let sent=[],writes=0,reads=0,model=0,seq=0,config,id;
function setup(overrides={}) {
 b.reset(); config={...base,...overrides}; b.promptAuditConfig(config);
 id=b.channelSessionId('whatsapp','46700000000',config,'synthetic-receiver');sent=[];writes=reads=model=0;
 const forbid=async()=>{writes++;throw Error('MUTATION FORBIDDEN');};
 b.configure({calendarAdapter:{getEvents:async()=>{reads++;return[]},checkSlots:async()=>{reads++;return{available_slots_string:''}},insertAppointment:forbid,updateAppointment:forbid,cancelAppointment:forbid},recordAppointment:forbid,claimOperation:forbid,notifyBooking:forbid,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),geminiGenerate:async()=>{model++;return{text:'OFFLINE_INFORMATION_ONLY'};}});
 global.fetch=async(url,init)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//); const body=JSON.parse(init.body);sent.push(body.text?.body);return new Response(JSON.stringify({messages:[{id:'synthetic'}]}));};
}
async function turn(text){const before=structuredClone(p.snapshot(id,text));const n=sent.length;await p.run({from:'46700000000',id:'synthetic-'+seq++,text:{body:text}},{phone_number_id:'synthetic-receiver'},config);assert.equal(writes,0,'no mutation before prerequisites');const result={text,before,after:structuredClone(p.snapshot(id,text)),responses:sent.slice(n)};console.log('TURN',JSON.stringify({text,before:before.pending?.status,after:result.after.pending?.status,service:result.after.pending?.service,operation:result.after.pending?.operation,language:result.after.pending?.language,date:result.after.pending?.selectedDate,ownedOfferCount:result.after.pending?.ownedOfferedSlots?.length,writes,reads,model,pre:before.pre,responses:result.responses}));return result;}
(async()=>{
 setup();
 let r=await turn('Vilka tider är lediga imorgon?');
 assert.equal(r.after.pending?.status,'awaiting_service');
 assert.equal(r.after.pending?.selectedDate,'2026-09-16');
 r=await turn('Video Consultation');
 assert.equal(r.after.pending?.service,'Video Consultation');
 assert.equal(r.after.pending?.serviceResolution,'authoritative');
 assert.equal(r.after.pending?.status,'awaiting_time_selection');
 assert.ok(r.after.pending?.ownedOfferedSlots.length>0);
 assert.equal(model,0,'service continuation is deterministic');
 for(let i=0;i<3;i++){r=await turn('Ny bokning');assert.ok(r.responses.every(x=>x!==ambiguity));assert.equal(r.after.pending?.operation,'new_booking');}
 setup(); await turn('Vilka tider är lediga imorgon?');r=await turn('Unknown Consultation');assert.notEqual(r.after.pending?.service,'Unknown Consultation');assert.equal(r.after.pending?.status,'awaiting_service');
 setup(); await turn('Vilka tider är lediga imorgon?');r=await turn('Vad kostar en bokning?');assert.equal(r.after.pending?.status,'awaiting_service');assert.notEqual(p.intent('Vad kostar en bokning?'),'new_booking');assert.equal(reads,0);
 setup(); await turn('Vilka tider är lediga imorgon?');r=await turn('Vad kostar Video Consultation?');assert.equal(r.after.pending?.status,'awaiting_service');assert.equal(reads,0);
 for(const text of ['Ny bokning','en ny bokning','New booking','a new booking','Neue Buchung','eine neue Buchung','Nueva reserva','una nueva reserva','رزرو جدید','حجز جديد','حجزًا جديدًا','jag vill boka en ny tid']) assert.equal(p.intent(text),'new_booking',text);
 for(const text of ['Ingen ny bokning','Vad betyder ny bokning?','Do I have a new booking?','inte ny bokning']) assert.notEqual(p.intent(text),'new_booking',text);
 setup(); r=await turn('Video Consultation');assert.equal(r.before.pre.returnsAmbiguousClarification,true);r=await turn('Ny bokning');assert.notEqual(r.responses.at(-1),ambiguity);assert.equal(r.after.pending?.operation,'new_booking');
 // Choosing the requested service after reaffirming the operation remains usable.
 r=await turn('Video Consultation');assert.equal(r.after.pending?.service,'Video Consultation');assert.equal(r.after.pending?.status,'awaiting_date_or_time');
 for(const text of ['Ny bokning','New booking','Neue Buchung','Nueva reserva','رزرو جدید','حجزًا جديدًا']) {
  setup();r=await turn(text);assert.equal(r.before.pre.intent,'new_booking',text);assert.equal(r.after.pending?.operation,'new_booking',text);assert.equal(r.after.pending?.status,'awaiting_service',text);
 }
 setup({services:[{name:'Video Consultation',durationMinutes:30}]});await turn('Vilka tider är lediga imorgon?');r=await turn('Ny bokning');assert.equal(r.before.pre.returnsAmbiguousClarification,false);
 setup({services:[{name:'Video Consultation',aliases:['Remote Consultation'],durationMinutes:30},base.services[1]]});await turn('Vilka tider är lediga imorgon?');r=await turn('Remote Consultation');assert.equal(r.after.pending?.service,'Video Consultation');assert.equal(r.after.pending?.status,'awaiting_time_selection');
 console.log('ROUTING REGRESSIONS PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
