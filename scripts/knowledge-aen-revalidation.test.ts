import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aenRoot,aenRevalidationRoot,aenSpec,revalidationTransport,validateRevalidationLedger,validateAenScope,verifyCandidate,aenTransport,requestCeiling,estimateUsage,type AenState} from './knowledge-aen-single-provider';
import {claimCase,latchFailure,sha256,safeDiagnostic,admitRequest} from './knowledge-multilingual-acceptance-policy';
const original=JSON.parse(readFileSync(join(aenRoot,'ledger-before.json'),'utf8'));
const historical=JSON.parse(readFileSync(join(aenRevalidationRoot,'ledger-before.json'),'utf8'));
const approval=JSON.parse(readFileSync(join(aenRevalidationRoot,'execution-approval.json'),'utf8'));
const binding=verifyCandidate(true);
const body={model:'gpt-5.6-luna',instructions:'UNIT EXTRACTION',input:[{content:JSON.stringify({evidence:[{businessId:77}]})}],max_output_tokens:100};
function setup(network:typeof fetch){
 const ledger=structuredClone(historical),state:AenState={stopReason:null,calls:[],replies:[],startedAt:performance.now()},controller=new AbortController();let writes=0;
 const guarded=aenTransport({ledger,historical:original,key:'synthetic-private-sentinel',state,controller,network,save:()=>{},saveLedger:()=>{validateRevalidationLedger(ledger,historical);writes++;}});
 const transport=revalidationTransport(guarded,ledger,historical,state,controller,()=>{});
 const call=(b:any=body,url='https://api.openai.com/v1/responses',signal?:AbortSignal)=>transport(url,{method:'POST',body:JSON.stringify(b),signal});
 return {ledger,state,controller,call,transport,writes:()=>writes};
}
const ok=()=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}),{status:200});
test('fixed candidate, exact question, approval and untouched historical accounting',()=>{
 validateAenScope(approval,binding.bindings);assert.equal(aenSpec.id,'A-en');assert.equal(historical.calls.length,161);assert.equal(historical.unmeteredReserveUsd,.34);
 assert.equal(sha256(readFileSync('docs/validation/shared-core-2026-10-22/source-aware-usage.json')),binding.ledgerSha256);
});
for(const [field,value]of Object.entries({caseId:'B-en',channel:'whatsapp',language:'sv',businessId:88,automaticRetry:true,localCapUsd:2,candidateSha256:'0'.repeat(64)}))test(`deny changed authorization ${field}`,()=>assert.throws(()=>validateAenScope({...approval,[field]:value},binding.bindings)));
test('exclusive one use and first-failure latch preserve original result',()=>{
 const dir=mkdtempSync(join(tmpdir(),'odin-aen-'));try{const result=claimCase(dir,'A-en',approval,binding.bindings);const bytes=readFileSync(result);assert.throws(()=>claimCase(dir,'A-en',approval,binding.bindings));assert.deepEqual(readFileSync(result),bytes);assert.ok(existsSync(join(dir,'A-en.consumed.json')));latchFailure(dir,'A-en','synthetic');assert.throws(()=>claimCase(dir,'A-en',approval,binding.bindings));}finally{rmSync(dir,{recursive:true});}
});
test('reserve persisted before provider then metered settlement; no headers captured',async()=>{
 let h:ReturnType<typeof setup>;h=setup(async()=>{assert.equal(h.ledger.unmeteredReserveUsd,historical.unmeteredReserveUsd+.02);assert.equal(h.writes(),1);return ok();});
 await h.call();assert.equal(h.state.calls.length,1);assert.equal(h.ledger.calls.length,162);assert.equal(h.ledger.unmeteredReserveUsd,.34);assert.equal(h.writes(),2);assert.equal(h.state.stopReason,null);assert.equal(h.ledger.calls.slice(0,160).length,160);safeDiagnostic(h.state,['synthetic-private-sentinel']);assert.equal(JSON.stringify(h.state).includes('headers'),false);
});
test('aborted call retains unknown reserve and stops all subsequent network',async()=>{
 let n=0;const abort=new AbortController();const h=setup(async()=>{n++;abort.abort();throw new DOMException('synthetic','AbortError');});await assert.rejects(h.call(body,undefined,abort.signal));assert.equal(h.state.stopReason,'PROVIDER_STAGE_ABORT');assert.equal(h.ledger.unmeteredReserveUsd,historical.unmeteredReserveUsd+.02);assert.equal(h.ledger.calls.length,161);await assert.rejects(h.call());assert.equal(n,1);
});
for(const [name,url,b]of [
 ['foreign destination','https://example.com/v1/responses',body],['wrong model','https://api.openai.com/v1/responses',{...body,model:'other'}],['foreign tenant','https://api.openai.com/v1/responses',{...body,input:[{content:JSON.stringify({evidence:[{businessId:88}]})}]}],['secret body','https://api.openai.com/v1/responses',{...body,instructions:'synthetic-private-sentinel'}],['oversized input','https://api.openai.com/v1/responses',{...body,instructions:'x'.repeat(100000)}],
]as const)test(`deny before network: ${name}`,async()=>{let n=0;const h=setup(async()=>{n++;return ok();});await assert.rejects(h.call(b,url));assert.equal(n,0);assert.equal(h.ledger.unmeteredReserveUsd,.34);});
test('insufficient cumulative headroom denied before network',async()=>{let n=0;const h=setup(async()=>{n++;return ok();});h.ledger.estimatedUsd=.67;await assert.rejects(h.call());assert.equal(n,0);assert.throws(()=>admitRequest(h.ledger,.02));});
test('request cap, incomplete and HTTP failures stop execution',async()=>{
 const h=setup(async()=>ok());h.state.calls=Array(7).fill({});await assert.rejects(h.call());assert.equal(h.state.stopReason,'REQUEST_COUNT_CEILING');
 for(const [status,code]of [['incomplete',200],['failed',429]]as const){const x=setup(async()=>new Response(JSON.stringify({status,error:{type:'synthetic',code:'test'}}),{status:code}));await assert.rejects(x.call());assert.equal(x.ledger.unmeteredReserveUsd,historical.unmeteredReserveUsd+.02);assert.ok(x.state.stopReason);}
});
test('Telegram delivery intercepted; duplicate and other channels rejected',async()=>{
 let n=0;const h=setup(async()=>{n++;return ok();});await h.call({chat_id:'46700000001',text:'Synthetic response.'},'https://api.telegram.org/bot123456:synthetic-offline/sendMessage');assert.deepEqual(h.state.replies,['Synthetic response.']);assert.equal(n,0);await assert.rejects(h.call({chat_id:'46700000001',text:'duplicate'},'https://api.telegram.org/bot123456:synthetic-offline/sendMessage'));
 const x=setup(async()=>{n++;return ok();});await assert.rejects(x.call({recipient:{id:'46700000001'},message:{text:'test'}},'https://graph.facebook.com/v1/messages'));assert.equal(n,0);
});
test('ceilings, usage and secret-redaction fail closed',()=>{assert.equal(requestCeiling({...body,max_output_tokens:99999},'/v1/responses').request.max_output_tokens,8192);assert.equal(estimateUsage({input_tokens:-1}),null);assert.throws(()=>safeDiagnostic({Authorization:'Bearer fake'}));assert.throws(()=>safeDiagnostic({text:'sk-synthetic-secret'}));});

for(const kind of ['row161','lower-reserve','drop-row161','lower-metered'] as const)test(`all 161 historical rows and $.34 protected: ${kind}`,()=>{const c=structuredClone(historical);if(kind==='row161')c.calls[160]={changed:true};if(kind==='lower-reserve')c.unmeteredReserveUsd=.32;if(kind==='drop-row161')c.calls.pop();if(kind==='lower-metered')c.estimatedUsd-=.00001;assert.throws(()=>validateRevalidationLedger(c,historical));});
test('unexpected planner blocked without provider admission or network',async()=>{let calls=0;const h=setup(async()=>{calls++;return ok();});await assert.rejects(h.call({...body,instructions:'OdinLink multilingual Knowledge retrieval query planner'}));assert.equal(calls,0);assert.equal(h.state.stopReason,'UNEXPECTED_PLANNING_REQUEST');assert.equal(h.ledger.unmeteredReserveUsd,.34);await assert.rejects(h.call());assert.equal(calls,0);});
test('original authorization stays consumed; new root remains unconsumed before execution',()=>{assert.ok(existsSync(join(aenRoot,'A-en.consumed.json')));assert.ok(existsSync(join(aenRoot,'first-failure-stop.json')));assert.equal(existsSync(join(aenRevalidationRoot,'A-en.consumed.json')),false);assert.equal(approval.authorizationId,'A-en-revalidation-20261024-once');});
