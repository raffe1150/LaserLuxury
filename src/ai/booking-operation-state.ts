import { isInvalidCustomerNameToken } from './channel-contact';

export const CURRENT_BOOKING_STATE_VERSION = 3;

export type BookingOperation =
  | 'none'
  | 'new_booking'
  | 'reschedule'
  | 'cancellation'
  | 'appointment_lookup';

export type CanonicalBookingPhase =
  | 'idle'
  | 'awaiting_service'
  | 'awaiting_date_or_constraint'
  | 'awaiting_slot_selection'
  | 'awaiting_slot_confirmation'
  | 'awaiting_contact'
  | 'awaiting_cancellation_reason'
  | 'awaiting_cancellation_confirmation'
  | 'awaiting_reschedule_target'
  | 'awaiting_reschedule_constraint'
  | 'awaiting_reschedule_confirmation'
  | 'finalizing'
  | 'failed_recoverable'
  | 'completed';

export type BookingStateResetReason =
  | 'future_state_version'
  | 'invalid_operation'
  | 'completed_state'
  | 'selected_slot_incomplete'
  | 'selected_slot_not_owned'
  | 'reschedule_target_missing'
  | 'cancellation_completed';

export type BookingStateNormalization = {
  state: Record<string, any> | null;
  phase: CanonicalBookingPhase;
  operation: BookingOperation;
  expectedInput: string;
  migratedFromVersion: number | null;
  resetReason: BookingStateResetReason | null;
  repairs: string[];
};

export function operationFromCurrentIntent(intent?: string | null): BookingOperation {
  if (intent === 'new_booking') return 'new_booking';
  if (intent === 'reschedule') return 'reschedule';
  if (intent === 'cancellation') return 'cancellation';
  if (intent === 'booking_lookup' || intent === 'existing_booking_lookup') return 'appointment_lookup';
  return 'none';
}

const OPERATIONS = new Set<BookingOperation>([
  'none', 'new_booking', 'reschedule', 'cancellation', 'appointment_lookup',
]);

export function canonicalPhaseFromLegacy(state?: Record<string, any> | null): CanonicalBookingPhase {
  const status = String(state?.status || '');
  if (!state || status === 'idle') return 'idle';
  if (status === 'awaiting_service') return 'awaiting_service';
  if (status === 'awaiting_date_or_time' || status === 'awaiting_date_or_constraint') return 'awaiting_date_or_constraint';
  if (status === 'awaiting_time_selection' || status === 'awaiting_slot_selection') return 'awaiting_slot_selection';
  if (status === 'awaiting_confirmation' || status === 'awaiting_slot_confirmation') return 'awaiting_slot_confirmation';
  if (status === 'awaiting_contact' || status === 'awaiting_voice_contact_confirmation') return 'awaiting_contact';
  if (status === 'awaiting_reason' || status === 'awaiting_cancellation_reason') return 'awaiting_cancellation_reason';
  if (status === 'awaiting_cancellation_confirmation') return 'awaiting_cancellation_confirmation';
  if (status === 'awaiting_target' || status === 'awaiting_reschedule_target') return 'awaiting_reschedule_target';
  if (status === 'awaiting_reschedule_constraint') return 'awaiting_reschedule_constraint';
  if (status === 'awaiting_reschedule_confirmation') return 'awaiting_reschedule_confirmation';
  if (status === 'inserting' || status === 'verifying' || status === 'finalizing' || status === 'processing' || status === 'updating') return 'finalizing';
  if (status === 'failed_recoverable' || status === 'update_failed' || status === 'verification_failed' || status === 'failed') return 'failed_recoverable';
  if (status === 'completed') return 'completed';
  return 'awaiting_date_or_constraint';
}

export function expectedInputForPhase(phase: CanonicalBookingPhase): string {
  switch (phase) {
    case 'awaiting_service': return 'service';
    case 'awaiting_date_or_constraint': return 'date_or_constraint';
    case 'awaiting_slot_selection': return 'slot_selection';
    case 'awaiting_slot_confirmation': return 'confirmation';
    case 'awaiting_contact': return 'contact';
    case 'awaiting_cancellation_reason': return 'cancellation_reason';
    case 'awaiting_cancellation_confirmation': return 'confirmation';
    case 'awaiting_reschedule_target': return 'appointment_target';
    case 'awaiting_reschedule_constraint': return 'date_or_constraint';
    case 'awaiting_reschedule_confirmation': return 'confirmation';
    case 'failed_recoverable': return 'retry_or_correction';
    default: return 'none';
  }
}

function reset(reason: BookingStateResetReason, version: number): BookingStateNormalization {
  return {
    state: null,
    phase: 'idle',
    operation: 'none',
    expectedInput: 'none',
    migratedFromVersion: version === CURRENT_BOOKING_STATE_VERSION ? null : version,
    resetReason: reason,
    repairs: [],
  };
}

function slotMatches(state: Record<string, any>): boolean {
  const start = new Date(String(state.dateTime || '')).getTime();
  const end = new Date(String(state.selectedSlotEnd || '')).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const owned = Array.isArray(state.ownedOfferedSlots) ? state.ownedOfferedSlots : [];
  return owned.some((slot: any) =>
    new Date(String(slot?.start || '')).getTime() === start &&
    new Date(String(slot?.end || '')).getTime() === end
  );
}

/** Canonical reader for the existing pending-booking store. It never invents customer data. */
export function normalizePendingBookingState(input: unknown): BookingStateNormalization {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return reset('invalid_operation', 0);
  }
  const state = { ...(input as Record<string, any>) };
  const version = Number.isInteger(Number(state.bookingStateVersion))
    ? Number(state.bookingStateVersion)
    : 0;
  if (version > CURRENT_BOOKING_STATE_VERSION) return reset('future_state_version', version);

  const operation = String(state.operation || 'new_booking') as BookingOperation;
  if (!OPERATIONS.has(operation) || operation === 'none') return reset('invalid_operation', version);
  let phase = canonicalPhaseFromLegacy(state);
  if (phase === 'completed') return reset('completed_state', version);
  if (operation === 'cancellation' && state.lastOperation === 'completed') return reset('cancellation_completed', version);
  if (operation === 'reschedule' && !(state.targetAppointmentId || state.originalAppointmentId || state.appointment?.id)) {
    return reset('reschedule_target_missing', version);
  }

  const repairs: string[] = [];
  if (state.customerName && isInvalidCustomerNameToken(state.customerName)) {
    state.customerName = null;
    repairs.push('invalid_customer_name_cleared');
  }

  const hasStart = Boolean(state.dateTime);
  const hasEnd = Boolean(state.selectedSlotEnd);
  if (hasStart !== hasEnd) {
    state.dateTime = null;
    state.selectedSlotEnd = null;
    state.offeredSlots = [];
    state.ownedOfferedSlots = [];
    state.lastAvailabilityConstraintKey = null;
    state.operationIdentity = null;
    state.status = 'awaiting_date_or_time';
    phase = 'awaiting_date_or_constraint';
    repairs.push('incomplete_selected_slot_cleared');
  } else if (hasStart && hasEnd && !slotMatches(state)) {
    state.dateTime = null;
    state.selectedSlotEnd = null;
    state.offeredSlots = [];
    state.ownedOfferedSlots = [];
    state.lastAvailabilityConstraintKey = null;
    state.operationIdentity = null;
    state.status = 'awaiting_date_or_time';
    phase = 'awaiting_date_or_constraint';
    repairs.push('unowned_selected_slot_cleared');
  }

  // A process restart cannot prove that an in-flight mutation is still running.
  // Preserve all transaction inputs and require the guarded idempotent retry path.
  if (phase === 'finalizing') {
    state.status = 'failed_recoverable';
    state.lastFailureStage = state.lastFailureStage || 'unexpected';
    phase = 'failed_recoverable';
    repairs.push('orphaned_finalizing_recovered');
  }

  if (phase === 'failed_recoverable') {
    state.retryEligible = state.retryEligible !== false;
    state.expectedInput = state.expectedInput || 'retry_or_correction';
    state.failedStage = state.failedStage || state.lastFailureStage || 'unexpected';
    state.mutationProgress = state.mutationProgress || {
      calendarStarted: false,
      calendarVerified: false,
      databaseStarted: false,
      databaseVerified: false,
      settlementStarted: false,
    };
  }

  state.bookingStateVersion = CURRENT_BOOKING_STATE_VERSION;
  state.operation = operation;
  return {
    state,
    phase,
    operation,
    expectedInput: expectedInputForPhase(phase),
    migratedFromVersion: version === CURRENT_BOOKING_STATE_VERSION ? null : version,
    resetReason: null,
    repairs,
  };
}

export function resolveAuthoritativeOperation(input: {
  currentIntent?: BookingOperation | null;
  pending?: Record<string, any> | null;
  reschedule?: Record<string, any> | null;
  cancellation?: Record<string, any> | null;
  lookup?: Record<string, any> | null;
}): { operation: BookingOperation; phase: CanonicalBookingPhase; expectedInput: string; conflict: boolean } {
  const active: BookingOperation[] = [];
  if (input.cancellation) active.push('cancellation');
  if (input.reschedule) active.push('reschedule');
  if (input.lookup) {
    const lookupOperation = String(input.lookup.operation || 'lookup');
    active.push(lookupOperation === 'cancel' ? 'cancellation' : lookupOperation === 'reschedule' ? 'reschedule' : 'appointment_lookup');
  }
  if (input.pending) active.push((input.pending.operation || 'new_booking') as BookingOperation);
  const distinct = Array.from(new Set(active));
  const operation = input.currentIntent && input.currentIntent !== 'none'
    ? input.currentIntent
    : distinct[0] || 'none';
  let phase: CanonicalBookingPhase = 'idle';
  if (operation === 'new_booking') {
    phase = canonicalPhaseFromLegacy(input.pending);
  } else if (operation === 'cancellation') {
    const status = String(input.cancellation?.lastOperation || input.lookup?.lastOperation || '');
    phase = status === 'awaiting_confirmation'
      ? 'awaiting_cancellation_confirmation'
      : 'awaiting_cancellation_reason';
  } else if (operation === 'reschedule') {
    const status = String(input.reschedule?.lastOperation || input.lookup?.lastOperation || '');
    phase = status === 'awaiting_confirmation'
      ? 'awaiting_reschedule_confirmation'
      : status === 'awaiting_constraint'
        ? 'awaiting_reschedule_constraint'
        : 'awaiting_reschedule_target';
  } else if (operation === 'appointment_lookup') {
    phase = 'awaiting_reschedule_target';
  }
  return {
    operation,
    phase,
    expectedInput: operation === 'appointment_lookup' ? 'appointment_target' : expectedInputForPhase(phase),
    conflict: distinct.length > 1,
  };
}
