import { UNIT_VERIFICATION_INSTRUCTION, parseRequestedFacets } from '../../src/ai/business-information-answer-plan';
import { MODALITIES, knowledgeStructuredOutput } from '../../src/ai/knowledge-answer-protocol';

type Protocol = 'v2' | 'source-exhaustive-v2';
type Schema = {
  type: 'object' | 'array' | 'boolean' | 'string';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  enum?: readonly string[];
};
type CitationBindings = Readonly<Record<string, readonly string[]>>;
const enumString = (values: readonly string[]): Schema => ({ type: 'string', enum: values });
export const connectiveRoles = ['purpose', 'upper_bound', 'lower_bound', 'none', 'unknown'] as const;
const modality = enumString([...MODALITIES, 'unknown']);
const bound = enumString(['unbounded', 'minimum', 'maximum', 'strict_minimum', 'strict_maximum', 'unknown']);
const permittedIds = (prefix: string) => Array.from({ length: 6 }, (_, i) => prefix + (i + 1));
const anchor = enumString(['before_appointment', 'after_appointment', 'other', 'unknown']);

export function semanticFormat(protocol: Protocol, bindings: CitationBindings) {
  const unitIds = Object.keys(bindings);
  const evidenceIds = [...new Set(Object.values(bindings).flat())];
  if (unitIds.length < 1 || unitIds.length > 6 || evidenceIds.length < 1 || evidenceIds.length > 6 ||
      unitIds.some(id => !permittedIds('u').includes(id) || bindings[id].length < 1 || bindings[id].length > 4) ||
      evidenceIds.some(id => !permittedIds('e').includes(id))) throw new Error('Invalid experimental citation bindings');
  const base = structuredClone(knowledgeStructuredOutput('verification', false, undefined, 6, protocol).schema) as Schema;
  const properties = {
    unitId: enumString(unitIds), evidenceId: enumString(evidenceIds),
    connectiveRole: enumString(connectiveRoles),
    candidateModality: modality, sourceModality: modality, candidateBound: bound, sourceBound: bound,
    candidateAnchor: anchor, sourceAnchor: anchor,
  };
  const findings: Schema = { type: 'array', minItems: unitIds.length, maxItems: unitIds.length,
    items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
  return { type: 'json_schema' as const, name: `odinlink_semantic_experiment_${protocol.replaceAll('-', '_')}_roles2`, strict: true as const,
    schema: { ...base, properties: { ...base.properties, findings }, required: [...base.required!, 'findings'] } };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type ExperimentDiagnostic =
  | 'TRANSPORT_ERROR' | 'INVALID_RESPONSE_ENVELOPE' | 'INCOMPLETE_RESPONSE' | 'MISSING_OUTPUT_TEXT'
  | 'OUTPUT_TOO_LARGE' | 'MALFORMED_JSON' | 'MISSING_REQUIRED_FIELD' | 'INVALID_FIELD'
  | 'INVALID_ENUM' | 'UNIT_BINDING_MISMATCH' | 'EVIDENCE_BINDING_MISMATCH'
  | 'DUPLICATE_FINDING' | 'DUPLICATE_VERDICT' | 'CONTRADICTORY_FINDING'
  | 'MODALITY_MISMATCH' | 'BOUND_MISMATCH' | 'ANCHOR_MISMATCH' | 'VERDICT_NOT_SUPPORTIVE';
type DiagnosticSink = (code: ExperimentDiagnostic) => void;

// Report only the first schema error. The walk follows schema-owned keys
// and emits neither model-generated paths nor values.
function schemaError(value: unknown, schema: Schema, field?: string): ExperimentDiagnostic | undefined {
  if (schema.type === 'object') {
    if (!record(value)) return 'INVALID_FIELD';
    if (schema.required!.some(key => !Object.hasOwn(value, key))) return 'MISSING_REQUIRED_FIELD';
    if (Object.keys(value).length !== schema.required!.length) return 'INVALID_FIELD';
    for (const key of schema.required!) {
      const error = schemaError(value[key], schema.properties![key], key);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
      return 'INVALID_FIELD';
    for (const item of value) {
      const error = schemaError(item, schema.items!);
      if (error) return error;
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return 'INVALID_FIELD';
    if (schema.enum && !schema.enum.includes(value))
      return field === 'unitId' ? 'UNIT_BINDING_MISMATCH' :
        field === 'evidenceId' ? 'EVIDENCE_BINDING_MISMATCH' : 'INVALID_ENUM';
  } else if (typeof value !== 'boolean') return 'INVALID_FIELD';
}

export function decodeExperiment(text: string, protocol: Protocol, bindings: CitationBindings,
  diagnostic: DiagnosticSink = () => {}) {
  const reject = (code: ExperimentDiagnostic) => { diagnostic(code); return null; };
  if (Buffer.byteLength(text) > 16_384) return reject('OUTPUT_TOO_LARGE');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return reject('MALFORMED_JSON'); }
  if (!record(raw)) return reject('INVALID_RESPONSE_ENVELOPE');
  const error = schemaError(raw, semanticFormat(protocol, bindings).schema);
  if (error) return reject(error);
  const { findings, ...baseline } = raw as { findings: Record<string, string>[]; decisions: Record<string, unknown>[] };
  const decisionIds = baseline.decisions.map(row => row.unitId);
  if (new Set(decisionIds).size !== decisionIds.length) return reject('DUPLICATE_VERDICT');
  if (new Set(findings.map(row => row.unitId)).size !== findings.length) return reject('DUPLICATE_FINDING');
  if (decisionIds.length !== findings.length) return reject('UNIT_BINDING_MISMATCH');
  for (const row of findings) {
    if (!decisionIds.includes(row.unitId)) return reject('UNIT_BINDING_MISMATCH');
    if (!bindings[row.unitId].includes(row.evidenceId)) return reject('EVIDENCE_BINDING_MISMATCH');
    // A purpose clause can accompany an independent numerical bound.
    if (row.connectiveRole === 'upper_bound' && !['maximum', 'strict_maximum'].includes(row.candidateBound) ||
        row.connectiveRole === 'lower_bound' && !['minimum', 'strict_minimum'].includes(row.candidateBound))
      return reject('CONTRADICTORY_FINDING');
  }
  const unsupported = (code: ExperimentDiagnostic) => { diagnostic(code); return false; };
  const supportedPurposeUnitIds = findings.filter(row => {
    if (row.connectiveRole !== 'purpose') return false;
    const verdict = baseline.decisions.find(d => d.unitId === row.unitId)!;
    // A well-formed finding can still be ineligible. These codes describe
    // that decision without making a non-supporting batch a parse failure.
    if (row.candidateModality !== 'recommended' || row.sourceModality !== 'recommended')
      return unsupported('MODALITY_MISMATCH');
    if (row.candidateBound !== 'unbounded' || row.sourceBound !== 'unbounded')
      return unsupported('BOUND_MISMATCH');
    if (row.candidateAnchor !== 'before_appointment' || row.sourceAnchor !== 'before_appointment')
      return unsupported('ANCHOR_MISMATCH');
    if (verdict.relation !== 'ENTAILED' || verdict.negativeAbsence !== false ||
        !['meaningPreserved','modalityPreserved','qualifiersPreserved','relevant','languageCorrect']
          .every(key => verdict[key] === true)) return unsupported('VERDICT_NOT_SUPPORTIVE');
    return true;
  }).map(row => row.unitId);
  return { baseline, findings, supportedPurposeUnitIds };
}

// Accept a parsed Responses envelope or a caller-reported transport failure.
// Neither provider errors nor content are copied into diagnostic output.
export function decodeExperimentResponse(response: unknown, protocol: Protocol, bindings: CitationBindings,
  diagnostic: DiagnosticSink, transportFailed = false) {
  const reject = (code: ExperimentDiagnostic) => { diagnostic(code); return null; };
  if (transportFailed) return reject('TRANSPORT_ERROR');
  if (!record(response) || typeof response.status !== 'string') return reject('INVALID_RESPONSE_ENVELOPE');
  if (response.status !== 'completed') return reject('INCOMPLETE_RESPONSE');
  if (!Array.isArray(response.output)) return reject('INVALID_RESPONSE_ENVELOPE');
  let text = '';
  for (const item of response.output) {
    if (!record(item) || typeof item.type !== 'string') return reject('INVALID_RESPONSE_ENVELOPE');
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || !Array.isArray(item.content)) return reject('INVALID_RESPONSE_ENVELOPE');
    for (const content of item.content) {
      if (!record(content) || typeof content.type !== 'string') return reject('INVALID_RESPONSE_ENVELOPE');
      if (content.type === 'refusal') return reject('INCOMPLETE_RESPONSE');
      if (content.type !== 'output_text' || typeof content.text !== 'string') return reject('INVALID_RESPONSE_ENVELOPE');
      text += content.text;
      if (Buffer.byteLength(text) > 16_384) return reject('OUTPUT_TOO_LARGE');
    }
  }
  if (!text.trim()) return reject('MISSING_OUTPUT_TEXT');
  return decodeExperiment(text, protocol, bindings, diagnostic);
}

export const experimentBindings = { u1: ['e1'], u2: ['e1'] } as const;
const question = 'برای مراجعهٔ اول، چه زمانی پیش از نوبت بهتر است برسم؟';
const quote = 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig inför besöket.';
const facets = parseRequestedFacets([{subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation'}]).facets;
const texts = [
  'به کسانی که نخستین بار مراجعه می‌کنند توصیه می‌شود حدود ۱۰ دقیقه پیش از نوبت برسند تا برای شروع آماده باشند.',
  'به کسانی که نخستین بار مراجعه می‌کنند توصیه می‌شود حداکثر ۱۰ دقیقه پیش از نوبت برسند.',
];
export const experimentalRequest = {
  model: 'gpt-5.6-luna',
  store: false,
  reasoning: { effort: 'low' },
  max_output_tokens: 2048,
  tools: [],
  instructions: UNIT_VERIFICATION_INSTRUCTION + '\nThis offline experiment also requires one findings row per unit. Classify the role of an actual clause- or phrase-linking connective in the candidate: purpose introduces a goal; upper_bound or lower_bound imposes a numerical limit through the connective itself; none means there is no relevant connective; unknown means the role is uncertain. A standalone explicit maximum or minimum marker is not a connective: report none for the role if no other relevant connective is present and record its limit in candidateBound. Assess candidateBound over the whole candidate, including any explicit markers, independently of connectiveRole. Bind the finding to an evidenceId already cited by that unit. Report candidate and source modality, numerical bound, and temporal anchor independently. Use unknown for any indeterminate field. Preserve the existing decisions and coverage rules. Do not rewrite or publish anything.',
  input: [{ role: 'user', content: JSON.stringify({
    question, requestedLanguage: 'fa', facets, authoritativeEvidence: '{}',
    evidence: [{ id: 'e1', businessId: 77, text: quote }],
    units: texts.map((text, index) => ({ id: `u${index + 1}`, text, language: 'fa', facetIds: ['f1'],
      subject: 'first-time visitors', predicate: 'arrival timing', value: index ? 'at most 10 minutes' : 'about 10 minutes',
      modality: 'recommended', negation: false, scope: 'first visit', qualifiers: ['before booked appointment'],
      evidenceRefs: [{ evidenceId: 'e1', exactQuote: quote }] })),
  }) }],
  text: { format: semanticFormat('v2', experimentBindings) },
};
