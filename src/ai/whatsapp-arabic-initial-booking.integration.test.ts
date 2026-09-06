import assert from 'node:assert/strict';
import { detectNormalizedIntent } from './booking-intelligence';
import { classifyMessagingIntent } from './channel-reliability';

process.env.NODE_ENV = 'test';
process.env.STRUCTURED_UNDERSTANDING_ENABLED = 'false';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const messages = ['مرحباً، أريد حجز موعد للغد.', 'أريد حجز تصوير حفل زفاف للغد.', 'test'];
const businessConfig = {
  id: 'whatsapp-arabic-p7', businessName: 'P7 Clinic', language: 'sv',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'p7-calendar',
  services: ['Video Consultation', 'test', 'video for tiktok', 'Golden video'].map(name => ({ name, duration: 30 })),
  workingHours: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(day => [day, [{ start: '09:00', end: '17:00' }]])),
};

try {
  boundary.reset();
  const reads: Array<{ start: string; end: string }> = [];
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'p7-calendar',
      getEvents: async (start: string, end: string) => { reads.push({ start, end }); return []; },
      checkSlots: async () => { throw new Error('legacy availability must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  for (const text of [...messages.slice(0, 2), 'أريد حجز موعد.', 'اريد حجز موعد للغد.', 'أود أن أحجز موعد للغد.']) {
    assert.equal(detectNormalizedIntent(text), 'new_booking', text);
    assert.equal(classifyMessagingIntent(text), 'new_booking', text);
  }
  for (const text of ['موعد', 'لا أريد حجز موعد للغد.', 'هل أريد حجز موعد؟', 'أريد إلغاء حجز موعد.']) {
    assert.notEqual(detectNormalizedIntent(text), 'new_booking', text);
  }
  assert.equal(detectNormalizedIntent('هل لدي موعد غدا؟'), 'booking_lookup');

  const sessionId = boundary.channelSessionId('whatsapp', '46700000001', businessConfig, 'p7-phone-id');
  for (const [index, text] of messages.entries()) {
    const decision = boundary.whatsappPreDispatchDecision(sessionId, text);
    assert.equal(decision.returnsAmbiguousClarification, false, text);
    assert.equal(decision.dispatchesUnifiedBooking, true, text);
    const result = await boundary.turn({
      sessionId, platformName: 'whatsapp', recipientUserId: '46700000001',
      text, businessConfig, now: new Date('2026-09-07T00:52:00+02:00'),
    });
    assert.equal(result.handled, true);
    assert.equal(result.pending?.language, 'ar');
    assert.equal(result.pending?.selectedDate, '2026-09-08');
    assert.equal(result.pending?.normalizedBookingRequest?.date?.value, '2026-09-08');
    assert.doesNotMatch(result.replies.join(' '), /هل تقصد حجزًا جديدًا|ماذا تريد أن تعرف/u);
    if (index < 2) {
      assert.equal(result.pending?.status, 'awaiting_service');
      assert.equal(result.pending?.service, 'Bokning');
      assert.equal(reads.length, 0);
      assert.deepEqual(result.pending?.offeredSlots, []);
      if (index === 0) {
        assert.equal(result.pending?.requestedService, null);
        assert.match(result.replies.join(' '), /خدمة/u);
      } else {
        assert.equal(result.pending?.requestedService, 'تصوير حفل زفاف');
        assert.match(result.replies.join(' '), /لا أستطيع مطابقة/u);
        for (const service of businessConfig.services) assert.ok(result.replies.join(' ').includes(service.name));
      }
    } else {
      assert.equal(result.pending?.service, 'test');
      assert.equal(result.pending?.status, 'awaiting_time_selection');
      assert.deepEqual(reads, [{ start: '2026-09-08', end: '2026-09-08' }]);
      assert.ok(result.pending?.ownedOfferedSlots?.length > 0);
      assert.match(result.replies.join(' '), /متاحة|المتاح/u);
    }
  }
  originalLog('P7 WhatsApp Arabic initial booking regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
