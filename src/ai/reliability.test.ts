import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AiReliabilityError,
  classifyAiFailure,
  containsUnverifiedBookingSuccessClaim,
  createBookingOperationResult,
  runAiProviderRequest,
} from './reliability';

async function runTests() {
  let attempts = 0;
  const recovered = await runAiProviderRequest({
    timeoutMs: 100,
    invoke: async () => {
      attempts++;
      if (attempts === 1) throw new Error('503 UNAVAILABLE');
      return 'ok';
    },
  });
  assert.equal(recovered, 'ok');
  assert.equal(attempts, 2, 'transient provider failures retry exactly once');

  attempts = 0;
  await assert.rejects(
    runAiProviderRequest({
      timeoutMs: 100,
      invoke: async () => {
        attempts++;
        throw new Error('invalid request payload');
      },
    }),
    (error: unknown) => error instanceof AiReliabilityError && error.category === 'UNKNOWN',
  );
  assert.equal(attempts, 1, 'non-retryable failures do not loop');

  attempts = 0;
  await assert.rejects(
    runAiProviderRequest({
      timeoutMs: 10,
      invoke: async () => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'late';
      },
    }),
    (error: unknown) => error instanceof AiReliabilityError && error.category === 'TIMEOUT',
  );
  assert.equal(attempts, 1, 'a timed-out request is not duplicated while the first call may still be live');

  assert.equal(classifyAiFailure(new Error('429 quota exceeded')), 'RATE_LIMIT');
  assert.equal(classifyAiFailure(new Error('fetch failed: ECONNRESET')), 'NETWORK');
  assert.equal(containsUnverifiedBookingSuccessClaim('Your appointment is confirmed.'), true);
  assert.equal(containsUnverifiedBookingSuccessClaim('Din tid är nu bokad.'), true);
  assert.equal(containsUnverifiedBookingSuccessClaim('Din tid för konsultation är nu bokad.'), true);
  assert.equal(containsUnverifiedBookingSuccessClaim('وقت شما رزرو شد.'), true);
  assert.equal(containsUnverifiedBookingSuccessClaim('I can help you choose a time.'), false);

  const successfulBooking = createBookingOperationResult({
    calendarCreated: true,
    calendarVerified: true,
    databaseInserted: true,
    databaseVerified: true,
    settlementRecorded: true,
    bookingId: 42,
    businessId: 7,
    serviceName: 'Consultation',
    startTime: '2026-08-04T10:00:00.000Z',
    customerName: 'Test Customer',
    sourceChannel: 'telegram',
  });
  assert.equal(successfulBooking.ok, true);
  assert.equal(successfulBooking.ok && successfulBooking.startTime, '2026-08-04T10:00:00.000Z');
  assert.deepEqual(createBookingOperationResult({
    calendarCreated: false,
    calendarVerified: false,
    databaseInserted: false,
    databaseVerified: false,
    settlementRecorded: false,
  }), { ok: false, code: 'PROVIDER_FAILED' });
  assert.deepEqual(createBookingOperationResult({
    calendarCreated: true,
    calendarVerified: true,
    databaseInserted: false,
    databaseVerified: false,
    settlementRecorded: false,
  }), { ok: false, code: 'DATABASE_FAILED' });
  assert.deepEqual(createBookingOperationResult({
    calendarCreated: true,
    calendarVerified: false,
    databaseInserted: false,
    databaseVerified: false,
    settlementRecorded: false,
  }), { ok: false, code: 'PROVIDER_VERIFICATION_FAILED' });
  assert.deepEqual(createBookingOperationResult({
    calendarCreated: true,
    calendarVerified: true,
    databaseInserted: true,
    databaseVerified: false,
    settlementRecorded: false,
  }), { ok: false, code: 'DATABASE_VERIFICATION_FAILED' });
  assert.deepEqual(createBookingOperationResult({
    calendarCreated: true,
    calendarVerified: true,
    databaseInserted: true,
    databaseVerified: true,
    settlementRecorded: false,
  }), { ok: false, code: 'IDEMPOTENCY_FAILED' });

  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram']) {
    assert.match(
      server,
      new RegExp(`platformName:\\s*["']${channel}["'][\\s\\S]{0,500}handleUnifiedBookingEngine|handleUnifiedBookingEngine\\([\\s\\S]{0,500}platformName:\\s*["']${channel}["']`),
      `${channel} must route through the unified booking engine`,
    );
  }
  assert.match(server, /inputMode:\s*voice\s*\?\s*["']voice["']\s*:\s*["']text["']/);
  assert.match(server, /if \(voice && !voiceTranscript\)[\s\S]{0,1200}return;/);
  assert.match(server, /awaiting_voice_contact_confirmation/);
  assert.match(server, /const bookingOperationResult\s*=\s*createBookingOperationResult/);
  assert.match(server, /verifiedBookingReplyAuthorizations\[sessionId\]\s*=\s*bookingOperationResult/);
  assert.match(server, /containsUnverifiedBookingSuccessClaim\(raw\)/);
  assert.match(server, /databaseVerified[\s\S]*bookingSettlementRecorded[\s\S]*verifiedBookingReplyAuthorizations/);
  assert.match(server, /NODE_ENV === ["']production["'][\s\S]{0,500}Calendar provider is not configured/);
  assert.match(server, /vad heter du/);
  assert.match(server, /formatLanguageMismatchRecovery/);
  assert.doesNotMatch(server, /formatLocalizedFlowFallback/);
  assert.doesNotMatch(server, /API Error in generateContentWithFallback/);
}

runTests().then(
  () => console.log('AI reliability tests passed'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
