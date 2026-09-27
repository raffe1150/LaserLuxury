import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const config = {
  id: 'quality-audit', businessName: 'Example Studio', language: 'sv', timezone: 'Europe/Stockholm',
  systemPrompt: 'Example Studio produces short video advertisements. Parking is behind the studio.',
  toneConfig: { tonePreset: 'warm', responseLength: 'short', formality: 'formal', emojiUsage: 'none', customToneInstructions: '' },
  services: ['Video Consultation', 'test', 'video for tiktok', 'Golden video', 'Reklam'].map(name => ({ name, durationMinutes: 30 })),
};
const now = new Date('2026-09-08T12:30:00Z');
let assessments: any[] = [];
function setup() {
  b.reset(); assessments = [];
  b.configure({
    calendarAdapter: {
      getCalendarId: () => 'mock-calendar',
      getEvents: async () => { throw new Error('information must not read Calendar'); },
      checkSlots: async () => { throw new Error('information must not check slots'); },
      insertAppointment: async () => { throw new Error('information must not book'); },
    },
    recordAppointment: async () => { throw new Error('information must not write DB'); },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    assessBusinessSupportGrounding: async (r: any) => {
      assessments.push(r);
      return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{
        claim: 'Example Studio produces short video advertisements.', candidateQuote: r.candidateReply,
        claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
        evidence: [{ source: 'business_system_prompt', quote: 'Example Studio produces short video advertisements.' }],
      }] };
    },
    assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
}
function completed(sessionId: string, channel: string) {
  b.seedRecentCompletedBooking(sessionId, 'de', { ok: true, bookingId: 'mock-booking', businessId: config.id,
    serviceName: 'Video Consultation', startTime: '2026-09-09T14:00:00+02:00',
    customerName: 'Alex Testsson', customerPhone: '0701234567', sourceChannel: channel }, 30);
}
const turn = (sessionId: string, channel: any, text: string) => b.turn({ sessionId, platformName: channel,
  recipientUserId: sessionId, text, businessConfig: config, now });
const info = {
  turns: [{
    customer: 'Können Sie mir etwas über dieses Unternehmen, Ihre Dienstleistungen und wichtige Informationen erzählen, die ich als Kunde wissen sollte?',
  }],
};
for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
  test(`${channel}: informational evidence escapes awaiting-service without changing pending state`, async () => {
    setup(); const id = `info-${channel}`;
    await turn(id, channel, 'Hallo, ich möchte für morgen einen Termin buchen.');
    for (const t of info.turns) {
      const result = await turn(id, channel, t.customer);
      assert.equal(result.handled, false, `turn ${t.turn}: ${result.replies.join(' ')}`);
      assert.equal(result.pending?.status, 'awaiting_service');
      assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
      assert.equal(b.resolveConversationLanguage(id, t.customer, config), 'de');
    }
  });
  test(`${channel}: current question and authoritative catalog reach Gemini grounding`, async () => {
    setup(); const id = `ground-${channel}`; completed(id, channel);
    const question = info.turns[0].customer;
    await turn(id, channel, question);
    assert.match(b.completedSupportInstruction(id), /Example Studio produces short video advertisements/);
    assert.match(b.completedSupportInstruction(id), /Golden video/);
    const reply = 'Example Studio erstellt kurze Videoanzeigen.';
    assert.equal(await b.finalizeGeneralAiReply(id, question, reply, 'de'), reply);
    assert.equal(assessments[0].customerMessage, question);
  });
  test(`${channel}: exact post-booking acknowledgment ends naturally`, async () => {
    setup(); const id = `thanks-${channel}`; completed(id, channel);
    const text = 'Alles klar, danke für die Bestätigung! Dann bis morgen um 14:00 Uhr.';
    const result = await turn(id, channel, text);
    assert.equal(result.handled, true);
    assert.match(result.replies.join(' '), /gern|dank|willkommen/iu);
    assert.doesNotMatch(result.replies.join(' '), /Unternehmensinformationen|buchen\?/);
    assert.equal(assessments.length, 0);
  });
}

for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
  test(`${channel}: changed question cannot inherit the completed service fallback`, async () => {
    setup(); const id = `fresh-${channel}`; completed(id, channel);
    const oldGap = 'In den verfügbaren Unternehmensinformationen finde ich keine konkrete Angabe zu Ihrer Frage über Video Consultation. Das Unternehmen kann bestätigen, was gilt.';
    const replies: string[] = [];
    for (const [text, expected] of [
      ['Welche Dienstleistungen bieten Sie an?', /Golden video/],
      ['Wie kann ich das Unternehmen erreichen?', /Kontaktmöglichkeiten/],
      ['Was sind Ihre Öffnungszeiten?', /Öffnungszeiten/],
    ] as const) {
      await turn(id, channel, text);
      const answer = await b.finalizeGeneralAiReply(id, text, oldGap, 'de');
      assert.match(answer, expected);
      if (!text.includes('Dienstleistungen')) assert.doesNotMatch(answer, /Video Consultation/);
      replies.push(answer);
    }
    assert.equal(new Set(replies).size, 3);
    assert.equal(assessments.length, 0, 'known stale fallback needs no LLM re-verification');
  });
  test(`${channel}: selected slot survives a business-information detour`, async () => {
    setup(); const id = `selected-${channel}`;
    const start = '2026-09-09T14:00:00+02:00';
    b.seedPending(id, { bookingStateVersion: 3, businessId: config.id, platform: channel, userId: id,
      businessConfig: config, operation: 'new_booking', status: 'awaiting_contact', expectedInput: 'contact',
      language: 'de', service: 'Video Consultation', durationMinutes: 30, selectedDate: '2026-09-09',
      dateTime: start, selectedSlotEnd: '2026-09-09T12:30:00.000Z',
      ownedOfferedSlots: [{ businessId: config.id, platform: channel, userId: id, start,
        end: '2026-09-09T12:30:00.000Z', durationMinutes: 30, service: 'Video Consultation', generatedAt: Date.now() }],
    });
    const before = b.pendingStateSnapshot(id);
    const result = await turn(id, channel, info.turns[0].customer);
    assert.equal(result.handled, false);
    for (const key of ['status', 'service', 'dateTime', 'selectedSlotEnd', 'ownedOfferedSlots']) {
      assert.deepEqual(result.pending?.[key], before?.[key], key);
    }
    assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
  });
}

test('selected tone, language and current evidence are shared across channels', async () => {
  for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
    setup(); const id = `tone-${channel}`;
    await turn(id, channel, info.turns[0].customer);
    const prompt = b.completedSupportInstruction(id);
    assert.match(prompt, /calm, empathetic|warm/i);
    assert.match(prompt, /very short/i);
    assert.match(prompt, /formal phrasing/i);
    assert.match(prompt, /Do not use emoji/i);
    assert.match(prompt, /Answer in de/);
    assert.match(prompt, /SOURCE retrieved_knowledge:\n\(none\)/);
    assert.match(prompt, /SOURCE structured_business_config/);
  }
});

test('harmless German greeting does not invalidate a grounded factual answer', async () => {
  setup(); const id = 'german-grounding-greeting';
  await turn(id, 'instagram', info.turns[0].customer);
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [{ claim: 'Example Studio produces short video advertisements.',
        candidateQuote: 'Example Studio erstellt kurze Videoanzeigen.', claimKind: 'OTHER', requiresBusinessEvidence: true,
        supported: true, evidence: [{ source: 'business_system_prompt', quote: 'Example Studio produces short video advertisements.' }] }] }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });
  const reply = 'Gerne! Example Studio erstellt kurze Videoanzeigen.';
  assert.equal(await b.finalizeGeneralAiReply(id, info.turns[0].customer, reply, 'de'), reply);
});

test('missing evidence fails closed without invented prices, policies, or handoff', async () => {
  setup(); const id = 'missing-information';
  await turn(id, 'instagram', 'Welche Preise und Bedingungen gelten für die Dienstleistungen?');
  b.configure({ assessBusinessSupportGrounding: async () => null });
  const reply = await b.finalizeGeneralAiReply(id, 'Welche Preise und Bedingungen gelten für die Dienstleistungen?',
    'Die Preise sind 50 Euro. Es gibt keine Bedingungen. Ich habe Ihre Anfrage weitergeleitet.', 'de');
  assert.match(reply, /Preise|Bedingungen/);
  assert.doesNotMatch(reply, /50|keine Bedingungen|weitergeleitet/);
});

const localizedQuestions = {
  en: 'Can you tell me about your company and services?', sv: 'Kan du berätta om företaget och era tjänster?',
  de: info.turns[0].customer, es: '¿Puede explicarme qué servicios ofrece la empresa?',
  fa: 'لطفاً درباره شرکت و خدمات توضیح می‌دهید؟', ar: 'هل يمكنك إخباري عن الشركة والخدمات؟',
};
for (const [language, text] of Object.entries(localizedQuestions)) {
  test(`${language}: business information remains read-only across four channels`, async () => {
    for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
      setup(); const id = `${language}-${channel}`; b.seedFlowLanguage(id, language);
      const result = await turn(id, channel, text);
      assert.equal(result.handled, false);
      assert.equal(result.pending, null);
      assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
      assert.match(b.completedSupportInstruction(id), new RegExp(`Answer in ${language}`));
    }
  });
}

test('different tenant/channel/user sessions cannot share information context', async () => {
  setup();
  const other = { ...config, id: 'other-business', systemPrompt: 'Other business sells flowers.', services: [{ name: 'Flowers', durationMinutes: 30 }] };
  const ids = [b.channelSessionId('instagram', 'same-user', config), b.channelSessionId('whatsapp', 'same-user', config), b.channelSessionId('instagram', 'same-user', other)];
  assert.equal(new Set(ids).size, 3);
  await Promise.all(ids.map((sessionId, i) => b.turn({ sessionId, platformName: i === 1 ? 'whatsapp' : 'instagram',
    recipientUserId: 'same-user', text: info.turns[0].customer, businessConfig: i === 2 ? other : config, now })));
  assert.doesNotMatch(b.completedSupportInstruction(ids[0]), /sells flowers/);
  assert.match(b.completedSupportInstruction(ids[2]), /sells flowers/);
  assert.doesNotMatch(b.completedSupportInstruction(ids[2]), /Parking is behind/);
});

test('retrieved tenant Knowledge reaches grounding and may support a factual reply', async () => {
  setup();

  const id = 'retrieved-knowledge-grounding';
  const question = 'Where is the customer entrance?';
  const knowledge =
    'KNOWLEDGE CHUNK 1\n' +
    'source_id: knowledge-source-1\n' +
    'The customer entrance is on Oak Street.';

  b.businessInformationState(
    id,
    config,
    question,
    'en',
    knowledge,
  );

  const instruction = b.completedSupportInstruction(id);

  assert.match(instruction, /SOURCE retrieved_knowledge:/);
  assert.match(instruction, /The customer entrance is on Oak Street/);

  b.configure({
    assessBusinessSupportGrounding: async (request: any) => {
      assert.match(request.evidenceCorpus, /SOURCE retrieved_knowledge:/);
      assert.match(request.evidenceCorpus, /The customer entrance is on Oak Street/);

      return {
        hasBusinessFactualClaims: true,
        allBusinessClaimsSupported: true,
        claims: [{
          claim: 'The customer entrance is on Oak Street.',
          candidateQuote: 'The customer entrance is on Oak Street.',
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{
            source: 'retrieved_knowledge',
            quote: 'The customer entrance is on Oak Street.',
          }],
        }],
      };
    },
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const replies = [
    'The customer entrance is on Oak Street.',
    'According to the available business information, the customer entrance is on Oak Street.',
  ];

  for (const reply of replies) {
    assert.equal(
      await b.finalizeGeneralAiReply(id, question, reply, 'en'),
      reply,
    );
  }
});

test('Swedish grounded Knowledge reply allows harmless greeting and emoji framing', async () => {
  setup();

  const id = 'retrieved-knowledge-swedish-framing';
  const question = 'Var ligger kundentrén?';
  const knowledge =
    'KNOWLEDGE CHUNK 1\n' +
    'source_id: knowledge-source-sv\n' +
    'Kundentrén ligger på Aurora Street 742.';

  b.businessInformationState(
    id,
    config,
    question,
    'sv',
    knowledge,
  );

  b.configure({
    assessBusinessSupportGrounding: async (request: any) => {
      assert.match(request.evidenceCorpus, /Kundentrén ligger på Aurora Street 742/);

      return {
        hasBusinessFactualClaims: true,
        allBusinessClaimsSupported: true,
        claims: [{
          claim: 'Kundentrén ligger på Aurora Street 742.',
          candidateQuote: 'Kundentrén ligger på Aurora Street 742.',
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{
            source: 'retrieved_knowledge',
            quote: 'Kundentrén ligger på Aurora Street 742.',
          }],
        }],
      };
    },
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = 'Hej! Välkommen! 👋 Kundentrén ligger på Aurora Street 742. ✨';

  assert.equal(
    await b.finalizeGeneralAiReply(id, question, reply, 'sv'),
    reply,
  );
});

test('semantic Knowledge retrieval bridges all six OdinLink languages to Swedish stored evidence', async () => {
  const knowledgeConfig = {
    ...config,
    id: 77,
    businessId: 77,
    business_id: 77,
    businessRecordId: 77,
  };

  const questions = {
    en: 'Where is the customer entrance?',
    sv: 'Var ligger kundentrén?',
    de: 'Wo befindet sich der Kundeneingang?',
    es: '¿Dónde está la entrada de clientes?',
    fa: 'ورودی مشتری کجاست؟',
    ar: 'أين يقع مدخل العملاء؟',
  };

  for (const [language, question] of Object.entries(questions)) {
    setup();

    const searchedQueries: string[] = [];

    b.configure({
      geminiGenerate: async (params: any) => {
        assert.equal(
          params?.config?.systemInstruction?.includes(
            "multilingual Knowledge retrieval query planner"
          ),
          true,
        );

        return {
          text: JSON.stringify({
            canonicalMeaning:
              'customer entrance location/address',
            queries: [
              'customer entrance address',
              'kundentré adress',
              'Kundeneingang Adresse',
              'entrada de clientes dirección',
              'آدرس ورودی مشتری',
              'عنوان مدخل العملاء',
            ],
          }),
        };
      },

      knowledgeSearch: async (
        businessId: number,
        query: string,
        limit: number,
      ) => {
        assert.equal(businessId, 77);
        assert.equal(limit, 5);

        searchedQueries.push(query);

        if (/kundentr[eé]/iu.test(query)) {
          return [{
            sourceId: 'knowledge-source-sv',
            businessId,
            score: 100,
            text:
              'Kundentrén ligger på Aurora Street 742.',
            metadata: {},
          }];
        }

        return [];
      },
      semanticKnowledgeSearch: async (
        businessId: number,
        query: string,
        limit: number,
      ) => {
        assert.equal(businessId, 77);
        assert.equal(query, question);
        assert.equal(limit, 5);
        return [];
      },
    });

    const plan =
      await b.semanticKnowledgeQueries(
        question,
        knowledgeConfig,
      );

    assert.ok(plan);
    assert.equal(
      plan?.canonicalMeaning,
      'customer entrance location/address',
    );

    assert.ok(
      plan?.queries.some(
        (query: string) =>
          /kundentr[eé]/iu.test(query)
      ),
      `${language}: expected Swedish semantic bridge query`,
    );

    const retrieved =
      await b.retrieveBusinessKnowledge(
        question,
        knowledgeConfig,
      );

    assert.match(
      retrieved,
      /Kundentrén ligger på Aurora Street 742/,
      `${language}: Swedish stored Knowledge was not retrieved`,
    );

    assert.ok(
      searchedQueries.some(
        (query) => /kundentr[eé]/iu.test(query)
      ),
      `${language}: Swedish retrieval query was never executed`,
    );
  }
});

test('Knowledge retrieval merges semantic and lexical ranks and deduplicates identical chunks', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 77,
    businessId: 77,
    business_id: 77,
    businessRecordId: 77,
  };

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'combined retrieval regression',
        queries: ['lexical lookup'],
      }),
    }),
    knowledgeSearch: async (_businessId: number, query: string) =>
      query === 'lexical lookup'
        ? [
            {
              sourceId: 'lexical-only',
              businessId: 77,
              score: 1000,
              text: 'Lexical-only fact.',
            },
            {
              sourceId: 'shared',
              businessId: 77,
              score: 0.01,
              text: 'Shared fact.',
            },
          ]
        : [],
    semanticKnowledgeSearch: async () => [
      {
        sourceId: 'shared',
        businessId: 77,
        score: 0.99,
        text: '  Shared fact.  ',
      },
      {
        sourceId: 'semantic-only',
        businessId: 77,
        score: 0.98,
        text: 'Semantic-only fact.',
      },
    ],
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    'How does combined retrieval behave?',
    knowledgeConfig,
  );

  assert.equal((retrieved.match(/Shared fact\./gu) || []).length, 1);
  assert.ok(
    retrieved.indexOf('Shared fact.') <
      retrieved.indexOf('Lexical-only fact.'),
    'a chunk present in both ranked lists should be fused ahead of a single-list chunk',
  );
  assert.match(retrieved, /Semantic-only fact\./u);
});

test('semantic Knowledge retrieval uses the original normalized natural paraphrase', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 77,
    businessId: 77,
    business_id: 77,
    businessRecordId: 77,
  };
  const semanticQueries: string[] = [];

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'parking location',
        queries: ['parking address'],
      }),
    }),
    knowledgeSearch: async () => [],
    semanticKnowledgeSearch: async (
      businessId: number,
      query: string,
      limit: number,
    ) => {
      assert.equal(businessId, 77);
      assert.equal(limit, 5);
      semanticQueries.push(query);
      return [{
        sourceId: 'parking',
        businessId,
        score: 0.87,
        text: 'Customer parking is behind the studio.',
      }];
    },
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    '  Where can I leave my car?  ',
    knowledgeConfig,
  );

  assert.deepEqual(semanticQueries, ['Where can I leave my car?']);
  assert.match(retrieved, /Customer parking is behind the studio\./u);
});

test('semantic Knowledge failure preserves lexical ranking and response content', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 77,
    businessId: 77,
    business_id: 77,
    businessRecordId: 77,
  };

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'lexical fallback',
        queries: ['fallback lookup'],
      }),
    }),
    knowledgeSearch: async (_businessId: number, query: string) =>
      query === 'fallback lookup'
        ? [
            {
              sourceId: 'lower',
              businessId: 77,
              score: 0.2,
              text: 'Lower-ranked lexical fact.',
            },
            {
              sourceId: 'higher',
              businessId: 77,
              score: 0.9,
              text: 'Higher-ranked lexical fact.',
            },
          ]
        : [],
    semanticKnowledgeSearch: async () => {
      throw new Error('injected semantic outage');
    },
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    'What is the fallback fact?',
    knowledgeConfig,
  );

  assert.ok(
    retrieved.indexOf('Higher-ranked lexical fact.') <
      retrieved.indexOf('Lower-ranked lexical fact.'),
  );
  assert.equal((retrieved.match(/KNOWLEDGE CHUNK/gu) || []).length, 2);
});

test('synchronous semantic Knowledge failure preserves completed lexical results', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 77,
    businessId: 77,
    business_id: 77,
    businessRecordId: 77,
  };

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'synchronous semantic fallback',
        queries: ['synchronous fallback lookup'],
      }),
    }),
    knowledgeSearch: async (_businessId: number, query: string) =>
      query === 'synchronous fallback lookup'
        ? [{
            sourceId: 'sync-fallback',
            businessId: 77,
            score: 0.8,
            text: 'Completed lexical result survives.',
          }]
        : [],
    semanticKnowledgeSearch: () => {
      throw new Error('synchronous injected semantic outage');
    },
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    'Does synchronous fallback work?',
    knowledgeConfig,
  );

  assert.match(retrieved, /Completed lexical result survives\./u);
  assert.equal((retrieved.match(/KNOWLEDGE CHUNK/gu) || []).length, 1);
});

test('semantic and lexical Knowledge retrieval remain scoped to businessId', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 88,
    businessId: 88,
    business_id: 88,
    businessRecordId: 88,
  };
  const scopes: number[] = [];

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'tenant scope',
        queries: ['tenant lookup'],
      }),
    }),
    knowledgeSearch: async (businessId: number) => {
      scopes.push(businessId);
      return [{
        sourceId: 'wrong-lexical-tenant',
        businessId: 999,
        score: 1,
        text: 'Other tenant lexical secret.',
      }];
    },
    semanticKnowledgeSearch: async (businessId: number) => {
      scopes.push(businessId);
      return [
        {
          sourceId: 'wrong-semantic-tenant',
          businessId: 999,
          score: 1,
          text: 'Other tenant semantic secret.',
        },
        {
          sourceId: 'right-tenant',
          businessId,
          score: 0.8,
          text: 'Scoped tenant fact.',
        },
      ];
    },
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    'Show my tenant fact.',
    knowledgeConfig,
  );

  assert.ok(scopes.length >= 2);
  assert.equal(scopes.every((businessId) => businessId === 88), true);
  assert.match(retrieved, /Scoped tenant fact\./u);
  assert.doesNotMatch(retrieved, /Other tenant/u);
});

test('semantic Knowledge results without businessId are rejected', async () => {
  setup();

  const knowledgeConfig = {
    ...config,
    id: 88,
    businessId: 88,
    business_id: 88,
    businessRecordId: 88,
  };

  b.configure({
    geminiGenerate: async () => ({
      text: JSON.stringify({
        canonicalMeaning: 'strict semantic tenant scope',
        queries: ['strict tenant lookup'],
      }),
    }),
    knowledgeSearch: async (_businessId: number, query: string) =>
      query === 'strict tenant lookup'
        ? [{
            sourceId: 'lexical-fallback',
            businessId: 88,
            score: 0.7,
            text: 'Strictly scoped lexical fact.',
          }]
        : [],
    semanticKnowledgeSearch: async () => [{
      sourceId: 'missing-tenant',
      score: 0.99,
      text: 'Unscoped semantic secret.',
    }],
  });

  const retrieved = await b.retrieveBusinessKnowledge(
    'Show strictly scoped facts.',
    knowledgeConfig,
  );

  assert.match(retrieved, /Strictly scoped lexical fact\./u);
  assert.doesNotMatch(retrieved, /Unscoped semantic secret/u);
  assert.equal((retrieved.match(/KNOWLEDGE CHUNK/gu) || []).length, 1);
});

test('meaningful current message switches conversation language from German to English', async () => {
  setup();

  const id = 'language-switch-de-en';

  b.configure({
    semanticLanguageResolver: async (
      text: string,
      activeLanguage: string | null,
    ) => {
      if (/park/i.test(text)) {
        assert.equal(activeLanguage, 'de');

        return {
          language: 'en',
          requestedReplyLanguage: null,
          confidence: 0.99,
        };
      }

      return {
        language: 'de',
        requestedReplyLanguage: null,
        confidence: 0.99,
      };
    },
  });

  assert.equal(
    await b.prepareConversationLanguage(
      id,
      'Wo befindet sich der Kundeneingang?',
      config,
    ),
    'de',
  );

  assert.equal(
    await b.prepareConversationLanguage(
      id,
      'Do you have free parking?',
      config,
    ),
    'en',
  );
});

test('Persian and Arabic remain distinct when the current message changes language', async () => {
  setup();

  const id = 'language-switch-fa-ar';

  b.configure({
    semanticLanguageResolver: async (
      text: string,
      activeLanguage: string | null,
    ) => {
      if (text.includes('مدخل')) {
        assert.equal(activeLanguage, 'fa');

        return {
          language: 'ar',
          requestedReplyLanguage: null,
          confidence: 0.99,
        };
      }

      return {
        language: 'fa',
        requestedReplyLanguage: null,
        confidence: 0.99,
      };
    },
  });

  assert.equal(
    await b.prepareConversationLanguage(
      id,
      'ورودی مشتری کجاست؟',
      config,
    ),
    'fa',
  );

  assert.equal(
    await b.prepareConversationLanguage(
      id,
      'أين يقع مدخل العملاء؟',
      config,
    ),
    'ar',
  );
});
