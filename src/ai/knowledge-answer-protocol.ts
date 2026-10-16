import type { UnifiedAiStructuredOutputRequest } from './providers/provider';
import { NATURAL_FLAGS } from './grounded-knowledge-composition';

export const KNOWLEDGE_SCHEMA_VERSION = 'evidence-first-v2';
export const QUESTION_TYPES = ['description', 'recommendation', 'requirement', 'permission', 'prohibition'] as const;
export const MODALITIES = ['descriptive', 'recommended', 'required', 'permitted', 'prohibited'] as const;
export const RELATIONS = ['ENTAILED', 'UNKNOWN', 'CONTRADICTED', 'NOT_APPLICABLE'] as const;
export type KnowledgeStage = 'planning' | 'extraction' | 'verification' | 'composition' | 'presentation_verification' | 'freshness' | 'publication';
export const DECISION_REASONS = [
  'ACCEPTED', 'MALFORMED_JSON', 'MALFORMED_ARRAY', 'LIMIT_EXCEEDED', 'INVALID_FIELDS', 'INVALID_FACET',
  'LANGUAGE_LABEL', 'OPERATION_CLAIM', 'QUESTION_TEXT', 'MISSING_CITATION', 'INVALID_CITATION', 'NUMERICAL_CONSTRAINT',
  'MISSING_VERDICT', 'DUPLICATE_VERDICT', 'WRONG_VERDICT_ID', 'INVALID_RELATION', 'INVALID_FLAGS',
  'UNKNOWN', 'CONTRADICTED', 'NOT_APPLICABLE', 'MEANING_CHANGED', 'MODALITY_CHANGED', 'QUALIFIERS_CHANGED',
  'NOT_RELEVANT', 'VERIFIER_LANGUAGE', 'LOCAL_LANGUAGE', 'NEGATIVE_ABSENCE', 'FACET_MISMATCH',
  'MISSING_COVERAGE', 'INVALID_COVERAGE', 'REQUEST_OBLIGATIONS_MISSING', 'MATERIAL_FACTS_MISSING', 'OBLIGATION_UNRESOLVED',
  'NO_EVIDENCE', 'NO_PARSED_UNITS', 'NO_VERIFIED_UNITS', 'CONTEXT_INVALID', 'SOURCE_INVALID', 'SOURCE_CURRENT', 'SOURCE_CHANGED', 'SOURCE_SCOPE',
  'SOURCE_MISSING_OR_UNAUTHORIZED', 'SOURCE_NOT_READY', 'SOURCE_REVISION', 'SOURCE_CHUNK', 'SOURCE_QUARANTINED', 'VALIDATOR_ERROR',
  'REFUSAL', 'TRUNCATED', 'BLOCKED', 'MALFORMED_RESPONSE', 'PROVIDER_FAILURE', 'DEADLINE', 'BUDGET_EXHAUSTED', 'TOOL_OUTPUT',
  'DIRECT_SINGLE_UNIT', 'COMPOSED', 'COMPOSER_FALLBACK', 'COMPOSER_SKIPPED_BUDGET', 'LEGACY_ROUTE', 'PUBLICATION_SUPPRESSED',
  'NATURAL_ACCEPTED', 'NATURAL_PROPOSAL_INVALID', 'NATURAL_CONTRACT_INVALID', 'NATURAL_BINDINGS', 'NATURAL_REPETITION', 'NATURAL_IDENTIFIER',
  'NATURAL_VERDICT_INVALID', 'NATURAL_SEMANTIC_REJECTION', 'NATURAL_COVERAGE_REJECTION', 'NATURAL_SINGLE_PARTIAL_DISABLED', 'NATURAL_TIMEOUT',
  'PUBLICATION_RESERVE', 'SOURCE_UNAVAILABLE',
] as const;
export type DecisionReason = typeof DECISION_REASONS[number];
export type KnowledgeDecision = {
  stage: KnowledgeStage; reason: DecisionReason; unitId?: string; facetId?: string;
  relation?: typeof RELATIONS[number] | 'INVALID';
  flags?: { meaningPreserved: boolean | null; modalityPreserved: boolean | null; qualifiersPreserved: boolean | null;
    relevant: boolean | null; languageCorrect: boolean | null; negativeAbsence: boolean | null; explicitAbsenceEvidence: boolean | null };
  counts?: { proposed: number; parsed: number; verified: number; rejected: number };
  facets?: readonly { type: string; obligations: number; status?: string }[];
  sourceIndex?: number; valid?: boolean; remainingMs?: number;
  sources?: readonly { index: number; valid: boolean; reason: DecisionReason }[];
  correlationId?: string; durationMs?: number; transportSuccess?: boolean; inputTokens?: number | null; outputTokens?: number | null;
  outputMode?: 'json_schema' | 'validated_text';
  failureCategory?: string;
  blockId?: string; blockKind?: 'fact'|'uncertainty'|'courtesy'; requestedLanguage?: string;
  semanticVerifiedUnits?: number; publishableUnits?: number; deadlineAt?: number; timeoutMs?: number;
  natural?: { schemaVersion: string; outcome: 'accepted_natural'|'canonical_fallback'|'direct_canonical'; reason: DecisionReason | null };
  route?: 'verified_manifest' | 'partial_manifest' | 'unavailable' | 'suppressed' | 'legacy';
};

// These schemas use the adapter's existing OpenAI JSON-schema capability. Bounds
// and cross-reference constraints are also enforced in application code. Gemini
// keeps its validated structured-text protocol; no schema parity is assumed.
const str = { type: 'string' };
const bool = { type: 'boolean' };
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const questionType = enumeration(QUESTION_TYPES);
const coverage = object({ facetId: str, requestAligned: bool, materialFactsComplete: bool, materialUnitIds: array(str), obligations: array(object({ obligationId: str,
  status: enumeration(['COVERED', 'UNRESOLVED']), unitIds: array(str) })) });
const schemas = {
  planning: object({ canonicalMeaning: str, queries: array(str), queryLanguages: array(object({ query: str, language: enumeration(['sv','en','de','es','fa','ar']) })),
    requestKind: enumeration(['BUSINESS_INFORMATION','GENERAL_CONVERSATION']), requestedFacets: array(object({ subject: str, attribute: str, questionType,
      obligations: array(object({ description: str, questionType })) })) }),
  extraction: object({ oversized: bool, units: array(object({ facetIds: array(str), subject: str, predicate: str, value: str,
    modality: enumeration(MODALITIES), negation: bool, scope: str, qualifiers: array(str), language: str, text: str,
    evidenceRefs: array(object({ evidenceId: str, exactQuote: str })) })) }),
  verification: object({ decisions: array(object({ unitId: str, relation: enumeration(RELATIONS), facetIds: array(str),
    meaningPreserved: bool, modalityPreserved: bool, qualifiersPreserved: bool, relevant: bool, languageCorrect: bool,
    explicitAbsenceEvidence: bool, negativeAbsence: bool })), coverage: array(coverage) }),
} as const;
const naturalProposal = object({blocks:array(object({kind:enumeration(['fact','uncertainty','courtesy']),text:str,
  proposedUnitOrdinals:array({type:'integer'}),obligationIds:array(str)}))});
const naturalValidation = object({contractHash:str,proposalHash:str,
  blocks:array(object({blockId:str,relation:enumeration(RELATIONS),noUnsupportedFacts:bool,meaningPreserved:bool,uncertaintyAccurate:bool})),
  unitCoverage:array(object({unitId:str,blockIds:array(str),complete:bool})),obligationCoverage:array(object({obligationId:str,blockIds:array(str),accurate:bool})),
  flags:object(Object.fromEntries(NATURAL_FLAGS.map(key=>[key,bool])))});
export function knowledgeStructuredOutput(stage: keyof typeof schemas|'presentation_verification', natural=false): UnifiedAiStructuredOutputRequest {
  if(stage==='presentation_verification')return{name:'odinlink_natural_validation_v1',strict:true,schema:naturalValidation};
  if(stage==='extraction'&&natural)return{name:'odinlink_natural_extraction_v1',strict:true,
    schema:object({...schemas.extraction.properties,naturalProposal:{anyOf:[{type:'null'},naturalProposal]}})};
  return { name: `odinlink_knowledge_${stage}_v2`, strict: true, schema: schemas[stage] };
}

export function knowledgeFailureReason(error: unknown): DecisionReason {
  // Never pass exception messages (which may contain provider bodies) into logs.
  const category = (error as any)?.category;
  const message = error instanceof Error ? error.message : '';
  if (category === 'TIMEOUT' || /^information_deadline$/u.test(message)) return 'DEADLINE';
  if (category === 'MALFORMED_RESPONSE') return 'MALFORMED_RESPONSE';
  if (message === 'information_budget_exhausted') return 'BUDGET_EXHAUSTED';
  if (message === 'information_publication_reserve') return 'PUBLICATION_RESERVE';
  return 'PROVIDER_FAILURE';
}

export function safeModelIdentifier(value: string): string {
  return value.length <= 96 && /^[a-z0-9][a-z0-9._/-]*$/iu.test(value) && !/^(?:sk-|AIza)/u.test(value) ? value : 'invalid_identifier';
}
