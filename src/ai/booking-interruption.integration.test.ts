import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from './business-information';
import { detectNormalizedIntent, normalizeBookingRequest, normalizeConversationText } from './booking-intelligence';
import { classifyMessagingIntent } from './channel-reliability';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { extractDocument } from '../knowledge/documents/extract';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const config = { id: '77', businessId: '77', businessName: 'Synthetic Studio', language: 'sv', timezone: 'Europe/Stockholm',
  systemPrompt: 'Synthetic business.', services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 30 }] };
const now = new Date('2026-10-15T09:00:00Z');
const start = '2026-10-19T12:00:00.000Z', end = '2026-10-19T12:30:00.000Z';
const fact = 'Den hemliga testkoden för detta företag är BLÅ-RÄV-742.';
const matrix = [
  { lang: 'sv', question: 'Hej! Vad är er testkod?', negative: 'Jag vill inte boka något just nu.', resume: 'Fortsätt min bokning.', book: 'Jag vill boka Video Consultation imorgon.', cancel: 'Jag vill avboka min tid.', move: 'Jag vill omboka min tid.' },
  { lang: 'en', question: 'What is your test code?', negative: "I don't want to book anything right now.", resume: "Let's continue the appointment we discussed earlier.", book: 'I want to book Video Consultation tomorrow.', cancel: 'Please cancel my appointment.', move: 'Please reschedule my appointment.' },
  { lang: 'de', question: 'Was ist Ihr Testcode?', negative: 'Ich möchte jetzt nichts buchen.', resume: 'Ich möchte die Buchung fortsetzen.', book: 'Ich möchte Video Consultation morgen buchen.', cancel: 'Ich möchte meinen Termin stornieren.', move: 'Ich möchte meinen Termin verschieben.' },
  { lang: 'es', question: '¿Cuál es su código de prueba?', negative: 'No quiero reservar nada ahora.', resume: 'Quiero continuar mi reserva.', book: 'Quiero reservar Video Consultation mañana.', cancel: 'Quiero cancelar mi cita.', move: 'Quiero cambiar mi cita.' },
  { lang: 'fa', question: 'کد آزمایشی شما چیست؟', negative: 'نمی‌خواهم الان چیزی رزرو کنم.', resume: 'می‌خواهم رزرو قبلی را ادامه دهم.', book: 'می‌خواهم برای فردا Video Consultation رزرو کنم.', cancel: 'می‌خواهم وقتم را لغو کنم.', move: 'می‌خواهم وقتم را تغییر دهم.' },
  { lang: 'ar', question: 'ما هو رمز الاختبار لديكم؟', negative: 'لا أريد حجز أي شيء الآن.', resume: 'أريد متابعة الحجز السابق.', book: 'أريد حجز Video Consultation غدا.', cancel: 'أريد إلغاء موعدي.', move: 'أريد تغيير موعدي.' },
];
const fail = async () => { throw Error('Unexpected operational side effect'); };
beforeEach(() => {
  b.reset();
  b.configure({ calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: fail, checkSlots: fail, insertAppointment: fail, deleteEvent: fail } as any,
    recordAppointment: fail, cancelAppointmentRow: fail, updateAppointmentRow: fail,
    postProcess: async () => undefined, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    knowledgeSearch: () => [], semanticKnowledgeSearch: () => [], geminiGenerate: async () => { throw Error('No paid generation'); },
    assessBusinessSupportGrounding: async () => null, assessBusinessClaimEntailment: async () => null });
});
function seed(id: string, channel: typeof channels[number], lang = 'sv', status = 'awaiting_time_selection', businessConfig = config) {
  b.seedPending(id, { bookingStateVersion: 3, businessId: businessConfig.id, platform: channel, userId: id,
    businessConfig, operation: 'new_booking', status, expectedInput: 'slot_selection', language: lang,
    service: 'Video Consultation', serviceId: 'video', durationMinutes: 30, selectedDate: '2026-10-19',
    offeredSlots: [start], ownedOfferedSlots: [{ businessId: businessConfig.id, platform: channel, userId: id, start, end,
      durationMinutes: 30, service: 'Video Consultation', serviceId: 'video', generatedAt: Date.now() }],
    ...(['awaiting_contact', 'failed_recoverable', 'awaiting_confirmation'].includes(status) ? { dateTime: start, selectedSlotEnd: end } : {}),
    ...(status === 'failed_recoverable' ? { failedStage: 'calendar', lastFailureStage: 'calendar', retryEligible: true } : {}) });
}
const turn = (id: string, channel: typeof channels[number], text: string, businessConfig = config) => b.turn({ sessionId: id,
  platformName: channel, recipientUserId: id, text, businessConfig, now });

for (const row of matrix) {
  test(`${row.lang}: negative intent never supplies service evidence; genuine booking remains actionable`, () => {
    const text = `${row.negative} ${row.question}`;
    assert.equal(isBusinessInformationQuestion(text), true);
    assert.equal(isExplicitBusinessActionRequest(text), false);
    assert.equal(detectNormalizedIntent(text), 'general_question');
    assert.equal(classifyMessagingIntent(text), 'normal');
    assert.equal(b.extractConcreteRequestedService(text), null);
    assert.equal(normalizeBookingRequest({ businessId: '77', channel: 'telegram', conversationKey: 'negative', inputMode: 'text', text: `${row.negative.replace(/[.!?؟]$/u, "")} Video Consultation`, timezone: 'Europe/Stockholm' }).service, undefined);
    assert.equal(detectNormalizedIntent(row.book), 'new_booking');
    assert.equal(isBusinessInformationQuestion(row.book), false);
  });
  for (const channel of channels) {
    test(`${channel}/${row.lang}: current question escapes pending booking; repeated questions stay read-only; explicit resume`, async () => {
      const id = `${channel}-${row.lang}`; seed(id, channel, row.lang);
      const before = b.pendingStateSnapshot(id);
      for (const text of [row.question, `${row.negative} ${row.question}`, row.question]) {
        const r = await turn(id, channel, text);
        assert.equal(r.handled, false, r.replies.join(' '));
        const info = b.businessInformationState(id);
        assert.ok(info, 'must reach authorized Knowledge path');
        assert.equal(info.question, normalizeConversationText(text));
        assert.equal(info.language, row.lang);
        assert.equal(r.pending.continuationPaused, true);
        for (const key of ['service', 'serviceId', 'status', 'ownedOfferedSlots', 'dateTime']) assert.deepEqual(r.pending[key], before[key], key);
        assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
      }
      const ambiguous = await turn(id, channel, 'yes');
      assert.equal(ambiguous.pending.continuationPaused, true);
      assert.equal(ambiguous.pending.dateTime, before.dateTime, 'yes cannot confirm a stale offer');
      assert.doesNotMatch(ambiguous.replies.join(' '), /[?؟]/u, 'give explicit resume instructions, not another yes/no loop');
      const repeatedAmbiguous = await turn(id, channel, 'yes');
      assert.equal(repeatedAmbiguous.pending.continuationPaused, true);
      assert.equal(repeatedAmbiguous.pending.dateTime, before.dateTime);
      const resume = await turn(id, channel, row.resume);
      assert.equal(resume.pending?.continuationPaused, undefined);
      assert.equal(resume.pending?.service, 'Video Consultation');
      assert.ok(resume.replies.length || !resume.handled);
    });
    test(`${channel}/${row.lang}: pause does not cancel an existing appointment`, async () => {
      const id = `pause-${channel}-${row.lang}`; seed(id, channel, row.lang, 'awaiting_contact');
      b.seedOwnedAppointment({ sessionId: id, platform: channel, userId: id, businessConfig: config,
        operation: 'cancellation', appointment: { id: 'real-synthetic', business_id: 77, service: 'Video Consultation', start_time: start, end_time: end } });
      const result = await turn(id, channel, row.negative);
      assert.equal(result.handled, true);
      assert.equal(result.pending?.dateTime, start);
      assert.ok(b.cancellationState(id), 'conversation stop must not consume cancellation confirmation');
      assert.equal(result.appointment?.id, 'real-synthetic');
    });
  }
}
for (const text of ["I don't want to book. What are your opening hours?", 'Actually, I have a question about your cancellation policy.',
  'Forget the booking for now. Do you offer parking?', 'What is the Wi-Fi password?']) {
  test(`information interruption: ${text}`, async () => {
    seed('info', 'telegram', 'en');
    const r = await turn('info', 'telegram', text);
    assert.equal(r.handled, false); assert.ok(b.businessInformationState('info'));
    assert.equal(detectNormalizedIntent(text), 'general_question');
  });
}
for (const status of ['awaiting_service', 'awaiting_time_selection', 'awaiting_contact', 'awaiting_confirmation', 'failed_recoverable']) {
  test(`${status}: question after Calendar failure/any booking phase keeps transaction inputs`, async () => {
    seed(status, 'telegram', 'sv', status);
    const before = b.pendingStateSnapshot(status);
    const result = await turn(status, 'telegram', matrix[0].question);
    assert.equal(result.handled, false);
    for (const key of ['status', 'dateTime', 'selectedSlotEnd', 'failedStage', 'ownedOfferedSlots', 'customerPhone']) assert.deepEqual(result.pending[key], before[key], key);
  });
}
for (const mode of ['semantic', 'lexical', 'missing', 'failure'] as const) {
  for (const active of [false, true]) test(`${mode}: TXT extraction → tenant-scoped retrieval → final grounding (${active ? 'booking detour' : 'fresh'})`, async () => {
    const storage = new InMemoryKnowledgeStorage();
    const extracted = documentChunks(await extractDocument(Buffer.from(fact), 'txt'), 'synthetic.txt');
    const doc: KnowledgeSource = { id: 'synthetic-doc', businessId: 77, type: 'document', status: 'ready', title: 'synthetic.txt',
      content: extracted.content, metadata: extracted.metadata, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    await storage.create(doc); await storage.create({ ...doc, id: 'foreign', businessId: 88, content: 'FOREIGN-CODE' });
    await storage.replaceChunks(77, doc.id, extracted.chunks.map((c: any, i: number) => ({ chunkIndex: i, content: c.content, metadata: c.metadata })));
    let embedded = 0;
    const vector = { provider: 'openai', model: 'synthetic-only', dimensions: 2, version: 1, values: [1, 0] };
    const service = new KnowledgeService(storage, storage, { supportsLocalSemanticSearch: true,
      embedQuery: async () => { if (mode === 'failure') throw Error('synthetic offline outage'); return vector; },
      embedDocuments: async texts => { embedded += texts.length; assert.ok(texts.every(t => !t.includes('FOREIGN'))); return texts.map(() => vector); } });
    const diagnostics: any[] = [];
    b.configure({
      knowledgeSearch: (id, q, limit) => mode === 'lexical' ? service.search(id, q, limit) : [],
      semanticKnowledgeSearch: (id, q, limit) => mode === 'semantic' || mode === 'failure' ? service.semanticSearch(id, q, limit) : [],
      validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches),
      knowledgeRetrievalDiagnostic: d => diagnostics.push(d),
      assessBusinessSupportGrounding: async request => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [{ claim: 'Testkoden är BLÅ-RÄV-742.', candidateQuote: request.candidateReply, claimKind: 'OTHER', requiresBusinessEvidence: true,
          supported: true, evidence: [{ source: 'retrieved_knowledge', quote: fact }] }] }),
      assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
    });
    const id = `retrieval-${mode}-${active}`; if (active) seed(id, 'telegram');
    const result = await turn(id, 'telegram', matrix[0].question);
    assert.equal(result.handled, false);
    const info = b.businessInformationState(id);
    assert.ok(info);
    assert.doesNotMatch(info.retrievedKnowledge, /FOREIGN/);
    const found = mode === 'semantic' || mode === 'lexical';
    assert.equal(info.retrievedKnowledge.includes('BLÅ-RÄV-742'), found);
    const d = diagnostics.at(-1); assert.ok(d);
    assert.equal(d.semanticMatchCount, mode === 'semantic' ? 1 : 0);
    assert.equal(d.lexicalMatchCount, mode === 'lexical' ? 1 : 0);
    assert.equal(d.mergeStrategy, mode === 'semantic' ? 'reciprocal_rank_fusion' : 'lexical_fallback');
    if (mode === 'semantic') assert.equal(embedded, 1, 'real local cosine search over stub vectors; never paid semantics');
    const answer = await b.finalizeGeneralAiReply(id, matrix[0].question, 'Testkoden är BLÅ-RÄV-742.', 'sv');
    assert.equal(answer.includes('BLÅ-RÄV-742'), found, answer);
    if (found) assert.deepEqual(b.geminiToolNames(id), [], 'document evidence grants no tools');
    if (!found) assert.match(answer, /kan inte|saknar|hittar|bekräfta/iu);
  });
}

test('pause survives scoped saved-state reload and never leaks to another channel or tenant', async () => {
  const { PendingLeadStore } = await import('../../tests/helpers/pending-lead-store');
  const store = new PendingLeadStore();
  b.configure({ supabaseClient: store });
  const id = 'persisted-customer'; seed(id, 'telegram');
  const before = b.pendingStateSnapshot(id);
  await turn(id, 'telegram', matrix[0].question);
  assert.equal(JSON.parse(store.rows[0].ai_summary!).continuationPaused, true);
  assert.equal(store.rows[0].business_id, '77');
  b.reset(); b.configure({ supabaseClient: store });
  const restored = await b.stateAuditRestore(id, 'telegram', config);
  assert.equal(restored.continuationPaused, true);
  assert.deepEqual(restored.ownedOfferedSlots, before.ownedOfferedSlots);
  assert.equal(await b.stateAuditRestore(id, 'whatsapp', config), null);
  assert.equal(await b.stateAuditRestore(id, 'telegram', { ...config, id: '88', businessId: '88' }), null);
  assert.equal(b.businessInformationState('other-channel'), null);
});

test('negated catalog label cannot become authoritative service evidence', () => {
  const otherConfig = { ...config, services: [...config.services, { id: 'photo', name: 'Photography', durationMinutes: 30 }] };
  for (const text of ["I don't want to book Video Consultation.", 'Jag vill inte boka Video Consultation.',
    'Ich möchte Video Consultation nicht buchen.', 'No quiero reservar Video Consultation.',
    'نمی‌خواهم Video Consultation رزرو کنم.', 'لا أريد حجز Video Consultation.']) {
    assert.equal(b.extractConcreteRequestedService(text), null);
    assert.notEqual(b.resolveAuthoritativeService(text, otherConfig).status, 'resolved', text);
  }
  const text = "I don't want to book Photography. Please book Video Consultation tomorrow.";
  assert.equal(isExplicitBusinessActionRequest(text), true);
  assert.equal(b.extractConcreteRequestedService(text), 'Video Consultation');
  const resolved = b.resolveAuthoritativeService(text, otherConfig);
  assert.equal(resolved.status, 'resolved');
  if (resolved.status === 'resolved') assert.equal(resolved.service.name, 'Video Consultation');
});

test('duplicate inbound pause is claimed once and cannot create a booking loop', async () => {
  const id = 'duplicate'; seed(id, 'telegram');
  const input = { sessionId: id, platformName: 'telegram' as const, recipientUserId: id, businessConfig: config,
    text: matrix[0].negative, eventId: 'synthetic-event', now };
  const first = await b.inboundTurn(input);
  const repeated = await b.inboundTurn(input);
  assert.equal(first.replies.length, 1);
  assert.equal(repeated.replies.length, 0);
  assert.equal(b.pendingStateSnapshot(id).continuationPaused, true);
});

test('an independent positive booking clause takes precedence over the negated service', async () => {
  const id = 'mixed-positive'; seed(id, 'telegram', 'en');
  const text = "I don't want to book Photography. Book Video Consultation tomorrow.";
  assert.equal(isExplicitBusinessActionRequest(text), true);
  assert.equal(isBusinessInformationQuestion(text), false);
  assert.equal(detectNormalizedIntent(text), 'new_booking');
  assert.equal(b.extractConcreteRequestedService(text), 'Video Consultation');
  const r = await turn(id, 'telegram', text);
  assert.notEqual(r.pending?.continuationPaused, true);
});

test('resume after an information detour preserves an exact selected slot and still collects missing contact', async () => {
  const id = 'selected-resume'; seed(id, 'telegram', 'en', 'awaiting_contact');
  await turn(id, 'telegram', 'What is your test code?');
  const r = await turn(id, 'telegram', "Let's continue my booking.");
  assert.equal(r.pending?.dateTime, start);
  assert.equal(r.pending?.selectedSlotEnd, end);
  assert.equal(r.pending?.continuationPaused, undefined);
  assert.equal(r.pending?.status, 'awaiting_contact');
  assert.match(r.replies.join(' '), /name|mobile|phone/iu);
});

for (const row of matrix) for (const channel of channels) {
  for (const [operation, text] of [['cancellation', row.cancel], ['reschedule', row.move]] as const) {
    test(`${channel}/${row.lang}: genuine ${operation} still reaches its guarded operation after pause`, async () => {
      const id = `${channel}-${row.lang}-${operation}`; seed(id, channel, row.lang);
      await turn(id, channel, row.negative);
      b.configure({ calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: async () => [],
        checkSlots: fail, insertAppointment: fail, cancelAppointment: fail, updateAppointment: fail },
        recordAppointment: fail, cancelAppointmentRow: fail, updateAppointmentRow: fail,
        postProcess: async () => undefined });
      const operationConfig = { ...config, allowCancellation: true, allowRescheduling: true };
      const result = await turn(id, channel, text, operationConfig);
      assert.equal(result.handled, true, result.replies.join(' '));
      assert.equal(result.operation.operation, operation, result.replies.join(' '));
      assert.equal(result.pending, null, 'explicit operation switch retires only the unfinished new-booking draft');
      assert.equal(result.appointment, null, 'no appointment has been selected or mutated');
    });
  }
}
