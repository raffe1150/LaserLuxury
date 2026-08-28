import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const slot = (start: string) => ({
  start,
  end: new Date(new Date(start).getTime() + 60 * 60_000).toISOString(),
  durationMinutes: 60,
  service: 'Video Consultation',
  businessId: '3',
  platform: 'instagram',
  userId: 'customer',
  generatedAt: Date.now(),
  searchStartDate: '2026-08-28',
  searchEndDate: '2026-08-29',
});

const owned = [
  slot('2026-08-28T10:45:00+02:00'),
  slot('2026-08-28T11:00:00+02:00'),
];
const pending = {
  offeredSlots: owned.map((entry) => `Fredag kl 10:45 (ISO: ${entry.start})`),
  ownedOfferedSlots: owned,
};

for (const wording of [
  'Då bokar jag in mig på 10:45 den 28 augusti.',
  'Jag tar 10:45 den 28 augusti.',
  'Jag bokar 10.45 den 28 augusti.',
]) {
  assert.equal(boundary.selectOwnedSlot(wording, pending)?.start, owned[0].start);
}

assert.equal(
  boundary.selectOwnedSlot('Då bokar jag in mig på 10:45 den 29 augusti.', pending),
  null,
);

const sameTimeAcrossDates = {
  offeredSlots: [],
  ownedOfferedSlots: [
    ...owned,
    slot('2026-08-29T10:45:00+02:00'),
  ],
};
assert.equal(
  boundary.selectOwnedSlot('Jag tar 10:45.', sameTimeAcrossDates),
  null,
);
assert.equal(
  boundary.selectOwnedSlot('Jag tar 10:45 den 29 augusti.', sameTimeAcrossDates)?.start,
  '2026-08-29T10:45:00+02:00',
);
