import { InformationBudget } from '../ai/business-information-answer-plan';
import { boundedInteger, type KnowledgeTask } from './knowledge-lifecycle';
import { knowledgeExecutionDeadline } from './knowledge-operation';

/** Explicit inactive task budget. The foreground InformationBudget stays 20s.
 * No queue/retry/recovery can reset acceptedAt or the original absolute expiry.
 */
export class DurableKnowledgeBudget extends InformationBudget {
  override readonly startedAt: number;
  override readonly deadlineAt: number;
  readonly executionDeadlineAt:number;
  readonly publicationV2: boolean;
  readonly maxAttempts: number;
  constructor(task: KnowledgeTask, readonly signal: AbortSignal, readonly reserve: () => Promise<void>) {
    super();
    boundedInteger(task.acceptedAt, 1, Number.MAX_SAFE_INTEGER);
    boundedInteger(task.expiresAt - task.acceptedAt, 1000, 120000);
    this.startedAt = task.acceptedAt; this.deadlineAt = task.expiresAt;
    this.executionDeadlineAt=knowledgeExecutionDeadline(task);
    this.publicationV2 = task.publicationV2 === true && task.scope.businessId === 3;
    this.maxAttempts = this.publicationV2 ? boundedInteger(task.maxModelAttempts, 4, 5) : Math.min(task.maxModelAttempts, 4);
    this.attempts = boundedInteger(task.modelAttempts, 0, 8);
  }
  override attempt() {
    if (!this.remaining() || this.attempts >= this.maxAttempts) throw new Error('information_budget_exhausted');
    this.attempts++;
  }
  override remaining() { return this.signal.aborted ? 0 : Math.max(0,this.executionDeadlineAt-Date.now()); }
}
