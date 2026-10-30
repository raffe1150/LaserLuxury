import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const question='What does the visitor policy say about nibbling before being called?';
const config=(id=77)=>({id,businessId:id,businessName:'Synthetic language reuse',language:'sv',services:[]});
const decision=(language='en',confidence=.99)=>({language,requestedReplyLanguage:null,confidence});
function seed(session:string,language='en',cfg=config()){
 b.resolveConversationLanguage(session,`Please reply in ${{en:'English',sv:'Swedish',de:'German',es:'Spanish',fa:'Persian',ar:'Arabic'}[language]} from now on.`,cfg);
}
test('same-current-language confirmation reaches the existing resolver with one classifier call',async t=>{
 b.reset();t.mock.method(globalThis,'fetch',async()=>{throw Error('Offline only');});let calls=0;const cfg=config();seed('same','en',cfg);
 b.configure({semanticLanguageResolver:async(text,previous,c)=>{calls++;assert.equal(text,question);assert.equal(previous,'en');assert.equal(c.id,77);assert.equal(calls,1,'must not seek a conflicting second verdict');return decision();}});
 assert.equal(await b.prepareConversationLanguage('same',question,cfg),'en');assert.equal(calls,1);b.reset();
});
for(const language of ['en','sv','de','fa','es','ar'])test(`successful same-language current-turn routing: ${language}`,async()=>{
 b.reset();const cfg=config();seed(language,language,cfg);let calls=0;
 const text=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/candidate-retrieval-acceptance-freeze-20261026/questions.json','utf8')).find((q:any)=>q.id===`P1-${language}`).question;
 b.configure({semanticLanguageResolver:async()=>{calls++;return decision(language);}});
 assert.equal(await b.prepareConversationLanguage(language,text,cfg),language);assert.ok(calls<=1);assert.ok(calls>0);b.reset();
});
test('reuse never crosses successive invocations, even with identical question/session',async()=>{
 b.reset();seed('repeat');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;return decision();}});
 for(let i=0;i<3;i++)assert.equal(await b.prepareConversationLanguage('repeat',question,config()),'en');assert.equal(calls,3);b.reset();
});
for(const [name,first]of [['low',decision('en',.2)],['failed',null],['ambiguous',{}],['unsupported',decision('zh')],['nonfinite',decision('en',NaN)],['overrange',decision('en',2)]] as const)test(`unusable first decision retains guarded fresh classification: ${name}`,async()=>{
 b.reset();seed(name);let calls=0;b.configure({semanticLanguageResolver:async()=>++calls===1?first as any:decision()});
 assert.equal(await b.prepareConversationLanguage(name,question,config()),'en');assert.equal(calls,2);b.reset();
});
test('two low-confidence outcomes do not authorize a language change',async()=>{
 b.reset();seed('low-both');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;return decision('de',.1);}});
 assert.equal(await b.prepareConversationLanguage('low-both',question,config()),'en');assert.equal(calls,2);b.reset();
});
test('explicit switches, negation and quoted instructions stay ahead of semantic reuse',async()=>{
 b.reset();seed('switch');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;return decision('de');}});
 assert.equal(await b.prepareConversationLanguage('switch','Please reply in Swedish from now on.',config()),'sv');assert.equal(calls,0);
 assert.equal(await b.prepareConversationLanguage('switch','Do not reply in German.',config()),'sv');assert.equal(calls,0);
 b.configure({semanticLanguageResolver:async(text)=>{calls++;assert.doesNotMatch(text,/German|reply in/);return decision('sv');}});
 assert.equal(await b.prepareConversationLanguage('switch','What does “reply in German” mean?',config()),'sv');assert.equal(calls,1);b.reset();
});
test('existing requested-reply authority stays ahead of message-language confirmation',async()=>{
 b.reset();seed('request');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;return{language:'en',requestedReplyLanguage:'de',confidence:.99};}});
 assert.equal(await b.prepareConversationLanguage('request','Could we carry on in the language used in Berlin?',config()),'de');assert.equal(calls,1);b.reset();
});
test('strong deterministic language evidence retains priority over a same-previous semantic result',async()=>{
 b.reset();seed('deterministic');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;return decision();}});
 assert.equal(await b.prepareConversationLanguage('deterministic','Hej, jag vill veta vilka tjänster ni erbjuder och boka en tid imorgon.',config()),'sv');assert.equal(calls,1);b.reset();
});
test('a changed tenant binding cannot reuse the earlier result',async()=>{
 b.reset();const cfg=config();seed('tenant-change','en',cfg);let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;if(calls===1)cfg.id=cfg.businessId=88;return decision();}});
 assert.equal(await b.prepareConversationLanguage('tenant-change',question,cfg),'en');assert.equal(calls,2);b.reset();
});
test('a newer conversation-language decision prevents reuse of the earlier snapshot',async()=>{
 b.reset();const cfg=config();seed('history-change','en',cfg);let calls=0;
 b.configure({semanticLanguageResolver:async()=>{calls++;if(calls===1){seed('history-change','de',cfg);return decision();}return decision('de');}});
 assert.equal(await b.prepareConversationLanguage('history-change',question,cfg),'de');assert.equal(calls,2);b.reset();
});
test('closed native timing rejects reuse; existing cancellation remains authoritative',async()=>{
 b.reset();seed('closed');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;if(calls===1)nativeKnowledgeTiming()!.fail();return decision();}});
 await runAccuracyFirstNative(async()=>{await b.prepareConversationLanguage('closed',question,config());},async()=>{});
 for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls,2);b.reset();
});
test('concurrent sessions and tenants do not share a semantic decision',async()=>{
 b.reset();const a=config(77),c=config(88);const sa=b.channelSessionId('whatsapp','same-user',a,'scope-a'),sc=b.channelSessionId('whatsapp','same-user',c,'scope-c');assert.notEqual(sa,sc);seed(sa,'en',a);seed(sc,'de',c);
 const counts=new Map<number,number>();b.configure({semanticLanguageResolver:async(_text,_previous,cfg)=>{counts.set(cfg.id,(counts.get(cfg.id)||0)+1);return decision(cfg.id===77?'en':'de');}});
 assert.deepEqual(await Promise.all([b.prepareConversationLanguage(sa,question,a),b.prepareConversationLanguage(sc,question,c)]),['en','de']);assert.equal(counts.get(77),1);assert.equal(counts.get(88),1);b.reset();
});
test('test resolver exception is not reused or allowed to contaminate the next invocation',async()=>{
 b.reset();seed('throwing');let calls=0;b.configure({semanticLanguageResolver:async()=>{calls++;throw Error('controlled test resolver failure');}});
 await assert.rejects(b.prepareConversationLanguage('throwing',question,config()),/controlled test resolver failure/);
 b.configure({semanticLanguageResolver:async()=>{calls++;return decision();}});assert.equal(await b.prepareConversationLanguage('throwing',question,config()),'en');assert.equal(calls,2);b.reset();
});
