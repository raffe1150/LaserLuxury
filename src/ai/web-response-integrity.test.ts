import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { containsWebOperationSuccess } from './web-response-integrity';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';

const recorded = 'Your appointment must be cancelled at least 37 hours before the scheduled visit.';
const examples = [
  { language: 'en', policies: [recorded, 'You should cancel at least 37 hours before the visit.', 'You can cancel your appointment.', 'You must cancel at least 37 hours before the visit.', 'Your booking should be confirmed by reception.'], negatives: ['Your appointment has not been cancelled.', 'I have not cancelled your appointment.', 'Your booking is not confirmed.'], completed: ['Your appointment has been cancelled.', 'I cancelled your appointment.', 'Your booking is confirmed.', 'I have successfully rescheduled your appointment.'] },
  { language: 'sv', policies: ['Din tid måste vara avbokad minst 37 timmar före besöket.', 'Du bör avboka minst 37 timmar före besöket.', 'Du kan avboka din tid.', 'Din bokning ska bli bekräftad av receptionen.'], negatives: ['Din tid är inte avbokad.', 'Jag har inte avbokat din tid.', 'Din bokning är inte bekräftad.'], completed: ['Din tid är avbokad.', 'Jag har avbokat din tid.', 'Din bokning är bekräftad.', 'Din tid är ombokad.'] },
  { language: 'de', policies: ['Ihr Termin muss storniert werden, mindestens 37 Stunden vor dem Besuch.', 'Sie sollten Ihren Termin mindestens 37 Stunden vor dem Besuch stornieren.', 'Sie können Ihren Termin stornieren.', 'Ihre Buchung sollte bestätigt werden.'], negatives: ['Ihr Termin wurde nicht storniert.', 'Ich habe Ihren Termin nicht storniert.', 'Ihre Buchung ist nicht bestätigt.'], completed: ['Ihr Termin wurde storniert.', 'Ich habe Ihren Termin storniert.', 'Ihre Buchung ist bestätigt.', 'Ihr Termin wurde verschoben.'] },
  { language: 'es', policies: ['Tu cita debe ser cancelada al menos 37 horas antes de la visita.', 'Deberías cancelar tu cita al menos 37 horas antes de la visita.', 'Puedes cancelar tu cita.', 'Tu reserva puede ser confirmada por recepción.'], negatives: ['Tu cita no ha sido cancelada.', 'No he cancelado tu cita.', 'Tu reserva no está confirmada.'], completed: ['Tu cita ha sido cancelada.', 'He cancelado tu cita.', 'Tu reserva está confirmada.', 'Tu cita ha sido reprogramada.'] },
  { language: 'fa', policies: ['نوبت شما باید حداقل ۳۷ ساعت پیش از مراجعه لغو شود.', 'بهتر است نوبت خود را حداقل ۳۷ ساعت پیش از مراجعه لغو کنید.', 'می‌توانید نوبت خود را لغو کنید.', 'رزرو باید تأیید شود.'], negatives: ['نوبت شما لغو نشده است.', 'من نوبت شما را لغو نکردم.', 'رزرو شما تأیید نشده است.'], completed: ['نوبت شما لغو شد.', 'من نوبت شما را لغو کردم.', 'رزرو شما تأیید شد.', 'وقت شما تغییر کرد.'] },
  { language: 'ar', policies: ['يجب أن يتم إلغاء الموعد قبل 37 ساعة على الأقل.', 'ينبغي إلغاء موعدك قبل 37 ساعة على الأقل.', 'يمكن إلغاء موعدك.', 'يجب أن يتم تأكيد الحجز.'], negatives: ['لم يتم إلغاء موعدك.', 'ما ألغيت موعدك.', 'موعدك ليس مؤكدًا.'], completed: ['تم إلغاء موعدك.', 'ألغيت موعدك.', 'تم تأكيد الحجز.', 'موعدك مؤكد.', 'تم تعديل موعدك.'] },
];

test('exact recorded English deadline is informational, not cancellation success', () => {
  assert.equal(containsWebOperationSuccess(recorded), false);
});
for (const text of ["Your appointment hasn't been cancelled.", 'Your booking isn’t confirmed.', 'نوبت باید لغو شده باشد.']) test(`local non-completion variant: ${text}`, () => {
  assert.equal(containsWebOperationSuccess(text), false);
  assert.equal(containsWebOperationSuccess(text + ' Your booking is confirmed.'), true);
});
for (const { language, policies, negatives, completed } of examples) {
  for (const policy of policies) test(`${language} modal policy: ${policy}`, () => assert.equal(containsWebOperationSuccess(policy), false));
  for (const negative of negatives) test(`${language} explicit non-success: ${negative}`, () => assert.equal(containsWebOperationSuccess(negative), false));
  for (const success of completed) test(`${language} completed action stays blocked: ${success}`, () => assert.equal(containsWebOperationSuccess(success), true));
  for (const separator of ['. ', '; ', ', ', '\n']) test(`${language} policy cannot conceal success across ${JSON.stringify(separator)}`, () => {
    for (const success of completed) {
      assert.equal(containsWebOperationSuccess(policies[0].replace(/\.$/u, '') + separator + success), true);
      assert.equal(containsWebOperationSuccess(success.replace(/\.$/u, '') + separator + policies[0]), true);
      assert.equal(containsWebOperationSuccess(negatives[0].replace(/\.$/u, '') + separator + success), true);
    }
  });
}
for (const text of [
  'Your appointment must be cancelled, and your booking is confirmed.',
  'Your appointment must be cancelled but I cancelled your appointment.',
  'Your appointment must be cancelled and is cancelled.',
  'Your booking is not only confirmed, your appointment has been cancelled.',
  'I cannot verify your booking, but your appointment is confirmed.',
  'Din tid måste vara avbokad och din bokning är bekräftad.',
  'Din tid måste vara avbokad och är avbokad.',
  'Ihr Termin muss storniert werden und Ihre Buchung ist bestätigt.',
  'Ihr Termin muss storniert werden und wurde storniert.',
  'Tu cita debe ser cancelada y tu reserva está confirmada.',
  'Tu cita debe ser cancelada y ha sido cancelada.',
  'نوبت باید لغو شود و رزرو شما تأیید شد.',
  'نوبت باید لغو شده باشد و لغو شد.',
  'يجب أن يتم إلغاء الموعد وتم تأكيد الحجز.',
  'Your appointment will be cancelled.',
  'Your booking may be confirmed; I have booked your appointment.',
  'You are all set. See you tomorrow!',
]) test(`affirmative/negation near-match stays blocked: ${text}`, () => assert.equal(containsWebOperationSuccess(text), true));

process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'synthetic-offline';
globalThis.fetch = async () => { throw Error('Offline integrity tests forbid network calls'); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => b.reset());

test('recorded deadline passes actual Website final publication after current same-tenant grounding (offline model)', async t => {
  b.reset();
  for (const method of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, method, () => undefined);
  const source = 'En bokad tid ska avbokas senast 37 timmar före besöket.';
  const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage, storage);
  const parsed = documentChunks([{ text: source, section: 'Policy' }], 'Synthetic.txt');
  await storage.create({ id: 'policy-A', businessId: 8801, type: 'document', status: 'ready', title: 'Synthetic', content: parsed.content, metadata: parsed.metadata, createdAt: '2026', updatedAt: '2026' });
  await storage.replaceChunks(8801, 'policy-A', parsed.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as any })));
  let verified = 0, freshness = 0;
  const forbidden = async () => assert.fail('Website policy answers cannot execute booking/calendar/analysis operations');
  b.configure({
    semanticLanguageResolver: async () => ({ language: 'en', confidence: 1 }),
    knowledgeSearch: (id, q, l) => service.search(id, q, l), semanticKnowledgeSearch: async () => [],
    validateKnowledgeMatches: async (id, matches) => { assert.equal(id, 8801); freshness++; return service.validateMatches(id, matches); },
    geminiGenerate: async (p: any) => { assert.equal(p.config.tools?.length || 0, 0); return { text: p.config.systemInstruction.includes('retrieval query planner') ? '{"canonicalMeaning":"cancellation deadline","queries":["avbokas"]}' : recorded }; },
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{ claim: recorded, candidateQuote: recorded, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true, evidence: [{ source: 'retrieved_knowledge', quote: source }] }] }),
    assessBusinessClaimEntailment: async request => { verified++; assert.ok(request.evidenceCorpus.includes(source)); return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
    calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden }, recordAppointment: forbidden, postProcess: forbidden,
  });
  const result = await b.promptAuditWeb({ chatId: 'recorded-policy', message: 'What cancellation deadline applies to my appointment?' }, { id: 8801, businessName: 'Synthetic Fjord Studio', language: 'en', services: [], systemPrompt: '' });
  assert.equal(result.status, 200); assert.equal(result.body.text, recorded);
  assert.equal(verified, 1); assert.ok(freshness >= 3);
});
