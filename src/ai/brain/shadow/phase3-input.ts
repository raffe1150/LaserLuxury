import type { Citation, FactProposal, TurnInput } from '../decide-turn';
import { tenantOf } from '../evaluation/corpus';
import { fact } from '../evaluation/facts';
import { loadSources, source } from '../evaluation/sources';
import type { EvalCase, Fact, Obligation, SourceRecord } from '../evaluation/types';

export const isAnswer = (o: Obligation) => o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE';
export const citationOf = (s: SourceRecord): Citation => ({ tenantId: s.tenantId, sourceId: s.sourceId, revision: s.revision });
export const currentRevisions = () => loadSources().filter(s => s.status === 'CURRENT').map(citationOf);

export function sourcePayload(f: Fact): string {
  if (!f.config) return f.quote!;
  const snapshot = JSON.parse(source(f.source).text);
  // Keep the service name, active status, currency and duration with the
  // configured field. A bare numeric value and array index lose that scope.
  const [index] = f.config.path;
  return JSON.stringify({ ...f.config, context: typeof index === 'number' ? snapshot[index] : undefined });
}

function asProposal(f: Fact): FactProposal {
  return { id: f.id, citation: citationOf(source(f.source)), proposition: {
    payload: sourcePayload(f), modality: f.modality, negated: f.negation, conditions: f.conditions ?? [],
  } };
}

/** Policy-only experiment. Phase 2 source-authored mappings provide upstream
 * obligation resolution and completeness. Never use these as recorded model
 * output or as accuracy measurements for planning/retrieval/verification.
 * Caller must validate the corpus and the pinned source/recording baseline.
 */
export function catalogInput(c: EvalCase): TurnInput {
  const idsFor = (o: Obligation) => [...o.facts, ...(o.expect === 'REFUSE_FOREIGN' ? o.foreignFacts ?? [] : [])];
  const ids = new Set(c.obligations.filter(o => o.expect !== 'CLARIFY').flatMap(idsFor));
  const proposals = [...ids].map(id => asProposal(fact(id)));
  return {
    tenantId: tenantOf(c.tenantId), currentRevisions: currentRevisions(),
    proposals, reviews: proposals.map(p => ({ ...p, entailment: 'ENTAILED' })),
    obligations: c.obligations.map(o => ({
      id: o.id,
      resolution: o.expect === 'ROUTE' ? 'BOOKING_ACTION' : o.expect === 'CLARIFY' ? 'AMBIGUOUS' : 'KNOWLEDGE',
      coverage: isAnswer(o) ? 'COMPLETE' : 'INCOMPLETE',
      conflict: c.evidenceProfile === 'CONFLICTING' && idsFor(o).some(id => source(fact(id).source).status === 'SYNTHETIC_NEGATIVE_CONTROL')
        ? 'CONFLICTING' : 'CLEAR',
      requiredFactIds: o.expect === 'CLARIFY' ? [] : idsFor(o),
      correctPremise: o.expect === 'CORRECT_PREMISE',
      route: o.route,
    })),
  };
}
