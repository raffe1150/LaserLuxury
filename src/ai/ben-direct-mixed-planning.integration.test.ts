import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {KnowledgeService} from '../../knowledge';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {preliminaryAcceptancePlan,documentaryQuotes,documentaryStatements,type AcceptanceFamily} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {serviceFactText} from '../../tests/fixtures/direct-service-questions';
import {serviceScopeUncertainty} from './source-aware-service-proposal';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
delete process.env.ODINLINK_SHARED_PG;
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await sharedCorpus(false,true),records:any[]=[];
after(()=>{corpus.cleanup();if(process.env.ODINLINK_BEN_DIRECT_RESULTS)writeFileSync(process.env.ODINLINK_BEN_DIRECT_RESULTS,JSON.stringify({provider:'scripted only',providerRequests:0,realSemanticAcceptance:false,records},null,2),{flag:'wx'});});
const normalizeBoundary=(s:string)=>s.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
let serial=46707000000;
const before=process.env.ODINLINK_BEN_DIRECT_BEFORE==='true';
for(const spec of incidentChannels.map(channel=>({...preliminaryAcceptancePlan.find(s=>s.id==='B-en')!,channel})))test(`direct B-en/${spec.channel}`,async t=>{
 const original={...incidentConfig};b.reset();const recipient=String(++serial),stages:string[]=[],inputs:any[]=[],events:any[]=[],replies:string[]=[],lookups:any[]=[];let actions=0,unhandled:any;
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 // Synthetic equal vectors test evidence transport, not multilingual ranking.
 const v={provider:'openai',model:'synthetic-preparation',dimensions:2,version:1,values:[1,0]};
 const service=new KnowledgeService(corpus.storage,corpus.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>v,embedDocuments:async texts=>texts.map(text=>({...v,values:text==='Heading'?[0,1]:[1,0]}))});
 const forbidden=async()=>{actions++;throw Error('Unauthorized booking/calendar/notification action');};
 const start=performance.now();
 try{
  // Keep the business locale Swedish. Only the classifier's current-message
  // language judgment selects the expected customer language in this rehearsal.
  incidentConfig.language='sv';
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(id,q,limit)=>{assert.equal(id,77);const matches=await service.search(id,q,limit);lookups.push({id,q,matches});return matches;},
   knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),
   semanticKnowledgeSearchQueries:(id,q,limit,options)=>service.semanticSearchQueries(id,q,limit,options),
   validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m,{strictSources:true,captureRevision:true}),knowledgeServiceCatalog:async id=>{assert.equal(id,77);return incidentConfig.services;},
   evidenceFirstDiagnostic:e=>inputs.push({stage:'manifest',data:e}),evidenceFirstDecisionDiagnostic:e=>events.push(e),
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:JSON.stringify({language:spec.language,requestedReplyLanguage:null,confidence:.99})};}
    if(!/retrieval query planner|UNIT EXTRACTION|BATCH ENTAILMENT|VERIFIED-UNIT PRESENTATION/u.test(instruction)){
     unhandled={instruction,contents:p.contents};throw Error('Preparation requires reviewed independent evidence-first execution, not an unsupported scripted legacy response');
    }
    const data=JSON.parse(p.contents[0].parts[0].text);inputs.push({instruction,data});
    if(instruction.includes('retrieval query planner')){stages.push('planning');await new Promise(r=>setTimeout(r,40));return{text:JSON.stringify({canonicalMeaning:data.question,queries:[data.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'customer information request',attribute:data.question,questionType:'description',obligations:[{description:data.question,questionType:'description'}]}]})};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');assert.equal(data.question,spec.question.replaceAll('Video Consultation','[question subject]'));assert.equal(data.facets[0].obligations[0].description,data.question);assert.equal(data.evidence.some((e:any)=>e.id==='configured-services'),false);assert.ok(data.evidence.every((e:any)=>e.businessId===77&&e.sourceId!=='configured-services:77'));
     return{text:JSON.stringify({units:documentaryStatements[spec.family][spec.language].map((text,i)=>{
      const quote=documentaryQuotes[spec.family][i],e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e,`Missing exact quote: ${spec.id}/${i}`);
      return{facetIds:['f1'],subject:spec.family==='B'?'Digital information calls':'AdMotion Studio visitor policy',predicate:`document fact ${i+1}`,value:text,
       scope:spec.family==='B'?'documentary offering only':'documented visitor conditions',modality:spec.family==='A'?(i===0?'required':i===1?'recommended':i===3?'prohibited':'permitted'):'descriptive',negation:spec.family==='C'||spec.family==='B'&&i>1||spec.family==='A'&&i===3,
       qualifiers:[],language:spec.language,text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};
     })})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');assert.equal(data.facets[0].obligations[0].description,spec.question);assert.equal(data.units.length,5);assert.equal(normalizeBoundary(data.question),normalizeBoundary(spec.question));assert.equal(data.requestedLanguage,spec.language);
     assert.ok(data.evidence.every((e:any)=>e.businessId===77));
     for(const u of data.units)for(const r of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===r.evidenceId);assert.ok(e?.text.includes(r.exactQuote));}
     if(spec.family==='B'){assert.equal(data.units[0].text,serviceFactText[spec.language]('Video Consultation',300,'SEK',60,2));const catalog=data.evidence.find((e:any)=>e.id==='configured-services');assert.ok(catalog);assert.equal(JSON.parse(catalog.text).services[0].name,'Video Consultation');}
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:spec.family==='A',incompletenessReason:spec.family==='A'?'NONE':'MISSING_RELEVANT_FACT',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:spec.family==='A'?'COVERED':'UNRESOLVED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
    }
    stages.push('composition');return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  await incidentInbound(b,spec.channel,spec.question,recipient);
  records.push({spec,stages,inputs,events,replies,lookups,unhandled,actions,wallMs:performance.now()-start});
  assert.equal(stages.filter(s=>s==='planning').length,before?1:0,'Only the bounded direct contract may skip planning');assert.equal(stages.includes('composition'),false);
  const manifest=inputs.find(i=>i.stage==='manifest')?.data;assert.equal(manifest?.completeness[0].status,'PARTIAL');assert.equal(manifest?.completeness[0].materialFactsComplete,false);assert.equal(manifest?.completeness[0].obligations[0],'UNRESOLVED');
  assert.equal(actions,0);assert.equal(replies.length,1);assert.equal(stages.filter(s=>s==='extraction').length,1,'Every preliminary case must reach real-path independent evidence extraction');
  assert.equal(stages.filter(s=>s==='verification').length,1,'Scripted legacy output is not semantic acceptance');
  assert.equal(lookups[0].q,before?spec.question.slice(0,120).trim():spec.question,'Direct retrieval retains the entire original question');
  for(const text of documentaryStatements[spec.family][spec.language])assert.ok(replies[0].includes(text),`Missing requested proposition: ${text}`);
  const publication=[...events].reverse().find(e=>e.stage==='publication');assert.equal(publication?.route,spec.family==='A'?'verified_manifest':'partial_manifest');
  if(spec.family==='B')assert.ok(replies[0].includes(serviceScopeUncertainty('Video Consultation',spec.language)!));
  if(spec.family==='C')assert.doesNotMatch(replies[0],/\d+\s*(?:SEK|EUR)|\b(?:per hour|pro Stunde)\b/iu);
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
