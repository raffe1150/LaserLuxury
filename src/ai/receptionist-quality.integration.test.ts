import assert from 'node:assert/strict';
import test from 'node:test';
import {priority1hUnifiedEngineTestBoundary as b} from '../../server';
import {renderDeterministicMissingDetailsReply} from './deterministic-booking-presentation';
test('German service inquiry reaches the final model instruction in German', async()=>{
  b.reset(); const requests:any[]=[];b.configure({postProcess:async()=>{},geminiGenerate:async req=>{requests.push(req);return{text:'Wir bieten Beratungsgespräche an.'};}});
  try {for(const language of ['de','sv']){
    b.promptAuditConfig({id:'quality-language-'+language,businessName:'Example',language,systemPrompt:'Consultation only.'});
    const result=await b.promptAuditWeb({chatId:'quality-german-'+language,message:'Welche Leistungen bieten Sie an?'});
    assert.equal(result.status,200);assert.match(requests.at(-1).config.systemInstruction,/ACTIVE CONVERSATION LANGUAGE: German \(de\)/);
  }}finally{b.reset();}
});
test('Spanish professional details do not mix usted commands with tu address',()=>{
  for(const responseLength of ['balanced','detailed'])for(const missing of [['name'],['phone'],['name','phone']] as Array<Array<'name'|'phone'>>){
    const output=renderDeterministicMissingDetailsReply('es',missing,{tonePreset:'professional',formality:'balanced',responseLength,emojiUsage:'none'});
    assert.doesNotMatch(output,/envíe tu/i);assert.match(output,/tu (?:nombre|número)/);
  }
});
test('stopping an unfinished booking request does not start appointment lookup',async()=>{
  b.reset();let reads=0;const config={id:'quality-stop',language:'en',businessName:'Example',calendarProvider:'custom',services:[{name:'Consultation',duration:30}]};
  b.configure({postProcess:async()=>{},calendarAdapter:{getEvents:async()=>{reads++;return[];},checkSlots:async()=>({available_slots_string:''})} as any});
  try{
    b.seedPending('quality-stop',{businessConfig:config,businessId:config.id,platform:'messenger',userId:'quality-stop',bookingStateVersion:3,operation:'new_booking',status:'awaiting_date_or_time',language:'en',service:'Consultation',selectedDate:'2026-09-14',requestedTime:'16:00',customerName:'Nadira',customerPhone:'0701234567',durationMinutes:30,createdAt:Date.now()});
    const result=await b.turn({sessionId:'quality-stop',platformName:'messenger',recipientUserId:'quality-stop',text:'Cancel this booking request.',businessConfig:config,now:new Date('2026-09-10T12:00:00Z')});
    assert.equal(result.pending,null);assert.match(result.replies.join(' '),/stopped this booking request/i);assert.doesNotMatch(result.replies.join(' '),/mobile|phone|name|\?/i);assert.equal(reads,0);
  }finally{b.reset();}
});
test('existing appointment cancellation still uses its lookup flow',async()=>{
  b.reset();const config={id:'quality-existing',language:'en',businessName:'Example',calendarProvider:'custom',allowCancellation:true};
  b.configure({postProcess:async()=>{},calendarAdapter:{getEvents:async()=>[],checkSlots:async()=>({available_slots_string:''})} as any});
  try{const result=await b.turn({sessionId:'quality-existing',platformName:'messenger',recipientUserId:'quality-existing',text:'Cancel my appointment.',businessConfig:config,now:new Date('2026-09-10T12:00:00Z')});assert.doesNotMatch(result.replies.join(' '),/stopped this booking request/i);assert.match(result.replies.join(' '),/mobile|phone/i);}finally{b.reset();}
});
