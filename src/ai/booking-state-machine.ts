import type { NormalizedBookingRequest, PersistedNormalizedBookingRequest } from './booking-intelligence';

export type BookingTransitionResult = {
  handled: boolean;
  nextState?: string;
  selectedSlot?: { start: string; end?: string };
  invalidateAvailability: boolean;
  runAvailability: boolean;
  requestContact: boolean;
  executeBooking: boolean;
  replyKind: 'none' | 'choose_slot' | 'request_contact' | 'booking_clarification';
  reason: string;
  replaced: { date: boolean; time: boolean; service: boolean };
};

export type BookingRequestTransition = BookingTransitionResult & {
  request: NormalizedBookingRequest;
  invalidatesOffers: boolean;
};

const AFFIRMATIVE = /^(?:yes|yeah|yep|ja|japp|bale|baleh|are|ok|okej|بله|آره|اره|باشه|حتما)$/iu;

function offeredLocalTime(slot: any): number | null {
  const match = String(slot?.start || '').match(/T(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function findSelectedSlot(pending: Record<string, any>, latest: NormalizedBookingRequest): any | null {
  const slots = Array.isArray(pending.ownedOfferedSlots) ? pending.ownedOfferedSlots : [];
  const exact = latest.timeConstraint?.kind === 'exact' ? latest.timeConstraint.startMinutes : undefined;
  if (exact !== undefined) return slots.find(slot => offeredLocalTime(slot) === exact) || null;
  const ordinal = latest.normalizedText.match(/^(?:option\s*)?(\d{1,2})$/i);
  return ordinal ? slots[Number(ordinal[1]) - 1] || null : null;
}

export function mergeBookingRequest(
  previous: NormalizedBookingRequest | PersistedNormalizedBookingRequest,
  latest: NormalizedBookingRequest,
) {
  const replaced = {
    date: Boolean(latest.date && JSON.stringify(latest.date) !== JSON.stringify(previous.date)),
    time: Boolean(latest.timeConstraint && JSON.stringify(latest.timeConstraint) !== JSON.stringify(previous.timeConstraint)),
    service: Boolean(latest.service && latest.service.normalized !== previous.service?.normalized),
  };
  return {
    request: {
      ...previous, ...latest,
      date: latest.date || previous.date,
      timeConstraint: latest.timeConstraint || previous.timeConstraint,
      service: latest.service || previous.service,
      customerCorrection: latest.customerCorrection,
    } as NormalizedBookingRequest,
    replaced,
    invalidatesOffers: replaced.date || replaced.time || replaced.service,
  };
}

export function decideBookingTransition(pending: Record<string, any>, latest: NormalizedBookingRequest): BookingTransitionResult {
  const previous = pending.normalizedBookingRequest as PersistedNormalizedBookingRequest | undefined;
  const slots = Array.isArray(pending.ownedOfferedSlots) ? pending.ownedOfferedSlots : [];
  const selected = findSelectedSlot(pending, latest);
  const affirmative = AFFIRMATIVE.test(latest.normalizedText.trim());
  const replaced = previous ? mergeBookingRequest(previous, latest).replaced : { date: false, time: false, service: false };
  const changed = replaced.date || replaced.time || replaced.service;
  const base = { invalidateAvailability: false, runAvailability: false, requestContact: false, executeBooking: false, replyKind: 'none' as const, replaced };

  if (latest.intent === 'cancellation') return { ...base, handled: false, reason: 'explicit_cancellation' };
  if (latest.intent === 'reschedule') return { ...base, handled: false, reason: 'explicit_reschedule' };
  // A new date/service can share the old slot's clock time but must never select
  // that stale slot. A time-only exact match remains an intentional selection.
  if (changed && (replaced.date || replaced.service || latest.customerCorrection || !selected)) {
    if (pending.status === 'awaiting_contact' && !latest.date && !latest.timeConstraint && !latest.customerCorrection) {
      return { ...base, handled: false, executeBooking: true, reason: 'contact_submission_to_verified_engine' };
    }
    return { ...base, handled: true, invalidateAvailability: true, runAvailability: true, reason: 'explicit_constraint_replacement' };
  }
  if (selected) return { ...base, handled: true, nextState: 'awaiting_confirmation', selectedSlot: selected, requestContact: true, reason: 'owned_slot_selected' };
  if (affirmative && slots.length === 1 && ['awaiting_time_selection', 'awaiting_confirmation'].includes(String(pending.status))) {
    return { ...base, handled: true, nextState: 'awaiting_confirmation', selectedSlot: slots[0], requestContact: true, reason: 'single_owned_slot_confirmed' };
  }
  if (affirmative && slots.length > 1 && pending.status === 'awaiting_time_selection') {
    return { ...base, handled: true, replyKind: 'choose_slot', reason: 'multiple_slots_need_selection' };
  }
  if (pending.status === 'awaiting_contact') return { ...base, handled: false, executeBooking: true, reason: 'contact_submission_to_verified_engine' };
  if (latest.intent === 'new_booking') return { ...base, handled: false, runAvailability: true, reason: 'new_booking' };
  return { ...base, handled: false, reason: 'no_deterministic_transition' };
}

export function applyBookingTransition(pending: Record<string, any>, latest: NormalizedBookingRequest): BookingRequestTransition {
  const decision = decideBookingTransition(pending, latest);
  const previous = pending.normalizedBookingRequest as PersistedNormalizedBookingRequest;
  const request = mergeBookingRequest(previous, latest).request;
  if (decision.reason === 'contact_submission_to_verified_engine' && latest.service && !latest.customerCorrection) {
    request.service = previous.service;
  }
  if (decision.invalidateAvailability) Object.assign(pending, {
    offeredSlots: [], ownedOfferedSlots: [], dateTime: null, selectedSlotEnd: null,
    lastAvailabilityConstraintKey: null,
  });
  // Exact selections still pass through the existing owned-slot validator. A
  // one-slot affirmative only supplies the missing deterministic selection.
  if (decision.reason === 'single_owned_slot_confirmed' && decision.selectedSlot) Object.assign(pending, {
    dateTime: decision.selectedSlot.start,
    selectedSlotEnd: decision.selectedSlot.end || null,
    status: decision.nextState,
  });
  return { ...decision, request, invalidatesOffers: decision.invalidateAvailability };
}

const latestTurnByConversation = new Map<string, number>();
export function registerConversationTurn(conversationKey: string, sequence: number): void {
  latestTurnByConversation.set(conversationKey, Math.max(sequence, latestTurnByConversation.get(conversationKey) || -Infinity));
}
export function isCurrentConversationTurn(conversationKey: string, sequence: number): boolean {
  return sequence >= (latestTurnByConversation.get(conversationKey) || -Infinity);
}
