import { createHash } from 'node:crypto';
import type { TurnInput } from '../decide-turn';
import { fact } from '../evaluation/facts';
import { source } from '../evaluation/sources';
import type { Recorded } from '../evaluation/tier2';
import type { EvalCase } from '../evaluation/types';
import { catalogInput } from './phase3-input';

export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
type RecordedUnit = { id?: string; modality?: string; negation?: boolean; evidenceRefs?: { evidenceId: string; exactQuote: string }[] };

// Explicit source review of the unchanged German recorded extraction unit:
// "first visit", "about", the 10 minute offset, recommendation, and the
// preparation purpose all match the full Swedish source excerpt. The sibling
// units do not settle whether bringing anything is mandatory. This review
// rebinds only the arrival fact to the Phase 2 current snapshot; legacy wire
// IDs/versions alone would not prove current evidence. No reuse for other text.
const germanArrival = {
  replayId: 'rec-shared-core-de-20261022',
  stage: 'extraction',
  unitDigest: '8ec17f0a211f9e7dc8d143546bc1334fff09a25d02f74b00d7e57957f22e2d47',
  evidenceDigest: '050e6e04495d4d7d897eb50078b6ef89e42f53cc1ad5f79355964fb59939cab7',
  revision: 'f6dc3097f9363e7ffecf4fec1554477c09344f130dde479fa1fdcc64ffb508c8',
  factId: 't3.arrive-10',
} as const;

const singleSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

export function recordedInput(c: EvalCase, r: Recorded): { input: TurnInput; checks: unknown[]; independentlyRebound: string[] } {
  const base = catalogInput(c);
  const checks: unknown[] = [];
  const independentlyRebound = new Set<string>();
  for (const stage of ['extraction', 're_extraction'] as const) {
    const raw = r.outputs[stage];
    if (!raw) continue;
    const units: RecordedUnit[] = JSON.parse(raw).units ?? [];
    for (const [index, u] of units.entries()) {
      const hash = digest(u);
      const refs = (u.evidenceRefs ?? []).map(ref => {
        const e = r.evidence.find(e => e.id === ref.evidenceId);
        return { ref, e, exactInRecordedEvidence: !!ref.exactQuote && !!e?.text.includes(ref.exactQuote) };
      });
      const f = fact(germanArrival.factId);
      const s = source(f.source);
      const bound = c.id === r.caseId && r.id === germanArrival.replayId && stage === germanArrival.stage &&
        hash === germanArrival.unitDigest && s.revision === germanArrival.revision && s.status === 'CURRENT' &&
        s.tenantId === base.tenantId && r.businessId === c.tenantId &&
        u.modality === f.modality && u.negation === f.negation &&
        refs.length === 1 && refs.some(({ ref, e }) =>
          e?.businessId === r.businessId && digest(e) === germanArrival.evidenceDigest && !!f.quote &&
          singleSpaces(ref.exactQuote) === singleSpaces(f.quote) &&
          singleSpaces(e.text).includes(singleSpaces(ref.exactQuote)) && s.text.includes(f.quote));
      if (bound) independentlyRebound.add(f.id);
      checks.push({ stage, index, unitDigest: hash, modality: u.modality ?? null, negation: u.negation ?? null,
        citations: refs.map(({ e, ref, exactInRecordedEvidence }) => ({
          evidenceId: ref.evidenceId, businessId: e?.businessId ?? null, sourceId: e?.sourceId ?? null, version: e?.version ?? null,
          exactInRecordedEvidence,
        })), independentReview: bound ? 'REBOUND_TO_CURRENT_SNAPSHOT' : 'INDETERMINATE_NOT_INDEPENDENTLY_REBOUND',
        ...(bound ? { factId: f.id, conditions: f.conditions, currentRevision: s.revision, recordedQuoteMatch: 'WHITESPACE_ONLY_NORMALIZATION' } : {}) });
    }
  }
  // Neither coverage nor per-unit entailment from the recorded verifier
  // supplies the independent review. Retain its verdict only as a diagnostic.
  if (r.outputs.verification) {
    const data = JSON.parse(r.outputs.verification);
    checks.push({ stage: 'verification', outputDigest: digest(r.outputs.verification),
      recordedVerdicts: (data.decisions ?? []).map((d: { unitId: string; relation: string }) => ({ unitId: d.unitId, relation: d.relation })),
      usedAsIndependentReview: false });
  }
  return { checks, independentlyRebound: [...independentlyRebound],
    input: { ...base, proposals: base.proposals.filter(p => independentlyRebound.has(p.id)),
      reviews: base.reviews.filter(p => independentlyRebound.has(p.id)) } };
}
