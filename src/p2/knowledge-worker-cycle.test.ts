import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeWorkerCycle, type DiscoverableKnowledgeRepository } from './knowledge-worker-cycle';
import { KnowledgeRunner } from './knowledge-runner';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import type { VerifiedKnowledge } from './knowledge-lifecycle';

test('host tick discovers durable work after restart; processing/delivery are deduplicated and reentry is bounded', async () => {
  const scope = { businessId: 77, channel: 'telegram' as const, providerAccount: 'account', conversationId: 'conversation' };
  let db = new FakeKnowledgeDatabase(); const acceptance = await new FakeKnowledgeLifecycle(db, Date.now, async () => true)
    .accept(scope, 'event', { question: 'Parking?', language: 'en', history: [] });
  db = FakeKnowledgeDatabase.restore(db.dump()); // New host has no in-memory task list.
  const repo: DiscoverableKnowledgeRepository = Object.assign(new FakeKnowledgeLifecycle(db, Date.now, async () => true), {
    discoverWork: async () => [...db.rows.tasks.values()].filter(t => ['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(t.state)).map(t => ({ scope: t.scope, taskId: t.id })),
    discoverDeliveries: async () => [...db.rows.deliveries.values()].filter(d => ['PENDING', 'SENDING'].includes(d.state)).map(d => ({ scope, taskId: d.taskId, deliveryId: d.id })),
  });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let models = 0; let sends = 0;
  const result: VerifiedKnowledge = { protocol: 'evidence-first-v2', independentlyVerified: true, completeRequiredFacts: true,
    text: 'Parking nearby.', sources: [{ id: 'doc', revision: 'v1' }] };
  const runner = new KnowledgeRunner(repo, async (_task, context) => { models++; await context.reserveModelAttempt(); await wait; return result; }, 'worker');
  const worker = new KnowledgeWorkerCycle(repo, runner, { authorize: async () => true,
    resolve: async task => ({ channel: task.scope.channel, providerAccount: task.scope.providerAccount, recipient: 'trusted' }),
    eligible: async () => true, send: async () => { sends++; return { kind: 'API_ACCEPTED', providerMessageId: 'id' }; } }, 'sender');
  const tick = worker.tick(); assert.equal((await worker.tick()).ran, false); release(); const report = await tick; assert.equal(report.ran, true);
  assert.equal(report.deliveries[0].result.outcome.kind, 'API_ACCEPTED'); assert.equal(report.deliveries[0].result.settled, true);
  assert.equal(models, 1); assert.equal(sends, 1); assert.equal(db.rows.deliveries.size, 1);
  assert.equal((await repo.get(scope, acceptance.task!.id))!.state, 'FINALIZED');
  await worker.tick(); assert.equal(models, 1); assert.equal(sends, 1); worker.stop(); assert.equal((await worker.tick()).ran, false);
});
