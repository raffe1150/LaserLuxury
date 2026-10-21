/** HTTP acceptance is distinct from a customer reply. Failures remain retryable
 * at the provider; concurrently completed messages are deduplicated on redelivery. */
export class NativeIntakeAcknowledgement {
  private readonly outcomes: Promise<boolean>[] = [];
  constructor(private readonly durable: boolean, private readonly response: {
    status(code:number): {send(body:string):unknown};
  }) {}
  acknowledge():void {
    if(!this.durable)this.response.status(200).send('EVENT_RECEIVED');
  }
  track(work:Promise<unknown>, failed:()=>void):void {
    this.outcomes.push(work.then(value=>value!==false,()=>{try{failed();}catch{}return false;}));
  }
  async complete():Promise<void> {
    if(!this.durable)return;
    const ok=(await Promise.all(this.outcomes)).every(Boolean);
    this.response.status(ok?200:503).send(ok?'EVENT_RECEIVED':'INTAKE_UNAVAILABLE');
  }
}
