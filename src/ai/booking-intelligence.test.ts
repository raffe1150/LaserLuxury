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
  isReadOnlyAvailabilityInquiry,
  mergeNormalizedBookingRequest,
  normalizeBookingRequest,
  normalizeTranscribedText,
  parseBookingDate,
  parseNamedBookingDateRange,
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
assert.deepEqual(parseTimeConstraint('senare än klockan 15'), { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
assert.deepEqual(parseTimeConstraint('later than 15'), { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
assert.deepEqual(parseTimeConstraint('från klockan 15'), { kind: 'from', startMinutes: 900, startInclusive: true, endInclusive: false, confidence: 'high' });
const germanLocalizedDate = request('Haben Sie am Donnerstag, den 17. September 2026, einen Termin später als 15 Uhr?');
assert.equal(germanLocalizedDate.intent, 'new_booking');
assert.equal(germanLocalizedDate.language, 'de');
assert.equal(germanLocalizedDate.date?.value, '2026-09-17');
assert.deepEqual(germanLocalizedDate.timeConstraint, { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
const persianLocalizedDate = request('در تاریخ چهارشنبه ۲۳ سپتامبر ۲۰۲۶ بعد از ساعت ۱۵ وقت خالی دارید؟');
assert.equal(persianLocalizedDate.intent, 'new_booking');
assert.equal(persianLocalizedDate.language, 'fa');
assert.equal(persianLocalizedDate.normalizedText.includes('23 سپتامبر 2026'), true);
assert.equal(persianLocalizedDate.date?.value, '2026-09-23');
assert.deepEqual(persianLocalizedDate.timeConstraint, { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
const exactArabicAvailability = request('هل لديكم موعد متاح بعد الساعة 15 يوم الجمعة 25 سبتمبر 2026؟');
assert.equal(exactArabicAvailability.intent, 'new_booking');
assert.equal(exactArabicAvailability.language, 'ar');
assert.equal(exactArabicAvailability.date?.value, '2026-09-25');
assert.equal(exactArabicAvailability.date?.weekday, undefined);
assert.deepEqual(exactArabicAvailability.timeConstraint, { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
assert.equal(slotMinutesSatisfyConstraint(900, exactArabicAvailability.timeConstraint), false);
assert.equal(slotMinutesSatisfyConstraint(915, exactArabicAvailability.timeConstraint), true);
const exactArabicEveningAvailability = request('هل لديكم مواعيد متاحة مساء يوم الأربعاء ٣٠ سبتمبر ٢٠٢٦؟');
assert.equal(exactArabicEveningAvailability.language, 'ar');
assert.equal(exactArabicEveningAvailability.intent, 'new_booking');
assert.equal(exactArabicEveningAvailability.date?.value, '2026-09-30');
assert.deepEqual(exactArabicEveningAvailability.timeConstraint, { kind: 'evening', startMinutes: 1020, endMinutes: 1260, startInclusive: true, endInclusive: false, confidence: 'high' });
assert.equal(request('هل لدي حجز قادم؟').intent, 'booking_lookup');
const exactSpanishAvailability = request('¿Tienen alguna cita después de las 15:00 el viernes 18 de septiembre de 2026?');
assert.equal(exactSpanishAvailability.intent, 'new_booking');
assert.equal(exactSpanishAvailability.language, 'es');
assert.equal(exactSpanishAvailability.date?.value, '2026-09-18');
assert.equal(exactSpanishAvailability.date?.kind, 'exact_date');
assert.deepEqual(exactSpanishAvailability.timeConstraint, { kind: 'after', startMinutes: 900, startInclusive: false, endInclusive: false, confidence: 'high' });
assert.equal(slotMinutesSatisfyConstraint(900, exactSpanishAvailability.timeConstraint), false);
assert.equal(slotMinutesSatisfyConstraint(915, exactSpanishAvailability.timeConstraint), true);
const exactAvailabilityInquiry = request('Är klockan 11 ledig fredagen den 23 oktober 2026?');
assert.equal(exactAvailabilityInquiry.timeConstraint?.kind, 'exact');
assert.equal(exactAvailabilityInquiry.timeConstraint?.startMinutes, 660);
assert.equal(exactAvailabilityInquiry.date?.value, '2026-10-23');
assert.equal(isReadOnlyAvailabilityInquiry(exactAvailabilityInquiry.normalizedText), true);
assert.equal(isReadOnlyAvailabilityInquiry('Boka fredagen den 23 oktober 2026 klockan 11'), false);
assert.equal(request('på morgonen tisdagen den 25 augusti 2026').timeConstraint?.kind, 'morning');
const exactAfternoonAvailability = request('Har ni någon ledig tid på eftermiddagen måndagen den 31 augusti 2026?');
assert.equal(exactAfternoonAvailability.date?.value, '2026-08-31');
assert.deepEqual(exactAfternoonAvailability.timeConstraint, { kind: 'afternoon', startMinutes: 720, endMinutes: 1020, startInclusive: true, endInclusive: false, confidence: 'high' });
assert.equal(slotMinutesSatisfyConstraint(720, exactAfternoonAvailability.timeConstraint), true);
assert.equal(slotMinutesSatisfyConstraint(1019, exactAfternoonAvailability.timeConstraint), true);
assert.equal(slotMinutesSatisfyConstraint(1020, exactAfternoonAvailability.timeConstraint), false);
const exactEveningAvailability = request('Har ni någon ledig tid på kvällen onsdagen den 2 september 2026?');
assert.equal(exactEveningAvailability.date?.value, '2026-09-02');
assert.deepEqual(exactEveningAvailability.timeConstraint, { kind: 'evening', startMinutes: 1020, endMinutes: 1260, startInclusive: true, endInclusive: false, confidence: 'high' });
assert.equal(slotMinutesSatisfyConstraint(1020, exactEveningAvailability.timeConstraint), true);
assert.equal(slotMinutesSatisfyConstraint(1259, exactEveningAvailability.timeConstraint), true);
assert.equal(slotMinutesSatisfyConstraint(1260, exactEveningAvailability.timeConstraint), false);

for (const [previousText, latestText, expectedKind, expectedStart, expectedEnd] of [
  ['Friday after 15', 'Friday before 11', 'before', undefined, 660],
  ['Friday morning', 'Friday afternoon', 'afternoon', 720, 1020],
  ['Friday afternoon', 'Friday evening', 'evening', 1020, 1260],
  ['Friday afternoon', 'Friday at 14:00', 'exact', 840, undefined],
] as const) {
  const replaced = mergeNormalizedBookingRequest(request(previousText), request(latestText));
  assert.equal(replaced.request.timeConstraint?.kind, expectedKind);
  assert.equal(replaced.request.timeConstraint?.startMinutes, expectedStart);
  assert.equal(replaced.request.timeConstraint?.endMinutes, expectedEnd);
  assert.equal(replaced.replaced.time, true);
}
assert.deepEqual(parseTimeConstraint('Har ni något mellan 16 och 18?'), { kind: 'between', startMinutes: 960, endMinutes: 1080, startInclusive: true, endInclusive: true, confidence: 'high' });
assert.equal(detectNormalizedIntent('Vad kostar laserbehandling?'), 'general_question');


// Service-selection guidance must remain informational across all supported
// customer languages and must not accidentally start availability discovery.
const serviceGuidanceCases = [
  ['en', "I don't know which service is right for me"],
  ['sv', 'Jag vet inte vilken tjänst som passar mig bäst'],
  ['fa', 'نمی‌دونم کدوم سرویس برای من مناسبه'],
  ['de', 'Ich weiß nicht, welche Behandlung für mich geeignet ist'],
  ['es', 'No sé qué tratamiento es mejor para mí'],
  ['ar', 'لا أعرف أي علاج مناسب لي'],
] as const;

for (const [language, message] of serviceGuidanceCases) {
  assert.equal(
    detectNormalizedIntent(message),
    'general_question',
    `${language}: service guidance must not start booking`
  );
}

// Guidance wording may contain booking language without becoming a booking.
assert.equal(
  detectNormalizedIntent('I need help choosing which service to book'),
  'general_question'
);
assert.equal(
  detectNormalizedIntent('Kan ni hjälpa mig välja rätt behandling innan jag bokar?'),
  'general_question'
);
assert.equal(
  detectNormalizedIntent('Jag behöver boka en tid, men jag vet inte vilken tjänst som passar.'),
  'general_question'
);
assert.equal(
  detectNormalizedIntent('Jag vet inte riktigt vilken typ av tjänst jag ska boka. Kan du hjälpa mig att förstå vad som passar för mitt behov?'),
  'general_question'
);

// Real booking requests must keep their existing behavior.
assert.equal(
  detectNormalizedIntent('I want to book a consultation on Friday'),
  'new_booking'
);
assert.equal(
  detectNormalizedIntent('Jag vill boka konsultation på fredag'),
  'new_booking'
);
assert.equal(
  detectNormalizedIntent('برای جمعه وقت مشاوره می‌خوام'),
  'new_booking'
);

assert.equal(parseTimeConstraint('Friday after 6 pm')?.startMinutes, 1080);
assert.equal(parseTimeConstraint('before noon')?.endMinutes, 720);
assert.equal(parseTimeConstraint('between 16 and 18')?.kind, 'between');
assert.deepEqual(parseTimeConstraint('13:00'), { kind: 'exact', startMinutes: 780, startInclusive: true, endInclusive: true, confidence: 'high' });
assert.equal(parseTimeConstraint("I'll take the 11:00 slot, please")?.startMinutes, 660);
assert.equal(parseTimeConstraint('11:30 passar mig utmärkt')?.startMinutes, 690);
assert.equal(parseTimeConstraint('Kl 10:30 passar mig perfekt')?.startMinutes, 630);
assert.equal(parseTimeConstraint('Jag väljer tiden 11:00')?.startMinutes, 660);
assert.equal(parseTimeConstraint('ساعت 11:00 را می‌خواهم')?.startMinutes, 660);
assert.equal(parseTimeConstraint('My phone number is 0701234567'), undefined);

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
const fridayBefore2030 = new Date('2026-08-20T23:00:00Z'); // 01:00 Friday in Stockholm
const fridayAfter2030 = new Date('2026-08-21T19:00:00Z'); // 21:00 Friday in Stockholm
assert.equal(parseBookingDate('Friday at 20:30', 'Europe/Stockholm', fridayBefore2030)?.value, '2026-08-21');
assert.equal(parseBookingDate('Friday at 20:30', 'Europe/Stockholm', fridayAfter2030)?.value, '2026-08-28');
assert.equal(parseBookingDate('next Friday at 20:30', 'Europe/Stockholm', fridayBefore2030)?.value, '2026-08-28');
assert.equal(parseBookingDate('this Friday at 20:30', 'Europe/Stockholm', fridayBefore2030)?.value, '2026-08-21');
assert.equal(parseBookingDate('Friday at 20:30', 'Europe/Stockholm', now)?.value, '2026-08-07');
assert.equal(parseBookingDate('2026-07-01', 'Europe/Stockholm', now), undefined);
assert.equal(parseBookingDate('7:e augusti', 'Europe/Stockholm', now)?.value, '2026-08-07');
assert.equal(parseBookingDate('۷ اوت', 'Europe/Stockholm', now)?.value, '2026-08-07');
assert.equal(parseBookingDate('August 17', 'Europe/Stockholm', now)?.value, '2026-08-17');
assert.equal(parseBookingDate('August 17, 2026', 'Europe/Stockholm', now)?.value, '2026-08-17');

const englishMonthFirstAvailability = request('Do you have any time August 17 or later?');
assert.equal(englishMonthFirstAvailability.intent, 'new_booking');
assert.equal(englishMonthFirstAvailability.date?.value, '2026-08-17');

const englishDayFirstAvailability = request('Do you have any time 17 August or later?');
assert.equal(englishDayFirstAvailability.intent, 'new_booking');
assert.equal(englishDayFirstAvailability.date?.value, '2026-08-17');

const liveDateConflict = request('Hej, jag vill boka en tid fredag den 10 september 2026 klockan 09:00.');
assert.equal(liveDateConflict.requiresClarification, true);
assert.equal(liveDateConflict.clarificationReason, 'weekday_explicit_date_conflict');
assert.equal(liveDateConflict.date, undefined, 'neither conflicting date may become authoritative');
assert.deepEqual(liveDateConflict.dateConflict, {
  kind: 'weekday_explicit_date_conflict',
  explicitDate: '2026-09-10',
  weekdayDate: '2026-09-11',
  requestedWeekday: 5,
});
assert.equal(liveDateConflict.timeConstraint?.startMinutes, 9 * 60);
assert.equal(
  parseBookingDate(
    'Hej, jag vill boka en tid tisdag den 21 september 2026 klockan 09:00.',
    'Europe/Stockholm',
    now,
  ),
  undefined,
  'the shared date parser must not resurrect the explicit date after conflict detection',
);
const secondLiveDateConflict = request('Hej, jag vill boka en tid tisdag den 21 september 2026 klockan 09:00.');
assert.deepEqual(secondLiveDateConflict.dateConflict, {
  kind: 'weekday_explicit_date_conflict',
  explicitDate: '2026-09-21',
  weekdayDate: '2026-09-22',
  requestedWeekday: 2,
});
assert.equal(secondLiveDateConflict.date, undefined);

for (const validText of [
  'Hej, jag vill boka en tid torsdag den 10 september 2026 klockan 09:00.',
  'Hej, jag vill boka en tid fredag den 11 september 2026 klockan 09:00.',
  'Hej, jag vill boka en tid den 10 september 2026 klockan 09:00.',
  'Hej, jag vill boka en tid fredag klockan 09:00.',
]) {
  const valid = request(validText);
  assert.equal(valid.requiresClarification, false, validText);
  assert.equal(valid.dateConflict, undefined, validText);
  assert.ok(valid.date?.value, validText);
}

const englishDateConflict = request('I want to book Friday 10 September 2026 at 09:00');
assert.equal(englishDateConflict.requiresClarification, true);
assert.deepEqual(englishDateConflict.dateConflict, {
  kind: 'weekday_explicit_date_conflict',
  explicitDate: '2026-09-10',
  weekdayDate: '2026-09-11',
  requestedWeekday: 5,
});

const pendingBeforeDateConflict: any = {
  normalizedBookingRequest: toPersistedBookingRequest(request('Friday at 10:00')),
  offeredSlots: ['owned-offer'],
  ownedOfferedSlots: [{ start: 'owned-offer' }],
  dateTime: 'owned-offer',
  selectedSlotEnd: 'owned-end',
  lastAvailabilityConstraintKey: 'owned-fingerprint',
};
const pendingBeforeDateConflictSnapshot = structuredClone(pendingBeforeDateConflict);
const conflictTransition = applyNormalizedRequestToPending(pendingBeforeDateConflict, liveDateConflict);
assert.equal(conflictTransition.replyKind, 'booking_clarification');
assert.equal(conflictTransition.runAvailability, false);
assert.deepEqual(pendingBeforeDateConflict, pendingBeforeDateConflictSnapshot,
  'an unresolved date conflict must not mutate pending state');

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

const rangeNow = new Date('2026-08-14T10:00:00Z');
for (const [text, expected] of [
  ['mellan 15 och 21 augusti', { startDate: '2026-08-15', endDate: '2026-08-21' }],
  ['between 15 and 21 August', { startDate: '2026-08-15', endDate: '2026-08-21' }],
  ['zwischen 15 und 21 August', { startDate: '2026-08-15', endDate: '2026-08-21' }],
  ['entre 15 y 21 agosto', { startDate: '2026-08-15', endDate: '2026-08-21' }],
] as const) {
  assert.deepEqual(parseNamedBookingDateRange(text, 'Europe/Stockholm', rangeNow), expected);
  assert.equal(parseTimeConstraint(text), undefined, `${text} must not become a clock window`);
}
assert.equal(parseTimeConstraint('mellan klockan 15 och 18')?.kind, 'between');
const normalizedNamedRange = normalizeBookingRequest({
  businessId: '1',
  channel: 'telegram',
  conversationKey: 'named-range-replacement',
  inputMode: 'text',
  text: 'Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti?',
  timezone: 'Europe/Stockholm',
  now: rangeNow,
});
assert.deepEqual(normalizedNamedRange.date, {
  kind: 'date_range',
  value: '2026-08-15',
  endValue: '2026-08-21',
  confidence: 'high',
});
assert.equal(normalizedNamedRange.timeConstraint?.kind, 'none');

const textState = toPersistedBookingRequest(request('برای جمعه بعد از ساعت ۱۸ وقت می‌خوام', 'text'));
const voiceState = toPersistedBookingRequest(request('برای جمعه بعد از ساعت هجده وقت می‌خوام', 'voice'));
assert.deepEqual(voiceState, textState);

const server = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const intelligence = fs.readFileSync(new URL('./booking-intelligence.ts', import.meta.url), 'utf8');
const stateMachine = fs.readFileSync(new URL('./booking-state-machine.ts', import.meta.url), 'utf8');
assert.match(stateMachine, /offeredSlots: \[\][\s\S]{0,200}lastAvailabilityConstraintKey: null/);
assert.match(server, /slotMinutesSatisfyConstraint\(minutes, params\.normalizedConstraint\)/);
assert.match(server, /if \(!slotsText\) return renderDeterministicAvailabilityReply\(lang, \{ kind: "busy_none"/);
assert.match(server, /if \(!slotsText\) return renderDeterministicAvailabilityReply\(lang, \{ kind: "none" \}/);
assert.match(server, /verifiedBookingReplyAuthorizations\[sessionId\] = bookingOperationResult/);
assert.doesNotMatch(server, /function decideConversation|export function decideConversation/);


const laterThanAt = parseTimeConstraint('do you have any time later than at 13:00?');
assert.equal(laterThanAt?.kind, 'after');
assert.equal(laterThanAt?.startMinutes, 13 * 60);
assert.equal(laterThanAt?.startInclusive, false);

const afterAt = parseTimeConstraint('do you have anything after at 13:00?');
assert.equal(afterAt?.kind, 'after');
assert.equal(afterAt?.startMinutes, 13 * 60);
assert.equal(afterAt?.startInclusive, false);

const plainExactAt = parseTimeConstraint('at 13:00');
assert.equal(plainExactAt?.kind, 'exact');
assert.equal(plainExactAt?.startMinutes, 13 * 60);

// Regression: an explicit English date plus a clock boundary must keep
// the date on that day and treat "after 15:00" as a time constraint.
const englishExplicitDateAfterTime = request(
  'Do you have any available time after 15:00 on August 20?'
);
assert.equal(englishExplicitDateAfterTime.date?.kind, 'exact_date');
assert.equal(englishExplicitDateAfterTime.date?.value, '2026-08-20');
assert.equal(englishExplicitDateAfterTime.timeConstraint?.kind, 'after');
assert.equal(englishExplicitDateAfterTime.timeConstraint?.startMinutes, 15 * 60);
assert.equal(englishExplicitDateAfterTime.timeConstraint?.startInclusive, false);


const multilingualAfterCases = [
  ['sv', 'senare än 13:45'],
  ['sv', 'efter kl 13:45'],
  ['fa', 'bad az saat 13:45'],
  ['fa', 'بعد از ساعت 13:45'],
  ['de', 'später als 13:45'],
  ['es', 'después de las 13:45'],
  ['ar', 'بعد الساعة 13:45'],
] as const;

for (const [language, text] of multilingualAfterCases) {
  const parsed = parseTimeConstraint(text);

  assert.equal(
    parsed?.kind,
    'after',
    `${language}: ${text} should parse as after`
  );

  assert.equal(
    parsed?.startMinutes,
    13 * 60 + 45,
    `${language}: ${text} should resolve to 13:45`
  );

  assert.equal(
    parsed?.startInclusive,
    false,
    `${language}: ${text} should be exclusive`
  );
}

console.log('booking intelligence tests passed');
