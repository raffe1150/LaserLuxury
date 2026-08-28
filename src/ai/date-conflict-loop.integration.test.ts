import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
console.log = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

let availabilityReads = 0;
let bookingMutations = 0;
const adapter = {
  getEvents: async () => { availabilityReads += 1; return []; },
  checkSlots: () => ({ available_slots_string: '' }),
  insertAppointment: () => { bookingMutations += 1; return { success: true }; },
  updateAppointment: () => { bookingMutations += 1; return { success: true }; },
  cancelAppointment: () => { bookingMutations += 1; return { success: true }; },
};

type LeadRow = { user_id: string; platform: string; ai_summary: string | null };
class LeadQuery {
  private filters: Array<(row: LeadRow) => boolean> = [];
  private columns = '*';
  constructor(private rows: LeadRow[], private values?: Partial<LeadRow>) {}
  eq(column: keyof LeadRow, value: unknown) {
    this.filters.push(row => row[column] === value);
    return this;
  }
  select(columns: string) { this.columns = columns; return this; }
  async maybeSingle() {
    const row = this.rows.find(item => this.filters.every(filter => filter(item))) || null;
    if (row && this.values) Object.assign(row, this.values);
    if (!row) return { data: null, error: null };
    if (this.columns === 'user_id') return { data: { user_id: row.user_id }, error: null };
    if (this.columns === 'ai_summary') return { data: { ai_summary: row.ai_summary }, error: null };
    return { data: structuredClone(row), error: null };
  }
}
class FakePendingStore {
  rows: LeadRow[] = [];
  from(table: string) {
    assert.equal(table, 'appointments_leads');
    return {
      select: (columns: string) => new LeadQuery(this.rows).select(columns),
      update: (values: Partial<LeadRow>) => new LeadQuery(this.rows, values),
      insert: async (values: Array<Partial<LeadRow>>) => {
        for (const value of values) this.rows.push({
          user_id: String(value.user_id || ''),
          platform: String(value.platform || 'telegram'),
          ai_summary: value.ai_summary == null ? null : String(value.ai_summary),
        });
        return { data: null, error: null };
      },
    };
  }
}
const now = new Date('2026-08-25T12:00:00+02:00');
const business = (id: string) => ({
  id,
  businessRecordId: id,
  business_id: id,
  businessName: `Clinic ${id}`,
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  defaultBookingService: 'Konsultation',
});
const configure = () => {
  boundary.reset();
  boundary.configure({ calendarAdapter: adapter, postProcess: async () => undefined });
  availabilityReads = 0;
};
const conflicts = {
  en: 'I want to book Tuesday 15 October 2026 at 14:00',
  sv: 'Jag vill boka tisdag den 15 oktober 2026 klockan 14:00',
  es: 'Quiero reservar el martes 15 de octubre de 2026 a las 14:00',
  de: 'Ich möchte Dienstag den 15. Oktober 2026 um 14:00 buchen',
  fa: 'می خواهم سه شنبه 15 اکتبر 2026 ساعت 14:00 رزرو کنم',
  ar: 'أريد حجز يوم الثلاثاء 15 أكتوبر 2026 الساعة 14:00',
} as const;

const turn = (sessionId: string, text: string, businessConfig = business('date-loop'), platformName: any = 'telegram') => boundary.turn({
  sessionId,
  platformName,
  recipientUserId: `${sessionId}-user`,
  text,
  businessConfig,
  now,
});

try {
  // All languages progress through four bounded, deterministic response stages.
  for (const [language, text] of Object.entries(conflicts)) {
    configure();
    const replies: string[] = [];
    let result: any;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      result = await turn(`repeat-${language}`, text);
      assert.equal(result.handled, true);
      assert.equal(result.replies.length, 1);
      replies.push(result.replies[0]);
      assert.equal(result.pending?.dateConflictClarification?.attemptCount, attempt);
      assert.equal(result.pending?.dateTime, null);
      assert.equal(result.pending?.selectedSlotEnd, null);
    }
    assert.equal(new Set(replies).size, 4, `${language} must not repeat the initial clarification`);
    const suppressed = await turn(`repeat-${language}`, text);
    assert.equal(suppressed.handled, true);
    assert.equal(suppressed.replies.length, 0, `${language} identical input is bounded after the terminal prompt`);
    assert.equal(suppressed.pending?.dateConflictClarification?.attemptCount, 4);
    if (language === 'fa' || language === 'ar') assert.match(replies.join(' '), /[\u0600-\u06ff]/u);
    if (language === 'fa') assert.match(replies[0], /منظورتان/u, 'Persian must not fall back to Arabic or English');
    if (language === 'ar') {
      assert.match(replies[0], /هل تقصد/u, 'Arabic must use native Arabic clarification copy');
      assert.match(replies[1], /يرجى الرد/u, 'Arabic explicit-choice recovery must remain Arabic');
    }
    assert.equal(availabilityReads, 0);
  }

  // Candidate 1, candidate 2, and a new date each clear state and resume availability once.
  for (const [language, text] of Object.entries(conflicts)) {
    for (const [selection, expectedDate] of [['1', '2026-10-15'], ['2', '2026-10-13'], ['2026-10-20', '2026-10-20']] as const) {
      configure();
      const sessionId = `resolve-${language}-${selection}`;
      await turn(sessionId, text);
      const resolved = await turn(sessionId, selection);
      assert.equal(resolved.pending?.selectedDate, expectedDate, `${language}/${selection}`);
      assert.equal(resolved.pending?.dateConflictClarification, undefined, `${language}/${selection} clears clarification`);
      assert.equal(availabilityReads, 1, `${language}/${selection} resumes availability exactly once`);
      assert.equal(bookingMutations, 0, 'clarification resolution never creates a booking');
    }
  }

  // Bare numeric messages have no global date-selection meaning.
  configure();
  assert.equal((await turn('bare-one', '1')).handled, false);
  assert.equal((await turn('bare-two', '2')).handled, false);
  assert.equal(availabilityReads, 0);

  // One provider event is idempotent; the same text under a new event is a real second attempt.
  configure();
  const inboundParams = {
    sessionId: 'provider-idempotency',
    platformName: 'telegram' as const,
    recipientUserId: 'provider-idempotency-user',
    text: conflicts.sv,
    businessConfig: business('provider-idempotency'),
    now,
  };
  const firstDelivery = await boundary.inboundTurn({ ...inboundParams, eventId: 'event-1' });
  const duplicateDelivery = await boundary.inboundTurn({ ...inboundParams, eventId: 'event-1' });
  const secondTurn = await boundary.inboundTurn({ ...inboundParams, eventId: 'event-2' });
  assert.equal(firstDelivery.replies.length, 1);
  assert.equal(duplicateDelivery.replies.length, 0);
  assert.equal(secondTurn.replies.length, 1);
  assert.match(secondTurn.replies[0], /(?:Svara|1)/u);
  assert.equal(secondTurn.pending?.dateConflictClarification?.attemptCount, 2);

  // The nested clarification state survives loss of process memory through the existing JSON store.
  boundary.reset();
  const durableStore = new FakePendingStore();
  boundary.configure({
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    supabaseClient: durableStore as any,
  });
  const durableConfig = business('durable-date-conflict');
  const durableFirst = await turn('durable-session', conflicts.sv, durableConfig);
  assert.equal(durableFirst.pending?.dateConflictClarification?.attemptCount, 1);
  assert.equal(durableStore.rows.length, 1);
  boundary.dropPendingMemory('durable-session');
  const durableSecond = await turn('durable-session', conflicts.sv, durableConfig);
  assert.equal(durableSecond.pending?.dateConflictClarification?.attemptCount, 2);
  assert.match(durableSecond.replies[0], /Svara 1/u);

  // Customer, channel, and tenant-scoped session keys cannot share clarification attempts.
  configure();
  const tenantA = business('tenant-a');
  const tenantB = business('tenant-b');
  const customerA = await turn('tenant-a-customer-a', conflicts.sv, tenantA);
  const customerB = await turn('tenant-a-customer-b', conflicts.sv, tenantA);
  const otherTenant = await turn('tenant-b-customer-a', conflicts.sv, tenantB);
  assert.equal(customerA.pending?.dateConflictClarification?.attemptCount, 1);
  assert.equal(customerB.pending?.dateConflictClarification?.attemptCount, 1);
  assert.equal(otherTenant.pending?.dateConflictClarification?.attemptCount, 1);

  for (const platform of ['telegram', 'whatsapp', 'messenger', 'instagram'] as const) {
    configure();
    const first = await turn(`channel-${platform}`, conflicts.sv, business(`channel-${platform}`), platform);
    const second = await turn(`channel-${platform}`, conflicts.sv, business(`channel-${platform}`), platform);
    assert.equal(first.pending?.dateConflictClarification?.attemptCount, 1, platform);
    assert.equal(second.pending?.dateConflictClarification?.attemptCount, 2, platform);
    assert.notEqual(first.replies[0], second.replies[0], platform);
  }

  // Attaching clarification to an existing flow preserves all authoritative booking facts.
  configure();
  const factsSession = 'existing-facts';
  const existingFacts = {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessConfig: business('facts-business'),
    businessId: 'facts-business',
    platform: 'telegram',
    userId: factsSession,
    sessionId: factsSession,
    operation: 'new_booking',
    status: 'awaiting_date_or_time',
    expectedInput: 'date_or_constraint',
    service: 'Laserbehandling',
    customerName: 'Ada',
    customerPhone: '+46701234567',
    contactPhoneSource: 'customer_message',
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'sv', sourceMode: 'text', requiresClarification: false,
      date: { kind: 'exact_date', value: '2026-10-10', confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: 600, confidence: 'high' },
    },
    offeredSlots: [], ownedOfferedSlots: [], dateTime: null, selectedSlotEnd: null,
  };
  boundary.seedPending(factsSession, existingFacts);
  const withClarification = await turn(factsSession, conflicts.sv, existingFacts.businessConfig);
  assert.equal(withClarification.pending?.service, existingFacts.service);
  assert.equal(withClarification.pending?.customerName, existingFacts.customerName);
  assert.equal(withClarification.pending?.customerPhone, existingFacts.customerPhone);
  assert.deepEqual(withClarification.pending?.normalizedBookingRequest, existingFacts.normalizedBookingRequest);
  assert.equal(withClarification.pending?.dateTime, null);
  assert.equal(withClarification.pending?.dateConflictClarification?.proposedTimeConstraint?.startMinutes, 840);
  assert.equal(availabilityReads, 0);
  assert.equal(bookingMutations, 0);
} finally {
  boundary.reset();
  console.log = originalLog;
}

console.log('cross-language and cross-channel date clarification loop integration tests passed');
