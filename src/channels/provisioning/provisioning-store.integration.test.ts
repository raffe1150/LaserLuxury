import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';

// Explicit opt-in, private Unix socket, no TCP, no user PG credentials/config.
// This harness cannot connect to production or the developer's normal database.
test('durable provisioning RPC enforces roles, tenant scope, fences and crash-safe intents', {
  skip: process.env.ODINLINK_TEST_LOCAL_POSTGRES !== '1' ? 'Opt in to an isolated temporary PostgreSQL cluster' : false,
}, () => {
  const directory = mkdtempSync('/tmp/odinlink-provisioning-pg-');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null' };
  const run = (binary: string, args: string[]) => execFileSync(binary, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const connection = ['-h', directory, '-p', '55439', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
  let running = false;
  try {
    run('initdb', ['-D', `${directory}/data`, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', `${directory}/data`, '-l', `${directory}/server.log`, '-o', `-F -k ${directory} -h '' -p 55439`, '-w', 'start']);
    running = true;
    run('psql', [...connection, '-c', 'create role service_role nologin bypassrls; create role anon; create role authenticated; create table public.businesses(id bigint primary key); insert into public.businesses values(3),(4);']);
    run('psql', [...connection, '-f', new URL('../../../supabase/migrations/20261006160042_whatsapp_template_provisioning_state.sql', import.meta.url).pathname]);
    const sqlQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const rpc = (operation: string, payload: unknown) => JSON.parse(run('psql', [...connection, '-c',
      `set role service_role; select coalesce(public.channel_provisioning_store(${sqlQuote(operation)}, ${sqlQuote(JSON.stringify(payload))}::jsonb), 'null'::jsonb);`]).trim());
    assert.equal(run('psql', [...connection, '-c', "select has_function_privilege('anon', 'public.channel_provisioning_store(text,jsonb)', 'execute');"]).trim(), 'f');
    assert.equal(run('psql', [...connection, '-c', "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='channel_provisioning' and c.relrowsecurity;"]).trim(), '3');
    const lease = rpc('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
    assert.ok(lease.fence);
    assert.equal(rpc('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000002', ttl_ms: 180000 }), null);
    const target = { provider: 'whatsapp', business_id: 3, asset_id: '200', identity_id: '500', app_id: '100', authorizing_user_id: 'owner' };
    const state = { target, mappings: [], next_check_at: 0 };
    rpc('save', { target, state, lease });
    assert.deepEqual(rpc('load', { target }), state);
    assert.equal(rpc('load', { target: { ...target, business_id: 4 } }), null);
    assert.equal(rpc('targets_due', { provider: 'whatsapp', limit: 25 }).length, 1);
    assert.equal(rpc('targets_for_asset', { provider: 'whatsapp', asset_id: '999' }).length, 0);
    const queuedTarget = { ...target, business_id: 4 };
    rpc('queue', { target: queuedTarget, state: { ...state, target: queuedTarget, code: 'provisioning_queued' } });
    assert.equal(rpc('load', { target: queuedTarget }).code, 'provisioning_queued');
    // New authorization must queue even while an older worker owns the WABA.
    const replacementTarget = { ...target, authorizing_user_id: 'new-owner' };
    rpc('queue', { target: replacementTarget, state: { ...state, target: replacementTarget, code: 'provisioning_queued' } });
    assert.throws(() => rpc('save', { target, state, lease }));
    assert.equal(rpc('load', { target: replacementTarget }).target.authorizing_user_id, 'new-owner');
    assert.throws(() => rpc('save', { target, lease, state: { ...state, accessToken: 'synthetic-token' } }));
    assert.throws(() => rpc('save', { target, lease, state: { ...state, mappings: [{ business_id: '4', waba_id: '200', phone_number_id: '500' }] } }));
    assert.throws(() => rpc('claim', { key: 'whatsapp:999:appointment_reminder:en', lease }));
    const key = 'whatsapp:200:appointment_reminder:en';
    assert.equal(rpc('claim', { key, lease }).claimed, true);
    // Crash before settle: reservation still prevents another submission.
    assert.equal(rpc('claim', { key, lease }).claimed, false);
    rpc('settle', { lease, intent: { key, state: 'uncertain', code: 'template_meta_error', asset_id: null, retry_at: null, provider_code: null } });
    assert.equal(rpc('claim', { key, lease }).claimed, false);
    const rateKey = 'whatsapp:200:appointment_reminder:sv'; rpc('claim', { key: rateKey, lease });
    rpc('settle', { lease, intent: { key: rateKey, state: 'retryable', code: 'template_creation_rate_limited', asset_id: null, retry_at: Date.now() + 60000, provider_code: 4 } });
    assert.equal(rpc('claim', { key: rateKey, lease }).claimed, false);
    const expiredKey = 'whatsapp:200:appointment_reminder:de'; rpc('claim', { key: expiredKey, lease });
    rpc('settle', { lease, intent: { key: expiredKey, state: 'retryable', code: 'template_creation_rate_limited', asset_id: null, retry_at: 0, provider_code: 4 } });
    assert.equal(rpc('claim', { key: expiredKey, lease }).claimed, true);
    rpc('release', { lease });
    const newLease = rpc('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000002', ttl_ms: 180000 });
    assert.notEqual(lease.fence, newLease.fence);
    assert.equal(rpc('renew', { lease, ttl_ms: 180000 }), false);
    assert.throws(() => rpc('save', { target, state, lease }));
    assert.equal(rpc('claim', { key, lease: newLease }).claimed, false);
    rpc('release', { lease: newLease });
  } finally {
    if (running) run('pg_ctl', ['-D', `${directory}/data`, '-m', 'immediate', '-w', 'stop']);
    rmSync(directory, { recursive: true, force: true });
  }
});
