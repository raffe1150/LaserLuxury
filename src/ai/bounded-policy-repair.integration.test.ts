import { ordinaryEntailmentPunctuationKey } from './claim-entailment-reuse';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { incidentFlags, incidentConfig, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { cancellationAspects, cancellationInformationNotice, cancellationCoverageNotice } from './cancellation-information';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import(process.env.BOUNDED_REPAIR_BASELINE_SERVER
  ? pathToFileURL(process.env.BOUNDED_REPAIR_BASELINE_SERVER).href : '../../server');
const rows = [
  ['en', 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?', 'You can cancel automatically through chat.', 'There is no late cancellation fee.', 'No advance cancellation notice is required.'],
  ['sv', 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?', 'Du kan avboka automatiskt via chatten.', 'Det finns ingen sen avbokningsavgift.', 'Ingen framförhållning krävs vid avbokning.'],
  ['de', 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?', 'Sie können automatisch über den Chat stornieren.', 'Es gibt keine Gebühr für eine späte Stornierung.', 'Für die Stornierung ist keine Vorankündigung erforderlich.'],
  ['es', '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?', 'Puedes cancelar automáticamente por el chat.', 'No hay cargo por cancelación tardía.', 'No se requiere aviso previo para cancelar.'],
  ['fa', 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟', 'می‌توانید نوبت را به صورت خودکار از طریق چت لغو کنید.', 'هزینه لغو دیرهنگام وجود ندارد.', 'برای لغو نوبت نیازی به اطلاع قبلی نیست.'],
  ['ar', 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟', 'يمكنك إلغاء الموعد تلقائياً عبر الدردشة.', 'لا توجد رسوم إلغاء متأخر.', 'لا يلزم إشعار مسبق لإلغاء الموعد.'],
] as const;
const scenarios = ['observed_contract', 'three_claims', 'many_claims', 'duplicates', 'missing_evidence', 'revoked_evidence',
  'settings_changed', 'foreign_evidence', 'numerical', 'overlap', 'broad_citation', 'broad_supported', 'negative_absence_missing',
  'qualifier_preserved', 'qualifier_removed', 'unlocatable_quote', 'unlocatable_unselected', 'unrequested_aspect', 'independent_original', 'complete'] as const;
const receipts: unknown[] = [];
for (const [language, compoundQuestion, baseChat, baseFee, bad] of rows)
for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const)
for (const scenario of scenarios) test(`bounded repair/${channel}/${language}/${scenario}`, async t => {
  b.reset(); const saved = structuredClone(incidentConfig);
  const replies: string[] = [], diagnostics: any[] = [], calls: any[] = [];
  let repairs = 0, calendarCalls = 0, repairStarted = false, current = true, changed = false;
  const extra = ['No cancellation restrictions apply.', 'All appointments are refundable.'];
  const qualified = ({ en: 'You can cancel through chat only after staff approval.', sv: 'Du kan avboka via chatten endast efter personalens godkännande.',
    de: 'Sie können nur nach Genehmigung des Personals über den Chat stornieren.', es: 'Puedes cancelar por el chat solo con la aprobación del personal.',
    fa: 'لغو نوبت از طریق چت فقط پس از تأیید کارکنان مجاز است.', ar: 'يمكنك إلغاء الموعد عبر الدردشة فقط بعد موافقة الموظفين.' })[language];
  const chat = scenario.startsWith('qualifier_') ? qualified : baseChat;
  const fee = scenario === 'complete' ? ({ en: 'Cancellation is free.', sv: 'Avbokning är avgiftsfri.', de: 'Stornierung ist kostenlos.',
    es: 'La cancelación es gratuita.', fa: 'لغو رایگان است.', ar: 'الإلغاء مجاني.' })[language] : baseFee;
  const completeQuestion = ({ en: 'Is cancellation free?', sv: 'Är avbokning avgiftsfri?', de: 'Ist die Stornierung kostenlos?',
    es: '¿La cancelación es gratuita?', fa: 'آیا لغو رایگان است؟', ar: 'هل الإلغاء مجاني؟' })[language];
  const deadlineQuestion = ({ en: 'How far in advance must I cancel?', sv: 'Hur långt i förväg måste jag avboka?', de: 'Wie weit im Voraus muss ich stornieren?',
    es: '¿Con cuánta antelación debo cancelar?', fa: 'چند ساعت قبل باید نوبت را لغو کنم؟', ar: 'كم ساعة قبل الموعد يجب إلغاء الحجز؟' })[language];
  const question = scenario === 'complete' ? completeQuestion : scenario === 'unrequested_aspect' ? deadlineQuestion : compoundQuestion;
  const notice = ({ en: 'You must cancel at least 24 hours before your appointment.', sv: 'Du måste avboka minst 24 timmar före besöket.',
    de: 'Sie müssen mindestens 24 Stunden vor dem Termin stornieren.', es: 'Debes cancelar al menos 24 horas antes de la cita.',
    fa: 'لغو نوبت باید حداقل ۲۴ ساعت قبل انجام شود.', ar: 'يجب إلغاء الموعد قبل 24 ساعة على الأقل.' })[language];
  // Reproduce the recorded control flow, not unavailable production wording:
  // three original atoms in one sentence, two entailed; then five repaired atoms.
  const original = scenario === 'complete' ? fee : scenario === 'independent_original' ? `${chat} ${fee} ${bad}` : `${chat.slice(0, -1)}; ${fee.slice(0, -1)}; ${bad}`;
  const repairFacts = scenario === 'three_claims' ? [bad, chat, fee] : scenario === 'many_claims'
    ? [...Array.from({ length: 18 }, (_, i) => `Unsupported policy statement ${String.fromCharCode(65 + i)}.`), chat, fee]
    : scenario === 'duplicates' ? [bad, chat, chat, chat, fee, fee, ...extra]
    : scenario === 'numerical' ? [notice, bad, extra[0], chat, fee]
    : scenario.startsWith('broad_') ? [chat, fee, bad, ...extra] : [bad, ...extra, chat, fee];
  const repair = [...new Set(repairFacts)].map(text => scenario === 'qualifier_removed' && text === chat ? baseChat : text).join(' ');
  const makeClaim = (text: string, quote = text) => ({ claim: text, candidateQuote: quote,
    requiresBusinessEvidence: true, supported: true,
    claimKind: text === chat || text === extra[1] ? 'OTHER' : 'NEGATIVE_ABSENCE',
    evidence: [{ source: text === chat && scenario.startsWith('qualifier_') ? 'retrieved_knowledge' : 'structured_business_config',
      quote: text === chat ? scenario.startsWith('qualifier_') ? qualified : '"automaticCancellationEnabled": true' : '"lateFeeEnabled": false' }] });
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (...args: any[]) => {
    if (args[0] === '[BusinessRecoveryDiagnostic]') diagnostics.push(JSON.parse(args[1]));
  });
  const forbidden = async () => { calendarCalls++; assert.fail('Information-only request reached Calendar or a booking write'); };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'synthetic' }] }));
  });
  try {
    const raw = { id: 77, language, allow_cancellation: true, cancellation_fee_enabled: false, cancellation_deadline_minutes: 1440 };
    const config = b.promptAuditNormalize(raw);
    Object.assign(incidentConfig, { language, services: [], systemPrompt: '', allowCancellation: config.allowCancellation,
      cancellationFeeEnabled: config.cancellationFeeEnabled, cancellationDeadlineMinutes: config.cancellationDeadlineMinutes,
      cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language, confidence: 1 }), loadCancellationConfig: async () => changed ? { ...raw, allow_cancellation: false } : raw,
      knowledgeSearch: async id => [{ businessId: id, sourceId: 'fixture-source', text: scenario.startsWith('qualifier_') ? qualified : 'Fictional studio information without cancellation terms.', score: 1, metadata: { source: 'document' } }],
      semanticKnowledgeSearchQueries: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches.filter(m => Number(m.businessId) === 77) : [],
      calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async p => {
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: question, queries: ['studio information'] }) };
        if (!p.config.systemInstruction.includes('COMPLETENESS REPAIR')) return { text: original };
        repairs++; repairStarted = true; return { text: repair };
      },
      assessBusinessSupportGrounding: async r => {
        assert.equal(String(r.businessId), '77');
        if (r.candidateReply === original) return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
          claims: scenario === 'complete' ? [makeClaim(fee)] : [makeClaim(chat, scenario === 'independent_original' ? chat : chat.slice(0, -1)),
            makeClaim(fee, scenario === 'independent_original' ? fee : fee.slice(0, -1)), makeClaim(bad)] } as any;
        return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: repairFacts.map(text => {
          const claim = makeClaim(text);
          if (scenario === 'missing_evidence' && text === chat) claim.evidence = [];
          if (scenario === 'foreign_evidence' && text === fee) claim.evidence = [{ source: 'retrieved_knowledge', quote: 'Foreign tenant secret: fee exemption.' }];
          if (scenario.startsWith('broad_')) claim.evidence = [{ source: 'structured_business_config', quote: r.structuredBusinessConfig }];
          if (scenario === 'unlocatable_unselected' && text === extra[1]) claim.candidateQuote = 'Invented quotation absent from candidate.';
          if (scenario === 'unlocatable_quote' && text === bad) claim.candidateQuote = 'Invented quotation absent from candidate.';
          if (scenario === 'overlap' && [chat, fee].includes(text)) claim.candidateQuote = repair;
          if (scenario === 'qualifier_removed' && text === chat) claim.candidateQuote = baseChat;
          return claim;
        }) } as any;
      },
      assessBusinessClaimEntailment: async r => {
        assert.equal(String(r.businessId), '77'); calls.push({ ...r, repairStarted });
        if (r.cancellationCoverage) return { relation: scenario === 'complete' ? 'ENTAILED' : 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
          coverage: cancellationAspects.map(aspect => ({ aspect, status: scenario === 'complete' && aspect === 'fees_and_windows' ? 'covered'
            : aspect === 'advance_notice' && scenario !== 'complete' ? 'missing' : 'not_requested', quote: scenario === 'complete' && aspect === 'fees_and_windows' ? fee : '' })) };
        if (repairStarted && scenario === 'revoked_evidence') current = false;
        if (repairStarted && scenario === 'settings_changed') changed = true;
        const rejected = repairStarted && (scenario === 'broad_citation' || scenario === 'qualifier_removed' && r.atomicClaim === chat) ||
          r.requireRequestedFact && scenario === 'unrequested_aspect';
        return { relation: !rejected && [chat, fee].includes(r.atomicClaim) ? 'ENTAILED' : 'UNKNOWN', claimKind: r.claimKind,
          explicitAbsenceEvidence: r.atomicClaim === fee && !(repairStarted && scenario === 'negative_absence_missing') };
      },
    });
    await incidentInbound(b, channel, question);
    assert.equal(replies.length, 1); assert.equal(calendarCalls, 0); assert.equal(repairs, ['complete', 'independent_original'].includes(scenario) ? 0 : 1);
    const diagnostic = diagnostics[0], reply = replies[0];
    receipts.push({ channel, language, scenario, reply, diagnostic, repairs, calendarCalls,
      repairVerifierCalls: calls.filter(c => c.repairStarted && !c.cancellationCoverage).length });
    if (process.env.BOUNDED_REPAIR_EXPECT_BASELINE) {
      assert.equal(diagnostic.counts.original_extraction?.claimCount ?? diagnostic.counts.single_policy.claimCount, 3);
      assert.equal(diagnostic.counts.single_policy.attemptedFacts, 2);
      assert.equal(diagnostic.counts.single_policy.acceptedFacts, 0);
      assert.equal(diagnostic.counts.single_policy.relevanceChecks, 0);
      assert.ok(diagnostic.decisions.some((d: any) => d.stage === 'single_policy' && d.reason === 'candidate_coverage'));
      assert.equal(diagnostic.counts.repair_extraction.claimCount, 5);
      assert.equal(diagnostic.recoveryReason, 'claim_count_limit');
      assert.equal(calls.filter(c => c.repairStarted && !c.cancellationCoverage).length, 0);
      assert.equal(reply, cancellationInformationNotice(language, 'unsupported_claims'));
    }
    // This customer-behavior assertion must fail on unmodified c12b4bf.
    const none = ['revoked_evidence', 'settings_changed', 'overlap', 'broad_citation', 'unlocatable_quote', 'unlocatable_unselected', 'unrequested_aspect'].includes(scenario);
    if (scenario === 'complete') assert.equal(reply, fee);
    else if (none) { assert.equal(reply.includes(chat), false, reply); assert.equal(reply.includes(fee), false, reply); }
    else {
      assert.equal(reply.includes(chat), !['missing_evidence', 'qualifier_removed'].includes(scenario), reply);
      assert.equal(reply.includes(fee), !['negative_absence_missing', 'foreign_evidence'].includes(scenario), reply);
      assert.ok(reply.includes(cancellationInformationNotice(language, 'incomplete_scope')), reply);
      const advanceLabel = cancellationCoverageNotice(language, [{ aspect: 'advance_notice', status: 'missing', quote: '' }]).split(':').at(-1)!.trim().replace(/\.$/u, '');
      assert.ok(reply.includes(advanceLabel), reply);
      assert.equal(reply.includes(cancellationInformationNotice(language, 'unsupported_claims')), false);
    }
    assert.equal(reply.includes(bad), false); assert.doesNotMatch(reply, /24|۲۴|٢٤|Foreign tenant secret/u);
    const repairCalls = calls.filter(c => c.repairStarted && !c.cancellationCoverage);
    assert.ok(repairCalls.length <= 12);
    assert.ok(new Set(repairCalls.map(c => c.atomicClaim)).size <= 3);
    if (scenario === 'numerical') assert.equal(repairCalls.some(c => c.atomicClaim === notice), false);
    if (repairStarted) for (const fact of [chat, fee]) if (reply.includes(fact)) {
      const priorReceipt = calls.find(c => !c.repairStarted && !c.requireRequestedFact && c.atomicClaim === fact &&
        ordinaryEntailmentPunctuationKey(c) && ordinaryEntailmentPunctuationKey(c) === ordinaryEntailmentPunctuationKey({ ...c, candidateQuote: fact }));
      assert.ok(repairCalls.some(c => c.atomicClaim === fact && !c.requireRequestedFact) ||
        priorReceipt && diagnostic.decisions.some((d: any) => d.reason === 'verified_result_reused'),
      'Published fact must pass ordinary entailment or reuse the same verified claim/citation/context receipt');
      assert.ok(repairCalls.some(c => c.atomicClaim === fact && c.requireRequestedFact), 'Published partial fact must pass requested-aspect verification');
    }
    if (['revoked_evidence', 'settings_changed'].includes(scenario)) assert.ok(diagnostic.decisions.some((d: any) => d.reason === 'freshness_failure'));
    if (['unlocatable_quote', 'unlocatable_unselected'].includes(scenario)) assert.ok(diagnostic.decisions.some((d: any) => d.reason === 'unsafe_quote'));
    if (scenario === 'overlap') assert.ok(diagnostic.decisions.some((d: any) => d.reason === 'overlapping_quotes'));
    if (scenario === 'observed_contract' && !process.env.BOUNDED_REPAIR_EXPECT_BASELINE) {
      assert.equal(diagnostic.counts.single_policy.acceptedFacts, 0);
      assert.equal(diagnostic.counts.single_policy.relevanceChecks, 0);
      assert.equal(diagnostic.counts.completeness_repair.acceptedFacts, 2);
      assert.equal(diagnostic.counts.completeness_repair.attemptedFacts, 3);
    }
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});
test.after(() => { if (process.env.BOUNDED_REPAIR_RECEIPT) writeFileSync(process.env.BOUNDED_REPAIR_RECEIPT, JSON.stringify(receipts)); });
