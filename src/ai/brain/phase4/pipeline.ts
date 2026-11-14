import { decideTurn } from '../decide-turn';
import { bindEvidence, hashRecord, type BindingResult, type Candidate, type Inventory, type Receipt, type Scope } from '../evidence/bind';
import { finishTurn, policyReferences, prepareTurn, type TurnContext } from '../memory/conversation-memory';
import type { TurnFrame } from '../memory/turn-frame';

type EvidenceBatch = Readonly<{ candidates: readonly Candidate[]; receipts: readonly Receipt[] }>;
export type RecoveryOutcome = 'RECOVERED_VERIFIED' | 'STILL_UNRESOLVED' | 'CONTRADICTORY' |
  'BUDGET_EXHAUSTED' | 'TIMED_OUT' | 'NOT_ELIGIBLE';
export type Recovery = Readonly<{
  /** Explicitly admitted obligation IDs. No implicit retries. */
  eligible: readonly string[];
  attempts: number;
  budgetMs: number;
  budgetCostUnits: number;
  perAttemptMs: number;
  perAttemptCostUnits: number;
  now: () => number; // trusted monotonic elapsed clock, injectable for replay
  read: (scope: Scope, reservation: Readonly<{ ms: number; costUnits: number }>, signal: AbortSignal) =>
    Promise<Readonly<{ batch: EvidenceBatch; costUnits: number }>>;
}>;
export type EvidencePort = Readonly<{
  inventory?: Inventory;
  initial: (scopes: readonly Scope[]) => EvidenceBatch;
  recovery?: Recovery;
}>;

function valid(n: number) { return Number.isSafeInteger(n) && n >= 0; }

export async function shadowTurn(input: Readonly<{
  frame?: TurnFrame; context: TurnContext; text: string; wire?: unknown; evidence: EvidencePort;
}>) {
  const prepared = await prepareTurn(input.frame, input.context, input.text);
  const semantic = finishTurn(prepared, input.wire);
  const references = policyReferences(semantic);
  const scopes: Scope[] = [];
  for (const [i, reading] of semantic.readings.entries()) {
    const guidance = semantic.guidance[i];
    if (guidance?.kind !== 'CHECK_KNOWLEDGE' || !reading.questionType) continue;
    scopes.push(Object.freeze({
      ...semantic.frame.binding, turn: semantic.frame.turn, obligationId: guidance.obligationId,
      language: semantic.frame.language.language, questionType: reading.questionType,
      requestDigest: hashRecord([prepared.request?.text, reading, prepared.request?.references, semantic.frame.recent.at(-1)]),
    }));
  }
  const inventory = input.evidence.inventory ? structuredClone(input.evidence.inventory) : undefined;
  const initial = scopes.length ? structuredClone(input.evidence.initial(Object.freeze(scopes))) : { candidates: [], receipts: [] };
  const now = semantic.frame.updatedAtMs;
  const bindings = new Map<string, BindingResult>();
  const accepted = new Map<string, EvidenceBatch>();
  for (const scope of scopes) {
    const b = bindEvidence(scope, now, inventory, initial.candidates, initial.receipts);
    bindings.set(scope.obligationId, b);
    if (b.status === 'BOUND') accepted.set(scope.obligationId, initial);
  }

  const recovery = input.evidence.recovery;
  const recoveries: { obligationId: string; outcome: RecoveryOutcome; attempted: boolean; reason?: string }[] = [];
  let attempts = 0;
  let reservedCostUnits = 0;
  let reservedMs = 0;
  const start = recovery?.now() ?? 0;
  const admitted = !!recovery && [start, recovery.attempts, recovery.budgetMs, recovery.budgetCostUnits, recovery.perAttemptMs,
    recovery.perAttemptCostUnits].every(valid) && recovery.perAttemptMs > 0 && recovery.perAttemptMs <= 1000;
  for (const reference of references) {
    const obligationId = reference.id;
    const scope = scopes.find(s => s.obligationId === obligationId);
    const original = bindings.get(obligationId);
    const record = (outcome: RecoveryOutcome, attempted = false, reason?: string) => recoveries.push({ obligationId, outcome, attempted, reason });
    if (original?.status === 'CONTRADICTORY') { record('CONTRADICTORY'); continue; }
    if (!scope || original?.status !== 'INDETERMINATE' || !recovery?.eligible.includes(obligationId)) {
      record('NOT_ELIGIBLE'); continue;
    }
    const began = recovery.now();
    if (!admitted || !valid(began) || began < start || attempts >= Math.min(3, recovery.attempts) ||
        Math.max(reservedMs, began - start) + recovery.perAttemptMs > recovery.budgetMs ||
        reservedCostUnits + recovery.perAttemptCostUnits > recovery.budgetCostUnits) {
      record('BUDGET_EXHAUSTED'); continue;
    }
    attempts++;
    reservedMs = Math.max(reservedMs, began - start) + recovery.perAttemptMs;
    reservedCostUnits += recovery.perAttemptCostUnits;
    const timeout = Symbol('timeout');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<typeof timeout>(resolve => {
        timer = setTimeout(() => { resolve(timeout); controller.abort(); }, recovery.perAttemptMs);
      });
      const result = await Promise.race([deadline, Promise.resolve().then(() =>
        recovery.read(scope, { ms: recovery.perAttemptMs, costUnits: recovery.perAttemptCostUnits }, controller.signal))]);
      const ended = recovery.now();
      const elapsed = ended - start;
      if (result === timeout || !valid(ended) || ended < began || ended - began >= recovery.perAttemptMs || elapsed >= recovery.budgetMs) {
        record('TIMED_OUT', true);
        break; // An uncooperative port may still be winding down. Do not overlap attempts.
      }
      if (!valid(result.costUnits) || result.costUnits > recovery.perAttemptCostUnits) {
        record('BUDGET_EXHAUSTED', true);
        break;
      }
      const batch = structuredClone(result.batch);
      const next = bindEvidence(scope, now + elapsed, inventory, batch.candidates, batch.receipts);
      if (next.status === 'BOUND') accepted.set(obligationId, batch);
      if (next.status === 'BOUND' || next.status === 'CONTRADICTORY') bindings.set(obligationId, next);
      record(next.status === 'BOUND' ? 'RECOVERED_VERIFIED' : next.status === 'CONTRADICTORY' ? 'CONTRADICTORY' : 'STILL_UNRESOLVED',
        true, next.reason);
    } catch {
      record('STILL_UNRESOLVED', true, 'RECOVERY_PORT_FAILED');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  const finalClock = recovery?.now() ?? start;
  const elapsed = valid(finalClock) && valid(start) && finalClock >= start ? finalClock - start : 0;
  // Recheck accepted initial evidence at decision time, including freshness.
  for (const scope of scopes) {
    const batch = accepted.get(scope.obligationId);
    if (!batch) continue;
    const clockValid = valid(finalClock) && valid(start) && finalClock >= start;
    const check = bindEvidence(scope, clockValid ? now + elapsed : Number.NaN, inventory, batch.candidates, batch.receipts);
    bindings.set(scope.obligationId, check);
    const attempt = recoveries.find(r => r.obligationId === scope.obligationId && r.outcome === 'RECOVERED_VERIFIED');
    if (attempt && check.status !== 'BOUND') {
      attempt.outcome = 'STILL_UNRESOLVED';
      attempt.reason = check.reason;
    }
  }
  // Fill unvisited rows after a timed-out or over-budget port.
  for (const reference of references) {
    if (recoveries.some(r => r.obligationId === reference.id)) continue;
    const status = bindings.get(reference.id)?.status;
    const outcome = status === 'CONTRADICTORY' ? 'CONTRADICTORY'
      : status === 'INDETERMINATE' && recovery?.eligible.includes(reference.id) ? 'BUDGET_EXHAUSTED' : 'NOT_ELIGIBLE';
    recoveries.push({ obligationId: reference.id, outcome, attempted: false });
  }
  const bound = [...bindings.values()];
  const decision = decideTurn({
    tenantId: semantic.frame.binding.tenantId, obligations: references.map(o => bindings.get(o.id)?.obligation ?? o),
    currentRevisions: (inventory?.revisions ?? []).map(r => ({ ...r, tenantId: inventory!.tenantId })),
    proposals: bound.flatMap(b => b.proposals), reviews: bound.flatMap(b => b.reviews),
  });
  return { semantic, decision, bindings: bound, recoveries, attempts, reservedMs, reservedCostUnits };
}
