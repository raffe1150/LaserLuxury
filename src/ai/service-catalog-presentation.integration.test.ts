import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const businessConfig = {
  id: 'catalog-presentation-business',
  businessName: 'AdMotion Studio',
  language: 'sv',
  systemPrompt:
    'AdMotion Studio skapar korta videoannonser för digitala plattformar.',
  toneConfig: {
    tonePreset: 'warm',
    responseLength: 'short',
    formality: 'balanced',
    emojiUsage: 'none',
    customToneInstructions: '',
  },
  services: [
    { name: 'Video Consultation', durationMinutes: 30 },
    { name: 'test', durationMinutes: 30 },
    { name: 'video for tiktok', durationMinutes: 30 },
    { name: 'Golden video', durationMinutes: 30 },
    { name: 'Reklam', durationMinutes: 30 },
  ],
};

test('valid natural service-catalog presentation is preserved instead of replaced by deterministic prose', async () => {
  const sessionId = 'catalog-natural-presentation';

  b.reset();

  b.businessInformationState(
    sessionId,
    businessConfig,
    'Vilka tjänster erbjuder ni?',
    'sv',
  );

  const factualQuote =
    'Vi erbjuder Video Consultation (30 minuter), test (30 minuter), video for tiktok (30 minuter), Golden video (30 minuter) och Reklam (30 minuter).';

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam, each with a configured duration of 30 minutes.',
        candidateQuote: factualQuote,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [
          {
            source: 'structured_business_config',
            quote: '"name": "Video Consultation"',
          },
          {
            source: 'structured_business_config',
            quote: '"name": "test"',
          },
          {
            source: 'structured_business_config',
            quote: '"name": "video for tiktok"',
          },
          {
            source: 'structured_business_config',
            quote: '"name": "Golden video"',
          },
          {
            source: 'structured_business_config',
            quote: '"name": "Reklam"',
          },
        ],
      }],
    }),

    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const candidate =
    `Absolut! ${factualQuote}`;

  const result = await b.businessSupportGrounding(
    sessionId,
    'Vilka tjänster erbjuder ni?',
    candidate,
    'sv',
  );

  assert.equal(
    result,
    candidate,
    'A fully grounded natural catalog presentation should survive the final grounding guard',
  );
});



test('catalog coverage ignores harmless multilingual presentation outside the complete catalog claim', async () => {
  const sessionId = 'catalog-spanish-natural-presentation';
  b.reset();

  b.businessInformationState(
    sessionId,
    businessConfig,
    '¿Qué servicios están disponibles?',
    'es',
  );

  const factualQuote =
    'Los servicios disponibles son Video Consultation (30 minutos), test (30 minutos), video for tiktok (30 minutos), Golden video (30 minutos) y Reklam (30 minutos).';

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam, each with a configured duration of 30 minutes.',
        candidateQuote: factualQuote,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [
          { source: 'structured_business_config', quote: '"name": "Video Consultation"' },
          { source: 'structured_business_config', quote: '"name": "test"' },
          { source: 'structured_business_config', quote: '"name": "video for tiktok"' },
          { source: 'structured_business_config', quote: '"name": "Golden video"' },
          { source: 'structured_business_config', quote: '"name": "Reklam"' },
        ],
      }],
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const candidate = `¡Claro! ${factualQuote} 🎬✨`;

  const result = await b.businessSupportGrounding(
    sessionId,
    '¿Qué servicios están disponibles?',
    candidate,
    'es',
  );

  assert.equal(
    result,
    candidate,
    'Natural multilingual presentation must not be rejected when one complete grounded catalog claim covers every configured service',
  );
});

test('entity-only atomic catalog quotes are rejected as incomplete verifier coverage', async () => {
  const sessionId = 'catalog-atomic-natural-presentation';
  b.reset();

  b.businessInformationState(
    sessionId,
    businessConfig,
    'What services are available?',
    'en',
  );

  const serviceNames = [
    'Video Consultation',
    'test',
    'video for tiktok',
    'Golden video',
    'Reklam',
  ];

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: serviceNames.map((serviceName) => ({
        claim: `The business offers ${serviceName}.`,
        candidateQuote: serviceName,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{
          source: 'structured_business_config',
          quote: `"name": "${serviceName}"`,
        }],
      })),
    }),
    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const candidate =
    'We offer Video Consultation, test, video for tiktok, Golden video, and Reklam. 🎬✨';

  const result = await b.businessSupportGrounding(
    sessionId,
    'What services are available?',
    candidate,
    'en',
  );

  assert.notEqual(
    result,
    candidate,
    'Entity-only candidateQuote values must not bypass material-claim coverage',
  );
  assert.match(result, /Video Consultation/);
  assert.match(result, /Reklam/);
});

test('invented catalog service must never survive', async () => {
  const sessionId = 'catalog-invented-service';

  b.reset();

  b.businessInformationState(
    sessionId,
    businessConfig,
    'Vilka tjänster erbjuder ni?',
    'sv',
  );

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: false,
      claims: [{
        claim: 'The business offers Wedding Photography.',
        candidateQuote: 'Wedding Photography',
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: false,
        evidence: [],
      }],
    }),

    assessBusinessClaimEntailment: async () => ({
      relation: 'UNKNOWN',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const unsafe =
    'Vi erbjuder Video Consultation, Golden video och Wedding Photography.';

  const result = await b.businessSupportGrounding(
    sessionId,
    'Vilka tjänster erbjuder ni?',
    unsafe,
    'sv',
  );

  assert.doesNotMatch(result, /Wedding Photography/);
  assert.match(result, /Video Consultation/);
  assert.match(result, /Golden video/);
});


test('service-catalog renderer instruction locks canonical configured service names', () => {
  const instruction = b.businessInformationInstruction({
    businessConfig,
    question: 'What services are available?',
    language: 'en',
  });

  assert.match(
    instruction,
    /preserve each configured service name exactly as provided/i,
    'Catalog rendering must explicitly lock canonical service names',
  );

  assert.match(
    instruction,
    /do not translate, rename, summarize, merge,.*omit configured service names/i,
    'Catalog rendering must forbid semantic rewriting or omission of canonical service names',
  );

  assert.match(
    instruction,
    /localize only the surrounding prose/i,
    'The LLM should own presentation language without modifying canonical service names',
  );

  for (const service of businessConfig.services) {
    assert.match(
      instruction,
      new RegExp(service.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `Instruction must contain canonical service name: ${service.name}`,
    );
  }
});

const sixServiceBusinessConfig = {
  ...businessConfig,
  services: [
    { name: 'Video Consultation', durationMinutes: 60, price: 300, currency: 'SEK' },
    { name: 'test', durationMinutes: 40, price: 150, currency: 'SEK' },
    { name: 'video for tiktok', durationMinutes: 15, price: 900, currency: 'SEK' },
    { name: 'Golden video', durationMinutes: 60, price: 1500, currency: 'SEK' },
    { name: 'Reklam', durationMinutes: 60, price: 1200, currency: 'SEK' },
    { name: 'video for Instagram', durationMinutes: 1, price: 500, currency: 'SEK' },
  ],
};

test('catalog presentation requires only the shared five-service display plan when more services exist', async () => {
  const sessionId = 'catalog-five-of-six-plan';

  b.reset();

  b.businessInformationState(
    sessionId,
    sixServiceBusinessConfig,
    'What services are available?',
    'en',
  );

  const factualQuote =
    'We offer Video Consultation (60 minutes, 300 SEK), test (40 minutes, 150 SEK), video for tiktok (15 minutes, 900 SEK), Golden video (60 minutes, 1500 SEK), and Reklam (60 minutes, 1200 SEK).';

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers the five services shown in the customer-facing catalog with their configured durations and prices.',
        candidateQuote: factualQuote,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [
          { source: 'structured_business_config', quote: '"name": "Video Consultation"' },
          { source: 'structured_business_config', quote: '"durationMinutes": 60' },
          { source: 'structured_business_config', quote: '"price": 300' },
          { source: 'structured_business_config', quote: '"name": "test"' },
          { source: 'structured_business_config', quote: '"name": "video for tiktok"' },
          { source: 'structured_business_config', quote: '"name": "Golden video"' },
          { source: 'structured_business_config', quote: '"name": "Reklam"' },
        ],
      }],
    }),

    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const candidate =
    `${factualQuote}\nWe have more services too. Tell me what you're looking for and I can help you find the right one.`;

  const result = await b.businessSupportGrounding(
    sessionId,
    'What services are available?',
    candidate,
    'en',
  );

  assert.equal(
    result,
    candidate,
    'A grounded five-service catalog plan must not require the hidden sixth service',
  );

  assert.doesNotMatch(result, /video for Instagram/);
});


test('greeting-only catalog reply cannot bypass the shared catalog requirement', async () => {
  const sessionId = 'catalog-greeting-only-bypass';

  b.reset();

  b.businessInformationState(
    sessionId,
    sixServiceBusinessConfig,
    '¿Qué servicios están disponibles?',
    'es',
  );

  const greetingOnly =
    '¡Hola! 👋 Soy Emily, la recepcionista de AdMotion Studio.';

  const result = await b.businessSupportGrounding(
    sessionId,
    '¿Qué servicios están disponibles?',
    greetingOnly,
    'es',
  );

  assert.notEqual(
    result,
    greetingOnly,
    'A greeting-only reply must never satisfy a service catalog request',
  );

  assert.match(result, /Video Consultation/);
  assert.match(result, /60 minutos/);
  assert.match(result, /300 SEK/);

  assert.match(result, /Reklam/);
  assert.match(result, /1200 SEK/);

  assert.doesNotMatch(result, /video for Instagram/);
});

test('catalog reply missing configured duration or price must fail completeness', async () => {
  const sessionId = 'catalog-missing-facts';

  b.reset();

  b.businessInformationState(
    sessionId,
    sixServiceBusinessConfig,
    'What services are available?',
    'en',
  );

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam.',
        candidateQuote:
          'We offer Video Consultation, test, video for tiktok, Golden video, and Reklam.',
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [
          { source: 'structured_business_config', quote: '"name": "Video Consultation"' },
          { source: 'structured_business_config', quote: '"name": "test"' },
          { source: 'structured_business_config', quote: '"name": "video for tiktok"' },
          { source: 'structured_business_config', quote: '"name": "Golden video"' },
          { source: 'structured_business_config', quote: '"name": "Reklam"' },
        ],
      }],
    }),

    assessBusinessClaimEntailment: async () => ({
      relation: 'ENTAILED',
      claimKind: 'OTHER',
      explicitAbsenceEvidence: false,
    }),
  });

  const incompleteCandidate =
    'We offer Video Consultation, test, video for tiktok, Golden video, and Reklam.';

  const result = await b.businessSupportGrounding(
    sessionId,
    'What services are available?',
    incompleteCandidate,
    'en',
  );

  assert.notEqual(
    result,
    incompleteCandidate,
    'Configured duration and price facts must not be silently omitted from the catalog',
  );

  assert.match(result, /Video Consultation/);
  assert.match(result, /60 minutes/);
  assert.match(result, /300 SEK/);
  assert.match(result, /Reklam/);
  assert.match(result, /1200 SEK/);
});

test('catalog-specific concision budget preserves the complete five-service follow-up', () => {
  const reply =
    'Our bookable services are: Video Consultation (60 minutes, 300 SEK), test (40 minutes, 150 SEK), video for tiktok (15 minutes, 900 SEK), Golden video (60 minutes, 1500 SEK), Reklam (60 minutes, 1200 SEK). We have more services too. Tell me what you are looking for and I can help you find the right one.';

  const generic = b.enforceConversationConcision(reply, 45);
  const catalog = b.enforceConversationConcision(reply, 90);

  assert.notEqual(generic, reply);
  assert.equal(catalog, reply);
  assert.match(catalog, /Tell me what you are looking for/);
});
