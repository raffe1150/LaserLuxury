import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {answerEvidence,buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets,pruneAnswerManifest} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
import {compactKnowledgeVerifierInput} from './knowledge-verifier-input';
import {knowledgeDiagnosticFailure} from './knowledge-answer-protocol';

// Exact immutable provider witness; every response here is replayed, never inferred.
const saved=readFileSync(new URL('../../docs/validation/shared-core-2026-10-22/authorized-four-case-gate/case-3-semantic-revalidation-2026-10-23T16-24-11-262Z-1ca9d8f9-150b-4709-93cf-92282bc519f5.json',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(saved).digest('hex'),'46f092944274e544d2fe888726b7b5287827e46b81fe9e7f339f92ec766faedf');
const capture=JSON.parse(saved),extraction=capture.calls.find((c:any)=>c.kind==='extraction'),verification=capture.calls.find((c:any)=>c.kind==='verification');
const wire=JSON.parse(verification.request.input[0].content),docs=answerEvidence(88,capture.retrieval.find((e:any)=>e.phase==='lexical').matches);
const catalog=configuredServiceEvidence(88,JSON.parse(wire.evidence.find((e:any)=>e.id==='configured-services').text).services)!;
const baseline=process.env.ODINLINK_PRESENTATION_BASELINE==='true',measurements:any[]=[];
after(()=>{if(process.env.ODINLINK_PRESENTATION_RESULTS)writeFileSync(process.env.ODINLINK_PRESENTATION_RESULTS,JSON.stringify({providerRequests:0,mode:'Offline replay and simulated stage durations, not new provider inference or latency',baseline,measurements},null,2),{flag:'wx'});});

test('captured Cedar: immutable direct presentation preserves all verified facts and uncertainty',async t=>{
 const epoch=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>epoch+elapsed);
 const budget=new InformationBudget(),events:any[]=[],stages:string[]=[];
 const evidence=[...docs,catalog];
 const manifest=await buildEvidenceFirstAnswer({question:wire.question,language:'en',facets:wire.facets,evidence,foreground:true,omitModelEvidenceVersions:true,authoritativeEvidence:JSON.stringify(wire.authoritativeEvidence),businessTone:{},history:[],budget,current:async()=>true,revalidateEvidence:async()=>evidence,diagnostic:e=>events.push(e),
  generate:async(stage,_instruction,data)=>{budget.attempt();stages.push(stage);
   if(stage==='extraction'){elapsed+=extraction.durationMs;return{text:extraction.outputText};}
   if(stage==='verification'){assert.deepEqual(compactKnowledgeVerifierInput(data),wire,'Independent verifier input is byte-equivalent as structured data');elapsed+=verification.durationMs;return{text:verification.outputText};}
   assert.equal(stage,'composition');elapsed+=2007;throw Error('information_deadline');
  }});
 assert.equal(manifest.text,capture.replies[0]);assert.equal(manifest.units.length,4);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.deepEqual(manifest.outcomes[0].obligations.map(o=>o.status),['UNRESOLVED']);
 for(const u of manifest.units)for(const ref of u.evidenceRefs){const e=evidence.find(e=>e.id===ref.evidenceId)!;assert.ok(e.text.includes(ref.exactQuote));assert.equal(e.version,ref.version);}
 assert.equal(stages.includes('composition'),baseline);assert.equal(manifest.presentationFallback,baseline);assert.equal(manifest.fallbackReason,baseline?'COMPOSER_FALLBACK':null);
 assert.equal(manifest.presentationPath,baseline?'fallback':'direct_verified_units');
 if(!baseline){const direct=events.find(e=>e.reason==='DIRECT_VERIFIED_UNITS');assert.ok(direct);assert.equal(knowledgeDiagnosticFailure(direct),'none');assert.ok(!events.some(e=>['DEADLINE','COMPOSER_FALLBACK'].includes(e.reason)));}
 measurements.push({case:'exact Cedar',stages,knowledgeModelCalls:stages.length,totalModelCallsIncludingRecordedLanguage:stages.length+1,simulatedStageTimeMs:elapsed,manifest,events});
 // Publication still subtracts whole facts after authority/revision loss.
 for(const invalid of ['catalog','document']as const){
  const current=evidence.filter(e=>invalid==='catalog'?e.id!==catalog.id:e.id!==docs[0].id);
  const pruned=pruneAnswerManifest(manifest,current);
  assert.deepEqual(pruned.units.map(u=>u.id),invalid==='catalog'?['u2','u3','u4']:['u1']);
  assert.notEqual(pruned.outcomes[0].status,'VERIFIED');assert.equal(pruneAnswerManifest(pruned,evidence).text,pruned.text);
 }
});

const localized={
 en:['Visitors should bring the reference number if it is available.','A remote briefing does not automatically replace an inspection.'],
 sv:['Besökare bör ta med referensnumret om det finns tillgängligt.','En digital genomgång ersätter inte automatiskt en inspektion.'],
 de:['Besucher sollten die Referenznummer mitbringen, falls sie verfügbar ist.','Eine digitale Besprechung ersetzt nicht automatisch eine Inspektion.'],
 es:['Los visitantes deberían traer el número de referencia si está disponible.','Una reunión remota no sustituye automáticamente una inspección.'],
 fa:['مراجعان بهتر است شماره مرجع را در صورت موجود بودن همراه بیاورند.','جلسه از راه دور به طور خودکار جایگزین بازرسی نمی‌شود.'],
 ar:['ينبغي للزوار إحضار الرقم المرجعي إذا كان متاحاً.','لا يحل اللقاء عن بعد تلقائياً محل الفحص.'],
};
const decision=(u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false});
for(const [language,texts]of Object.entries(localized))for(const complete of [true,false])test(`${language}/${complete?'complete':'partial'}: direct rendering never rewrites conditions, actors or negation`,async()=>{
 const facets=parseRequestedFacets([{subject:'visit',attribute:'preparation and remote briefing',questionType:'description'}]).facets;
 const evidence=answerEvidence(99,[{businessId:99,sourceId:'independent-guide',text:texts.join(' '),metadata:{documentRevision:'r1'}}]);
 const stages:string[]=[],events:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:'Visit preparation and the limits of remote briefings?',language,facets,evidence,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,diagnostic:e=>events.push(e),
 generate:async(stage,_instruction,data:any)=>{stages.push(stage);
  return{text:JSON.stringify(stage==='extraction'?{units:texts.map((text,i)=>({facetIds:['f1'],subject:i?'remote briefing':'visitors',predicate:i?'replace':'bring',value:i?'inspection':'reference number',scope:i?'remote briefing':'visitors',modality:i?'descriptive':'recommended',negation:!!i,qualifiers:i?['not automatically']:['if available'],language,text,evidenceRefs:[{evidenceId:'e1',exactQuote:text}]}))}:stage==='verification'?{decisions:data.units.map(decision),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:complete,incompletenessReason:complete?'NONE':'UNRESOLVED',materialUnitIds:['u1','u2'],obligations:[{obligationId:'f1.o1',status:complete?'COVERED':'UNRESOLVED',unitIds:['u1','u2']}]}]}:{unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 assert.deepEqual(manifest.units.map(u=>u.text),texts);assert.deepEqual(manifest.units.map(u=>u.negation),[false,true]);assert.deepEqual(manifest.units.map(u=>u.modality),['recommended','descriptive']);
 assert.equal(manifest.outcomes[0].status,complete?'VERIFIED':'PARTIAL');assert.equal(manifest.text.startsWith(texts.join(' ')),true);
 assert.equal(stages.includes('composition'),baseline);if(!baseline){assert.equal(manifest.presentationFallback,false);assert.equal(manifest.fallbackReason,null);assert.equal(manifest.presentationPath,'direct_verified_units');}
});

for(const prefix of ['none','greeting']as const)test(`multiple facets retain question-order composition and optional ${prefix}, without rewriting facts`,async()=>{
 const texts=localized.en,facets=parseRequestedFacets([{subject:'visit',attribute:'preparation',questionType:'description'},{subject:'remote briefing',attribute:'inspection replacement',questionType:'description'}]).facets;
 const evidence=answerEvidence(99,[{businessId:99,sourceId:'guide',text:texts.join(' ')}]);let compositions=0;
 const manifest=await buildEvidenceFirstAnswer({question:'Preparation, then remote inspection limits?',language:'en',facets,evidence,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction')return{text:JSON.stringify({units:[1,0].map(i=>({facetIds:[`f${i+1}`],subject:i?'remote briefing':'visitors',predicate:i?'replace':'bring',value:'arrangement',scope:'visits',modality:i?'descriptive':'recommended',negation:!!i,qualifiers:[],language:'en',text:texts[i],evidenceRefs:[{evidenceId:'e1',exactQuote:texts[i]}]}))})};
  if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map(decision),coverage:facets.map(f=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.filter((u:any)=>u.facetIds.includes(f.id)).map((u:any)=>u.id),obligations:[{obligationId:f.obligations[0].id,status:'COVERED',unitIds:data.units.filter((u:any)=>u.facetIds.includes(f.id)).map((u:any)=>u.id)}]}))})};
  compositions++;return{text:JSON.stringify({unitIds:['u2','u1'],prefix,addition:false})};
 }});
 assert.equal(compositions,1);assert.equal(manifest.presentationPath,'composed');assert.equal(manifest.text,(prefix==='greeting'?'Hello! ':'')+texts.join(' '));
 assert.deepEqual(manifest.units.map(u=>u.text),[texts[1],texts[0]],'Ordering must not mutate verified units');
});

for(const fault of ['misaligned-request','expired-context','revoked-source']as const)test(`direct presentation does not bypass ${fault}`,async()=>{
 const texts=localized.en,facets=parseRequestedFacets([{subject:'visit',attribute:'preparation and remote briefing',questionType:'description'}]).facets;
 const evidence=answerEvidence(99,[{businessId:99,sourceId:'guide',text:texts.join(' '),metadata:{documentRevision:'r1'}}]);
 let verified=false,compositions=0;const events:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:'Preparation and remote briefing limits?',language:'en',facets,evidence,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),diagnostic:e=>events.push(e),
 current:async()=>!(verified&&fault==='expired-context'),revalidateEvidence:async()=>verified&&fault==='revoked-source'?[]:evidence,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction')return{text:JSON.stringify({units:texts.map((text,i)=>({facetIds:['f1'],subject:i?'remote briefing':'visitors',predicate:i?'replace':'bring',value:'arrangement',scope:'visits',modality:i?'descriptive':'recommended',negation:!!i,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e1',exactQuote:text}]}))})};
  if(stage==='verification'){verified=true;return{text:JSON.stringify({decisions:data.units.map(decision),coverage:[{facetId:'f1',requestAligned:fault!=='misaligned-request',materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:['u1','u2'],obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1','u2']}]}]})};}
  compositions++;return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 assert.equal(events.some(e=>e.reason==='DIRECT_VERIFIED_UNITS'),false);
 if(fault==='misaligned-request'){assert.equal(compositions,1,'Misaligned coverage stays outside the new admission');assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].requestAligned,false);}
 else{assert.equal(manifest.units.length,0);assert.ok(texts.every(text=>!manifest.text.includes(text)));assert.equal(compositions,0);}
});
