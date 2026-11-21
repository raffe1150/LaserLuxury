import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import { KnowledgeRunner, deliverKnowledge, type GuardedKnowledgeTransport } from './knowledge-runner';
import { resultDigest, safeUnavailableKnowledge, type KnowledgeScope, type VerifiedKnowledge } from './knowledge-lifecycle';

const dir = 'docs/designs/durable-knowledge-publication-migration-package';
const forward = readFileSync(dir + '/durable-publication-v2.sql', 'utf8');
const rollback = readFileSync(dir + '/rollback-durable-publication-v2.sql', 'utf8');
const complete: VerifiedKnowledge = { protocol: 'evidence-first-v2', independentlyVerified: true, completeRequiredFacts: true,
  text: 'Parking is in the courtyard.', sources: [{ id: 'doc', revision: 'r1' }] };
const partial: VerifiedKnowledge = { ...complete, protocol: 'evidence-first-partial-v1', completeRequiredFacts: false,
  text: complete.text + ' I can’t confirm whether parking is free.' };

test('guarded durable publication on disposable PostgreSQL 17', async t => {
  const pg = new DisposableNativeKnowledgeDatabase();
  t.after(() => pg.close());
  pg.sql('insert into public.businesses values (3);');
  const key = (s: KnowledgeScope) => 'canonical-' + s.conversationId;
  let factualAuthorized = true;
  const authority = async (task: import('./knowledge-lifecycle').KnowledgeTask) =>
    task.result?.protocol === 'safe-unavailable-v1' || factualAuthorized;
  const repo = new SupabaseOrderedKnowledgeRepository(pg.db, async s => key(s), authority);
  let serial = 0;
  function conversation(businessId: number, channel: KnowledgeScope['channel'] = 'telegram'): KnowledgeScope {
    const scope = { businessId, channel, providerAccount: '123456', conversationId: randomUUID() };
    pg.sql(`insert into public.odin_conversations(id,business_id,conversation_key) values('${scope.conversationId}',${businessId},'${key(scope)}');`);
    return scope;
  }
  const newOrder = (scope: KnowledgeScope) => ({
    atMs: Math.floor((Date.now() - 3000) / 1000) * 1000, sequence: scope.channel === 'telegram' ? ++serial : null,
  });
  async function admit(scope: KnowledgeScope, language: string, max?: 4 | 5, prepareOnly = false) {
    const order = newOrder(scope), event = randomUUID(), owner = randomUUID();
    const begin = await repo.intake(scope, event, order, 'begin', owner, 'Where is parking?', undefined, 75_000, max);
    assert.equal(begin.state, 'ROUTING');
    await repo.intake(scope, event, order, 'prepare', owner, '', { question: 'Where is parking?', language, history: [] });
    if (prepareOnly) return { scope, order, event, owner, task: null };
    const finish = await repo.intake(scope, event, order, 'reconcile', owner);
    assert.equal(finish.state, 'ATTACHED');
    return { scope, order, event, owner, task: finish.result.acceptance!.task! };
  }
  const historical = await admit(conversation(77), 'en');
  const old = (await repo.claim(historical.scope, historical.task!.id, 'old', 15_000))!;
  const oldToken = { taskId: old.id, owner: 'old', fence: old.fence };
  assert.ok(await repo.verified(historical.scope, oldToken, complete));

  const discovery = 'public.odin_discover_knowledge_v2(text,integer)';
  pg.sql('grant execute on function ' + discovery + ' to authenticated;');
  assert.throws(() => pg.sql(forward), /fingerprint_or_acl/u);
  pg.sql('revoke execute on function ' + discovery + ' from authenticated;');
  const v1Signature = () => pg.sql("select row(oid,proargnames,pronargdefaults,proargdefaults::text,prosecdef,proacl::text) from pg_proc where oid='public.odin_native_intake_v1(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer)'::regprocedure");
  const originalV1 = v1Signature();
  pg.sql(forward);
  assert.equal(v1Signature(), originalV1);
  assert.throws(() => pg.sql(forward), /fingerprint_or_acl/u);
  pg.sql(rollback);
  assert.equal(v1Signature(), originalV1);
  assert.throws(() => pg.sql(rollback), /fingerprint_or_acl/u);
  pg.sql(forward);
  assert.equal(v1Signature(), originalV1);
  assert.equal((await repo.get(historical.scope, old.id))!.resultDigest, resultDigest(complete));
  assert.ok(await repo.finalize(historical.scope, oldToken));

  let sends = 0;
  const transport: GuardedKnowledgeTransport = {
    authorize: async () => true,
    resolve: async task => ({ recipient: 'synthetic', channel: task.scope.channel, providerAccount: task.scope.providerAccount }),
    eligible: async () => true,
    send: async () => { sends++; return { kind: 'API_ACCEPTED', providerMessageId: 'synthetic-id' }; },
  };
  async function send(scope: KnowledgeScope, taskId: string, deliveryId: string) {
    assert.deepEqual(await deliverKnowledge(repo, transport, scope, taskId, deliveryId, 'sender'),
      { outcome: { kind: 'API_ACCEPTED', providerMessageId: 'synthetic-id' }, settled: true });
    assert.equal(await deliverKnowledge(repo, transport, scope, taskId, deliveryId, 'sender'), null);
  }

  for (const [index, language] of ['en', 'sv', 'de', 'es', 'fa', 'ar'].entries()) {
    const scope = conversation(3, (['telegram', 'whatsapp', 'instagram', 'messenger'] as const)[index % 4]);
    const f = await admit(scope, language, 4);
    const task = f.task!;
    assert.equal(task.maxModelAttempts, 4);
    assert.equal(task.publicationV2, true);
    const runner = new KnowledgeRunner(repo, async () => { throw new Error('synthetic provider denial'); }, 'worker');
    const d = (await runner.run(scope, task.id))!;
    const expected = safeUnavailableKnowledge(language);
    assert.equal(d.text, expected.text);
    assert.equal((await repo.get(scope, task.id))!.resultDigest, resultDigest(expected));
    await send(scope, task.id, d.id);
    const duplicate = await repo.intake(scope, f.event, f.order, 'begin', randomUUID(), '', undefined, 75_000, 5);
    assert.equal(duplicate.result.acceptance!.inserted, false);
    assert.equal(duplicate.result.acceptance!.task!.maxModelAttempts, 4);
  }
  assert.equal(sends, 6);

  const other = await admit(conversation(88), 'en');
  assert.equal(other.task!.maxModelAttempts, 4);
  assert.equal(other.task!.publicationV2, undefined);
  const otherClaim = (await repo.claim(other.scope, other.task!.id, 'worker', 15_000))!;
  await assert.rejects(repo.verified(other.scope, { taskId: otherClaim.id, owner: 'worker', fence: otherClaim.fence }, partial));
  await assert.rejects(repo.intake(other.scope, randomUUID(), newOrder(other.scope), 'begin', randomUUID(), '', undefined, 75_000, 5), /publication_scope/u);

  const p = await admit(conversation(3), 'en', 5);
  assert.throws(() => pg.sql(rollback), /drain_required/u);
  const d = (await new KnowledgeRunner(repo, async (task, context) => {
    assert.equal(task.maxModelAttempts, 5);
    for (let attempt = 0; attempt < 5; attempt++) await context.reserveModelAttempt();
    await assert.rejects(context.reserveModelAttempt(), /attempt_not_reserved/u);
    return partial;
  }, 'worker').run(p.scope, p.task!.id))!;
  assert.equal(d.text, partial.text);
  assert.deepEqual((await repo.get(p.scope, p.task!.id))!.result, partial);
  assert.equal((await repo.get(p.scope, p.task!.id))!.modelAttempts, 5);
  await send(p.scope, p.task!.id, d.id);

  for (const mode of ['finalize', 'unclaimed', 'claimed', 'race', 'ambiguous'] as const) {
    factualAuthorized = true;
    const f = await admit(conversation(3), 'sv', 5);
    const c = (await repo.claim(f.scope, f.task!.id, 'worker', 15_000))!;
    const token = { taskId: c.id, owner: 'worker', fence: c.fence };
    assert.equal(await repo.verified(f.scope, token, partial), true);
    factualAuthorized = mode !== 'finalize';
    const outgoing = (await repo.finalize(f.scope, token))!;
    assert.ok(outgoing);
    const localTransport = { ...transport, authorize: authority };
    if (mode === 'ambiguous') {
      const d = (await repo.claimDelivery(f.scope, outgoing.id, 'first-sender', 15_000))!;
      assert.equal(await repo.settleDelivery(f.scope, { deliveryId: d.id, owner: 'first-sender', fence: d.fence }, { kind: 'AMBIGUOUS' }), true);
      factualAuthorized = false;
      assert.equal(await repo.withdrawFinal(f.scope, c.id, d.id), null);
      assert.deepEqual((await repo.get(f.scope, c.id))!.result, partial);
      assert.equal(await deliverKnowledge(repo, localTransport, f.scope, c.id, d.id, 'next-sender'), null);
      continue;
    }
    if (mode === 'claimed') {
      let checks = 0;
      const failing = {...localTransport, authorize: async () => {
        if (++checks === 1) return true;
        factualAuthorized = false;
        return false;
      }, send: async () => assert.fail('Claimed stale facts must stay unsent')};
      assert.deepEqual(await deliverKnowledge(repo, failing, f.scope, c.id, outgoing.id, 'first-sender'),
        { outcome: { kind: 'DEFINITIVELY_UNSENT', retryable: true }, settled: true });
      pg.sql("update public.odin_outbox set available_at=clock_timestamp() where id='"+outgoing.id+"';");
    } else if (mode !== 'race') factualAuthorized = false;
    const expected = safeUnavailableKnowledge('sv');
    const racedAuthority = async (task: Parameters<typeof authority>[0]) => {
      if (task.result?.protocol !== 'safe-unavailable-v1' && factualAuthorized) {
        factualAuthorized = false;
        assert.ok(await repo.withdrawFinal(f.scope, c.id, outgoing.id));
        return true; // The preflight had already authorized the prior version.
      }
      return authority(task);
    };
    const result = await deliverKnowledge(repo, {...localTransport, authorize: mode === 'race' ? racedAuthority : authority, send: async (_target, text) => {
      assert.equal(text, expected.text);
      return { kind: 'API_ACCEPTED', providerMessageId: 'synthetic-withdrawal' };
    }}, f.scope, c.id, outgoing.id, 'next-sender');
    assert.equal(result?.outcome.kind, 'API_ACCEPTED');
    assert.deepEqual((await repo.get(f.scope, c.id))!.result, expected);
    assert.equal((await repo.get(f.scope, c.id))!.resultDigest, resultDigest(expected));
    assert.deepEqual(JSON.parse(pg.sql("select knowledge_withdrawn_result from public.odin_tasks where id='"+c.id+"';")),
      { result: partial, digest: resultDigest(partial) });
    assert.equal(pg.sql("select count(*) from public.odin_outbox where knowledge_task_id='"+c.id+"';"), '1');
  }
  factualAuthorized = true;

  const recovering = await admit(conversation(3), 'fa', 5, true);
  pg.restart();
  await repo.recoverIntakes();
  const row = (await repo.discoverWork()).find(w => w.scope.conversationId === recovering.scope.conversationId)!;
  const c = (await repo.claim(row.scope, row.taskId, 'crashed', 15_000))!;
  assert.equal(c.maxModelAttempts, 5);
  const token = { taskId: c.id, owner: 'crashed', fence: c.fence };
  for (let attempt = 0; attempt < 5; attempt++) assert.ok(await repo.reserveModelAttempt(c.scope, token));
  await assert.rejects(repo.verified(c.scope, token, { ...safeUnavailableKnowledge('fa'), text: 'Unsupported parking claim.' }));
  await assert.rejects(repo.verified(c.scope, token, safeUnavailableKnowledge('en')));
  pg.sql(`update public.odin_tasks set knowledge_lease_until=clock_timestamp()-interval '1 second',
    knowledge_run_attempts=knowledge_max_runs,knowledge_fence=knowledge_max_runs where id='${c.id}';`);
  assert.ok((await repo.discoverWork()).some(w => w.taskId === c.id));
  const recovered = (await new KnowledgeRunner(repo, async () => assert.fail('No model on final-only recovery'), 'recovery').run(c.scope, c.id))!;
  assert.equal(recovered.text, safeUnavailableKnowledge('fa').text);
  const recoveredTask = (await repo.get(c.scope, c.id))!;
  assert.equal(recoveredTask.runAttempts, recoveredTask.maxRunAttempts);
  assert.equal(recoveredTask.modelAttempts, 5);
  assert.ok(recoveredTask.fence > recoveredTask.runAttempts);
  assert.equal(await repo.reserveModelAttempt(c.scope, token), false);
  await send(c.scope, c.id, recovered.id);

  const superseded = await admit(conversation(3), 'en', 5);
  const noDelivery = await new KnowledgeRunner(repo, async () => {
    const next = { ...superseded.order, sequence: superseded.order.sequence! + 1 };
    await repo.acceptOrdered(superseded.scope, randomUUID(), next);
    return null;
  }, 'worker').run(superseded.scope, superseded.task!.id);
  assert.equal(noDelivery, null);
  assert.equal((await repo.get(superseded.scope, superseded.task!.id))!.state, 'SUPERSEDED');

  assert.throws(() => pg.sql(rollback), /legacy_reader_incompatible/u,
    'drained historical results can still be replayed to the legacy decoder by duplicate intake');
  assert.deepEqual((await repo.get(p.scope, p.task!.id))!.result, partial, 'refused rollback preserves history');
  const duplicate = await repo.intake(p.scope, p.event, p.order, 'begin', randomUUID());
  assert.equal(duplicate.result.acceptance!.inserted, false);
  assert.deepEqual(duplicate.result.acceptance!.task!.result, partial, 'V1 intake with the current reader works after flag rollback');
});
