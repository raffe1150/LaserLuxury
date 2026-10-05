import assert from 'node:assert/strict';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import test from 'node:test';
import { createRequireAuth } from '../auth/require-auth';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import { createTelegramSetupHandler } from './telegram-setup';

const uid = '11111111-1111-4111-8111-111111111111';
const tokenA = 'synthetic-token-a';
const tokenB = 'synthetic-token-b';
const normalizeToken = (value: string) => String(value || '').replace(/[\r\n]/g, '').trim();

function fixture(options: {
  role?: string; status?: string; userId?: string; membershipBusinessId?: number;
  rows?: Record<string, any>[]; error?: boolean; wrongReply?: boolean;
  wrongConfig?: boolean; unavailable?: boolean; buildError?: boolean;
} = {}) {
  const requests: URL[] = [];
  const built: Record<string, any>[] = [];
  const saved: Record<string, any>[] = [];
  const started: Record<string, any>[] = [];
  const failures: string[] = [];
  const client = createClient('https://telegram-setup.invalid', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(init?.method, 'GET');
      let data: Record<string, any>[];
      if (url.pathname.endsWith('/business_memberships')) {
        data = [{ business_id: options.membershipBusinessId ?? 1, user_id: options.userId ?? uid,
          role: options.role ?? 'owner', status: options.status ?? 'active' }]
          .filter(row => Object.entries(row).every(([key, value]) =>
            !url.searchParams.has(key) || url.searchParams.get(key) === `eq.${value}`));
      } else {
        assert.ok(url.pathname.endsWith('/businesses'));
        if (options.error) return new Response(JSON.stringify({ code: 'XX000', message: `private ${tokenB}` }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
        const rows = options.rows ?? [{ id: 1, telegram_bot_token: tokenA, business_name: 'A' },
          { id: 2, telegram_bot_token: tokenB, business_name: 'B' }];
        data = options.wrongReply ? rows.filter(row => row.id === 2)
          : rows.filter(row => url.searchParams.get('id') === `eq.${row.id}`);
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const authClient: any = { auth: { getUser: async (token: string) => token === 'valid-user-token'
    ? { data: { user: { id: uid } }, error: null }
    : { data: { user: null }, error: { status: 401, code: 'bad_jwt' } } } };
  const app = express();
  app.use(express.json());
  app.post('/api/setup-telegram', createRequireAuth(authClient),
    createRequireBusinessPermission('settings.manage', {
      client, resolveBusinessId: req => req.body?.businessId ?? req.body?.business_id,
    }), createTelegramSetupHandler({
      client: options.unavailable ? null : client,
      normalizeToken,
      buildConfig: async row => {
        built.push(row);
        if (options.buildError) throw new Error(`private ${tokenB}`);
        return { id: options.wrongConfig ? 2 : row.id, business_name: row.business_name,
          telegramToken: normalizeToken(row.telegram_bot_token) };
      },
      saveConfig: config => { saved.push(config); },
      startPolling: config => { started.push(config); },
      onFailure: category => { failures.push(category); },
    }));
  return { app, requests, built, saved, started, failures };
}

async function post(f: ReturnType<typeof fixture>, body: Record<string, any>, authenticated = true) {
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/setup-telegram`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: 'Bearer valid-user-token' } : {}) },
      body: JSON.stringify(body),
    });
    const result = { status: response.status, body: await response.json() };
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic-token|private/);
    return result;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function noEffects(f: ReturnType<typeof fixture>) {
  assert.equal(f.saved.length, 0);
  assert.equal(f.started.length, 0);
}

test('rightful owner resolves only their business, saves scoped database config, and starts Telegram', async () => {
  const f = fixture();
  assert.equal((await post(f, { businessId: 1, telegramToken: ` ${tokenA}\r\n`,
    whatsappAccessToken: 'untrusted-other-provider', systemPrompt: 'untrusted-request-config' })).status, 200);
  const reads = f.requests.filter(url => url.pathname.endsWith('/businesses'));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].searchParams.get('id'), 'eq.1');
  assert.equal(reads[0].searchParams.get('select'), '*');
  assert.equal(reads[0].searchParams.has('telegram_bot_token'), false);
  assert.equal(f.saved.length, 1);
  assert.equal(f.started.length, 1);
  assert.equal(f.saved[0].businessRecordId, 1);
  assert.equal(f.saved[0].telegramToken, tokenA);
  assert.equal(f.saved[0].whatsappAccessToken, undefined);
  assert.equal(f.saved[0].systemPrompt, undefined);
});

test('another business token cannot trigger cross-tenant reads, saves, hydration or polling', async () => {
  const f = fixture();
  assert.equal((await post(f, { businessId: 1, telegramToken: tokenB })).status, 403);
  noEffects(f);
  assert.equal(f.built.length, 0);
  for (const url of f.requests.filter(url => url.pathname.endsWith('/businesses'))) {
    assert.equal(url.searchParams.get('id'), 'eq.1');
    assert.equal(url.searchParams.has('telegram_bot_token'), false);
    assert.equal(url.searchParams.has('or'), false);
  }
});

test('membership for A cannot authorize setup of B', async () => {
  const f = fixture();
  assert.equal((await post(f, { businessId: 2, telegramToken: tokenB })).status, 403);
  assert.equal(f.requests.some(url => url.pathname.endsWith('/businesses')), false);
  noEffects(f);
});

test('business B works independently and cannot resolve A through its token or business ID', async () => {
  const own = fixture({ membershipBusinessId: 2 });
  assert.equal((await post(own, { businessId: 2, telegramToken: tokenB })).status, 200);
  assert.equal(own.started[0].businessRecordId, 2);
  assert.equal(own.saved[0].telegramToken, tokenB);
  const foreignToken = fixture({ membershipBusinessId: 2 });
  assert.equal((await post(foreignToken, { businessId: 2, telegramToken: tokenA })).status, 403);
  assert.equal(foreignToken.built.length, 0);
  assert.equal(foreignToken.requests.find(url => url.pathname.endsWith('/businesses'))?.searchParams.get('id'), 'eq.2');
  noEffects(foreignToken);
  const foreignBusiness = fixture({ membershipBusinessId: 2 });
  assert.equal((await post(foreignBusiness, { businessId: 1, telegramToken: tokenA })).status, 403);
  assert.equal(foreignBusiness.requests.some(url => url.pathname.endsWith('/businesses')), false);
  noEffects(foreignBusiness);
});

for (const field of ['id', 'business_id', 'businessRecordId']) {
  test(`conflicting ${field} cannot override the authorized business`, async () => {
    const f = fixture();
    assert.equal((await post(f, { businessId: 1, [field]: 2, telegramToken: tokenA })).status, 403);
    assert.equal(f.requests.some(url => url.pathname.endsWith('/businesses')), false);
    noEffects(f);
  });
}

for (const options of [{ status: 'suspended' }, { status: 'revoked' }, { status: 'invited' },
  { role: 'viewer' }, { role: 'agent' }, { userId: '22222222-2222-4222-8222-222222222222' }]) {
  test(`ineligible membership ${JSON.stringify(options)} cannot set up Telegram`, async () => {
    const f = fixture(options);
    assert.equal((await post(f, { businessId: 1, telegramToken: tokenA })).status, 403);
    assert.equal(f.requests.some(url => url.pathname.endsWith('/businesses')), false);
    noEffects(f);
  });
}

test('anonymous setup never reaches membership or business data', async () => {
  const f = fixture();
  assert.equal((await post(f, { businessId: 1, telegramToken: tokenA }, false)).status, 401);
  assert.equal(f.requests.length, 0);
  noEffects(f);
});

test('no matching business fails closed without global token recovery', async () => {
  const f = fixture({ rows: [] });
  assert.equal((await post(f, { businessId: 1, telegramToken: tokenA })).status, 404);
  noEffects(f);
  assert.equal(f.requests.filter(url => url.pathname.endsWith('/businesses')).length, 1);
});

for (const options of [{ error: true }, { wrongReply: true }, { wrongConfig: true }, { buildError: true },
  { rows: [{ id: 1, telegram_bot_token: tokenA }, { id: 1, telegram_bot_token: tokenA }] }]) {
  test(`query/config integrity failure ${Object.keys(options)[0]} fails closed`, async () => {
    const f = fixture(options);
    assert.equal((await post(f, { businessId: 1, telegramToken: tokenA })).status, 503);
    noEffects(f);
    assert.deepEqual(f.failures, ['setup_telegram_failed']);
  });
}

test('unavailable database cannot save config or start a poller', async () => {
  const f = fixture({ unavailable: true });
  assert.equal((await post(f, { businessId: 1, telegramToken: tokenA })).status, 503);
  noEffects(f);
});

test('existing no-token config save remains scoped and does not start polling', async () => {
  const f = fixture();
  assert.equal((await post(f, { business_id: '01' })).status, 200);
  assert.equal(f.saved[0].business_id, 1);
  assert.equal(f.started.length, 0);
});

for (const role of ['admin', 'manager']) {
  test(`${role} retains legitimate settings-managed Telegram setup`, async () => {
    const f = fixture({ role });
    assert.equal((await post(f, { businessId: 1, telegramToken: tokenA })).status, 200);
    assert.equal(f.started[0].businessRecordId, 1);
  });
}

test('invalid business and token inputs fail before business resolution', async () => {
  for (const body of [{ businessId: '1 OR 1=1', telegramToken: tokenA }, { businessId: 1, telegramToken: { token: tokenB } }]) {
    const f = fixture();
    assert.equal((await post(f, body)).status, 400);
    assert.equal(f.requests.some(url => url.pathname.endsWith('/businesses')), false);
    noEffects(f);
  }
});
