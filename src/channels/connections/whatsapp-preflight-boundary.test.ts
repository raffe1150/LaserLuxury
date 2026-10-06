import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelConnectionsRouter } from './api-router';

// Exercise the actual completion handlers with synthetic authorization and
// storage. The fake client fails if connection persistence is ever reached.
async function completion(path: string, sessionBusinessId = 3, healthy = false) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { META_APP_ID: process.env.META_APP_ID, META_APP_SECRET: process.env.META_APP_SECRET,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, CHANNEL_CREDENTIAL_ENCRYPTION_KEY: process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY };
  const token = 'synthetic-boundary-token';
  const requests: string[] = [];
  let storageCalls = 0;
  process.env.META_APP_ID = '26871846599183572';
  process.env.META_APP_SECRET = 'synthetic-app-secret';
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  let connectionSaved = false;
  globalThis.fetch = async (address, init) => {
    const url = new URL(String(address));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(init?.method || 'GET', 'GET');
    requests.push(url.pathname); // Never record credentials or query parameters.
      const body = url.pathname.endsWith('/oauth/access_token') ? { access_token: token } :
      url.pathname.endsWith('/debug_token') ? { data: { is_valid: true, app_id: process.env.META_APP_ID,
        user_id: '122138897973387476', scopes: ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'] } } :
        healthy && url.pathname.endsWith('/1349279940681149') ? { id: '1349279940681149', owner_business_info: { id: '300' } } :
        healthy && url.pathname.endsWith('/1176858338851675') ? { id: '1176858338851675', status: 'CONNECTED', platform_type: 'CLOUD_API', account_mode: 'LIVE',
          health_status: { can_send_message: 'AVAILABLE', entities: [{ entity_type: 'WABA', id: '1349279940681149', can_send_message: 'AVAILABLE' }] } } :
        healthy && url.pathname.endsWith('/phone_numbers') ? { data: [{ id: '1176858338851675' }] } :
        healthy && url.pathname.endsWith('/assigned_users') ? { data: [{ id: '122138897973387476', tasks: ['MANAGE'] }] } :
        healthy && url.pathname.endsWith('/subscribed_apps') ? { data: [{ whatsapp_business_api_data: { id: process.env.META_APP_ID } }] } : { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = {
      rpc: async () => ({ data: { business_id: sessionBusinessId, user_id: 'odinlink-owner',
        redirect_uri: 'https://example.test/api/channel-connections/whatsapp/callback' }, error: null }),
      from: (table: string) => {
        storageCalls++; if (!healthy) throw new Error('Unexpected connection storage access');
        assert.equal(table, 'channel_connections');
        return { upsert: (row: any) => ({ select: () => ({ single: async () => {
          connectionSaved = true; return { data: { ...row, id: 'synthetic-connection' }, error: null };
        } }) }) };
      },
    };
    const router = createChannelConnectionsRouter({ client: client as any, requireAuth: (_req, _res, next) => next(),
      requireBusinessPermission: () => (_req, _res, next) => next(),
      ...(healthy ? { whatsappTemplateProvisioner: async (input: any, preflight: any) => {
        assert.equal(connectionSaved, true); assert.equal(input.authorization.businessId, 3);
        assert.equal(input.authorization.authorizingUserId, 'odinlink-owner'); assert.equal(input.authorization.accessToken, token);
        assert.equal(preflight.provisioning_ready, true);
        return { code: 'provisioning_queued', readiness: { ...preflight, reminder_ready: false, ready: false } } as any;
      } } : {}) });
    const route = router.stack.find((layer: any) => layer.route?.path === path)?.route;
    assert.ok(route);
    const handler = route.stack.at(-1).handle as (request: any, response: any, next: (error?: unknown) => void) => void;
    let status = 200;
    const result = await new Promise<any>((resolve, reject) => {
      handler({ body: { state: 'synthetic-state', code: 'synthetic-code', wabaId: '1349279940681149',
        phoneNumberId: '1176858338851675', accessToken: token }, header: () => 'odinlink_channel_auth=synthetic-nonce',
      auth: { userId: 'odinlink-owner' }, businessAccess: { businessId: 3 } }, {
        setHeader() { return this; },
        status(value: number) { status = value; return this; },
        json(body: unknown) { resolve({ status, body }); },
      }, reject);
    });
    assert.equal(storageCalls, healthy ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    return { ...result, requests };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('embedded completion returns safe readiness and never saves a connection after failed preflight', async () => {
  const result = await completion('/:businessId/whatsapp/complete');
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'whatsapp_setup_needs_attention');
  assert.equal(result.body.readiness.business_id, 3);
  assert.equal(result.body.readiness.provisioning_ready, false);
  assert.ok(result.body.readiness.reasons.some((reason: any) => reason.code === 'phone_not_in_selected_waba'));
  assert.ok(result.requests[0].endsWith('/oauth/access_token'));
});
test('manual completion applies the same gate before connection persistence', async () => {
  const result = await completion('/:businessId/whatsapp/manual');
  assert.equal(result.status, 409);
  assert.equal(result.body.readiness.provisioning_ready, false);
  assert.ok(result.requests.every((path: string) => !path.endsWith('/oauth/access_token')));
});
test('tenant authorization mismatch stops embedded completion before token exchange or storage', async () => {
  const result = await completion('/:businessId/whatsapp/complete', 4);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'authorization_owner_mismatch');
  assert.deepEqual(result.requests, []);
});
test('successful embedded and manual routes save the authorized connection before starting template provisioning', async () => {
  for (const path of ['/:businessId/whatsapp/complete', '/:businessId/whatsapp/manual']) {
    const result = await completion(path, 3, true);
    assert.equal(result.status, 200); assert.equal(result.body.provisioning.code, 'provisioning_queued');
    assert.equal(result.body.readiness.reminder_ready, false);
  }
});
