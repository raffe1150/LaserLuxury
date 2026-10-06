import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWhatsAppProvisioning, WHATSAPP_REMINDER_LANGUAGES } from './whatsapp-provisioning-preflight';
import { completeWhatsApp, completeManualWhatsApp, WhatsAppPreflightError } from './providers';

const wabaId = '1349279940681149';
const otherWabaId = '2039179683638711';
const phoneId = '1176858338851675';
const portfolioId = '813717704763648';
const subjectId = '122138897973387476';
const appId = '26871846599183572';
const token = 'synthetic-private-token-never-log';
const authorization = { businessId: 3, authorizingUserId: 'odinlink-owner', appId, accessToken: token, expectedPortfolioId: portfolioId };
const templates = () => WHATSAPP_REMINDER_LANGUAGES.map((language, index) => ({
  id: String(5000 + index), name: 'appointment_reminder', language, status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: language === 'de' ? 'Hallo {{1}}, {{5}}: {{3}} {{4}} {{2}}.' : 'Hi {{1}}, {{5}}: {{2}} {{3}} {{4}}.' }],
}));

function fixture() {
  const model = {
    debug: { data: { is_valid: true, app_id: appId, user_id: subjectId, expires_at: 0, data_access_expires_at: 0,
      scopes: ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'] } } as any,
    waba: { id: wabaId, name: 'Bussiness Sim', owner_business_info: { id: portfolioId, name: 'AdMotion Studio' },
      account_review_status: 'APPROVED', business_verification_status: 'verified' } as any,
    phone: { id: phoneId, display_phone_number: '+46 76 923 58 85', verified_name: 'Bussiness Sim', status: 'CONNECTED',
      platform_type: 'CLOUD_API', account_mode: 'LIVE', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250',
      throughput: { level: 'STANDARD' }, name_status: 'APPROVED', code_verification_status: 'VERIFIED', is_pin_enabled: true,
      health_status: { can_send_message: 'AVAILABLE', entities: [
        { entity_type: 'PHONE_NUMBER', id: phoneId, can_send_message: 'AVAILABLE', errors: [] },
        { entity_type: 'WABA', id: wabaId, can_send_message: 'AVAILABLE', errors: [] },
        { entity_type: 'BUSINESS', id: portfolioId, can_send_message: 'AVAILABLE', errors: [] },
        { entity_type: 'APP', id: appId, can_send_message: 'AVAILABLE', errors: [] },
      ] } } as any,
    phones: { data: [{ id: phoneId }] } as any,
    users: { data: [{ id: subjectId, tasks: ['MANAGE'] }] } as any,
    subscriptions: { data: [{ whatsapp_business_api_data: { id: appId } }] } as any,
    templates: { data: templates() } as any,
    otherTemplates: { data: templates() },
    failures: new Map<string, any>(),
    secondPages: new Map<string, any>(),
  };
  const calls: Array<{ path: string; method: string; after: string | null }> = [];
  const fetchImpl: typeof fetch = async (address, init) => {
    const url = new URL(String(address));
    const path = url.pathname.replace(/^\/v\d+\.\d+\//u, '');
    const method = init?.method || 'GET';
    calls.push({ path, method, after: url.searchParams.get('after') });
    assert.equal(url.origin, 'https://graph.facebook.com');
    // All writes are mocked too; no request in this suite reaches a network.
    if (path === 'oauth/access_token') return json({ access_token: token });
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    if (method !== 'GET') {
      assert.ok([`${phoneId}/register`, `${wabaId}/subscribed_apps`].includes(path));
      return json({ success: true });
    }
    assert.equal(init?.redirect, 'error');
    if (model.failures.has(path)) return json(model.failures.get(path), 403);
    if (url.searchParams.has('after')) return json(model.secondPages.get(path) || { data: [] });
    const bodies: Record<string, any> = {
      debug_token: model.debug, [wabaId]: model.waba, [phoneId]: model.phone,
      [`${wabaId}/phone_numbers`]: model.phones, [`${wabaId}/assigned_users`]: model.users,
      [`${wabaId}/subscribed_apps`]: model.subscriptions, [`${wabaId}/message_templates`]: model.templates,
      [`${otherWabaId}/message_templates`]: model.otherTemplates,
    };
    assert.ok(path in bodies, `Unexpected asset read: ${path}`);
    if (path.endsWith('/assigned_users')) assert.equal(url.searchParams.get('business'), portfolioId);
    if (path.endsWith('/message_templates')) assert.equal(url.searchParams.get('name'), 'appointment_reminder');
    return json(bodies[path]);
  };
  return { model, calls, fetchImpl, inspect: (changes: any = {}) => inspectWhatsAppProvisioning({ authorization, wabaId, phoneNumberId: phoneId, fetchImpl, ...changes }) };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function hasReason(result: Awaited<ReturnType<typeof inspectWhatsAppProvisioning>>, code: string) {
  assert.ok(result.reasons.some(reason => reason.code === code), code);
}
function paymentBlock(model: ReturnType<typeof fixture>['model']) {
  model.phone.health_status.can_send_message = 'BLOCKED';
  model.phone.health_status.entities[1].can_send_message = 'BLOCKED';
  model.phone.health_status.entities[1].errors = [{ error_code: 141006, error_description: 'Payment blocked' }];
}

test('A: live membership does not borrow reminders from the other WABA', async () => {
  const f = fixture(); f.model.templates.data = [{ id: '9000', name: 'hello_world', language: 'en_US' }];
  const result = await f.inspect();
  assert.equal(result.connection_ready, true); assert.equal(result.provisioning_ready, true);
  assert.equal(result.reminder_ready, false); assert.equal(result.ready, false);
  assert.ok(result.templates.every(t => t.state === 'missing'));
  hasReason(result, 'template_missing_for_selected_waba');
  assert.ok(f.calls.every(c => !c.path.includes(otherWabaId) && c.method === 'GET'));
});
test('B: CONNECTED/CLOUD_API/LIVE does not override a payment block', async () => {
  const f = fixture(); paymentBlock(f.model);
  f.model.phone.code_verification_status = 'EXPIRED'; f.model.phone.is_pin_enabled = false;
  const result = await f.inspect();
  assert.equal(result.connection_ready, true); assert.equal(result.delivery_ready, false);
  assert.equal(result.waba.payment_blocked, true);
  assert.ok(result.reasons.some(r => r.code === 'billing_payment_blocked' && r.scope === 'billing' && r.severity === 'blocking'));
  hasReason(result, 'phone_verification_expired');
});
test('C: multiple accessible WABAs never cause automatic account selection', async () => {
  const f = fixture();
  f.model.templates.data = []; f.model.otherTemplates.data = templates();
  const result = await f.inspect();
  assert.equal(result.asset.waba_id, wabaId); assert.equal(result.reminder_ready, false);
  assert.ok(f.calls.every(c => !c.path.includes(otherWabaId)));
});
test('D: granted scopes without selected-WABA assignment cannot authorize provisioning', async () => {
  const f = fixture(); f.model.users.data = [{ id: '99999', tasks: ['MANAGE'] }];
  const result = await f.inspect(); assert.equal(result.provisioning_ready, false);
  assert.equal(result.authorization.management_access_sufficient, false); hasReason(result, 'waba_assignment_missing');
});
test('E: approval with the wrong category is incompatible', async () => {
  const f = fixture(); f.model.templates.data[0].category = 'MARKETING';
  const result = await f.inspect(); assert.equal(result.reminder_ready, false);
  assert.equal(result.templates[0].state, 'incompatible'); hasReason(result, 'template_incompatible');
});
test('F: unsupported component and placeholder contracts are incompatible', async () => {
  for (const components of [
    [{ type: 'BODY', text: '{{1}} {{2}} {{3}} {{4}} {{6}}' }],
    [{ type: 'BODY', text: '{{customer_name}}' }],
    [...templates()[0].components, { type: 'HEADER', format: 'IMAGE' }],
    [...templates()[0].components, { type: 'BUTTONS', buttons: [] }],
  ]) {
    const f = fixture(); f.model.templates.data[0].components = components;
    const result = await f.inspect(); assert.equal(result.reminder_ready, false); hasReason(result, 'template_incompatible');
  }
});
test('G: approved-compatible reminders do not override billing health', async () => {
  const f = fixture(); paymentBlock(f.model); const result = await f.inspect();
  assert.equal(result.reminder_ready, true); assert.equal(result.delivery_ready, false);
  assert.equal(result.provisioning_ready, true); assert.equal(result.ready, false);
});
test('H: fully evidenced healthy selected account is ready in all four dimensions', async () => {
  const f = fixture(); const result = await f.inspect();
  for (const key of ['ready', 'connection_ready', 'provisioning_ready', 'reminder_ready', 'delivery_ready'] as const) assert.equal(result[key], true, key);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.templates.every(t => t.state === 'approved_compatible'));
  assert.equal(result.asset.portfolio_id, portfolioId); assert.deepEqual(result.authorization.waba_tasks, ['MANAGE']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('template review states remain distinct and explicit format is required', async () => {
  for (const [status, state, code] of [
    ['PENDING', 'pending', 'template_pending'], ['REJECTED', 'rejected', 'template_rejected'],
    ['PAUSED', 'paused_disabled', 'template_paused_disabled'], ['DISABLED', 'paused_disabled', 'template_paused_disabled'],
  ]) {
    const f = fixture(); f.model.templates.data[0].status = status;
    const result = await f.inspect(); assert.equal(result.templates[0].state, state); hasReason(result, code);
  }
  const f = fixture(); delete f.model.templates.data[0].parameter_format;
  assert.equal((await f.inspect()).templates[0].state, 'incompatible');
});
test('phone membership, app identity and trusted portfolio must agree', async () => {
  const missing = fixture(); missing.model.phones.data = [{ id: '99999' }];
  const missingResult = await missing.inspect(); assert.equal(missingResult.connection_ready, false); hasReason(missingResult, 'phone_not_in_selected_waba');
  const app = fixture(); app.model.debug.data.app_id = '99999';
  assert.equal((await app.inspect()).connection_ready, false);
  const owner = fixture(); const ownerResult = await owner.inspect({ authorization: { ...authorization, expectedPortfolioId: '99999' } });
  assert.equal(ownerResult.provisioning_ready, false); hasReason(ownerResult, 'portfolio_mismatch');
});
test('invalid or expired authorization and missing grants fail closed', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.model.debug.data.is_valid = false; },
    (f: ReturnType<typeof fixture>) => { f.model.debug.data.expires_at = 1; },
    (f: ReturnType<typeof fixture>) => { f.model.debug.data.scopes = ['whatsapp_business_messaging']; },
  ]) {
    const f = fixture(); mutate(f); const result = await f.inspect();
    assert.equal(result.connection_ready, false); assert.equal(result.provisioning_ready, false); assert.equal(result.delivery_ready, false);
  }
  const f = fixture(); const result = await f.inspect({ authorization: { ...authorization, businessId: 0 } });
  hasReason(result, 'authorization_context_invalid'); assert.equal(f.calls.length, 0);
});
test('granular grants restricted to another WABA cannot authorize the selected account', async () => {
  const f = fixture(); f.model.debug.data.granular_scopes = [{ scope: 'whatsapp_business_management', target_ids: [otherWabaId] }];
  const result = await f.inspect(); assert.equal(result.provisioning_ready, false); hasReason(result, 'authorization_asset_scope_missing');
});
test('unreadable assignments, subscription, templates and health do not imply readiness or leak errors', async () => {
  for (const [path, state, code] of [
    [`${wabaId}/assigned_users`, 'provisioning_ready', 'waba_assignment_unverified'],
    [`${wabaId}/subscribed_apps`, 'delivery_ready', 'app_subscription_unverified'],
    [`${wabaId}/message_templates`, 'reminder_ready', 'template_lookup_unverified'],
    ['debug_token', 'connection_ready', 'authorization_unverified'],
  ] as const) {
    const f = fixture(); f.model.failures.set(path, { error: { message: token, code: 190 } });
    const result = await f.inspect(); assert.equal(result[state], false); hasReason(result, code);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  }
  const f = fixture(); delete f.model.phone.health_status;
  const result = await f.inspect(); assert.equal(result.delivery_ready, false); hasReason(result, 'sending_health_unverified');
});
test('pagination remains bound to the selected account and incomplete inventories fail closed', async () => {
  const f = fixture();
  f.model.phones = { data: [], paging: { next: 'https://evil.example/collect', cursors: { after: 'page-two' } } };
  f.model.secondPages.set(`${wabaId}/phone_numbers`, { data: [{ id: phoneId }] });
  assert.equal((await f.inspect()).connection_ready, true);
  assert.ok(f.calls.some(c => c.path === `${wabaId}/phone_numbers` && c.after === 'page-two'));
  const incomplete = fixture();
  incomplete.model.templates = { data: templates(), paging: { next: 'https://evil.example/collect' } };
  const result = await incomplete.inspect(); assert.equal(result.reminder_ready, false); hasReason(result, 'template_lookup_unverified');
});

test('completion exchanges authorization before preflight, and invalid membership stops all provisioning writes', async () => {
  process.env.META_APP_ID = appId; process.env.META_APP_SECRET = 'synthetic-app-secret';
  const original = globalThis.fetch;
  try {
    const f = fixture(); f.model.phones.data = []; globalThis.fetch = f.fetchImpl;
    await assert.rejects(() => completeWhatsApp({ code: 'synthetic-code', wabaId, phoneNumberId: phoneId, redirectUri: 'https://example.test/callback',
      authorization: { businessId: 3, authorizingUserId: 'odinlink-owner' } }), WhatsAppPreflightError);
    assert.equal(f.calls[0].path, 'oauth/access_token'); assert.ok(f.calls.every(c => c.method === 'GET'));
    const manual = fixture(); manual.model.users.data = []; globalThis.fetch = manual.fetchImpl;
    await assert.rejects(() => completeManualWhatsApp({ wabaId, phoneNumberId: phoneId, accessToken: token,
      authorization: { businessId: 3, authorizingUserId: 'odinlink-owner' } }), WhatsAppPreflightError);
    assert.ok(manual.calls.every(c => c.method === 'GET'));
  } finally { globalThis.fetch = original; }
});
test('connected subscribed completion does not reset PIN or conflate reminder readiness with connection', async () => {
  const original = globalThis.fetch;
  try {
    const f = fixture(); f.model.templates.data = []; paymentBlock(f.model); globalThis.fetch = f.fetchImpl;
    const result = await completeWhatsApp({ code: 'synthetic-code', wabaId, phoneNumberId: phoneId, redirectUri: 'https://example.test/callback',
      authorization: { businessId: 3, authorizingUserId: 'odinlink-owner' } });
    assert.equal(result.preflight?.connection_ready, true); assert.equal(result.preflight?.reminder_ready, false);
    assert.equal(result.preflight?.delivery_ready, false); assert.equal(result.credential.twoStepPin, undefined);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  } finally { globalThis.fetch = original; }
});
test('existing mocked provisioning boundary is reached only after effective assignment verification', async () => {
  const original = globalThis.fetch;
  try {
    const f = fixture(); f.model.phone.status = 'PENDING'; f.model.phone.is_pin_enabled = false; f.model.subscriptions.data = []; globalThis.fetch = f.fetchImpl;
    const result = await completeWhatsApp({ code: 'synthetic-code', wabaId, phoneNumberId: phoneId, redirectUri: 'https://example.test/callback',
      authorization: { businessId: 3, authorizingUserId: 'odinlink-owner' } });
    const lastRead = f.calls.findIndex(c => c.path === `${wabaId}/assigned_users`);
    const firstWrite = f.calls.findIndex(c => c.method === 'POST');
    assert.ok(firstWrite > lastRead); assert.match(result.credential.twoStepPin || '', /^\d{6}$/);
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), [`${phoneId}/register`, `${wabaId}/subscribed_apps`]);
  } finally { globalThis.fetch = original; }
});
test('unverified registration and unknown subscription stop completion before any write', async () => {
  const original = globalThis.fetch;
  try {
    for (const kind of ['verification', 'pin', 'subscription']) {
      const f = fixture();
      if (kind === 'subscription') f.model.failures.set(`${wabaId}/subscribed_apps`, { error: { code: 10 } });
      else {
        f.model.phone.status = 'PENDING';
        if (kind === 'verification') f.model.phone.code_verification_status = 'EXPIRED';
      }
      globalThis.fetch = f.fetchImpl;
      await assert.rejects(() => completeWhatsApp({ code: 'synthetic-code', wabaId, phoneNumberId: phoneId, redirectUri: 'https://example.test/callback',
        authorization: { businessId: 3, authorizingUserId: 'odinlink-owner' } }), WhatsAppPreflightError);
      assert.ok(f.calls.every(c => c.method === 'GET'));
    }
  } finally { globalThis.fetch = original; }
});
