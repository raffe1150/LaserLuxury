import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Responses } from 'openai/resources/responses';
import { incidentFlags, incidentCorpus, incidentConfig, incidentQuestions, incidentChannels, incidentInbound, incidentSession,
  interceptedIncidentSend, assertIncidentAnswer, type IncidentQuestion } from '../../tests/helpers/p0-incident-knowledge';
import { hasForeignAddressPreposition } from './knowledge-prose-language';
import { documentKnowledgeTopicsEligible } from './knowledge-planning';
import { hasExternalConversationReference } from './conversation-intent-continuity';
import { compactFixture } from '../../tests/fixtures/knowledge-verification-protocol';
incidentFlags(); process.env.OPENAI_API_KEY = 'synthetic-offline-only'; process.env.ODINLINK_SMART_WAITING = 'false';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const { service } = await incidentCorpus();
let replies: string[], calls: any[], decisions: any[], leak: boolean;
const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
const facts: Record<IncidentQuestion, readonly [string, string][]> = {
  A: [['The Nordpark garage entrance is at Stjärngatan 14.', 'Garagets infart ligger på Stjärngatan 14 .'],
    ['It is approximately a five-minute walk from the studio.', 'Från garaget tar det ungefär fem minuter att gå till studions entré.']],
  B: [['You may bring one adult companion to the reception waiting room.', 'En kund får ta med sig en vuxen medföljande person till receptionens väntrum.'],
    ['Entering the treatment or work room requires separate staff approval.', 'Detta måste godkännas separat av personalen.']],
  C: [['AdMotion Studio does not provide free parking.', 'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.'],
    ['AdMotion Studio cannot reserve parking spaces.', 'AdMotion Studio erbjuder inte gratis parkering och kan inte reservera parkeringsplatser.']],
};
beforeEach((t: any) => {
  b.reset(); replies = []; calls = []; decisions = []; leak = false;
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: replies.length }, message_id: 'intercepted', messages: [{ id: 'intercepted' }] }), { status: 200 });
  });
  t.mock.method(Responses.prototype, 'create', async params => {
    const p: any = params, instruction = p.instructions, data = JSON.parse(p.input[0].content); calls.push(p);
    const text = data.question || '';
    const key: IncidentQuestion = text.includes('bring someone') ? 'B' : text.includes('reserve a parking') ? 'C' : 'A';
    const result = (value: any) => ({ output_text: JSON.stringify(value), output: [] }) as any;
    if (instruction.includes('query planner')) return result({ canonicalMeaning: text,
      // Deliberately reproduce the false model reference judgment for A.
      referenceResolution: key === 'A' ? 'UNRESOLVED' : 'NOT_REQUIRED', queries: ['parkering medföljande'], queryLanguages: [{ query: 'parkering medföljande', language: 'sv' }],
      requestKind: 'BUSINESS_INFORMATION', requestedFacets: [{ subject: 'studio', attribute: text, questionType: 'description', obligations: [{ description: text, questionType: 'description' }] }] });
    if (instruction.includes('UNIT EXTRACTION')) return result({ oversized: false, units: facts[key].map(([answer, quote], index) => {
      const evidence = data.evidence.find((e: any) => normalized(e.text).includes(quote));
      assert.ok(evidence, 'actual six-chunk corpus must supply the material quote');
      return { facetIds: data.facets.map((f: any) => f.id), subject: 'AdMotion Studio', predicate: 'states', value: answer,
        modality: key === 'B' ? 'permitted' : 'descriptive', negation: key === 'C', scope: 'studio', qualifiers: [], language: 'en',
        text: leak && index === 0 ? 'The address is på Stjärngatan 14.' : answer, evidenceRefs: [{ evidenceId: evidence.id, exactQuote: quote }] };
    }) });
    if (instruction.includes('BATCH ENTAILMENT')) {
      const value = { decisions: data.units.map((u: any) => ({ unitId: u.id, relation: 'ENTAILED', facetIds: u.facetIds,
        meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true,
        explicitAbsenceEvidence: true, negativeAbsence: u.negation })),
        coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
          materialUnitIds: data.units.map((u: any) => u.id), obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })) };
      return result(p.text?.format?.name?.includes('compact') ? compactFixture(value) : value);
    }
    if (instruction.includes('VERIFIED-UNIT PRESENTATION')) return result({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false });
    assert.fail('Unexpected unrestricted model request');
  });
  const forbidden = async () => assert.fail('Knowledge must not mutate or read calendars, bookings or notifications');
  b.configure({ semanticLanguageResolver: async () => ({ language: 'en', confidence: 1 }), postProcess: async () => {},
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    knowledgeSearch: (id, q, limit) => service.search(id, q, limit), semanticKnowledgeSearchQueries: async () => [],
    knowledgeSourceLanguages: id => service.sourceLanguageHints(id),
    validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches, { strictSources: true, captureRevision: true }),
    evidenceFirstDecisionDiagnostic: event => decisions.push(event),
    calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
  for (const channel of incidentChannels) b.promptAuditHistory(incidentSession(b, channel, '46700000001'), []);
});
afterEach(() => b.reset());

for (const channel of incidentChannels) {
  for (const key of Object.keys(incidentQuestions) as IncidentQuestion[]) test(`mocked ${channel}: fresh incident ${key}`, async () => {
    await incidentInbound(b, channel, incidentQuestions[key]);
    assert.equal(replies.length, 1); assertIncidentAnswer(key, replies[0]);
    assert.ok(decisions.some(e => e.stage === 'publication' && e.route === 'verified_manifest'));
    for (const request of calls) {
      assert.ok(!request.instructions.includes('query planner'), 'self-contained incident questions need no speculative planning call');
      if (/UNIT EXTRACTION|BATCH ENTAILMENT/u.test(request.instructions)) assert.deepEqual(request.reasoning, { effort: 'low' });
    }
  });
  test(`mocked ${channel}: A→B→C keeps latest question and independent evidence`, async () => {
    for (const key of Object.keys(incidentQuestions) as IncidentQuestion[]) {
      replies = []; await incidentInbound(b, channel, incidentQuestions[key]); assert.equal(replies.length, 1); assertIncidentAnswer(key, replies[0]);
      assert.equal(b.businessInformationState(incidentSession(b, channel, '46700000001'))?.question, incidentQuestions[key]);
    }
  });
  test(`mocked ${channel}: a self-contained question exits pending ambiguity`, async () => {
    await incidentInbound(b, channel, 'Can I reserve it there?');
    assert.match(replies.at(-1)!, /referring to/u); assert.equal(calls.length, 0);
    replies = []; await incidentInbound(b, channel, incidentQuestions.B); assertIncidentAnswer('B', replies.at(-1)!);
    assert.equal(b.businessInformationState(incidentSession(b, channel, '46700000001'))?.question, incidentQuestions.B);
  });
  test(`mocked ${channel}: local guard rejects Swedish glue even when model says languageCorrect`, async () => {
    leak = true; await incidentInbound(b, channel, incidentQuestions.A);
    assert.ok(replies.length); assert.doesNotMatch(replies.at(-1)!, /\bpå\s+Stjärngatan/u);
    assert.ok(decisions.some(e => e.reason === 'LOCAL_LANGUAGE'));
  });
}
test('location routing preserves structured contact, services and prices', () => {
  assert.equal(documentKnowledgeTopicsEligible(incidentQuestions.A), true);
  for (const text of ['What is your address?', 'What is your address and where is the parking garage?', 'What services do you offer?', 'What does parking cost?', 'What is the garage location and your phone number?'])
    assert.equal(documentKnowledgeTopicsEligible(text), false, text);
  assert.equal(hasExternalConversationReference(incidentQuestions.A), false);
  assert.equal(hasExternalConversationReference('Where is that garage, and how far is it from the studio?'), true);
  assert.equal(hasExternalConversationReference('Can I reserve it there?'), true);
});
for (const [language, reply] of [
  ['en', 'The Nordpark entrance is at Stjärngatan 14, a five-minute walk away.'],
  ['sv', 'Nordparks infart ligger på Stjärngatan 14, ungefär fem minuters promenad bort.'],
  ['de', 'Die Einfahrt liegt in der Stjärngatan 14, etwa fünf Gehminuten entfernt.'],
  ['es', 'La entrada está en Stjärngatan 14, a unos cinco minutos a pie.'],
  ['fa', 'ورودی Nordpark در Stjärngatan 14 است و حدود پنج دقیقه پیاده فاصله دارد.'],
  ['ar', 'يقع مدخل Nordpark في Stjärngatan 14، على بُعد نحو خمس دقائق سيرًا.'],
] as const) test(`${language}: correct address prose is unchanged`, () => {
  assert.equal(hasForeignAddressPreposition(reply, language), false);
  assert.equal(b.guardReply('address-' + language, reply, language), reply);
});
