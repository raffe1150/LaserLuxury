import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {sharedCorpus} from '../../tests/helpers/shared-core-incident';
import {serviceQuestionLanguages,serviceFactText} from '../../tests/fixtures/direct-service-questions';
import {mixedBusinesses,mixedQuestion,mixedParaphraseQuestion,independentMixedQuestion} from '../../tests/fixtures/mixed-source-questions';
import {serviceScopeUncertainty} from './source-aware-service-proposal';
import {literalInformationFallback} from './knowledge-planning';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import(process.env.ODINLINK_MIXED_BASELINE ? '../../server.mixed-before.ts' : '../../server.ts');
const corpus=await sharedCorpus(false);after(()=>corpus.cleanup());
for(const business of mixedBusinesses){
 const id=`mixed-${business.id}`;await corpus.storage.create({id,businessId:business.id,type:'document',status:'ready',title:business.subject,content:business.source,metadata:{segments:[{start:0,end:business.source.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'});
 await corpus.storage.replaceChunks(business.id,id,[{chunkIndex:0,content:business.source,metadata:{source:'document',section:'Text'}}]);
}
const before=process.env.ODINLINK_MIXED_COMPARISON==='before',measurements:any[]=[];
let serial=46702000000;
const normalized=(q:string)=>q.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
after(()=>{if(process.env.ODINLINK_MIXED_MEASUREMENTS)writeFileSync(process.env.ODINLINK_MIXED_MEASUREMENTS,JSON.stringify({phase:before?'before':'after',provider:'offline scripted transport, not provider inference',controlledPlannerDelayMs:40,measurements},null,2));});
const scenarios=mixedBusinesses.flatMap(business=>incidentChannels.flatMap(channel=>(before?['en']as const:serviceQuestionLanguages).map(language=>({business,channel,language,mode:'normal'}))));
if(!before)for(const business of mixedBusinesses)for(const channel of incidentChannels)for(const language of serviceQuestionLanguages)scenarios.push({business,channel,language,mode:'irrelevant-supplement'});
if(!before)for(const business of mixedBusinesses)for(const channel of incidentChannels)for(const language of serviceQuestionLanguages)scenarios.push({business,channel,language,mode:'catalog-absent-false-complete'});
if(!before)for(const business of mixedBusinesses)for(const channel of incidentChannels)for(const language of serviceQuestionLanguages)for(const mode of ['paraphrase','non-equivalence'])scenarios.push({business,channel,language,mode});
if(!before)for(const channel of incidentChannels)for(const mode of ['unknown-document','wrong-quote','unsupported-binding','stale-document','changed-catalog','foreign-document'])scenarios.push({business:mixedBusinesses[0],channel,language:'en',mode});
for(const {business,channel,language,mode}of scenarios)test(`mixed source ${business.id}/${channel}/${language}/${mode}`,async t=>{
 const original={...incidentConfig};b.reset();const recipient=String(++serial),stages:string[]=[],replies:string[]=[],payloads:any[]=[],events:any[]=[];let expectedDocumentText:string[]=[];let actions=0,catalogReads=0,lookups=0,firstRetrievalMs:number|null=null,validations=0;
 const question=mode==='paraphrase'?mixedParaphraseQuestion(business,language):mode==='non-equivalence'?independentMixedQuestion(business,language):mixedQuestion(business,language),started=performance.now();
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 const forbidden=async()=>{actions++;throw Error('Read-only request cannot operate bookings');};
 try{
  Object.assign(incidentConfig,{id:business.id,businessId:business.id,businessName:business.name,services:[business.service],language});
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});});
  b.configure({evidenceFirstDecisionDiagnostic:e=>events.push(e),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(tenant,q,limit)=>{lookups++;firstRetrievalMs??=performance.now()-started;assert.equal(tenant,business.id);assert.equal(normalized(q),normalized(stages.includes('planning')?question.slice(0,120):question),'Existing planner lexical probes are bounded; literal contracts keep the full question');const matches=await corpus.service.search(tenant,q,limit);return mode==='foreign-document'?matches.map(m=>({...m,businessId:99})):matches;},
   knowledgeSourceLanguages:tenant=>corpus.service.sourceLanguageHints(tenant),semanticKnowledgeSearchQueries:async(tenant,queries)=>{assert.equal(tenant,business.id);assert.deepEqual(queries.map(normalized),[normalized(question)]);return[];},
   knowledgeServiceCatalog:async tenant=>{catalogReads++;assert.equal(tenant,business.id);return mode==='catalog-absent-false-complete'?[]:[{...business.service,...(mode==='changed-catalog'&&catalogReads>=2?{price:999}:{})}];},
   validateKnowledgeMatches:(tenant,matches)=>{validations++;return mode==='stale-document'&&validations>=2?Promise.resolve([]):corpus.service.validateMatches(tenant,matches,{strictSources:true,captureRevision:true});},
   geminiGenerate:async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier')){stages.push('language');return{text:JSON.stringify({language,requestedReplyLanguage:null,confidence:.99})};}
    const data=JSON.parse(p.contents[0].parts[0].text);
    if(instruction.includes('retrieval query planner')){stages.push('planning');await new Promise(r=>setTimeout(r,40));return{text:JSON.stringify(literalInformationFallback(question,true))};}
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');payloads.push({stage:'extraction',data});if(mode==='catalog-absent-false-complete'){assert.equal(data.authorityScope,undefined);assert.equal(normalized(data.question),normalized(question));}else{assert.equal(data.authorityScope,'document_only');assert.doesNotMatch(JSON.stringify(data),new RegExp(business.service.name));}
     assert.ok(data.evidence.length>0);assert.ok(data.evidence.every((e:any)=>e.businessId===business.id&&e.id!=='configured-services'));
     const e=data.evidence.find((e:any)=>e.text===business.source);assert.ok(e,'Exact tenant-owned documentary text retrieved');
     const sentences=business.source.match(/[^.]+\./gu)!;
     // Scripted translations are fixture data, not evidence or a semantic judgment.
     const bike=business.id===99;
     const localized:Record<string,string[]>={
      en:sentences.map(s=>s.trim()),
      sv:[`${business.subject} ger endast ${bike?'inledande vägledning om inställning':'inledande orientering'}.`,`${business.subject} ersätter inte automatiskt en ${bike?'cykelinspektion':'verkstadsinspektion'}.`,`${bike?'Bromsfel':'Säkerhetskritiska fel'} kan inte bedömas från ${bike?'bilder':'fotografier'}.`,`${bike?'Cyklister bör ta med ramens identifieringsnummer':'Besökare bör ta med enhetens serienummer'} om det finns tillgängligt.`],
      de:[`${business.subject} bieten nur ${bike?'vorläufige Hinweise zur Einstellung':'eine erste Orientierung'}.`,`${business.subject} ersetzen nicht automatisch eine ${bike?'Fahrradinspektion':'Werkstattinspektion'}.`,`${bike?'Bremsdefekte':'Sicherheitskritische Fehler'} können nicht anhand von ${bike?'Bildern':'Fotos'} beurteilt werden.`,`${bike?'Radfahrer sollten die Rahmenkennung':'Besucher sollten die Seriennummer des Geräts'} mitbringen, falls sie verfügbar ist.`],
      es:[`${business.subject} ofrecen únicamente ${bike?'orientación preliminar sobre ajustes':'orientación inicial'}.`,`${business.subject} no sustituyen automáticamente una ${bike?'inspección de la bicicleta':'inspección en el taller'}.`,`${bike?'Los defectos de los frenos':'Los fallos críticos de seguridad'} no se pueden evaluar mediante ${bike?'imágenes':'fotografías'}.`,`${bike?'Los ciclistas deberían traer el identificador del cuadro':'Los visitantes deberían traer el número de serie del dispositivo'} si está disponible.`],
      fa:[`${business.subject} فقط ${bike?'راهنمایی مقدماتی تنظیم':'راهنمایی اولیه'} ارائه می‌دهد.`,`${business.subject} به طور خودکار جایگزین ${bike?'بازرسی دوچرخه':'بازرسی در کارگاه'} نمی‌شود.`,`${bike?'ایرادهای ترمز':'ایرادهای حیاتی ایمنی'} را نمی‌توان از روی ${bike?'تصاویر':'عکس‌ها'} ارزیابی کرد.`,`${bike?'دوچرخه‌سواران بهتر است شناسه بدنه':'مراجعان بهتر است شماره سریال دستگاه'} را در صورت موجود بودن همراه بیاورند.`],
      ar:[`${business.subject} تقدم ${bike?'إرشادات تمهيدية للإعداد':'إرشادات أولية'} فقط.`,`${business.subject} لا تحل تلقائياً محل ${bike?'فحص الدراجة':'الفحص في الورشة'}.`,`${bike?'لا يمكن تقييم عيوب الفرامل':'لا يمكن تقييم الأعطال الحرجة للسلامة'} من الصور.`,`${bike?'ينبغي لراكبي الدراجات إحضار معرف الهيكل':'ينبغي للزوار إحضار الرقم التسلسلي للجهاز'} إذا كان متاحاً.`],
     };
     expectedDocumentText=localized[language];
     return{text:JSON.stringify({units:sentences.map((quote,i)=>({facetIds:['f1'],subject:i===3?'Visitors':business.subject,predicate:['purpose','replacement limitation','assessment limitation','conditional preparation'][i],value:quote.trim(),modality:i===3?'recommended':'descriptive',negation:i===1||i===2,scope:'documentary offering only',qualifiers:i===3?['if one is available']:[],language,text:mode==='unsupported-binding'&&i===0?`${business.service.name} replaces a workshop inspection.`:localized[language][i],evidenceRefs:[{evidenceId:e.id,exactQuote:mode==='wrong-quote'&&i===0?'Invented source quotation.':quote.trim()}]}))})};
    }
    if(instruction.includes('BATCH ENTAILMENT')){
     stages.push('verification');payloads.push({stage:'verification',data});assert.equal(normalized(data.question),normalized(question));assert.equal(normalized(data.facets[0].obligations[0].description),normalized(question));assert.equal(data.units.length,['wrong-quote','unsupported-binding','stale-document','foreign-document'].includes(mode)?1:['changed-catalog','catalog-absent-false-complete'].includes(mode)?4:5);assert.ok(data.evidence.every((e:any)=>e.businessId===business.id));
     const catalog=data.evidence.find((e:any)=>e.id==='configured-services');if(mode==='changed-catalog'||mode==='catalog-absent-false-complete')assert.equal(catalog,undefined);else{assert.ok(catalog);assert.deepEqual(JSON.parse(catalog.text).services[0].name,business.service.name);}
     if(!['changed-catalog','catalog-absent-false-complete'].includes(mode))assert.equal(data.units[0].text,serviceFactText[language](business.service.name,business.service.price,business.service.currency,business.service.durationMinutes,2));
     for(const u of data.units){for(const ref of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===ref.evidenceId);assert.ok(e?.text.includes(ref.exactQuote));}}
     return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='unknown-document'&&u.id==='u5'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:!(mode==='irrelevant-supplement'&&u.id==='u5'),languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode!=='irrelevant-supplement',incompletenessReason:mode==='irrelevant-supplement'?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:data.units.filter((u:any)=>mode!=='irrelevant-supplement'||u.id!=='u5').map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:mode==='irrelevant-supplement'?'UNRESOLVED':'COVERED',unitIds:data.units.filter((u:any)=>mode!=='irrelevant-supplement'||u.id!=='u5').map((u:any)=>u.id)}]}]})};
    }
    stages.push('composition');payloads.push({stage:'composition',data});return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden});
  await incidentInbound(b,channel,question,recipient);
  measurements.push({businessId:business.id,channel,language,question,mode,stages,lookups,catalogReads,firstRetrievalMs,wallMs:performance.now()-started,replies,payloads,events});
  assert.equal(actions,0);assert.equal(replies.length,1);assert.ok(lookups>0);assert.ok(catalogReads>=2);if(mode==='paraphrase')assert.ok(stages.filter(s=>s==='planning').length<=1,'Existing literal or bounded semantic planning is permitted');else assert.equal(stages.filter(s=>s==='planning').length,before?1:0);assert.equal(stages.filter(s=>s==='extraction').length,mode==='foreign-document'?0:1);assert.equal(stages.filter(s=>s==='verification').length,1);
  if(!before&&['normal','paraphrase','non-equivalence','irrelevant-supplement','catalog-absent-false-complete','changed-catalog'].includes(mode)){
   assert.equal(stages.includes('composition'),false,'Verified single-facet facts need no ordering model');
   assert.ok(events.some(e=>e.stage==='composition'&&e.reason==='DIRECT_VERIFIED_UNITS'));
   assert.ok(!events.some(e=>e.stage==='composition'&&['DEADLINE','COMPOSER_FALLBACK'].includes(e.reason)));
  }
  const published=[...events].reverse().find(e=>e.stage==='publication');assert.ok(published,JSON.stringify(events));if(mode==='changed-catalog'||mode==='catalog-absent-false-complete')assert.doesNotMatch(replies[0],/145|25 minutes|999/);else assert.ok(replies[0].includes(serviceFactText[language](business.service.name,business.service.price,business.service.currency,business.service.durationMinutes,2)));
  if(mode==='irrelevant-supplement'){
   for(const text of expectedDocumentText.slice(0,3))assert.ok(replies[0].includes(text),`Verified requested fact lost: ${text}`);
   assert.ok(!replies[0].includes(expectedDocumentText[3]),'Unrelated preparation advice must not publish');
   assert.equal(published.route,'partial_manifest');assert.equal(published.publishableUnits,4);
   assert.ok(events.some(e=>e.stage==='verification'&&e.unitId==='u5'&&e.reason==='NOT_RELEVANT'));
   assert.ok(!events.some(e=>e.reason==='INVALID_COVERAGE'));
  }
  if(mode==='catalog-absent-false-complete'){
   for(const text of expectedDocumentText)assert.ok(replies[0].includes(text),'Verified documentary facts remain available');
   assert.equal(published.route,'partial_manifest','A false complete model verdict cannot replace missing catalog authority');
   assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'));
  }
  if(['normal','paraphrase','non-equivalence','changed-catalog'].includes(mode))for(const text of expectedDocumentText)assert.ok(replies[0].includes(text),`Material documentary proposition missing: ${text}`);
  if(mode==='non-equivalence'){assert.equal(published.route,'verified_manifest');assert.equal(replies[0].includes(serviceScopeUncertainty(business.service.name,language)!),false);}
  else {assert.equal(published.route,'partial_manifest');assert.ok(replies[0].includes(serviceScopeUncertainty(business.service.name,language)!), 'Requested service applicability must remain explicitly unresolved in every language');}
  if(['normal','paraphrase'].includes(mode))assert.ok(events.some(e=>e.reason==='SOURCE_SCOPE'));
  if(language==='en'&&!['irrelevant-supplement','catalog-absent-false-complete','non-equivalence','paraphrase'].includes(mode)){if(mode==='normal'||mode==='changed-catalog')assert.ok(replies[0].includes(business.source));else assert.doesNotMatch(replies[0],/initial orientation|Visitors should|automatically replace|Safety-critical/);// Catalog loss cannot erase the original relationship request: require the
   // precise unresolved-applicability notice, alongside existing price/route guards.
   assert.match(replies[0],/cannot confirm whether the document's information applies/);assert.equal(published.route,'partial_manifest');}
 }finally{Object.assign(incidentConfig,original);b.reset();}
});
