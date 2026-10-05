import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import test from 'node:test';
import { getBackendSupabaseConfiguration } from './backend-supabase';

const url = 'https://credential-selection.invalid';
const jwt = (role: string) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role })).toString('base64url'),
  Buffer.from('synthetic-signature').toString('base64url'),
].join('.');

test('backend selects only the privileged credential and normalizes surrounding whitespace', () => {
  assert.deepEqual(getBackendSupabaseConfiguration({
    SUPABASE_URL: ` ${url} `,
    SUPABASE_SERVICE_ROLE_KEY: ` ${jwt('service_role')} `,
    SUPABASE_ANON_KEY: jwt('anon'),
  }), { url, serviceRoleKey: jwt('service_role') });
});

test('modern secret credential is allowed in the existing server-only variable', () => {
  assert.equal(getBackendSupabaseConfiguration({
    SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic-backend-key',
  }).serviceRoleKey, 'sb_secret_synthetic-backend-key');
});

test('installed SDK sends the selected service credential, with no user-session substitution', async () => {
  const { url: selectedUrl, serviceRoleKey } = getBackendSupabaseConfiguration({
    SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'), SUPABASE_ANON_KEY: jwt('anon'),
  });
  let requests = 0;
  const client = createClient(selectedUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (_input, init) => {
      requests += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), serviceRoleKey);
      assert.equal(headers.get('authorization'), `Bearer ${serviceRoleKey}`);
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const { error } = await client.from('businesses').select('id');
  assert.equal(error, null);
  assert.equal(requests, 1);
});

for (const missing of [undefined, '', '   ']) {
  test(`missing service credential (${JSON.stringify(missing)}) cannot fall back to anon`, () => {
    assert.throws(() => getBackendSupabaseConfiguration({
      SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: missing, SUPABASE_ANON_KEY: jwt('anon'),
    }), { message: 'backend_supabase_service_configuration_missing' });
  });
}

for (const role of ['anon', 'authenticated']) {
  test(`${role} JWT mislabeled as a service key fails closed`, () => {
    assert.throws(() => getBackendSupabaseConfiguration({
      SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: jwt(role),
    }), { message: 'backend_supabase_service_credential_invalid' });
  });
}

test('malformed and public credentials fail without disclosing their values', () => {
  for (const key of ['sb_publishable_synthetic-key', 'malformed-sensitive-key', 'e30.bm90LWpzb24.c2ln', 'sb_secret_']) {
    assert.throws(() => getBackendSupabaseConfiguration({
      SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key,
    }), error => {
      assert.equal((error as Error).message, 'backend_supabase_service_credential_invalid');
      assert.ok(!String(error).includes(key));
      return true;
    });
  }
});

test('missing URL cannot create a privileged backend client', () => {
  assert.throws(() => getBackendSupabaseConfiguration({
    SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
  }), { message: 'backend_supabase_service_configuration_missing' });
});

for (const nodeEnv of ['production', 'test']) {
  test(`actual server import refuses configured anonymous fallback in ${nodeEnv}`, () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval',
      "import('./server.ts').catch(error => { console.error(error.message); process.exitCode = 1; })",
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env, NODE_ENV: nodeEnv, DOTENV_CONFIG_PATH: '/dev/null',
        SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: jwt('anon'),
      },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /backend_supabase_service_configuration_missing/);
    assert.ok(!`${child.stdout}${child.stderr}`.includes(jwt('anon')));
  });
}

test('production server refuses startup when all database credentials are absent', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval',
    "import('./server.ts').catch(error => { console.error(error.message); process.exitCode = 1; })",
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env, NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/dev/null',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '',
    },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /backend_supabase_service_configuration_missing/);
});
