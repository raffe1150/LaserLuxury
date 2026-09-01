import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: 'instagram-boundary-business',
  businessName: 'Instagram Boundary Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'instagram-boundary-calendar',
};

boundary.reset();
boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'instagram-boundary-calendar',
    checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => [],
    insertAppointment: async () => ({ success: false }),
  },
  recordAppointment: async () => null,
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
});

try {
  const reminder = 'Hej Alex! En vänlig påminnelse från kliniken: du har tid för Video Consultation idag kl 14:00. Vi ses snart! 😊';
  assert.equal(
    boundary.instagramOutboundText('customer-1', reminder, 'proactive', 'fresh-instagram-session'),
    reminder,
  );
  assert.equal(
    boundary.instagramOutboundText('customer-1', reminder, 'conversation', 'fresh-instagram-session'),
    'I’m happy to help in English. What would you like to know?',
    'actual conversational replies retain the language guard',
  );

  const base = { sender: { id: 'customer-1' }, recipient: { id: 'business-1' } };
  const rejectedEvents = [
    { ...base, message: { mid: 'echo-1', is_echo: true, text: 'echo' } },
    { ...base, delivery: { mids: ['delivery-1'] } },
    { ...base, read: { watermark: 123 } },
    { ...base, message: { mid: 'reaction-1', reaction: { action: 'react', emoji: '❤' } } },
    { ...base, message: { mid: 'empty-1', text: '   ' } },
    { ...base, message: { mid: 'unsupported-1', attachments: [{ type: 'image', payload: { url: 'https://example.invalid/image' } }] } },
  ];
  for (const event of rejectedEvents) {
    assert.equal(boundary.instagramEventCanEnterConversation(event), false);
  }
  assert.equal(
    boundary.instagramEventCanEnterConversation({ ...base, message: { mid: 'text-1', text: 'Hola' } }),
    true,
  );
  assert.equal(
    boundary.instagramEventCanEnterConversation({ ...base, message: { mid: 'audio-1', attachments: [{ type: 'audio', payload: { url: 'https://example.invalid/audio' } }] } }),
    true,
  );

  const duplicateSession = 'instagram-duplicate-inbound';
  boundary.seedRecentCompletedBooking(duplicateSession, 'es', {
    ok: true,
    bookingId: 'instagram-duplicate-booking',
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-02T14:00:00+02:00',
    customerName: 'Alex Testsson',
    customerPhone: '0701234567',
    sourceChannel: 'instagram',
  });
  const duplicateParams = {
    sessionId: duplicateSession,
    platformName: 'instagram' as const,
    recipientUserId: 'customer-1',
    text: '¿Está confirmada mi reserva?',
    inputMode: 'text' as const,
    businessConfig,
    now: new Date('2026-09-01T12:00:00+02:00'),
    eventId: 'same-instagram-mid',
  };
  const first = await boundary.inboundTurn(duplicateParams);
  const duplicate = await boundary.inboundTurn(duplicateParams);
  assert.equal(first.replies.length, 1);
  assert.equal(duplicate.replies.length, 0);
} finally {
  boundary.reset();
}

console.log('Instagram outbound/inbound boundary regressions passed');
