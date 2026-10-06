import assert from 'node:assert/strict';
import test from 'node:test';
import { createWhatsAppMappingBoundary, validateReminderPublication } from './reminder-mapping-publisher';
import { mappingPublicationFixture } from './reminder-mapping-publisher.test-fixture';
import { createWhatsAppProvisioningRuntime } from './provisioning-runtime';

test('publisher rejects partial, cross-tenant, duplicate, invalid and stale bundles before the write RPC', async () => {
  const now = Date.now(), state = mappingPublicationFixture(now);
  assert.equal(validateReminderPublication(state, now), null);
  for (const mutate of [
    (s: typeof state) => { s.templates.pop(); },
    (s: typeof state) => { s.mappings.pop(); },
    (s: typeof state) => { s.templates[0].category = 'MARKETING'; },
    (s: typeof state) => { s.templates[0].status = 'PENDING'; },
    (s: typeof state) => { s.templates[1] = structuredClone(s.templates[0]); },
    (s: typeof state) => { s.mappings[0].business_id = '4'; },
    (s: typeof state) => { s.mappings[0].waba_id = '201'; },
    (s: typeof state) => { s.mappings[0].body_parameters.reverse(); },
    (s: typeof state) => { s.readiness.checked_at = new Date(now - 181000).toISOString(); },
    (s: typeof state) => { s.templates[0].last_provider_event_at = new Date(now + 1).toISOString(); },
    (s: typeof state) => { s.readiness.authorization.token_valid = false; },
    (s: typeof state) => { s.readiness.authorization.waba_tasks = []; },
    (s: typeof state) => { s.readiness.asset.phone_belongs_to_waba = false; },
    (s: typeof state) => { delete s.target.authorization_version; },
  ]) {
    const invalid = structuredClone(state); mutate(invalid); const writes: string[] = [];
    const boundary = createWhatsAppMappingBoundary({ rpc: (async (_name, args: any) => {
      writes.push(args.p_operation); return { data: { supported: true, protocol_version: 1 }, error: null };
    }) as any }, { enabled: () => true, now: () => now });
    assert.equal((await boundary.publish(invalid)).published, false);
    assert.deepEqual(writes, ['gate']);
  }
});
test('I: disabled gate performs no RPC or automated queue/template/mapping writes', async () => {
  let calls = 0; const client = { rpc: async () => { calls++; throw new Error('should never call'); } } as any;
  const boundary = createWhatsAppMappingBoundary(client, { enabled: () => false });
  assert.equal((await boundary.publish(mappingPublicationFixture())).code, 'provisioning_rollout_disabled');
  const previous = process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED;
  delete process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED;
  try {
    const runtime = createWhatsAppProvisioningRuntime(client), state = mappingPublicationFixture();
    const queued = await runtime.provision({ authorization: { businessId: 3, appId: '100', authorizingUserId: 'owner', accessToken: 'synthetic-token' },
      wabaId: '200', phoneNumberId: '500' }, state.readiness);
    assert.equal(queued.code, 'provisioning_rollout_disabled');
    assert.deepEqual(await runtime.reconcileDue(), []);
    await runtime.handleVerifiedWebhook({}); assert.equal(await runtime.status(3), null);
  } finally { if (previous == null) delete process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED; else process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED = previous; }
  assert.equal(calls, 0);
});
test('J: missing RPC, storage capability or incompatible protocol fails closed before every automated path', async () => {
  for (const data of [null, { supported: false, protocol_version: 1 }, { supported: true, protocol_version: 2 }]) {
    const calls: string[] = []; const client = { rpc: async (_name: string, args: any) => { calls.push(args.p_operation); return { data, error: null }; } } as any;
    const boundary = createWhatsAppMappingBoundary(client, { enabled: () => true });
    assert.equal((await boundary.publish(mappingPublicationFixture())).code, 'provisioning_schema_missing');
    assert.deepEqual(calls, ['gate']);
  }
  const boundary = createWhatsAppMappingBoundary({ rpc: (async () => ({ error: { message: 'secret provider/database text' }, data: null })) as any }, { enabled: () => true });
  assert.equal((await boundary.gate()).code, 'provisioning_schema_missing');
  const previous = process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED;
  process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED = 'true';
  try {
    const calls: string[] = [];
    const runtime = createWhatsAppProvisioningRuntime({ rpc: async (_name: string, args: any) => {
      calls.push(args.p_operation); return { data: { supported: false, protocol_version: 1 }, error: null };
    } } as any);
    const state = mappingPublicationFixture();
    assert.equal((await runtime.provision({ authorization: { businessId: 3, appId: '100', authorizingUserId: 'owner', accessToken: 'synthetic-token' },
      wabaId: '200', phoneNumberId: '500' }, state.readiness)).code, 'provisioning_schema_missing');
    assert.deepEqual(await runtime.reconcileDue(), []); await runtime.handleVerifiedWebhook({});
    assert.equal(await runtime.status(3), null); assert.ok(calls.every(operation => operation === 'gate'));
  } finally { if (previous == null) delete process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED; else process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED = previous; }
});
test('safe publication errors never expose database/provider messages', async () => {
  const boundary = createWhatsAppMappingBoundary({ rpc: (async (_name, args: any) => args.p_operation === 'gate' ?
    { data: { supported: true, protocol_version: 1 }, error: null } : { data: null, error: { message: 'synthetic-secret' } }) as any }, { enabled: () => true });
  const result = await boundary.publish(mappingPublicationFixture());
  assert.equal(result.code, 'provisioning_storage_unavailable'); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
test('malformed successful publication receipts never assert readiness', async () => {
  const boundary = createWhatsAppMappingBoundary({ rpc: (async (_name, args: any) => ({ data: args.p_operation === 'gate' ?
    { supported: true, protocol_version: 1 } : { code: 'reminder_mappings_published', published: true, ready: true, delivery_ready: true }, error: null })) as any }, { enabled: () => true });
  const result = await boundary.publish(mappingPublicationFixture());
  assert.equal(result.code, 'provisioning_storage_unavailable'); assert.equal(result.published, false); assert.equal(result.ready, false);
});
