import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { cancellationGroundingConfig, CANCELLATION_POLICY_GUIDANCE } from './cancellation-policy';
import { numericalConstraintSafe } from './numerical-constraints';
import { cancellationAspects } from './cancellation-information';
process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'synthetic-offline';
globalThis.fetch = async () => { throw Error('Policy grounding tests forbid provider and database network'); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => b.reset());
const source = 'En bokad tid ska avbokas senast 37 timmar före besöket.';
const config = { id: 8801, businessName: 'Synthetic Policy Audit', language: 'en', services: [], systemPrompt: '',
  allowCancellation: true, cancellationDeadlineMinutes: 1440, cancellationFeeEnabled: true, cancellationFeeAmount: 250, cancellationFeeCurrency: 'SEK' };
const cases = [
  ['en', 'What free-cancellation deadline applies to my appointment?', 'Free cancellation is available at least 24 hours before the visit.', 'Your appointment must be cancelled at least 24 hours before the visit.'],
  ['sv', 'Vilken tidsgräns gäller för avgiftsfri avbokning?', 'Avgiftsfri avbokning är möjlig minst 24 timmar före besöket.', 'Din tid måste avbokas minst 24 timmar före besöket.'],
  ['de', 'Welche Frist gilt für die kostenlose Stornierung meines Termins?', 'Eine kostenlose Stornierung ist mindestens 24 Stunden vor dem Besuch möglich.', 'Sie müssen mindestens 24 Stunden vor dem Besuch stornieren.'],
  ['es', '¿Qué plazo se aplica a la cancelación gratuita de mi cita?', 'La cancelación gratuita está disponible al menos 24 horas antes de la visita.', 'Debes cancelar al menos 24 horas antes de la visita.'],
  ['fa', 'مهلت لغو رایگان نوبت من چیست؟', 'لغو رایگان حداقل ۲۴ ساعت پیش از مراجعه امکان‌پذیر است.', 'نوبت باید حداقل ۲۴ ساعت پیش از مراجعه لغو شود.'],
  ['ar', 'ما مهلة الإلغاء المجاني لموعدي؟', 'الإلغاء المجاني متاح قبل 24 ساعة على الأقل.', 'يجب إلغاء الموعد قبل 24 ساعة على الأقل.'],
] as const;
const citation = { source: 'structured_business_config', quote: '"freeCancellationDeadlineMinutes": 1440' };
const coverage = (reply: string): any => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false,
  coverage: cancellationAspects.map(aspect => ({ aspect, status: aspect === 'fees_and_windows' ? 'covered' : 'not_requested', quote: reply })) });
for (const [language, , free, hard] of cases) {
  const snapshot = JSON.stringify({ cancellation: cancellationGroundingConfig(config) });
  test(`${language}: configured free window never entails a hard cutoff or mandatory notice`, () => {
    assert.equal(numericalConstraintSafe(free, free, [citation], snapshot), true);
    assert.equal(numericalConstraintSafe(hard, hard, [citation], snapshot), false);
    assert.equal(numericalConstraintSafe(free, hard, [citation], snapshot), false, 'Extractor cannot drop free qualifier');
    assert.equal(numericalConstraintSafe(hard, free, [citation], snapshot), false, 'Correct extracted meaning cannot rescue incorrect published meaning');
    const document = hard.replace(/24|۲۴/gu, language === 'fa' ? '۳۷' : '37');
    assert.equal(numericalConstraintSafe(document, document, [source], snapshot), true, 'A document-owned mandatory notice is distinct from a configured free-fee window');
    assert.equal(numericalConstraintSafe(free.replace(/24|۲۴/gu, language === 'fa' ? '۲۵' : '25'), free, [citation], snapshot), false);
  });
}
test('legacy ambiguous deadline JSON and document JSON cannot establish a hard prohibition', () => {
  const hard = cases[0][3];
  assert.equal(numericalConstraintSafe(hard, hard, [{ source: 'structured_business_config', quote: '"deadlineMinutes": 1440' }]), false);
  assert.equal(numericalConstraintSafe(cases[0][2], cases[0][2], [{ ...citation, source: 'retrieved_knowledge' }]), false);
});
for (const [language, text] of [
  ['en', 'You cannot cancel after the free cancellation window ends.'],
  ['sv', 'Du får inte avboka efter den avgiftsfria perioden.'],
  ['de', 'Sie können nach der kostenlosen Stornierungsfrist nicht mehr stornieren.'],
  ['es', 'No puedes cancelar cuando termina el período de cancelación gratuita.'],
  ['fa', 'بعد از مهلت لغو رایگان نمی‌توانید نوبت را لغو کنید.'],
  ['ar', 'لا يمكنك إلغاء موعدك بعد انتهاء فترة الإلغاء المجاني.'],
] as const) test(`${language}: a free-window mention cannot hide an invented cancellation prohibition`, () => {
  assert.equal(numericalConstraintSafe(text, text, [{ source: 'structured_business_config', quote: '"lateFeeEnabled": true' }],
    JSON.stringify({ cancellation: cancellationGroundingConfig(config) })), false);
});
test('fee-disabled or zero-window settings cannot invent a numeric free-cancellation cutoff', () => {
  for (const patch of [{ cancellationFeeEnabled: false }, { cancellationDeadlineMinutes: 0 }]) {
    const snapshot = JSON.stringify({ cancellation: cancellationGroundingConfig({ ...config, ...patch }) });
    assert.equal(numericalConstraintSafe(cases[0][2], cases[0][2], [citation], snapshot), false);
  }
});
test('disabled automation is a channel permission, not a hard business cutoff', () => {
  const text = 'You cannot cancel automatically through chat.';
  const snapshot = JSON.stringify({ cancellation: cancellationGroundingConfig({ ...config, allowCancellation: false }) });
  assert.equal(numericalConstraintSafe(text, text, [{ source: 'structured_business_config', quote: '"automaticCancellationEnabled": false' }], snapshot), true);
  assert.equal(numericalConstraintSafe(text, 'You cannot cancel.', [{ source: 'structured_business_config', quote: '"automaticCancellationEnabled": false' }], snapshot), false);
});
test('ordinary document notice, duration and manual Knowledge facts retain their existing verification contracts', () => {
  const doc = 'Cancel at least 37 hours before the visit.';
  assert.equal(numericalConstraintSafe(doc, doc, [source], JSON.stringify({ businessName: 'Synthetic' })), true);
  assert.equal(numericalConstraintSafe('Service lasts 45 minutes.', 'Service lasts 45 minutes.', ['"durationMinutes":45'], JSON.stringify({ cancellation: cancellationGroundingConfig(config) })), true);
  const service = 'Cancellation Consultation lasts 45 minutes.';
  assert.equal(numericalConstraintSafe(service, service, ['"durationMinutes":45'], JSON.stringify({ services: [{ name: 'Cancellation Consultation', durationMinutes: 45 }], cancellation: cancellationGroundingConfig(config) })), true);
});

async function publication(t: any, language: string, question: string, reply: string, mode = 'current') {
  b.reset(); for (const method of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, method, () => undefined);
  const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage, storage);
  const documentSource = mode === 'document-conflict' ? 'Avgiftsfri avbokning är möjlig minst 37 timmar före besöket.' : source;
  const parsed = documentChunks([{ text: documentSource, section: 'Policy' }], 'Synthetic.txt');
  await storage.create({ id: 'A', businessId: 8801, type: mode === 'manual' ? 'text' : 'document', status: 'ready', title: 'Synthetic',
    content: parsed.content, metadata: mode === 'manual' ? {} : parsed.metadata, createdAt: '2026', updatedAt: '2026' });
  await storage.replaceChunks(8801, 'A', parsed.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: mode === 'manual' ? {} : c.metadata as any })));
  let current: any = { ...config, language }; let assessments = 0, entailments = 0, freshness = 0;
  const forbidden = async () => assert.fail('Website information must remain tool-free');
  b.configure({ loadCancellationConfig: async id => { assert.equal(id, '8801'); return current; },
    semanticLanguageResolver: async () => ({ language, confidence: 1 }),
    knowledgeSearch: (id, q, l) => service.search(id, q, l), semanticKnowledgeSearch: async () => [],
    validateKnowledgeMatches: async (id, matches) => { freshness++; return service.validateMatches(id, matches); },
    geminiGenerate: async (p: any) => {
      assert.equal(p.config.tools?.length || 0, 0);
      if (p.config.systemInstruction.includes('retrieval query planner')) return { text: '{"canonicalMeaning":"cancellation policy","queries":["avbokas"]}' };
      assert.ok(p.config.systemInstruction.includes(CANCELLATION_POLICY_GUIDANCE));
      assert.ok(p.config.systemInstruction.includes('"freeCancellationDeadlineMinutes": 1440'));
      if (mode === 'generation-change') current = { ...current, cancellationDeadlineMinutes: 720 };
      if (mode === 'generation-disabled') current = { ...current, allowCancellation: false };
      if (mode === 'foreign-policy') current = { ...current, id: 8802 };
      if (mode === 'missing-policy') current = null;
      return { text: reply };
    },
    assessBusinessSupportGrounding: async () => { assessments++;
      return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{ claim: reply, candidateQuote: reply,
        claimKind: mode === 'document-conflict' ? 'OTHER' : 'NEGATIVE_ABSENCE', requiresBusinessEvidence: true, supported: true,
        evidence: mode === 'document-conflict' ? [{ source: 'retrieved_knowledge', quote: documentSource }] : [citation as any] }] }; },
    assessBusinessClaimEntailment: async r => { entailments++;
      if (r.cancellationCoverage) return coverage(reply);
      if (mode === 'verification-change') current = { ...current, cancellationFeeAmount: 500 };
      if (mode === 'local-update') b.cancellationPolicyUpdated(current);
      if (mode === 'delete') await storage.delete(8801, 'A');
      if (mode === 'revise') { const previous = (await storage.list(8801))[0]; await storage.create({ ...previous, content: previous.content + ' Changed revision.' }); }
      return { relation: mode === 'unknown' ? 'UNKNOWN' : 'ENTAILED', claimKind: r.claimKind, explicitAbsenceEvidence: mode !== 'unknown' }; },
    calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden }, recordAppointment: forbidden, postProcess: forbidden,
  });
  const result = await b.promptAuditWeb({ chatId: mode + '-' + language, message: question }, { ...config, language });
  return { result, assessments, entailments, freshness };
}
for (const [language, question, free, hard] of cases) {
  test(`${language}: current dashboard free policy survives conflicting uploaded 37-hour prose (offline providers)`, async t => {
    const r = await publication(t, language, question, free); assert.equal(r.result.body.text, free); assert.equal(r.entailments, 2); assert.ok(r.freshness >= 3);
  });
  test(`${language}: unsupported hard 24-hour answer fails before even a lying ENTAILED verifier`, async t => {
    const r = await publication(t, language, question, hard); assert.notEqual(r.result.body.text, hard); assert.equal(r.entailments, 0);
  });
  test(`${language}: actual 37-hour document claim cannot override the configured free-cancellation policy`, async t => {
    const document = free.replace(/24|۲۴/gu, language === 'fa' ? '۳۷' : '37');
    const r = await publication(t, language, question, document, 'document-conflict');
    assert.notEqual(r.result.body.text, document); assert.equal(r.entailments, 0);
  });
}
for (const mode of ['generation-change', 'generation-disabled', 'foreign-policy', 'missing-policy', 'verification-change', 'local-update', 'delete', 'revise', 'unknown'] as const) test(`${mode} during policy answering cannot publish a stale/unverified policy`, async t => {
  const r = await publication(t, 'en', cases[0][1], cases[0][2], mode); assert.notEqual(r.result.body.text, cases[0][2]); assert.doesNotMatch(r.result.body.text, /24|37|250/u);
});
test('manual Knowledge keeps current configured cancellation authority and tool restrictions', async t => {
  const r = await publication(t, 'en', cases[0][1], cases[0][2], 'manual'); assert.equal(r.result.body.text, cases[0][2]);
});


test('actual extraction and entailment prompts share the free-policy authority contract (offline SDK boundary)', async t => {
  b.reset(); for (const method of ['log','info','warn','error'] as const) t.mock.method(console, method, () => undefined);
  const instructions: string[] = [];
  const reply = cases[0][2];
  b.configure({ geminiGenerate: async (p: any) => {
    assert.equal(p.config.tools?.length || 0, 0);
    const instruction = p.config.systemInstruction; instructions.push(instruction);
    assert.ok(instruction.includes(CANCELLATION_POLICY_GUIDANCE));
    if (instruction.includes('business-response claim and citation extractor')) return { text: JSON.stringify({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [{ claim: reply, candidateQuote: reply, claimKind: 'NEGATIVE_ABSENCE', requiresBusinessEvidence: true, supported: true, evidence: [citation] }] }) };
    assert.match(instruction, /entailment gate/u);
    if (instruction.includes('coverage verifier')) return { text: JSON.stringify(coverage(reply)) };
    return { text: '{"relation":"ENTAILED","claimKind":"NEGATIVE_ABSENCE","explicitAbsenceEvidence":true}' };
  }});
  b.businessInformationState('prompt-policy', config, cases[0][1], 'en', source);
  assert.equal(await b.businessSupportGrounding('prompt-policy', cases[0][1], reply, 'en'), reply);
  assert.equal(instructions.length, 3);
});

for (const mode of ['current', 'foreign', 'missing', 'error'] as const) test(`authoritative ${mode} policy read is tenant-filtered, bounded and has no activeConfig fallback`, async t => {
  b.reset(); for (const method of ['log','info','warn','error'] as const) t.mock.method(console, method, () => undefined);
  const calls: any[] = [];
  const row = { id: mode === 'foreign' ? 8802 : 8801, allow_cancellation: true, cancellation_deadline_minutes: 1440,
    cancellation_fee_enabled: true, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK', timezone: 'Europe/Stockholm', google_calendar_id: null };
  const client = { from(table: string) {
    assert.equal(table, 'businesses'); const call: any = { table }; calls.push(call);
    const query = { select(columns: string) { call.columns = columns; assert.match(columns, /cancellation_deadline_minutes/u); return query; },
      eq(key: string, id: string) { assert.equal(key, 'id'); assert.equal(id, '8801'); call.id = id; return query; },
      abortSignal(signal: AbortSignal) { assert.equal(signal.aborted, false); call.bounded = true; return query; },
      async maybeSingle() { return { data: mode === 'missing' ? null : row, error: mode === 'error' ? { message: 'synthetic unavailable' } : null }; } };
    return query;
  } };
  b.promptAuditConfig({ id: 9999, allowCancellation: true, cancellationDeadlineMinutes: 9999 });
  b.configure({ supabaseClient: client,
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [{ claim: cases[0][2], candidateQuote: cases[0][2], claimKind: 'NEGATIVE_ABSENCE', requiresBusinessEvidence: true, supported: true, evidence: [citation as any] }] }),
    assessBusinessClaimEntailment: async r => r.cancellationCoverage ? coverage(cases[0][2]) : ({ relation: 'ENTAILED', claimKind: 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: true }),
  });
  b.businessInformationState('policy-read', config, cases[0][1], 'en', source);
  const answer = await b.businessSupportGrounding('policy-read', cases[0][1], cases[0][2], 'en');
  assert.equal(answer === cases[0][2], mode === 'current'); assert.ok(calls.length); assert.ok(calls.every(call => call.bounded));
});
