import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const now = new Date('2026-08-16T12:00:00+02:00');
type CatalogService = { id?: string; name: string; aliases?: string[]; durationMinutes: number; price?: number; currency?: string; active: boolean; business_id?: string };
const video: CatalogService = { id:'video',name:'Video Consultation',aliases:['Remote Session'],durationMinutes:45,price:650,currency:'SEK',active:true };
const laser: CatalogService = { id:'laser',name:'Laser Treatment',durationMinutes:60,price:900,currency:'SEK',active:true };
const baseBusiness = { id:'7',businessName:'Synthetic Identity Clinic',timezone:'Europe/Stockholm',
  calendarProvider:'custom',googleCalendarId:'cal-7',services:[video,laser] as CatalogService[] };
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
  boundary.seedFlowLanguage(session, language);
  async function turn(text: string, config = business) {
    active = config;
    const before = boundary.pendingStateSnapshot(session);
    const result = await boundary.turn({ sessionId: session, platformName: channel, recipientUserId: recipient, text, businessConfig: config, now });
    process.stdout.write(`RC03I ${JSON.stringify({ text, channel, businessId: config.id, before, pending: result.pending,
      operation: result.operation, replies: result.replies, count, created, recorded })}\n`);
    return result;
  }
  return { turn, seed, count, created, recorded, session, recipient, business };
}

const languages=['en','sv','de','es','fa','ar'] as const;
const localized = { en:'Online Consultation',sv:'Videokonsultation',de:'Videoberatung',es:'Videoconsulta',fa:'مشاوره ویدیویی',ar:'استشارة فيديو' };
function noWrites(f: ReturnType<typeof fixture>) { assert.equal(f.count.calendarWrites,0);assert.equal(f.count.bookingWrites,0); }
async function offered(f: ReturnType<typeof fixture>, config=f.business, name='Video Consultation') {
 const r=await f.turn(`I want to book ${name} on August 17.`,config);
 assert.equal(r.pending?.ownedOfferedSlots.length,3);return r.pending;
}
for(const channel of channels) for(const language of languages) {
 for(const wording of ['Video Consultation','Remote Session','Online Consultation',localized[language]]) test(`${channel}/${language}: same catalog target retains offers: ${wording}`,async t=>{
  const f=fixture(t,channel,language);const before=await offered(f);const reads=f.count.calendarReads;
  const r=await f.turn(wording);assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.serviceId,'video');assert.equal(r.pending?.durationMinutes,45);
  assert.deepEqual(r.pending?.ownedOfferedSlots,before.ownedOfferedSlots);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}/${language}: compatible selected slot survives restatement`,async t=>{
  const f=fixture(t,channel,language);await offered(f);const selected=await f.turn('14:00');const reads=f.count.calendarReads;
  assert.equal(selected.pending?.status,'awaiting_confirmation');const r=await f.turn('Video Consultation');
  assert.equal(r.pending?.status,'awaiting_confirmation');assert.equal(r.pending?.dateTime,selected.pending?.dateTime);assert.equal(r.pending?.selectedSlotEnd,selected.pending?.selectedSlotEnd);
  assert.deepEqual(r.pending?.ownedOfferedSlots,selected.pending?.ownedOfferedSlots);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}/${language}: different catalog service produces fresh own-duration offers`,async t=>{
  const f=fixture(t,channel,language);await offered(f);await f.turn('14:00');const reads=f.count.calendarReads;const r=await f.turn('Actually, Laser Treatment.');
  assert.equal(r.pending?.serviceId,'laser');assert.equal(r.pending?.service,'Laser Treatment');assert.equal(r.pending?.durationMinutes,60);assert.equal(r.pending?.dateTime,null);
  assert.equal(f.count.calendarReads,reads+1);for(const s of r.pending.ownedOfferedSlots){assert.equal(s.durationMinutes,60);assert.equal(s.service,'Laser Treatment');assert.equal(s.serviceId,'laser');assert.equal(s.businessId,'7');}noWrites(f);
 });
 for(const selected of [false,true]) for(const change of ['duration','id'] as const) test(`${channel}/${language}: ${change} drift invalidates ${selected?'selected':'offered'} slot`,async t=>{
  const f=fixture(t,channel,language);const config={...f.business,services:[{...video,name:'Konsultation',id:'consult',durationMinutes:30}]};await offered(f,config,'Konsultation');
  if(selected) await f.turn('14:00',config);const reads=f.count.calendarReads;
  const next={...config,services:config.services.map(s=>({...s,...(change==='duration'?{durationMinutes:60}:{id:'replacement'})}))};
  const r=await f.turn('Konsultation',next);assert.equal(r.pending?.serviceId,change==='id'?'replacement':'consult');assert.equal(r.pending?.durationMinutes,change==='duration'?60:30);
  assert.equal(r.pending?.dateTime,null);assert.equal(r.pending?.status,'awaiting_time_selection');assert.equal(f.count.calendarReads,reads+1);assert.equal(r.pending?.ownedOfferedSlots.length,3);
  for(const s of r.pending.ownedOfferedSlots){assert.equal(s.durationMinutes,change==='duration'?60:30);assert.equal(s.serviceId,change==='id'?'replacement':'consult');}noWrites(f);
 });
 test(`${channel}/${language}: variant target never falls back to shorter component`,async t=>{
  const f=fixture(t,channel,language);const config={...f.business,services:[{id:'face',name:'Face',durationMinutes:30,price:300,active:true},{id:'face-neck',name:'Face + Neck',durationMinutes:60,price:600,active:true}]};
  await offered(f,config,'Face');await f.turn('14:00',config);const reads=f.count.calendarReads;const r=await f.turn('Face + Neck',config);
  assert.equal(r.pending?.service,'Face + Neck');assert.equal(r.pending?.serviceId,'face-neck');assert.equal(r.pending?.durationMinutes,60);assert.equal(r.pending?.dateTime,null);assert.equal(f.count.calendarReads,reads+1);
  for(const s of r.pending.ownedOfferedSlots){assert.equal(s.service,'Face + Neck');assert.equal(s.serviceId,'face-neck');assert.equal(s.durationMinutes,60);}noWrites(f);
 });
 test(`${channel}/${language}: same name in another business cannot reuse offers`,async t=>{
  const f=fixture(t,channel,language);await offered(f);const next={...f.business,id:'8',services:[{...video,durationMinutes:75}]};const r=await f.turn('Video Consultation',next);
  assert.equal(r.pending?.businessId,'8');assert.equal(r.pending?.durationMinutes,75);assert.deepEqual(r.pending?.ownedOfferedSlots,[]);noWrites(f);
 });
}
for(const channel of channels) {
 test(`${channel}: price-only refresh keeps scheduling offers and current metadata`,async t=>{
  const f=fixture(t,channel,'en');const before=await offered(f);const reads=f.count.calendarReads;const next={...f.business,services:[{...video,price:850},laser]};const r=await f.turn('Video Consultation',next);
  assert.deepEqual(r.pending?.ownedOfferedSlots,before.ownedOfferedSlots);assert.equal(r.pending?.businessConfig.services[0].price,850);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}: valid canonical service completes exactly once with its duration`,async t=>{
  const f=fixture(t,channel,'en');await offered(f);await f.turn('Remote Session');await f.turn('14:00');await f.turn('Yes');
  const r=await f.turn('My name is Elin Testlund and my phone number is 0700001102.');
  assert.equal(r.pending,null);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);assert.equal(f.created[0].service,'Video Consultation');assert.equal(f.created[0].duration,45);assert.equal(f.recorded[0].businessId,'7');
  await f.turn('Yes');assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
 });
}
for(const channel of channels) {
 for(const weakSelectedLabel of [false,true]) test(`${channel}: verified ID reconciles legacy normalized service state`,async t=>{
  const f=fixture(t,channel,'en');const p=await offered(f);const legacy={...p,service:weakSelectedLabel?'Konsultation':p.service,
   normalizedBookingRequest:{...p.normalizedBookingRequest,service:{normalized:'Konsultation',confidence:'high'}}};
  boundary.seedPending(f.session,legacy);const reads=f.count.calendarReads;const r=await f.turn('Video Consultation');
  assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.serviceId,'video');assert.equal(r.pending?.normalizedBookingRequest.service.normalized,'Video Consultation');
  assert.deepEqual(r.pending?.ownedOfferedSlots,p.ownedOfferedSlots);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}: unique catalog name works when IDs are absent`,async t=>{
  const f=fixture(t,channel,'en');const {id:_id,...withoutId}=video;const config={...f.business,services:[withoutId,laser]};const p=await offered(f,config);const reads=f.count.calendarReads;
  const r=await f.turn('Remote Session',config);assert.equal(r.pending?.serviceId,null);assert.deepEqual(r.pending?.ownedOfferedSlots,p.ownedOfferedSlots);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}: same-ID rename retains compatible selected geometry`,async t=>{
  const f=fixture(t,channel,'en');await offered(f);const p=(await f.turn('14:00')).pending;const reads=f.count.calendarReads;const next={...f.business,services:[{...video,name:'Virtual Consultation'},laser]};
  const r=await f.turn('Virtual Consultation',next);assert.equal(r.pending?.service,'Virtual Consultation');assert.equal(r.pending?.serviceId,'video');assert.equal(r.pending?.dateTime,p.dateTime);assert.equal(r.pending?.selectedSlotEnd,p.selectedSlotEnd);
  assert.equal(r.pending?.ownedOfferedSlots[0].service,'Virtual Consultation');assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}: inactive target releases selection and cannot book`,async t=>{
  const f=fixture(t,channel,'en');await offered(f);await f.turn('14:00');const reads=f.count.calendarReads;const next={...f.business,services:[{...video,active:false},laser]};const r=await f.turn('Yes',next);
  assert.equal(r.pending?.status,'awaiting_service');assert.equal(r.pending?.dateTime,null);assert.deepEqual(r.pending?.ownedOfferedSlots,[]);assert.equal(f.count.calendarReads,reads);noWrites(f);
 });
 test(`${channel}: fresh time proof after duration drift uses a fresh 60-minute slot`,async t=>{
  const f=fixture(t,channel,'en');await offered(f);const p=(await f.turn('14:00')).pending;const next={...f.business,services:[{...video,durationMinutes:60},laser]};const r=await f.turn('14:00',next);
  assert.equal(r.pending?.durationMinutes,60);assert.equal(r.pending?.status,'awaiting_confirmation');assert.notEqual(r.pending?.selectedSlotEnd,p.selectedSlotEnd);
  assert.equal(new Date(r.pending.selectedSlotEnd).getTime()-new Date(r.pending.dateTime).getTime(),60*60_000);noWrites(f);
 });
 test(`${channel}: resolved combined variant completes exactly once at 60 minutes`,async t=>{
  const f=fixture(t,channel,'en');const config={...f.business,services:[{id:'face',name:'Face',durationMinutes:30,active:true},{id:'face-neck',name:'Face + Neck',durationMinutes:60,active:true}]};
  await offered(f,config,'Face');await f.turn('Face + Neck',config);await f.turn('14:00',config);await f.turn('Yes',config);const r=await f.turn('My name is Elin Testlund and my phone number is 0700001102.',config);
  assert.equal(r.pending,null);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);assert.equal(f.created[0].duration,60);assert.equal(f.created[0].service,'Face + Neck');assert.equal(f.recorded[0].service,'Face + Neck');
  await f.turn('Yes',config);assert.equal(f.count.calendarWrites,1);assert.equal(f.count.bookingWrites,1);
 });
}
for(const channel of channels) test(`${channel}: old confirmation cannot book after catalog duration changes`,async t=>{
 const f=fixture(t,channel,'en');await offered(f);const p=(await f.turn('14:00')).pending;
 boundary.seedPending(f.session,{...p,customerName:'Elin Testlund',customerPhone:'0700001102',contactPhoneSource:'explicit_customer_input'});
 const next={...f.business,services:[{...video,durationMinutes:60},laser]};const r=await f.turn('Yes',next);
 assert.equal(r.pending?.status,'awaiting_time_selection');assert.equal(r.pending?.dateTime,null);assert.equal(r.pending?.durationMinutes,60);noWrites(f);
});
for(const channel of channels) {
 test(`${channel}: complete combined catalog label in a dated request outranks its component`,async t=>{
  const f=fixture(t,channel,'en');const config={...f.business,services:[{id:'face',name:'Face',durationMinutes:30,active:true},{id:'face-neck',name:'Face + Neck',durationMinutes:60,active:true}]};
  const p=await offered(f,config,'Face + Neck');assert.equal(p.serviceId,'face-neck');assert.equal(p.service,'Face + Neck');assert.equal(p.durationMinutes,60);
  for(const s of p.ownedOfferedSlots){assert.equal(s.serviceId,'face-neck');assert.equal(s.durationMinutes,60);}noWrites(f);
 });
 test(`${channel}: separate component and combined mentions remain an ambiguous choice`,async t=>{
  const f=fixture(t,channel,'en');const config={...f.business,services:[{id:'face',name:'Face',durationMinutes:30,active:true},{id:'face-neck',name:'Face + Neck',durationMinutes:60,active:true}]};
  const r=await f.turn('I want to book Face or Face + Neck on August 17.',config);
  assert.equal(r.pending?.status,'awaiting_service');assert.deepEqual(r.pending?.ownedOfferedSlots,[]);assert.equal(f.count.calendarReads,0);noWrites(f);
 });
}
for(const channel of channels) test(`${channel}: guarded no-catalog default still resumes with fresh offers`,async t=>{
 const f=fixture(t,channel,'sv');const config={...f.business,services:[],defaultBookingService:'Konsultation',serviceDurations:{Konsultation:30}};
 boundary.seedPending(f.session,{businessId:config.id,platform:channel,userId:f.recipient,businessConfig:config,
  bookingStateVersion:CURRENT_BOOKING_STATE_VERSION,operation:'new_booking',status:'awaiting_service',expectedInput:'service',
  service:'Bokning',serviceResolution:'unresolved',durationMinutes:null,language:'sv',selectedDate:'2026-08-17',
  availabilityStartDate:'2026-08-17',availabilityEndDate:'2026-08-17',offeredSlots:[],ownedOfferedSlots:[],dateTime:null,
  createdAt:Date.now(),updatedAt:Date.now()});
 const r=await f.turn('Konsultation tack.',config);assert.equal(r.pending?.status,'awaiting_time_selection');
 assert.equal(r.pending?.service,'Konsultation');assert.equal(r.pending?.durationMinutes,30);assert.equal(r.pending?.dateTime,null);
 assert.equal(f.count.calendarReads,1);assert.ok(r.pending?.ownedOfferedSlots.length>0);
 for(const slot of r.pending.ownedOfferedSlots){assert.equal(slot.service,'Konsultation');assert.equal(slot.durationMinutes,30);assert.equal(slot.serviceId,undefined);}noWrites(f);
});
for(const channel of channels) test(`${channel}: removal of the last catalog target cannot authorize its old selection`,async t=>{
 const f=fixture(t,channel,'en');const config={...f.business,services:[video]};await offered(f,config);const p=(await f.turn('14:00',config)).pending;
 boundary.seedPending(f.session,{...p,customerName:'Elin Testlund',customerPhone:'0700001102',contactPhoneSource:'explicit_customer_input'});
 const reads=f.count.calendarReads;const r=await f.turn('Yes',{...config,services:[]});assert.equal(r.pending?.dateTime,null);
 assert.equal(r.pending?.status,'awaiting_service');assert.deepEqual(r.pending?.ownedOfferedSlots,[]);assert.equal(f.count.calendarReads,reads);noWrites(f);
});
