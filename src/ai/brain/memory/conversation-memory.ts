import { createHash } from 'node:crypto';
import { resolveLanguageBrain, type ResolveLanguageBrainInput } from '../../language-brain';
import { getDateInTimeZone, normalizeBookingRequest } from '../../booking-intelligence';
import { hasBookingInterruption } from '../../booking-interruption';
import { businessInformationTopics } from '../../business-information';
import type { ResolvedObligation } from '../decide-turn';
import { SEMANTIC_LIMITS as limits, type Binding, type Catalog, type Field, type InterpretationRequest, type Missing,
  type Parameter, type Reading, type Span } from '../semantic/contracts';
import { catalogId, excerpt, fields, isRoute, literalReading, parsedDate, parsedTime, parseInterpretation } from '../semantic/interpret';
import type { Goal, Guidance, ObligationState, TurnFrame } from './turn-frame';

export type TurnContext = Readonly<{
  binding: Binding;
  turn: number; // ordered, server-assigned sequence
  nowMs: number;
  timezone: string;
  catalog: Catalog;
  language?: Partial<Pick<ResolveLanguageBrainInput, 'businessFallback' | 'explicitSwitch' | 'deterministicLanguage' | 'preservePrevious'>>;
  reset?: boolean;
}>;
type Prepared = Readonly<{ request: InterpretationRequest | null }>;
type Draft = { frame?: TurnFrame; context: TurnContext; request: InterpretationRequest | null; language: TurnFrame['language'] };
export type TurnResult = Readonly<{
  frame: TurnFrame;
  interpretation: 'SCRIPTED_OR_MODEL_PROPOSAL' | 'DETERMINISTIC' | 'UNRESOLVED_INPUT';
  readings: readonly Reading[];
  guidance: readonly Guidance[];
  repeatedQuestion: boolean;
}>;
type Memo = Readonly<{ digest?: string; goalIds: readonly string[]; atMs: number }>;
const frames = new WeakMap<TurnFrame, Memo>();
const prepared = new WeakMap<Prepared, Draft>();
const turnResults = new WeakSet<TurnResult>();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function bindingMatches(a: Binding, b: Binding) {
  return a.tenantId === b.tenantId && a.conversationId === b.conversationId;
}

function checkContext(frame: TurnFrame | undefined, context: TurnContext) {
  const { binding, turn, nowMs } = context;
  if (!Number.isSafeInteger(binding.tenantId) || binding.tenantId < 1 || typeof binding.conversationId !== 'string' ||
      !binding.conversationId.length || binding.conversationId.length > 128 ||
      !Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8.64e15)
    throw new Error('INVALID_TRUSTED_CONTEXT');
  if (frame && (!frames.has(frame) || !bindingMatches(frame.binding, binding))) throw new Error('MEMORY_SCOPE_MISMATCH');
  if (frame && (turn <= frame.turn || nowMs < frame.updatedAtMs)) throw new Error('TURN_OUT_OF_ORDER');
}

/** Prepare a frozen, ephemeral model request. The model sees opaque option
 * indexes and semantic summaries, and supplies no server scope or language. */
export async function prepareTurn(frame: TurnFrame | undefined, context: TurnContext, text: string): Promise<Prepared> {
  checkContext(frame, context);
  context = freeze(structuredClone(context));
  const prior = context.reset ? undefined : frame;
  const language = await resolveLanguageBrain({
    text: '', previousLanguage: prior?.language.language, businessFallback: context.language?.businessFallback,
    explicitSwitch: context.language?.explicitSwitch, deterministicLanguage: context.language?.deterministicLanguage,
    preservePrevious: context.language?.preservePrevious ?? true, semanticEligible: false,
  });
  const goals = liveGoals(prior, context);
  const request: InterpretationRequest | null = text.length <= limits.inputChars && text.trim()
    ? freeze({ version: 1, text, language: language.language, references: goals.map(g => ({
        goalId: g.id, kind: g.kind, intent: g.intent, lastTurn: g.lastTurn, parameters: g.parameters, topics: g.topics,
        questionTypes: g.obligations.flatMap(o => o.questionType ? [o.questionType] : []),
        waitingFor: g.pending ? [g.pending.field] : [],
      })), limits: { obligations: limits.obligations, conditionsPerObligation: limits.conditions, outputChars: limits.proposalChars } })
    : null;
  const handle = Object.freeze({ request });
  prepared.set(handle, { frame: prior, context, request, language });
  return handle;
}

function liveGoals(frame: TurnFrame | undefined, context: TurnContext): Goal[] {
  const localDate = getDateInTimeZone(new Date(context.nowMs), context.timezone);
  return (frame?.lifecycle === 'OPEN' ? frame.goals : []).filter(g => context.nowMs - g.updatedAtMs <= limits.taskMs)
    .map(g => {
      const parameters = Object.fromEntries(Object.entries(g.parameters).filter(([field, p]) => {
        if (context.nowMs - p.atMs > limits.taskMs) return false;
        if (field === 'service' || field === 'staff') {
          const list = field === 'service' ? context.catalog.services : context.catalog.staff;
          return list.filter(item => item.id === p.value).length === 1;
        }
        if (field === 'date' && typeof p.value === 'object' && 'value' in p.value)
          return (p.value.endValue ?? p.value.value ?? '') >= localDate;
        return true;
      }));
      // Old Knowledge review is never carried into a new turn.
      const obligations = g.obligations.map(o => ({ ...o, evidence: 'UNVERIFIED' as const }));
      return { ...g, parameters, obligations };
    });
}

function interpretParameters(reading: Reading, request: InterpretationRequest, context: TurnContext, fallback: boolean) {
  const params: Partial<Record<Field, Parameter>> = {};
  let conflict = false;
  for (const field of fields) {
    if (reading.intent === 'correction' && !reading.change?.includes(field)) continue;
    const anchor: Span | undefined = reading.entities?.[field];
    if (!anchor) continue;
    const text = excerpt(request.text, anchor);
    const value = field === 'date' ? parsedDate(text, context.timezone, new Date(context.nowMs))
      : field === 'time' ? parsedTime(text)
      : catalogId(text, field === 'service' ? context.catalog.services : context.catalog.staff);
    if (value === 'conflict' && field === 'date') { conflict = true; continue; }
    if (field === 'date' && typeof value === 'object' && 'value' in value &&
        (value.endValue ?? value.value ?? '') < getDateInTimeZone(new Date(context.nowMs), context.timezone)) {
      conflict = true;
      continue;
    }
    if (value !== undefined) params[field] = { value, turn: context.turn, atMs: context.nowMs,
      provenance: fallback ? 'USER_STATED' : 'USER_SPAN_INTERPRETED' };
  }
  return { params, conflict };
}

function hasUnresolvedBookingTime(text: string, context: TurnContext) {
  return normalizeBookingRequest({ text, businessId: context.binding.tenantId, channel: 'offline',
    conversationKey: context.binding.conversationId, inputMode: 'text', timezone: context.timezone,
    now: new Date(context.nowMs) }).requiresClarification;
}

function storeFrame(frame: TurnFrame, memo: Memo): TurnFrame {
  if (Buffer.byteLength(JSON.stringify(frame)) > limits.frameBytes) throw new Error('TURN_FRAME_SIZE_LIMIT');
  const frozen = freeze(frame);
  frames.set(frozen, memo);
  return frozen;
}

/** Consume one prepared request with at most one untrusted response. The
 * resulting frame is an immutable process-local value. */
export function finishTurn(handle: Prepared, wire?: unknown): TurnResult {
  const draft = prepared.get(handle);
  if (!draft) throw new Error('INVALID_OR_CONSUMED_TURN');
  prepared.delete(handle);
  const { context, frame: previous, request, language } = draft;
  const { turn, nowMs } = context;
  const proposal = request ? parseInterpretation(wire, request) : null;
  const readings: Reading[] = proposal ?? (request && wire === undefined
    ? literalReading(request, context.catalog) : [{ intent: 'unknown', span: { start: 0, end: request?.text.length ?? 0 }, missing: 'intent' }]);
  const guidance: Guidance[] = [];
  const referenced = new Set<string>();
  const goals = liveGoals(previous, context);
  const optionIds = request?.references.map(r => r.goalId) ?? [];
  const priorMemo = previous ? frames.get(previous) : undefined;
  const digest = request && readings.every(r => r.intent === 'general_question') ? createHash('sha256').update(request.text.normalize('NFKC').trim().toLowerCase()).digest('hex') : undefined;
  const repeatedQuestion = !!digest && digest === priorMemo?.digest && nowMs - priorMemo.atMs <= limits.recentMs &&
    readings.every(r => r.intent === 'general_question');
  let activeGoalId = goals.find(g => g.id === previous?.activeGoalId)?.id;
  let corrections = (previous?.corrections ?? []).filter(c => nowMs - c.previous.atMs <= limits.taskMs);
  const closed = readings[0].intent === 'close';
  const touched: string[] = [];
  const bookingReadings = readings.filter(r => isRoute(r.intent) || r.intent === 'correction');
  const obligations: string[] = [];
  let informationGoalId: string | undefined;
  for (const [index, reading] of readings.entries()) {
    const id = `t${turn}o${index + 1}`;
    obligations.push(id);
    if (closed) { guidance.push({ kind: 'CLOSE', obligationId: id }); break; }
    const negatedAction = isRoute(reading.intent) && reading.polarity === 'negative';
    const kind = isRoute(reading.intent) || reading.intent === 'correction' ? 'booking' : 'information';
    const explicitGoal = reading.reference === undefined ? undefined : goals.find(g => g.id === optionIds[reading.reference]);
    const repeatedGoal = repeatedQuestion && priorMemo ? goals.find(g => g.id === priorMemo.goalIds[index]) : undefined;
    const unknownGoal = reading.intent === 'unknown' ? goals.find(g => g.id === activeGoalId && g.kind === 'information' && g.intent === 'unknown') : undefined;
    const siblingGoal = kind === 'information' && reading.intent === 'general_question' ? goals.find(g => g.id === informationGoalId) : undefined;
    const ref = explicitGoal ?? repeatedGoal ?? unknownGoal ?? siblingGoal;
    const compatibleRef = !negatedAction && ref?.kind === kind && (kind === 'information' ||
      (ref.obligations.some(o => o.polarity !== 'negative') &&
        (reading.intent === 'correction' || reading.intent === ref.intent))) ? ref : undefined;
    if (explicitGoal && compatibleRef) referenced.add(explicitGoal.id);
    const goalId = compatibleRef?.id ?? id;
    touched.push(goalId);
    if (kind === 'information' && reading.intent === 'general_question' && !explicitGoal) informationGoalId = goalId;
    let missing = reading.missing;
    if (request && reading.intent === 'unknown' && reading.entities?.date &&
        parsedDate(excerpt(request.text, reading.entities.date), context.timezone, new Date(nowMs)) === 'conflict')
      missing = 'conflict';
    if (reading.reference !== undefined && !compatibleRef || reading.intent === 'correction' && !compatibleRef) missing = 'reference';
    if (bookingReadings.length > 1 && kind === 'booking') missing = 'conflict';
    if (kind === 'booking' && reading.conditions?.length) missing ??= 'intent';
    if (kind === 'booking' && request && hasBookingInterruption(excerpt(request.text, reading.span))) missing ??= 'intent';
    const next = request && !negatedAction && reading.intent !== 'unknown' && missing !== 'reference' && missing !== 'conflict'
      ? interpretParameters(reading, request, context, !proposal) : { params: {}, conflict: false };
    if (next.conflict) missing = 'conflict';
    if (reading.intent === 'correction' && !Object.keys(next.params).length) missing ??= 'intent';
    if (proposal && reading.intent === 'correction') {
      const missingChange = reading.change?.find(field => !next.params[field]);
      if (missingChange) missing ??= missingChange;
    }
    const retained = compatibleRef?.parameters ?? {};
    const blockedUpdate = missing === 'reference' || missing === 'conflict' || missing === 'intent' && kind === 'booking' ||
      reading.intent === 'correction' && !!missing;
    const parameters = blockedUpdate ? retained : { ...retained, ...next.params };
    if (!blockedUpdate && missing && fields.includes(missing as Field) &&
        (!reading.entities?.[missing as Field] || next.params[missing as Field]) && parameters[missing as Field]) missing = undefined;
    if (reading.intent === 'new_booking' && !parameters.service) missing ??= 'service';
    if (reading.intent === 'new_booking' && !parameters.date) missing ??= 'date';
    if (isRoute(reading.intent) && reading.entities?.time && !next.params.time &&
        (proposal || hasUnresolvedBookingTime(request!.text, context))) missing ??= 'time';
    if (reading.intent === 'new_booking' && !missing && compatibleRef?.pending &&
        !next.params[compatibleRef.pending.field as Field]) missing = compatibleRef.pending.field;
    if (reading.intent === 'new_booking' && reading.entities?.staff && !next.params.staff && proposal) missing ??= 'staff';
    let pending: Goal['pending'];
    if (negatedAction) {
      guidance.push({ kind: 'NO_BOOKING_ACTION', obligationId: id });
    } else if (missing) {
      const earlier = compatibleRef?.pending;
      const repeats = earlier?.field === missing;
      pending = { field: missing, firstTurn: repeats ? earlier.firstTurn : turn, lastTurn: turn };
      guidance.push({ kind: repeats ? 'WAIT_FOR_CLARIFICATION' : 'ASK', obligationId: id, field: missing });
    } else if (reading.intent === 'correction') {
      if (compatibleRef?.pending && !next.params[compatibleRef.pending.field as Field]) pending = compatibleRef.pending;
      const updated = fields.filter(field => next.params[field] !== undefined);
      for (const field of updated) {
        const prior = retained[field];
        if (prior && JSON.stringify(prior.value) !== JSON.stringify(next.params[field]?.value))
          corrections = [...corrections, { turn, goalId, field, previous: prior }].slice(-limits.corrections);
      }
      guidance.push({ kind: 'CORRECTION', obligationId: id, goalId, updated });
    } else if (isRoute(reading.intent)) {
      guidance.push({ kind: 'REFER_TO_BOOKING_AUTHORITY', obligationId: id, route: reading.intent });
    } else {
      guidance.push({ kind: 'CHECK_KNOWLEDGE', obligationId: id });
    }
    const obligation: ObligationState = { id, intent: reading.intent, questionType: reading.questionType, polarity: reading.polarity,
      hasSuspectedPremise: !!reading.premise, conditions: (reading.conditions ?? []).map(({ kind, explicit }) => ({ kind, explicit })),
      evidence: 'UNVERIFIED', state: 'OPEN' };
    const topics = kind === 'information' && request
      ? [...new Set([...(compatibleRef?.topics ?? []), ...businessInformationTopics(excerpt(request.text, reading.span))])]
      : [];
    const goal: Goal = { id: goalId, kind, intent: reading.intent === 'correction' ? compatibleRef?.intent ?? 'unknown' : reading.intent,
      lastTurn: turn, updatedAtMs: nowMs, parameters, topics, obligations: [...(compatibleRef?.obligations ?? []), obligation].slice(-limits.goalObligations), pending };
    const goalIndex = goals.findIndex(g => g.id === goalId);
    if (goalIndex >= 0) goals.splice(goalIndex, 1);
    goals.push(goal);
    activeGoalId = goal.id;
  }
  const primary = readings[0].intent;
  const secondary = [...new Set(readings.slice(1).map(r => r.intent))].filter(i => i !== primary);
  const recent = [...(previous?.lifecycle === 'OPEN' ? previous.recent : []).filter(r => nowMs - r.atMs <= limits.recentMs),
    { turn, atMs: nowMs, primary, secondary, referencedGoalIds: [...referenced], obligationIds: obligations }].slice(-limits.recentTurns);
  const activeGoals = closed ? [] : goals.slice(-limits.goals);
  const frame = storeFrame({ version: 1, binding: context.binding, turn, updatedAtMs: nowMs, language,
    lifecycle: closed ? 'CLOSED' : 'OPEN', currentIntent: primary,
    previousIntent: previous?.lifecycle === 'OPEN' ? previous.currentIntent : undefined,
    activeGoalId: closed ? undefined : activeGoalId, goals: activeGoals,
    recent: closed ? [] : recent, corrections: closed ? [] : corrections.filter(c => activeGoals.some(g => g.id === c.goalId)),
  }, { digest: closed ? undefined : digest, atMs: nowMs, goalIds: closed ? [] : touched });
  const result: TurnResult = freeze({ frame, readings, guidance, repeatedQuestion,
    interpretation: proposal ? 'SCRIPTED_OR_MODEL_PROPOSAL' : readings[0].intent !== 'unknown' ? 'DETERMINISTIC' : 'UNRESOLVED_INPUT' });
  turnResults.add(result);
  return result;
}

/** This argument belongs only to the trusted evidence caller, after existing
 * Knowledge checks. It cannot be supplied by the interpretation response. */
export function applyKnowledgeAssessment(result: TurnResult, assessment: Readonly<{
  binding: Binding; turn: number; obligationId: string; status: 'VERIFIED_FOR_TURN' | 'UNSUPPORTED';
}>): TurnResult {
  const { frame } = result;
  const memo = frames.get(frame);
  if (!turnResults.has(result) || !memo || !bindingMatches(frame.binding, assessment.binding) || frame.turn !== assessment.turn ||
      !frame.goals.some(g => g.obligations.some(o => o.id === assessment.obligationId)) ||
      !result.guidance.some(g => g.kind === 'CHECK_KNOWLEDGE' && g.obligationId === assessment.obligationId) ||
      (assessment.status !== 'VERIFIED_FOR_TURN' && assessment.status !== 'UNSUPPORTED')) throw new Error('ASSESSMENT_SCOPE_MISMATCH');
  const goals = frame.goals.map(g => ({ ...g, obligations: g.obligations.map(o => o.id === assessment.obligationId
    ? { ...o, state: 'RESOLVED' as const, evidence: assessment.status } : o) }));
  const guidance: Guidance[] = result.guidance.map(g => g.obligationId !== assessment.obligationId ? g
    : { obligationId: g.obligationId, kind: assessment.status === 'VERIFIED_FOR_TURN' ? 'ANSWER_CANDIDATE' : 'DISCLOSE_UNSUPPORTED' });
  const updated = freeze({ ...result, guidance, frame: storeFrame({ ...frame, goals }, memo) });
  turnResults.add(updated);
  return updated;
}

/** Type-only preview for Phase 4. Semantic state never supplies coverage,
 * conflicts or facts to the offline decision engine. */
export function policyReferences(result: TurnResult): ResolvedObligation[] {
  return result.guidance.flatMap(g => {
    if (g.kind === 'CLOSE' || g.kind === 'CORRECTION' || g.kind === 'NO_BOOKING_ACTION') return [];
    const resolution = g.kind === 'REFER_TO_BOOKING_AUTHORITY' ? 'BOOKING_ACTION'
      : g.kind === 'ASK' || g.kind === 'WAIT_FOR_CLARIFICATION' ? 'AMBIGUOUS' : 'KNOWLEDGE';
    return [{ id: g.obligationId, resolution, coverage: 'UNKNOWN', conflict: 'UNKNOWN', requiredFactIds: [],
      ...(g.kind === 'REFER_TO_BOOKING_AUTHORITY' ? { route: g.route } : {}) }];
  });
}
