import test from 'node:test';
import assert from 'node:assert/strict';
import {captureKnowledgeProviderReceipt as capture,type ReceiptCheckpoint} from './knowledge-provider-receipt-capture';
import {safeDiagnostic} from './knowledge-multilingual-acceptance-policy';

const original={usage:{input_tokens:10,output_tokens:5},output_text:'private-customer-placeholder'};
const validate=(raw:unknown)=>{assert.ok(raw&&typeof raw==='object'&&'usage' in raw);const u=raw.usage;assert.ok(u&&typeof u==='object'&&'input_tokens'in u&&'output_tokens'in u);assert.equal(u.input_tokens,10);assert.equal(u.output_tokens,5);return u;};
test('capture preserves exact response, body and existing usage validation; checkpoints contain no private data',async()=>{
 const events:ReceiptCheckpoint[]=[],response=new Response(JSON.stringify(original));
 const captured=await capture(async()=>response,{checkpoint:e=>events.push(e),diagnosticGuard:raw=>{safeDiagnostic(raw);},validateUsage:validate});
 assert.strictEqual(captured.response,response);assert.deepEqual(captured.raw,original);assert.deepEqual(await response.json(),original);
 assert.deepEqual(events.map(e=>e.phase),['awaiting_headers','headers_received','body_read','body_decoded','receipt_serialized','diagnostic_accepted','usage_validated']);
 assert.doesNotMatch(JSON.stringify(events),/private-customer|output_text|"usage":|input_tokens/);
});
for(const mode of ['headers','body','malformed','serialization','redaction','missing-usage','invalid-usage','cancel','timeout'] as const)test(`privacy-safe failure classification: ${mode}`,async t=>{
 const events:ReceiptCheckpoint[]=[],controller=new AbortController();let now=100;
 const response=new Response(mode==='malformed'?'{invalid':JSON.stringify(mode==='missing-usage'?{text:'private-customer-placeholder'}:mode==='invalid-usage'?{usage:{input_tokens:-1}}:original),{status:mode==='missing-usage'?400:200});
 const privateError=new Error('Bearer private-error-message sk-private-credential');
 if(mode==='body')t.mock.method(response,'clone',()=>{throw privateError;});
 if(mode==='serialization')t.mock.method(response,'clone',()=>{const cloned=new Response();t.mock.method(cloned,'json',async()=>({usage:original.usage,value:1n}));return cloned;});
 const run=()=>capture(async()=>{if(mode==='headers')throw privateError;if(mode==='cancel'||mode==='timeout'){now=mode==='timeout'?300:150;controller.abort();}return response;},
  {checkpoint:e=>events.push(e),diagnosticGuard:raw=>{if(mode==='redaction')safeDiagnostic({Authorization:'Bearer private-header'});safeDiagnostic(raw);},validateUsage:validate,signal:controller.signal,deadlineAt:200,now:()=>now});
 await assert.rejects(run);
 const expected={headers:'headers_transport_failure',body:'body_transport_read_failure',malformed:'body_decode_failure',serialization:'receipt_serialization_failure',redaction:'diagnostic_redaction_rejection','missing-usage':'usage_metadata_missing','invalid-usage':'usage_metadata_invalid',cancel:'cancelled',timeout:'timeout'};
 assert.equal(events.at(-1)?.failure,expected[mode]);assert.doesNotMatch(JSON.stringify(events),/private|Bearer|sk-|input_tokens|output_text|Authorization/);
 if(mode!=='headers')assert.ok(events.some(e=>e.phase==='headers_received'&&e.httpStatus===(mode==='missing-usage'?400:200)));
 assert.doesNotThrow(()=>safeDiagnostic(events));
});
test('original usage/assertion failure identity survives for the caller; no ledger side effects',async()=>{
 const sentinel=Object.assign(new Error('controlled'),{code:'ERR_ASSERTION'});let observed:unknown;
 try{await capture(async()=>new Response(JSON.stringify(original)),{checkpoint:()=>{},diagnosticGuard:()=>{},validateUsage:()=>{throw sentinel;}});}catch(e){observed=e;}
 assert.strictEqual(observed,sentinel);
});
