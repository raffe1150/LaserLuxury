import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { extractInProcess } from '../knowledge/documents/extraction-process';
import { documentChunks } from '../knowledge/documents/service';
import { InMemoryKnowledgeStorage,KnowledgeService } from '../../knowledge';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { normalizeConversationText } from './booking-intelligence';
import { NATURAL_FLAGS } from './grounded-knowledge-composition';
import { performance } from 'node:perf_hooks';
process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER='gemini';
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
let decisionEvents:any[], decisionLogs:string[];
let oldNatural:string|undefined,oldSinglePartial:string|undefined;
const configure = (d: Parameters<typeof b.configure>[0]) => { deps = { ...deps, ...d }; b.configure(deps); };
const forbidden = async () => assert.fail('Unauthorized appointment mutation');
const unit = (text: string, index = 0) => ({ facetIds: [`f${index + 1}`], subject: 'studio', predicate: 'offers', value: text,
 modality: text === policy ? 'recommended' : 'descriptive', negation: false, scope: 'this business', qualifiers: [], language: lang, text,
 evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] });
beforeEach((t: any) => {
 b.reset(); deps = {}; sent = []; requests = []; metrics = []; reads = 0; current = true; mode = 'present'; lang = 'sv';
 decisionEvents=[];decisionLogs=[];
 facts = [policy]; proposed = undefined; verdict = 'ENTAILED'; composer = 'valid'; facetCount = 1;
 oldFlag = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'true';
 oldNatural=process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES;oldSinglePartial=process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL;
 // Preserve explicit rollback-protocol coverage. New natural cases below opt in
 // independently and exercise the real native adapters, not a shared-engine loop.
 process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';process.env.ODINLINK_GROUNDED_NATURAL_SINGLE_PARTIAL='false';
 oldFetch = globalThis.fetch;
 for (const m of ['log','info','warn','error'] as const) t.mock.method(console, m, (...args:any[]) => {
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

// EXPLICIT MODEL FIXTURES: these English sentences and entailment decisions test
// orchestration/provenance only. They are not captured or evaluated OpenAI output.
const question='Where can I park my car when visiting AdMotion Studio?';
const pdfBytes=readFileSync(new URL('../../tests/fixtures/admotion-studio-parking.pdf',import.meta.url));
assert.equal(createHash('sha256').update(pdfBytes).digest('hex'),'f15ba3a6a1428745edeedd6647fd7d6b61daf139d99311f304e38a2f1a340e9d');
const sections=await extractInProcess(pdfBytes,'admotion studio1.pdf','application/pdf');
const extracted=documentChunks(sections,'admotion studio1.pdf');
const parkingFacts=[
 'You can park at Nordpark, with the garage entrance at Stjärngatan 14, approximately a five-minute walk from the studio.',
 'Parking is not free.',
 'Parking spaces cannot be reserved.',
];
const rawQuotes=[
 'För besökare som kommer med bil fi nns ett parkeringsgarage som i detta test kallas Nordpark .\nGaragets infart ligger på Stjärngatan 14 . Från garaget tar det ungefär fem minuter att gå till studions entré.',
 'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.',
 'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.',
];
// Match the actual extracted line separator, retaining every original character.
const garageText=String(extracted.chunks[0].content);
const qstart=garageText.indexOf('För besökare som kommer med bil');
rawQuotes[0]=garageText.slice(qstart,garageText.indexOf('AdMotion Studio erbjuder inte gratis parkering',qstart)).trim();
const results:any[]=[];
async function install(t:any,fault='complete',ch:Channel='whatsapp') {
 (config as any).address='Studio Street 99';t.after(()=>delete (config as any).address);
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage);
 const data=fault==='ambiguous'?documentChunks(sections.map((s,i)=>i? s:{...s,text:rawQuotes[0]+' '+rawQuotes[0]+'\n'+rawQuotes[1]}),'admotion studio1.pdf'):extracted;
 const source:any={id:'exact-pdf',businessId:77,type:'document',title:'admotion studio1.pdf',status:'ready',content:data.content,metadata:data.metadata,createdAt:'2026',updatedAt:'2026'};
 await storage.create(source);await storage.replaceChunks(77,source.id,data.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata as any})));
 const txt='Det finns möjlighet till parkering i närheten. Kontakta företaget för information om parkeringsalternativ.';
 await storage.create({...source,id:'generic-txt',title:'odinlink-test.txt',content:txt,metadata:{segments:[{start:0,end:txt.length,section:'Text'}]}});
 await storage.replaceChunks(77,'generic-txt',[{chunkIndex:0,content:txt,metadata:{section:'Text'}}]);
 assert.deepEqual(await service.sourceLanguageHints(77),[]);
 if(fault==='conflict'){(config as any).systemPrompt='Parking policy: Parking at Nordpark is free for all studio visitors.';t.after(()=>delete (config as any).systemPrompt);}
 lang='en';let phase='building',validation=0,searched=false;let elapsed=0;const epoch=Date.now();
 if(fault.startsWith('timing')||fault==='publication-timeout')t.mock.method(Date,'now',()=>epoch+elapsed);
 const advance=(ms:number)=>{elapsed+=ms;};
 configure({evidenceFirstDecisionDiagnostic:e=>{decisionEvents.push(e);if(fault.startsWith('timing')&&e.stage==='verification'&&e.counts)advance(150);},knowledgeSourceLanguages:async()=>[],knowledgeSearch:async(id,q,l)=>{
  if(fault.startsWith('timing')&&!searched){advance(874);searched=true;}
  const m=await service.search(id,q,l);return fault==='foreign'?m.map(x=>({...x,businessId:88})):m;
 },semanticKnowledgeSearch:async()=>[],
 validateKnowledgeMatches:async(id,matches)=>{
  validation++;
  if(fault.startsWith('timing'))advance(phase==='publication'?1337:validation===1?320:validation===2?358:334);
  if(fault==='publication-timeout'&&phase==='publication')advance(20001);
  const valid=await service.validateMatches(id,matches,{strictSources:true,captureRevision:true});
  // Production's rounded summary + final-read durations leave 5ms for the
  // observed deadline-reaching continuation. Model it explicitly, not via CPU noise.
  if(fault.startsWith('timing')&&phase==='publication')advance(5);
  return valid;
 },evidenceFirstPublicationDiagnostic:e=>{
  if(e.phase!=='publication_start')return;phase='publication';
  if(fault==='delete'||fault==='timing-delete')void storage.delete(77,source.id);
  if(fault==='revision'||fault==='timing-revision')void storage.create({...source,updatedAt:'2027',content:source.content+' Changed.'});
  if(fault==='ownership')void b.securedRequest(session(ch,ch==='whatsapp'?'46700000001':'synthetic-customer'),async()=>{});
  if(fault==='stale')void storage.create({...source,status:'processing'});
 },geminiGenerate:async p=>{
  requests.push(p);const instruction=p.config.systemInstruction;
  if(instruction.includes('retrieval query planner')){
   if(fault.startsWith('timing'))advance(2594);
   return{text:JSON.stringify({canonicalMeaning:'parking arrangements',queries:['parkering garage infart'],queryLanguages:[],requestKind:'BUSINESS_INFORMATION',requestedFacets:[{subject:'parking',attribute:'arrangements',questionType:'description',obligations:[{description:'parking arrangements',questionType:'description'}]}]})};
  }
  const data=JSON.parse(p.contents[0].parts[0].text);
  if(instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')){
   if(fault.startsWith('timing'))advance(7905);
   const ev=data.evidence.find((e:any)=>e.text.includes('Nordpark'));assert.ok(ev,'Real local retrieval must supply parking chunk');
   assert.ok(data.evidence.some((e:any)=>e.text.includes('Kontakta företaget')),'Generic TXT remains available for conflict assessment');
   return{text:JSON.stringify({units:parkingFacts.map((text,i)=>({facetIds:['f1'],subject:'parking',predicate:'arrangement',value:text,scope:'garage for studio visitors',qualifiers:[],negation:i>0,modality:'descriptive',language:'en',text,evidenceRefs:[{evidenceId:fault==='bad-id'?'absent':ev.id,exactQuote:fault==='address'&&i===0?rawQuotes[i].replace('14','19'):fault==='negation'?rawQuotes[i].replace('inte gratis','gratis'):fault==='whitespace'?rawQuotes[i].replace(/\s+([.,])/gu,'$1').replace(/\s+/gu,' '):fault==='partial'&&i===0?'fabricated source quotation':rawQuotes[i]}]}))})};
  }
  if(instruction.includes('BATCH ENTAILMENT')){
   assert.ok(data.authoritativeEvidence.includes('Studio Street 99'),'Distinct studio address stays available to the verifier');
   if(fault==='conflict')assert.ok(data.authoritativeEvidence.includes('Parking at Nordpark is free'),'Applicable authoritative conflict reaches independent verifier');
   if(fault.startsWith('timing'))advance(6123);
   if(fault==='verification-timeout'){const e:any=new Error('synthetic timeout');e.category='TIMEOUT';throw e;}
   const decisions=data.units.map((u:any)=>({unitId:u.id,relation:fault==='conflict'?'CONTRADICTED':'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,explicitAbsenceEvidence:true,negativeAbsence:false}));
   const ids=fault==='conflict'?[]:data.units.map((u:any)=>u.id);return{text:JSON.stringify({decisions,coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:ids.length===3,materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:ids.length===3?'COVERED':'UNRESOLVED',unitIds:ids.length===3?ids:[]}]}]})};
  }
  if(instruction.includes('VERIFIED-UNIT PRESENTATION'))return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  throw Error('Unexpected provider stage');
 }});
 return {storage,service,source,elapsed:()=>elapsed,validation:()=>validation};
}
for(const ch of channels)for(const fault of ['complete','whitespace','bad-id','address','negation','ambiguous','ownership','foreign','partial','conflict','delete','revision','stale','verification-timeout','publication-timeout','timing','timing-delete','timing-revision'])test(`P0 parking/${ch}/${fault}: exact PDF through real native adapter, explicit model fixtures`,async t=>{
 const f=await install(t,fault,ch);await inbound(ch,question);
 if(fault==='ownership'){assert.equal(sent.length,0,'Lost request ownership suppresses delivery');assert.ok(decisionEvents.some(e=>e.reason==='PUBLICATION_SUPPRESSED'));return;}
 assert.equal(sent.length,1,'Exactly one intercepted native send');assert.equal(reads,0);
 assert.doesNotMatch(decisionLogs.join(' '),/Nordpark|Stjärngatan|Where can I park my car|synthetic-offline-only/);
 const text=published();assert.equal(text.includes('Studio Street 99'),false);assert.equal(text.includes(question),false);assert.equal(text.includes('contact'),false);
 const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.ok(final);assert.equal(final.naturalEnabled,false);
 results.push({channel:ch,fault,output:text,elapsedControlledMs:f.elapsed(),validationReads:f.validation(),publication:final,contextChars:requests.filter(p=>!/retrieval query planner/u.test(p.config.systemInstruction)).map(p=>({stage:p.config.systemInstruction.includes('EXTRACTION')?'extraction':p.config.systemInstruction.includes('ENTAILMENT')?'verification':'presentation',chars:p.contents[0].parts[0].text.length}))});
 if(['complete','whitespace','timing'].includes(fault)){
  for(const fact of parkingFacts)assert.ok(text.includes(fact),text);
  assert.equal(final.publishableUnits,3);assert.equal(final.facets[0].status,'VERIFIED');
 }else if(fault==='negation'){
  assert.ok(text.includes(parkingFacts[0]));assert.equal(text.includes(parkingFacts[1]),false);assert.equal(text.includes(parkingFacts[2]),false);assert.equal(final.facets[0].status,'PARTIAL');
 }else if(['partial','address','ambiguous'].includes(fault)){
  assert.equal(text.includes('Nordpark'),false);assert.ok(text.includes(parkingFacts[1]));assert.equal(final.facets[0].status,'PARTIAL');assert.ok(text.includes('I can only confirm these details for now.'));
 }else {assert.equal(text.includes('Nordpark'),false);assert.equal(final.publishableUnits,0);}
 if(fault==='verification-timeout')assert.ok(decisionEvents.some(e=>e.stage==='verification'&&e.reason==='DEADLINE'));
 if(fault==='publication-timeout')assert.ok(decisionEvents.some(e=>e.stage==='freshness'&&e.reason==='DEADLINE'));
 if(fault==='ambiguous')assert.ok(decisionEvents.some(e=>e.citationSubtype==='AMBIGUOUS_QUOTE'));
 if(fault==='bad-id')assert.ok(decisionEvents.some(e=>e.citationSubtype==='EVIDENCE_ID'));
 if(fault==='whitespace')assert.ok(decisionEvents.some(e=>e.citationSubtype==='WHITESPACE_MAPPED'));

});
import {after} from 'node:test';
after(()=>{const out=process.env.P0_RESULTS;if(out)writeFileSync(out,JSON.stringify({label:'MOCKED PROVIDER / INTERCEPTED SENDS — no actual OpenAI evaluation',pdfSha256:createHash('sha256').update(pdfBytes).digest('hex'),results},null,2));});

for(const fail of ['slow','failed'])test(`P0 parking/whatsapp/${fail} semantic provider: real deadline preserves lexical fallback`,async t=>{
 await install(t);configure({semanticKnowledgeSearchQueries:async()=>{if(fail==='slow')return new Promise(()=>{});throw Error('synthetic embedding failure');}});
 const start=performance.now();await inbound('whatsapp',question);assert.equal(sent.length,1);for(const fact of parkingFacts)assert.ok(published().includes(fact));
 if(fail==='slow')assert.ok(performance.now()-start>=2400&&performance.now()-start<5000);
});
for(const ch of channels)test(`P0 parking/${ch}/OpenAI SDK protocol: explicit model fixture, no external request`,async t=>{
 await install(t,'complete',ch);
 const previous={AI_PROVIDER:process.env.AI_PROVIDER,OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL};
 Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-only',OPENAI_MODEL:'gpt-5.6-luna'});
 t.after(()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const fixture=deps.geminiGenerate!;let calls=0;
 t.mock.method(Responses.prototype,'create',async(p:any)=>{
  calls++;assert.equal(p.model,'gpt-5.6-luna');assert.equal(p.tools?.length||0,0);
  const r=await fixture({config:{systemInstruction:p.instructions,tools:[]},contents:[{parts:[{text:p.input[0].content}]}]});
  return{output_text:r.text,status:'completed',output:[],usage:{input_tokens:10,output_tokens:10}} as any;
 });
 await inbound(ch,question);assert.equal(sent.length,1);for(const fact of parkingFacts)assert.ok(published().includes(fact));
 assert.equal(published().includes(question),false);assert.equal(calls,3);assert.equal(reads,0);
 const final=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.equal(final.provider,'openai');assert.equal(final.publishableUnits,3);assert.equal(final.naturalEnabled,false);
});

// Actual audio helper exercised inside the native Messenger request's async scope.
// This does not claim the ordinary unified inbound route chooses audio.
for (const mutation of ['none','delete','revision','during-tts','ownership','deadline','during-probe','unknown-send','rejected-send']) test(`Messenger Knowledge audio boundary/${mutation}`, async t => {
 const f=await install(t,'complete','messenger');let audio:Promise<any>|undefined,started=false,tts=0,audioSends=0;
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  if(String(input)==='https://synthetic.invalid/audio') {
   if(mutation==='during-probe')await f.storage.delete(77,f.source.id);
   return new Response('',{status:200});
  }
  const body=JSON.parse(String(options?.body||'{}'));
  if(body.message?.attachment){audioSends++;if(mutation==='unknown-send')throw Error('synthetic transport uncertainty');if(mutation==='rejected-send')return new Response('{}',{status:400});}
  return originalFetch(input,options);
 };
 configure({messengerVoiceReply:async text=>{
  tts++;for(const fact of parkingFacts)assert.ok(text.includes(fact));
  if(mutation==='during-tts')await f.storage.delete(77,f.source.id);
  if(mutation==='ownership')await b.securedRequest(session('messenger','synthetic-customer'),async()=>{});
  if(mutation==='deadline'){const now=Date.now();t.mock.method(Date,'now',()=>now+21000);}
  return{filePath:'/unused/mocked.mp3',url:'https://synthetic.invalid/audio'};
 },knowledgeVoiceValidation:async()=>{
  if(started)return;started=true;
  audio=(async()=>{
   if(mutation==='delete')await f.storage.delete(77,f.source.id);
   if(mutation==='revision')await f.storage.create({...f.source,updatedAt:'new-revision',content:f.source.content+' Changed.'});
   return b.messengerVoice('synthetic-customer',parkingFacts.join(' '),config);
  })();await audio;
 }});
 await inbound('messenger',question);assert.ok(audio);const delivery=await audio;
 assert.equal(audioSends,['none','unknown-send','rejected-send'].includes(mutation)?1:0);
 if(['unknown-send','rejected-send'].includes(mutation))assert.equal(delivery.attempted,true);assert.equal(delivery.sent,mutation==='none');
 if(['delete','revision'].includes(mutation))assert.equal(tts,0);
});

test('Legacy semantic retrieval retains slow cold semantic results without EFK cutoff',async t=>{
 await install(t);let completed=false;
 configure({knowledgeSearch:async()=>[],semanticKnowledgeSearchQueries:async()=>{
  await new Promise(r=>setTimeout(r,2700));completed=true;
  return[{businessId:77,sourceId:'legacy-semantic',text:'Parking is available at Nordpark.',score:1,metadata:{}}];
 }});
 const start=performance.now();const result=await b.retrieveBusinessKnowledge(question,config);assert.ok(JSON.stringify(result).includes('Nordpark'));
 assert.equal(completed,true);assert.ok(performance.now()-start>=2600);
});

for(const kind of ['manual','document','mixed'] as const)for(const when of ['verification','tts'] as const)test(`Messenger ${kind} revocation during ${when}: no stale audio`,async t=>{
 const f=await install(t,'complete','messenger');
 if(kind==='manual'){
  const content=rawQuotes.slice(0,2).join('\n');
  await f.storage.create({...f.source,type:'text',content,metadata:{}});
  await f.storage.replaceChunks(77,f.source.id,[{chunkIndex:0,content,metadata:{}}]);
 }
 if(kind==='mixed') {
  await f.storage.create({...f.source,id:'manual-parking',type:'text',content:rawQuotes[1],metadata:{}});
  await f.storage.replaceChunks(77,'manual-parking',[{chunkIndex:0,content:rawQuotes[1],metadata:{}}]);
 }
 const revoke=async()=>{await f.storage.delete(77,f.source.id);await f.storage.delete(77,'manual-parking');};
 const model=deps.geminiGenerate!;let started=false,tts=0,audioSends=0;const fixtureErrors:string[]=[];
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  if(String(input)==='https://synthetic.invalid/audio')return new Response('',{status:200});
  const body=JSON.parse(String(options?.body||'{}'));if(body.message?.attachment)audioSends++;
  return originalFetch(input,options);
 };
 configure({geminiGenerate:async p=>{
  let result:any;try{result=await model(p);}catch(e){fixtureErrors.push(String(e));throw e;}
  if(p.config.systemInstruction.includes('UNIT EXTRACTION')&&kind==='mixed'){
   const payload=JSON.parse(p.contents[0].parts[0].text);const manual=payload.evidence.find((e:any)=>e.text.includes(rawQuotes[1])&&!e.text.includes('Nordpark'));assert.ok(manual,JSON.stringify(payload.evidence));
   const parsed=JSON.parse(result.text);for(const u of parsed.units.slice(1))u.evidenceRefs[0].evidenceId=manual.id;
   return{text:JSON.stringify(parsed)};
  }
  if(p.config.systemInstruction.includes('BATCH ENTAILMENT')&&when==='verification')await revoke();
  return result;
 },messengerVoiceReply:async text=>{tts++;if(when==='tts')await revoke();return{filePath:'/unused/mock.mp3',url:'https://synthetic.invalid/audio'};},
 knowledgeVoiceValidation:async()=>{if(started)return;started=true;const result=await b.messengerVoice('synthetic-customer',parkingFacts.join(' '),config);assert.equal(result.sent,false);assert.equal(result.attempted,false);}});
 await inbound('messenger',question);assert.deepEqual(fixtureErrors,[]);assert.ok(requests.some(p=>p.config.systemInstruction.includes('BATCH ENTAILMENT')));assert.equal(started,true);assert.equal(audioSends,0);assert.equal(tts,when==='verification'?0:1);
});

for(const revoked of [false,true])test(`Native Messenger voice inbound / verification revocation=${revoked}: guarded text route`,async t=>{
 const f=await install(t,'complete','messenger');const model=deps.geminiGenerate!;let transcription=0;
 configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction.startsWith("Transcribe the customer's")){transcription++;return{text:question};}
  const result=await model(p);
  if(revoked&&p.config.systemInstruction.includes('BATCH ENTAILMENT'))await f.storage.delete(77,f.source.id);
  return result;
 },messengerVoiceReply:async()=>assert.fail('Unified parking voice inbound currently delivers guarded text')});
 const original=globalThis.fetch;globalThis.fetch=async(input,options)=>String(input).includes('synthetic.invalid/inbound')?new Response('mocked audio',{headers:{'content-type':'audio/ogg'}}):original(input,options);
 await b.messengerInbound({sender:{id:'synthetic-customer'},recipient:{id:'ms-synthetic'},timestamp:Date.now(),message:{mid:String(++sequence),attachments:[{type:'audio',payload:{url:'https://synthetic.invalid/inbound'}}]}},config);
 assert.equal(transcription,1);assert.equal(sent.length,1);assert.equal(published().includes('Nordpark'),!revoked);assert.equal(reads,0);
});

// Production observations: timeout durations are censored, NOT completed model latencies.
// The completion probe uses Telegram's observed 6963ms verifier on every profile;
// it is an explicitly counterfactual provider fixture, never a historical Meta response.
const incidentProfiles={
 telegram:{units:3,planning:2463,search:847,first:125,extraction:7270,overhead:184,next:147,verification:6963,bookkeeping:8,final:340},
 instagram:{units:4,planning:3244,search:1024,first:319,extraction:7591,overhead:118,next:343,verification:5860,bookkeeping:2,final:192},
 whatsapp:{units:3,planning:8810,search:893,first:348,extraction:8024,overhead:190,next:134,verification:102,bookkeeping:1,final:316},
 messenger:{units:2,planning:4284,search:1561,first:132,extraction:6342,overhead:322,next:146,verification:5714,bookkeeping:1,final:135},
};
for(const profile of channels)for(const channel of channels)for(const completion of [false,true])test(`production-replay/${profile}/${channel}/${completion?'completion-probe':'observed-censored'}`,async t=>{
 await install(t,'complete',channel);const original={...deps};const p=incidentProfiles[profile];
 const epoch=Date.now();let elapsed=0,validations=0,publishing=false,searched=false,publicationReads=0;const checkpoints:any[]=[];
 t.mock.method(Date,'now',()=>epoch+elapsed);
 const timeout=()=>{const e:any=new Error('Explicit simulated provider timeout');e.category='TIMEOUT';throw e;};
 const work=(ms:number)=>{const allowance=Math.max(0,20000-elapsed-1500);if(ms>allowance){elapsed+=allowance+2;timeout();}elapsed+=ms;};
 configure({knowledgeSearch:async(...args)=>{if(!searched){elapsed+=p.search;searched=true;}return original.knowledgeSearch!(...args);},
 validateKnowledgeMatches:async(...args)=>{validations++;elapsed+=publishing?(++publicationReads===1?p.final:109):validations===1?p.first:validations===2?p.next:333;return original.validateKnowledgeMatches!(...args);},
 evidenceFirstPublicationDiagnostic:e=>{if(e.phase==='publication_start'){publishing=true;if(channel==='telegram'&&publicationReads===0)elapsed+=5;}if(e.phase==='publication_result'&&channel==='telegram'&&publicationReads===2)elapsed+=1;},
 evidenceFirstDecisionDiagnostic:e=>{
  original.evidenceFirstDecisionDiagnostic!(e);
  if(e.stage==='composition'&&profile==='telegram'&&process.env.KNOWLEDGE_REPLAY_BASELINE==='true')elapsed+=4;
  if(e.stage==='extraction'&&e.counts){checkpoints.push({stage:'parsed',remainingMs:e.remainingMs});if(process.env.KNOWLEDGE_REPLAY_BASELINE==='true')assert.equal(e.remainingMs,{telegram:9111,instagram:7704,whatsapp:1735,messenger:7359}[profile]);}
 },
 geminiGenerate:async params=>{
  const instruction=params.config.systemInstruction;
  try {
  if(instruction.includes('retrieval query planner'))work(p.planning);
  if(instruction.includes('UNIT EXTRACTION')){work(p.extraction);elapsed+=p.overhead;}
  if(instruction.includes('BATCH ENTAILMENT')){
   work(completion?6963:p.verification);elapsed+=p.bookkeeping;
   if(!completion&&profile!=='telegram'){elapsed=18502;timeout();}
  }
  if(instruction.includes('VERIFIED-UNIT PRESENTATION'))work(2000);
  const result=await original.geminiGenerate!(params);
  if(instruction.includes('UNIT EXTRACTION')&&p.units!==3){
   const data=JSON.parse(result.text),[garage,free,reserved]=data.units;
   data.units=p.units===2?[garage,{...free,text:parkingFacts[1]+' '+parkingFacts[2],value:parkingFacts[1]+' '+parkingFacts[2]}]:
    [{...garage,text:'You can park at Nordpark, with the garage entrance at Stjärngatan 14.',value:'Nordpark entrance Stjärngatan 14'},
     {...garage,text:'The garage is approximately a five-minute walk from the studio.',value:'approximately a five-minute walk'},free,reserved];
   return{text:JSON.stringify(data)};
  }
  if(instruction.includes('BATCH ENTAILMENT')&&p.units!==3){
   const data=JSON.parse(result.text),ids=JSON.parse(params.contents[0].parts[0].text).units.map((u:any)=>u.id);
   data.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:true,materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:ids}]}];return{text:JSON.stringify(data)};
  }
  return result;
  } finally {if(!requests.includes(params))requests.push(params);}
 }});
 b.promptAuditHistory(session(channel,channel==='whatsapp'?'46700000001':'synthetic-customer'),[]);
 await inbound(channel,question);assert.equal(sent.length,1);assert.equal(reads,0);
 const baseline=process.env.KNOWLEDGE_REPLAY_BASELINE==='true';
 if(baseline)assert.equal(checkpoints.find(c=>c.stage==='parsed')?.remainingMs,{telegram:9111,instagram:7704,whatsapp:1735,messenger:7359}[profile]);
 const complete=profile==='telegram'||completion&&!baseline;
 const output=published();assert.equal(output.includes('Nordpark'),complete,JSON.stringify({profile,channel,completion,elapsed,output}));
 if(complete)for(const fact of ['Nordpark','Stjärngatan 14','five-minute walk','Parking is not free.','Parking spaces cannot be reserved.'])assert.ok(output.includes(fact));
 assert.equal(output.includes(question),false);
 const publication=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.equal(publication.publishableUnits,complete?p.units:0);
 results.push({profile,channel,completion,label:completion?'Counterfactual 6963ms completion fixture':'Observed timeout is censored; no recovered Meta answer',inventoryUnits:p.units,elapsedControlledMs:elapsed,checkpoints,output,publication,
  requests:requests.map(r=>({stage:r.config.systemInstruction.includes('retrieval query planner')?'planning':r.config.systemInstruction.includes('UNIT EXTRACTION')?'extraction':r.config.systemInstruction.includes('BATCH ENTAILMENT')?'verification':'ordering',chars:r.contents?.[0]?.parts?.[0]?.text?.length||0,instructionChars:r.config.systemInstruction.length}))});
});

for(const channel of channels)for(const variant of ['two-complete','two-partial','three-complete','four-complete'])test(`latency-inventory/${channel}/${variant}: complete facts or explicit partial coverage`,async t=>{
 await install(t,'complete',channel);const original=deps.geminiGenerate!;let proposedUnits:any[]=[];
 configure({geminiGenerate:async p=>{
  assert.equal(p.config.systemInstruction.includes('retrieval query planner'),false,'Recognized self-contained question must not pay for planning');
  const result=await original(p);
  if(p.config.systemInstruction.includes('UNIT EXTRACTION')){
   const data=JSON.parse(result.text);const [garage,free,reserved]=data.units;
   proposedUnits=variant==='two-complete'?[garage,{...free,text:parkingFacts[1]+' '+parkingFacts[2],value:parkingFacts[1]+' '+parkingFacts[2]}]:variant==='two-partial'?[garage,free]:variant==='four-complete'?
    [{...garage,text:'You can park at Nordpark, with the garage entrance at Stjärngatan 14.',value:'Nordpark entrance Stjärngatan 14'},
     {...garage,text:'The garage is approximately a five-minute walk from the studio.',value:'approximately a five-minute walk'},free,reserved]:data.units;
   return{text:JSON.stringify({...data,units:proposedUnits})};
  }
  if(p.config.systemInstruction.includes('BATCH ENTAILMENT')){
   const data=JSON.parse(result.text),ids=JSON.parse(p.contents[0].parts[0].text).units.map((u:any)=>u.id),complete=variant!=='two-partial';
   data.coverage=[{facetId:'f1',requestAligned:true,materialFactsComplete:complete,materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:complete?'COVERED':'UNRESOLVED',unitIds:complete?ids:[]}]}];return{text:JSON.stringify(data)};
  }
  return result;
 }});
 await inbound(channel,question);assert.equal(sent.length,1);assert.equal(reads,0);
 const output=published(),publication=decisionEvents.filter(e=>e.stage==='publication').at(-1);
 for(const fact of ['Nordpark','Stjärngatan 14','five-minute walk','Parking is not free.'])assert.ok(output.includes(fact),output);
 assert.equal(publication.facets[0].status,variant==='two-partial'?'PARTIAL':'VERIFIED');
 assert.equal(output.includes('Parking spaces cannot be reserved.'),variant!=='two-partial');assert.equal(output.includes(question),false);
});

for(const channel of channels)test(`latency-admission/${channel}: no new verifier below measured six-second window`,async t=>{
 await install(t);const original=deps.geminiGenerate!;const epoch=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>epoch+elapsed);
 configure({geminiGenerate:async p=>{assert.equal(p.config.systemInstruction.includes('BATCH ENTAILMENT'),false);const result=await original(p);if(p.config.systemInstruction.includes('UNIT EXTRACTION'))elapsed=14001;return result;}});
 await inbound(channel,question);assert.equal(sent.length,1);assert.equal(published().includes('Nordpark'),false);assert.ok(decisionEvents.some(e=>e.reason==='STAGE_ADMISSION'));assert.equal(reads,0);
});

for(const slow of [false,true])test(`latency-ambiguous-planning/${slow?'slow':'normal'}: bounded model planning retains fail-closed contract`,async t=>{
 await install(t);const original=deps.geminiGenerate!;let plannerCompleted=false;
 configure({geminiGenerate:async p=>{if(p.config.systemInstruction.includes('retrieval query planner')){if(slow)await new Promise(r=>setTimeout(r,2800));plannerCompleted=true;}return original(p);}});
 const start=performance.now();await inbound('whatsapp','Could you tell me about parking arrangements at AdMotion Studio?');
 assert.equal(sent.length,1);assert.equal(published().includes('Nordpark'),!slow);
 if(slow){assert.equal(plannerCompleted,false);assert.ok(performance.now()-start>=2400&&performance.now()-start<4000);await new Promise(r=>setTimeout(r,400));assert.equal(plannerCompleted,true);assert.equal(sent.length,1,'Late planning cannot publish another answer');}
});

const locationLanguages=[
 ['sv','Var finns kundparkering vid AdMotion Studio?',['Du kan parkera i Nordpark med infart på Stjärngatan 14, ungefär fem minuters promenad från studion.','Parkeringen är inte gratis.','Parkeringsplatser kan inte reserveras.']],
 ['en',question,parkingFacts],
 ['de','Wo ist der Kundenparkplatz bei AdMotion Studio?',['Sie können im Nordpark parken. Die Einfahrt liegt an der Stjärngatan 14, etwa fünf Gehminuten vom Studio entfernt.','Das Parken ist nicht kostenlos.','Parkplätze können nicht reserviert werden.']],
 ['es','Dónde está el aparcamiento para clientes de AdMotion Studio?',['Puede aparcar en Nordpark. La entrada está en Stjärngatan 14, a unos cinco minutos a pie del estudio.','El aparcamiento no es gratuito.','No se pueden reservar plazas.']],
 ['fa','کجا می توانم پارکینگ مشتریان AdMotion Studio را پیدا کنم؟',['می‌توانید در Nordpark پارک کنید. ورودی در Stjärngatan 14 است و حدود پنج دقیقه پیاده تا استودیو فاصله دارد.','پارکینگ رایگان نیست.','امکان رزرو جای پارک وجود ندارد.']],
 ['ar','أين يمكنني العثور على موقف سيارات عملاء AdMotion Studio؟',['يمكنك الوقوف في Nordpark. المدخل في Stjärngatan 14، على بعد حوالي خمس دقائق سيرًا على الأقدام من الاستوديو.','الوقوف ليس مجانيًا.','لا يمكن حجز أماكن الوقوف.']],
] as const;
for(const channel of channels)for(const [language,localizedQuestion,translations]of locationLanguages)test(`latency-location/${channel}/${language}: actual semantic index, explicitly synthetic embeddings and model translations`,async t=>{
 const f=await install(t);lang=language;const normalizedQuestion=localizedQuestion.replace(/؟/gu,'?');const original=deps.geminiGenerate!;
 const vector=(values:number[])=>({provider:'openai',model:'synthetic-multilingual-only',dimensions:2,version:1,values});
 const provider:any={supportsLocalSemanticSearch:true,embedQuery:async()=>vector([1,0]),embedDocuments:async(texts:string[])=>texts.map(text=>vector(texts[0]===normalizedQuestion?[1,0]:text.includes('Nordpark')?[1,0]:text.includes('Kontakta företaget')?[.98,.2]:[0,1]))};
 const semantic=new KnowledgeService(f.storage,f.storage,provider);let semanticCalls=0;
 configure({semanticKnowledgeSearchQueries:async(id,queries,limit)=>{semanticCalls++;assert.equal(queries[0],normalizedQuestion);return semantic.semanticSearchQueries(id,queries,limit);},geminiGenerate:async p=>{
  assert.equal(p.config.systemInstruction.includes('retrieval query planner'),false);
  let result:any;try{result=await original(p);}catch(error){t.diagnostic('Explicit model fixture error: '+String(error));throw error;}if(p.config.systemInstruction.includes('UNIT EXTRACTION')){const data=JSON.parse(result.text);data.units.forEach((u:any,i:number)=>{u.language=language;u.text=translations[i];u.value=translations[i];});return{text:JSON.stringify(data)};}return result;
 }});
 await inbound(channel,localizedQuestion);assert.equal(semanticCalls,1);assert.equal(sent.length,1);assert.equal(reads,0);
 const output=published();for(const fact of translations)assert.ok(output.includes(fact),output);assert.equal(output.includes(localizedQuestion),false);
 const publication=decisionEvents.filter(e=>e.stage==='publication').at(-1);assert.equal(publication.publishableUnits,3);assert.equal(publication.facets[0].status,'VERIFIED');
});


test('Bounded optional planner abort reaches mocked OpenAI SDK; late completion cannot send',async t=>{
 await install(t);const fixture=deps.geminiGenerate!;
 const previous={AI_PROVIDER:process.env.AI_PROVIDER,OPENAI_API_KEY:process.env.OPENAI_API_KEY};Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-only'});
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 let aborted=false,completed=false,calls=0;
 t.mock.method(Responses.prototype,'create',async(p:any,options:any)=>{
  calls++;assert.ok(p.instructions.includes('retrieval query planner'));assert.ok(options.signal);
  options.signal.addEventListener('abort',()=>{aborted=true;},{once:true});
  await new Promise(r=>setTimeout(r,2800));completed=true;
  const result=await fixture({config:{systemInstruction:p.instructions,tools:[]},contents:[{parts:[{text:p.input[0].content}]}]});
  return{output_text:result.text,status:'completed',output:[],usage:{input_tokens:10,output_tokens:10}} as any;
 });
 await inbound('whatsapp','Could you tell me about parking arrangements at AdMotion Studio?');
 assert.equal(aborted,true);assert.equal(completed,false);assert.equal(sent.length,1);assert.equal(published().includes('Nordpark'),false);
 await new Promise(r=>setTimeout(r,400));assert.equal(completed,true);assert.equal(calls,1);assert.equal(sent.length,1);
});

for(const channel of channels)for(const variant of ['plain','prefixed','verifier-timeout'] as const)
 test(`greeting-regression/${channel}/${variant}: native adapter keeps original question and verification authority`,async t=>{
  const inboundQuestion=variant==='plain'?question:'Hi,'+question;
  await install(t,variant==='verifier-timeout'?'verification-timeout':'complete',channel);
  const fixture=deps.geminiGenerate!;const stages:string[]=[];
  configure({geminiGenerate:async p=>{
   const instruction=p.config.systemInstruction;
   assert.equal(instruction.includes('retrieval query planner'),false,'A literal location question with an optional greeting must not enter the timed planner');
   const payload=JSON.parse(p.contents[0].parts[0].text);
   if(instruction.includes('UNIT EXTRACTION')||instruction.includes('BATCH ENTAILMENT')){
    stages.push(instruction.includes('UNIT EXTRACTION')?'extraction':'verification');
    assert.equal(payload.question,inboundQuestion,'The original customer input remains authoritative');
    assert.equal(payload.facets[0].obligations[0].description,inboundQuestion);
   }
   const result=await fixture(p);
   if(instruction.includes('VERIFIED-UNIT PRESENTATION')&&variant==='prefixed'){
    assert.equal(payload.question,inboundQuestion);
    return{text:JSON.stringify({...JSON.parse(result.text),prefix:'greeting'})};
   }
   return result;
  }});
  await inbound(channel,inboundQuestion);assert.equal(sent.length,1);assert.equal(reads,0);
  assert.deepEqual(stages,['extraction','verification']);
  const output=published(),publication=decisionEvents.filter(e=>e.stage==='publication').at(-1);
  if(variant==='verifier-timeout'){
   assert.equal(output.includes('Nordpark'),false);assert.equal(publication.publishableUnits,0);
  }else{
   for(const fact of parkingFacts)assert.ok(output.includes(fact),output);
   assert.equal(publication.facets[0].status,'VERIFIED');
   if(variant==='prefixed')assert.ok(output.startsWith('Hello!'),output);
  }
 });

for(const channel of channels)for(const flag of [undefined,'false','true'] as const)test(`lexical-batch-dispatch/${channel}/${flag===undefined?'default':flag==='true'?'batch':'legacy'}: same selected evidence and verified answer`,async t=>{
 const enabled=flag==='true';
 const previous=process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH;
 if(flag===undefined)delete process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH;else process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH=flag;
 t.after(()=>{if(previous===undefined)delete process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH;else process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH=previous;});
 const f=await install(t,'complete',channel);const legacySearch=deps.knowledgeSearch!;
 const batch=KnowledgeService.prototype.searchLexicalQueries;let batchCalls=0,legacyCalls=0;let retrieval:any;
 t.mock.method(KnowledgeService.prototype,'searchLexicalQueries',async function(id,queries,limit,diagnostic){
  batchCalls++;assert.deepEqual(queries,[question,'park','car']);assert.equal(limit,5);
  return batch.call(f.service,id,queries,limit,diagnostic);
 });
 configure({knowledgeSearch:async(...args)=>{legacyCalls++;return legacySearch(...args);},knowledgeRetrievalDiagnostic:e=>{retrieval=e;}});
 await inbound(channel,question);assert.equal(sent.length,1);assert.equal(reads,0);
 assert.equal(batchCalls,enabled?1:0);assert.equal(legacyCalls,enabled?0:3);
 assert.equal(retrieval.mergeStrategy,'lexical_fallback');assert.equal(retrieval.queryCount,3);
 assert.deepEqual([...new Set(retrieval.sourceIds)],['exact-pdf','generic-txt']);
 const extraction=requests.find(r=>r.config.systemInstruction.includes('UNIT EXTRACTION'));
 const payload=JSON.parse(extraction.contents[0].parts[0].text);
 assert.ok(payload.evidence.some((e:any)=>e.text.includes('Kontakta företaget')),'Supplementary recommendation remains in selected evidence');
 for(const fact of parkingFacts)assert.ok(published().includes(fact));
 assert.equal(decisionEvents.filter(e=>e.stage==='publication').at(-1).facets[0].status,'VERIFIED');
});

for(const fault of ['delete','revision','publication-timeout','late-search','semantic-failure'])test(`lexical-batch-safety/${fault}: semantic fallback and final publication retain their guards`,async t=>{
 const previous=process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH;process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH='true';
 t.after(()=>{if(previous===undefined)delete process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH;else process.env.ODINLINK_KNOWLEDGE_LEXICAL_BATCH=previous;});
 const f=await install(t,fault==='semantic-failure'||fault==='late-search'?'complete':fault,'whatsapp');
 let elapsed=0;const epoch=Date.now();if(fault==='late-search')t.mock.method(Date,'now',()=>epoch+elapsed);
 const batch=KnowledgeService.prototype.searchLexicalQueries;
 t.mock.method(KnowledgeService.prototype,'searchLexicalQueries',async function(id,queries,limit,diagnostic){const sets=await batch.call(f.service,id,queries,limit,diagnostic);if(fault==='late-search')elapsed=21000;return sets;});
 if(fault==='semantic-failure')configure({semanticKnowledgeSearchQueries:async()=>{throw Error('synthetic unavailable semantic search');}});
 await inbound('whatsapp',question);assert.equal(sent.length,1);assert.equal(reads,0);
 if(fault==='semantic-failure')for(const fact of parkingFacts)assert.ok(published().includes(fact));
 else {assert.equal(published().includes('Nordpark'),false);if(fault!=='late-search')assert.equal(decisionEvents.filter(e=>e.stage==='publication').at(-1).publishableUnits,0);}
 if(fault==='late-search')assert.equal(requests.some(r=>r.config.systemInstruction.includes('UNIT EXTRACTION')||r.config.systemInstruction.includes('BATCH ENTAILMENT')),false,'Late retrieval cannot start model work');
});
