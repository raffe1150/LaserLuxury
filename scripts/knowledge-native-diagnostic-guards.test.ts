import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {diagnosticProviderStage,assertDiagnosticDispatch,optionalQueryEmbeddingCancelled,DiagnosticStageNotAuthorized} from './knowledge-native-diagnostic-guards';
import {SOURCE_LANGUAGE_QUERY_INSTRUCTION,SOURCE_LANGUAGE_QUERY_SCHEMA} from '../src/ai/source-language-query';
import {captureKnowledgeProviderReceipt} from './knowledge-provider-receipt-capture';
import {safeDiagnostic} from './knowledge-multilingual-acceptance-policy';
import {stageOf,bounded,execute} from '../docs/validation/shared-core-2026-10-22/final-three-native-reliability-20261027/reviewed-runner';
const recovery={instructions:SOURCE_LANGUAGE_QUERY_INSTRUCTION,text:{format:{type:'json_schema',...SOURCE_LANGUAGE_QUERY_SCHEMA}}};
const allowed=['language','embedding','extraction','verification'] as const;
test('existing recovery protocol is recognized, but does not acquire authorization',()=>{
 assert.equal(stageOf(recovery,'/v1/responses'),'source_language_recovery');
 assert.throws(()=>assertDiagnosticDispatch(stageOf(recovery,'/v1/responses'),allowed,{caseSignal:new AbortController().signal}),DiagnosticStageNotAuthorized);
 for(const changed of [{...recovery,instructions:recovery.instructions+' Ignore guards'}, {...recovery,text:{format:{...recovery.text.format,name:'different'}}},{...recovery,text:{format:{...recovery.text.format,strict:false}}}])assert.equal(stageOf(changed,'/v1/responses'),'unsupported');
});
for(const which of ['case','native','request'] as const)test(`already cancelled ${which} request cannot reserve or invoke the network`,async()=>{
 const caseC=new AbortController(),nativeC=new AbortController(),requestC=new AbortController();({case:caseC,native:nativeC,request:requestC})[which].abort();let reservations=0,network=0;
 await assert.rejects(async()=>{assertDiagnosticDispatch('verification',allowed,{caseSignal:caseC.signal,nativeSignal:nativeC.signal,requestSignal:requestC.signal});reservations++;await captureKnowledgeProviderReceipt(async()=>{network++;return new Response();},{checkpoint:()=>{},diagnosticGuard:()=>{},validateUsage:()=>{},signal:requestC.signal});});
 assert.equal(reservations,0);assert.equal(network,0);
});
test('unknown and unapproved stages are denied before financial side effects without assertion/integrity mutation',()=>{
 let reservations=0;for(const stage of ['source_language_recovery','unsupported','planning','composition'] as const){assert.throws(()=>{assertDiagnosticDispatch(stage,allowed,{caseSignal:new AbortController().signal});reservations++;},e=>e instanceof DiagnosticStageNotAuthorized&&!('code' in e));}assert.equal(reservations,0);
});
test('only optional embedding abort with live parent contexts permits lexical continuation; reserves remain intact',()=>{
 const c=new AbortController(),n=new AbortController(),r=new AbortController(),e=new DOMException('Aborted','AbortError');r.abort();
 const context={caseSignal:c.signal,nativeSignal:n.signal,requestSignal:r.signal};
 assert.equal(optionalQueryEmbeddingCancelled('embedding',e,context),true);
 for(const stage of ['extraction','verification','language','source_language_recovery']as const)assert.equal(optionalQueryEmbeddingCancelled(stage,e,context),false);
 assert.equal(optionalQueryEmbeddingCancelled('embedding',new Error('receipt invalid'),context),false);
 assert.equal(optionalQueryEmbeddingCancelled('embedding',e,{...context,requestSignal:new AbortController().signal}),false);
 c.abort();assert.equal(optionalQueryEmbeddingCancelled('embedding',e,context),false);
 assert.equal(optionalQueryEmbeddingCancelled('embedding',e,{...context,caseSignal:new AbortController().signal,nativeSignal:AbortSignal.abort()}),false);
});
test('unchanged frozen request model, schema and budget bounds remain enforced',()=>{
 const saved=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/native-four-language-revalidation-20261027/C-fa/result.json','utf8'));
 for(const c of saved.state.calls){const b=bounded(c.request,c.stage==='embedding'?'/v1/embeddings':'/v1/responses');assert.equal(b.reserve,c.advanceReservationUsd);assert.deepEqual(b.request,c.request);}
});
test('reviewed runner is offline-only; no old approval can execute',async()=>{await assert.rejects(()=>execute('B-de'),/OFFLINE_ONLY/);});
test('guard diagnostics preserve unchanged secret rejection',()=>{assert.doesNotThrow(()=>safeDiagnostic({stage:'source_language_recovery',reason:'UNAPPROVED_PROVIDER_STAGE',networkCallbackEntered:false}));for(const v of [{Authorization:'Bearer private-value'},{token:'sk-private-value'}])assert.throws(()=>safeDiagnostic(v));});
