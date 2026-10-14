import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { google } from 'googleapis';
import { cancellationUncertainReply } from './cancellation-policy';
process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'synthetic-offline';
globalThis.fetch = async () => { throw Error('Cancellation integrity tests forbid network'); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => b.reset());
const now = Date.parse('2026-10-14T06:00:00Z');
class Store {
  rows: any[] = []; failWrites = false; onWrite: (() => void) | null = null;
  from(table: string) {
    if (table !== 'appointments_leads') throw Error('Synthetic store only exposes claim storage');
    const store = this;
    function query(values?: any) {
      const filters: Array<(r: any) => boolean> = [];
      const q = { eq(k: string, v: any) { filters.push(r => r[k] === v); return q; }, select(_columns: string) { return q; },
        async maybeSingle() {
          if (values) store.onWrite?.();
          if (values && store.failWrites) return { data: null, error: { code: 'synthetic_outage' } };
          const row = store.rows.find(r => filters.every(f => f(r)));
          if (row && values) Object.assign(row, values);
          return { data: row ? structuredClone(row) : null, error: null };
        } };
      return q;
    }
    return { insert: async (inputs: any[]) => { for (const row of inputs) {
      if (store.rows.some(r => r.user_id === row.user_id)) return { error: { code: '23505' } };
      store.rows.push(structuredClone(row));
    } return { error: null }; }, select: () => query(), update: (values: any) => query(values) };
  }
  state() { return JSON.parse(this.rows.find(r => r.platform.startsWith('idempotency:'))?.ai_summary || 'null'); }
}
function fixture(t: any) {
  t.mock.timers.enable({ apis: ['Date'], now }); b.reset();
  for (const k of ['log','error','warn','info'] as const) t.mock.method(console, k, () => undefined);
  const config = { id: '8801', businessName: 'Synthetic Integrity', timezone: 'Europe/Stockholm', language: 'en',
    calendarProvider: 'custom', googleCalendarId: 'cal-8801', allowCancellation: true, cancellationDeadlineMinutes: 1440,
    cancellationFeeEnabled: true, cancellationFeeAmount: 250, cancellationFeeCurrency: 'SEK' };
  const h: any = { store: new Store(), config, settings: structuredClone(config), reads: 0, deletes: 0, inserts: 0,
    rowUpdates: 0, onRead: null, beforeDelete: null, rowFailure: false, verificationFailure: false, deleteUnknown: false, readUnknown: false };
  h.row = { id: 'row-A', calendarEventId: 'event-A', source: 'appointments_table', businessId: '8801', platform: 'telegram',
    userId: 'synthetic-owner', customerName: 'Synthetic Visitor', phone: '0701234567', service: 'Consultation',
    start: new Date(now + 12 * 3600000).toISOString(), end: new Date(now + 12 * 3600000 + 45 * 60000).toISOString(), status: 'booked' };
  h.events = new Map([['event-A', { id: 'event-A', etag: '"version-A"', status: 'confirmed', start: { dateTime: h.row.start },
    end: { dateTime: h.row.end }, extendedProperties: { private: { businessId: '8801', platform: 'telegram', userId: 'synthetic-owner' } } }]]);
  h.move = () => { h.row.start = new Date(now + 14 * 3600000).toISOString(); h.row.end = new Date(now + 14 * 3600000 + 45 * 60000).toISOString();
    Object.assign(h.events.get('event-A'), { etag: '"version-B"', start: { dateTime: h.row.start }, end: { dateTime: h.row.end } }); };
  h.dependencies = { supabaseClient: h.store,
    loadCancellationConfig: async () => { h.reads++; await h.onRead?.(h.reads); return structuredClone(h.settings); },
    validateAppointment: async () => structuredClone(h.row),
    calendarAdapter: { getCalendarId: () => config.googleCalendarId, getEvents: async () => [...h.events.values()],
      getEventById: async (id: string) => structuredClone(h.events.get(id) || null),
      checkSlots: async () => ({ available_slots_string: '' }),
      cancelAppointment: async (id: string, options?: any) => { await h.beforeDelete?.();
        if (options?.ifMatch && h.events.get(id)?.etag !== options.ifMatch) return { success: false, outcome: 'not_deleted', code: 'VERSION_CONFLICT' };
        h.deletes++; h.events.delete(id); if (h.deleteUnknown) throw Error('synthetic lost delete response'); return { success: true }; },
      verifyEventDeleted: async (id: string) => { if (h.verificationFailure) throw Error('synthetic verification timeout'); return !h.events.has(id); },
      cancellationEventState: async (id: string) => h.readUnknown ? 'unknown' : h.events.has(id) ? 'active' : 'deleted',
      insertAppointment: async () => { h.inserts++; return { success: false }; },
    } as any,
    cancelAppointmentRow: async (appointment: any) => { h.rowUpdates++;
      if (h.rowFailure) throw Error('synthetic row outage');
      if (appointment.start !== h.row.start || appointment.end !== h.row.end) return null;
      h.row.status = 'cancelled'; return { id: 'row-A', business_id: '8801', platform: 'telegram', user_id: 'synthetic-owner', status: 'cancelled', service: 'Consultation' }; },
    postProcess: async () => undefined, notifyCancellation: async () => true };
  b.configure(h.dependencies);
  b.seedOwnedAppointment({ sessionId: 'integrity', platform: 'telegram', userId: 'synthetic-owner', businessConfig: config,
    appointment: structuredClone(h.row), operation: 'cancellation' });
  h.turn = (text: string) => b.turn({ sessionId: 'integrity', platformName: 'telegram', recipientUserId: 'synthetic-owner', text, businessConfig: config });
  h.confirm = () => h.turn('My plans changed.'); h.yes = () => h.turn('Yes'); return h;
}
test('recorded 18:00 to 20:00 move during final policy validation never deletes with old consent', async t => {
  const h = fixture(t); await h.confirm(); h.onRead = (n: number) => { if (n === 5) h.move(); };
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.row.status, 'booked');
});
test('recorded delete success plus verification timeout retains durable unresolved state, never restoration', async t => {
  const h = fixture(t); await h.confirm(); h.verificationFailure = true; h.readUnknown = true;
  const result = await h.yes(); assert.equal(h.events.has('event-A'), false); assert.equal(h.inserts, 0);
  assert.equal(h.store.state().status, 'manual_resolution'); assert.equal(h.store.state().cancellation.phase, 'manual_resolution');
  assert.doesNotMatch(result.replies.join(' '), /Your appointment is cancelled/u);
});
test('recorded expired worker cannot overwrite newer completed claim', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); b.reset(); const store = new Store(); b.configure({ supabaseClient: store });
  const params = { type: 'cancellation_operation_claim' as const, tenantScope: '8801', businessId: '8801', platform: 'telegram', exactId: 'synthetic-owner|row-A|event-A|cancel' };
  const old = await b.claimAtomic(params); t.mock.timers.setTime(now + 120001); const newer = await b.claimAtomic(params);
  assert.equal(newer.claimed, true); assert.equal(await b.settleAtomic(newer, 'completed'), true);
  assert.equal(await b.settleAtomic(old, 'failed'), false); assert.equal(store.state().status, 'completed');
});
test('changed appointment requires delivered new details and another explicit consent', async t => {
  const h = fixture(t); await h.confirm(); const old = b.cancellationState('integrity').confirmation;
  h.onRead = (n: number) => { if (n === 5) h.move(); }; const response = await h.yes();
  const fresh = b.cancellationState('integrity').confirmation;
  assert.notEqual(fresh.token, old.token); assert.equal(fresh.subject.start, h.row.start);
  assert.equal(fresh.subject.calendarEtag, '"version-B"'); assert.ok(response.replies.some((r: string) => r.includes(fresh.reply)));
  assert.equal(h.deletes, 0); t.mock.timers.setTime(now + 6000); await h.yes(); assert.equal(h.deletes, 1);
});
test('event changes immediately before deletion: If-Match conflict suppresses deletion and refreshes consent', async t => {
  const h = fixture(t); await h.confirm(); h.beforeDelete = () => { h.beforeDelete = null; h.move(); };
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.row.status, 'booked');
  assert.equal(h.store.state().cancellation.calendarOutcome, 'not_deleted');
  t.mock.timers.setTime(now + 6000); await h.yes(); assert.equal(h.deletes, 1);
});
test('database outage after verified deletion never restores; exact evidence is held durably', async t => {
  const h = fixture(t); await h.confirm(); h.rowFailure = true; const result = await h.yes();
  assert.equal(h.deletes, 1); assert.equal(h.inserts, 0); assert.equal(h.row.status, 'booked');
  const state = h.store.state(); assert.equal(state.status, 'manual_resolution');
  assert.equal(state.cancellation.calendarOutcome, 'deleted'); assert.equal(state.cancellation.subject.appointmentId, 'row-A');
  assert.equal(state.cancellation.subject.eventId, 'event-A'); assert.equal(state.cancellation.calendarId, 'cal-8801');
  assert.match(result.replies.join(' '), /cannot verify|contact the business/u);
});
test('competing booking during failed row update cannot be overlapped by cancellation restoration', async t => {
  const h = fixture(t); await h.confirm(); h.dependencies.cancelAppointmentRow = async () => {
    h.events.set('competing-booking', { id: 'competing-booking', start: { dateTime: h.row.start } }); throw Error('synthetic DB failure');
  }; await h.yes(); assert.deepEqual([...h.events.keys()], ['competing-booking']); assert.equal(h.inserts, 0);
  assert.equal(h.store.state().status, 'manual_resolution');
});
test('claim completion outage leaves durable dispatch intent and never undoes verified cancellation', async t => {
  const h = fixture(t); await h.confirm(); const original = h.dependencies.cancelAppointmentRow;
  h.dependencies.cancelAppointmentRow = async (appointment: any) => { const row = await original(appointment); h.store.failWrites = true; return row; };
  const result = await h.yes(); assert.equal(h.row.status, 'cancelled'); assert.equal(h.events.size, 0); assert.equal(h.inserts, 0);
  assert.equal(h.store.state().status, 'manual_resolution'); assert.equal(h.store.state().cancellation.phase, 'dispatch_intent');
  assert.match(result.replies.join(' '), /cannot verify/u);
});
test('lost delete response can complete only after authoritative exact-event deletion and row verification', async t => {
  const h = fixture(t); await h.confirm(); h.deleteUnknown = true; const result = await h.yes();
  assert.equal(h.store.state().status, 'completed'); assert.equal(h.row.status, 'cancelled');
  assert.match(result.replies.join(' '), /Your appointment is cancelled/u); assert.equal(h.inserts, 0);
});
test('lost response with an active/unknown event remains manual, never a retryable failed claim', async t => {
  const h = fixture(t); await h.confirm(); h.beforeDelete = () => { throw Error('synthetic ambiguous transport'); };
  await h.yes(); assert.equal(h.store.state().status, 'manual_resolution'); assert.equal(h.deletes, 0);
  const params = { type: 'cancellation_operation_claim' as const, tenantScope: '8801', businessId: '8801', platform: 'telegram', exactId: 'synthetic-owner|row-A|event-A|cancel' };
  t.mock.timers.setTime(now + 180000); b.reset(); b.configure({ supabaseClient: h.store });
  const claim = await b.claimAtomic(params); assert.equal(claim.claimed, false); assert.equal(claim.duplicateStatus, 'manual_resolution');
});
test('durable intent write failure prevents every calendar deletion', async t => {
  const h = fixture(t); await h.confirm(); h.store.failWrites = true;
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.rowUpdates, 0);
});
test('current event end inconsistent with the owned row cannot establish cancellation consent', async t => {
  const h = fixture(t); h.events.get('event-A').end.dateTime = new Date(now + 15 * 3600000).toISOString();
  await h.confirm(); await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.row.status, 'booked');
});
test('fee increase and disabling after accepted dispatch do not change the consented fee or imply payment', async t => {
  const h = fixture(t); await h.confirm(); h.beforeDelete = () => { h.settings.cancellationFeeAmount = 500; h.settings.allowCancellation = false; b.cancellationPolicyUpdated(h.settings); };
  const result = await h.yes(); const journal = h.store.state().cancellation;
  assert.equal(h.deletes, 1); assert.equal(journal.feeAmount, 250); assert.equal(journal.phase, 'completed'); assert.ok(journal.acceptedAt);
  assert.match(result.replies.join(' '), /250 SEK may be charged/u); assert.doesNotMatch(result.replies.join(' '), /500|collected|have charged/u);
});
test('policy disabling before accepted dispatch still suppresses deletion', async t => {
  const h = fixture(t); await h.confirm(); h.onRead = (n: number) => { if (n === 5) { h.settings.allowCancellation = false; b.cancellationPolicyUpdated(h.settings); } };
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.store.state().cancellation.calendarOutcome, 'not_deleted');
});
for (const etag of [undefined, 'W/"weak"', 'unquoted', '"bad\r\nheader"']) test(`missing or invalid calendar version (${etag ?? 'missing'}) never authorizes deletion`, async t => {
  const h = fixture(t); h.events.get('event-A').etag = etag; await h.confirm(); await h.yes(); assert.equal(h.deletes, 0);
});
test('concurrent confirmations and repeated yes cause exactly one deletion', async t => {
  const h = fixture(t); await h.confirm(); await Promise.all([h.yes(), h.yes(), h.yes()]); await h.yes();
  assert.equal(h.deletes, 1); assert.equal(h.rowUpdates, 1); assert.equal(h.store.state().status, 'completed');
});
test('expired un-dispatched claim cannot settle even without a successor', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); b.reset(); const store = new Store(); b.configure({ supabaseClient: store });
  const claim = await b.claimAtomic({ type: 'cancellation_operation_claim', tenantScope: '8801', businessId: '8801', platform: 'telegram', exactId: 'expired' });
  t.mock.timers.setTime(now + 120001); assert.equal(await b.settleAtomic(claim, 'failed'), false); assert.equal(store.state().status, 'processing');
});
test('overlapping reclaimed attempts have one winner; loser settlement cannot overwrite it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); b.reset(); const store = new Store(); b.configure({ supabaseClient: store });
  const p = { type: 'cancellation_operation_claim' as const, tenantScope: '8801', businessId: '8801', platform: 'telegram', exactId: 'overlap' };
  const old = await b.claimAtomic(p); t.mock.timers.setTime(now + 120001);
  const results = await Promise.all([b.claimAtomic(p), b.claimAtomic(p)]); assert.equal(results.filter(r => r.claimed).length, 1);
  const winner = results.find(r => r.claimed)!; assert.equal(await b.settleAtomic(winner, 'completed'), true);
  assert.equal(await b.settleAtomic(old, 'failed'), false); assert.equal(await b.settleAtomic(winner, 'failed'), false);
  assert.equal(store.state().status, 'completed');
});
for (const status of [204, 412, 503]) test(`real Google client conditional delete transports If-Match and handles HTTP ${status}`, async t => {
  for (const k of ['log','warn','error'] as const) t.mock.method(console, k, () => undefined);
  let requests = 0;
  const auth = { request: async (options: any) => {
    requests++; assert.equal(options.method, 'DELETE'); assert.ok(String(options.url).includes('/calendars/cal-8801/events/event-A'));
    assert.equal(options.headers.get('If-Match'), '"version-A"'); assert.equal(options.timeout, 15000); assert.equal(options.retry, false);
    if (status !== 204) throw Object.assign(Error('synthetic calendar response'), { response: { status } });
    return { status, data: undefined, headers: new Headers(), config: options };
  } };
  const client = google.calendar({ version: 'v3', auth: auth as any });
  const adapter = b.googleCalendarForTest(client, 'cal-8801');
  const result = await adapter.cancelAppointment('event-A', { ifMatch: '"version-A"' }); assert.equal(requests, 1);
  if (status === 204) assert.equal(result.success, true);
  else assert.equal(result.outcome, status === 412 ? 'not_deleted' : 'unknown');
});
test('Google client missing conditional version never falls back to an unconditional delete', async () => {
  const adapter = b.googleCalendarForTest({ events: { delete: async () => assert.fail('No delete without valid version') } }, 'cal-8801');
  assert.equal((await adapter.cancelAppointment('event-A', { ifMatch: '' })).outcome, 'not_deleted');
});
for (const [language, name, yes] of [['en','English','Yes'],['sv','Swedish','Ja'],['de','German','Ja'],['es','Spanish','Sí'],['fa','Persian','بله'],['ar','Arabic','نعم']])
  test(`${language}: unresolved cancellation publishes localized uncertainty, not success or generic acknowledgement`, async t => {
    const h = fixture(t); await h.turn(`Please reply in ${name}. My plans changed.`);
    h.readUnknown = true; const result = await h.turn(yes);
    assert.equal(h.store.state().status, 'manual_resolution'); assert.ok(result.replies.some((r: string) => r.includes(cancellationUncertainReply(language))));
  });
for (const [status, state] of [[200,'active'],[404,'deleted'],[410,'deleted'],[403,'unknown'],[503,'unknown']] as const)
  test(`Google exact-event reconciliation maps HTTP ${status} to ${state}`, async () => {
    const adapter = b.googleCalendarForTest({ events: { get: async (params: any, options: any) => {
      assert.equal(params.calendarId, 'cal-8801'); assert.equal(params.eventId, 'event-A'); assert.equal(options.timeout, 5000);
      if (status !== 200) throw { response: { status } }; return { data: { id: 'event-A', status: 'confirmed' } };
    } } }, 'cal-8801'); assert.equal(await adapter.cancellationEventState('event-A'), state);
  });
test('Google tombstone is deleted, but foreign/empty event bodies remain unknown', async () => {
  for (const data of [{ id: 'event-A', status: 'cancelled' }, { id: 'foreign-event', status: 'confirmed' }, null]) {
    const adapter = b.googleCalendarForTest({ events: { get: async () => ({ data }) } }, 'cal-8801');
    assert.equal(await adapter.cancellationEventState('event-A'), data?.status === 'cancelled' ? 'deleted' : 'unknown');
  }
});
test('row moved during post-delete reconciliation stays manual and is not marked cancelled', async t => {
  const h = fixture(t); await h.confirm(); const original = h.dependencies.cancelAppointmentRow;
  h.dependencies.cancelAppointmentRow = async (appointment: any) => { h.row.start = new Date(now + 16 * 3600000).toISOString(); return original(appointment); };
  await h.yes(); assert.equal(h.row.status, 'booked'); assert.equal(h.store.state().status, 'manual_resolution'); assert.equal(h.inserts, 0);
});
test('production row reconciliation applies exact owner/time/status predicates and accepts an already-cancelled same row', async t => {
  const h = fixture(t); await h.confirm(); delete h.dependencies.cancelAppointmentRow;
  const original = h.store.from.bind(h.store); const queries: any[] = [];
  h.store.from = (table: string) => {
    if (table !== 'appointments') return original(table);
    const make = (update: boolean) => {
      const call = { update, filters: {} as any }; queries.push(call);
      const q = { eq(k: string, v: any) { call.filters[k] = v; return q; }, select() { return q; },
        async maybeSingle() {
          assert.equal(call.filters.id, 'row-A'); assert.equal(call.filters.business_id, '8801');
          assert.equal(call.filters.platform, 'telegram'); assert.equal(call.filters.user_id, 'synthetic-owner');
          assert.equal(call.filters.start_time, h.row.start); assert.equal(call.filters.end_time, h.row.end); assert.equal(call.filters.service, 'Consultation');
          if (update) { assert.equal(call.filters.status, 'booked'); return { data: null, error: null }; }
          assert.equal(call.filters.status, 'cancelled'); return { data: { id: 'row-A', business_id: '8801', platform: 'telegram', user_id: 'synthetic-owner', status: 'cancelled' }, error: null };
        } }; return q;
    };
    return { update: () => make(true), select: () => make(false) } as any;
  };
  await h.yes(); assert.equal(h.store.state().status, 'completed'); assert.equal(queries.length, 2); assert.equal(h.inserts, 0);
});
