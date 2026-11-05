/** SCRIPTED judgments, real native channel publication; no provider or database traffic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { cancellationAspects } from './cancellation-information';
import { incidentFlags, incidentConfig, incidentChannels, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const sourceNotice = 'En bokad tid ska avbokas senast 91 timmar före besöket.';
const sourceFree = 'Avgiftsfri avbokning är möjlig minst 2 timmar före besöket.';
const rows = [
  { language: 'sv', question: 'Hur långt i förväg måste jag avboka min tid?', notice: 'Bokade tider måste avbokas minst 91 timmar före besöket.',
    hard: 'Bokade tider måste avbokas minst 2 timmar före besöket.', free: 'Avgiftsfri avbokning är möjlig minst 91 timmar före besöket.' },
  { language: 'de', question: 'Wie weit im Voraus muss ich meinen Termin stornieren?', notice: 'Termine müssen mindestens 91 Stunden vor dem Besuch storniert werden.',
    hard: 'Termine müssen mindestens 2 Stunden vor dem Besuch storniert werden.', free: 'Eine kostenlose Stornierung ist mindestens 91 Stunden vor dem Besuch möglich.' },
  { language: 'fa', question: 'چند ساعت قبل باید نوبت را لغو کنم؟', notice: 'نوبت باید حداقل ۹۱ ساعت پیش از مراجعه لغو شود.',
    hard: 'نوبت باید حداقل ۲ ساعت پیش از مراجعه لغو شود.', free: 'لغو رایگان حداقل ۹۱ ساعت پیش از مراجعه امکان‌پذیر است.' },
];
const modes = ['document_notice', 'configured_as_notice', 'document_window_as_notice', 'missing_notice', 'free_conflict', 'unknown'] as const;

for (const row of rows) for (const channel of incidentChannels) for (const feeEnabled of [true, false]) for (const mode of modes)
test(`SCRIPTED native ${channel}/${row.language}/fees=${feeEnabled}/${mode}`, async t => {
  b.reset();
  const saved = structuredClone(incidentConfig), replies: string[] = [];
  let operations = 0, entailments = 0, coverageCalls = 0;
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  const raw = { id: 3, language: row.language, allow_cancellation: true, cancellation_deadline_minutes: 120,
    cancellation_fee_enabled: feeEnabled, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK' };
  const config = b.promptAuditNormalize(raw);
  const source = mode === 'free_conflict' ? 'Avgiftsfri avbokning är möjlig minst 91 timmar före besöket.'
    : ['document_window_as_notice', 'missing_notice'].includes(mode) ? sourceFree : sourceNotice;
  const candidate = mode === 'free_conflict' ? row.free
    : ['configured_as_notice', 'document_window_as_notice'].includes(mode) ? row.hard : row.notice;
  const storage = new InMemoryKnowledgeStorage(), service = new KnowledgeService(storage, storage);
  const parsed = documentChunks([{ text: source }], 'Policy.txt');
  await storage.create({ id: 'policy', businessId: 3, type: 'document', status: 'ready', title: 'Policy.txt',
    content: parsed.content, metadata: parsed.metadata, createdAt: '2026', updatedAt: '2026' });
  await storage.replaceChunks(3, 'policy', parsed.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as any })));
  const forbidden = async () => { operations++; throw Error('Informational request must not access booking operations'); };
  try {
    Object.assign(incidentConfig, { id: 3, businessId: 3, services: [], systemPrompt: '', language: row.language,
      allowCancellation: true, cancellationDeadlineMinutes: 120, cancellationFeeEnabled: feeEnabled,
      cancellationFeeAmount: 250, cancellationFeeCurrency: 'SEK', cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }), loadCancellationConfig: async () => raw,
      knowledgeSearch: (id, _query, limit) => service.search(id, source, limit), semanticKnowledgeSearchQueries: async () => [],
      validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches, { strictSources: true, requireCompleteDocumentContext: true }),
      calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async p => p.config.systemInstruction.includes('retrieval query planner')
        ? { text: JSON.stringify({ canonicalMeaning: 'cancellation notice', queries: [source] }) } : { text: candidate },
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [{ claim: candidate, candidateQuote: candidate, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
          evidence: [{ source: mode === 'configured_as_notice' ? 'structured_business_config' : 'retrieved_knowledge',
            quote: mode === 'configured_as_notice' ? '"freeCancellationDeadlineMinutes": 120' : mode === 'missing_notice' ? sourceNotice : source }] }] }),
      assessBusinessClaimEntailment: async r => {
        if (!r.cancellationCoverage) { entailments++; return { relation: mode === 'unknown' ? 'UNKNOWN' : 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; }
        coverageCalls++;
        return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false,
          coverage: cancellationAspects.map(aspect => ({ aspect, status: aspect === 'advance_notice' ? 'covered' : 'not_requested', quote: candidate })) };
      },
    });
    await incidentInbound(b, channel, row.question);
    assert.equal(replies.length, 1);
    if (mode === 'document_notice') {
      assert.equal(replies[0], candidate, 'Separately evidenced notice is distinct from an optional fee window');
      assert.ok(entailments > 0); assert.equal(coverageCalls, 1);
    } else {
      assert.ok(!replies[0].includes(candidate), JSON.stringify({ mode, reply: replies[0] }));
      if (mode === 'configured_as_notice' || mode === 'missing_notice') assert.equal(entailments, 0);
    }
    assert.equal(operations, 0);
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});
