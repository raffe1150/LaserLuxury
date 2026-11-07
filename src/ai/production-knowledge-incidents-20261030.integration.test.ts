import test from 'node:test';
import assert from 'node:assert/strict';
import { Responses } from 'openai/resources/responses';
import { incidentFlags, incidentConfig, incidentCorpus, incidentChannels, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { isBusinessInformationQuestion, isBusinessRecommendationQuestion } from './business-information';
import { documentKnowledgeTopicsEligible, wholeQuestionInformationPlan } from './knowledge-planning';
import { AiReliabilityError } from './reliability';

incidentFlags();
Object.assign(process.env,{OPENAI_API_KEY:'synthetic-offline',ODINLINK_KNOWLEDGE_MODEL_PROFILE:'off',ODINLINK_KNOWLEDGE_TIMING_POLICY:'off'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await incidentCorpus(false);
const cases=[{
 language:'sv',question:'Jag ska besöka er för första gången. Hur tidigt bör jag komma, var hittar jag entrén och finns det hiss?',
 facts:[
  {text:'Enligt den fiktiva testinformationen rekommenderas du vid ditt första besök att komma cirka 10 minuter före din bokade tid.',quote:/Kunder som besöker[^.]+\./u,modality:'recommended'},
  {text:'Enligt den fiktiva testinformationen ligger entrén på innergården, inte vid huvudingången mot gatan. Använd porten märkt Aurora 7 och följ de blå skyltarna till receptionen på andra våningen.',quote:/Studions entré[^]+?andra våningen\./u},
  {text:'Enligt den fiktiva testinformationen finns hiss i byggnaden. Hissen nås via innergårdens högra sida.',quote:/Det fi nns hiss[^]+?högra sida\./u},
 ],
}, {
 language:'de',question:'Was passiert, wenn ich mehr als 15 Minuten zu spät komme? Wird mein Termin automatisch storniert?',
 facts:[
  {text:'Laut der fiktiven Testinformation sollten Sie bei drohender Verspätung das Studio so bald wie möglich über Ihren üblichen Kontaktkanal informieren.',quote:/Om du riskerar[^]+?med företaget\./u,modality:'recommended'},
  {text:'Laut der fiktiven Testinformation kann das Personal bei mehr als 15 Minuten Verspätung erneut beurteilen müssen, ob der Besuch wie geplant stattfinden kann. Der Besuch wird nicht automatisch abgesagt; das Personal muss zuerst die Situation beurteilen.',quote:/Vid en försening[^]+?bedöma situationen\./u,negation:true},
 ],
}];

for(const spec of cases)for(const channel of incidentChannels)for(const failure of ['none','slow','timeout','request_timeout','unknown','foreign','incomplete','conflict'] as const)
test(`October 30 ${spec.language}/${channel}: ${failure}`,async t=>{
 b.reset();const saved={...incidentConfig};const replies:string[]=[],stages:string[]=[],decisions:any[]=[],unitDecisions:any[]=[];let actions=0;
 let now=Date.now();if(failure==='slow'||failure==='request_timeout')t.mock.method(Date,'now',()=>now);
 const forbidden=async()=>{actions++;throw Error('Booking/calendar work forbidden');};
 for(const name of ['log','info','warn','error']as const)t.mock.method(console,name,()=>{});
 t.mock.method(globalThis,'fetch',async(input,options)=>{
  replies.push(interceptedIncidentSend(input,options));
  return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}),{status:200});
 });
 t.mock.method(Responses.prototype,'create',async(p:any)=>{
  assert.equal(p.model,'gpt-5.6-luna');
  const d=JSON.parse(p.input[0].content),instruction=p.instructions;
  const result=(value:unknown)=>({output_text:JSON.stringify(value),output:[]}) as any;
  assert.equal(d.question,spec.question,'Full original request reaches each factual stage');
  assert.equal(d.facets[0].obligations[0].description,spec.question);
  if(instruction.includes('UNIT EXTRACTION')){
   stages.push('extraction');
   assert.ok(d.evidence.length && d.evidence.every((e:any)=>e.businessId===77));
   if(spec.language==='sv')assert.ok(d.evidence.some((e:any)=>e.text.includes('fem minuter')),'Competing TXT guidance remains visible');
   if(failure==='slow')now+=8_000;
   if(failure==='request_timeout')now+=20_001;
   if(failure==='timeout'||failure==='request_timeout')throw new AiReliabilityError('TIMEOUT','Synthetic extraction timeout');
   const units=spec.facts.map((fact:any)=>{
    const evidence=d.evidence.find((e:any)=>fact.quote.test(e.text));assert.ok(evidence,`Missing source for ${fact.text}`);
    return {facetIds:['f1'],subject:'documented visitor policy',predicate:'states',value:fact.text,
     text:fact.text,language:spec.language,modality:fact.modality||'descriptive',negation:!!fact.negation,
     scope:spec.language==='sv'?'fictional test information; first visit':'fictional test information; delayed arrival',qualifiers:[],
     evidenceRefs:[{evidenceId:failure==='foreign'?'foreign-tenant-evidence':evidence.id,exactQuote:evidence.text.match(fact.quote)[0]}]};
   });return result({oversized:false,units});
  }
  if(instruction.includes('BATCH ENTAILMENT')){
   stages.push('verification');
    if(failure==='slow')now+=1_000;
    return result({decisions:d.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:failure==='unknown'?'UNKNOWN':failure==='conflict'?'CONTRADICTED':'ENTAILED',
    meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
    coverage:d.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:failure!=='incomplete',
     materialUnitIds:d.units.map((u:any)=>u.id),incompletenessReason:failure==='incomplete'?'MISSING_RELEVANT_FACT':'NONE',
     obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:failure==='incomplete'?'UNRESOLVED':'COVERED',unitIds:d.units.map((u:any)=>u.id)}))}))});
  }
  if(instruction.includes('VERIFIED-UNIT PRESENTATION')){stages.push('composition');return result({unitIds:d.units.map((u:any)=>u.id),prefix:'none',addition:false});}
  assert.fail('No model planning, legacy generation or other provider stage is allowed');
 });
 try{
  incidentConfig.language=spec.language;
  b.configure({semanticLanguageResolver:async()=>({language:spec.language,confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),
   semanticKnowledgeSearchQueries:async()=>[],validateKnowledgeMatches:(id,m)=>corpus.service.validateMatches(id,m,{strictSources:true,captureRevision:true}),
   evidenceFirstDiagnostic:event=>decisions.push(event),evidenceFirstDecisionDiagnostic:event=>unitDecisions.push(event),
   calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
   recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,spec.question);
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(decisions.length,1,'Actual adapter must reach evidence-first answering');
  assert.doesNotMatch(replies[0],/Video Consultation|bokningsbara tjänster|rekommendera rätt tjänst|300 SEK/u);
  if(failure==='none'||failure==='slow'){
   assert.equal(decisions[0].units,spec.facts.length,JSON.stringify(unitDecisions));assert.ok(decisions[0].facets.every((f:any)=>f.status==='VERIFIED'));
   for(const fact of spec.facts)assert.ok(replies[0].includes(fact.text));
   if(spec.language==='sv')assert.doesNotMatch(replies[0],/fem minuter/u);
   assert.ok(stages.includes('extraction')&&stages.includes('verification'));
  }else{
   if(failure==='incomplete')assert.ok(decisions[0].facets.every((f:any)=>f.status!=='VERIFIED'));
   else assert.equal(decisions[0].units,0);
   if(failure==='incomplete')assert.match(replies[0],spec.language==='sv'?/kan bara bekräfta/u:/kann derzeit nur diese Angaben bestätigen/u);
   else assert.match(replies[0],spec.language==='sv'?/inte.*(?:verifiera|bekräfta)/iu:/nicht.*(?:überprüfen|bestätigen)/iu);
   if(failure==='conflict')assert.ok(unitDecisions.some(e=>e.relation==='CONTRADICTED'));
   if(failure==='timeout'){
    assert.deepEqual(stages,['extraction']);
    assert.ok(unitDecisions.some(e=>e.eventType==='transport'&&e.timeoutScope==='stage'&&e.remainingMs>0));
   }
   if(failure==='request_timeout')assert.ok(unitDecisions.some(e=>e.eventType==='transport'&&e.timeoutScope==='request'&&e.remainingMs===0));
  }
 }finally{Object.assign(incidentConfig,saved);b.reset();}
});

test('exact incident contracts preserve all wording without recommendation or model planning',()=>{
 for(const spec of cases){
  assert.equal(isBusinessRecommendationQuestion(spec.question),false);
  assert.equal(documentKnowledgeTopicsEligible(spec.question),true);
  const plan=wholeQuestionInformationPlan(spec.question,isBusinessInformationQuestion(spec.question),false,incidentConfig.services);
  assert.ok(plan);assert.equal(plan.requestedFacets[0].obligations[0].description,spec.question);
  assert.equal(wholeQuestionInformationPlan(spec.question,true,true),null);
 }
});

const novemberQuestions = [
 {channel:'telegram',language:'fa',question:'من می‌خوام اولین بار بیام استودیو. باید زودتر برسم؟ تأییدیه رزرو رو همراهم داشته باشم؟ آدرس دقیق رو از کجا می‌تونم بگیرم؟',facts:[
  ['طبق اطلاعات آزمایشی، برای اولین مراجعه توصیه می‌شود حدود 10 دقیقه پیش از زمان رزرو برسید.',/Kunder som besöker[^]+?lugn och ro\./u,'recommended'],
  ['طبق اطلاعات آزمایشی، تأییدیه رزرو را دیجیتال یا کاغذی همراه داشته باشید و دستورهای آماده‌سازی ویژه‌ای را که دریافت کرده‌اید رعایت کنید.',/Ta gärna med[^]+?följa dessa\./u,'recommended'],
  ['آدرس بازدید همراه با تأییدیه رزرو اعلام می‌شود.',/Besöksadressen meddelas[^.]+\./u,'descriptive']]},
 {channel:'whatsapp',language:'en',question:"Hi! I'm visiting your studio for the first time. Should I use the main entrance facing the street, and how do I get to reception? Is there an elevator?",facts:[
  ['According to the fictional test information, use the courtyard entrance, not the street-facing main entrance; use the gate marked Aurora 7 and follow the blue signs to reception on the second floor.',/Studions entré[^]+?andra våningen\./u,'descriptive'],
  ['According to the fictional test information, there is an elevator reached via the right side of the courtyard.',/Det fi nns hiss[^]+?högra sida\./u,'descriptive']]},
 {channel:'messenger',language:'de',question:'Darf ich jemanden zu meinem Termin mitbringen? Kann die Person auch mit in den Behandlungsraum kommen?',facts:[
  ['Laut den fiktiven Testinformationen darf eine erwachsene Begleitperson in den Wartebereich der Rezeption mitkommen.',/En kund får[^]+?väntrum\./u,'permitted'],
  ['Laut den fiktiven Testinformationen ist der Zugang zum Behandlungs- oder Arbeitsraum nicht automatisch erlaubt; das Personal muss ihn separat genehmigen.',/Medföljande personer[^]+?personalen\./u,'descriptive']]},
 {channel:'instagram',language:'es',question:'Hola, creo que llegaré unos 20 minutos tarde a mi cita. ¿La cancelan automáticamente o todavía puedo acudir?',facts:[
  ['Según la información ficticia de prueba, si prevés llegar tarde, deberías contactar al estudio cuanto antes por tu canal habitual.',/Om du riskerar[^]+?med företaget\./u,'recommended'],
  ['Según la información ficticia de prueba, con más de 15 minutos de retraso el estudio puede necesitar evaluar de nuevo si la visita puede realizarse según lo previsto.',/Vid en försening[^]+?enligt plan\./u,'descriptive'],
  ['Según la información ficticia de prueba, la visita no se cancela automáticamente; el personal debe evaluar primero la situación.',/Detta innebär[^]+?bedöma situationen\./u,'descriptive']]},
] as const;

// Scripted native-handler regressions, not historical model judgments or live success.
for(const entry of novemberQuestions)for(const channel of entry.language==='es'?incidentChannels:[entry.channel])
for(const fault of entry.language==='es'?['none','quoted-threshold','quoted-threshold-16','quoted-threshold-inclusive','quoted-threshold-invalid-citation','quoted-threshold-rejected','quoted-threshold-incomplete','private-flag-only','conditional-completion','conditional-completion-rejected','conditional-completion-incomplete','corrected-antecedent','missing-antecedent','numeric-negation','rejected','threshold-16','inclusive-15','automatic-cancellation','invalid-quote','wrong-valid-span','missing-condition','missing-qualification','omitted-fact','incomplete-source-review','wrong-language-label','wrong-language-text']:['none','rejected'])
test(`November 6 original ${channel}/${entry.language}: ${fault}`,async t=>{
 const spec={...entry,channel},positive=['none','quoted-threshold','private-flag-only','conditional-completion','corrected-antecedent'].includes(fault);
 const parseLoss=['quoted-threshold-16','quoted-threshold-inclusive','quoted-threshold-invalid-citation','threshold-16','inclusive-15','invalid-quote','wrong-language-label','wrong-valid-span','missing-condition','missing-antecedent','numeric-negation'].includes(fault);
 const semanticFailure=['quoted-threshold-rejected','conditional-completion-rejected','rejected','automatic-cancellation','missing-qualification','wrong-language-text'].includes(fault);
 const incomplete=!positive&&!parseLoss&&fault!=='incomplete-source-review';
 let completeCorpusReads=0;
 b.reset();const saved={...incidentConfig},savedEnv={...process.env};
 const replies:string[]=[],stages:string[]=[],events:any[]=[];let actions=0;let scriptError:unknown;
 const forbidden=async()=>{actions++;throw Error('OFFLINE_ACTION_FORBIDDEN');};
 for(const name of ['log','info','warn','error'] as const)t.mock.method(console,name,()=>{});
 Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',
  ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2'});
 delete process.env.ODINLINK_PRIVATE_NUMERICAL_DIAGNOSTICS;
 if(fault==='private-flag-only')process.env.ODINLINK_PRIVATE_NUMERICAL_DIAGNOSTICS='fixture-v1';
 const local=await incidentCorpus(false);
 const {readFileSync}=await import('node:fs');
 const audited=JSON.parse(readFileSync('tests/fixtures/cancellation-business3-audited-20261101.json','utf8'));
 const txt=audited.sources.find((s:any)=>s.title==='odinlink-test.txt');assert.ok(txt);
 // Remove the older harness's deliberately competing five-minute TXT advice.
 const prior=(await local.storage.list(77)).find(s=>s.id==='incident-txt')!;
 await local.storage.create({...prior,content:txt.content,metadata:{segments:[{start:0,end:txt.content.length,section:'Text'}]}});
 await local.storage.replaceChunks(77,prior.id,[{chunkIndex:0,content:txt.content,metadata:{source:'document',section:'Text'}}]);
 t.mock.method(globalThis,'fetch',async(input,options)=>{
  replies.push(interceptedIncidentSend(input,options));
  return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}));
 });
 try{
  incidentConfig.language=spec.language;
  b.configure({offlineAi:true,semanticLanguageResolver:async()=>({language:spec.language,confidence:1}),
   postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   knowledgeSearch:(id,q,limit)=>local.service.search(id,q,limit),
   completeKnowledgeCorpus:async(id,m,options,mode)=>{const complete=await local.service.completeSmallCorpus(id,m,options,mode);completeCorpusReads++;assert.equal(complete?.length,6);return complete;},
   knowledgeSourceLanguages:id=>local.service.sourceLanguageHints(id),semanticKnowledgeSearchQueries:async()=>[],
   validateKnowledgeMatches:(id,m)=>local.service.validateMatches(id,m,{strictSources:true,captureRevision:true}),
   evidenceFirstDecisionDiagnostic:e=>events.push(e),
   aiGenerate:async r=>{try {
    assert.deepEqual(r.tools,[]);
    const d=JSON.parse(r.messages[0].content),instruction=r.systemInstruction;
    assert.equal(d.question.replace(/؟/gu,'?').replace(/‌/gu,' '),spec.question.replace(/؟/gu,'?').replace(/‌/gu,' '));
    if(instruction.includes('retrieval query planner'))return{functionCalls:[],text:JSON.stringify({canonicalMeaning:d.question,queries:[d.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'visitor policy',attribute:d.question,questionType:'description',obligations:[{description:d.question,questionType:'description'}]}]})};
    if(instruction.includes('UNIT EXTRACTION')){
     assert.match(instruction,/Citation completeness:/u);assert.match(instruction,/cite both spans/u);assert.match(instruction,/Customer quantities describe the requested scenario/u);
     stages.push('extraction');assert.ok(d.evidence.length>0 && d.evidence.length<=6);assert.equal(new Set(d.evidence.map((e:any)=>e.sourceGroup||e.sourceId)).size,2);
     assert.ok(d.evidence.every((e:any)=>e.businessId===77));
     const units=spec.facts.map(([text,quote,modality])=>{
      const e=d.evidence.find((e:any)=>quote.test(e.text));assert.ok(e,String(quote));
      return{facetIds:['f1'],subject:'documented visitor policy',predicate:'states',value:text,text,modality,
       negation:false,scope:'documented visit process; PDF facts are fictional test information',qualifiers:[],language:spec.language,
       evidenceRefs:[{evidenceId:e.id,...(instruction.includes('literal-evidence-v1')?{}:{exactQuote:e.text.match(quote)[0]})}]};
     });
     if(fault.startsWith('conditional-completion')){
      const captured=JSON.parse(readFileSync('tests/fixtures/conditional-citation-genuine-036c3df.json','utf8'));
      const e=d.evidence.find((e:any)=>e.text.includes(captured.originalQuotes[0]));assert.ok(e);
      // Exact retained policy sentence only. Structured fields are scripted;
      // unavailable redacted metadata from the original unit is not recreated.
      units[2]={...units[2],text:captured.text,value:captured.text,negation:true,
       evidenceRefs:[{evidenceId:e.id,exactQuote:captured.originalQuotes[0]}]};
     }
     if(['corrected-antecedent','missing-antecedent','numeric-negation'].includes(fault)){
      const replay=JSON.parse(readFileSync('tests/fixtures/late-arrival-genuine-96e03c3.json','utf8'));
      const consequence=/Detta innebär[^]+?bedöma situationen\./u;
      const policy=/Vid en försening[^]+?enligt plan\./u;
      const e=d.evidence.find((e:any)=>policy.test(e.text)&&consequence.test(e.text));assert.ok(e);
      // Counterfactual complete binding of the actual permitted u1 sentence;
      // not a reconstruction or repair of a genuine provider response.
      units[2]={...units[2],text:replay.u1.text+' El personal debe evaluar primero la situación.',value:replay.u1.text+' El personal debe evaluar primero la situación.',negation:true,
       evidenceRefs:[{evidenceId:e.id,exactQuote:e.text.match(consequence)[0]},
        ...(fault==='missing-antecedent'?[]:[{evidenceId:e.id,exactQuote:e.text.match(policy)[0]}])]};
      if(fault==='numeric-negation')units[2].text=units[2].text.replace('más de','no más de');
     }
     if(fault.startsWith('quoted-threshold')){
      const formatted=(s:string)=>s.replace('15','“15”');
      units[1]={...units[1],text:formatted(units[1].text),value:formatted(units[1].value)};
      if(fault==='quoted-threshold-16')units[1]={...units[1],text:units[1].text.replace('15','16'),value:units[1].value.replace('15','16')};
      if(fault==='quoted-threshold-inclusive')units[1]={...units[1],text:units[1].text.replace('más de','al menos'),value:units[1].value.replace('más de','al menos')};
      if(fault==='quoted-threshold-invalid-citation')units[1].evidenceRefs=units[1].evidenceRefs.map((r:any)=>({...r,exactQuote:formatted(r.exactQuote)}));
     }
     if(fault==='threshold-16')units[1]={...units[1],text:units[1].text.replace('15','16'),value:units[1].value.replace('15','16')};
     if(fault==='inclusive-15')units[1]={...units[1],text:units[1].text.replace('más de','al menos')};
     if(fault==='automatic-cancellation')units[2]={...units[2],text:'Según la información ficticia de prueba, la visita se cancela automáticamente.'};
     if(fault==='invalid-quote')units[1].evidenceRefs=[{evidenceId:units[1].evidenceRefs[0].evidenceId,exactQuote:'A quotation absent from the reviewed source.'}];
     if(fault==='wrong-valid-span')units[1].evidenceRefs=units[0].evidenceRefs;
     if(fault==='missing-condition')units[1]={...units[1],text:'Según la información ficticia de prueba, el estudio siempre debe evaluar de nuevo si la visita puede realizarse según lo previsto.'};
     if(fault==='missing-qualification')units[2]={...units[2],text:units[2].text.replace('Según la información ficticia de prueba, ','')};
     if(fault==='omitted-fact')units.splice(2,1);
     if(fault==='wrong-language-label')units[1]={...units[1],language:'en'};
     if(fault==='wrong-language-text')units[1]={...units[1],text:'According to the fictional test information, with more than 15 minutes of delay staff may need to assess the visit.'};
     return{functionCalls:[],text:JSON.stringify({oversized:false,units})};
    }
    assert.match(instruction,/BATCH ENTAILMENT/);stages.push('verification');
    if(fault.startsWith('conditional-completion')){
     const captured=JSON.parse(readFileSync('tests/fixtures/conditional-citation-genuine-036c3df.json','utf8'));
     assert.equal(d.units[2].text,captured.text);
     assert.equal(d.units[2].evidenceRefs.length,2);
     assert.ok(d.units[2].evidenceRefs.some((ref:any)=>ref.exactQuote.replace(/\s+/gu,' ')===captured.antecedent));
    }
    assert.equal(d.units.length,spec.facts.length-(parseLoss||fault==='omitted-fact'?1:0));assert.equal(new Set(d.evidence.map((e:any)=>e.sourceGroup||e.sourceId)).size,2);
    for(const u of d.units)for(const ref of u.evidenceRefs){
     const e=d.evidence.find((e:any)=>e.id===ref.evidenceId);assert.ok(e?.text.includes(ref.exactQuote));
    }
    return{functionCalls:[],text:JSON.stringify({
     decisions:d.units.map((u:any,i:number)=>({unitId:u.id,facetIds:u.facetIds,relation:semanticFailure?(i===0?'CONTRADICTED':'UNKNOWN'):'ENTAILED',
      meaningPreserved:!semanticFailure,modalityPreserved:fault!=='missing-condition',qualifiersPreserved:!semanticFailure,relevant:true,languageCorrect:fault!=='wrong-language-text',
      negativeAbsence:false,explicitAbsenceEvidence:false})),
     coverage:d.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:!incomplete,
      incompletenessReason:incomplete?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:incomplete?[]:d.units.map((u:any)=>u.id),
      obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:incomplete?'UNRESOLVED':'COVERED',unitIds:incomplete?[]:d.units.map((u:any)=>u.id)}))})),
     sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:!incomplete,
      conditionsPreserved:!incomplete,conflictsAbsent:!semanticFailure,evidenceIdsReviewed:d.evidence.slice(fault==='incomplete-source-review'?1:0).map((e:any)=>e.id),
      acceptedUnitIdsReviewed:d.units.map((u:any)=>u.id),
      obligations:d.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:incomplete?'UNLOCATED':'COMPLETE'})))}
    })};
   } catch(error) {scriptError=error;throw error;}},
   calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,
    cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  assert.equal(b.inspectNativeKnowledgeAdmissionForTest(spec.channel,spec.question,incidentConfig),true);
  await incidentInbound(b,spec.channel,spec.question);
  assert.equal(scriptError,undefined);assert.equal(actions,0);assert.equal(replies.length,1);assert.deepEqual(stages,['extraction','verification']);
  assert.ok(completeCorpusReads>0,'canonical completion was exercised');
  if(!positive){
   assert.notEqual(events.filter(e=>e.stage==='publication').at(-1)?.route,'verified_manifest');
   for(const [text]of spec.facts)assert.ok(!replies[0].includes(text));
   if(semanticFailure)assert.ok(events.some(e=>e.relation==='CONTRADICTED'),JSON.stringify(events));
   if(['quoted-threshold-16','quoted-threshold-inclusive','threshold-16','inclusive-15','wrong-valid-span','missing-condition','missing-antecedent','numeric-negation'].includes(fault))assert.ok(events.some(e=>e.reason==='NUMERICAL_CONSTRAINT'));
   if(fault==='invalid-quote'||fault==='quoted-threshold-invalid-citation')assert.ok(events.some(e=>e.reason==='INVALID_CITATION'));
   if(fault==='wrong-language-label')assert.ok(events.some(e=>e.reason==='LANGUAGE_LABEL'));
  }
  else {for(const [index,[text]]of spec.facts.entries()){const expected=fault==='quoted-threshold'&&index===1?text.replace('15','“15”'):fault==='conditional-completion'&&index===2?JSON.parse(readFileSync('tests/fixtures/conditional-citation-genuine-036c3df.json','utf8')).text:fault==='corrected-antecedent'&&index===2?JSON.parse(readFileSync('tests/fixtures/late-arrival-genuine-96e03c3.json','utf8')).u1.text+' El personal debe evaluar primero la situación.':text;assert.ok(replies[0].includes(expected),JSON.stringify({reply:replies[0],events:events.map(e=>({stage:e.stage,reason:e.reason,unitId:e.unitId,route:e.route}))}));}
   assert.equal(events.filter(e=>e.stage==='publication').at(-1)?.route,'verified_manifest');
   if(spec.language==='fa')assert.doesNotMatch(replies[0],/Studio Street|Stjärngatan/u);}
  t.diagnostic(JSON.stringify({channel:spec.channel,language:spec.language,fault,completeCorpusReads,stages,replies:replies.length,actions,route:events.filter(e=>e.stage==='publication').at(-1)?.route,answer:positive?replies[0]:undefined}));
 }finally{Object.assign(incidentConfig,saved);for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);b.reset();}
});
