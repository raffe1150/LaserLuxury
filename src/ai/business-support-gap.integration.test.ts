import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

test('Swedish service catalog reply does not append an unrelated knowledge gap', () => {
  const sessionId = 'sv-service-catalog-gap';

  b.businessInformationState(
    sessionId,
    {
      id: 'test-business',
      language: 'sv',
      services: [
        { name: 'Video Consultation', durationMinutes: 30 },
        { name: 'test', durationMinutes: 30 },
        { name: 'video for tiktok', durationMinutes: 30 },
        { name: 'Golden video', durationMinutes: 30 },
        { name: 'Reklam', durationMinutes: 30 },
      ],
    },
    'Vilka tjänster erbjuder ni?',
    'sv',
  );

  const reply = b.businessSupportGap(
    sessionId,
    'Vilka tjänster erbjuder ni?',
    'sv',
  );

  assert.match(reply, /Video Consultation/);
  assert.match(reply, /Golden video/);
  assert.doesNotMatch(
    reply,
    /Jag hittar ingen specifik uppgift|Verksamheten kan bekräfta vad som gäller/iu,
  );
});

test('direct service catalog question overrides a grounded generic business description', async () => {
  const sessionId = 'sv-service-catalog-grounded-description';

  b.businessInformationState(
    sessionId,
    {
      id: 'test-business',
      language: 'sv',
      systemPrompt: 'AdMotion Studio skapar effektiva korta videoannonser för digitala plattformar.',
      services: [
        { name: 'Video Consultation', durationMinutes: 30 },
        { name: 'test', durationMinutes: 30 },
        { name: 'video for tiktok', durationMinutes: 30 },
        { name: 'Golden video', durationMinutes: 30 },
        { name: 'Reklam', durationMinutes: 30 },
      ],
    },
    'Vilka tjänster erbjuder ni?',
    'sv',
  );

  b.configure({
    assessBusinessSupportGrounding: async () => ({
      hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: true,
      claims: [{
        claim: 'AdMotion Studio skapar effektiva korta videoannonser för digitala plattformar.',
        candidateQuote: 'AdMotion Studio skapar effektiva korta videoannonser för digitala plattformar.',
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{
          source: 'business_system_prompt',
          quote: 'AdMotion Studio skapar effektiva korta videoannonser för digitala plattformar.',
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
    'Vilka tjänster erbjuder ni?',
    'AdMotion Studio skapar effektiva korta videoannonser för digitala plattformar.',
    'sv',
  );

  assert.match(reply, /Video Consultation/);
  assert.match(reply, /Golden video/);
  assert.doesNotMatch(reply, /AdMotion Studio skapar effektiva korta videoannonser/iu);
});
