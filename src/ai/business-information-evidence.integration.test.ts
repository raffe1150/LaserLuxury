import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const serviceConfig = {
  id: 101,
  businessName: 'Verified Studio',
  language: 'en',
  timezone: 'Europe/Stockholm',
  systemPrompt: '',
  services: [{
    name: 'Intro Facial',
    description: 'A gentle introductory facial.',
    durationMinutes: 45,
    price: 650,
    currency: 'SEK',
    active: true,
  }],
};

function seedInformation(
  sessionId: string,
  question: string,
  config: any = serviceConfig,
  retrievedKnowledge = '',
) {
  b.reset();
  b.businessInformationState(
    sessionId,
    config,
    question,
    'en',
    retrievedKnowledge,
  );
}

test('Services & Prices remain usable when Knowledge is absent', () => {
  const sessionId = 'services-prices-without-knowledge';
  const question = 'What services and prices do you offer?';
  seedInformation(sessionId, question);

  const instruction = b.completedSupportInstruction(sessionId);
  assert.match(instruction, /SOURCE structured_business_config:[\s\S]*Intro Facial/);
  assert.match(instruction, /"durationMinutes": 45/);
  assert.match(instruction, /"price": 650/);
  assert.match(instruction, /A gentle introductory facial/);
  assert.match(instruction, /SOURCE retrieved_knowledge:\n\(none\)/);
});

test('factual Business/System Prompt Settings enter grounding evidence', async () => {
  const sessionId = 'factual-system-prompt';
  const question = 'What preparation is required?';
  const fact = 'Customers should bring photo ID for Intro Facial.';
  seedInformation(sessionId, question, {
    ...serviceConfig,
    systemPrompt: fact,
  });

  const instruction = b.completedSupportInstruction(sessionId);
  assert.match(instruction, /SOURCE business_system_prompt:\nCustomers should bring photo ID for Intro Facial\./);

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim: fact,
        candidateQuote: fact,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{ source: 'business_system_prompt', quote: fact }],
      }],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  assert.equal(
    await b.businessSupportGrounding(sessionId, question, fact, 'en'),
    fact,
  );
});

test('tenant-scoped Knowledge survives the recent-completion business-information path', async () => {
  const sessionId = 'knowledge-after-completion';
  const knowledgeFact = 'Please arrive ten minutes early.';
  b.reset();
  b.configure({
    geminiGenerate: async () => ({ text: '' }),
    knowledgeSearch: async (businessId: number) => {
      assert.equal(businessId, 101);
      return [{ sourceId: 'arrival-faq', businessId, text: knowledgeFact, score: 1 }];
    },
    semanticKnowledgeSearch: async () => [],
    calendarAdapter: {
      getCalendarId: () => 'mock-calendar',
      getEvents: async () => { throw new Error('information must not read Calendar'); },
      checkSlots: async () => { throw new Error('information must not check slots'); },
      insertAppointment: async () => { throw new Error('information must not book'); },
    },
  });
  b.seedRecentCompletedBooking(sessionId, 'en', {
    ok: true,
    bookingId: 'verified-booking',
    businessId: 101,
    serviceName: 'Intro Facial',
    startTime: '2026-10-01T14:00:00+02:00',
    customerName: 'Alex Example',
    customerPhone: '0701234567',
    sourceChannel: 'instagram',
  }, 45);

  const result = await b.turn({
    sessionId,
    platformName: 'instagram',
    recipientUserId: sessionId,
    text: 'What preparation information should I know before arriving?',
    businessConfig: serviceConfig,
    now: new Date('2026-09-28T12:00:00Z'),
  });

  assert.equal(result.handled, false);
  assert.match(
    b.completedSupportInstruction(sessionId),
    /SOURCE retrieved_knowledge:[\s\S]*Please arrive ten minutes early/,
  );
});

test('compound services + recommendation fallback presents verified services and asks a clarification', async () => {
  const sessionId = 'compound-services-recommendation';
  const question = 'Tell me about your services and what you recommend for a first-time visitor?';
  seedInformation(sessionId, question);
  b.configure({ assessBusinessSupportGrounding: async () => null });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    'I recommend our Premium treatment.',
    'en',
  );

  assert.match(reply, /Intro Facial/);
  assert.match(reply, /45 minutes/);
  assert.match(reply, /650 SEK/);
  assert.match(reply, /\?$/);
  assert.match(reply, /(?:help|goal|looking for|choose)/i);
  assert.doesNotMatch(reply, /Premium/);
  assert.doesNotMatch(reply, /can't find a specific answer/i);
});

test('supported service fact and safe natural clarification survive an unsupported recommendation', async () => {
  const sessionId = 'partial-supported-service';
  const question = 'What services do you offer and what do you recommend for a first-time visitor?';
  const supported = 'Intro Facial takes 45 minutes.';
  const unsupported = 'It is definitely the best choice for every first-time visitor.';
  const clarification = 'What kind of result are you hoping for?';
  seedInformation(sessionId, question);
  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: false,
      claims: [
        {
          claim: supported,
          candidateQuote: supported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"durationMinutes": 45' }],
        },
        {
          claim: unsupported,
          candidateQuote: unsupported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        },
      ],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    `${supported} ${unsupported} ${clarification}`,
    'en',
  );

  assert.match(reply, /Intro Facial takes 45 minutes/);
  assert.match(reply, /What kind of result are you hoping for\?/);
  assert.doesNotMatch(reply, /definitely|best choice for every/);
});

test('unsafe factual or booking clarification candidate is not preserved', async () => {
  const sessionId = 'unsafe-natural-clarification';
  const question = 'What services do you offer and what do you recommend for a first-time visitor?';
  const supported = 'Intro Facial takes 45 minutes.';
  const unsupported = 'It is definitely the best choice for every first-time visitor.';
  const unsafeClarification = 'Would you like to book our Premium treatment for 999 SEK now?';
  seedInformation(sessionId, question);
  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: false,
      claims: [
        {
          claim: supported,
          candidateQuote: supported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"durationMinutes": 45' }],
        },
        {
          claim: unsupported,
          candidateQuote: unsupported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        },
      ],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    `${supported} ${unsupported} ${unsafeClarification}`,
    'en',
  );

  assert.match(reply, /Intro Facial/);
  assert.match(reply, /\?$/);
  assert.doesNotMatch(reply, /book our Premium|Premium treatment|best choice|999/i);
});

test('localized deterministic clarification is used when no safe clarification survives', async () => {
  const sessionId = 'localized-clarification-fallback';
  const question = 'Vilka tjänster har ni och vad rekommenderar ni för första gången?';
  const supported = 'Intro Facial tar 45 minuter.';
  const unsupported = 'Det är definitivt bäst för alla förstagångsbesökare.';
  seedInformation(sessionId, question);
  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: false,
      claims: [
        {
          claim: supported,
          candidateQuote: supported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"durationMinutes": 45' }],
        },
        {
          claim: unsupported,
          candidateQuote: unsupported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        },
      ],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    `${supported} ${unsupported}`,
    'sv',
  );

  assert.match(reply, /Intro Facial tar 45 minuter/);
  assert.match(reply, /(?:Vad|Vilken|Hur).+\?$/u);
  assert.doesNotMatch(reply, /definitivt|bäst för alla/i);
});

test('selected conversational wording is not replaced by the fixed clarification template', async () => {
  const sessionId = 'tone-preserved-clarification';
  const question = 'What services do you offer and what do you recommend for a first-time visitor?';
  const supported = 'Intro Facial takes 45 minutes.';
  const unsupported = 'It is the ideal treatment for every new customer.';
  const warmClarification = 'What would feel most useful for you today?';
  seedInformation(sessionId, question, {
    ...serviceConfig,
    toneConfig: { tone: 'warm', formality: 'casual' },
  });
  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: false,
      claims: [
        {
          claim: supported,
          candidateQuote: supported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"durationMinutes": 45' }],
        },
        {
          claim: unsupported,
          candidateQuote: unsupported,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        },
      ],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    `${supported} ${unsupported} ${warmClarification}`,
    'en',
  );

  assert.match(reply, /What would feel most useful for you today\?/);
  assert.doesNotMatch(reply, /verified services/i);
  assert.doesNotMatch(reply, /ideal treatment/i);
});

test('verified recommendation evidence keeps the normal grounded response and natural question', async () => {
  const sessionId = 'verified-recommendation-natural-question';
  const question = 'What do you recommend for a first-time visitor?';
  const recommendation = 'Intro Facial is recommended for first-time visitors.';
  const clarification = 'What result matters most to you?';
  seedInformation(sessionId, question, {
    ...serviceConfig,
    systemPrompt: recommendation,
  });
  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim: recommendation,
        candidateQuote: recommendation,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{ source: 'business_system_prompt', quote: recommendation }],
      }],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const candidate = `${recommendation} ${clarification}`;
  assert.equal(
    await b.businessSupportGrounding(sessionId, question, candidate, 'en'),
    candidate,
  );
});

test('no verified information fails closed without inventing services or recommendations', async () => {
  const sessionId = 'no-verified-information';
  const question = 'What services do you offer and what would you recommend?';
  seedInformation(sessionId, question, {
    ...serviceConfig,
    systemPrompt: 'Be friendly. Recommend premium services.',
    services: [],
  });
  b.configure({ assessBusinessSupportGrounding: async () => null });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    'The Premium treatment is best and costs 999 SEK.',
    'en',
  );

  assert.match(reply, /can't find a specific answer/i);
  assert.doesNotMatch(reply, /Premium|999/);
});

test('behavioral and style prompt instructions are excluded from factual evidence', () => {
  const instruction = b.businessInformationInstruction({
    businessConfig: {
      ...serviceConfig,
      systemPrompt: [
        'Verified Studio provides gentle facial treatments.',
        'Be friendly.',
        'Recommend premium services.',
        'Tone: warm and enthusiastic.',
        'The assistant should always upsell.',
      ].join(' '),
    },
    question: 'Tell me about the business.',
    language: 'en',
  });
  const factualSource = instruction
    .split('SOURCE business_system_prompt:\n')[1]
    .split('\n\nSOURCE structured_business_config:')[0];

  assert.match(factualSource, /Verified Studio provides gentle facial treatments/);
  assert.doesNotMatch(factualSource, /Be friendly|Recommend premium|Tone:|assistant should|upsell/i);
});

test('supported claim with non-verbatim evidence quote is repaired before falling back', async () => {
  const sessionId = 'evidence-quote-repair';
  const question = 'What services do you offer and what do you recommend for a first-time visitor?';
  const factualClaim = 'Intro Facial takes 45 minutes.';
  const clarification = 'What kind of result are you hoping for?';
  const candidate = `${factualClaim} ${clarification}`;

  seedInformation(sessionId, question);

  let assessmentCalls = 0;

  b.configure({
    assessBusinessSupportGrounding: async () => {
      assessmentCalls += 1;

      if (assessmentCalls === 1) {
        return {
          hasBusinessFactualClaims: true,
          allBusinessClaimsSupported: true,
          claims: [{
            claim: factualClaim,
            candidateQuote: factualClaim,
            claimKind: 'OTHER',
            requiresBusinessEvidence: true,
            supported: true,
            evidence: [{
              source: 'structured_business_config',
              quote: 'Intro Facial takes 45 minutes',
            }],
          }],
        };
      }

      return {
        hasBusinessFactualClaims: true,
        allBusinessClaimsSupported: true,
        claims: [{
          claim: factualClaim,
          candidateQuote: factualClaim,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{
            source: 'structured_business_config',
            quote: '"durationMinutes": 45',
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

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    candidate,
    'en',
  );

  assert.ok(
    assessmentCalls >= 2,
    'invalid non-verbatim evidence should trigger a constrained evidence repair pass',
  );
  assert.equal(reply, candidate);
});

test('natural recommendation clarification with purpose prefix and harmless intro is preserved', async () => {
  const sessionId = 'recommendation-purpose-prefix';
  const question =
    'Hi! Can you tell me a little about your services and what you would recommend for someone visiting for the first time?';

  const factualClaim = 'Intro Facial takes 45 minutes.';
  const candidate =
    'Hello! Here are some of our services: ' +
    factualClaim +
    ' To help recommend something perfect for your first visit, could you tell me a little about your main marketing goal or target platform? 🚀';

  seedInformation(sessionId, question);

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim: factualClaim,
        candidateQuote: factualClaim,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{
          source: 'structured_business_config',
          quote: '"durationMinutes": 45',
        }],
      }],
    }),

    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const reply = await b.businessSupportGrounding(
    sessionId,
    question,
    candidate,
    'en',
  );

  assert.equal(reply, candidate);
});
