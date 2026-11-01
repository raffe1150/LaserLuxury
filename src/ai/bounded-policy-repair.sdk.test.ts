import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Responses } from 'openai/resources/responses';
import { incidentFlags, incidentConfig, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { cancellationAspects } from './cancellation-information';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline', OPENAI_MODEL: 'gpt-5.6-luna', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import(process.env.BOUNDED_REPAIR_BASELINE_SERVER
  ? pathToFileURL(process.env.BOUNDED_REPAIR_BASELINE_SERVER).href : '../../server');
const chat = 'You can cancel automatically through chat.', fee = 'There is no late cancellation fee.';
const bad = 'No advance cancellation notice is required.';
const email = 'Cancellation requests are accepted by email.', staff = 'Staff reviews cancellation requests.';
const source = `${email} ${staff}`;
const question = 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?';

const receipts: unknown[] = [];
for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const)
for (const mode of ['shared_sentence', 'independent_sentences', 'verification_ceiling'] as const)
test(`bounded repair SDK/${channel}/${mode}`, async t => {
  b.reset(); const saved = structuredClone(incidentConfig), replies: string[] = [], diagnostics: any[] = [], providerCalls: any[] = [];
  let providerDispatches = 0, repairs = 0, repairVerifierCalls = 0, coverageCalls = 0, calendarCalls = 0, requestedAspectChecks = 0;
  const original = mode === 'independent_sentences' ? `${chat} ${fee} ${bad}` : `${chat.slice(0, -1)}; ${fee.slice(0, -1)}; ${bad}`;
  const extra = ['No cancellation restrictions apply.', 'All appointments are refundable.'];
  const repairFacts = mode === 'verification_ceiling' ? [chat, email, staff, ...extra] : [bad, ...extra, chat, fee];
  const repair = repairFacts.join(' ');
  const good = mode === 'verification_ceiling' ? [chat, email, staff] : [chat, fee];
  // Keep the ceiling case genuinely fresh: it must not match an ordinary
  // original claim/quote receipt by terminal punctuation alone.
  const originalChatClaim = mode === 'verification_ceiling' ? 'Automatic cancellation through chat is enabled.' : chat;
  const makeClaim = (text: string, quote = text) => ({ claim: text === chat && quote === chat.slice(0, -1) ? originalChatClaim : text, candidateQuote: quote, requiresBusinessEvidence: true, supported: true,
    claimKind: [chat, email, staff].includes(text) ? 'OTHER' : 'NEGATIVE_ABSENCE',
    evidence: [{ source: [email, staff].includes(text) ? 'retrieved_knowledge' : 'structured_business_config',
      quote: mode === 'verification_ceiling' && extra.includes(text) ? 'Uncited invented source' : [email, staff].includes(text) ? text : text === chat ? '"automaticCancellationEnabled": true' : '"lateFeeEnabled": false' }] });
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (...args: any[]) => {
    if (args[0] === '[BusinessRecoveryDiagnostic]') diagnostics.push(JSON.parse(args[1]));
    if (args[0] === '[AIRequest]') providerCalls.push({ stage: args[1].stage, role: args[1].verificationRole || null, attempt: args[1].attempt, success: args[1].success });
  });
  t.mock.method(Responses.prototype, 'create', async (request: any) => {
    providerDispatches++;
    assert.equal(request.model, 'gpt-5.6-luna');
    const instruction = request.instructions;
    const respond = (value: unknown) => ({ output_text: typeof value === 'string' ? value : JSON.stringify(value), output: [] }) as any;
    if (instruction.includes('COMPLETENESS REPAIR')) { repairs++; return respond(repair); }
    if (instruction.includes('retrieval query planner')) return respond({ canonicalMeaning: question, queries: [source] });
    let data: any;
    try { data = JSON.parse(request.input[0].content); } catch { return respond(original); }
    if (instruction.includes('claim and citation extractor')) return respond({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: data.candidateReply === original ? [makeClaim(chat, mode === 'independent_sentences' ? chat : chat.slice(0, -1)),
        makeClaim(fee, mode === 'independent_sentences' ? fee : fee.slice(0, -1)), makeClaim(bad)] : repairFacts.map(text => makeClaim(text)) });
    if (data.cancellationCoverage) { coverageCalls++; return respond({ relation: 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
      coverage: cancellationAspects.map(aspect => ({ aspect, status: 'missing', quote: '' })) }); }
    const requested = instruction.includes('REQUESTED-FACT RECOVERY CHECK:');
    if (repairs) repairVerifierCalls++;
    if (requested) {
      requestedAspectChecks++;
      assert.equal(data.relevantContext.customerQuestion, question);
      // Enforce the real requested-aspect contract instead of always accepting
      // a partial atom under the old whole-question prompt.
      assert.match(instruction, /directly answers at least one explicitly requested aspect/u);
      assert.match(instruction, /complete-question coverage is checked separately/u);
      assert.match(instruction, /sharing a topic is insufficient/u);
      assert.match(instruction, /Do not rewrite or complete the quote/u);
    }
    const isGood = (repairs ? good : [chat, fee, originalChatClaim]).includes(data.atomicClaim);
    const adjudication = instruction.includes('strict final semantic adjudicator');
    const relation = !isGood || repairs && mode === 'verification_ceiling' && !requested && !adjudication ? 'UNKNOWN' : 'ENTAILED';
    return respond({ relation, claimKind: [chat, email, staff, originalChatClaim].includes(data.atomicClaim) ? 'OTHER' : 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: data.atomicClaim === fee });
  });
  const forbidden = async () => { calendarCalls++; assert.fail('Unexpected Calendar or booking operation'); };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'synthetic' }] }));
  });
  try {
    const raw = { id: 77, allow_cancellation: true, cancellation_fee_enabled: false, cancellation_deadline_minutes: 1440 };
    const config = b.promptAuditNormalize(raw);
    Object.assign(incidentConfig, { language: 'en', services: [], systemPrompt: '', allowCancellation: config.allowCancellation,
      cancellationFeeEnabled: config.cancellationFeeEnabled, cancellationDeadlineMinutes: config.cancellationDeadlineMinutes,
      cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: 'en', confidence: 1 }), loadCancellationConfig: async () => raw,
      knowledgeSearch: async id => [{ businessId: id, sourceId: 'sdk-source', text: source, score: 1, metadata: { source: 'document' } }],
      semanticKnowledgeSearchQueries: async () => [], validateKnowledgeMatches: async (_id, matches) => matches,
      calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
    await incidentInbound(b, channel, question);
    receipts.push({ channel, mode, providerDispatches, providerCalls, repairVerifierCalls, coverageCalls, repairs, reply: replies[0], diagnostics });
    assert.equal(providerCalls.length, providerDispatches, 'Count actual SDK dispatches, excluding cached checks');
    assert.equal(replies.length, 1); assert.equal(calendarCalls, 0); assert.equal(coverageCalls, 1);
    for (const fact of good) assert.ok(replies[0].includes(fact), replies[0]);
    assert.match(replies[0], /Still unverified:.*advance-notice requirements/u);
    assert.doesNotMatch(replies[0], /No advance|24/u);
    assert.equal(repairs, mode === 'independent_sentences' ? 0 : 1);
    assert.ok(requestedAspectChecks > 0); assert.ok(repairVerifierCalls <= 12);
    if (mode === 'shared_sentence') {
      assert.equal(providerCalls.length, 12, 'Exact incident reproduction must save two ordinary repair dispatches');
      assert.equal(repairVerifierCalls, 2, 'Full repaired sentences still receive two requested-aspect checks');
      assert.equal(diagnostics[0].decisions.find((d: any) => d.stage === 'repair_entailment' && d.reason === 'verified_result_reused')?.count, 2);
    }
    if (mode === 'verification_ceiling') {
      assert.equal(repairVerifierCalls, 12, 'Three facts, each initial/retry/adjudication/requested-aspect: strict ceiling');
      assert.equal(diagnostics[0].counts.completeness_repair.attemptedFacts, 3);
    }
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});

test.after(() => { if (process.env.CALL_BUDGET_RECEIPT) writeFileSync(process.env.CALL_BUDGET_RECEIPT, JSON.stringify(receipts)); });
