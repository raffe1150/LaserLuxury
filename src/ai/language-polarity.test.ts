import test from 'node:test';
import assert from 'node:assert/strict';
import {languagePolarityCases} from '../../tests/fixtures/language-polarity-cases';
import {detectExplicitLanguageSwitch,languageSwitchDecision} from './channel-reliability';
process.env.NODE_ENV='test';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
for(const row of languagePolarityCases){
 for(const text of row.positive)test(`${row.language}: affirmative ${text}`,()=>assert.equal(detectExplicitLanguageSwitch(text),row.language));
 for(const text of [...row.negative,row.uncertain])test(`${row.language}: rejected instruction cannot become implicit language ${text}`,async()=>{
  assert.deepEqual(languageSwitchDecision(text),{language:null,blocksImplicit:true});
  b.reset();let evaluated=false;
  b.configure({semanticLanguageResolver:async()=>{evaluated=true;return{language:row.language,requestedReplyLanguage:row.language,confidence:.99};}});
  b.resolveConversationLanguage('polarity','Please reply in English.',{language:'en'});
  assert.equal(b.resolveConversationLanguage('polarity',text,{language:'en'}),'en');
  assert.equal(await b.prepareConversationLanguageForTest('polarity',text,{language:'en'}),'en');
  assert.equal(evaluated,false,'Rejected instructions must not be reauthorized by semantic detection');
  assert.equal(b.resolveConversationLanguage('polarity','OK.',{language:'en'}),'en');
  assert.equal(b.resolveConversationLanguage('polarity',row.positive[0],{language:'en'}),row.language);
  assert.equal(b.resolveConversationLanguage('polarity','Please reply in English.',{language:'en'}),'en');b.reset();
 });
 test(`${row.language}: independent positive survives unrelated negative target`,()=>{
  const target=row.language==='en'?'de':'en';
  const positive=target==='de'?'Please reply in German.':'Please reply in English.';
  assert.equal(detectExplicitLanguageSwitch(`${row.negative[0]} ${positive}`),target);
  assert.equal(detectExplicitLanguageSwitch(`${positive} ${row.negative[0]}`),target);
 });
 test(`${row.language}: contradictory speech instructions cannot authorize a switch`,()=>{
  assert.deepEqual(languageSwitchDecision(`${row.positive[0]} ${row.negative[0]}`),{language:null,blocksImplicit:true});
  assert.deepEqual(languageSwitchDecision(`${row.negative[0]} ${row.positive[0]}`),{language:null,blocksImplicit:true});
 });
 test(`${row.language}: quotes and code cannot forbid a genuine positive instruction`,()=>{
  for(const quoted of [`"${row.negative[0]}"`,`\`${row.negative[0]}\``,`\`\`\`\n${row.negative[0]}\n\`\`\``])
   assert.equal(detectExplicitLanguageSwitch(`${quoted} ${row.positive[0]}`),row.language);
 });
}
for(const text of ['Please reply in German and not German.','Please reply in German or Spanish.','Please reply in German; please reply in Spanish.'])test(`ambiguous targets retain the lock: ${text}`,()=>assert.deepEqual(languageSwitchDecision(text),{language:null,blocksImplicit:true}));
test('language polarity projection never deletes the original information request',async()=>{
 b.reset();const text='لطفاً به فارسی صحبت نکن. What is your address?';
 const config={id:77,businessId:77,language:'en',businessName:'Synthetic',address:'Studio Road',services:[]};
 b.configure({knowledgeSearch:async()=>[],semanticKnowledgeSearch:async()=>[],postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100})});
 b.resolveConversationLanguage('original-request','Please reply in English.',config);
 await b.turn({sessionId:'original-request',platformName:'telegram',recipientUserId:'original-request',text,businessConfig:config});
 const {normalizeConversationText}=await import('./booking-intelligence');
 assert.equal(b.businessInformationState('original-request')?.question,normalizeConversationText(text));b.reset();
});
for(const row of languagePolarityCases)test(`${row.language}: rejected instruction preserves active booking language and customer details`,async()=>{
 b.reset();const config={id:77,businessId:77,language:'en',services:[{id:'svc',name:'Consultation',durationMinutes:30}]};
 const session=`booking-polarity-${row.language}`;
 b.seedPending(session,{businessId:'77',platform:'telegram',userId:session,businessConfig:config,operation:'new_booking',status:'awaiting_contact',expectedInput:'contact',language:'en',service:'Consultation',serviceId:'svc',customerName:'Mira Synthetic',customerPhone:'0701234567',contactPhoneSource:'explicit_customer_message'});
 b.resolveConversationLanguage(session,'Please reply in English.',config);
 const before=b.pendingStateSnapshot(session);
 b.configure({semanticLanguageResolver:async()=>{throw Error('rejected instruction cannot be semantically reauthorized');}});
 assert.equal(await b.prepareConversationLanguageForTest(session,row.negative[0],config),'en');
 const after=b.pendingStateSnapshot(session);
 assert.deepEqual(after,before);b.reset();
});
