import assert from 'node:assert/strict';
import { normalizeBookingRequest, toPersistedBookingRequest } from './booking-intelligence';
import {
  applyBookingTransition,
  getBookingPhase,
  isPositiveBookingConfirmation,
} from './booking-state-machine';

const now = new Date('2026-08-12T12:00:00Z');
const selectedSlot = {
  start: '2026-08-14T14:00:00+02:00',
  end: '2026-08-14T12:30:00.000Z',
};

const request = (text: string) => normalizeBookingRequest({
  businessId: 1,
  channel: 'shared',
  conversationKey: 'multilingual-confirmation',
  inputMode: 'text',
  text,
  timezone: 'Europe/Stockholm',
  now,
});

function pendingConfirmation() {
  return {
    status: 'awaiting_slot_confirmation',
    service: 'Konsultation',
    normalizedBookingRequest: toPersistedBookingRequest(request('Friday at 14 consultation')),
    offeredSlots: [selectedSlot.start],
    ownedOfferedSlots: [{ ...selectedSlot }],
    dateTime: selectedSlot.start,
    selectedSlotEnd: selectedSlot.end,
    lastAvailabilityConstraintKey: 'authoritative-snapshot',
    operationIdentity: 'operation-1',
  };
}

const positiveByLanguage: Record<string, string[]> = {
  Persian: [
    'بله',
    'بله، لطفاً آن را برای من رزرو کنید.',
    'بله، لطفاً برای همان ساعت رزرو کنید.',
    'بله برای همان ساعت رزرو کنید',
    'بله همون ساعت رو رزرو کنید',
    'بله، لطفاً برای همین زمان رزرو کنید.',
    'باشه همون وقت رو رزرو کن',
    'آره لطفاً همون ساعت',
    'همان وقت را رزرو کنید',
  ],
  Finglish: [
    'bale',
    'bale lotfan hamoon saat ro rezerv kon',
    'are hamon vaght ro rezerv kon',
    'bashe hamoon saat',
  ],
  English: [
    'Yes',
    'Yes, please book it for me.',
    'Please confirm it for me.',
    'Yes, please. What information do you need from me to finalize the booking?',
    'Yes, please book that time.',
    'Yes, book the same time.',
    'Yes, please confirm that appointment.',
    'Yes, that time works. Please book it.',
    'Please book that slot.',
  ],
  Swedish: [
    'Ja',
    'Ja tack, boka den åt mig.',
    'Ja, tack! Det vore jättebra.',
    'Ja tack, boka den tiden.',
    'Ja, boka samma tid.',
    'Ja gärna, boka den.',
    'Den tiden passar, boka den gärna.',
  ],
  German: [
    'Ja',
    'Ja, bitte buchen Sie diese Zeit.',
    'Ja, buchen Sie diesen Termin.',
    'Ja, der Termin passt. Bitte buchen.',
  ],
  Spanish: [
    'Sí',
    'Sí, por favor reserva esa hora.',
    'Sí, reserva esa cita.',
    'Sí, esa hora está bien. Resérvala.',
  ],
  Arabic: [
    'نعم',
    'نعم، احجز ذلك الموعد من فضلك.',
    'نعم، احجز نفس الموعد.',
    'نعم، هذا الموعد مناسب، احجزه.',
  ],
};

for (const [language, messages] of Object.entries(positiveByLanguage)) {
  for (const message of messages) {
    assert.equal(isPositiveBookingConfirmation(message), true, `${language}: ${message}`);
    const pending = pendingConfirmation();
    const transition = applyBookingTransition(pending, request(message));
    assert.equal(transition.reason, 'slot_confirmation_accepted', `${language}: ${message}`);
    assert.equal(getBookingPhase(pending), 'awaiting_contact');
    assert.equal(pending.dateTime, selectedSlot.start);
    assert.equal(pending.selectedSlotEnd, selectedSlot.end);
    assert.equal(pending.ownedOfferedSlots.length, 1);
    assert.equal(transition.invalidateAvailability, false);
    assert.equal(transition.runAvailability, false);
    assert.equal(transition.replyKind, 'none');
    assert.equal(transition.requestContact, true);
    assert.equal(pending.lastAvailabilityConstraintKey, 'authoritative-snapshot');
  }
}


// Regression: confirmation and contact details may arrive in the same turn.
// Contact data must not make an otherwise explicit affirmative confirmation fail.
const confirmationWithContactByLanguage: Record<string, string> = {
  English: 'Yes, my name is Raom 0545894846',
  Swedish: 'Ja, mitt namn är Raom 0545894846',
  German: 'Ja, mein Name ist Raom 0545894846',
  Spanish: 'Sí, me llamo Raom 0545894846',
  Persian: 'بله، اسم من رائوم است 0545894846',
  Arabic: 'نعم، اسمي راوم 0545894846',
};

for (const [language, confirmationWithContactMessage] of Object.entries(
  confirmationWithContactByLanguage
)) {
  const confirmationWithContact = pendingConfirmation();

  assert.equal(
    isPositiveBookingConfirmation(confirmationWithContactMessage),
    true,
    `${language}: affirmative confirmation with contact details is still confirmation`
  );

  const confirmationWithContactTransition = applyBookingTransition(
    confirmationWithContact,
    request(confirmationWithContactMessage)
  );

  assert.equal(
    confirmationWithContactTransition.reason,
    'slot_confirmation_accepted',
    `${language}: confirmation plus contact advances the authoritative selected slot`
  );

  assert.equal(
    getBookingPhase(confirmationWithContact),
    'awaiting_contact',
    `${language}: combined confirmation/contact advances to awaiting_contact`
  );
}

const conflictsByLanguage: Record<string, string[]> = {
  Persian: [
    'نه، همان ساعت را رزرو نکنید', 'بله شاید', 'بله ولی ساعت دیگری می خواهم',
    'بله ولی جمعه می خواهم', 'بله ولی ساعت ۱۵ بهتره', 'بله اما می خوام روزش رو عوض کنم',
    'بله ولی لیزر می خواهم',
  ],
  Finglish: [
    'na hamoon saat ro rezerv nakon', 'bale shayad', 'bale vali saat 15 behtare',
    'bale vali jome mikham', 'bale vali vaght dige mikham', 'bale vali laser mikham',
  ],
  English: [
    'Yes, but make it 3 PM.', 'Yes, but Friday instead.', 'Yes, maybe.',
    'Yes, but I want another appointment.', 'Yes, cancel that one.', 'Yes, but laser instead.',
  ],
  Swedish: [
    'Ja, men klockan 15 istället.', 'Ja, men på fredag istället.', 'Ja, kanske.',
    'Ja, men jag vill byta tiden.', 'Ja, men boka laser istället.',
  ],
  German: [
    'Ja, aber um 15 Uhr.', 'Ja, aber Freitag stattdessen.', 'Ja, vielleicht.',
    'Ja, aber ich möchte den Termin verschieben.', 'Ja, bitte stornieren.',
    'Ja, aber Laserbehandlung stattdessen.',
  ],
  Spanish: [
    'Sí, pero a las 15.', 'Sí, pero el viernes en su lugar.', 'Sí, quizás.',
    'Sí, pero quiero cambiar la cita.', 'Sí, cancela esa cita.', 'Sí, pero tratamiento láser.',
  ],
  Arabic: [
    'نعم، لكن الساعة 15.', 'نعم، لكن يوم الجمعة بدلاً من ذلك.', 'نعم، ربما.',
    'نعم، أريد تغيير الموعد.', 'نعم، ألغِ ذلك الموعد.', 'نعم، أريد خدمة ليزر.',
  ],
};

for (const [language, messages] of Object.entries(conflictsByLanguage)) {
  for (const message of messages) {
    assert.equal(isPositiveBookingConfirmation(message), false, `${language}: ${message}`);
    const pending = pendingConfirmation();
    const transition = applyBookingTransition(pending, request(message));
    assert.notEqual(transition.reason, 'slot_confirmation_accepted', `${language}: ${message}`);
    assert.notEqual(getBookingPhase(pending), 'awaiting_contact', `${language}: ${message}`);
  }
}

for (const message of ['Yes, I want to book a new appointment Friday', 'I want to reschedule my appointment']) {
  const pending = pendingConfirmation();
  const transition = applyBookingTransition(pending, request(message));
  assert.notEqual(transition.reason, 'slot_confirmation_accepted');
}

const noOwnedSlot = pendingConfirmation();
noOwnedSlot.ownedOfferedSlots = [];
assert.notEqual(
  applyBookingTransition(noOwnedSlot, request('Yes, please book that time.')).reason,
  'slot_confirmation_accepted',
  'semantic confirmation cannot create slot ownership',
);

console.log('multilingual slot confirmation regressions passed');
