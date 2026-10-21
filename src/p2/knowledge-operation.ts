import { AsyncLocalStorage } from 'node:async_hooks';
import type { KnowledgeTask } from './knowledge-lifecycle';

export const KNOWLEDGE_OPERATION_LIMITS = Object.freeze({ databaseMs:3000, eligibilityMs:5000, sendMs:5000, cycleMs:60000, deliveryMs:15000 });
const scope=new AsyncLocalStorage<{signal:AbortSignal;deadlineAt:number}>();
export function knowledgeOperationSignal():AbortSignal|undefined { return scope.getStore()?.signal; }
export function knowledgeExecutionDeadline(task:Pick<KnowledgeTask,'acceptedAt'|'expiresAt'>):number {
  // Candidate allowance for final source checks, eligibility, send and
  // settlement, each separately bounded below. This is a scheduling reserve,
  // not a production latency percentile or a guarantee of successful delivery.
  return task.expiresAt-Math.min(15000,Math.max(1500,Math.floor((task.expiresAt-task.acceptedAt)*0.375)));
}
export async function knowledgeOperation<T>(work:(signal:AbortSignal)=>PromiseLike<T>,options:{
  signal?:AbortSignal;deadlineAt?:number;timeoutMs?:number;independent?:boolean;factualResult?:boolean;
}={}):Promise<T> {
  const parent=options.independent?undefined:scope.getStore();
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,...(parent?[parent.signal]:[]),...(options.signal?[options.signal]:[])]);
  const deadlineAt=Math.min(parent?.deadlineAt??Infinity,options.deadlineAt??Infinity,Date.now()+(options.timeoutMs??KNOWLEDGE_OPERATION_LIMITS.databaseMs));
  let timer:ReturnType<typeof setTimeout>|undefined;let aborted:(()=>void)|undefined;
  try {
    if(signal.aborted || Date.now()>=deadlineAt)throw new Error('knowledge_operation_stopped');
    return await scope.run({signal,deadlineAt},async()=>{
      const stopped=new Promise<never>((_,reject)=>{
        aborted=()=>reject(new Error('knowledge_operation_stopped'));signal.addEventListener('abort',aborted,{once:true});
        timer=setTimeout(()=>controller.abort(),Math.max(1,deadlineAt-Date.now()));
      });
      const value=await Promise.race([Promise.resolve().then(()=>{
        if(signal.aborted || Date.now()>=deadlineAt)throw new Error('knowledge_operation_stopped');
        return work(signal);
      }),stopped]);
      // A response already received may record a fact after its send deadline;
      // it never authorizes another operation. Timed-out races still reject.
      if(!options.factualResult && (signal.aborted || Date.now()>=deadlineAt))throw new Error('knowledge_operation_stopped');
      return value;
    });
  } finally {
    if(timer)clearTimeout(timer);if(aborted)signal.removeEventListener('abort',aborted);controller.abort();
  }
}
export function knowledgeDatabaseRead<T=any>(query:any):Promise<T> {
  return knowledgeOperation(signal=>typeof query.abortSignal==='function'?query.abortSignal(signal):query);
}
