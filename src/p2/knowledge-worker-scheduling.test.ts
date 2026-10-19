import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeWorkerCycle } from './knowledge-worker-cycle';
import { KnowledgeRunner } from './knowledge-runner';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';

test('occupied processing leases do not starve later durable tasks in the bounded scan', async () => {
  const db = new FakeKnowledgeDatabase();
  const scope = { businessId: 77, channel: 'telegram' as const, providerAccount: 'account', conversationId: 'conversation' };
  const repo = Object.assign(new FakeKnowledgeLifecycle(db, Date.now, async () => true), {
    discoverWork: async () => [...db.rows.tasks.values()].map(task => ({ scope: task.scope, taskId: task.id })),
    discoverDeliveries: async () => [],
  });
  const accepted = [];
  for (let i = 0; i < 4; i++) {
    // Independent conversations: occupied leases must not obstruct unrelated customers.
    const s = { ...scope, conversationId: `conversation-${i}` };
    accepted.push(await repo.accept(s, `event-${i}`, { question: 'Parking?', language: 'en', history: [] }));
  }
  for (const a of accepted.slice(0, 2)) await repo.claim(a.task!.scope, a.task!.id, 'other-worker', 15000);
  let executions = 0;
  const runner = new KnowledgeRunner(repo, async () => { executions++; return null; }, 'worker', 2);
  const worker = new KnowledgeWorkerCycle(repo, runner, {
    authorize: async () => true, resolve: async () => null, eligible: async () => false,
    send: async () => { throw new Error('unexpected send'); },
  }, 'sender', { processing: () => true, delivery: () => false });
  const report = await worker.tick();
  assert.equal(report.ran, true);
  assert.equal(executions, 2, 'both later claimable conversations execute despite two occupied leases');
  assert.equal(report.deliveries.length, 0);
  worker.stop();
});
