import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, test } from 'node:test';
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
const configure = (d: Parameters<typeof b.configure>[0]) => { deps = { ...deps, ...d }; b.configure(deps); };
const forbidden = async () => assert.fail('Unauthorized appointment mutation');
const unit = (text: string, index = 0) => ({ facetIds: [`f${index + 1}`], subject: 'studio', predicate: 'offers', value: text,
 modality: text === policy ? 'recommended' : 'descriptive', negation: false, scope: 'this business', qualifiers: [], language: lang, text,
 evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] });
beforeEach((t: any) => {
 b.reset(); deps = {}; sent = []; requests = []; metrics = []; reads = 0; current = true; mode = 'present'; lang = 'sv';
 facts = [policy]; proposed = undefined; verdict = 'ENTAILED'; composer = 'valid'; facetCount = 1;
 oldFlag = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true';
 oldFetch = globalThis.fetch;
 for (const m of ['log','info','warn','error'] as const) t.mock.method(console, m, () => {});
 globalThis.fetch = async (input, options) => {
  const url = String(input); assert.ok(url.startsWith('https://api.telegram.org/bot123456:synthetic-offline/sendMessage') || /^https:\/\/graph\.(?:facebook|instagram)\.com\//u.test(url), url);
  sent.push({ url, body: JSON.parse(String(options?.body || '{}')) });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }), { status: 200 });
 };
 configure({ semanticLanguageResolver: async () => ({ language: lang, confidence: 1 }), postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  knowledgeSearch: async id => { assert.equal(id, 77); return mode === 'missing' ? [] : [{ businessId: mode === 'foreign' ? 88 : 77, sourceId: 'synthetic-document', text: [policy,parking,digital,...facts].filter((v,i,a) => a.indexOf(v) === i).join('\n'), score: 1, metadata: { source: 'document', documentRevision: 'synthetic-v1' } }]; },
  semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches : [],
  evidenceFirstDiagnostic: event => metrics.push(event),
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
    return { text: JSON.stringify({ decisions: payload.units.map((u:any, i:number) => ({ unitId: u.id, relation: (mode === 'reject-sibling' && i) || (mode === 'reject-first' && !i) ? 'UNKNOWN' : verdict, facetIds: u.facetIds, meaningPreserved: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })) }) };
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
afterEach((t: any) => { t.diagnostic(`EvidenceFirstCase ${JSON.stringify({ name:t.name, events:metrics, simulatedProviderRequests:requests.length, stages:requests.map(p=>p.context?.stage || p.config.systemInstruction.slice(0,90)), calendarReads:reads })}`); globalThis.fetch = oldFetch; if (oldFlag === undefined) delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = oldFlag; b.reset(); });
function session(ch: Channel, id: string) { return ch === 'telegram' ? `tg:77:${createHash('sha256').update(config.telegramToken).digest('hex').slice(0,12)}:${id}` : b.channelSessionId(ch,id,config,ch === 'instagram' ? 'ig-synthetic' : ch === 'whatsapp' ? 'wa-synthetic' : 'ms-synthetic'); }
async function inbound(ch: Channel, text: string, id = ch === 'whatsapp' ? '46700000001' : 'synthetic-customer', eventId = String(++sequence)) {
 const now = Date.now(), cfg = { ...config };
 if (ch === 'telegram') return b.telegramInbound({ update_id: eventId, message: { chat: { id }, text, date: Math.floor(now/1000) } }, cfg);
 if (ch === 'whatsapp') return b.whatsappInbound({ id: eventId, from: id, text: { body: text }, type: 'text', timestamp: String(Math.floor(now/1000)) }, { phone_number_id: 'wa-synthetic' }, cfg);
 const event = { sender: { id }, recipient: { id: ch === 'instagram' ? 'ig-synthetic' : 'ms-synthetic' }, timestamp: now, message: { mid: eventId, text } };
 return ch === 'instagram' ? b.instagramInbound(event,cfg) : b.messengerInbound(event,cfg);
}
function published() { assert.ok(sent.length, 'actual adapter reached fake outbound boundary'); const body = sent.at(-1).body; return (typeof body.text === 'string' ? body.text : body.text?.body) || body.message?.text; }
for (const ch of channels) for (const [name,text,expected] of [
 ['policy',q.policy,[policy]], ['paraphrase',q.paraphrase,[policy]], ['parking',q.parking,[parking]], ['digital-intro',q.intro,[digital]], ['digital-direct',q.direct,[digital]], ['compound',q.compound,[parking,digital]],
] as const) test(`${ch}/${name}: real adapter publishes independently verified facts`, async () => {
 facts = [...expected]; facetCount = facts.length; composer = 'natural'; await inbound(ch,text);
 const answer = published(); for (const fact of facts) assert.ok(answer.includes(fact), answer);
 assert.doesNotMatch(answer,/måste|ingen specifik|available times/iu); assert.equal(reads,0);
 assert.equal(metrics.at(-1).units,facts.length); assert.equal(metrics.at(-1).attempts,4); assert.equal(metrics.at(-1).retries,0);
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
 mode = failure; await inbound(ch,q.policy); assert.equal(published().includes(policy),false); assert.equal(reads,0);
 assert.ok(requests.length <= 4); if (failure === 'missing' || failure === 'foreign') assert.equal(requests.length,1);
});
for (const ch of channels) for (const failure of ['error','malformed'] as const) test(`${ch}/composer-${failure}: preserve verified answer without counting fallback as composition`, async () => {
 composer = failure; await inbound(ch,q.policy); assert.equal(published(),policy); assert.equal(metrics.at(-1).presentationFallback,true); assert.equal(requests.length,4);
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
 configure({knowledgeSearch:async()=>[{businessId:77,sourceId:'synthetic-web',text:policy,metadata:{source:'website'}}]});
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
 await inbound(ch,q.compound);assert.equal(published().includes(parking),false);assert.ok(published().includes(digital));assert.equal(reads,0);assert.equal(requests.length,4);
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
