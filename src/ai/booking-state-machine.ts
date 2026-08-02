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

export type BookingPhase =
  | 'idle'
  | 'awaiting_service'
  | 'awaiting_date_or_time'
  | 'awaiting_slot_selection'
  | 'awaiting_slot_confirmation'
  | 'awaiting_contact'
  | 'finalizing'
  | 'completed'
  | 'failed_recoverable';

export type BookingFailureStage =
  | 'final_validation'
  | 'calendar_create'
  | 'calendar_verification'
  | 'database_insert'
  | 'database_verification'
  | 'idempotency_settlement'
  | 'unexpected';

export function getBookingPhase(pending?: Record<string, any> | null): BookingPhase {
  const status = String(pending?.status || '');
  if (!pending) return 'idle';
  if (status === 'awaiting_service') return 'awaiting_service';
  if (status === 'awaiting_date_or_time') return 'awaiting_date_or_time';
  if (['awaiting_time_selection', 'awaiting_slot_selection'].includes(status)) return 'awaiting_slot_selection';
  if (['awaiting_confirmation', 'awaiting_slot_confirmation'].includes(status)) return 'awaiting_slot_confirmation';
  if (['awaiting_contact', 'awaiting_voice_contact_confirmation'].includes(status)) return 'awaiting_contact';
  if (['inserting', 'finalizing', 'verifying'].includes(status)) return 'finalizing';
  if (status === 'completed') return 'completed';
  if (status === 'failed_recoverable') return 'failed_recoverable';
  return 'awaiting_date_or_time';
}

export function isPositiveBookingConfirmation(text: string): boolean {
  const raw = String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[!?.،,؛]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || /\b(?:no|not|nej|inte|maybe|kanske|na|nemikham|نه|خیر|شاید)\b/iu.test(raw)) return false;
  return /^(?:yes|yes please|yeah|yep|sure|book it|that works|ja|ja tack|ja gärna|japp|absolut|boka den|det blir bra|bale|baleh|bale lotfan|baleh lotfan|are|khobe|bashe|ok|okay|okej|بله|بله لطفا|آره|اره|باشه|حتما)$/iu.test(raw);
}

export function beginBookingFinalization(pending: Record<string, any>): boolean {
  if (!['awaiting_contact', 'failed_recoverable'].includes(getBookingPhase(pending)) || !pending.dateTime || !pending.selectedSlotEnd) return false;
  pending.status = 'inserting';
  return true;
}

export function recoverBookingFinalization(pending: Record<string, any>, stage: BookingFailureStage, rollbackSucceeded?: boolean): void {
  pending.status = 'failed_recoverable';
  pending.lastFailureStage = stage;
  pending.lastRollbackSucceeded = rollbackSucceeded ?? null;
}

export async function recoverBookingTransaction(
  pending: Record<string, any>,
  stage: BookingFailureStage,
  rollback?: () => Promise<boolean>,
): Promise<{ phase: BookingPhase; rollbackSucceeded: boolean | null }> {
  const rollbackSucceeded = rollback ? await rollback() : null;
  recoverBookingFinalization(pending, stage, rollbackSucceeded ?? undefined);
  return { phase: getBookingPhase(pending), rollbackSucceeded };
}

export function getMissingBookingContact(pending: Record<string, any>): Array<'name' | 'phone' | 'service'> {
  const missing: Array<'name' | 'phone' | 'service'> = [];
  const phoneDigits = String(pending.customerPhone || '').replace(/\D/g, '');
  if (!String(pending.customerName || '').trim()) missing.push('name');
  if (phoneDigits.length < 7 || phoneDigits.length > 15) missing.push('phone');
  if (!pending.service || pending.service === 'Bokning') missing.push('service');
  return missing;
}

export function getBookingInvariantFailures(pending: Record<string, any>): string[] {
  const phase = getBookingPhase(pending);
  const failures: string[] = [];
  const slots = Array.isArray(pending.ownedOfferedSlots) ? pending.ownedOfferedSlots : [];
  const selected = slots.filter(slot =>
    new Date(String(slot?.start || '')).getTime() === new Date(String(pending.dateTime || '')).getTime() &&
    new Date(String(slot?.end || '')).getTime() === new Date(String(pending.selectedSlotEnd || '')).getTime()
  );
  if (phase === 'awaiting_slot_confirmation' && selected.length !== 1) failures.push('confirmation_requires_one_owned_slot');
  if (['awaiting_contact', 'finalizing', 'failed_recoverable'].includes(phase) && selected.length !== 1) failures.push('selected_owned_slot_required');
  if (['awaiting_contact', 'finalizing', 'failed_recoverable'].includes(phase) && !pending.service) failures.push('service_required');
  return failures;
}

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
  const affirmative = isPositiveBookingConfirmation(latest.normalizedText);
  const replaced = previous ? mergeBookingRequest(previous, latest).replaced : { date: false, time: false, service: false };
  const changed = replaced.date || replaced.time || replaced.service;
  const base = { invalidateAvailability: false, runAvailability: false, requestContact: false, executeBooking: false, replyKind: 'none' as const, replaced };

  if (latest.intent === 'cancellation') return { ...base, handled: false, reason: 'explicit_cancellation' };
  if (latest.intent === 'reschedule') return { ...base, handled: false, reason: 'explicit_reschedule' };
  // A new date/service can share the old slot's clock time but must never select
  // that stale slot. A time-only exact match remains an intentional selection.
  if (changed && (replaced.date || replaced.service || latest.customerCorrection || !selected)) {
    if (['awaiting_contact', 'failed_recoverable'].includes(getBookingPhase(pending)) && !latest.date && !latest.timeConstraint && !latest.customerCorrection) {
      return { ...base, handled: false, executeBooking: true, reason: 'contact_submission_to_verified_engine' };
    }
    return { ...base, handled: true, invalidateAvailability: true, runAvailability: true, reason: 'explicit_constraint_replacement' };
  }
  const selectedPendingSlots = pending.dateTime && pending.selectedSlotEnd
    ? slots.filter(slot =>
        new Date(String(slot?.start || '')).getTime() === new Date(String(pending.dateTime)).getTime() &&
        new Date(String(slot?.end || '')).getTime() === new Date(String(pending.selectedSlotEnd)).getTime()
      )
    : [];
  const selectedPendingSlot = selectedPendingSlots.length === 1 ? selectedPendingSlots[0] : null;
  if (affirmative && getBookingPhase(pending) === 'awaiting_slot_confirmation' && selectedPendingSlot) {
    return { ...base, handled: true, nextState: 'awaiting_contact', selectedSlot: selectedPendingSlot, requestContact: true, reason: 'slot_confirmation_accepted' };
  }
  if (['awaiting_contact', 'failed_recoverable'].includes(getBookingPhase(pending))) {
    return { ...base, handled: false, executeBooking: true, reason: 'contact_submission_to_verified_engine' };
  }
  if (selected) return { ...base, handled: true, nextState: 'awaiting_confirmation', selectedSlot: selected, requestContact: true, reason: 'owned_slot_selected' };
  if (affirmative && slots.length > 1 && pending.status === 'awaiting_time_selection') {
    return { ...base, handled: true, replyKind: 'choose_slot', reason: 'multiple_slots_need_selection' };
  }
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
    lastAvailabilityConstraintKey: null, operationIdentity: null, lastFailureStage: null, lastRollbackSucceeded: null,
  });
  // Exact selections still pass through the existing owned-slot validator.
  // Confirmed authoritative selections advance without another availability scan.
  if (decision.reason === 'slot_confirmation_accepted' && decision.selectedSlot) Object.assign(pending, {
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
