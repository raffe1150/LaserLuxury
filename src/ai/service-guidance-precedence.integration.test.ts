import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { isBusinessInformationQuestion } from './business-information';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const now = new Date('2027-05-20T12:00:00+02:00');
const baseBusiness = { id: '7', businessName: 'Synthetic Service Clinic', timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7',
  services: [{id:'consult',name:'Konsultation',aliases:['Remote Session'],durationMinutes:30,active:true},
    {id:'laser',name:'Laser Treatment',durationMinutes:60,active:true}] };
type Event = { id: string; status: string; summary: string; description: string;
  start: { dateTime: string }; end: { dateTime: string };
  extendedProperties: { private: { businessId: string; platform: Channel; userId: string } } };
function fixture(t: TestContext, channel: Channel, language: string, status = 'awaiting_time_selection') {
  const business = { ...baseBusiness, language };
  const withSender = false;
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
  function seed(config = business, customerName?: string) {
    active = config;
    boundary.seedFlowLanguage(session, language);
    const slots = ['13:45', '14:00', '14:15'].map(time => {
      const slotStart = `2027-05-21T${time}:00+02:00`;
      return { start: slotStart, end: new Date(new Date(slotStart).getTime() + 30 * 60_000).toISOString(),
        durationMinutes: 30, service: 'Konsultation', businessId: config.id, platform: channel, userId: recipient,
        generatedAt: Date.now(), searchStartDate: '2027-05-21', searchEndDate: '2027-05-21' };
    });
    const selected = status === 'awaiting_confirmation';
    boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient, businessConfig: config,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status,
      expectedInput: selected ? 'confirmation' : 'slot_selection', service: 'Konsultation', serviceId: 'consult',
      serviceResolution: 'authoritative', durationMinutes: 30, language, customerName,
      selectedDate: '2027-05-21', dateTime: selected ? slots[0].start : null,
      selectedSlotEnd: selected ? slots[0].end : null, createdAt: Date.now(), updatedAt: Date.now(),
      offeredSlots: slots.map(slot => `Friday (ISO: ${slot.start})`), ownedOfferedSlots: slots,
      normalizedBookingRequest: { intent: 'new_booking', language, requiresClarification: false,
        service: { normalized: 'Konsultation', confidence: 'high' },
        date: { kind: 'exact_date', value: '2027-05-21', confidence: 'high' },
        timeConstraint: { kind: 'none', confidence: 'high' } },
      availabilityConstraint: { startDate: '2027-05-21', endDate: '2027-05-21', kind: 'whole_day', rejectedTimes: [] },
    });
  }
  seed();
  async function turn(text: string, config = business) {
    active = config;
    const before = boundary.pendingStateSnapshot(session);
    const result = await boundary.turn({ sessionId: session, platformName: channel, recipientUserId: recipient, text, businessConfig: config, now });
    process.stdout.write(`RC03F ${JSON.stringify({ text, channel, businessId: config.id, before, pending: result.pending,
      operation: result.operation, replies: result.replies, count, created, recorded })}\n`);
    return result;
  }
  return { turn, seed, count, created, recorded, session, recipient };
}

const messages = [
 ['en', "I still don't know which service I should book. Can you help me choose?", 'Maybe another service.', 'I still want to book a consultation.', 'How much does this service cost?', 'How long does this service take?'],
 ['sv', 'Jag vet fortfarande inte vilken typ av tjänst jag ska boka. Kan ni hjälpa mig att reda ut det?', 'Kanske en annan tjänst.', 'Jag vill fortfarande boka en konsultation.', 'Vad kostar den här tjänsten?', 'Hur lång tid tar den här tjänsten?'],
 ['de', 'Ich bin nicht sicher, welche Behandlung ich brauche.', 'Vielleicht eine andere Behandlung.', 'Konsultation.', 'Wie viel kostet diese Dienstleistung?', 'Wie lange dauert diese Dienstleistung?'],
 ['es', 'No sé qué servicio reservar. ¿Me ayudas a elegir?', 'Quizá otro servicio.', 'Konsultation.', '¿Cuánto cuesta este servicio?', '¿Cuánto dura este servicio?'],
 ['fa', 'نمی‌دانم کدام خدمت را باید رزرو کنم. برای انتخاب کمک می‌خواهم.', 'شاید یک خدمت دیگر.', 'Konsultation.', 'هزینه این خدمت چقدر است؟', 'مدت این خدمت چقدر است؟'],
 ['ar', 'لا أعرف أي خدمة أحتاج. ساعدني في الاختيار.', 'ربما خدمة أخرى.', 'Konsultation.', 'كم تكلفة هذه الخدمة؟', 'كم مدة هذه الخدمة؟'],
] as const;
function noWrites(f: ReturnType<typeof fixture>) {
 assert.equal(f.count.calendarWrites,0); assert.equal(f.count.bookingWrites,0);
}
function unresolved(result: Awaited<ReturnType<ReturnType<typeof fixture>['turn']>>) {
 assert.equal(result.pending?.status,'awaiting_service'); assert.equal(result.pending?.service,'Bokning');
 assert.deepEqual(result.pending?.ownedOfferedSlots,[]); assert.deepEqual(result.pending?.offeredSlots,[]);
 assert.equal(result.pending?.dateTime,null); assert.equal(result.pending?.durationMinutes,null);
}
for (const channel of channels) for (const [language,uncertain,another,same,price,duration] of messages) {
 for(const status of ['awaiting_time_selection','awaiting_confirmation']) test(`${channel}/${language}/${status}: explicit service uncertainty invalidates offers and selection`,async t=>{
  const f=fixture(t,channel,language,status); const result=await f.turn(uncertain); unresolved(result);
  assert.equal(f.count.calendarReads,0); noWrites(f);
  const later=await f.turn('13:45'); assert.notEqual(later.pending?.status,'awaiting_confirmation');
  assert.equal(later.pending?.dateTime,null); assert.deepEqual(later.pending?.ownedOfferedSlots,[]); noWrites(f);
 });
 test(`${channel}/${language}: maybe another service reopens choice`,async t=>{
  const f=fixture(t,channel,language); unresolved(await f.turn(another)); assert.equal(f.count.calendarReads,0); noWrites(f);
 });
 test(`${channel}/${language}: same authoritative service retains offers`,async t=>{
  const f=fixture(t,channel,language); const before=boundary.pendingStateSnapshot(f.session);
  const result=await f.turn(same); assert.equal(result.pending?.service,'Konsultation');
  assert.deepEqual(result.pending?.ownedOfferedSlots,before.ownedOfferedSlots); assert.equal(f.count.calendarReads,0);
  const selected=await f.turn('13:45'); assert.equal(selected.pending?.status,'awaiting_confirmation'); noWrites(f);
 });
 for (const text of [price,duration]) test(`${channel}/${language}: information preserves selected service: ${text}`,async t=>{
  const f=fixture(t,channel,language,'awaiting_confirmation'); const before=boundary.pendingStateSnapshot(f.session);
  const result=await f.turn(text); assert.equal(result.pending?.service,'Konsultation');
  assert.equal(result.pending?.status,'awaiting_confirmation');assert.equal(result.pending?.dateTime,before.dateTime);
  assert.deepEqual(result.pending?.ownedOfferedSlots,before.ownedOfferedSlots); assert.equal(f.count.calendarReads,0);noWrites(f);
  if (isBusinessInformationQuestion(text)) {
   assert.equal(result.handled,false);assert.ok(boundary.businessInformationState(f.session));
  }
 });
}
for (const channel of channels) {
 for(const status of ['awaiting_time_selection','awaiting_confirmation']) test(`${channel}/${status}: explicit different service rebuilds its own 60-minute availability`,async t=>{
  const f=fixture(t,channel,'en',status);const old=boundary.pendingStateSnapshot(f.session);
  const result=await f.turn('Actually, Laser Treatment.');
  assert.equal(result.pending?.service,'Laser Treatment');assert.equal(result.pending?.durationMinutes,60);
  assert.equal(result.pending?.dateTime,null);assert.equal(f.count.calendarReads,1);noWrites(f);
  assert.ok(result.pending?.ownedOfferedSlots.length>0);
  for(const slot of result.pending.ownedOfferedSlots){assert.equal(slot.service,'Laser Treatment');assert.equal(slot.durationMinutes,60);assert.equal(slot.businessId,'7');}
  assert.notDeepEqual(result.pending?.ownedOfferedSlots,old.ownedOfferedSlots);
 });
 test(`${channel}: standalone recognized same-service alias preserves offers`,async t=>{
  const f=fixture(t,channel,'en');const old=boundary.pendingStateSnapshot(f.session);
  const r=await f.turn('Remote Session.');assert.deepEqual(r.pending?.ownedOfferedSlots,old.ownedOfferedSlots);noWrites(f);
 });
 test(`${channel}: business information and incidental service mention preserve selection`,async t=>{
  const f=fixture(t,channel,'en','awaiting_confirmation');const old=boundary.pendingStateSnapshot(f.session);
  for(const text of ['What are your opening hours?','What services would you recommend for a first-time visitor?','I do not want another service.']){
   const r=await f.turn(text);assert.equal(r.pending?.dateTime,old.dateTime);assert.equal(r.pending?.service,'Konsultation');noWrites(f);
  }
 });
 test(`${channel}: service uncertainty cannot leak A slots into business B`,async t=>{
  const f=fixture(t,channel,'sv');await f.turn(messages[1][1]);
  const b={...baseBusiness,id:'8',language:'sv'};const r=await f.turn('13:45',b);
  assert.equal(r.pending?.dateTime??null,null);assert.ok(!(r.pending?.ownedOfferedSlots||[]).some((slot:{businessId:string})=>slot.businessId==='7'));noWrites(f);
 });
 test(`${channel}: new service and fresh selection still book exactly once`,async t=>{
  const f=fixture(t,channel,'en');const changed=await f.turn('Actually, Laser Treatment.');
  const slot=changed.pending.ownedOfferedSlots[0];
  await f.turn(slot.start.slice(11,16));
  const done=await f.turn('Yes, my name is Elin Testlund and my phone number is 0700001102.');
  assert.equal(done.pending,null);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
  assert.equal(f.created[0].service,'Laser Treatment');assert.equal(f.created[0].duration,60);
  assert.equal(f.recorded[0].businessId,'7');assert.equal(f.recorded[0].userId,f.recipient);
  await f.turn('Yes, my name is Elin Testlund and my phone number is 0700001102.');
  assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
 });
}
test('exact line-938 service uncertainty preserves the existing expected contract',async t=>{
 const f=fixture(t,'telegram','sv');const r=await f.turn('Jag förstår att ni har tider den 17 augusti, men jag vet fortfarande inte vilken typ av tjänst jag ska boka. Kan ni hjälpa mig att reda ut det?');
 unresolved(r);assert.equal(r.handled,false);assert.deepEqual(r.replies,[]);noWrites(f);
 const followup=await f.turn('Jag förstår att ni har tider den 17 augusti, men jag behöver först veta vilken typ av tjänst ni erbjuder. Kan ni beskriva de olika tjänsterna ni har så jag kan välja rätt en?');
 unresolved(followup);assert.equal(followup.handled,false);noWrites(f);
});

for (const channel of channels) for (const text of [
 'Actually, change to Laser Treatment. How much does it cost?',
 'Actually, I want to book wedding photography instead. How much does it cost?',
]) test(`${channel}: explicit correction cannot hide inside a price question: ${text}`,async t=>{
 const f=fixture(t,channel,'en','awaiting_confirmation');const r=await f.turn(text);noWrites(f);
 assert.equal(r.pending?.dateTime,null);
 if(text.includes('Laser Treatment')){assert.equal(r.pending?.service,'Laser Treatment');assert.equal(r.pending?.durationMinutes,60);assert.ok(r.pending?.ownedOfferedSlots.length>0);}
 else unresolved(r);
});
for(const channel of channels) test(`${channel}: an ambiguous catalog replacement cannot retain the previous service`,async t=>{
 const f=fixture(t,channel,'en');const config={...baseBusiness,language:'en',services:[...baseBusiness.services,
  {id:'face',name:'Laser Face',durationMinutes:30,active:true},{id:'legs',name:'Laser Legs',durationMinutes:60,active:true}]};
 const r=await f.turn('Actually, I want laser instead.',config);unresolved(r);noWrites(f);assert.equal(f.count.calendarReads,0);
});
for(const [language,text] of [
 ['de','Wie viel kostet diese Dienstleistung? Welche Preise gelten?'],
 ['de','Wie lange dauern Ihre Dienstleistungen?'],
 ['fa','مدت این خدمت چقدر است؟ لطفاً درباره خدمات توضیح بدهید.'],
] as const) test(`${language}: existing recognized information path remains grounded and preserves selection`,async t=>{
 const f=fixture(t,'instagram',language,'awaiting_confirmation');const old=boundary.pendingStateSnapshot(f.session);
 assert.equal(isBusinessInformationQuestion(text),true);const r=await f.turn(text);
 assert.equal(r.handled,false);assert.ok(boundary.businessInformationState(f.session));
 assert.equal(r.pending?.dateTime,old.dateTime);assert.deepEqual(r.pending?.ownedOfferedSlots,old.ownedOfferedSlots);noWrites(f);
});

for(const channel of channels) test(`${channel}: quoted third-party uncertainty is incidental information`,async t=>{
 const f=fixture(t,channel,'en','awaiting_confirmation');const old=boundary.pendingStateSnapshot(f.session);
 const r=await f.turn('A customer said: "I do not know which service to book." What are your opening hours?');
 assert.equal(r.pending?.dateTime,old.dateTime);assert.deepEqual(r.pending?.ownedOfferedSlots,old.ownedOfferedSlots);noWrites(f);
});
for(const channel of channels) test(`${channel}: explicit replacement booking request outranks its price question`,async t=>{
 const f=fixture(t,channel,'en','awaiting_confirmation');const r=await f.turn('I want to book Laser Treatment. How much does it cost?');
 assert.equal(r.pending?.service,'Laser Treatment');assert.equal(r.pending?.dateTime,null);assert.equal(r.pending?.durationMinutes,60);noWrites(f);
});
