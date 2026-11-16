import {
  publishableKnowledgeManifest, type AnswerManifest, type AnswerUnit, type Evidence,
} from '../../business-information-answer-plan';
import { EVIDENCE_LIMITS, hashRecord, type Candidate, type Inventory, type Receipt, type Scope } from './bind';

/**
 * Phase 6A: pure translation of the existing product's attested, publishable
 * Knowledge manifest into Brain V2 evidence batches (`bind.ts` contract).
 *
 * The product's publication authority stays authoritative. This module never
 * judges entailment or coverage itself; it only re-expresses verdicts the
 * product already attested, and fails closed on anything it cannot prove.
 * It performs no provider, database, network, clock or logging side effects.
 *
 * - Authority: `publishableKnowledgeManifest` must accept the manifest for the
 *   exact tenant (it checks the product's in-process authority tokens).
 * - Obligations: the caller supplies explicit links from each Brain V2 scope to
 *   exactly one product obligation. Links must form a bijection over every
 *   product obligation, with identical question type and language.
 * - Coverage: only an obligation the product marked COVERED inside a VERIFIED,
 *   request-aligned, conflict-free facet becomes COMPLETE. Everything else,
 *   including partial facets and the zero-fact unresolved notice, is INCOMPLETE
 *   with no units, so Brain V2 can never bind it as a verified fact.
 * - Freshness: every cited chunk must be present, unchanged and tenant-scoped in
 *   the caller's current evidence, with one revision per source.
 */
export type ObligationLink = Readonly<{ scope: Scope; facetId: string; obligationId: string }>;
export type CurrentEvidence = Readonly<{ checkedAtMs: number; evidence: readonly Evidence[] }>;
export type V1BindingInput = Readonly<{
  tenantId: number;
  manifest: AnswerManifest | undefined;
  current: CurrentEvidence;
  links: readonly ObligationLink[];
}>;
export type V1BindingFailure =
  | 'INVALID_INPUT' | 'NOT_PUBLISHABLE' | 'TENANT_MISMATCH' | 'LANGUAGE_MISMATCH' | 'EVIDENCE_LIMIT'
  | 'STALE_OR_UNKNOWN_EVIDENCE' | 'AMBIGUOUS_SOURCE_REVISION' | 'UNKNOWN_FACET' | 'UNKNOWN_OBLIGATION'
  | 'QUESTION_TYPE_MISMATCH' | 'OBLIGATION_MAPPING_AMBIGUOUS' | 'OBLIGATION_MAPPING_INCOMPLETE'
  | 'UNVERIFIED_UNIT' | 'UNIT_REFERENCE_INVALID';
export type V1PublicationKind = 'VERIFIED' | 'QUALIFIED_PARTIAL' | 'UNRESOLVED_NOTICE';
export type V1BoundObligation = Readonly<{
  scopeObligationId: string; facetId: string; obligationId: string; coverage: Receipt['coverage'];
}>;
export type V1BindingResult =
  | Readonly<{ ok: true; publication: V1PublicationKind; inventory: Inventory; candidates: readonly Candidate[];
      receipts: readonly Receipt[]; obligations: readonly V1BoundObligation[] }>
  | Readonly<{ ok: false; reason: V1BindingFailure }>;

const failure = (reason: V1BindingFailure): V1BindingResult => Object.freeze({ ok: false as const, reason });
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function bindV1Manifest(input: V1BindingInput): V1BindingResult {
  const { tenantId, manifest, current, links } = input ?? ({} as V1BindingInput);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !manifest || !current || !Array.isArray(current.evidence) ||
      !Number.isSafeInteger(current.checkedAtMs) || current.checkedAtMs < 0 || !Array.isArray(links) || !links.length)
    return failure('INVALID_INPUT');
  // The product's own publication authority decides; nothing here re-verifies.
  if (!publishableKnowledgeManifest(manifest, tenantId)) return failure('NOT_PUBLISHABLE');
  if (current.evidence.length > EVIDENCE_LIMITS.chunks || links.length > EVIDENCE_LIMITS.receipts ||
      manifest.units.length > EVIDENCE_LIMITS.units) return failure('EVIDENCE_LIMIT');
  if (current.evidence.some(e => e.businessId !== tenantId) || links.some(l => l?.scope?.tenantId !== tenantId))
    return failure('TENANT_MISMATCH');
  if (links.some(l => l.scope.language !== manifest.language)) return failure('LANGUAGE_MISMATCH');

  // Current inventory: unique chunk ids and exactly one revision per source.
  const revisions = new Map<string, string>();
  for (const chunk of current.evidence) {
    if (!text(chunk.id) || !text(chunk.sourceId) || !text(chunk.chunkId) || !text(chunk.version)) return failure('INVALID_INPUT');
    const known = revisions.get(chunk.sourceId);
    if (known !== undefined && known !== chunk.version) return failure('AMBIGUOUS_SOURCE_REVISION');
    revisions.set(chunk.sourceId, chunk.version);
  }
  if (new Set(current.evidence.map(e => e.id)).size !== current.evidence.length) return failure('INVALID_INPUT');

  // Every published unit is product-verified and cites current tenant evidence.
  for (const unit of manifest.units) {
    if (unit.verification !== 'ENTAILED') return failure('UNVERIFIED_UNIT');
    if (!unit.evidenceRefs.length || unit.evidenceRefs.some(ref => !current.evidence.some(e => e.id === ref.evidenceId &&
        e.sourceId === ref.sourceId && e.chunkId === ref.chunkId && e.version === ref.version && e.text.includes(ref.exactQuote))))
      return failure('STALE_OR_UNKNOWN_EVIDENCE');
  }

  // Obligation links: a bijection over every product obligation.
  const productObligations = manifest.facets.flatMap(facet => facet.obligations.map(obligation => ({ facet, obligation })));
  const linkedKeys = links.map(l => l.facetId + '\u0000' + l.obligationId);
  if (new Set(links.map(l => l.scope.obligationId)).size !== links.length || new Set(linkedKeys).size !== links.length)
    return failure('OBLIGATION_MAPPING_AMBIGUOUS');
  for (const link of links) {
    const facet = manifest.facets.find(f => f.id === link.facetId);
    if (!facet) return failure('UNKNOWN_FACET');
    const obligation = facet.obligations.find(o => o.id === link.obligationId);
    if (!obligation) return failure('UNKNOWN_OBLIGATION');
    if (obligation.questionType !== link.scope.questionType) return failure('QUESTION_TYPE_MISMATCH');
  }
  if (productObligations.length !== links.length) return failure('OBLIGATION_MAPPING_INCOMPLETE');

  const units = new Map(manifest.units.map(unit => [unit.id, unit] as const));
  const candidates: Candidate[] = [];
  const receipts: Receipt[] = [];
  const obligations: V1BoundObligation[] = [];
  for (const link of links) {
    const outcomes = manifest.outcomes.filter(o => o.facetId === link.facetId);
    if (outcomes.length !== 1) return failure('OBLIGATION_MAPPING_AMBIGUOUS');
    const [outcome] = outcomes;
    const rows = outcome.obligations.filter(o => o.obligationId === link.obligationId);
    if (rows.length !== 1) return failure('OBLIGATION_MAPPING_AMBIGUOUS');
    const [row] = rows;
    const complete = row.status === 'COVERED' && outcome.status === 'VERIFIED' && outcome.requestAligned &&
      outcome.materialFactsComplete && row.unitIds.length > 0 && !manifest.unresolvedNoticeOnly;
    const boundUnits: AnswerUnit[] = [];
    if (complete) for (const id of row.unitIds) {
      const unit = units.get(id);
      if (!unit || !unit.facetIds.includes(link.facetId)) return failure('UNIT_REFERENCE_INVALID');
      boundUnits.push(unit);
    }
    if (complete && new Set(boundUnits.map(u => u.id)).size !== boundUnits.length) return failure('UNIT_REFERENCE_INVALID');
    candidates.push(Object.freeze({ obligationId: link.scope.obligationId, units: Object.freeze(boundUnits) }));
    receipts.push(Object.freeze({
      scope: link.scope, checkedAtMs: current.checkedAtMs,
      coverage: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const,
      conflict: outcome.status === 'CONFLICT' ? 'CONFLICTING' as const : 'CLEAR' as const,
      correctPremise: false,
      units: Object.freeze(boundUnits.map(unit => Object.freeze({
        id: unit.id, digest: hashRecord(unit), relation: 'ENTAILED' as const, modality: unit.modality, negated: unit.negation,
        conditions: Object.freeze([...unit.qualifiers]),
        citations: Object.freeze([...new Set(unit.evidenceRefs.map(ref => ref.evidenceId))].map(evidenceId => Object.freeze({
          evidenceId, digest: hashRecord(current.evidence.find(e => e.id === evidenceId)!) }))),
      }))),
    }));
    obligations.push(Object.freeze({ scopeObligationId: link.scope.obligationId, facetId: link.facetId,
      obligationId: link.obligationId, coverage: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const }));
  }
  const publication: V1PublicationKind = manifest.unresolvedNoticeOnly ? 'UNRESOLVED_NOTICE'
    : manifest.outcomes.every(o => o.status === 'VERIFIED') ? 'VERIFIED' : 'QUALIFIED_PARTIAL';
  return Object.freeze({
    ok: true as const, publication,
    inventory: Object.freeze({ tenantId, checkedAtMs: current.checkedAtMs,
      revisions: Object.freeze([...revisions].map(([sourceId, revision]) => Object.freeze({ sourceId, revision }))),
      chunks: Object.freeze([...current.evidence]) }),
    candidates: Object.freeze(candidates), receipts: Object.freeze(receipts), obligations: Object.freeze(obligations),
  });
}
