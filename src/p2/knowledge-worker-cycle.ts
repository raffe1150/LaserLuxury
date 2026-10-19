import { deliverKnowledge, KnowledgeRunner, type GuardedKnowledgeTransport } from './knowledge-runner';
import type { KnowledgeLifecycleRepository, KnowledgeScope } from './knowledge-lifecycle';
import { requireId } from './knowledge-lifecycle';

export type KnowledgeCycleReport = Readonly<{ ran: boolean; deliveries: readonly Readonly<{
  taskId: string; deliveryId: string; result: NonNullable<Awaited<ReturnType<typeof deliverKnowledge>>>;
}>[] }>;

type Work = Readonly<{ scope: KnowledgeScope; taskId: string }>;
export interface DiscoverableKnowledgeRepository extends KnowledgeLifecycleRepository {
  discoverWork(limit?: number): Promise<readonly Work[]>;
  discoverDeliveries(limit?: number): Promise<readonly (Work & { deliveryId: string })[]>;
}
/** A single reentrant-safe host tick, NOT a new worker service/in-memory queue.
 * No timers or startup hooks are installed. The future opt-in host invokes this
 * on startup and periodically, recovering identifiers from durable rows.
 * Foreground Booking actions are never part of discovery or recovery.
 */
export class KnowledgeWorkerCycle {
  private busy = false;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly repository: DiscoverableKnowledgeRepository, private readonly runner: KnowledgeRunner,
    private readonly transport: GuardedKnowledgeTransport, private readonly sender: string,
    private readonly controls: {processing:()=>boolean;delivery:()=>boolean} = {processing:()=>true,delivery:()=>true}) { requireId(sender); }
  stop(): void { this.stopped = true; this.abort.abort(); this.runner.stop(); }
  async tick(): Promise<KnowledgeCycleReport> {
    if (this.stopped || this.busy || !this.controls.processing() && !this.controls.delivery()) return { ran: false, deliveries: [] };
    this.busy = true;
    try {
      const reports: { taskId: string; deliveryId: string; result: NonNullable<Awaited<ReturnType<typeof deliverKnowledge>>> }[] = [];
      const send = async (scope: KnowledgeScope, taskId: string, deliveryId: string) => {
        if (this.stopped || !this.controls.delivery()) return;
        const result = await deliverKnowledge(this.repository, this.transport, scope, taskId, deliveryId, this.sender, undefined, this.abort.signal);
        // Settlement failures remain business-visible without falsifying the
        // provider outcome or causing an automatic duplicate remote send.
        if (result) reports.push({ taskId, deliveryId, result });
      };
      const [work, deliveries] = await Promise.all([this.controls.processing() ? this.repository.discoverWork(16) : [], this.controls.delivery() ? this.repository.discoverDeliveries(16) : []]);
      const outcomes = await Promise.allSettled([
        // Runner applies its own bounded concurrency. Overflow stays durable;
        // it is never moved into an unbounded in-process waiting queue.
        (async () => {
          const failures:unknown[]=[];
          // Scan only the bounded durable discovery result. Capacity overflow
          // must not repeatedly drop every ID after two unclaimable lease rows.
          const capacity=this.runner.capacity;
          for(let i=0;i<work.length && !this.stopped && this.controls.processing();i+=capacity){
            const batch=await Promise.allSettled(work.slice(i,i+capacity).map(async item=>{
              const delivery=await this.runner.run(item.scope,item.taskId);
              if(delivery && !this.stopped)await send(item.scope,item.taskId,delivery.id);
            }));
            for(const result of batch)if(result.status==='rejected')failures.push(result.reason);
          }
          if(failures.length)throw failures[0];
        })(),
        (async () => {
          for (const item of deliveries) {
            if (this.stopped) break;
            await this.repository.recover(item.scope); // Expired SENDING -> UNCERTAIN.
            await send(item.scope, item.taskId, item.deliveryId);
          }
        })(),
      ]);
      // Keep the reentry guard until every owned branch settles; preserve errors.
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      return { ran: true, deliveries: reports };
    } finally { this.busy = false; }
  }
}
