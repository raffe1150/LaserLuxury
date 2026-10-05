import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createRequireAuth } from '../auth/require-auth';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import { getBackendSupabaseConfiguration } from '../auth/backend-supabase';
import { applyBusinessToneConfigUpdate } from './business-tone-update';

const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const routeStatements: string[] = [];
let projectionExpression = '';
function inspect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'DASHBOARD_BUSINESS_COLUMNS') {
    projectionExpression = node.initializer!.getText(parsed);
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(parsed) === 'app'
      && ts.isStringLiteral(call.arguments[0])
      && ((call.expression.name.text === 'get' && call.arguments[0].text === '/api/businesses')
        || (call.expression.name.text === 'put' && call.arguments[0].text === '/api/businesses/:id'))) {
      routeStatements.push(node.getText(parsed));
    }
  }
  ts.forEachChild(node, inspect);
}
inspect(parsed);
assert.equal(routeStatements.length, 2, 'test the actual registered business list/update handlers');
assert.ok(projectionExpression);
// Execute the actual route statements, not copies of their implementation.
// This avoids starting production pollers, cron or provider clients in tests.
const executable = ts.transpileModule(
  `const DASHBOARD_BUSINESS_COLUMNS = ${projectionExpression};\n${routeStatements.join('\n')}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const key = ['synthetic', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'signature'].join('.');

function fixture(options: { status?: string; role?: string } = {}) {
  const rows = [
    { id: 2, business_name: 'A', telegram_bot_token: 'private-a', whatsapp_access_token: 'private-wa-a' },
    { id: 3, business_name: 'B', telegram_bot_token: 'private-b', whatsapp_access_token: 'private-wa-b' },
  ];
  const memberships = [
    { business_id: 2, user_id: userA, status: options.status ?? 'active', role: options.role ?? 'owner' },
    { business_id: 3, user_id: userB, status: 'active', role: 'owner' },
  ];
  const calls: { table: string; method: string; url: URL }[] = [];
  const updates: any[] = [];
  const config = getBackendSupabaseConfiguration({ SUPABASE_URL: 'https://business-security.invalid',
    SUPABASE_SERVICE_ROLE_KEY: key, SUPABASE_ANON_KEY: 'unused-anon' });
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), key);
      assert.equal(headers.get('Authorization'), `Bearer ${key}`);
      const table = url.pathname.split('/').at(-1)!;
      const method = init?.method || 'GET';
      calls.push({ table, method, url });
      let result: Record<string, any>[];
      if (table === 'business_memberships') {
        result = memberships.filter(row => Object.entries(row).every(([column, value]) =>
          !url.searchParams.has(column) || url.searchParams.get(column) === `eq.${value}`));
      } else {
        assert.equal(table, 'businesses');
        const ids = url.searchParams.get('id')!;
        result = rows.filter(row => ids === `eq.${row.id}` || ids.slice(4, -1).split(',').includes(String(row.id)));
        if (method === 'PATCH') {
          const payload = JSON.parse(String(init?.body));
          updates.push({ id: result[0]?.id, payload });
          result.forEach(row => Object.assign(row, payload));
        }
      }
      const columns = url.searchParams.get('select')!.split(',');
      assert.ok(columns.every(column => !/access_token|bot_token|app_secret|verify_token/.test(column)));
      result = result.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const authClient: any = { auth: { getUser: async (token: string) => ({
    data: { user: token === 'a' ? { id: userA } : token === 'b' ? { id: userB } : null },
    error: ['a', 'b'].includes(token) ? null : { status: 401, code: 'bad_jwt' },
  }) } };
  const app = express();
  app.use(express.json());
  runInNewContext(executable, {
    app, supabase: client, requireAuth: createRequireAuth(authClient),
    requireBusinessPermission: (permission: any) => createRequireBusinessPermission(permission, { client }),
    getAuthorizationClient: () => client,
    applyBusinessToneConfigUpdate,
    invalidateIntegrationHealthCache: () => {},
    logOperatorApiFailure: () => {},
  });
  return { app, calls, updates, rows };
}

async function request(f: ReturnType<typeof fixture>, path = '/api/businesses', method = 'GET', body?: any, token: string | null = 'a') {
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    assert.doesNotMatch(JSON.stringify(result.body), /private-|signature|unused-anon/);
    return result;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('business list for A cannot read B or provider credentials, even with spoofed query scope', async () => {
  const f = fixture();
  const result = await request(f, '/api/businesses?businessId=3&user_id=' + userB);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.map((row: any) => row.id), [2]);
  assert.equal(f.calls.find(call => call.table === 'businesses')!.url.searchParams.get('id'), 'in.(2)');
});

test('business list for B excludes A and credentials', async () => {
  const result = await request(fixture(), '/api/businesses', 'GET', undefined, 'b');
  assert.deepEqual(result.body.data.map((row: any) => row.id), [3]);
});

test('foreign business updates fail in both directions before privileged access', async () => {
  for (const [token, id] of [['a', 3], ['b', 2]] as const) {
    const f = fixture();
    assert.equal((await request(f, `/api/businesses/${id}`, 'PUT', { businessName: 'tampered' }, token)).status, 403);
    assert.equal(f.calls.some(call => call.table === 'businesses'), false);
    assert.equal(f.updates.length, 0);
  }
});

test('authorized backend update is scoped by route/membership, ignores body tenant aliases and hides credentials', async () => {
  const f = fixture();
  const result = await request(f, '/api/businesses/2', 'PUT', { businessName: 'Updated A', businessId: 3, business_id: 3, id: 3 });
  assert.equal(result.status, 200);
  assert.deepEqual(f.updates, [{ id: 2, payload: { business_name: 'Updated A' } }]);
  assert.equal(f.rows[1].business_name, 'B');
  assert.equal(result.body.data.id, 2);
});

test('anonymous business reads and writes perform no database operations', async () => {
  for (const method of ['GET', 'PUT']) {
    const f = fixture();
    assert.equal((await request(f, method === 'GET' ? '/api/businesses' : '/api/businesses/2', method,
      method === 'PUT' ? { businessName: 'tampered' } : undefined, null)).status, 401);
    assert.equal(f.calls.length, 0);
  }
});

test('inactive and insufficient memberships cannot mutate business settings', async () => {
  for (const options of [{ status: 'revoked' }, { status: 'suspended' }, { role: 'viewer' }]) {
    const f = fixture(options);
    assert.equal((await request(f, '/api/businesses/2', 'PUT', { businessName: 'tampered' })).status, 403);
    assert.equal(f.updates.length, 0);
    assert.equal(f.calls.some(call => call.table === 'businesses'), false);
  }
});
