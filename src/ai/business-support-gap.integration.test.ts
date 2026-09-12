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
