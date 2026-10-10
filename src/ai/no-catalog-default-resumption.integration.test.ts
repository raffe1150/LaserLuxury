import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const now = new Date('2026-08-01T12:00:00+02:00');
const baseBusiness = { id: '7', businessName: 'Synthetic Service Clinic', timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7',
  serviceDurations: { Konsultation: 30, Massage: 45 } };
type Event = { id: string; status: string; summary: string; description: string;
  start: { dateTime: string }; end: { dateTime: string };
  extendedProperties: { private: { businessId: string; platform: Channel; userId: string } } };
function fixture(t: TestContext, channel: Channel, language: string, status = 'awaiting_service') {
  const business = { ...baseBusiness, language };
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  boundary.reset(); t.after(() => boundary.reset());
  const events = new Map<string, Event>();
  const claims = new Map<string, { claimed: boolean; keyHash: string; storageId: string;
    state: { type: string; status: string; attempts: number; claimedAt: number; updatedAt: number } }>();
  const count = { calendarWrites: 0, bookingWrites: 0, calendarReads: 0 };
  const created: Array<{ name: string; phone: string; service: string; dateTime: string; duration: number; marker: string }> = [];
  const recorded: Array<{ businessId: string; platform: Channel; userId: string; name: string; phone: string; service: string; dateTime: string }> = [];
  const recipient = '46700000001';
  // The shared engine boundary receives raw Meta/WhatsApp conversation IDs;
  // Telegram requires its tenant/bot/chat fixture representation.
  const session = channel === 'telegram' ? fixtureChannelSessionId(boundary, channel, recipient, business) : recipient;
  let active = business;
  const dependencies: Parameters<typeof boundary.configure>[0] = {
    semanticLanguageResolver: async () => null,
    calendarAdapter: {
      getCalendarId: () => 'cal-7', getEvents: async () => { count.calendarReads++; return [...events.values()]; },
      checkSlots: () => { throw Error('Legacy availability must not run'); },
      insertAppointment: async (customerName, customerPhone, service, dateTime, duration = 30, marker = '') => {
        count.calendarWrites++; created.push({ name: customerName, phone: customerPhone, service, dateTime, duration, marker });
        const event = { id: `synthetic-${count.calendarWrites}`, status: 'confirmed',
          summary: `Booked: ${customerName} - ${customerPhone}`,
          description: `BusinessId: ${active.id}\nPlatform: ${channel}\nUserId: ${marker}`,
          start: { dateTime: new Date(dateTime).toISOString() },
          end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: active.id, platform: channel, userId: marker } } };
        events.set(event.id, event); return { success: true, event };
      },
      getEventById: async id => events.get(id) || null,
      cancelAppointment: async () => { throw Error('No cancellation is authorized'); },
      updateAppointment: async () => { throw Error('No reschedule is authorized'); },
    }, postProcess: async () => undefined, notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    validateAppointment: async appointment => appointment,
    recordAppointment: async params => {
      count.bookingWrites++;
      recorded.push({ businessId: String(params.businessConfig.id), platform: params.platform, userId: String(params.userId),
        name: params.name, phone: params.phone, service: params.service, dateTime: params.dateTime });
      return { id: count.bookingWrites, business_id: String(params.businessConfig.id), platform: params.platform,
        user_id: String(params.userId), service: params.service, start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + Number(params.durationMinutes) * 60_000).toISOString(), status: 'booked' };
    },
    claimOperation: async params => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const previous = claims.get(key);
      if (previous) return { ...previous, claimed: false, duplicateStatus: previous.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key,
        state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle); return handle;
    },
    settleOperation: async (handle, status) => { handle.state.status = status; return true; },
  };
  boundary.configure(dependencies);
  function seed(config = business, date: string | null = null, conversation = session, user = recipient) {
    active = config; boundary.seedFlowLanguage(conversation, language);
    boundary.seedPending(conversation, { businessId: config.id, platform: channel, userId: user, businessConfig: config,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status,
      expectedInput: 'service', service: 'Bokning', serviceResolution: null, language,
      selectedDate: date, availabilityStartDate: date, availabilityEndDate: date,
      offeredSlots: [], ownedOfferedSlots: [], dateTime: null, selectedSlotEnd: null, durationMinutes: null,
      createdAt: Date.now(), updatedAt: Date.now() });
  }
  function seedOffers(config = business) {
    active = config; boundary.seedFlowLanguage(session, language);
    const slots = ['13:45', '14:00', '14:15'].map(time => {
      const start = `2026-08-17T${time}:00+02:00`;
      return { start, end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
        durationMinutes: 30, service: 'Konsultation', businessId: config.id, platform: channel, userId: recipient,
        generatedAt: Date.now(), searchStartDate: '2026-08-17', searchEndDate: '2026-08-17' };
    });
    boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient, businessConfig: config,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status: 'awaiting_time_selection',
      expectedInput: 'slot_selection', service: 'Konsultation', serviceResolution: 'authoritative', durationMinutes: 30, language,
      selectedDate: '2026-08-17', availabilityStartDate: '2026-08-17', availabilityEndDate: '2026-08-17',
      offeredSlots: slots.map(slot => `Monday (ISO: ${slot.start})`), ownedOfferedSlots: slots, dateTime: null,
      createdAt: Date.now(), updatedAt: Date.now() });
    return slots;
  }
  if (status !== 'fresh') seed();
  async function turn(text: string, config = business, conversation = session, user = recipient) {
    active = config;
    const before = boundary.pendingStateSnapshot(conversation);
    const result = await boundary.turn({ sessionId: conversation, platformName: channel, recipientUserId: user, text, businessConfig: config, now });
    process.stdout.write(`RC03G ${JSON.stringify({ text, channel, businessId: config.id, before, pending: result.pending,
      operation: result.operation, replies: result.replies, count, created, recorded })}\n`);
    return result;
  }
  return { turn, seed, seedOffers, count, created, recorded, session, recipient, business };
}


const choices = [
 ['en', ['I want to book Konsultation.', 'Book Konsultation.', 'Konsultation please.', 'Konsultation.', 'Consultation sounds good.']],
 ['sv', ['Jag vill boka en konsultation.', 'Boka Konsultation.', 'Konsultation tack.', 'Konsultation.', 'En konsultation låter bra, tack!']],
 ['de', ['Ich möchte eine Beratung buchen.', 'Beratung buchen.', 'Konsultation bitte.', 'Konsultation.', 'Ich nehme Beratung.']],
 ['es', ['Quiero reservar una consulta.', 'Reservar consulta.', 'Konsultation por favor.', 'Konsultation.', 'Elijo consulta.']],
 ['fa', ['می‌خواهم مشاوره رزرو کنم.', 'مشاوره را رزرو کنید.', 'مشاوره لطفاً.', 'Konsultation.', 'مشاوره را انتخاب می‌کنم.']],
 ['ar', ['أريد حجز استشارة.', 'احجز استشارة.', 'استشارة من فضلك.', 'Konsultation.', 'أختار استشارة.']],
] as const;
const unsafe = [
 "I don't want Konsultation.", "I don't know if Konsultation is right.", 'How much is Konsultation?',
 'I want to book Hair Treatment.', 'I want to book Dental Consultation.', 'I want to book Konsultation or Massage.',
 'My friend said: "Book Konsultation".', "My friend said: 'Book Konsultation'.", 'A note says Book Konsultation.',
 'Konsultation was mentioned in my reference.', 'Book Konsultation. Actually I want Hair Treatment.',
 'Consultation sounds good, but I am not sure.',
 'Book Konsultation B.', 'Book Konsultation+.', 'Book Premium Konsultation.',
] as const;
function noWrites(f: ReturnType<typeof fixture>) { assert.equal(f.count.calendarWrites, 0); assert.equal(f.count.bookingWrites, 0); }
function fresh(f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof f.turn>>, service = 'Konsultation', duration = 30, businessId = '7') {
 assert.equal(result.pending?.status, 'awaiting_time_selection'); assert.equal(result.pending?.service, service);
 assert.equal(result.pending?.durationMinutes, duration); assert.equal(result.pending?.dateTime, null);
 assert.equal(f.count.calendarReads, 1); assert.ok(result.pending?.ownedOfferedSlots.length > 0); noWrites(f);
 for(const slot of result.pending.ownedOfferedSlots) {
  assert.equal(slot.service, service); assert.equal(slot.durationMinutes, duration); assert.equal(slot.businessId, businessId);
  assert.equal(slot.platform, result.pending.platform); assert.equal(slot.userId, f.recipient);
  assert.equal(new Date(slot.end).getTime()-new Date(slot.start).getTime(), duration*60_000);
 }
}
for(const channel of channels) for(const [language,texts] of choices) for(const text of texts)
 test(`${channel}/${language}: positive default choice resumes: ${text}`,async t=>{
  const f=fixture(t,channel,language); const resolution=boundary.resolveAuthoritativeService(text,f.business);assert.equal(resolution.status,'resolved');
  if(resolution.status==='resolved') assert.equal(resolution.source,'explicit_default');
  const r=await f.turn(text); fresh(f,r); assert.equal(r.pending?.serviceId,null);
 });
for(const channel of channels) for(const text of unsafe) test(`${channel}: unsafe default mention cannot resume: ${text}`,async t=>{
 const f=fixture(t,channel,'en'); const r=await f.turn(text);
 assert.equal(r.pending?.status,'awaiting_service'); assert.deepEqual(r.pending?.ownedOfferedSlots,[]);
 assert.equal(f.count.calendarReads,0); noWrites(f);
});
for(const [language,texts] of [
 ['sv',['Jag vill inte boka konsultation.','Jag vet inte om konsultation passar mig.','Vad kostar konsultation?','Jag vill boka en tandkonsultation.']],
 ['de',['Ich möchte keine Beratung buchen.','Ich weiß nicht, ob Beratung richtig ist.','Wie viel kostet Beratung?','Ich möchte eine Zahnberatung buchen.']],
 ['es',['No quiero reservar consulta.','No sé si consulta es lo adecuado.','¿Cuánto cuesta consulta?','Quiero reservar una consulta dental.']],
 ['fa',['نمی‌خواهم مشاوره رزرو کنم.','نمی‌دانم مشاوره مناسب است یا نه.','هزینه مشاوره چقدر است؟','می‌خواهم مشاوره دندان رزرو کنم.']],
 ['ar',['لا أريد حجز استشارة.','لا أعرف إن كانت استشارة مناسبة.','كم تكلفة استشارة؟','أريد حجز استشارة أسنان.']],
] as const) for(const text of texts) test(`${language}: unsafe localized choice stays unresolved: ${text}`,async t=>{
 const f=fixture(t,'instagram',language); const r=await f.turn(text);
 assert.equal(r.pending?.status,'awaiting_service'); assert.deepEqual(r.pending?.ownedOfferedSlots,[]);
 assert.equal(f.count.calendarReads,0); noWrites(f);
});
const exactChoice='En konsultation låter bra, tack! Jag vill gärna boka in en tid för att få hjälp att välja rätt tjänst.';
test('exact historical line-965 sequence creates fresh offers after service reopening',async t=>{
 const g=fixture(t,'telegram','sv');
 const initial=await g.turn('Jag behöver boka en tid, men jag vet inte vilken tjänst som passar.');
 assert.equal(initial.pending?.status,'awaiting_service');const old=g.seedOffers();
 for(const text of [
  'Jag förstår att ni har tider den 17 augusti, men jag vet fortfarande inte vilken typ av tjänst jag ska boka. Kan ni hjälpa mig att reda ut det?',
  'Jag förstår att ni har tider den 17 augusti, men jag behöver först veta vilken typ av tjänst ni erbjuder. Kan ni beskriva de olika tjänsterna ni har så jag kan välja rätt en?',
 ]) {const r=await g.turn(text);assert.equal(r.pending?.status,'awaiting_service');assert.deepEqual(r.pending?.ownedOfferedSlots,[]);assert.equal(r.pending?.selectedDate,null);}
 const r=await g.turn(exactChoice);fresh(g,r);assert.notDeepEqual(r.pending.ownedOfferedSlots,old);
 assert.ok(r.pending.ownedOfferedSlots.every((slot:{start:string})=>!slot.start.startsWith('2026-08-17')));
});
for(const channel of channels) test(`${channel}: reopened choice never restores stale offers`,async t=>{
 const f=fixture(t,channel,'en');const old=f.seedOffers();
 const r=await f.turn("I still don't know which service to book.");assert.equal(r.pending?.status,'awaiting_service');
 assert.deepEqual(r.pending?.ownedOfferedSlots,[]);assert.equal(r.pending?.selectedDate,null);
 const done=await f.turn('Book Konsultation.');fresh(f,done);assert.notDeepEqual(done.pending.ownedOfferedSlots,old);
});
for(const channel of channels) test(`${channel}: fresh conversation retains established default booking`,async t=>{
 const f=fixture(t,channel,'en','fresh');
 const r=await f.turn('I want to book Konsultation.');fresh(f,r);
});
for(const channel of channels) test(`${channel}: default choice with fresh explicit date honors it`,async t=>{
 const f=fixture(t,channel,'en');const r=await f.turn('I want to book Konsultation on August 17.');fresh(f,r);
 assert.ok(r.pending.ownedOfferedSlots.every((slot:{start:string})=>slot.start.startsWith('2026-08-17')));
});
for(const channel of channels) test(`${channel}: configured duration replaces discarded offer duration`,async t=>{
 const f=fixture(t,channel,'en');const config={...f.business,serviceDurations:{Konsultation:45,Massage:60}};f.seed(config);
 const r=await f.turn('Book Konsultation.',config);fresh(f,r,'Konsultation',45);
});
for(const channel of channels) test(`${channel}: business defaults and offer ownership stay isolated`,async t=>{
 const f=fixture(t,channel,'en');const a=await f.turn('Book Konsultation.');fresh(f,a);
 const b={...f.business,id:'8',defaultBookingService:'Massage'};
 const rejected=await f.turn('Book Konsultation.',b);
 assert.ok(!(rejected.pending?.ownedOfferedSlots||[]).some((slot:{businessId:string})=>slot.businessId==='7'));noWrites(f);
 f.seed(b); const before=f.count.calendarReads;const accepted=await f.turn('Book Massage.',b);
 assert.equal(accepted.pending?.service,'Massage');assert.equal(accepted.pending?.durationMinutes,45);
 assert.equal(accepted.pending?.status,'awaiting_time_selection');assert.equal(f.count.calendarReads,before+1);
 for(const slot of accepted.pending.ownedOfferedSlots){assert.equal(slot.businessId,'8');assert.equal(slot.service,'Massage');assert.equal(slot.userId,f.recipient);}
 noWrites(f);
});
for(const channel of channels) test(`${channel}: resumed default books exactly once with valid contact and slot`,async t=>{
 const f=fixture(t,channel,'en');const offered=await f.turn('Book Konsultation.');fresh(f,offered);
 const slot=offered.pending.ownedOfferedSlots[0];await f.turn(slot.start.slice(11,16));noWrites(f);
 const text='Yes, my name is Elin Testlund and my phone number is 0700001102.';
 const done=await f.turn(text);assert.equal(done.pending,null);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
 assert.equal(f.created[0].service,'Konsultation');assert.equal(f.created[0].duration,30);assert.equal(f.recorded[0].businessId,'7');assert.equal(f.recorded[0].userId,f.recipient);
 await f.turn(text);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
});
for(const config of [
 {...baseBusiness,defaultBookingService:''},
 {...baseBusiness,services:[{id:'inactive',name:'Konsultation',active:false,durationMinutes:30}]},
 {...baseBusiness,services:[{id:'active',name:'Konsultation',active:true,durationMinutes:30}]},
]) test(`catalog/default boundary unchanged: ${JSON.stringify(config)}`,async t=>{
 const f=fixture(t,'messenger','en');const r=await f.turn('Konsultation please.',{...config,language:'en'});
 assert.notEqual(r.pending?.status,'awaiting_time_selection');assert.equal(f.count.calendarReads,0);noWrites(f);
});

for(const channel of channels) test(`${channel}: separate business/session offers cannot leak`,async t=>{
 const f=fixture(t,channel,'en');const a=await f.turn('Book Konsultation.');fresh(f,a);
 const b={...f.business,id:'8',defaultBookingService:'Massage'};const userB='46700000002';
 const sessionB=channel==='telegram'?fixtureChannelSessionId(boundary,channel,userB,b):userB;
 f.seed(b,null,sessionB,userB);const before=f.count.calendarReads;const result=await f.turn('Book Massage.',b,sessionB,userB);
 assert.equal(result.pending?.status,'awaiting_time_selection');assert.equal(result.pending?.service,'Massage');
 assert.equal(result.pending?.durationMinutes,45);assert.equal(f.count.calendarReads,before+1);
 for(const slot of result.pending.ownedOfferedSlots){assert.equal(slot.businessId,'8');assert.equal(slot.userId,userB);assert.equal(slot.platform,channel);assert.equal(slot.service,'Massage');}
 assert.deepEqual(boundary.pendingStateSnapshot(f.session).ownedOfferedSlots,a.pending.ownedOfferedSlots);noWrites(f);
});
for(const channel of channels) test(`${channel}: explicit default resumption preserves already collected contact`,async t=>{
 const f=fixture(t,channel,'en');const old=boundary.pendingStateSnapshot(f.session);
 boundary.seedPending(f.session,{...old,customerName:'Elin Testlund',customerPhone:'0700001102',contactPhoneSource:'explicit_customer_message'});
 const result=await f.turn('Book Konsultation.');fresh(f,result);
 assert.equal(result.pending?.customerName,'Elin Testlund');assert.equal(result.pending?.customerPhone,'0700001102');
});
for(const channel of channels) test(`${channel}: retained valid date is used for a fresh default scan`,async t=>{
 const f=fixture(t,channel,'en');f.seed(f.business,'2026-08-17');const result=await f.turn('Konsultation please.');fresh(f,result);
 assert.ok(result.pending.ownedOfferedSlots.every((slot:{start:string})=>slot.start.startsWith('2026-08-17')));
});
