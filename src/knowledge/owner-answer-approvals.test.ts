import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { knowledgeSourceRevision } from '../../knowledge';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import type { AuthenticatedRequest, BusinessRole } from '../auth/types';
import { canonicalHash } from './documents/canonical';
import { lookupActiveOwnerAnswerApproval, ownerAnswerApprovalRouter } from './owner-answer-approvals';

const sourceId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const content = 'Synthetic source text and condition.';
const row = { id: sourceId, business_id: 77, type: 'text' as const, status: 'ready' as const,
  title: 'Synthetic source', content, metadata: { source: 'manual' },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const revision = knowledgeSourceRevision({ id: sourceId, businessId: 77, type: row.type, status: row.status,
  title: row.title, content, metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at });
const submission = { sourceId, revision, language: 'fa', confirmCompleteReview: true, answerText: 'پاسخ نمونه با شرط',
  spans: [{ start: 0, end: content.length, digest: canonicalHash(content) }],
  qualifications: [{ spanIndex: 0, answerPhrase: 'با شرط' }] };

function fakeDatabase() {
  let role: BusinessRole | undefined = 'owner';
  let current = { ...row };
  let stored: Record<string, any> | null = null;
  let writeError: string | undefined;
  const writes: Record<string, any>[] = [];
  const db = {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
        is: (key: string, value: unknown) => { filters.set(key, value); return query; },
        maybeSingle: async () => {
          const data = table === 'business_memberships' ? (role ? { business_id: 77, user_id: ownerId, role, status: 'active' } : null) :
            table === 'knowledge_sources' ? current : stored;
          return { data: data && [...filters].every(([key, value]) => (data as Record<string, unknown>)[key] === value)
            ? { ...data, ...(table === 'knowledge_answer_approvals' ? { source: current } : {}) } : null, error: null };
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, any>) {
      assert.equal(name, 'write_knowledge_answer_approval');
      writes.push(args);
      if (writeError) return { error: { code: writeError } };
      if (args.p_revoke_id) {
        if (!stored || stored.id !== args.p_revoke_id || stored.business_id !== args.p_business_id || stored.revoked_at) return { data: null };
        stored.revoked_at = 'revoked';
      } else {
        stored = { id: approvalId, business_id: args.p_business_id, source_id: args.p_source_id, language: args.p_language,
          source_revision: args.p_revision, reviewed_answer: args.p_reviewed_answer, approved_by: args.p_actor, revoked_at: null };
      }
      return { data: approvalId, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, writes, setRole: (value: BusinessRole | undefined) => { role = value; },
    revise: () => { current = { ...current, content: content + ' Changed.' }; }, setWriteError: (code: string) => { writeError = code; } };
}

async function mount(t: TestContext, fixture: ReturnType<typeof fakeDatabase>, enabled: () => boolean) {
  const app = express();
  app.use(express.json());
  app.use('/businesses/:businessId/approvals', ownerAnswerApprovalRouter(() => fixture.db, (request, response, next) => {
    if (request.get('authorization') !== 'Test synthetic') { response.sendStatus(401); return; }
    (request as AuthenticatedRequest).auth = { userId: ownerId };
    next();
  }, createRequireBusinessPermission('settings.manage', { client: fixture.db }), enabled));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return async (action: 'approve' | 'revoke', body: object, businessId = 77, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/businesses/${businessId}/approvals/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Test synthetic' } : {}) },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
}

const key = { businessId: 77, sourceId, revision, language: 'fa' as const, approvalId };

test('writes require feature enablement, authentication, and active owner membership in the routed tenant', async t => {
  const fixture = fakeDatabase();
  let enabled = false;
  const request = await mount(t, fixture, () => enabled);
  assert.equal(await request('approve', submission), 404);
  enabled = true;
  assert.equal(await request('approve', submission, 77, false), 401);
  assert.equal(await request('approve', submission, 88), 403);
  fixture.setRole('admin');
  assert.equal(await request('approve', submission), 403);
  assert.equal(await request('revoke', { approvalId }), 403);
  fixture.setRole(undefined);
  assert.equal(await request('approve', submission), 403);
  assert.equal(fixture.writes.length, 0);
});

test('owner approval stores reviewed fields and uses server identity, with lookup and revocation', async t => {
  const fixture = fakeDatabase();
  let enabled = true;
  const request = await mount(t, fixture, () => enabled);
  const question = 'آیا این شرط برقرار است؟';
  const proposition = { subject: 'condition', predicate: 'applies', value: 'sample policy', scope: 'sample case',
    modality: 'descriptive', negation: false };
  assert.equal(await request('approve', { ...submission, question }), 400);
  assert.equal(await request('approve', { ...submission, question, proposition, businessId: 88, ownerId: 'spoofed' }), 201);
  const [write] = fixture.writes;
  assert.equal(write.p_actor, ownerId);
  assert.equal(write.p_business_id, 77);
  assert.equal(write.p_revision, revision);
  assert.deepEqual(write.p_source_snapshot, row);
  assert.deepEqual(write.p_reviewed_answer, { answerText: submission.answerText, spans: submission.spans,
    qualifications: submission.qualifications, confirmCompleteReview: true, question, proposition });
  assert.equal((await lookupActiveOwnerAnswerApproval(fixture.db, key, () => enabled))?.id, approvalId);
  assert.equal(await lookupActiveOwnerAnswerApproval(fixture.db, { ...key, businessId: 88 }, () => enabled), null);
  enabled = false;
  assert.equal(await lookupActiveOwnerAnswerApproval(fixture.db, key, () => enabled), null);
  enabled = true;
  assert.equal(await request('revoke', { approvalId }), 200);
  assert.equal(await lookupActiveOwnerAnswerApproval(fixture.db, key, () => enabled), null);
  assert.equal(await request('revoke', { approvalId }), 404);
});

test('invalid spans, missing qualifications, stale sources and concurrent conflicts fail closed', async t => {
  const fixture = fakeDatabase();
  const request = await mount(t, fixture, () => true);
  assert.equal(await request('approve', { ...submission, confirmCompleteReview: false }), 400);
  assert.equal(await request('approve', { ...submission, spans: [{ start: 0, end: content.length, digest: 'wrong' }] }), 400);
  assert.equal(await request('approve', { ...submission, answerText: 'پاسخ نمونه' }), 400);
  assert.equal(fixture.writes.length, 0);
  fixture.setWriteError('23505');
  assert.equal(await request('approve', submission), 409);
  fixture.setWriteError('P0001');
  assert.equal(await request('approve', submission), 409);
  fixture.setWriteError('42501');
  assert.equal(await request('approve', submission), 403);
  fixture.setWriteError('00000');
  const clean = fakeDatabase();
  const cleanRequest = await mount(t, clean, () => true);
  assert.equal(await cleanRequest('approve', submission), 201);
  clean.revise();
  assert.equal(await lookupActiveOwnerAnswerApproval(clean.db, key, () => true), null);
  assert.equal(await cleanRequest('approve', submission), 409);
});

// Exact-question contract for the shared selector. Synthetic manual source;
// not AdMotion production text and not live evidence.
test('selector matches the exact Persian incident question under the shared normalizer only', async t => {
  const { selectOwnerAnswerProposal } = await import('./owner-answer-approvals');
  const { answerEvidence } = await import('../ai/business-information-answer-plan');
  const { chunkKnowledgeContent } = await import('../../knowledge');
  const { normalizeConversationText } = await import('../ai/booking-intelligence');
  const previous = process.env.ODINLINK_OWNER_ANSWER_APPROVALS;
  process.env.ODINLINK_OWNER_ANSWER_APPROVALS = 'true';
  t.after(() => { if (previous === undefined) delete process.env.ODINLINK_OWNER_ANSWER_APPROVALS; else process.env.ODINLINK_OWNER_ANSWER_APPROVALS = previous; });

  const incident = 'من اولین باره می‌خوام بیام استودیو. بهتره چقدر زودتر از نوبتم اونجا باشم؟';
  const policy = 'Synthetic: förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid för att förbereda sig i lugn och ro.';
  const textRow = { ...row, content: policy };
  const textRevision = knowledgeSourceRevision({ id: sourceId, businessId: 77, type: textRow.type, status: textRow.status,
    title: textRow.title, content: policy, metadata: textRow.metadata, createdAt: textRow.created_at, updatedAt: textRow.updated_at });
  const answerText = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند، برای اینکه با آرامش آماده شوند.';
  const evidence = answerEvidence(77, chunkKnowledgeContent(policy).map(chunk =>
    ({ sourceId, businessId: 77, text: chunk.content, metadata: { sourceRevision: textRevision } })));
  assert.equal(evidence.length, 1);
  const facets = [{ id: 'facet-1', subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' as const, obligations: [] }];
  const approvalFor = (storedQuestion: string) => ({ id: approvalId, business_id: 77, source_id: sourceId, source_revision: textRevision,
    language: 'fa', approved_by: ownerId, approved_at: '2026-01-02T00:00:00Z', revoked_at: null,
    reviewed_answer: { question: storedQuestion, answerText, confirmCompleteReview: true,
      spans: [{ start: 0, end: policy.length, digest: canonicalHash(policy) }],
      qualifications: [{ spanIndex: 0, answerPhrase: 'برای اینکه با آرامش آماده شوند' }],
      proposition: { subject: 'first-time visitors', predicate: 'arrival timing', value: 'approximately ten minutes before the booked appointment',
        scope: 'first visit', modality: 'recommended', negation: false } } });
  const dbFor = (stored: ReturnType<typeof approvalFor>) => ({
    from() {
      const filters = new Map<string, unknown>();
      const query = { select: () => query, abortSignal: () => query,
        eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
        is: (key: string, value: unknown) => { filters.set(key, value); return query; },
        maybeSingle: async () => ({ error: null, data: [...filters].every(([key, value]) => (stored as Record<string, unknown>)[key] === value)
          ? { ...stored, source: textRow } : null }) };
      return query;
    },
  }) as unknown as SupabaseClient;
  const select = (storedQuestion: string, question: string) => selectOwnerAnswerProposal(dbFor(approvalFor(storedQuestion)),
    { businessId: 77, question, language: 'fa', facets, evidence }, new AbortController().signal);

  // Raw incident text (ZWNJ + Arabic question mark) and the foreground-normalized form.
  const exact = await select(incident, incident);
  assert.ok(exact, 'raw exact incident question must match');
  assert.equal(exact.proposal.text, answerText);
  assert.equal(exact.key.approvalId, approvalId);
  assert.ok(await select(incident, normalizeConversationText(incident)));
  assert.ok(await select(normalizeConversationText(incident), incident));
  // Equivalent representations under the same trusted normalizer.
  for (const variant of [
    incident.replace('‌', ' '),                       // half-space written as a space
    '  ' + incident.replace(/ /g, '  ').replace('. ', '.\n') + '\n', // whitespace/newline noise
    incident.replace('؟', '?'),                            // Latin question mark
  ]) assert.ok(await select(incident, variant), JSON.stringify(variant));
  assert.ok(await select(incident.replace('‌', ' '), incident));

  // Materially different or merely similar questions never match (no fuzzy matching).
  for (const different of [
    incident.replace('اولین', 'دومین'),
    incident.replace('زودتر', 'دیرتر'),
    'بهتره چقدر زودتر از نوبتم اونجا باشم؟',
    incident.replace('می‌خوام', 'میخوام'),
    incident + ' حداکثر؟',
    '',
  ]) assert.equal(await select(incident, different), null, JSON.stringify(different));
});
