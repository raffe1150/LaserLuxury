import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createRequireAuth } from '../auth/require-auth';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import { getBackendSupabaseConfiguration } from '../auth/backend-supabase';
import { createSalonCreateHandler, createSalonListHandler, DASHBOARD_SALON_COLUMNS } from './salons-api';

const uidA = '11111111-1111-4111-8111-111111111111';
const uidB = '22222222-2222-4222-8222-222222222222';
const serviceKey = ['synthetic', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'signature'].join('.');
const salonA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', salon_name: 'A', business_id: '2', status: 'active' };
const salonB = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', salon_name: 'B', business_id: '3', status: 'active' };
const legacy = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', salon_name: 'legacy', business_id: 'chi', status: 'active' };

function fixture(options: {
  role?: string; status?: string; noMembership?: boolean; bothBusinesses?: boolean;
  noSalons?: boolean; membershipError?: boolean; queryError?: boolean; unavailable?: boolean;
} = {}) {
  const memberships = options.noMembership ? [] : [
    { business_id: 2, user_id: uidA, role: options.role ?? 'owner', status: options.status ?? 'active' },
    { business_id: 3, user_id: uidB, role: 'owner', status: 'active' },
    ...(options.bothBusinesses ? [{ business_id: 3, user_id: uidA, role: 'owner', status: 'active' }] : []),
  ];
  const salons = options.noSalons ? [] : [salonA, salonB, legacy];
  const requests: { url: URL; method: string; body?: any }[] = [];
  const inserted: any[] = [];
  const failures: string[] = [];
  const config = getBackendSupabaseConfiguration({ SUPABASE_URL: 'https://salons-test.invalid',
    SUPABASE_SERVICE_ROLE_KEY: serviceKey, SUPABASE_ANON_KEY: 'must-not-be-used' });
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), serviceKey);
      assert.equal(headers.get('Authorization'), `Bearer ${serviceKey}`);
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      const project = (row: Record<string, any>) => Object.fromEntries(
        String(url.searchParams.get('select')).split(',').map(key => [key, row[key]]));
      if (url.pathname.endsWith('/business_memberships')) {
        assert.equal(method, 'GET');
        assert.ok([`eq.${uidA}`, `eq.${uidB}`].includes(url.searchParams.get('user_id')!));
        assert.equal(url.searchParams.get('status'), 'eq.active');
        if (options.membershipError) return json({ code: 'XX000', message: 'private database detail' }, 500);
        return json(memberships.filter(row => Object.entries(row).every(([key, value]) =>
          !url.searchParams.has(key) || url.searchParams.get(key) === `eq.${value}`)).map(project));
      }
      assert.ok(url.pathname.endsWith('/salons'));
      assert.equal(url.searchParams.get('select'), DASHBOARD_SALON_COLUMNS);
      if (options.queryError) return json({ code: 'XX000', message: 'private database detail' }, 500);
      if (method === 'POST') {
        inserted.push(...body);
        if (salons.some(row => row.business_id === body[0].business_id)) return json({ code: '23505' }, 409);
        const row = { id: salonA.id, ...body[0] };
        salons.push(row);
        return json([project(row)], 201);
      }
      assert.equal(method, 'GET');
      const filter = url.searchParams.get('business_id');
      assert.ok(filter?.startsWith('in.('));
      const ids = filter.slice(4, -1).split(',').map(id => id.replaceAll('"', ''));
      assert.ok(ids.every(id => /^\d+$/.test(id)));
      return json(salons.filter(row => ids.includes(row.business_id)).map(project));
    } },
  });
  const authClient: any = { auth: { getUser: async (token: string) => {
    const id = token === 'user-a' ? uidA : token === 'user-b' ? uidB : null;
    return { data: { user: id ? { id } : null }, error: id ? null : { status: 401, code: 'bad_jwt' } };
  } } };
  const app = express();
  app.use(express.json());
  const dependencies = { client: options.unavailable ? null : client, getAuthorizationClient: () => client,
    onFailure: (category: string) => { failures.push(category); } };
  app.get('/api/salons', createRequireAuth(authClient), createSalonListHandler(dependencies));
  app.post('/api/salons', createRequireAuth(authClient), createRequireBusinessPermission('settings.manage', {
    client, resolveBusinessId: request => request.body?.businessId ?? request.body?.business_id,
  }), createSalonCreateHandler(dependencies));
  return { app, requests, inserted, failures };
}

async function request(f: ReturnType<typeof fixture>, method = 'GET', body?: any, token: string | null = 'user-a', query = '') {
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/salons${query}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    assert.doesNotMatch(JSON.stringify(result.body), /private|service_role|must-not-be-used|signature/);
    return result;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

for (const method of ['GET', 'POST']) {
  test(`${method} rejects anonymous and invalid sessions before any database call`, async () => {
    for (const token of [null, 'invalid']) {
      const f = fixture();
      assert.equal((await request(f, method, method === 'POST' ? { businessId: 2, salonName: 'A' } : undefined, token)).status, 401);
      assert.equal(f.requests.length, 0);
    }
  });
}

test('GET uses only active verified-user memberships and ignores untrusted query scope', async () => {
  const f = fixture();
  const result = await request(f, 'GET', undefined, 'user-a', '?businessId=3&business_id=chi&user_id=' + uidB);
  assert.deepEqual(result, { status: 200, body: [salonA] });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url.searchParams.get('user_id'), `eq.${uidA}`);
  assert.equal(f.requests[1].url.searchParams.get('business_id'), 'in.(2)');
  assert.equal(f.requests[1].url.searchParams.has('or'), false);
});

test('GET isolates business B from A and the unmapped legacy row', async () => {
  const f = fixture();
  assert.deepEqual((await request(f, 'GET', undefined, 'user-b')).body, [salonB]);
});

test('GET returns all legitimately managed tenants without choosing a single row', async () => {
  const f = fixture({ bothBusinesses: true });
  assert.deepEqual((await request(f)).body, [salonA, salonB]);
  assert.equal(f.requests[1].url.searchParams.has('limit'), false);
});

for (const options of [{ noMembership: true }, { status: 'suspended' }, { status: 'revoked' }, { status: 'invited' }]) {
  test(`GET with no active scope is quiet and avoids the salons query: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    assert.deepEqual(await request(f), { status: 200, body: [] });
    assert.equal(f.requests.length, 1);
    assert.equal(f.failures.length, 0);
  });
}

test('GET with no matching salon returns an empty array', async () => {
  assert.deepEqual(await request(fixture({ noSalons: true })), { status: 200, body: [] });
});

for (const id of [2, '2', '02', ' 002 ']) {
  test(`POST persists the authorized canonical text ID for ${JSON.stringify(id)}`, async () => {
    const f = fixture({ noSalons: true });
    const result = await request(f, 'POST', { businessId: id, salonName: 'New salon', status: 'inactive',
      id: salonB.id, user_id: uidB, telegram_bot_token: 'untrusted-private-field' });
    assert.equal(result.status, 200);
    assert.deepEqual(f.inserted, [{ salon_name: 'New salon', business_id: '2', status: 'inactive' }]);
    assert.deepEqual(Object.keys(result.body.data[0]).sort(), ['business_id', 'id', 'salon_name', 'status']);
  });
}

test('POST supports the business_id alias and unchanged default status', async () => {
  const f = fixture({ noSalons: true });
  assert.equal((await request(f, 'POST', { business_id: '02', salonName: 'A' })).status, 200);
  assert.equal(f.inserted[0].status, 'active');
  assert.equal(f.inserted[0].business_id, '2');
});

test('equivalent aliases succeed but conflicting aliases fail without insertion', async () => {
  const allowed = fixture({ noSalons: true });
  assert.equal((await request(allowed, 'POST', { businessId: '02', business_id: 2, salonName: 'A' })).status, 200);
  for (const alias of [3, 'chi', '2,or(business_id.eq.3)', null, {}]) {
    const f = fixture({ noSalons: true });
    assert.equal((await request(f, 'POST', { businessId: 2, business_id: alias, salonName: 'A' })).status, 403);
    assert.equal(f.inserted.length, 0);
    assert.equal(f.requests.some(r => r.url.pathname.endsWith('/salons')), false);
  }
});

test('POST cannot authorize a foreign tenant in either direction', async () => {
  for (const [token, businessId] of [['user-a', 3], ['user-b', 2]] as const) {
    const f = fixture({ noSalons: true });
    assert.equal((await request(f, 'POST', { businessId, salonName: 'foreign' }, token)).status, 403);
    assert.equal(f.inserted.length, 0);
    assert.equal(f.requests.some(r => r.url.pathname.endsWith('/salons')), false);
  }
});

test('legacy, arbitrary, unsafe numeric and injected keys fail before database writes', async () => {
  for (const businessId of ['chi', '2,3', '2);delete', '2e0', -2, 0, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture({ noSalons: true });
    assert.equal((await request(f, 'POST', { businessId, salonName: 'A' })).status, 400);
    assert.equal(f.requests.length, 0);
    assert.equal(f.inserted.length, 0);
  }
});

for (const options of [{ role: 'viewer' }, { role: 'agent' }, { status: 'suspended' }, { noMembership: true }]) {
  test(`POST requires settings permission and active membership: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ ...options, noSalons: true });
    assert.equal((await request(f, 'POST', { businessId: 2, salonName: 'A' })).status, 403);
    assert.equal(f.inserted.length, 0);
  });
}

for (const role of ['admin', 'manager']) {
  test(`${role} retains legitimate salon creation`, async () => {
    assert.equal((await request(fixture({ role, noSalons: true }), 'POST', { businessId: 2, salonName: 'A' })).status, 200);
  });
}

test('canonical uniqueness conflicts remain visible and never overwrite existing data', async () => {
  const f = fixture();
  assert.equal((await request(f, 'POST', { businessId: '02', salonName: 'duplicate' })).status, 500);
  assert.deepEqual(f.failures, ['salon_create_failed']);
  assert.deepEqual((await request(f)).body, [salonA]);
});

test('database and authorization failures remain categorized without private error details', async () => {
  const auth = fixture({ membershipError: true });
  assert.equal((await request(auth)).status, 500);
  assert.deepEqual(auth.failures, ['salon_authorization_failed']);
  assert.equal(auth.requests.length, 1);
  const read = fixture({ queryError: true });
  assert.equal((await request(read)).status, 500);
  assert.deepEqual(read.failures, ['salon_list_failed']);
  const write = fixture({ queryError: true });
  assert.equal((await request(write, 'POST', { businessId: 2, salonName: 'A' })).status, 500);
  assert.deepEqual(write.failures, ['salon_create_failed']);
});

test('missing database or required input fails without insertion', async () => {
  const f = fixture({ unavailable: true });
  assert.equal((await request(f)).status, 500);
  assert.equal((await request(f, 'POST', { businessId: 2, salonName: 'A' })).status, 500);
  assert.equal(f.inserted.length, 0);
  assert.equal((await request(fixture(), 'POST', { businessId: 2 })).status, 400);
});
