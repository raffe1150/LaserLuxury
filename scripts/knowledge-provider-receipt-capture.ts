/** Diagnostic transport only. No provider dispatch, credentials, ledger writes,
 * response rewriting or publication authority. Original errors propagate. */
export type ReceiptCapturePhase = 'awaiting_headers' | 'headers_received' | 'body_read' |
  'body_decoded' | 'receipt_serialized' | 'diagnostic_accepted' | 'usage_validated';
export type ReceiptCaptureFailure = 'headers_transport_failure' | 'body_transport_read_failure' | 'body_decode_failure' |
  'cancelled' | 'timeout' | 'receipt_serialization_failure' |
  'diagnostic_redaction_rejection' | 'usage_metadata_missing' | 'usage_metadata_invalid';
export type ReceiptCheckpoint = Readonly<{
  phase: ReceiptCapturePhase;
  elapsedMs: number;
  httpStatus?: number;
  failure?: ReceiptCaptureFailure;
}>;
type Options<T> = {
  checkpoint: (event: ReceiptCheckpoint) => void;
  diagnosticGuard: (raw: unknown) => void;
  validateUsage: (raw: unknown) => T;
  signal?: AbortSignal;
  /** Existing caller deadline, for classification only; does not extend it. */
  deadlineAt?: number;
  now?: () => number;
};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object';

export async function captureKnowledgeProviderReceipt<T>(
  receive: () => Promise<Response>, options: Options<T>,
): Promise<{response: Response; raw: unknown; usage: T}> {
  const now=options.now??Date.now,start=now();
  const state:{phase:ReceiptCapturePhase}={phase:'awaiting_headers'};
  let httpStatus:number|undefined;
  let failure:ReceiptCaptureFailure='headers_transport_failure';
  const checkpoint=(next:ReceiptCapturePhase,failed?:ReceiptCaptureFailure)=>{
    state.phase=next;
    // Deliberately no URL, headers, customer text, receipt body, exception
    // message, stack, request ID or arbitrary provider field in this event.
    options.checkpoint(Object.freeze({phase:state.phase,elapsedMs:Math.max(0,now()-start),
      ...(httpStatus===undefined?{}:{httpStatus}),...(failed?{failure:failed}:{})}));
  };
  checkpoint(state.phase);
  try {
    options.signal?.throwIfAborted();
    const response=await receive();
    httpStatus=response.status;
    checkpoint('headers_received');
    options.signal?.throwIfAborted();
    failure='body_transport_read_failure';checkpoint('body_read');
    // Same clone/json capture used by the retained runner. The original SDK
    // response remains readable and its parsing contract is unchanged.
    const raw:unknown=await response.clone().json();
    checkpoint('body_decoded');options.signal?.throwIfAborted();
    failure='receipt_serialization_failure';
    if(JSON.stringify(raw)===undefined)throw Error('Receipt serialization unavailable');
    checkpoint('receipt_serialized');
    failure='diagnostic_redaction_rejection';options.diagnosticGuard(raw);
    checkpoint('diagnostic_accepted');
    failure=object(raw)&&Object.hasOwn(raw,'usage')?'usage_metadata_invalid':'usage_metadata_missing';
    const usage=options.validateUsage(raw);checkpoint('usage_validated');
    return {response,raw,usage};
  } catch(error) {
    if(state.phase==='body_read'&&error instanceof SyntaxError)failure='body_decode_failure';
    if(options.signal?.aborted){
      const reason:unknown=options.signal.reason;
      const timeout=object(reason)&&reason.name==='TimeoutError' ||
        typeof options.deadlineAt==='number'&&Number.isFinite(options.deadlineAt)&&now()>=options.deadlineAt;
      failure=timeout?'timeout':'cancelled';
    }
    checkpoint(state.phase,failure);
    // Preserve assertion identity and the existing caller's first-failure,
    // integrity and unknown-reservation handling. Never log the error here.
    throw error;
  }
}
