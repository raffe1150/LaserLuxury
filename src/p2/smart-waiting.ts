import { runOptionalDiagnostic } from '../ai/business-information-timing';
import { approvedWaitingText, waitingLanguage, waitingText, waitingTopic, type WaitingStage } from './smart-waiting-presentation';
import type { KnowledgeTask, DeliveryOutcome } from './knowledge-lifecycle';
import type { NativeKnowledgeProgressAuthority } from './knowledge-progress-authority';

export type WaitingControls=Readonly<{enabled:boolean;delayMs:number}>;
export function smartWaitingControls(env:NodeJS.ProcessEnv=process.env):WaitingControls {
  const raw=env.ODINLINK_SMART_WAITING_DELAY_MS;
  const delay=raw===undefined?5000:Number(raw);
  // Invalid optional configuration disables waiting; never breaks Knowledge.
  const valid=Number.isSafeInteger(delay)&&delay>=1000&&delay<=10000 && (raw===undefined||/^\d+$/u.test(raw));
  return Object.freeze({enabled:valid&&env.ODINLINK_SMART_WAITING==='true',delayMs:valid?delay:5000});
}
export type WaitingHandle={progress(stage:WaitingStage|null,labels?:readonly string[]):void;stop():void};
export type WaitingSchedule=(run:()=>void,delayMs:number)=>()=>void;
const schedule:WaitingSchedule=(run,ms)=>{const timer=setTimeout(run,ms);timer.unref();return ()=>clearTimeout(timer);};
const idle:WaitingHandle={progress:()=>{},stop:()=>{}};
/** Small bounded side task, not a queue. All claim/dedup authority stays durable.
 * No promise from this module is awaited by execution or final publication. */
export class SmartWaitingCoordinator {
  private active=new Set<()=>void>();private pending=new Set<Promise<void>>();private stopped=false;
  private variants=new Map<string,number>();
  constructor(private readonly options:{controls:()=>WaitingControls;authority:NativeKnowledgeProgressAuthority;
    send:(target:NonNullable<Awaited<ReturnType<NativeKnowledgeProgressAuthority['dispatchTarget']>>>,text:string,signal:AbortSignal)=>Promise<DeliveryOutcome>;
    schedule?:WaitingSchedule;diagnostic?:(event:{stage:string;turnId:string;channel:string;outcome?:string})=>unknown}){}
  private controls(){try{const c=this.options.controls();return Number.isSafeInteger(c.delayMs)&&c.delayMs>=1000&&c.delayMs<=10000?c:{enabled:false,delayMs:5000};}catch{return {enabled:false,delayMs:5000};}}
  private event(task:KnowledgeTask,stage:string,outcome?:string){runOptionalDiagnostic(()=>this.options.diagnostic?.({stage,turnId:task.turnId,channel:task.scope.channel,...(outcome?{outcome}:{})}));}
  begin(task:KnowledgeTask,parent:AbortSignal):WaitingHandle {
    if(this.stopped||!this.controls().enabled||parent.aborted||!task.lease||task.state!=='RUNNING'||!waitingLanguage(task.input.language))return idle;
    const abort=new AbortController();const token={taskId:task.id,owner:task.lease.owner,fence:task.fence};
    let cancel:(()=>void)|undefined;let attempted=false;let stage:WaitingStage|null=null;let labels:readonly string[]=[];
    const stop=()=>{cancel?.();cancel=undefined;abort.abort();parent.removeEventListener('abort',stop);this.active.delete(stop);};
    parent.addEventListener('abort',stop,{once:true});this.active.add(stop);
    const work=async()=>{
      if(!stage||attempted||abort.signal.aborted||!this.controls().enabled||this.pending.size>=2||task.expiresAt-Date.now()<4000)return;
      const phase=stage;attempted=true;this.event(task,'waiting_attempt');
      let claim:Awaited<ReturnType<NativeKnowledgeProgressAuthority['claim']>>=null;
      let enteredTransport=false;let deliveredOutcome:DeliveryOutcome|undefined;
      try {
        // Retry/recovery must reuse the original approved wording exactly.
        const stored=await this.options.authority.existingText(task.scope,task.id);
        const key=`${task.scope.businessId}:${task.scope.channel}:${task.input.language}`;
        let variant=task.sequence%3;if(this.variants.get(key)===variant)variant=(variant+1)%3;
        let text=stored;
        if(text===null){text=waitingText(task.input.language,phase,waitingTopic(labels),variant);this.variants.delete(key);this.variants.set(key,variant);
          if(this.variants.size>128)this.variants.delete(this.variants.keys().next().value!);}
        if(!text||!approvedWaitingText(task.input.language,text,phase)||stage!==phase||abort.signal.aborted||!this.controls().enabled)return;
        claim=await this.options.authority.claim(task.scope,token,text,abort.signal);
        if(!claim)return;
        const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,claim.until-Date.now()))]);
        const target=await this.options.authority.dispatchTarget(task.scope,claim,signal);
        if(!target||stage!==phase||signal.aborted||!this.controls().enabled){await this.options.authority.settle(task.scope,claim,{kind:'DEFINITIVELY_UNSENT',retryable:false});return;}
        enteredTransport=true;
        const outcome=await this.options.send(target,claim.text,signal);deliveredOutcome=outcome;
        this.event(task,'waiting_transport_result',outcome.kind);
        if(!await this.options.authority.settle(task.scope,claim,outcome))this.event(task,'waiting_settlement_unconfirmed');
      } catch {
        // Optional waiting failure cannot alter a model, verifier or final send.
        this.event(task,'waiting_failed');
        if(claim){try{if(!await this.options.authority.settle(task.scope,claim,deliveredOutcome||(enteredTransport?{kind:'AMBIGUOUS'}:{kind:'DEFINITIVELY_UNSENT',retryable:false})))this.event(task,'waiting_settlement_unconfirmed');}catch{this.event(task,'waiting_settlement_unconfirmed');}}
      }
    };
    return {progress:(next,context=[])=>{
      if(abort.signal.aborted)return;stage=next;labels=context.slice(0,8);if(attempted)return;
      if(next&&!cancel)cancel=(this.options.schedule||schedule)(()=>{
        cancel=undefined;
        let pending:Promise<void>;pending=work().finally(()=>this.pending.delete(pending));this.pending.add(pending);
      },this.controls().delayMs);
    },stop};
  }
  stop(){this.stopped=true;for(const stop of [...this.active])stop();}
  async drain(){await Promise.allSettled([...this.pending]);}
}
