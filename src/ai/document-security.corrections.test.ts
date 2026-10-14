import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.AI_PROVIDER='gemini';process.env.GEMINI_API_KEY='synthetic-offline';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const {KnowledgeService,InMemoryKnowledgeStorage}=await import('../../knowledge');
const fact='Customer parking is behind the studio.';
const config={id:77,businessName:'Synthetic',language:'en',systemPrompt:'',services:[]};
const question='Where is customer parking?';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function setup(effect?:()=>Promise<void>, groundingEffect?:()=>Promise<void>){
  b.reset();const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);
  await storage.create({id:'doc',businessId:77,type:'document',status:'ready',title:'Synthetic.txt',content:fact,metadata:{segments:[{start:0,end:fact.length}]},createdAt:'2026-10-13',updatedAt:'2026-10-13'});
  let validations=0;
  b.configure({knowledgeSearch:async()=>{storage.search=async()=>[{sourceId:'doc',businessId:77,text:fact}];return service.search(77,'parking');},semanticKnowledgeSearch:async()=>[],
    validateKnowledgeMatches:async(id,m)=>{validations++;return service.validateMatches(id,m);},
    geminiGenerate:async(p:any)=>{if(p.config.systemInstruction.includes('retrieval query planner'))return{text:'{"canonicalMeaning":"parking","queries":["parking"]}'};if(p.config.systemInstruction.includes("READ-ONLY BUSINESS INFORMATION"))await effect?.();return{text:fact};},
    assessBusinessSupportGrounding:async(r:any)=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[{claim:fact,candidateQuote:r.candidateReply,claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:fact}]}]}),
    assessBusinessClaimEntailment:async()=>{await groundingEffect?.();return{relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};},postProcess:async()=>{},
  });
  return {storage,validations:()=>validations};
}
afterEach(()=>b.reset());
test('conversation context expires during generation but request snapshot is still grounded and revalidated',async()=>{
  const original=Date.now;let offset=0;
  try{Date.now=()=>original()+offset;const state=await setup(async()=>{offset=120001;});
    const result=await b.promptAuditWeb({chatId:'expiry',message:question},config);
    assert.equal(result.body.text,fact);assert.ok(state.validations()>=4);
  }finally{Date.now=original;}
});
for(const change of ['delete','revise'] as const)test(`${change} during generation cannot publish captured source evidence`,async()=>{
  let state:Awaited<ReturnType<typeof setup>>;state=await setup(async()=>{
    if(change==='delete')await state.storage.delete(77,'doc');
    else{const old=(await state.storage.list(77))[0];await state.storage.create({...old,content:'Parking is unavailable.',metadata:{segments:[{start:0,end:23}]}});}
  });
  const result=await b.promptAuditWeb({chatId:change,message:question},config);assert.notEqual(result.body.text,fact);assert.match(result.body.text,/can't find/u);
});
test('active website context survives history-capacity eviction by another visitor',async()=>{
  const entered=deferred(),release=deferred();let calls=0;
  await setup(async()=>{if(++calls===1){entered.resolve();await release.promise;}});
  const pending=b.promptAuditWeb({chatId:'active',message:question},config);await entered.promise;
  b.seedWebsiteHistory(256);await b.promptAuditWeb({chatId:'new-visitor',message:question},config);
  assert.equal(b.websiteHistoryContains(b.promptAuditWebSession('active',config)),true);
  release.resolve();const result=await pending;assert.equal(result.body.text,fact);
});
test('superseded concurrent website request cannot publish or replace newer evidence',async()=>{
  const entered=deferred(),release=deferred();let calls=0;
  await setup(async()=>{if(++calls===1){entered.resolve();await release.promise;}});
  const pending=b.promptAuditWeb({chatId:'same',message:question},config);await entered.promise;
  const latest=await b.promptAuditWeb({chatId:'same',message:question},config);assert.equal(latest.body.text,fact);
  release.resolve();const old=await pending;assert.equal(old.status,409);assert.notEqual(old.body.text,fact);
});
test('real dispatcher rejects overlapping and expired tool-free invocations after conversation state changes',async()=>{
  await setup();const id='dispatcher';await b.turn({sessionId:id,platformName:'whatsapp',recipientUserId:'synthetic',text:question,businessConfig:config});
  const original=Date.now;let offset=0;
  try{Date.now=()=>original()+offset;
    await b.securedRequest(id,async()=>{
      await b.secureGenerate(id,{messages:[],systemInstruction:b.completedSupportInstruction(id),tools:[]});
      offset=120001;assert.deepEqual(b.documentToolDispatch([{function:{name:'logSystemAnalysis',arguments:'{}'}}],id),[]);
      await b.securedRequest(id,async()=>{await b.secureGenerate(id,{messages:[],systemInstruction:'Synthetic regular request',tools:[{functionDeclarations:[{name:'logSystemAnalysis'}]}]});});
      assert.deepEqual(b.documentToolDispatch([{function:{name:'checkSlots',arguments:'{}'}}],id),[]);assert.equal(await b.securePublication(fact),null);
    });
  }finally{Date.now=original;}
});
test('request deadline fails closed instead of returning a generated document answer',async()=>{
  const original=Date.now;let offset=0;
  try{Date.now=()=>original()+offset;await setup(async()=>{offset=300001;});const result=await b.promptAuditWeb({chatId:'deadline',message:question},config);assert.equal(result.status,409);assert.notEqual(result.body.text,fact);}
  finally{Date.now=original;}
});

test('source deleted during entailment is rejected by post-grounding revalidation',async()=>{
  let state:Awaited<ReturnType<typeof setup>>;state=await setup(undefined,async()=>{await state.storage.delete(77,'doc');});
  const result=await b.promptAuditWeb({chatId:'during-verifier',message:question},config);assert.notEqual(result.body.text,fact);assert.match(result.body.text,/can't find/u);
});
test('required document context missing at generation fails closed without calling the provider',async()=>{
  let calls=0;await setup(async()=>{calls++;});
  await b.securedRequest('missing-context',async()=>{const result=await b.secureGenerate('missing-context',{messages:[],systemInstruction:'untrusted_document_text: \"old evidence\"',tools:[]});assert.notEqual(result.text,fact);assert.equal(calls,0);assert.deepEqual(b.documentToolDispatch([{function:{name:'logSystemAnalysis',arguments:'{}'}}],'missing-context'),[]);});
});
