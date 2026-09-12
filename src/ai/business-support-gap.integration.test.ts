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

test('WhatsApp service catalog question dispatches through unified read-only business-information path', () => {
  const sessionId = 'wa-service-catalog-dispatch';

  b.reset();

  const decision = b.whatsappPreDispatchDecision(
    sessionId,
    'Vilka tjänster erbjuder ni?',
  );

  assert.equal(decision.intent, 'normal');
  assert.equal(decision.returnsAmbiguousClarification, false);
  assert.equal(
    decision.dispatchesUnifiedBooking,
    true,
    'service catalog questions must enter unified engine so read-only business context is seeded',
  );
});

test('WhatsApp service catalog turn seeds read-only business context without creating booking state', async () => {
  const sessionId = 'wa-service-catalog-read-only';
  const businessConfig = {
    id: 'test-business',
    businessName: 'AdMotion Studio',
    language: 'sv',
    timezone: 'Europe/Stockholm',
    services: [
      { name: 'Video Consultation', durationMinutes: 30 },
      { name: 'test', durationMinutes: 30 },
      { name: 'video for tiktok', durationMinutes: 30 },
      { name: 'Golden video', durationMinutes: 30 },
      { name: 'Reklam', durationMinutes: 30 },
    ],
  };

  b.reset();
  b.seedFlowLanguage(sessionId, 'sv');

  const result = await b.turn({
    sessionId,
    platformName: 'whatsapp',
    recipientUserId: '46700000000',
    text: 'Vilka tjänster erbjuder ni?',
    businessConfig,
  });

  assert.equal(result.handled, false);
  assert.equal(result.replies.length, 0);
  assert.equal(result.pending, null);

  const information = b.businessInformationState(sessionId);
  assert.ok(information, 'business-information context must be seeded');
  assert.equal(information.question, 'Vilka tjänster erbjuder ni?');
  assert.equal(information.language, 'sv');
  assert.deepEqual(
    information.businessConfig.services.map((service: any) => service.name),
    ['Video Consultation', 'test', 'video for tiktok', 'Golden video', 'Reklam'],
  );
});
