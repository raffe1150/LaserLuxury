import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isBusinessInformationQuestion,isExplicitBusinessActionRequest} from './business-information';
import {detectNormalizedIntent,normalizeConversationText} from './booking-intelligence';
import {isPassiveCancellationPolicyQuestion} from './information-request-contract';
import {prepareLiteralTurn} from './conversation-intent-continuity';
import {incidentFlags,incidentConfig,incidentChannels,incidentCorpus,incidentInbound,incidentSession,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';

const cases=[
 {language:'sv',question:'Hej! Jag har bokat en tid hos er, men jag kanske blir ungefär 20 minuter sen. Blir min tid automatiskt avbokad? Och var kan jag parkera bilen när jag kommer?',passive:'Blir min tid automatiskt avbokad?',context:'Jag har bokat en tid hos er. Var kan jag parkera?',facts:[
 'Enligt den fiktiva testinformationen bör du vid risk för försening kontakta studion så snart som möjligt via din vanliga kontaktkanal.',
 'Enligt den fiktiva testinformationen kan studion vid mer än 15 minuter försening behöva bedöma på nytt om besöket kan genomföras enligt plan.',
 'Enligt den fiktiva testinformationen avbokas besöket inte automatiskt; personalen behöver först bedöma situationen.',
 'Enligt den fiktiva testinformationen ligger Nordparks infart på Stjärngatan 14, ungefär fem minuters promenad från studions entré.',
 'Enligt den fiktiva testinformationen erbjuder studion inte gratis parkering och kan inte reservera parkeringsplatser.']},
 {language:'en',question:'I have an appointment, but I may arrive 20 minutes late. Will my appointment be automatically cancelled? And where can I park?',passive:'Will my booking be cancelled automatically?',context:'I have an appointment. Where can I park?',facts:[
 'According to the fictional test information, if you may arrive late, you should contact the studio as soon as possible through your usual channel.',
 'According to the fictional test information, with more than 15 minutes of delay the studio may need to reassess whether the visit can proceed as planned.',
 'According to the fictional test information, the visit is not automatically cancelled; staff must first assess the situation.',
 'According to the fictional test information, the Nordpark entrance is at Stjärngatan 14, approximately a five-minute walk from the studio entrance.',
 'According to the fictional test information, the studio does not offer free parking and cannot reserve parking spaces.']},
 {language:'de',question:'Ich habe einen Termin, aber ich komme vielleicht 20 Minuten zu spät. Wird mein Termin automatisch storniert? Und wo kann ich parken?',passive:'Wird mein Termin automatisch storniert?',context:'Ich habe einen Termin. Wo kann ich parken?',facts:[
 'Laut den fiktiven Testinformationen sollten Sie bei drohender Verspätung das Studio möglichst bald über Ihren üblichen Kontaktkanal informieren.',
 'Laut den fiktiven Testinformationen kann das Studio bei mehr als 15 Minuten Verspätung erneut prüfen müssen, ob der Besuch wie geplant stattfinden kann.',
 'Laut den fiktiven Testinformationen wird der Besuch nicht automatisch storniert; das Personal muss zuerst die Situation beurteilen.',
 'Laut den fiktiven Testinformationen liegt die Einfahrt von Nordpark an Stjärngatan 14, ungefähr fünf Gehminuten vom Studioeingang entfernt.',
 'Laut den fiktiven Testinformationen bietet das Studio keine kostenlosen Parkplätze an und kann keine Parkplätze reservieren.']},
 {language:'es',question:'Tengo una cita, pero quizá llegue 20 minutos tarde. ¿La cancelan automáticamente? ¿Y dónde puedo aparcar?',passive:'¿Se cancela automáticamente mi cita?',context:'Tengo una cita. ¿Dónde puedo aparcar?',facts:[
 'Según la información ficticia de prueba, si prevés llegar tarde deberías contactar al estudio cuanto antes por tu canal habitual.',
 'Según la información ficticia de prueba, con más de 15 minutos de retraso el estudio puede necesitar evaluar de nuevo si la visita puede realizarse según lo previsto.',
 'Según la información ficticia de prueba, la visita no se cancela automáticamente; el personal debe evaluar primero la situación.',
 'Según la información ficticia de prueba, la entrada de Nordpark está en Stjärngatan 14, a unos cinco minutos a pie de la entrada del estudio.',
 'Según la información ficticia de prueba, el estudio no ofrece aparcamiento gratuito ni puede reservar plazas.']},
 {language:'fa',question:'من نوبت دارم ولی شاید 20 دقیقه دیر برسم. آیا نوبت من خودکار لغو می‌شود؟ کجا می‌توانم پارک کنم؟',passive:'آیا نوبت من خودکار لغو می‌شود؟',context:'من نوبت دارم. کجا می‌توانم پارک کنم؟',facts:[
 'طبق اطلاعات آزمایشی، اگر احتمال می‌دهید دیر برسید، توصیه می‌شود هرچه زودتر از طریق کانال معمول خود با استودیو تماس بگیرید.',
 'طبق اطلاعات آزمایشی، با بیش از 15 دقیقه تأخیر ممکن است استودیو نیاز داشته باشد امکان انجام بازدید طبق برنامه را دوباره بررسی کند.',
 'طبق اطلاعات آزمایشی، بازدید خودکار لغو نمی‌شود؛ کارکنان باید ابتدا وضعیت را بررسی کنند.',
 'طبق اطلاعات آزمایشی، ورودی پارکینگ Nordpark در Stjärngatan 14 است و ورودی استودیو حدود پنج دقیقه پیاده فاصله دارد.',
 'طبق اطلاعات آزمایشی، استودیو پارکینگ رایگان ارائه نمی‌کند و نمی‌تواند جای پارک رزرو کند.']},
 {language:'ar',question:'لدي موعد لكن قد أتأخر 20 دقيقة. هل سيتم إلغاء موعدي تلقائيا؟ وأين يمكنني ركن السيارة؟',passive:'هل سيتم إلغاء موعدي تلقائيا؟',context:'لدي موعد. أين موقف السيارات؟',facts:[
 'وفق معلومات الاختبار الخيالية، إذا توقعت التأخر فيُنصح بالتواصل مع الاستوديو بأسرع وقت عبر قناة التواصل المعتادة.',
 'وفق معلومات الاختبار الخيالية، عند التأخر أكثر من 15 دقيقة قد يحتاج الاستوديو إلى إعادة تقييم إمكانية إجراء الزيارة كما هو مخطط.',
 'وفق معلومات الاختبار الخيالية، لا تُلغى الزيارة تلقائيا؛ يجب أن يقيّم الموظفون الوضع أولا.',
 'وفق معلومات الاختبار الخيالية، مدخل موقف Nordpark في Stjärngatan 14 ويبعد نحو خمس دقائق سيرا عن مدخل الاستوديو.',
 'وفق معلومات الاختبار الخيالية، لا يوفر الاستوديو مواقف مجانية ولا يمكنه حجز أماكن للسيارات.']},
];
const quotes=[/Om du riskerar[^]+?med företaget\./u,/Vid en försening[^]+?enligt plan\./u,/Detta innebär[^]+?bedöma situationen\./u,/Garagets infart[^]+?studions entré\./u,/AdMotion Studio erbjuder inte gratis[^.]+\./u];
for(const row of cases)test(`passive policy classifier ${row.language}`,()=>{
 for(const text of [row.question,row.passive,row.context]){
  assert.equal(isBusinessInformationQuestion(text),true,text);
  assert.equal(isExplicitBusinessActionRequest(text),false,text);
  assert.equal(detectNormalizedIntent(text),'general_question',text);
  const p=prepareLiteralTurn(text,c=>isExplicitBusinessActionRequest(c)||(!isBusinessInformationQuestion(c)&&['cancellation','reschedule'].includes(detectNormalizedIntent(c))));
  assert.equal(p.kind,'single',text);assert.equal(p.clauses[0].text,text);
 }
});
incidentFlags();Object.assign(process.env,{OPENAI_API_KEY:'synthetic-offline',ODINLINK_KNOWLEDGE_MODEL_PROFILE:'off',
 ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3',
 ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await incidentCorpus(false,3);
const audited=JSON.parse(readFileSync('tests/fixtures/cancellation-business3-audited-20261101.json','utf8'));
const txt=audited.sources.find((s:any)=>s.title==='odinlink-test.txt');
const prior=(await corpus.storage.list(3)).find(s=>s.id==='incident-txt')!;
await corpus.storage.create({...prior,content:txt.content,metadata:{segments:[{start:0,end:txt.content.length,section:'Text'}]}});
await corpus.storage.replaceChunks(3,prior.id,[{chunkIndex:0,content:txt.content,metadata:{source:'document',section:'Text'}}]);
for(const row of cases)for(const channel of incidentChannels)for(const overlap of row.language==='sv'?[false,true]:[false])test(`native passive policy ${channel}/${row.language}/${overlap?'overlapping':'single'}: complete verified answer`,async t=>{
 b.reset();const saved={...incidentConfig};const replies:string[]=[],events:any[]=[],stages:string[]=[];let reads=0,actions=0,scriptError:unknown;
 const forbidden=async()=>{actions++;throw Error('UNAUTHORIZED_ACTION');};
 let entered!:()=>void,release!:()=>void,held=false;
 const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 for(const name of ['log','info','warn','error'] as const)t.mock.method(console,name,()=>{});
 t.mock.method(globalThis,'fetch',async(input,options)=>{replies.push(interceptedIncidentSend(input,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}));});
 try{
  Object.assign(incidentConfig,{id:3,businessId:3,language:row.language,allowCancellation:true,allowRescheduling:true});
  b.configure({offlineAi:true,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
   semanticLanguageResolver:async()=>({language:row.language,confidence:1}),
   knowledgeCancellationConfig:async()=>({id:3,allow_cancellation:true}),
   knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),semanticKnowledgeSearchQueries:async()=>[],knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),
   completeKnowledgeCorpus:async(id,m,options,mode)=>{const all=await corpus.service.completeSmallCorpus(id,m,options,mode);reads++;assert.equal(all?.length,6);return all;},
   validateKnowledgeMatches:(id,m)=>corpus.service.validateMatches(id,m,{strictSources:true,captureRevision:true,requireCompleteDocumentContext:true}),
   calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
   recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden,evidenceFirstDecisionDiagnostic:e=>events.push(e),
   aiGenerate:async r=>{try{
    assert.deepEqual(r.tools,[]);const d=JSON.parse(r.messages[0].content),instruction=r.systemInstruction;
    assert.equal(d.question,normalizeConversationText(row.question),'Entire compound question survives existing punctuation normalization');
    if(row.language==='sv')assert.equal(d.question,row.question,'Exact production question remains byte-identical');
    if(instruction.includes('retrieval query planner'))return{text:JSON.stringify({canonicalMeaning:d.question,queries:[d.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'visitor policy',attribute:d.question,questionType:'description',obligations:[{description:d.question,questionType:'description'}]}]}),functionCalls:[]};
    assert.ok(d.evidence.every((e:any)=>e.businessId===3));assert.equal(new Set(d.evidence.map((e:any)=>e.sourceGroup||e.sourceId)).size,2);
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');
     if(overlap&&!held){held=true;entered();await hold;}
     const qualification=d.evidence.find((e:any)=>/Observera: All information/.test(e.text));assert.ok(qualification);
     return{text:JSON.stringify({oversized:false,units:row.facts.map((text,i)=>{
      const e=d.evidence.find((e:any)=>quotes[i].test(e.text));assert.ok(e,String(quotes[i]));
      const refs=[{evidenceId:e.id,exactQuote:e.text.match(quotes[i])[0]},{evidenceId:qualification.id,exactQuote:qualification.text.match(/Observera: All information[^]+?verkliga kundvillkor\./u)[0]}];
      return{facetIds:['f1'],subject:'documented visitor policy',predicate:'states',value:text,text,modality:i===0?'recommended':'descriptive',negation:i===2||i===4,scope:'fictional test visit information',qualifiers:[],language:row.language,evidenceRefs:refs};
     })}),functionCalls:[]};
    }
    assert.match(instruction,/BATCH ENTAILMENT/);stages.push('verification');assert.equal(d.units.length,5,JSON.stringify(events));
    return{text:JSON.stringify({decisions:d.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
     coverage:d.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:d.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:d.units.map((u:any)=>u.id)}))})),
     sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:true,conditionsPreserved:true,conflictsAbsent:true,evidenceIdsReviewed:d.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:d.units.map((u:any)=>u.id),obligations:d.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:'COMPLETE'})))}}),functionCalls:[]};
   }catch(error){scriptError=error;throw error;}}});
  assert.equal(b.inspectNativeKnowledgeAdmissionForTest(channel,row.question,incidentConfig),true);
  if(overlap){
   const first=incidentInbound(b,channel,row.question);await started;
   const second=incidentInbound(b,channel,row.question);
   await new Promise<void>(r=>setImmediate(r));release();await Promise.all([first,second]);
  }else await incidentInbound(b,channel,row.question);
  assert.equal(scriptError,undefined);assert.equal(actions,0);assert.ok(reads>0);
  if(overlap){assert.ok(replies.length>=1&&replies.length<=2);assert.equal(stages.filter(s=>s==='extraction').length,2);}
  else {assert.equal(replies.length,1);assert.deepEqual(stages,['extraction','verification'],JSON.stringify({replies,events}));}
  for(const reply of replies)for(const text of row.facts)assert.ok(reply.includes(text),JSON.stringify({reply,events}));
  assert.equal(events.filter(e=>e.stage==='publication').at(-1)?.route,'verified_manifest');
  const id=incidentSession(b,channel,'46700000001');assert.equal(b.pendingStateSnapshot(id),null);assert.equal(b.cancellationState(id),null);
  t.diagnostic(JSON.stringify({channel,language:row.language,sourceChunks:6,responses:replies.length,actions,route:'verified_manifest',judgments:'SCRIPTED'}));
 }finally{release?.();Object.assign(incidentConfig,saved);delete(incidentConfig as any).allowCancellation;delete(incidentConfig as any).allowRescheduling;b.reset();}
});

// Existing owned state must survive an information detour without advancing
// consent or reading Calendar. These are shared-engine state controls; the
// complete-answer matrix above separately enters all four real adapters.
for(const row of cases)for(const channel of incidentChannels)for(const operation of ['cancellation','reschedule'] as const)
test(`owned ${operation} survives passive policy ${channel}/${row.language}`,async t=>{
 b.reset();for(const name of ['log','info','warn','error'] as const)t.mock.method(console,name,()=>{});
 let actions=0;const forbidden=async()=>{actions++;throw Error('No appointment authority');};
 const config={...incidentConfig,id:3,businessId:3,language:row.language,allowCancellation:true,allowRescheduling:true};
 const id=`owned-${channel}-${row.language}-${operation}`,user='46700000001';
 b.configure({offlineAi:true,semanticLanguageResolver:async()=>({language:row.language,confidence:1}),postProcess:async()=>{},
  calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden,
  knowledgeSearch:()=>[],semanticKnowledgeSearchQueries:async()=>[],knowledgeSourceLanguages:async()=>[]});
 b.seedOwnedAppointment({sessionId:id,platform:channel,userId:user,businessConfig:config,operation,
  appointment:{id:'owned-synthetic',business_id:3,service:'Video Consultation',start_time:'2026-12-01T10:00:00Z',end_time:'2026-12-01T11:00:00Z'},
  ...(operation==='reschedule'?{selectedNewStartTime:'2026-12-02T10:00:00Z'}:{})});
 const before=b.appointmentOperationState(id),consent=b.cancellationState(id);
 try{
  const result=await b.turn({sessionId:id,platformName:channel,recipientUserId:user,text:row.question,businessConfig:config});
  assert.equal(result.handled,false);assert.equal(actions,0);assert.equal(result.replies.length,0);
  assert.equal(b.businessInformationState(id)?.question,normalizeConversationText(row.question));
  assert.deepEqual(b.appointmentOperationState(id),before);
  const after=b.cancellationState(id);
  assert.deepEqual(after&&{...after,language:consent?.language},consent);
 }finally{b.reset();}
});

for(const row of cases)for(const channel of incidentChannels)test(`context statement is not lookup ${channel}/${row.language}`,async t=>{
 b.reset();for(const name of ['log','info','warn','error'] as const)t.mock.method(console,name,()=>{});
 let actions=0;const forbidden=async()=>{actions++;throw Error('Context is not lookup authority');};
 const config={...incidentConfig,id:3,businessId:3,language:row.language};
 b.configure({offlineAi:true,postProcess:async()=>{},semanticLanguageResolver:async()=>({language:row.language,confidence:1}),
  calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden},recordAppointment:forbidden,
  knowledgeSearch:()=>[],semanticKnowledgeSearchQueries:async()=>[],knowledgeSourceLanguages:async()=>[]});
 try{const id=`context-${channel}-${row.language}`;
  const result=await b.turn({sessionId:id,platformName:channel,recipientUserId:'46700000001',text:row.context,businessConfig:config});
  assert.equal(result.handled,false);assert.equal(actions,0);assert.equal(result.replies.length,0);
  assert.equal(b.businessInformationState(id)?.question,normalizeConversationText(row.context));
 }finally{b.reset();}
});

const hypothetical=[
 'If I arrive late, will my appointment be cancelled?',
 'Om jag blir sen, blir min tid avbokad?',
 'Wenn ich zu spät komme, wird mein Termin storniert?',
 'Si llego tarde, ¿se cancela mi cita?',
 'اگر دیر برسم، آیا نوبت من لغو می‌شود؟',
 'إذا تأخرت، هل سيتم إلغاء موعدي؟',
];
for(const text of hypothetical)test(`hypothetical passive question: ${text}`,()=>{
 assert.equal(isPassiveCancellationPolicyQuestion(text),true);assert.equal(isBusinessInformationQuestion(text),true);
 assert.equal(detectNormalizedIntent(text),'general_question');assert.equal(prepareLiteralTurn(text).kind,'single');
});
for(const text of [
 'Was my appointment automatically cancelled?', 'Är min tid redan avbokad?',
 'Wurde mein Termin automatisch storniert?', '¿Mi cita ya fue cancelada automáticamente?',
 'آیا نوبت من خودکار لغو شده؟','هل تم إلغاء موعدي تلقائيا؟',
])test(`completed status is not passive policy: ${text}`,()=>assert.equal(isPassiveCancellationPolicyQuestion(text),false));
for(const text of [
 'Please cancel my booking.', 'Jag vill avboka min tid.', 'Bitte stornieren Sie meinen Termin.',
 'Quiero cancelar mi cita.', 'لطفاً نوبتم را لغو کنید.', 'أريد إلغاء موعدي.',
])test(`actual cancellation survives hypothetical sibling: ${text}`,()=>{
 const combined=`Will my booking be automatically cancelled? ${text}`;
 assert.equal(isBusinessInformationQuestion(combined),false);assert.equal(prepareLiteralTurn(combined).kind,'mixed');
});
