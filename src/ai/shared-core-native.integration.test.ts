import { normalizeConversationText } from './booking-intelligence';
import test,{beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import { Responses } from 'openai/resources/responses';
import { incidentFlags,incidentChannels,incidentConfig,incidentInbound,incidentSession,interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { sharedCorpus,sharedQuestions,assertSharedFacts } from '../../tests/helpers/shared-core-incident';
incidentFlags();process.env.OPENAI_API_KEY='synthetic-offline-only';process.env.ODINLINK_SHARED_PG='true';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpus=await sharedCorpus();after(()=>corpus.cleanup());
let language:keyof typeof sharedQuestions='sv',index=0,replies:string[]=[],revise=false,plannedRequests=0;
const texts={
 es:[['Para su primera visita, se recomienda llegar aproximadamente 10 minutos antes de su cita.','Se recomienda traer la confirmación de reserva, en formato digital o en papel.','Si ha recibido instrucciones especiales de preparación, debe seguirlas.'],['Video Consultation cuesta 300 SEK y dura 60 minutos.','Las sesiones informativas digitales se utilizan solo para información inicial. No sustituyen automáticamente una visita presencial y no todos los asuntos pueden tratarse digitalmente.'],['Si llega más de 15 minutos tarde, el personal puede necesitar evaluar de nuevo si la visita puede realizarse.','La visita no se cancela automáticamente; el personal debe evaluar primero la situación.','Si prevé llegar tarde, debería contactar con el estudio lo antes posible por su canal habitual.'],['Los objetos olvidados normalmente se guardan hasta 21 días.','Los objetos de valor se registran por separado.','Debe describir el objeto antes de que se le entregue.']],
 ar:[['في زيارتك الأولى، يُنصح بالوصول قبل موعدك بحوالي 10 دقائق.','يُنصح بإحضار تأكيد الحجز، رقميًا أو على ورق.','إذا تلقيت تعليمات خاصة للتحضير، فيجب عليك اتباعها.'],['سعر Video Consultation هو 300 SEK ومدته 60 دقيقة.','تُستخدم المكالمات المعلوماتية الرقمية للمعلومات الأولية فقط. ولا تحل تلقائيًا محل زيارة حضورية، ولا يمكن معالجة جميع الأمور رقميًا.'],['إذا تأخرت أكثر من 15 دقيقة، فقد يحتاج الموظفون إلى إعادة تقييم إمكانية إجراء الزيارة.','لا تُلغى الزيارة تلقائيًا؛ يجب على الموظفين تقييم الوضع أولًا.','إذا توقعت التأخر، يُنصح بالتواصل مع الاستوديو في أقرب وقت عبر قناة التواصل المعتادة.'],['تُحفظ الأغراض المنسية عادةً لمدة تصل إلى 21 يومًا.','يتم تسجيل الأغراض الثمينة بشكل منفصل.','يجب عليك وصف الغرض قبل تسليمه إليك.']],
 sv:[['Kom cirka 10 minuter före din bokade tid vid ditt första besök.','Ta gärna med bokningsbekräftelsen, digitalt eller på papper.','Följ särskilda förberedelseinstruktioner om du har fått sådana.'],['Video Consultation kostar 300 SEK och tar 60 minuter.','Digitala informationssamtal används endast för inledande information. De ersätter inte automatiskt ett fysiskt besök; alla ärenden kan inte hanteras digitalt.'],['Vid mer än 15 minuters försening kan personalen behöva bedöma om besöket kan genomföras.','Besöket avbokas inte automatiskt; personalen behöver först bedöma situationen.','Kontakta studion så snart som möjligt om du riskerar att komma för sent.'],['Kvarglömda föremål förvaras normalt i upp till 21 dagar.','Värdesaker registreras separat.','Du behöver beskriva föremålet innan det kan lämnas ut.']],
 en:[['For your first visit, you are advised to arrive approximately 10 minutes before your appointment.','You are advised to bring the booking confirmation, digitally or on paper.','If you have received special preparation instructions, you must follow them.'],['Video Consultation costs 300 SEK and lasts 60 minutes.','Digital information sessions are used only for initial information. They do not automatically replace an in-person visit; not every matter can be handled digitally.'],['If you are more than 15 minutes late, staff may need to reassess whether the visit can proceed.','The visit is not automatically cancelled; staff must assess the situation first.','Contact the studio promptly if you may be late.'],['Lost items are normally stored for up to 21 days.','Valuables are registered separately.','You must describe the item before collection.']],
 de:[['Bei Ihrem ersten Besuch sollten Sie ungefähr 10 Minuten vor Ihrem Termin kommen.','Sie sollten die Buchungsbestätigung digital oder auf Papier mitbringen.','Wenn Sie besondere Vorbereitungsanweisungen erhalten haben, müssen Sie diese befolgen.'],['Video Consultation kostet 300 SEK und dauert 60 Minuten.','Digitale Informationsgespräche dienen nur der einführenden Information. Sie ersetzen nicht automatisch einen Besuch vor Ort; nicht alle Anliegen können digital bearbeitet werden.'],['Bei mehr als 15 Minuten Verspätung kann das Personal erneut prüfen müssen, ob der Besuch stattfinden kann.','Der Besuch wird nicht automatisch abgesagt; das Personal muss zuerst die Situation beurteilen.','Melden Sie sich bei Verspätung möglichst umgehend beim Studio.'],['Fundsachen werden normalerweise bis zu 21 Tage aufbewahrt.','Wertsachen werden gesondert registriert.','Beschreiben Sie den Gegenstand vor der Abholung.']],
 fa:[['برای اولین مراجعه توصیه می‌شود حدود 10 دقیقه قبل از نوبت برسید.','توصیه می‌شود تأیید رزرو را به صورت دیجیتال یا روی کاغذ همراه بیاورید.','اگر دستورهای آماده‌سازی ویژه‌ای دریافت کرده‌اید، باید آن‌ها را رعایت کنید.'],['قیمت Video Consultation برابر 300 SEK و مدت آن 60 دقیقه است.','جلسات اطلاعاتی دیجیتال فقط برای اطلاعات اولیه هستند. این جلسات خودکار جایگزین مراجعه حضوری نمی‌شوند و همه موارد را نمی‌توان دیجیتال بررسی کرد.'],['در صورت بیش از 15 دقیقه تأخیر، ممکن است کارکنان نیاز داشته باشند امکان انجام مراجعه را دوباره بررسی کنند.','مراجعه به‌طور خودکار لغو نمی‌شود؛ کارکنان باید ابتدا وضعیت را ارزیابی کنند.','اگر احتمال تأخیر هست، سریع با استودیو تماس بگیرید.'],['وسایل جامانده معمولاً تا 21 روز نگهداری می‌شوند.','اشیای باارزش جداگانه ثبت می‌شوند.','باید وسیله را پیش از دریافت توصیف کنید.']],
} as const;
const quotes=[
 ['Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.','Ta gärna med din bokningsbekräftelse, digitalt eller på papper.','Om du har fått särskilda förberedelseinstruktioner inför ditt besök ska du följa dessa.'],
 ['', 'Digitala informationssamtal används endast för inledande information. De ersätter inte automatiskt ett fysiskt besök, och alla ärenden kan inte hanteras digitalt.'],
 ['Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.','Detta innebär inte att besöket automatiskt avbokas. Personalen behöver först bedöma situationen.','Om du riskerar att komma för sent bör du kontakta studion så snart som möjligt via den kontaktkanal där du vanligtvis kommunicerar med företaget.'],
 ['Kvarglömda föremål förvaras normalt i upp till 21 dagar .','Värdesaker registreras separat.','Kunden behöver beskriva föremålet innan det kan lämnas ut.'],
];
const norm=(s:string)=>s.replace(/\s+/gu,' ').trim();
beforeEach((t:any)=>{
 b.reset();replies=[];revise=false;plannedRequests=0;incidentConfig.services=[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true} as any];
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 t.mock.method(globalThis,'fetch',async(input,options)=>{replies.push(interceptedIncidentSend(input,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}]}),{status:200});});
 t.mock.method(Responses.prototype,'create',async(p:any)=>{
  const d=JSON.parse(p.input[0].content),instruction=p.instructions;
  const result=(x:any)=>({output_text:JSON.stringify(x),output:[]})as any;
  if(instruction.includes('Knowledge retrieval query planner')) {
   plannedRequests++;
   assert.equal(d.question,normalizeConversationText(sharedQuestions[language][index]),'Semantic planning must preserve the actual latest request');
   return result({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:d.question,referenceResolution:'NOT_REQUIRED',queries:[d.question.slice(0,120)],queryLanguages:[{query:d.question.slice(0,120),language}],requestedFacets:[{subject:'customer request',attribute:d.question,questionType:'description',obligations:[{description:d.question,questionType:'description'}]}]});
  }
  if(instruction.includes('source-language search query')) return result({query:['första besök tidigt bokningsbekräftelse förberedelser','digitala informationssamtal ersätta besök','försening 15 minuter automatiskt avbokat kontakta','kvarglömda värdesaker 21 dagar beskriva'][index]});
  if(instruction.includes('UNIT EXTRACTION')){
   const units=texts[language][index].flatMap((text,j)=>{
    const structured=index===1&&j===0,quote=structured?'':quotes[index][j];
    const evidence=d.evidence.find((e:any)=>structured?e.id==='configured-services':norm(e.text).includes(quote));
    if(structured&&!evidence?.text.includes('300'))return[];
    assert.ok(evidence,`canonical source must supply ${quote}`);
    return[{facetIds:d.facets.map((f:any)=>f.id),subject:structured?'Video Consultation':'source-specific visitor policy',predicate:'states',value:text,
     modality:index===0?(j===2?'required':'recommended'):index===3&&j===2?'required':'descriptive',negation:index===1&&j===1||index===2&&j===1,
     scope:'exact source conditions',qualifiers:[],language,text,evidenceRefs:[{evidenceId:evidence.id,exactQuote:structured?evidence.text:quote}]}];
   });return result({oversized:false,units});
  }
  if(instruction.includes('BATCH ENTAILMENT')){
   if(revise) incidentConfig.services=[{name:'Video Consultation',price:999,currency:'SEK',durationMinutes:90,active:true}as any];
   return result({decisions:d.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,explicitAbsenceEvidence:true,negativeAbsence:u.negation})),
    coverage:d.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:index!==1,incompletenessReason:index===1?'UNRESOLVED':'NONE',materialUnitIds:d.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:index===1?'UNRESOLVED':'COVERED',unitIds:d.units.map((u:any)=>u.id)}))}))});
  }
  if(instruction.includes('VERIFIED-UNIT PRESENTATION'))return result({unitIds:d.units.map((u:any)=>u.id),prefix:'none',addition:false});
  assert.fail('Self-contained incident question must not call unrestricted generation');
 });
 const forbidden=async()=>assert.fail('Knowledge cannot access booking/calendar/notifications');
 b.configure({semanticLanguageResolver:async()=>({language,confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  knowledgeServiceCatalog:async id=>id===77?incidentConfig.services:null,
  knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),semanticKnowledgeSearchQueries:async id=>corpus.service.search(id,sharedQuestions.sv[index],5),knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),
  validateKnowledgeMatches:(id,matches)=>corpus.service.validateMatches(id,matches,{strictSources:true,captureRevision:true}),
  calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden});
 for(const ch of incidentChannels)b.promptAuditHistory(incidentSession(b,ch,'46700000001'),[]);
});
afterEach(()=>b.reset());
test('Spanish lost-property question can use semantic planning without unrestricted generation',async()=>{
 language='es';index=3;await incidentInbound(b,'telegram',sharedQuestions.es[3]);
 assert.equal(plannedRequests,1);assert.equal(replies.length,1);assertSharedFacts(index,replies[0],language);
});
for(const lang of Object.keys(sharedQuestions)as(keyof typeof sharedQuestions)[])for(const channel of incidentChannels)for(let questionIndex=0;questionIndex<4;questionIndex++)test(`mocked model/semantic results, PostgreSQL lexical RPC: ${lang}/${channel}/${questionIndex}`,async()=>{
 language=lang;index=questionIndex;await incidentInbound(b,channel,sharedQuestions[language][index]);
 assert.equal(replies.length,1);assertSharedFacts(index,replies[0],language);
 assert.doesNotMatch(replies[0],/ingen specifik uppgift.*priser|no specific.*prices/iu);
});
test('a service revision between verification and send removes stale price/duration independently',async()=>{
 language='sv';index=1;revise=true;await incidentInbound(b,'telegram',sharedQuestions.sv[1]);assert.equal(replies.length,1);assert.doesNotMatch(replies[0],/300|60/);
});
test('explicitly absent structured service amounts are never supplied from old context',async()=>{
 language='sv';index=1;incidentConfig.services=[{name:'Video Consultation',active:true}as any];await incidentInbound(b,'telegram',sharedQuestions.sv[1]);assert.equal(replies.length,1);assert.doesNotMatch(replies[0],/300|60/);
});
test('Swedish prepositions cannot masquerade as English first-person pronouns',()=>{
 const text='AdMotion Studio lämnar föremål som hittas i studion till receptionen och förvarar kvarglömda föremål normalt i upp till 21 dagar.';
 assert.notEqual(b.detectStrongLanguage(text,incidentConfig),'en');
});
for(const lang of Object.keys(sharedQuestions)as(keyof typeof sharedQuestions)[])for(const channel of incidentChannels)test(`mocked ${lang}/${channel}: A→B→C→D preserves the latest question`,async()=>{
 language=lang;
 for(index=0;index<4;index++){
  replies=[];await incidentInbound(b,channel,sharedQuestions[language][index]);assert.equal(replies.length,1);assertSharedFacts(index,replies[0],language);
  assert.equal(b.businessInformationState(incidentSession(b,channel,'46700000001'))?.question,normalizeConversationText(sharedQuestions[language][index]));
 }
});
test('explicit late-arrival retest stays informational rather than cancellation execution',async()=>{
 language='sv';index=2;
 await incidentInbound(b,'telegram','Om jag kommer mer än 15 minuter för sent till AdMotion Studio, avbokas mitt besök automatiskt eller behöver personalen först bedöma situationen?');
 assert.equal(replies.length,1);assertSharedFacts(index,replies[0],language);
});
test('empty Persian lexical results get one bounded source-language lookup without inferred facts',async()=>{
 language='fa';index=0;
 b.configure({semanticLanguageResolver:async()=>({language,confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),semanticKnowledgeSearchQueries:async()=>[],knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),
  validateKnowledgeMatches:(id,matches)=>corpus.service.validateMatches(id,matches,{strictSources:true,captureRevision:true})});
 await incidentInbound(b,'telegram',sharedQuestions.fa[0]);assert.equal(replies.length,1);assertSharedFacts(index,replies[0],language);
});
test('German articles cannot masquerade as Swedish pronouns in a verified contact instruction',()=>{
 assert.equal(b.detectStrongLanguage('Wenn Sie voraussichtlich zu spät kommen, sollten Sie die AdMotion Studio so bald wie möglich über den Kommunikationskanal kontaktieren, über den Sie gewöhnlich mit dem Unternehmen kommunizieren.',incidentConfig),'de');
});
test('deleting the source before publication revokes all document facts',async()=>{
 language='sv';index=3;
 b.configure({semanticLanguageResolver:async()=>({language:'sv',confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  knowledgeSearch:(id,q,limit)=>corpus.service.search(id,q,limit),semanticKnowledgeSearchQueries:async id=>corpus.service.search(id,sharedQuestions.sv[3],5),
  validateKnowledgeMatches:async(id,matches)=>{await corpus.storage.delete(77,corpus.source.id);return corpus.service.validateMatches(id,matches,{strictSources:true,captureRevision:true});}});
 await incidentInbound(b,'telegram',sharedQuestions.sv[3]);assert.equal(replies.length,1);assert.doesNotMatch(replies[0],/21|registreras|beskriva/u);
});
