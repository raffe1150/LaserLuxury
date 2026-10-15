import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { getZonedSlotParts } from './booking-intelligence';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const now = new Date('2026-10-15T09:00:00Z');
const config = { id: '77', businessId: '77', businessName: 'Safety Fixture', timezone: 'Europe/Stockholm', language: 'en',
  defaultBookingService: 'Video Consultation', calendarProvider: 'custom',
  services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 30 }],
  workingHours: Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => [day,[{start:'09:00',end:'18:00'}]])) };
let reads = 0, searches = 0;
const mutation = async () => { assert.fail('No booking/cancellation/rescheduling authorized in this fixture'); };
beforeEach(() => {
  b.reset(); reads=0; searches=0;
  b.configure({ calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: async () => {reads++; return [];},
    checkSlots: async () => ({available_slots_string:''}), insertAppointment: mutation, cancelAppointment: mutation, updateAppointment: mutation },
    recordAppointment: mutation, cancelAppointmentRow: mutation, updateAppointmentRow: mutation,
    postProcess: async () => undefined, incrementUsage: async () => ({allowed:true,count:1,limit:100}),
    knowledgeSearch: () => {searches++;return [];}, semanticKnowledgeSearch: () => [], geminiGenerate: async () => {throw Error('offline fixture');} });
});
function seed(id: string, channel: typeof channels[number]) {
  const start = '2026-10-23T11:00:00+02:00', end = '2026-10-23T09:30:00.000Z';
  b.seedPending(id,{businessConfig:config,businessId:'77',platform:channel,userId:id,bookingStateVersion:3,operation:'new_booking',
    status:'awaiting_confirmation',expectedInput:'confirmation',service:'Video Consultation',serviceId:'video',serviceResolution:'authoritative',
    selectedDate:'2026-10-23',durationMinutes:30,language:'en',dateTime:start,selectedSlotEnd:end,
    normalizedBookingRequest:{intent:'new_booking',language:'en',requiresClarification:false,date:{kind:'exact_date',value:'2026-10-23',confidence:'high'},timeConstraint:{kind:'exact',startMinutes:660,confidence:'high'}},
    ownedOfferedSlots:[{start,end,businessId:'77',platform:channel,userId:id,durationMinutes:30,service:'Video Consultation',serviceId:'video',generatedAt:Date.now()}]});
  return {start,end};
}
const turn = (id:string,channel:typeof channels[number],text:string) => b.turn({sessionId:id,platformName:channel,recipientUserId:id,text,businessConfig:config,now});
for (const channel of channels) {
  test(`${channel}: incidental tomorrow in a confirmation preserves the selected slot`,async()=>{
    const id=`incidental-${channel}`,slot=seed(id,channel);
    const r=await turn(id,channel,'Yes, book it. Tomorrow I have another meeting.');
    assert.equal(r.pending?.selectedDate,'2026-10-23');assert.equal(r.pending?.dateTime,slot.start);
    assert.equal(r.pending?.selectedSlotEnd,slot.end);assert.equal(r.pending?.status,'awaiting_contact');
    assert.equal(reads,1,'confirmation revalidates the retained slot against Calendar');assert.equal(searches,0);
  });
  test(`${channel}: correcting this draft stays in booking and releases the old selected slot`,async()=>{
    const id=`draft-correction-${channel}`;seed(id,channel);
    const r=await turn(id,channel,'Actually, change the booking to tomorrow.');
    assert.equal(r.pending?.selectedDate,'2026-10-16');assert.equal(r.pending?.dateTime,null);
    assert.equal(r.pending?.status,'awaiting_time_selection');assert.equal(r.operation.operation,'new_booking');
    assert.equal(r.appointment,null);assert.equal(searches,0);
  });
  test(`${channel}: a Spanish morning follow-up refines booking availability without Knowledge retrieval`,async()=>{
    const id=`morning-followup-${channel}`;
    await turn(id,channel,'Hola, quiero reservar una cita para el viernes.');
    const r=await turn(id,channel,'¿Tienes algo por la mañana?');
    assert.equal(r.pending?.selectedDate,'2026-10-16');assert.equal(r.pending?.availabilityConstraint?.daypart,'morning');
    assert.equal(searches,0);assert.ok(r.pending?.ownedOfferedSlots.length>0);
  });
  test(`${channel}: unrelated business questions mentioning a daypart still reach Knowledge`,async()=>{
    const id=`business-daypart-${channel}`,slot=seed(id,channel);
    const r=await turn(id,channel,"What's your evening dress code?");
    assert.equal(r.handled,false);assert.ok(searches>0);assert.equal(reads,0);
    assert.ok(b.businessInformationState(id));assert.equal(r.pending?.dateTime,slot.start);
    assert.equal(r.pending?.continuationPaused,true);
  });
  test(`${channel}: availability wording reaches Calendar and preserves the exclusive lower bound`,async()=>{
    const r=await turn(`availability-${channel}`,channel,'Do you have availability after 15 on Friday 23 October 2026?');
    assert.equal(r.handled,true);assert.equal(searches,0);assert.ok(reads>0);
    assert.equal(r.pending?.availabilityConstraint?.timeBoundary?.kind,'exclusive_lower');
    assert.equal(r.pending?.availabilityConstraint?.timeBoundary?.time,'15:00');
    assert.ok(r.pending?.ownedOfferedSlots.length>0);
    assert.ok(r.pending.ownedOfferedSlots.every((s:any)=>getZonedSlotParts(s.start,'Europe/Stockholm')!.minutes>900));
  });
  test(`${channel}: accentless Spanish morning is temporal input, not a service`,async()=>{
    const r=await turn(`manana-${channel}`,channel,'Hola, quiero reservar una cita para manana en la manana.');
    assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.selectedDate,'2026-10-16');
    assert.equal(r.pending?.availabilityConstraint?.daypart,'morning');assert.ok(r.pending?.ownedOfferedSlots.length>0);
    assert.ok(r.pending.ownedOfferedSlots.every((s:any)=>{const m=getZonedSlotParts(s.start,'Europe/Stockholm')!.minutes;return m>=540&&m<720;}));
    assert.doesNotMatch(r.replies.join(' '),/no ofrecemos|cita para manana en/iu);
  });
  test(`${channel}: Swedish deictic confirmation keeps the offered service and takes a safe hold`,async()=>{
    const id=`deictic-${channel}`;
    const offer=await turn(id,channel,'Är klockan 11 ledig fredagen den 23 oktober 2026?');
    assert.equal(offer.pending?.readOnlyExactAvailabilityInquiry,true);assert.equal(offer.pending?.dateTime,null);
    const r=await turn(id,channel,'Ja, boka den åt mig');
    assert.equal(r.pending?.service,'Video Consultation');assert.equal(r.pending?.status,'awaiting_contact');
    assert.equal(getZonedSlotParts(r.pending?.dateTime,'Europe/Stockholm')?.minutes,660);
    assert.doesNotMatch(r.replies.join(' '),/den åt mig.*tjänst|tjänsten erbjuds inte/iu);
  });
}
for(const label of ['شماره تماسم','شماره تماس من','شماره تماس'])test(`explicit Persian phone label: ${label}`,()=>{
  const p=b.extractBookingContactParts(`نام من اسکار ساندبرگ و ${label} ۰۷۰۰۰۰۷۶۲۸ است.`);
  assert.equal(p.phoneOnly,'0700007628');assert.equal(p.combined?.name,'اسکار ساندبرگ');assert.equal(p.combined?.phone,'0700007628');
  assert.equal(b.extractBookingContactParts('شماره فاکتور ۰۷۰۰۰۰۷۶۲۸ است.').phoneOnly,null);
});

for(const channel of channels)test(`${channel}: canonical catalog inquiry creates no hold; confirmation reserves only the owned offered slot`,async()=>{
  const id=`hold-owner-${channel}`;
  const canOffer=async()=>{
    const r=await b.canonicalOffers({businessConfig:config,sessionId:`hold-observer-${channel}`,platform:channel,userId:`observer-${channel}`,
      startDate:'2026-10-23',endDate:'2026-10-23',service:'Video Consultation',durationMinutes:30,requestedTime:'11:00',now});
    return r.ownedSlots.some((slot:any)=>getZonedSlotParts(slot.start,'Europe/Stockholm')?.minutes===660);
  };
  await turn(id,channel,'Är klockan 11 ledig fredagen den 23 oktober 2026?');
  assert.equal(await canOffer(),true,'read-only inquiry must not reserve');
  await turn(id,channel,'Ja, boka den åt mig');
  assert.equal(await canOffer(),false,'confirmed draft hold excludes the slot for other customers');
});
