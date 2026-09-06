import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.STRUCTURED_UNDERSTANDING_ENABLED = 'false';

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = () => undefined;
console.error = () => undefined;

const warnings: Array<{ marker: unknown; event: any }> = [];
console.warn = (marker, event) => { warnings.push({ marker, event }); };

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const sessionId = 'customer-reply-guard-arabic-persian-regression';
const fallback = 'يسعدني مساعدتك بالعربية. ماذا تريد أن تعرف؟';

try {
  boundary.reset();

  boundary.seedFlowLanguage(sessionId, 'ar', 'booking');
  boundary.seedPending(sessionId, {
    status: 'awaiting_service',
    operation: 'new_booking',
    expectedInput: 'service',
    language: 'ar',
    service: 'Bokning',
    selectedDate: '2026-09-07',
  });

  const before = boundary.pendingStateSnapshot(sessionId);

  const productionReply =
    'لا يوجد موعد متاح لنفس اليوم والقيد الزمني. هل تريد تجربة يوم أو وقت آخر؟';

  warnings.length = 0;
  assert.equal(
    boundary.guardReply(sessionId, productionReply, 'ar'),
    productionReply,
    'Arabic reply containing وقت must not be classified as Persian',
  );
  assert.equal(
    warnings.filter(item => item.marker === '[CustomerReplyGuard]').length,
    0,
  );

  const arabicTimeReply =
    'يمكننا تجربة الوقت المناسب لك غداً، أي ساعة تفضل؟';

  warnings.length = 0;
  assert.equal(
    boundary.guardReply(sessionId, arabicTimeReply, 'ar'),
    arabicTimeReply,
    'Arabic الوقت must not be Persian evidence',
  );

  const arabicNameReply =
    'ما اسمك ورقم هاتفك لإكمال الحجز؟';

  warnings.length = 0;
  assert.equal(
    boundary.guardReply(sessionId, arabicNameReply, 'ar'),
    arabicNameReply,
    'Arabic اسمك must not be Persian evidence',
  );

  const genuinePersianReply =
    'برای رزرو لطفاً شماره موبایل خود را بفرستید.';

  warnings.length = 0;
  assert.equal(
    boundary.guardReply(sessionId, genuinePersianReply, 'ar'),
    fallback,
    'Genuine Persian must still be blocked when Arabic is expected',
  );
  assert.equal(
    warnings.filter(item => item.marker === '[CustomerReplyGuard]').length,
    1,
  );

  const englishReply =
    'Please choose an available time for test tomorrow.';

  warnings.length = 0;
  assert.equal(
    boundary.guardReply(sessionId, englishReply, 'ar'),
    fallback,
    'English must still be blocked when Arabic is expected',
  );

  assert.deepEqual(boundary.pendingStateSnapshot(sessionId), before);

  originalLog('CustomerReplyGuard Arabic/Persian regression tests passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
