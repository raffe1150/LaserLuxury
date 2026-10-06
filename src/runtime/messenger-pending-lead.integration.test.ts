import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { PendingLeadStore, type LeadRow } from '../../tests/helpers/pending-lead-store';
import { CURRENT_BOOKING_STATE_VERSION } from '../ai/booking-operation-state';
import { encryptCredential } from '../channels/connections/credential-crypto';

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'synthetic-gemini-key';
process.env.AI_PROVIDER = 'gemini';
process.env.PENDING_BOOKING_TTL_MINUTES = '45';
process.env.ODINLINK_LOCAL_TEST_MODE = 'false';
process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SUPABASE_URL = 'https://analytics.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_synthetic_test_key';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://analytics.invalid', 'no live transport is allowed');
  assert.equal(url.pathname, '/rest/v1/analytics_events');
  assert.equal(init?.method, 'POST');
  const [event] = JSON.parse(String(init?.body));
  assert.equal(String(event.business_id), '3');
  return new Response(null, { status: 201 });
};
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = Date.parse('2026-10-06T20:16:28.912Z');
mock.timers.enable({ apis: ['Date'], now });
const config = { id: '3', businessRecordId: '3', business_id: '3', calendarProvider: 'custom',
  timezone: 'Europe/Stockholm', defaultBookingService: 'Consultation' };
const session = 'ms_3:customer-a';
const pending = (patch: any = {}) => ({
  type: 'pending_booking', business_id: '3', platform: 'messenger', userId: '3:customer-a',
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking',
  status: 'awaiting_date_or_time', expectedInput: 'date_or_constraint', service: 'Consultation',
  language: 'en', createdAt: now - 1000, updatedAt: now - 1000, ...patch,
});
const lead = (id: number, state: any = pending(), patch: Partial<LeadRow> = {}): LeadRow => ({
  id, user_id: session, platform: 'messenger', business_id: null,
  ai_summary: state === null ? null : JSON.stringify(state), ...patch,
});
let store: PendingLeadStore;
let errors: any[][];
const originalError = console.error;
beforeEach(() => {
  boundary.reset();
  mock.timers.setTime(now);
  store = new PendingLeadStore();
  errors = [];
  console.error = (...args) => { errors.push(args); };
  boundary.configure({ supabaseClient: store });
});
after(() => { boundary.reset(); console.error = originalError; globalThis.fetch = originalFetch; mock.timers.reset(); });
const restore = () => boundary.stateAuditRestore(session, 'messenger', config);
const writes = () => store.requests.filter(r => r.method !== 'GET');

test('production-shaped legacy rows: 129 empty shells plus 13 expired pending payloads are absence without writes', async () => {
  store.rows = [
    ...Array.from({ length: 129 }, (_, i) => lead(i + 1, null)),
    ...Array.from({ length: 13 }, (_, i) => lead(i + 130, pending({
      status: i < 2 ? 'awaiting_time_selection' : 'awaiting_service',
      service: i < 2 ? 'Video Consultation' : 'Bokning',
      selectedDate: i < 2 ? '2026-10-13' : null,
      customerName: i < 2 ? 'Test Customer' : null,
      createdAt: now - 2 * 24 * 60 * 60_000, updatedAt: now - 2 * 24 * 60 * 60_000,
    }))),
  ];
  const before = structuredClone(store.rows);
  assert.equal(await restore(), null);
  assert.deepEqual(store.rows, before);
  assert.equal(writes().length, 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('ordinary Messenger message with no pending booking returns to conversation handling without a booking side effect', async () => {
  const result = await boundary.turn({ sessionId: session, platformName: 'messenger',
    recipientUserId: 'customer-a', text: 'Hi, are you available?', businessConfig: config });
  assert.equal(result.handled, false);
  assert.equal(result.pending, null);
  assert.equal(writes().length, 0);
});

test('empty legacy shells and unrelated internal/idempotency rows cannot supply pending state', async () => {
  store.rows = [lead(1, null), lead(2, null),
    lead(3, { type: 'inbound_message_claim' }),
    lead(4, { type: 'inbound_message_claim' }, { platform: 'idempotency:messenger' }),
    lead(5, pending(), { platform: 'operation:messenger' })];
  const before = structuredClone(store.rows);
  assert.equal(await restore(), null);
  assert.deepEqual(store.rows, before);
  assert.equal(writes().length, 0);
});

test('one active exact-owner lead survives expired legacy payloads with service/date/contact state intact', async () => {
  store.rows = [lead(1, pending({ createdAt: now - 46 * 60_000 })),
    lead(2, pending({ selectedDate: '2026-10-13', customerName: 'Test Customer', customerPhone: '0701234567' }))];
  const before = structuredClone(store.rows);
  const result = await restore();
  assert.equal(result?.service, 'Consultation');
  assert.equal(result?.selectedDate, '2026-10-13');
  assert.equal(result?.customerName, 'Test Customer');
  assert.equal(result?.customerPhone, '0701234567');
  assert.deepEqual(store.rows, before);
  assert.equal(writes().length, 0);
});

for (const [name, patch, state] of [
  ['business', { business_id: '4' }, pending({ business_id: '4' })],
  ['channel', { platform: 'instagram' }, pending({ platform: 'instagram' })],
  ['customer', { user_id: 'ms_3:customer-b' }, pending({ userId: '3:customer-b' })],
  ['legacy embedded business', { business_id: null }, pending({ business_id: '4' })],
] as const) {
  test(`wrong ${name} is ignored without modifying it`, async () => {
    store.rows = [lead(1, state, patch)];
    const before = structuredClone(store.rows);
    assert.equal(await restore(), null);
    assert.deepEqual(store.rows, before);
    assert.equal(writes().length, 0);
  });
}

test('two genuinely active matching Messenger leads still fail closed on restore and save', async () => {
  store.rows = [lead(1), lead(2)];
  const before = structuredClone(store.rows);
  await assert.rejects(restore, /ambiguous_pending_lead/);
  await assert.rejects(() => boundary.stateAuditPersist(session, 'messenger', {
    ...pending(), businessConfig: config, businessId: '3',
  }), /ambiguous_pending_lead/);
  assert.deepEqual(store.rows, before);
  assert.equal(writes().length, 0);
});

for (const createdAt of [undefined, null, 0, -1, true, [1], {}, 'invalid', 'Infinity', now + 1, now - 45 * 60_000]) {
  test(`unproven/equality expiry ${createdAt} cannot bypass ambiguity`, async () => {
    store.rows = [lead(1, pending({ createdAt })), lead(2, pending({ createdAt }))];
    await assert.rejects(restore, /ambiguous_pending_lead/);
    assert.equal(writes().length, 0);
  });
}

test('active Messenger booking continues through the real durable lookup alongside expired legacy state', async () => {
  const continuityConfig = { ...config, defaultBookingService: 'Video Consultation',
    services: [{ name: 'Video Consultation', duration: 30 }] };
  store.rows = [lead(1, pending({ createdAt: now - 46 * 60_000 })), lead(2, pending({
    service: 'Video Consultation', selectedDate: '2026-10-13', requestedTime: '16:00',
    customerName: 'Test Customer', customerPhone: '0701234567',
  }))];
  const expired = structuredClone(store.rows[0]);
  boundary.configure({ supabaseClient: store, postProcess: async () => undefined,
    calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }),
      insertAppointment: async () => { assert.fail('partial continuation must not book'); } } });
  const result = await boundary.turn({ sessionId: session, platformName: 'messenger',
    recipientUserId: 'customer-a', text: 'At 17:00 instead.', businessConfig: continuityConfig,
    now: new Date(now) });
  assert.equal(result.handled, true);
  assert.equal(result.pending?.selectedDate, '2026-10-13');
  assert.equal(result.pending?.requestedTime, '17:00');
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.customerName, 'Test Customer');
  assert.equal(result.pending?.customerPhone, '0701234567');
  assert.deepEqual(store.rows[0], expired);
  assert.equal(store.rows.length, 2);
  assert.ok(writes().length > 0);
  assert.ok(writes().every(request => request.method === 'PATCH' && request.url.searchParams.get('id') === 'eq.2'));
});

test('expired legacy pending payload still must prove tenant and customer ownership', async () => {
  for (const patch of [{ business_id: undefined }, { userId: '3:customer-b' }, { platform: 'instagram' }]) {
    store.rows = [lead(1, pending({ createdAt: now - 46 * 60_000, ...patch }))];
    await assert.rejects(restore, /pending_lead_scope_unverifiable|pending_lead_owner_mismatch/);
  }
  assert.equal(writes().length, 0);
});

test('explicitly scoped Messenger rows keep the existing stale-duplicate integrity rule', async () => {
  store.rows = [lead(1, pending({ createdAt: now - 46 * 60_000 }), { business_id: '3' }),
    lead(2, pending(), { business_id: '3' })];
  await assert.rejects(restore, /ambiguous_pending_lead/);
  assert.equal(writes().length, 0);
});

for (const platform of ['whatsapp', 'telegram', 'instagram']) {
  test(`${platform} duplicate expiry semantics remain unchanged`, async () => {
    const otherSession = platform === 'telegram' ? 'tg:3:synthetic-bot:customer-a' : `${platform === 'whatsapp' ? 'wa' : 'ig'}_3:customer-a`;
    const userId = platform === 'telegram' ? 'customer-a' : '3:customer-a';
    store.rows = [1, 2].map(id => lead(id, pending({ platform, userId, createdAt: now - 46 * 60_000 }), { platform, user_id: otherSession }));
    await assert.rejects(() => boundary.stateAuditRestore(otherSession, platform, config), /ambiguous_pending_lead/);
    assert.equal(writes().length, 0);
  });
}

// Run the actual claimed Messenger handler, Page connection resolution, sender,
// and postProcessMessage. Only provider/storage/AI transport is intercepted.
async function runMessengerInbound(rows: LeadRow[], timestamp: number = now - 1234) {
  const history: any[] = [];
  const replies: any[] = [];
  let generated = 0;
  const connection = {
    id: 'connection-3', business_id: 3, provider: 'messenger', provider_account_id: 'page-3',
    status: 'connected', reconnect_required: false, connected_at: '2026-09-24T00:00:00Z',
    granted_scopes: ['pages_messaging'],
    credential_ciphertext: encryptCredential({ accessToken: 'synthetic-page-token', tokenType: 'page' }),
  };
  store = new PendingLeadStore(async (url, init) => {
    const method = init?.method || 'GET';
    let data: any[] = [];
    if (url.pathname === '/rest/v1/channel_connections') {
      assert.equal(method, 'GET');
      assert.equal(url.searchParams.get('provider'), 'eq.messenger');
      assert.equal(url.searchParams.get('provider_account_id'), 'eq.page-3');
      assert.equal(url.searchParams.get('status'), 'eq.connected');
      assert.equal(url.searchParams.get('reconnect_required'), 'eq.false');
      data = [connection];
    } else if (url.pathname === '/rest/v1/businesses') {
      assert.equal(method, 'GET');
      assert.equal(url.searchParams.get('id'), 'eq.3');
      data = [{ id: 3, business_name: 'Test Studio', timezone: config.timezone,
        language: 'en', default_booking_service: 'Consultation', services: [], working_hours: {} }];
    } else if (url.pathname === '/rest/v1/chat_history') {
      if (method === 'POST') {
        data = JSON.parse(String(init?.body));
        history.push(...data);
      } else assert.equal(method, 'GET');
    } else {
      assert.equal(method, 'GET', `unexpected write: ${url.pathname}`);
      assert.ok(['/rest/v1/calendar_connections', '/rest/v1/appointments'].includes(url.pathname), url.pathname);
    }
    return new Response(JSON.stringify(data), { status: method === 'POST' ? 201 : 200,
      headers: { 'Content-Type': 'application/json' } });
  });
  store.rows = structuredClone(rows);
  const before = structuredClone(store.rows);
  boundary.configure({ supabaseClient: store,
    geminiGenerate: async () => { generated++; return { text: 'Hi! How can I help you?' }; },
    semanticLanguageResolver: async () => ({ language: 'en', requestedReplyLanguage: null, confidence: 1 }),
    knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    incrementUsage: async params => {
      assert.equal(String(params.businessId), '3');
      assert.equal(params.platform, 'messenger');
      assert.equal(params.userId, session);
      return { allowed: true, count: 1, limit: 100 };
    },
    calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }),
      insertAppointment: async () => { assert.fail('ordinary text must not book'); } },
    recordAppointment: async () => { assert.fail('ordinary text must not persist appointments'); },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://analytics.invalid') return originalFetch(input, init);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname, '/v25.0/me/messages');
    assert.equal(url.searchParams.get('access_token'), 'synthetic-page-token');
    assert.equal(init?.method, 'POST');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.recipient.id, 'customer-a');
    assert.equal(payload.messaging_type, 'RESPONSE');
    replies.push(payload);
    return new Response(JSON.stringify({ recipient_id: 'customer-a', message_id: 'mid.reply' }), { status: 200 });
  };
  try {
    await boundary.messengerInbound({ sender: { id: 'customer-a' }, recipient: { id: 'page-3' },
      timestamp, message: { mid: 'mid.fresh-inbound', text: 'Hi, are you available?' } }, config);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(store.rows.filter(row => row.platform === 'messenger'), before,
    'ordinary inbound must not modify booking lead rows');
  for (const request of writes()) {
    assert.equal(request.method === 'POST' ? request.body[0].platform : request.url.searchParams.get('platform'),
      request.method === 'POST' ? 'idempotency:messenger' : 'eq.idempotency:messenger');
  }
  assert.equal(store.rows.filter(row => row.platform === 'idempotency:messenger').length, 1);
  return { history, replies, generated };
}

for (const [scenario, rows] of [
  ['no pending rows', []],
  ['only empty legacy shells', [lead(1, null), lead(2, null)]],
  ['empty shells and expired legacy payloads', [lead(1, null), lead(2, null),
    lead(3, pending({ createdAt: now - 46 * 60_000 })),
    lead(4, pending({ createdAt: now - 2 * 24 * 60 * 60_000 }))]],
] as const) {
test(`fresh Messenger inbound (${scenario}) replies and persists exact provider time/tenant/channel/customer through the real handler`, async () => {
  const timestamp = now - 1234;
  const { history, replies, generated } = await runMessengerInbound([...rows], timestamp);
  assert.equal(generated, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0].message.text, /How can I help/);
  assert.equal(history.length, 2);
  for (const row of history) {
    assert.equal(String(row.business_id), '3');
    assert.equal(row.platform, 'messenger');
    assert.equal(row.user_id, 'customer-a');
  }
  assert.equal(history[0].sender, 'user');
  assert.equal(history[0].message, 'Hi, are you available?');
  assert.equal(history[0].provider_event_at, new Date(timestamp).toISOString());
  assert.notEqual(history[0].provider_event_at, new Date(now).toISOString());
  assert.equal(history[1].sender, 'bot');
  assert.equal(history[1].provider_event_at, undefined);
  assert.equal(await restore(), null);
  assert.equal(errors.length, 0, JSON.stringify(errors));
});
}

test('two active Messenger leads stop the real inbound handler before generation/reply/persistence', async () => {
  const { history, replies, generated } = await runMessengerInbound([lead(1), lead(2)]);
  assert.equal(generated, 0);
  assert.deepEqual(replies, []);
  assert.deepEqual(history, []);
  assert.ok(errors.some(args => args[1]?.category === 'ambiguous_pending_lead'));
});

test('WhatsApp legacy empty shells still restore absence without writes', async () => {
  store.rows = [1, 2].map(id => lead(id, null, { platform: 'whatsapp', user_id: 'wa_3:46701234567' }));
  assert.equal(await boundary.stateAuditRestore('wa_3:46701234567', 'whatsapp', config), null);
  assert.equal(writes().length, 0);
});
