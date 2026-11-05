import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { deterministicLocationPlan } from './knowledge-planning';
import { knowledgeSourceRevision } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { configuredCancellationEvidence } from './configured-cancellation-evidence';
import { nativeKnowledgeTiming, knowledgeAdmission } from './knowledge-timing-policy';
import { configureKnowledgeBudgetOwner } from './knowledge-model-policy';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, incidentChannels, incidentCorpus } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3,77',
  ODINLINK_KNOWLEDGE_VERIFICATION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const audited=JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json',import.meta.url),'utf8'));
const specs=[
 ['en','What is your cancellation policy, and how far in advance do I need to cancel my appointment?',
  'Automatic appointment cancellation through chat is enabled.','The optional late cancellation fee is disabled.','required advance notice',
  'What is your cancellation policy, and how far in advance do I need to cancel my appointment if I arrive late?','Please cancel my appointment.','Please reschedule my appointment.'],
 ['sv','Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
  'Automatisk avbokning av tider via chatt är aktiverad.','Den valfria avgiften för sen avbokning är inaktiverad.','hur långt i förväg',
  'Vad är er avbokningspolicy och hur långt i förväg måste jag avboka min tid om jag kommer sent till besöket?','Jag vill avboka min tid.','Jag vill flytta min tid.'],
 ['de','Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
  'Die automatische Terminabsage per Chat ist aktiviert.','Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.','Vorankündigungsfrist',
  'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren, wenn ich zu spät komme?','Bitte stornieren Sie meinen Termin.','Bitte verschieben Sie meinen Termin.'],
 ['es','¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
  'La cancelación automática de citas por chat está habilitada.','El cargo opcional por cancelación tardía está desactivado.','con cuánta antelación',
  '¿Cuál es su política de cancelación y cuántas horas antes debo cancelar si llego tarde a mi cita?','Quiero cancelar mi cita.','Quiero reprogramar mi cita.'],
 ['fa','سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
  'لغو خودکار نوبت از طریق چت فعال است.','هزینه اختیاری لغو دیرهنگام غیرفعال است.','چه مدت قبل',
  'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم اگر دیر به نوبت برسم؟','لطفاً نوبتم را لغو کنید.','لطفاً وقت من را تغییر دهید.'],
 ['ar','ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
  'إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.','رسوم الإلغاء المتأخر الاختيارية معطّلة.','الإشعار المسبق',
  'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز إذا تأخرت في الوصول؟','أريد إلغاء موعدي.','أريد تغيير موعدي.'],
];
type Mode='valid'|'snapshot-change'|'extraction-change'|'verification-change'|'publication-change'|'publication-document-change'|'revert'|'epoch'|'missing'|'malformed'|'foreign'|'db-error'|'timeout'|'abort'|'conflict'|'forged'|'cross-citation'|'normalized-only'|'superseded';
const records:any[]=[];
let serial=0;
let corpusPromise:ReturnType<typeof incidentCorpus>|undefined;
const localDocumentCorpus=()=>corpusPromise ||= incidentCorpus(false,77);
function useLocalRetrieval(f:ReturnType<typeof setup>,service:Awaited<ReturnType<typeof incidentCorpus>>['service']){
 f.dependencies.knowledgeSearch=async(id:number,q:string,limit:number)=>{const matches=await service.search(id,q,limit);f.retrieval.push({q,matches:matches.map(m=>({sourceId:m.sourceId,gate:m.text.includes('Aurora 7'),lost:m.text.includes('Föremål som hittas')}))});return matches;};
 f.dependencies.knowledgeSourceLanguages=async(id:number)=>{const hints=await service.sourceLanguageHints(id);f.retrieval.push({sourceLanguages:hints});return hints;};
 f.dependencies.completeKnowledgeCorpus=(id:number,m:any[])=>service.completeSmallCorpus(id,m);
 f.dependencies.semanticKnowledgeSearchQueries=(id:number,q:string[],limit:number,options:any)=>service.semanticSearchQueries(id,q,limit,options);
 f.dependencies.validateKnowledgeMatches=(id:number,m:any[])=>service.validateMatches(id,m,{strictSources:true,captureRevision:true});
}
function quiet(t:any){for(const key of ['log','info','warn','error'])t.mock.method(console,key,()=>{});}
const facets=[{subject:'cancellation settings',attribute:'chat capability and optional late fee',questionType:'description'},
 {subject:'cancellation policy',attribute:'mandatory advance notice',questionType:'requirement'}];
function setup(spec=specs[0],mode:Mode='valid',tenant=3){
 let row:any={...audited.business,id:tenant},reads=0,actions=0,legacyReads=0,changeDuringDocuments=false;
 const config=b.promptAuditNormalize(row),expected=configuredCancellationEvidence(tenant,config)!;
 const matches=audited.sources.map((s:any)=>({businessId:tenant,sourceId:s.id,text:s.content,score:1,
  metadata:{source:'document',documentRevision:'audited-fixture-v1'}}));
 const stages:string[]=[],inputs:any[]=[],decisions:any[]=[],publications:any[]=[],retrieval:any[]=[];
 const change=()=>{row={...row,allow_cancellation:false};};
 const forbidden=async()=>{actions++;throw Error('OFFLINE_MUTATION_FORBIDDEN');};
 const dependencies:any={offlineAi:true,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  semanticLanguageResolver:async()=>({language:spec[0],confidence:1}),
  loadCancellationConfig:async()=>{legacyReads++;throw Error('Merged cancellation reader is not native citation authority');},
  knowledgeCancellationConfig:async(id:number,signal:AbortSignal)=>{
   reads++;assert.equal(id,tenant);assert.ok(signal instanceof AbortSignal);signal.throwIfAborted();
   if(mode==='missing')return null;
   if(mode==='malformed')return {id:tenant,allow_cancellation:'true',cancellation_fee_enabled:'false'};
   if(mode==='normalized-only')return {id:tenant,allowCancellation:true,cancellationFeeEnabled:false,cancellationSettingsEvidence:config.cancellationSettingsEvidence};
   if(mode==='foreign')return {...row,id:tenant+1};
   if(mode==='db-error')throw Error('simulated database failure');
   if(mode==='timeout')throw new DOMException('simulated database deadline','TimeoutError');
   if(mode==='abort'){nativeKnowledgeTiming()!.fail();signal.throwIfAborted();}
   return structuredClone(row);
  },
  knowledgeSearch:async()=>matches,semanticKnowledgeSearch:async()=>[],semanticKnowledgeSearchQueries:async()=>[],
  completeKnowledgeCorpus:async()=>null,knowledgeSourceLanguages:async()=>['sv'],
  validateKnowledgeMatches:async(id:number,m:any[])=>{assert.equal(id,tenant);if(changeDuringDocuments){changeDuringDocuments=false;change();}return m;},
  knowledgeServiceCatalog:async()=>config.services,
  evidenceFirstDecisionDiagnostic:(d:any)=>decisions.push(d),
  evidenceFirstPublicationDiagnostic:(d:any)=>{publications.push(d);if(d.phase==='publication_start'){
   if(mode==='publication-change')change();if(mode==='publication-document-change')changeDuringDocuments=true;}},
  aiGenerate:async(request:any)=>{
   const instruction=request.systemInstruction,data=JSON.parse(request.messages[0].content);
   if(instruction.includes('retrieval query planner'))return {text:JSON.stringify({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:data.question,
    referenceResolution:'NOT_REQUIRED',queries:[],requestedFacets:facets})};
   if(instruction.startsWith('OdinLink source-language search query.'))return{text:JSON.stringify({query:'avbokningspolicy'})};
   assert.ok(instruction.includes('UNIT EXTRACTION')||instruction.includes('BATCH ENTAILMENT'),'No legacy/free prose/provider fallback');
   assert.deepEqual(request.tools,[]);const stage=instruction.includes('UNIT EXTRACTION')?'extraction':'verification';stages.push(stage);inputs.push({stage,data});
   const e=data.evidence.find((e:any)=>e.id===expected.id);assert.ok(e);assert.equal(e.businessId,tenant);assert.equal(e.text,expected.text);
   assert.ok(!e.text.includes('1440'));const statements=JSON.parse(e.text).statements;
   if(stage==='extraction'){
    if(mode==='extraction-change')change();
    return {text:JSON.stringify({oversized:false,units:[spec[2],spec[3]].map((text,i)=>({facetIds:['f1'],subject:'configured cancellation',predicate:'setting',value:text,
     modality:'descriptive',negation:i===1,scope:'chat automation and this optional late fee only',qualifiers:[],language:spec[0],text,
     evidenceRefs:[{evidenceId:mode==='cross-citation'?`configured-cancellation:${tenant+1}`:e.id,
      ...(!instruction.includes('literal-evidence-v1')||mode==='forged'?{exactQuote:mode==='forged'?'Cancellation is always free.':statements[i]}:{})}]}))})};
   }
   if(mode==='verification-change')change();
   const requestAligned=data.facets.some((f:any)=>f.obligations.some((o:any)=>o.questionType==='requirement'));
   return {text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='conflict'?'CONTRADICTED':'ENTAILED',
    meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:u.negation,explicitAbsenceEvidence:u.negation})),
    coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned,materialFactsComplete:requestAligned&&f.id==='f1',incompletenessReason:requestAligned&&f.id==='f1'?'NONE':'UNRESOLVED',
     materialUnitIds:f.id==='f1'?data.units.map((u:any)=>u.id):[],obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:f.id==='f1'?'COVERED':'UNRESOLVED',unitIds:f.id==='f1'?data.units.map((u:any)=>u.id):[]}))}))})};
  },calendarAdapter:{getCalendarId:()=> 'offline',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
  recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden};
 if(mode==='conflict')matches.push({businessId:tenant,sourceId:'conflicting-policy',text:'The optional late cancellation fee is enabled.',score:1,metadata:{source:'document',documentRevision:'conflict-v1'}});
 return {config,expected,matches,dependencies,stages,inputs,decisions,publications,retrieval,change,setRow:(next:any)=>{row=next;},
  stats:()=>({reads,actions,legacyReads})};
}

for(const spec of specs)for(const channel of incidentChannels)test(`native admitted server boundary/${spec[0]}/${channel}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup(spec);b.configure(f.dependencies);let final:any;
 await b.nativeKnowledgeEvidenceRequest({sessionId:`native-wiring-${++serial}`,businessConfig:f.config,question:spec[1],language:spec[0],facets,matches:f.matches,channel},async api=>{
  const snap:any=api.snapshot();assert.ok(Object.isFrozen(snap));assert.ok(Object.isFrozen(snap.evidence));
  assert.deepEqual(snap.evidence.find((e:any)=>e.id===f.expected.id),f.expected);
  assert.equal(snap.matches.length,f.matches.length);assert.deepEqual(snap.evidence.filter((e:any)=>e.id!==f.expected.id).map((e:any)=>e.text),f.matches.map((m:any)=>m.text));
  const response=await api.generate();const beforePublication=f.stats().reads;final=await api.publish(response.text);
  assert.equal(f.stats().reads-beforePublication,1,'Final publication performs one fresh settings read, not two');
  assert.ok(final?.includes(spec[2]));assert.ok(final?.includes(spec[3]));assert.ok(final?.includes(spec[4]));
  const m=api.manifest()!;assert.equal(m.outcomes[1].obligations[0].status,'UNRESOLVED');assert.equal(m.facets[1].questionType,'requirement');
  assert.deepEqual(m.outcomes[1].obligations[0].unitIds,[]);assert.equal(m.units.length,2);
  for(const u of m.units)assert.equal(u.evidenceRefs[0].version,f.expected.version);
  if(spec[0]==='en'&&channel==='whatsapp')records.push({kind:'SCRIPTED_SERVER_BOUNDARY_NOT_PROVIDER_VALIDATION',question:spec[1],final,manifest:m,stats:f.stats()});
 });
 assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.stats().actions,0);assert.equal(f.stats().legacyReads,0);
 assert.equal(f.stats().reads,4,'Fresh evidence phases and final publication read settings; identity-only guards do not');b.reset();
});

for(const mode of ['snapshot-change','extraction-change','verification-change','publication-change','publication-document-change','revert','epoch','missing','malformed','foreign','db-error','timeout','abort','conflict','forged','cross-citation','normalized-only','superseded'] as Mode[])
test(`native wiring rejects changed/unavailable/unsafe evidence/${mode}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup(specs[0],mode);b.configure(f.dependencies);let final:any,after:any;
 await b.nativeKnowledgeEvidenceRequest({sessionId:'native-adversarial',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  if(mode==='snapshot-change'||mode==='revert'){f.change();assert.deepEqual(await api.refresh(),[]);if(mode==='revert'){
   f.setRow({...audited.business});assert.deepEqual(await api.refresh(),[],'Changed and restored settings cannot revive authority');}}
  if(mode==='epoch')b.cancellationPolicyUpdated(f.config);
  const result=await api.generate();
  if(mode==='superseded')await b.securedRequest('native-adversarial',async()=>{});
  final=await api.publish(result.text);after=api.manifest();
  assert.equal(final===null||!final.includes(specs[0][2]),true,'Changed, unavailable or unsafe settings cannot publish the captured facts');
  if(mode==='conflict')assert.ok(f.inputs.find(x=>x.stage==='verification').data.evidence.some((e:any)=>e.text.includes('fee is enabled')));
 });
 assert.equal(f.stats().actions,0);assert.equal(f.stats().legacyReads,0);
 if(['snapshot-change','epoch','missing','malformed','foreign','db-error','timeout','abort','normalized-only'].includes(mode))assert.equal(f.stages.length,0);
 if(['forged','cross-citation'].includes(mode)){
  assert.deepEqual(f.stages,['extraction']);assert.equal(f.decisions.some(d=>d.reason==='INVALID_CITATION'),true,'Forged citations must reach and fail the real citation parser');
 }
 if(mode==='extraction-change')assert.deepEqual(f.stages,['extraction']);
 if(['verification-change','publication-change','publication-document-change','conflict','superseded'].includes(mode))assert.deepEqual(f.stages,['extraction','verification']);
 b.reset();
});

test('raw database path selects only necessary columns, exact tenant, original ownership and cancellation signal',{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup();let queries=0;delete f.dependencies.knowledgeCancellationConfig;
 f.dependencies.supabaseClient={from:(table:string)=>{assert.equal(table,'businesses');const q:any={select:(cols:string)=>{
  assert.equal(cols,'id,allow_cancellation,cancellation_deadline_minutes,cancellation_fee_enabled,cancellation_fee_amount,cancellation_fee_currency');return q;},
  eq:(key:string,id:number)=>{assert.equal(key,'id');assert.equal(id,3);return q;},abortSignal:(s:AbortSignal)=>{assert.ok(s instanceof AbortSignal);assert.equal(s.aborted,false);return q;},
  maybeSingle:async()=>{queries++;return {data:{...audited.business,allowCancellation:false,cancellationSettingsEvidence:{invented:true}},error:null};}};return q;}};
 b.configure(f.dependencies);
 await b.nativeKnowledgeEvidenceRequest({sessionId:'raw-read',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const generated=await api.generate();assert.ok((await api.publish(generated.text))?.includes(specs[0][2]));
 });
 assert.equal(queries,4);b.reset();
});

for(const spec of specs)for(const text of [spec[6],spec[7],`${spec[1]} ${spec[6]}`,`${spec[7]} ${spec[1]}`])
test(`operational/mixed request gets no configuration evidence/${spec[0]}/${text}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup(spec);b.configure(f.dependencies);
 await b.nativeKnowledgeEvidenceRequest({sessionId:`action-${++serial}`,businessConfig:f.config,question:text,language:spec[0],facets},async api=>{
  assert.equal((api.snapshot() as any).evidence.some((e:any)=>e.id===f.expected.id),false);
  const generated=await api.generate();const published=await api.publish(generated.text);
  assert.ok(published===null||!published.includes(spec[2]));
 });assert.equal(f.stats().reads,0);assert.equal(f.stats().actions,0);b.reset();
});

test('missing initial fields and normalized defaults never become snapshot authority',{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup();b.configure(f.dependencies);
 for(const raw of [{id:3},{id:3,allow_cancellation:null,cancellation_fee_enabled:null},{id:3,allow_cancellation:'true',cancellation_fee_enabled:'false'}]){
  await b.nativeKnowledgeEvidenceRequest({sessionId:`missing-initial-${++serial}`,businessConfig:b.promptAuditNormalize(raw),question:specs[0][1],language:'en',facets},async api=>{
   assert.equal((api.snapshot() as any).evidence.some((e:any)=>e.id.startsWith('configured-cancellation:')),false);
  });
 }assert.equal(f.stats().reads,0);b.reset();
});

for(const mode of ['superseded','epoch'] as const)test(`in-flight raw read cannot commit after ownership/epoch changes/${mode}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup();let entered!:()=>void,release!:(value:unknown)=>void,readCount=0;
 const started=new Promise<void>(r=>{entered=r;});let final:any;
 f.dependencies.knowledgeCancellationConfig=async()=>{readCount++;entered();return new Promise(r=>{release=r;});};b.configure(f.dependencies);
 const running=b.nativeKnowledgeEvidenceRequest({sessionId:'in-flight-owner',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const result=await api.generate();final=await api.publish(result.text);assert.deepEqual(await api.refresh(),[]);
 });
 await started;
 if(mode==='superseded')await b.securedRequest('in-flight-owner',async()=>{});else b.cancellationPolicyUpdated(f.config);
 release({...audited.business});await running;
 assert.ok(final===null||!final.includes(specs[0][2]));assert.equal(readCount,1);assert.equal(f.stages.length,0);b.reset();
});

test('operation deadline aborts a slow raw read; late completion cannot restore evidence',{timeout:5000},async t=>{
 quiet(t);b.reset();t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const f=setup();
 let release!:(value:unknown)=>void,signal:AbortSignal|undefined,final:any,started=false;
 f.dependencies.knowledgeCancellationConfig=async(_id:number,s:AbortSignal)=>{signal=s;started=true;return new Promise(r=>{release=r;});};b.configure(f.dependencies);
 const running=b.nativeKnowledgeEvidenceRequest({sessionId:'slow-raw-read',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const result=await api.generate();final=await api.publish(result.text);assert.deepEqual(await api.refresh(),[]);
 });
 const flush=async()=>{for(let i=0;i<200;i++)await Promise.resolve();};await flush();assert.equal(started,true);
 t.mock.timers.tick(35000);await flush();await running;assert.equal(signal?.aborted,true);
 release({...audited.business});await flush();assert.ok(final===undefined||final===null||!final.includes(specs[0][2]));
 assert.equal(f.stages.length,0);assert.equal(knowledgeAdmission().snapshot().active,0,'Settled late read releases its native queue slot');
 assert.equal(knowledgeAdmission().snapshot().waiting,0);b.reset();
});

test('real raw-read timeout withdraws evidence and releases native admission',{timeout:8000},async t=>{
 quiet(t);b.reset();const f=setup();let signal:AbortSignal|undefined,reads=0;
 f.dependencies.knowledgeCancellationConfig=async(_id:number,s:AbortSignal)=>{signal=s;reads++;
  return new Promise((_resolve,reject)=>{s.throwIfAborted();s.addEventListener('abort',()=>reject(s.reason),{once:true});});};
 b.configure(f.dependencies);
 await b.nativeKnowledgeEvidenceRequest({sessionId:'raw-read-timeout',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const generated=await api.generate();const final=await api.publish(generated.text);
  assert.equal(final===null||!final.includes(specs[0][2]),true,'Timed-out settings cannot publish facts');
  assert.deepEqual(await api.refresh(),[],'Timeout withdrawal is permanent');
 });
 assert.equal(signal?.aborted,true);assert.equal(signal?.reason?.name,'TimeoutError');assert.equal(reads,1);
 assert.deepEqual(f.stages,[]);assert.equal(knowledgeAdmission().snapshot().active,0);assert.equal(knowledgeAdmission().snapshot().waiting,0);b.reset();
});

test('native test host propagates assertion failures and releases admission',{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup();b.configure(f.dependencies);
 await assert.rejects(b.nativeKnowledgeEvidenceRequest({sessionId:'assertion-cleanup',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},
  async()=>{assert.equal(false,true,'Deliberate host propagation diagnostic');}),{code:'ERR_ASSERTION',message:/Deliberate host propagation diagnostic/});
 assert.equal(knowledgeAdmission().snapshot().active,0);assert.equal(knowledgeAdmission().snapshot().waiting,0);b.reset();
});

test('ordinary documentary and configured-service snapshot inventories remain unchanged',{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup();b.configure(f.dependencies);
 for(const question of ['Where is the studio entrance?','What does Video Consultation cost, how long does it last, and where is the studio entrance?']){
  const config={...f.config,services:[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60}]};
  await b.nativeKnowledgeEvidenceRequest({sessionId:`ordinary-${++serial}`,businessConfig:config,question,language:'en',facets,matches:f.matches},async api=>{
   const snapshot:any=api.snapshot();assert.equal(snapshot.evidence.some((e:any)=>e.id===f.expected.id),false);
   assert.deepEqual(snapshot.evidence.filter((e:any)=>e.id!=='configured-services').map((e:any)=>e.text),f.matches.map((m:any)=>m.text));
   if(question.includes('cost'))assert.ok(snapshot.evidence.some((e:any)=>e.id==='configured-services'));
  });
 }assert.equal(f.stats().reads,0);b.reset();
});

test('accuracy-first cancellation route wires the bridge through real channel adapters',{timeout:5000},async t=>{
 quiet(t);b.reset();const original={...incidentConfig};let sends=0;let active=specs[0];const allStats:any[]=[],outbound:any[]=[],forbiddenUrls:string[]=[];
 try{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
   if(/openai|gemini|supabase/iu.test(String(url))){forbiddenUrls.push(String(url));throw Error('OFFLINE_EXTERNAL_PROVIDER_OR_DATABASE_FORBIDDEN');}sends++;
   const answer=interceptedIncidentSend(url,options);outbound.push({language:active[0],answer});
   return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}],message_id:'offline'}));
  });
  for(const spec of specs){active=spec;const f=setup(spec,'valid',77);
   const dispatched:string[]=[];const originalGenerate=f.dependencies.aiGenerate;delete f.dependencies.semanticLanguageResolver;
   f.dependencies.aiGenerate=async(r:any)=>{
    assert.equal(r.signal instanceof AbortSignal,true,'Native owner supplies every model signal');
    if(r.systemInstruction.includes('language-routing classifier')){dispatched.push('language');return{text:JSON.stringify({language:spec[0],requestedReplyLanguage:null,confidence:1})};}
    const stage=r.systemInstruction.includes('retrieval query planner')?'planning':r.systemInstruction.includes('UNIT EXTRACTION')?'extraction':r.systemInstruction.includes('BATCH ENTAILMENT')?'verification':'source_query';
    dispatched.push(stage);return originalGenerate(r);
   };
   Object.assign(incidentConfig,audited.business,{id:77,businessRecordId:77,business_id:77,businessId:77,language:spec[0],
    cancellationSettingsEvidence:f.config.cancellationSettingsEvidence,allowCancellation:true,cancellationDeadlineMinutes:1440,
    cancellationFeeEnabled:false,cancellationFeeAmount:0,cancellationFeeCurrency:'SEK'});
   assert.equal(b.inspectWhatsAppTimingForTest('offline',spec[1],incidentConfig).admitted,true);
   assert.equal(b.inspectWhatsAppTimingForTest('offline',spec[5],incidentConfig).admitted,true,`${spec[0]} existing arrival route`);
   // Real local lexical/chunk/currentness interfaces; no embedding provider.
   useLocalRetrieval(f,(await localDocumentCorpus()).service);
   for(const channel of incidentChannels){b.reset();b.configure(f.dependencies);const before=outbound.length,callStart=dispatched.length,readStart=f.stats().reads,started=performance.now();await incidentInbound(b,channel,spec[1]);
    assert.equal(outbound.length-before,1,`${spec[0]}/${channel}: one captured channel answer`);
    const answer=outbound.at(-1).answer;
    records.push({kind:'MOCK_REAL_CHANNEL_CANCELLATION',language:spec[0],channel,question:spec[1],answer,calls:dispatched.slice(callStart),rawReads:f.stats().reads-readStart,wallMs:performance.now()-started});
    assert.equal(dispatched.length-callStart<=5,true,'One language attempt plus at most four information-budget attempts');
    for(const text of [spec[2],spec[3],spec[4]])assert.equal(answer.includes(text),true,`${spec[0]}/${channel}: expected fact or unresolved notice: ${answer}`);
   }
   assert.equal(f.stats().actions,0);assert.equal(f.stats().legacyReads,0);allStats.push({language:spec[0],...f.stats(),stages:f.stages,decisions:f.decisions,publications:f.publications});
  }
  assert.equal(sends,24,JSON.stringify(allStats));assert.deepEqual(forbiddenUrls,[]);
 }finally{Object.assign(incidentConfig,original);b.reset();}
});

for(const mode of ['omitted-facts','recovered-u2'] as const)for(const channel of incidentChannels)
test(`P0 planner timeout and extraction recovery/${mode}/${channel}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const saved=structuredClone(incidentConfig),f=setup(specs[0],'valid',77),answers:string[]=[],calls:string[]=[];
 const generate=f.dependencies.aiGenerate;
 useLocalRetrieval(f,(await localDocumentCorpus()).service);
 f.dependencies.aiGenerate=async(r:any)=>{
  if(r.systemInstruction.includes('retrieval query planner')){calls.push('planning-timeout');throw new DOMException('scripted planner deadline','TimeoutError');}
  if(r.systemInstruction.includes('UNIT EXTRACTION')){
   calls.push('extraction');assert.match(r.systemInstruction,/literal-evidence-v1/);
   const data=JSON.parse(r.messages[0].content),e=data.evidence.find((e:any)=>e.text.includes('Fullständiga avbokningsvillkor'));
   assert.ok(e,'Actual document chunk, including the noncontiguous list, reaches extraction');
   assert.match(e.text,/Priser på studions tjänster[\s\S]*Fullständiga avbokningsvillkor/u);
   const config=data.evidence.find((e:any)=>e.id===f.expected.id);
   return{text:JSON.stringify({oversized:false,units:mode==='omitted-facts'?[]:[{
    facetIds:['f1'],subject:"AdMotion Studio's business configuration",predicate:'has the optional late cancellation fee',value:'disabled',
    modality:'descriptive',negation:false,scope:'business configuration',
    qualifiers:['This configuration covers the optional late fee only; other fees and mandatory advance notice are outside this source.'],language:'en',
    text:"AdMotion Studio's business configuration has the optional late cancellation fee disabled; this source does not specify any mandatory advance-notice period.",
    evidenceRefs:[{evidenceId:config.id}]},{
    facetIds:['f1'],subject:'the supplied customer-information document',predicate:'contains information about full cancellation terms',
    value:'no',modality:'descriptive',negation:true,scope:'the supplied document',qualifiers:[],language:'en',
    text:'The supplied customer-information document does not contain the full cancellation terms.',evidenceRefs:[{evidenceId:e.id}]}]})};
  }
  if(r.systemInstruction.includes('BATCH ENTAILMENT')){
   calls.push('verification');const data=JSON.parse(r.messages[0].content);
   assert.deepEqual(data.facets.map((x:any)=>x.questionType),['description','requirement']);
   assert.equal(data.units.length,mode==='omitted-facts'?2:4,'Original proposals survive and canonical facts remain proposals for the independent verifier');
   if(mode==='recovered-u2'){
    const u=data.units[1],e=data.evidence.find((e:any)=>e.id===u.evidenceRefs[0].evidenceId);
    assert.equal(u.evidenceRefs[0].exactQuote,e.text,'Backend binds literal source, never stitches a quote');
   }
  }
  return generate(r);
 };
 try{
  Object.assign(incidentConfig,audited.business,{id:77,businessId:77,businessRecordId:77,business_id:77,language:'en',cancellationSettingsEvidence:f.config.cancellationSettingsEvidence});
  t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
  b.configure(f.dependencies);await incidentInbound(b,channel,specs[0][1]);
  assert.equal(answers.length,1);for(const required of specs[0].slice(2,5))assert.ok(answers[0].includes(required),answers[0]);
  assert.doesNotMatch(answers[0],/cannot verify an answer|24 hours|always free/);
  assert.deepEqual(calls,['planning-timeout','extraction','verification']);assert.equal(f.stats().actions,0);assert.equal(f.stats().legacyReads,0);
  records.push({kind:'SCRIPTED_P0_RECOVERY_NOT_PROVIDER_ACCEPTANCE',mode,channel,answer:answers[0],calls});
 }finally{for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();}
});

for(const approved of [false,true])test(`P0 scoped transport preserves managed Sol routing/approved=${approved}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const saved=structuredClone(incidentConfig),savedEnv={...process.env},f=setup(specs[0],'valid',77),answers:string[]=[],stages:string[]=[];
 const generate=f.dependencies.aiGenerate;
 useLocalRetrieval(f,(await localDocumentCorpus()).service);
 Object.assign(process.env,{ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77'});
 configureKnowledgeBudgetOwner(approved?new ScriptedKnowledgeBudgetOwner():undefined);
 f.dependencies.aiGenerate=async(r:any)=>{
  if(r.systemInstruction.includes('UNIT EXTRACTION')||r.systemInstruction.includes('BATCH ENTAILMENT')){
   stages.push(r.systemInstruction.includes('UNIT EXTRACTION')?'extraction':'verification');
   assert.equal(r.model,'gpt-6.1-sol');assert.ok(r.knowledgeExecution);assert.doesNotMatch(r.systemInstruction,/literal-evidence-v1/);
   assert.equal(r.structuredOutput.name,stages.at(-1)==='extraction'?'odinlink_knowledge_extraction_v2':'odinlink_knowledge_verification_v2');
  }
  return generate(r);
 };
 try{
  Object.assign(incidentConfig,audited.business,{id:77,businessId:77,businessRecordId:77,business_id:77,language:'en',cancellationSettingsEvidence:f.config.cancellationSettingsEvidence});
  t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1}}));});
  b.configure(f.dependencies);await incidentInbound(b,'telegram',specs[0][1]);
  assert.equal(answers.length,1);assert.deepEqual(stages,approved?['extraction','verification']:[],'No implicit demotion to Luna or bypass of the managed profile');
  assert.equal(answers[0].includes(specs[0][2]),approved);assert.equal(f.stats().actions,0);
 }finally{
  configureKnowledgeBudgetOwner();for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);
  for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();
 }
});


const operationalControls=[
 ['Do I already have an appointment?','Cancel?','Cancel it?'],['Har jag en bokning?','Avboka?','Avboka den?'],
 ['Habe ich einen Termin?','Stornieren?','Kann ich das stornieren?'],['¿Tengo una cita?','¿Cancelar?','¿Puedo cancelarlo?'],
 ['آیا وقت دارم؟','لغو؟','آن را لغو کنم؟'],['هل لدي حجز قادم؟','إلغاء؟','هل يمكن إلغاء ذلك؟'],
];
for(const [i,spec] of specs.entries())test(`release admission preserves action, lookup, mixed and ambiguous boundaries/${spec[0]}`,{timeout:5000},()=>{
 b.reset();const f=setup(spec);const admitted=(q:string,c=f.config)=>b.inspectWhatsAppTimingForTest('offline',q,c).admitted;
 assert.equal(admitted(spec[1]),true,'Exact policy question is admitted for existing accuracy-first tenant');
 for(const channel of incidentChannels)assert.equal(b.inspectNativeKnowledgeAdmissionForTest(channel,spec[1],f.config),true);
 assert.equal(b.inspectNativeKnowledgeAdmissionForTest(undefined,spec[1],f.config),false,'No new web/generic-server admission without a native channel owner');
 for(const q of [spec[6],spec[7],...operationalControls[i],`${spec[1]} ${spec[6]}`,`${spec[7]} ${spec[1]}`,`${spec[1]} ${spec[6]} ${spec[7]}`])
  assert.equal(admitted(q),false,`No native cancellation admission for operational/ambiguous request: ${q}`);
 assert.equal(admitted(spec[1],{...f.config,id:88,businessRecordId:88,businessId:88,business_id:88}),false,'No enrollment by customer wording');
 b.reset();
});

test('self-contained location plan retains reference admission for existing source-language fallback',{timeout:5000},()=>{
 for(const q of ['Wo werden Fundsachen aufbewahrt?','وسایل جامانده کجا نگهداری می‌شوند؟'])assert.equal(deterministicLocationPlan(q,true)?.referenceResolution,'NOT_REQUIRED');
 for(const q of ['Where is it?','Wo ist das?','آن کجاست؟'])assert.equal(deterministicLocationPlan(q,true),null,'References still require semantic resolution');
});

const gateControls=[
 ['Which gate should I use to enter the studio?','Use the gate marked Aurora 7 and follow the blue signs to reception on the second floor.',
  'Where are lost items kept?','Lost items are kept at reception.'],
 ['Vilken port ska jag använda för att komma in i studion?','Använd porten märkt Aurora 7 och följ de blå skyltarna till receptionen på andra våningen.',
  'Var förvaras kvarglömda föremål?','Kvarglömda föremål förvaras i receptionen.'],
 ['Welchen Eingang soll ich für das Studio benutzen?','Benutzen Sie das Tor mit der Aufschrift Aurora 7 und folgen Sie den blauen Schildern zur Rezeption im zweiten Stock.',
  'Wo werden Fundsachen aufbewahrt?','Fundsachen werden an der Rezeption aufbewahrt.'],
 ['¿Qué entrada debo usar para entrar al estudio?','Usa la puerta marcada Aurora 7 y sigue las señales azules hasta la recepción en la segunda planta.',
  '¿Dónde se guardan los objetos perdidos?','Los objetos perdidos se guardan en recepción.'],
 ['برای ورود به استودیو از کدام ورودی استفاده کنم؟','از درِ دارای نشان Aurora 7 وارد شوید و تابلوهای آبی را تا پذیرش در طبقه دوم دنبال کنید.',
  'وسایل جامانده کجا نگهداری می‌شوند؟','وسایل جامانده در پذیرش نگهداری می‌شوند.'],
 ['أي مدخل يجب أن أستخدم لدخول الاستوديو؟','استخدم البوابة التي تحمل علامة Aurora 7 واتبع اللافتات الزرقاء إلى الاستقبال في الطابق الثاني.',
  'أين تُحفظ الأغراض المفقودة؟','تُحفظ الأغراض المفقودة في الاستقبال.'],
];
for(const [index,spec] of specs.entries())for(const channel of incidentChannels)for(const control of [0,1])
test(`release documentary control/${spec[0]}/${channel}/${control}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const saved=structuredClone(incidentConfig),f=setup(spec,'valid',77),answers:string[]=[],calls:string[]=[];let rawReads=0;
 const question=gateControls[index][control*2],answer=gateControls[index][control*2+1];
 const source=audited.sources[1].content as string;
 useLocalRetrieval(f,(await localDocumentCorpus()).service);
 const quote=control===0?'Besökare ska använda porten märkt   Aurora 7   och därefter följa de blå skyltarna till receptionen på andra våningen.':
  'Föremål som hittas i studion lämnas till receptionen.';
 assert.equal(source.includes(quote),true);
 f.dependencies.knowledgeCancellationConfig=async()=>{rawReads++;throw Error('No cancellation config on a document control');};
 f.dependencies.aiGenerate=async(r:any)=>{
  const instruction=r.systemInstruction,data=JSON.parse(r.messages[0].content);
  if(instruction.includes('retrieval query planner')){calls.push('planning');return{text:JSON.stringify({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:question,
   referenceResolution:'NOT_REQUIRED',queries:[],requestedFacets:[{subject:'studio visitors',attribute:question,questionType:'description'}]})};}
  if(instruction.startsWith('OdinLink source-language search query.')){calls.push('source_query');return{text:JSON.stringify({query:control?'kvarglömda föremål':'porten Aurora 7'})};}
  if(instruction.includes('UNIT EXTRACTION')){calls.push('extraction');const pattern=control===0?/Besökare ska använda porten märkt\s+Aurora 7\s+och därefter följa de blå skyltarna till receptionen på andra våningen\./u:/Föremål som hittas i studion lämnas till receptionen\./u;
   const e=data.evidence.find((e:any)=>pattern.test(e.text));assert.equal(!!e,true,'Real document evidence reaches extractor');const exact=pattern.exec(e.text)![0];
   assert.equal(data.evidence.some((e:any)=>e.id.startsWith('configured-cancellation:')),false);assert.equal(e.businessId,77);
   return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'studio visitors',predicate:'documented visitor information',value:answer,modality:control?'descriptive':'required',
    negation:false,scope:'documented visitors',qualifiers:[],language:spec[0],text:answer,evidenceRefs:[{evidenceId:e.id,exactQuote:exact}]}]})};}
  assert.equal(instruction.includes('BATCH ENTAILMENT'),true,'No legacy prose or unexpected generation');calls.push('verification');
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,
   qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((f:any)=>({facetId:f.id,
   requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),
   obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))})};
 };
 try{
  Object.assign(incidentConfig,audited.business,{id:77,businessId:77,businessRecordId:77,business_id:77,language:spec[0],cancellationSettingsEvidence:f.config.cancellationSettingsEvidence});
  t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
  b.configure(f.dependencies);const started=performance.now();await incidentInbound(b,channel,question);
  assert.deepEqual(answers,[answer],JSON.stringify({calls,decisions:f.decisions.map((d:any)=>({stage:d.stage,reason:d.reason})),retrieval:f.retrieval}));assert.equal(rawReads,0);assert.equal(f.stats().actions,0);
  assert.equal(calls.filter(x=>x==='extraction').length,1);assert.equal(calls.filter(x=>x==='verification').length,1);
  records.push({kind:'MOCK_REAL_CHANNEL_DOCUMENT_CONTROL',language:spec[0],channel,question,answer,calls,wallMs:performance.now()-started});
 }finally{for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();}
});

for(const kind of ['mandatory-24-hours','universal-free'] as const)test(`release rejects unsupported scope/${kind}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup(),generate=f.dependencies.aiGenerate;
 const bad=kind==='mandatory-24-hours'?'You must cancel at least 24 hours before the appointment.':'All cancellations are always free.';
 f.dependencies.aiGenerate=async(r:any)=>{
  const response=await generate(r);
  if(r.systemInstruction.includes('UNIT EXTRACTION')){const body=JSON.parse(response.text);body.units[0].text=bad;body.units[0].value=bad;return{text:JSON.stringify(body)};}
  if(r.systemInstruction.includes('BATCH ENTAILMENT')){const body=JSON.parse(response.text);body.decisions[0].relation='UNKNOWN';return{text:JSON.stringify(body)};}
  return response;
 };b.configure(f.dependencies);
 await b.nativeKnowledgeEvidenceRequest({sessionId:`scope-${kind}`,businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const generated=await api.generate(),final=await api.publish(generated.text);assert.equal(final?.includes(bad)||false,false);
  assert.equal(api.manifest()?.units.some(u=>u.text===bad)||false,false);
 });assert.equal(f.stats().actions,0);b.reset();
});

for(const mode of ['slow-success','late-extraction','late-verification','provider-failure'] as const)
test(`release native operation deadline and provider lifecycle/${mode}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const f=setup(),generate=f.dependencies.aiGenerate;let now=Date.now(),sent=0;const start=now;const stages:string[]=[];
 t.mock.method(Date,'now',()=>now);
 f.dependencies.aiGenerate=async(r:any)=>{
  const stage=r.systemInstruction.includes('UNIT EXTRACTION')?'extraction':'verification';stages.push(stage);
  if(stage==='extraction')now+=mode==='late-extraction'?21000:12000;
  if(stage==='verification')now+=mode==='late-verification'?21000:8000;
  if(mode==='provider-failure')throw Object.assign(Error('offline simulated unavailable'),{status:503});
  return generate(r);
 };b.configure(f.dependencies);
 await b.nativeKnowledgeEvidenceRequest({sessionId:`deadline-${mode}`,businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const generated=await api.generate(),final=await api.publish(generated.text);if(final)sent++;
  assert.equal(final?.includes(specs[0][2])||false,mode==='slow-success');
 });
 assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(stages.filter(s=>s==='verification').length,['late-extraction','provider-failure'].includes(mode)?0:1);
 assert.equal(knowledgeAdmission().snapshot().active,0);assert.equal(f.stats().actions,0);
 records.push({kind:'VIRTUAL_TIME_PROVIDER_LIFECYCLE',mode,stages,elapsedMs:now-start,sent});b.reset();
});

test('late uncooperative provider cannot publish or release live-work admission early',{timeout:5000},async t=>{
 quiet(t);b.reset();t.mock.timers.enable({apis:['Date','setTimeout'],now:2000000});const f=setup(),generate=f.dependencies.aiGenerate;
 let release!:(value:any)=>void,signal:AbortSignal|undefined,final:string|null|undefined,started=false;
 f.dependencies.aiGenerate=async(r:any)=>{if(r.systemInstruction.includes('UNIT EXTRACTION')){signal=r.signal;started=true;return new Promise(resolve=>{release=resolve;});}return generate(r);};b.configure(f.dependencies);
 const running=b.nativeKnowledgeEvidenceRequest({sessionId:'uncooperative-provider',businessConfig:f.config,question:specs[0][1],language:'en',facets,matches:f.matches},async api=>{
  const result=await api.generate();final=await api.publish(result.text);
 });
 const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};await flush();assert.equal(started,true);
 t.mock.timers.tick(21000);await flush();assert.equal(signal?.aborted,true);assert.equal(knowledgeAdmission().snapshot().active,1,'A timed-out live provider still owns capacity');
 t.mock.timers.tick(14000);await flush();await running;
 assert.equal(final?.includes(specs[0][2])||false,false);assert.equal(knowledgeAdmission().snapshot().active,1);
 release({text:'A late unsupported provider answer.'});await flush();
 assert.equal(knowledgeAdmission().snapshot().active,0);assert.equal(knowledgeAdmission().snapshot().waiting,0);
 assert.equal(final?.includes(specs[0][2])||false,false);assert.equal(f.stats().actions,0);b.reset();
});

for(const channel of incidentChannels)test(`planner cannot escape native cancellation budget/${channel}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const saved=structuredClone(incidentConfig),f=setup(specs[0],'valid',77),answers:string[]=[],calls:string[]=[];
 const generate=f.dependencies.aiGenerate;
 f.dependencies.aiGenerate=async(r:any)=>{if(r.systemInstruction.includes('retrieval query planner')){calls.push('planning');return{text:JSON.stringify({requestKind:'GENERAL_CONVERSATION',canonicalMeaning:specs[0][1],queries:[],referenceResolution:'NOT_REQUIRED',requestedFacets:[]})};}
  calls.push('unexpected');return generate(r);};
 f.dependencies.loadCancellationConfig=async()=>({...audited.business,id:77});
 try{
  Object.assign(incidentConfig,audited.business,{id:77,businessId:77,businessRecordId:77,business_id:77,language:'en',cancellationSettingsEvidence:f.config.cancellationSettingsEvidence});
  t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
  b.configure(f.dependencies);await incidentInbound(b,channel,specs[0][1]);
  assert.deepEqual(calls,['planning'],'GENERAL_CONVERSATION may not dispatch legacy generation or repair');assert.equal(answers.length,1);
  assert.equal(answers[0].includes(specs[0][2]),false);assert.equal(f.stats().actions,0);
 }finally{for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();}
});


// SCRIPTED spatial regressions isolated from the separate documentary audit.
// Complete recall is supplied; the actual native freshness/publication gates run.
for(const index of [3,4])for(const channel of incidentChannels)
for(const mode of ['complete-original','complete-original-unsupported-policy'] as const)
test(`spatial full-PDF/${specs[index][0]}/${channel}/${mode}`,{timeout:5000},async t=>{
 quiet(t);b.reset();const spec=specs[index],saved=structuredClone(incidentConfig),f=setup(spec,'valid',77);
 const savedVerifier=process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL;
 process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL='source-exhaustive-v2';
 const question=gateControls[index][0],originalAnswer=gateControls[index][1],answers:string[]=[],calls:string[]=[];
 const unsupportedPolicy=mode==='complete-original-unsupported-policy';
 const answer=(spec[0]==='es'?'Según este documento ficticio de prueba: ':'طبق این سند تخیلی آزمایشی: ')+originalAnswer+
  (unsupportedPolicy?(spec[0]==='es'?' Debes cancelar como máximo 21 horas antes de la cita.':' لغو نوبت باید حداکثر ۲۱ ساعت قبل از نوبت انجام شود.'):'');
 const corpus=await localDocumentCorpus(),pdf=(await corpus.storage.list(77)).find(s=>s.id==='incident-pdf')!;
 const segments=pdf.metadata.segments;if(!Array.isArray(segments))throw Error('Original PDF fixture requires canonical segments');
 const canonical=documentChunks(segments.map(({start,end,...provenance}:any)=>({text:pdf.content.slice(start,end),...provenance})),pdf.title);
 const matches=canonical.chunks.map(c=>({businessId:77,sourceId:pdf.id,text:String(c.content),score:1,
  metadata:{...(c.metadata as any),documentRevision:knowledgeSourceRevision(pdf)}}));
 assert.equal(matches.length,5);
 useLocalRetrieval(f,corpus.service);
 f.dependencies.knowledgeSearch=async()=>matches;
 f.dependencies.validateKnowledgeMatches=async(id:number,m:any[])=>{
  const current=await corpus.service.validateMatches(id,m,{strictSources:true,captureRevision:true,requireCompleteDocumentContext:true});
  assert.equal(current.length,5);return current;
 };
 f.dependencies.knowledgeCancellationConfig=async()=>{throw Error('No cancellation config on a document control');};
 let verifierSchema:string|undefined;
 f.dependencies.aiGenerate=async(r:any)=>{
  const instruction=r.systemInstruction,data=JSON.parse(r.messages[0].content);
  if(instruction.includes('retrieval query planner')){calls.push('planning');return{text:JSON.stringify({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:question,
   referenceResolution:'NOT_REQUIRED',queries:[],requestedFacets:[{subject:'studio visitors',attribute:question,questionType:'description'}]})};}
  if(instruction.startsWith('OdinLink source-language search query.'))return{text:JSON.stringify({query:'porten Aurora 7'})};
  if(instruction.includes('UNIT EXTRACTION')){
   calls.push('extraction');assert.equal(data.evidence.length,5);assert.ok(data.evidence.every((e:any)=>e.businessId===77));
   const pattern=/Besökare ska använda porten märkt\s+Aurora 7\s+och därefter följa de blå skyltarna till receptionen på andra våningen\./u;
   const e=data.evidence.find((e:any)=>pattern.test(e.text));assert.ok(e);
   return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'studio visitors',predicate:'documented visitor information',value:answer,modality:'required',
    negation:false,scope:'documented visitors',qualifiers:[],language:spec[0],text:answer,evidenceRefs:[{evidenceId:e.id,exactQuote:pattern.exec(e.text)![0]}]}]})};
  }
  assert.ok(instruction.includes('BATCH ENTAILMENT'));calls.push('verification');verifierSchema=r.structuredOutput?.name;
  assert.equal(data.evidence.length,5);
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,
   qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((f:any)=>({facetId:f.id,
   requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),
   obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))})),
   sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:true,conditionsPreserved:true,conflictsAbsent:true,
    evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:data.units.map((u:any)=>u.id),
    obligations:data.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:'COMPLETE'})))}})};
 };
 try{
  Object.assign(incidentConfig,audited.business,{id:77,businessId:77,businessRecordId:77,business_id:77,language:spec[0],cancellationSettingsEvidence:f.config.cancellationSettingsEvidence});
  t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
  b.configure(f.dependencies);await incidentInbound(b,channel,question);
  assert.equal(f.stats().actions,0);assert.equal(f.stats().reads,0);assert.equal(answers.length,1);
  records.push({kind:unsupportedPolicy?'SCRIPTED_COMPLETE_SOURCE_UNSUPPORTED_POLICY':'SCRIPTED_COMPLETE_SOURCE_ORIGINAL_WORDING',language:spec[0],channel,
   question,originalAnswer,answer:answers,calls,verifierSchema,actions:f.stats().actions,sourceId:pdf.id,revision:knowledgeSourceRevision(pdf),canonicalChunks:matches.length});
  if(unsupportedPolicy){
   assert.equal(answers[0].includes(originalAnswer),false);assert.ok(f.decisions.some((d:any)=>d.reason==='NUMERICAL_CONSTRAINT'));
   assert.equal(calls.filter(x=>x==='verification').length,0);
  }else{
   assert.deepEqual(answers,[answer]);assert.equal(calls.filter(x=>x==='extraction').length,1);assert.equal(calls.filter(x=>x==='verification').length,1);
   assert.equal(verifierSchema,'odinlink_knowledge_source_exhaustive_v2');
  }
 }finally{
  for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();
  if(savedVerifier===undefined)delete process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL;else process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL=savedVerifier;
 }
});

test('write simulated receipts only when explicitly requested',{timeout:5000},()=>{
 if(process.env.ODINLINK_NATIVE_CANCELLATION_WIRING_RECEIPT)writeFileSync(process.env.ODINLINK_NATIVE_CANCELLATION_WIRING_RECEIPT,
  JSON.stringify({providerCalls:0,realCustomerMessages:0,bookingWrites:0,records},null,2)+'\n',{flag:'wx'});
});
