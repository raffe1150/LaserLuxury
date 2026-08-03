import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type Failure = 'availability' | 'calendar_create' | 'calendar_verify' | 'database_insert' | 'database_verify' | 'settlement';

function fixture(failOnce?: Failure) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = { availability: 0, calendarCreate: 0, calendarRead: 0, calendarDelete: 0, databaseInsert: 0, databaseRead: 0, settlement: 0, usage: 0 };
  let remainingFailure = failOnce;
  let eventSequence = 0;
  const consume = (stage: Failure) => remainingFailure === stage ? (remainingFailure = undefined, true) : false;
  const adapter = {
    getCalendarId: () => 'cal-7',
    checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => {
      counters.availability += 1;
      if (consume('availability')) throw new Error('injected availability failure');
      return [...events.values()];
    },
    insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
      counters.calendarCreate += 1;
      if (consume('calendar_create')) return { success: false, code: 'PROVIDER_FAILED' };
      const id = `event-${++eventSequence}`;
      const platform = marker.startsWith('wa_') ? 'whatsapp' : marker.startsWith('ig_') ? 'instagram' : 'messenger';
      const userId = marker.replace(/^(?:wa_|ig_|ms_)/, '');
      const event = { id, status: 'confirmed', summary: `Bokad: ${name} - ${phone}`, start: { dateTime: new Date(dateTime).toISOString() }, end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() }, extendedProperties: { private: { platform, userId, businessId: '7' } }, description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${userId}` };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => {
      counters.calendarRead += 1;
      if (consume('calendar_verify')) return null;
      return events.get(id) || null;
    },
    cancelAppointment: async (id: string) => { counters.calendarDelete += 1; events.delete(id); return { success: true }; },
    verifyEventDeleted: async (id: string) => !events.has(id),
    updateAppointment: async (id: string, dateTime: string, duration = 30) => {
      const existing = events.get(id);
      const event = { ...existing, start: { dateTime: new Date(dateTime).toISOString() }, end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() } };
      events.set(id, event);
      return { success: true, event };
    },
  };
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    notifyReschedule: async () => true,
    notifyCancellation: async () => true,
    incrementUsage: async () => ({ allowed: true, count: ++counters.usage, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    updateAppointmentRow: async (appointment: any, start: string, end: string) => ({ id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, start_time: start, end_time: end, status: 'booked' }),
    cancelAppointmentRow: async (appointment: any) => ({ id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, status: 'cancelled' }),
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      if (consume('database_insert')) return null;
      counters.databaseRead += 1;
      const start = new Date(params.dateTime).toISOString();
      return { id: counters.databaseInsert, business_id: '7', platform: params.platform, user_id: String(params.userId), service: params.service, start_time: start, end_time: consume('database_verify') ? new Date(new Date(start).getTime() + 999 * 60_000).toISOString() : new Date(new Date(start).getTime() + Number(params.durationMinutes || 30) * 60_000).toISOString(), status: 'booked', created_at: new Date().toISOString() };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing?.state.status === 'completed' || existing?.state.status === 'processing') return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key, state: { type: params.type, status: 'processing', attempts: Number(existing?.state.attempts || 0) + 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: 'completed' | 'failed') => {
      if (status === 'completed' && consume('settlement')) return false;
      handle.state.status = status;
      if (status === 'completed') counters.settlement += 1;
      return true;
    },
  });
  return { counters, events };
}

const businessConfig = { id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm', defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7', allowCancellation: true };
const turn = (sessionId: string, platformName: 'whatsapp' | 'instagram', recipientUserId: string, text: string) => boundary.turn({ sessionId, platformName, recipientUserId, text, businessConfig });
const inbound = (eventId: string, sessionId: string, platformName: 'whatsapp' | 'instagram', recipientUserId: string, text: string) => boundary.inboundTurn({ eventId, sessionId, platformName, recipientUserId, text, businessConfig });

// Transcript 1: an availability failure retains the authoritative Friday/after-16 request.
{
  const { counters } = fixture('availability');
  const failed = await inbound('wa-recovery-1', 'wa_46701111111', 'whatsapp', '46701111111', 'man mikham ye vaght moshavereh baraye jome bad az sate 16');
  assert.equal(failed.replies.length, 1);
  const failedReplay = await inbound('wa-recovery-1', 'wa_46701111111', 'whatsapp', '46701111111', 'man mikham ye vaght moshavereh baraye jome bad az sate 16');
  assert.equal(failedReplay.replies.length, 0);
  const retried = await inbound('wa-recovery-2', 'wa_46701111111', 'whatsapp', '46701111111', 'dobare emtehan kon');
  assert.equal(retried.replies.length, 1);
  assert.equal(retried.pending?.service, 'Konsultation');
  assert.equal(retried.pending?.availabilityConstraint?.weekday, 'friday');
  assert.equal(retried.pending?.availabilityConstraint?.timeBoundary?.kind, 'exclusive_lower');
  assert.equal(retried.pending?.availabilityConstraint?.timeBoundary?.time, '16:00');
  assert.equal(counters.usage, 2);
}

// Transcripts 2/3: combined contact finalizes once; every transaction stage safely retries.
for (const failure of [undefined, 'calendar_create', 'calendar_verify', 'database_insert', 'database_verify', 'settlement'] as const) {
  const { counters, events } = fixture(failure);
  const suffix = failure || 'success';
  const user = `46702${suffix.length}12345`;
  const session = `wa_${user}`;
  await turn(session, 'whatsapp', user, 'Book a consultation next Friday at 16:30');
  await turn(session, 'whatsapp', user, 'Yes');
  const contact = await turn(session, 'whatsapp', user, 'Molly 0495358630');
  assert.equal(contact.replies.length, 1);
  if (failure) {
    assert.equal(contact.pending?.status, 'failed_recoverable');
    assert.equal(contact.pending?.customerName, 'Molly');
    assert.ok(contact.pending?.customerPhone);
    assert.ok(contact.pending?.dateTime && contact.pending?.selectedSlotEnd);
    const recovered = await turn(session, 'whatsapp', user, 'try again');
    assert.equal(recovered.pending, null, `${failure} eventually succeeds`);
    assert.equal(recovered.replies.length, 1);
  } else {
    assert.equal(contact.pending, null);
    assert.equal(counters.calendarCreate, 1);
    assert.equal(counters.calendarRead, 1);
    assert.equal(counters.databaseInsert, 1);
    assert.equal(counters.databaseRead, 1);
  }
  assert.equal(events.size, 1, `${suffix}: exactly one live Calendar event`);
  assert.equal(counters.settlement, 1, `${suffix}: one completed settlement`);
}

// Name-first and phone-first contact sequences merge without asking for valid fields twice.
for (const [index, inputs] of [['Molly', '0495358630'], ['0495358630', 'Molly']].entries()) {
  fixture();
  const user = `contact-order-${index}`;
  const session = `ig_${user}`;
  await turn(session, 'instagram', user, 'Book a consultation next Friday at 16:30');
  await turn(session, 'instagram', user, 'Yes');
  const first = await turn(session, 'instagram', user, inputs[0]);
  assert.ok(first.pending, 'one contact field remains pending');
  const second = await turn(session, 'instagram', user, inputs[1]);
  assert.equal(second.pending, null, 'the complementary field finalizes once');
}

const appointment = (userId: string) => ({ id: `row-${userId}`, calendarEventId: `event-${userId}`, source: 'appointments_table', customerName: 'Peter', phone: '0701234567', platform: 'instagram', userId, businessId: '7', service: 'Konsultation', start: '2026-08-14T10:00:00+02:00', end: '2026-08-14T08:30:00.000Z', status: 'booked' });

// Transcripts 4/5: explicit Swedish and Finglish reschedule intent overrides cancellation.
for (const [userId, text] of [['switch-sv', 'Jag vill ändra Peters tid till torsdag'], ['switch-fa', 'jome ro nemikham, 5shanbe ro mikham avaz konam']] as const) {
  const { events } = fixture();
  const appt = appointment(userId);
  events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'cancellation' });
  const switched = await turn(`ig_${userId}`, 'instagram', userId, text);
  assert.equal(switched.operation.operation, 'reschedule');
  assert.equal(switched.operation.phase === 'awaiting_reschedule_target' || switched.operation.phase === 'awaiting_reschedule_confirmation', true);
  assert.doesNotMatch(switched.replies.join(' '), /sure you want to cancel|säker på att du vill avboka/i);
  assert.ok(events.has(appt.calendarEventId), 'source appointment remains unchanged');
}

// Transcript 6: all localized negative confirmations preserve the appointment, then reschedule works.
for (const [index, negative] of ['Nej', 'Na', 'نه'].entries()) {
  const userId = `negative-${index}`;
  const { events } = fixture();
  const appt = appointment(userId);
  events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'cancellation' });
  const kept = await turn(`ig_${userId}`, 'instagram', userId, negative);
  assert.equal(kept.operation.operation, 'none');
  assert.ok(events.has(appt.calendarEventId));
  const switched = await turn(`ig_${userId}`, 'instagram', userId, 'Jag vill boka om den till torsdag kl 10');
  assert.equal(switched.operation.operation, 'reschedule');
}

// Remaining real-engine operation-switch precedence pairs.
{
  let state = fixture();
  let userId = 'cancel-new';
  let appt = appointment(userId);
  state.events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'cancellation' });
  assert.equal((await turn(`ig_${userId}`, 'instagram', userId, 'Book a new consultation next Friday at 16:30')).operation.operation, 'new_booking');

  state = fixture();
  userId = 'reschedule-cancel';
  appt = appointment(userId);
  state.events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'reschedule' });
  assert.equal((await turn(`ig_${userId}`, 'instagram', userId, 'Cancel my appointment')).operation.operation, 'cancellation');

  fixture();
  await turn('ig_new-lookup', 'instagram', 'new-lookup', 'Book a consultation next Friday at 16:30');
  assert.equal((await turn('ig_new-lookup', 'instagram', 'new-lookup', 'When is my appointment?')).operation.operation, 'appointment_lookup');

  state = fixture();
  userId = 'lookup-reschedule';
  appt = appointment(userId);
  state.events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'lookup' });
  assert.equal((await turn(`ig_${userId}`, 'instagram', userId, 'Reschedule my appointment to Thursday')).operation.operation, 'reschedule');
}

// Transcripts 7/8: current explicit intent wins, and duplicate provider deliveries are side-effect free.
{
  const { counters } = fixture();
  const session = 'wa_46709999999';
  await inbound('dup-booking', session, 'whatsapp', '46709999999', 'Book a consultation next Friday at 16:30');
  await inbound('dup-booking', session, 'whatsapp', '46709999999', 'Book a consultation next Friday at 16:30');
  assert.equal(counters.usage, 1);

  await inbound('dup-confirm', session, 'whatsapp', '46709999999', 'Yes');
  const finalized = await inbound('dup-contact', session, 'whatsapp', '46709999999', 'Molly 0495358630');
  const finalizationReplay = await inbound('dup-contact', session, 'whatsapp', '46709999999', 'Molly 0495358630');
  assert.equal(finalized.replies.length, 1);
  assert.equal(finalizationReplay.replies.length, 0);
  assert.equal(counters.calendarCreate, 1);
  assert.equal(counters.databaseInsert, 1);
  assert.equal(counters.usage, 3);
}

{
  const { counters, events } = fixture();
  const userId = 'duplicate-switch';
  const appt = appointment(userId);
  events.set(appt.calendarEventId, { id: appt.calendarEventId, status: 'confirmed', start: { dateTime: new Date(appt.start).toISOString() }, end: { dateTime: appt.end }, extendedProperties: { private: { platform: 'instagram', userId, businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: `ig_${userId}`, platform: 'instagram', userId, businessConfig, appointment: appt, operation: 'cancellation' });
  const switched = await inbound('dup-switch', `ig_${userId}`, 'instagram', userId, 'Jag vill ändra Peters tid till torsdag');
  const replay = await inbound('dup-switch', `ig_${userId}`, 'instagram', userId, 'Jag vill ändra Peters tid till torsdag');
  assert.equal(switched.operation.operation, 'reschedule');
  assert.equal(replay.replies.length, 0);
  assert.equal(counters.usage, 1);
  assert.ok(events.has(appt.calendarEventId));
}

console.log('Priority 1I live-recovery real-engine integration transcripts passed');
