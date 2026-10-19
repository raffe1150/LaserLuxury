import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Temporary, business-info-only diagnostics. Never retain message contents,
// recipients, evidence, tokens, or factual verdicts here.
type NativeChannel = 'telegram' | 'whatsapp' | 'instagram' | 'messenger';
type Timing = { businessInfoTurnId: string; businessId: string | number | null; nativeChannel?: NativeChannel;
  startedAt: number; stages: Set<string>; events: number; sends: number };
const turns = new Map<string, Timing>();
const scope = new AsyncLocalStorage<{ timing?: Timing; nativeChannel?: NativeChannel; turnId?: string }>();
// Separate normal-stage and outbound allowances keep terminal transport events
// available even when stage instrumentation reaches its limit.
export const INFORMATION_TIMING_EVENT_LIMIT = 40;
export const INFORMATION_SEND_ATTEMPT_LIMIT = 8;
const stages = new Set(['received', 'language_complete', 'intent_and_state_ready', 'retrieval_start',
  'retrieval_complete', 'generation_start', 'grounding_start', 'grounding_complete', 'response_ready',
  'delivery_handoff', 'delivery_complete']);
const elapsed = (value: number) => Number.isFinite(value) ? Math.min(3_600_000, Math.max(0, Math.round(value))) : 0;
const status = (value: unknown) => Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : undefined;
const languages = new Set(['en', 'sv', 'de', 'es', 'fa', 'ar']);
const dispositions = new Set(['configured_facts_no_retrieval', 'retrieved']);

/** Optional telemetry only: never pass business work or transport operations here.
 * Do not log failures through the same possibly broken sink. Async observers are
 * not awaited and their rejection cannot escape into request processing. */
export function runOptionalDiagnostic(emit: () => unknown): void {
  try {
    const pending = emit();
    if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(pending).catch(() => {});
    }
  } catch { /* Dropping optional telemetry must not change execution. */ }
}

export function withBusinessInformationTiming<T>(work: () => Promise<T>, nativeChannel?: NativeChannel, turnId?: string): Promise<T> {
  const safeTurnId = typeof turnId === 'string' && /^[a-f0-9-]{36}$/iu.test(turnId) ? turnId : undefined;
  return scope.run({ nativeChannel, turnId: safeTurnId }, work);
}
/** Bind only before stage emission; optional telemetry must never alter execution. */
export function bindBusinessInformationTurnId(turnId:string):void {
  runOptionalDiagnostic(()=>{const request=scope.getStore();if(request && !request.timing && /^[a-f0-9-]{36}$/iu.test(turnId))request.turnId=turnId;});
}
function currentTiming(sessionId: string): Timing | undefined {
  if (!sessionId) return undefined; // Proactive sends must not inherit this turn.
  const request = scope.getStore();
  const timing = request ? request.timing : turns.get(sessionId);
  return timing && Date.now() - timing.startedAt <= 600_000 ? timing : undefined;
}
export function beginBusinessInformationTiming(sessionId: string, question: string, businessId: string | number | null) {
  const request = scope.getStore();
  if (request?.timing) return request.timing; // One ID, including mixed subplans.
  if (turns.size >= 1000) turns.delete(turns.keys().next().value!);
  const timing: Timing = { businessInfoTurnId: request?.turnId || randomUUID(),
    businessId: /^\d{1,12}$/u.test(String(businessId)) ? businessId : null,
    nativeChannel: request?.nativeChannel, startedAt: Date.now(), stages: new Set(), events: 0, sends: 0 };
  // Keep the legacy map for direct diagnostic/test callers only. Native turns
  // never read or write it, so overlapping sessions cannot replace their IDs.
  if (request) request.timing = timing; else turns.set(sessionId, timing);
  markBusinessInformationTiming(sessionId, 'received');
  return timing;
}
export function businessInformationTimingContext(sessionId: string) {
  const timing = currentTiming(sessionId);
  if (!timing) return {};
  return { businessInfoTurnId: timing.businessInfoTurnId };
}
export function clearBusinessInformationTiming(sessionId?: string) {
  if (sessionId === undefined) turns.clear(); else turns.delete(sessionId);
}
export function markBusinessInformationTiming(sessionId: string, stage: string, durationMs = 0,
  details: { language?: string; disposition?: string; success?: boolean; httpStatus?: number } = {}) {
  const timing = currentTiming(sessionId);
  markTiming(timing, stage, durationMs, details);
}
function markTiming(timing: Timing | undefined, stage: string, durationMs = 0,
  details: { language?: string; disposition?: string; success?: boolean; httpStatus?: number } = {}) {
  runOptionalDiagnostic(() => {
    if (!timing || !stages.has(stage) || timing.events >= INFORMATION_TIMING_EVENT_LIMIT) return;
    timing.events++;
    timing.stages.add(stage);
    return console.info('[BusinessInformationTiming]', { schemaVersion: 'knowledge-timing-v1', businessInfoTurnId: timing.businessInfoTurnId,
      businessId: timing.businessId, nativeChannel: timing.nativeChannel || 'internal',
      ...(stage === 'delivery_complete' ? { completionScope: 'transport_call', customerDelivery: 'unconfirmed' } : {}),
      stage, durationMs: elapsed(durationMs), elapsedMs: elapsed(Date.now() - timing.startedAt),
      ...(languages.has(details.language) ? { language: details.language } : {}),
      ...(dispositions.has(details.disposition) ? { disposition: details.disposition } : {}),
      ...(typeof details.success === 'boolean' ? { success: details.success } : {}),
      ...(status(details.httpStatus) === undefined ? {} : { httpStatus: status(details.httpStatus) }) });
  });
}

type SendAttempt = { timing: Timing; attempt: number; startedAt: number; complete: boolean };
const responses = new WeakMap<object, SendAttempt>();
function sendEvent(send: SendAttempt, event: Record<string, unknown>) {
  runOptionalDiagnostic(() => {
    return console.info('[BusinessInformationOutbound]', JSON.stringify({ schemaVersion: 'knowledge-outbound-v1',
      businessInfoTurnId: send.timing.businessInfoTurnId, nativeChannel: send.timing.nativeChannel || 'internal', sendAttempt: send.attempt,
      durationMs: elapsed(Date.now() - send.startedAt), customerDelivery: 'unconfirmed', ...event }));
  });
}
/** Observe the existing adapter decision without parsing/consuming its response. */
export function recordBusinessInformationSendResult(response: object, applicationAccepted: boolean,
  providerAcceptance: 'accepted' | 'rejected' | 'unknown' = 'unknown') {
  runOptionalDiagnostic(() => {
    const send = responses.get(response);
    if (!send || send.complete) return;
    send.complete = true;
    const code = 'status' in response ? status(response.status) : undefined;
    sendEvent(send, { eventType: 'application_result', applicationAccepted: applicationAccepted === true,
      providerAcceptance: code !== undefined && code >= 400 ? 'rejected'
        : ['accepted', 'rejected'].includes(providerAcceptance) ? providerAcceptance : 'unknown' });
  });
}
export async function timeBusinessInformationDelivery<T>(sessionId: string, delivery: () => Promise<T>, stage = 'delivery'): Promise<T> {
  let timing: Timing | undefined, send: SendAttempt | undefined;
  let started = 0, success = false, httpStatus: number | undefined;
  runOptionalDiagnostic(() => {
    timing = currentTiming(sessionId);
    started = Date.now();
    send = timing && timing.sends < INFORMATION_SEND_ATTEMPT_LIMIT
      ? { timing, attempt: ++timing.sends, startedAt: started, complete: false } : undefined;
    if (!timing?.stages.has('response_ready')) markTiming(timing, 'response_ready');
    markTiming(timing, `${stage}_handoff`);
    if (send) sendEvent(send, { eventType: 'send_attempt' });
  });
  try {
    // This operation is deliberately outside the telemetry failure boundary.
    const result = await delivery();
    runOptionalDiagnostic(() => {
      if (send) {
        if (result && typeof result === 'object') responses.set(result, send);
        const code = result && typeof result === 'object' && 'status' in result ? status(result.status) : undefined;
        sendEvent(send, { eventType: 'http_response', ...(code === undefined ? {} : { httpStatus: code }),
          providerAcceptance: code !== undefined && code >= 400 ? 'rejected' : 'unknown' });
      }
      success = result !== false;
      if (result && typeof result === 'object' && 'ok' in result && 'status' in result) {
        success = result.ok === true;
        if (typeof result.status === 'number') httpStatus = result.status;
      }
    });
    return result;
  } catch (error) {
    if (send) sendEvent(send, { eventType: 'transport_exception', providerAcceptance: 'unknown' });
    throw error;
  } finally {
    runOptionalDiagnostic(() => markTiming(timing, `${stage}_complete`, Date.now() - started,
      { success, ...(httpStatus === undefined ? {} : { httpStatus }) }));
  }
}
