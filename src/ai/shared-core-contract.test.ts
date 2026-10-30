import test from 'node:test';
import assert from 'node:assert/strict';
import { numericalConstraintSafe } from './numerical-constraints';
import { hasExternalConversationReference } from './conversation-intent-continuity';
import { isBusinessInformationQuestion } from './business-information';
import { wholeQuestionInformationPlan,literalInformationFallback } from './knowledge-planning';
import { configuredServiceEvidence } from './configured-service-evidence';
import { sharedQuestions } from '../../tests/helpers/shared-core-incident';
import { isArrivalInformationQuestion } from './information-request-contract';
test('delay noun is arrival information only with a visit context and without fees or notice',()=>{
 const text='A delay of more than 15 minutes does not automatically cancel the visit; staff must first assess the situation, and the studio may need to reassess whether the visit can proceed as planned.';
 const source='Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan. Detta innebär inte att besöket automatiskt avbokas. Personalen behöver först bedöma situationen.';
 assert.equal(isArrivalInformationQuestion(text),true);
 assert.equal(numericalConstraintSafe(text,text,[source]),true);
 for(const question of ['Does a delay incur a cancellation fee for my visit?','What notice deadline applies to a delayed visit?','Can you delay sending the invoice?'])assert.equal(isArrivalInformationQuestion(question),false,question);
});
for(const [language,questions]of Object.entries(sharedQuestions))for(const[index,question]of questions.entries())test(`${language}/${index}: complete read-only question retains its local referent`,()=>{
 assert.equal(isBusinessInformationQuestion(question),true);assert.equal(hasExternalConversationReference(question),false);
 // A bounded literal shortcut is optional. Legitimate semantic planning must
 // retain transport recovery with the same full question, not a guessed fact.
 const plan=wholeQuestionInformationPlan(question,true)||literalInformationFallback(question,true);assert.ok(plan);assert.equal(plan.canonicalMeaning,question);assert.equal(plan.requestedFacets[0].obligations[0].description,question);
});
for(const text of ['Is it free?','Can I reserve it there?','Is that parking free?','Can I bring something to that place?','Kan jag boka den där?'])test(`external reference stays unresolved: ${text}`,()=>assert.equal(hasExternalConversationReference(text),true));
for(const [claim,source]of [
 ['Arrive approximately 10 minutes before your appointment.','Arrive approximately 10 minutes before your appointment.'],
 ['Kom cirka 10 minuter före din bokade tid.','Kom cirka 10 minuter före din bokade tid.'],
 ['Kommen Sie ungefähr 10 Minuten vor Ihrem Termin.','Kommen Sie ungefähr 10 Minuten vor Ihrem Termin.'],
 ['حدود 10 دقیقه قبل از نوبت برسید.','حدود 10 دقیقه قبل از نوبت برسید.'],
])test(`unbounded relative time does not acquire an inequality: ${claim}`,()=>{
 assert.equal(numericalConstraintSafe(claim,claim,[source]),true);
 assert.equal(numericalConstraintSafe(claim.replace('10','15'),claim.replace('10','15'),[source]),false);
});
test('relative time cannot reverse anchors or become a minimum',()=>{
 const source='Arrive approximately 10 minutes before the appointment.';
 for(const claim of ['Arrive 10 minutes after the appointment.','Arrive at least 10 minutes before the appointment.'])assert.equal(numericalConstraintSafe(claim,claim,[source]),false);
});
test('structured service evidence preserves identity, missing values and revisions',()=>{
 const input=[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true,accessToken:'must not leak'}];
 const first=configuredServiceEvidence(77,input)!;
 assert.doesNotMatch(first.text,/accessToken|must not leak/);assert.match(first.text,/Video Consultation/);
 assert.notEqual(configuredServiceEvidence(77,[{...input[0],price:301}])!.version,first.version);
 assert.notEqual(configuredServiceEvidence(88,input)!.sourceId,first.sourceId);
 assert.equal(configuredServiceEvidence(77,[{...input[0],active:false}]),null);
 const missing=configuredServiceEvidence(77,[{name:'Video Consultation'}])!;
 assert.doesNotMatch(missing.text,/price|duration|currency/);
});

test('source-language hint schema rejects malformed, oversized and injected object fields', async()=>{
 const {parseSourceLanguageQuery}=await import('./source-language-query');
 assert.equal(parseSourceLanguageQuery('{"query":"kvarglömda värdesaker 21 dagar"}'),'kvarglömda värdesaker 21 dagar');
 for(const raw of ['invalid','null','[]','{"query":""}','{"query":17}','{"query":"parking","businessId":88}',JSON.stringify({query:'x'.repeat(121)})])assert.equal(parseSourceLanguageQuery(raw),null);
});

test('supplied PDF contains all incident facts independently of the older production extraction',async()=>{
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 const {extractInProcess}=await import('../knowledge/documents/extraction-process');const {documentChunks}=await import('../knowledge/documents/service');
 const bytes=readFileSync(new URL('../../tests/fixtures/admotion-studio-shared-core.pdf',import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'4a38fc458f27dfa18e58802e7018efc54f9dec125058095a26f3c4ecbdaa339c');
 const parsed=documentChunks(await extractInProcess(bytes,'admotion studio1.pdf','application/pdf'),'admotion studio1.pdf');
 for(const literal of ['10 minuter','bokningsbekräftelse','förberedelseinstruktioner','15 minuter','inte att besöket automatiskt avbokas','21 dagar','Värdesaker registreras separat','beskriva föremålet','ersätter inte automatiskt'])assert.ok(parsed.content.includes(literal),literal);
});

test('source-language sampling reads beyond titles and disclaimer lines without trusting metadata',async()=>{
 const {sharedCorpus}=await import('../../tests/helpers/shared-core-incident');
 const corpus=await sharedCorpus(false);try{assert.deepEqual(await corpus.service.sourceLanguageHints(77),['sv']);}finally{corpus.cleanup();}
});

test('generic temporal references are not booking-success claims; actual assertions remain blocked',async()=>{
 const {containsUnverifiedBookingSuccessClaim:check}=await import('./reliability');
 const {containsWebOperationSuccess:webCheck}=await import('./web-response-integrity');
 assert.equal(check('First-time visitors should arrive approximately 10 minutes before their booked appointment so they have time to prepare calmly.'),false);
 assert.equal(check('Arrive 10 minutes before your confirmed appointment.'),false);
 // Exact rejected arrival prose from the saved production-equivalent English
 // adapter diagnostics. These must not be confused with a booking operation.
 for (const text of [
  'Customers visiting AdMotion Studio for the first time are recommended to arrive approximately 10 minutes before their booked time to prepare calmly.',
  'First-time visitors to AdMotion Studio are recommended to arrive approximately 10 minutes before their booked appointment so they have time to prepare calmly.',
  'As a first-time visitor, you are recommended to arrive approximately 10 minutes before your booked appointment so you have time to prepare calmly.',
  'First-time visitors are recommended to arrive approximately 10 minutes before their booked appointment so they have time to prepare calmly.',
 ]) {assert.equal(check(text),false,text);assert.equal(webCheck(text),false,text);}
 for(const text of ['Your appointment is booked.','We booked your appointment.','Your booked appointment is confirmed.','We confirmed your appointment; arrive before your booked appointment.','Your appointment is confirmed 10 minutes before your booked appointment.']){assert.equal(check(text),true,text);assert.equal(webCheck(text),true,text);}
});

test('actual unit parser rejects a wrong evidence ID or translated quote; never reassigns citations',async()=>{
 const {parseAnswerUnits,parseRequestedFacets,answerEvidence}=await import('./business-information-answer-plan');
 const facets=parseRequestedFacets([{subject:'studio',attribute:'arrival',questionType:'recommendation',obligations:[{description:'When should I arrive?',questionType:'recommendation'}]}]).facets;
 const evidence=answerEvidence(77,[{businessId:77,sourceId:'source-a',text:'Ta med din bekräftelse.'},{businessId:77,sourceId:'source-b',text:'Kom cirka 10 minuter före din bokade tid.'}]);
 const text='Arrive approximately 10 minutes before your booked appointment.';
 const unit={facetIds:['f1'],subject:'Visitor',predicate:'arrival time',value:'approximately 10 minutes before appointment',scope:'studio visit',modality:'recommended',negation:false,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e2',exactQuote:evidence[1].text}]};
 assert.equal(parseAnswerUnits({units:[unit]},facets,evidence,'en').units.length,1);
 for(const ref of [{evidenceId:'e1',exactQuote:evidence[1].text},{evidenceId:'e2',exactQuote:'Arrive approximately 10 minutes before your booked appointment.'}])assert.equal(parseAnswerUnits({units:[{...unit,evidenceRefs:[ref]}]},facets,evidence,'en').units.length,0);
});

test('real-provider unsupported service equivalence is vetoed while catalog amounts survive',async()=>{
 const {readFileSync}=await import('node:fs');
 const {parseAnswerUnits,parseRequestedFacets}=await import('./business-information-answer-plan');
 const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-core-service-scope-proposals.json',import.meta.url),'utf8'));
 const facets=parseRequestedFacets([{subject:'requested information',attribute:'price, duration, replacement',questionType:'description',obligations:[{description:sharedQuestions.de[1],questionType:'description'}]}]).facets;
 const events:any[]=[];
 const result=parseAnswerUnits(fixture.proposal,facets,fixture.evidence,'de',e=>events.push(e));
 assert.deepEqual(result.units.map(u=>u.id),['u2','u3']);
 assert.deepEqual(events.filter(e=>e.reason==='SOURCE_SCOPE').map(e=>e.unitId),['u1','u4']);
 assert.match(result.units[0].text,/300 SEK/);assert.match(result.units[1].text,/60 Minuten/);
});

test('service scope gate requires explicit document naming and preserves independent document facts',async()=>{
 const {configuredServiceScopeSupported:check}=await import('./configured-service-evidence');
 const catalog=configuredServiceEvidence(77,[{name:'Video Consultation',price:300,currency:'SEK'}])!;
 const doc={id:'e1',businessId:77,sourceId:'doc',chunkId:'chunk',version:'revision',text:'Digital information calls are introductory only.'};
 const unit={text:'Digital information calls are introductory only.',subject:'Digital information calls',predicate:'purpose',value:'introductory only',scope:'documented offering',qualifiers:[],evidenceRefs:[{evidenceId:'e1',sourceId:'doc',chunkId:'chunk',version:'revision',exactQuote:doc.text}]};
 assert.equal(check(unit,[catalog,doc]),true);
 assert.equal(check({...unit,scope:'Video Consultation'},[catalog,doc]),false);
 assert.equal(check({...unit,text:'Video Consultation is introductory only.'},[catalog,doc]),false);
 // Passing this extra gate never grants entailment; the verifier still checks
 // the relationship, all clauses and contradictory full context independently.
 assert.equal(check({...unit,text:'Video Consultation is introductory only.'},[catalog,{...doc,text:'Video Consultation is introductory only.'}]),true);
 assert.equal(check(unit,[catalog,{...doc,businessId:88}]),false);
});
