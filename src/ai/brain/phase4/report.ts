import { CORPUS, tenantOf } from '../evaluation/corpus';
import type { TurnFrame } from '../memory/turn-frame';
import { compare } from '../shadow/compare';
import { evaluateHeldOut } from './semantic-eval';
import { context, inventory, reviewed, scriptedCase } from './fixtures';
import { shadowTurn } from './pipeline';
import { evaluateRecovery, evaluateSafety } from './safety-eval';

export async function phase4Report() {
  const heldOut = await evaluateHeldOut();
  const previous = await compare();
  const scripted = [];
  for (const id of ['var-cmp-01-sv', 'rep-04'] as const) {
    const fixture = scriptedCase(id);
    const v1 = previous.cases.find(c => c.id === id)!;
    const v2 = await shadowTurn({ ...fixture, evidence: { inventory, initial: ([first]) => reviewed(first, fixture.unit) } });
    scripted.push({
      id, language: v1.language, interpretation: v2.semantic.interpretation,
      evidenceOrigin: id === 'rep-04' ? 'INDEPENDENTLY_REBOUND_RECORDED_UNIT' : 'SOURCE_CATALOG_FIXTURE',
      v1Oracle: v1.v1.oracle.map(o => ({ protocol: o.protocol, metrics: o.metrics.filter(m => m.startsWith('safe_partial:')), perObligation: o.perObligation.map(({ id, v1 }) => ({ id, v1 })) })),
      v2: v2.decision.obligations.map(o => ({ id: o.obligationId, outcome: o.outcome, reason: o.reason,
        facts: o.supportingFacts.map(f => ({ id: f.id, citation: f.citation, modality: f.proposition.modality })) })),
      binding: v2.bindings.map(b => ({ status: b.status, reason: b.reason })), safePartial: v2.decision.safePartial,
    });
  }
  const deterministic = [];
  for (const c of CORPUS) {
    let frame: TurnFrame | undefined;
    let final: Awaited<ReturnType<typeof shadowTurn>> | undefined;
    for (const [i, text] of c.turns.entries()) {
      final = await shadowTurn({ frame, text, context: { ...context, turn: i + 1, nowMs: context.nowMs + i * 1000,
        binding: { tenantId: tenantOf(c.tenantId), conversationId: c.id }, language: { deterministicLanguage: c.language } },
        evidence: { initial: () => ({ candidates: [], receipts: [] }) } });
      frame = final.semantic.frame;
    }
    const v2 = final!;
    const v1 = previous.cases.find(row => row.id === c.id)!;
    // A turn-level route signal does not establish semantic alignment of all
    // obligations. Expose both inventories for inspection without assuming IDs align.
    deterministic.push({ caseId: c.id, language: c.language, channelLabel: c.channel,
      v1: v1.v1.perObligation, v1Signals: v1.v1.signals,
      expected: c.obligations.map(o => ({ id: o.id, expectation: o.expect, questionType: o.questionType, route: o.route })),
      v2: v2.decision.obligations.map(o => ({ id: o.obligationId, outcome: o.outcome, route: o.route, reason: o.reason })),
      intent: v2.semantic.frame.currentIntent, guidance: v2.semantic.guidance,
      binding: v2.bindings.map(b => ({ status: b.status, reason: b.reason })),
    });
  }
  const languages = [...new Set(heldOut.map(row => row.language))];
  const byLanguage = Object.fromEntries(languages.map(language => {
    const h = heldOut.filter(r => r.language === language);
    const d = deterministic.filter(r => r.language === language);
    return [language, { heldOutTurns: h.length, exactInterpretations: h.filter(r => r.exactMatches).length,
      primaryIntentMatches: h.filter(r => r.primaryMatches).length, policyLanguageMatches: h.filter(r => r.languageMatches).length,
      phase2Cases: d.length,
      explicitClarificationCases: d.filter(r => r.expected.some(o => o.expectation === 'CLARIFY')).length,
      clarificationSignalOnExpectedCases: d.filter(r => r.expected.some(o => o.expectation === 'CLARIFY') &&
        r.v2.some(o => o.outcome === 'CLARIFY')).length,
      v1ClarificationSignalOnExpectedCases: d.filter(r => r.expected.some(o => o.expectation === 'CLARIFY') && r.v1Signals.clarification).length,
      v2HandoffWithoutExpectedRoute: d.filter(r => r.v2.some(o => o.outcome === 'HANDOFF' &&
        !r.expected.some(e => e.route === o.route))).length,
      v2ClarificationTurns: d.filter(r => r.v2.some(o => o.outcome === 'CLARIFY')).length,
      v2BookingHandoffTurns: d.filter(r => r.v2.some(o => o.outcome === 'HANDOFF')).length,
      v2AnswerTurnsWithoutReceipts: d.filter(r => r.v2.some(o => o.outcome === 'ANSWER')).length }];
  }));
  return {
    schema: 'odinlink-phase4-offline-v1',
    byLanguage, heldOut, scripted, deterministic, genuineSemanticModel: 'NOT_EVALUATED',
    phase2PolicyComparison: previous.summary.partial,
    recorded: previous.recordings.map(r => ({
      id: r.id, caseId: r.caseId, kind: r.kind, v1: r.v1, independentlyRebound: r.independentlyRebound,
      priorPolicyComparison: r.perObligation, safePartialOpportunity: r.safePartial,
    })),
    deliveries: previous.deliveries,
    historicalNegativeControls: previous.controls.map(c => ({ name: c.name, passed: c.passed })),
    bindingControls: await evaluateSafety(), recovery: await evaluateRecovery(),
  };
}
