import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const warm = {
  tonePreset: 'warm',
  responseLength: 'detailed',
  formality: 'casual',
  emojiUsage: 'expressive',
  customToneInstructions: '',
} as const;
const professional = {
  tonePreset: 'professional',
  responseLength: 'balanced',
  formality: 'formal',
  emojiUsage: 'none',
  customToneInstructions: '',
} as const;

const detailsSession = 'tone-guard-details';
boundary.seedPending(detailsSession, {
  status: 'awaiting_contact',
  customerName: null,
  customerPhone: null,
  service: 'Consultation',
});
const warmDetails = boundary.guardReply(detailsSession, 'Jag behöver ditt namn.', 'en', warm);
const professionalDetails = boundary.guardReply(detailsSession, 'Jag behöver ditt namn.', 'en', professional);
assert.notEqual(warmDetails, professionalDetails);
assert.match(warmDetails, /name.*mobile number/i);
assert.match(professionalDetails, /name.*mobile number/i);
assert.doesNotMatch(professionalDetails, /\p{Extended_Pictographic}/u);

const confirmationSession = 'tone-guard-confirmation';
boundary.seedVerifiedBookingReply(confirmationSession, {
  ok: true,
  bookingId: 'booking-1',
  businessId: 'business-1',
  serviceName: 'Consultation',
  startTime: '2026-08-26T15:00:00+02:00',
  customerName: 'Rihanna',
  sourceChannel: 'telegram',
});
try {
  const warmConfirmation = boundary.guardReply(confirmationSession, 'Your booking is confirmed.', 'en', warm);
  const professionalConfirmation = boundary.guardReply(confirmationSession, 'Your booking is confirmed.', 'en', professional);
  assert.notEqual(warmConfirmation, professionalConfirmation);
  for (const fact of ['Rihanna', 'consultation', '15:00']) {
    assert.match(warmConfirmation, new RegExp(fact, 'i'));
    assert.match(professionalConfirmation, new RegExp(fact, 'i'));
  }
  assert.doesNotMatch(professionalConfirmation, /\p{Extended_Pictographic}/u);
} finally {
  boundary.clearVerifiedBookingReply(confirmationSession);
  boundary.reset();
}

const persianAvailabilitySession = 'persian-gregorian-date-availability';
boundary.seedPending(persianAvailabilitySession, {
  status: 'awaiting_time_selection',
  offeredSlots: [
    'چهارشنبه ساعت 18:15 (ISO: 2026-08-26T18:15:00+02:00)',
    'چهارشنبه ساعت 18:30 (ISO: 2026-08-26T18:30:00+02:00)',
    'چهارشنبه ساعت 18:45 (ISO: 2026-08-26T18:45:00+02:00)',
  ],
});
const persianAvailability = boundary.guardReply(
  persianAvailabilitySession,
  'I found available times.',
  'fa',
  professional,
);
assert.match(persianAvailability, /چهارشنبه 26 اوت/u);

const persianConfirmationSession = 'persian-gregorian-date-confirmation';
boundary.seedVerifiedBookingReply(persianConfirmationSession, {
  ok: true,
  bookingId: 'booking-fa-date',
  businessId: 'business-fa-date',
  serviceName: 'Consultation',
  startTime: '2026-08-26T18:30:00+02:00',
  customerName: 'آرمان',
  sourceChannel: 'telegram',
});
try {
  const persianConfirmation = boundary.guardReply(
    persianConfirmationSession,
    'Your booking is confirmed.',
    'fa',
    professional,
  );
  assert.match(persianConfirmation, /چهارشنبه ۲۶ اوت/u);
  assert.match(persianConfirmation, /18:30/u);
  assert.doesNotMatch(persianConfirmation, /شهریور/u);
} finally {
  boundary.clearVerifiedBookingReply(persianConfirmationSession);
  boundary.reset();
}

console.log('Deterministic booking Tone guard tests passed.');
