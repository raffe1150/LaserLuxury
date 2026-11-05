/** Real adapters and retrieval; SCRIPTED extraction/verifier. No external calls. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {knowledgeSourceRevision} from '../../knowledge';
import {incidentFlags,incidentConfig,incidentCorpus,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {AiReliabilityError} from './reliability';
import {documentChunks} from '../knowledge/documents/service';
incidentFlags();
Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',
 ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',
 ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS:'source-partitioned-v1',ODINLINK_HIERARCHICAL_SEARCH:'off'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const cases=[
 {language:'fa',question:'اگر وسیله‌ای رو در محل شما جا بذارم، تا چند روز نگهش می‌دارید و برای تحویل گرفتنش باید چه اطلاعاتی بدم؟',
 answer:'طبق این سند تخیلی آزمایشی، وسایل پیدا‌شده به پذیرش تحویل داده می‌شوند. وسایل جامانده معمولاً تا 21 روز نگهداری می‌شوند. اشیای باارزش جداگانه ثبت می‌شوند. برای تحویل گرفتن باید وسیله را توصیف کنید. طبق همین شرایط آزمایشی، مجموعه مسئول ارسال پستی وسایل جامانده نیست.'},
 {language:'sv',question:'Om jag glömmer något hos er, hur länge förvaras det och vad behöver jag uppge för att hämta det?',
 answer:'Enligt detta fiktiva testdokument lämnas hittade föremål till receptionen. Kvarglömda föremål förvaras normalt i upp till 21 dagar. Värdesaker registreras separat. Du behöver beskriva föremålet innan det kan lämnas ut. Enligt testvillkoren ansvarar studion inte för att skicka föremålen med post.'},
 {language:'de',question:'Wenn ich einen Gegenstand bei Ihnen vergesse, wie lange bewahren Sie ihn auf und welche Angaben brauche ich zur Abholung?',
 answer:'Laut diesem fiktiven Testdokument werden gefundene Gegenstände an der Rezeption abgegeben und normalerweise bis zu 21 Tage aufbewahrt. Wertgegenstände werden separat registriert. Vor der Abholung müssen Sie den Gegenstand beschreiben. Laut diesen Testbedingungen ist das Studio nicht für den Postversand verantwortlich.'},
 {language:'es',question:'Si olvido un objeto en sus instalaciones, ¿cuánto tiempo lo guardan y qué información necesito para recogerlo?',
 answer:'Según este documento ficticio de prueba, los objetos encontrados se entregan en recepción y normalmente se guardan hasta 21 días. Los objetos de valor se registran por separado. Debe describir el objeto antes de recogerlo. Según estas condiciones de prueba, el estudio no se responsabiliza de enviarlo por correo.'},
 {language:'en',question:'If I leave an item at your premises, how long do you keep it and what must I provide to collect it?',
 answer:'According to this fictional test document, found items are handed to reception and normally kept for up to 21 days. Valuables are registered separately. You must describe the item before collecting it. Under these test terms, the studio is not responsible for sending lost items by post.'},
];
const revised={...cases[0],question:'سلام، اگه یکی از وسایل شخصیم رو پیش شما فراموش کنم، معمولاً چقدر فرصت دارم که برگردم دنبالش؟ برای پس گرفتنش باید مشخصات خاصی ارائه بدم؟'};
const receipts:any[]=[];
after(()=>{if(process.env.ODINLINK_LOST_PROPERTY_RECEIPTS)writeFileSync(process.env.ODINLINK_LOST_PROPERTY_RECEIPTS,JSON.stringify({mode:'SCRIPTED_NOT_GENUINE',receipts},null,2));});
type Fault='none'|'stale'|'incomplete'|'foreign'|'conflict'|'oversized'|'source-query-deadline'|'extraction-deadline'|'verification-deadline'|'postal-obligation'|'planner-deadline'|'read-timeout'|'read-error'|'read-null'|'revoked'|'slow'|'low-budget'|'dual-planning-deadline';
async function replay(t:any,spec:typeof cases[number],channel:typeof incidentChannels[number],fault:Fault,inventoryMode=false,readDelay=350){
 b.reset();for(const key of ['log','info','warn','error'] as const)t.mock.method(console,key,()=>{});
 const now=Date.now();if(fault==='low-budget')t.mock.timers.enable({apis:['Date'],now});
 const old=structuredClone(incidentConfig);Object.assign(incidentConfig,{language:spec.language,services:[]});
 const corpus=await incidentCorpus(false,77),sources=await corpus.storage.list(77);
 const record:any={language:spec.language,channel,fault,question:spec.question,inventoryMode,readDelay,stages:[],completions:[],payloads:[],decisions:[],answers:[],actions:0,assertionErrors:[]};
 const deny=async()=>{record.actions++;throw Error('OFFLINE_ACTION_FORBIDDEN');};
 if(fault==='oversized'){
  const pdf=sources.find(s=>s.id==='incident-pdf')!,extra='Extra unsupported section';
  const sections=(pdf.metadata.segments as any[]).map(({start,end,...provenance})=>({text:pdf.content.slice(start,end),...provenance}));
  const parsed=documentChunks([...sections,{text:extra,page:99}],pdf.title);
  await corpus.storage.create({...pdf,content:parsed.content,metadata:parsed.metadata});
 }
 if(fault==='conflict'){
  const txt=sources.find(s=>s.id==='incident-txt')!,text=txt.content+'\nKvarglömda föremål sparas bara i 2 dagar, inte 21 dagar.';
  const parsed=documentChunks([{text,section:'Text'}],txt.title);await corpus.storage.create({...txt,content:parsed.content,metadata:parsed.metadata});
  await corpus.storage.replaceChunks(77,txt.id,parsed.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata as any})));
 }
 let completed:any[]=[],extracted=false;
 const expectedSources=await corpus.storage.list(77);
 const checkPayload=(stage:string,data:any)=>{
  const normalize=(s:string)=>s.replace(/[؟،\u200c]/gu,c=>c==='؟'?'?':c==='،'?',':' ');
  assert.equal(normalize(data.question),normalize(spec.question));
  assert.ok(data.evidence.length<=5);assert.ok(data.evidence.every((e:any)=>e.businessId===77&&e.text.length<=2400));
  assert.ok(data.evidence.reduce((n:number,e:any)=>n+e.text.length,0)<=9000);
  assert.equal(completed.length,6);assert.deepEqual(new Set(completed.map(m=>m.sourceId)),new Set(['incident-pdf','incident-txt']));
  for(const m of completed){assert.equal(m.businessId,77);assert.equal(m.metadata.documentRevision,knowledgeSourceRevision(expectedSources.find(s=>s.id===m.sourceId)!));
   assert.ok(data.evidence.some((e:any)=>e.text.includes(m.text)),'No canonical text may be lost in grouping');}
  record.payloads.push({stage,records:data.evidence.length,canonicalChunks:completed.length,retainedSources:[...new Set(completed.map(m=>m.sourceId))],sourceGroups:data.evidence.map((e:any)=>e.sourceGroup),revisions:[...new Set(completed.map(m=>m.metadata.documentRevision))]});
 };
 b.configure({offlineAi:true,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  semanticLanguageResolver:async()=>{if(fault==='low-budget')t.mock.timers.setTime(now+25000);return{language:spec.language,confidence:1};},knowledgeServiceCatalog:async()=>[],
  knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),
  semanticKnowledgeSearchQueries:async()=>[],completeKnowledgeCorpus:async(id,m,options,mode)=>{
   if(mode!=='native-documentary'||!inventoryMode)return corpus.service.completeSmallCorpus(id,m,options);
   if(fault==='read-error')throw Error('scripted inventory read failure');
   if(fault==='read-null')return null;
   await new Promise(resolve=>setTimeout(resolve,fault==='read-timeout'?1100:readDelay));
   const result=await corpus.service.completeSmallCorpus(id,m,options,mode);completed=result||[];
   record.completions.push({kind:'inventory',output:result?.length||0});
   if(fault==='stale'||fault==='revoked'){const pdf=expectedSources.find(s=>s.id==='incident-pdf')!;await corpus.storage.create({...pdf,...(fault==='revoked'?{status:'disabled' as const}:{content:pdf.content+' changed'})});}
   if(fault==='incomplete'&&result)return result.slice(1);
   if(fault==='foreign'&&result)return result.map((m,i)=>i?m:{...m,businessId:88});
   return result;
  },
  completeKnowledgeDocuments:async(id,m,anchors,options)=>{
   if(fault==='slow'||fault==='read-timeout')await new Promise(resolve=>setTimeout(resolve,fault==='read-timeout'?1100:readDelay));
   if(fault==='read-error')throw Error('scripted selected read failure');
   if(fault==='read-null')return null;
   const result=await corpus.service.completeSelectedDocuments(id,m,anchors,options);completed=result||[];
   record.completions.push({input:m.length,output:result?.length||0});
   if(fault==='stale'){const pdf=expectedSources.find(s=>s.id==='incident-pdf')!;await corpus.storage.create({...pdf,content:pdf.content+' changed'});}
   if(fault==='incomplete'&&result)return result.filter((_,i)=>i!==0);
   if(fault==='foreign'&&result)return result.map((m,i)=>i?m:{...m,businessId:88});
   return result;
  },
  validateKnowledgeMatches:(id,m)=>corpus.service.validateMatches(id,m,{strictSources:true,captureRevision:true,requireCompleteDocumentContext:true}),
  evidenceFirstDecisionDiagnostic:e=>record.decisions.push(e),knowledgeRetrievalDiagnostic:e=>record.retrieval=e,
  calendarAdapter:{getCalendarId:()=> 'offline',getEvents:deny,checkSlots:deny,insertAppointment:deny,cancelAppointment:deny,updateAppointment:deny},
  recordAppointment:deny,cancelAppointmentRow:deny,updateAppointmentRow:deny,
  aiGenerate:async request=>{try{
   const instruction=request.systemInstruction||'',data=JSON.parse(request.messages[0].content);
   if(instruction.includes('retrieval query planner')){record.stages.push('planning');if(fault==='planner-deadline'||fault==='dual-planning-deadline'){await new Promise(resolve=>setTimeout(resolve,2600));throw new AiReliabilityError('TIMEOUT','scripted planner timeout');}return{functionCalls:[],text:JSON.stringify({canonicalMeaning:spec.question,queries:['kvarglömda föremål information'],queryLanguages:[{query:'kvarglömda föremål information',language:'sv'}],referenceResolution:'NOT_REQUIRED',requestKind:'BUSINESS_INFORMATION',requestedFacets:[{subject:'lost property',attribute:spec.question,questionType:'description'}]})};}
   if(instruction.startsWith('OdinLink source-language search query.')){
    record.stages.push('source_query');if(fault==='source-query-deadline'||fault==='dual-planning-deadline')await new Promise(resolve=>setTimeout(resolve,2600));
    return{functionCalls:[],text:JSON.stringify({query:'kvarglömda föremål information'})};
   }
   if(instruction.includes('UNIT EXTRACTION')){
    record.stages.push('extraction');extracted=true;
    if(['stale','incomplete','oversized','revoked','read-timeout','read-error','read-null'].includes(fault)){
     assert.ok(data.evidence.length>0);
     assert.ok(data.evidence.every((e:any)=>e.businessId===77&&!e.text.includes('Kvarglömda föremål')&&!e.text.includes('All information i detta dokument är')),'Invalid PDF is quarantined while current TXT remains usable');
     record.payloads.push({stage:'extraction',records:data.evidence.length,quarantinedPdf:true});
     return{functionCalls:[],text:JSON.stringify({oversized:false,units:[]})};
    }
    checkPayload('extraction',data);
    if(fault==='extraction-deadline')throw new AiReliabilityError('TIMEOUT','scripted provider timeout');
    const policy=data.evidence.find((e:any)=>e.text.includes('Kvarglömda föremål förvaras normalt'));
    const declaration=data.evidence.find((e:any)=>e.text.includes('All information i detta dokument är'));
    assert.ok(policy&&declaration);assert.equal(policy.sourceGroup,declaration.sourceGroup);
    // Explicit opaque ID and exact quote transport, depending on the existing contract.
    const literal=instruction.includes('literal-evidence-v1');
    return{functionCalls:[],text:JSON.stringify({oversized:false,units:[{facetIds:data.facets.map((f:any)=>f.id),subject:'lost property',predicate:'documented retention and collection',value:spec.answer,
     modality:'descriptive',negation:false,scope:'fictional test document only',qualifiers:['fictional test document only'],language:spec.language,text:fault==='postal-obligation'?spec.answer+' باید وسیله جامانده را از طریق پست ارسال کنید.':spec.answer,
     evidenceRefs:[{evidenceId:policy.id,...(!literal?{exactQuote:policy.text.slice(policy.text.indexOf('Föremål som hittas'),policy.text.indexOf('8. Digitala')).trim()}:{})},
      {evidenceId:declaration.id,...(!literal?{exactQuote:declaration.text.slice(declaration.text.indexOf('Observera:'),declaration.text.indexOf('1. Inför')).trim()}:{})}]}]})};
   }
   assert.ok(instruction.includes('BATCH ENTAILMENT'),'Unexpected provider stage');record.stages.push('verification');checkPayload('verification',data);
   assert.equal(request.structuredOutput?.name,'odinlink_knowledge_source_exhaustive_v2');
   if(fault==='verification-deadline')throw new AiReliabilityError('TIMEOUT','scripted provider timeout');
   if(fault==='conflict')assert.ok(data.evidence.some((e:any)=>e.text.includes('sparas bara i 2 dagar')));
   if(fault==='postal-obligation')assert.ok(data.units.some((u:any)=>u.text.includes('باید وسیله جامانده را از طریق پست ارسال کنید.')));
   const safe=fault!=='conflict'&&fault!=='postal-obligation';const ids=data.units.map((u:any)=>u.id);
   for(const u of data.units)for(const r of u.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===r.evidenceId)?.text.includes(r.exactQuote));
   return{functionCalls:[],text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:safe?'ENTAILED':'CONTRADICTED',meaningPreserved:safe,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
    coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:safe,incompletenessReason:safe?'NONE':'MISSING_CONDITION',materialUnitIds:safe?ids:[],obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:safe?'COVERED':'UNRESOLVED',unitIds:safe?ids:[]}))})),
    sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:safe,conditionsPreserved:true,conflictsAbsent:safe,evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:ids,obligations:data.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:safe?'COMPLETE':'SOURCE_CONFLICT'})))}})};
  }catch(error){if((error as any)?.code==='ERR_ASSERTION')record.assertionErrors.push((error as Error).message);throw error;}}});
 t.mock.method(globalThis,'fetch',async(url,options)=>{record.answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
 try{
  assert.equal(b.inspectNativeKnowledgeAdmissionForTest(channel,spec.question,incidentConfig),true);
  await incidentInbound(b,channel,spec.question);receipts.push(record);
  assert.deepEqual(record.assertionErrors,[]);assert.equal(record.actions,0);assert.equal(record.answers.length,1);if(fault==='low-budget')assert.ok(record.retrieval.canonicalCompletion.some((r:any)=>r.outcome==='skipped_budget'));
  if(fault==='none'||fault==='slow'||fault==='planner-deadline'||fault==='dual-planning-deadline'||inventoryMode&&fault==='source-query-deadline'){
   assert.deepEqual(record.answers,[spec.answer]);assert.equal(record.stages.filter((s:string)=>s==='extraction').length,1);assert.equal(record.stages.filter((s:string)=>s==='verification').length,1);
   assert.equal(record.payloads.length,2);if(inventoryMode){assert.equal(record.retrieval.completeCorpusUsed,true);assert.equal(record.stages.includes('source_query'),false);assert.ok(record.retrieval.canonicalCompletion.some((r:any)=>r.kind==='inventory'&&r.outcome==='complete'));}assert.ok(record.decisions.some((e:any)=>e.stage==='publication'&&e.publishableUnits>0));
  }else{
   assert.ok(record.answers.every((a:string)=>!a.includes('21')));assert.notDeepEqual(record.answers,[spec.answer]);
   if(['foreign','source-query-deadline'].includes(fault))assert.equal(extracted,false);
   if(fault==='source-query-deadline')assert.ok(record.decisions.some((e:any)=>e.stage==='planning'&&e.reason==='DEADLINE'));
   if(fault==='extraction-deadline'||fault==='verification-deadline')assert.ok(record.decisions.some((e:any)=>e.stage===(fault==='extraction-deadline'?'extraction':'verification')&&e.reason==='DEADLINE'));
   if(fault==='postal-obligation')assert.ok(record.decisions.some((e:any)=>e.stage==='verification'&&e.reason==='CONTRADICTED'));
  }
 }finally{Object.assign(incidentConfig,old);b.reset();}
}
for(const spec of cases)for(const channel of incidentChannels)test('SCRIPTED lost-property original adapter/'+spec.language+'/'+channel,{timeout:8000},t=>replay(t,spec,channel,'none'));
for(const fault of ['stale','incomplete','foreign','conflict','oversized','source-query-deadline','extraction-deadline','verification-deadline','postal-obligation'] as const)
 for(const channel of incidentChannels)test('SCRIPTED lost-property safety/'+fault+'/'+channel,{timeout:8000},t=>replay(t,cases[0],channel,fault));

// The production failure replays use a complete tenant inventory and real bounded
// database-delay simulation, not injected matches or a second test harness.
for(const spec of [cases[0],revised])for(const channel of incidentChannels)
 for(const delay of [150,350,750])test(`SCRIPTED full canonical inventory/${spec===revised?'reworded':'original'}/${channel}/${delay}ms`,{timeout:8000},t=>replay(t,spec,channel,'slow',true,delay));
for(const channel of incidentChannels)test(`SCRIPTED live planner timeout with canonical inventory/${channel}`,{timeout:8000},t=>replay(t,revised,channel,'planner-deadline',true));
for(const channel of incidentChannels)test(`SCRIPTED slow selected-source completion/${channel}`,{timeout:8000},t=>replay(t,cases[0],channel,'slow',false,350));
for(const fault of ['stale','revoked','incomplete','foreign','conflict','oversized','read-timeout','read-error','read-null','extraction-deadline','verification-deadline','postal-obligation'] as const)
 for(const channel of incidentChannels)test(`SCRIPTED canonical inventory safety/${fault}/${channel}`,{timeout:8000},t=>replay(t,cases[0],channel,fault,true));
for(const fault of ['read-timeout','read-error','read-null'] as const)
 test(`SCRIPTED selected completion outcome/${fault}`,{timeout:8000},t=>replay(t,cases[0],'telegram',fault,false));

for(const channel of incidentChannels)test(`SCRIPTED canonical read preserves downstream reserves/${channel}`,{timeout:8000},t=>replay(t,cases[0],channel,'low-budget',true));

for(const channel of incidentChannels)test(`SCRIPTED exact 2358 dual query timeout replay/${channel}`,{timeout:8000},t=>replay(t,revised,channel,'dual-planning-deadline',true));
