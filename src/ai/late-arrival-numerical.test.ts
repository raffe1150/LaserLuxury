import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {numericalConstraintSafe as safe} from './numerical-constraints';
const audited=JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json',import.meta.url),'utf8'));
const pdf=audited.sources.find((s:any)=>s.title.endsWith('.pdf')).content;
const threshold=pdf.match(/Vid en försening[^]+?enligt plan\./u)![0];
const cancellation=pdf.match(/Detta innebär[^]+?bedöma situationen\./u)![0];
const variants=[
 ['sv','Vid mer än 15 minuter försening kan personalen behöva bedöma besöket.'],
 ['en','With more than 15 minutes of delay staff may need to assess the visit.'],
 ['de','Bei mehr als 15 Minuten Verspätung kann das Personal den Besuch neu beurteilen.'],
 ['es','Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.'],
 ['fa','با بیش از ۱۵ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.'],
 ['ar','عند التأخر أكثر من ١٥ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.'],
] as const;
for(const [language,text]of variants){
 test(`${language}: exact strict 15-minute threshold is retained`,()=>assert.equal(safe(text,text,[threshold]),true));
 const wrong=text.replace('15','16').replace('۱۵','۱۶').replace('١٥','١٦');
 test(`${language}: invented strict 16-minute threshold is vetoed`,()=>assert.equal(safe(wrong,wrong,[threshold]),false));
}
test('a customer delay of 20 minutes is not source authority for a 20-minute threshold',()=>{
 const claim='Con más de 20 minutos de retraso el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(claim,claim,[threshold]),false);
});
test('inclusive 15 minutes cannot replace strictly more than 15 minutes',()=>{
 const claim='Con al menos 15 minutos de retraso el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(claim,claim,[threshold]),false);
});
test('a plain no-automatic-cancellation claim remains subject to independent semantic verification',()=>{
 const claim='La cita no se cancela automáticamente; el personal debe evaluar primero la situación.';
 assert.equal(safe(claim,claim,[cancellation]),true);
 // This numeric gate alone cannot decide cancellation meaning or staff modality.
 const unsupported='La cita se cancela automáticamente.';
 assert.equal(safe(unsupported,unsupported,[cancellation]),true);
});
test('the numerical gate has no customer-premise input and cannot license contextual numbers',()=>{
 const claim='Si llegas 20 minutos tarde, la cita no se cancela automáticamente.';
 assert.equal(safe(claim,claim,[threshold,cancellation]),false);
});
test('strict upper bounds preserve value and strictness without confusing negated inclusive wording',()=>{
 for(const claim of ['Less than 15 minutes.','Menos de 15 minutos.','Weniger als 15 Minuten.','Mindre än 15 minuter.','کمتر از ۱۵ دقیقه.','أقل من ١٥ دقيقة.'])
  assert.equal(safe(claim,claim,['Less than 15 minutes.']),true);
 assert.equal(safe('At most 15 minutes.','At most 15 minutes.',['Less than 15 minutes.']),false);
 assert.equal(safe('Not more than 15 minutes.','Not more than 15 minutes.',['At most 15 minutes.']),true);
});

const replay=JSON.parse(readFileSync(new URL('../../tests/fixtures/late-arrival-genuine-96e03c3.json',import.meta.url),'utf8'));
const negatedActions={
 es:replay.u1.text as string,
 en:'With more than 15 minutes of delay, the appointment is not automatically cancelled.',
 sv:'Vid mer än 15 minuter försening avbokas besöket inte automatiskt.',
 de:'Bei mehr als 15 Minuten Verspätung wird der Termin nicht automatisch storniert.',
 fa:'با بیش از ۱۵ دقیقه تأخیر، نوبت به طور خودکار لغو نمی‌شود.',
 ar:'مع التأخر أكثر من ١٥ دقيقة لا يلغى الموعد تلقائيا.',
};
for(const [language,text]of Object.entries(negatedActions)){
 test(`${language}: indicative action negation preserves a supported strict numeric condition`,()=>
  assert.equal(safe(text,text,[threshold,cancellation]),true));
 test(`${language}: action negation never licenses an invented threshold`,()=>{
  const wrong=text.replace('15','16').replace('۱۵','۱۶').replace('١٥','١٦');assert.equal(safe(wrong,wrong,[threshold,cancellation]),false);
 });
}
test('actual genuine u1 still requires its missing antecedent; no automatic citation expansion',()=>{
 assert.equal(safe(replay.u1.text,replay.u1.text,replay.u1.originalQuotes),false);
 assert.equal(safe(replay.u1.text,replay.u1.text,[replay.u1.addedAntecedentQuote,...replay.u1.originalQuotes]),true);
 for(const q of [...replay.u1.originalQuotes,replay.u1.addedAntecedentQuote])assert.ok(pdf.replace(/\s+/gu,' ').includes(q.replace(/\s+/gu,' ')));
});
test('an indicative action-negation form cannot be matched inside another word',()=>{
 const text='با بیش از ۱۵ دقیقه تأخیر، نوبت ناخودکار لغو نمی‌شود.';
 assert.equal(safe(text,text,[threshold,cancellation]),false);
});
for(const text of [
 'No se cancela automáticamente con no más de 15 minutos de retraso.',
 'The appointment is not automatically cancelled with not more than 15 minutes of delay.',
 'Besöket avbokas inte automatiskt vid inte mer än 15 minuter försening.',
 'Der Termin wird nicht automatisch storniert bei nicht mehr als 15 Minuten Verspätung.',
 'نوبت با حداکثر ۱۵ دقیقه تأخیر به طور خودکار لغو نمی‌شود.',
 'لا يلغى الموعد تلقائيا مع التأخر على الأكثر ١٥ دقيقة.',
])test(`action negation does not hide an inclusive/reversed comparator: ${text}`,()=>assert.equal(safe(text,text,[threshold,cancellation]),false));
for(const text of [
 'Do not cancel at least 91 hours before the visit.',
 'You must not automatically cancel at least 91 hours before the visit.',
 'No debes cancelar automáticamente al menos 91 horas antes de la visita.',
 'Bokningen ska inte avbokas automatiskt minst 91 timmar före besöket.',
 'Der Termin darf nicht automatisch storniert werden mindestens 91 Stunden vor dem Besuch.',
 'نوبت نباید حداقل ۹۱ ساعت پیش از مراجعه به طور خودکار لغو شود.',
 'يجب ألا يلغى الموعد تلقائيا على الأقل ٩١ ساعة قبل الزيارة.',
])test(`negated action cannot become a documented advance-notice rule: ${text}`,()=>
 assert.equal(safe(text,text,['Cancel at least 91 hours before the visit.']),false));
test('the genuine u2 observation remains customer premise versus policy, not a fabricated 20-minute threshold',()=>{
 assert.equal(replay.u2.textAvailable,'partially redacted; not reconstructed');
 assert.equal(replay.u2.observedReason,'UNBOUNDED_CLAIM_NOT_SUPPORTED');
 assert.equal(replay.u2.observedClaimConstraints[0].seconds,1200);
 assert.equal(replay.u2.observedSourceConstraints[0].seconds,900);
 assert.equal(replay.u2.observedSourceConstraints[0].bound,'strict_minimum');
 // Controlled offline sentences are not reconstructed genuine u2 claims.
 const scenario='Con un retraso de 20 minutos el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(scenario,scenario,[threshold,cancellation]),false);
 const rule='Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(rule,rule,[threshold,cancellation]),true);
});

const contactQuote=pdf.match(/Om du riskerar[^]+?med företaget\./u)![0];
const scenarioTexts={
 en:'With a delay of 20 minutes staff may need to assess the visit.',
 sv:'Vid 20 minuter försening kan personalen behöva bedöma besöket.',
 de:'Bei 20 Minuten Verspätung kann das Personal den Besuch neu beurteilen.',
 es:'Con un retraso de 20 minutos el personal puede necesitar evaluar la visita.',
 fa:'با ۲۰ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
 ar:'مع تأخر ٢٠ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.',
};
const contactTexts={
 en:'If you may arrive late, contact the studio as soon as possible through your usual channel.',
 sv:'Om du riskerar att komma för sent bör du kontakta studion så snart som möjligt via din vanliga kontaktkanal.',
 de:'Wenn du zu spät kommst, solltest du das Studio so bald wie möglich über deinen üblichen Kontaktkanal kontaktieren.',
 es:'Si prevés llegar tarde, deberías contactar al estudio cuanto antes por tu canal habitual.',
 fa:'اگر احتمال دارد دیر برسید، بهتر است هرچه زودتر از راه ارتباطی معمول با استودیو تماس بگیرید.',
 ar:'إذا توقعت التأخر، يوصى بالتواصل مع الاستوديو في أقرب وقت عبر قناة التواصل المعتادة.',
};
for(const language of Object.keys(negatedActions)as (keyof typeof negatedActions)[]){
 test(`${language}: no source-only license for a customer 20-minute scenario`,()=>{
  const text=scenarioTexts[language];assert.equal(safe(text,text,[threshold,cancellation]),false);
 });
 test(`${language}: missing antecedent remains a rejection`,()=>{
  const text=negatedActions[language];assert.equal(safe(text,text,[cancellation]),false);
 });
 test(`${language}: prompt-contact advice is not converted into a numerical requirement`,()=>{
  const text=contactTexts[language];assert.equal(safe(text,text,[contactQuote]),true);
 });
}

// Scripted full-source semantic judgments test backend enforcement, not genuine
// model judgment. Real adapter parity is covered by the native incident tests.
const questions={en:'If I am 20 minutes late, is my appointment automatically cancelled or can I still attend?',
 sv:'Jag blir 20 minuter sen till min bokade tid. Avbokas besöket automatiskt eller kan jag fortfarande komma?',
 de:'Ich komme 20 Minuten zu spät. Wird mein Termin automatisch abgesagt oder kann ich noch kommen?',
 es:'Hola, creo que llegaré unos 20 minutos tarde a mi cita. ¿La cancelan automáticamente o todavía puedo acudir?',
 fa:'اگر ۲۰ دقیقه دیر برسم، نوبتم خودکار لغو می‌شود یا هنوز می‌توانم بیایم؟',
 ar:'إذا تأخرت ٢٠ دقيقة، هل يلغى موعدي تلقائيا أم يمكنني الحضور؟'};
const automatic={en:'With more than 15 minutes of delay, the appointment is automatically cancelled.',
 sv:'Vid mer än 15 minuter försening avbokas besöket automatiskt.',
 de:'Bei mehr als 15 Minuten Verspätung wird der Termin automatisch storniert.',
 es:'Con más de 15 minutos de retraso, la cita se cancela automáticamente.',
 fa:'با بیش از ۱۵ دقیقه تأخیر، نوبت خودکار لغو می‌شود.',
 ar:'مع التأخر أكثر من ١٥ دقيقة يلغى الموعد تلقائيا.'};
const attribution={en:'According to the fictional test document, ',sv:'Enligt den fiktiva testinformationen: ',
 de:'Laut den fiktiven Testinformationen: ',es:'Según la información ficticia de prueba, ',fa:'طبق اطلاعات آزمایشی، ',ar:'وفق المعلومات الاختبارية الخيالية، '};
for(const language of Object.keys(questions)as (keyof typeof questions)[])for(const fault of ['none','automatic-cancellation','incomplete-coverage']as const)
 test(`${language}: source-exhaustive publication / ${fault}`,async t=>{
  const {buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets}=await import('./business-information-answer-plan');
  const {runAccuracyFirstNative,nativeKnowledgeTiming}=await import('./knowledge-timing-policy');
  const saved=process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE='off';
  t.after(()=>{if(saved===undefined)delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE=saved;});
  const doc=audited.sources.find((s:any)=>s.title.endsWith('.pdf')),txt=audited.sources.find((s:any)=>s.title.endsWith('.txt'));
  const a=doc.content.indexOf('5. Om'),b=doc.content.indexOf('6. Till');assert.ok(a>0&&b>a);
  const evidence=[doc.content.slice(0,a),doc.content.slice(a,b),doc.content.slice(b),txt.content].map((text,i)=>({id:`e${i+1}`,businessId:3,
   sourceId:i===3?txt.id:doc.id,chunkId:`language-${i}`,version:'fixture-r1',text}));
  assert.ok(evidence.every(e=>e.text.length<=2400));const e=evidence[1],facets=parseRequestedFacets([{subject:'visitor policy',attribute:questions[language],questionType:'description'}]).facets;
  const texts=[contactTexts[language],variants.find(v=>v[0]===language)![1],fault==='automatic-cancellation'?automatic[language]:negatedActions[language]];
  const quotes=[contactQuote,threshold,cancellation];let manifest:any;const stages:string[]=[],events:any[]=[];
  await runAccuracyFirstNative(async()=>{manifest=await buildEvidenceFirstAnswer({businessId:3,question:questions[language],language,facets,evidence,
   foreground:true,extractionProtocol:'v2',verificationProtocol:'source-exhaustive-v2',authoritativeEvidence:'{}',businessTone:{},history:[],
   budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>evidence,diagnostic:e=>events.push({stage:e.stage,reason:e.reason,unitId:e.unitId}),
   generate:async(stage,instruction,data:any)=>{
    stages.push(stage);
    if(stage==='extraction')return{text:JSON.stringify({oversized:false,units:texts.map((text,i)=>({facetIds:['f1'],subject:'documented visitor policy',
     predicate:'states',value:text,text:attribution[language]+text,scope:'fictional documented late arrival policy',qualifiers:[],negation:i===2&&fault!=='automatic-cancellation',
     modality:i===0?'recommended':'descriptive',language,evidenceRefs:[{evidenceId:e.id,exactQuote:quotes[i]},...(i===2?[{evidenceId:e.id,exactQuote:threshold}]:[])]}))})};
    assert.equal(stage,'verification');assert.equal(data.units.length,fault==='automatic-cancellation'&&(language==='en'||language==='de')?2:3,JSON.stringify(events));
    const complete=fault==='none';
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:fault==='automatic-cancellation'&&u.id==='u3'?'CONTRADICTED':'ENTAILED',
     meaningPreserved:!(fault==='automatic-cancellation'&&u.id==='u3'),modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,
     negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:complete,
      incompletenessReason:complete?'NONE':'MISSING_RELEVANT_FACT',materialUnitIds:complete?data.units.map((u:any)=>u.id):[],
      obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:complete?'COVERED':'UNRESOLVED',unitIds:complete?data.units.map((u:any)=>u.id):[]}))})),
     sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:complete,conditionsPreserved:true,conflictsAbsent:fault!=='automatic-cancellation',
      evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:data.units.filter((u:any)=>!(fault==='automatic-cancellation'&&u.id==='u3')).map((u:any)=>u.id),
      obligations:data.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:complete?'COMPLETE':'AVAILABLE_SOURCE_FACT_OMITTED'})))}})};
   }});},async()=>assert.fail('Unexpected native timeout'));
  assert.deepEqual(stages,['extraction','verification']);assert.notEqual(manifest.fallbackReason,'PROVIDER_FAILURE',JSON.stringify(events));
  if(fault==='automatic-cancellation')assert.ok(events.some(e=>e.unitId==='u3'&&e.reason===((language==='en'||language==='de')?'OPERATION_CLAIM':'CONTRADICTED')),JSON.stringify(events));
  if(fault==='none'){assert.equal(manifest.units.length,3,JSON.stringify({fallback:manifest.fallbackReason,outcomes:manifest.outcomes,events}));assert.equal(manifest.presentationPath,'direct_verified_units');for(const text of texts)assert.ok(manifest.text.includes(text));}
  else{assert.notEqual(manifest.presentationPath,'direct_verified_units');assert.ok(!manifest.text.includes(automatic[language]));}
 });

test('negated automatic events do not hide a separate asserted booking mutation',async()=>{
 const {containsWebOperationSuccess:operation}=await import('./web-response-integrity');
 for(const text of [negatedActions.en,negatedActions.de])assert.equal(operation(text),false);
 for(const text of [
  'Your appointment is not automatically cancelled, but I have cancelled it.',
  'Your appointment is not automatically cancelled and is rescheduled.',
  'Your appointment has not been automatically cancelled, but your booking is confirmed.',
  'Dein Termin wird nicht automatisch storniert, aber die Buchung ist bestätigt.',
  'Dein Termin ist nicht automatisch storniert und ist verschoben.',
 ])assert.equal(operation(text),true,text);
});
