import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SupabaseKnowledgeLifecycleRepository } from './supabase-knowledge-lifecycle-repository';
import { KnowledgeRunner, deliverKnowledge } from './knowledge-runner';
import type { KnowledgeScope, VerifiedKnowledge } from './knowledge-lifecycle';
const bin = '/opt/homebrew/opt/postgresql@17/bin/';
const literal = (v: any): string => v === null ? 'NULL' : typeof v === 'number' ? String(v) :
  "'" + (typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''") + "'" + (typeof v === 'object' ? '::jsonb' : '');
const identifier = (v: string) => { assert.match(v, /^[a-z_][a-z_0-9]*$/); return '"' + v + '"'; };

/** Private initdb only; no URL, project env, network or existing DB accepted. */
test('real repository + runner on disposable PostgreSQL: claims, restart, authority, dedup and uncertain delivery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'odin-slice2-')); const socket = join(root, 'socket'); mkdirSync(socket, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const run = (name: string, args: string[], input?: string) => {
    const p = spawnSync(bin + name, args, { env, input, encoding: 'utf8', timeout: 25000 });
    if (p.status !== 0) throw new Error(name + ': ' + p.stderr);
    return p.stdout.trim();
  };
  let started = false;
  const sql = (query: string) => run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55439', '-U', 'postgres', '-d', 'postgres'], query);
  const rpcNames = ['odin_accept_knowledge_turn_v1', 'odin_transition_knowledge_v1'];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.ok(rpcNames.includes(name));
      try { return { data: JSON.parse(sql('SET ROLE service_role; SELECT public.' + identifier(name) + '(' +
        Object.entries(args).map(([k, v]) => identifier(k) + '=>' + literal(v)).join(',') + ');') || 'null'), error: null }; }
      catch (error) { return { data: null, error }; }
    },
    from: (table: string) => {
      assert.ok(['odin_tasks', 'odin_inbox', 'odin_outbox', 'odin_conversations'].includes(table));
      let fields = '*', where: string[] = [], order = '', limit = 1000, single = false;
      const q: any = {
        select: (f: string) => { fields = f === '*' ? '*' : f.split(',').map(identifier).join(','); return q; },
        eq: (k: string, v: any) => { where.push(identifier(k) + '=' + literal(v)); return q; },
        not: (k: string, op: string, v: any) => { assert.equal(op, 'is'); assert.equal(v, null); where.push(identifier(k) + ' IS NOT NULL'); return q; },
        in: (k: string, v: any[]) => { where.push(identifier(k) + ' IN (' + v.map(literal).join(',') + ')'); return q; },
        order: (k: string, opts: any) => { order = ' ORDER BY ' + identifier(k) + (opts.ascending ? ' ASC' : ' DESC'); return q; },
        limit: (n: number) => { limit = n; return q; }, maybeSingle: () => { single = true; return q; },
        then: (resolve: any, reject: any) => Promise.resolve().then(() => {
          const rows = JSON.parse(sql('SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(t)),\'[]\'::jsonb) FROM (SELECT ' + fields +
            ' FROM public.' + identifier(table) + (where.length ? ' WHERE ' + where.join(' AND ') : '') + order + ' LIMIT ' + limit + ') t;'));
          return { data: single ? rows[0] ?? null : rows, error: null };
        }).then(resolve, reject),
      }; return q;
    },
  };
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-o', "-h '' -k " + socket + ' -p 55439', '-w', 'start']); started = true;
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.businesses(id bigint PRIMARY KEY); INSERT INTO public.businesses VALUES(77),(88);');
    sql(readFileSync('docs/designs/knowledge-migration-wrappers/foundation.sql.payload', 'utf8'));
    sql(readFileSync('docs/designs/knowledge-migration-wrappers/extension.sql.payload', 'utf8'));
    const scope: KnowledgeScope = { businessId: 77, channel: 'whatsapp', providerAccount: 'account', conversationId: randomUUID() };
    const canonical = 'synthetic-canonical';
    sql('INSERT INTO public.odin_conversations(id,business_id,conversation_key) VALUES(' + literal(scope.conversationId) + ',77,' + literal(canonical) + ');');
    let authority = true;
    // Generic/legacy P2 rows can lack the namespaced lifecycle identity. They
    // must not be discovered as executable Knowledge or poison the worker scan.
    sql('INSERT INTO public.odin_tasks(business_id,conversation_id,task_type,knowledge_state) VALUES(77,' + literal(scope.conversationId) + ",'knowledge_async_v1','ACCEPTED');");
    const connect = () => new SupabaseKnowledgeLifecycleRepository(db, async () => canonical, async () => authority);
    const repo = connect(); const input = { question: 'Parking?', language: 'en', history: [] };
    const [a, duplicate] = await Promise.all([repo.accept(scope, 'event1', input), connect().accept(scope, 'event1', input)]);
    assert.equal((await repo.discoverWork()).length, 1); assert.equal((await repo.discoverWork())[0].taskId, a.task!.id);
    assert.equal(a.task!.id, duplicate.task!.id); assert.equal(a.identity.turnId, duplicate.identity.turnId);
    assert.equal(await new SupabaseKnowledgeLifecycleRepository(db, async () => 'wrong-key', async () => true).get(scope, a.task!.id), null);
    assert.equal(await repo.get({ ...scope, providerAccount: 'other-account' }, a.task!.id), null);
    assert.equal(await repo.get({ ...scope, businessId: 88 }, a.task!.id), null);
    const claims = await Promise.all([repo.claim(scope, a.task!.id, 'a', 30000), connect().claim(scope, a.task!.id, 'b', 30000)]);
    assert.equal(claims.filter(Boolean).length, 1); const claimed = claims.find(Boolean)!;
    const token = { taskId: claimed.id, owner: claimed.lease!.owner, fence: claimed.fence };
    assert.equal(await repo.reserveModelAttempt(scope, token), true); assert.equal(await repo.checkpoint(scope, token, 'extraction'), true);
    const result: VerifiedKnowledge = { protocol: 'evidence-first-v2', independentlyVerified: true, completeRequiredFacts: true,
      text: 'Parking nearby.', sources: [{ id: 'doc', revision: 'v1' }] };
    assert.equal(await repo.verified(scope, token, result), true);
    authority = false; assert.equal(await repo.finalize(scope, token), null); assert.equal(sql('select count(*) from public.odin_outbox;'), '0');
    authority = true; const delivery = (await repo.finalize(scope, token))!; assert.ok(delivery);
    assert.equal((await repo.discoverDeliveries())[0].deliveryId, delivery.id);
    assert.equal(delivery.kind, 'final'); assert.equal(delivery.customerDelivery, 'UNCONFIRMED');
    assert.equal(await repo.finalize(scope, token), null);
    const sent = await deliverKnowledge(repo, { authorize: async () => true, resolve: async () => ({ recipient: 'trusted', channel: scope.channel, providerAccount: scope.providerAccount }),
      eligible: async () => true, send: async () => ({ kind: 'AMBIGUOUS' }) }, scope, claimed.id, delivery.id, 'sender');
    assert.equal(sent!.settled, true); assert.equal(sql('select knowledge_state from public.odin_outbox;'), 'UNCERTAIN');
    assert.equal(await repo.claimDelivery(scope, delivery.id, 'again', 1000), null);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-m', 'fast', '-o', "-h '' -k " + socket + ' -p 55439', '-w', 'restart']);
    assert.equal((await connect().get(scope, claimed.id))!.expiresAt, a.task!.expiresAt);
    assert.equal((await connect().get(scope, claimed.id))!.modelAttempts, 1);
    const next = await repo.accept(scope, 'event2', input); let calls = 0;
    const runner = new KnowledgeRunner(connect(), async (_task, context) => { calls++; await context.reserveModelAttempt(); return result; }, 'runner');
    assert.ok(await runner.run(scope, next.task!.id)); assert.equal(calls, 1);
    assert.equal(await repo.renew(scope, token, 1000), false);
    assert.equal(sql("select count(*) from public.odin_outbox where knowledge_state='PENDING';"), '1');
    t.diagnostic('PostgreSQL ' + sql('show server_version;') + '; actual adapter and installed RPC payloads; private Unix socket, TCP disabled');
  } finally {
    if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
