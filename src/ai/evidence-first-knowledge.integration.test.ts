import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { normalizeConversationText } from './booking-intelligence';
import { withBusinessInformationTiming, beginBusinessInformationTiming } from './business-information-timing';
import { NATURAL_FLAGS } from './grounded-knowledge-composition';
import { performance } from 'node:perf_hooks';
import { naturalLocationCases } from '../../tests/fixtures/knowledge-natural-location';
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'synthetic-offline-only';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['telegram', 'instagram', 'whatsapp', 'messenger'] as const;
type Channel = typeof channels[number];
const q = {
 policy: 'Kan jag komma utan att boka tid i förväg?', paraphrase: 'Behöver jag boka i förväg för att besöka er?',
 parking: 'Hej! Finns det parkering i närheten av er studio?',
 detour: 'Tack! Innan jag väljer en tid, kan du berätta om det finns parkering nära studion?',
 intro: 'Innan vi bokar, kan du berätta om ni erbjuder digitala möten?', direct: 'Erbjuder ni digitala möten?',
 compound: 'Jag har två frågor: Finns det parkering nära er studio, och erbjuder ni digitala möten?',
};
const policy = 'Vi rekommenderar att du bokar tid i förväg, eftersom besök sker efter överenskommelse.';
const parking = 'Det finns parkering nära studion.';
const digital = 'Vissa tjänster kan genomföras som digitala möten.';
const config = { id: 77, businessId: 77, businessName: 'Synthetic studio', language: 'sv', timezone: 'Europe/Stockholm',
 services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 60 }], defaultBookingService: 'Video Consultation', calendarProvider: 'custom',
 channelConnectionId: 'synthetic-connection', telegramToken: '123456:synthetic-offline', telegramBusinessResolved: true,
 whatsappPhoneNumberId: 'wa-synthetic', whatsappAccessToken: 'synthetic-only', instagramAccountId: 'ig-synthetic', instagramAccessToken: 'synthetic-only',
 messengerPageId: 'ms-synthetic', messengerPageAccessToken: 'synthetic-only', toneConfig: { tonePreset: 'warm' },
 workingHours: Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d => [d, [{ start: '09:00', end: '17:00' }]])) };
let deps: Parameters<typeof b.configure>[0], sent: any[], requests: any[], metrics: any[], reads: number, current: boolean, mode: string, lang: string;
let facts: string[], proposed: any[] | undefined, verdict: string, composer: string, facetCount: number, oldFetch: typeof fetch, oldFlag: string | undefined;
let sequence = 0;
let decisionEvents:any[], decisionLogs:string[], timingEvents:any[], outboundEvents:any[];
let oldNatural:string|undefined,oldSinglePartial:string|undefined;
const configure = (d: Parameters<typeof b.configure>[0]) => { deps = { ...deps, ...d }; b.configure(deps); };
const forbidden = async () => assert.fail('Unauthorized appointment mutation');
const unit = (text: string, index = 0) => ({ facetIds: [`f${index + 1}`], subject: 'studio', predicate: 'offers', value: text,
 modality: text === policy ? 'recommended' : 'descriptive', negation: false, scope: 'this business', qualifiers: [], language: lang, text,
 evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] });
beforeEach((t: any) => {
 b.reset(); deps = {}; sent = []; requests = []; metrics = []; reads = 0; current = true; mode = 'present'; lang = 'sv';
 decisionEvents=[];decisionLogs=[];timingEvents=[];outboundEvents=[];
 facts = [policy]; proposed = undefined; verdict = 'ENTAILED'; composer = 'valid'; facetCount = 1;
 oldFlag = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true';
 oldNatural=process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES;oldSinglePartial=process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL;
 // Preserve explicit rollback-protocol coverage. New natural cases below opt in
 // independently and exercise the real native adapters, not a shared-engine loop.
 process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL='false';
 oldFetch = globalThis.fetch;
 for (const m of ['log','info','warn','error'] as const) t.mock.method(console, m, (...args:any[]) => {
  if(m==='info'&&args[0]==='[BusinessInformationTiming]')timingEvents.push(args[1]);
  if(m==='info'&&args[0]==='[BusinessInformationOutbound]')outboundEvents.push(JSON.parse(args[1]));
  if(m==='info'&&['[EvidenceFirstDecision]','[EvidenceFirstKnowledge]'].includes(args[0])){assert.equal(typeof args[1],'string');assert.equal(args[1].includes('\n'),false);JSON.parse(args[1]);decisionLogs.push(args[1]);}
 });
 globalThis.fetch = async (input, options) => {
  const url = String(input); assert.ok(url.startsWith('https://api.telegram.org/bot123456:synthetic-offline/sendMessage') || /^https:\/\/graph\.(?:facebook|instagram)\.com\//u.test(url), url);
  sent.push({ url, body: JSON.parse(String(options?.body || '{}')) });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }), { status: 200 });
 };
 configure({ semanticLanguageResolver: async () => ({ language: lang, confidence: 1 }), postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  knowledgeSearch: async id => { assert.equal(id, 77); return mode === 'missing' ? [] : [{ businessId: mode === 'foreign' ? 88 : 77, sourceId: 'synthetic-document', text: [policy,parking,digital,...facts].filter((v,i,a) => a.indexOf(v) === i).join('\n'), score: 1, metadata: { source: 'document', documentRevision: 'synthetic-v1' } }]; },
  semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches : [],
  evidenceFirstDiagnostic: event => metrics.push(event),
  evidenceFirstDecisionDiagnostic:event=>decisionEvents.push(event),
  geminiGenerate: async p => {
   requests.push(p); const instruction = p.config.systemInstruction;
   if (instruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: 'requested business information', queries: [], requestedFacets: Array.from({ length: facetCount }, (_,i) => ({ subject: 'studio', attribute: `requested-part-${i+1}`, questionType: 'description' })) }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
   const payload = JSON.parse(p.contents[0].parts[0].text);
   if (instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')) {
    if (mode === 'revoke-extraction') current = false;
    if (mode === 'extract-error') throw new Error('synthetic failure');
    assert.deepEqual(p.config.tools, [], 'unit extraction cannot offer tools');
    assert.equal(payload.businessTone.tonePreset, 'warm'); assert.ok(payload.evidence[0].version);
    return { text: mode === 'malformed' ? 'invalid-json' : JSON.stringify({ units: proposed || facts.map((text,i) => unit(text, i)) }) };
   }
   if (instruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')) {
    if (mode === 'revoke-verification') current = false;
    if (mode === 'verify-error') throw new Error('synthetic failure');
    const decisions=payload.units.map((u:any,i:number)=>({unitId:u.id,relation:(mode==='reject-sibling'&&i)||(mode==='reject-first'&&!i)?'UNKNOWN':verdict,facetIds:u.facetIds,
     meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false}));
    return {text:JSON.stringify({decisions,coverage:payload.facets.map((f:any)=>{const ids=decisions.filter((d:any)=>d.relation==='ENTAILED'&&d.facetIds.includes(f.id)).map((d:any)=>d.unitId);
     return{facetId:f.id,requestAligned:true,materialFactsComplete:ids.length>0,materialUnitIds:ids,obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:ids.length?'COVERED':'UNRESOLVED',unitIds:ids}))};})})};
   }
   if (instruction.includes('VERIFIED-UNIT PRESENTATION')) {
    if (mode === 'revoke-composition') current = false;
    if (composer === 'error') throw new Error('synthetic failure');
    return { text: composer === 'malformed' ? '{"unitIds":[],"extra":"you must book"}' : JSON.stringify({ unitIds: payload.units.map((u:any) => u.id), prefix: composer === 'natural' ? 'acknowledgement' : 'none', addition: true }) };
   }
   throw new Error('Unrestricted prose/recovery generation must not run for migrated information');
  },
  assessBusinessSupportGrounding: async () => assert.fail('Legacy prose grounding must not run for migrated information'),
  assessBusinessClaimEntailment: async () => assert.fail('No per-claim verifier fan-out'),
  calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: async () => { reads++; return []; }, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
  recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
 });
});
afterEach((t: any) => { t.diagnostic(`EvidenceFirstCase ${JSON.stringify({ name:t.name, events:metrics, naturalPublications:decisionEvents.filter(e=>e.stage==='publication'&&e.natural).map(e=>({nativeChannel:e.nativeChannel,...e.natural})), simulatedProviderRequests:requests.length, stages:requests.map(p=>p.context?.stage || p.config.systemInstruction.slice(0,90)), calendarReads:reads })}`); globalThis.fetch = oldFetch; if (oldFlag === undefined) delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = oldFlag; b.reset(); });
afterEach(()=>{for(const [key,value]of [['ODINLINK_GROUNDED_NATURAL_RESPONSES',oldNatural],['ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL',oldSinglePartial]]){
 if(value===undefined)delete process.env[key!];else process.env[key!]=value;
}});
function session(ch: Channel, id: string) { return ch === 'telegram' ? `tg:77:${createHash('sha256').update(config.telegramToken).digest('hex').slice(0,12)}:${id}` : b.channelSessionId(ch,id,config,ch === 'instagram' ? 'ig-synthetic' : ch === 'whatsapp' ? 'wa-synthetic' : 'ms-synthetic'); }
async function inbound(ch: Channel, text: string, id = ch === 'whatsapp' ? '46700000001' : 'synthetic-customer', eventId = String(++sequence)) {
 const now = Date.now(), cfg = { ...config };
 if (ch === 'telegram') return b.telegramInbound({ update_id: eventId, message: { chat: { id }, text, date: Math.floor(now/1000) } }, cfg);
 if (ch === 'whatsapp') return b.whatsappInbound({ id: eventId, from: id, text: { body: text }, type: 'text', timestamp: String(Math.floor(now/1000)) }, { phone_number_id: 'wa-synthetic' }, cfg);
 const event = { sender: { id }, recipient: { id: ch === 'instagram' ? 'ig-synthetic' : 'ms-synthetic' }, timestamp: now, message: { mid: eventId, text } };
 return ch === 'instagram' ? b.instagramInbound(event,cfg) : b.messengerInbound(event,cfg);
}
function published() { assert.ok(sent.length, 'actual adapter reached fake outbound boundary'); const body = sent.at(-1).body; return (typeof body.text === 'string' ? body.text : body.text?.body) || body.message?.text; }
for(const ch of channels)for(const [language,question,text]of naturalLocationCases)
 test(`${ch}/${language}/conversational-location: complete authorized answer without a planner call`,async()=>{
  lang=language;facts=[text];
  const history=[{role:'user',content:'We are discussing a future studio visit.'},{role:'assistant',content:'How can I help with your visit?'}];
  b.promptAuditHistory(session(ch,ch==='whatsapp'?'46700000001':'synthetic-customer'),history);
  await inbound(ch,question);
  assert.equal(published(),text,'Retain address, walking distance, payment, reservation restriction and alternatives');
  assert.equal(requests.some(p=>p.config.systemInstruction.includes('retrieval query planner')),false);
  const extraction=requests.find(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST UNIT EXTRACTION'));
  const verification=requests.find(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT'));
  assert.ok(extraction&&verification,'Extraction and independent verification must both execute');
  for(const request of [extraction,verification]){
   const data=JSON.parse(request.contents[0].parts[0].text);
   assert.equal(data.question,normalizeConversationText(question));
   assert.equal(data.facets[0].obligations[0].description,data.question);
  }
  assert.deepEqual(JSON.parse(extraction.contents[0].parts[0].text).relevantHistory,history);
  assert.equal(metrics.at(-1).completeness[0].status,'VERIFIED');
  assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.publishableUnits===1));assert.equal(reads,0);
 });
for(const ch of channels)for(const action of [
 'I want to book Video Consultation next week.', 'Please cancel my appointment.', 'Please reschedule my appointment.',
 'I want to book Video Consultation next week. Could you tell me where I can park?',
 'Please cancel my appointment. Could you tell me where I can park?',
 'Please reschedule my appointment. Could you tell me where I can park?',
])test(`${ch}/conversational-location/action-boundary: ${action}`,async()=>{
 lang='en';
 const information='Could you tell me where I can park?';
 const mixed=action.endsWith(information);
 if(mixed)facts=['Visitor parking is near the studio.'];
 await inbound(ch,action);
 if(!mixed){
  // Pure actions still cannot enter information generation or obtain tool authority from it.
  assert.equal(metrics.length,0);assert.equal(requests.some(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST')),false);
 }else{
  // The former blanket ban on Knowledge for mixed turns discarded this question.
  // Require its independent verification without transferring any action authority.
  assert.ok(sent.length>=2,'both the action response and information response are delivered');
  assert.equal(published(),facts[0]);
  const extraction=requests.find(p=>p.config.systemInstruction.includes('UNIT EXTRACTION'));assert.ok(extraction);
  assert.equal(JSON.parse(extraction.contents[0].parts[0].text).question,information);
  assert.deepEqual(extraction.config.tools,[]);
  assert.equal(metrics.length,1);assert.equal(metrics[0].completeness[0].status,'VERIFIED');
  assert.ok(requests.some(p=>p.config.systemInstruction.includes('BATCH ENTAILMENT')));
  if(action.startsWith('I want to book')){
   const id=ch==='whatsapp'?'46700000001':'synthetic-customer';
   assert.equal(b.pendingStateSnapshot(session(ch,id))?.service,'Video Consultation');
   assert.equal(b.pendingStateSnapshot(session(ch,id))?.continuationPaused,true);
  }
 }
});
for(const ch of channels)for(const fault of ['foreign','revoke-extraction','verify-error']as const)
 test(`${ch}/conversational-location/${fault}: shortcut never grants publication authority`,async()=>{
  const [language,question,text]=naturalLocationCases[0];lang=language;facts=[text];mode=fault;
  await inbound(ch,question);assert.ok(!published().includes('Nordpark'));
  assert.equal(requests.some(p=>p.config.systemInstruction.includes('retrieval query planner')),false);
  assert.ok(!decisionEvents.some(e=>e.stage==='publication'&&e.publishableUnits>0));assert.equal(reads,0);
 });
for(const ch of channels)test(`${ch}/conversational-location/incomplete: source-backed unit cannot certify full coverage`,async()=>{
 lang='en';facts=[naturalLocationCases[0][2]];
 proposed=[{...unit('Use the Nordpark garage at Stjärngatan 14.'),evidenceRefs:[{evidenceId:'e1',exactQuote:facts[0]}]}];
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  const result=await generate(p);
  if(!p.config.systemInstruction.includes('BATCH ENTAILMENT'))return result;
  const verdict=JSON.parse(result.text);
  verdict.coverage.forEach((c:any)=>{c.materialFactsComplete=false;c.incompletenessReason='MISSING_RECOMMENDATION';
   c.obligations.forEach((o:any)=>{o.status='UNRESOLVED';o.unitIds=[];});});
  return{text:JSON.stringify(verdict)};
 }});
 await inbound(ch,naturalLocationCases[0][1]);
 assert.equal(metrics.at(-1).completeness[0].materialFactsComplete,false);
 assert.notEqual(metrics.at(-1).completeness[0].status,'VERIFIED');
 assert.ok(decisionEvents.some(e=>e.eventType==='coverage'&&e.incompletenessReason==='MISSING_RECOMMENDATION'));
 assert.equal(reads,0);
});
for(const ch of channels)for(const fault of ['timeout','malformed','provider']as const)
 test(`${ch}/conversational-location/planner-${fault}: ambiguous reference retains fail-closed semantic planning`,async()=>{
  lang='en';const question='Could you tell me where that parking is?';
  configure({geminiGenerate:async p=>{
   requests.push(p);assert.match(p.config.systemInstruction,/retrieval query planner/);
   if(fault==='malformed')return{text:'not-json'};
   throw fault==='timeout'?Object.assign(new Error('synthetic planner timeout'),{category:'TIMEOUT'}):new Error('synthetic planner failure');
  }});
  await inbound(ch,question);assert.equal(requests.length,1);assert.ok(!published().includes('Nordpark'));
  assert.equal(decisionEvents.some(e=>e.stage==='extraction'),false);assert.equal(reads,0);
 });
for(const ch of channels)test(`${ch}/conversational-location/context: ambiguous follow-up keeps history-aware planner`,async()=>{
 lang='en';facts=[naturalLocationCases[0][2]];
 const history=[{role:'user',content:'I am asking about visitor parking.'},{role:'assistant',content:'We can discuss parking for the studio.'}];
 b.promptAuditHistory(session(ch,ch==='whatsapp'?'46700000001':'synthetic-customer'),history);
 await inbound(ch,'Could you tell me where that parking is?');
 const planner=requests.find(p=>p.config.systemInstruction.includes('retrieval query planner'));assert.ok(planner);
 assert.deepEqual(JSON.parse(planner.contents[0].parts[0].text).referenceHistory,history);
 assert.equal(published(),facts[0]);assert.equal(metrics.at(-1).completeness[0].status,'VERIFIED');assert.equal(reads,0);
});
for(const ch of channels)for(const exhausted of [false,true])
 test(`${ch}/conversational-location/budget-${exhausted?'exhausted':'reserved'}: unchanged verifier admission and deadline`,async t=>{
  lang='en';facts=[naturalLocationCases[0][2]];const advance=elapsedClock(t),generate=deps.geminiGenerate!;
  configure({geminiGenerate:async p=>{
   if(p.config.systemInstruction.includes('UNIT EXTRACTION'))advance(exhausted?13_000:8_000,0);
   if(p.config.systemInstruction.includes('BATCH ENTAILMENT'))advance(6_900,0);
   return generate(p);
  }});
  await inbound(ch,naturalLocationCases[0][1]);
  assert.equal(requests.some(p=>p.config.systemInstruction.includes('retrieval query planner')),false);
  const publication=decisionEvents.find(e=>e.stage==='publication'&&e.eventType==='publication');assert.ok(publication);
  if(exhausted){assert.ok(!published().includes('Nordpark'));assert.equal(publication.publishableUnits,0);
   assert.ok(decisionEvents.some(e=>e.reason==='STAGE_ADMISSION'));}
  else {assert.equal(published(),facts[0]);assert.ok(publication.remainingMs>=1500);
   const verification=decisionEvents.find(e=>e.stage==='verification'&&e.eventType==='transport');
   assert.ok(verification.timeoutMs>=6000);assert.equal(metrics.at(-1).attempts,2);}
  assert.equal(reads,0);
 });
for (const ch of channels) for (const [name,text,expected] of [
 ['policy',q.policy,[policy]], ['paraphrase',q.paraphrase,[policy]], ['parking',q.parking,[parking]], ['digital-intro',q.intro,[digital]], ['digital-direct',q.direct,[digital]], ['compound',q.compound,[parking,digital]],
] as const) test(`${ch}/${name}: real adapter publishes independently verified facts`, async () => {
 facts = [...expected]; facetCount = facts.length; composer = 'natural'; await inbound(ch,text);
 const answer = published(); for (const fact of facts) assert.ok(answer.includes(fact), answer);
 assert.doesNotMatch(answer,/måste|ingen specifik|available times/iu); assert.equal(reads,0);
 assert.equal(metrics.at(-1).units,facts.length); assert.equal(metrics.at(-1).attempts,facts.length===1?3:4); assert.equal(metrics.at(-1).retries,0);
 assert.equal(metrics.at(-1).presentationFallback,false); assert.ok(requests.every(r => !r.config.systemInstruction.includes('COMPLETENESS REPAIR')));
});
for (const ch of channels) for (const context of ['history','active-draft','long-response'] as const) test(`${ch}/${context}: final guards preserve verified units and draft ownership`, async () => {
 const id = ch === 'whatsapp' ? '46700000002' : 'context'; const sid = session(ch,id);
 facts = [parking];
 if (context === 'active-draft') { await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id); assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation'); sent = []; requests = []; metrics = []; reads = 0; }
 if (context === 'history') b.promptAuditHistory(sid,[{ role:'user', content:'Jag vill boka senare.' },{ role:'assistant', content:'Vi kan fortsätta när du vill.' }]);
 if (context === 'long-response') facts = ['Det finns parkering nära studion. '.repeat(12).trim()];
 if (context === 'long-response') proposed = [unit(facts[0])];
 await inbound(ch,context === 'active-draft' ? q.detour : q.parking,id);
 assert.ok(published().includes(facts[0]),published()); assert.equal(reads,0);
 if (context === 'active-draft') { const pending = b.pendingStateSnapshot(sid); assert.equal(pending?.service,'Video Consultation'); assert.equal(pending?.continuationPaused,true); assert.equal(pending?.dateTime,null); }
});
for (const ch of channels) for (const failure of ['malformed','extract-error','verify-error','missing','foreign','revoke-extraction','revoke-verification','revoke-composition'] as const) test(`${ch}/${failure}: no unverified or revoked facts are published`, async () => {
 mode = failure; if(failure==='revoke-composition'){facts=[policy,parking];facetCount=2;} await inbound(ch,q.policy); assert.equal(published().includes(policy),false); assert.equal(reads,0);
 assert.ok(requests.length <= 4); if (failure === 'missing' || failure === 'foreign') assert.equal(requests.length,1);
});
for (const ch of channels) for (const failure of ['error','malformed'] as const) test(`${ch}/composer-${failure}: preserve verified answer without counting fallback as composition`, async () => {
 composer = failure; facts=[policy,parking];facetCount=2;await inbound(ch,q.policy); assert.ok(published().includes(policy));assert.ok(published().includes(parking)); assert.equal(metrics.at(-1).presentationFallback,true); assert.equal(requests.length,4);
});
for (const ch of channels) test(`${ch}: rejected independent unit cannot erase a verified sibling`, async () => {
 facts = [parking,digital]; facetCount = 2; mode = 'reject-sibling'; await inbound(ch,q.compound);
 assert.ok(published().includes(parking)); assert.equal(published().includes(digital),false); assert.equal(metrics.at(-1).units,1);
 assert.deepEqual(metrics.at(-1).facets.map((f:any) => f.status),['VERIFIED','UNAVAILABLE']);
});
for (const ch of channels) test(`${ch}: rejected mandatory rule cannot erase supported recommendation on the same facet`,async()=>{
 mode='reject-first';proposed=[{...unit('Du måste boka innan varje besök.'),modality:'required',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]},unit(policy)];
 await inbound(ch,q.policy);assert.equal(published(),policy);assert.equal(metrics.at(-1).units,1);assert.equal(reads,0);
 assert.deepEqual(metrics.at(-1).facets.map((f:any)=>f.status),['VERIFIED']);
});
const translations = [
 ['sv',q.policy,'Vi rekommenderar att du bokar tid i förväg.'], ['en','Can I visit without booking in advance?','We recommend booking in advance.'],
 ['de','Kann ich ohne Termin kommen?','Wir empfehlen eine vorherige Terminbuchung.'], ['es','¿Puedo venir sin reservar cita?','Recomendamos reservar con antelación.'],
 ['fa','آیا می‌توانم بدون رزرو قبلی بیایم؟','توصیه می‌کنیم از قبل وقت رزرو کنید.'], ['ar','هل يمكنني الحضور بدون حجز مسبق؟','نوصي بحجز موعد مسبقاً.'],
] as const;
for (const ch of channels) for (const [language,question,text] of translations) test(`${ch}/${language}: same recommended modality through native handoff`, async () => {
 lang = language; facts = [policy]; proposed = [{ ...unit(text), modality:'recommended', evidenceRefs:[{evidenceId:'e1',exactQuote:policy}] }]; await inbound(ch,question);
 assert.equal(published(),text); assert.equal(reads,0); assert.equal(metrics.at(-1).units,1);
});
for (const ch of channels) test(`${ch}: repeat question is answered; repeat event is deduplicated`, async () => {
 await inbound(ch,q.policy,undefined,'same-event'); const before = sent.length;
 await inbound(ch,q.policy,undefined,'same-event'); assert.equal(sent.length,before);
 await inbound(ch,q.policy); assert.equal(sent.length,before+1); assert.equal(published(),policy);
});
for (const ch of channels) test(`${ch}: genuine action bypasses information pipeline`, async () => {
 await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.'); assert.ok(reads > 0); assert.equal(metrics.length,0);
});
for (const ch of channels) for (const text of ['Jag vill avboka min tid.','Jag vill boka om min tid.']) test(`${ch}/${text}: explicit appointment action retains authoritative routing`,async()=>{
 await inbound(ch,text); assert.equal(metrics.length,0,'not an evidence-first information turn');
 assert.equal(requests.some(r=>r.config.systemInstruction.includes('EVIDENCE-FIRST')),false);
});
for (const ch of channels) test(`${ch}: malformed planner is unavailable without unrestricted generation`, async()=>{
 configure({geminiGenerate:async p=>{requests.push(p);assert.match(p.config.systemInstruction,/retrieval query planner/);return{text:'{"canonicalMeaning":"policy","queries":[],"requestedFacets":"invalid"}'};}});
 await inbound(ch,q.policy);assert.equal(published().includes(policy),false);assert.equal(requests.length,1);
});
for (const ch of channels) test(`${ch}: oversized question clarifies without generating partial facts`,async()=>{
 facetCount=5;await inbound(ch,q.policy);assert.match(published(),/fyra frågor/);assert.equal(requests.length,1);
});
for (const ch of channels) test(`${ch}: transient provider failure cannot start a nested retry`,async()=>{
 configure({geminiGenerate:async p=>{requests.push(p);throw Object.assign(new Error('synthetic service unavailable'),{status:503});}});
 await inbound(ch,q.policy);assert.equal(requests.length,1);assert.equal(published().includes(policy),false);
});
for (const ch of channels) test(`${ch}: non-document source is revalidated before publication`,async()=>{
 facts=[policy,parking];facetCount=2;configure({knowledgeSearch:async()=>[{businessId:77,sourceId:'synthetic-web',text:policy+'\n'+parking,metadata:{source:'website'}}]});
 mode='revoke-composition';await inbound(ch,q.policy);assert.equal(published().includes(policy),false);
});
for (const ch of channels) test(`${ch}: conflicting verification does not publish a disputed fact`,async()=>{
 verdict='CONTRADICTED';await inbound(ch,q.policy);assert.equal(published().includes(policy),false);assert.equal(metrics.at(-1).facets[0].status,'CONFLICT');
});
for (const ch of channels) test(`${ch}: superseded information request cannot publish an old manifest`,async()=>{
 const generate=deps.geminiGenerate!;let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),hold=new Promise<void>(r=>release=r);let first=true;
 configure({geminiGenerate:async p=>{if(first&&p.config.systemInstruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')){first=false;enter();await hold;}return generate(p);}});
 const earlier=inbound(ch,q.policy);await started;await inbound(ch,q.policy);release();await earlier;
 assert.equal(sent.length,1);assert.equal(published(),policy);
});
for (const ch of channels) test(`${ch}: changed document version fails freshness without replacing evidence silently`,async()=>{
 configure({validateKnowledgeMatches:async(_id,matches)=>matches.map(m=>({...m,metadata:{...m.metadata,documentRevision:'synthetic-v2'}}))});
 await inbound(ch,q.policy);assert.equal(published().includes(policy),false);assert.equal(requests.length,1);
});
for (const ch of channels) test(`${ch}: revocation at the final publication boundary removes a previously verified answer`,async()=>{
 let publishing=false,checks=0;configure({
  evidenceFirstPublicationDiagnostic:event=>{if(event.phase==='publication_start')publishing=true;},
  validateKnowledgeMatches:async(_id,matches)=>{if(publishing){checks++;return [];}return matches;},
 });
 await inbound(ch,q.policy);assert.equal(metrics.at(-1).units,1);assert.ok(publishing && checks>0);assert.equal(published().includes(policy),false);
});
for (const ch of channels) test(`${ch}: semantic general-conversation decision preserves flexible language/tone generation`,async()=>{
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction.includes('retrieval query planner')){requests.push(p);return{text:JSON.stringify({canonicalMeaning:'general creative conversation',queries:[],requestKind:'GENERAL_CONVERSATION',requestedFacets:[]})};}
  if(p.config.systemInstruction.includes('LANGUAGE ENGINE:')){requests.push(p);assert.match(p.config.systemInstruction,/Tone:/);return{text:'Självklart, jag kan hjälpa dig.'};}
  return generate(p);
 },assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:false,allBusinessClaimsSupported:true,claims:[]})});
 await inbound(ch,'Berätta en kort historia.');assert.ok(published());assert.equal(metrics.length,0);
 assert.equal(requests.some(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST UNIT')),false);
});
for (const ch of channels) for (const [language,question,text] of translations) test(`${ch}/${language}: meaningful language switch preserves the same verified recommendation`,async()=>{
 lang=language==='en'?'sv':'en';const initial=lang==='sv'?policy:'We recommend booking in advance.';
 proposed=[{...unit(initial),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
 await inbound(ch,lang==='sv'?q.policy:'Can I visit without booking in advance?');
 lang=language;proposed=[{...unit(text),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
 await inbound(ch,question);assert.equal(published(),text);assert.equal(reads,0);
});
for (const ch of channels) test(`${ch}: model language label cannot bypass the shared language guard`,async()=>{
 facts=['We recommend that you book an appointment in advance because visits to the studio are arranged by agreement.'];proposed=[{...unit(facts[0]),modality:'recommended'}];
 await inbound(ch,q.policy);assert.equal(published().includes(facts[0]),false);assert.equal(reads,0);
});

const partialLanguages = [
 ['sv',q.compound,parking,digital],
 ['en','Is there parking nearby, and can meetings be digital?','There is parking near the studio.','Some services can be conducted digitally.'],
 ['de','Gibt es Parkplätze in der Nähe und bieten Sie digitale Besprechungen an?','Es gibt Parkplätze in der Nähe des Studios.','Einige Dienstleistungen können digital durchgeführt werden.'],
 ['es','¿Hay aparcamiento cerca y pueden ser digitales las reuniones?','Hay aparcamiento cerca del estudio.','Algunos servicios pueden realizarse de forma digital.'],
 ['fa','آیا نزدیک استودیو پارکینگ هست و جلسات دیجیتال ارائه می‌دهید؟','نزدیک استودیو پارکینگ وجود دارد.','برخی خدمات را می‌توان به صورت دیجیتال انجام داد.'],
 ['ar','هل توجد مواقف قرب الاستوديو وهل تقدمون اجتماعات رقمية؟','توجد مواقف قرب الاستوديو.','يمكن تقديم بعض الخدمات رقمياً.'],
] as const;
function separateSources() {
 facetCount=2;facts=[parking,digital];
 configure({knowledgeSearch:async()=>[
  {businessId:77,sourceId:'parking-doc',text:parking,score:1,metadata:{source:'document',documentRevision:'parking-v1'}},
  {businessId:77,sourceId:'digital-doc',text:digital,score:.99,metadata:{source:'document',documentRevision:'digital-v1'}},
 ]});
}
for(const ch of channels) for(const [language,question,parkText,digitalText] of partialLanguages) for(const fault of ['revoked','stale','foreign'] as const)
 test(`${ch}/${language}/${fault}: publication preserves independent authorized unit in unfinished booking`,async()=>{
  const id=ch==='whatsapp'?'46700000009':'partial',sid=session(ch,id);
  await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id);
  const draft=b.pendingStateSnapshot(sid);assert.equal(draft?.service,'Video Consultation');sent=[];requests=[];metrics=[];reads=0;
  lang=language;separateSources();composer='natural';proposed=[
   {...unit(parkText,0),evidenceRefs:[{evidenceId:'e1',exactQuote:parking}]},
   {...unit(digitalText,1),evidenceRefs:[{evidenceId:'e2',exactQuote:digital}]},
  ];
  let publishing=false;const publications:any[]=[];
  configure({evidenceFirstPublicationDiagnostic:event=>{publications.push(event);if(event.phase==='publication_start')publishing=true;},
   validateKnowledgeMatches:async(_id,matches)=>matches.flatMap(m=>!publishing||m.sourceId!=='parking-doc'?[m]:fault==='revoked'?[]:
    fault==='stale'?[{...m,metadata:{...m.metadata,documentRevision:'parking-v2'}}]:[{...m,businessId:88}]),
  });
  await inbound(ch,question,id);
  const answer=published();assert.ok(answer.includes(digitalText),answer);assert.equal(answer.includes(parkText),false,answer);
  assert.equal(metrics.at(-1).units,2,'both independently verified before publication');
  const final=publications.filter(p=>p.phase==='publication_result').at(-1);assert.equal(final.units,1);assert.equal(final.invalidSources,1);
  assert.deepEqual(final.facets.map((f:any)=>f.status),['UNAVAILABLE','VERIFIED']);assert.equal(requests.length,4);assert.equal(reads,0);
  const pending=b.pendingStateSnapshot(sid);assert.equal(pending?.service,draft.service);assert.equal(pending?.dateTime,null);assert.equal(pending?.continuationPaused,true);
  const last=b.promptAuditHistory(sid).filter((m:any)=>m.role==='assistant').at(-1);
  if(last) assert.equal(last.content.includes(parkText),false,'unpublished fact is not retained in assistant history');
 });
for(const ch of channels) for(const stage of ['verification','composition'] as const) test(`${ch}/${stage}: mid-generation revocation filters only the affected source without new calls`,async()=>{
 separateSources();proposed=[unit(parking),{...unit(digital,1),evidenceRefs:[{evidenceId:'e2',exactQuote:digital}]}];
 let invalid=false;const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{const result=await generate(p);if(p.config.systemInstruction.includes(stage==='verification'?'BATCH ENTAILMENT':'VERIFIED-UNIT PRESENTATION'))invalid=true;return result;},
  validateKnowledgeMatches:async(_id,matches)=>matches.filter(m=>!invalid||m.sourceId!=='parking-doc'),
 });
 await inbound(ch,q.compound);assert.equal(published().includes(parking),false);assert.ok(published().includes(digital));assert.equal(reads,0);assert.equal(requests.length,stage==='verification'?3:4);
});
for(const ch of channels) test(`${ch}: all dependencies of compound negated/qualified unit must remain valid`,async()=>{
 separateSources();
 const qualified='Besök sker endast efter överenskommelse, och digitala möten erbjuds inte på plats.';
 configure({knowledgeSearch:async()=>[
  {businessId:77,sourceId:'parking-doc',text:'Besök sker endast efter överenskommelse.',score:1,metadata:{source:'document',documentRevision:'v1'}},
  {businessId:77,sourceId:'digital-doc',text:`Digitala möten erbjuds inte på plats. ${digital}`,score:.99,metadata:{source:'document',documentRevision:'v1'}},
 ]});
 proposed=[{...unit(qualified),negation:true,qualifiers:['endast efter överenskommelse'],evidenceRefs:[
  {evidenceId:'e1',exactQuote:'Besök sker endast efter överenskommelse.'},{evidenceId:'e2',exactQuote:'Digitala möten erbjuds inte på plats.'}]},
  {...unit(digital,1),evidenceRefs:[{evidenceId:'e2',exactQuote:digital}]}];
 let publishing=false;configure({evidenceFirstPublicationDiagnostic:e=>{if(e.phase==='publication_start')publishing=true;},
  validateKnowledgeMatches:async(_id,matches)=>matches.filter(m=>!publishing||m.sourceId!=='parking-doc')});
 await inbound(ch,q.compound);assert.ok(published().includes(digital));assert.equal(published().includes(qualified),false);assert.doesNotMatch(published(),/på plats|överenskommelse/);assert.equal(reads,0);
});
for(const ch of channels) test(`${ch}: transient validator exception fails closed and never restores quarantined units`,async()=>{
 separateSources();proposed=[unit(parking),{...unit(digital,1),evidenceRefs:[{evidenceId:'e2',exactQuote:digital}]}];
 let publishing=false,fail=true;configure({evidenceFirstPublicationDiagnostic:e=>{if(e.phase==='publication_start')publishing=true;},
  validateKnowledgeMatches:async(_id,matches)=>{if(publishing&&fail){fail=false;throw new Error('synthetic freshness failure');}return matches;}});
 await inbound(ch,q.compound);assert.equal(published().includes(parking),false);assert.equal(published().includes(digital),false);assert.equal(reads,0);
});

for(const ch of channels) for(const [language,question,text] of translations) for(const context of ['fresh','history','draft'] as const)
 test(`${ch}/${language}/${context}: recommendation survives unresolved permission with explicit partial coverage`,async()=>{
  const id=ch==='whatsapp'?'46700000019':'reliability',sid=session(ch,id);
  if(context==='draft'){await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id);assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation');}
  if(context==='history')b.promptAuditHistory(sid,[{role:'user',content:'Jag funderar på att boka senare.'},{role:'assistant',content:'Vi kan fortsätta när du vill.'}]);
  sent=[];requests=[];metrics=[];decisionEvents=[];decisionLogs=[];reads=0;lang=language;
  proposed=[{...unit(text),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
  const generate=deps.geminiGenerate!;
  configure({geminiGenerate:async p=>{
   const result=await generate(p);
   if(p.config.systemInstruction.includes('retrieval query planner')){const plan=JSON.parse(result.text);plan.requestedFacets=[{subject:'visits',attribute:'visit policy',questionType:'permission',obligations:[{description:'whether visits are permitted',questionType:'permission'},{description:'advance-booking recommendation',questionType:'recommendation'}]}];return{text:JSON.stringify(plan)};}
   if(p.config.systemInstruction.includes('BATCH ENTAILMENT')){const data=JSON.parse(p.contents[0].parts[0].text),verified=JSON.parse(result.text);
    verified.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1'],obligations:[{obligationId:data.facets[0].obligations[0].id,status:'UNRESOLVED',unitIds:[]},{obligationId:data.facets[0].obligations[1].id,status:'COVERED',unitIds:['u1']}]}];return{text:JSON.stringify(verified)};}
   return result;
  }});
  await inbound(ch,question,id);const answer=published();assert.ok(answer.includes(text),answer);assert.equal(metrics.at(-1).units,1);
  assert.equal(metrics.at(-1).facets[0].status,'PARTIAL');assert.deepEqual(metrics.at(-1).completeness[0].obligations,['UNRESOLVED','COVERED']);
  assert.equal(answer.includes(normalizeConversationText(question)),false,'partial answers must not echo the whole normalized question');
  assert.doesNotMatch(answer,/Den delen|that part|diesen Teil|esa parte|آن بخش|هذا الجزء/iu);
  assert.equal(metrics.at(-1).presentationPath,'direct_single_unit');assert.equal(requests.length,3);assert.equal(reads,0);
  assert.ok(decisionEvents.some(e=>e.reason==='OBLIGATION_UNRESOLVED'));assert.ok(decisionEvents.some(e=>e.eventType==='unit_verdict'&&e.reason==='ACCEPTED'&&e.flags.modalityPreserved));
  assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.route==='partial_manifest'));
  assert.ok(decisionEvents.every(e=>e.nativeChannel===ch&&e.businessId===77&&e.businessInfoTurnId&&e.schemaVersion==='evidence-first-v2'));
  assert.ok(decisionEvents.length<=64);assert.ok(decisionLogs.every(s=>!s.includes(policy)&&!s.includes(text)&&!s.includes(config.telegramToken)&&!s.includes(id)));
  if(context==='draft'){const draft=b.pendingStateSnapshot(sid);assert.equal(draft.service,'Video Consultation');assert.equal(draft.dateTime,null);assert.equal(draft.continuationPaused,true);}
 });

const arrangements = ['Besök sker efter överenskommelse.','Visits are arranged by agreement.','Besuche erfolgen nach Vereinbarung.',
 'Las visitas se realizan con cita acordada.','بازدیدها با هماهنگی انجام می‌شود.','تتم الزيارات بالاتفاق المسبق.'];
for(const ch of channels) for(const [i,[language,question,text]] of translations.entries()) for(const failComposer of [false,true])
 test(`${ch}/${language}/natural-partial/composer-${failComposer?'failed':'valid'}: two immutable facts, specific uncertainty, no extra request`,async()=>{
  lang=language;composer=failComposer?'error':'natural';
  proposed=[{...unit(text),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]},
   {...unit(arrangements[i]),modality:'descriptive',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
  const generate=deps.geminiGenerate!;
  configure({geminiGenerate:async p=>{
   const result=await generate(p),instruction=p.config.systemInstruction;
   if(instruction.includes('retrieval query planner')){const plan=JSON.parse(result.text);plan.requestedFacets=[{subject:'visits',attribute:'visit policy',questionType:'permission',obligations:[{description:'permission to visit',questionType:'permission'},{description:'recommendation for advance booking',questionType:'recommendation'}]}];return{text:JSON.stringify(plan)};}
   if(instruction.includes('BATCH ENTAILMENT')){const data=JSON.parse(p.contents[0].parts[0].text),v=JSON.parse(result.text);v.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1','u2'],obligations:[{obligationId:data.facets[0].obligations[0].id,status:'UNRESOLVED',unitIds:[]},{obligationId:data.facets[0].obligations[1].id,status:'COVERED',unitIds:['u1']}]}];return{text:JSON.stringify(v)};}
   return result;
  }});
  await inbound(ch,question);const answer=published();assert.ok(answer.includes(text),'recommendation preserved');assert.ok(answer.includes(arrangements[i]),'independent arrangement preserved');assert.equal(answer.includes(normalizeConversationText(question)),false,'partial uncertainty must not repeat the whole question');
  assert.doesNotMatch(answer,/Den delen|that part|diesen Teil|esa parte|آن بخش|هذا الجزء/iu);
  assert.equal(metrics.at(-1).units,2);assert.equal(metrics.at(-1).facets[0].status,'PARTIAL');assert.equal(metrics.at(-1).presentationFallback,failComposer);
  assert.equal(requests.length,4);assert.equal(reads,0);assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.route==='partial_manifest'&&e.nativeChannel===ch));
 });

const fluent = [
 ['Vi rekommenderar en bokad tid inför besöket.','Jag kan däremot inte bekräfta om du kan komma utan bokad tid.'],
 ['We recommend arranging your visit in advance.','I cannot confirm whether you can visit without an appointment.'],
 ['Wir empfehlen, Ihren Besuch vorab zu vereinbaren.','Ob Sie auch ohne Termin kommen können, kann ich allerdings nicht bestätigen.'],
 ['Te recomendamos concertar la visita con antelación.','Lo que no puedo confirmar es si puedes venir sin cita.'],
 ['توصیهٔ ما این است که از قبل وقت بگیرید.','اما نمی‌توانم تأیید کنم که مراجعه بدون وقت قبلی امکان‌پذیر است.'],
 ['نوصيك بترتيب موعد زيارتك مسبقاً.','لكن لا أستطيع تأكيد إمكانية الحضور دون موعد مسبق.'],
];
function approvedNatural(data:any) {
 return {contractHash:data.contractHash,proposalHash:data.proposalHash,flags:Object.fromEntries(NATURAL_FLAGS.map(k=>[k,true])),
  blocks:data.proposal.blocks.map((b:any)=>({blockId:b.id,relation:'ENTAILED',noUnsupportedFacts:true,meaningPreserved:true,uncertaintyAccurate:true})),
  unitCoverage:data.contract.units.map((u:any)=>({unitId:u.id,blockIds:data.proposal.blocks.filter((b:any)=>b.unitIds.includes(u.id)).map((b:any)=>b.id),complete:true})),
  obligationCoverage:data.contract.outcomes.flatMap((o:any)=>o.obligations.filter((d:any)=>d.status==='UNRESOLVED').map((d:any)=>({obligationId:d.obligationId,
   blockIds:data.proposal.blocks.filter((b:any)=>b.obligationIds.includes(d.obligationId)).map((b:any)=>b.id),accurate:true})))};
}
function enableNatural(presentation:any, options:{permission?:boolean;failure?:string}={}) {
 process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='true';process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL='true';
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  const instruction=p.config.systemInstruction;
  if(instruction.includes('INDEPENDENT NATURAL RESPONSE VALIDATION')){
   requests.push(p);assert.deepEqual(p.config.tools,[]);const data=JSON.parse(p.contents[0].parts[0].text);assert.equal(JSON.stringify(data.contract).includes('exactQuote'),false);
   assert.ok(data.contract.scope.turnId);assert.equal(data.contract.scope.businessId,77);assert.equal(data.contract.language,lang);
   if(options.failure==='provider')throw new Error('private natural provider failure');
   if(options.failure==='malformed')return{text:'private malformed natural body'};
   if(options.failure==='revocation')current=false;
   if(options.failure==='flag-change')process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';
   const v:any=approvedNatural(data);
   if(options.failure==='unsupported')v.flags.noUnsupportedFacts=false;
   if(options.failure==='missing-unit')v.unitCoverage.pop();
   if(options.failure==='duplicate')v.blocks.push(v.blocks[0]);
   if(options.failure==='wrong-hash')v.contractHash='foreign-contract';
   if(options.failure==='modality')v.flags.modalityPreserved=false;
   if(options.failure==='uncertainty')v.flags.uncertaintyAccurate=false;
   if(options.failure==='refusal')return{text:JSON.stringify(v),candidates:[{finishReason:'MAX_TOKENS'}]};
   return{text:JSON.stringify(v)};
  }
  const result=await generate(p);
  if(instruction.includes('retrieval query planner')&&options.permission){const v=JSON.parse(result.text);v.requestedFacets=[{subject:'visits',attribute:'visit policy',questionType:'permission',obligations:[{description:'permission without appointment',questionType:'permission'},{description:'booking recommendation',questionType:'recommendation'}]}];return{text:JSON.stringify(v)};}
  if(instruction.includes('UNIT EXTRACTION')){assert.ok(instruction.includes('GROUNDED NATURAL PROPOSAL'));return{text:JSON.stringify({...JSON.parse(result.text),naturalProposal:presentation})};}
  if(instruction.includes('BATCH ENTAILMENT')){
   const data=JSON.parse(p.contents[0].parts[0].text);assert.equal(data.naturalProposal,undefined);assert.equal(data.proposal,undefined,'unit verifier is blind to proposed presentation');
   if(options.permission){const v=JSON.parse(result.text);v.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:data.units.map((u:any)=>u.id),obligations:[
    {obligationId:data.facets[0].obligations[0].id,status:'UNRESOLVED',unitIds:[]},{obligationId:data.facets[0].obligations[1].id,status:'COVERED',unitIds:['u1']}]}];return{text:JSON.stringify(v)};}
  }
  return result;
 }});
}
for(const ch of channels)for(const [i,[language,question,text]]of translations.entries())for(const context of ['fresh','history','draft']as const)
 test(`${ch}/${language}/${context}/grounded-natural: preserved policy with native expression and unresolved permission`,async()=>{
  const id=ch==='whatsapp'?'46700000029':'natural-context',sid=session(ch,id);
  if(context==='draft'){await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id);assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation');}
  if(context==='history')b.promptAuditHistory(sid,[{role:'user',content:'Jag vill boka senare.'},{role:'assistant',content:'Vi fortsätter när du vill.'}]);
  sent=[];requests=[];metrics=[];reads=0;lang=language;
  proposed=[{...unit(text),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]},
   {...unit(arrangements[i]),modality:'descriptive',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
  const fact=fluent[i][0]+' '+arrangements[i],uncertain=fluent[i][1];
  enableNatural({blocks:[{kind:'fact',text:fact,proposedUnitOrdinals:[1,2],obligationIds:[]},{kind:'uncertainty',text:uncertain,proposedUnitOrdinals:[],obligationIds:['f1.o1']}]},{permission:true});
  await inbound(ch,question,id);const answer=published();assert.equal(answer,fact+' '+uncertain);assert.equal(answer.includes(normalizeConversationText(question)),false);
  assert.equal(metrics.at(-1).units,2);assert.equal(metrics.at(-1).facets[0].status,'PARTIAL');assert.equal(metrics.at(-1).naturalResponse.outcome,'accepted_natural');
  assert.equal(metrics.at(-1).presentationPath,'validated_natural');assert.equal(requests.length,4);assert.equal(reads,0);
  assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.natural?.outcome==='accepted_natural'&&e.nativeChannel===ch));
  assert.ok(decisionLogs.every(log=>!log.includes(fact)&&!log.includes(uncertain)&&!log.includes(config.telegramToken)));
  if(context==='draft'){const draft=b.pendingStateSnapshot(sid);assert.equal(draft.service,'Video Consultation');assert.equal(draft.dateTime,null);assert.equal(draft.continuationPaused,true);}
 });
for(const ch of channels)for(const [language,question,parkText,digitalText]of partialLanguages)
 test(`${ch}/${language}/grounded-natural-compound: independently verified facts combine without an invented disclaimer`,async()=>{
  lang=language;facts=[parking,digital];facetCount=2;proposed=[{...unit(parkText,0),evidenceRefs:[{evidenceId:'e1',exactQuote:parking}]},{...unit(digitalText,1),evidenceRefs:[{evidenceId:'e1',exactQuote:digital}]}];
  const answer=parkText+' '+digitalText;enableNatural({blocks:[{kind:'fact',text:answer,proposedUnitOrdinals:[1,2],obligationIds:[]}]});
  await inbound(ch,question);assert.equal(published(),answer);assert.equal(metrics.at(-1).naturalResponse.outcome,'accepted_natural');assert.equal(requests.length,4);assert.equal(reads,0);
 });
for(const ch of channels)for(const failure of ['provider','malformed','unsupported','missing-unit','duplicate','wrong-hash','modality','uncertainty','refusal','revocation']as const)
 test(`${ch}/grounded-natural-${failure}: canonical facts survive rejected presentation, with no repair request`,async()=>{
  facts=[parking,digital];facetCount=2;enableNatural({blocks:[{kind:'fact',text:parking+' '+digital,proposedUnitOrdinals:[1,2],obligationIds:[]}]},{failure});
  await inbound(ch,q.compound);assert.equal(metrics.at(-1).naturalResponse.outcome,'canonical_fallback');assert.equal(requests.length,4);assert.equal(reads,0);
  if(failure!=='revocation'){assert.ok(published().includes(parking));assert.ok(published().includes(digital));}
  else{assert.equal(published().includes(parking),false);assert.equal(published().includes(digital),false);}
 });
for(const ch of channels)for(const failure of ['revoked','stale','foreign']as const)
 test(`${ch}/grounded-natural-publication-${failure}: source pruning discards whole prose but preserves independent facts`,async()=>{
  separateSources();proposed=[{...unit(parking),evidenceRefs:[{evidenceId:'e1',exactQuote:parking}]},{...unit(digital,1),evidenceRefs:[{evidenceId:'e2',exactQuote:digital}]}];
  enableNatural({blocks:[{kind:'fact',text:'Nära studion finns parkering. Vissa tjänster erbjuds digitalt.',proposedUnitOrdinals:[1,2],obligationIds:[]}]});
  let publishing=false;configure({evidenceFirstPublicationDiagnostic:e=>{if(e.phase==='publication_start')publishing=true;},
   validateKnowledgeMatches:async(_id,matches)=>matches.flatMap(m=>!publishing||m.sourceId!=='parking-doc'?[m]:failure==='revoked'?[]:failure==='stale'?[{...m,metadata:{...m.metadata,documentRevision:'v2'}}]:[{...m,businessId:88}])});
  await inbound(ch,q.compound);assert.equal(metrics.at(-1).naturalResponse.outcome,'accepted_natural','accepted before source change');
  assert.ok(published().includes(digital));assert.equal(published().includes('Nära studion'),false);assert.equal(published().includes('Vissa tjänster erbjuds digitalt'),false);
  assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.natural?.outcome==='canonical_fallback'&&e.natural.reason==='SOURCE_INVALID'));assert.equal(requests.length,4);assert.equal(reads,0);
 });
for(const ch of channels)for(const mode of ['direct','single-disabled','single-enabled','flag-change']as const)
 test(`${ch}/grounded-natural-${mode}: request-scoped feature and single-unit admission policy`,async()=>{
  proposed=[{...unit(policy),modality:'recommended'}];enableNatural({blocks:[{kind:'fact',text:fluent[0][0],proposedUnitOrdinals:[1],obligationIds:[]},
   {kind:'uncertainty',text:fluent[0][1],proposedUnitOrdinals:[],obligationIds:['f1.o1']}]},{permission:mode!=='direct',failure:mode==='flag-change'?'flag-change':undefined});
  if(mode==='single-disabled')process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL='false';
  await inbound(ch,q.policy);assert.equal(requests.length,mode==='direct'||mode==='single-disabled'?3:4);assert.equal(reads,0);
  assert.equal(metrics.at(-1).naturalResponse.outcome,mode==='direct'?'direct_canonical':mode==='single-disabled'?'canonical_fallback':'accepted_natural');
 });
for(const ch of channels)for(const outcome of ['complete','timeout']as const)
 test(`${ch}/grounded-natural-openai-${outcome}: installed SDK schema handoff and two-second abort without external transport`,async t=>{
  const previous={AI_PROVIDER:process.env.AI_PROVIDER,OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL,AI_PROVIDER_TIMEOUT_MS:process.env.AI_PROVIDER_TIMEOUT_MS};
  Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-offline-only',OPENAI_MODEL:'gpt-5.6-luna',AI_PROVIDER_TIMEOUT_MS:'10000'});
  t.after(()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  facts=[parking,digital];facetCount=2;enableNatural({blocks:[{kind:'fact',text:parking+' '+digital,proposedUnitOrdinals:[1,2],obligationIds:[]}]});
  const nativeFetch=globalThis.fetch;let sdkCalls=0,aborted=false;const names:string[]=[];let validationMs=0;
  globalThis.fetch=async(input,init)=>{
   if(!String(input).startsWith('https://api.openai.com/'))return nativeFetch(input,init);
   const params=JSON.parse(String(init?.body));sdkCalls++;assert.equal(params.text.format.type,'json_schema');assert.equal(params.text.format.strict,true);names.push(params.text.format.name);
   const p={config:{systemInstruction:params.instructions,tools:[]},contents:[{parts:[{text:params.input[0].content}]}]};
   if(params.instructions.includes('INDEPENDENT NATURAL RESPONSE VALIDATION')&&outcome==='timeout'){
    requests.push(p);const started=Date.now();
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,2400);const signal=init?.signal;
     const abort=()=>{clearTimeout(timer);aborted=true;validationMs=Date.now()-started;reject(new DOMException('Aborted','AbortError'));};
     if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
   }
   const generated=await deps.geminiGenerate!(p as any);
   return new Response(JSON.stringify({id:'resp_synthetic',object:'response',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:generated.text,annotations:[]}]}],usage:{input_tokens:10,output_tokens:10}}),{headers:{'content-type':'application/json'}});
  };
  await inbound(ch,q.compound);assert.equal(sdkCalls,4);assert.equal(reads,0);assert.equal(metrics.at(-1).attempts,4);assert.equal(metrics.at(-1).retries,0);
  assert.ok(names.includes('odinlink_natural_extraction_v1'));assert.ok(names.includes('odinlink_knowledge_verification_v2'));assert.ok(names.includes('odinlink_natural_validation_v1'));
  assert.ok(published().includes(parking));assert.ok(published().includes(digital));
  assert.equal(metrics.at(-1).naturalResponse.outcome,outcome==='complete'?'accepted_natural':'canonical_fallback');
  if(outcome==='timeout'){assert.equal(aborted,true);assert.ok(validationMs<=2300,'transport aborted within the existing two-second allowance plus scheduling tolerance');}
 });

const liveFaults=[['UNKNOWN','UNKNOWN'],['NOT_APPLICABLE','NOT_APPLICABLE'],['CONTRADICTED','CONTRADICTED'],['wrong-id','MISSING_VERDICT'],['missing','MISSING_VERDICT'],['duplicate','DUPLICATE_VERDICT'],
 ['modality','MODALITY_CHANGED'],['qualifiers','QUALIFIERS_CHANGED'],['meaning','MEANING_CHANGED'],['language-local','LOCAL_LANGUAGE'],['language-flag','VERIFIER_LANGUAGE'],
 ['malformed-verification','MALFORMED_JSON'],['blocked','BLOCKED'],['truncated','TRUNCATED'],['timeout','DEADLINE'],
 ['coverage-missing','MISSING_COVERAGE'],['coverage-incomplete','MATERIAL_FACTS_MISSING'],['coverage-wrong-id','INVALID_COVERAGE'],['missing-recommendation','MATERIAL_FACTS_MISSING']] as const;
for(const ch of channels) for(const [fault,reason] of liveFaults)test(`${ch}/${fault}: live-incident failure boundary is diagnosable through the native adapter`,async()=>{
 const generate=deps.geminiGenerate!;
 if(fault==='language-local')proposed=[{...unit('We recommend that you book an appointment in advance because visits to the studio are arranged by agreement.'),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
 const arranged='Besök sker efter överenskommelse.';
 if(fault==='missing-recommendation'){proposed=[{...unit(arranged),modality:'descriptive'}];configure({knowledgeSearch:async()=>[{businessId:77,sourceId:'synthetic-document',text:policy+'\n'+arranged,metadata:{source:'document',documentRevision:'v1'}}]});}
 configure({geminiGenerate:async p=>{
  const result=await generate(p);
  if(fault==='missing-recommendation'&&p.config.systemInstruction.includes('retrieval query planner')){const plan=JSON.parse(result.text);plan.requestedFacets[0].questionType='recommendation';return{text:JSON.stringify(plan)};}
  if(!p.config.systemInstruction.includes('BATCH ENTAILMENT'))return result;
  if(fault==='timeout')throw Object.assign(new Error('private provider timeout body'),{category:'TIMEOUT'});
  if(fault==='malformed-verification')return{text:'private malformed output'};
  if(fault==='blocked')return{...result,promptFeedback:{blockReason:'SAFETY'}};
  if(fault==='truncated')return{...result,candidates:[{finishReason:'MAX_TOKENS'}]};
  const data=JSON.parse(result.text),v=data.decisions[0];
  if(['UNKNOWN','NOT_APPLICABLE','CONTRADICTED'].includes(fault))v.relation=fault;
  if(fault==='wrong-id')v.unitId='private-injected-identifier';if(fault==='missing')data.decisions=[];if(fault==='duplicate')data.decisions.push({...v});
  if(fault==='modality')v.modalityPreserved=false;if(fault==='qualifiers')v.qualifiersPreserved=false;if(fault==='meaning')v.meaningPreserved=false;if(fault==='language-flag')v.languageCorrect=false;
  if(fault==='coverage-missing')delete data.coverage;if(fault==='coverage-incomplete'||fault==='missing-recommendation')data.coverage[0].materialFactsComplete=false;
  if(fault==='coverage-wrong-id')data.coverage[0].materialUnitIds=['u9'];
  return{text:JSON.stringify(data)};
 }});
 await inbound(ch,q.policy);
 const partial=fault.startsWith('coverage-')||fault==='missing-recommendation';
 assert.equal(metrics.at(-1).units,partial?1:0);assert.equal(published().includes(fault==='missing-recommendation'?arranged:policy),partial);
 if(partial)assert.equal(metrics.at(-1).facets[0].status,'PARTIAL');
 assert.ok(decisionEvents.some(e=>e.reason===reason),JSON.stringify(decisionEvents));assert.equal(reads,0);assert.equal(requests.length,3);
 assert.doesNotMatch(decisionLogs.join(' '),/private-injected-identifier|private malformed output|private provider timeout body/);
});

for(const ch of channels) for(const outcome of ['complete','refused','truncated'] as const)test(`${ch}/openai-${outcome}: effective model and strict protocol reach the real provider adapter without network`,async t=>{
 const previous={AI_PROVIDER:process.env.AI_PROVIDER,OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL};
 process.env.AI_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-offline-only';process.env.OPENAI_MODEL='gpt-5.6-luna';
 t.after(()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const generate=deps.geminiGenerate!;let calls=0;
 t.mock.method(Responses.prototype,'create',async(params:any)=>{
  calls++;assert.equal(params.model,'gpt-5.6-luna');assert.equal(params.text.format.type,'json_schema');assert.equal(params.text.format.strict,true);
  assert.ok(params.text.format.name.startsWith('odinlink_knowledge_'));assert.equal(params.tools?.length||0,0,'no mutation tools offered');
  const result=await generate({config:{systemInstruction:params.instructions,tools:[]},contents:[{parts:[{text:params.input[0].content}]}]});
  if(params.instructions.includes('BATCH ENTAILMENT')&&outcome!=='complete')return{output_text:result.text,status:outcome==='truncated'?'incomplete':'completed',output:outcome==='refused'?[{content:[{type:'refusal',refusal:'private refusal'}]}]:[],usage:{input_tokens:10,output_tokens:10}} as any;
  return{output_text:result.text,status:'completed',output:[],usage:{input_tokens:10,output_tokens:10}} as any;
 });
 await inbound(ch,q.policy);assert.equal(calls,3);assert.equal(reads,0);assert.equal(published().includes(policy),outcome==='complete');
 assert.ok(decisionEvents.some(e=>e.provider==='openai'&&e.model==='gpt-5.6-luna'&&e.outputMode==='json_schema'));
 if(outcome!=='complete')assert.ok(decisionEvents.some(e=>e.reason===(outcome==='refused'?'REFUSAL':'TRUNCATED')));
});

// Retain real timers while advancing only elapsed request time. This exercises
// the actual provider/source Promise.race deadlines near 20s, not a fake timeout
// exception or a mock that makes every freshness check instantaneous.
function elapsedClock(t:any) {
 const now=Date.now.bind(Date);let offset=0;
 t.mock.method(Date,'now',()=>now()+offset);
 return (remaining:number,target:number)=>{offset+=Math.max(0,remaining-target);};
}
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

for(const ch of channels)for(const natural of [false,true])for(const [i,[language,question,text]]of translations.entries())
 test(`${ch}/${language}/deadline-repair/natural-${natural}: verified facts survive delayed publication near the live boundary`,async t=>{
  const id=ch==='whatsapp'?'46700000039':'deadline-context',sid=session(ch,id);
  if(i%3===1)b.promptAuditHistory(sid,[{role:'user',content:'Vi kan boka senare.'},{role:'assistant',content:'Vi kan fortsätta när du vill.'}]);
  if(i%3===2){await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id);assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation');}
  sent=[];requests=[];metrics=[];reads=0;lang=language;
  proposed=[{...unit(text),modality:'recommended',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]},
   {...unit(arrangements[i]),modality:'descriptive',evidenceRefs:[{evidenceId:'e1',exactQuote:policy}]}];
  if(natural)enableNatural({blocks:[{kind:'fact',text:fluent[i][0]+' '+arrangements[i],proposedUnitOrdinals:[1,2],obligationIds:[]},
   {kind:'uncertainty',text:fluent[i][1],proposedUnitOrdinals:[],obligationIds:['f1.o1']}]},{permission:true});
  else {
   const generate=deps.geminiGenerate!;
   configure({geminiGenerate:async p=>{
    const result=await generate(p),instruction=p.config.systemInstruction;
    if(instruction.includes('retrieval query planner')){const v=JSON.parse(result.text);v.requestedFacets=[{subject:'visits',attribute:'visit policy',questionType:'permission',obligations:[{description:'walk-in permission',questionType:'permission'},{description:'booking recommendation',questionType:'recommendation'}]}];return{text:JSON.stringify(v)};}
    if(instruction.includes('BATCH ENTAILMENT')){const v=JSON.parse(result.text),data=JSON.parse(p.contents[0].parts[0].text);v.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:['u1','u2'],obligations:[{obligationId:data.facets[0].obligations[0].id,status:'UNRESOLVED',unitIds:[]},{obligationId:data.facets[0].obligations[1].id,status:'COVERED',unitIds:['u1']}]}];return{text:JSON.stringify(v)};}
    return result;
   }});
  }
  const advance=elapsedClock(t);let verified=false,sourceReadsAfterVerification=0;
  configure({evidenceFirstDecisionDiagnostic:(e:any)=>{
   decisionEvents.push(e);
   if(e.stage==='verification'&&e.counts?.verified===2&&!verified){verified=true;advance(e.remainingMs,1086);}
  },validateKnowledgeMatches:async(_id,matches)=>{
   if(verified){sourceReadsAfterVerification++;await wait(250);}
   return current?matches:[];
  }});
  await inbound(ch,question,id);
  assert.ok(published().includes(text));assert.ok(published().includes(arrangements[i]));
  assert.ok(verified);assert.equal(sourceReadsAfterVerification,ch==='telegram'?3:1+(natural?1:0),'canonical no-provider path defers builder read; every actual native publication still checks');
  const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);
  assert.equal(final.semanticVerifiedUnits,2);assert.equal(final.publishableUnits,2);assert.ok(final.remainingMs>0);
  assert.equal(final.facets[0].status,'PARTIAL','a recommendation does not establish walk-in permission');
  assert.equal(final.naturalEnabled,natural);assert.equal(typeof final.revision,'string');
  assert.equal(metrics.at(-1).attempts,3);assert.equal(reads,0);
  if(natural)assert.equal(final.natural.outcome,'canonical_fallback');
  if(i%3===2){assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation');assert.equal(b.pendingStateSnapshot(sid)?.dateTime,null);assert.equal(b.pendingStateSnapshot(sid)?.continuationPaused,true);}
 });

for(const ch of channels)for(const fault of ['provider-deadline','builder-deadline','publication-deadline','revoked']as const)
 test(`${ch}/deadline-repair/${fault}: real delayed work cannot restore expired or revoked authority`,async t=>{
  facts=[parking,digital];facetCount=2;
  enableNatural({blocks:[{kind:'fact',text:parking+' '+digital,proposedUnitOrdinals:[1,2],obligationIds:[]}]});
  const advance=elapsedClock(t),generate=deps.geminiGenerate!;let extraction=false,publishing=false,verified=false,sourceCalls=0;
  configure({geminiGenerate:async p=>{
   if(p.config.systemInstruction.includes('BATCH ENTAILMENT')&&fault==='provider-deadline')await wait(350);
   const result=await generate(p);if(p.config.systemInstruction.includes('UNIT EXTRACTION'))extraction=true;return result;
  },evidenceFirstDecisionDiagnostic:(e:any)=>{
   decisionEvents.push(e);
   if(fault==='provider-deadline'&&extraction&&e.reason==='SOURCE_CURRENT')advance(e.remainingMs,1150);
   if(fault==='builder-deadline'&&!verified&&e.stage==='verification'&&e.counts?.verified===2){verified=true;advance(e.remainingMs,90);}
  },evidenceFirstPublicationDiagnostic:e=>{if(e.phase==='publication_start'){
   publishing=true;
   if(fault==='publication-deadline'){
    const last=decisionEvents.at(-1);advance(last.remainingMs,90);
   }
  }},validateKnowledgeMatches:async(_id,matches)=>{
   sourceCalls++;
   if(publishing&&fault==='publication-deadline'||verified&&fault==='builder-deadline')await wait(180);
   if(publishing&&fault==='revoked')return [];
   return matches;
  }});
  const started=performance.now();await inbound(ch,q.compound);await wait(220);
  assert.ok(performance.now()-started>=150,'actual elapsed timers used');
  assert.equal(published().includes(parking),false);assert.equal(published().includes(digital),false);
  assert.doesNotMatch(published(),/hittar ingen specifik/iu,'unavailability is not asserted evidence absence');
  const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);
  assert.equal(final.publishableUnits,0);assert.equal(final.semanticVerifiedUnits,fault==='provider-deadline'?0:2);
  assert.equal(final.reason,fault==='provider-deadline'?'PUBLICATION_RESERVE':fault==='revoked'?'SOURCE_INVALID':'DEADLINE');
  if(fault==='provider-deadline')assert.equal(requests.length,2,'verification must not begin inside the measured publication reserve');
  if(fault==='publication-deadline'||fault==='builder-deadline')assert.equal(decisionEvents.some(e=>e.reason==='SOURCE_INVALID'),false,'a timed-out source read is not revocation');
  assert.equal(reads,0);assert.ok(requests.length<=4);assert.ok(sourceCalls>0);
 });

for(const ch of channels)for(const invalid of ['missing','oversized','malformed','language']as const)
 test(`${ch}/deadline-repair/${invalid}: optional proposal never erases canonical units`,async()=>{
  facts=[parking,digital];facetCount=2;
  const proposal=invalid==='missing'?null:invalid==='malformed'?{blocks:'invalid'}:{blocks:[{kind:'fact',text:invalid==='oversized'?'x'.repeat(1201):'We recommend that you book an appointment in advance because visits to the studio are arranged by agreement.',proposedUnitOrdinals:[1,2],obligationIds:[]}]};
  enableNatural(proposal);
  await inbound(ch,q.compound);assert.ok(published().includes(parking));assert.ok(published().includes(digital));
  const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.equal(final.publishableUnits,2);assert.equal(final.natural.outcome,'canonical_fallback');
  assert.equal(metrics.at(-1).attempts,3);assert.equal(reads,0);
  if(invalid==='language'){
   const rejection=decisionEvents.find(e=>e.reason==='LOCAL_LANGUAGE'&&e.blockId);
   assert.equal(rejection?.blockId,'b1');assert.equal(rejection?.blockKind,'fact');assert.equal(rejection?.requestedLanguage,'sv');
   assert.equal(JSON.stringify(rejection).includes('We recommend'),false);
  }
 });

test('deadline-repair/four-native/real-wall-clock: slow authoritative providers fail closed within the unchanged deadline', {timeout:30_000}, async()=>{
 facts=[parking,digital];facetCount=2;
 enableNatural({blocks:[{kind:'fact',text:parking+' '+digital,proposedUnitOrdinals:[1,2],obligationIds:[]}]});
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction.includes('BATCH ENTAILMENT'))await wait(20_050);
  return generate(p);
 }});
 const started=performance.now();
 // Separate real native request scopes, with identical synthetic evidence. No
 // accelerated Date clock: late results finish after the actual 20-second cap.
 await Promise.all(channels.map(ch=>inbound(ch,q.compound)));
 const publicationElapsed=performance.now()-started;
 // Wait past the actual provider completion, independent of the earlier reserve.
 await wait(Math.max(0,20_500-publicationElapsed));
 assert.ok(publicationElapsed>=18_000&&publicationElapsed<21_000);
 assert.ok(performance.now()-started>=20_000);
 assert.equal(sent.length,4);assert.equal(reads,0);assert.equal(metrics.length,4);
 for(const ch of channels){
  const final=decisionEvents.filter(e=>e.nativeChannel===ch&&e.stage==='publication').at(-1);
  assert.equal(final.semanticVerifiedUnits,0);assert.equal(final.publishableUnits,0);assert.equal(final.reason,'DEADLINE');
  assert.equal(final.naturalEnabled,true);
  const metric=metrics.find(e=>e.nativeChannel===ch);assert.equal(metric.attempts,3);assert.equal(metric.units,0);
  assert.ok(metric.durationMs<=20_000);assert.equal(metric.retries,0);
 }
 assert.equal(decisionEvents.some(e=>e.stage==='verification'&&e.relation==='ENTAILED'),false,'late results cannot restore verified authority');
 assert.equal(decisionEvents.some(e=>e.reason==='SOURCE_INVALID'),false);
});

for(const ch of channels)for(const scenario of ['low','boundary','ample','revoked','modified','late']as const)
 test(`${ch}/publication-headroom/${scenario}: optional ordering preserves mandatory publication authority`,async t=>{
  facts=[parking,digital];facetCount=2;
  const advance=elapsedClock(t);let verified=false,publishing=false,postVerificationReads=0;
  configure({evidenceFirstDecisionDiagnostic:(e:any)=>{
   decisionEvents.push(e);
   if(!verified&&e.stage==='verification'&&e.counts?.verified===2){
    verified=true;advance(e.remainingMs,scenario==='ample'?8_000:scenario==='boundary'?6_500:4_159);
   }
  },evidenceFirstPublicationDiagnostic:e=>{
   if(e.phase==='publication_start'){
    publishing=true;
    if(scenario==='late')advance(decisionEvents.at(-1).remainingMs,40);
   }
  },validateKnowledgeMatches:async(_id,matches)=>{
   if(verified)postVerificationReads++;
   if(publishing&&scenario==='late')await wait(100);
   if(publishing&&scenario==='revoked')return [];
   if(publishing&&scenario==='modified')return matches.map(m=>({...m,text:'Changed source content',metadata:{...m.metadata,documentRevision:'v2'}}));
   return matches;
  }});
  await inbound(ch,q.compound);
  if(scenario==='late'){const publishedCount=sent.length;await wait(130);assert.equal(sent.length,publishedCount,'late freshness cannot trigger another send');}
  const composition=decisionEvents.filter(e=>e.stage==='composition'&&e.startingBudgetMs!==undefined);
  assert.equal(composition.length,1);
  assert.equal(composition[0].reason,scenario==='ample'?'ACCEPTED':'COMPOSER_SKIPPED_BUDGET');
  assert.equal(requests.filter(p=>p.config.systemInstruction.includes('VERIFIED-UNIT PRESENTATION')).length,scenario==='ample'?1:0);
  const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);
  assert.equal(typeof final.durationMs,'number');assert.equal(typeof final.startingBudgetMs,'number');assert.equal(typeof final.startedAtMs,'number');
  assert.ok(final.businessInfoTurnId);
  const rejected=['revoked','modified','late'].includes(scenario);
  assert.equal(final.publishableUnits,rejected?0:2);
  assert.equal(published().includes(parking),!rejected);assert.equal(published().includes(digital),!rejected);
  assert.ok(postVerificationReads>0,'independent publication validation remains mandatory');
  if(!rejected&&scenario!=='ample')assert.equal(postVerificationReads,ch==='telegram'?3:1,'no intermediate builder read on guarded canonical path');
  if(scenario==='late')assert.equal(final.reason,'DEADLINE');
 });

// Release 1 observes real adapter entry/send paths without changing their answers.
for (const ch of channels) test(`release1/${ch}: exact incident admission and final send share one ID`, async t => {
 lang='en';facts=['Use Nordpark at Stjärngatan 14, five minutes on foot from the studio.', 'Parking is paid.', 'Parking spaces cannot be reserved.'];
 proposed=facts.map(text=>unit(text,0));
 const epoch=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>epoch+elapsed);
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  assert.equal(p.config.systemInstruction.includes('BATCH ENTAILMENT'),false,'verifier must not start');
  const result=await generate(p);
  if(p.config.systemInstruction.includes('UNIT EXTRACTION'))elapsed=12796;
  return result;
 }});
 await inbound(ch,"Hi! I'm thinking about visiting your studio next week. Could you tell me where I can park my car?");
 const admission=decisionEvents.find(e=>e.eventType==='verification_admission');
 assert.deepEqual(admission.admission,{checkpoint:'before_queue',remainingBudgetMs:7204,publicationReserveMs:1500,
  verificationAdmissionFloorMs:6000,effectiveAllowanceMs:5704,admitted:false,rejectionReason:'INSUFFICIENT_VERIFICATION_ALLOWANCE'});
 assert.equal(admission.reason,'STAGE_ADMISSION');assert.equal(admission.failureKind,'not_admitted');
 assert.ok(decisionEvents.some(e=>e.stage==='extraction'&&e.counts?.proposed===3&&e.counts?.parsed===3));
 assert.equal(published(),'I cannot verify that part right now.');assert.equal(sent.length,1);assert.equal(reads,0);
 const id=admission.businessInfoTurnId;assert.match(id,/^[0-9a-f-]{36}$/u);
 assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.businessInfoTurnId===id&&e.reason==='STAGE_ADMISSION'));
 assert.ok(decisionEvents.every(e=>e.businessInfoTurnId===id));
 assert.ok(timingEvents.some(e=>e.stage==='retrieval_complete'&&e.businessInfoTurnId===id));
 assert.deepEqual(outboundEvents.map(e=>e.eventType),['send_attempt','http_response','application_result']);
 assert.ok(outboundEvents.every(e=>e.businessInfoTurnId===id&&e.customerDelivery==='unconfirmed'));
 assert.equal(outboundEvents.at(-1).applicationAccepted,true);
 assert.doesNotMatch(JSON.stringify([...decisionEvents,...timingEvents,...outboundEvents]),/synthetic-customer|46700000001|synthetic-offline|Stjärngatan|thinking about visiting/);
});
for(const ch of channels)test(`release1/${ch}: admitted verification, publication and HTTP-only acceptance remain distinct`,async()=>{
 facts=[parking];await inbound(ch,q.parking);
 assert.equal(published(),parking);assert.equal(reads,0);
 const admissions=decisionEvents.filter(e=>e.eventType==='verification_admission');
 assert.deepEqual(admissions.map(e=>e.admission.checkpoint),['before_queue','after_queue']);
 assert.ok(admissions.every(e=>e.admission.admitted&&e.admission.effectiveAllowanceMs>=6000));
 const id=admissions[0].businessInfoTurnId;
 assert.ok(decisionEvents.every(e=>e.businessInfoTurnId===id));
 assert.ok(decisionEvents.some(e=>e.stage==='verification'&&e.eventType==='transport'&&e.transportSuccess));
 assert.equal(outboundEvents.at(-1).businessInfoTurnId,id);
 assert.equal(outboundEvents.find(e=>e.eventType==='http_response').providerAcceptance,'unknown');
 assert.equal(outboundEvents.at(-1).customerDelivery,'unconfirmed');
});
for(const fault of ['timeout','decoder','coverage','source'] as const)test(`release1/whatsapp: ${fault} is not admission rejection`,async()=>{
 facts=[parking];const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  const instruction=p.config.systemInstruction;
  if(instruction.includes('BATCH ENTAILMENT')){
   if(fault==='timeout')throw Object.assign(new Error('private provider timeout body'),{category:'TIMEOUT'});
   if(fault==='decoder')return{text:'private invalid json document body'};
   const result=await generate(p);
   if(fault==='coverage'){const parsed=JSON.parse(result.text);parsed.coverage=[];return{text:JSON.stringify(parsed)};}
   return result;
  }
  const result=await generate(p);if(fault==='source'&&instruction.includes('UNIT EXTRACTION'))current=false;
  return result;
 }});
 await inbound('whatsapp',q.parking);
 const expected={timeout:'provider_timeout',decoder:'decoder_failure',coverage:'incomplete_coverage',source:'source_invalidation'}[fault];
 assert.ok(decisionEvents.some(e=>e.failureKind===expected),JSON.stringify(decisionEvents));
 assert.equal(decisionEvents.some(e=>e.failureKind==='not_admitted'),false);
 assert.doesNotMatch(JSON.stringify(decisionEvents),/private provider|private invalid|document body/);
});

for(const ch of channels)test(`release1/${ch}: concurrent conversations retain distinct stage and send correlation`,async()=>{
 facts=[parking];const generate=deps.geminiGenerate!;let extractionCount=0;
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
 configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction.includes('UNIT EXTRACTION')&&++extractionCount===1){entered();await held;}
  return generate(p);
 }});
 const first=inbound(ch,q.parking,ch==='whatsapp'?'46700000002':'concurrent-a');
 await started;
 try{await inbound(ch,q.parking,ch==='whatsapp'?'46700000003':'concurrent-b');}finally{release();}
 await first;
 const ids=[...new Set(decisionEvents.map(e=>e.businessInfoTurnId))];assert.equal(ids.length,2);assert.ok(ids.every(Boolean));
 for(const id of ids){
  assert.ok(decisionEvents.some(e=>e.businessInfoTurnId===id&&e.stage==='planning'));
  assert.ok(decisionEvents.some(e=>e.businessInfoTurnId===id&&e.stage==='publication'));
  assert.deepEqual(outboundEvents.filter(e=>e.businessInfoTurnId===id).map(e=>e.eventType),['send_attempt','http_response','application_result']);
 }
 assert.equal(sent.length,2);assert.equal(reads,0);
});

for(const ch of channels)for(const failure of ['http','transport','api-body'] as const)
 test(`release1/${ch}: ${failure} send evidence is correlated without changing adapter results`,async()=>{
  facts=[parking];const send=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
   await send(input,options); // Existing fake adapter records the unchanged payload.
   if(failure==='transport')throw new Error('private transport secret recipient');
   return new Response(JSON.stringify({error:{code:100,message:'private API secret recipient'}}),{status:failure==='http'?403:200});
  };
  await inbound(ch,q.parking);
  assert.equal(sent.length,1);
  const id=decisionEvents.find(e=>e.stage==='publication').businessInfoTurnId;
  assert.ok(outboundEvents.every(e=>e.businessInfoTurnId===id&&e.customerDelivery==='unconfirmed'));
  if(failure==='transport'){
   assert.deepEqual(outboundEvents.map(e=>e.eventType),['send_attempt','transport_exception']);
   assert.equal(outboundEvents.at(-1).providerAcceptance,'unknown');
  }else{
   assert.equal(outboundEvents.at(-1).eventType,'application_result');
   // Keep the existing HTTP-only application decision even for an error body.
   assert.equal(outboundEvents.at(-1).applicationAccepted,failure==='api-body');
   assert.equal(outboundEvents.at(-1).providerAcceptance,ch==='telegram'&&failure==='api-body'?'unknown':'rejected');
   assert.equal(outboundEvents.find(e=>e.eventType==='http_response').httpStatus,failure==='http'?403:200);
  }
  assert.doesNotMatch(JSON.stringify(outboundEvents),/private|recipient|secret|synthetic-offline/);
 });

for(const ch of channels)test(`p1-isolation/${ch}: throwing timing and outbound sinks preserve one verified send`,async t=>{
 facts=[parking];const info=console.info;
 t.mock.method(console,'info',(...args:any[])=>{
  if(['[BusinessInformationTiming]','[BusinessInformationOutbound]'].includes(args[0]))throw new Error('optional sink failure');
  info(...args);
 });
 await inbound(ch,q.parking);
 assert.equal(sent.length,1);assert.equal(published(),parking);assert.equal(reads,0);
 assert.ok(decisionEvents.some(e=>e.stage==='publication'&&e.publishableUnits===1));
});

for(const fault of ['sink','serialization','observer','async-observer'] as const)
 for(const outcome of ['admitted','not-admitted','source-revoked'] as const)
 test(`p1-isolation/whatsapp/${fault}/${outcome}: admission and publication authority survive telemetry failure`,async t=>{
  lang='en';facts=['Parking is available near the studio.'];const epoch=Date.now();let elapsed=0;
  t.mock.method(Date,'now',()=>epoch+elapsed);
  const generate=deps.geminiGenerate!,stringify=JSON.stringify;
  if(fault==='sink')t.mock.method(console,'info',()=>{throw new Error('optional sink failure');});
  if(fault==='serialization')t.mock.method(JSON,'stringify',(value:any,...args:any[])=>{
   if(['evidence-first-v2','knowledge-outbound-v1'].includes(value?.schemaVersion))throw new Error('optional serialization failure');
   return stringify(value,...args);
  });
  const publications:any[]=[];
  if(fault==='observer'||fault==='async-observer'){
   const fail=()=>{if(fault==='async-observer')return Promise.reject(new Error('optional async observer'));throw new Error('optional observer');};
   configure({evidenceFirstDecisionDiagnostic:e=>{decisionEvents.push(e);return fail();},
    evidenceFirstDiagnostic:e=>{metrics.push(e);return fail();},
    evidenceFirstPublicationDiagnostic:e=>{publications.push(e);return fail();}});
  }
  configure({geminiGenerate:async p=>{
   if(outcome==='not-admitted')assert.equal(p.config.systemInstruction.includes('BATCH ENTAILMENT'),false);
   const result=await generate(p);
   if(p.config.systemInstruction.includes('UNIT EXTRACTION')){
    if(outcome==='not-admitted')elapsed=12796;
    if(outcome==='source-revoked')current=false;
   }
   return result;
  }});
  await inbound('whatsapp','Where can I park my car?');
  assert.equal(sent.length,1);assert.equal(reads,0);
  const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.ok(final);
  assert.equal(final.publishableUnits,outcome==='admitted'?1:0);
  assert.equal(published(),outcome==='admitted'?facts[0]:'I cannot verify that part right now.');
  if(outcome==='not-admitted'){
   const admission=decisionEvents.find(e=>e.admission);assert.ok(admission);
   assert.equal(admission.reason,'STAGE_ADMISSION');
   assert.deepEqual(admission.admission,{checkpoint:'before_queue',remainingBudgetMs:7204,publicationReserveMs:1500,
    verificationAdmissionFloorMs:6000,effectiveAllowanceMs:5704,admitted:false,rejectionReason:'INSUFFICIENT_VERIFICATION_ALLOWANCE'});
  }
  if(outcome==='admitted')assert.ok(requests.some(p=>p.config.systemInstruction.includes('BATCH ENTAILMENT')));
  if(outcome==='source-revoked')assert.ok(decisionEvents.some(e=>e.failureKind==='source_invalidation'));
  if(fault==='observer'||fault==='async-observer')assert.ok(publications.some(e=>e.phase==='publication_result'));
 });

test('p1-isolation/whatsapp: application-result logging exception preserves the adapter true return',async t=>{
 const info=console.info;
 t.mock.method(console,'info',(...args:any[])=>{
  if(args[0]==='[BusinessInformationOutbound]'&&JSON.parse(args[1]).eventType==='application_result')throw new Error('optional result observer');
  info(...args);
 });
 const result=await withBusinessInformationTiming(async()=>{
  beginBusinessInformationTiming('synthetic-send-session','private question',77);
  return b.sendCustomerMessage('whatsapp','46700000001',parking,config,'conversation');
 },'whatsapp');
 assert.equal(result,true);assert.equal(sent.length,1);
});

for(const rejected of [false,true])test(`p1-isolation/observer-mutation/${rejected}: observer snapshot cannot change admission authority`,async t=>{
 lang='en';facts=['Parking is available near the studio.'];
 const epoch=Date.now();let elapsed=0,mutations=0;t.mock.method(Date,'now',()=>epoch+elapsed);
 const generate=deps.geminiGenerate!;
 configure({geminiGenerate:async p=>{
  const result=await generate(p);if(rejected&&p.config.systemInstruction.includes('UNIT EXTRACTION'))elapsed=12796;return result;
 },evidenceFirstDecisionDiagnostic:e=>{
  decisionEvents.push(e);
  if(e.admission){mutations++;(e.admission as any).admitted=!(e.admission as any).admitted;throw new Error('optional observer mutation');}
 }});
 await inbound('whatsapp','Where can I park my car?');
 assert.ok(mutations>0);assert.equal(sent.length,1);
 assert.equal(published(),rejected?'I cannot verify that part right now.':facts[0]);
 assert.equal(requests.some(p=>p.config.systemInstruction.includes('BATCH ENTAILMENT')),!rejected);
 assert.ok(decisionEvents.filter(e=>e.admission).every(e=>e.admission.admitted===!rejected));
});

for(const ch of channels)for(const informationFirst of [false,true])
 test(`extraction/mixed/${ch}/${informationFirst}: literal action first, one independent answer and frozen pre-action history`,async()=>{
  lang='en';facts=['Parking is available near the studio.'];
  const action='Please book Unicorn Surgery for 2026-10-20.',information='Where can I park my car?';
  const history=[{role:'user',content:'I am thinking of visiting.'},{role:'assistant',content:'What would you like to know?'}];
  const id=ch==='whatsapp'?'46700000001':'synthetic-customer';b.promptAuditHistory(session(ch,id),history);
  const search=deps.knowledgeSearch!;let retrievals=0;
  configure({knowledgeSearch:async(...args:any[])=>{
   retrievals++;assert.equal(sent.length,1,'the action branch must finish its response before Knowledge retrieval');
   return (search as any)(...args);
  }});
  await inbound(ch,informationFirst?`${information} ${action}`:`${action} ${information}`,id);
  assert.ok(retrievals>0);assert.equal(sent.length,2);assert.equal(published(),facts[0]);assert.equal(reads,0);
  const extraction=requests.find(p=>p.config.systemInstruction.includes('UNIT EXTRACTION'));assert.ok(extraction);
  const payload=JSON.parse(extraction.contents[0].parts[0].text);
  assert.equal(payload.question,normalizeConversationText(information));assert.deepEqual(payload.relevantHistory,history);
  const turnIds=new Set(decisionEvents.map(e=>e.businessInfoTurnId));assert.equal(turnIds.size,1);assert.ok([...turnIds][0]);
 });
