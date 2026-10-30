/** Explicitly invoked local diagnostic. No production DB or channel credentials.
 * Only OpenAI traffic leaves this process; channel POSTs are intercepted. */
import { sharedCorpus, sharedQuestions, assertSharedFacts,focusedSemanticChecklist } from '../tests/helpers/shared-core-incident';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {captureSyntheticVerifierRequest,captureSyntheticVerifierDecision,type SyntheticVerifierPolicy} from '../tests/helpers/semantic-verifier-diagnostics';
import {configuredServiceEvidence} from '../src/ai/configured-service-evidence';
import { incidentFlags, incidentConfig, incidentCorpus, incidentQuestions, incidentChannels, incidentInbound,
  interceptedIncidentSend, assertIncidentAnswer, incidentSession, type IncidentQuestion } from '../tests/helpers/p0-incident-knowledge';

const keyFile = process.env.ODINLINK_P0_KEY_FILE;
if (!keyFile) throw new Error('ODINLINK_P0_KEY_FILE must name a local credential file');
const key = parse(readFileSync(keyFile)).OPENAI_API_KEY;
if (!key) throw new Error('Credential file has no OpenAI key');
process.env.OPENAI_API_KEY = key; incidentFlags();
process.env.ODINLINK_SMART_WAITING = 'false';
const profile = process.env.ODINLINK_P0_PROFILE || 'candidate';
const fullMatrix = process.env.ODINLINK_P0_FULL_MATRIX === 'true';
const multilingual = process.env.ODINLINK_P0_MULTILINGUAL === 'true';
const verifierDiagnostics=process.env.ODINLINK_VERIFIER_DIAGNOSTICS==='true';
const selectedCases=process.env.ODINLINK_SHARED_CASES?.split(',');
if(verifierDiagnostics&&(!selectedCases||selectedCases.join(',')!=='en:1,de:0'||fullMatrix))throw Error('Verifier diagnostics are restricted to the two approved synthetic cases');
const allowedEvidence=new Set<string>();let currentQuestion='';
const diagnosticPolicy=():SyntheticVerifierPolicy=>({enabled:verifierDiagnostics,nodeEnv:process.env.NODE_ENV||'',question:currentQuestion,allowedEvidence,secrets:[key],
 structuredAuthority:{businessName:incidentConfig.businessName,timezone:incidentConfig.timezone,address:incidentConfig.address,
  services:incidentConfig.services.map((s:any)=>Object.fromEntries(Object.entries({name:s.name,durationMinutes:s.durationMinutes,price:s.price,currency:s.currency,active:s.active}).filter(([,v])=>v!==undefined))),workingHours:incidentConfig.workingHours}});
let language = 'en';
const locationQuestions: Record<string, string> = {
 en: incidentQuestions.A, sv: 'Var ligger Nordparks parkeringsgarage, och hur långt är det från studion?',
 de: 'Wo ist die Einfahrt zum Nordpark-Parkplatz, und wie weit ist es zu Fuß vom Studio?',
 es: '¿Dónde está ubicado el aparcamiento Nordpark y cuánto se tarda en caminar hasta el estudio?',
 fa: 'ورودی پارکینگ Nordpark کجاست و پیاده تا استودیو چقدر فاصله دارد؟',
 ar: 'أين يقع مدخل موقف Nordpark، وكم يبعد سيرًا عن الاستوديو؟',
};
const originalFetch = globalThis.fetch;
const originalConsole = { ...console };
for (const method of ['log', 'info', 'warn', 'error'] as const) console[method] = () => {};
const providerCalls: any[] = [], cases: any[] = []; let replies: string[] = [];
const sourceAwareRun=profile.startsWith('source-aware-');
const spendFile=resolve(`docs/validation/shared-core-2026-10-22/${sourceAwareRun?'source-aware-usage':'budget-resumed-usage'}.json`);
let caseStarted=performance.now();
// Local stop only; never touches the project's hard limit. Rates checked on the
// model's official card. Embeddings conservatively use the text input rate.
let spend: any;
try {spend=JSON.parse(readFileSync(spendFile,'utf8'));} catch {spend={calls:[],estimatedUsd:0,unmeteredReserveUsd:0};}
const saveSpend=()=>writeFileSync(spendFile,JSON.stringify(spend,null,2));
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin === 'https://api.openai.com' && ['/v1/responses', '/v1/embeddings'].includes(url.pathname)) {
    const body = JSON.parse(String(options?.body));
    if (!['gpt-5.6-luna','text-embedding-3-small'].includes(body.model)) throw new Error('Unbudgeted diagnostic model');
    if(spend.estimatedUsd+spend.unmeteredReserveUsd>=(sourceAwareRun?0.30:0.38))throw new Error('Local diagnostic spend cap reached');
    // Matched comparison: reproduce the deployed verifier's implicit default.

    const started = performance.now();
    const kind=url.pathname.endsWith('embeddings')?'embedding':body.instructions?.includes('UNIT EXTRACTION')?'extraction':body.instructions?.includes('BATCH ENTAILMENT')?'verification':body.instructions?.includes('query planner')?'planning':'other';
    let payload:any;
    try{payload=JSON.parse(body.input?.[0]?.content);}catch{}
    const verifierRequest=verifierDiagnostics&&kind==='verification'?captureSyntheticVerifierRequest(body,diagnosticPolicy()):undefined;
    const call:any={kind,model:body.model,reasoning:body.reasoning?.effort||'default',startedAfterCaseMs:Math.round(started-caseStarted),requestChars:JSON.stringify(body).length,
      instructionChars:body.instructions?.length||0,evidenceChars:payload?.evidence?.reduce((n:number,e:any)=>n+e.text.length,0),evidenceItems:payload?.evidence?.length,authorityScope:payload?.authorityScope,
      extractionEvidence:kind==='extraction'?payload?.evidence:undefined,verificationUnits:kind==='verification'?payload?.units:undefined,
      // This opt-in harness contains only synthetic tenant data. Preserve the
      // exact stage contract, not headers/credentials, for future disagreements.
      stageInput:['extraction','verification'].includes(kind)?payload:undefined,
      stageInstructions:['extraction','verification'].includes(kind)?body.instructions:undefined,
      stageInputSha256:payload&&['extraction','verification'].includes(kind)?createHash('sha256').update(JSON.stringify(payload)).digest('hex'):undefined,
      verifierRequest,requestBytesUnchanged:verifierRequest?String(options?.body)===JSON.stringify(body):undefined,
      status:null,structuredText:''};
    providerCalls.push(call);
    // Reserve unknown usage for aborted calls, which may still incur billing.
    spend.unmeteredReserveUsd+=0.02;saveSpend();
    let response:Response;
    try{response=await originalFetch(input, { ...options, body: JSON.stringify(body) });}
    catch(error){Object.assign(call,{durationMs:Math.round(performance.now()-started),errorKind:error instanceof Error?error.name:'unknown'});throw error;}
    const result = await response.clone().json().catch(() => ({}));
    const fullStructuredText=String(result.output_text||result.output?.filter((item:any)=>item.type==='message').flatMap((item:any)=>item.content||[]).filter((item:any)=>item.type==='output_text').map((item:any)=>item.text).join('')||'');
    let structuredText=fullStructuredText;
    if(structuredText.includes(key)){structuredText='';call.diagnosticFailure='UNKNOWN_SENSITIVE_OUTPUT_REJECTED';}
    if(verifierRequest){
      try{call.verifierDecisionWitness=captureSyntheticVerifierDecision(verifierRequest,structuredText,diagnosticPolicy());}
      catch{structuredText='';call.diagnosticFailure='UNKNOWN_OUTPUT_CAPTURE_REJECTED';}
    }
    if(result.usage){
      const usage=result.usage;
      const inputTokens=usage.input_tokens??usage.prompt_tokens??0;
      const outputTokens=usage.output_tokens??0;
      const cached=usage.input_tokens_details?.cached_tokens??0;
      const written=usage.input_tokens_details?.cache_write_tokens??0;
      const estimatedUsd=((inputTokens-cached-written)*0.2+cached*0.02+written*0.25+outputTokens*1.2)/1e6;
      spend.unmeteredReserveUsd-=0.02;spend.estimatedUsd+=estimatedUsd;
      spend.calls.push({profile,model:body.model,inputTokens,outputTokens,cached,estimatedUsd});saveSpend();
    }
    // Capture only the fictional, synthetic tenant's evidence actually sent to
    // extraction. This distinguishes wrong evidence IDs from fabricated quotes.
    const extractionEvidence = body.instructions?.includes('UNIT EXTRACTION')
      ? (body.input || []).flatMap((message: any) => (typeof message.content === 'string' ? [{text:message.content}] : message.content || []).flatMap((part: any) => {
          try { return JSON.parse(part.text || '{}').evidence || []; } catch { return []; }
        })) : undefined;
    Object.assign(call,{ kind: url.pathname.endsWith('embeddings') ? 'embedding' : body.instructions?.includes('UNIT EXTRACTION') ? 'extraction' :
      body.instructions?.includes('BATCH ENTAILMENT') ? 'verification' : body.instructions?.includes('query planner') ? 'planning' : 'other',
      model: body.model, reasoning: body.reasoning?.effort || 'default', durationMs: Math.round(performance.now() - started), status: response.status,
      requestChars: JSON.stringify(body).length, usage: result.usage, extractionEvidence,
      structuredText:structuredText.slice(0,16000),structuredTextComplete:structuredText===fullStructuredText&&fullStructuredText.length<=16000 });
    return response;
  }
  replies.push(interceptedIncidentSend(input, options));
  return new Response(JSON.stringify({ ok: true, result: { message_id: replies.length }, message_id: 'intercepted', messages: [{ id: 'intercepted' }] }), { status: 200 });
};
const { priority1hUnifiedEngineTestBoundary: b } = await import('../server');
const { service, storage, chunkCount, cleanup } = await sharedCorpus(true);
if(verifierDiagnostics){
 const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/admotion-production-document.json',import.meta.url),'utf8'));
 fixture.chunks.forEach((c:any)=>allowedEvidence.add(c.content));
 for(const source of await storage.list(77))allowedEvidence.add(source.content);
 allowedEvidence.add(configuredServiceEvidence(77,incidentConfig.services)!.text);
}
let diagnostics: any[] = [], decisions: any[] = [];
const forbidden = async () => { throw new Error('Booking/calendar/notification operation forbidden in Knowledge diagnostics'); };
const configure = () => b.configure({
  postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
  knowledgeSearch: (id, q, limit) => service.search(id, q, limit), knowledgeSourceLanguages: id => service.sourceLanguageHints(id),
  semanticKnowledgeSearchQueries: (id, queries, limit, options) => service.semanticSearchQueries(id, queries, limit, options),
  validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches, { strictSources: true, captureRevision: true }),
  evidenceFirstDiagnostic: event => diagnostics.push(event), evidenceFirstDecisionDiagnostic: event => decisions.push(event),
  calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
  recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
try {
  for (const selectedLanguage of (process.env.ODINLINK_SHARED_LANGUAGES?.split(',') || (fullMatrix ? Object.keys(sharedQuestions) : ['sv']))) {
    language = selectedLanguage;
    for (const channel of (process.env.ODINLINK_SHARED_CHANNELS?.split(',') || (fullMatrix ? incidentChannels : ['whatsapp'])) as typeof incidentChannels[number][]) {
      b.reset(); configure(); b.promptAuditHistory(incidentSession(b,channel,'46700000001'),[]);
      for (const [index, question] of sharedQuestions[language as keyof typeof sharedQuestions].entries()) {
        if(selectedCases&&!selectedCases.includes(`${language}:${index}`))continue;
        if (process.env.ODINLINK_SHARED_QUESTIONS && !process.env.ODINLINK_SHARED_QUESTIONS.split(',').includes(String(index))) continue;
        currentQuestion=question;
        b.reset(); configure(); b.promptAuditHistory(incidentSession(b,channel,'46700000001'),[]);
        diagnostics=[];decisions=[];replies=[];const before=providerCalls.length,started=performance.now();let errorCategory=null;
        caseStarted=started;
        try { await incidentInbound(b,channel,question); } catch(error) { errorCategory=error instanceof Error?error.name:'unknown'; }
        let passed=!errorCategory&&replies.length===1;
        try { assertSharedFacts(index,replies[0]||'',language); } catch { passed=false; }
        const minimumPassed=passed;
        const semanticChecks=sourceAwareRun?focusedSemanticChecklist(index,replies[0]||'',language):null;
        if(semanticChecks&&!Object.values(semanticChecks).every(Boolean))passed=false;
        cases.push({language,channel,questionIndex:index,question,passed,minimumPassed,semanticChecks,errorCategory,elapsedMs:Math.round(performance.now()-started),replies,
          manifest:diagnostics.at(-1)||null,decisions,providerCalls:providerCalls.slice(before)});
        writeFileSync(resolve(`docs/validation/shared-core-2026-10-22/checkpoint-${profile}.json`),JSON.stringify({profile,cases},null,2));
        originalConsole.log(JSON.stringify({language,channel,index,passed,elapsedMs:cases.at(-1).elapsedMs}));
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch; Object.assign(console, originalConsole); b.reset(); cleanup();
  const report = { profile, provider: 'real OpenAI', model: 'gpt-5.6-luna', corpusChunks: chunkCount,
    verifierDiagnostics,verifierContractChanged:false,witnesses:'Deterministic bindings and explicit flags only; semantic explanation and missing proposition UNKNOWN when not reported',
    outbound: 'intercepted', languageResolution: 'actual shared resolver', database: process.env.ODINLINK_SHARED_PG==='true'?'disposable PostgreSQL production lexical RPC plus in-memory canonical fixture':'in-memory synthetic tenant',
    asyncKnowledge: false, smartWaiting: false, passed: cases.filter(c => c.passed).length, total: cases.length, cases };
  const output = resolve(`docs/validation/shared-core-2026-10-22/real-${profile}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ profile, passed: report.passed, total: report.total, output, cases: cases.map(({ channel, mode, question, passed, elapsedMs, replies }) => ({ channel, mode, question, passed, elapsedMs, replies })) }));
  if (report.passed !== report.total) process.exitCode = 1;
}
