import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { incidentChannels, incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { ACCEPTANCE_ROWS, type AcceptanceLanguage } from '../../tests/helpers/first-visit-acceptance-cases';
import { formatBusinessSupportVerificationUnavailable } from './business-information';
import { configureKnowledgeBudgetOwner, executeKnowledgeGeneration } from './knowledge-model-policy';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

// P0 2026-11-17 (Telegram, fa): a context sentence followed by two coordinated
// questions was collapsed into ONE literal obligation, and the turn-wide GUARD_12
// then denied every verified partial. OFFLINE end-to-end: real native adapters,
// planning, inventory, citation, coverage, GUARD_12 and publication. Provider
// stages are deterministic mocks. The verifier mock applies the source-exhaustive
// contract per obligation (it never marks a requirement complete from an
// optional/advisory fact, and never marks a compound obligation complete when
// any requested aspect is unestablished). No paid provider, network, DB or send.
// Production verifier protocol is source-exhaustive-v2; the -v2 wrapper file runs
// the same matrix under plain v2 (CONTEXTUAL_COMPOUND_PROTOCOL=v2).
const PROTOCOL = process.env.CONTEXTUAL_COMPOUND_PROTOCOL === 'v2' ? 'v2' : 'source-exhaustive-v2';
const SOURCE_EXHAUSTIVE = PROTOCOL === 'source-exhaustive-v2';
incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: PROTOCOL, ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false',
  ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'off', ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off', ODINLINK_HIERARCHICAL_SEARCH: 'off',
  KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED: 'false',
});
Object.assign(incidentConfig, { id: 3, businessId: 3 });
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const sources: KnowledgeSource[] = JSON.parse(readFileSync(new URL('../../tests/fixtures/admotion-mixed-inventory.json', import.meta.url), 'utf8')).sources
  .map((s: any) => ({ ...s, businessId: s.business_id, createdAt: s.created_at, updatedAt: s.updated_at }));
const ARRIVAL = /Kunder som besöker[^.]+cirka 10 minuter[^.]+\./u;
const CONFIRMATION = 'Ta gärna med din bokningsbekräftelse, digitalt eller på papper.';
const INSTRUCTIONS = /Om du har fått särskilda\s+förberedelseinstruktioner[^.]+\./u;
const FOOD = /Mat får inte förtäras[^.]+\./u;

type Row = { language: AcceptanceLanguage; question: string; arrival: string; bring: string; complete: string; canBring: string; notice: (label: string) => string; instructions: string; prohibited: string; unconditional: string; invented: string };
// Six-language equivalents of the exact incident message (fa is byte-for-byte).
const ROWS: readonly Row[] = [
  { language: 'fa', question: 'من برای اولین بار می‌خوام بیام. چند دقیقه قبل از وقت رزرو باید اونجا باشم و آیا لازم هست چیزی با خودم بیارم؟',
    arrival: 'چند دقیقه قبل از وقت رزرو باید اونجا باشم',
    bring: 'آیا لازم هست چیزی با خودم بیارم؟', complete: 'من برای اولین بار می‌خوام بیام. چند دقیقه قبل از وقت رزرو باید اونجا باشم و آیا می‌توانم تأییدیه رزرو را همراه داشته باشم؟',
    canBring: 'آیا می‌توانم تأییدیه رزرو را همراه داشته باشم؟', notice: t => `پاسخ کامل به «${t}» را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.`,
    instructions: 'اگر دستورالعمل آماده‌سازی خاصی دریافت کرده‌اید، باید آن را رعایت کنید.',
    prohibited: 'خوردن غذا در اتاق‌های درمان یا کار مجاز نیست.', unconditional: 'باید دستورالعمل‌های آماده‌سازی خاص را رعایت کنید.', invented: 'باید کارت شناسایی همراه داشته باشید.' },
  { language: 'ar', question: 'سآتي لأول مرة. كم دقيقة قبل موعدي يجب أن أصل، وهل أحتاج إلى إحضار أي شيء معي؟',
    arrival: 'كم دقيقة قبل موعدي يجب أن أصل',
    bring: 'هل أحتاج إلى إحضار أي شيء معي؟', complete: 'سآتي لأول مرة. كم دقيقة قبل موعدي يجب أن أصل، وهل يمكنني إحضار تأكيد الحجز؟',
    canBring: 'هل يمكنني إحضار تأكيد الحجز؟', notice: t => `لا يمكن تأكيد الإجابة الكاملة عن «${t}» من المعلومات المتاحة.`,
    instructions: 'إذا تلقيت تعليمات تحضير خاصة، فيجب عليك اتباعها.',
    prohibited: 'لا يُسمح بتناول الطعام في غرف العلاج أو العمل.', unconditional: 'يجب عليك اتباع تعليمات التحضير الخاصة.', invented: 'يجب عليك إحضار بطاقة الهوية.' },
  { language: 'sv', question: 'Jag kommer för första gången. Hur många minuter före min bokade tid ska jag komma, och behöver jag ta med mig något?',
    arrival: 'Hur många minuter före min bokade tid ska jag komma',
    bring: 'behöver jag ta med mig något?', complete: 'Jag kommer för första gången. Hur många minuter före min bokade tid ska jag komma, och får jag ta med min bokningsbekräftelse?',
    canBring: 'får jag ta med min bokningsbekräftelse?', notice: t => `Det fullständiga svaret på ”${t}” kan inte bekräftas utifrån den tillgängliga informationen.`,
    instructions: 'Om du har fått särskilda förberedelseinstruktioner inför ditt besök ska du följa dessa.',
    prohibited: 'Mat får inte förtäras i behandlings- eller arbetsrummen.', unconditional: 'Du ska följa särskilda förberedelseinstruktioner.', invented: 'Du måste ta med legitimation.' },
  { language: 'en', question: "I'm coming for the first time. How many minutes before my appointment should I arrive, and do I need to bring anything with me?",
    arrival: 'How many minutes before my appointment should I arrive',
    bring: 'do I need to bring anything with me?', complete: "I'm coming for the first time. How many minutes before my appointment should I arrive, and can I bring my booking confirmation?",
    canBring: 'can I bring my booking confirmation?', notice: t => `The full answer to “${t}” cannot be confirmed from the available information.`,
    instructions: 'If you have received special preparation instructions for your visit, you must follow them.',
    prohibited: 'Food may not be eaten in the treatment or work rooms.', unconditional: 'You must follow special preparation instructions.', invented: 'You must bring photo ID.' },
  { language: 'de', question: 'Ich komme zum ersten Mal. Wie viele Minuten vor meinem Termin sollte ich da sein, und muss ich etwas mitbringen?',
    arrival: 'Wie viele Minuten vor meinem Termin sollte ich da sein',
    bring: 'muss ich etwas mitbringen?', complete: 'Ich komme zum ersten Mal. Wie viele Minuten vor meinem Termin sollte ich da sein, und darf ich meine Buchungsbestätigung mitbringen?',
    canBring: 'darf ich meine Buchungsbestätigung mitbringen?', notice: t => `Die vollständige Antwort auf „${t}“ kann anhand der verfügbaren Informationen nicht bestätigt werden.`,
    instructions: 'Wenn Sie besondere Vorbereitungshinweise erhalten haben, müssen Sie diese befolgen.',
    prohibited: 'In den Behandlungs- oder Arbeitsräumen darf nicht gegessen werden.', unconditional: 'Sie müssen besondere Vorbereitungshinweise befolgen.', invented: 'Sie müssen einen Lichtbildausweis mitbringen.' },
  { language: 'es', question: 'Voy a ir por primera vez. ¿Cuántos minutos antes de mi cita debo llegar y necesito llevar algo?',
    arrival: '¿Cuántos minutos antes de mi cita debo llegar',
    bring: 'necesito llevar algo?', complete: 'Voy a ir por primera vez. ¿Cuántos minutos antes de mi cita debo llegar y puedo llevar la confirmación de mi reserva?',
    canBring: 'puedo llevar la confirmación de mi reserva?', notice: t => `La respuesta completa a «${t}» no puede confirmarse con la información disponible.`,
    instructions: 'Si ha recibido instrucciones de preparación especiales, debe seguirlas.',
    prohibited: 'No se permite comer en las salas de tratamiento o de trabajo.', unconditional: 'Debe seguir instrucciones de preparación especiales.', invented: 'Debe traer un documento de identidad.' },
];
// Native intake normalizes Persian/Arabic question marks and ZWNJ before planning; labels are spans of that text.
const norm = (text: string) => text.replace(/\u200c/gu, ' ').replace(/؟/gu, '?');
const accepted = (row: Row) => ACCEPTANCE_ROWS.find(r => r.language === row.language)!;
const fallbackSubject = (row: Row) => accepted(row).fallbackSubject;

type Scenario = 'partial' | 'complete' | 'omitted' | 'contradicted' | 'required_beside_gap' | 'negated_beside_gap' |
  'prohibited_beside_gap' | 'condition_dropped' | 'unsupported_beside_gap' | 'unbound_citation';
type Outcome = { replies: string[]; stages: string[]; plannerCalls: number; facets: any[]; guards: unknown[]; publications: string[]; errors: unknown[] };

type Planner = (question: string) => unknown[];
async function run(t: TestContext, channel: IncidentChannel, row: Row, scenario: Scenario, turns = 1, opts: { question?: string; planner?: Planner } = {}): Promise<Outcome> {
  boundary.reset(); t.after(() => boundary.reset());
  for (const m of ['log', 'warn', 'error'] as const) t.mock.method(console, m, () => {});
  const storage = new InMemoryKnowledgeStorage();
  for (const s of sources) await storage.create(structuredClone(s));
  const service = new KnowledgeService(storage, storage, null);
  const owner = new ScriptedKnowledgeBudgetOwner(); owner.businessIds = [3];
  const previousModel = process.env.ODINLINK_AI_DEFAULT_MODEL;
  process.env.ODINLINK_AI_DEFAULT_MODEL = 'gpt-6.1-sol'; configureKnowledgeBudgetOwner(owner);
  t.after(() => { if (previousModel === undefined) delete process.env.ODINLINK_AI_DEFAULT_MODEL; else process.env.ODINLINK_AI_DEFAULT_MODEL = previousModel; configureKnowledgeBudgetOwner(); });
  const out: Outcome = { replies: [], stages: [], plannerCalls: 0, facets: [], guards: [], publications: [], errors: [] };
  t.mock.method(console, 'info', (label: unknown, value: any) => {
    if (label === '[EvidenceFirstDecision]') { const e = JSON.parse(value); (out as any).events = [...((out as any).events ?? []), [e.stage, e.reason, e.facetId, e.unitId, e.sourceCoverage?.guard, e.sourceCoverage?.failedChecks]]; if (e.stage === 'verification' && e.reason === 'INVALID_COVERAGE' && e.sourceCoverage) out.guards.push(e.sourceCoverage.guard); }
    if (label === '[KnowledgeModelRouting]') out.publications.push(JSON.parse(value).publication);
  });
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    out.replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }] }));
  });
  const forbidden = async () => { out.errors.push('unexpected action'); throw Error('offline'); };
  const a = accepted(row);
  const question = opts.question ?? (scenario === 'complete' ? row.complete : row.question);
  boundary.configure({
    offlineAi: true, structuredUnderstandingAdoptionRuntime: null, postProcess: async () => {},
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
    // Plain v2 declines the complete-inventory read by design (it requires a
    // source-exhaustive protocol). Offline search cannot cross languages, so v2
    // runs supply the same tenant's complete current corpus (perfect retrieval).
    knowledgeSearch: SOURCE_EXHAUSTIVE ? forbidden : async (id: number) => (await service.completeSmallCorpus(id, [], undefined, 'native-documentary')) ?? [],
    semanticKnowledgeSearchQueries: SOURCE_EXHAUSTIVE ? forbidden : async () => [],
    completeKnowledgeCorpus: (id: number, anchors: any, options: any, mode: any, decline: any) => service.completeSmallCorpus(id, anchors, options, mode, decline),
    knowledgeSourceLanguages: async () => [],
    validateKnowledgeMatches: (id: number, matches: any) => service.validateMatches(id, matches, { strictSources: true, requireCompleteDocumentContext: true }),
    aiGenerate: async (request: any) => {
      const respond = async () => {
        if (request.systemInstruction.includes('retrieval query planner')) {
          out.plannerCalls++;
          if (!opts.planner) throw Error('planner must not be needed');
          const asked = JSON.parse(request.messages[0].content).question;
          return { text: JSON.stringify({ requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: 'first visit arrival time and items to bring',
            referenceResolution: 'NOT_REQUIRED', queries: [asked.slice(0, 120)], queryLanguages: [{ query: asked.slice(0, 120), language: row.language }],
            requestedFacets: opts.planner(asked) }) };
        }
        const data = JSON.parse(request.messages[0].content);
        if (request.systemInstruction.includes('VERIFIED-UNIT PRESENTATION')) {
          out.stages.push('composition');
          return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
        }
        assert.ok(data.evidence.every((e: any) => e.businessId === 3), 'only same-tenant evidence reaches a provider');
        if (request.systemInstruction.includes('UNIT EXTRACTION')) {
          out.stages.push('extraction'); out.facets = data.facets;
          const [arrivalFacet, bringFacet] = data.facets;
          const find = (p: (text: string) => boolean) => data.evidence.find((e: any) => p(e.text));
          const arrivalItem = find(text => ARRIVAL.test(text)), confirmationItem = find(text => text.includes(CONFIRMATION));
          const unit = (facet: any, predicate: string, modality: string, text: string, evidenceId: string, quote: string, negation = false) => ({
            facetIds: [facet.id], subject: 'first-time visitors', predicate, value: quote, modality, negation, scope: 'first visit', qualifiers: [],
            language: row.language, text, evidenceRefs: [{ evidenceId, exactQuote: quote }] });
          const units = [unit(arrivalFacet, 'arrival timing', 'recommended', scenario === 'contradicted' ? a.wrong : a.digit, arrivalItem.id, arrivalItem.text.match(ARRIVAL)[0])];
          if (scenario !== 'omitted') units.push(unit(bringFacet, 'bringing booking confirmation', 'recommended', a.confirmation, confirmationItem.id, CONFIRMATION));
          if (scenario === 'required_beside_gap') { const item = find(text => INSTRUCTIONS.test(text)); units.push(unit(bringFacet, 'special preparation instructions', 'required', row.instructions, item.id, item.text.match(INSTRUCTIONS)[0])); }
          if (scenario === 'negated_beside_gap') units[1] = { ...units[1], negation: true };
          if (scenario === 'prohibited_beside_gap') { const item = find(text => FOOD.test(text)); units.push(unit(bringFacet, 'food in treatment rooms', 'prohibited', row.prohibited, item.id, item.text.match(FOOD)[0])); }
          // Condition omitted: the unit states the requirement without "if you have received …".
          if (scenario === 'condition_dropped') { const item = find(text => INSTRUCTIONS.test(text)); units.push(unit(bringFacet, 'special preparation instructions (unconditional)', 'required', row.unconditional, item.id, item.text.match(INSTRUCTIONS)[0])); }
          // Invented item: cites a real sentence that does not state it.
          if (scenario === 'unsupported_beside_gap') units.push(unit(bringFacet, 'photo ID', 'required', row.invented, confirmationItem.id, CONFIRMATION));
          // Citation not present in the bound source.
          if (scenario === 'unbound_citation') units.push(unit(bringFacet, 'photo ID', 'required', row.invented, confirmationItem.id, 'Ta med legitimation.'));
          return { text: JSON.stringify({ oversized: false, units }) };
        }
        assert.match(request.systemInstruction, /BATCH ENTAILMENT/u);
        out.stages.push('verification');
        // Per-unit entailment: only the faithful source wording is ENTAILED.
        const relation = (u: any) => u.text === a.wrong ? 'CONTRADICTED' : u.predicate === 'photo ID' ? 'UNKNOWN' : 'ENTAILED';
        const conditionsKept = (u: any) => u.predicate !== 'special preparation instructions (unconditional)';
        const entailed = (u: any) => relation(u) === 'ENTAILED' && conditionsKept(u);
        const decisions = data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: relation(u),
          meaningPreserved: relation(u) === 'ENTAILED', modalityPreserved: relation(u) === 'ENTAILED', qualifiersPreserved: conditionsKept(u), relevant: true, languageCorrect: true,
          negativeAbsence: false, explicitAbsenceEvidence: false }));
        const accepted = data.units.filter(entailed);
        // Per-obligation coverage by the source-exhaustive contract.
        const rows = data.facets.flatMap((f: any) => f.obligations.map((o: any) => {
          const inFacet = accepted.filter((u: any) => u.facetIds.includes(f.id));
          const bringingAspect = inFacet.length === 0 && data.units.some((u: any) => u.facetIds.includes(f.id)) ? false : true;
          // The source has a material "booking confirmation" proposition for the item facet.
          const omitted = f.id === data.facets[1].id && !inFacet.some((u: any) => /confirmation/u.test(u.predicate));
          if (omitted) return { f, o, state: 'AVAILABLE_SOURCE_FACT_OMITTED', units: inFacet };
          if (o.questionType === 'requirement') {
            const required = inFacet.filter((u: any) => u.modality === 'required');
            // A requirement is answered only by a source requirement about the asked item; none exists for "anything to bring".
            return { f, o, state: 'UNRESOLVED_REQUIREMENT', units: inFacet, cited: [] as any[], required };
          }
          return { f, o, state: inFacet.length && bringingAspect ? 'COMPLETE' : 'REQUESTED_INFORMATION_NOT_VERIFIED', units: inFacet, cited: inFacet };
        }));
        const ids = accepted.map((u: any) => u.id);
        return { text: JSON.stringify({ decisions,
          coverage: data.facets.map((f: any) => {
            const own = rows.filter((r: any) => r.f.id === f.id), complete = own.every((r: any) => r.state === 'COMPLETE');
            return { facetId: f.id, requestAligned: true, materialFactsComplete: complete,
              incompletenessReason: complete ? 'NONE' : own.some((r: any) => r.state === 'AVAILABLE_SOURCE_FACT_OMITTED') ? 'MISSING_RELEVANT_FACT' : 'UNRESOLVED',
              materialUnitIds: own[0].units.map((u: any) => u.id),
              obligations: own.map((r: any) => ({ obligationId: r.o.id, status: r.state === 'COMPLETE' ? 'COVERED' : 'UNRESOLVED', unitIds: (r.cited ?? []).map((u: any) => u.id) })) };
          }),
          sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true,
            availableMaterialFactsComplete: !rows.some((r: any) => r.state === 'AVAILABLE_SOURCE_FACT_OMITTED'), conditionsPreserved: true, conflictsAbsent: true,
            evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids,
            obligations: rows.map((r: any) => ({ facetId: r.f.id, obligationId: r.o.id, state: r.state })) } }) };
      };
      try {
        if (!request.knowledgeExecution) return { functionCalls: [], ...await respond() };
        const { response, usage } = await executeKnowledgeGeneration(request, { model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, instructions: request.systemInstruction,
          input: [{ role: 'user', content: request.messages[0].content }], text: { format: { type: 'json_schema', ...request.structuredOutput } } },
          async () => ({ ...await respond(), model: 'gpt-6.1-sol', service_tier: 'default', reasoning: { effort: 'low' }, prompt_cache_options: { mode: 'implicit', ttl: '30m' },
            usage: { input_tokens: 200, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
        return { text: response.text, knowledgeUsage: usage, functionCalls: [] };
      } catch (error) { out.errors.push(error); throw error; }
    },
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden,
  });
  for (let i = 0; i < turns; i++) await incidentInbound(boundary, channel, question);
  return out;
}

// Plain v2 renders its existing requirement-uncertainty copy instead of the scoped limitation.
const V2_REQUIREMENT: Record<AcceptanceLanguage, string> = {
  sv: 'Jag kan däremot inte bekräfta vilka krav som gäller.', en: 'However, I cannot confirm what is required.',
  de: 'Welche Anforderungen gelten, kann ich allerdings nicht bestätigen.', es: 'Sin embargo, no puedo confirmar qué se exige.',
  fa: 'با این حال، نمی‌توانم تأیید کنم چه الزاماتی وجود دارد.', ar: 'لكن لا أستطيع تأكيد المتطلبات.',
};
// RTL: the echoed fa/ar span keeps its Arabic-script question mark.
const echoed = (row: Row, label: string) => ['fa', 'ar'].includes(row.language) ? norm(label).replace(/\?/gu, '؟') : norm(label);
const limitation = (row: Row, label: string | null) => SOURCE_EXHAUSTIVE ? (label === null ? unconfirmedRequirement[row.language] : row.notice(echoed(row, label))) : V2_REQUIREMENT[row.language];
const partialAnswer = (row: Row, label: string | null = row.bring) => `${accepted(row).digit} ${accepted(row).confirmation}\n\n${limitation(row, label)}`;
const unavailable = (row: Row) => formatBusinessSupportVerificationUnavailable(row.language, fallbackSubject(row));

for (const row of ROWS) for (const channel of incidentChannels) {
  test(`${row.language}/${channel}: verified arrival + preparation fact, requirement stays explicitly unconfirmed`, async t => {
    const r = await run(t, channel, row, 'partial');
    assert.deepEqual(r.errors, []); assert.equal(r.plannerCalls, 0);
    assert.deepEqual(r.facets.map(f => [f.questionType, f.obligations.map((o: any) => [o.questionType, o.description])]),
      [['description', [['description', norm(row.arrival)]]], ['requirement', [['requirement', norm(row.bring)]]]]);
    assert.ok(r.facets.every(f => f.subject === norm(row.question.slice(0, row.question.indexOf('.') + 1))), 'shared context is preserved on every facet');
    assert.deepEqual(r.replies, [partialAnswer(row)]);
    assert.deepEqual(r.stages, ['extraction', 'verification']);
    assert.deepEqual(r.guards, []);
  });
  test(`${row.language}/${channel}: both questions independently complete -> complete answer`, async t => {
    const r = await run(t, channel, row, 'complete');
    assert.deepEqual(r.errors, []); assert.equal(r.plannerCalls, 0);
    assert.deepEqual(r.facets.map(f => f.questionType), ['description', 'description']);
    assert.deepEqual(r.replies, [`${accepted(row).digit} ${accepted(row).confirmation}`]);
  });
}

// Fail-closed outcomes stay byte-identical to the existing safe fallback; no partial leaks.
const closed: Record<Exclude<Scenario, 'partial' | 'complete' | 'required_beside_gap'>, string> = {
  omitted: 'GUARD_04', contradicted: 'PRECONDITION', negated_beside_gap: 'GUARD_12', prohibited_beside_gap: 'GUARD_12',
  condition_dropped: 'PRECONDITION', unsupported_beside_gap: 'PRECONDITION', unbound_citation: 'PRECONDITION',
};
// A verified conditional requirement ("if you received special instructions you
// must follow them") is published as itself beside the unresolved "anything to
// bring?" question; it never answers it, and the limitation is always rendered.
for (const row of ROWS) for (const channel of ['telegram', 'whatsapp'] as const)
  test(`${row.language}/${channel}/required_beside_gap: verified conditional requirement published as itself, gap stays explicit`, async t => {
    const r = await run(t, channel, row, 'required_beside_gap');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.replies, [`${accepted(row).digit} ${accepted(row).confirmation} ${row.instructions}\n\n${limitation(row, row.bring)}`]);
    assert.deepEqual(r.guards, []);
  });
for (const row of ROWS) for (const [scenario, guard] of Object.entries(closed) as [Scenario, string][]) for (const channel of ['telegram', 'whatsapp'] as const) {
  test(`${row.language}/${channel}/${scenario}: safe fallback, no partial publication (${guard})`, async t => {
    const r = await run(t, channel, row, scenario);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.replies, [unavailable(row)]);
    for (const text of [accepted(row).digit, accepted(row).confirmation, accepted(row).wrong, row.instructions, row.prohibited, row.unconditional, row.invented])
      assert.ok(!r.replies[0].includes(text), text);
    if (SOURCE_EXHAUSTIVE && guard !== 'PRECONDITION') assert.deepEqual(r.guards, [guard]);
    const rejected = ((r as any).events ?? []).filter((e: any[]) => e[3] && ['extraction', 'verification'].includes(e[0]) && e[1] !== 'ACCEPTED').map((e: any[]) => `${e[0]}:${e[1]}`);
    if (process.env.CONTEXTUAL_COMPOUND_TRACE) process.stderr.write(`TRACE ${row.language} ${scenario} ${JSON.stringify(rejected)}\n`);
    // The injected unit is rejected at unit level by the expected gate (not by an unrelated failure).
    const expectedRejection: Partial<Record<Scenario, string>> = { contradicted: 'extraction:NUMERICAL_CONSTRAINT',
      condition_dropped: 'verification:QUALIFIERS_CHANGED', unsupported_beside_gap: 'verification:UNKNOWN', unbound_citation: 'extraction:INVALID_CITATION' };
    if (expectedRejection[scenario]) assert.ok(rejected.length > 0 && rejected.every((x: string) => x === expectedRejection[scenario]), JSON.stringify(rejected));
  });
}

test('fa/telegram: repeating the exact incident message gives the same grounded answer and no booking action', async t => {
  const row = ROWS[0];
  const r = await run(t, 'telegram', row, 'partial', 2);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.replies, [partialAnswer(row), partialAnswer(row)]);
  assert.deepEqual(r.stages, ['extraction', 'verification', 'extraction', 'verification']);
});

test('fa: published answer never claims that nothing is required', async t => {
  const r = await run(t, 'telegram', ROWS[0], 'partial');
  assert.doesNotMatch(r.replies[0], /نیازی نیست|لازم نیست|لازم نمی|الزامی نیست|چیز دیگری لازم/u);
  assert.match(r.replies[0], /۱۰ دقیقه/u);
  assert.match(r.replies[0], SOURCE_EXHAUSTIVE ? /«آیا لازم هست چیزی با خودم بیارم؟»/u : /نمی‌توانم تأیید کنم چه الزاماتی/u);
});

// Context-free form of the incident (no introductory sentence). Before the fix the
// arrival-lead-time clause was not recognized as business information and the turn
// was routed to Booking ("Video Consultation ... which date?"). It now reaches the
// model planner (Knowledge), never a booking prompt or calendar action.
const CONTEXT_FREE = 'چند دقیقه قبل از وقت رزرو باید اونجا باشم؟ آیا لازم هست چیزی با خودم بیارم؟';
const spanPlanner: Planner = q => q.trim().split(/(?<=[?؟])\s+/u).map((span, i) => ({ subject: 'first visit', attribute: i ? 'items to bring' : 'arrival time',
  questionType: i ? 'requirement' : 'description', obligations: [{ description: span, questionType: i ? 'requirement' : 'description' }] }));
for (const channel of incidentChannels) test(`fa/${channel}: context-free incident question routes to Knowledge, not Booking`, async t => {
  const row = ROWS[0];
  const r = await run(t, channel, row, 'partial', 1, { question: CONTEXT_FREE, planner: spanPlanner });
  assert.deepEqual(r.errors, []);
  assert.equal(r.plannerCalls, 1);
  assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.doesNotMatch(r.replies[0], /قابل رزرو|برای چه تاریخی|رزرو کنید/u);
  assert.deepEqual(r.replies, [partialAnswer(row, 'آیا لازم هست چیزی با خودم بیارم؟')]);
});


// Model-planned forms (no introductory sentence, or a deictic "there" that needs
// reference resolution). A realistic planner paraphrases its labels; they are never
// echoed. The unresolved requirement gets fixed, fact-free copy instead.
const paraphrasePlanner: Planner = () => [
  { subject: 'first visit', attribute: 'recommended arrival time', questionType: 'description', obligations: [{ description: 'how early to arrive before the appointment', questionType: 'description' }] },
  { subject: 'first visit', attribute: 'items to bring', questionType: 'requirement', obligations: [{ description: 'whether anything must be brought', questionType: 'requirement' }] }];
const unconfirmedRequirement: Record<AcceptanceLanguage, string> = {
  en: 'I cannot confirm from the available information what, if anything, is required.',
  sv: 'Utifrån den tillgängliga informationen kan jag inte bekräfta om något krävs, och i så fall vad.',
  de: 'Anhand der verfügbaren Informationen kann ich nicht bestätigen, ob und was erforderlich ist.',
  es: 'Con la información disponible no puedo confirmar si se exige algo ni, en su caso, qué.',
  fa: 'بر اساس اطلاعات موجود نمی‌توانم تأیید کنم که آیا چیزی الزامی است یا نه.',
  ar: 'لا أستطيع أن أؤكد من المعلومات المتاحة ما إذا كان هناك أي شيء مطلوب.',
};
const THERE: Partial<Record<AcceptanceLanguage, string>> = {
  en: "I'm coming for the first time. How many minutes before my appointment should I be there, and do I need to bring anything with me?",
  sv: 'Jag kommer hit för första gången. Hur många minuter före min bokade tid ska jag vara där, och behöver jag ta med mig något?',
  es: 'Voy a ir por primera vez. ¿Cuántos minutos antes de mi cita debo estar allí y necesito llevar algo?',
  ar: 'سآتي لأول مرة. كم دقيقة قبل موعدي يجب أن أكون هناك، وهل أحتاج إلى إحضار أي شيء معي؟',
};
for (const row of ROWS) for (const channel of incidentChannels) {
  const forms = [['context-free', row.question.replace(/^[^.]+\.\s*/u, '')], ...(THERE[row.language] ? [['there', THERE[row.language]!]] : [])];
  for (const [form, question] of forms) test(`${row.language}/${channel}/${form}: model-planned compound question publishes verified facts with fixed requirement notice`, async t => {
    const r = await run(t, channel, row, 'partial', 1, { question, planner: paraphrasePlanner });
    assert.deepEqual(r.errors, []); assert.equal(r.plannerCalls, 1);
    assert.deepEqual(r.stages, ['extraction', 'verification']);
    assert.deepEqual(r.replies, [partialAnswer(row, null)]);
    assert.ok(!r.replies[0].includes('whether anything must be brought'), 'model-authored labels are never echoed');
  });
}

// The exception never asserts that nothing else is required, in any language/protocol.
const NOTHING_ELSE = /nothing else|no other|not required|no (?:further|additional)|inget annat|inga andra|krävs inte|nichts (?:anderes|weiter)|keine weiteren|nicht erforderlich|nada más|ningún otro|no se (?:exige|requiere)|چیز دیگری|لازم نیست|الزامی نیست|لا شيء آخر|غير مطلوب|لا يلزم/iu;
for (const row of ROWS) test(`${row.language}: no published partial claims that nothing else is required`, async t => {
  for (const scenario of ['partial', 'required_beside_gap'] as const) {
    const r = await run(t, 'telegram', row, scenario);
    assert.doesNotMatch(r.replies[0], NOTHING_ELSE);
    assert.ok(r.replies[0].includes(limitation(row, row.bring)), 'the requirement limitation is always rendered');
  }
});
