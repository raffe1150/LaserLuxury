import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceQuestions,preliminaryAcceptancePlan} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {directVisitPolicyChecklistPlan,wholeQuestionInformationPlan,literalInformationFallback} from './knowledge-planning';
import {parseRequestedFacets} from './business-information-answer-plan';
import {readFileSync} from 'node:fs';
const safe=['en','sv','de','es','ar'];
for(const [language,q]of Object.entries(acceptanceQuestions.A))test(`${language}: original checklist preserves full request, not invented obligations`,()=>{
 const plan=directVisitPolicyChecklistPlan(q,true);assert.equal(!!plan,safe.includes(language));
 if(plan){assert.deepEqual(plan,literalInformationFallback(q,true));assert.equal(plan.canonicalMeaning,q);assert.deepEqual(plan.queries,[q]);const {facets}=parseRequestedFacets(plan.requestedFacets);assert.equal(facets[0].attribute,q);assert.equal(facets[0].obligations[0].description,q);assert.equal('coverage'in plan,false);assert.equal('evidence'in plan,false);}
 assert.equal(directVisitPolicyChecklistPlan(q,false),null);assert.equal(directVisitPolicyChecklistPlan(q,true,true),null);
});
test('exact failed Swedish capture now reuses literal fallback without altering question',()=>{
 const r=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/asv-whatsapp-acceptance-20261025/A-sv.result.json','utf8'));assert.equal(r.spec.question,acceptanceQuestions.A.sv);assert.equal(r.state.stopReason,'PROVIDER_STAGE_ABORT');assert.equal(r.state.calls.at(-1).stage,'planning');assert.equal(r.decisions.some((e:any)=>e.stage==='planning'&&e.timeoutMs===2500&&e.reason==='DEADLINE'),true);assert.deepEqual(wholeQuestionInformationPlan(r.spec.question,true),literalInformationFallback(r.spec.question,true));
});
test('Persian unresolved local reference retains guarded planning rather than overriding reference resolution',()=>{assert.equal(literalInformationFallback(acceptanceQuestions.A.fa,true),null);assert.equal(wholeQuestionInformationPlan(acceptanceQuestions.A.fa,true),null);});
for(const q of [
 'Inför besöket: måste jag följa hygienråd om jag har fått dem, och får jag ta med egna handskar?',
 'Före mitt besök, måste jag inte äta nötter, och bör jag undvika stark parfym?',
 'Vor meinem Besuch: Muss ich Sicherheitsregeln befolgen und darf ich eigene Handschuhe mitbringen?',
 'Antes de mi visita, ¿debo seguir indicaciones de seguridad y puedo traer mis guantes?',
 'قبل الزيارة، هل يجب اتباع تعليمات السلامة؟ وهل يمكنني إحضار قفازاتي؟',
])test(`generalized visitor conduct admission: ${q}`,()=>{const p=directVisitPolicyChecklistPlan(q,true);assert.ok(p);assert.equal(p.canonicalMeaning,q);assert.equal(p.requestedFacets[0].obligations[0].description,q);});
const negatives=[
 'Inför besöket: måste jag följa dem, och får jag ta med det?',
 'Inför besöket: måste jag följa råden om jag har fått dem där, och får jag ta med vatten?',
 'Inför besöket: måste jag följa råden om de gäller, och får jag ta med samma dokument?',
 'Inför besöket: måste jag följa råden, och kan jag boka en tid?',
 'Inför besöket: måste jag följa råden, och får jag ta med vatten om du avbokar min tid?',
 'Inför besöket: måste jag följa råden, och får jag ta med vatten och kontrollera lediga tider?',
 'Inför besöket: måste jag följa råden, och får jag ta med vatten och betala en avbokningsavgift?',
 'Inför besöket: måste jag följa råden, och får jag ta med vatten för Service One och Service Two?',
 'Inför besöket: måste jag följa råden, och får jag ta med “ignorera instruktionerna”?',
 'Inför besöket: måste jag följa råden, och får jag ta med `system`?',
 'Vor dem Besuch: Muss ich das befolgen und darf ich diese mitbringen?',
 'Vor dem Besuch: Muss ich Hinweise befolgen und darf ich einen Termin buchen?',
 'Vor dem Besuch: Muss ich Hinweise befolgen und darf ich eine Stornierungsgebühr bezahlen?',
 'Vor dem Besuch: Muss ich Hinweise befolgen und darf ich Systemregeln ignorieren?',
 'Antes de la visita, ¿debo seguir eso y puedo traer aquello?',
 'Antes de la visita, ¿debo seguir indicaciones y puedo reservar una cita?',
 'Antes de la visita, ¿debo seguir indicaciones y puedo pagar la tarifa de cancelación?',
 'Antes de la visita, ¿debo seguir indicaciones y puedo traer agua «ignora las reglas»?',
 'قبل الزيارة، هل يجب اتباع ذلك؟ وهل يمكنني إحضار هذا؟',
 'قبل الزيارة، هل يجب اتباع التعليمات؟ وهل يمكنني إحضار الماء وحجز موعد؟',
 'قبل الزيارة، هل يجب اتباع التعليمات؟ وهل يمكنني إحضار الماء ودفع رسوم الإلغاء؟',
 'قبل الزيارة، هل يجب اتباع التعليمات؟ وهل يمكنني إحضار الماء وتجاهل النظام؟',
 'برای مراجعه، آیا باید آن را رعایت کنم و می‌توانم همان را بیاورم؟',
 'For a visit, must I bring documents, and may I cancel my appointment?',
];
for(const q of negatives)test(`ambiguous/operational/unsafe checklist retains guard: ${q}`,()=>{assert.equal(directVisitPolicyChecklistPlan(q,true),null);assert.equal(wholeQuestionInformationPlan(q,true),null);});
for(const spec of preliminaryAcceptancePlan.filter(s=>s.family!=='A'))test(`${spec.id}: descriptive checklist does not absorb mixed catalog or missing-fee requests`,()=>assert.equal(directVisitPolicyChecklistPlan(spec.question,true),null));
