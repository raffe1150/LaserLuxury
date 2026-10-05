import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { PendingLeadStore, type LeadRow } from '../../tests/helpers/pending-lead-store';
import { CURRENT_BOOKING_STATE_VERSION } from '../ai/booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const config = { id: '3', businessRecordId: '3', business_id: '3', calendarProvider: 'custom',
  timezone: 'Europe/Stockholm', defaultBookingService: 'Consultation' };
const session = 'tg:3:synthetic-bot:customer-a';
const platform = 'telegram';
const pending = () => ({ businessConfig: config, businessId: '3', platform, userId: 'customer-a',
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking',
  status: 'awaiting_date_or_time', expectedInput: 'date_or_constraint', service: 'Consultation',
  language: 'en', createdAt: Date.now(), updatedAt: Date.now() });
const lead = (id = 1, overrides: Partial<LeadRow> = {}, state: any = {}) => ({
  id, user_id: session, platform, business_id: '3',
  ai_summary: JSON.stringify({ ...pending(), businessConfig: undefined, type: 'pending_booking',
    business_id: '3', ...state }), ...overrides,
});
let store: PendingLeadStore;
let errors: any[][];
const originalError = console.error;
beforeEach(() => {
  boundary.reset();
  store = new PendingLeadStore();
  errors = [];
  console.error = (...args) => { errors.push(args); };
  boundary.configure({ supabaseClient: store });
});
after(() => { boundary.reset(); console.error = originalError; });
const restore = () => boundary.stateAuditRestore(session, platform, config);
const persist = () => boundary.stateAuditPersist(session, platform, pending());
const writes = () => store.requests.filter(request => request.method !== 'GET');

test('real client confirms zero is valid and duplicate rows produce PGRST116 in the checkpoint query', async () => {
  const query = () => store.client.from('appointments_leads').select('user_id').eq('user_id', session).maybeSingle();
  assert.equal((await query()).error, null);
  store.rows = [lead()];
  assert.equal((await query()).data?.user_id, session);
  store.rows.push(lead(2));
  const result = await query();
  assert.equal(result.error?.code, 'PGRST116');
  assert.match(result.error?.details || '', /2 rows/);
});
test('no pending row is quiet; saving creates one explicitly scoped row', async () => {
  assert.equal(await restore(), null);
  assert.equal(errors.length, 0);
  await persist();
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].business_id, '3');
  assert.equal(store.rows[0].platform, platform);
  assert.equal(store.rows[0].user_id, session);
});
test('one pending row restores and subsequent save updates it without inserting', async () => {
  store.rows = [lead()];
  assert.equal((await restore())?.userId, 'customer-a');
  await persist();
  assert.equal(store.rows.length, 1);
  assert.equal(writes()[0].method, 'PATCH');
  assert.equal(errors.length, 0);
});
test('duplicate pending rows stop recovery and saving, emit an integrity category, and do not write', async () => {
  store.rows = [lead(), lead(2, {}, { updatedAt: Date.now() + 1000 })];
  const before = structuredClone(store.rows);
  await assert.rejects(restore, /ambiguous_pending_lead/);
  await assert.rejects(persist, /ambiguous_pending_lead/);
  assert.deepEqual(store.rows, before);
  assert.equal(writes().length, 0);
  assert.ok(errors.some(args => args[1]?.category === 'ambiguous_pending_lead'));
  assert.doesNotMatch(JSON.stringify(errors), /customer-a|synthetic-bot|ai_summary/);
});
test('lookup and update requests retain exact session, channel, business and row isolation', async () => {
  store.rows = [lead()];
  await persist();
  const [read, write] = store.requests;
  assert.equal(read.url.searchParams.get('user_id'), `eq.${session}`);
  assert.equal(read.url.searchParams.get('platform'), 'eq.telegram');
  assert.equal(read.url.searchParams.get('or'), '(business_id.eq.3,business_id.is.null)');
  assert.equal(read.url.searchParams.has('limit'), false);
  assert.equal(write.url.searchParams.get('id'), 'eq.1');
  assert.equal(write.url.searchParams.get('user_id'), `eq.${session}`);
  assert.equal(write.url.searchParams.get('platform'), 'eq.telegram');
  assert.equal(write.url.searchParams.get('business_id'), 'eq.3');
});
for (const businessId of ['3', '9007199254740993', '9223372036854775807']) {
  test(`canonical bigint business ID ${businessId} preserves zero/one/multiple-row semantics`, async () => {
    const scopedConfig = { ...config, id: businessId, businessRecordId: businessId, business_id: businessId };
    const scopedSession = `tg:${businessId}:synthetic-bot:customer-a`;
    const scopedRestore = () => boundary.stateAuditRestore(scopedSession, platform, scopedConfig);
    const scopedPersist = () => boundary.stateAuditPersist(scopedSession, platform,
      { ...pending(), businessConfig: scopedConfig, businessId });
    assert.equal(await scopedRestore(), null);
    assert.equal(errors.length, 0);
    const row = lead(1, { user_id: scopedSession, business_id: businessId }, { business_id: businessId });
    store.rows = [row];
    assert.equal((await scopedRestore())?.businessId, businessId);
    await scopedPersist();
    assert.equal(store.rows.length, 1);
    assert.equal(writes().length, 1);
    for (const request of store.requests.filter(request => request.method === 'GET')) {
      assert.equal(request.url.searchParams.get('or'), `(business_id.eq.${businessId},business_id.is.null)`);
      assert.equal(request.url.searchParams.has('limit'), false);
    }
    boundary.dropBookingSessionMemory(scopedSession);
    store.rows.push({ ...row, id: 2 });
    await assert.rejects(scopedRestore, /ambiguous_pending_lead/);
    await assert.rejects(scopedPersist, /ambiguous_pending_lead/);
    assert.equal(writes().length, 1);
    assert.equal(store.rows.length, 2);
  });
}
test('invalid or noncanonical bigint business IDs fail closed before any request', async () => {
  for (const businessId of ['', 'clinic', '0', '-3', '+3', '03', '3.0', '3e0', ' 3', '3 ', '3\n',
    '9223372036854775808', '99999999999999999999']) {
    const invalidConfig = { ...config, id: businessId, businessRecordId: businessId, business_id: businessId };
    await assert.rejects(() => boundary.stateAuditRestore(session, platform, invalidConfig), /pending_lead_scope_missing/);
    await assert.rejects(() => boundary.stateAuditPersist(session, platform,
      { ...pending(), businessConfig: invalidConfig, businessId }), /pending_lead_scope_missing/);
  }
  assert.equal(store.requests.length, 0);
  assert.equal(store.rows.length, 0);
  assert.ok(errors.every(args => args[1]?.category === 'pending_lead_scope_missing'));
});
test('raw filter injection inputs cannot reach PostgREST', async () => {
  for (const businessId of ['3,business_id.is.null', '3),user_id.neq.customer-a', '3,platform.neq.telegram',
    '3"', '3%2Cbusiness_id.is.null', '3\n,business_id.is.null']) {
    const injectedConfig = { ...config, id: businessId, businessRecordId: businessId, business_id: businessId };
    await assert.rejects(() => boundary.stateAuditRestore(session, platform, injectedConfig), /pending_lead_scope_missing/);
    await assert.rejects(() => boundary.stateAuditPersist(session, platform,
      { ...pending(), businessConfig: injectedConfig, businessId }), /pending_lead_scope_missing/);
  }
  assert.equal(store.requests.length, 0);
  assert.equal(store.rows.length, 0);
});
for (const [name, row] of [
  ['business', () => lead(2, { business_id: '4' }, { business_id: '4' })],
  ['channel', () => lead(2, { platform: 'instagram' }, { platform: 'instagram' })],
  ['customer/session', () => lead(2, { user_id: 'tg:3:synthetic-bot:customer-b' }, { userId: 'customer-b' })],
] as const) {
  test(`${name} isolation excludes foreign rows from recovery and updates`, async () => {
    const foreign = row();
    store.rows = [foreign];
    assert.equal(await restore(), null);
    await persist();
    assert.deepEqual(store.rows[0], foreign);
    assert.equal(store.rows.length, 2);
    boundary.dropBookingSessionMemory(session);
    assert.equal((await restore())?.businessId, '3');
    await persist();
    assert.deepEqual(store.rows[0], foreign);
    assert.equal(store.rows.length, 2);
  });
}
test('embedded customer mismatch cannot be restored or overwritten', async () => {
  store.rows = [lead(1, {}, { userId: 'customer-b' })];
  await assert.rejects(restore, /pending_lead_owner_mismatch/);
  await assert.rejects(persist, /pending_lead_owner_mismatch/);
  assert.equal(writes().length, 0);
});
test('legacy null-business row requires matching embedded ownership and remains recoverable', async () => {
  store.rows = [lead(1, { business_id: null })];
  assert.equal((await restore())?.businessId, '3');
  await persist();
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].business_id, '3');
});
test('legacy row from another business is never recovered or updated', async () => {
  const foreign = lead(1, { business_id: null }, { business_id: '4' });
  store.rows = [foreign];
  assert.equal(await restore(), null);
  await persist();
  assert.deepEqual(store.rows[0], foreign);
  assert.equal(store.rows.length, 2);
});
test('legacy row without provable business scope fails safely without an insert', async () => {
  store.rows = [lead(1, { business_id: null, ai_summary: null })];
  await assert.rejects(restore, /pending_lead_scope_unverifiable/);
  await assert.rejects(persist, /pending_lead_scope_unverifiable/);
  assert.equal(writes().length, 0);
});
test('foreign expired memory cannot clear the durable row', async () => {
  store.rows = [lead()];
  boundary.seedPending(session, { ...pending(), businessId: '4', createdAt: Date.now() - 46 * 60_000 });
  assert.equal(await restore(), null);
  assert.equal(writes().length, 0);
  assert.ok(store.rows[0].ai_summary);
});
for (const [name, state] of [
  ['stale', { createdAt: Date.now() - 46 * 60_000 }],
  ['completed', { status: 'completed' }],
  ['completed cancellation', { operation: 'cancellation', status: 'completed' }],
] as const) {
  test(`${name} state remains inactive and clearing cannot affect another owner`, async () => {
    const foreign = lead(2, { business_id: '4' }, { business_id: '4' });
    store.rows = [lead(1, {}, state), foreign];
    assert.equal(await restore(), null);
    assert.equal(store.rows[0].ai_summary, null);
    assert.deepEqual(store.rows[1], foreign);
  });
}
test('stale duplicate has no authority over an active row; refuse to pick or clear either', async () => {
  store.rows = [lead(), lead(2, {}, { createdAt: Date.now() - 46 * 60_000 })];
  await assert.rejects(restore, /ambiguous_pending_lead/);
  assert.equal(writes().length, 0);
});
test('database query failure stays visible and cannot trigger an insert', async () => {
  store.readError = { code: '42501', message: 'synthetic permission failure with private details' };
  await persist();
  assert.equal(writes().length, 0);
  assert.ok(errors.some(args => args[1]?.category === 'query_failure' && args[1]?.code === '42501'));
  assert.doesNotMatch(JSON.stringify(errors), /private details/);
});
test('strict state-first recovery still propagates genuine database failures', async () => {
  store.readError = { code: '42501', message: 'synthetic permission failure' };
  await assert.rejects(() => boundary.whatsappStateFirstPlan('wa_3:123456789', 'Yes', config),
    (error: any) => error.code === '42501');
  assert.equal(writes().length, 0);
});
test('a cleared lead shell is valid absence and is reused by the next booking', async () => {
  store.rows = [lead(1, { ai_summary: null })];
  assert.equal(await restore(), null);
  await persist();
  assert.equal(store.rows.length, 1);
  boundary.dropBookingSessionMemory(session);
  assert.equal((await restore())?.status, 'awaiting_date_or_time');
});
test('normal booking intake survives a process restart and continues the same state', async () => {
  boundary.configure({ supabaseClient: store, calendarAdapter: { getEvents: async () => [],
    checkSlots: () => ({ available_slots_string: '' }) }, postProcess: async () => undefined });
  const turn = (text: string) => boundary.turn({ sessionId: session, platformName: platform,
    recipientUserId: 'customer-a', text, businessConfig: config, now: new Date('2026-10-05T12:00:00+02:00') });
  const first = await turn('I want to book a consultation');
  assert.equal(first.handled, true);
  assert.equal(store.rows.length, 1);
  boundary.dropBookingSessionMemory(session);
  const next = await turn('2026-10-13');
  assert.equal(next.handled, true);
  assert.equal(next.pending?.selectedDate, '2026-10-13');
  assert.equal(store.rows.length, 1);
});
test('recoverable failure survives the durable lookup without losing retry semantics', async () => {
  store.rows = [lead(1, {}, { status: 'failed_recoverable', selectedDate: '2026-10-13',
    lastFailureStage: 'calendar_create', retryEligible: true })];
  const result = await restore();
  assert.equal(result?.status, 'failed_recoverable');
  assert.equal(result?.retryEligible, true);
  assert.equal(result?.failedStage, 'calendar_create');
});
