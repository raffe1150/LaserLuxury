import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = { id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm', defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7', allowCancellation: true };
const testNow = new Date('2026-08-03T10:00:00+02:00');
const thursday = '2026-08-06';
const event = (id: string, start: string, end: string, summary = 'Customer appointment') => ({ id, summary, status: 'confirmed', start: { dateTime: `${thursday}T${start}:00+02:00` }, end: { dateTime: `${thursday}T${end}:00+02:00` } });

function fixture(options: { changingSnapshot?: boolean } = {}) {
  const events = new Map<string, any>();
  const counters = { reads: 0, creates: 0, updates: 0, deletes: 0, databaseMutations: 0 };
  const adapter = {
    getCalendarId: () => 'cal-7',
    checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => {
      counters.reads += 1;
      if (options.changingSnapshot && counters.reads > 1) return [event('changed', '09:00', '20:00', 'Unexpected provider snapshot')];
      return [...events.values()];
    },
    insertAppointment: async () => { counters.creates += 1; return { success: false }; },
    updateAppointment: async () => { counters.updates += 1; return { success: false }; },
    cancelAppointment: async () => { counters.deletes += 1; return { success: false }; },
    getEventById: async (id: string) => events.get(id) || null,
    verifyEventDeleted: async () => false,
  };
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    notifyReschedule: async () => true,
    notifyCancellation: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    updateAppointmentRow: async () => { counters.databaseMutations += 1; return null; },
    cancelAppointmentRow: async () => { counters.databaseMutations += 1; return null; },
    recordAppointment: async () => { counters.databaseMutations += 1; return null; },
    claimOperation: async (params: any) => ({ claimed: true, keyHash: params.exactId, storageId: params.exactId, state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } }),
    settleOperation: async () => true,
  });
  return { events, counters };
}

const turn = (sessionId: string, platformName: 'whatsapp' | 'instagram' | 'messenger' | 'telegram', text: string, inputMode: 'text' | 'voice' = 'text') => boundary.turn({ sessionId, platformName, recipientUserId: sessionId, text, inputMode, businessConfig, now: testNow });
const minutes = (iso: string) => { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value); };
const starts = (result: any) => (result.pending?.ownedOfferedSlots || []).map((slot: any) => minutes(slot.start));

// Messenger live contradiction, strict correction replacement, snapshot stability, and no mutation.
{
  const { events, counters } = fixture();
  events.set('hours', event('hours', '09:00', '20:00', 'Working hours 9 AM - 8 PM'));
  events.set('busy-11', event('busy-11', '11:00', '11:30'));
  await turn('ms-live', 'messenger', 'Hej kan du boka en tid för mig');
  let reads = counters.reads;
  const after = await turn('ms-live', 'messenger', 'Konsultation, jag vill komma på torsdag efter kl 15');
  assert.equal(counters.reads, reads + 1);
  assert.ok(starts(after).every((value: number) => value > 15 * 60));
  const afterFingerprint = after.pending.lastAvailabilityConstraintKey;
  reads = counters.reads;
  const before = await turn('ms-live', 'messenger', 'Innan kl 12 jag kan komma också');
  assert.equal(counters.reads, reads + 1);
  assert.ok(starts(before).length > 0 && starts(before).every((value: number) => value < 12 * 60));
  assert.equal(before.pending.availabilityConstraint.timeBoundary.kind, 'exclusive_upper');
  assert.notEqual(before.pending.lastAvailabilityConstraintKey, afterFingerprint);
  const blocked = await turn('ms-live', 'messenger', 'Kl 11');
  assert.ok(blocked.pending.ownedOfferedSlots.length > 0);
  assert.ok(!starts(blocked).includes(11 * 60));
  assert.equal(blocked.pending.availabilityConstraint.kind, 'exact_time');
  assert.equal(blocked.pending.availabilityConstraint.exactTime, '11:00');
  const free = await turn('ms-live', 'messenger', 'Kl 12:30?');
  assert.deepEqual(starts(free), [12 * 60 + 30]);
  assert.equal(free.pending.availabilityConstraint.kind, 'exact_time');
  const exactFingerprint = free.pending.lastAvailabilityConstraintKey;
  const friday = await turn('ms-live', 'messenger', 'Friday after 16');
  assert.equal(friday.pending.availabilityConstraint.startDate, '2026-08-07');
  assert.ok(starts(friday).every((value: number) => value > 16 * 60));
  assert.notEqual(friday.pending.lastAvailabilityConstraintKey, exactFingerprint);
  assert.deepEqual({ creates: counters.creates, updates: counters.updates, deletes: counters.deletes, databaseMutations: counters.databaseMutations }, { creates: 0, updates: 0, deletes: 0, databaseMutations: 0 });
}

// Full enumeration finds a later candidate after the first ranked candidates are blocked; before/after ranking is deterministic.
{
  const { events } = fixture();
  events.set('late-1', event('late-1', '12:45', '13:15'));
  events.set('late-2', event('late-2', '12:30', '13:00'));
  events.set('late-3', event('late-3', '12:15', '12:45'));
  const before = await turn('range-before', 'messenger', 'Book consultation Thursday before 13');
  assert.ok(starts(before).includes(11 * 60 + 45));
  assert.ok(starts(before).every((value: number) => value < 13 * 60));
  for (const value of starts(before)) {
    const clock = `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    const exact = await turn('exact-equivalence', 'messenger', `Book consultation Thursday at ${clock}`);
    assert.deepEqual(starts(exact), [value]);
  }
  const after = await turn('range-after', 'messenger', 'Book consultation Thursday after 16');
  assert.deepEqual(starts(after).slice(0, 3), [16 * 60 + 15, 16 * 60 + 30, 16 * 60 + 45]);
  const between = await turn('range-between', 'messenger', 'Book consultation Thursday between 10 and 12');
  assert.ok(starts(between).length > 0 && starts(between).every((value: number) => value >= 10 * 60 && value <= 12 * 60));
}

// A changing provider is read exactly once for one availability turn.
{
  const { counters } = fixture({ changingSnapshot: true });
  const result = await turn('snapshot', 'messenger', 'Book consultation Thursday after 16');
  assert.equal(counters.reads, 1);
  assert.ok(starts(result).length > 0);
}

// Equivalent normalized requests have identical candidates across channels and Telegram voice normalization.
{
  const results: number[][] = [];
  for (const [platform, mode] of [['whatsapp', 'text'], ['instagram', 'text'], ['messenger', 'text'], ['telegram', 'text'], ['telegram', 'voice']] as const) {
    fixture();
    results.push(starts(await turn(`${platform}-${mode}`, platform, 'Book consultation Thursday after 16', mode)));
  }
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
}

// Reschedule searches preserve appointment identity and perform no mutation before confirmation.
{
  const { events, counters } = fixture();
  const appointment = { id: 'row-1', calendarEventId: 'original', platform: 'messenger', userId: 'reschedule', businessId: '7', service: 'Konsultation', start: '2026-08-05T10:00:00+02:00', end: '2026-08-05T08:30:00.000Z', status: 'booked' };
  events.set('original', { id: 'original', summary: 'Customer appointment', start: { dateTime: appointment.start }, end: { dateTime: appointment.end } });
  boundary.seedOwnedAppointment({ sessionId: 'reschedule', platform: 'messenger', userId: 'reschedule', businessConfig, appointment, operation: 'reschedule' });
  const result = await turn('reschedule', 'messenger', 'Change my appointment to Thursday after 15');
  assert.equal(result.appointment.id, 'row-1');
  assert.equal(counters.updates, 0);
  assert.equal(counters.databaseMutations, 0);
}

console.log('Priority 1K range availability real-engine integration transcripts passed');
