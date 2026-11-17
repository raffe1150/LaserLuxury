/**
 * Coverage decision observability (Unified Conversational Brain V2, Phase 1).
 *
 * Explains, without content, why source-exhaustive coverage accepted or denied
 * an answer. Decision authority stays exclusively with assessSourceCoverage(),
 * which is called unchanged and is never influenced by anything here. The
 * observer below re-reads the same inputs only to classify them; when its
 * classification does not reproduce the authoritative state it reports
 * consistent=false / UNCLASSIFIED instead of guessing. It never invents a
 * missing-condition explanation: per-obligation states are copied only when the
 * verifier returned a valid enum, otherwise they are INVALID/ABSENT.
 *
 * Privacy contract: enums, booleans, bounded counts and positional indices
 * only. No customer text, unit prose, source quotes, provider output, model- or
 * planner-chosen identifiers, or tenant identifiers (the host event envelope
 * already carries businessId). The serialized record is capped at
 * SOURCE_COVERAGE_DECISION_MAX_BYTES; detail arrays are dropped first.
 */
import { assessSourceCoverage, isSourceExhaustiveProtocol, scopedPartialModalityBlocked, SOURCE_COVERAGE_STATES, SOURCE_EXHAUSTIVE_PROTOCOL,
  type SourceCoverageAssessment, type SourceExhaustiveProtocol } from './source-exhaustive-coverage';
import type { AnswerUnit, Evidence, Facet } from './business-information-answer-plan';
import type { KnowledgeDecision } from './knowledge-answer-protocol';

export const SOURCE_COVERAGE_DECISION_SCHEMA = 'source-coverage-decision-v1' as const;
/** UTF-8 bytes of the serialized record. The bounded worst case fits; anything larger is truncated. */
export const SOURCE_COVERAGE_DECISION_MAX_BYTES = 3072;
const COUNT_CAP = 99;
const MAX_FACETS = 4, MAX_OBLIGATIONS_PER_FACET = 2;

// Local copies keep this module free of runtime import cycles; a test pins them
// to the protocol definitions.
export const RECORD_QUESTION_TYPES = ['description', 'recommendation', 'requirement', 'permission', 'prohibition'] as const;
export const RECORD_MODALITIES = ['descriptive', 'recommended', 'required', 'permitted', 'prohibited'] as const;
export const RECORD_RELATIONS = ['ENTAILED', 'UNKNOWN', 'CONTRADICTED', 'NOT_APPLICABLE'] as const;
export const RECORD_INCOMPLETENESS = ['NONE', 'MISSING_RELEVANT_FACT', 'MISSING_CONDITION', 'MISSING_RECOMMENDATION', 'UNRESOLVED'] as const;

export const SOURCE_COVERAGE_GUARDS = ['NONE', 'EARLY_STOP', 'PRECONDITION',
  'GUARD_01', 'GUARD_02', 'GUARD_03', 'GUARD_04', 'GUARD_05', 'GUARD_06', 'GUARD_07', 'GUARD_08', 'GUARD_09', 'GUARD_10',
  'GUARD_11', 'GUARD_12', 'UNCLASSIFIED'] as const;

/** Failure categories. GUARD_04 is split into every independently evaluated sub-check. */
export const SOURCE_COVERAGE_CHECKS = [
  // Backend inventory state before/without the coverage certificate.
  'PROPOSAL_PARSE_INCOMPLETE', 'EXTRACTION_INCOMPLETE', 'UNIT_CONFLICT', 'CATALOG_INCOMPLETE', 'UNIT_NOT_VERIFIED',
  // GUARD_01..03
  'PROTOCOL_UNSUPPORTED', 'INPUT_CONTRACT_INVALID', 'RESPONSE_SHAPE_INVALID',
  // GUARD_04 sub-checks
  'ASSESSMENT_SHAPE_INVALID', 'ASSESSMENT_PROTOCOL_MISMATCH', 'REQUEST_NOT_ALIGNED', 'AVAILABLE_FACTS_INCOMPLETE',
  'CONDITIONS_NOT_PRESERVED', 'CONFLICTS_PRESENT', 'EVIDENCE_INVENTORY_MISMATCH', 'UNIT_INVENTORY_MISMATCH',
  // GUARD_05..12
  'DECISION_INVENTORY_MISMATCH', 'UNIT_DECISION_REJECTED', 'OBLIGATION_INVENTORY_MISMATCH', 'LEGACY_COVERAGE_INVALID',
  'OBLIGATION_ROW_INVALID', 'COMPLETE_NOT_SUPPORTED', 'UNAVAILABLE_STATE_NOT_PERMITTED', 'PARTIAL_NON_DESCRIPTIVE_UNITS',
] as const;
export const GUARD_04_CHECKS = ['ASSESSMENT_SHAPE_INVALID', 'ASSESSMENT_PROTOCOL_MISMATCH', 'REQUEST_NOT_ALIGNED', 'AVAILABLE_FACTS_INCOMPLETE',
  'CONDITIONS_NOT_PRESERVED', 'CONFLICTS_PRESENT', 'EVIDENCE_INVENTORY_MISMATCH', 'UNIT_INVENTORY_MISMATCH'] as const;

export type SourceCoverageGuard = typeof SOURCE_COVERAGE_GUARDS[number];
export type SourceCoverageCheck = typeof SOURCE_COVERAGE_CHECKS[number];
type Tri = boolean | null;
type RowState<T extends string> = T | 'ABSENT' | 'DUPLICATE' | 'INVALID';
export type SourceCoverageInventory = Readonly<{ expected: number; reviewed: number | null; missing: number; unexpected: number; duplicate: number }>;
export type SourceCoverageObligationRecord = Readonly<{
  facet: number; obligation: number; questionType: typeof RECORD_QUESTION_TYPES[number] | 'other';
  sourceState: RowState<typeof SOURCE_COVERAGE_STATES[number]>; facetMatches: Tri;
  legacyStatus: RowState<'COVERED' | 'UNRESOLVED'>;
}>;
export type SourceCoverageLegacyRecord = Readonly<{
  facet: number; row: RowState<'PRESENT'>; requestAligned: Tri; materialFactsComplete: Tri;
  incompletenessReason: RowState<typeof RECORD_INCOMPLETENESS[number]>;
}>;
export type SourceCoverageDecisionRecord = Readonly<{
  schema: typeof SOURCE_COVERAGE_DECISION_SCHEMA;
  protocol: SourceExhaustiveProtocol | 'unsupported';
  state: SourceCoverageAssessment['state'];
  guard: SourceCoverageGuard;
  failedChecks: readonly SourceCoverageCheck[];
  /** false when the observer could not reproduce the authoritative state. */
  consistent: boolean;
  certificate: Readonly<{ present: boolean; shapeValid: boolean; protocolMatches: Tri; requestAligned: Tri;
    availableMaterialFactsComplete: Tri; conditionsPreserved: Tri; conflictsAbsent: Tri }>;
  evidenceInventory: SourceCoverageInventory | null;
  unitInventory: SourceCoverageInventory | null;
  obligations: readonly SourceCoverageObligationRecord[];
  legacyCoverage: readonly SourceCoverageLegacyRecord[];
  unitModalities: Readonly<Record<typeof RECORD_MODALITIES[number] | 'other', number>>;
  decisionRelations: Readonly<Record<typeof RECORD_RELATIONS[number] | 'INVALID', number>> | null;
  counts: Readonly<{ facets: number; obligations: number; units: number; evidence: number; unavailable: number }>;
  guard12: 'BLOCKED' | 'PASSED' | 'NOT_REACHED';
  /** Non-descriptive units plus a typed-unavailable obligation (the former turn-wide GUARD_12 condition). GUARD_12 is now facet-scoped; see scopedPartialModalityBlocked. */
  guard12Latent: boolean;
  callerVeto?: 'OWNER_PROPOSAL_REQUIRES_COMPLETE';
  truncated: boolean;
  recordError?: true;
}>;

const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.every(x => typeof x === 'string') &&
  new Set(a).size === a.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keys = (v: any, expected: string[]) => object(v) && same(Object.keys(v), expected);
const cap = (n: number) => Math.max(0, Math.min(COUNT_CAP, Math.floor(n)));
const tri = (v: unknown): Tri => typeof v === 'boolean' ? v : null;
const member = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

type Classification = { guard: SourceCoverageGuard; failedChecks: SourceCoverageCheck[]; unavailable: number; reached12: boolean };

/** Re-evaluates the guard sequence of assessSourceCoverage() on the same inputs.
 * Mirrors source-exhaustive-coverage.ts; GUARD_04 sub-checks are evaluated
 * without short-circuiting so every failing one is reported. */
function classify(raw: any, facets: readonly Facet[], units: readonly AnswerUnit[], evidence: readonly Evidence[],
  businessId: number | undefined, protocol: SourceExhaustiveProtocol): Classification {
  const deny = (guard: SourceCoverageGuard, failedChecks: SourceCoverageCheck[]): Classification => ({ guard, failedChecks, unavailable: 0, reached12: false });
  if (!isSourceExhaustiveProtocol(protocol)) return deny('GUARD_01', ['PROTOCOL_UNSUPPORTED']);
  if (!Number.isSafeInteger(businessId) || businessId! <= 0 || !facets.length || facets.length > 4 || !units.length || units.length > 6 ||
    !evidence.length || evidence.length > 6 || evidence.some(e => e.businessId !== businessId ||
      [e.id, e.sourceId, e.chunkId, e.version, e.text].some(x => typeof x !== 'string' || !x.trim()) || e.text.length > 2400) ||
    new Set(evidence.map(e => e.id)).size !== evidence.length || new Set(evidence.map(e => JSON.stringify([e.sourceId, e.chunkId]))).size !== evidence.length ||
    new Set(units.map(u => u.id)).size !== units.length) return deny('GUARD_02', ['INPUT_CONTRACT_INVALID']);
  if (!keys(raw, ['decisions', 'coverage', 'sourceCoverage'])) return deny('GUARD_03', ['RESPONSE_SHAPE_INVALID']);
  const s = raw.sourceCoverage;
  const g04: SourceCoverageCheck[] = [];
  if (!keys(s, ['protocol', 'requestAligned', 'availableMaterialFactsComplete', 'conditionsPreserved', 'conflictsAbsent',
    'evidenceIdsReviewed', 'acceptedUnitIdsReviewed', 'obligations'])) g04.push('ASSESSMENT_SHAPE_INVALID');
  if (object(s)) {
    if (s.protocol !== protocol) g04.push('ASSESSMENT_PROTOCOL_MISMATCH');
    if (s.requestAligned !== true) g04.push('REQUEST_NOT_ALIGNED');
    if (s.availableMaterialFactsComplete !== true) g04.push('AVAILABLE_FACTS_INCOMPLETE');
    if (s.conditionsPreserved !== true) g04.push('CONDITIONS_NOT_PRESERVED');
    if (s.conflictsAbsent !== true) g04.push('CONFLICTS_PRESENT');
    if (!same(s.evidenceIdsReviewed, evidence.map(e => e.id))) g04.push('EVIDENCE_INVENTORY_MISMATCH');
    if (!same(s.acceptedUnitIdsReviewed, units.map(u => u.id))) g04.push('UNIT_INVENTORY_MISMATCH');
  }
  if (g04.length) return deny('GUARD_04', g04);
  if (!Array.isArray(raw.decisions) || raw.decisions.length !== units.length || !same(raw.decisions.map((d: any) => d?.unitId), units.map(u => u.id)))
    return deny('GUARD_05', ['DECISION_INVENTORY_MISMATCH']);
  for (const u of units) {
    const d = raw.decisions.find((d: any) => d.unitId === u.id);
    if (!u.facetIds.length || !u.facetIds.every(id => facets.some(f => f.id === id)) || d.relation !== 'ENTAILED' ||
      !same(d.facetIds, u.facetIds) || ['meaningPreserved', 'modalityPreserved', 'qualifiersPreserved', 'relevant', 'languageCorrect'].some(k => d[k] !== true) ||
      typeof d.negativeAbsence !== 'boolean' || typeof d.explicitAbsenceEvidence !== 'boolean' || d.negativeAbsence && !d.explicitAbsenceEvidence ||
      !u.evidenceRefs.length || u.evidenceRefs.some(r => !evidence.some(e => e.id === r.evidenceId && e.sourceId === r.sourceId &&
        e.chunkId === r.chunkId && e.version === r.version && e.text.includes(r.exactQuote)))) return deny('GUARD_06', ['UNIT_DECISION_REJECTED']);
  }
  const obligations = facets.flatMap(f => f.obligations.map(o => ({ f, o })));
  if (!Array.isArray(s.obligations) || s.obligations.length !== obligations.length || !same(s.obligations.map((o: any) => o?.obligationId), obligations.map(({ o }) => o.id)) ||
    !Array.isArray(raw.coverage) || raw.coverage.length !== facets.length || !same(raw.coverage.map((c: any) => c?.facetId), facets.map(f => f.id)))
    return deny('GUARD_07', ['OBLIGATION_INVENTORY_MISMATCH']);
  let unavailable = 0;
  const gaps: { facetId: string; state: string }[] = [];
  for (const f of facets) {
    const c = raw.coverage.find((c: any) => c.facetId === f.id), validIds = units.filter(u => u.facetIds.includes(f.id)).map(u => u.id);
    const subset = (ids: any) => Array.isArray(ids) && ids.every(id => typeof id === 'string' && validIds.includes(id)) && new Set(ids).size === ids.length;
    if (!keys(c, ['facetId', 'requestAligned', 'materialFactsComplete', 'incompletenessReason', 'materialUnitIds', 'obligations']) || c.requestAligned !== true ||
      typeof c.materialFactsComplete !== 'boolean' || !['NONE', 'UNRESOLVED', 'MISSING_RELEVANT_FACT'].includes(c.incompletenessReason) ||
      !subset(c.materialUnitIds) || !Array.isArray(c.obligations) || c.obligations.length !== f.obligations.length ||
      !same(c.obligations.map((o: any) => o?.obligationId), f.obligations.map(o => o.id))) return deny('GUARD_08', ['LEGACY_COVERAGE_INVALID']);
    for (const o of f.obligations) {
      const d = c.obligations.find((d: any) => d.obligationId === o.id), a = s.obligations.find((a: any) => a.obligationId === o.id);
      if (!keys(d, ['obligationId', 'status', 'unitIds']) || !subset(d.unitIds) || !keys(a, ['facetId', 'obligationId', 'state']) || a.facetId !== f.id)
        return deny('GUARD_09', ['OBLIGATION_ROW_INVALID']);
      if (a.state === 'COMPLETE') {
        const covers = o.questionType === 'description' || units.some(u => d.unitIds.includes(u.id) &&
          (o.questionType === 'permission' ? u.modality === 'permitted' || u.modality === 'prohibited' && !u.negation :
            u.modality === ({ requirement: 'required', recommendation: 'recommended', prohibition: 'prohibited' } as const)[o.questionType]));
        if (!covers || !c.materialFactsComplete || c.incompletenessReason !== 'NONE' || d.status !== 'COVERED' || !d.unitIds.length || !c.materialUnitIds.length)
          return deny('GUARD_10', ['COMPLETE_NOT_SUPPORTED']);
      } else {
        if (d.status !== 'UNRESOLVED' || c.materialFactsComplete || c.incompletenessReason === 'NONE' ||
          o.questionType === 'requirement' && d.unitIds.length !== 0 ||
          !(a.state === 'REQUESTED_INFORMATION_NOT_VERIFIED' && o.questionType === 'description' || a.state === 'UNRESOLVED_REQUIREMENT' && o.questionType === 'requirement'))
          return deny('GUARD_11', ['UNAVAILABLE_STATE_NOT_PERMITTED']);
        unavailable++;
        gaps.push({ facetId: f.id, state: a.state });
      }
    }
  }
  if (scopedPartialModalityBlocked(units, gaps as never)) return { guard: 'GUARD_12', failedChecks: ['PARTIAL_NON_DESCRIPTIVE_UNITS'], unavailable, reached12: true };
  return { guard: 'NONE', failedChecks: [], unavailable, reached12: true };
}

function inventory(reviewed: unknown, expected: readonly string[]): SourceCoverageInventory {
  if (!Array.isArray(reviewed)) return Object.freeze({ expected: cap(expected.length), reviewed: null, missing: cap(expected.length), unexpected: 0, duplicate: 0 });
  const strings = reviewed.filter((x): x is string => typeof x === 'string'), unique = new Set(strings);
  return Object.freeze({ expected: cap(expected.length), reviewed: cap(reviewed.length), missing: cap(expected.filter(id => !unique.has(id)).length),
    unexpected: cap(reviewed.length - strings.length + [...unique].filter(id => !expected.includes(id)).length), duplicate: cap(strings.length - unique.size) });
}

function rowState(rows: readonly unknown[] | null, match: (row: any) => boolean): { state: 'ABSENT' | 'DUPLICATE' | 'PRESENT'; row?: any } {
  if (!rows) return { state: 'ABSENT' };
  const found = rows.filter(r => object(r) && match(r));
  return found.length === 1 ? { state: 'PRESENT', row: found[0] } : { state: found.length ? 'DUPLICATE' : 'ABSENT' };
}

/** Content-free per-obligation / per-facet detail, read independently of which guard fired. */
function details(raw: any, facets: readonly Facet[], units: readonly AnswerUnit[], evidence: readonly Evidence[], protocol: SourceExhaustiveProtocol) {
  const s = object(raw) && object(raw.sourceCoverage) ? raw.sourceCoverage : undefined;
  const sourceRows = s && Array.isArray(s.obligations) ? s.obligations as unknown[] : null;
  const legacyRows = object(raw) && Array.isArray(raw.coverage) ? raw.coverage as unknown[] : null;
  const bounded = facets.slice(0, MAX_FACETS);
  const obligations: SourceCoverageObligationRecord[] = [], legacyCoverage: SourceCoverageLegacyRecord[] = [];
  bounded.forEach((f, facet) => {
    const legacy = rowState(legacyRows, r => r.facetId === f.id);
    const c = legacy.row;
    legacyCoverage.push(Object.freeze({ facet, row: legacy.state, requestAligned: c ? tri(c.requestAligned) : null,
      materialFactsComplete: c ? tri(c.materialFactsComplete) : null,
      incompletenessReason: !c ? legacy.state as 'ABSENT' | 'DUPLICATE' : member(RECORD_INCOMPLETENESS, c.incompletenessReason) ? c.incompletenessReason : 'INVALID' }));
    f.obligations.slice(0, MAX_OBLIGATIONS_PER_FACET).forEach((o, obligation) => {
      const source = rowState(sourceRows, r => r.obligationId === o.id);
      const legacyObligation: { state: 'ABSENT' | 'DUPLICATE' | 'PRESENT'; row?: any } = c ? rowState(Array.isArray(c.obligations) ? c.obligations : null, r => r.obligationId === o.id) : { state: 'ABSENT' as const };
      obligations.push(Object.freeze({ facet, obligation,
        questionType: member(RECORD_QUESTION_TYPES, o.questionType) ? o.questionType : 'other',
        sourceState: source.row ? member(SOURCE_COVERAGE_STATES, source.row.state) ? source.row.state : 'INVALID' : source.state as 'ABSENT' | 'DUPLICATE',
        facetMatches: source.row ? source.row.facetId === f.id : null,
        legacyStatus: legacyObligation.row ? member(['COVERED', 'UNRESOLVED'] as const, legacyObligation.row.status) ? legacyObligation.row.status : 'INVALID'
          : legacyObligation.state as 'ABSENT' | 'DUPLICATE' }));
    });
  });
  const unitModalities = Object.fromEntries([...RECORD_MODALITIES, 'other'].map(m => [m, 0])) as Record<typeof RECORD_MODALITIES[number] | 'other', number>;
  for (const u of units) unitModalities[member(RECORD_MODALITIES, u.modality) ? u.modality : 'other']++;
  const decisions = object(raw) && Array.isArray(raw.decisions) ? raw.decisions as unknown[] : null;
  let decisionRelations: Record<typeof RECORD_RELATIONS[number] | 'INVALID', number> | null = null;
  if (decisions) {
    decisionRelations = Object.fromEntries([...RECORD_RELATIONS, 'INVALID'].map(r => [r, 0])) as any;
    for (const d of decisions) decisionRelations![object(d) && member(RECORD_RELATIONS, (d as any).relation) ? (d as any).relation : 'INVALID']++;
    for (const k of Object.keys(decisionRelations!) as (keyof typeof decisionRelations)[]) decisionRelations![k] = cap(decisionRelations![k]);
  }
  for (const k of Object.keys(unitModalities) as (keyof typeof unitModalities)[]) unitModalities[k] = cap(unitModalities[k]);
  const nonDescriptive = units.some(u => u.modality !== 'descriptive');
  return {
    certificate: Object.freeze({ present: !!s, shapeValid: keys(s, ['protocol', 'requestAligned', 'availableMaterialFactsComplete', 'conditionsPreserved',
      'conflictsAbsent', 'evidenceIdsReviewed', 'acceptedUnitIdsReviewed', 'obligations']), protocolMatches: s ? s.protocol === protocol : null,
      requestAligned: s ? tri(s.requestAligned) : null, availableMaterialFactsComplete: s ? tri(s.availableMaterialFactsComplete) : null,
      conditionsPreserved: s ? tri(s.conditionsPreserved) : null, conflictsAbsent: s ? tri(s.conflictsAbsent) : null }),
    evidenceInventory: s ? inventory(s.evidenceIdsReviewed, evidence.map(e => e.id)) : null,
    unitInventory: s ? inventory(s.acceptedUnitIdsReviewed, units.map(u => u.id)) : null,
    obligations: Object.freeze(obligations), legacyCoverage: Object.freeze(legacyCoverage),
    unitModalities: Object.freeze(unitModalities), decisionRelations: decisionRelations && Object.freeze(decisionRelations),
    guard12Latent: nonDescriptive && obligations.some(o => o.sourceState === 'REQUESTED_INFORMATION_NOT_VERIFIED' || o.sourceState === 'UNRESOLVED_REQUIREMENT'),
  };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
/** Enforces the documented size cap. Drops detail arrays before summary fields. */
export function boundSourceCoverageRecord(record: SourceCoverageDecisionRecord): SourceCoverageDecisionRecord {
  let r = record;
  if (bytes(r) > SOURCE_COVERAGE_DECISION_MAX_BYTES) r = { ...r, legacyCoverage: Object.freeze([]), truncated: true };
  if (bytes(r) > SOURCE_COVERAGE_DECISION_MAX_BYTES) r = { ...r, obligations: Object.freeze([]), truncated: true };
  if (bytes(r) > SOURCE_COVERAGE_DECISION_MAX_BYTES) r = { ...r, failedChecks: Object.freeze(r.failedChecks.slice(0, 4)), truncated: true };
  return Object.freeze(r);
}

const protocolLabel = (p: unknown): SourceExhaustiveProtocol | 'unsupported' => isSourceExhaustiveProtocol(p) ? p : 'unsupported';
const emptyCounts = (facets: readonly Facet[], units: readonly AnswerUnit[], evidence: readonly Evidence[], unavailable = 0) => Object.freeze({
  facets: cap(facets.length), obligations: cap(facets.reduce((n, f) => n + f.obligations.length, 0)), units: cap(units.length),
  evidence: cap(evidence.length), unavailable: cap(unavailable) });

function errorRecord(state: SourceCoverageAssessment['state'], protocol: unknown): SourceCoverageDecisionRecord {
  return Object.freeze({ schema: SOURCE_COVERAGE_DECISION_SCHEMA, protocol: protocolLabel(protocol), state, guard: 'UNCLASSIFIED', failedChecks: Object.freeze([]),
    consistent: false, certificate: Object.freeze({ present: false, shapeValid: false, protocolMatches: null, requestAligned: null,
      availableMaterialFactsComplete: null, conditionsPreserved: null, conflictsAbsent: null }), evidenceInventory: null, unitInventory: null,
    obligations: Object.freeze([]), legacyCoverage: Object.freeze([]), unitModalities: Object.freeze({ descriptive: 0, recommended: 0, required: 0,
      permitted: 0, prohibited: 0, other: 0 }), decisionRelations: null, counts: Object.freeze({ facets: 0, obligations: 0, units: 0, evidence: 0, unavailable: 0 }),
    guard12: 'NOT_REACHED', guard12Latent: false, truncated: false, recordError: true });
}

/** Pure description of an assessment already made by assessSourceCoverage(). Never throws. */
export function describeSourceCoverageDecision(assessment: SourceCoverageAssessment, raw: unknown, facets: readonly Facet[], units: readonly AnswerUnit[],
  evidence: readonly Evidence[], businessId: number | undefined, protocol: SourceExhaustiveProtocol = SOURCE_EXHAUSTIVE_PROTOCOL): SourceCoverageDecisionRecord {
  try {
    let c: Classification;
    try { c = classify(raw, facets, units, evidence, businessId, protocol); }
    catch { c = { guard: 'UNCLASSIFIED', failedChecks: [], unavailable: 0, reached12: false }; }
    const observed = c.guard === 'NONE' ? c.unavailable ? 'SCOPED_PARTIAL' : 'COMPLETE' : c.guard === 'UNCLASSIFIED' ? undefined : 'DENIED';
    const consistent = observed === assessment.state && (assessment.state !== 'SCOPED_PARTIAL' || c.unavailable === assessment.unavailable.length);
    const d = details(raw, facets, units, evidence, protocol);
    return boundSourceCoverageRecord({ schema: SOURCE_COVERAGE_DECISION_SCHEMA, protocol: protocolLabel(protocol), state: assessment.state,
      guard: consistent ? c.guard : 'UNCLASSIFIED', failedChecks: Object.freeze(consistent ? c.failedChecks : []), consistent,
      certificate: d.certificate, evidenceInventory: d.evidenceInventory, unitInventory: d.unitInventory,
      obligations: d.obligations, legacyCoverage: d.legacyCoverage, unitModalities: d.unitModalities, decisionRelations: d.decisionRelations,
      counts: emptyCounts(facets, units, evidence, assessment.unavailable.length),
      guard12: !consistent || !c.reached12 ? 'NOT_REACHED' : c.guard === 'GUARD_12' ? 'BLOCKED' : 'PASSED',
      guard12Latent: d.guard12Latent, truncated: false });
  } catch { return errorRecord(assessment.state, protocol); }
}

/** Authoritative assessment, unchanged, plus its content-free decision record. */
export function assessSourceCoverageDetailed(raw: any, facets: readonly Facet[], units: readonly AnswerUnit[],
  evidence: readonly Evidence[], businessId: number | undefined,
  protocol: SourceExhaustiveProtocol = SOURCE_EXHAUSTIVE_PROTOCOL): { assessment: SourceCoverageAssessment; record: SourceCoverageDecisionRecord } {
  const assessment = assessSourceCoverage(raw, facets, units, evidence, businessId, protocol);
  return { assessment, record: describeSourceCoverageDecision(assessment, raw, facets, units, evidence, businessId, protocol) };
}

/** Records a denial that the backend made before assessSourceCoverage() ran
 * (source-exhaustive early stop or post-verification precondition). Never throws. */
export function describeSourceCoveragePrecondition(input: { kind: 'EARLY_STOP' | 'PRECONDITION'; protocol: SourceExhaustiveProtocol;
  raw?: unknown; facets: readonly Facet[]; units: readonly AnswerUnit[]; evidence: readonly Evidence[];
  proposalParseComplete: boolean; extractionIncomplete: boolean; conflicts?: number; catalogComplete?: boolean; verified?: number }): SourceCoverageDecisionRecord {
  try {
    const failedChecks: SourceCoverageCheck[] = [];
    if (!input.proposalParseComplete) failedChecks.push('PROPOSAL_PARSE_INCOMPLETE');
    if (input.extractionIncomplete) failedChecks.push('EXTRACTION_INCOMPLETE');
    if (input.conflicts) failedChecks.push('UNIT_CONFLICT');
    if (input.catalogComplete === false) failedChecks.push('CATALOG_INCOMPLETE');
    if (input.verified !== undefined && input.verified !== input.units.length) failedChecks.push('UNIT_NOT_VERIFIED');
    const d = details(input.raw, input.facets, input.units, input.evidence, input.protocol);
    return boundSourceCoverageRecord({ schema: SOURCE_COVERAGE_DECISION_SCHEMA, protocol: protocolLabel(input.protocol), state: 'DENIED',
      guard: input.kind, failedChecks: Object.freeze(failedChecks), consistent: failedChecks.length > 0,
      certificate: d.certificate, evidenceInventory: d.evidenceInventory, unitInventory: d.unitInventory,
      obligations: d.obligations, legacyCoverage: d.legacyCoverage, unitModalities: d.unitModalities, decisionRelations: d.decisionRelations,
      counts: emptyCounts(input.facets, input.units, input.evidence), guard12: 'NOT_REACHED', guard12Latent: d.guard12Latent, truncated: false });
  } catch { return errorRecord('DENIED', input.protocol); }
}

/** Marks a non-DENIED assessment that the caller still vetoed (owner proposals require COMPLETE). */
export function withOwnerCompleteVeto(record: SourceCoverageDecisionRecord): SourceCoverageDecisionRecord {
  return Object.freeze({ ...record, callerVeto: 'OWNER_PROPOSAL_REQUIRES_COMPLETE' });
}

/** Optional event field; a failing record builder yields no field, never an exception. */
export function sourceCoverageField(build: () => SourceCoverageDecisionRecord | undefined): { sourceCoverage?: SourceCoverageDecisionRecord } {
  try { const record = build(); return record ? { sourceCoverage: record } : {}; } catch { return {}; }
}

/** The single new event, for COMPLETE / SCOPED_PARTIAL decisions only (denials enrich their existing event).
 * Observability only: a throwing sink cannot affect the answer decision. */
export function emitSourceCoverageAccepted(diagnostic: (event: KnowledgeDecision) => void, record: SourceCoverageDecisionRecord | undefined): void {
  if (!record || record.state === 'DENIED') return;
  try { diagnostic({ stage: 'verification', reason: 'SOURCE_COVERAGE_ACCEPTED', sourceCoverage: record }); } catch { /* observability only */ }
}
