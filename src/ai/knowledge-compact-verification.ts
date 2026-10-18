import type { AnswerUnit, Facet } from './business-information-answer-plan';
import { RELATIONS } from './knowledge-answer-protocol';

export const COMPACT_VERIFICATION_FLAG = 'ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION';
export const compactVerificationEnabled = () => process.env[COMPACT_VERIFICATION_FLAG] === 'true';
export const COMPACT_VERIFICATION_NAME = 'odinlink_knowledge_verification_compact_v1';
export const INCOMPLETENESS_REASONS = ['NONE', 'MISSING_RELEVANT_FACT', 'MISSING_CONDITION', 'MISSING_RECOMMENDATION', 'UNRESOLVED'] as const;
// Aliases only. Enum values, explicit booleans and stable IDs are unchanged.
export const DECISION_FIELDS = {
  i: 'unitId', r: 'relation', f: 'facetIds', m: 'meaningPreserved', o: 'modalityPreserved',
  q: 'qualifiersPreserved', v: 'relevant', l: 'languageCorrect', a: 'explicitAbsenceEvidence', n: 'negativeAbsence',
} as const;
export const COVERAGE_FIELDS = {
  i: 'facetId', a: 'requestAligned', c: 'materialFactsComplete', r: 'incompletenessReason', u: 'materialUnitIds', o: 'obligations',
} as const;
export const OBLIGATION_FIELDS = { i: 'obligationId', s: 'status', u: 'unitIds' } as const;

export function compactVerificationInstruction(legacy: string): string {
  return legacy.replace('Return JSON only: {"decisions":[],"coverage":[]}.', '') +
    ` Compact wire v1: the preceding names describe canonical semantics, NOT output keys. Return JSON only with exactly {"d":[{"i":"u1","r":"ENTAILED","f":["f1"],"m":true,"o":true,"q":true,"v":true,"l":true,"a":false,"n":false}],"c":[{"i":"f1","a":true,"c":true,"r":"NONE","u":["u1"],"o":[{"i":"f1.o1","s":"COVERED","u":["u1"]}]}]}. d=decisions; c=coverage. Decision aliases: ${JSON.stringify(DECISION_FIELDS)}. Coverage aliases: ${JSON.stringify(COVERAGE_FIELDS)}. Obligation aliases: ${JSON.stringify(OBLIGATION_FIELDS)}. These example verdicts are illustrative, never defaults. Supply every explicit field and every expected unit/facet/obligation exactly once. Preserve all enum values and original IDs. No extra keys. Never omit a false flag or infer completeness from unit existence.`;
}

export function compactVerificationSchema() {
  const str = { type: 'string' }, bool = { type: 'boolean' };
  const array = (items: unknown) => ({ type: 'array', items });
  const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  return object({
    d: array(object({ i: str, r: { type: 'string', enum: [...RELATIONS] }, f: array(str),
      m: bool, o: bool, q: bool, v: bool, l: bool, a: bool, n: bool })),
    c: array(object({ i: str, a: bool, c: bool, r: { type: 'string', enum: [...INCOMPLETENESS_REASONS] }, u: array(str),
      o: array(object({ i: str, s: { type: 'string', enum: ['COVERED', 'UNRESOLVED'] }, u: array(str) })) })),
  });
}

/** JSON.parse alone silently accepts duplicate object members, including escaped
 * aliases. Scan the already syntax-checked text before trusting any verdict. */
function strictJson(text: string): any {
  if (Buffer.byteLength(text, 'utf8') > 32_768) throw new Error('compact_size');
  const parsed = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      while (++i < text.length) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
      let next = i + 1; while (/\s/u.test(text[next] || '') && next < text.length) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)), keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error('compact_duplicate');
        keys.add(key);
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null);
      if (stack.length > 12) throw new Error('compact_depth');
    } else if (char === '}' || char === ']') stack.pop();
  }
  return parsed;
}

const shape = (value: any, fields: Record<string, string>): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length && Object.keys(fields).every(k => Object.hasOwn(value, k));
const ids = (value: any, allowed: readonly string[], max: number, nonempty = false): value is string[] => Array.isArray(value) &&
  value.length <= max && (!nonempty || value.length > 0) && new Set(value).size === value.length &&
  value.every(id => typeof id === 'string' && id.length <= 8 && allowed.includes(id));
const expand = (row: any, fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([key, name]) => [name, row[key]]));

/** No repair, default verdicts, alternate-protocol retry or authority creation.
 * The unchanged canonical gates still judge all decoded flags and modalities. */
export function decodeCompactVerification(text: string, units: readonly Pick<AnswerUnit, 'id' | 'facetIds'>[], facets: readonly Facet[]): any | null {
  try {
    const raw = strictJson(text);
    if (!shape(raw, { d: 'decisions', c: 'coverage' }) || units.length > 6 || facets.length > 4 ||
      !Array.isArray(raw.d) || raw.d.length !== units.length || !Array.isArray(raw.c) || raw.c.length !== facets.length) return null;
    const seenUnits = new Set(), seenFacets = new Set();
    for (const d of raw.d) {
      const unit = units.find(u => u.id === d?.i);
      if (!shape(d, DECISION_FIELDS) || !unit || seenUnits.has(d.i) || !RELATIONS.includes(d.r) ||
        !ids(d.f, unit.facetIds, 4, true) || d.f.length !== new Set(unit.facetIds).size ||
        !['m', 'o', 'q', 'v', 'l', 'a', 'n'].every(k => typeof d[k] === 'boolean')) return null;
      seenUnits.add(d.i);
    }
    for (const c of raw.c) {
      const facet = facets.find(f => f.id === c?.i);
      if (!shape(c, COVERAGE_FIELDS) || !facet || seenFacets.has(c.i) || typeof c.a !== 'boolean' || typeof c.c !== 'boolean' ||
        !INCOMPLETENESS_REASONS.includes(c.r) ||
        !Array.isArray(c.o) || facet.obligations.length > 2 || c.o.length !== facet.obligations.length) return null;
      // Match assessCoverage(): the enum is diagnostic, never completeness
      // authority. Preserve both values, including disagreement; do not infer or
      // repair c.c from the label. Bindings and canonical gates still apply.
      const supported = raw.d.filter((d: any) => d.r === 'ENTAILED' && d.f.includes(c.i) && d.m && d.o && d.q && d.v && d.l && (!d.n || d.a)).map((d: any) => d.i);
      if (!ids(c.u, supported, 6, c.c)) return null;
      const seenObligations = new Set();
      for (const o of c.o) {
        if (!shape(o, OBLIGATION_FIELDS) || !facet.obligations.some(f => f.id === o.i) || seenObligations.has(o.i) ||
          !['COVERED', 'UNRESOLVED'].includes(o.s) || !ids(o.u, supported, 6, o.s === 'COVERED')) return null;
        seenObligations.add(o.i);
      }
      seenFacets.add(c.i);
    }
    return { decisions: raw.d.map((d: any) => expand(d, DECISION_FIELDS)), coverage: raw.c.map((c: any) => ({
      ...expand(c, COVERAGE_FIELDS), obligations: c.o.map((o: any) => expand(o, OBLIGATION_FIELDS)),
    })) };
  } catch { return null; }
}
