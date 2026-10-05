import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createRequireAuth } from '../../src/auth/require-auth';
import { createRequireBusinessPermission } from '../../src/auth/require-business-access';
import { getBackendSupabaseConfiguration } from '../../src/auth/backend-supabase';
import { applyBusinessToneConfigUpdate } from '../../src/business/business-tone-update';
import { createSalonListHandler, createSalonCreateHandler } from '../../src/business/salons-api';
import { createTelegramSetupHandler } from '../../src/channels/telegram-setup';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrations = [
  '20261005095355_harden_business_membership_integrity.sql',
  '20261005111021_restrict_salons_to_backend_access.sql',
  '20261005111029_prepare_businesses_backend_only_rls.sql',
].map(name => fileURLToPath(new URL('../../supabase/migrations/' + name, import.meta.url)));
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const key = 'synthetic.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
const available = ['initdb', 'pg_ctl', 'psql', 'pg_dump'].every(command => {
  try { execFileSync(command, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
});

test('production-shaped security rollout, real PostgreSQL privileges, APIs and exact rollback', {
  skip: available ? false : 'local PostgreSQL executables unavailable',
  timeout: 120_000,
}, async t => {
  // Never consume PG*/DATABASE_URL/Supabase environment configuration.
  // Unix socket only, isolated cluster, synthetic identities and credentials.
  // Short path avoids macOS's 104-byte Unix-socket pathname limit.
  const directory = mkdtempSync('/tmp/odin-sec-');
  const data = join(directory, 'data');
  const socket = join(directory, 'socket');
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  const execute = (command: string, args: string[]) => execFileSync(command, args, {
    env, encoding: 'utf8', stdio: 'pipe', timeout: 20_000,
  }).trim();
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55447', '-U', 'postgres', '-d', 'postgres'];
  const query = (sql: string) => execute('psql', [...args, '-c', sql]);
  const apply = (index: number) => execute('psql', [...args, ...(index === 0 ? ['-1'] : []), '-f', migrations[index]]);
  const denied = (sql: string, pattern = /permission denied/) => {
    assert.throws(() => query(sql), (error: any) => pattern.test(String(error.stderr)));
  };
  const snapshot = () => query(`select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,relacl::text) order by relname)
      from pg_class where oid in ('businesses'::regclass,'salons'::regclass,'business_memberships'::regclass)),
    'sequence',(select relacl::text from pg_class where oid='businesses_id_seq'::regclass),
    'comment',col_description('business_memberships'::regclass,(select attnum from pg_attribute where attrelid='business_memberships'::regclass and attname='business_id'))) `);
  let started = false;
  try {
    mkdirSync(socket);
    execute('initdb', ['-D', data, '-U', 'postgres', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject']);
    execute('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-k ${socket} -p 55447 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    execute('psql', [...args, '-f', join(here, 'production-shaped-fixture.sql')]);
    execute('psql', [...args, '-f', join(here, 'rollout-checks.sql')]);
    const before = snapshot();
    writeFileSync(join(directory, 'prior-access.json'), before);
    execute('pg_dump', ['-h', socket, '-p', '55447', '-U', 'postgres', '-d', 'postgres', '--schema-only', '-f', join(directory, 'prior-schema.sql')]);

    await t.test('businesses migration fails closed before validated membership FK', () => {
      assert.throws(() => apply(2), (e: any) => /businesses_membership_fk_not_validated/.test(String(e.stderr)));
      assert.equal(snapshot(), before);
    });
    await t.test('membership migration rolls back atomically on orphan data', () => {
      query(`insert into business_memberships(business_id,user_id,role) values(999,'${userA}','owner')`);
      assert.throws(() => apply(0), (e: any) => /violates foreign key/.test(String(e.stderr)));
      assert.equal(query("select count(*) from pg_constraint where conname='business_memberships_business_id_fkey'"), '0');
      assert.equal(snapshot(), before);
      query('delete from business_memberships where business_id=999');
    });
    await t.test('all three exact migration files execute in dependency order', () => {
      migrations.forEach((_, index) => apply(index));
      execute('psql', [...args, '-f', join(here, 'rollout-checks.sql')]);
      assert.equal(query("select relrowsecurity from pg_class where oid='businesses'::regclass"), 't');
      assert.equal(query("select count(*) from pg_policy where polrelid='businesses'::regclass"), '0');
      assert.equal(query("select convalidated from pg_constraint where conname='business_memberships_business_id_fkey'"), 't');
      assert.equal(query("select relrowsecurity from pg_class where oid='salons'::regclass"), 'f');
      assert.equal(query("select count(*) from salons where salon_name='chichi' and business_id='chi'"), '1');
    });
    await t.test('rerun: membership fails without changes; salons/businesses succeed', () => {
      const restricted = snapshot();
      assert.throws(() => apply(0), (e: any) => /already exists/.test(String(e.stderr)));
      assert.equal(snapshot(), restricted);
      apply(1); apply(2);
      assert.equal(snapshot(), restricted);
    });
    await t.test('anon and authenticated businesses/salons CRUD and sequence access denied', () => {
      for (const role of ['anon', 'authenticated']) {
        for (const table of ['businesses', 'salons']) {
          denied(`set role ${role}; select * from ${table}`);
          denied(`set role ${role}; insert into ${table} default values`);
          denied(`set role ${role}; update ${table} set ${table === 'salons' ? 'salon_name' : 'business_name'}='bad'`);
          denied(`set role ${role}; delete from ${table}`);
          assert.equal(query(`select has_table_privilege('${role}','${table}','TRUNCATE')`), 'f');
        }
        denied(`set role ${role}; select nextval('businesses_id_seq')`);
      }
    });
    await t.test('authenticated own active membership reads survive; mutation/truncate denied', () => {
      for (const [user, id] of [[userA, 2], [userB, 3]]) {
        assert.equal(query(`set role authenticated; set request.jwt.claim.sub='${user}'; select business_id from business_memberships`), String(id));
        assert.equal(query(`set role authenticated; set request.jwt.claim.sub='${user}'; select count(*) from business_memberships where business_id<>${id}`), '0');
      }
      denied('set role anon; select * from business_memberships');
      denied('set role authenticated; delete from business_memberships');
      denied('set role authenticated; truncate business_memberships');
      query(`update business_memberships set status='suspended' where business_id=2`);
      assert.equal(query(`set role authenticated; set request.jwt.claim.sub='${userA}'; select count(*) from business_memberships`), '0');
      query("update business_memberships set status='active' where business_id=2");
    });
    await t.test('service_role businesses/salons CRUD and identity sequence survive', () => {
      assert.equal(query(`begin; set local role service_role;
        insert into businesses(business_name) values('Disposable') returning id;
        update businesses set business_name='Disposable edited' where business_name='Disposable';
        delete from businesses where business_name='Disposable edited';
        insert into salons(salon_name,business_id) values('Disposable','disposable');
        update salons set status='edited' where business_id='disposable';
        delete from salons where business_id='disposable';
        select count(*) from salons where business_id='chi'; rollback;`).split('\n').at(-1), '1');
      assert.equal(query("set role service_role; select count(*) from businesses where telegram_bot_token is not null"), '2');
    });
    await t.test('direct business delete cascades membership; appointments block delete atomically', () => {
      const cascading = ['business_notifications','knowledge_sources','booking_slot_reservations','booking_result_outbox',
        'channel_connections','channel_authorization_sessions','calendar_connections','calendar_authorization_sessions','knowledge_chunks'];
      query(`begin; insert into businesses(id,business_name) values(80,'Cascade');
        insert into business_memberships(business_id,user_id,role) values(80,'${userA}','owner');
        ${cascading.map(table => 'insert into ' + table + '(business_id) values(80);').join('\n')}
        delete from businesses where id=80; commit;`);
      assert.equal(query('select count(*) from business_memberships where business_id=80'), '0');
      for (const table of cascading) assert.equal(query('select count(*) from ' + table + ' where business_id=80'), '0');
      query('insert into appointments(business_id) values(2)');
      denied('delete from businesses where id=2', /violates foreign key/);
      denied('set role service_role; select delete_business_with_memberships(2)', /violates foreign key/);
      assert.equal(query('select count(*) from business_memberships where business_id=2'), '1');
      query('delete from appointments where business_id=2');
    });
    await t.test('real production SECURITY INVOKER onboarding/delete RPCs work as service_role', () => {
      const id = query(`set role service_role; select (create_business_with_owner('${userA}','RPC created',null,null,null,null,null,null,null,false)->>'id')`);
      assert.equal(query(`select count(*) from business_memberships where business_id=${id} and status='active' and role='owner'`), '1');
      assert.equal(query(`set role service_role; select delete_business_with_memberships(${id})`), 't');
      assert.equal(query(`select count(*) from business_memberships where business_id=${id}`), '0');
      denied(`set role authenticated; select delete_business_with_memberships(2)`);
    });

    // This deliberately limited PostgREST adapter executes every supported request
    // as the real service_role in PostgreSQL. JWT verification, REST schema cache,
    // GraphQL, pooler and provider delivery are NOT emulated.
    const literal = (value: unknown) => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
    const identifier = (value: string) => {
      assert.match(value, /^[a-z_][a-z0-9_]*$/);
      return '"' + value + '"';
    };
    const dbClient = createClient(getBackendSupabaseConfiguration({
      SUPABASE_URL: 'https://local-security.invalid', SUPABASE_SERVICE_ROLE_KEY: key,
    }).url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('apikey'), key);
        assert.equal(headers.get('Authorization'), 'Bearer ' + key);
        const url = new URL(String(input));
        const table = identifier(url.pathname.split('/').at(-1)!);
        const columns = url.searchParams.get('select') || '*';
        const projection = columns === '*' ? '*' : columns.split(',').map(identifier).join(',');
        const filters: string[] = [];
        for (const [column, expression] of url.searchParams) {
          if (column === 'select' || column === 'columns' || column === 'order') continue;
          const name = identifier(column);
          if (expression.startsWith('eq.')) filters.push(name + '=' + literal(expression.slice(3)));
          else if (expression.startsWith('in.(')) filters.push(name + ' IN (' + expression.slice(4, -1).split(',').map(literal).join(',') + ')');
          else if (expression === 'not.is.null') filters.push(name + ' IS NOT NULL');
          else throw new Error('unsupported local REST filter');
        }
        const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
        const method = init?.method || 'GET';
        let statement: string;
        if (method === 'GET') {
          const order = url.searchParams.get('order');
          if (order) assert.equal(order, 'id.asc');
          statement = 'SELECT ' + projection + ' FROM ' + table + where + (order ? ' ORDER BY id ASC' : '');
        }
        else {
          const parsedBody = JSON.parse(String(init?.body));
          const body = Array.isArray(parsedBody) ? parsedBody[0] : parsedBody;
          const values = Object.entries(body);
          if (method === 'POST') statement = 'INSERT INTO ' + table + '(' + values.map(([c]) => identifier(c)).join(',') +
            ') VALUES(' + values.map(([,v]) => literal(typeof v === 'object' ? JSON.stringify(v) : v)).join(',') + ') RETURNING ' + projection;
          else {
            assert.equal(method, 'PATCH');
            statement = 'UPDATE ' + table + ' SET ' + values.map(([c,v]) => identifier(c) + '=' + literal(typeof v === 'object' ? JSON.stringify(v) : v)).join(',') + where + ' RETURNING ' + projection;
          }
        }
        const rows = JSON.parse(query('begin; set local role service_role; WITH result AS (' + statement +
          ") SELECT coalesce(jsonb_agg(result),'[]'::jsonb) FROM result; commit;"));
        const single = headers.get('Accept')?.includes('vnd.pgrst.object');
        return new Response(JSON.stringify(single ? rows[0] : rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    } });
    const auth: any = { auth: { getUser: async (token: string) => ({
      data: { user: token === 'a' ? { id: userA } : token === 'b' ? { id: userB } : null },
      error: ['a','b'].includes(token) ? null : { code: 'bad_jwt', status: 401 },
    }) } };
    const app = express(); app.use(express.json());
    const requireAuth = createRequireAuth(auth);
    const permission = (p: any) => createRequireBusinessPermission(p, { client: dbClient });
    const bodyPermission = createRequireBusinessPermission('settings.manage', { client: dbClient, resolveBusinessId: req => req.body.businessId ?? req.body.business_id });
    const source = readFileSync(fileURLToPath(new URL('../../server.ts', import.meta.url)), 'utf8');
    const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
    const statements: string[] = []; let projection = ''; let startupPoller = ''; let bootstrap = '';
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.getText(parsed).includes("Supabase not configured for isolated tests.")) bootstrap = node.getText(parsed);
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'DASHBOARD_BUSINESS_COLUMNS') projection = node.initializer!.getText(parsed);
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'startAllBusinessTelegramPollers') startupPoller = node.getText(parsed);
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const call = node.expression;
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(parsed) === 'app' &&
          ts.isStringLiteral(call.arguments[0]) && ((call.expression.name.text === 'get' && call.arguments[0].text === '/api/businesses') ||
          (call.expression.name.text === 'put' && call.arguments[0].text === '/api/businesses/:id'))) statements.push(node.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed); assert.equal(statements.length, 2); assert.ok(projection); assert.ok(startupPoller);
    await t.test('actual production database bootstrap accepts only privileged configuration', () => {
      assert.ok(bootstrap);
      const code = ts.transpileModule(bootstrap, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const context: any = { supabase: null, getBackendSupabaseConfiguration: () => getBackendSupabaseConfiguration({
        SUPABASE_URL: 'https://local-security.invalid', SUPABASE_SERVICE_ROLE_KEY: key,
      }), process: { env: { NODE_ENV: 'production' } }, console: { log: () => {}, warn: () => {} },
        createClient: (url: string, selected: string, options: any) => {
          assert.equal(url, 'https://local-security.invalid'); assert.equal(selected, key);
          assert.equal(options.auth.persistSession, false); assert.equal(options.auth.autoRefreshToken, false);
          return dbClient;
        },
      };
      runInNewContext(code, context);
      assert.equal(context.supabase, dbClient);
      for (const supplied of [undefined, 'synthetic.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.signature']) {
        assert.throws(() => runInNewContext(code, { ...context, supabase: null,
          getBackendSupabaseConfiguration: () => getBackendSupabaseConfiguration({
            SUPABASE_URL: 'https://local-security.invalid', SUPABASE_SERVICE_ROLE_KEY: supplied, SUPABASE_ANON_KEY: 'unused',
          }),
        }), /backend_supabase_service_/);
      }
    });
    runInNewContext(ts.transpileModule('const DASHBOARD_BUSINESS_COLUMNS=' + projection + ';' + statements.join('\n'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      app, supabase: dbClient, requireAuth, requireBusinessPermission: permission,
      getAuthorizationClient: () => dbClient, applyBusinessToneConfigUpdate,
      invalidateIntegrationHealthCache: () => {}, logOperatorApiFailure: () => {},
    });
    const deps = { client: dbClient, getAuthorizationClient: () => dbClient, onFailure: () => {} };
    app.get('/api/salons', requireAuth, createSalonListHandler(deps));
    app.post('/api/salons', requireAuth, bodyPermission, createSalonCreateHandler(deps));
    const saved: any[] = []; const polled: any[] = [];
    app.post('/api/setup-telegram', requireAuth, bodyPermission, createTelegramSetupHandler({
      client: dbClient, normalizeToken: token => token.trim(),
      buildConfig: async row => ({ businessId: row.id, telegramToken: row.telegram_bot_token }),
      saveConfig: c => { saved.push(c); }, startPolling: c => { polled.push(c); }, onFailure: () => {},
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const request = async (path: string, method = 'GET', body?: any, token: string | null = 'a') => {
      const result = await fetch('http://127.0.0.1:' + address.port + path, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = { status: result.status, body: await result.json() };
      assert.doesNotMatch(JSON.stringify(response.body), /private-|signature/);
      return response;
    };
    try {
      await t.test('actual business API handlers work with grants/RLS; isolate tenant and credentials', async () => {
        const listed = await request('/api/businesses?businessId=3');
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        assert.deepEqual(listed.body.data.map((r: any) => r.id), [2]);
        assert.deepEqual((await request('/api/businesses','GET',undefined,'b')).body.data.map((r: any) => r.id), [3]);
        assert.equal((await request('/api/businesses','GET',undefined,null)).status, 401);
        assert.equal((await request('/api/businesses/3','PUT',{ businessName: 'Bad' })).status, 403);
        assert.equal((await request('/api/businesses/2','PUT',{ businessName: 'Edited A', businessId: 3 })).status, 200);
        assert.equal(query("select business_name from businesses where id=3"), 'Synthetic B');
      });
      await t.test('protected salon APIs work; legacy row preserved; cross-tenant list/create denied', async () => {
        assert.equal((await request('/api/salons','GET',undefined,null)).status, 401);
        assert.deepEqual((await request('/api/salons')).body, []);
        assert.equal((await request('/api/salons','POST',{ salonName: 'A', businessId: 3 })).status, 403);
        assert.equal((await request('/api/salons','POST',{ salonName: 'A', businessId: 2, business_id: 'chi' })).status, 403);
        assert.equal((await request('/api/salons','POST',{ salonName: 'A', businessId: 2 })).status, 200);
        assert.deepEqual((await request('/api/salons?businessId=3')).body.map((r: any) => r.business_id), ['2']);
        assert.deepEqual((await request('/api/salons','GET',undefined,'b')).body, []);
        assert.equal(query("select count(*) from salons where salon_name='chichi' and business_id='chi'"), '1');
      });
      await t.test('Telegram setup remains authorized and cannot resolve another tenant', async () => {
        assert.equal((await request('/api/setup-telegram','POST',{ businessId: 2, telegramToken: 'private-a' })).status, 200);
        assert.equal((await request('/api/setup-telegram','POST',{ businessId: 3, telegramToken: 'private-b' })).status, 403);
        assert.equal((await request('/api/setup-telegram','POST',{ businessId: 2, telegramToken: 'private-b' })).status, 403);
        assert.equal(saved.length, 1); assert.equal(polled.length, 1); assert.equal(saved[0].businessId, 2);
      });
      await t.test('actual background Telegram startup reads privileged rows under RLS', async () => {
        const started: number[] = [];
        const context: any = {
          supabase: dbClient, activeConfig: {}, process: { env: {} }, console,
          normalizeTelegramBotToken: (v: string) => v.trim(), logTelegramTokenSource: () => {},
          loadFreshBusinessConfigByTelegramToken: async (token: string) => ({
            businessId: token === 'private-a' ? 2 : 3, telegramBusinessResolved: true,
          }),
          startTelegramPolling: async (c: any) => { started.push(c.businessId); },
        };
        runInNewContext(ts.transpileModule(startupPoller + '\nthis.run=startAllBusinessTelegramPollers;',
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
        await context.run();
        assert.deepEqual(started.sort(), [2,3]);
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await t.test('reverse rollback restores exact prior ACL/RLS/comment without deleting rows', () => {
      const memberships = query('select jsonb_agg(m order by business_id) from business_memberships m');
      const salons = query('select jsonb_agg(s order by business_id) from salons s');
      for (const file of ['rollback-businesses.sql','rollback-salons.sql','rollback-memberships.sql']) {
        execute('psql', [...args, '-f', join(here,file)]);
      }
      assert.equal(snapshot(), before);
      assert.equal(query('select jsonb_agg(m order by business_id) from business_memberships m'), memberships);
      assert.equal(query('select jsonb_agg(s order by business_id) from salons s'), salons);
      assert.equal(query("select count(*) from pg_constraint where conname='business_memberships_business_id_fkey'"), '0');
      assert.equal(query('set role anon; select count(*) from businesses'), '2');
      assert.equal(query('set role anon; select count(*) from salons'), '2');
    });
    await t.test('reapplication after rollback succeeds without data loss', () => {
      migrations.forEach((_,index) => apply(index));
      assert.equal(query('select count(*) from business_memberships'), '2');
      assert.equal(query("select count(*) from salons where business_id='chi'"), '1');
    });
    await t.test('earlier reminder migrations coexist with security grants and RLS without configuring templates', () => {
      query("create table chat_history(id bigint primary key, business_id bigint, user_id text, platform text, sender text, created_at timestamptz default now())");
      const reminderFiles = ['20261004130125_add_chat_history_provider_event_time.sql',
        '20261004201036_add_whatsapp_reminder_template_config.sql'];
      for (const name of reminderFiles) execute('psql', [...args, '-f',
        fileURLToPath(new URL('../../supabase/migrations/' + name, import.meta.url))]);
      apply(1); apply(2);
      assert.equal(query("select count(*) from businesses where whatsapp_reminder_templates is not null"), '0');
      assert.equal(query("select count(*) from information_schema.columns where table_schema='public' and table_name='chat_history' and column_name in ('provider_event_at','reminder_provider_time_cutover_at')"), '2');
      denied('set role anon; select whatsapp_reminder_templates from businesses');
      assert.equal(query('set role service_role; select count(*) from businesses'), '2');
    });
  } finally {
    if (started) execute('pg_ctl', ['-D',data,'-m','immediate','-w','stop']);
    rmSync(directory, { recursive: true, force: true });
  }
});
