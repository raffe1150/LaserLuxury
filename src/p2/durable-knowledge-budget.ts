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
  constructor(task: KnowledgeTask, readonly signal: AbortSignal, readonly reserve: () => Promise<void>) {
    super();
    boundedInteger(task.acceptedAt, 1, Number.MAX_SAFE_INTEGER);
    boundedInteger(task.expiresAt - task.acceptedAt, 1000, 120000);
    this.startedAt = task.acceptedAt; this.deadlineAt = task.expiresAt;
    this.executionDeadlineAt=knowledgeExecutionDeadline(task);
    this.attempts = boundedInteger(task.modelAttempts, 0, 8);
  }
  override remaining() { return this.signal.aborted ? 0 : Math.max(0,this.executionDeadlineAt-Date.now()); }
}
