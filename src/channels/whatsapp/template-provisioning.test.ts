import assert from 'node:assert/strict';
import test from 'node:test';
import { WHATSAPP_REMINDER_LANGUAGES, canonicalAppointmentReminder, APPOINTMENT_REMINDER_BODIES } from './appointment-reminder-templates';
import { provisionWhatsAppTemplates, queueWhatsAppTemplateProvisioning, type WhatsAppTemplateProvisioningState } from './template-provisioning';
import { createWhatsAppApprovalTracker, templateEvents } from './approval-tracking';
import { provisioningTargetKey, type CreationIntent, type ProvisioningLease, type ProvisioningStore,
  type ProvisioningTarget } from '../provisioning/orchestration';
import { SupabaseProvisioningStore } from '../provisioning/supabase-store';
import { validMetaWebhookSignature } from '../connections/meta-webhook-security';
import { createHmac } from 'node:crypto';
import { completeWhatsApp, completeManualWhatsApp } from '../connections/providers';

class TestStore implements ProvisioningStore<WhatsAppTemplateProvisioningState> {
  states = new Map<string, WhatsAppTemplateProvisioningState>();
  intents = new Map<string, CreationIntent>();
  leases = new Map<string, ProvisioningLease>();
  allowRenew = true; fence = 0;
  async acquire(resourceKey: string, owner: string) {
    if (this.leases.has(resourceKey)) return null;
    const lease = { resource_key: resourceKey, owner, fence: String(++this.fence) }; this.leases.set(resourceKey, lease); return lease;
  }
  private guard(lease: ProvisioningLease) { assert.deepEqual(this.leases.get(lease.resource_key), lease); }
  async renew(lease: ProvisioningLease) { this.guard(lease); return this.allowRenew; }
  async release(lease: ProvisioningLease) { this.guard(lease); this.leases.delete(lease.resource_key); }
  async load(target: ProvisioningTarget) { return structuredClone(this.states.get(provisioningTargetKey(target)) || null); }
  async enqueue(target: ProvisioningTarget, state: WhatsAppTemplateProvisioningState) {
    const previous = await this.load(target);
    this.states.set(provisioningTargetKey(target), structuredClone({ ...state, templates: previous?.templates || state.templates }));
  }
  async save(target: ProvisioningTarget, state: WhatsAppTemplateProvisioningState, lease: ProvisioningLease) {
    this.guard(lease); assert.equal(lease.resource_key, `${target.provider}:${target.asset_id}`);
    const prior = this.states.get(provisioningTargetKey(target));
    if (prior && prior.target.authorizing_user_id !== target.authorizing_user_id) throw new Error('provisioning_snapshot_superseded');
    this.states.set(provisioningTargetKey(target), structuredClone(state));
  }
  async targetsDue(_provider: string, now: number, limit: number) {
    return [...this.states.values()].filter(s => s.next_check_at <= now).slice(0, limit).map(s => s.target);
  }
  async targetsForAsset(_provider: string, assetId: string) { return [...this.states.values()].filter(s => s.target.asset_id === assetId).map(s => s.target); }
  async intent(key: string) { return structuredClone(this.intents.get(key) || null); }
  async claim(key: string, lease: ProvisioningLease, now: number) {
    this.guard(lease);
    const prior = this.intents.get(key);
    if (prior && !(prior.state === 'retryable' && prior.retry_at != null && prior.retry_at <= now)) return { claimed: false, intent: prior };
    const intent: CreationIntent = { key, state: 'reserved', code: 'template_creation_unconfirmed', asset_id: null, retry_at: null, provider_code: null };
    this.intents.set(key, intent); return { claimed: true, intent };
  }
  async settle(intent: CreationIntent, lease: ProvisioningLease) { this.guard(lease); this.intents.set(intent.key, intent); }
}
function fixture() {
  const token = 'synthetic-provisioning-token';
  const authorization = { businessId: 3, authorizingUserId: 'owner', appId: '100', accessToken: token, expectedPortfolioId: '300' };
  const assets = WHATSAPP_REMINDER_LANGUAGES.map((language, index) => ({ ...canonicalAppointmentReminder(language), id: String(6000 + index), status: 'APPROVED' }));
  const store = new TestStore();
  const model = { assets: assets as any[], otherAssets: structuredClone(assets) as any[], membership: true, manage: true, payment: false, inventoryReadable: true,
    now: Date.UTC(2026, 9, 6), createdStatus: 'PENDING', responseStatus: 'PENDING', visible: true, fail: null as null | 'permission' | 'rate' | 'transient' | 'timeout',
    acceptBeforeTimeout: false, idMismatch: false };
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const fetchImpl: typeof fetch = async (address, init) => {
    const url = new URL(String(address)), path = url.pathname.replace(/^\/v\d+\.\d+\//u, ''), method = init?.method || 'GET';
    assert.equal(url.origin, 'https://graph.facebook.com');
    calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === 'oauth/access_token') return json({ access_token: token });
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    if (method === 'POST') {
      assert.equal(path, '200/message_templates');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, canonicalAppointmentReminder(body.language));
      if (model.fail === 'permission') return json({ error: { code: 200, message: token } }, 403);
      if (model.fail === 'rate') return json({ error: { code: 4, message: token } }, 429);
      if (model.fail === 'transient') return json({ error: { code: 2, is_transient: true, message: token } }, 503);
      if (model.fail === 'timeout' && !model.acceptBeforeTimeout) throw new Error(token);
      const id = String(7000 + WHATSAPP_REMINDER_LANGUAGES.indexOf(body.language));
      if (model.visible) model.assets.push({ ...body, id, status: model.createdStatus });
      if (model.fail === 'timeout') throw new Error(token);
      return json({ id: model.idMismatch ? '99999' : id, status: model.responseStatus, category: 'UTILITY' });
    }
    assert.equal(method, 'GET');
    const wabaState = model.payment ? 'BLOCKED' : 'AVAILABLE';
    const replies: Record<string, unknown> = {
      debug_token: { data: { is_valid: true, app_id: '100', user_id: '400', scopes: ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['200', '201'] }, { scope: 'whatsapp_business_messaging', target_ids: ['200', '201'] }] } },
      '200': { id: '200', name: 'Selected account', owner_business_info: { id: '300', name: 'Owner' }, business_verification_status: 'verified' },
      '500': { id: '500', status: 'CONNECTED', platform_type: 'CLOUD_API', account_mode: 'LIVE', quality_rating: 'GREEN', name_status: 'APPROVED',
        health_status: { can_send_message: wabaState, entities: [{ entity_type: 'WABA', id: '200', can_send_message: wabaState,
          errors: model.payment ? [{ error_code: 141006 }] : [] }] } },
      '200/phone_numbers': { data: model.membership ? [{ id: '500' }] : [] },
      '200/assigned_users': { data: model.manage ? [{ id: '400', tasks: ['MANAGE'] }] : [] },
      '200/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '100' } }] },
      '200/message_templates': { data: model.assets },
      '201/message_templates': { data: model.otherAssets },
    };
    assert.ok(path in replies, `Unexpected provider path: ${path}`);
    if (path === '200/message_templates') {
      assert.equal(url.searchParams.get('name'), 'appointment_reminder');
      if (!model.inventoryReadable) return json({ error: { code: 10, message: token } }, 403);
    }
    return json(replies[path]);
  };
  const input = { authorization, wabaId: '200', phoneNumberId: '500', fetchImpl, now: () => model.now };
  const run = (changes = {}) => provisionWhatsAppTemplates({ ...input, ...changes }, store);
  const tracker = createWhatsAppApprovalTracker({ store, resolveAuthorization: async () => authorization, fetchImpl, now: input.now });
  return { model, store, input, run, tracker, calls, posts: () => calls.filter(c => c.method === 'POST'), token };
}
const en = (state: WhatsAppTemplateProvisioningState) => state.templates.find(t => t.language_code === 'en')!;

test('A: six approved canonical assets generate 12 deterministic mappings without any creation or publishing', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(f.posts().length, 0); assert.equal(result.mappings.length, 12); assert.equal(result.mapping_ready, true);
  assert.equal(result.mappings_persisted, false); assert.equal(result.readiness.ready, true);
  assert.ok(result.templates.every(t => t.code === 'template_already_ready'));
  assert.deepEqual(result.mappings[0].body_parameters, ['customer_name', 'service', 'date', 'time', 'business_name']);
  assert.deepEqual((await f.run()).mappings, result.mappings);
});
test('B: one missing language produces exactly one create and stays pending', async () => {
  const f = fixture(); f.model.assets.shift(); const result = await f.run();
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.language, 'en');
  assert.equal(en(result).code, 'template_created_pending'); assert.equal(en(result).status, 'PENDING');
  assert.equal(result.mapping_ready, false); assert.equal(result.readiness.reminder_ready, false);
  await f.run(); assert.equal(f.posts().length, 1);
});
test('C: all six missing produces six deterministic creation attempts, never duplicates on repeated calls', async () => {
  const f = fixture(); f.model.assets = []; await f.run(); await f.run();
  assert.deepEqual(f.posts().map(c => c.body.language), [...WHATSAPP_REMINDER_LANGUAGES]);
  assert.equal(f.store.intents.size, 6);
});
test('D: incompatible category, components, placeholder semantics or wording never get overwritten', async () => {
  for (const mutate of [
    (asset: any) => { asset.category = 'MARKETING'; },
    (asset: any) => { asset.parameter_format = 'NAMED'; },
    (asset: any) => { asset.components.push({ type: 'FOOTER', text: 'Static footer' }); },
    (asset: any) => { asset.components[0].text = '{{1}} {{2}} {{3}} {{4}} {{6}}'; },
    (asset: any) => { asset.components[0].text = 'Tomorrow: {{1}} {{2}} {{3}} {{4}} {{5}}'; },
  ]) {
    const f = fixture(); mutate(f.model.assets[0]); const result = await f.run();
    assert.equal(en(result).code, 'template_incompatible_existing'); assert.equal(f.posts().length, 0);
    assert.equal(result.readiness.reminder_ready, false); assert.equal(result.mappings.length, 0);
  }
});
test('E: creation response claiming APPROVED cannot override a pending or invisible selected-WABA inventory', async () => {
  const f = fixture(); f.model.assets.shift(); f.model.responseStatus = 'APPROVED';
  assert.equal((await f.run()).readiness.reminder_ready, false);
  const invisible = fixture(); invisible.model.assets.shift(); invisible.model.visible = false;
  assert.equal(en(await invisible.run()).code, 'template_creation_unconfirmed');
  await invisible.run(); assert.equal(invisible.posts().length, 1);
});
test('F: PENDING to APPROVED yields mappings only after selected-WABA reconciliation', async () => {
  const f = fixture(); f.model.assets[0].status = 'PENDING'; assert.equal((await f.run()).mappings.length, 0);
  f.model.assets[0].status = 'APPROVED'; const ready = await f.run();
  assert.equal(ready.mappings.length, 12); assert.equal(ready.readiness.reminder_ready, true); assert.equal(f.posts().length, 0);
});
test('G: PENDING to REJECTED is a blocked conflict with no mutation', async () => {
  const f = fixture(); f.model.assets[0].status = 'PENDING'; await f.run(); f.model.assets[0].status = 'REJECTED';
  const result = await f.run(); assert.equal(en(result).code, 'template_rejected'); assert.equal(result.mappings.length, 0); assert.equal(f.posts().length, 0);
});
test('H: permission failure is safe and cannot create a partial false-ready bundle', async () => {
  const f = fixture(); f.model.assets = []; f.model.fail = 'permission'; const result = await f.run();
  assert.equal(en(result).code, 'template_creation_permission_denied'); assert.equal(result.mapping_ready, false);
  assert.equal(f.posts().length, 1); assert.doesNotMatch(JSON.stringify(result), new RegExp(f.token));
  await f.run(); assert.equal(f.posts().length, 1);
});
test('I: definitive rate rejection respects cooldown and fresh reads; uncertain 5xx/timeouts never blindly resubmit', async () => {
  const rate = fixture(); rate.model.assets.shift(); rate.model.fail = 'rate';
  assert.equal(en(await rate.run()).code, 'template_creation_rate_limited'); await rate.run(); assert.equal(rate.posts().length, 1);
  rate.model.now += 61_000; rate.model.fail = null; await rate.run(); assert.equal(rate.posts().length, 2); assert.equal(rate.model.assets.length, 6);
  for (const failure of ['transient', 'timeout'] as const) {
    const f = fixture(); f.model.assets.shift(); f.model.fail = failure;
    const result = await f.run(); assert.equal(en(result).code, 'template_meta_error');
    f.model.now += 600_000; f.model.fail = null; await f.run(); assert.equal(f.posts().length, 1);
  }
  const accepted = fixture(); accepted.model.assets.shift(); accepted.model.fail = 'timeout'; accepted.model.acceptBeforeTimeout = true;
  await accepted.run(); await accepted.run(); assert.equal(accepted.posts().length, 1); assert.equal(accepted.model.assets.length, 6);
});
test('J: billing blocks delivery independently from approved reminder assets and management provisioning', async () => {
  const f = fixture(); f.model.payment = true; const result = await f.run();
  assert.equal(result.readiness.reminder_ready, true); assert.equal(result.readiness.delivery_ready, false);
  assert.equal(result.readiness.provisioning_ready, true); assert.equal(result.mappings.length, 12);
  assert.ok(result.reasons.some(r => r.code === 'billing_payment_blocked'));
});
test('K: templates outside selected WABA are never queried or borrowed', async () => {
  const f = fixture(); f.model.assets = []; const result = await f.run();
  assert.equal(f.model.otherAssets.length, 6); assert.ok(f.calls.every(c => !c.path.startsWith('201')));
  assert.equal(result.readiness.reminder_ready, false); assert.equal(f.posts().length, 6);
  assert.ok(result.templates.every(t => f.model.assets.some(asset => asset.id === t.template_id)));
});
test('L: duplicate selected-WABA assets fail closed, including identical duplicates', async () => {
  const f = fixture(); f.model.assets.push({ ...f.model.assets[0], id: '8000' }); const result = await f.run();
  assert.equal(en(result).code, 'template_duplicate_conflict'); assert.equal(f.posts().length, 0); assert.equal(result.mappings.length, 0);
});
test('paused/disabled and creation-ID mismatches cannot become ready', async () => {
  for (const status of ['PAUSED', 'DISABLED']) {
    const f = fixture(); f.model.assets[0].status = status;
    assert.equal(en(await f.run()).code, 'template_paused_disabled'); assert.equal(f.posts().length, 0);
  }
  const f = fixture(); f.model.assets.shift(); f.model.createdStatus = 'APPROVED'; f.model.idMismatch = true;
  assert.equal(en(await f.run()).code, 'template_creation_id_mismatch'); assert.equal((await f.run()).mappings.length, 0);
});
test('unreadable inventory, missing assignment and wrong membership stop all template writes', async () => {
  for (const kind of ['inventory', 'assignment', 'membership']) {
    const f = fixture(); f.model.assets = [];
    if (kind === 'inventory') f.model.inventoryReadable = false;
    if (kind === 'assignment') f.model.manage = false;
    if (kind === 'membership') f.model.membership = false;
    const result = await f.run(); assert.equal(result.mapping_ready, false); assert.equal(f.posts().length, 0);
    assert.equal(result.templates.length, 6);
  }
});
test('concurrent workers serialize by WABA; durable intent survives loss of a worker response', async () => {
  const f = fixture(); f.model.assets = [];
  await Promise.all([f.run(), f.run()]); assert.equal(f.posts().length, 6);
  const crashed = fixture(); crashed.model.assets.shift();
  crashed.store.intents.set('whatsapp:200:appointment_reminder:en', { key: 'whatsapp:200:appointment_reminder:en', state: 'reserved', code: 'template_creation_unconfirmed', asset_id: null, retry_at: null, provider_code: null });
  assert.equal(en(await crashed.run()).code, 'template_creation_unconfirmed'); assert.equal(crashed.posts().length, 0);
  const lost = fixture(); lost.model.assets = []; lost.store.allowRenew = false;
  assert.equal((await lost.run()).code, 'provisioning_lease_lost'); assert.equal(lost.posts().length, 0);
});
test('signed status/category/quality events invalidate candidates and trigger authoritative read reconciliation', async () => {
  const f = fixture(); await f.run();
  const payload = { object: 'whatsapp_business_account', entry: [{ id: '200', time: f.model.now / 1000, changes: [
    { field: 'message_template_status_update', value: { message_template_id: '6000', message_template_language: 'en', event: 'APPROVED' } },
    { field: 'template_category_update', value: { message_template_id: '6000', new_category: 'MARKETING' } },
    { field: 'message_template_quality_update', value: { message_template_id: '6000', new_quality_score: 'RED' } },
  ] }] };
  const raw = Buffer.from(JSON.stringify(payload)), secret = 'synthetic-webhook-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(validMetaWebhookSignature(raw, signature, secret), true);
  assert.equal(validMetaWebhookSignature(Buffer.from('{}'), signature, secret), false);
  await f.tracker.handleVerifiedWebhook(payload);
  const dirty = [...f.store.states.values()][0]; assert.equal(dirty.mapping_ready, false);
  assert.equal(en(dirty).last_provider_event_at, new Date(f.model.now).toISOString());
  const reconciled = await f.tracker.reconcileDue(); assert.equal(reconciled[0]?.mapping_ready, true);
  // Event hints did not change category; only the provider read can do that.
  f.model.assets[0].category = 'MARKETING'; f.model.now += 900_001;
  assert.equal((await f.tracker.reconcileDue())[0]?.mapping_ready, false);
});
test('unknown WABA/template, stale events and unrelated webhook objects never affect a tenant', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(templateEvents({ object: 'page', entry: [] }), []);
  for (const [waba, asset] of [['999', '6000'], ['200', '999']]) {
    await f.tracker.handleVerifiedWebhook({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'message_template_status_update', value: { message_template_id: asset } }] }] });
    assert.equal([...f.store.states.values()][0].mapping_ready, true);
  }
  const state = [...f.store.states.values()][0]; en(state).last_provider_event_at = new Date(f.model.now).toISOString();
  await f.tracker.handleVerifiedWebhook({ object: 'whatsapp_business_account', entry: [{ id: '200', time: f.model.now / 1000 - 60,
    changes: [{ field: 'message_template_status_update', value: { message_template_id: '6000', event: 'REJECTED' } }] }] });
  assert.equal([...f.store.states.values()][0].mapping_ready, true);
});
test('revoked assignment or disconnected tenant binding invalidates prior approval tracking without provider writes', async () => {
  const f = fixture(); const initial = await f.run(); f.model.manage = false;
  await f.run(); assert.equal((await f.store.load(initial.target))?.mapping_ready, false);
  const other = fixture(); const ready = await other.run();
  const tracker = createWhatsAppApprovalTracker({ store: other.store, resolveAuthorization: async () => null, fetchImpl: other.input.fetchImpl });
  assert.equal((await tracker.reconcileTarget(ready.target))?.code, 'provisioning_connection_changed'); assert.equal(other.posts().length, 0);
});
test('embedded and manual connections queue no template writes; background reconciliation resumes with tenant authorization', async () => {
  const originalFetch = globalThis.fetch, originalApp = process.env.META_APP_ID, originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_ID = '100'; process.env.META_APP_SECRET = 'synthetic-app-secret';
  try {
    for (const manual of [false, true]) {
      const f = fixture(); f.model.assets = []; globalThis.fetch = f.input.fetchImpl;
      const common = { authorization: { businessId: 3, authorizingUserId: 'owner' }, wabaId: '200', phoneNumberId: '500' };
      const result = manual ? await completeManualWhatsApp({ ...common, accessToken: f.token }) :
        await completeWhatsApp({ ...common, code: 'synthetic-code', redirectUri: 'https://example.test/callback' });
      const queued = await queueWhatsAppTemplateProvisioning({ ...f.input, now: Date.now }, result.preflight!, f.store);
      assert.equal(queued.code, 'provisioning_queued'); assert.equal(f.posts().length, 0); assert.equal(queued.mapping_ready, false);
      const reconciled = await f.tracker.reconcileTarget(queued.target); assert.equal(f.posts().length, 6); assert.equal(reconciled?.mapping_ready, false);
      assert.equal(result.metadata.authorizing_odinlink_user_id, 'owner');
      assert.doesNotMatch(JSON.stringify(queued), new RegExp(f.token));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApp == null) delete process.env.META_APP_ID; else process.env.META_APP_ID = originalApp;
    if (originalSecret == null) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = originalSecret;
  }
});
test('durable RPC adapter passes tenant/lease scope and suppresses database errors', async () => {
  const calls: any[] = [];
  const store = new SupabaseProvisioningStore<any>({ rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: null, error: null }; } } as any);
  const f = fixture(); const target = (await f.run()).target; await store.load(target);
  assert.equal(calls[0].name, 'channel_provisioning_store'); assert.equal(calls[0].args.p_payload.target.business_id, 3);
  const broken = new SupabaseProvisioningStore<any>({ rpc: async () => ({ error: { message: 'synthetic-private-database-error' } }) } as any);
  await assert.rejects(() => broken.load(target), { message: 'provisioning_storage_unavailable' });
  for (const [language, text] of Object.entries(APPOINTMENT_REMINDER_BODIES)) {
    const keys = [...text.matchAll(/\{\{(\d+)\}\}/gu)].map(m => m[1]); assert.deepEqual([...new Set(keys)].sort(), ['1', '2', '3', '4', '5'], language);
  }
});
test('onboarding queues durably while another worker holds the WABA lease, without creation or cross-tenant state', async () => {
  const f = fixture(), ready = await f.run();
  const lease = await f.store.acquire('whatsapp:200', 'other-worker'); assert.ok(lease);
  const queued = await queueWhatsAppTemplateProvisioning({ ...f.input, authorization: { ...f.input.authorization, businessId: 4 } },
    { ...ready.readiness, business_id: 4 }, f.store);
  assert.equal(queued.code, 'provisioning_queued'); assert.equal(f.store.states.size, 2);
  assert.equal((await f.store.load(ready.target))?.mapping_ready, true); assert.equal(f.posts().length, 0);
  await f.store.release(lease);
});
test('changed tenant authorization during a batch stops remaining creates and mapping readiness', async () => {
  const f = fixture(); f.model.assets = [];
  const result = await f.run({ confirmAuthorization: async () => f.posts().length === 0 });
  assert.equal(f.posts().length, 1); assert.equal(result.code, 'provisioning_connection_changed');
  assert.equal(result.readiness.provisioning_ready, false); assert.equal(result.mapping_ready, false);
});
