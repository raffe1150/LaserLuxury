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
  | 'availability'
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
  const raw = String(text || '').normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670]/gu, '')
    .replace(/[يى]/gu, 'ی').replace(/ك/gu, 'ک').replace(/\u200c/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return false;

  const conflictingIntent = [
    /(?:^|\s)(?:no|not|dont|do not|maybe|perhaps|unsure|nej|inte|kanske|osaker|nein|nicht|vielleicht|unsicher|quizas|tal vez|na|nemikham|shayad)(?:\s|$)/u,
    /(?:^|\s)(?:نه|خیر|نکنید|نکن|شاید|نمیدانم|مطمئن نیستم|لا|ليس|ربما|غير متاكد)(?:\s|$)/u,
    /\b(?:cancel|cancellation|avboka|stornieren|cancelar|cancela|laghv)\b/u,
    /(?:لغو|کنسل|ألغ|الغ)/u,
    /\b(?:reschedule|move|change|another|different|instead|byta|andra|flytta|ann?an|istallet|verschieben|andern|stattdessen|cambiar|cambio|otra|otro|diferente|taghir|avaz|dige)\b/u,
    /(?:تغییر|عوض|دیگر|دیگه|روزش|بدلا|بدلاً)/u,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mandag|tisdag|onsdag|torsdag|fredag|lordag|sondag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunes|martes|miercoles|jueves|viernes|sabado|domingo|jomeh?)\b/u,
    /(?:دوشنبه|سه شنبه|چهارشنبه|پنجشنبه|جمعه|شنبه|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|السبت)/u,
    /\b\d{1,2}(?:(?:\s|:|\.)\d{2})?(?:\s*(?:am|pm|uhr))?\b/u,
    /\b(?:laser|laserbehandlung|consultation|konsultation|consulta|tratamiento|behandlung|service)\b/u,
    /(?:لیزر|مشاوره|خدمة|خدمه)/u,
    /\b(?:new appointment|new booking|ny tid|neuer termin|nueva cita|nueva reserva|vaght jadid)\b/u,
    /(?:وقت جدید|رزرو جدید|موعد جديد|حجز جديد)/u,
  ];
  if (conflictingIntent.some(pattern => pattern.test(raw))) return false;

  const simpleAffirmative = /^(?:yes|yes please|yeah|yep|sure|correct|confirm|confirm it|book it|book that one|that works|that time|ok|okay|ja|ja tack|ja garna|ja bitte|ja gerne|japp|absolut|gerne|boka den|det blir bra|si|si por favor|si claro|claro|نعم|نعم من فضلك|اجل|موافق|بله|بله لطفا|اره|باشه|حتما|bale|baleh|bale lotfan|baleh lotfan|are|khobe|bashe|hamoon vaght|hamon vaght|همون وقت|همان وقت)$/u;
  if (simpleAffirmative.test(raw)) return true;

  const affirmativeWithPolitenessOnly = /^(?:yes|yeah|sure|ja|japp|si|claro|نعم|اجل|موافق|بله|اره|باشه|bale|baleh|are|bashe)(?: please| thanks| thank you| tack| garna| snalla| danke| gerne| bitte| gracias| por favor| شکرا| من فضلک| مرسی| ممنون| لطفا| متشکرم| سپاس| mersi| merci| mamnoon| mamnun| lotfan| sepas)+$/u;
  if (affirmativeWithPolitenessOnly.test(raw)) return true;

  const affirmativeAgreement = [
    /^ja(?: det)? (?:gar )?(?:fint|bra)(?: for mig)?$/u,
    /^yes (?:that )?(?:works|is fine)(?: for me)?$/u,
    /^ja (?:das )?(?:passt|ist gut)(?: fur mich)?$/u,
    /^si (?:esta bien|me va bien)(?: para mi)?$/u,
    /^(?:نعم|اجل|موافق) (?:هذا )?(?:مناسب|جيد)(?: لی)?$/u,
    /^(?:بله|اره|باشه) (?:خوبه|مناسبه|برای من خوبه)$/u,
    /^(?:bale|are|bashe) (?:khube|monasebe|baraye man khube)$/u,
  ];
  if (affirmativeAgreement.some(pattern => pattern.test(raw))) return true;

  const affirmativeLead = /^(?:yes|yeah|yep|sure|ja|japp|absolut|si|claro|نعم|اجل|موافق|بله|اره|باشه|bale|baleh|are|bashe)(?: please| tack| garna| لطفا)?(?=\s|$)/u;
  const confirmationContinuation =
    /\b(?:book|confirm|finalize|finish|information|details|great|perfect|wonderful|boka|bekrafta|slutfora|uppgifter|information|jattebra|perfekt|utmärkt|utmarkt|reserva|confirma|finalizar|reservar|buchen|bestatigen|abschliessen)\b/u.test(raw) ||
    /(?:رزرو|تایید|تکمیل|اطلاعات|عالی|خیلی خوب|احجز|تأكيد|إكمال|معلومات)/u.test(raw);
  const contactContinuation =
    /\b(?:my name is|name is|i am|i'm|mein name ist|ich hei(?:ss|ß)e|me llamo|mi nombre es|jag heter|mitt namn är|mitt namn ar|phone|phone number|telephone|telefon|telefonnummer|telefono|numero de telefono)\b/u.test(raw) ||
    /(?:اسم من|نام من|شماره من|شماره تلفن|اسمي|رقم هاتفي|رقم الهاتف)/u.test(raw) ||
    /(?:^|\s)\+?\d(?:[\s-]?\d){6,14}(?:\s|$)/u.test(raw);
  if (affirmativeLead.test(raw) && (confirmationContinuation || contactContinuation)) return true;

  const currentSlotContinuation = [
    /^(?:yes(?: please)? )?(?:please )?(?:book|confirm) it(?: for me)?$/u,
    /^(?:yes(?: please)? )?(?:please )?(?:book|confirm) (?:that|this|the same|same|the proposed|proposed|the selected|selected) (?:time|slot|appointment)$/u,
    /^yes (?:please )?(?:confirm|book) that appointment$/u,
    /^yes (?:that|the same) time works(?: please)? (?:book|confirm) it$/u,
    /^please (?:book|confirm) (?:that|this|the same|same) (?:time|slot|appointment)$/u,
    /^ja(?: tack| garna)? (?:boka|bekrafta) (?:den|det)(?: at mig)?$/u,
    /^ja(?: tack| garna)? boka (?:den tiden|samma tid|den)$/u,
    /^(?:den|samma) tiden passar boka den(?: garna)?$/u,
    /^ja(?: bitte)? buchen sie (?:diese zeit|diesen termin)$/u,
    /^ja buchen sie (?:diese zeit|diesen termin)$/u,
    /^ja der termin passt bitte buchen$/u,
    /^si(?: por favor)? reserva (?:esa hora|esa cita)$/u,
    /^si (?:esa hora|esa cita) esta bien (?:reserva|reservala|confirmala)$/u,
    /^نعم احجز (?:ذلک|نفس|هذا) الموعد(?: من فضلک)?$/u,
    /^نعم هذا الموعد مناسب احجزه$/u,
    /^(?:بله|اره|باشه)(?: لطفا)? (?:ان|آن|اون|این|همان|همون) را برای من رزرو (?:کنید|کن)$/u,
    /^(?:بله|اره|باشه)(?: لطفا)?(?: برای)? (?:همان|همون|همین|این) (?:زمان|ساعت|وقت)(?: را| رو)?(?: رزرو (?:کنید|کن))?$/u,
    /^(?:همان|همون|همین|این) (?:زمان|ساعت|وقت) (?:را|رو) رزرو (?:کنید|کن)$/u,
    /^(?:bale|baleh|are|bashe)(?: lotfan)?(?: baraye)? (?:hamoon|hamon) (?:saat|vaght)(?: ro)?(?: rezerv kon(?:id)?)?$/u,
    /^(?:hamoon|hamon) (?:saat|vaght) ro rezerv kon(?:id)?$/u,
  ];
  return currentSlotContinuation.some(pattern => pattern.test(raw));
}

export function beginBookingFinalization(pending: Record<string, any>): boolean {
  if (!['awaiting_contact', 'failed_recoverable'].includes(getBookingPhase(pending)) || !pending.dateTime || !pending.selectedSlotEnd) return false;
  pending.status = 'inserting';
  return true;
}

export function recoverBookingFinalization(pending: Record<string, any>, stage: BookingFailureStage, rollbackSucceeded?: boolean): void {
  pending.status = 'failed_recoverable';
  pending.lastFailureStage = stage;
  pending.failedStage = stage;
  pending.lastRollbackSucceeded = rollbackSucceeded ?? null;
  pending.expectedInput = 'retry_or_correction';
  pending.retryEligible = rollbackSucceeded !== false;
  pending.mutationProgress = {
    calendarStarted: !['availability', 'final_validation', 'unexpected'].includes(stage),
    calendarVerified: ['database_insert', 'database_verification', 'idempotency_settlement'].includes(stage),
    databaseStarted: ['database_insert', 'database_verification', 'idempotency_settlement'].includes(stage),
    databaseVerified: stage === 'idempotency_settlement',
    settlementStarted: stage === 'idempotency_settlement',
  };
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
