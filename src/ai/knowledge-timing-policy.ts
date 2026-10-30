import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AiRequestQueue } from './request-queue';

/** Experimental, explicit opt-in. No booking, durable, web or voice defaults change. */
export const ACCURACY_FIRST_POLICY = Object.freeze({
  version: 'accuracy-first-v1', turnMs: 45_000, knowledgeMs: 35_000,
  extractionMs: 20_000, verificationReserveMs: 12_000, verificationDispatchMs: 10_000,
  publicationMs: 3_000, deliveryMs: 5_000, cleanupMs: 2_000,
});
export class KnowledgeTimingError extends Error {
  constructor(public readonly code: 'deadline' | 'closed' | 'overload' | 'delivery_attempted') {
    super(`knowledge_${code}${code === 'deadline' || code === 'closed' ? ': aborted' : ''}`); this.name = 'KnowledgeTimingError';
  }
}
const context = new AsyncLocalStorage<NativeKnowledgeTiming>();
export const nativeKnowledgeTiming = () => context.getStore();
/** Backend configuration only. The global selector alone never enrolls a tenant.
 * Invalid/absent lists fail closed; language and customer/model text confer no authority. */
export function accuracyFirstEnabled(businessId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ODINLINK_KNOWLEDGE_TIMING_POLICY !== ACCURACY_FIRST_POLICY.version ||
      !Number.isSafeInteger(businessId) || businessId <= 0) return false;
  const tenants = (env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS ?? '').split(',').map(id => id.trim());
  return tenants.length <= 10 && tenants.every(id => /^[1-9]\d*$/u.test(id) && Number.isSafeInteger(Number(id))) &&
    tenants.includes(String(businessId));
}
export const accuracyFirstExtractionAllowance = (generationMs: number) => Number.isFinite(generationMs)
  ? Math.max(0, Math.floor(Math.min(ACCURACY_FIRST_POLICY.extractionMs, generationMs - ACCURACY_FIRST_POLICY.verificationReserveMs))) : 0;

/** Contains no question, recipient, tenant, evidence or credentials. Timers never reset on retry. */
export class NativeKnowledgeTiming {
  readonly policy = ACCURACY_FIRST_POLICY;
  readonly turnId = randomUUID();
  readonly startedAt = Date.now();
  readonly deadlineAt = this.startedAt + this.policy.turnMs;
  private readonly processing = new AbortController();
  private readonly lifetime = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<unknown>>();
  private failed = false;
  private closed = false;
  private attemptedDelivery = false;
  private knowledgeEnd?: number;
  readonly events: Array<Readonly<{ event: string; elapsedMs: number; pending: number; remainingMs: number }>> = [];
  constructor() {
    Object.defineProperty(this, 'startedAt', { writable: false, configurable: false });
    Object.defineProperty(this, 'deadlineAt', { writable: false, configurable: false });
    this.at(this.deadlineAt - this.policy.deliveryMs - this.policy.cleanupMs, () => this.fail());
    this.at(this.deadlineAt - this.policy.cleanupMs, () => this.lifetime.abort(new KnowledgeTimingError('deadline')));
    this.record('created');
  }
  get signal() { return this.processing.signal; }
  get deliverySignal() { return this.lifetime.signal; }
  get publicationReserveMs() { return this.policy.publicationMs; }
  get failure() { return this.failed || this.signal.aborted || this.closed ||
    Date.now() >= (this.knowledgeEnd ?? this.deadlineAt - this.policy.deliveryMs - this.policy.cleanupMs); }
  get deliveryAttempted() { return this.attemptedDelivery; }
  remaining() { return Math.max(0, this.deadlineAt - Date.now()); }
  knowledgeDeadline() {
    if (this.knowledgeEnd === undefined) {
      this.knowledgeEnd = Math.min(Date.now() + this.policy.knowledgeMs,
        this.deadlineAt - this.policy.deliveryMs - this.policy.cleanupMs);
      this.at(this.knowledgeEnd, () => this.fail());
      this.record('knowledge_started');
    }
    return this.knowledgeEnd;
  }
  assertProcessing() {
    if (this.closed) throw new KnowledgeTimingError('closed');
    if (this.failed || Date.now() >= (this.knowledgeEnd ?? this.deadlineAt - this.policy.deliveryMs - this.policy.cleanupMs)) this.fail();
    this.signal.throwIfAborted();
  }
  fail(code: 'deadline' | 'overload' = 'deadline') {
    if (this.failed) return;
    this.failed = true; this.processing.abort(new KnowledgeTimingError(code)); this.record(code === 'overload' ? 'admission_overload' : 'processing_aborted');
  }
  private at(deadline: number, work: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); work(); }, Math.max(0, deadline - Date.now()));
    this.timers.add(timer);
  }
  record(event: string) {
    // Preserve terminal scheduling/delivery visibility when frequent read events fill the trace.
    if (this.events.length >= 48 && /^(?:operation_|provider_)/u.test(event)) return;
    if (this.events.length < 64) this.events.push(Object.freeze({ event, elapsedMs: Math.max(0, Date.now() - this.startedAt),
      pending: this.pending.size, remainingMs: this.remaining() }));
  }
  /** A raced timeout is not cancellation. Retain admission until underlying work settles. */
  observe<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise); this.record('operation_started');
    void promise.then(() => {}, () => {}).finally(() => { this.pending.delete(promise); this.record('operation_settled'); });
    return promise;
  }
  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.assertProcessing();
    return abortKnowledgeWork(this.observe(Promise.resolve().then(work)), this.signal);
  }
  async deliver<T>(work: (signal: AbortSignal) => Promise<T>, authorizationDeadlineAt = Infinity): Promise<T> {
    if (this.closed || this.remaining() <= this.policy.cleanupMs) throw new KnowledgeTimingError('deadline');
    if (this.attemptedDelivery) throw new KnowledgeTimingError('delivery_attempted');
    this.lifetime.signal.throwIfAborted();
    this.attemptedDelivery = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const deadline = Math.min(Date.now() + this.policy.deliveryMs, this.deadlineAt - this.policy.cleanupMs, authorizationDeadlineAt);
    if (deadline <= Date.now() || Number.isNaN(deadline)) throw new KnowledgeTimingError('deadline');
    const timer = setTimeout(() => controller.abort(new KnowledgeTimingError('deadline')), Math.max(0, deadline - Date.now()));
    this.record('delivery_started');
    try {
      const result = await abortKnowledgeWork(this.observe(Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); })), signal);
      if (Date.now() >= deadline) { controller.abort(new KnowledgeTimingError('deadline')); signal.throwIfAborted(); }
      return result;
    }
    finally { clearTimeout(timer); this.record(signal.aborted ? 'delivery_ambiguous' : 'delivery_settled'); }
  }
  close() {
    this.closed = true;
    this.processing.abort(new KnowledgeTimingError('closed'));
    this.lifetime.abort(new KnowledgeTimingError('closed'));
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.record('closed');
  }
}

export async function abortKnowledgeWork<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); signal.throwIfAborted(); }
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
const boundedSetting = (value: string | undefined, fallback: number, max: number) =>
  value && /^\d+$/u.test(value) ? Math.min(max, Math.max(0, Number(value))) : fallback;
let admission: { key: string; queue: AiRequestQueue } | undefined;
export function knowledgeAdmission() {
  // One active Knowledge turn by default: it cannot occupy all three default AI slots.
  const active = Math.max(1, boundedSetting(process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS, 1, 3));
  const waiting = boundedSetting(process.env.KNOWLEDGE_MAX_WAITING_REQUESTS, 3, 12);
  const key = `${active}:${waiting}`;
  // Reconfiguration never discards ownership of live/uncooperative work.
  if (!admission || admission.key !== key && admission.queue.snapshot().active === 0 && admission.queue.snapshot().waiting === 0)
    admission = { key, queue: new AiRequestQueue(active, waiting) };
  return admission.queue;
}

export async function runAccuracyFirstNative<T>(work: () => Promise<T>, safeFailure: () => Promise<void>,
  diagnostic?: (event: { policyVersion: string; policyTurnId: string; elapsedMs: number; events: NativeKnowledgeTiming['events']; admission: ReturnType<AiRequestQueue['snapshot']> }) => void): Promise<T | undefined> {
  const timing = new NativeKnowledgeTiming(), queue = knowledgeAdmission();
  return context.run(timing, async () => {
    const stopped = new AbortController();
    // Once an authorized send has started, its own five-second deadline applies.
    // The Knowledge compute timer must not confiscate the delivery allowance.
    const processingStopped = () => { if (!timing.deliveryAttempted) stopped.abort(timing.signal.reason); };
    const lifetimeStopped = () => stopped.abort(timing.deliverySignal.reason);
    timing.signal.addEventListener('abort', processingStopped, { once: true });
    timing.deliverySignal.addEventListener('abort', lifetimeStopped, { once: true });
    // The queue slot belongs to the real work, not its timeout race.
    const running = queue.run(async () => {
      try { return await work(); }
      finally { await timing.drain(); }
    }, () => timing.record('admitted'), timing.signal);
    try { return await abortKnowledgeWork(running, stopped.signal); }
    catch (error) {
      timing.fail(error instanceof Error && error.message === 'knowledge_admission_overload' ? 'overload' : 'deadline');
      if (!timing.deliveryAttempted && timing.remaining() > timing.policy.cleanupMs)
        await abortKnowledgeWork(timing.observe(Promise.resolve().then(safeFailure)), timing.deliverySignal).catch(() => {});
      return undefined;
    } finally {
      timing.signal.removeEventListener('abort', processingStopped);
      timing.deliverySignal.removeEventListener('abort', lifetimeStopped);
      timing.close();
      try { diagnostic?.({ policyVersion: timing.policy.version, policyTurnId: timing.turnId, elapsedMs: Date.now() - timing.startedAt, events: timing.events, admission: queue.snapshot() }); } catch { /* optional telemetry */ }
    }
  });
}
