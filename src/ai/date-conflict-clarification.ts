import { createHash } from 'node:crypto';
import {
  normalizeConversationText,
  type NormalizedBookingRequest,
  type NormalizedTimeConstraint,
} from './booking-intelligence';

export type DateConflictClarificationStage =
  | 'initial'
  | 'explicit_choice'
  | 'bounded_recovery'
  | 'terminal_recovery'
  | 'suppressed_duplicate';

export type DateConflictClarificationState = {
  version: 1;
  kind: 'weekday_explicit_date_conflict';
  candidate1: string;
  candidate2: string;
  requestedWeekday: number;
  conflictFingerprint: string;
  initialInputFingerprint: string;
  lastUnresolvedInputFingerprint: string;
  attemptCount: number;
  expectedResponse: 'candidate_or_unambiguous_date';
  previousExpectedInput: string | null;
  ownsPendingShell: boolean;
  proposedTimeConstraint?: NormalizedTimeConstraint;
  proposedService?: { normalized?: string; confidence: 'high' | 'medium' | 'low' };
};

type DateConflict = NonNullable<NormalizedBookingRequest['dateConflict']>;

function stableFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function fingerprintDateConflict(conflict: DateConflict): string {
  return stableFingerprint([
    conflict.kind,
    conflict.explicitDate,
    conflict.weekdayDate,
    conflict.requestedWeekday,
  ].join(':'));
}

export function fingerprintClarificationInput(text: string): string {
  return stableFingerprint(normalizeConversationText(text).toLowerCase());
}

export function isDateConflictClarificationState(value: unknown): value is DateConflictClarificationState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    state.kind === 'weekday_explicit_date_conflict' &&
    /^20\d{2}-\d{2}-\d{2}$/.test(String(state.candidate1 || '')) &&
    /^20\d{2}-\d{2}-\d{2}$/.test(String(state.candidate2 || '')) &&
    Number.isInteger(Number(state.requestedWeekday)) &&
    Number(state.requestedWeekday) >= 0 &&
    Number(state.requestedWeekday) <= 6 &&
    typeof state.conflictFingerprint === 'string' &&
    typeof state.initialInputFingerprint === 'string' &&
    typeof state.lastUnresolvedInputFingerprint === 'string' &&
    Number.isInteger(Number(state.attemptCount)) &&
    Number(state.attemptCount) >= 1 &&
    Number(state.attemptCount) <= 4 &&
    state.expectedResponse === 'candidate_or_unambiguous_date';
}

function stageForAttempt(attemptCount: number): DateConflictClarificationStage {
  if (attemptCount <= 1) return 'initial';
  if (attemptCount === 2) return 'explicit_choice';
  if (attemptCount === 3) return 'bounded_recovery';
  return 'terminal_recovery';
}

export function beginOrAdvanceDateConflictClarification(params: {
  existing?: unknown;
  conflict: DateConflict;
  input: string;
  previousExpectedInput?: string | null;
  ownsPendingShell: boolean;
  proposedTimeConstraint?: NormalizedTimeConstraint;
  proposedService?: NormalizedBookingRequest['service'];
}): { state: DateConflictClarificationState; stage: DateConflictClarificationStage } {
  const conflictFingerprint = fingerprintDateConflict(params.conflict);
  const inputFingerprint = fingerprintClarificationInput(params.input);
  const existing = isDateConflictClarificationState(params.existing) &&
    params.existing.conflictFingerprint === conflictFingerprint
      ? params.existing
      : null;

  if (
    existing &&
    existing.attemptCount >= 4 &&
    existing.lastUnresolvedInputFingerprint === inputFingerprint
  ) {
    return { state: existing, stage: 'suppressed_duplicate' };
  }

  const attemptCount = existing ? Math.min(4, existing.attemptCount + 1) : 1;
  const proposedService = params.proposedService
    ? {
        ...(params.proposedService.normalized ? { normalized: params.proposedService.normalized } : {}),
        confidence: params.proposedService.confidence,
      }
    : existing?.proposedService;
  const state: DateConflictClarificationState = {
    version: 1,
    kind: 'weekday_explicit_date_conflict',
    candidate1: params.conflict.explicitDate,
    candidate2: params.conflict.weekdayDate,
    requestedWeekday: params.conflict.requestedWeekday,
    conflictFingerprint,
    initialInputFingerprint: existing?.initialInputFingerprint || inputFingerprint,
    lastUnresolvedInputFingerprint: inputFingerprint,
    attemptCount,
    expectedResponse: 'candidate_or_unambiguous_date',
    previousExpectedInput: existing?.previousExpectedInput ?? params.previousExpectedInput ?? null,
    ownsPendingShell: existing?.ownsPendingShell ?? params.ownsPendingShell,
    ...(params.proposedTimeConstraint || existing?.proposedTimeConstraint
      ? { proposedTimeConstraint: params.proposedTimeConstraint || existing?.proposedTimeConstraint }
      : {}),
    ...(proposedService ? { proposedService } : {}),
  };
  return { state, stage: stageForAttempt(attemptCount) };
}

export function advanceUnresolvedDateConflictClarification(
  existing: DateConflictClarificationState,
  input: string,
): { state: DateConflictClarificationState; stage: DateConflictClarificationStage } {
  const inputFingerprint = fingerprintClarificationInput(input);
  if (
    existing.attemptCount >= 4 &&
    existing.lastUnresolvedInputFingerprint === inputFingerprint
  ) {
    return { state: existing, stage: 'suppressed_duplicate' };
  }
  const attemptCount = Math.min(4, existing.attemptCount + 1);
  return {
    state: {
      ...existing,
      attemptCount,
      lastUnresolvedInputFingerprint: inputFingerprint,
    },
    stage: stageForAttempt(attemptCount),
  };
}

function explicitChoice(text: string): 1 | 2 | null {
  const normalized = normalizeConversationText(text).toLowerCase().trim();
  const match = normalized.match(
    /^(?:(?:option|choice|alternativ(?:et)?|opci[oó]n|گزینه|انتخاب|الخيار|خيار)\s*)?(?:number|nummer|n[uú]mero|رقم\s*)?([12])$/iu,
  );
  return match ? Number(match[1]) as 1 | 2 : null;
}

export function resolveDateConflictClarification(params: {
  state: DateConflictClarificationState;
  input: string;
  normalizedRequest: NormalizedBookingRequest;
}): { date: string; source: 'candidate_1' | 'candidate_2' | 'unambiguous_date' } | null {
  const choice = explicitChoice(params.input);
  if (choice === 1) return { date: params.state.candidate1, source: 'candidate_1' };
  if (choice === 2) return { date: params.state.candidate2, source: 'candidate_2' };

  const parsedDate = params.normalizedRequest.date?.value;
  if (!parsedDate || params.normalizedRequest.requiresClarification) return null;
  if (parsedDate === params.state.candidate1) return { date: parsedDate, source: 'candidate_1' };
  if (parsedDate === params.state.candidate2) return { date: parsedDate, source: 'candidate_2' };
  return { date: parsedDate, source: 'unambiguous_date' };
}

function localeForLanguage(language: string): string {
  if (language === 'sv') return 'sv-SE';
  if (language === 'fa') return 'fa-IR';
  if (language === 'de') return 'de-DE';
  if (language === 'es') return 'es-ES';
  if (language === 'ar') return 'ar';
  return 'en-GB';
}

function describeDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function formatDateConflictClarification(
  state: DateConflictClarificationState,
  language: string,
  stage: Exclude<DateConflictClarificationStage, 'suppressed_duplicate'>,
): string {
  const first = describeDate(state.candidate1, language);
  const second = describeDate(state.candidate2, language);

  if (stage === 'initial') {
    if (language === 'sv') return `Menar du ${first} eller ${second}?`;
    if (language === 'fa') return `منظورتان ${first} است یا ${second}؟`;
    if (language === 'de') return `Meinen Sie ${first} oder ${second}?`;
    if (language === 'es') return `¿Te refieres al ${first} o al ${second}?`;
    if (language === 'ar') return `هل تقصد ${first} أم ${second}؟`;
    return `Do you mean ${first} or ${second}?`;
  }
  if (stage === 'explicit_choice') {
    if (language === 'sv') return `Svara 1 för ${first} eller 2 för ${second}.`;
    if (language === 'fa') return `لطفاً برای ${first} عدد ۱ و برای ${second} عدد ۲ را بفرستید.`;
    if (language === 'de') return `Bitte antworten Sie mit 1 für ${first} oder 2 für ${second}.`;
    if (language === 'es') return `Responde 1 para ${first} o 2 para ${second}.`;
    if (language === 'ar') return `يرجى الرد بـ ١ لـ ${first} أو ٢ لـ ${second}.`;
    return `Please reply 1 for ${first} or 2 for ${second}.`;
  }
  if (stage === 'bounded_recovery') {
    if (language === 'sv') return `Jag kan fortfarande inte avgöra datumet säkert. Svara bara 1 för ${first}, 2 för ${second}, eller skicka ett nytt entydigt kalenderdatum.`;
    if (language === 'fa') return `هنوز نمی‌توانم تاریخ را با اطمینان مشخص کنم. فقط ۱ برای ${first}، ۲ برای ${second} یا یک تاریخ تقویمی جدید و بدون ابهام بفرستید.`;
    if (language === 'de') return `Ich kann das Datum weiterhin nicht sicher bestimmen. Antworten Sie nur mit 1 für ${first}, 2 für ${second} oder senden Sie ein neues eindeutiges Kalenderdatum.`;
    if (language === 'es') return `Todavía no puedo determinar la fecha con seguridad. Responde solo 1 para ${first}, 2 para ${second}, o envía una nueva fecha de calendario sin ambigüedad.`;
    if (language === 'ar') return `ما زلت لا أستطيع تحديد التاريخ بأمان. أرسل فقط ١ لـ ${first}، أو ٢ لـ ${second}، أو تاريخًا تقويميًا جديدًا وواضحًا.`;
    return `I still can’t resolve the date safely. Reply only 1 for ${first}, 2 for ${second}, or send a new unambiguous calendar date.`;
  }

  if (language === 'sv') return `Jag kan inte välja datum åt dig. Skicka bara 1, 2 eller ett nytt datum, till exempel ${state.candidate1}.`;
  if (language === 'fa') return `نمی‌توانم تاریخ را به جای شما انتخاب کنم. فقط ۱، ۲ یا یک تاریخ جدید مثل ${state.candidate1} بفرستید.`;
  if (language === 'de') return `Ich kann das Datum nicht für Sie auswählen. Senden Sie nur 1, 2 oder ein neues Datum, zum Beispiel ${state.candidate1}.`;
  if (language === 'es') return `No puedo elegir la fecha por ti. Envía solo 1, 2 o una fecha nueva, por ejemplo ${state.candidate1}.`;
  if (language === 'ar') return `لا يمكنني اختيار التاريخ نيابةً عنك. أرسل فقط ١ أو ٢ أو تاريخًا جديدًا مثل ${state.candidate1}.`;
  return `I can’t choose the date for you. Send only 1, 2, or a new date such as ${state.candidate1}.`;
}
