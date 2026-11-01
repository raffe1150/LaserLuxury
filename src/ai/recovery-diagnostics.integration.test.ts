import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Responses } from 'openai/resources/responses';
import { incidentFlags, incidentConfig, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { cancellationAspects } from './cancellation-information';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
// Optional external baseline copy is used only by the offline comparison runner.
const { priority1hUnifiedEngineTestBoundary: b } = await import(process.env.RECOVERY_AUDIT_BASELINE
  ? pathToFileURL(process.env.RECOVERY_AUDIT_BASELINE).href : '../../server');
const receipts: unknown[] = [];
const question = 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?';
const chat = 'Chat cancellation is enabled.', fee = 'Late cancellation fees are disabled.';
const bad = 'No advance notice is required.', extra = 'There are no cancellation restrictions.';
const candidate = `${chat} ${fee} ${bad} ${extra}`;
const repairedChat = 'You can cancel automatically through chat.', repairedFee = 'There is no late cancellation fee.';
const repaired = `${repairedChat} ${repairedFee}`;
const scenarios = ['claim_count_limit', 'sentence_boundary', 'invalid_citation', 'requested_aspect_rejected', 'entailment_rejected',
  'assessment_missing', 'no_factual_claims', 'quote_missing', 'overlapping_quotes', 'absence_evidence_missing', 'malformed_response', 'candidate_limit', 'tool_calls', 'success', 'freshness_failure'] as const;
for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) for (const scenario of scenarios)
test(`recovery diagnostic/${channel}/${scenario}`, async t => {
  b.reset(); const saved = structuredClone(incidentConfig);
  const events: any[] = [], fallbacks: any[] = [], replies: string[] = [], calls: unknown[] = [];
  let repairs = 0, calendarCalls = 0, current = true;
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (...args: any[]) => {
    if (args[0] === '[BusinessRecoveryDiagnostic]') events.push(JSON.parse(args[1]));
    if (args[0] === '[BusinessSupportGrounding] unsupported reply replaced') fallbacks.push(args[1]);
  });
  const forbidden = async () => { calendarCalls++; assert.fail('Unexpected Calendar or booking operation'); };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'synthetic' }] }));
  });
  const makeClaim = (text: string, quote = text, citation = text === fee || text === repairedFee || text === bad || text === extra
    ? '"lateFeeEnabled": false' : '"automaticCancellationEnabled": true') => ({ claim: text, candidateQuote: quote,
    claimKind: text === chat || text === repairedChat ? 'OTHER' : 'NEGATIVE_ABSENCE', supported: true,
    requiresBusinessEvidence: true, evidence: [{ source: 'structured_business_config', quote: citation }] });
  try {
    const raw = { id: 77, allow_cancellation: true, cancellation_fee_enabled: false, cancellation_deadline_minutes: 1440 };
    const config = b.promptAuditNormalize(raw);
    Object.assign(incidentConfig, { language: 'en', services: [], systemPrompt: '', allowCancellation: config.allowCancellation,
      cancellationFeeEnabled: config.cancellationFeeEnabled, cancellationDeadlineMinutes: config.cancellationDeadlineMinutes,
      cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: 'en', confidence: 1 }), loadCancellationConfig: async () => raw,
      knowledgeSearch: async id => [{ businessId: id, sourceId: 'synthetic-policy', text: 'Fictional studio entrance information.', score: 1, metadata: { source: 'document' } }],
      semanticKnowledgeSearchQueries: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches : [],
      calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async p => {
        calls.push(['generation', p]);
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: question, queries: ['studio information'] }) };
        if (!p.config.systemInstruction.includes('COMPLETENESS REPAIR')) return { text: candidate };
        repairs++;
        return { text: scenario === 'malformed_response' ? '' : scenario === 'candidate_limit' ? 'x'.repeat(1201) : repaired,
          ...(scenario === 'tool_calls' ? { functionCalls: [{ name: 'not_allowed', args: {} }] } : {}) };
      },
      assessBusinessSupportGrounding: async r => {
        calls.push(['extraction', r]);
        if (r.candidateReply === candidate) return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
          claims: [chat, fee, bad, extra].map(text => makeClaim(text)) } as any;
        if (scenario === 'assessment_missing') return null;
        if (scenario === 'no_factual_claims') return { hasBusinessFactualClaims: false, allBusinessClaimsSupported: true, claims: [] };
        const facts = scenario === 'claim_count_limit' ? [repairedChat, repairedFee, bad, extra] : scenario === 'absence_evidence_missing' ? [repairedFee] : [repairedChat, repairedFee];
        return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: facts.map(text => makeClaim(text,
          scenario === 'sentence_boundary' ? text.slice(3) : scenario === 'quote_missing' ? '' : scenario === 'overlapping_quotes' ? repaired : text, scenario === 'invalid_citation' ? 'uncited invented source' : undefined)) } as any;
      },
      assessBusinessClaimEntailment: async r => {
        calls.push(['entailment', r]);
        if (r.cancellationCoverage) return { relation: 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
          coverage: cancellationAspects.map(aspect => ({ aspect, status: 'missing', quote: '' })) };
        if (scenario === 'freshness_failure') current = false;
        const isRepair = [repairedChat, repairedFee].includes(r.atomicClaim);
        return { relation: [bad, extra].includes(r.atomicClaim) || r.requireRequestedFact && (!isRepair || scenario === 'requested_aspect_rejected') ||
          isRepair && scenario === 'entailment_rejected' ? 'UNKNOWN' : 'ENTAILED', claimKind: r.claimKind, explicitAbsenceEvidence: !(isRepair && scenario === 'absence_evidence_missing') };
      },
    });
    await incidentInbound(b, channel, question);
    assert.equal(calendarCalls, 0); assert.equal(replies.length, 1); assert.ok(repairs <= 1);
    assert.doesNotMatch(replies[0], /24/u);
    // Full provider/verifier requests and final answer are compared to the unmodified baseline offline.
    const stable = JSON.parse(JSON.stringify({ channel, scenario, replies, repairs, calendarCalls, calls }, (key, value) =>
      key === 'businessInfoTurnId' ? undefined : value));
    receipts.push(stable);
    if (!process.env.RECOVERY_AUDIT_BASELINE) {
      assert.equal(events.length, 1);
      assert.equal(events[0].businessId, 77);
      if (events[0].outcome === 'fallback') {
        assert.equal(fallbacks.length, 1);
        assert.equal(fallbacks[0].businessInfoTurnId, events[0].businessInfoTurnId);
        assert.equal(fallbacks[0].recoveryStage, events[0].recoveryStage);
        assert.equal(fallbacks[0].recoveryReason, events[0].recoveryReason);
      }
      if (scenario === 'success') {
        assert.equal(events[0].outcome, 'accepted'); assert.equal(events[0].recoveryReason, undefined);
        assert.ok(replies[0].includes(repairedChat)); assert.ok(replies[0].includes(repairedFee));
      } else {
        assert.ok(events[0].decisions.some((e: any) => e.reason === scenario), JSON.stringify(events));
        assert.notEqual(events[0].outcome, 'accepted');
        if (scenario === 'claim_count_limit') {
          assert.equal(events[0].recoveryReason, 'claim_count_limit');
          assert.equal(events[0].counts.repair_extraction.claimCount, 4);
        }
      }
      assert.doesNotMatch(JSON.stringify(events), /Chat cancellation|advance notice|synthetic-policy|46700000001|uncited invented/u);
    }
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});
for (const scenario of ['repair_parser', 'requested_fact_parser', 'coverage_parser'] as const)
test(`recovery diagnostic/SDK/${scenario}`, async t => {
  b.reset(); const events: any[] = [], wire: any[] = [], roles: string[] = [];
  const previous = { AI_PROVIDER: process.env.AI_PROVIDER, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline', OPENAI_MODEL: 'gpt-5.6-luna' });
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (...args: any[]) => {
    if (args[0] === '[BusinessRecoveryDiagnostic]') events.push(JSON.parse(args[1]));
    if (args[0] === '[AIRequest]' && args[1]?.verificationRole) roles.push(args[1].verificationRole);
  });
  const claim = (text: string) => ({ claim: text, candidateQuote: text, requiresBusinessEvidence: true, supported: true,
    claimKind: [chat, repairedChat].includes(text) ? 'OTHER' : 'NEGATIVE_ABSENCE',
    evidence: [{ source: 'structured_business_config', quote: [chat, repairedChat].includes(text)
      ? '"automaticCancellationEnabled": true' : '"lateFeeEnabled": false' }] });
  t.mock.method(Responses.prototype, 'create', async (request: any) => {
    wire.push(request); assert.equal(request.model, 'gpt-5.6-luna');
    const instruction = request.instructions;
    let output: string;
    if (instruction.includes('COMPLETENESS REPAIR')) output = repaired;
    else {
      const body = JSON.parse(request.input[0].content);
      if (instruction.includes('claim and citation extractor')) {
        const isRepair = body.candidateReply === repaired;
        output = isRepair && scenario === 'repair_parser' ? '{"claims":"invalid"}' : JSON.stringify({
          hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
          claims: (isRepair ? [repairedChat, repairedFee] : [chat, fee, bad, extra]).map(claim) });
      } else if (body.cancellationCoverage) output = '{"coverage":"invalid"}';
      else if (instruction.includes('REQUESTED-FACT RECOVERY CHECK:') && [repairedChat, repairedFee].includes(body.atomicClaim) && scenario === 'requested_fact_parser') output = '{"relation":"invalid"}';
      else output = JSON.stringify({ relation: [bad, extra].includes(body.atomicClaim) ||
        instruction.includes('REQUESTED-FACT RECOVERY CHECK:') && ![repairedChat, repairedFee].includes(body.atomicClaim) ? 'UNKNOWN' : 'ENTAILED',
        claimKind: [chat, repairedChat].includes(body.atomicClaim) ? 'OTHER' : 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: true });
    }
    return { output_text: output, output: [] } as any;
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network or database call'));
  try {
    const raw = { id: 77, allow_cancellation: true, cancellation_fee_enabled: false, cancellation_deadline_minutes: 1440 };
    b.configure({ loadCancellationConfig: async () => raw });
    b.businessInformationState('diagnostic-sdk', raw, question, 'en', 'Fictional studio information.');
    const reply = await b.businessSupportGrounding('diagnostic-sdk', question, candidate, 'en');
    receipts.push({ scenario, reply, wire });
    if (!process.env.RECOVERY_AUDIT_BASELINE) {
      assert.equal(events.length, 1);
      const expected = scenario === 'repair_parser' ? 'repair_extraction' : scenario === 'requested_fact_parser' ? 'repair_requested_fact' : 'coverage';
      assert.ok(events[0].decisions.some((e: any) => e.stage === expected && e.reason === 'parser_failure'), JSON.stringify(events));
      assert.ok(roles.includes('original_extraction')); assert.ok(roles.includes('repair_extraction'));
      assert.ok(roles.includes('requested_fact'));
      if (scenario === 'repair_parser') assert.equal(events[0].recoveryReason, 'parser_failure');
      if (scenario === 'coverage_parser') {
        assert.equal(events[0].outcome, 'accepted'); assert.equal(events[0].recoveryReason, undefined);
        assert.ok(reply.includes(repairedChat)); assert.ok(roles.includes('coverage'));
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    b.reset();
  }
});
test.after(() => { if (process.env.RECOVERY_AUDIT_RECEIPT) writeFileSync(process.env.RECOVERY_AUDIT_RECEIPT, JSON.stringify(receipts)); });
