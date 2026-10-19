import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { captureInput, captureVerified, resultDigest, type KnowledgeScope, type KnowledgeTask, type TaskToken, type KnowledgeDelivery } from './knowledge-lifecycle';

const input = { question: 'Where can I park?', language: 'en', history: [{ role: 'assistant' as const, content: 'How can I help?' }] };
const result = { protocol: 'evidence-first-v2' as const, independentlyVerified: true as const, completeRequiredFacts: true as const,
  text: 'Use the paid car park.', sources: [{ id: 'document-1', revision: 'v1' }] };
const token = (t: KnowledgeTask): TaskToken => ({ taskId: t.id, owner: t.lease!.owner, fence: t.fence });
const dt = (d: KnowledgeDelivery) => ({ deliveryId: d.id, owner: d.lease!.owner, fence: d.fence });
function fixture(channel: KnowledgeScope['channel'] = 'whatsapp') {
  let now = 1000, authorized = true, revision = 'v1', calls = 0;
  let database = new FakeKnowledgeDatabase();
  const scope: KnowledgeScope = { businessId: 77, channel, providerAccount: 'account-77', conversationId: 'conversation-77' };
  const connect = () => new FakeKnowledgeLifecycle(database, () => now, async (task, phase) => {
    calls++;
    return authorized && task.scope.businessId === 77 && task.scope.providerAccount === 'account-77' &&
      (phase === 'send' && !task.result || task.result?.sources.every(s => s.revision === revision) === true);
  });
  const api = connect();
  return { scope, api, connect, time: (ms: number) => { now += ms; },
    revoke: () => { authorized = false; }, change: () => { revision = 'v2'; }, calls: () => calls,
    db: () => database, restart: () => { database = FakeKnowledgeDatabase.restore(database.dump()); return connect(); } };
}
async function running(f: ReturnType<typeof fixture>, executionMs = 40_000) {
  const a = await f.api.accept(f.scope, 'event-1', input, { executionMs });
  return (await f.api.claim(f.scope, a.task!.id, 'worker-a', 1000))!;
}
async function finalized(f: ReturnType<typeof fixture>) {
  const t = await running(f); assert.equal(await f.api.verified(f.scope, token(t), result), true);
  return { task: t, delivery: (await f.api.finalize(f.scope, token(t)))! };
}

for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) {
  test(`${channel}: competing acceptance creates one task/turn and bounded immutable input`, async () => {
    const f = fixture(channel), other = f.connect();
    const [a, b] = await Promise.all([f.api.accept(f.scope, 'event-1', input), other.accept(f.scope, 'event-1', input)]);
    assert.equal(a.identity.turnId, b.identity.turnId); assert.equal(a.task!.id, b.task!.id);
    assert.equal(Number(a.inserted) + Number(b.inserted), 1); assert.equal(f.db().rows.tasks.size, 1);
    assert.ok(Object.isFrozen(a.task!.input.history));
    assert.throws(() => { (a.task as any).expiresAt = 999999; });
    const duplicate = await f.api.accept(f.scope, 'event-1', { ...input, question: 'Changed payload' }, { executionMs: 120_000 });
    assert.equal(duplicate.task!.input.question, input.question); assert.equal(duplicate.task!.expiresAt, a.task!.expiresAt);
  });
}
for (const executionMs of [30_000, 35_000, 40_000, 60_000]) test(`${executionMs}ms expiry is acceptance-relative across queue, restart and takeover`, async () => {
  const f = fixture(), t = await running(f, executionMs); f.time(1001);
  const api = f.restart(), next = (await api.claim(f.scope, t.id, 'worker-b', 2000))!;
  assert.equal(next.acceptedAt, t.acceptedAt); assert.equal(next.expiresAt, t.acceptedAt + executionMs);
  f.time(executionMs); assert.equal(await api.renew(f.scope, token(next), 1000), false);
  assert.equal((await api.get(f.scope, t.id))!.state, 'EXPIRED'); assert.deepEqual(await api.recover(f.scope), []);
});
test('two workers: one live processing claim, renewal cannot revive a lost lease', async () => {
  const f = fixture(), a = await f.api.accept(f.scope, 'event-1', input);
  const claims = await Promise.all([f.api.claim(f.scope, a.task!.id, 'a', 100), f.connect().claim(f.scope, a.task!.id, 'b', 100)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const t = claims.find(Boolean)!; assert.equal(await f.api.renew(f.scope, token(t), 100), true);
  f.time(100); const next = (await f.connect().claim(f.scope, t.id, 'next', 100))!;
  assert.ok(next.fence > t.fence);
  assert.equal(await f.api.verified(f.scope, token(t), result), false);
  assert.equal(await f.api.finalize(f.scope, token(t)), null);
  assert.equal(await f.api.renew(f.scope, token(t), 1000), false);
  assert.equal(await f.api.reserveModelAttempt(f.scope, token(t)), false);
  assert.equal(f.db().rows.deliveries.size, 0);
});
for (const checkpoint of ['planning', 'retrieval', 'extraction'] as const) test(`restart after ${checkpoint} retains checkpoint, counters and no Booking execution`, async () => {
  const f = fixture(), t = await running(f);
  assert.equal(await f.api.reserveModelAttempt(f.scope, token(t)), true);
  assert.equal(await f.api.checkpoint(f.scope, token(t), checkpoint), true);
  f.time(1001); const api = f.restart(), candidates = await api.recover(f.scope);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].checkpoint, checkpoint);
  assert.equal(candidates[0].modelAttempts, 1);
  const next = (await api.claim(f.scope, t.id, 'restarted', 100))!;
  assert.equal(next.modelAttempts, 1); assert.equal(next.runAttempts, 2);
  assert.equal(f.db().rows.deliveries.size, 0);
  assert.deepEqual(Object.keys(candidates[0].input).sort(), ['history', 'language', 'question']);
});
test('restart before claim and after verification recovers result but requires fresh authority', async () => {
  const f = fixture(), a = await f.api.accept(f.scope, 'event-1', input);
  let api = f.restart(); assert.equal((await api.recover(f.scope))[0].state, 'ACCEPTED');
  const t = (await api.claim(f.scope, a.task!.id, 'a', 100))!;
  assert.equal(await api.verified(f.scope, token(t), result), true);
  f.time(101); api = f.restart(); const next = (await api.claim(f.scope, t.id, 'b', 100))!;
  assert.equal(next.state, 'VERIFIED'); assert.equal(next.result!.text, result.text);
  f.revoke(); assert.equal(await api.finalize(f.scope, token(next)), null); assert.equal(f.db().rows.deliveries.size, 0);
});
test('persisted run and model attempt ceilings survive every connection/restart', async () => {
  const f = fixture(), a = await f.api.accept(f.scope, 'event-1', input, { maxRunAttempts: 2, maxModelAttempts: 2 });
  const t = (await f.api.claim(f.scope, a.task!.id, 'a', 10))!;
  assert.equal(await f.api.reserveModelAttempt(f.scope, token(t)), true);
  f.time(11); const api = f.restart(), next = (await api.claim(f.scope, t.id, 'b', 10))!;
  assert.equal(await api.reserveModelAttempt(f.scope, token(next)), true);
  assert.equal(await api.reserveModelAttempt(f.scope, token(next)), false);
  f.time(11); assert.equal(await f.restart().claim(f.scope, t.id, 'c', 10), null);
  assert.equal((await f.connect().get(f.scope, t.id))!.state, 'FAILED');
});
test('new non-Knowledge inbound supersedes task, duplicate old event cannot regain latest ownership', async () => {
  const f = fixture(), t = await running(f);
  const newer = await f.connect().accept(f.scope, 'new-booking-turn');
  assert.equal(newer.task, null);
  const duplicate = await f.api.accept(f.scope, 'event-1', input);
  assert.equal(duplicate.task!.state, 'SUPERSEDED'); assert.equal(duplicate.identity.turnId, t.turnId);
  assert.equal(await f.api.verified(f.scope, token(t), result), false);
  assert.equal(await f.api.finalize(f.scope, token(t)), null); assert.equal(f.db().rows.tasks.size, 1);
});
test('acceptance transaction failure leaves neither task nor watermark', async () => {
  const f = fixture(); f.db().failNextCommit = true;
  await assert.rejects(f.api.accept(f.scope, 'event-1', input), /transaction_failure/);
  assert.equal(f.db().rows.tasks.size, 0); assert.equal(f.db().rows.events.size, 0); assert.equal(f.db().rows.latest.size, 0);
  assert.equal((await f.api.accept(f.scope, 'event-1', input)).identity.sequence, 1);
});
test('atomic finalization rollback exposes no final entry, retry creates exactly one', async () => {
  const f = fixture(), t = await running(f); await f.api.verified(f.scope, token(t), result);
  f.db().failNextCommit = true;
  await assert.rejects(f.api.finalize(f.scope, token(t)), /transaction_failure/);
  assert.equal(f.db().rows.deliveries.size, 0); assert.equal((await f.api.get(f.scope, t.id))!.state, 'VERIFIED');
  const finals = await Promise.all([f.api.finalize(f.scope, token(t)), f.connect().finalize(f.scope, token(t))]);
  assert.equal(finals.filter(Boolean).length, 1); assert.equal(f.db().rows.deliveries.size, 1);
  assert.equal((await f.api.get(f.scope, t.id))!.state, 'FINALIZED');
});
for (const fault of ['revoked', 'changed', 'expired', 'superseded'] as const) test(`${fault} after verification prevents atomic publication`, async () => {
  const f = fixture(), t = await running(f); await f.api.verified(f.scope, token(t), result);
  if (fault === 'revoked') f.revoke(); if (fault === 'changed') f.change();
  if (fault === 'expired') f.time(40_000); if (fault === 'superseded') await f.api.accept(f.scope, 'new');
  assert.equal(await f.api.finalize(f.scope, token(t)), null); assert.equal(f.db().rows.deliveries.size, 0);
});
for (const fault of ['revoked', 'changed', 'expired', 'superseded'] as const) test(`${fault} after finalization prevents recovered send claim`, async () => {
  const f = fixture(), { delivery } = await finalized(f);
  if (fault === 'revoked') f.revoke(); if (fault === 'changed') f.change();
  if (fault === 'expired') f.time(40_000); if (fault === 'superseded') await f.api.accept(f.scope, 'new');
  assert.equal(await f.restart().claimDelivery(f.scope, delivery.id, 'sender', 100), null);
});
test('final and progress identities deduplicate independently; final suppresses pending progress', async () => {
  const f = fixture(), t = await running(f);
  const p = (await f.api.enqueueProgress(f.scope, t.id, 'Checking the details.'))!;
  assert.equal((await f.api.enqueueProgress(f.scope, t.id, 'Different text.'))!.id, p.id);
  await f.api.verified(f.scope, token(t), result); const d = (await f.api.finalize(f.scope, token(t)))!;
  assert.notEqual(d.key, p.key); assert.equal(f.db().rows.deliveries.size, 2);
  assert.equal(await f.api.claimDelivery(f.scope, p.id, 'sender', 100), null);
  assert.equal(await f.api.enqueueProgress(f.scope, t.id, 'Late waiting.'), null);
});
test('competing send claims, stale settlement and restart never cause blind resend', async () => {
  const f = fixture(), { delivery } = await finalized(f);
  const claims = await Promise.all([f.api.claimDelivery(f.scope, delivery.id, 'a', 100), f.connect().claimDelivery(f.scope, delivery.id, 'b', 100)]);
  assert.equal(claims.filter(Boolean).length, 1); const claim = claims.find(Boolean)!;
  f.time(100); const api = f.restart();
  assert.equal(await api.claimDelivery(f.scope, delivery.id, 'recovery', 100), null);
  assert.equal(await api.settleDelivery(f.scope, dt(claim), { kind: 'API_ACCEPTED', providerMessageId: 'provider-1' }), false);
  assert.equal(f.db().rows.deliveries.get(delivery.id)!.state, 'UNCERTAIN');
});
test('explicit uncertain result cannot be retried even after restart or new worker', async () => {
  const f = fixture(), { delivery } = await finalized(f), claim = (await f.api.claimDelivery(f.scope, delivery.id, 'a', 100))!;
  assert.equal(await f.api.settleDelivery(f.scope, dt(claim), { kind: 'AMBIGUOUS' }), true);
  assert.equal(await f.restart().claimDelivery(f.scope, delivery.id, 'b', 100), null);
});
for (const retryable of [true, false]) test(`definitively unsent failure retryable=${retryable} has bounded attempts`, async () => {
  const f = fixture(), { delivery } = await finalized(f);
  for (let i = 0; i < (retryable ? 3 : 1); i++) {
    const claim = (await f.connect().claimDelivery(f.scope, delivery.id, 'sender', 100))!;
    assert.ok(claim); assert.equal(await f.api.settleDelivery(f.scope, dt(claim), { kind: 'DEFINITIVELY_UNSENT', retryable }), true);
    assert.equal(await f.api.settleDelivery(f.scope, dt(claim), { kind: 'AMBIGUOUS' }), false);
  }
  assert.equal(await f.restart().claimDelivery(f.scope, delivery.id, 'b', 100), null);
});
test('provider acceptance is terminal API evidence, never customer delivery confirmation', async () => {
  const f = fixture(), { delivery } = await finalized(f), d = (await f.api.claimDelivery(f.scope, delivery.id, 'a', 100))!;
  assert.equal(await f.api.settleDelivery(f.scope, dt(d), { kind: 'API_ACCEPTED', providerMessageId: 'provider-1' }), true);
  const saved = f.db().rows.deliveries.get(d.id)!;
  assert.equal(saved.state, 'SENT'); assert.equal(saved.customerDelivery, 'UNCONFIRMED');
  assert.equal(saved.providerMessageId, 'provider-1'); assert.equal(await f.restart().claimDelivery(f.scope, d.id, 'b', 100), null);
});
for (const mismatch of ['businessId', 'providerAccount', 'conversationId', 'channel'] as const) test(`${mismatch} scope mismatch cannot inspect, finalize or deliver another task`, async () => {
  const f = fixture(), { task, delivery } = await finalized(f);
  const other = { ...f.scope, [mismatch]: mismatch === 'businessId' ? 88 : mismatch === 'channel' ? 'telegram' : 'other' };
  assert.equal(await f.api.get(other, task.id), null); assert.equal(await f.api.finalize(other, token(task)), null);
  assert.equal(await f.api.claimDelivery(other, delivery.id, 'a', 100), null);
});
test('same provider event cannot be rebound to a different conversation; account namespaces stay independent', async () => {
  const f = fixture(); await f.api.accept(f.scope, 'event-1', input);
  await assert.rejects(f.api.accept({ ...f.scope, conversationId: 'other' }, 'event-1', input), /scope_mismatch/);
  await assert.rejects(f.api.accept({ ...f.scope, providerAccount: 'other' }, 'event-1', input), /conversation_scope_mismatch/);
  const a = await f.api.accept({ ...f.scope, providerAccount: 'other', conversationId: 'other-account-conversation' }, 'event-1', input);
  assert.ok(a.inserted); assert.equal(f.db().rows.tasks.size, 2);
});
test('invalid proof, limits, transitions, checkpoints and oversized input fail closed', async () => {
  const f = fixture(), t = await running(f);
  assert.equal(await f.api.finalize(f.scope, token(t)), null);
  await assert.rejects(f.api.verified(f.scope, token(t), { ...result, independentlyVerified: false } as any));
  await assert.rejects(f.api.verified(f.scope, token(t), { ...result, completeRequiredFacts: false } as any));
  await assert.rejects(f.api.checkpoint(f.scope, token(t), 'booking' as any));
  assert.equal(await f.api.checkpoint(f.scope, token(t), 'extraction'), true);
  assert.equal(await f.api.checkpoint(f.scope, token(t), 'planning'), false);
  await assert.rejects(f.api.accept(f.scope, 'event-2', input, { executionMs: Infinity }));
  assert.throws(() => captureInput({ ...input, question: 'x'.repeat(4001) }));
  assert.throws(() => captureVerified({ ...result, sources: [] }));
  assert.equal(await f.api.fail(f.scope, token(t)), true);
  assert.equal(await f.api.verified(f.scope, token(t), result), false);
  assert.equal(await f.api.claim(f.scope, t.id, 'b', 100), null);
  assert.equal(f.db().rows.deliveries.size, 0);
});
test('authorization exceptions and expiry during authorization cannot expose sendable results', async () => {
  let now = 1; const db = new FakeKnowledgeDatabase(); let mode = 'throw';
  const api = new FakeKnowledgeLifecycle(db, () => now, async () => {
    if (mode === 'throw') throw new Error('synthetic_source_unavailable'); now += 40_000; return true;
  });
  const scope = fixture().scope, a = await api.accept(scope, 'event', input), t = (await api.claim(scope, a.task!.id, 'a', 1000))!;
  await api.verified(scope, token(t), result);
  await assert.rejects(api.finalize(scope, token(t)), /source_unavailable/); assert.equal(db.rows.deliveries.size, 0);
  mode = 'expire'; assert.equal(await api.finalize(scope, token(t)), null); assert.equal(db.rows.deliveries.size, 0);
});
test('allowlisted recoverable input strips extra fields, no callbacks or executable Booking capability persist', () => {
  const value = captureInput({ ...input, token: 'not-retained', booking: { operation: 'cancel' } } as any);
  assert.doesNotMatch(JSON.stringify(value), /not-retained|booking|cancel/);
});
test('opaque provider IDs retain punctuation for exact deduplication and API acceptance evidence', async () => {
  const f = fixture();
  const a = await f.api.accept(f.scope, 'wamid.ABC+/==', input);
  assert.equal((await f.api.accept(f.scope, 'wamid.ABC+/==', input)).task!.id, a.task!.id);
  assert.equal((await f.api.accept(f.scope, 'wamid.ABC-__', input)).inserted, true);
  await assert.rejects(f.api.accept(f.scope, 'wamid.\nsecret', input));
  const g = fixture(), { delivery } = await finalized(g), claim = (await g.api.claimDelivery(g.scope, delivery.id, 'a', 100))!;
  assert.equal(await g.api.settleDelivery(g.scope, dt(claim), { kind: 'API_ACCEPTED', providerMessageId: 'wamid.XYZ==' }), true);
});
test('unrecognized persisted states are never claimed, verified, finalized or dispatched', async () => {
  const f = fixture(), t = await running(f);
  (f.db().rows.tasks.get(t.id) as any).state = 'UNKNOWN';
  assert.equal(await f.api.claim(f.scope, t.id, 'b', 100), null);
  assert.equal(await f.api.verified(f.scope, token(t), result), false);
  assert.equal(await f.api.finalize(f.scope, token(t)), null);
  assert.equal(await f.api.enqueueProgress(f.scope, t.id, 'Waiting.'), null);
  assert.deepEqual(await f.api.recover(f.scope), []);
});
test('foreground-to-Knowledge handoff attaches once to original durable ingress without resetting its clock', async () => {
  const f = fixture(), ingress = await f.api.accept(f.scope, 'mixed-event');
  assert.equal(ingress.task, null); f.time(9000);
  const api = f.restart();
  const [a, b] = await Promise.all([api.accept(f.scope, 'mixed-event', input), f.connect().accept(f.scope, 'mixed-event', input)]);
  assert.equal(a.identity.turnId, ingress.identity.turnId); assert.equal(a.identity.sequence, ingress.identity.sequence);
  assert.equal(a.task!.id, b.task!.id); assert.equal(a.task!.expiresAt, ingress.identity.acceptedAt + 40_000);
  assert.equal(f.db().rows.tasks.size, 1); assert.equal(f.db().rows.deliveries.size, 0);
});
test('expired or superseded foreground handoff cannot attach new Knowledge work', async () => {
  for (const fault of ['expired', 'superseded']) {
    const f = fixture(); await f.api.accept(f.scope, 'mixed-event');
    if (fault === 'expired') f.time(40_000); else await f.api.accept(f.scope, 'newer');
    assert.equal((await f.api.accept(f.scope, 'mixed-event', input, { executionMs: 120_000 })).task, null); assert.equal(f.db().rows.tasks.size, 0);
  }
});
test('captured verified artifact cannot be changed by caller mutation or replaced after verification', async () => {
  const f = fixture(), t = await running(f), proposal = structuredClone(result);
  const digest = resultDigest(proposal);
  await f.api.verified(f.scope, token(t), proposal);
  proposal.text = 'Changed claim'; proposal.sources[0].revision = 'v2';
  assert.equal((await f.api.get(f.scope, t.id))!.resultDigest, digest);
  assert.equal(await f.api.verified(f.scope, token(t), proposal), false);
  const delivery = (await f.api.finalize(f.scope, token(t)))!;
  assert.equal(delivery.text, result.text);
  assert.equal(resultDigest({ ...result, text: 'پارکینگ مجاز است.' }).length, 64);
  assert.notEqual(resultDigest(proposal), digest);
});
