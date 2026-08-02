import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyNormalizedRequestToPending,
  availabilityFieldsFromConstraint,
  buildSlotFingerprintSource,
  detectNormalizedIntent,
  formatPersianSpokenPhone,
  getZonedSlotParts,
  formatPersianSpokenTime,
  mergeNormalizedBookingRequest,
  normalizeBookingRequest,
  normalizeTranscribedText,
  parseBookingDate,
  parseTimeConstraint,
  preparePersianTextForTts,
  slotMinutesSatisfyConstraint,
  toPersistedBookingRequest,
  zonedLocalIso,
} from './booking-intelligence';

const now = new Date('2026-08-02T12:00:00Z');
const request = (text: string, inputMode: 'text' | 'voice' = 'text') => normalizeBookingRequest({
  businessId: 1,
  channel: 'test',
  conversationKey: 'test',
  inputMode,
  text,
  timezone: 'Europe/Stockholm',
  now,
});

const finglish = request('mitoni ye vaght moshavereh bedi be man baraye jomeh ghabl az sate 12');
assert.equal(finglish.intent, 'new_booking');
assert.equal(finglish.language, 'fa');
assert.equal(finglish.service?.normalized, 'Konsultation');
assert.equal(finglish.date?.weekday, 5);
assert.deepEqual(finglish.timeConstraint, { kind: 'before', endMinutes: 720, endInclusive: false, confidence: 'high' });

assert.equal(detectNormalizedIntent('baraye jomeh bad az sate 18 vaght mikham'), 'new_booking');
assert.equal(detectNormalizedIntent('kare shoma chie'), 'general_question');
assert.equal(detectNormalizedIntent('chera zabaneto avaz mikoni'), 'general_question');

assert.deepEqual(parseTimeConstraint('برای جمعه ساعت ۱۸ وقت می‌خوام'), { kind: 'exact', startMinutes: 1080, startInclusive: true, endInclusive: true, confidence: 'high' });
assert.deepEqual(parseTimeConstraint('برای جمعه بعد از ساعت ۱۸ وقت می‌خوام'), { kind: 'after', startMinutes: 1080, startInclusive: false, endInclusive: false, confidence: 'high' });
assert.deepEqual(parseTimeConstraint('قبل از ساعت ۱۲'), { kind: 'before', endMinutes: 720, endInclusive: false, confidence: 'high' });
const correction = request('نه، منظورم بعد از ۱۸ بود');
assert.equal(correction.customerCorrection?.replacesTime, true);
assert.equal(correction.timeConstraint?.kind, 'after');

assert.equal(request('Jag vill boka på fredag efter klockan 18').intent, 'new_booking');
assert.equal(request('Jag menade före klockan 12').timeConstraint?.kind, 'before');
assert.deepEqual(parseTimeConstraint('Har ni något mellan 16 och 18?'), { kind: 'between', startMinutes: 960, endMinutes: 1080, startInclusive: true, endInclusive: true, confidence: 'high' });
assert.equal(detectNormalizedIntent('Vad kostar laserbehandling?'), 'general_question');

assert.equal(parseTimeConstraint('Friday after 6 pm')?.startMinutes, 1080);
assert.equal(parseTimeConstraint('before noon')?.endMinutes, 720);
assert.equal(parseTimeConstraint('between 16 and 18')?.kind, 'between');
assert.deepEqual(parseTimeConstraint('13:00'), { kind: 'exact', startMinutes: 780, startInclusive: true, endInclusive: true, confidence: 'high' });

const after = parseTimeConstraint('after 18')!;
assert.equal(slotMinutesSatisfyConstraint(1080, after), false);
assert.equal(slotMinutesSatisfyConstraint(1095, after), true);
const before = parseTimeConstraint('before 12')!;
assert.equal(slotMinutesSatisfyConstraint(720, before), false);
assert.equal(slotMinutesSatisfyConstraint(705, before), true);
const exact = parseTimeConstraint('at 18')!;
assert.equal(slotMinutesSatisfyConstraint(1065, exact), false);
assert.equal(slotMinutesSatisfyConstraint(1080, exact), true);
assert.equal(slotMinutesSatisfyConstraint(1095, exact), false);
const from = parseTimeConstraint('from 16')!;
assert.equal(slotMinutesSatisfyConstraint(960, from), true);

assert.equal(normalizeTranscribedText('جمعه ساعت هجده'), 'جمعه ساعت 18');
assert.equal(parseTimeConstraint(normalizeTranscribedText('جمعه ساعت شش عصر'))?.startMinutes, 1080);
assert.equal(request('جمعه ساعت هجده', 'voice').timeConstraint?.startMinutes, request('جمعه ساعت ۱۸', 'text').timeConstraint?.startMinutes);
assert.equal(request('ساعت [unclear]', 'voice').requiresClarification, true);

assert.equal(formatPersianSpokenTime(14 * 60), 'ساعت دو بعدازظهر');
assert.equal(formatPersianSpokenTime(14 * 60 + 15), 'ساعت دو و ربع بعدازظهر');
assert.equal(formatPersianSpokenTime(18 * 60 + 30), 'ساعت شش و نیم عصر');
assert.equal(preparePersianTextForTts('ساعت ساعت 14:00'), 'ساعت دو بعدازظهر');
assert.doesNotMatch(preparePersianTextForTts('زمان 14:00 است'), /چهارده و دو صفر|ساعت ساعت/u);
assert.notEqual(formatPersianSpokenPhone('070'), formatPersianSpokenTime(70));

assert.equal(parseBookingDate('Friday', 'Europe/Stockholm', now)?.value, '2026-08-07');
assert.equal(parseBookingDate('next Friday', 'Europe/Stockholm', now)?.value, '2026-08-14');
assert.equal(parseBookingDate('tomorrow', 'Europe/Stockholm', new Date('2026-12-31T12:00:00Z'))?.value, '2027-01-01');
assert.equal(parseBookingDate('tomorrow', 'Europe/Stockholm', new Date('2026-08-31T12:00:00Z'))?.value, '2026-09-01');
assert.equal(parseBookingDate('tomorrow', 'Europe/Stockholm', new Date('2026-03-28T23:30:00Z'))?.value, '2026-03-30');
assert.equal(parseBookingDate('this Friday', 'Europe/Stockholm', new Date('2026-08-07T08:00:00Z'))?.value, '2026-08-07');
assert.equal(parseBookingDate('Friday', 'Europe/Stockholm', new Date('2026-08-07T08:00:00Z'))?.value, '2026-08-14');
assert.equal(parseBookingDate('2026-07-01', 'Europe/Stockholm', now), undefined);
assert.equal(parseBookingDate('7:e augusti', 'Europe/Stockholm', now)?.value, '2026-08-07');
assert.equal(parseBookingDate('۷ اوت', 'Europe/Stockholm', now)?.value, '2026-08-07');

const first = request('Friday before 12');
const changedTime = mergeNormalizedBookingRequest(first, request('No, after 18'));
assert.equal(changedTime.request.date?.value, first.date?.value);
assert.equal(changedTime.request.timeConstraint?.kind, 'after');
assert.equal(changedTime.invalidatesOffers, true);
const changedDate = mergeNormalizedBookingRequest(request('Friday at 18'), request('Saturday instead'));
assert.equal(changedDate.request.timeConstraint?.startMinutes, 1080);
assert.equal(changedDate.request.date?.weekday, 6);

const unchanged = mergeNormalizedBookingRequest(first, request('Friday before 12'));
assert.equal(unchanged.invalidatesOffers, false);
const unchangedPending: any = { normalizedBookingRequest: toPersistedBookingRequest(first), offeredSlots: ['old'], ownedOfferedSlots: ['owned'], dateTime: 'old', lastAvailabilityConstraintKey: 'same' };
applyNormalizedRequestToPending(unchangedPending, request('Friday before 12'));
assert.deepEqual(unchangedPending.offeredSlots, ['old']);
const changedPending: any = { ...unchangedPending, normalizedBookingRequest: toPersistedBookingRequest(first) };
applyNormalizedRequestToPending(changedPending, request('No, after 18'));
assert.deepEqual(changedPending.offeredSlots, []);
assert.equal(changedPending.dateTime, null);
assert.equal(changedPending.lastAvailabilityConstraintKey, null);
assert.equal(availabilityFieldsFromConstraint(changedPending.normalizedBookingRequest.timeConstraint).timeBoundary.time, '18:00');
const fingerprintBase = { businessId: '1', service: 'Konsultation', date: '2026-08-07', timezone: 'Europe/Stockholm', durationMinutes: 30 };
const beforeFingerprint = buildSlotFingerprintSource({ ...fingerprintBase, constraint: before });
assert.equal(beforeFingerprint, buildSlotFingerprintSource({ ...fingerprintBase, constraint: before }));
assert.notEqual(beforeFingerprint, buildSlotFingerprintSource({ ...fingerprintBase, constraint: after }));
assert.notEqual(beforeFingerprint, buildSlotFingerprintSource({ ...fingerprintBase, date: '2026-08-08', constraint: before }));

assert.deepEqual(getZonedSlotParts('2026-08-07T18:00:00Z', 'UTC'), { date: '2026-08-07', minutes: 1080 });
assert.deepEqual(getZonedSlotParts('2026-08-07T18:00:00Z', 'Europe/Stockholm'), { date: '2026-08-07', minutes: 1200 });
assert.deepEqual(getZonedSlotParts('2026-08-07T18:00:00Z', 'America/New_York'), { date: '2026-08-07', minutes: 840 });
assert.equal(getZonedSlotParts('2026-03-08T06:30:00Z', 'America/New_York')?.minutes, 90);
assert.equal(getZonedSlotParts('2026-03-08T07:30:00Z', 'America/New_York')?.minutes, 210);
assert.match(zonedLocalIso('2026-08-07', '18:00:00', 'Europe/Stockholm'), /\+02:00$/);
assert.match(zonedLocalIso('2026-08-07', '18:00:00', 'UTC'), /\+00:00$/);
assert.match(zonedLocalIso('2026-08-07', '18:00:00', 'America\/New_York'), /-04:00$/);

const textState = toPersistedBookingRequest(request('برای جمعه بعد از ساعت ۱۸ وقت می‌خوام', 'text'));
const voiceState = toPersistedBookingRequest(request('برای جمعه بعد از ساعت هجده وقت می‌خوام', 'voice'));
assert.deepEqual(voiceState, textState);

const server = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const intelligence = fs.readFileSync(new URL('./booking-intelligence.ts', import.meta.url), 'utf8');
const stateMachine = fs.readFileSync(new URL('./booking-state-machine.ts', import.meta.url), 'utf8');
assert.match(stateMachine, /offeredSlots: \[\][\s\S]{0,200}lastAvailabilityConstraintKey: null/);
assert.match(server, /slotMinutesSatisfyConstraint\(zoned\.minutes, params\.normalizedConstraint\)/);
assert.match(server, /if \(!slotsText\) return l\.busyNone\(normalizedSpecificTime\)/);
assert.match(server, /if \(!slotsText\) return l\.none/);
assert.match(server, /verifiedBookingReplyAuthorizations\[sessionId\] = bookingOperationResult/);
assert.doesNotMatch(server, /function decideConversation|export function decideConversation/);

console.log('booking intelligence tests passed');
