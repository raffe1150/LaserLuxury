import type { AnswerUnit, Facet } from './business-information-answer-plan';

export const COVERAGE_WITNESS_PROTOCOL = 'coverage-witness-v1' as const;
export const COVERAGE_WITNESS_SCHEMA_NAME = 'odinlink_knowledge_verification_witness_v1';
const reasons = ['MISSING_CONDITION', 'MISSING_RELEVANT_FACT', 'MISSING_RECOMMENDATION', 'UNRESOLVED'] as const;
type IncompleteReason = typeof reasons[number];
export type CoverageWitnessAssessment = Readonly<{
  state: 'VALID' | 'UNKNOWN' | 'INVALID'; reason: string;
  claimedMissing: readonly Readonly<{ facetId: string; obligationId: string; reason: IncompleteReason;
    start: number; end: number; semanticTruth: 'UNCONFIRMED_MODEL_CLAIM' }>[];
}>;

export const COVERAGE_WITNESS_INSTRUCTION = `Coverage witness v1: preserve all existing independent unit and full-question coverage judgments. Return coverageWitnesses=[] for COMPLETE coverage. For each UNRESOLVED obligation in an incomplete coverage row, return exactly one witness with that facetId, obligationId and the row's incompletenessReason. Never invent a customer requirement, source fact, explanation, answer or citation. location={kind:QUESTION_SPAN,quote:...} copies a short exact contiguous phrase from the unchanged original question that you judge unanswered. Do not paraphrase or generate offsets; the backend locates the unique phrase and derives offsets. The entire owning obligation must occur literally and unambiguously in the question. Preserve every condition, negation and room/scope modifier in your interpretation; a short selected span never replaces its full question/obligation context. If no trustworthy literal anchor can be identified, use location={kind:UNLOCATED,reason:NO_RELIABLE_REQUEST_SPAN}. An unavailable witness never converts incomplete coverage into complete. A witness is a model assertion for diagnostics, not evidence, entailment or publication authority. No other keys or free-form explanation.`;

export function coverageWitnessInstruction(legacy: string): string {
  const footer = 'Return JSON only: {"decisions":[],"coverage":[]}.';
  if (!legacy.endsWith(footer)) throw new Error('unsupported_witness_instruction');
  return legacy.slice(0, -footer.length) + COVERAGE_WITNESS_INSTRUCTION +
    '\nReturn JSON only: {"decisions":[],"coverage":[],"coverageWitnesses":[]}.';
}

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
/** Clone the canonical schema; never mutate the legacy wire contract. */
export function coverageWitnessSchema(legacy: Record<string, any>) {
  const schema = structuredClone(legacy);
  schema.properties.coverageWitnesses = { type: 'array', maxItems: 8, items: object({
    facetId: { type: 'string', maxLength: 8 }, obligationId: { type: 'string', maxLength: 8 },
    reason: { type: 'string', enum: [...reasons] }, location: { anyOf: [
      object({ kind: { type: 'string', enum: ['QUESTION_SPAN'] }, quote: { type: 'string', minLength: 1, maxLength: 240 } }),
      object({ kind: { type: 'string', enum: ['UNLOCATED'] }, reason: { type: 'string', enum: ['NO_RELIABLE_REQUEST_SPAN'] } }),
    ] },
  }) };
  schema.required.push('coverageWitnesses');
  return schema;
}

/** Witness-v1 only: exact JSON, bounded depth/size, no duplicate members or
 * fence repair. Legacy parsing is intentionally unchanged. */
export function parseCoverageWitnessResponse(text: string): unknown {
  try {
    if (Buffer.byteLength(text, 'utf8') > 32_768) return null;
    const parsed = JSON.parse(text), stack: Array<Set<string> | null> = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        const start = i;
        while (++i < text.length) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
        let next = i + 1; while (next < text.length && /\s/u.test(text[next])) next++;
        if (text[next] === ':') {
          const key = JSON.parse(text.slice(start, i + 1)), keys = stack.at(-1);
          if (!keys || keys.has(key)) return null;
          keys.add(key);
        }
      } else if (text[i] === '{' || text[i] === '[') {
        stack.push(text[i] === '{' ? new Set() : null);
        if (stack.length > 12) return null;
      } else if (text[i] === '}' || text[i] === ']') stack.pop();
    }
    return parsed;
  } catch { return null; }
}

const shape = (v: any, keys: readonly string[]) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const ids = (v: any, allowed: readonly string[], max: number) => Array.isArray(v) && v.length <= max &&
  new Set(v).size === v.length && v.every(id => typeof id === 'string' && id.length <= 8 && allowed.includes(id));
const decisionKeys = ['unitId','relation','facetIds','meaningPreserved','modalityPreserved','qualifiersPreserved','relevant','languageCorrect','explicitAbsenceEvidence','negativeAbsence'];
const coverageKeys = ['facetId','requestAligned','materialFactsComplete','incompletenessReason','materialUnitIds','obligations'];
const boundary = (s: string, n: number) => !(n > 0 && n < s.length && /[\uD800-\uDBFF]/u.test(s[n - 1]) && /[\uDC00-\uDFFF]/u.test(s[n]));
const token = /[\p{L}\p{M}\p{N}_\u200c/'’\-\u2010-\u2015]/u;

/** Structural diagnostic validation only. Literal provenance cannot establish
 * that a requirement is missing. Never returns semantic/publication authority.
 * Original question and obligations stay with the caller; telemetry contains
 * only bounded IDs/categories/backend offsets, never model prose/customer text. */
export function assessCoverageWitnesses(raw: any, question: string, facets: readonly Facet[],
  units: readonly Pick<AnswerUnit, 'id' | 'facetIds'>[]): CoverageWitnessAssessment {
  const fail = (reason: string, state: 'INVALID' | 'UNKNOWN' = 'INVALID'): CoverageWitnessAssessment =>
    Object.freeze({ state, reason, claimedMissing: Object.freeze([]) });
  if (!shape(raw, ['decisions','coverage','coverageWitnesses']) || !Array.isArray(raw.coverageWitnesses) || raw.coverageWitnesses.length > 8 ||
      !Array.isArray(raw.coverage) || raw.coverage.length !== facets.length || !facets.length || facets.length > 4 ||
      facets.some(f => f.obligations.length > 2) || !Array.isArray(raw.decisions) || raw.decisions.length !== units.length || units.length > 6 ||
      typeof question !== 'string' || question.length > 8192) return fail('INVALID_ENVELOPE');
  const seenUnits = new Set<string>();
  for (const d of raw.decisions) {
    const unit = units.find(u => u.id === d?.unitId);
    if (!shape(d, decisionKeys) || !unit || seenUnits.has(d.unitId) ||
        !['ENTAILED','UNKNOWN','CONTRADICTED','NOT_APPLICABLE'].includes(d.relation) ||
        !ids(d.facetIds, unit.facetIds, 4) || d.facetIds.length !== new Set(unit.facetIds).size ||
        !decisionKeys.slice(3).every(k => typeof d[k] === 'boolean')) return fail('INVALID_DECISION_SHAPE');
    seenUnits.add(d.unitId);
  }
  const expected = new Map<string, { obligation: Facet['obligations'][number]; reason: IncompleteReason }>();
  const seenFacets = new Set<string>();
  for (const c of raw.coverage) {
    const facet = facets.find(f => f.id === c?.facetId);
    if (!facet || seenFacets.has(facet.id) || !shape(c, coverageKeys) || typeof c.requestAligned !== 'boolean' ||
        typeof c.materialFactsComplete !== 'boolean' || !['NONE',...reasons].includes(c.incompletenessReason) ||
        !ids(c.materialUnitIds, units.filter(u => u.facetIds.includes(facet.id)).map(u => u.id), 6) ||
        !Array.isArray(c.obligations) || c.obligations.length !== facet.obligations.length) return fail('INVALID_COVERAGE_BINDING');
    seenFacets.add(facet.id);
    const seenObligations = new Set<string>();
    for (const o of c.obligations) {
      if (!shape(o, ['obligationId','status','unitIds']) || !facet.obligations.some(f => f.id === o.obligationId) ||
          seenObligations.has(o.obligationId) || !['COVERED','UNRESOLVED'].includes(o.status) ||
          !ids(o.unitIds, units.filter(u => u.facetIds.includes(facet.id)).map(u => u.id), 6)) return fail('INVALID_OBLIGATION_BINDING');
      seenObligations.add(o.obligationId);
    }
    if (c.materialFactsComplete) {
      if (c.incompletenessReason !== 'NONE' || !c.requestAligned || c.obligations.some((o: any) => o.status !== 'COVERED')) return fail('CONTRADICTORY_COMPLETE');
    } else {
      if (!reasons.includes(c.incompletenessReason) || !c.obligations.some((o: any) => o.status === 'UNRESOLVED')) return fail('CONTRADICTORY_INCOMPLETE');
      for (const o of c.obligations.filter((o: any) => o.status === 'UNRESOLVED'))
        expected.set(`${facet.id}/${o.obligationId}`, { obligation: facet.obligations.find(f => f.id === o.obligationId)!, reason: c.incompletenessReason });
    }
  }
  if (raw.coverageWitnesses.length !== expected.size) return fail('WITNESS_CARDINALITY');
  const seen = new Set<string>(), claims: CoverageWitnessAssessment['claimedMissing'][number][] = [];
  let unknown = false;
  for (const w of raw.coverageWitnesses) {
    if (!shape(w, ['facetId','obligationId','reason','location']) || typeof w.facetId !== 'string' || w.facetId.length > 8 ||
        typeof w.obligationId !== 'string' || w.obligationId.length > 8) return fail('INVALID_WITNESS_SHAPE');
    const key = `${w.facetId}/${w.obligationId}`, binding = expected.get(key);
    if (!binding || seen.has(key) || w.reason !== binding.reason) return fail('WITNESS_VERDICT_MISMATCH');
    seen.add(key);
    if (shape(w.location, ['kind','reason']) && w.location.kind === 'UNLOCATED' && w.location.reason === 'NO_RELIABLE_REQUEST_SPAN') { unknown = true; continue; }
    if (!shape(w.location, ['kind','quote']) || w.location.kind !== 'QUESTION_SPAN' || typeof w.location.quote !== 'string' ||
        !w.location.quote.trim() || w.location.quote.length > 240) return fail('INVALID_LOCATOR');
    const description = binding.obligation.description, at = question.indexOf(description);
    const start = question.indexOf(w.location.quote), end = start + w.location.quote.length;
    if (start < 0) return fail('QUOTE_NOT_IN_REQUEST');
    if (start !== question.lastIndexOf(w.location.quote) || at < 0 || at !== question.lastIndexOf(description)) { unknown = true; continue; }
    if (start < at || end > at + description.length || !boundary(question, start) || !boundary(question, end)) return fail('INVALID_REQUEST_RANGE');
    if ((start > 0 && token.test(question[start - 1]) && token.test(question[start])) ||
        (end < question.length && token.test(question[end - 1]) && token.test(question[end]))) return fail('SPLIT_REQUEST_TOKEN');
    claims.push(Object.freeze({ facetId: w.facetId, obligationId: w.obligationId, reason: binding.reason,
      start, end, semanticTruth: 'UNCONFIRMED_MODEL_CLAIM' }));
  }
  return Object.freeze({ state: unknown ? 'UNKNOWN' : 'VALID', reason: unknown ? 'NO_RELIABLE_REQUEST_ANCHOR' : 'STRUCTURALLY_CONSISTENT_ONLY',
    claimedMissing: Object.freeze(claims) });
}
