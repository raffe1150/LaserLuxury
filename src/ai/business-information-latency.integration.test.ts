import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Responses } from 'openai/resources/responses';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, isSimpleCatalogLocationQuestion } from './business-information';
import { AiReliabilityError } from './reliability';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const baseline = process.env.BUSINESS_LATENCY_BASELINE === '1';
const cases = [
  ['ar', 'مرحباً! ما الخدمات التي تقدمونها وأين موقعكم؟', 'العنوان هو Aurora Street 742.'],
  ['fa', 'سلام! چه خدماتی دارید و کجا هستین؟', 'آدرس Aurora Street 742 است.'],
  ['en', 'Hello! What services do you offer and where are you located?', 'The address is Aurora Street 742.'],
  ['sv', 'Hej! Vilka tjänster erbjuder ni och var finns ni?', 'Adressen är Aurora Street 742.'],
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', 'Die Adresse ist Aurora Street 742.'],
  ['es', '¡Hola! ¿Qué servicios ofrecen y dónde están ubicados?', 'La dirección es Aurora Street 742.'],
] as const;

for (const [language, question, location] of cases) {
  for (const configured of [true, false]) {
    test(`${language}: ${configured ? 'configured' : 'retrieved'} catalog/location uses grounded generation with only necessary retrieval`, async t => {
      const oldEnv = { ...process.env };
      Object.assign(process.env, {
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-offline-latency',
        OPENAI_MODEL: 'gpt-5.6-luna',
      });

      b.reset();
      t.after(() => {
        b.reset();
        for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
        Object.assign(process.env, oldEnv);
      });

      const config = {
        ...fixture.business,
        language,
        ...(configured ? { address: 'Aurora Street 742' } : {}),
      };

      const session = `latency-${language}-${configured}`;
      const catalog = formatConfiguredServiceCatalogPlan(
        buildConfiguredServiceCatalogPlan(config.services),
        language,
      );
      const candidate = `${catalog}\n${location}`;

      const counts = {
        planner: 0,
        generation: 0,
        extraction: 0,
        entailment: 0,
        lexical: 0,
        semantic: 0,
      };

      const timings: any[] = [];

      for (const method of ['log', 'info', 'warn', 'error'] as const) {
        t.mock.method(console, method, (label: string, event: any) => {
          if ([
            '[BusinessInformationTiming]',
            '[KnowledgeRetrieval]',
            '[AIRequest]',
            '[BusinessSupportVerifierTiming]',
          ].includes(label)) {
            timings.push({ label, ...event });
          }
        });
      }

      b.configure({
        semanticLanguageResolver: async () => null,
        postProcess: async () => {},
        knowledgeSearch: async () => {
          counts.lexical++;
          await delay(5);
          return [{
            businessId: 3,
            sourceId: fixture.sources[0].id,
            text: fixture.sources[0].content,
            score: 1,
          }];
        },
        semanticKnowledgeSearch: async () => {
          counts.semantic++;
          await delay(5);
          return [];
        },
      });

      t.mock.method(Responses.prototype, 'create', async (params: any) => {
        assert.equal(params.model, 'gpt-5.6-luna');
        const instructions = params.instructions;
        await delay(10);

        if (instructions.includes('retrieval query planner')) {
          counts.planner++;
          return {
            output_text: JSON.stringify({
              canonicalMeaning: 'catalog and address',
              queries: [question],
            }),
            output: [],
          } as any;
        }

        if (instructions.includes('claim and citation extractor')) {
          counts.extraction++;

          return {
            output_text: JSON.stringify({
              hasBusinessFactualClaims: true,
              allBusinessClaimsSupported: true,
              claims: [
                {
                  claim: catalog,
                  candidateQuote: catalog,
                  claimKind: 'OTHER',
                  requiresBusinessEvidence: true,
                  supported: true,
                  evidence: [{
                    source: 'structured_business_config',
                    quote: '"name": "Video Consultation"',
                  }],
                },
                {
                  claim: location,
                  candidateQuote: location,
                  claimKind: 'OTHER',
                  requiresBusinessEvidence: true,
                  supported: true,
                  evidence: [{
                    source: configured
                      ? 'structured_business_config'
                      : 'retrieved_knowledge',
                    quote: configured
                      ? 'Aurora Street 742'
                      : fixture.sources[0].content,
                  }],
                },
              ],
            }),
            output: [],
          } as any;
        }

        if (instructions.includes('entailment gate')) {
          counts.entailment++;
          return {
            output_text: JSON.stringify({
              relation: 'ENTAILED',
              claimKind: 'OTHER',
              explicitAbsenceEvidence: false,
            }),
            output: [],
          } as any;
        }

        assert.equal(instructions, 'offline conversation candidate');
        counts.generation++;

        return {
          output_text: candidate,
          output: [],
        } as any;
      });

      const started = performance.now();
      const measuredStages: Record<string, number> = {};

      let stageStarted = performance.now();

      assert.equal(
        await b.prepareConversationLanguageForTest(session, question, config),
        language,
      );

      measuredStages.languageMs = Math.round(performance.now() - stageStarted);
      stageStarted = performance.now();

      const result = await b.turn({
        sessionId: session,
        platformName: 'whatsapp',
        recipientUserId: '46700000001',
        text: question,
        businessConfig: config,
      });

      measuredStages.unifiedInformationMs =
        Math.round(performance.now() - stageStarted);

      assert.equal(
        result.handled,
        false,
        'catalog/location must continue to shared grounded conversation generation',
      );
      assert.equal(result.replies.length, 0);

      stageStarted = performance.now();

      const generated = await b.promptAuditGenerate(null, {
        messages: [{ role: 'user', content: question }],
        systemInstruction: 'offline conversation candidate',
        context: {
          businessId: 3,
          channel: 'whatsapp',
          stage: 'conversation',
          language,
        },
      });

      measuredStages.generationMs = Math.round(performance.now() - stageStarted);
      stageStarted = performance.now();

      const final = await b.finalizeGeneralAiReply(
        session,
        question,
        generated.text,
        language,
      );

      measuredStages.groundingMs = Math.round(performance.now() - stageStarted);

      assert.ok(final.includes('Aurora Street 742'));

      for (const service of config.services.slice(0, 5)) {
        assert.equal(final.split(service.name).length - 1, 1);
      }

      assert.equal(result.pending, null);

      if (configured) {
        assert.equal(counts.lexical, 0);
        assert.deepEqual(
          {
            planner: counts.planner,
            generation: counts.generation,
            extraction: counts.extraction,
            entailment: counts.entailment,
            semantic: counts.semantic,
          },
          {
            planner: 0,
            generation: 1,
            extraction: 1,
            entailment: 2,
            semantic: 0,
          },
        );
      } else {
        assert.ok(counts.lexical >= 7 && counts.lexical <= 8);
        assert.deepEqual(
          {
            planner: counts.planner,
            generation: counts.generation,
            extraction: counts.extraction,
            entailment: counts.entailment,
            semantic: counts.semantic,
          },
          {
            planner: 1,
            generation: 1,
            extraction: 1,
            entailment: 2,
            semantic: 1,
          },
        );
      }

      const stages = timings.filter(
        event => event.label === '[BusinessInformationTiming]',
      );

      assert.ok(stages.some(event => event.stage === 'retrieval_complete'));
      assert.equal(
        new Set(stages.map(event => event.businessInfoTurnId)).size,
        1,
      );
      assert.equal(JSON.stringify(stages).includes('Aurora Street'), false);

      const retrievalEvents = timings.filter(
        event => event.label === '[KnowledgeRetrieval]',
      );

      assert.equal(retrievalEvents.length, configured ? 0 : 1);
      assert.ok(
        retrievalEvents.every(
          event =>
            event.durationMs >= event.queryPlanningDurationMs &&
            event.searchDurationMs >= 0,
        ),
      );

      for (const privateValue of [
        question,
        fixture.sources[0].content,
        'sk-offline-latency',
        '46700000001',
      ]) {
        assert.equal(JSON.stringify(timings).includes(privateValue), false);
      }

      t.diagnostic(JSON.stringify({
        mode: baseline ? 'baseline-env' : 'current',
        language,
        configured,
        counts,
        elapsedMs: Math.round(performance.now() - started),
        measuredStages,
        providerStages: timings
          .filter(event => event.label === '[AIRequest]')
          .map(event => ({
            stage: event.stage,
            durationMs: event.durationMs,
          })),
        stages,
      }));
    });
  }
}

for (const failure of ['TIMEOUT', 'AUTHENTICATION', 'UNKNOWN', 'CONTRADICTED', 'NEGATIVE_ABSENCE'] as const) {
  test(`retrieved Arabic location ${failure} remains conservative through grounded generation`, async t => {
    b.reset();
    t.after(() => b.reset());

    const saved = { ...process.env };
    Object.assign(process.env, {
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-offline-latency',
      OPENAI_MODEL: 'gpt-5.6-luna',
    });

    t.after(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    });

    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      t.mock.method(console, method, () => {});
    }

    const question = cases[0][1];
    const location = cases[0][2];
    const catalog = formatConfiguredServiceCatalogPlan(
      buildConfiguredServiceCatalogPlan(fixture.business.services),
      'ar',
    );
    const candidate = `${catalog}\n${location}`;

    let planner = 0;
    let generation = 0;
    let extraction = 0;
    let locationVerifierCalls = 0;

    b.configure({
      postProcess: async () => {},
      knowledgeSearch: async () => [{
        businessId: 3,
        sourceId: fixture.sources[0].id,
        text: fixture.sources[0].content,
        score: 1,
      }],
      semanticKnowledgeSearch: async () => [],
    });

    t.mock.method(Responses.prototype, 'create', async (params: any) => {
      const instructions = String(params.instructions || '');

      if (instructions.includes('retrieval query planner')) {
        planner++;
        return {
          output_text: JSON.stringify({
            canonicalMeaning: 'catalog and address',
            queries: [question],
          }),
          output: [],
        } as any;
      }

      if (instructions.includes('claim and citation extractor')) {
        extraction++;

        return {
          output_text: JSON.stringify({
            hasBusinessFactualClaims: true,
            allBusinessClaimsSupported: true,
            claims: [
              {
                claim: catalog,
                candidateQuote: catalog,
                claimKind: 'OTHER',
                requiresBusinessEvidence: true,
                supported: true,
                evidence: [{
                  source: 'structured_business_config',
                  quote: '"name": "Video Consultation"',
                }],
              },
              {
                claim: location,
                candidateQuote: location,
                claimKind: 'OTHER',
                requiresBusinessEvidence: true,
                supported: true,
                evidence: [{
                  source: 'retrieved_knowledge',
                  quote: fixture.sources[0].content,
                }],
              },
            ],
          }),
          output: [],
        } as any;
      }

      if (instructions.includes('entailment gate')) {
        const body = JSON.parse(params.input[0].content);

        const claimText = JSON.stringify({
          atomicClaim: body.atomicClaim,
          claim: body.claim,
          candidateQuote: body.candidateQuote,
        });

        const isLocationClaim = claimText.includes('Aurora Street 742');

        if (!isLocationClaim) {
          return {
            output_text: JSON.stringify({
              relation: 'ENTAILED',
              claimKind: 'OTHER',
              explicitAbsenceEvidence: false,
            }),
            output: [],
          } as any;
        }

        locationVerifierCalls++;

        assert.ok(
          body.citedEvidence.some(
            (item: any) =>
              String(item.quote || '').includes(fixture.sources[0].content),
          ),
        );

        if (failure === 'TIMEOUT' || failure === 'AUTHENTICATION') {
          throw new AiReliabilityError(
            failure,
            'offline injected failure',
          );
        }

        return {
          output_text: JSON.stringify({
            relation:
              failure === 'NEGATIVE_ABSENCE'
                ? 'ENTAILED'
                : failure,
            claimKind:
              failure === 'NEGATIVE_ABSENCE'
                ? 'NEGATIVE_ABSENCE'
                : 'OTHER',
            explicitAbsenceEvidence: false,
          }),
          output: [],
        } as any;
      }

      assert.equal(instructions, 'offline conversation candidate');
      generation++;

      return {
        output_text: candidate,
        output: [],
      } as any;
    });

    b.seedFlowLanguage('failure', 'ar');

    const result = await b.turn({
      sessionId: 'failure',
      platformName: 'whatsapp',
      recipientUserId: '46700000001',
      text: question,
      businessConfig: fixture.business,
    });

    assert.equal(result.handled, false);
    assert.equal(result.replies.length, 0);

    const generated = await b.promptAuditGenerate(null, {
      messages: [{ role: 'user', content: question }],
      systemInstruction: 'offline conversation candidate',
      context: {
        businessId: 3,
        channel: 'whatsapp',
        stage: 'conversation',
        language: 'ar',
      },
    });

    const reply = await b.finalizeGeneralAiReply(
      'failure',
      question,
      generated.text,
      'ar',
    );

    assert.equal(planner, 1);
    assert.equal(generation, 1);
    assert.equal(extraction, 1);
    assert.ok(locationVerifierCalls >= 1);

    assert.ok(reply.includes('Video Consultation'));
    assert.doesNotMatch(reply, /Aurora Street/u);

    if (failure === 'CONTRADICTED' || failure === 'NEGATIVE_ABSENCE') {
      assert.match(reply, /لا أجد/u);
    } else {
      assert.match(reply, /لا أستطيع التحقق/u);
    }
  });
}

test('genuinely unknown location stays on full safe grounding path and cannot inherit a candidate address', async t => {
  b.reset(); t.after(() => b.reset());
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  let checks = 0;
  b.configure({ postProcess: async () => {}, knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    assessBusinessSupportGrounding: async () => { checks++; return null; },
    assessBusinessClaimEntailment: async () => { throw new Error('no untrusted address proposal is eligible'); },
    geminiGenerate: async () => ({ text: JSON.stringify({ canonicalMeaning: 'catalog and address', queries: [] }) }),
  });
  b.seedFlowLanguage('unknown', 'ar');
  const result = await b.turn({ sessionId: 'unknown', platformName: 'whatsapp', recipientUserId: '46700000001', text: cases[0][1], businessConfig: fixture.business });
  assert.equal(result.handled, false);
  const reply = await b.finalizeGeneralAiReply('unknown', cases[0][1], 'العنوان هو Invented Road 999.', 'ar');
  assert.equal(checks, 1);
  assert.ok(reply.includes('Video Consultation'));
  assert.doesNotMatch(reply, /Invented|Aurora/u);
  assert.match(reply, /لا أستطيع التحقق/u);
});

test('fast path never absorbs additional factual questions, recommendations, or booking instructions', () => {
  for (const question of [
    `${cases[2][1]} Do you have a swimming pool?`,
    'What services do you offer and where are you located and what is your email?',
    'What services do you offer and where are you located and what are the entry requirements?',
    'What services do you recommend and where are you located?',
    `${cases[0][1]} وهل لديكم مسبح؟`,
    `${cases[1][1]} آیا پارکینگ دارید؟`,
    `${cases[3][1]} Boka en tid åt mig.`,
    `${cases[4][1]} Welche Unterlagen brauche ich?`,
    `${cases[5][1]} ¿Tienen aparcamiento?`,
  ]) assert.equal(isSimpleCatalogLocationQuestion(question), false, question);
});

for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram'] as const) {
  test(`${channel}: grounded catalog/location delegation preserves selected booking state and native-name collection`, async t => {
    b.reset();
    t.after(() => b.reset());

    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      t.mock.method(console, method, () => {});
    }

    const userId = '46700000001';
    const config = {
      ...fixture.business,
      address: 'Aurora Street 742',
    };
    const id = userId;

    const pending = {
      bookingStateVersion: 3,
      createdAt: Date.now(),
      businessId: '3',
      platform: channel,
      userId,
      operation: 'new_booking',
      status: 'awaiting_contact',
      expectedInput: 'contact',
      businessConfig: config,
      language: 'ar',
      service: 'Video Consultation',
      durationMinutes: 60,
      dateTime: '2026-10-02T14:15:00+02:00',
      selectedSlotEnd: '2026-10-02T13:15:00Z',
      selectedDate: '2026-10-02',
      customerPhone: channel === 'whatsapp' ? '+46700000001' : null,
      customerName: null,
      ownedOfferedSlots: [{
        businessId: '3',
        platform: channel,
        userId,
        service: 'Video Consultation',
        durationMinutes: 60,
        start: '2026-10-02T14:15:00+02:00',
        end: '2026-10-02T13:15:00Z',
        generatedAt: Date.now(),
      }],
    };

    b.configure({
      postProcess: async () => {},
      knowledgeSearch: async () => {
        throw new Error('configured catalog/location must skip Knowledge retrieval');
      },
      semanticKnowledgeSearch: async () => {
        throw new Error('configured catalog/location must skip semantic Knowledge search');
      },
      assessBusinessSupportGrounding: async () => {
        throw new Error('turn delegation must not perform final grounding yet');
      },
      assessBusinessClaimEntailment: async () => {
        throw new Error('turn delegation must not perform final entailment yet');
      },
    });

    b.seedPending(id, pending);
    b.seedFlowLanguage(id, 'ar');

    const before = await b.stateAuditRestore(id, channel, config);
    assert.ok(before, 'fixture has valid owned pending state');

    const result = await b.turn({
      sessionId: id,
      platformName: channel,
      recipientUserId: userId,
      text: cases[0][1],
      businessConfig: config,
    });

    assert.equal(result.handled, false);
    assert.equal(result.replies.length, 0);
    assert.deepEqual(result.pending, before);

    const information = b.businessInformationState(id);
    assert.ok(information);

    const instruction = b.businessInformationInstruction(information);
    assert.ok(instruction.includes('Aurora Street 742'));
    assert.match(instruction, /CUSTOMER_FACING_CATALOG_PLAN:/u);

    assert.equal(
      b.extractPendingBookingCustomerName(
        'اسمي لينا اختبار AIBB 7a928ba6 channel-ar. وبالمناسبة، قال لي أحدهم اليوم "hej".',
        result.pending!,
      ),
      'لينا اختبار',
    );
  });
}
