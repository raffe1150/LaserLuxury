import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeAuthority } from './knowledge-authority';
import { knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { resultDigest, type KnowledgeTask } from './knowledge-lifecycle';
const source: KnowledgeSource = { id: 'doc', businessId: 77, type: 'document', title: 'Synthetic', status: 'ready',
  content: 'Parking nearby.', createdAt: 'synthetic', updatedAt: 'synthetic', metadata: { segments: [{ text: 'Parking nearby.' }] } };
function fixture(duringEligibility?:()=>void) {
  let row: any = { conversation_key: 'canonical', knowledge_channel: 'whatsapp', knowledge_account: 'account', knowledge_sequence: 1 };
  let current = structuredClone(source); let eligible = true;
  const result = { protocol: 'evidence-first-v2' as const, independentlyVerified: true as const, completeRequiredFacts: true as const,
    text: 'Parking nearby.', sources: [{ id: 'doc', revision: knowledgeSourceRevision(source) }] };
  const task: KnowledgeTask = { id: 'task', turnId: 'turn', eventId: 'event', acceptedAt: Date.now(), expiresAt: Date.now() + 40000,
    input: { question: 'Parking?', language: 'en', history: [] }, state: 'VERIFIED', revision: 1, fence: 1, lease: null,
    runAttempts: 1, maxRunAttempts: 3, modelAttempts: 2, maxModelAttempts: 4, checkpoint: 'extraction', scope: { businessId: 77, conversationId: 'conversation', channel: 'whatsapp', providerAccount: 'account' },
    sequence: 1, result, resultDigest: resultDigest(result) };
  const db = { rpc: () => assert.fail('No writes'), from: () => {
    const query: any = { select: () => query, eq: (name: string, value: any) => { assert.ok(['id', 'business_id'].includes(name)); return query; },
      maybeSingle: async () => ({ data: row, error: null }) }; return query;
  } };
  const authority = createKnowledgeAuthority(db, { list: async id => { assert.equal(id, 77); return [current]; } },
    { canonicalConversationKey: async () => 'canonical', eligible: async () => {duringEligibility?.();return eligible;} });
  return { task, authority, change: (patch: Partial<KnowledgeSource>) => { current = { ...current, ...patch }; },
    revoke: () => { eligible = false; }, supersede: () => { row.knowledge_sequence++; }, rebind: () => { row.knowledge_account = 'other'; } };
}
test('stored verification flags require current exact source revision and provider/turn authority', async () => {
  const f = fixture(); assert.equal(await f.authority(f.task, 'finalize'), true); assert.equal(await f.authority(f.task, 'send'), true);
  f.change({ content: 'Changed evidence.' }); assert.equal(await f.authority(f.task, 'finalize'), false);
});
for (const patch of [{ status: 'disabled' as const }, { businessId: 88 }, { id: 'foreign' }]) test(`revoked/foreign source ${JSON.stringify(patch)} rejects publication`, async () => {
  const f = fixture(); f.change(patch); assert.equal(await f.authority(f.task, 'send'), false);
});
test('newer turn and rebound provider account reject stored verified result', async () => {
  const f = fixture(); f.supersede(); assert.equal(await f.authority(f.task, 'finalize'), false);
  const g = fixture(); g.rebind(); assert.equal(await g.authority(g.task, 'send'), false);
});
test('provider eligibility is checked anew for delivery, not taken from artifact flags', async () => {
  const f = fixture(); assert.equal(await f.authority(f.task, 'finalize'), true); f.revoke(); assert.equal(await f.authority(f.task, 'send'), false);
});
test('modified stored text with unchanged digest is rejected without source access granting authority', async () => {
  const f = fixture(); const modified = { ...f.task, result: { ...f.task.result!, text: 'Unsupported replacement' } };
  assert.equal(await f.authority(modified, 'send'), false);
});
test('revoked provider eligibility also prevents creation of a final outbound entry', async () => {
  const f = fixture(); f.revoke(); assert.equal(await f.authority(f.task, 'finalize'), false);
});

test('revocation while provider eligibility is pending is detected by a fresh source read',async()=>{
  const f=fixture(()=>f.change({status:'disabled'}));
  assert.equal(await f.authority(f.task,'send'),false);
});
