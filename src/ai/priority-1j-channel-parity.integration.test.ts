import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type Failure = 'calendar_create' | 'calendar_verify' | 'database_insert' | 'database_verify' | 'settlement';

function fixture(options: { failOnce?: Failure; adminFailure?: boolean } = {}) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = { availabilityReads: 0, calendarCreate: 0, calendarRead: 0, calendarDelete: 0, databaseInsert: 0, databaseRead: 0, databaseCancel: 0, settlement: 0, cancellationSettlement: 0, admin: 0, usage: 0, createdName: '', createdPhone: '' };
  let remainingFailure = options.failOnce;
  let sequence = 0;
  const consume = (stage: Failure) => remainingFailure === stage ? (remainingFailure = undefined, true) : false;
  const adapter = {
    getCalendarId: () => 'cal-7',
    checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => { counters.availabilityReads += 1; return [...events.values()]; },
    insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
      counters.calendarCreate += 1;
      counters.createdName = name;
      counters.createdPhone = phone;
      if (consume('calendar_create')) return { success: false, code: 'PROVIDER_FAILED' };
      const id = `created-${++sequence}`;
      const platform = marker.startsWith('wa_') ? 'whatsapp' : marker.startsWith('ig_') ? 'instagram' : marker.startsWith('ms_') ? 'messenger' : 'unknown';
      const userId = marker.replace(/^(?:wa_|ig_|ms_)/, '');
      const start = new Date(dateTime).toISOString();
      const event = { id, status: 'confirmed', summary: `Bokad: ${name} - ${phone}`, description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${userId}`, start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() }, extendedProperties: { private: { businessId: '7', platform, userId } } };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => { counters.calendarRead += 1; return consume('calendar_verify') ? null : events.get(id) || null; },
    cancelAppointment: async (id: string) => { counters.calendarDelete += 1; events.delete(id); return { success: true }; },
    verifyEventDeleted: async (id: string) => !events.has(id),
    updateAppointment: async (id: string, dateTime: string, duration = 30) => {
      const current = events.get(id);
      const start = new Date(dateTime).toISOString();
      const event = { ...current, start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() } };
      events.set(id, event);
      return { success: true, event };
    },
  };
  const dependencies = {
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    notifyBooking: async () => { counters.admin += 1; if (options.adminFailure) throw new Error('injected admin failure'); return true; },
    notifyReschedule: async () => true,
    notifyCancellation: async () => { counters.admin += 1; if (options.adminFailure) throw new Error('injected admin failure'); return true; },
    incrementUsage: async () => ({ allowed: true, count: ++counters.usage, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    updateAppointmentRow: async (appointment: any, start: string, end: string) => ({ id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, start_time: start, end_time: end, status: 'booked' }),
    cancelAppointmentRow: async (appointment: any) => { counters.databaseCancel += 1; return { id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, status: 'cancelled' }; },
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
      if (status === 'completed') {
        counters.settlement += 1;
        if (String(handle.keyHash).startsWith('cancellation_operation_claim|')) counters.cancellationSettlement += 1;
      }
      return true;
    },
  };
  const restart = () => { boundary.reset(); boundary.configure(dependencies); };
  restart();
  return { counters, events, restart };
}

const businessConfig = { id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm', defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7', allowCancellation: true };
const turn = (sessionId: string, platformName: 'whatsapp' | 'instagram' | 'messenger' | 'telegram', recipientUserId: string, text: string, extra: Record<string, any> = {}) => boundary.turn({ sessionId, platformName, recipientUserId, text, businessConfig, ...extra });
const inbound = (eventId: string, sessionId: string, platformName: 'whatsapp' | 'instagram' | 'messenger', recipientUserId: string, text: string) => boundary.inboundTurn({ eventId, sessionId, platformName, recipientUserId, text, businessConfig });
const localMinute = (iso: string) => { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); return Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value); };

// Test 1: WhatsApp before-time correction owns a fresh scan and invalidates old offers.
{
  const { counters } = fixture();
  const session = 'wa_46701110000';
  const first = await turn(session, 'whatsapp', '46701110000', 'Salam man ye vaght moshavereh mikham');
  const oldStarts = new Set((first.pending?.ownedOfferedSlots || []).map((slot: any) => slot.start));
  const oldFingerprint = first.pending?.lastAvailabilityConstraintKey;
  const readsBefore = counters.availabilityReads;
  const corrected = await turn(session, 'whatsapp', '46701110000', 'man ghabl az sate 13 mitonam biam');
  assert.equal(corrected.replies.length, 1);
  assert.equal(counters.availabilityReads, readsBefore + 1);
  assert.ok(corrected.pending?.ownedOfferedSlots.length > 0);
  assert.ok(corrected.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) < 13 * 60));
  assert.ok(corrected.pending.ownedOfferedSlots.every((slot: any) => !oldStarts.has(slot.start)));
  assert.notEqual(corrected.pending.lastAvailabilityConstraintKey, oldFingerprint);
  assert.equal(corrected.pending.availabilityConstraint.timeBoundary.kind, 'exclusive_upper');
}

// Tests 2/3: WhatsApp contact dispatch, verified success, and all isolated terminal failures.
for (const failure of [undefined, 'calendar_create', 'calendar_verify', 'database_insert', 'database_verify', 'settlement'] as const) {
  const { counters, events } = fixture({ failOnce: failure });
  const user = `4670222${String(failure || 'ok').length}00`;
  const session = `wa_${user}`;
  await turn(session, 'whatsapp', user, 'Book a consultation next Friday at 16:30');
  await turn(session, 'whatsapp', user, 'bale mersi');
  assert.equal(boundary.whatsappWouldDispatch(session, 'Maral 03485350634'), true);
  const result = await turn(session, 'whatsapp', user, 'Maral 03485350634');
  assert.equal(result.replies.length, 1);
  assert.doesNotMatch(result.replies[0], /technical problem occurred/i);
  if (failure) {
    assert.equal(result.pending?.status, 'failed_recoverable');
    assert.equal(result.pending?.customerName, 'Maral');
    assert.ok(result.pending?.dateTime && result.pending?.selectedSlotEnd);
    assert.doesNotMatch(result.replies[0], /your appointment has been booked|your booking is confirmed/i);
    assert.ok(result.pending?.failedStage || result.pending?.lastFailureStage);
    assert.ok(counters.calendarCreate <= 1 && counters.calendarRead <= 1 && counters.databaseInsert <= 1 && counters.settlement <= 1);
  } else {
    assert.equal(result.pending, null);
    assert.equal(counters.calendarCreate, 1);
    assert.equal(counters.calendarRead, 1);
    assert.equal(counters.databaseInsert, 1);
    assert.equal(counters.databaseRead, 1);
    assert.equal(counters.settlement, 1);
    assert.equal(counters.createdName, 'Maral');
    assert.ok(counters.createdPhone.length >= 8);
    assert.match(result.replies[0], /booked|confirmed/i);
    assert.equal(events.size, 1);
  }
}

// Customer delivery failure stays terminal; admin failure cannot replace a delivered success.
{
  let state = fixture();
  await turn('wa_delivery', 'whatsapp', 'delivery', 'Book a consultation next Friday at 16:30');
  await turn('wa_delivery', 'whatsapp', 'delivery', 'Yes');
  const failedDelivery = await turn('wa_delivery', 'whatsapp', 'delivery', 'Maral 03485350634', { sendResult: false });
  assert.equal(failedDelivery.handled, true);
  assert.equal(failedDelivery.pending, null);
  assert.equal(failedDelivery.replies.length, 0);
  assert.equal(state.counters.calendarCreate, 1);

  state = fixture({ adminFailure: true });
  await turn('wa_admin', 'whatsapp', 'admin', 'Book a consultation next Friday at 16:30');
  await turn('wa_admin', 'whatsapp', 'admin', 'Yes');
  const adminFailure = await turn('wa_admin', 'whatsapp', 'admin', 'Maral 03485350634');
  assert.equal(adminFailure.pending, null);
  assert.equal(adminFailure.replies.length, 1);
  assert.equal(state.counters.admin, 1);
}

// Test 4: Instagram numeric Finglish weekday exact/range parity uses one snapshot per turn.
{
  const { counters, events } = fixture();
  const displayDate = '2026-08-05';
  events.set('working-hours', { id: 'working-hours', summary: 'Working Hours', start: { dateTime: `${displayDate}T09:00:00+02:00` }, end: { dateTime: `${displayDate}T19:00:00+02:00` } });
  events.set('booked', { id: 'booked', summary: 'Booked appointment', start: { dateTime: `${displayDate}T16:30:00+02:00` }, end: { dateTime: `${displayDate}T17:00:00+02:00` } });
  events.set('pending-hold', { id: 'pending-hold', summary: 'Pending hold', start: { dateTime: `${displayDate}T17:30:00+02:00` }, end: { dateTime: `${displayDate}T18:00:00+02:00` } });
  await turn('ig_range', 'instagram', 'range', 'Salam man ye vaght moshavereh mikham');
  const beforeRangeReads = counters.availabilityReads;
  const range = await turn('ig_range', 'instagram', 'range', '4 shanbe bad az sate 16');
  assert.equal(counters.availabilityReads, beforeRangeReads + 1);
  assert.ok(range.pending?.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) > 16 * 60));
  assert.ok(range.pending?.ownedOfferedSlots.some((slot: any) => localMinute(slot.start) === 17 * 60));
  await turn('ig_exact', 'instagram', 'exact', 'Salam man ye vaght moshavereh mikham');
  const beforeExactReads = counters.availabilityReads;
  const exact = await turn('ig_exact', 'instagram', 'exact', '4shanbe sate 17');
  assert.equal(counters.availabilityReads, beforeExactReads + 1);
  assert.equal(localMinute(exact.pending?.dateTime), 17 * 60);
  assert.equal(range.pending?.selectedDate, exact.pending?.selectedDate);
}

// Test 5: Instagram lookup ownership survives restart and never includes another customer.
{
  const { events, restart } = fixture();
  const owned = (id: string, hour: number) => ({ id, status: 'confirmed', summary: `Bokad: Peter - 0701234567`, description: 'BusinessId: 7', start: { dateTime: `2026-08-14T${String(hour).padStart(2, '0')}:00:00+02:00` }, end: { dateTime: `2026-08-14T${String(hour).padStart(2, '0')}:30:00+02:00` }, extendedProperties: { private: { businessId: '7', platform: 'instagram', userId: 'owner' } } });
  events.set('owned-1', owned('owned-1', 10));
  events.set('owned-2', owned('owned-2', 11));
  events.set('other', { ...owned('other', 12), extendedProperties: { private: { businessId: '7', platform: 'instagram', userId: 'other' } } });
  restart();
  const found = await turn('ig_owner', 'instagram', 'owner', 'Jag vill ändra min tid');
  assert.equal(found.selection?.appointments.length, 2);
  assert.ok(found.selection.appointments.every((item: any) => item.id !== 'other'));
  const selected = await turn('ig_owner', 'instagram', 'owner', '1');
  assert.ok(['owned-1', 'owned-2'].includes(String(selected.appointment?.id)));
  const stableId = selected.appointment.id;
  await turn('ig_owner', 'instagram', 'owner', 'torsdag kl 15');
  const corrected = await turn('ig_owner', 'instagram', 'owner', 'torsdag kl 16 istället');
  assert.equal(corrected.appointment?.id || stableId, stableId);
}

const messengerAppointment = { id: 'row-ms', calendarEventId: 'event-ms', source: 'appointments_table', customerName: 'Peter', phone: '0701234567', platform: 'messenger', userId: 'ms-owner', businessId: '7', service: 'Konsultation', start: '2026-08-14T10:00:00+02:00', end: '2026-08-14T08:30:00.000Z', status: 'booked' };

// Tests 6/7: Messenger cancellation is terminal and duplicate delivery is suppressed.
{
  const { counters, events } = fixture();
  events.set('event-ms', { id: 'event-ms', status: 'confirmed', summary: 'Bokad: Peter - 0701234567', description: 'BusinessId: 7', start: { dateTime: new Date(messengerAppointment.start).toISOString() }, end: { dateTime: messengerAppointment.end }, extendedProperties: { private: { businessId: '7', platform: 'messenger', userId: 'ms-owner' } } });
  boundary.seedOwnedAppointment({ sessionId: 'ms_ms-owner', platform: 'messenger', userId: 'ms-owner', businessConfig, appointment: messengerAppointment, operation: 'cancellation' });
  await inbound('ms-reason', 'ms_ms-owner', 'messenger', 'ms-owner', 'Mina planer ändrades');
  const confirmed = await inbound('ms-confirm', 'ms_ms-owner', 'messenger', 'ms-owner', 'Bale');
  const duplicate = await inbound('ms-confirm', 'ms_ms-owner', 'messenger', 'ms-owner', 'Bale');
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.replies.length, 1);
  assert.match(confirmed.replies[0], /cancelled|canceled|avbokad|لغو/u);
  assert.equal(confirmed.operation.operation, 'none');
  assert.equal(duplicate.replies.length, 0);
  assert.equal(counters.calendarDelete, 1);
  assert.equal(counters.databaseCancel, 1);
  assert.equal(counters.cancellationSettlement, 1);
  assert.equal(counters.admin, 1);
  assert.equal(counters.usage, 2);
}

// Messenger admin notification failure cannot replace or suppress customer success.
{
  const { counters, events } = fixture({ adminFailure: true });
  events.set('event-ms', { id: 'event-ms', status: 'confirmed', summary: 'Bokad appointment', description: 'BusinessId: 7', start: { dateTime: new Date(messengerAppointment.start).toISOString() }, end: { dateTime: messengerAppointment.end }, extendedProperties: { private: { businessId: '7', platform: 'messenger', userId: 'ms-owner' } } });
  boundary.seedOwnedAppointment({ sessionId: 'ms_ms-owner', platform: 'messenger', userId: 'ms-owner', businessConfig, appointment: messengerAppointment, operation: 'cancellation' });
  await turn('ms_ms-owner', 'messenger', 'ms-owner', 'Mina planer ändrades');
  const confirmed = await turn('ms_ms-owner', 'messenger', 'ms-owner', 'Bale');
  assert.equal(confirmed.replies.length, 1);
  assert.match(confirmed.replies[0], /cancelled|canceled|avbokad|لغو/u);
  assert.equal(confirmed.operation.operation, 'none');
  assert.equal(counters.admin, 1);
  assert.equal(counters.calendarDelete, 1);
}

console.log('Priority 1J non-Telegram channel-parity real-engine transcripts passed');
