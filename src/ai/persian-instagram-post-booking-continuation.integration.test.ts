import assert from 'node:assert/strict';
import { isPositiveBookingConfirmation } from './booking-state-machine';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-02T12:00:00+02:00');
const businessConfig = {
  id: 'odin-fa-post-booking-continuation',
  businessRecordId: 'odin-fa-post-booking-continuation',
  businessName: 'Persian Instagram Clinic',
  language: 'de',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'persian-instagram-calendar',
  defaultBookingService: 'Video Consultation',
  services: [{ name: 'Video Consultation', duration: 30 }],
  workingHours: { tuesday: [{ start: '09:00', end: '20:00' }] },
};

const calls = {
  calendarReads: 0,
  calendarCreates: 0,
  databaseCreates: 0,
  groundingVerifier: 0,
  entailment: 0,
};
let eventSequence = 0;
let rowSequence = 0;
let events = new Map<string, any>();

const configure = () => {
  boundary.reset();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  eventSequence = 0;
  rowSequence = 0;
  events = new Map();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => businessConfig.googleCalendarId,
      getEvents: async () => { calls.calendarReads += 1; return [...events.values()]; },
      checkSlots: async () => { throw new Error('legacy availability must not run'); },
      insertAppointment: async (
        name: string,
        phone: string,
        service: string,
        dateTime: string,
        durationMinutes = 30,
      ) => {
        calls.calendarCreates += 1;
        const id = `persian-event-${++eventSequence}`;
        const event = {
          id,
          status: 'confirmed',
          summary: `Bokad: ${name} - ${phone}`,
          start: { dateTime: new Date(dateTime).toISOString() },
          end: { dateTime: new Date(new Date(dateTime).getTime() + durationMinutes * 60_000).toISOString() },
          extendedProperties: {
            private: {
              platform: 'instagram',
              userId: 'persian-instagram-sender',
              businessId: businessConfig.id,
            },
          },
          description: `BusinessId: ${businessConfig.id}`,
        };
        events.set(id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
    },
    recordAppointment: async (params: any) => {
      calls.databaseCreates += 1;
      const start = new Date(params.dateTime).toISOString();
      return {
        id: ++rowSequence,
        business_id: businessConfig.id,
        platform: params.platform,
        user_id: params.userId,
        service: params.service,
        start_time: start,
        end_time: new Date(new Date(start).getTime() + params.durationMinutes * 60_000).toISOString(),
        status: 'booked',
        created_at: new Date().toISOString(),
      };
    },
    claimOperation: async (params: any) => ({
      claimed: true,
      keyHash: `claim-${eventSequence}`,
      storageId: `claim-${eventSequence}`,
      state: {
        type: params.type,
        status: 'processing',
        attempts: 1,
        claimedAt: Date.now(),
        updatedAt: Date.now(),
      },
    }),
    settleOperation: async () => true,
    notifyBooking: async () => true,
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    assessBusinessSupportGrounding: () => {
      calls.groundingVerifier += 1;
      return { hasBusinessFactualClaims: false, claims: [], allBusinessClaimsSupported: true };
    },
    assessBusinessClaimEntailment: () => {
      calls.entailment += 1;
      return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false };
    },
  } as any);
};

const seedStaleGermanCompletion = (sessionId: string) => {
  boundary.seedFlowLanguage(sessionId, 'de', 'booking');
  boundary.seedRecentCompletedBooking(sessionId, 'de', {
    ok: true,
    bookingId: `old-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-02T14:00:00+02:00',
    customerName: 'Old Name',
    customerPhone: '0701111111',
    sourceChannel: 'instagram',
  }, 30);
};

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'instagram',
  recipientUserId: 'persian-instagram-sender',
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

const turn1Text = 'سلام، می‌خواهم برای سه‌شنبه ۱۵ سپتامبر ۲۰۲۶ یک وقت رزرو کنم.';
const turn2Text = 'سلام، پس لطفاً برای سه‌شنبه ۱۵ سپتامبر ۲۰۲۶ وقت رزرو کنید. نام من اسکار ساندبرگ و شماره تماسم ۰۷۰۰۰۰۷۶۲۸ است.';
const turn3Text = 'سلام، لطفاً وقت ۱۴:۰۰ برای سه‌شنبه ۱۵ سپتامبر ۲۰۲۶ را رزرو کنید.';
const turn4Text = 'بله، لطفاً رزرو کنید. ممنونم که وقت ۱۴:۰۰ برای سه‌شنبه ۱۵ سپتامبر ۲۰۲۶ را برایم ثبت می‌کنید. نام من اسکار ساندبرگ و شماره تماس ۰۷۰۰۰۰۷۶۲۸ است.';
const requirementsText = 'عالیه، ممنون. اطلاعات یا تأیید دیگری از طرف من لازم دارید؟';
const preparationText = 'برای جلسه لازم است چیز خاصی همراه داشته باشم یا از قبل آماده کنم؟';
const statusText = 'نه، ممنونم. آیا قرار من تأیید شده و با چه نام و شماره تلفنی ثبت شده است؟';

try {
  configure();
  const freshTurn1 = await turn('persian-instagram-fresh-turn-1', turn1Text);
  assert.equal(freshTurn1.handled, true);
  assert.equal(freshTurn1.pending?.selectedDate, '2026-09-15');
  assert.equal(freshTurn1.pending?.language, 'fa');
  assert.match(freshTurn1.replies.join(' '), /زمان|خالی/u);

  configure();
  const sessionId = 'persian-instagram-live-sequence';
  seedStaleGermanCompletion(sessionId);
  assert.equal(boundary.detectStrongLanguage(turn1Text, businessConfig), 'fa');
  assert.equal(boundary.isExplicitDatedBookingCreation(turn1Text, businessConfig, now), true);
  assert.equal(
    boundary.recentCompletionClassification(sessionId, turn1Text, businessConfig, now)?.category,
    'new_booking',
  );

  const first = await turn(sessionId, turn1Text);
  assert.equal(first.handled, true);
  assert.equal(first.pending?.selectedDate, '2026-09-15');
  assert.equal(first.pending?.status, 'awaiting_time_selection');
  assert.equal(first.pending?.language, 'fa');
  assert.equal(boundary.recentCompletionState(sessionId).support, null);
  assert.equal(calls.calendarReads, 1);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  const second = await turn(sessionId, turn2Text);
  assert.equal(second.handled, true);
  assert.equal(second.pending?.status, 'awaiting_time_selection');
  assert.equal(second.pending?.language, 'fa');
  assert.equal(second.pending?.customerName, 'اسکار ساندبرگ');
  assert.equal(second.pending?.customerPhone, '0700007628');
  assert.match(second.replies.join(' '), /زمان|خالی/u);
  assert.doesNotMatch(second.replies.join(' '), /Hier|Dienstag|verfügbar/iu);
  assert.equal(calls.calendarReads, 2);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  const third = await turn(sessionId, turn3Text);
  assert.equal(third.handled, true);
  assert.equal(third.pending?.status, 'awaiting_confirmation');
  assert.equal(third.pending?.language, 'fa');
  assert.equal(third.pending?.dateTime, '2026-09-15T14:00:00+02:00');
  assert.match(third.replies.join(' '), /14:00|رزرو/u);
  assert.equal(calls.calendarReads, 3);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  assert.equal(isPositiveBookingConfirmation(turn4Text), false);
  assert.equal(
    boundary.isPendingSlotConfirmation(sessionId, turn4Text, businessConfig, now),
    true,
  );
  const fourth = await turn(sessionId, turn4Text);
  assert.equal(fourth.handled, true);
  assert.equal(fourth.pending, null);
  assert.equal(calls.calendarCreates, 1);
  assert.equal(calls.databaseCreates, 1);
  assert.equal(calls.calendarReads, 5);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);
  assert.match(fourth.replies.join(' '), /اسکار ساندبرگ|رزرو شد|تأیید/u);
  assert.doesNotMatch(fourth.replies.join(' '), /می‌خواهید برایتان رزرو کنم/u);

  assert.equal(
    boundary.recentCompletionClassification(sessionId, requirementsText, businessConfig, now)?.category,
    'completion_requirements',
  );
  const requirements = await turn(sessionId, requirementsText);
  assert.equal(requirements.handled, true);
  assert.equal(requirements.pending, null);
  assert.match(requirements.replies.join(' '), /کار دیگری لازم نیست|اطلاعات تماس شما ثبت/u);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  assert.equal(
    boundary.recentCompletionClassification(sessionId, preparationText, businessConfig, now)?.category,
    'business_support',
  );
  const preparation = await turn(sessionId, preparationText);
  assert.equal(preparation.handled, false);
  assert.ok(boundary.recentCompletionState(sessionId).support);
  const preparationGap = await boundary.finalizeGeneralAiReply(
    sessionId,
    preparationText,
    'برای این جلسه نیاز به آمادگی خاصی ندارید.',
    'fa',
  );
  assert.match(preparationGap, /پاسخ مشخصی|اطلاعات موجود کسب/u);
  assert.equal(calls.groundingVerifier, 1);
  assert.equal(calls.entailment, 0);

  const readsBeforeStatus = calls.calendarReads;
  assert.equal(
    boundary.recentCompletionClassification(sessionId, statusText, businessConfig, now)?.category,
    'current_booking_status',
  );
  const status = await turn(sessionId, statusText);
  assert.equal(status.handled, true);
  assert.equal(status.pending, null);
  assert.equal(calls.calendarReads, readsBeforeStatus);
  assert.match(status.replies.join(' '), /اسکار ساندبرگ/u);
  assert.match(status.replies.join(' '), /0700007628/u);
  assert.doesNotMatch(status.replies.join(' '), /خالی|14:15|14:30|14:45/u);

  for (const [index, question] of [
    'اطلاعات دیگری لازم دارید؟',
    'تأیید دیگری لازم است؟',
    'چیز دیگری از من لازم دارید؟',
    'اطلاعات بیشتری لازم دارید؟',
  ].entries()) {
    configure();
    const requirementsSession = `persian-requirements-${index}`;
    boundary.seedRecentCompletedBooking(requirementsSession, 'fa', {
      ok: true,
      bookingId: `persian-requirements-${index}`,
      businessId: businessConfig.id,
      serviceName: 'Video Consultation',
      startTime: '2026-09-15T14:00:00+02:00',
      customerName: 'اسکار ساندبرگ',
      customerPhone: '0700007628',
      sourceChannel: 'instagram',
    }, 30);
    assert.equal(
      boundary.recentCompletionClassification(requirementsSession, question, businessConfig, now)?.category,
      'completion_requirements',
      question,
    );
    const result = await turn(requirementsSession, question);
    assert.equal(result.handled, true, question);
    assert.doesNotMatch(result.replies.join(' '), /پاسخ مشخصی|اطلاعات موجود کسب/u, question);
    assert.equal(calls.groundingVerifier, 0, question);
    assert.equal(calls.entailment, 0, question);
  }

  configure();
  const informationSession = 'persian-business-information-preserved';
  boundary.seedRecentCompletedBooking(informationSession, 'fa', {
    ok: true,
    bookingId: 'persian-business-information',
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-15T14:00:00+02:00',
    customerName: 'اسکار ساندبرگ',
    customerPhone: '0700007628',
    sourceChannel: 'instagram',
  }, 30);
  const informationText = 'هزینه جلسه چقدر است؟';
  assert.equal(
    boundary.recentCompletionClassification(informationSession, informationText, businessConfig, now)?.category,
    'business_support',
  );
  const information = await turn(informationSession, informationText);
  assert.equal(information.handled, false);
  assert.ok(boundary.recentCompletionState(informationSession).support);

  for (const [index, confirmation] of [
    'بله، لطفاً رزرو کنید.',
    'لطفاً رزرو کنید.',
    'برایم ثبت کنید.',
    'وقت را رزرو کنید.',
  ].entries()) {
    configure();
    const confirmationSession = `persian-confirmation-${index}`;
    const proposed = await turn(
      confirmationSession,
      'سلام، می‌خواهم برای سه‌شنبه ۱۵ سپتامبر ۲۰۲۶ ساعت ۱۴:۰۰ وقت رزرو کنم.',
    );
    assert.equal(proposed.pending?.status, 'awaiting_confirmation', confirmation);
    assert.equal(
      boundary.isPendingSlotConfirmation(confirmationSession, confirmation, businessConfig, now),
      true,
      confirmation,
    );
    const confirmed = await turn(confirmationSession, confirmation);
    assert.equal(confirmed.pending?.status, 'awaiting_contact', confirmation);
    assert.doesNotMatch(confirmed.replies.join(' '), /می‌خواهید برایتان رزرو کنم/u, confirmation);
  }

  configure();
  const supportSession = 'persian-business-support-preserved';
  boundary.seedRecentCompletedBooking(supportSession, 'fa', {
    ok: true,
    bookingId: 'persian-support-completed',
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-15T14:00:00+02:00',
    customerName: 'اسکار ساندبرگ',
    customerPhone: '0700007628',
    sourceChannel: 'instagram',
  }, 30);
  const supportText = 'آیا برای مشاوره باید چیزی همراه بیاورم؟';
  assert.equal(
    boundary.recentCompletionClassification(supportSession, supportText, businessConfig, now)?.category,
    'business_support',
  );
  const support = await turn(supportSession, supportText);
  assert.equal(support.handled, false);
  assert.ok(boundary.recentCompletionState(supportSession).support);
  assert.equal(calls.calendarReads, 0);

  originalLog('Persian Instagram post-booking continuation regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
