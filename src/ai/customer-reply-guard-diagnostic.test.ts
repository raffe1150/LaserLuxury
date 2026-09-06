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
const sessionId = 'customer-reply-guard-diagnostic';
const fallback = 'يسعدني مساعدتك بالعربية. ماذا تريد أن تعرف؟';
const diagnostics = () => warnings.filter(item => item.marker === '[CustomerReplyGuardDiagnostic]');

try {
  boundary.reset();
  boundary.seedFlowLanguage(sessionId, 'ar', 'booking');
  boundary.seedPending(sessionId, {
    status: 'awaiting_service', operation: 'new_booking', expectedInput: 'service',
    language: 'ar', service: 'Bokning', selectedDate: '2026-09-07',
  });
  const before = boundary.pendingStateSnapshot(sessionId);
  const arabicReply = 'هذه المواعيد متاحة: الاثنين 7 سبتمبر الساعة 13:45 و14:00. أي وقت يناسبك؟';
  warnings.length = 0;
  // Preserve the existing false-positive behavior; this change only diagnoses it.
  assert.equal(boundary.guardReply(sessionId, arabicReply, 'ar'), fallback);
  assert.deepEqual(diagnostics(), [{
    marker: '[CustomerReplyGuardDiagnostic]',
    event: {
      replyBeforeGuard: arabicReply,
      expectedLanguage: 'ar',
      strongReplyLanguage: 'fa',
      hasEnglishStructure: false,
      hasSwedishStructure: false,
      hasPersianStructure: true,
      verifiedCompletionPresentationMatchesLanguage: false,
      pendingStatus: 'awaiting_service',
    },
  }]);
  assert.deepEqual(warnings.find(item => item.marker === '[CustomerReplyGuard]')?.event, {
    language: 'ar', mixedLanguageBlocked: true, stateType: 'booking',
  });
  assert.deepEqual(boundary.pendingStateSnapshot(sessionId), before);

  warnings.length = 0;
  const englishReply = 'Please choose an available time for test tomorrow.';
  assert.equal(boundary.guardReply(sessionId, englishReply, 'ar'), fallback);
  assert.equal(diagnostics().length, 1);
  assert.equal(diagnostics()[0].event.strongReplyLanguage, 'en');
  assert.equal(diagnostics()[0].event.hasEnglishStructure, true);

  warnings.length = 0;
  const accepted = 'بالتأكيد. لأي خدمة تريد حجز موعد؟';
  assert.equal(boundary.guardReply(sessionId, accepted, 'ar'), accepted);
  assert.deepEqual(warnings, [], 'accepted booking replies emit no guard diagnostic');

  boundary.seedFlowLanguage(sessionId, 'ar', 'availability');
  warnings.length = 0;
  assert.equal(boundary.guardReply(sessionId, englishReply, 'ar'), fallback);
  assert.equal(diagnostics().length, 0, 'blocked non-booking flow types emit no diagnostic');
  assert.equal(warnings.filter(item => item.marker === '[CustomerReplyGuard]').length, 1);

  boundary.reset();
  warnings.length = 0;
  assert.equal(boundary.guardReply(sessionId, englishReply, 'ar'), fallback);
  assert.equal(diagnostics().length, 0, 'a blocked reply with no flow emits no diagnostic');
  originalLog('CustomerReplyGuard diagnostic tests passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
