import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

function fixture(options: { fail?: 'calendar_create' | 'calendar_verify' | 'database_insert' | 'database_verify' | 'settlement' | 'reschedule_update' | 'cancellation' } = {}) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = { calendarCreate: 0, calendarUpdate: 0, calendarDelete: 0, databaseInsert: 0, databaseUpdate: 0, databaseCancel: 0, completedSettlements: 0, admin: 0, usage: 0 };
  let eventSequence = 0;
  let rowSequence = 0;
  const adapter = {
    getCalendarId: () => 'cal-7',
    getEvents: async () => [...events.values()],
    checkSlots: async () => ({ available_slots_string: '' }),
    insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
      counters.calendarCreate += 1;
      if (options.fail === 'calendar_create') return { success: false, code: 'PROVIDER_FAILED' };
      const id = `event-${++eventSequence}`;
      const platform = marker.startsWith('wa_') ? 'whatsapp' : marker.startsWith('tg_') ? 'telegram' : marker.startsWith('ig_') ? 'instagram' : 'messenger';
      const userId = marker.replace(/^(?:wa_|tg_|ig_|ms_)/, '');
      const start = new Date(dateTime).toISOString();
      const end = new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString();
      const event = {
        id, status: 'confirmed', summary: `Bokad: ${name} - ${phone}`,
        start: { dateTime: start }, end: { dateTime: end },
        extendedProperties: { private: { platform, userId, businessId: '7' } },
        description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${userId}`,
      };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => options.fail === 'calendar_verify' ? null : events.get(id) || null,
    updateAppointment: async (id: string, dateTime: string, duration = 30) => {
      counters.calendarUpdate += 1;
      if (options.fail === 'reschedule_update') return { success: false, code: 'PROVIDER_FAILED' };
      const existing = events.get(id);
      const start = new Date(dateTime).toISOString();
      const updated = { ...existing, start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() } };
      events.set(id, updated);
      return { success: true, event: updated };
    },
    cancelAppointment: async (id: string) => {
      counters.calendarDelete += 1;
      if (options.fail === 'cancellation') return { success: false, code: 'PROVIDER_FAILED' };
      events.delete(id);
      return { success: true };
    },
    verifyEventDeleted: async (id: string) => !events.has(id),
  };
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    notifyBooking: async () => { counters.admin += 1; return true; },
    notifyReschedule: async () => { counters.admin += 1; return true; },
    notifyCancellation: async () => { counters.admin += 1; return true; },
    incrementUsage: async () => ({ allowed: true, count: ++counters.usage, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    updateAppointmentRow: async (appointment: any, nextStart: string, nextEnd: string) => {
      counters.databaseUpdate += 1;
      return { id: appointment.id, customer_name: appointment.customerName, phone_number: appointment.phone, platform: appointment.platform, user_id: appointment.userId, service: appointment.service, start_time: nextStart, end_time: nextEnd, status: 'booked', business_id: '7' };
    },
    cancelAppointmentRow: async (appointment: any) => {
      counters.databaseCancel += 1;
      return { id: appointment.id, platform: appointment.platform, user_id: appointment.userId, service: appointment.service, status: 'cancelled', business_id: '7' };
    },
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      if (options.fail === 'database_insert') return null;
      const start = new Date(params.dateTime).toISOString();
      return {
        id: ++rowSequence, business_id: '7', platform: params.platform,
        user_id: String(params.userId), service: params.service, start_time: start,
        end_time: options.fail === 'database_verify' ? new Date(new Date(start).getTime() + 999 * 60_000).toISOString() : new Date(new Date(start).getTime() + Number(params.durationMinutes || 30) * 60_000).toISOString(),
        status: 'booked', created_at: new Date().toISOString(),
      };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing) return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key, state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: 'completed' | 'failed') => {
      if (status === 'completed' && options.fail === 'settlement') return false;
      handle.state.status = status;
      if (status === 'completed') counters.completedSettlements += 1;
      return true;
    },
  });
  return { counters, events };
}

const businessConfig = {
  id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7', allowCancellation: true,
};

async function turn(sessionId: string, platformName: 'whatsapp' | 'telegram', recipientUserId: string, text: string) {
  return boundary.turn({ sessionId, platformName, recipientUserId, text, businessConfig });
}

for (const failure of ['calendar_create', 'calendar_verify', 'database_insert', 'database_verify', 'settlement'] as const) {
  fixture({ fail: failure });
  const recipient = `46888${failure.length}1234`;
  const session = `wa_${recipient}`;
  await turn(session, 'whatsapp', recipient, 'Book a consultation next Friday at 14:00');
  await turn(session, 'whatsapp', recipient, 'Yes');
  const failed = await turn(session, 'whatsapp', recipient, 'Arman');
  assert.equal(failed.replies.length, 1);
  assert.doesNotMatch(failed.replies[0], /your appointment .* booked|är nu bokad|رزرو شد/ui);
  assert.match(failed.replies[0], /couldn.t|could not|not confirmed|inte|نتوانستم|تأیید نشده/ui);
  assert.equal(failed.pending?.status, 'failed_recoverable');
}

for (const [index, confirmation] of ['Ja tack', 'Bale', 'Yes', 'بله'].entries()) {
  const { counters, events } = fixture();
  const session = `wa_4670000000${index}`;
  const recipient = `4670000000${index}`;
  const first = await turn(session, 'whatsapp', recipient, 'I want to book a consultation next Friday before 12');
  assert.equal(first.operation.operation, 'new_booking');
  const correction = await turn(session, 'whatsapp', recipient, 'next Friday at 14:00 instead');
  assert.equal(correction.pending?.status, 'awaiting_confirmation');
  const confirmed = await turn(session, 'whatsapp', recipient, confirmation);
  assert.equal(confirmed.pending?.status, 'awaiting_contact');
  assert.match(confirmed.replies[0], /name|namn|نام/u);
  const completed = await turn(session, 'whatsapp', recipient, 'Arman 03585353563');
  assert.equal(completed.pending, null);
  assert.equal(completed.replies.length, 1);
  const createdEvent = [...events.values()][0];
  assert.match(createdEvent.summary, new RegExp(recipient));
  assert.doesNotMatch(createdEvent.summary, /03585353563/);
  assert.deepEqual(counters, { calendarCreate: 1, calendarUpdate: 0, calendarDelete: 0, databaseInsert: 1, databaseUpdate: 0, databaseCancel: 0, completedSettlements: 1, admin: 1, usage: 0 });
}

{
  const { counters } = fixture();
  const session = 'wa_46777777777';
  await turn(session, 'whatsapp', '46777777777', 'Book a consultation next Friday at 14:00');
  await turn(session, 'whatsapp', '46777777777', 'Yes');
  const first = await boundary.inboundTurn({ eventId: 'wa-event-contact-1', sessionId: session, platformName: 'whatsapp', recipientUserId: '46777777777', text: 'Arman', businessConfig });
  const replay = await boundary.inboundTurn({ eventId: 'wa-event-contact-1', sessionId: session, platformName: 'whatsapp', recipientUserId: '46777777777', text: 'Arman', businessConfig });
  assert.equal(first.replies.length, 1);
  assert.equal(replay.replies.length, 0);
  assert.equal(counters.usage, 1);
  assert.equal(counters.calendarCreate, 1);
  assert.equal(counters.databaseInsert, 1);
}

{
  const { counters } = fixture();
  const usageCases = [
    ['general', 'What services do you offer?'],
    ['new_booking', 'Book a consultation next Friday at 14:00'],
    ['availability_correction', 'next Friday after 15 instead'],
    ['confirmation', 'Yes'],
    ['contact', 'Arman 0701234567'],
    ['reschedule', 'Reschedule my appointment'],
    ['cancellation', 'Cancel my appointment'],
    ['lookup', 'When is my appointment?'],
    ['deterministic_fallback', 'Which booking do you mean?'],
    ['gemini_fallback', 'Tell me something about the business'],
  ] as const;
  for (const [index, [kind, text]] of usageCases.entries()) {
    await boundary.inboundTurn({ eventId: `usage-${kind}`, sessionId: `usage-session-${index}`, platformName: 'messenger', recipientUserId: `usage-user-${index}`, text, businessConfig });
  }
  assert.equal(counters.usage, usageCases.length);
  await boundary.inboundTurn({ eventId: 'usage-general', sessionId: 'usage-session-0', platformName: 'messenger', recipientUserId: 'usage-user-0', text: usageCases[0][1], businessConfig });
  assert.equal(counters.usage, usageCases.length, 'duplicate provider delivery does not increment usage');
}

{
  fixture();
  const session = 'tg:7:token:reply-mode';
  assert.equal(boundary.telegramDelivery(session, 'voice', 'سلام').delivery, 'voice');
  assert.equal(boundary.telegramDelivery(session, 'text', 'hello').delivery, 'text');
  assert.equal(boundary.telegramDelivery(session, 'text', 'reply with voice').delivery, 'voice');
  assert.equal(boundary.telegramDelivery(session, 'text', 'booking confirmation').delivery, 'voice');
  assert.equal(boundary.telegramDelivery(session, 'text', 'reply with text').delivery, 'text');
  for (const deterministicReply of ['booking', 'reschedule', 'cancellation', 'lookup', 'fallback', 'general']) {
    assert.equal(boundary.telegramDelivery(session, 'voice', deterministicReply).delivery, 'text');
  }
}

{
  const { counters, events } = fixture();
  const session = 'ig_owner-1';
  const originalStart = '2026-08-14T10:00:00+02:00';
  const newStart = '2026-08-14T15:00:00+02:00';
  const appointment = { id: 'row-owned', calendarEventId: 'event-owned', source: 'appointments_table', customerName: 'Peter', phone: '0701234567', platform: 'instagram', userId: 'owner-1', businessId: '7', service: 'Konsultation', start: originalStart, end: '2026-08-14T08:30:00.000Z', status: 'booked' };
  events.set('event-owned', { id: 'event-owned', status: 'confirmed', start: { dateTime: new Date(originalStart).toISOString() }, end: { dateTime: '2026-08-14T08:30:00.000Z' }, extendedProperties: { private: { platform: 'instagram', userId: 'owner-1', businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: session, platform: 'instagram', userId: 'owner-1', businessConfig, appointment, operation: 'reschedule', selectedNewStartTime: newStart });
  const moved = await boundary.turn({ sessionId: session, platformName: 'instagram', recipientUserId: 'owner-1', text: 'Yes', businessConfig });
  assert.equal(moved.pending, null);
  assert.equal(counters.calendarUpdate, 1);
  assert.equal(counters.databaseUpdate, 1);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.match(moved.replies[0], /rescheduled|changed|ombokad/i);
}

{
  const { counters, events } = fixture({ fail: 'reschedule_update' });
  const appointment = { id: 'row-reschedule-fail', calendarEventId: 'event-reschedule-fail', source: 'appointments_table', customerName: 'Peter', phone: '0701234567', platform: 'instagram', userId: 'owner-rf', businessId: '7', service: 'Konsultation', start: '2026-08-14T10:00:00+02:00', end: '2026-08-14T08:30:00.000Z', status: 'booked' };
  events.set('event-reschedule-fail', { id: 'event-reschedule-fail', status: 'confirmed', start: { dateTime: new Date(appointment.start).toISOString() }, end: { dateTime: appointment.end }, extendedProperties: { private: { platform: 'instagram', userId: 'owner-rf', businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: 'ig_owner-rf', platform: 'instagram', userId: 'owner-rf', businessConfig, appointment, operation: 'reschedule', selectedNewStartTime: '2026-08-14T15:00:00+02:00' });
  const failed = await boundary.turn({ sessionId: 'ig_owner-rf', platformName: 'instagram', recipientUserId: 'owner-rf', text: 'Yes', businessConfig });
  assert.equal(counters.calendarUpdate, 1);
  assert.equal(counters.databaseUpdate, 0);
  assert.doesNotMatch(failed.replies.join(' '), /now rescheduled|nu ombokad/u);
}

{
  const { counters, events } = fixture();
  const session = 'ig_owner-2';
  const originalStart = '2026-08-14T11:00:00+02:00';
  const appointment = { id: 'row-cancel', calendarEventId: 'event-cancel', source: 'appointments_table', customerName: 'Nina', phone: '0709999999', platform: 'instagram', userId: 'owner-2', businessId: '7', service: 'Konsultation', start: originalStart, end: '2026-08-14T09:30:00.000Z', status: 'booked' };
  events.set('event-cancel', { id: 'event-cancel', status: 'confirmed', summary: 'Bokad: Nina - 0709999999', start: { dateTime: new Date(originalStart).toISOString() }, end: { dateTime: '2026-08-14T09:30:00.000Z' }, extendedProperties: { private: { platform: 'instagram', userId: 'owner-2', businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: session, platform: 'instagram', userId: 'owner-2', businessConfig, appointment, operation: 'cancellation' });
  const reason = await boundary.turn({ sessionId: session, platformName: 'instagram', recipientUserId: 'owner-2', text: 'My plans changed', businessConfig });
  assert.match(reason.replies[0], /sure|cancel/i);
  const cancelled = await boundary.turn({ sessionId: session, platformName: 'instagram', recipientUserId: 'owner-2', text: 'Bale', businessConfig });
  assert.equal(counters.calendarDelete, 1);
  assert.equal(counters.databaseCancel, 1);
  assert.equal(counters.calendarCreate, 0);
  assert.match(cancelled.replies[0], /cancelled|canceled/i);
  assert.equal(cancelled.operation.operation, 'none');
}

{
  const { counters, events } = fixture({ fail: 'cancellation' });
  const appointment = { id: 'row-cancel-fail', calendarEventId: 'event-cancel-fail', source: 'appointments_table', customerName: 'Nina', phone: '0709999999', platform: 'instagram', userId: 'owner-cf', businessId: '7', service: 'Konsultation', start: '2026-08-14T11:00:00+02:00', end: '2026-08-14T09:30:00.000Z', status: 'booked' };
  events.set('event-cancel-fail', { id: 'event-cancel-fail', status: 'confirmed', summary: 'Bokad: Nina - 0709999999', start: { dateTime: new Date(appointment.start).toISOString() }, end: { dateTime: appointment.end }, extendedProperties: { private: { platform: 'instagram', userId: 'owner-cf', businessId: '7' } }, description: 'BusinessId: 7' });
  boundary.seedOwnedAppointment({ sessionId: 'ig_owner-cf', platform: 'instagram', userId: 'owner-cf', businessConfig, appointment, operation: 'cancellation' });
  await boundary.turn({ sessionId: 'ig_owner-cf', platformName: 'instagram', recipientUserId: 'owner-cf', text: 'My plans changed', businessConfig });
  const failed = await boundary.turn({ sessionId: 'ig_owner-cf', platformName: 'instagram', recipientUserId: 'owner-cf', text: 'Yes', businessConfig });
  assert.equal(counters.calendarDelete, 1);
  assert.equal(counters.databaseCancel, 0);
  assert.doesNotMatch(failed.replies.join(' '), /has been cancelled|nu avbokad/u);
}

{
  fixture();
  const session = 'ms_switch-1';
  await boundary.turn({ sessionId: session, platformName: 'messenger', recipientUserId: 'switch-1', text: 'Book a consultation next Friday before 12', businessConfig });
  const switched = await boundary.turn({ sessionId: session, platformName: 'messenger', recipientUserId: 'switch-1', text: 'Cancel my appointment', businessConfig });
  assert.equal(switched.pending, null);
  assert.equal(switched.operation.operation, 'cancellation');
}

{
  const { events } = fixture();
  const event = (id: string, userId: string, hour: string) => ({
    id, status: 'confirmed', summary: `Consultation ${userId}`,
    start: { dateTime: `2026-08-14T${hour}:00:00+02:00` }, end: { dateTime: `2026-08-14T${hour}:30:00+02:00` },
    description: `BusinessId: 7 Platform: instagram UserId: ${userId}`,
    extendedProperties: { private: { businessId: '7', platform: 'instagram', userId } },
  });
  events.set('lookup-own', event('lookup-own', 'lookup-1', '10'));
  events.set('lookup-other', event('lookup-other', 'lookup-2', '16'));
  const lookup = await boundary.turn({ sessionId: 'ig_lookup-1', platformName: 'instagram', recipientUserId: 'lookup-1', text: 'Do I have an appointment?', businessConfig });
  assert.match(lookup.replies.join(' '), /10:00/);
  assert.doesNotMatch(lookup.replies.join(' '), /16:00/);

  boundary.reset();
  const isolated = fixture();
  isolated.events.set('lookup-own', event('lookup-own', 'lookup-1', '10'));
  isolated.events.set('lookup-other', event('lookup-other', 'lookup-2', '16'));
  await boundary.turn({ sessionId: 'ig_lookup-1', platformName: 'instagram', recipientUserId: 'lookup-1', text: 'Reschedule my appointment on August 14 at 16:00', businessConfig });
  assert.equal(isolated.counters.calendarUpdate, 0);
  assert.ok(isolated.events.has('lookup-other'), 'another customer appointment cannot be changed');

  boundary.reset();
  const cancelIsolated = fixture();
  cancelIsolated.events.set('lookup-own', event('lookup-own', 'lookup-1', '10'));
  cancelIsolated.events.set('lookup-other', event('lookup-other', 'lookup-2', '16'));
  await boundary.turn({ sessionId: 'ig_lookup-1', platformName: 'instagram', recipientUserId: 'lookup-1', text: 'Cancel my appointment on August 14 at 16:00', businessConfig });
  assert.equal(cancelIsolated.counters.calendarDelete, 0);
  assert.ok(cancelIsolated.events.has('lookup-other'), 'another customer appointment cannot be cancelled');
}

{
  const { counters } = fixture();
  const session = 'tg:7:token:991';
  await turn(session, 'telegram', '991', 'I want to book a consultation next Friday at 14:00');
  const confirmed = await turn(session, 'telegram', '991', 'Bale');
  assert.equal(confirmed.pending?.customerName, null);
  assert.match(confirmed.replies[0], /name.*mobile|نام.*شماره/u);
  const phone = await turn(session, 'telegram', '991', '0701234567');
  assert.equal(phone.pending?.customerName, null);
  assert.match(phone.replies[0], /name|نام/u);
  const done = await turn(session, 'telegram', '991', 'Arman');
  assert.equal(done.pending, null);
  assert.equal(done.replies.length, 1);
  assert.equal(counters.calendarCreate, 1);
  assert.equal(counters.databaseInsert, 1);
}

boundary.reset();
console.log('Priority 1H real unified-engine integration transcripts passed');
