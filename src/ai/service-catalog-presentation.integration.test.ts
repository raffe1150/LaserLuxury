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
