/** Offline-reviewed native diagnostic transport guards. These grant no provider
 * budget, source authority, semantic verdict or publication permission. */
import {isDeepStrictEqual} from 'node:util';
import {SOURCE_LANGUAGE_QUERY_INSTRUCTION,SOURCE_LANGUAGE_QUERY_SCHEMA} from '../src/ai/source-language-query';

export type DiagnosticStage='language'|'embedding'|'extraction'|'verification'|'planning'|
  'source_language_recovery'|'composition'|'presentation_verification'|'unsupported';
type WireRequest={instructions?:unknown;text?:{format?:unknown}};
export function diagnosticProviderStage(body:WireRequest,path:string):DiagnosticStage {
  if(path==='/v1/embeddings')return 'embedding';
  const instruction=typeof body.instructions==='string'?body.instructions:'';
  // Recognize the existing protocol without classifying arbitrary translated
  // instructions as an approved request. Selection is separate from admission.
  if(instruction===SOURCE_LANGUAGE_QUERY_INSTRUCTION &&
    isDeepStrictEqual(body.text?.format,{type:'json_schema',...SOURCE_LANGUAGE_QUERY_SCHEMA}))return 'source_language_recovery';
  return instruction.includes('language-routing classifier')?'language':
    instruction.includes('UNIT EXTRACTION')?'extraction':instruction.includes('BATCH ENTAILMENT')?'verification':
    /query planner/iu.test(instruction)?'planning':instruction.includes('VERIFIED-UNIT PRESENTATION')?'composition':
    instruction.includes('PRESENTATION')&&instruction.includes('VERIFICATION')?'presentation_verification':'unsupported';
}
export class DiagnosticStageNotAuthorized extends Error {
  constructor(readonly stage:DiagnosticStage){super('Diagnostic stage not authorized; no provider dispatch');this.name='DiagnosticStageNotAuthorized';}
}
export type DispatchContext=Readonly<{requestSignal?:AbortSignal|null;caseSignal:AbortSignal;nativeSignal?:AbortSignal}>;
/** Caller MUST run this before request registration or financial reservation.
 * Recheck immediately before network invocation as cancellation can race admission. */
export function assertDiagnosticDispatch(stage:DiagnosticStage,allowed:readonly DiagnosticStage[],context:DispatchContext):void {
  context.caseSignal.throwIfAborted();context.nativeSignal?.throwIfAborted();context.requestSignal?.throwIfAborted();
  if(stage==='unsupported'||!allowed.includes(stage))throw new DiagnosticStageNotAuthorized(stage);
}
/** Only the product's optional query-embedding cancellation is recoverable.
 * The consumer still decides whether lexical evidence supports a verified reply.
 * This never releases unknown usage, retries, or accepts a provider verdict. */
export function optionalQueryEmbeddingCancelled(stage:DiagnosticStage,error:unknown,context:DispatchContext):boolean {
  return stage==='embedding' && error instanceof Error && error.name==='AbortError' &&
    context.requestSignal?.aborted===true && !context.caseSignal.aborted && !context.nativeSignal?.aborted;
}
