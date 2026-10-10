import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import express, { type ErrorRequestHandler } from 'express';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';
import { createRequireAuth } from '../../auth/require-auth';
import { createRequireBusinessPermission } from '../../auth/require-business-access';
import * as credentials from './credential-crypto';
import * as contracts from './contracts';
import * as providers from './providers';
import * as repository from './repository';
import * as security from './security';

// Execute the entire actual router with real auth/permission middleware and
// mocked storage/provider completion. Wrapping the real URL builder records
// whether unsupported input reaches it; no production test seam is needed.
const source = readFileSync(new URL('./api-router.ts', import.meta.url), 'utf8');
const executable = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const userId = '11111111-1111-4111-8111-111111111111';
interface Session {
  business_id: number; user_id: string; provider: string;
  state_hash: string; browser_nonce_hash: string; redirect_uri: string;
}
interface StoreCall { table: string; method: string; filters: URLSearchParams }

async function fixture(
  run: (f: Awaited<ReturnType<typeof startFixture>>) => Promise<void>,
  options: { role?: string; status?: string; businessId?: number } = {},
) {
  const environment = {
    PUBLIC_BASE_URL: 'https://authorization.example.test', INSTAGRAM_APP_ID: '123456', META_APP_ID: '987654',
    META_GRAPH_API_VERSION: 'v26.0', META_LOGIN_CONFIG_ID: 'synthetic-login-config',
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'synthetic-whatsapp-config',
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const f = await startFixture(options);
  try { await run(f); } finally {
    await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
    globalThis.fetch = f.originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function startFixture(options: { role?: string; status?: string; businessId?: number }) {
  const sessions: Session[] = [];
  const storeCalls: StoreCall[] = [];
  const urlBuilders: string[] = [];
  const launches: string[] = [];
  const randomValues: string[] = [];
  const cookies: string[] = [];
  const callbackUrls: string[] = [];
  const completed: string[] = [];
  const saved: Record<string, unknown>[] = [];
  const outbound: string[] = [];
  const originalFetch = globalThis.fetch;
  const client = createClient('https://store.example.test', 'synthetic-store-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (address, init) => {
      const url = new URL(String(address));
      const table = url.pathname.split('/').at(-1)!;
      const method = init?.method || 'GET';
      storeCalls.push({ table, method, filters: url.searchParams });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      if (table === 'business_memberships') {
        assert.equal(method, 'GET');
        assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
        const allowed = url.searchParams.get('business_id') === `eq.${options.businessId ?? 101}`
          && (options.status ?? 'active') === 'active';
        return json(allowed ? [{ business_id: options.businessId ?? 101, user_id: userId,
          role: options.role ?? 'owner', status: options.status ?? 'active' }] : []);
      }
      if (table === 'channel_authorization_sessions') {
        if (method === 'DELETE') return new Response(null, { status: 204 });
        assert.equal(method, 'POST');
        const row: Session = JSON.parse(String(init?.body));
        sessions.push(row);
        return new Response(null, { status: 201 });
      }
      if (table === 'consume_channel_authorization_session') {
        const params = JSON.parse(String(init?.body));
        const index = sessions.findIndex(s => s.provider === params.p_provider
          && s.state_hash === params.p_state_hash && s.browser_nonce_hash === params.p_browser_nonce_hash);
        return json(index < 0 ? [] : sessions.splice(index, 1));
      }
      assert.equal(table, 'channel_connections');
      assert.equal(method, 'POST');
      const row: Record<string, unknown> = JSON.parse(String(init?.body));
      saved.push(row);
      return json({ ...row, id: 'synthetic-connection' }, 201);
    } },
  });
  const authClient = createClient('https://auth.example.test', 'synthetic-auth-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (_address, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-user-token');
      return new Response(JSON.stringify({ id: userId, aud: 'authenticated', role: 'authenticated',
        app_metadata: {}, user_metadata: {}, created_at: '2026-10-08T00:00:00Z' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } },
  });
  const complete = (provider: 'instagram' | 'messenger') => async () => {
    completed.push(provider);
    return { providerAccountId: 'synthetic-account', credential: { accessToken: 'synthetic-provider-token' },
      grantedScopes: providers.PROVIDER_SCOPES[provider], metadata: {} };
  };
  const exports = {};
  const modules: Record<string, unknown> = {
    express, './credential-crypto': credentials, './contracts': contracts, './repository': repository,
    './security': { ...security,
      randomAuthorizationValue: () => {
        const value = security.randomAuthorizationValue(); randomValues.push(value); return value;
      },
      authorizationCookie: (value: string) => { cookies.push(value); return security.authorizationCookie(value); },
      callbackUrl: (provider: string) => { callbackUrls.push(provider); return security.callbackUrl(provider); },
    },
    './providers': { ...providers,
      buildAuthorizationUrl: (...args: Parameters<typeof providers.buildAuthorizationUrl>) => {
        urlBuilders.push(args[0]); return providers.buildAuthorizationUrl(...args);
      },
      whatsappLaunchConfiguration: (state: string) => {
        launches.push(state); return providers.whatsappLaunchConfiguration(state);
      },
      completeInstagram: complete('instagram'), completeMessenger: complete('messenger'),
    },
  };
  const compiled: typeof import('./api-router') = vm.runInNewContext(`${executable}\nmodule.exports;`, {
    module: { exports }, exports, URL, Date, Set,
    require: (name: string) => { assert.ok(name in modules, `unexpected import: ${name}`); return modules[name]; },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/channel-connections', compiled.createChannelConnectionsRouter({
    client, requireAuth: createRequireAuth(authClient),
    requireBusinessPermission: permission => createRequireBusinessPermission(permission, { client }),
  }));
  const errorHandler: ErrorRequestHandler = (_error, _request, response, _next) => {
    response.status(500).json({ error: 'unexpected_test_route_error' });
  };
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = async (path: string, init: RequestInit = {}) => originalFetch(
    `http://127.0.0.1:${address.port}/api/channel-connections${path}`, { redirect: 'manual', ...init },
  );
  globalThis.fetch = async address => { outbound.push(String(address)); throw new Error('unexpected_provider_outbound'); };
  const authorize = (provider: string, businessId = '101', authenticated = true) => request(`/${businessId}/${provider}/authorize`, {
    method: 'POST', headers: authenticated ? { Authorization: 'Bearer synthetic-user-token' } : {},
  });
  return { server, originalFetch, request, authorize, sessions, storeCalls, urlBuilders, launches, completed, saved, outbound, randomValues, cookies, callbackUrls };
}

function noArtifacts(f: Awaited<ReturnType<typeof startFixture>>, response: Response) {
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(f.sessions, []);
  assert.deepEqual(f.storeCalls.filter(c => c.table !== 'business_memberships'), []);
  assert.deepEqual(f.randomValues, []);
  assert.deepEqual(f.cookies, []);
  assert.deepEqual(f.callbackUrls, []);
  assert.deepEqual(f.urlBuilders, []);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.completed, []);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.outbound, []);
}

test('Telegram authorization rejects before state/session/cookie/Meta URL creation', async t => {
  await fixture(async f => {
    const response = await f.authorize('telegram');
    const body = await response.json();
    t.diagnostic(JSON.stringify({ status: response.status, body, sessions: f.sessions.length,
      sessionProviders: f.sessions.map(s => s.provider), cookieCreated: response.headers.has('set-cookie'),
      urlBuilders: f.urlBuilders, randomValues: f.randomValues.length, cookieCalls: f.cookies.length, callbackUrls: f.callbackUrls, providerOutboundCalls: f.outbound.length }));
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'unsupported_provider' });
    noArtifacts(f, response);
  });
});

for (const provider of ['instagram', 'messenger'] as const) {
  for (const role of ['owner', 'admin']) {
    test(`${role} ${provider} authorization retains scoped state/cookie/URL and callback compatibility`, async () => {
      await fixture(async f => {
        const response = await f.authorize(provider);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.success, true); assert.equal(body.mode, 'redirect');
        const url = new URL(body.authorizationUrl);
        assert.equal(url.origin, provider === 'instagram' ? 'https://www.instagram.com' : 'https://www.facebook.com');
        assert.equal(url.searchParams.get('client_id'), provider === 'instagram' ? '123456' : '987654');
        assert.equal(url.searchParams.get('scope'), providers.PROVIDER_SCOPES[provider].join(','));
        assert.equal(url.searchParams.get('redirect_uri'), security.callbackUrl(provider));
        assert.equal(f.sessions.length, 1);
        const session = f.sessions[0];
        assert.equal(session.business_id, 101); assert.equal(session.user_id, userId); assert.equal(session.provider, provider);
        assert.equal(session.state_hash, security.hashAuthorizationValue(url.searchParams.get('state')!));
        const cookie = response.headers.get('set-cookie')!;
        assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
        assert.equal(session.browser_nonce_hash, security.hashAuthorizationValue(security.parseCookie(cookie, security.AUTHORIZATION_COOKIE)!));
        assert.deepEqual(f.urlBuilders, [provider]); assert.deepEqual(f.outbound, []);
        assert.equal(f.randomValues.length, 2); assert.equal(f.cookies.length, 1); assert.deepEqual(f.callbackUrls, [provider]);
        const callback = await f.request(`/${provider}/callback?state=${url.searchParams.get('state')}&code=synthetic-code`, { headers: { cookie } });
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), security.dashboardReturnUrl(provider, 'connected'));
        assert.match(callback.headers.get('set-cookie')!, /Max-Age=0/);
        assert.deepEqual(f.completed, [provider]); assert.equal(f.saved.length, 1);
        assert.equal(f.saved[0].business_id, 101); assert.equal(f.saved[0].provider, provider);
        const replay = await f.request(`/${provider}/callback?state=${url.searchParams.get('state')}&code=synthetic-code`, { headers: { cookie } });
        assert.equal(replay.headers.get('location'), security.dashboardReturnUrl(provider, 'authorization_state_invalid'));
        assert.equal(f.saved.length, 1); assert.deepEqual(f.outbound, []);
      }, { role });
    });
  }
}

test('WhatsApp retains embedded signup session/cookie/config and never calls the Meta redirect builder', async () => {
  await fixture(async f => {
    const response = await f.authorize('whatsapp'); const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { success: true, mode: 'embedded_signup', ...providers.whatsappLaunchConfiguration(body.state), redirectUri: security.callbackUrl('whatsapp') });
    assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].provider, 'whatsapp');
    assert.equal(f.sessions[0].business_id, 101); assert.equal(f.sessions[0].user_id, userId);
    assert.equal(f.sessions[0].state_hash, security.hashAuthorizationValue(body.state));
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
    assert.deepEqual(f.launches, [body.state]); assert.deepEqual(f.urlBuilders, []); assert.deepEqual(f.outbound, []);
  });
});

for (const provider of ['telegram', 'instagram', 'messenger', 'whatsapp', 'unsupported']) {
  test(`${provider}: authentication still runs before provider eligibility`, async () => {
    await fixture(async f => {
      const response = await f.authorize(provider, '101', false);
      assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthenticated' });
      assert.deepEqual(f.storeCalls, []); noArtifacts(f, response);
    });
  });
  test(`${provider}: forbidden membership cannot reach eligibility or artifacts`, async () => {
    await fixture(async f => {
      const response = await f.authorize(provider); assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'forbidden' }); noArtifacts(f, response);
    }, { role: 'viewer' });
  });
  test(`${provider}: membership for A cannot authorize business B or disclose provider eligibility`, async () => {
    await fixture(async f => {
      const response = await f.authorize(provider, '202'); assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'forbidden' }); noArtifacts(f, response);
    });
  });
}

test('invalid provider keeps the existing 400 unsupported_provider response without artifacts', async () => {
  await fixture(async f => {
    const response = await f.authorize('unsupported'); assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unsupported_provider' }); noArtifacts(f, response);
  });
});

test('invalid business scope is still rejected before provider eligibility', async () => {
  await fixture(async f => {
    const response = await f.authorize('telegram', 'invalid'); assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_business_id' }); noArtifacts(f, response);
  });
});

test('Telegram callback remains unsupported and cannot consume state or save a connection', async () => {
  await fixture(async f => {
    const response = await f.request('/telegram/callback?state=synthetic-state&code=synthetic-code');
    assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found'); noArtifacts(f, response);
  });
});
