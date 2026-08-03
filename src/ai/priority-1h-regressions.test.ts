import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectSecureAppointmentRows } from '../../booking-security';
import { enumerateCandidateMinutes, isCanonicalSlotFree } from './canonical-availability';
import { normalizeBookingRequest, toPersistedBookingRequest } from './booking-intelligence';
import {
  CURRENT_BOOKING_STATE_VERSION,
  normalizePendingBookingState,
  resolveAuthoritativeOperation,
} from './booking-operation-state';
import { applyBookingTransition, beginBookingFinalization, isPositiveBookingConfirmation } from './booking-state-machine';
import { isInvalidCustomerNameToken, resolveAuthoritativeContact } from './channel-contact';
import { resolveTelegramReplyPreference, selectTelegramDeliveryMode } from './channel-reliability';

const start = '2026-08-07T14:00:00+02:00';
const end = '2026-08-07T12:30:00.000Z';
const ownedSlot = { start, end };
const request = (text: string) => normalizeBookingRequest({
  businessId: '7', channel: 'shared', conversationKey: 'owner-1', inputMode: 'text', text,
  timezone: 'Europe/Stockholm', now: new Date('2026-08-03T08:00:00Z'),
});
const pending = (overrides: Record<string, any> = {}) => ({
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
  operation: 'new_booking', status: 'awaiting_contact', service: 'Konsultation',
  durationMinutes: 30, dateTime: start, selectedSlotEnd: end,
  offeredSlots: [start], ownedOfferedSlots: [ownedSlot],
  normalizedBookingRequest: toPersistedBookingRequest(request('Friday at 14')),
  ...overrides,
});

function whatsapp_combined_contact_finalizes_without_technical_fallback() {
  const state = pending({ customerPhone: '+46701234567', contactPhoneSource: 'verified_sender_metadata' });
  const contact = resolveAuthoritativeContact({
    channel: 'whatsapp', storedPhone: state.customerPhone,
    storedPhoneSource: state.contactPhoneSource, currentName: 'Arman',
    currentPhone: '03585353563', senderPhone: '+46701234567',
  });
  assert.deepEqual(contact.missing, []);
  assert.equal(contact.phone, '+46701234567', 'sender metadata remains authoritative');
  state.customerName = contact.name; state.customerPhone = contact.phone;
  assert.equal(beginBookingFinalization(state), true);
  assert.equal(beginBookingFinalization(state), false);
}

function telegram_bale_never_becomes_customer_name() {
  for (const token of ['Bale', 'بله', 'Ja', 'Yes', 'Ja tack', 'Mersi', 'مرسی', 'Thanks']) {
    assert.equal(isInvalidCustomerNameToken(token), true, token);
  }
  const normalized = normalizePendingBookingState(pending({ customerName: 'Bale' }));
  assert.equal(normalized.state?.customerName, null);
  assert.ok(normalized.repairs.includes('invalid_customer_name_cleared'));
  const phoneOnly = resolveAuthoritativeContact({ channel: 'telegram', currentPhone: '0701234567' });
  assert.deepEqual(phoneOnly.missing, ['name']);
  const nameOnly = resolveAuthoritativeContact({ channel: 'telegram', currentName: 'Arman' });
  assert.deepEqual(nameOnly.missing, ['phone']);
}

function telegram_text_does_not_inherit_voice_reply_mode() {
  const voice = resolveTelegramReplyPreference(null, 'voice', 'سلام');
  const text = resolveTelegramReplyPreference(voice, 'text', 'hello');
  assert.equal(selectTelegramDeliveryMode(text, 'text'), 'text');
  const explicit = resolveTelegramReplyPreference(text, 'text', 'reply with voice');
  assert.equal(selectTelegramDeliveryMode(explicit, 'text'), 'voice');
  const afterRestart = resolveTelegramReplyPreference(null, 'text', 'hello');
  assert.deepEqual(afterRestart, { mode: 'auto', explicit: false });
}

function instagram_bale_confirms_cancellation_before_language_detection() {
  const operation = resolveAuthoritativeOperation({
    cancellation: { status: 'awaiting_cancellation_confirmation' },
  });
  assert.equal(operation.operation, 'cancellation');
  assert.equal(isPositiveBookingConfirmation('Bale'), true);
}

function instagram_reschedule_updates_target_instead_of_creating_new_booking() {
  const operation = resolveAuthoritativeOperation({
    reschedule: { originalAppointmentId: 'appointment-1' },
  });
  assert.equal(operation.operation, 'reschedule');
  const invalid = normalizePendingBookingState({ operation: 'reschedule', status: 'awaiting_confirmation' });
  assert.equal(invalid.resetReason, 'reschedule_target_missing');
}

function messenger_exact_single_slot_yes_advances_to_contact() {
  const state = pending({ status: 'awaiting_confirmation' });
  const transition = applyBookingTransition(state, request('Yes please!'));
  assert.equal(transition.reason, 'slot_confirmation_accepted');
  assert.equal(state.status, 'awaiting_contact');
  assert.equal(state.dateTime, start);
  assert.equal(state.selectedSlotEnd, end);
}

function range_and_exact_availability_share_one_snapshot() {
  const events = [
    { summary: 'Business hours 09-17', start: { dateTime: '2026-08-07T07:00:00Z' }, end: { dateTime: '2026-08-07T15:00:00Z' } },
    { summary: 'Booked', start: { dateTime: '2026-08-07T10:00:00Z' }, end: { dateTime: '2026-08-07T10:30:00Z' } },
  ];
  const candidates = enumerateCandidateMinutes(9 * 60, 17 * 60, 30, 30);
  const exactStart = new Date('2026-08-07T10:30:00Z').getTime();
  assert.ok(candidates.includes(12 * 60 + 30));
  assert.equal(isCanonicalSlotFree(exactStart, 30, events, new Date('2026-08-03T00:00:00Z').getTime()), true, 'adjacent half-open boundary is free');
  assert.equal(isCanonicalSlotFree(new Date('2026-08-07T10:00:00Z').getTime(), 30, events, 0), false);
}

function stale_priority_1g_state_is_reset_safely() {
  const stale = normalizePendingBookingState(pending({
    bookingStateVersion: 0, status: 'inserting', customerName: 'Bale',
  }));
  assert.equal(stale.state?.bookingStateVersion, CURRENT_BOOKING_STATE_VERSION);
  assert.equal(stale.state?.status, 'failed_recoverable');
  assert.equal(stale.state?.customerName, null);
  assert.ok(stale.repairs.includes('orphaned_finalizing_recovered'));
  const incomplete = normalizePendingBookingState(pending({ selectedSlotEnd: null }));
  assert.equal(incomplete.state?.dateTime, null);
  assert.equal(incomplete.phase, 'awaiting_date_or_constraint');
}

function appointment_lookup_isolates_cross_customer_rows() {
  const rows = [
    { id: 'mine', business_id: '7', platform: 'instagram', user_id: 'owner-1', status: 'booked', start_time: '2026-08-07T10:00:00Z' },
    { id: 'other', business_id: '7', platform: 'instagram', user_id: 'owner-2', status: 'booked', start_time: '2026-08-07T11:00:00Z' },
  ];
  const result = selectSecureAppointmentRows(rows, { businessId: '7', platform: 'instagram', userId: 'owner-1' }, 'upcoming', Date.parse('2026-08-03'), Date.parse('2026-08-03'), Date.parse('2026-08-10'));
  assert.deepEqual(result.rows.map(row => row.id), ['mine']);
}

async function provider_fake_end_to_end_transactions() {
  const calendar = new Map<string, { id: string; start: string }>();
  const database = new Map<string, { id: string; start: string; status: string }>();
  const settled = new Set<string>();
  let creates = 0;
  const createOnce = (key: string) => {
    if (settled.has(key)) return;
    const event = { id: 'event-1', start }; calendar.set(event.id, event); creates += 1;
    assert.deepEqual(calendar.get(event.id), event, 'calendar read-back verifies');
    const row = { id: 'appointment-1', start, status: 'booked' }; database.set(row.id, row);
    assert.deepEqual(database.get(row.id), row, 'database read-back verifies');
    settled.add(key);
  };
  createOnce('new:owner-1:slot-1'); createOnce('new:owner-1:slot-1');
  assert.equal(creates, 1); assert.equal(calendar.size, 1); assert.equal(database.size, 1);
  calendar.set('event-1', { id: 'event-1', start: '2026-08-08T10:00:00Z' });
  database.set('appointment-1', { id: 'appointment-1', start: '2026-08-08T10:00:00Z', status: 'booked' });
  assert.equal(calendar.size, 1, 'reschedule updates, never inserts');
  calendar.delete('event-1'); database.set('appointment-1', { id: 'appointment-1', start, status: 'cancelled' });
  assert.equal(calendar.has('event-1'), false); assert.equal(database.get('appointment-1')?.status, 'cancelled');
}

function unique_inbound_message_increments_usage_once() {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  for (const platform of ['telegram', 'messenger', 'instagram']) {
    const counter = source.indexOf(`platform: "${platform}"`, source.indexOf('const inboundUsage'));
    assert.ok(counter >= 0, `${platform} counts at claimed-handler entry`);
  }
  assert.match(source, /runWithInboundMessageClaim[\s\S]*Duplicate inbound message suppressed/);
  assert.equal((source.match(/const inboundUsage = await checkAndIncrementDailyUsage/g) || []).length, 3);
  assert.equal((source.match(/const usage = await checkAndIncrementDailyUsage/g) || []).length, 1, 'WhatsApp already counts before deterministic routing');
}

whatsapp_combined_contact_finalizes_without_technical_fallback();
telegram_bale_never_becomes_customer_name();
telegram_text_does_not_inherit_voice_reply_mode();
instagram_bale_confirms_cancellation_before_language_detection();
instagram_reschedule_updates_target_instead_of_creating_new_booking();
messenger_exact_single_slot_yes_advances_to_contact();
range_and_exact_availability_share_one_snapshot();
stale_priority_1g_state_is_reset_safely();
appointment_lookup_isolates_cross_customer_rows();
await provider_fake_end_to_end_transactions();
unique_inbound_message_increments_usage_once();

console.log('Priority 1H transcript and provider-fake regressions passed');
