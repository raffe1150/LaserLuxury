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
