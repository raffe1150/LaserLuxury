/** Explicitly invoked local diagnostic. No production DB or channel credentials.
 * Only OpenAI traffic leaves this process; channel POSTs are intercepted. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { performance } from 'node:perf_hooks';
import { incidentFlags, incidentCorpus, incidentQuestions, incidentChannels, incidentInbound,
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
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin === 'https://api.openai.com' && ['/v1/responses', '/v1/embeddings'].includes(url.pathname)) {
    const body = JSON.parse(String(options?.body));
    // Matched comparison: reproduce the deployed verifier's implicit default.
    if (profile === 'baseline' && /BATCH ENTAILMENT/u.test(body.instructions || '')) delete body.reasoning;
    const started = performance.now();
    const response = await originalFetch(input, { ...options, body: JSON.stringify(body) });
    const result = await response.clone().json().catch(() => ({}));
    providerCalls.push({ kind: url.pathname.endsWith('embeddings') ? 'embedding' : body.instructions?.includes('UNIT EXTRACTION') ? 'extraction' :
      body.instructions?.includes('BATCH ENTAILMENT') ? 'verification' : body.instructions?.includes('query planner') ? 'planning' : 'other',
      model: body.model, reasoning: body.reasoning?.effort || 'default', durationMs: Math.round(performance.now() - started), status: response.status,
      requestChars: JSON.stringify(body).length, usage: result.usage,
      structuredText: (result.output_text || result.output?.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content || []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('') || '').slice(0, 16000) });
    return response;
  }
  replies.push(interceptedIncidentSend(input, options));
  return new Response(JSON.stringify({ ok: true, result: { message_id: replies.length }, message_id: 'intercepted', messages: [{ id: 'intercepted' }] }), { status: 200 });
};
const { priority1hUnifiedEngineTestBoundary: b } = await import('../server');
const { service, chunkCount } = await incidentCorpus(true);
let diagnostics: any[] = [], decisions: any[] = [];
const forbidden = async () => { throw new Error('Booking/calendar/notification operation forbidden in Knowledge diagnostics'); };
const configure = () => b.configure({ semanticLanguageResolver: async () => ({ language, confidence: 1 }),
  postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
  knowledgeSearch: (id, q, limit) => service.search(id, q, limit), knowledgeSourceLanguages: id => service.sourceLanguageHints(id),
  semanticKnowledgeSearchQueries: (id, queries, limit, options) => service.semanticSearchQueries(id, queries, limit, options),
  validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches, { strictSources: true, captureRevision: true }),
  evidenceFirstDiagnostic: event => diagnostics.push(event), evidenceFirstDecisionDiagnostic: event => decisions.push(event),
  calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
  recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
try {
  for (const selectedLanguage of multilingual ? Object.keys(locationQuestions) : ['en']) {
    language = selectedLanguage;
  for (const channel of fullMatrix ? incidentChannels : ['whatsapp'] as const) {
    for (const mode of fullMatrix ? ['fresh', 'sequence'] : ['fresh']) {
      b.reset(); configure(); b.promptAuditHistory(incidentSession(b, channel, '46700000001'), []);
      for (const question of (multilingual ? ['A'] : Object.keys(incidentQuestions)) as IncidentQuestion[]) {
        if (mode === 'fresh') { b.reset(); configure(); b.promptAuditHistory(incidentSession(b, channel, '46700000001'), []); }
        diagnostics = []; decisions = []; replies = []; const before = providerCalls.length;
        const started = performance.now(); let errorCategory: string | null = null;
        try { await incidentInbound(b, channel, multilingual ? locationQuestions[language] : incidentQuestions[question]); } catch (error) { errorCategory = error instanceof Error ? error.name : 'unknown'; }
        let passed = !errorCategory && replies.length === 1;
        try {
          if (!multilingual) assertIncidentAnswer(question, replies[0] || '');
          else {
            const reply = replies[0] || '';
            if (!/Stjärngatan\s+14/u.test(reply) || !/(?:five|fem|fünf|cinco|پنج|خمس|[5۵٥])/iu.test(reply) || !/(?:minut|دقیق|دقائق)/iu.test(reply)) passed = false;
          }
        } catch { passed = false; }
        if (!diagnostics.at(-1)?.completeness?.every((c: any) => c.status === 'VERIFIED')) passed = false;
        cases.push({ language, channel, mode, question, passed, errorCategory, elapsedMs: Math.round(performance.now() - started), replies,
          manifest: diagnostics.at(-1) || null, decisions, providerCalls: providerCalls.slice(before) });
        originalConsole.log(JSON.stringify({ progress: cases.length, channel, mode, question, passed, elapsedMs: cases.at(-1).elapsedMs }));
      }
    }
  }
  }
} finally {
  globalThis.fetch = originalFetch; Object.assign(console, originalConsole); b.reset();
  const report = { profile, provider: 'real OpenAI', model: 'gpt-5.6-luna', corpusChunks: chunkCount,
    outbound: 'intercepted', languageResolution: 'fixture selected language', database: 'in-memory synthetic tenant',
    asyncKnowledge: false, smartWaiting: false, passed: cases.filter(c => c.passed).length, total: cases.length, cases };
  const output = resolve(`docs/validation/p0-production-reliability-2026-10-22/real-${profile}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ profile, passed: report.passed, total: report.total, output, cases: cases.map(({ channel, mode, question, passed, elapsedMs, replies }) => ({ channel, mode, question, passed, elapsedMs, replies })) }));
  if (report.passed !== report.total) process.exitCode = 1;
}
