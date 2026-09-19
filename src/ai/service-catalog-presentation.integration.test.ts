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
    'Vi erbjuder Video Consultation, test, video for tiktok, Golden video och Reklam.';

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam.',
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
    'Los servicios disponibles son Video Consultation, test, video for tiktok, Golden video y Reklam.';

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim:
          'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam.',
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


test('shared AI generation forwards structured response configuration', async () => {
  let capturedParams: any = null;

  b.reset();
  b.configure({
    geminiGenerate: async (params: any) => {
      capturedParams = params;
      return { text: '{"ok":true}' };
    },
  });

  await b.promptAuditGenerate(null, {
    messages: [{ role: 'user', content: 'test' }],
    systemInstruction: 'Return JSON.',
    model: 'gemini-2.5-flash',
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN' },
      },
      required: ['ok'],
    },
  });

  assert.equal(
    capturedParams?.config?.responseMimeType,
    'application/json',
    'Shared AI helper must forward responseMimeType to Gemini',
  );

  assert.deepEqual(
    capturedParams?.config?.responseSchema,
    {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN' },
      },
      required: ['ok'],
    },
    'Shared AI helper must forward responseSchema to Gemini',
  );
});


test('business grounding verifier requests structured JSON output', async () => {
  const sessionId = 'catalog-grounding-structured-output';
  const calls: any[] = [];

  b.reset();

  b.businessInformationState(
    sessionId,
    businessConfig,
    'What services are available?',
    'en',
  );

  const candidate =
    'We offer Video Consultation, test, video for tiktok, Golden video and Reklam.';

  b.configure({
    geminiGenerate: async (params: any) => {
      calls.push(params);

      if (calls.length === 1) {
        return {
          text: JSON.stringify({
            hasBusinessFactualClaims: true,
            claims: [{
              claim:
                'The business offers Video Consultation, test, video for tiktok, Golden video and Reklam.',
              candidateQuote: candidate,
              claimKind: 'OTHER',
              requiresBusinessEvidence: true,
              supported: true,
              evidence: [{
                source: 'structured_business_config',
                quote: '"name": "Video Consultation"',
              }],
            }],
            allBusinessClaimsSupported: true,
          }),
        };
      }

      return {
        text: JSON.stringify({
          relation: 'ENTAILED',
          claimKind: 'OTHER',
          explicitAbsenceEvidence: false,
        }),
      };
    },
  });

  await b.businessSupportGrounding(
    sessionId,
    'What services are available?',
    candidate,
    'en',
  );

  assert.ok(calls.length >= 1, 'Grounding verifier should call Gemini');

  assert.equal(
    calls[0]?.config?.responseMimeType,
    'application/json',
    'Grounding verifier must request JSON output',
  );

  assert.equal(
    calls[0]?.config?.responseSchema?.type,
    'OBJECT',
    'Grounding verifier must provide a response schema',
  );

  assert.deepEqual(
    calls[0]?.config?.responseSchema?.required,
    [
      'hasBusinessFactualClaims',
      'claims',
      'allBusinessClaimsSupported',
    ],
    'Grounding verifier schema must require the complete assessment contract',
  );
});
