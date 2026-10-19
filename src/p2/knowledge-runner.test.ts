import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeRunner, deliverKnowledge, type KnowledgeExecutor, type GuardedKnowledgeTransport } from './knowledge-runner';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import type { KnowledgeScope, VerifiedKnowledge } from './knowledge-lifecycle';
const result: VerifiedKnowledge = { protocol: 'evidence-first-v2', independentlyVerified: true, completeRequiredFacts: true,
  text: 'Parking is available nearby.', sources: [{ id: 'doc', revision: 'v1' }] };
const input = { question: 'Where can I park?', language: 'en', history: [] };
function fixture(channel: KnowledgeScope['channel'] = 'whatsapp') {
  let now = Date.now(); let allowed = true; let checks = 0;
  const db = new FakeKnowledgeDatabase();
  const scope: KnowledgeScope = { businessId: 77, channel, providerAccount: 'account', conversationId: 'conversation' };
  const connect = (database = db) => new FakeKnowledgeLifecycle(database, () => now, async () => { checks++; return allowed; });
  return { scope, db, repo: connect(), connect, advance: (ms: number) => { now += ms; }, revoke: () => { allowed = false; }, checks: () => checks };
}
const execute: KnowledgeExecutor = async (_task, ctx) => {
  await ctx.checkpoint('planning'); await ctx.reserveModelAttempt();
  await ctx.checkpoint('retrieval'); await ctx.reserveModelAttempt();
  await ctx.checkpoint('extraction'); await ctx.reserveModelAttempt();
  return result;
};
const transport = (send: GuardedKnowledgeTransport['send']): GuardedKnowledgeTransport => ({
  authorize: async () => true, resolve: async task => ({ channel: task.scope.channel, providerAccount: task.scope.providerAccount, recipient: 'trusted-test-recipient' }),
  eligible: async () => true, send,
});
for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) {
  for (const language of ['en', 'sv', 'de', 'es', 'fa', 'ar']) test(`${channel}/${language}: runner preserves input and single correlated send despite telemetry failures`, async () => {
    const f = fixture(channel); const a = await f.repo.accept(f.scope, 'event', { ...input, language });
    let calls = 0; const events: string[] = [];
    const runner = new KnowledgeRunner(f.repo, async (task, ctx) => { assert.equal(task.input.language, language); return execute(task, ctx); }, 'worker', 2,
      event => { events.push(event.turnId); throw new Error('telemetry'); });
    const duplicate = await f.repo.accept(f.scope, 'event', input); assert.equal(a.task!.id, duplicate.task!.id);
    const delivery = await runner.run(f.scope, a.task!.id); assert.ok(delivery);
    const sent = await deliverKnowledge(f.repo, transport(async target => {
      assert.equal(target.recipient, 'trusted-test-recipient'); calls++; return { kind: 'API_ACCEPTED', providerMessageId: 'provider-result' };
    }), f.scope, a.task!.id, delivery.id, 'sender', () => { throw new Error('telemetry'); });
    assert.equal(sent!.outcome.kind, 'API_ACCEPTED'); assert.equal(sent!.settled, true); assert.equal(calls, 1);
    assert.equal(await deliverKnowledge(f.repo, transport(async () => { calls++; throw Error('duplicate'); }), f.scope, a.task!.id, delivery.id, 'sender'), null);
    assert.equal(calls, 1); assert.ok(events.every(id => id === a.identity.turnId));
    assert.equal(delivery.customerDelivery, 'UNCONFIRMED'); assert.equal((await f.repo.get(f.scope, a.task!.id))!.modelAttempts, 3);
  });
}
test('two competing workers execute models only once', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input); let work = 0;
  const executor: KnowledgeExecutor = async (task, ctx) => { work++; return execute(task, ctx); };
  const values = await Promise.all([new KnowledgeRunner(f.repo, executor, 'a').run(f.scope, a.task!.id),
    new KnowledgeRunner(f.connect(), executor, 'b').run(f.scope, a.task!.id)]);
  assert.equal(work, 1); assert.equal(values.filter(Boolean).length, 1);
});
test('supersession during execution rejects stale verified result and finalization', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const runner = new KnowledgeRunner(f.repo, async () => { await f.repo.accept(f.scope, 'newer'); return result; }, 'worker');
  assert.equal(await runner.run(f.scope, a.task!.id), null); assert.equal(f.db.rows.deliveries.size, 0);
});
test('lease loss fences old worker without exposing a result', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const runner = new KnowledgeRunner(f.repo, async () => { f.advance(15001); await f.connect().claim(f.scope, a.task!.id, 'new', 15000); return result; }, 'old');
  assert.equal(await runner.run(f.scope, a.task!.id), null); assert.equal(f.db.rows.deliveries.size, 0);
});
for (const stage of ['planning', 'retrieval', 'extraction'] as const) test(`restart after ${stage} recomputes safely and retains attempt/expiry`, async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const task = (await f.repo.claim(f.scope, a.task!.id, 'dead-worker', 100))!;
  const token = { taskId: task.id, owner: 'dead-worker', fence: task.fence };
  await f.repo.reserveModelAttempt(f.scope, token); await f.repo.checkpoint(f.scope, token, stage); f.advance(101);
  const restored = FakeKnowledgeDatabase.restore(f.db.dump()); const repo = f.connect(restored);
  await new KnowledgeRunner(repo, execute, 'recovery').recover(f.scope);
  const recovered = (await repo.get(f.scope, task.id))!;
  assert.equal(recovered.state, 'FINALIZED'); assert.equal(recovered.modelAttempts, 4);
  assert.equal(recovered.expiresAt, task.expiresAt); assert.equal(restored.rows.deliveries.size, 1);
});
test('recovered VERIFIED task requires fresh authority and does not repeat inference', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const t = (await f.repo.claim(f.scope, a.task!.id, 'dead', 100))!;
  await f.repo.verified(f.scope, { taskId: t.id, owner: 'dead', fence: t.fence }, result); f.advance(101); f.revoke();
  let calls = 0;
  const runner = new KnowledgeRunner(f.connect(), async () => { calls++; return result; }, 'recovery');
  assert.equal(await runner.run(f.scope, t.id), null); assert.equal(calls, 0); assert.ok(f.checks() > 0);
  assert.equal(f.db.rows.deliveries.size, 0);
});
test('model/provider failures remain observable, with no publication', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input); const error = new Error('provider_timeout');
  await assert.rejects(new KnowledgeRunner(f.repo, async () => { throw error; }, 'worker').run(f.scope, a.task!.id), e => e === error);
  assert.equal(f.db.rows.deliveries.size, 0);
});
test('transport exception remains original and becomes uncertain; no second send', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!;
  const error = new Error('connection_lost_after_write'); let sends = 0;
  const t = transport(async () => { sends++; throw error; });
  await assert.rejects(deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'), e => e === error);
  assert.equal(f.db.rows.deliveries.get(d.id)!.state, 'UNCERTAIN');
  assert.equal(await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'), null); assert.equal(sends, 1);
});
test('provider acceptance is preserved even if settlement persistence fails', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!;
  const sent = await deliverKnowledge(f.repo, transport(async () => { f.db.failNextCommit = true; return { kind: 'API_ACCEPTED', providerMessageId: 'provider-id' }; }),
    f.scope, a.task!.id, d.id, 'sender');
  assert.equal(sent!.outcome.kind, 'API_ACCEPTED'); assert.equal(sent!.settled, false); assert.ok(sent!.settlementError);
  f.advance(15001); await f.repo.recover(f.scope); assert.equal(f.db.rows.deliveries.get(d.id)!.state, 'UNCERTAIN');
});
test('ineligible channel or mismatched provider account never enters transport', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!; let sends = 0;
  const t = transport(async () => { sends++; return { kind: 'AMBIGUOUS' }; }); t.eligible = async () => false;
  assert.equal(await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'), null); assert.equal(sends, 0);
});
test('source authorization revoked after delivery claim prevents transport entry', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!; let sends = 0; let checks = 0;
  const t = transport(async () => { sends++; return { kind: 'AMBIGUOUS' }; }); t.authorize = async () => ++checks === 1;
  const outcome = await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender');
  assert.equal(outcome!.outcome.kind, 'DEFINITIVELY_UNSENT'); assert.equal(sends, 0);
});
test('definitively unsent transport failures have bounded retries, without repeating Knowledge', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!; let sends = 0;
  const t = transport(async () => { sends++; return { kind: 'DEFINITIVELY_UNSENT', retryable: true }; });
  for (let i = 0; i < 3; i++) assert.equal((await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'))!.settled, true);
  assert.equal(await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'), null); assert.equal(sends, 3);
  assert.equal((await f.repo.get(f.scope, a.task!.id))!.modelAttempts, 3);
});
test('provider acceptance after delivery lease loss stays observable and is quarantined', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!;
  const accepted = await deliverKnowledge(f.repo, transport(async () => { f.advance(15001); return { kind: 'API_ACCEPTED', providerMessageId: 'accepted' }; }),
    f.scope, a.task!.id, d.id, 'sender');
  assert.equal(accepted!.outcome.kind, 'API_ACCEPTED'); assert.equal(accepted!.settled, false);
  assert.equal(f.db.rows.deliveries.get(d.id)!.state, 'UNCERTAIN');
});
test('unverified progress or altered outbox text cannot acquire factual sending authority', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const task = (await f.repo.claim(f.scope, a.task!.id, 'worker', 15000))!;
  await f.repo.verified(f.scope, { taskId: task.id, owner: 'worker', fence: task.fence }, result);
  const progress = (await f.repo.enqueueProgress(f.scope, task.id, 'Unverified policy claim'))!;
  let sends = 0; const t = transport(async () => { sends++; return { kind: 'AMBIGUOUS' }; });
  assert.equal(await deliverKnowledge(f.repo, t, f.scope, task.id, progress.id, 'sender'), null);
  assert.equal(sends, 0);
  const final = (await f.repo.finalize(f.scope, { taskId: task.id, owner: 'worker', fence: task.fence }))!;
  f.db.rows.deliveries.get(final.id)!.text = 'Altered unsupported text';
  assert.equal(await deliverKnowledge(f.repo, t, f.scope, task.id, final.id, 'sender'), null);
  assert.equal(sends, 0);
});
test('concurrent resolver reuse cannot mutate a captured turn recipient', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const d = (await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id))!;
  const shared = { recipient: 'original-recipient', channel: f.scope.channel, providerAccount: f.scope.providerAccount };
  let recipient = '';
  const t = transport(async target => { recipient = target.recipient; return { kind: 'API_ACCEPTED', providerMessageId: 'id' }; });
  t.resolve = async () => shared; t.eligible = async () => { shared.recipient = 'different-turn'; return true; };
  assert.equal((await deliverKnowledge(f.repo, t, f.scope, a.task!.id, d.id, 'sender'))!.settled, true);
  assert.equal(recipient, 'original-recipient');
});
test('verified work that expires during finalization never exposes a sendable reply', async () => {
  const f = fixture(); const a = await f.repo.accept(f.scope, 'event', input);
  const finalize = f.repo.finalize.bind(f.repo);
  f.repo.finalize = async (scope, token) => { f.advance(40001); return finalize(scope, token); };
  assert.equal(await new KnowledgeRunner(f.repo, execute, 'worker').run(f.scope, a.task!.id), null);
  assert.equal(f.db.rows.deliveries.size, 0); const task = (await f.repo.get(f.scope, a.task!.id))!;
  assert.equal(task.state, 'EXPIRED'); assert.ok(task.result, 'verification completed, but expiry still blocks publication');
});
