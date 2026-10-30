/** Offline deterministic identity regression. No provider,channel or calendar IO. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';

process.env.NODE_ENV='test';process.env.STRUCTURED_UNDERSTANDING_ENABLED='false';process.env.AI_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-offline-only';
for(const key of Object.keys(process.env))if(/SUPABASE|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|^DATABASE_URL$/u.test(key))delete process.env[key];
const originalFetch=globalThis.fetch;let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('Offline regression forbids network');};
const{priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const languages=['en','sv','de','fa','es','ar'] as const;
const services=['Video Consultation','Premium Consultation'];
const fallback={en:'appointment',sv:'bokning',de:'Termin',fa:'وقت',es:'cita',ar:'موعد'};
const records:Array<Record<string,unknown>>=[];
const configuration={id:77,businessId:77,businessName:'AdMotion Studio',language:'sv',timezone:'Europe/Stockholm',calendarProvider:'custom',services:services.map((name,i)=>({id:'service-'+i,name,durationMinutes:i?90:60})),defaultBookingService:services[0]};
after(()=>{b.reset();globalThis.fetch=originalFetch;assert.equal(networkAttempts,0);if(process.env.ODINLINK_CANONICAL_NAME_RESULTS)writeFileSync(process.env.ODINLINK_CANONICAL_NAME_RESULTS,JSON.stringify({mode:'OFFLINE_REAL_PRESENTATION_AND_SHARED_DURATION_PATH_NO_MODEL_SUCCESS_CLAIM',providerCalls:0,networkAttempts,externalCalendarCalls:0,records},null,2)+'\n',{flag:'wx'});});

for(const language of languages){
 for(const reminderType of ['24h','2h'] as const)for(const service of services)test(`${language}/${reminderType}: canonical stored reminder service ${service}`,()=>{
  const message=b.formatReminder({business_id:77,language,service,customer_name:'Test Customer',start_time:'2030-09-13T09:00:00+02:00'},configuration,reminderType);
  records.push({route:'reminder',language,reminderType,service,message});
  assert.ok(message.includes(service),'Exact authoritative service label must survive');assert.ok(message.includes(configuration.businessName));assert.equal(message.includes(service===services[0]?services[1]:services[0]),false);
 });
 for(const service of services)for(const known of [true,false])test(`${language}: duration formatter preserves canonical service ${service}/${known?'known':'unknown'}`,()=>{
  const durationMinutes=known?(service===services[0]?60:90):null,reply=b.formatServiceDuration(language,service,durationMinutes);
  records.push({route:'duration-formatter',language,service,durationMinutes,reply});
  assert.ok(reply.includes(service),'Duration reply must retain selected canonical identity');if(known)assert.ok(reply.includes(String(durationMinutes)));else assert.ok(!/60|90/u.test(reply),'Unknown duration must not invent a value');
 });
 test(`${language}: identity-free reminder fallback is unchanged`,()=>{
  for(const service of ['',null,undefined])for(const reminderType of ['24h','2h'] as const){const message=b.formatReminder({business_id:77,language,service,customer_name:'Test Customer',start_time:'2030-09-13T09:00:00+02:00'},configuration,reminderType);assert.ok(message.includes(fallback[language]));assert.ok(!services.some(name=>message.includes(name)));records.push({route:'identity-free-reminder',language,reminderType,service:service??null,message});}
 });
}
test('shared-word canonical services remain distinct in every language and reminder type',()=>{
 for(const language of languages)for(const reminderType of ['24h','2h'] as const){const output=services.map(service=>b.formatReminder({business_id:77,language,service,customer_name:'Test Customer',start_time:'2030-09-13T09:00:00+02:00'},configuration,reminderType));assert.notEqual(output[0],output[1]);}
});
test('opaque stored names retain exact capitalization,punctuation and Unicode',()=>{
 for(const language of languages)for(const service of ['Consultation – ویژه / AX-7','Full Body Laser PREMIUM','Bikini & Glow','  Video Consultation  ']){const message=b.formatReminder({business_id:77,language,service,customer_name:'Test Customer',start_time:'2030-09-13T09:00:00+02:00'},configuration,'24h');assert.ok(message.includes(service));}
});
