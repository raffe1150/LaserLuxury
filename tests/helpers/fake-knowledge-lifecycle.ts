import { randomUUID } from 'node:crypto';
import {
  boundedInteger, captureInput, captureVerified, requireId, requireProviderId, resultDigest, scopeKey, snapshot, validateScope,
  type Acceptance, type Checkpoint, type DeliveryOutcome, type DeliveryToken, type KnowledgeAuthority,
  type KnowledgeDelivery, type KnowledgeInput, type KnowledgeLifecycleRepository, type KnowledgeScope,
  type KnowledgeTask, type TaskToken, type TurnIdentity, type VerifiedKnowledge,
} from '../../src/p2/knowledge-lifecycle';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Task = Mutable<KnowledgeTask>;
type Delivery = Mutable<KnowledgeDelivery>;
type Rows = {
  tasks: Map<string, Task>; deliveries: Map<string, Delivery>;
  events: Map<string, { scope: string; identity: TurnIdentity; runs: number; models: number }>;
  latest: Map<string, number>;
  conversations: Map<string, string>;
};
/** Test-only database model. JSON export/import simulates restart, NOT durability.
 * All connections share the database mutex, not a per-worker mutex. Mutations
 * commit a private copy together or none, including injected commit failures.
 */
export class FakeKnowledgeDatabase {
  rows: Rows = { tasks: new Map(), deliveries: new Map(), events: new Map(), latest: new Map(), conversations: new Map() };
  tail: Promise<void> = Promise.resolve();
  failNextCommit = false;
  dump(): string { return JSON.stringify(Object.fromEntries(Object.entries(this.rows).map(([k, v]) => [k, [...v]]))); }
  static restore(json: string): FakeKnowledgeDatabase {
    const db = new FakeKnowledgeDatabase(), parsed = JSON.parse(json);
    for (const key of ['tasks', 'deliveries', 'events', 'latest', 'conversations'] as const) (db.rows as any)[key] = new Map(parsed[key]);
    return db;
  }
}

export class FakeKnowledgeLifecycle implements KnowledgeLifecycleRepository {
  constructor(readonly database: FakeKnowledgeDatabase, private readonly clock: () => number,
    private readonly authority: KnowledgeAuthority) {}

  private async tx<T>(work: (rows: Rows) => T | Promise<T>): Promise<T> {
    const previous = this.database.tail; let release!: () => void;
    this.database.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const rows = structuredClone(this.database.rows), result = await work(rows);
      if (this.database.failNextCommit) { this.database.failNextCommit = false; throw new Error('injected_transaction_failure'); }
      this.database.rows = rows;
      return snapshot(result);
    } finally { release(); }
  }
  private task(rows: Rows, scope: KnowledgeScope, id: string): Task | null {
    validateScope(scope); requireId(id);
    const task = rows.tasks.get(id);
    return task && scopeKey(task.scope) === scopeKey(scope) ? task : null;
  }
  private refresh(rows: Rows, task: Task): void {
    const current = rows.latest.get(scopeKey(task.scope)) === task.sequence;
    if (!current && !['FAILED', 'EXPIRED', 'SUPERSEDED'].includes(task.state)) {
      task.state = 'SUPERSEDED'; task.lease = null; task.revision++;
    } else if (this.clock() >= task.expiresAt && ['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(task.state)) {
      task.state = 'EXPIRED'; task.lease = null; task.revision++;
    }
    for (const d of rows.deliveries.values()) if (d.taskId === task.id) {
      if (d.state === 'SENDING' && (!d.lease || d.lease.until <= this.clock())) { d.state = 'UNCERTAIN'; d.lease = null; }
      if (['PENDING', 'FAILED'].includes(d.state) && (!current || this.clock() >= task.expiresAt)) {
        d.state = !current ? 'SUPERSEDED' : 'EXPIRED'; d.lease = null;
      }
    }
  }
  private owns(rows: Rows, scope: KnowledgeScope, token: TaskToken): Task | null {
    const t = this.task(rows, scope, token.taskId); if (!t) return null;
    this.refresh(rows, t);
    return ['RUNNING', 'VERIFIED'].includes(t.state) && t.lease?.owner === token.owner &&
      t.lease.fence === token.fence && t.lease.until > this.clock() ? t : null;
  }
  async accept(scope: KnowledgeScope, eventId: string, knowledge?: KnowledgeInput,
    limits: { executionMs?: number; maxRunAttempts?: number; maxModelAttempts?: number } = {}): Promise<Acceptance> {
    validateScope(scope); requireProviderId(eventId);
    const input = knowledge ? captureInput(knowledge) : null;
    const duration = boundedInteger(limits.executionMs ?? 40_000, 1000, 120_000);
    const runs = boundedInteger(limits.maxRunAttempts ?? 3, 1, 5), models = boundedInteger(limits.maxModelAttempts ?? 4, 1, 8);
    return this.tx(rows => {
      const conversation = JSON.stringify([scope.businessId, scope.conversationId]);
      const binding = rows.conversations.get(conversation);
      if (binding && binding !== scopeKey(scope)) throw new Error('knowledge_conversation_scope_mismatch');
      rows.conversations.set(conversation, scopeKey(scope));
      const key = JSON.stringify([scope.businessId, scope.channel, scope.providerAccount, eventId]);
      const existing = rows.events.get(key);
      if (existing) {
        if (existing.scope !== scopeKey(scope)) throw new Error('knowledge_event_scope_mismatch');
        let task = existing.identity.taskId ? rows.tasks.get(existing.identity.taskId)! : null;
        if (!task && input && rows.latest.get(scopeKey(scope)) === existing.identity.sequence &&
            this.clock() < existing.identity.expiresAt) {
          const identity = { ...existing.identity, taskId: randomUUID() };
          existing.identity = identity;
          task = this.newTask(scope, identity, input, existing.runs, existing.models);
          rows.tasks.set(task.id, task);
        }
        if (task) this.refresh(rows, task);
        return { identity: existing.identity, task, inserted: false };
      }
      const acceptedAt = this.clock(), sequence = (rows.latest.get(scopeKey(scope)) ?? 0) + 1;
      const identity: TurnIdentity = { turnId: randomUUID(), eventId, sequence, acceptedAt, expiresAt: acceptedAt + duration, taskId: input ? randomUUID() : null };
      rows.latest.set(scopeKey(scope), sequence);
      rows.events.set(key, { scope: scopeKey(scope), identity, runs, models });
      for (const task of rows.tasks.values()) if (scopeKey(task.scope) === scopeKey(scope)) this.refresh(rows, task);
      const task: Task | null = input ? this.newTask(scope, identity, input, runs, models) : null;
      if (task) rows.tasks.set(task.id, task);
      return { identity, task, inserted: true };
    });
  }
  private newTask(scope: KnowledgeScope, identity: TurnIdentity, input: KnowledgeInput, runs: number, models: number): Task {
    return { id: identity.taskId!, turnId: identity.turnId, eventId: identity.eventId,
      scope: snapshot({ businessId: scope.businessId, channel: scope.channel, providerAccount: scope.providerAccount, conversationId: scope.conversationId }),
      sequence: identity.sequence, acceptedAt: identity.acceptedAt, expiresAt: identity.expiresAt,
      input, state: 'ACCEPTED', revision: 0, fence: 0, lease: null,
      runAttempts: 0, maxRunAttempts: runs, modelAttempts: 0, maxModelAttempts: models,
      checkpoint: null, result: null, resultDigest: null };
  }
  async get(scope: KnowledgeScope, id: string) {
    return this.tx(rows => { const t = this.task(rows, scope, id); if (t) this.refresh(rows, t); return t; });
  }
  async claim(scope: KnowledgeScope, id: string, owner: string, leaseMs: number) {
    requireId(owner); boundedInteger(leaseMs, 1, 30_000);
    return this.tx(rows => {
      const t = this.task(rows, scope, id); if (!t) return null; this.refresh(rows, t);
      if (!['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(t.state) || (t.lease && t.lease.until > this.clock())) return null;
      if (t.runAttempts >= t.maxRunAttempts) { t.state = 'FAILED'; t.lease = null; return null; }
      t.runAttempts++; t.fence++; t.revision++;
      t.lease = { owner, fence: t.fence, until: Math.min(this.clock() + leaseMs, t.expiresAt) };
      if (t.state !== 'VERIFIED') t.state = 'RUNNING';
      return t;
    });
  }
  async renew(scope: KnowledgeScope, token: TaskToken, leaseMs: number) {
    boundedInteger(leaseMs, 1, 30_000);
    return this.tx(rows => { const t = this.owns(rows, scope, token); if (!t) return false;
      t.lease = { ...t.lease!, until: Math.min(this.clock() + leaseMs, t.expiresAt) }; t.revision++; return true; });
  }
  async reserveModelAttempt(scope: KnowledgeScope, token: TaskToken) {
    return this.tx(rows => { const t = this.owns(rows, scope, token);
      if (!t || t.state !== 'RUNNING' || t.modelAttempts >= t.maxModelAttempts) return false;
      t.modelAttempts++; t.revision++; return true; });
  }
  async checkpoint(scope: KnowledgeScope, token: TaskToken, checkpoint: Checkpoint) {
    const stages: Checkpoint[] = ['planning', 'retrieval', 'extraction'];
    if (!stages.includes(checkpoint)) throw new Error('knowledge_invalid_checkpoint');
    return this.tx(rows => { const t = this.owns(rows, scope, token);
      if (!t || t.state !== 'RUNNING' || stages.indexOf(checkpoint) <= stages.indexOf(t.checkpoint!)) return false;
      t.checkpoint = checkpoint; t.revision++; return true; });
  }
  async verified(scope: KnowledgeScope, token: TaskToken, result: VerifiedKnowledge) {
    const captured = captureVerified(result);
    return this.tx(rows => { const t = this.owns(rows, scope, token); if (!t || t.state !== 'RUNNING') return false;
      t.result = captured; t.resultDigest = resultDigest(captured); t.state = 'VERIFIED'; t.revision++; return true; });
  }
  async fail(scope: KnowledgeScope, token: TaskToken) {
    return this.tx(rows => { const t = this.owns(rows, scope, token); if (!t) return false;
      t.state = 'FAILED'; t.lease = null; t.revision++; return true; });
  }
  private delivery(rows: Rows, task: Task, kind: 'final' | 'progress', text: string): Delivery {
    const key = JSON.stringify([task.scope.businessId, task.turnId, kind]);
    const existing = [...rows.deliveries.values()].find(d => d.key === key); if (existing) return existing;
    const d: Delivery = { id: randomUUID(), taskId: task.id, kind, key, text, state: 'PENDING', fence: 0,
      lease: null, attempts: 0, maxAttempts: 3, providerMessageId: null, customerDelivery: 'UNCONFIRMED' };
    rows.deliveries.set(d.id, d); return d;
  }
  async finalize(scope: KnowledgeScope, token: TaskToken) {
    return this.tx(async rows => {
      const t = this.owns(rows, scope, token);
      if (!t || t.state !== 'VERIFIED' || !t.result || t.resultDigest !== resultDigest(t.result)) return null;
      if (!await this.authority(snapshot(t), 'finalize') || !this.owns(rows, scope, token)) return null;
      const delivery = this.delivery(rows, t, 'final', t.result.text);
      t.state = 'FINALIZED'; t.lease = null; t.revision++;
      // Final always wins over waiting text that has not been dispatched.
      for (const d of rows.deliveries.values()) if (d.taskId === t.id && d.kind === 'progress' && ['PENDING', 'FAILED'].includes(d.state)) d.state = 'SUPERSEDED';
      return delivery;
    });
  }
  async enqueueProgress(scope: KnowledgeScope, id: string, text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 240) throw new Error('knowledge_invalid_progress');
    return this.tx(rows => { const t = this.task(rows, scope, id); if (!t) return null; this.refresh(rows, t);
      if (!['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(t.state)) return null;
      return this.delivery(rows, t, 'progress', text); });
  }
  async claimDelivery(scope: KnowledgeScope, id: string, owner: string, leaseMs: number) {
    requireId(owner); boundedInteger(leaseMs, 1, 30_000);
    return this.tx(async rows => {
      const d = rows.deliveries.get(id); if (!d) return null;
      const t = this.task(rows, scope, d.taskId); if (!t) return null; this.refresh(rows, t);
      if (!['PENDING', 'FAILED'].includes(d.state) || d.attempts >= d.maxAttempts || this.clock() >= t.expiresAt ||
          ['SUPERSEDED', 'FAILED', 'EXPIRED'].includes(t.state) || (d.kind === 'final' && t.state !== 'FINALIZED')) return null;
      if (!await this.authority(snapshot(t), 'send')) return null;
      this.refresh(rows, t);
      if (!['PENDING', 'FAILED'].includes(d.state) || this.clock() >= t.expiresAt || rows.latest.get(scopeKey(scope)) !== t.sequence) return null;
      d.fence++; d.attempts++; d.state = 'SENDING';
      d.lease = { owner, fence: d.fence, until: Math.min(this.clock() + leaseMs, t.expiresAt) };
      return d;
    });
  }
  async settleDelivery(scope: KnowledgeScope, token: DeliveryToken, outcome: DeliveryOutcome) {
    if (!['API_ACCEPTED', 'DEFINITIVELY_UNSENT', 'AMBIGUOUS'].includes(outcome.kind)) throw new Error('knowledge_invalid_delivery_outcome');
    if (outcome.kind === 'API_ACCEPTED') requireProviderId(outcome.providerMessageId);
    if (outcome.kind === 'DEFINITIVELY_UNSENT' && typeof outcome.retryable !== 'boolean') throw new Error('knowledge_invalid_delivery_outcome');
    return this.tx(rows => {
      const d = rows.deliveries.get(token.deliveryId); if (!d) return false;
      const t = this.task(rows, scope, d.taskId); if (!t) return false; this.refresh(rows, t);
      if (d.state !== 'SENDING' || d.lease?.owner !== token.owner || d.lease.fence !== token.fence || d.lease.until <= this.clock()) return false;
      if (outcome.kind === 'API_ACCEPTED') { d.state = 'SENT'; d.providerMessageId = outcome.providerMessageId; }
      else if (outcome.kind === 'AMBIGUOUS') d.state = 'UNCERTAIN';
      else { d.state = 'FAILED'; if (!outcome.retryable) d.maxAttempts = d.attempts; }
      d.lease = null; return true;
    });
  }
  async recover(scope: KnowledgeScope) {
    validateScope(scope);
    return this.tx(rows => {
      const available: Task[] = [];
      for (const t of rows.tasks.values()) if (scopeKey(t.scope) === scopeKey(scope)) {
        this.refresh(rows, t);
        if (['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(t.state) && (!t.lease || t.lease.until <= this.clock()) && t.runAttempts < t.maxRunAttempts) available.push(t);
      }
      return available.slice(0, 100);
    });
  }
}
