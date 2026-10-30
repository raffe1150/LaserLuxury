import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {KnowledgeService} from '../../knowledge';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {incidentConfig,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {preliminaryAcceptancePlan,documentaryQuotes,documentaryStatements} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {wholeQuestionInformationPlan} from './knowledge-planning';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
delete process.env.ODINLINK_SHARED_PG;
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const normalizeBoundary=(s:string)=>s.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
const corpus=await sharedCorpus(false,true),records:any[]=[];
after(()=>{corpus.cleanup();if(process.env.ODINLINK_ACCURACY_NATIVE_RESULTS)writeFileSync(process.env.ODINLINK_ACCURACY_NATIVE_RESULTS,JSON.stringify({provider:'scripted only',providerRequests:0,realSemanticAcceptance:false,records},null,2),{flag:'wx'});});
let serial=46707000000;
for(const prepared of preliminaryAcceptancePlan.filter(s=>s.family==='A'))for(const channel of ['telegram','whatsapp','instagram','messenger'] as const)for(const mode of ['complete','slow-complete','incomplete','unknown','revoked','late-extraction'] as const){const spec={...prepared,channel};test(`accuracy-first native ${spec.id}/${spec.channel}/${mode}`,async t=>{
 const original={...incidentConfig};b.reset();const recipient=String(++serial),stages:string[]=[],inputs:any[]=[],events:any[]=[],replies:string[]=[],lookups:any[]=[];let actions=0,unhandled:any,semanticSearches=0,verified=false;const timingEvents:any[]=[];
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,(label,data)=>{if(label==='[KnowledgeTimingPolicy]')timingEvents.push(data);});
 // Synthetic equal vectors test evidence transport, not multilingual ranking.
 const v={provider:'openai',model:'synthetic-preparation',dimensions:2,version:1,values:[1,0]};
 const service=new KnowledgeService(corpus.storage,corpus.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>v,embedDocuments:async texts=>texts.map(text=>({...v,values:text==='Heading'?[0,1]:[1,0]}))});
 const forbidden=async()=>{actions++;throw Error('Unauthorized booking/calendar/notification action');};
 let virtualNow=Date.now();
 if(['slow-complete','late-extraction'].includes(mode))t.mock.method(Date,'now',()=>virtualNow);
 const start=performance.now();
 try{
  // Keep the business locale Swedish. Only the classifier's current-message
  // language judgment selects the expected customer language in this rehearsal.
  incidentConfig.language='sv';
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(id,q,limit)=>{assert.equal(id,77);const matches=await service.search(id,q,limit);lookups.push({id,q,matches});return matches;},
   knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),
   semanticKnowledgeSearchQueries:(id,q,limit,options)=>{semanticSearches++;assert.equal(id,77);assert.ok(q.length>0&&q.length<=3,'Preserve bounded multilingual retrieval probes');return service.semanticSearchQueries(id,q,limit,options);},
   knowledgeRetrievalDiagnostic:e=>events.push(e),
   validateKnowledgeMatches:(id,m)=>mode==='revoked'&&verified ? Promise.resolve([]) : service.validateMatches(id,m,{strictSources:true,captureRevision:true}),knowledgeServiceCatalog:async id=>{assert.equal(id,77);return incidentConfig.services;},
   evidenceFirstDiagnostic:e=>inputs.push({stage:'manifest',data:e}),evidenceFirstDecisionDiagnostic:e=>events.push(e),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){if(['slow-complete','late-extraction'].includes(mode))virtualNow+=1694;assert.ok(p.config.abortSignal instanceof AbortSignal,'Absolute policy owns pre-Knowledge classification');stages.push('language');return{text:JSON.stringify({language:spec.language,requestedReplyLanguage:null,confidence:.99})};}
    if(instruction.startsWith('OdinLink source-language search query.')){stages.push('source_query');return{text:JSON.stringify({query:'förberedelser parfym vattenflaska mat mellanmål väntrum behandlingsrum arbetsrum'})};}
    if(!/retrieval query planner|UNIT EXTRACTION|BATCH ENTAILMENT|VERIFIED-UNIT PRESENTATION/u.test(instruction)){
     unhandled={instruction,contents:p.contents};throw Error('Preparation requires reviewed independent evidence-first execution, not an unsupported scripted legacy response');
    }
    const data=JSON.parse(p.contents[0].parts[0].text);inputs.push({instruction,data});
    if(instruction.includes('retrieval query planner')){stages.push('planning');return{text:JSON.stringify({canonicalMeaning:data.question,queries:[data.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'customer information request',attribute:data.question,questionType:'description',obligations:[{description:data.question,questionType:'description'}]}]})};}
    if(instruction.includes('UNIT EXTRACTION')){
     if(mode==='slow-complete')virtualNow+=12000;
     if(mode==='late-extraction')virtualNow+=21000;
     stages.push('extraction');assert.equal(normalizeBoundary(data.question),normalizeBoundary(spec.question));assert.equal(normalizeBoundary(data.facets[0].obligations[0].description),normalizeBoundary(spec.question));assert.deepEqual(data.facets.map((f:any)=>normalizeBoundary(f.attribute)),[normalizeBoundary(spec.question)]);assert.ok(data.evidence.every((e:any)=>e.businessId===77&&e.sourceId!=='configured-services:77'));
     return{text:JSON.stringify({units:documentaryStatements[spec.family][spec.language].map((text,i)=>{
      const quote=documentaryQuotes[spec.family][i],e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e,`Missing exact quote: ${spec.id}/${i}`);
      return{facetIds:['f1'],subject:'AdMotion Studio visitors',predicate:`document fact ${i+1}`,value:text,
       scope:'documented visitor conditions',modality:i===0?'required':i===1?'recommended':i===3?'prohibited':'permitted',negation:i===3,
       qualifiers:[],language:spec.language,text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};
     }).filter((_,i)=>mode!=='incomplete'||i!==0)})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     if(mode==='slow-complete')virtualNow+=8000;
     stages.push('verification');verified=true;assert.equal(normalizeBoundary(data.question),normalizeBoundary(spec.question));assert.equal(data.requestedLanguage,spec.language);
     assert.ok(data.evidence.every((e:any)=>e.businessId===77));
     for(const u of data.units)for(const r of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===r.evidenceId);assert.ok(e?.text.includes(r.exactQuote));}
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='unknown'&&u.modality==='permitted'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode!=='incomplete',incompletenessReason:mode==='incomplete'?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
    }
    stages.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  await incidentInbound(b,spec.channel,spec.question,recipient);
  records.push({spec,stages,inputs,events,replies,lookups,unhandled,actions,semanticSearches,wallMs:performance.now()-start});
  assert.equal(stages.filter(s=>s==='planning').length,wholeQuestionInformationPlan(spec.question,true)?0:1,'Preserve existing multilingual planning admission');assert.equal(semanticSearches,['fa','ar'].includes(spec.language)?2:1,'Preserve existing bounded source-language retrieval pass; no exhaustive limit increase');
  assert.ok(lookups.length>0,'Existing bounded lexical probes execute; original request is asserted at extraction and verification');
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(stages.filter(s=>s==='extraction').length,1,'Every preliminary case must reach real-path independent evidence extraction');
  assert.equal(stages.filter(s=>s==='verification').length,mode==='late-extraction'?0:1,'Scripted legacy output is not semantic acceptance');
  for(const text of documentaryStatements[spec.family][spec.language])assert.equal(replies[0].includes(text),['complete','slow-complete'].includes(mode),`Complete or Safe Failure: ${text}`);
  const publication=[...events].reverse().find(e=>e.stage==='publication');assert.equal(publication?.route,['complete','slow-complete'].includes(mode)?'verified_manifest':'unavailable');
  assert.equal(timingEvents.length,1);assert.equal(timingEvents[0].policyVersion,'accuracy-first-v1');
  assert.ok(timingEvents[0].events.some((e:any)=>e.event==='delivery_started'));
  assert.ok(timingEvents[0].elapsedMs<45000);
  if(mode==='slow-complete'){assert.ok(timingEvents[0].elapsedMs>=21694);assert.ok(events.some(e=>e.stage==='extraction'&&e.timeoutMs>18000));}
 }finally{Object.assign(incidentConfig,original);b.reset();}
});}
