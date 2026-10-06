import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import test from 'node:test';
import { mappingPublicationFixture } from './reminder-mapping-publisher.test-fixture';
import { canonicalAppointmentReminder, WHATSAPP_REMINDER_LANGUAGES } from './appointment-reminder-templates';
import { createWhatsAppProvisioningRuntime } from './provisioning-runtime';
import { encryptCredential } from '../connections/credential-crypto';

// Private temporary cluster; no TCP, no normal PG credentials, no Supabase
// environment or connection string. Only this generated directory is removed.
test('atomic mapping publisher SQL contract and concurrency', {
  skip: process.env.ODINLINK_TEST_LOCAL_POSTGRES !== '1' ? 'Opt in to isolated temporary PostgreSQL' : false,
}, async t => {
  const directory = mkdtempSync('/tmp/odinlink-mapping-pg-');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null' };
  const run = (binary: string, args: string[]) => execFileSync(binary, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const connection = ['-h', directory, '-p', '55439', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
  const sql = (value: string) => run('psql', [...connection, '-c', value]).trim();
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const expression = (operation: string, payload: unknown) => `public.whatsapp_reminder_mapping_boundary(${quote(operation)}, ${quote(JSON.stringify(payload))}::jsonb)`;
  const rpc = (operation: string, payload: unknown) => JSON.parse(sql(`set role service_role; select ${expression(operation, payload)};`));
  const store = (operation: string, payload: unknown) => JSON.parse(sql(`set role service_role; select coalesce(public.channel_provisioning_store(${quote(operation)}, ${quote(JSON.stringify(payload))}::jsonb), 'null'::jsonb);`));
  const seedConnection = () => sql(`delete from public.channel_connections; insert into public.channel_connections
    (id,business_id,provider,provider_account_id,provider_connection_id,credential_ciphertext,credential_key_id,status,connected_at,reconnect_required,granted_scopes,metadata)
    values('00000000-0000-0000-0000-000000000003',3,'whatsapp','500','200','synthetic-encrypted-envelope','v1','connected',clock_timestamp(),false,
    array['business_management','whatsapp_business_management','whatsapp_business_messaging'],
    '{"whatsapp_provisioning_app_id":"100","authorizing_odinlink_user_id":"owner"}');`);
  const seed = () => {
    sql('truncate channel_provisioning.snapshots, channel_provisioning.reminder_publications, channel_provisioning.leases; update public.businesses set whatsapp_reminder_templates=null where id=3; truncate public.mapping_write_audit;');
    seedConnection();
    const state = mappingPublicationFixture();
    state.target.authorization_version = rpc('binding', { target: state.target }).authorization_version;
    const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
    store('save', { target: state.target, state, lease });
    store('release', { lease });
    return state;
  };
  const publish = (state: ReturnType<typeof seed>) => rpc('publish', { enabled: true, state });
  const configured = () => JSON.parse(sql('select coalesce(whatsapp_reminder_templates, \'null\'::jsonb) from public.businesses where id=3;'));
  const writes = () => Number(sql('select count(*) from public.mapping_write_audit;'));
  let running = false;
  try {
    run('initdb', ['-D', `${directory}/data`, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', `${directory}/data`, '-l', `${directory}/server.log`, '-o', `-F -k ${directory} -h '' -p 55439`, '-w', 'start']); running = true;
    sql(`create role service_role nologin bypassrls; create role anon; create role authenticated;
      create table public.businesses(id bigint primary key); insert into public.businesses values(3),(4);
      create table public.channel_connections(id uuid primary key,business_id bigint,provider text,provider_account_id text,provider_connection_id text,
        credential_ciphertext text,credential_key_id text,token_expires_at timestamptz,status text,connected_at timestamptz,reconnect_required boolean,
        granted_scopes text[],metadata jsonb,unique(business_id,provider));
      grant select,update on public.businesses to service_role; grant select,update on public.channel_connections to service_role;`);
    for (const migration of ['20261004201036_add_whatsapp_reminder_template_config.sql', '20261006160042_whatsapp_template_provisioning_state.sql',
      '20261006164644_whatsapp_reminder_mapping_publication.sql']) {
      run('psql', [...connection, '-f', new URL(`../../../supabase/migrations/${migration}`, import.meta.url).pathname]);
    }
    sql(`update public.businesses set whatsapp_reminder_templates='[{"keep":"tenant4"}]'::jsonb where id=4;
      create table public.mapping_write_audit(business_id bigint, mapping_count integer);
      create function public.audit_mapping_write() returns trigger language plpgsql security definer as $$begin
      insert into public.mapping_write_audit values(new.id,jsonb_array_length(new.whatsapp_reminder_templates)); return new; end;$$;
      create trigger audit_mapping_write after update of whatsapp_reminder_templates on public.businesses for each row execute function public.audit_mapping_write();`);
    await t.test('A: all 12 mappings publish in one write with a fingerprint/version', () => {
      const state = seed(), result = publish(state);
      assert.equal(result.code, 'reminder_mappings_published'); assert.equal(result.published, true);
      assert.equal(result.ready, true); assert.equal(result.version, 1); assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
      assert.deepEqual(configured(), state.mappings); assert.equal(writes(), 1);
      assert.equal(rpc('current', { target: state.target }).current, true);
      assert.equal(store('load', { target: state.target }).mappings_persisted, true);
    });
    await t.test('B: partial approval writes nothing, even through direct service RPC', () => {
      const state = seed(); state.templates[0].status = 'PENDING'; state.mapping_ready = false;
      store('queue', { target: state.target, state }); // Then save the exact candidate under its fence.
      const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
      store('save', { target: state.target, state, lease }); store('release', { lease });
      assert.equal(publish(state).published, false); assert.equal(configured(), null); assert.equal(writes(), 0);
    });
    for (const [label, change] of [
      ['C: WABA changed', "provider_connection_id='201'"], ['D: phone changed', "provider_account_id='501'"],
      ['E: encrypted credential rotated with unchanged IDs', "credential_ciphertext='rotated-envelope'"],
      ['E: authorization owner changed', "metadata=jsonb_set(metadata,'{authorizing_odinlink_user_id}','\"new-owner\"')"],
      ['E: connection revoked', "reconnect_required=true"],
    ]) await t.test(label, () => {
      const state = seed(); sql(`update public.channel_connections set ${change} where business_id=3;`);
      assert.equal(publish(state).code, 'provisioning_connection_changed'); assert.equal(configured(), null); assert.equal(writes(), 0);
    });
    await t.test('F: repeated identical publication has no update side effects', () => {
      const state = seed(), first = publish(state), second = publish(state);
      assert.equal(second.code, 'reminder_mappings_already_current'); assert.equal(second.version, first.version);
      assert.equal(second.fingerprint, first.fingerprint); assert.equal(writes(), 1);
      const stored = store('load', { target: state.target }); assert.equal(publish(stored).code, 'reminder_mappings_already_current'); assert.equal(writes(), 1);
    });
    await t.test('G: one invalid mapping, incompatible template or duplicate invalidates the entire bundle', () => {
      for (const mutate of [
        (s: ReturnType<typeof seed>) => { s.mappings[3].body_parameters.reverse(); },
        (s: ReturnType<typeof seed>) => { s.templates[0].category = 'MARKETING'; },
        (s: ReturnType<typeof seed>) => { s.templates[1] = structuredClone(s.templates[0]); },
      ]) {
        const state = seed(); mutate(state);
        const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
        store('save', { target: state.target, state, lease }); store('release', { lease });
        assert.equal(publish(state).code, 'reminder_mapping_bundle_invalid'); assert.equal(configured(), null); assert.equal(writes(), 0);
      }
    });
    await t.test('H: billing, verification and sending limits allow configuration, never full delivery readiness', () => {
      for (const limitation of ['billing', 'verification', 'phone', 'entity']) {
        const state = seed(); state.readiness.waba.payment_blocked = limitation === 'billing';
        state.readiness.waba.business_verification_limited = limitation === 'verification';
        if (limitation === 'billing') { state.readiness.waba.sending_health = 'BLOCKED'; state.readiness.delivery_ready = false; }
        if (limitation === 'phone') state.readiness.phone.health!.can_send_message = 'LIMITED';
        if (limitation === 'entity') state.readiness.reasons.push({ code: 'sending_health_limited', scope: 'waba', severity: 'warning', message: 'Limited.' });
        const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
        store('save', { target: state.target, state, lease }); store('release', { lease });
        const result = publish(state); assert.equal(result.published, true); assert.equal(result.reminder_ready, true);
        assert.equal(result.delivery_ready, false); assert.equal(result.ready, false); assert.equal(writes(), 1);
      }
    });
    await t.test('I: explicit rollout-disabled input prevents even a direct publication RPC', () => {
      const state = seed(); assert.equal(rpc('publish', { enabled: false, state }).code, 'provisioning_rollout_disabled'); assert.equal(writes(), 0);
    });
    await t.test('J: absent mapping column fails closed; no mapping write is attempted', () => {
      const state = seed(); sql('drop trigger audit_mapping_write on public.businesses; alter table public.businesses drop column whatsapp_reminder_templates;');
      try {
        assert.equal(rpc('gate', {}).supported, false); assert.equal(publish(state).code, 'provisioning_schema_missing'); assert.equal(writes(), 0);
      } finally { sql('alter table public.businesses add column whatsapp_reminder_templates jsonb; create trigger audit_mapping_write after update of whatsapp_reminder_templates on public.businesses for each row execute function public.audit_mapping_write();'); }
      // Restore the untouched second-tenant fixture after the simulated schema loss.
      sql(`update public.businesses set whatsapp_reminder_templates='[{"keep":"tenant4"}]'::jsonb where id=4;`);
    });
    await t.test('K: concurrent callers serialize into one safe final state and one business update', async () => {
      const state = seed(), exec = promisify(execFile);
      const results = await Promise.all([0, 1].map(async () => {
        const { stdout } = await exec('psql', [...connection, '-c', `begin; set role service_role; select ${expression('publish', { enabled: true, state })}; select pg_sleep(0.2); commit;`], { env, encoding: 'utf8' });
        return JSON.parse(stdout.trim().split('\n')[0]);
      }));
      assert.deepEqual(results.map(r => r.code).sort(), ['reminder_mappings_already_current', 'reminder_mappings_published']);
      assert.ok(results.every(r => r.version === 1)); assert.equal(writes(), 1); assert.deepEqual(configured(), state.mappings);
    });
    await t.test('L: another tenant is unchanged; unprivileged callers cannot publish', () => {
      const state = seed(); publish(state);
      assert.deepEqual(JSON.parse(sql('select whatsapp_reminder_templates from public.businesses where id=4;')), [{ keep: 'tenant4' }]);
      assert.equal(sql("select has_function_privilege('anon','public.whatsapp_reminder_mapping_boundary(text,jsonb)','execute');"), 'f');
      assert.throws(() => sql(`set role anon; select ${expression('publish', { enabled: true, state })};`));
    });
    await t.test('new reconciliation invalidates old candidates and replaces the full verified bundle', () => {
      const old = seed(), first = publish(old), state = structuredClone(old);
      state.templates[0].template_id = '9999'; state.readiness.templates[0].template_id = '9999';
      state.mappings.filter(m => m.booking_language === 'en').forEach(m => { m.template_id = '9999'; });
      const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
      store('save', { target: state.target, state, lease }); store('release', { lease });
      assert.equal(publish(old).code, 'template_reconciliation_unverified');
      const replacement = publish(state); assert.equal(replacement.version, 2); assert.notEqual(replacement.fingerprint, first.fingerprint);
      assert.deepEqual(configured(), state.mappings); assert.equal(writes(), 2);
      sql("update public.businesses set whatsapp_reminder_templates='[]'::jsonb where id=3;");
      assert.equal(rpc('current', { target: state.target }).current, false);
    });
    await t.test('stale reconciliation cannot publish or overwrite the configured bundle', () => {
      const state = seed(); state.readiness.checked_at = new Date(Date.now() - 181000).toISOString();
      const lease = store('acquire', { resource_key: 'whatsapp:200', owner: '00000000-0000-0000-0000-000000000001', ttl_ms: 180000 });
      store('save', { target: state.target, state, lease }); store('release', { lease });
      assert.equal(publish(state).code, 'template_reconciliation_unverified'); assert.equal(writes(), 0);
    });
    await t.test('failure after business update rolls back the mapping, receipt and snapshot together', () => {
      const state = seed(); sql('alter table channel_provisioning.reminder_publications add constraint simulate_failure check(false) not valid;');
      try {
        assert.throws(() => publish(state)); assert.equal(configured(), null); assert.equal(writes(), 0);
        assert.equal(store('load', { target: state.target }).mappings_persisted, false);
      } finally { sql('alter table channel_provisioning.reminder_publications drop constraint simulate_failure;'); }
    });
    await t.test('runtime queues, reconciles and publishes through the rollout gate with authoritative connection revision', async () => {
      const state = seed(), oldFetch = globalThis.fetch;
      const keys = ['WHATSAPP_TEMPLATE_PROVISIONING_ENABLED', 'META_APP_ID', 'CHANNEL_CREDENTIAL_ENCRYPTION_KEY'] as const;
      const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED = 'true'; process.env.META_APP_ID = '100';
      process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
      const token = 'synthetic-runtime-token';
      try {
        const envelope = encryptCredential({ accessToken: token });
        sql(`update public.channel_connections set credential_ciphertext=${quote(envelope)} where business_id=3;`);
        const calls: string[] = [];
        globalThis.fetch = async (address, init) => {
          assert.equal(init?.method || 'GET', 'GET'); // No messages or provider writes in this test.
          const path = new URL(String(address)).pathname.replace(/^\/v\d+\.\d+\//u, ''); calls.push(path);
          const responses: Record<string, unknown> = {
            debug_token: { data: { is_valid: true, app_id: '100', user_id: '400', scopes: state.readiness.authorization.effective_scopes } },
            '200': { id: '200', name: 'Selected', owner_business_info: { id: '300', name: 'Owner' }, business_verification_status: 'verified' },
            '500': { id: '500', status: 'CONNECTED', platform_type: 'CLOUD_API', account_mode: 'LIVE', name_status: 'APPROVED',
              health_status: { can_send_message: 'AVAILABLE', entities: [{ entity_type: 'WABA', id: '200', can_send_message: 'AVAILABLE', errors: [] }] } },
            '200/phone_numbers': { data: [{ id: '500' }] }, '200/assigned_users': { data: [{ id: '400', tasks: ['MANAGE'] }] },
            '200/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '100' } }] },
            '200/message_templates': { data: WHATSAPP_REMINDER_LANGUAGES.map((lang, index) => ({ ...canonicalAppointmentReminder(lang), id: String(6000 + index), status: 'APPROVED' })) },
          };
          assert.ok(path in responses); return new Response(JSON.stringify(responses[path]), { status: 200 });
        };
        const client: any = {
          rpc: async (name: string, args: any) => ({ data: name === 'channel_provisioning_store' ? store(args.p_operation, args.p_payload) : rpc(args.p_operation, args.p_payload), error: null }),
          from: (name: string) => {
            assert.equal(name, 'channel_connections');
            const filters = new Map<string, unknown>(); const query: any = { select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
              maybeSingle: async () => {
                assert.equal(filters.get('business_id'), 3); assert.equal(filters.get('provider'), 'whatsapp');
                return { data: JSON.parse(sql('select to_jsonb(c) from public.channel_connections c where business_id=3;')), error: null };
              } };
            return query;
          },
        };
        const runtime = createWhatsAppProvisioningRuntime(client);
        const queued = await runtime.provision({ authorization: { businessId: 3, appId: '100', authorizingUserId: 'owner', accessToken: token }, wabaId: '200', phoneNumberId: '500' }, state.readiness);
        assert.equal(queued.code, 'provisioning_queued'); assert.equal(writes(), 0); assert.equal(calls.length, 0);
        const results = await runtime.reconcileDue();
        assert.equal(results.length, 1); assert.equal(results[0]?.mappings_persisted, true); assert.equal(results[0]?.readiness.ready, true);
        assert.equal(configured().length, 12); assert.equal(writes(), 1);
        const status = await runtime.status(3); assert.equal(status?.mappings_persisted, true); assert.equal(status?.readiness.ready, true);
        assert.equal(status?.publication?.version, 1); assert.doesNotMatch(JSON.stringify(status), /synthetic-runtime-token/);
        assert.deepEqual(await runtime.reconcileDue(), []); assert.equal(writes(), 1);
        process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED = 'false';
        assert.deepEqual(await runtime.reconcileDue(), []); assert.equal(writes(), 1);
      } finally {
        globalThis.fetch = oldFetch;
        for (const key of keys) { if (previous[key] == null) delete process.env[key]; else process.env[key] = previous[key]; }
      }
    });
  } finally {
    if (running) run('pg_ctl', ['-D', `${directory}/data`, '-m', 'immediate', '-w', 'stop']);
    rmSync(directory, { recursive: true, force: true });
  }
});
