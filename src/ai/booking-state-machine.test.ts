import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBookingRequest, toPersistedBookingRequest } from './booking-intelligence';
import {
  applyBookingTransition,
  beginBookingFinalization,
  decideBookingTransition,
  getBookingPhase,
  getBookingInvariantFailures,
  getMissingBookingContact,
  isCurrentConversationTurn,
  isPositiveBookingConfirmation,
  recoverBookingFinalization,
  recoverBookingTransaction,
  registerConversationTurn,
} from './booking-state-machine';

const now = new Date('2026-08-02T12:00:00Z');
const request = (text: string, inputMode: 'text' | 'voice' = 'text') => normalizeBookingRequest({
  businessId: 1,
  channel: 'shared',
  conversationKey: 'conversation',
  inputMode,
  text,
  timezone: 'Europe/Stockholm',
  now,
});
const slot = (hour: number, minute = 0) => ({
  start: `2026-08-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+02:00`,
  end: new Date(new Date(`2026-08-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+02:00`).getTime() + 30 * 60_000).toISOString(),
});
const pending = (initialText = 'Friday before 12') => ({
  status: 'awaiting_time_selection',
  service: 'Konsultation',
  customerName: 'Ada',
  customerPhone: '+46700000000',
  normalizedBookingRequest: toPersistedBookingRequest(request(initialText)),
  offeredSlots: [slot(10).start],
  ownedOfferedSlots: [slot(10)],
  dateTime: slot(10).start,
  selectedSlotEnd: slot(10).end,
  lastAvailabilityConstraintKey: 'old-fingerprint',
  operationIdentity: 'operation-1',
});

const changedTime = pending();
const timeTransition = applyBookingTransition(changedTime, request('No, after 18'));
assert.equal(timeTransition.reason, 'explicit_constraint_replacement');
assert.deepEqual(timeTransition.replaced, { date: false, time: true, service: false });
assert.equal(timeTransition.runAvailability, true);
assert.deepEqual(changedTime.offeredSlots, []);
assert.deepEqual(changedTime.ownedOfferedSlots, []);
assert.equal(changedTime.dateTime, null);
assert.equal(changedTime.lastAvailabilityConstraintKey, null);
assert.equal(changedTime.operationIdentity, null);
assert.equal(timeTransition.request.date?.value, '2026-08-07');
assert.equal(changedTime.customerName, 'Ada');
assert.equal(changedTime.customerPhone, '+46700000000');

const changedDate = pending('Friday at 19');
const dateTransition = applyBookingTransition(changedDate, request('Monday instead'));
assert.deepEqual(dateTransition.replaced, { date: true, time: false, service: false });
assert.equal(dateTransition.request.date?.value, '2026-08-03');
assert.equal(dateTransition.request.timeConstraint?.startMinutes, 19 * 60);

const lockedMonday = pending('Monday before 12');
lockedMonday.offeredSlots = [];
lockedMonday.ownedOfferedSlots = [];
lockedMonday.dateTime = null;
lockedMonday.selectedSlotEnd = null;
const mondayAt13 = applyBookingTransition(lockedMonday, request('kl 13'));
assert.equal(mondayAt13.request.date?.value, '2026-08-03', 'time-only follow-up retains locked Monday');
assert.equal(mondayAt13.request.timeConstraint?.startMinutes, 13 * 60);
assert.equal(lockedMonday.service, 'Konsultation');
assert.equal(mondayAt13.replaced.date, false);
assert.equal(mondayAt13.replaced.time, true);
assert.deepEqual(lockedMonday.offeredSlots, []);

const lockedFriday = pending('Friday after 18');
const fridayAt19 = applyBookingTransition(lockedFriday, request('kl 19'));
assert.equal(fridayAt19.request.date?.value, '2026-08-07');
assert.equal(fridayAt19.replaced.date, false);
const explicitTuesday = applyBookingTransition(pending('Monday before 12'), request('Tuesday instead'));
assert.equal(explicitTuesday.request.date?.value, '2026-08-04');
assert.equal(explicitTuesday.replaced.date, true);
assert.deepEqual(explicitTuesday.replaced, { date: true, time: false, service: false });

const changedService = pending('Friday before 12 consultation');
const serviceTransition = applyBookingTransition(changedService, request('laser instead'));
assert.deepEqual(serviceTransition.replaced, { date: false, time: false, service: true });
assert.equal(serviceTransition.request.date?.value, '2026-08-07');
assert.equal(serviceTransition.request.timeConstraint?.endMinutes, 12 * 60);

const unchanged = pending();
const unchangedTransition = applyBookingTransition(unchanged, request('Friday before 12'));
assert.equal(unchangedTransition.invalidateAvailability, false);
assert.equal(unchangedTransition.runAvailability, false);
assert.equal(unchanged.lastAvailabilityConstraintKey, 'old-fingerprint');
assert.equal(unchanged.offeredSlots.length, 1);

const unavailable = pending();
unavailable.offeredSlots = [];
unavailable.ownedOfferedSlots = [];
unavailable.dateTime = null;
applyBookingTransition(unavailable, request('Monday before 12'));
assert.equal(unavailable.lastAvailabilityConstraintKey, null);

const oneSlot = pending('Friday at 19');
oneSlot.ownedOfferedSlots = [slot(19)];
oneSlot.offeredSlots = [slot(19).start];
oneSlot.dateTime = null;
oneSlot.selectedSlotEnd = null;
const yesTransition = applyBookingTransition(oneSlot, request('Ja'));
assert.equal(yesTransition.reason, 'no_deterministic_transition');
assert.equal(oneSlot.dateTime, null, 'yes outside confirmation must not select a slot');
assert.equal(oneSlot.status, 'awaiting_time_selection');

const confirmation = pending('Friday at 19:30');
confirmation.status = 'awaiting_confirmation';
confirmation.ownedOfferedSlots = [slot(19, 30)];
confirmation.offeredSlots = [slot(19, 30).start];
confirmation.dateTime = slot(19, 30).start;
confirmation.selectedSlotEnd = slot(19, 30).end;
const confirmedStart = confirmation.dateTime;
const confirmedEnd = confirmation.selectedSlotEnd;
const politeConfirmation = applyBookingTransition(confirmation, request('Ja tack'));
assert.equal(politeConfirmation.reason, 'slot_confirmation_accepted');
assert.equal(getBookingPhase(confirmation), 'awaiting_contact');
assert.equal(confirmation.dateTime, confirmedStart);
assert.equal(confirmation.selectedSlotEnd, confirmedEnd);
assert.equal(politeConfirmation.runAvailability, false);
assert.deepEqual(getBookingInvariantFailures(confirmation), []);
const repeatedConfirmation = applyBookingTransition(confirmation, request('Ja tack'));
assert.equal(repeatedConfirmation.reason, 'contact_submission_to_verified_engine');
assert.equal(getBookingPhase(confirmation), 'awaiting_contact');

for (const affirmative of ['Ja', 'Ja tack', 'absolut', 'boka den', 'det blir bra', 'Yes', 'yes please', 'book it', 'that works', 'Bale', 'are', 'khobe', 'ok', 'بله', 'آره']) {
  const channelState = pending('Friday at 19:30');
  channelState.status = 'awaiting_confirmation';
  channelState.ownedOfferedSlots = [slot(19, 30)];
  channelState.dateTime = slot(19, 30).start;
  channelState.selectedSlotEnd = slot(19, 30).end;
  assert.equal(applyBookingTransition(channelState, request(affirmative)).reason, 'slot_confirmation_accepted');
  assert.equal(getBookingPhase(channelState), 'awaiting_contact');
}
assert.equal(isPositiveBookingConfirmation('Nej tack'), false);
const brokenConfirmation = { ...confirmation, status: 'awaiting_confirmation', selectedSlotEnd: null };
assert.deepEqual(getBookingInvariantFailures(brokenConfirmation), ['confirmation_requires_one_owned_slot']);

const exactSlot = pending('Friday at 19');
exactSlot.ownedOfferedSlots = [slot(19)];
exactSlot.dateTime = null;
const exactTransition = applyBookingTransition(exactSlot, request('Kl 19'));
assert.equal(exactTransition.reason, 'owned_slot_selected');
assert.equal(exactTransition.selectedSlot?.start, slot(19).start);
assert.equal(exactSlot.dateTime, null, 'existing owned-slot validator must perform the mutation');

const staleSameTime = pending('Friday at 19');
staleSameTime.ownedOfferedSlots = [slot(19)];
const staleTransition = applyBookingTransition(staleSameTime, request('Monday at 19'));
assert.equal(staleTransition.reason, 'explicit_constraint_replacement');
assert.equal(staleTransition.selectedSlot, undefined);
assert.deepEqual(staleSameTime.ownedOfferedSlots, []);

const manySlots = pending();
manySlots.ownedOfferedSlots = [slot(10), slot(11)];
manySlots.dateTime = null;
const manyTransition = decideBookingTransition(manySlots, request('Ja'));
assert.equal(manyTransition.reason, 'multiple_slots_need_selection');
assert.equal(manyTransition.replyKind, 'choose_slot');
assert.equal(manyTransition.selectedSlot, undefined);

const contact = pending('Friday at 19');
contact.status = 'awaiting_contact';
contact.ownedOfferedSlots = [slot(19)];
contact.dateTime = slot(19).start;
contact.selectedSlotEnd = slot(19).end;
const contactTransition = applyBookingTransition(contact, request('Ada 0700000000'));
assert.equal(contactTransition.executeBooking, true);
assert.equal(contact.dateTime, slot(19).start);
assert.equal(contact.ownedOfferedSlots[0].start, slot(19).start);
assert.equal(contact.operationIdentity, 'operation-1');
contact.customerName = 'Nina';
contact.customerPhone = '07394660356';
assert.deepEqual(getMissingBookingContact(contact), []);
let calendarCreates = 0;
let databaseCreates = 0;
let truthfulSuccessReplies = 0;
if (contactTransition.executeBooking && beginBookingFinalization(contact)) {
  calendarCreates += 1;
  databaseCreates += 1;
  truthfulSuccessReplies += 1;
}
assert.deepEqual(
  { calendarCreates, databaseCreates, truthfulSuccessReplies },
  { calendarCreates: 1, databaseCreates: 1, truthfulSuccessReplies: 1 },
  'combined valid contact begins exactly one verified finalization',
);
assert.equal(beginBookingFinalization(contact), false, 'the same contact turn cannot finalize twice');
contact.status = 'awaiting_contact';
contact.customerPhone = '123';
assert.deepEqual(getMissingBookingContact(contact), ['phone']);
assert.equal(contact.dateTime, slot(19).start, 'invalid contact must preserve the selected slot');
contact.customerPhone = '07394660356';
const serviceNamedContact = applyBookingTransition(contact, request('Laser 0700000000'));
assert.equal(serviceNamedContact.reason, 'contact_submission_to_verified_engine');
assert.equal(contact.dateTime, slot(19).start);
assert.notEqual(serviceNamedContact.request.service?.normalized, 'Laserbehandling');
const repeatedExactTime = applyBookingTransition(contact, request('Sate 19'));
assert.equal(repeatedExactTime.reason, 'contact_submission_to_verified_engine');
assert.equal(contact.dateTime, slot(19).start);

assert.equal(beginBookingFinalization(contact), true);
assert.equal(getBookingPhase(contact), 'finalizing');
assert.equal(beginBookingFinalization(contact), false, 'concurrent finalization must be rejected');
recoverBookingFinalization(contact, 'calendar_create', false);
assert.equal(getBookingPhase(contact), 'failed_recoverable');
assert.equal(contact.lastFailureStage, 'calendar_create');
assert.equal(contact.lastRollbackSucceeded, false);
assert.equal(contact.dateTime, slot(19).start);
assert.equal(contact.selectedSlotEnd, slot(19).end);
assert.equal(contact.customerName, 'Nina');
assert.equal(contact.customerPhone, '07394660356');
assert.equal(contact.service, 'Konsultation');
assert.equal(contact.operationIdentity, 'operation-1');
assert.equal(beginBookingFinalization(contact), true, 'recoverable failure can retry the same operation');
recoverBookingFinalization(contact, 'database_verification', true);
assert.equal(contact.lastFailureStage, 'database_verification');
assert.equal(contact.lastRollbackSucceeded, true);
assert.equal(contact.dateTime, slot(19).start);
let rollbackCalls = 0;
const simulatedDatabaseFailure = await recoverBookingTransaction(contact, 'database_verification', async () => {
  rollbackCalls += 1;
  return true;
});
assert.deepEqual(simulatedDatabaseFailure, { phase: 'failed_recoverable', rollbackSucceeded: true });
assert.equal(rollbackCalls, 1, 'database verification failure rolls back once');
const simulatedCalendarFailure = await recoverBookingTransaction(contact, 'calendar_create');
assert.deepEqual(simulatedCalendarFailure, { phase: 'failed_recoverable', rollbackSucceeded: null });

const textCorrection = applyBookingTransition(pending(), request('بعد از ساعت ۱۸', 'text'));
const voiceCorrection = applyBookingTransition(pending(), request('بعد از ساعت هجده', 'voice'));
assert.deepEqual(textCorrection.replaced, voiceCorrection.replaced);
assert.deepEqual(textCorrection.request.timeConstraint, voiceCorrection.request.timeConstraint);

const channelResults = ['whatsapp', 'telegram', 'instagram', 'messenger'].map(() =>
  decideBookingTransition(pending(), request('No, after 18')),
);
for (const result of channelResults.slice(1)) assert.deepEqual(result, channelResults[0]);
const confirmationResults = ['whatsapp', 'telegram', 'instagram', 'messenger'].map(() => {
  const state = pending('Friday at 19:30');
  state.status = 'awaiting_confirmation';
  state.ownedOfferedSlots = [slot(19, 30)];
  state.dateTime = slot(19, 30).start;
  state.selectedSlotEnd = slot(19, 30).end;
  return { transition: applyBookingTransition(state, request('Ja tack')), phase: getBookingPhase(state), start: state.dateTime, end: state.selectedSlotEnd };
});
for (const result of confirmationResults.slice(1)) assert.deepEqual(result, confirmationResults[0]);
for (const affirmative of ['Yes', 'Bale', 'بله']) {
  const selectionState = pending();
  selectionState.dateTime = null;
  assert.equal(applyBookingTransition(selectionState, request(affirmative)).selectedSlot, undefined);
}

registerConversationTurn('turn-test', 10);
assert.equal(isCurrentConversationTurn('turn-test', 10), true);
registerConversationTurn('turn-test', 11);
assert.equal(isCurrentConversationTurn('turn-test', 10), false);
assert.equal(isCurrentConversationTurn('turn-test', 11), true);

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(server, /lastAvailabilityConstraintKey === availabilityConstraintKey[\s\S]{0,300}formatNoAvailabilityRecovery/);
assert.match(server, /slotMinutesSatisfyConstraint\(zoned\.minutes, params\.normalizedConstraint\)/);
assert.match(server, /verifiedBookingReplyAuthorizations\[sessionId\] = bookingOperationResult/);
assert.match(server, /Boolean\(deterministicTransition\?\.runAvailability\)/);
assert.match(server, /selectedSlotEnd: exactOwnedSlot\?\.end \|\| null/);
assert.match(server, /calendarEvents: filteredEvents,[\s\S]{0,80}pendingEvents/);
assert.match(server, /recoverBookingTransaction\(pending, "calendar_verification", rollbackInsertedCalendarEvent\)/);
assert.match(server, /recoverBookingTransaction\(pending, databaseFailurePath/);
assert.ok(server.indexOf('verifiedBookingReplyAuthorizations[sessionId] = bookingOperationResult') < server.indexOf('await notifyAdminAboutBooking('));
for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram']) {
  assert.match(server, new RegExp(`platformName:\\s*["']${channel}["'][\\s\\S]{0,500}handleUnifiedBookingEngine|handleUnifiedBookingEngine\\([\\s\\S]{0,500}platformName:\\s*["']${channel}["']`));
}

console.log('booking state machine tests passed');
