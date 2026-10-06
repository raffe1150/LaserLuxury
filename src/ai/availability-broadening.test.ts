import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNormalizedRequestToPending, normalizeBookingRequest, toPersistedBookingRequest } from './booking-intelligence';

const request = (text: string) => normalizeBookingRequest({ businessId: '7', channel: 'shared',
  conversationKey: 'broadening', inputMode: 'text', text, timezone: 'Europe/Stockholm',
  now: new Date('2026-10-06T10:00:00Z') });

const broadeningMessages = [
  ['en', 'Could you check if you have any available times for me tomorrow?'],
  ['sv', 'Vilka lediga tider har ni i morgon?'],
  ['de', 'Welche freien Termine haben Sie morgen?'],
  ['es', '¿Qué horarios disponibles tienen mañana?'],
  ['fa', 'چه وقت های خالی برای فردا دارید؟'],
  ['ar', 'ما هي الأوقات المتاحة غداً؟'],
] as const;

for (const [language, text] of broadeningMessages) {
  test(`${language}: explicit availability broadening uses canonical none and preserves context`, () => {
    const previous = request('Video Consultation tomorrow at 14:00');
    const pending = { service: 'Video Consultation', customerName: 'Ada Test', customerPhone: '0701234567',
      business_id: '7', platform: 'instagram', userId: 'customer', operation: 'new_booking',
      status: 'awaiting_time_selection', normalizedBookingRequest: toPersistedBookingRequest(previous),
      offeredSlots: ['stale'], ownedOfferedSlots: [], lastAvailabilityConstraintKey: 'stale' };
    const latest = request(text);
    assert.equal(latest.timeConstraint?.kind, 'none');
    const transition = applyNormalizedRequestToPending(pending, latest);
    assert.equal(transition.request.date?.value, '2026-10-07');
    assert.equal(transition.request.timeConstraint?.kind, 'none');
    assert.equal(transition.request.service?.normalized, previous.service?.normalized);
    assert.equal(transition.runAvailability, true);
    assert.deepEqual(pending.offeredSlots, []);
    assert.equal(pending.lastAvailabilityConstraintKey, null);
    assert.equal(pending.customerName, 'Ada Test');
    assert.equal(pending.customerPhone, '0701234567');
    assert.equal(pending.service, 'Video Consultation');
    assert.equal(pending.operation, 'new_booking');
    assert.equal(pending.business_id, '7');
    assert.equal(pending.userId, 'customer');
  });
}

for (const text of ['any time', 'anytime', 'whenever', 'any slot', 'what times do you have',
  'any available times tomorrow', 'any time tomorrow', 'not 14:00, any time tomorrow']) {
  test(`unrestricted request: ${text}`, () => assert.equal(request(text).timeConstraint?.kind, 'none'));
}

for (const [text, kind] of [
  ['any time after 15:00', 'after'], ['any time before 15:00', 'before'],
  ['any time tomorrow afternoon', 'afternoon'], ['any time between 15:00 and 17:00', 'between'],
  ['How about 14:00 tomorrow?', 'exact'],
  ['Vilken tid som helst i morgon efter 15:00', 'after'],
  ['Jederzeit morgen nach 15:00', 'after'],
  ['Cualquier hora mañana después de las 15:00', 'after'],
  ['هر وقتی فردا بعد از ساعت 15:00', 'after'],
  ['أي وقت غداً بعد الساعة 15:00', 'after'],
  ['Vilken tid som helst i morgon eftermiddag', 'afternoon'],
  ['Jederzeit morgen Nachmittag', 'afternoon'],
  ['Cualquier hora mañana por la tarde', 'afternoon'],
  ['هر وقتی فردا بعدازظهر', 'afternoon'],
  ['أي وقت غداً بعد الظهر', 'afternoon'],
] as const) {
  test(`explicit narrower constraint wins: ${text}`, () => assert.equal(request(text).timeConstraint?.kind, kind));
}

for (const text of ['Please check again.', 'tomorrow?', 'Is that available?', 'Thanks for your help.',
  'Can I contact you any time tomorrow?', 'Is parking available all day?',
  'I cannot do any time tomorrow.', 'Not any time tomorrow.', 'I am not available all day tomorrow.']) {
  test(`ambiguous or negated follow-up does not clear: ${text}`, () => {
    const previous = request('tomorrow at 14:00');
    const pending = { status: 'awaiting_time_selection', normalizedBookingRequest: toPersistedBookingRequest(previous),
      ownedOfferedSlots: [], offeredSlots: [], lastAvailabilityConstraintKey: 'same' };
    const transition = applyNormalizedRequestToPending(pending, request(text));
    assert.equal(transition.request.timeConstraint?.kind, 'exact');
    assert.equal(transition.request.timeConstraint?.startMinutes, 840);
    assert.equal(transition.invalidatesOffers, false);
  });
}
