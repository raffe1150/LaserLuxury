import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const configured = {
  id: '3',
  services: [
    { name: 'Video Consultation', durationMinutes: 60 },
  ],
};

assert.equal(
  boundary.resolveConfiguredService('Konsultation', configured),
  'Video Consultation',
);
assert.equal(
  await boundary.resolveConfiguredDuration('Konsultation', configured),
  60,
);

const ambiguous = {
  services: [
    { name: 'Video Consultation', durationMinutes: 60 },
    { name: 'Strategy Consultation', durationMinutes: 90 },
  ],
};

assert.equal(boundary.resolveConfiguredService('Konsultation', ambiguous), null);
assert.equal(await boundary.resolveConfiguredDuration('Konsultation', ambiguous), 30);

const unrelatedSingleService = {
  services: [
    { name: 'Hair Treatment', durationMinutes: 75 },
  ],
};

assert.equal(
  boundary.resolveConfiguredService('Konsultation', unrelatedSingleService),
  null,
);
assert.equal(
  await boundary.resolveConfiguredDuration('Konsultation', unrelatedSingleService),
  30,
);
