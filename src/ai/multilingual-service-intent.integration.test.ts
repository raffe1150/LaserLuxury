import assert from 'node:assert/strict';
import { normalizeBookingRequest } from './booking-intelligence';
import { groundedSemanticServicePhrase, serviceIntentMatchScore, stripServiceTemporalSuffix } from './service-intent';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = new Date('2026-10-07T10:00:00Z');
const tomorrow = '2026-10-08';
const channels = ['instagram', 'messenger', 'whatsapp', 'telegram'] as const;
const video = { id: 'tenant-video', name: 'Video Consultation', durationMinutes: 30 };
const skin = { id: 'tenant-skin', name: 'Skin Consultation', durationMinutes: 45 };
const phrases = [
  { language: 'sv', service: 'videokonsultation', text: 'Jag vill boka en videokonsultation imorgon runt kl. 13:00.' },
  { language: 'en', service: 'Video Consultation', text: 'I want to book a Video Consultation tomorrow around 13:00.' },
  { language: 'de', service: 'Videoberatung', text: 'Ich möchte eine Videoberatung morgen gegen 13:00 buchen.' },
  { language: 'es', service: 'consulta por video', text: 'Quiero reservar una consulta por video mañana alrededor de las 13:00.' },
  { language: 'fa', service: 'مشاوره ویدیویی', text: 'می‌خواهم مشاوره ویدیویی فردا حدود ساعت ۱۳:۰۰ رزرو کنم.' },
  { language: 'ar', service: 'استشارة بالفيديو', text: 'أريد حجز استشارة بالفيديو غدًا حوالي الساعة ١٣:٠٠.' },
] as const;
let cases = 0;
let calendarReads = 0;
function configure(runtime?: any) {
  boundary.reset(); calendarReads = 0;
  boundary.configure({
    calendarAdapter: { getCalendarId: () => 'offline-calendar', getEvents: async () => { calendarReads++; return []; }, checkSlots: async () => { throw new Error('legacy slots must not run'); } },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    structuredUnderstandingAdoptionRuntime: runtime || null,
  } as any);
}
function config(language = 'sv', services: any[] = [video, skin], id = 'tenant-a') {
  return { id, language, businessName: 'Offline Clinic', timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'offline-calendar', services,
    workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [day, [{ start: '09:00', end: '18:00' }]])) };
}
const output = console.log, warn = console.warn, error = console.error;
console.log = console.warn = console.error = () => undefined;
try {
  for (const channel of channels) for (const phrase of phrases) {
    configure();
    assert.equal(boundary.extractConcreteRequestedService(phrase.text), phrase.service, phrase.text);
    const normalized = normalizeBookingRequest({ businessId: 'tenant-a', channel, conversationKey: 'offline', inputMode: 'text', text: phrase.text, timezone: 'Europe/Stockholm', now });
    assert.equal(normalized.date?.value, tomorrow, phrase.text);
    assert.equal(normalized.date?.relative, 'tomorrow', phrase.text);
    if (normalized.timeConstraint) {
      assert.equal(normalized.timeConstraint.kind, 'exact', phrase.text);
      assert.equal(normalized.timeConstraint.startMinutes, 780, phrase.text);
    }
    if (phrase.language === 'sv') assert.equal(normalized.timeConstraint?.startMinutes, 780, phrase.text);
    const result = await boundary.turn({sessionId: `offline-${channel}-${phrase.language}`, platformName: channel, recipientUserId: 'offline', text: phrase.text, businessConfig: config(phrase.language), now});
    assert.equal(result.pending?.service, video.name, `${channel}: ${phrase.text}`);
    assert.equal(result.pending?.serviceId, video.id, phrase.text);
    assert.equal(result.pending?.selectedDate, tomorrow, phrase.text);
    if (phrase.language === 'sv') assert.equal(result.pending?.normalizedBookingRequest?.timeConstraint?.startMinutes, 780, phrase.text);
    assert.equal(result.pending?.availabilityConstraint?.exactTime, '13:00', phrase.text);
    assert.equal(result.pending?.availabilityConstraint?.kind, phrase.language === 'de' ? 'approximate_time' : 'exact_time', phrase.text);
    assert.notEqual(result.pending?.status, 'awaiting_service', phrase.text);
    assert.ok(calendarReads > 0, phrase.text);
    assert.doesNotMatch(result.replies.join(' '), /kan inte matcha|cannot match|keiner buchbaren|No puedo asociar/u);
    cases++;
  }
  const variants = [
    'videokonsultation', 'video konsultation', 'videokonsultasion', 'videokonsultationen', 'videokonsultationer',
    'video consult', 'online consultation', 'virtual consultation', 'videoconsultation', 'Video Consultatio',
    'Videoberatung', 'Videoberatunng', 'Online Beratung', 'consulta por vídeo', 'consulta por vido', 'consulta online',
    'مشاوره ویدیویی', 'مشاوره ویدویی', 'مشاوره آنلاین', 'استشارة بالفيديو', 'استشاره بالفيديو', 'استشارة عن بعد',
    'video consulta', 'video مشاوره', 'video استشارة',
  ];
  for (const value of variants) {
    const resolved = boundary.resolveAuthoritativeService(`I want to book ${value} tomorrow around 13:00.`, config('en'));
    assert.equal(resolved.status, 'resolved', value);
    if (resolved.status === 'resolved') assert.equal(resolved.service.id, video.id, value);
    cases++;
  }
  for (const suffix of [
    'today', 'tomorrow around 13:00', 'at 13:00', 'before 13:00', 'after 13:00', 'morning', 'afternoon', 'evening', 'on Monday', 'on 2026-10-08', 'on October 8',
    'idag', 'imorgon runt kl. 13:00', 'före kl. 13:00', 'innan kl. 13:00', 'efter kl. 13:00', 'på morgonen', 'på eftermiddagen', 'på kvällen', 'på torsdag', 'den 8 oktober',
    'heute', 'morgen gegen 13:00', 'vor 13:00', 'nach 13:00', 'am Morgen', 'am Nachmittag', 'am Abend', 'am Montag', 'am 8. Oktober',
    'hoy', 'mañana alrededor de las 13:00', 'antes de las 13:00', 'después de las 13:00', 'por la mañana', 'por la tarde', 'por la noche', 'el lunes', 'el 8 de octubre',
    'امروز', 'فردا حدود ساعت ۱۳:۰۰', 'قبل از ساعت ۱۳:۰۰', 'بعد از ساعت ۱۳:۰۰', 'صبح', 'عصر', 'شب', 'پنجشنبه', '۸ اکتبر',
    'اليوم', 'غدًا حوالي الساعة ١٣:٠٠', 'قبل الساعة ١٣:٠٠', 'بعد الساعة ١٣:٠٠', 'صباحا', 'مساء', 'الاثنين', '٨ أكتوبر',
  ]) {
    assert.equal(stripServiceTemporalSuffix(`Deep Tissue Sports Massage ${suffix}`), 'Deep Tissue Sports Massage', suffix);
    assert.equal(boundary.extractConcreteRequestedService(`I want to book Deep Tissue Sports Massage ${suffix}.`), 'Deep Tissue Sports Massage', suffix);
    cases++;
  }
  for (const name of ['Deep Tissue Sports Massage', 'Premium Skin Care and Wellness Consultation', 'Good Morning Facial', 'Morgon Porträtt', 'Morgen Porträts', 'fotografering för företag', 'fotografering till minne']) {
    const text = `I want to book ${name} tomorrow around 13:00.`;
    assert.equal(boundary.extractConcreteRequestedService(text), name, name);
    const resolved = boundary.resolveAuthoritativeService(text, config('en', [{id: 'custom', name, durationMinutes: 45}]));
    assert.equal(resolved.status, 'resolved', name);
    if (resolved.status === 'resolved') assert.equal(resolved.service.id, 'custom');
    cases++;
  }
  // Multiple qualified equivalents must clarify; generic skin/premium are not video.
  for (const services of [[video, {...video,id:'another-video'}], [video, {id:'online',name:'Online Consultation',durationMinutes:30}], [video, {...video,id:'alias',name:'Remote Session',aliases:['video consult']}],
    Array.from({length: 8}, (_, i) => ({id:`remote-${i}`,name:`Remote ${i}`,aliases:['video consult']}))]) {
    const resolved = boundary.resolveAuthoritativeService('Jag vill boka videokonsultation imorgon runt kl. 13:00.', config('sv', services));
    assert.equal(resolved.status, 'ambiguous');
    configure();
    const result = await boundary.turn({sessionId:'ambiguous',platformName:'telegram',recipientUserId:'offline',text:phrases[0].text,businessConfig:config('sv',services),now});
    assert.equal(result.pending?.status,'awaiting_service');
    assert.equal(result.pending?.serviceId,null);
    assert.equal(calendarReads,0);
    cases++;
  }
  assert.equal(boundary.resolveAuthoritativeService('I want to book video editing tomorrow.', config('en')).status, 'unsupported'); cases++;
  for (const services of [[skin], [{...video,active:false}], [{...video,bookable:false}]]) {
    const result = boundary.resolveAuthoritativeService(phrases[0].text, config('sv', services, 'tenant-b'));
    assert.equal(result.status,'unsupported'); cases++;
  }
  // Same wording resolves to only the ID in the current tenant, independent of order or prior calls.
  for (const id of ['tenant-a','tenant-b','tenant-a']) for (const services of [[{...video,id:`${id}-video`},skin],[skin,{...video,id:`${id}-video`}]]) {
    const result = boundary.resolveAuthoritativeService(phrases[0].text,config('sv',services,id));
    assert.equal(result.status,'resolved'); if (result.status === 'resolved') assert.equal(result.service.id,`${id}-video`); cases++;
  }
  assert.ok(serviceIntentMatchScore('Video Consultatio','Video Consultation') >= 0.9);
  assert.equal(serviceIntentMatchScore('video editing','Video Consultation'),0);
  assert.equal(groundedSemanticServicePhrase('Haircut tomorrow','Video Consultation',1),null);
  assert.equal(groundedSemanticServicePhrase('video consult tomorrow','video consult',0.4),null);
  assert.equal(groundedSemanticServicePhrase('videoconsultation','consultation',1),null);
  // Provider helps find a phrase in unfamiliar syntax. It still cannot choose an ID.
  for (const channel of channels) for (const confidence of [0.99,0.4]) {
    const text = 'Could we arrange an online consultation for me tomorrow around 13:00?';
    configure({evaluate: async () => ({schemaVersion:1,language:{primary:{value:'en',confidence:1},codeSwitches:[]},intents:[{value:'new_booking',confidence:1}],acts:{},entities:{service:{value:{statedValue:'online consultation'},confidence}},ambiguities:[]}),emitDecisions:()=>{}});
    const result = await boundary.turn({sessionId:`semantic-${channel}`,platformName:channel,recipientUserId:'offline',text,businessConfig:config('en'),now,shadowEligibleCustomerTurn:true});
    if (confidence >= 0.8) {
      assert.equal(result.pending?.serviceId,video.id,channel);
      assert.equal(result.pending?.selectedDate,tomorrow,channel);
    } else assert.equal(result.pending?.serviceId,null,channel);
    cases++;
  }
  for (const scenario of [
    {text:'I want to book online consultation for me tomorrow around 13:00.',phrase:'online consultation',confidence:0.99,services:[video,skin],status:'resolved'},
    {text:'Could we arrange an online consultation tomorrow around 13:00?',phrase:'online consultation',confidence:0.99,services:[skin],status:'awaiting_service'},
    {text:'Could we arrange a haircut tomorrow around 13:00?',phrase:'Video Consultation',confidence:0.99,services:[video,skin],status:'awaiting_service'},
    {text:'Could we arrange an online consultation tomorrow around 13:00?',phrase:'online consultation',confidence:0.99,services:[video,{id:'remote',name:'Online Consultation',durationMinutes:30}],status:'awaiting_date_or_time'},
  ]) {
    configure({evaluate:async()=>({schemaVersion:1,language:{primary:{value:'en',confidence:1},codeSwitches:[]},intents:[{value:'new_booking',confidence:1}],acts:{},entities:{service:{value:{statedValue:scenario.phrase},confidence:scenario.confidence}},ambiguities:[]}),emitDecisions:()=>{}});
    const result=await boundary.turn({sessionId:'semantic-negative',platformName:'telegram',recipientUserId:'offline',text:scenario.text,businessConfig:config('en',scenario.services),now,shadowEligibleCustomerTurn:true});
    if (scenario.status === 'awaiting_service') {
      assert.equal(result.pending?.status,'awaiting_service',scenario.text);
      assert.equal(result.pending?.serviceId,null,scenario.text);
      assert.equal(calendarReads,0,scenario.text);
    } else assert.equal(result.pending?.serviceId,scenario.status === 'resolved' ? video.id : 'remote','grounded phrase resolves through exact tenant catalog');
    cases++;
  }
  const aliasCollision = boundary.resolveAuthoritativeService('video consult',config('en',[video,{id:'remote',name:'Remote Session',aliases:['video consult']}]));
  // The exact tenant alias has stronger evidence than a generic concept synonym.
  assert.equal(aliasCollision.status,'resolved');
  if(aliasCollision.status === 'resolved') assert.equal(aliasCollision.service.id,'remote'); cases++;
  const duplicateAlias = boundary.resolveAuthoritativeService('video consult',config('en',[{id:'one',name:'Remote One',aliases:['video consult']},{id:'two',name:'Remote Two',aliases:['video consult']}]));
  assert.equal(duplicateAlias.status,'ambiguous'); cases++;
  const foreign=boundary.resolveAuthoritativeService(phrases[0].text,config('sv',[{...video,business_id:'tenant-b'}],'tenant-a'));
  assert.equal(foreign.status,'unsupported'); cases++;
  output(`multilingual service intent regressions passed (${cases} cases)`);
} finally { boundary.reset(); console.log = output; console.warn = warn; console.error = error; }
