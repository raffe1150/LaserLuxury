import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.AI_PROVIDER='gemini';process.env.GEMINI_API_KEY='synthetic-offline';
globalThis.fetch=async()=>{throw Error('Offline acceptance forbids provider network');};
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const source='För Synthetic Birch Studio ska en bokad tid avbokas senast 91 timmar före besöket.\nParkeringsgrindens märkning är BJORK-915.';
const question='چند ساعت قبل باید نوبت را لغو کنم و شناسه دروازه پارکینگ مشتریان چیست؟';
const config={id:8802,businessName:'Synthetic Birch Studio',language:'fa',systemPrompt:'',services:[]};
const bad='نوبت باید حداکثر ۹۱ ساعت پیش از زمان مراجعه لغو شود.';
const good='نوبت باید حداقل ۹۱ ساعت پیش از زمان مراجعه لغو شود.';
const gate='شناسه دروازه پارکینگ مشتریان «BJORK-915» است.';
afterEach(()=>b.reset());
for (const wrong of [true,false]) test(`exact real Business-B fixture: ${wrong?'max notice rejected despite lying ENTAILED verifier':'correct minimum supported'}`,async t=>{
 b.reset();for(const m of ['log','warn','error','info'] as const)t.mock.method(console,m,()=>undefined);
 const deadline=wrong?bad:good;const calls:any[]=[];
 b.configure({assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[
  {claim:deadline,candidateQuote:deadline,claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:source.split('\n')[0]}]},
  {claim:gate,candidateQuote:gate,claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:source.split('\n')[1]}]},
 ]}),assessBusinessClaimEntailment:async r=>{calls.push(r);return{relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};}});
 b.businessInformationState('B',config,question,'fa',source);
 const reply=await b.businessSupportGrounding('B',question,deadline+' '+gate,'fa');
 assert.doesNotMatch(reply,/TALL-742|۳۷/u);
 if(wrong){assert.doesNotMatch(reply,/حداکثر|۹۱/u);assert.ok(calls.every(c=>!c.atomicClaim.includes('۹۱')),'Rejected direction cannot reach entailment/retry/adjudication/recovery');}
 else {assert.equal(reply,good+' '+gate);assert.equal(calls.length,2);}
});
test('request-bound structured cancellation deadline cannot be overridden by a document even with ENTAILED verdicts',async t=>{
 b.reset();for(const m of ['log','warn','error','info'] as const)t.mock.method(console,m,()=>undefined);
 let calls=0;
 b.configure({assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[{claim:good,candidateQuote:good,claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:source.split('\n')[0]}]}]}),assessBusinessClaimEntailment:async()=>{calls++;return{relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};}});
 b.businessInformationState('structured-deadline',{...config,cancellationDeadlineMinutes:120},question,'fa',source);
 const reply=await b.businessSupportGrounding('structured-deadline',question,good,'fa');
 assert.doesNotMatch(reply,/۹۱/u);assert.equal(calls,0);
});
