import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { naturalLocationCases } from '../../tests/fixtures/knowledge-natural-location';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { KnowledgeRunner, deliverKnowledge } from './knowledge-runner';
import { InformationBudget } from '../ai/business-information-answer-plan';
import { knowledgeProposalAllowance } from '../ai/knowledge-planning';
import { knowledgeExecutionDeadline } from './knowledge-operation';
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
          stages.push('extraction'); assert.deepEqual(data.allowedFacetIds,data.facets.map((f:any)=>f.id));
          assert.match(instruction,/multiple units answering the same question reuse the same facet ID/);
          assert.ok(data.evidence.every((e:any)=>!Object.hasOwn(e,'version')));
          assert.deepEqual(data.relevantHistory, history); assert.deepEqual(p.config.tools, []);
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
          await modelLatency(extractionMs,true);
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
    const modelLatency = async (ms: number,proposal=false) => {
      // Honor the existing per-call cap and publication reserve. Virtual time
      // alone cannot fire Promise.race's real timer, so emulate that timeout.
      const allowance = Math.max(0,Math.min(20000, knowledgeExecutionDeadline(a.task!) - now - 1500,proposal?knowledgeProposalAllowance(knowledgeExecutionDeadline(a.task!)-now-1500):Infinity));
      await advance(Math.min(ms, allowance));
      if (ms > allowance) throw new Error('synthetic provider timeout');
    };
    now += queueMs;
    let delivery; let reservations = 0;
    try { delivery = await new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, { ...context,
      reserveModelAttempt: async () => { await context.reserveModelAttempt(); if (++reservations === 2) now += reservationMs; } },
      { id: 77, businessId: 77, language: 'en' }, async () => true), 'worker').run(scope, a.task!.id); }
    catch (error) { assert.match((error as Error).message, /^knowledge_(?:runner|operation)_stopped$/); delivery = null; }
    const completed = Boolean(delivery);
    const executionMs=knowledgeExecutionDeadline(a.task!)-start;
    const effectiveVerificationAllowance = executionMs - queueMs - 2782 - extractionMs - 1500 - reservationMs;
    const expected = extractionMs <= Math.min(20000,knowledgeProposalAllowance(executionMs - queueMs - 2782 - 1500)) &&
      effectiveVerificationAllowance >= 6000 && verificationMs <= Math.min(20000, effectiveVerificationAllowance) &&
      queueMs + 2782 + extractionMs + reservationMs + verificationMs + 300 < executionMs;
    assert.equal(completed, expected);
    if(effectiveVerificationAllowance<6000)assert.equal(verificationAdmitted,false,'independent verification cannot start below its minimum allowance');
    assert.equal(a.task!.expiresAt,start+duration,'publication reserve never extends the original expiry');
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
    t.diagnostic(JSON.stringify({ simulation: name, proposedUnits: 3, configuredCompositionMs: 300, compositionAttempted, deadlineMs: duration, executionMs, elapsedMs: now - start, verificationAdmitted,
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
    assert.equal(delivery, null); assert.equal(db.rows.deliveries.size, 0); if(failure==='planner-timeout')assert.equal(calls,3,'one failed planner, literal recovery, proposal and malformed independent verdict; no retry');else assert.ok(calls<=2);
  });
}

// Existing executor and lifecycle fixtures; no separate answer engine or harness.
const standaloneQuestions:Record<string,string>={en:'Is parking available?',sv:'Finns det parkering?',de:'Gibt es Parkplätze?',es:'¿Hay aparcamiento?',fa:'آیا پارکینگ وجود دارد؟',ar:'هل يوجد موقف سيارات؟'};
for(const [language,question]of Object.entries(standaloneQuestions))for(const outcome of ['complete','partial','missing-condition','invalid-facet','bad-quote','conflict','unknown']as const)
 test(`durable literal/${language}/${outcome}: full obligation coverage remains separate from valid facets and exact quotes`,async t=>{
  const previous={evidence:process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE,natural:process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES};
  process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';
  t.after(()=>{for(const[k,v]of [['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE',previous.evidence],['ODINLINK_GROUNDED_NATURAL_RESPONSES',previous.natural]]){if(v===undefined)delete process.env[k!];else process.env[k!]=v;}});
  for(const level of ['log','info','warn','error']as const)t.mock.method(console,level,()=>{});
  const fact=naturalLocationCases.find(c=>c[0]===language)![2];const sentences=fact.match(/[^.]+\./gu)!;
  const db=new FakeKnowledgeDatabase(),repo=new FakeKnowledgeLifecycle(db,Date.now,async()=>true);const calls:string[]=[],events:any[]=[];
  const scope={businessId:77,channel:'messenger' as const,providerAccount:'account',conversationId:randomUUID()};
  const accepted=await repo.accept(scope,randomUUID(),{question,language,history:[]},{executionMs:40000});
  b.configure({evidenceFirstDecisionDiagnostic:event=>events.push(event),semanticKnowledgeSearch:async()=>[],
    knowledgeSearch:async()=>[{businessId:77,sourceId:'doc',text:fact,score:1,metadata:{source:'document',documentRevision:'v1'}}],validateKnowledgeMatches:async(_id,matches)=>matches,
    geminiGenerate:async p=>{
      const instruction=p.config.systemInstruction;const data=JSON.parse(p.contents[0].parts[0].text);
      if(instruction.includes('retrieval query planner'))assert.fail('Eligible standalone literal question must not spend a planner attempt');
      if(instruction.includes('UNIT EXTRACTION')){
        calls.push('proposal');assert.deepEqual(data.allowedFacetIds,['f1']);assert.equal(data.question,question);
        return {text:JSON.stringify({units:sentences.map(text=>({facetIds:[outcome==='invalid-facet'?'f9':'f1'],subject:'studio',predicate:'offering',value:text,modality:'descriptive',negation:false,scope:'this business',qualifiers:[],language,text:text.trim(),
          evidenceRefs:[{evidenceId:'e1',exactQuote:outcome==='bad-quote'?'No such quotation exists in this source.':text.trim()}]}))})};
      }
      if(instruction.includes('VERIFIED-UNIT PRESENTATION'))return {text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
      assert.ok(instruction.includes('BATCH ENTAILMENT'),'expected independent verifier');calls.push('verification');
      assert.equal(data.units.length,sentences.length);assert.deepEqual(data.units.map((u:any)=>u.facetIds),sentences.map(()=>['f1']));
      return {text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:outcome==='conflict'?'CONTRADICTED':outcome==='unknown'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:outcome!=='missing-condition',relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
        coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:outcome==='complete',incompletenessReason:outcome==='missing-condition'?'MISSING_CONDITION':outcome==='complete'?'NONE':'UNRESOLVED',materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))})};
    }});
  const delivery=await new KnowledgeRunner(repo,(task,context)=>executeDurableKnowledgeTask(task,context,{id:77,businessId:77,language},async()=>true),'worker').run(scope,accepted.task!.id);
  assert.ok(events.some(e=>e.reason==='LITERAL_REQUEST_DIRECT'),'literal planning selected');
  assert.deepEqual(calls,['invalid-facet','bad-quote'].includes(outcome)?['proposal']:['proposal','verification']);
  if(outcome==='complete'){assert.ok(delivery,'complete literal result must finalize: '+JSON.stringify({calls,events}));for(const sentence of sentences)assert.ok(delivery.text.includes(sentence.trim()),'material sentence retained');assert.equal(db.rows.deliveries.size,1);}
  else{assert.equal(delivery,null);assert.equal(db.rows.deliveries.size,0,'no PARTIAL or invalid result becomes a VERIFIED durable publication');}
 });

const referenceQuestions:Record<string,string>={en:'Where is that parking?',sv:'Var är den parkeringen?',de:'Wo ist das Parkhaus?',es:'¿Dónde está eso?',fa:'آن پارکینگ کجا است؟',ar:'أين ذلك الموقف؟'};
for(const [language,question]of Object.entries(referenceQuestions))for(const resolved of [false,true])
 test(`durable reference/${language}/${resolved}: frozen history is planner input, never evidence authority`,async t=>{
  const old=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';t.after(()=>{if(old===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=old;});
  for(const level of ['log','info','warn','error']as const)t.mock.method(console,level,()=>{});
  const fact=naturalLocationCases.find(c=>c[0]===language)![2],history=[{role:'assistant' as const,content:fact}];
  const db=new FakeKnowledgeDatabase(),repo=new FakeKnowledgeLifecycle(db,Date.now,async()=>true);const scope={businessId:77,channel:'instagram' as const,providerAccount:'account',conversationId:randomUUID()};
  const accepted=await repo.accept(scope,randomUUID(),{question,language,history});let planned=0,verified=0;
  b.configure({knowledgeSearch:async()=>[{businessId:77,sourceId:'doc',text:fact,score:1,metadata:{source:'document',documentRevision:'v1'}}],semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(_id,matches)=>matches,
    geminiGenerate:async p=>{const instruction=p.config.systemInstruction,data=JSON.parse(p.contents[0].parts[0].text);
      if(instruction.includes('retrieval query planner')){planned++;assert.deepEqual(data.referenceHistory,history);return {text:JSON.stringify({canonicalMeaning:'location of the parking mentioned in frozen history',queries:[],referenceResolution:resolved?'RESOLVED':'UNRESOLVED',requestKind:'BUSINESS_INFORMATION',requestedFacets:[{subject:'studio',attribute:'parking',questionType:'description'}]})};}
      if(instruction.includes('UNIT EXTRACTION')){assert.deepEqual(data.relevantHistory,history);return {text:JSON.stringify({units:[{facetIds:['f1'],subject:'studio',predicate:'offering',value:fact,modality:'descriptive',negation:false,scope:'studio',qualifiers:[],language,text:fact,evidenceRefs:[{evidenceId:'e1',exactQuote:fact}]}]})};}
      verified++;return {text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1'],obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:['u1']}))}))})};
    }});
  const delivery=await new KnowledgeRunner(repo,(task,context)=>executeDurableKnowledgeTask(task,context,{id:77,businessId:77,language},async()=>true),'worker').run(scope,accepted.task!.id);
  assert.equal(planned,1);assert.equal(verified,resolved?1:0);assert.equal(Boolean(delivery),resolved);assert.equal(db.rows.deliveries.size,resolved?1:0);
 });

const negativeTranslations:Record<string,string>={en:'AdMotion Studio does not offer free parking and cannot reserve parking spaces.',sv:'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.',de:'AdMotion Studio bietet keine kostenlosen Parkplätze an und kann keine Parkplätze reservieren.',es:'AdMotion Studio no ofrece aparcamiento gratuito y no puede reservar plazas.',fa:'استودیوی AdMotion پارکینگ رایگان ارائه نمی‌دهد و نمی‌تواند جای پارک رزرو کند.',ar:'لا يوفر استوديو AdMotion مواقف مجانية ولا يمكنه حجز أماكن للوقوف.'};
const documentInputs=new Map<string,Promise<ReturnType<typeof import('../knowledge/documents/service').documentChunks>>>();
for(const format of ['pdf','txt'])for(const language of Object.keys(standaloneQuestions))
 test(`durable ${format}/${language}: real extraction, exact citation and scoped descriptive negatives`,async t=>{
  const old=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';t.after(()=>{if(old===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=old;});
  const preflights:any[]=[];for(const level of ['log','info','warn','error']as const)t.mock.method(console,level,(...args)=>{if(args[0]==='[AsyncKnowledgePreflight]')preflights.push(JSON.parse(String(args[1])));});
  if(!documentInputs.has(format))documentInputs.set(format,(async()=>{const {readFile}=await import('node:fs/promises');const {extractInProcess}=await import('../knowledge/documents/extraction-process');const {documentChunks}=await import('../knowledge/documents/service');
    const name=format==='pdf'?'admotion-studio-parking.pdf':'admotion-studio-parking-equivalent.txt';const bytes=await readFile('tests/fixtures/'+name);
    return documentChunks(await extractInProcess(bytes,name,format==='pdf'?'application/pdf':'text/plain'),name);})());
  const document=(await documentInputs.get(format))!,quote='AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.';
  assert.ok(document.content.includes(quote),'exact source-backed compound negative survives real extraction');
  const {createHash}=await import('node:crypto');const revision=createHash('sha256').update(document.content).digest('hex');
  const fact=negativeTranslations[language],question="What are the studio's limits on free parking and reserving parking spaces?";
  const db=new FakeKnowledgeDatabase(),repo=new FakeKnowledgeLifecycle(db,Date.now,async()=>true),scope={businessId:77,channel:'messenger' as const,providerAccount:'account',conversationId:randomUUID()};
  const accepted=await repo.accept(scope,randomUUID(),{question,language,history:[]});let verifierCalls=0;
  b.configure({knowledgeSearch:async()=>[{businessId:77,sourceId:'document-'+format,text:document.content,score:1,metadata:{source:'document',documentRevision:revision}}],semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(_id,matches)=>matches,
    geminiGenerate:async p=>{const instruction=p.config.systemInstruction,data=JSON.parse(p.contents[0].parts[0].text);
      if(instruction.includes('retrieval query planner'))return {text:JSON.stringify({canonicalMeaning:question,queries:[],requestKind:'BUSINESS_INFORMATION',requestedFacets:[{subject:'studio',attribute:'free parking and space reservation',questionType:'description'}]})};
      if(instruction.includes('UNIT EXTRACTION'))return {text:JSON.stringify({units:[{facetIds:['f1'],subject:'AdMotion Studio',predicate:'offers or arranges',value:fact,modality:'descriptive',negation:true,scope:'studio offering only; no assertion of garage prices',qualifiers:['both negative offering limits'],language,text:fact,evidenceRefs:[{evidenceId:'e1',exactQuote:quote}]}]})};
      verifierCalls++;assert.equal(data.units[0].modality,'descriptive');assert.equal(data.units[0].evidenceRefs[0].exactQuote,quote);assert.ok(data.evidence[0].text.includes(quote),'verifier sees complete extracted source context');
      return {text:JSON.stringify({decisions:[{unitId:'u1',facetIds:['f1'],relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:true,explicitAbsenceEvidence:true}],coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1'],obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:['u1']}))}))})};
    }});
  const delivery=await new KnowledgeRunner(repo,(task,context)=>executeDurableKnowledgeTask(task,context,{id:77,businessId:77,language},async()=>true),'worker').run(scope,accepted.task!.id);
  assert.equal(delivery?.text,fact,JSON.stringify({preflights,verifierCalls}));assert.equal(verifierCalls,1);assert.deepEqual((await repo.get(scope,accepted.task!.id))!.result!.sources,[{id:'document-'+format,revision}]);
 });

test('durable scope parity: out-of-route service wording does not gain Knowledge authority',async()=>{
  const previous=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';
  try {
    const repo=new FakeKnowledgeLifecycle(new FakeKnowledgeDatabase(),Date.now,async()=>true),scope={businessId:77,channel:'messenger' as const,providerAccount:'account',conversationId:randomUUID()};
    const a=await repo.accept(scope,randomUUID(),{question:'Does your studio offer free parking or reserve parking spaces?',language:'en',history:[]});
    b.configure({geminiGenerate:async()=>assert.fail('Out-of-route input must not call a model')});
    assert.equal(await new KnowledgeRunner(repo,(task,context)=>executeDurableKnowledgeTask(task,context,{id:77,businessId:77,language:'en'},async()=>true),'worker').run(scope,a.task!.id),null);
  }finally{if(previous===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=previous;}
});

for(const natural of [false,true])for(const complete of [false,true])
 test(`durable coverage stop integration/${natural?'natural':'canonical'}/${complete?'complete':'incomplete'}: optional work and terminal delivery safety`,async t=>{
  const flags=['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE','ODINLINK_GROUNDED_NATURAL_RESPONSES']as const;
  const previous=flags.map(k=>process.env[k]);process.env[flags[0]]='true';process.env[flags[1]]=String(natural);
  t.after(()=>flags.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];}));
  for(const level of ['log','warn','info','error']as const)t.mock.method(console,level,()=>{});
  const facts=['Customer parking is beside the studio.','Use the east entrance to the car park.'];
  const calls:string[]=[],events:any[]=[],summaries:any[]=[];let sourceChecks=0;
  b.configure({knowledgeSearch:async business=>[{businessId:business,sourceId:'doc',text:facts.join('\n'),score:1,metadata:{source:'document',documentRevision:'v1'}}],
   semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(id,matches)=>{assert.equal(id,77);sourceChecks++;return matches;},
   evidenceFirstDecisionDiagnostic:e=>events.push(e),evidenceFirstDiagnostic:e=>summaries.push(e),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction,data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('UNIT EXTRACTION')){calls.push('extraction');return{text:JSON.stringify({units:facts.map(text=>({facetIds:['f1'],subject:'studio',predicate:'states',value:text,modality:'descriptive',negation:false,scope:'customer parking',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e1',exactQuote:text}]})),
     ...(natural?{naturalProposal:{blocks:facts.map((text,i)=>({kind:'fact',text,proposedUnitOrdinals:[i+1],obligationIds:[]}))}}:{})})};}
    if(instruction.includes('BATCH ENTAILMENT')){calls.push('verification');return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,relation:'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
     coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:complete,incompletenessReason:complete?'NONE':'UNRESOLVED',materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:complete?'COVERED':'UNRESOLVED',unitIds:data.units.map((u:any)=>u.id)}))}))})};}
    assert.ok(complete,'incomplete coverage must not invoke either optional provider path');
    if(instruction.includes('VERIFIED-UNIT PRESENTATION')){calls.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};}
    assert.ok(instruction.includes('INDEPENDENT NATURAL RESPONSE VALIDATION'),'only existing natural verifier expected');
    calls.push('presentation_verification');const {NATURAL_FLAGS}=await import('../ai/grounded-knowledge-composition');
    return{text:JSON.stringify({contractHash:data.contractHash,proposalHash:data.proposalHash,flags:Object.fromEntries(NATURAL_FLAGS.map(f=>[f,true])),
     blocks:data.proposal.blocks.map((block:any)=>({blockId:block.id,relation:'ENTAILED',noUnsupportedFacts:true,meaningPreserved:true,uncertaintyAccurate:true})),
     unitCoverage:data.contract.units.map((u:any)=>({unitId:u.id,blockIds:data.proposal.blocks.filter((block:any)=>block.unitIds.includes(u.id)).map((block:any)=>block.id),complete:true})),obligationCoverage:[]})};
   }});
  const db=new FakeKnowledgeDatabase(),repo=new FakeKnowledgeLifecycle(db,Date.now,async()=>true);
  const scope={businessId:77,channel:'messenger' as const,providerAccount:'account',conversationId:randomUUID()};
  const accepted=await repo.accept(scope,randomUUID(),{question:'Where can I park my car?',language:'en',history:[]},{executionMs:40000});
  const originalExpiry=accepted.task!.expiresAt;
  const delivery=await new KnowledgeRunner(repo,(task,context)=>executeDurableKnowledgeTask(task,context,{id:77,businessId:77,language:'en'},async()=>true),'worker').run(scope,accepted.task!.id);
  const task=(await repo.get(scope,accepted.task!.id))!;
  assert.deepEqual(calls,complete?['extraction','verification',natural?'presentation_verification':'composition']:['extraction','verification'],JSON.stringify({events,summaries}));
  assert.equal(task.expiresAt,originalExpiry);assert.equal(task.expiresAt-task.acceptedAt,40000);
  assert.equal(task.modelAttempts,complete?3:2);assert.ok(sourceChecks>=3,'existing revision checks remain active');
  assert.equal(Boolean(delivery),complete);assert.equal(db.rows.deliveries.size,complete?1:0);assert.equal(task.state,complete?'FINALIZED':'FAILED');
  assert.equal(summaries[0].semanticVerifiedUnits,2);assert.equal(summaries[0].completeness[0].status,complete?'VERIFIED':'PARTIAL');
  assert.equal(summaries[0].completeness[0].materialFactsComplete,complete);
  assert.deepEqual(summaries[0].completeness[0].obligations,[complete?'COVERED':'UNRESOLVED']);
  if(complete&&natural)assert.equal(summaries[0].naturalResponse.outcome,'accepted_natural');
  if(!complete){assert.equal(events.some(e=>e.stage==='composition'||e.stage==='presentation_verification'),false);
   assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'&&e.incompletenessReason==='UNRESOLVED'));}
 });
