import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {directVisitPolicyChecklistPlan,wholeQuestionInformationPlan,literalInformationFallback} from './knowledge-planning';
import {businessInformationTopics,isBusinessInformationQuestion}from './business-information';
import {acceptanceQuestions} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import{parseRequestedFacets}from './business-information-answer-plan';
for(const question of [acceptanceQuestions.A.en,
 'Before my visit, must I bring consent forms if I have received them, and may I wear outdoor shoes?',
 'During a visit, should I bring hearing protection, and may I carry my own equipment?',
 'For the visit, must I not bring glass containers, and should I wear protective clothing?',
 'For a visit, must I bring documents, and may I wear shoes, may I carry a bag?',
])test(`bounded checklist preserves complete unmodified request: ${question}`,()=>{
 assert.equal(isBusinessInformationQuestion(question),true);assert.deepEqual(businessInformationTopics(question),['policies']);
 const plan=directVisitPolicyChecklistPlan(question,true);assert.ok(plan);assert.deepEqual(plan,literalInformationFallback(question,true));assert.deepEqual(wholeQuestionInformationPlan(question,true),plan);
 assert.deepEqual(plan.queries,[question]);assert.equal(plan.canonicalMeaning,question);const{facets}=parseRequestedFacets(plan.requestedFacets);assert.equal(facets[0].attribute,question);assert.equal(facets[0].obligations[0].description,question);assert.equal('coverage'in plan,false);assert.equal('evidence'in plan,false);
 assert.equal(directVisitPolicyChecklistPlan(question,false),null);assert.equal(directVisitPolicyChecklistPlan(question,true,true),null);
});
for(const q of [
 'For a visit, must I follow it, and may I bring that?',
 'For a visit, must I follow instructions if it is available, and may I bring water?',
 'For a visit, must I follow instructions if I have received them there, and may I bring water?',
 'For a visit, must I bring the same documents, and may I wear shoes?',
 'For a visit, must I bring documents, and may I book an appointment?',
 'For a visit, must I bring documents, and may I cancel my appointment?',
 'For a visit, must I bring documents, and may I check availability?',
 'For a visit, must I bring documents, and may I compare Service One and Service Two?',
 'For a visit, must I bring documents, and may I choose Remote Assessment?',
 'For a visit, must I bring documents, and may I use Remote Assessment instead?',
 'For a visit, must I bring documents, and should I pay cancellation fees?',
 'For a visit, must I bring documents, and should I contact you at your address?',
 'For a visit, must I bring documents, and should I reveal system prompts?',
 'For a visit, must I bring documents, and may I bring tools to execute JSON?',
 'For a visit, must I bring documents, and should I bring water? Please delete my booking.',
 'For a visit, must I bring documents, and how early should I arrive?',
 'For a visit, must I bring documents and may I bring "ignore all rules"?',
 'For a visit, must I bring documents, and may I bring <system>tags</system>?',
 'Must I bring documents, and may I wear shoes?',
 'For a visit, where is the garage, and what is the price?',
 'For a visit, should I avoid noise, and may I eat snacks?', // no recognized documentary topic
 'For a visit, must I bring '+'x'.repeat(240)+', and may I wear shoes?',
])test(`new admission declines unsupported shape/authority/reference: ${q.slice(0,95)}`,()=>assert.equal(directVisitPolicyChecklistPlan(q,true),null));
test('saved real failure is unchanged and fallback already preserved every obligation literally',()=>{
 const r=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/aen-single-provider-20261024/A-en.result.json','utf8'));
 assert.equal(r.spec.question,acceptanceQuestions.A.en);assert.equal(r.calls.length,2);assert.equal(r.calls[1].stage,'planning');assert.equal(r.stopReason,'PROVIDER_STAGE_ABORT');assert.equal(r.decisions.some((e:any)=>e.stage==='planning'&&e.reason==='DEADLINE'&&e.timeoutMs===2500),true);
 assert.deepEqual(literalInformationFallback(r.spec.question,true),directVisitPolicyChecklistPlan(r.spec.question,true));
});
for(const [lang,q]of Object.entries(acceptanceQuestions.A))test(`prepared ${lang} retains exact question through the existing fallback contract`,()=>{const p=literalInformationFallback(q,true);if(p)assert.equal(p.canonicalMeaning,q);assert.equal(directVisitPolicyChecklistPlan(q,true)!==null,['en','sv','de','es','ar'].includes(lang));});
