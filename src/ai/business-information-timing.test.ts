import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginBusinessInformationTiming, businessInformationTimingContext, markBusinessInformationTiming,
  timeBusinessInformationDelivery, recordBusinessInformationSendResult, withBusinessInformationTiming,
  runOptionalDiagnostic, INFORMATION_SEND_ATTEMPT_LIMIT, INFORMATION_TIMING_EVENT_LIMIT, clearBusinessInformationTiming } from './business-information-timing';
import { AiReliabilityError, classifyAiFailure } from './reliability';
import { verificationAdmissionDiagnostic, knowledgeDiagnosticFailure } from './knowledge-answer-protocol';

test('incident arithmetic and unchanged six-second admission boundary', () => {
  assert.deepEqual(verificationAdmissionDiagnostic(7204, 1500, 6000, 'before_queue'), {
    checkpoint: 'before_queue', remainingBudgetMs: 7204, publicationReserveMs: 1500,
    verificationAdmissionFloorMs: 6000, effectiveAllowanceMs: 5704, admitted: false,
    rejectionReason: 'INSUFFICIENT_VERIFICATION_ALLOWANCE',
  });
  assert.equal(verificationAdmissionDiagnostic(7500, 1500, 6000, 'after_queue').admitted, true);
  assert.equal(verificationAdmissionDiagnostic(7499, 1500, 6000, 'after_queue').admitted, false);
  assert.equal(verificationAdmissionDiagnostic(9000, 1500, 6000, 'before_queue').effectiveAllowanceMs, 7500);
});

test('diagnostic failure taxonomy separates scheduling, transport, decoding, coverage and sources', () => {
  const kind = (reason: any, rest = {}) => knowledgeDiagnosticFailure({ stage: 'verification', reason, ...rest });
  assert.equal(kind('STAGE_ADMISSION'), 'not_admitted');
  assert.equal(kind('DEADLINE', { transportSuccess: false, failureCategory: 'TIMEOUT' }), 'provider_timeout');
  assert.equal(kind('DEADLINE'), 'deadline');
  assert.equal(kind('MALFORMED_JSON'), 'decoder_failure');
  assert.equal(kind('MATERIAL_FACTS_MISSING'), 'incomplete_coverage');
  assert.equal(kind('SOURCE_REVISION'), 'source_invalidation');
  assert.equal(kind('UNKNOWN'), 'semantic_rejection');
});

test('overlapping turns pin outbound results to their own random IDs, even for the same session', async t => {
  const logs: any[] = [];
  t.mock.method(console, 'info', (label, value) => logs.push({ label, ...(typeof value === 'string' ? JSON.parse(value) : value) }));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let firstId = '', secondId = '';
  const first = withBusinessInformationTiming(async () => {
    firstId = beginBusinessInformationTiming('private-recipient', 'private-message', 3).businessInfoTurnId;
    const result = await timeBusinessInformationDelivery('private-recipient', async () => {
      started(); await barrier; return new Response('{}', { status: 200 });
    });
    assert.equal(businessInformationTimingContext('private-recipient').businessInfoTurnId, firstId);
    recordBusinessInformationSendResult(result, true, 'accepted');
  });
  await entered;
  await withBusinessInformationTiming(async () => {
    secondId = beginBusinessInformationTiming('private-recipient', 'another-private-message', 3).businessInfoTurnId;
    assert.notEqual(firstId, secondId);
    const result = await timeBusinessInformationDelivery('private-recipient', async () => new Response('{}', { status: 403 }));
    recordBusinessInformationSendResult(result, false, 'rejected');
  });
  release(); await first;
  for (const id of [firstId, secondId]) {
    const events = logs.filter(e => e.label === '[BusinessInformationOutbound]' && e.businessInfoTurnId === id);
    assert.deepEqual(events.map(e => e.eventType), ['send_attempt', 'http_response', 'application_result']);
    assert.equal(events.at(-1).applicationAccepted, id === firstId);
    assert.ok(events.every(e => e.customerDelivery === 'unconfirmed'));
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-recipient|private-message|another-private-message/);
  assert.deepEqual(businessInformationTimingContext('private-recipient'), {});
});

test('diagnostics never consume a response or convert transport uncertainty into delivery success', async t => {
  const logs: any[] = [];
  t.mock.method(console, 'info', (label, value) => { if (label === '[BusinessInformationOutbound]') logs.push(JSON.parse(value)); });
  await withBusinessInformationTiming(async () => {
    beginBusinessInformationTiming('session', 'body', 3);
    const response = new Response('{"secret":"do-not-log"}', { status: 200 });
    assert.equal(await timeBusinessInformationDelivery('session', async () => response), response);
    assert.equal(response.bodyUsed, false);
    recordBusinessInformationSendResult(response, true); // Existing HTTP-only acceptance.
    const failure = new Error('secret token sk-private-document-text');
    await assert.rejects(timeBusinessInformationDelivery('session', async () => { throw failure; }), error => error === failure);
    assert.equal(await timeBusinessInformationDelivery('', async () => false), false);
  });
  assert.equal(logs.find(e => e.eventType === 'application_result').providerAcceptance, 'unknown');
  assert.equal(logs.at(-1).eventType, 'transport_exception');
  assert.equal(logs.at(-1).providerAcceptance, 'unknown');
  assert.ok(logs.every(e => e.customerDelivery === 'unconfirmed'));
  assert.doesNotMatch(JSON.stringify(logs), /secret|sk-private|document-text|do-not-log/);
});

test('stage cardinality and outbound event count stay bounded without suppressing terminal send results', async t => {
  const timings: any[] = [], sends: any[] = [];
  t.mock.method(console, 'info', (label, value) => {
    if (label === '[BusinessInformationTiming]') timings.push(value);
    if (label === '[BusinessInformationOutbound]') sends.push(JSON.parse(value));
  });
  await withBusinessInformationTiming(async () => {
    beginBusinessInformationTiming('sk-recipient', 'sensitive-question', 'sk-tenant');
    for (let i = 0; i < 100; i++) {
      markBusinessInformationTiming('sk-recipient', `untrusted-stage-${i}`);
      markBusinessInformationTiming('sk-recipient', 'retrieval_complete', Infinity,
        { language: 'secret-language', disposition: 'document-body', httpStatus: 9000 });
    }
    for (let i = 0; i < 12; i++) {
      const response = await timeBusinessInformationDelivery('sk-recipient', async () => new Response('{}'));
      recordBusinessInformationSendResult(response, true, 'accepted');
      recordBusinessInformationSendResult(response, true, 'accepted');
    }
  });
  assert.equal(timings.length, INFORMATION_TIMING_EVENT_LIMIT);
  assert.equal(sends.length, INFORMATION_SEND_ATTEMPT_LIMIT * 3);
  assert.doesNotMatch(JSON.stringify([...timings, ...sends]), /sk-recipient|sensitive-question|sk-tenant|secret-language|document-body|untrusted-stage/);
  clearBusinessInformationTiming();
});

for (const fault of ['timing', 'send_attempt', 'http_response', 'application_result', 'delivery_complete', 'transport_exception', 'serialization', 'async-sink'] as const)
 test(`p1-isolation/${fault}: telemetry cannot change one send, response identity or original error`, async t => {
  const stringify = JSON.stringify;
  t.mock.method(console, 'info', (label, value) => {
   if (fault === 'async-sink') return Promise.reject(new Error('optional async sink failure'));
   if (label === '[BusinessInformationTiming]' && (fault === 'timing' || fault === 'delivery_complete' && value.stage === 'delivery_complete')) throw new Error('optional sink failure');
   if (label === '[BusinessInformationOutbound]' && typeof value === 'string' && JSON.parse(value).eventType === fault) throw new Error('optional sink failure');
  });
  if (fault === 'serialization') t.mock.method(JSON, 'stringify', (value, ...args) => {
   if (value?.schemaVersion === 'knowledge-outbound-v1') throw new Error('optional serialization failure');
   return stringify(value, ...args);
  });
  await withBusinessInformationTiming(async () => {
   assert.doesNotThrow(() => beginBusinessInformationTiming('session', 'private question', 3));
   let attempts = 0;
   const response = new Response('{}', { status: 200 });
   assert.equal(await timeBusinessInformationDelivery('session', async () => { attempts++; return response; }), response);
   assert.doesNotThrow(() => recordBusinessInformationSendResult(response, true, 'accepted'));
   assert.equal(attempts, 1);
   const original = new AiReliabilityError('TIMEOUT', 'original transport error');
   await assert.rejects(timeBusinessInformationDelivery('session', async () => { attempts++; throw original; }), error => error === original);
   assert.equal(attempts, 2, 'one invocation per requested operation, never a telemetry retry');
   assert.equal(classifyAiFailure(original), 'TIMEOUT');
   assert.equal(await timeBusinessInformationDelivery('session', async () => false), false);
  });
 });

test('p1-isolation/concurrency: failed telemetry in one turn does not replace either owner', async t => {
 let firstId = '', secondId = '';
 const observed: string[] = [];
 t.mock.method(console, 'info', (label, value) => {
  const event = typeof value === 'string' ? JSON.parse(value) : value;
  if (event.businessInfoTurnId === firstId) throw new Error('first turn sink failure');
  observed.push(event.businessInfoTurnId);
 });
 let ready!: () => void, release!: () => void;
 const entered = new Promise<void>(r => { ready = r; }), held = new Promise<void>(r => { release = r; });
 let attempts = 0;
 const first = withBusinessInformationTiming(async () => {
  firstId = beginBusinessInformationTiming('same-session', 'first question', 3).businessInfoTurnId;
  const response = await timeBusinessInformationDelivery('same-session', async () => { attempts++; ready(); await held; return new Response('{}'); });
  recordBusinessInformationSendResult(response, true);
  assert.equal(businessInformationTimingContext('same-session').businessInfoTurnId, firstId);
 });
 await entered;
 try {
  await withBusinessInformationTiming(async () => {
   secondId = beginBusinessInformationTiming('same-session', 'second question', 3).businessInfoTurnId;
   const response = await timeBusinessInformationDelivery('same-session', async () => { attempts++; return new Response('{}'); });
   recordBusinessInformationSendResult(response, true);
   assert.equal(businessInformationTimingContext('same-session').businessInfoTurnId, secondId);
  });
 } finally { release(); }
 await first;
 assert.notEqual(firstId, secondId); assert.equal(attempts, 2); assert.ok(observed.includes(secondId));
});

test('p1-isolation/observers: sync and async telemetry failures are isolated, business work still rejects', async () => {
 assert.doesNotThrow(() => runOptionalDiagnostic(() => { throw new Error('optional callback'); }));
 assert.doesNotThrow(() => runOptionalDiagnostic(async () => { throw new Error('optional async callback'); }));
 await new Promise<void>(resolve => setImmediate(resolve));
 const businessError = new Error('required business failure');
 await assert.rejects(withBusinessInformationTiming(async () => { throw businessError; }), error => error === businessError);
});

test('p1-isolation/metadata: optional result inspection cannot reject a successful transport', async t => {
 t.mock.method(console, 'info', () => {});
 await withBusinessInformationTiming(async () => {
  beginBusinessInformationTiming('session', 'question', 3);
  const response = { get status(): number { throw new Error('optional metadata failure'); } };
  let attempts = 0;
  assert.equal(await timeBusinessInformationDelivery('session', async () => { attempts++; return response; }), response);
  assert.doesNotThrow(() => recordBusinessInformationSendResult(response, true));
  assert.equal(attempts, 1);
 });
});
