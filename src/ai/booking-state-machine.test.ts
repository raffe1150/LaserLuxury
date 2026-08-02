import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBookingRequest, toPersistedBookingRequest } from './booking-intelligence';
import {
  applyBookingTransition,
  decideBookingTransition,
  isCurrentConversationTurn,
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
const slot = (hour: number) => ({
  start: `2026-08-07T${String(hour).padStart(2, '0')}:00:00+02:00`,
  end: `2026-08-07T${String(hour).padStart(2, '0')}:30:00+02:00`,
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
assert.equal(timeTransition.request.date?.value, '2026-08-07');
assert.equal(changedTime.customerName, 'Ada');
assert.equal(changedTime.customerPhone, '+46700000000');

const changedDate = pending('Friday at 19');
const dateTransition = applyBookingTransition(changedDate, request('Monday instead'));
assert.deepEqual(dateTransition.replaced, { date: true, time: false, service: false });
assert.equal(dateTransition.request.date?.value, '2026-08-03');
assert.equal(dateTransition.request.timeConstraint?.startMinutes, 19 * 60);

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
assert.equal(yesTransition.reason, 'single_owned_slot_confirmed');
assert.equal(oneSlot.dateTime, slot(19).start);
assert.equal(oneSlot.status, 'awaiting_confirmation');

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
const contactTransition = applyBookingTransition(contact, request('Ada 0700000000'));
assert.equal(contactTransition.executeBooking, true);
assert.equal(contact.dateTime, slot(19).start);
assert.equal(contact.ownedOfferedSlots[0].start, slot(19).start);
const serviceNamedContact = applyBookingTransition(contact, request('Laser 0700000000'));
assert.equal(serviceNamedContact.reason, 'contact_submission_to_verified_engine');
assert.equal(contact.dateTime, slot(19).start);
assert.notEqual(serviceNamedContact.request.service?.normalized, 'Laserbehandling');

const textCorrection = applyBookingTransition(pending(), request('بعد از ساعت ۱۸', 'text'));
const voiceCorrection = applyBookingTransition(pending(), request('بعد از ساعت هجده', 'voice'));
assert.deepEqual(textCorrection.replaced, voiceCorrection.replaced);
assert.deepEqual(textCorrection.request.timeConstraint, voiceCorrection.request.timeConstraint);

const channelResults = ['whatsapp', 'telegram', 'instagram', 'messenger'].map(() =>
  decideBookingTransition(pending(), request('No, after 18')),
);
for (const result of channelResults.slice(1)) assert.deepEqual(result, channelResults[0]);

registerConversationTurn('turn-test', 10);
assert.equal(isCurrentConversationTurn('turn-test', 10), true);
registerConversationTurn('turn-test', 11);
assert.equal(isCurrentConversationTurn('turn-test', 10), false);
assert.equal(isCurrentConversationTurn('turn-test', 11), true);

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(server, /lastAvailabilityConstraintKey === availabilityConstraintKey[\s\S]{0,300}formatNoAvailabilityRecovery/);
assert.match(server, /slotMinutesSatisfyConstraint\(zoned\.minutes, params\.normalizedConstraint\)/);
assert.match(server, /verifiedBookingReplyAuthorizations\[sessionId\] = bookingOperationResult/);
for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram']) {
  assert.match(server, new RegExp(`platformName:\\s*["']${channel}["'][\\s\\S]{0,500}handleUnifiedBookingEngine|handleUnifiedBookingEngine\\([\\s\\S]{0,500}platformName:\\s*["']${channel}["']`));
}

console.log('booking state machine tests passed');
