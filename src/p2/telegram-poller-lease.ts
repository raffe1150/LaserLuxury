import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';

/** A polling cursor is provider acknowledgement authority, not Booking authority.
 * A lost/uncertain lease permanently stops this owner. A new instance must claim
 * a new fence; an old RPC response cannot revive local polling. */
export class TelegramPollerLease {
  readonly controller = new AbortController();
  private fence:number|null=null;
  private heartbeat:ReturnType<typeof setInterval>|undefined;
  private watchdog:ReturnType<typeof setTimeout>|undefined;
  private renewing=false;
  lastUpdateId=-1;
  nextOffset=0;
  constructor(private readonly db:KnowledgeDatabase,private readonly businessId:number,
    private readonly botId:string,private readonly owner:string) {}
  private lose(reason:unknown = new Error('telegram_poller_stopped')):void {
    this.controller.abort(reason);
    if(this.heartbeat)clearInterval(this.heartbeat);
    if(this.watchdog)clearTimeout(this.watchdog);
  }
  private async call(command:'claim'|'renew'|'commit'|'release',update?:number):Promise<any> {
    const timeout=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      let query=this.db.rpc('odin_telegram_poller_v1',{p_business:this.businessId,p_bot:this.botId,p_owner:this.owner,
        p_command:command,p_fence:this.fence,p_update:update??null});
      if(typeof query.abortSignal==='function')query=query.abortSignal(timeout.signal);
      const result:any=await Promise.race([query,new Promise((_,reject)=>{timer=setTimeout(()=>{
        timeout.abort();reject(new Error('telegram_poller_storage_timeout'));
      },5000);})]);
      if(result.error)throw new Error('telegram_poller_storage_unavailable');
      return result.data;
    } catch (error) {
      if (error instanceof Error && error.message === 'telegram_poller_storage_timeout') throw error;
      throw new Error('telegram_poller_storage_unavailable');
    } finally {if(timer)clearTimeout(timer);}
  }
  private arm(started:number):void {
    if(this.watchdog)clearTimeout(this.watchdog);
    // SQL leases last 60s. A local 50s watchdog starts BEFORE the RPC, avoiding
    // extending local ownership by network latency or comparing host/DB clocks.
    this.watchdog=setTimeout(()=>this.lose(new Error('telegram_poller_lease_lost')),Math.max(1,started+50000-Date.now()));
    this.watchdog.unref();
  }
  async acquire():Promise<boolean> {
    if(this.controller.signal.aborted || this.fence!==null)throw new Error('telegram_poller_stopped');
    const started=Date.now();
    try {
      const row=await this.call('claim');
      if(this.controller.signal.aborted)throw new Error('telegram_poller_stopped');
      if(!row)return false;
      if(row.owner!==this.owner || row.business_id!==this.businessId || row.bot_id!==this.botId ||
        !Number.isSafeInteger(Number(row.fence)) || Number(row.fence)<1 || !Number.isSafeInteger(Number(row.last_update_id)))throw new Error('telegram_poller_scope');
      this.fence=Number(row.fence);this.lastUpdateId=Number(row.last_update_id);
      this.nextOffset=row.cursor_reset_due===true?0:Math.max(0,this.lastUpdateId+1);this.arm(started);
      this.heartbeat=setInterval(()=>{
        if(this.renewing || this.controller.signal.aborted)return;
        this.renewing=true;
        void this.current().catch(()=>{}).finally(()=>{this.renewing=false;});
      },15000);this.heartbeat.unref();return true;
    } catch(error){this.lose(error);throw error;}
  }
  async current():Promise<void> {
    if(this.fence===null || this.controller.signal.aborted)throw new Error('telegram_poller_stopped');
    const started=Date.now();
    try {
      const row=await this.call('renew');
      if(!row || this.controller.signal.aborted)throw new Error('telegram_poller_lease_lost');
      this.nextOffset=row.cursor_reset_due===true?0:Math.max(0,Number(row.last_update_id)+1);
      this.arm(started);
    } catch(error){this.lose(error);throw error;}
  }
  async commit(updateId:number):Promise<void> {
    if(this.fence===null || this.controller.signal.aborted)throw new Error('telegram_poller_stopped');
    try {
      if(!await this.call('commit',updateId) || this.controller.signal.aborted)throw new Error('telegram_poller_cursor_unconfirmed');
      this.lastUpdateId=updateId;this.nextOffset=updateId+1;
    } catch(error){this.lose(error);throw error;}
  }
  async dispose(updateId:number,handler:()=>Promise<unknown>):Promise<void> {
    await this.current();
    if(await handler()===false)throw new Error('telegram_intake_unfinished');
    await this.commit(updateId);
  }
  async stop():Promise<void> {
    this.lose();
    if(this.fence!==null)try{await this.call('release');}catch{/* Expiry remains authoritative. */}
  }
}
