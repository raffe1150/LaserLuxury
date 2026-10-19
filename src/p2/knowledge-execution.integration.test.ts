import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { naturalLocationCases } from '../../tests/fixtures/knowledge-natural-location';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { KnowledgeRunner, deliverKnowledge } from './knowledge-runner';
import { InformationBudget } from '../ai/business-information-answer-plan';
import { DurableKnowledgeBudget } from './durable-knowledge-budget';
import { verificationAdmissionDiagnostic } from '../ai/knowledge-answer-protocol';
process.env.NODE_ENV = 'test'; process.env.GEMINI_API_KEY = 'synthetic-only';
const { executeDurableKnowledgeTask, priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => b.reset());
for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) {
  for (const [language, question, fact] of naturalLocationCases) test(`${channel}/${language}: real Knowledge-only entry independently verifies with frozen history and durable attempts`, async t => {
    const old = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;
    const natural = process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES;
    process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true'; process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES = 'false';
    t.after(() => { if (old === undefined) delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = old;
      if (natural === undefined) delete process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES; else process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES = natural; });
    for (const level of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, level, () => {});
    const stages: string[] = []; const diagnostics: any[] = []; const history = [{ role: 'user' as const, content: 'Discussing a studio visit.' }];
    const scope = { businessId: 77, channel, providerAccount: 'account', conversationId: randomUUID() };
    const db = new FakeKnowledgeDatabase(); const repo = new FakeKnowledgeLifecycle(db, Date.now, async () => true);
    const acceptance = await repo.accept(scope, randomUUID(), { question, language, history });
    b.configure({ evidenceFirstDecisionDiagnostic: event => diagnostics.push(event), knowledgeSearch: async () => [{ businessId: 77, sourceId: 'doc', text: fact, score: 1,
        metadata: { source: 'document', documentRevision: 'v1' } }], semanticKnowledgeSearch: async () => [],
      validateKnowledgeMatches: async (_id, matches) => matches,
      geminiGenerate: async (p: any) => {
        const instruction = p.config.systemInstruction; const data = JSON.parse(p.contents[0].parts[0].text);
        if (instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')) {
          stages.push('extraction'); assert.deepEqual(data.relevantHistory, history); assert.deepEqual(p.config.tools, []);
          return { text: JSON.stringify({ units: [{ facetIds: ['f1'], subject: 'studio', predicate: 'offers', value: fact,
            modality: 'descriptive', negation: false, scope: 'this business', qualifiers: [], language, text: fact,
            evidenceRefs: [{ evidenceId: 'e1', exactQuote: fact }] }] }) };
        }
        if (instruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')) {
          stages.push('verification');
          return { text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id, relation: 'ENTAILED', facetIds: u.facetIds,
            meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true,
            negativeAbsence: false, explicitAbsenceEvidence: false })), coverage: data.facets.map((f: any) => ({ facetId: f.id,
              requestAligned: true, materialFactsComplete: true, materialUnitIds: data.units.map((u: any) => u.id),
              obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })) }) };
        }
        assert.fail('No separate planner/presentation call expected for this deterministic complete location question');
      },
      calendarAdapter: { getCalendarId: () => 'unused', getEvents: async () => assert.fail('No Booking reads'),
        insertAppointment: async () => assert.fail('No Booking mutations'), cancelAppointment: async () => assert.fail('No Booking mutations'),
        updateAppointment: async () => assert.fail('No Booking mutations'), checkSlots: async () => assert.fail('No Booking mutations') },
    });
    const runner = new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, context,
      { id: 77, businessId: 77, businessName: 'Synthetic studio', language, toneConfig: { tonePreset: 'warm' } }, async () => true), 'worker');
    const delivery = await runner.run(scope, acceptance.task!.id);
    assert.ok(delivery, JSON.stringify({stages, diagnostics})); assert.equal(delivery.text, fact); assert.deepEqual(stages, ['extraction', 'verification']);
    assert.equal((await repo.get(scope, acceptance.task!.id))!.modelAttempts, 2);
  });
}
test('30/35/40 budgets retain original acceptance and model accounting; foreground still 20s', () => {
  const now = Date.now();
  assert.equal(new InformationBudget(40000).deadlineAt - new InformationBudget().startedAt <= 20001, true);
  for (const duration of [30000, 35000, 40000]) {
    const task = { acceptedAt: now - 2000, expiresAt: now + duration - 2000, modelAttempts: 2 } as any;
    const budget = new DurableKnowledgeBudget(task, new AbortController().signal, async () => {});
    assert.equal(budget.startedAt, now - 2000); assert.equal(budget.deadlineAt, task.expiresAt); assert.equal(budget.attempts, 2);
  }
});
test('incident admission arithmetic remains 7204-1500=5704, below 6000', () => {
  const event = verificationAdmissionDiagnostic(7204, 1500, 6000, 'before_queue');
  assert.equal(event.effectiveAllowanceMs, 5704); assert.equal(event.admitted, false);
});

// SIMULATED durations: intercepted providers advance a virtual clock. These are
// not production latency measurements or evidence of guaranteed remote delivery.
for (const [name, extractionMs, verificationMs, queueMs, reservationMs] of [['incident', 10014, 6963, 0, 0], ['slow', 15000, 11000, 0, 0], ['very-slow', 19000, 16000, 0, 0], ['queued-incident', 10014, 6963, 10000, 0], ['reservation-boundary', 9700, 6000, 0, 200]] as const) {
  for (const duration of [20000, 30000, 35000, 40000]) test(`timing simulation ${name}/${duration}ms: admission versus verified completion`, async t => {
    const flags = ['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE', 'ODINLINK_GROUNDED_NATURAL_RESPONSES'] as const;
    const previous = flags.map(key => process.env[key]);
    process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true'; process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES = 'false';
    t.after(() => flags.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
    let now = Date.now(); const start = now; t.mock.method(Date, 'now', () => now);
    for (const level of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, level, () => {});
    let retrieval = false; let verificationAdmitted = false; let compositionAttempted = false; const decisions: any[] = [];
    const facts = ['Parking is near the studio.', 'The nearby car park charges a fee.', 'Parking spaces cannot be reserved.'];
    const fact = facts.join('\n');
    b.configure({ evidenceFirstDecisionDiagnostic: event => decisions.push(event),
      knowledgeSearch: async () => { if (!retrieval) { now += 2782; retrieval = true; } return [{ businessId: 77, sourceId: 'doc', text: fact, score: 1, metadata: { source: 'document', documentRevision: 'v1' } }]; },
      semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id, matches) => matches,
      geminiGenerate: async (p: any) => {
        const data = JSON.parse(p.contents[0].parts[0].text);
        if (p.config.systemInstruction.includes('UNIT EXTRACTION')) {
          await modelLatency(extractionMs);
          return { text: JSON.stringify({ units: facts.map(text => ({ facetIds: ['f1'], subject: 'studio', predicate: 'states', value: text, modality: 'descriptive',
            negation: false, scope: 'studio', qualifiers: [], language: 'en', text, evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] })) }) };
        }
        if (p.config.systemInstruction.includes('VERIFIED-UNIT PRESENTATION')) {
          compositionAttempted = true; await modelLatency(300);
          return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
        }
        assert.ok(p.config.systemInstruction.includes('BATCH ENTAILMENT')); assert.equal(data.units.length, 3); verificationAdmitted = true; await modelLatency(verificationMs);
        return { text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id, relation: 'ENTAILED', facetIds: u.facetIds,
          meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, materialUnitIds: data.units.map((u: any) => u.id),
            obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })) }) };
      },
    });
    const scope = { businessId: 77, channel: 'whatsapp' as const, providerAccount: 'account', conversationId: randomUUID() };
    const db = new FakeKnowledgeDatabase(); const repo = new FakeKnowledgeLifecycle(db, () => now, async () => true);
    const a = await repo.accept(scope, randomUUID(), { question: 'Where can I park?', language: 'en', history: [] }, { executionMs: duration });
    // Model heartbeat execution explicitly: virtual clock jumps do not fire real
    // setInterval callbacks. Renew every simulated 3s, without extending expiry.
    const advance = async (ms: number) => {
      while (ms > 0) {
        const step = Math.min(3000, ms); now += step; ms -= step;
        const running = db.rows.tasks.get(a.task!.id)!;
        if (running.lease) await repo.renew(scope, { taskId: running.id, owner: running.lease.owner, fence: running.fence }, 15000);
      }
    };
    const modelLatency = async (ms: number) => {
      // Honor the existing per-call cap and publication reserve. Virtual time
      // alone cannot fire Promise.race's real timer, so emulate that timeout.
      const allowance = Math.min(20000, a.task!.expiresAt - now - 1500);
      await advance(Math.min(ms, allowance));
      if (ms > allowance) throw new Error('synthetic provider timeout');
    };
    now += queueMs;
    let delivery; let reservations = 0;
    try { delivery = await new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, { ...context,
      reserveModelAttempt: async () => { await context.reserveModelAttempt(); if (++reservations === 2) now += reservationMs; } },
      { id: 77, businessId: 77, language: 'en' }, async () => true), 'worker').run(scope, a.task!.id); }
    catch (error) { assert.equal((error as Error).message, 'knowledge_runner_stopped'); delivery = null; }
    const completed = Boolean(delivery);
    const effectiveVerificationAllowance = duration - queueMs - 2782 - extractionMs - 1500 - reservationMs;
    const expected = extractionMs <= Math.min(20000, duration - queueMs - 2782 - 1500) &&
      effectiveVerificationAllowance >= 6000 && verificationMs <= Math.min(20000, effectiveVerificationAllowance) &&
      queueMs + 2782 + extractionMs + reservationMs + verificationMs + 300 + 500 < duration;
    assert.equal(completed, expected);
    if ((name === 'incident' || name === 'queued-incident') && duration - queueMs === 20000) {
      assert.equal(verificationAdmitted, false); const rejected = decisions.find(e => e.admission?.effectiveAllowanceMs === 5704);
      assert.ok(rejected); assert.equal(rejected.admission.admitted, false);
    }
    if (name === 'reservation-boundary' && duration === 20000) {
      assert.equal(verificationAdmitted, false);
      assert.ok(decisions.some(e => e.admission?.effectiveAllowanceMs === 6018 && e.admission.admitted));
      assert.ok(decisions.some(e => e.admission?.effectiveAllowanceMs === 5818 && !e.admission.admitted));
    }
    if (completed) {
      for (const text of facts) assert.ok(delivery!.text.includes(text), 'all three material facts survive publication');
      const sent = await deliverKnowledge(repo, { authorize: async () => true,
        resolve: async () => ({ recipient: 'synthetic', channel: scope.channel, providerAccount: scope.providerAccount }),
        eligible: async () => true, send: async () => { now += 500; return { kind: 'API_ACCEPTED', providerMessageId: 'synthetic' }; } },
        scope, a.task!.id, delivery!.id, 'sender');
      assert.equal(sent!.settled, true); assert.equal(sent!.outcome.kind, 'API_ACCEPTED');
      assert.ok(now < a.task!.expiresAt, '500ms simulated API acceptance fits original expiry');
      assert.equal(db.rows.deliveries.size, 1);
    }
    t.diagnostic(JSON.stringify({ simulation: name, proposedUnits: 3, configuredCompositionMs: 300, compositionAttempted, deadlineMs: duration, elapsedMs: now - start, verificationAdmitted,
      providerTimeout: decisions.some(e => e.failureCategory === 'TIMEOUT' && e.providerAttempted === true),
      admissionRejected: decisions.some(e => e.admission?.admitted === false),
      completeVerifiedPublication: completed, simulatedApiAcceptanceBeforeExpiry: completed, customerDelivery: 'UNCONFIRMED' }));
  });
}

for (const failure of ['planner-timeout', 'malformed-planner', 'malformed-extraction', 'malformed-verifier', 'source-revoked', 'foreign-tenant']) {
  test(`durable Knowledge ${failure}: no unsupported final outbox entry`, async t => {
    const old = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true';
    t.after(() => { if (old === undefined) delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = old; });
    for (const level of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, level, () => {});
    const scope = { businessId: 77, channel: 'telegram' as const, providerAccount: 'account', conversationId: randomUUID() };
    const db = new FakeKnowledgeDatabase(); const repo = new FakeKnowledgeLifecycle(db, Date.now, async () => true);
    let current = true; let calls = 0; const fact = 'Parking is near the studio.';
    const question = failure.includes('planner') ? 'Are drop-in visits allowed?' : 'Where can I park?';
    const a = await repo.accept(scope, randomUUID(), { question, language: 'en', history: [] });
    b.configure({ knowledgeSearch: async () => [{ businessId: failure === 'foreign-tenant' ? 88 : 77, sourceId: 'doc', text: fact,
        score: 1, metadata: { source: 'document', documentRevision: 'v1' } }],
      semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches : [],
      geminiGenerate: async (p: any) => {
        calls++; const instruction = p.config.systemInstruction;
        if (instruction.includes('retrieval query planner')) {
          if (failure === 'planner-timeout') throw new Error('synthetic provider timeout');
          return { text: 'malformed' };
        }
        if (instruction.includes('UNIT EXTRACTION')) {
          if (failure === 'malformed-extraction') return { text: 'malformed' };
          return { text: JSON.stringify({ units: [{ facetIds: ['f1'], subject: 'studio', predicate: 'has', value: 'parking nearby', modality: 'descriptive',
            negation: false, scope: 'studio', qualifiers: [], language: 'en', text: fact, evidenceRefs: [{ evidenceId: 'e1', exactQuote: fact }] }] }) };
        }
        if (failure === 'source-revoked') {
          current = false; const data = JSON.parse(p.contents[0].parts[0].text);
          return { text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id, relation: 'ENTAILED', facetIds: u.facetIds,
            meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
            coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, materialUnitIds: ['u1'],
              obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: ['u1'] })) })) }) };
        }
        return { text: 'malformed' };
      },
    });
    const delivery = await new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, context,
      { id: 77, businessId: 77, language: 'en' }, async () => true), 'worker').run(scope, a.task!.id);
    assert.equal(delivery, null); assert.equal(db.rows.deliveries.size, 0); assert.ok(calls <= 2);
  });
}
