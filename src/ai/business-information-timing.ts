import { createHash, randomUUID } from 'node:crypto';

// Temporary, business-info-only diagnostics. Never retain message contents,
// recipients, evidence, tokens, or factual verdicts here.
type Timing = { businessInfoTurnId: string; businessId: string | number | null;
  questionFingerprint: string; startedAt: number; stages: Set<string> };
const turns = new Map<string, Timing>();
export function beginBusinessInformationTiming(sessionId: string, question: string, businessId: string | number | null) {
  if (turns.size >= 1000) turns.delete(turns.keys().next().value!);
  const timing: Timing = { businessInfoTurnId: randomUUID(), businessId,
    questionFingerprint: createHash('sha256').update(question).digest('hex').slice(0, 12),
    startedAt: Date.now(), stages: new Set() };
  turns.set(sessionId, timing);
  markBusinessInformationTiming(sessionId, 'received');
  return timing;
}
export function businessInformationTimingContext(sessionId: string) {
  const timing = turns.get(sessionId);
  if (!timing || Date.now() - timing.startedAt > 600_000) { turns.delete(sessionId); return {}; }
  return { businessInfoTurnId: timing.businessInfoTurnId };
}
export function clearBusinessInformationTiming(sessionId?: string) {
  if (sessionId === undefined) turns.clear(); else turns.delete(sessionId);
}
export function markBusinessInformationTiming(sessionId: string, stage: string, durationMs = 0,
  details: { language?: string; disposition?: string; success?: boolean; httpStatus?: number } = {}) {
  const timing = turns.get(sessionId);
  if (!businessInformationTimingContext(sessionId).businessInfoTurnId || !timing) return;
  timing.stages.add(stage);
  console.info('[BusinessInformationTiming]', { businessInfoTurnId: timing.businessInfoTurnId,
    businessId: timing.businessId, questionFingerprint: timing.questionFingerprint,
    stage, durationMs, elapsedMs: Date.now() - timing.startedAt, ...details });
}
export async function timeBusinessInformationDelivery<T>(sessionId: string, delivery: () => Promise<T>, stage = 'delivery'): Promise<T> {
  const timing = turns.get(sessionId);
  if (!timing?.stages.has('response_ready')) markBusinessInformationTiming(sessionId, 'response_ready');
  markBusinessInformationTiming(sessionId, `${stage}_handoff`);
  const started = Date.now();
  let success = false, httpStatus: number | undefined;
  try {
    const result = await delivery();
    success = result !== false;
    if (result && typeof result === 'object' && 'ok' in result && 'status' in result) {
      success = result.ok === true;
      if (typeof result.status === 'number') httpStatus = result.status;
    }
    return result;
  } finally { markBusinessInformationTiming(sessionId, `${stage}_complete`, Date.now() - started,
    { success, ...(httpStatus === undefined ? {} : { httpStatus }) }); }
}
