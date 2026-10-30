import type { UnifiedAiStructuredOutputRequest } from './providers/provider';
import { NATURAL_FLAGS } from './grounded-knowledge-composition';
import { compactVerificationEnabled, compactVerificationSchema, COMPACT_VERIFICATION_NAME } from './knowledge-compact-verification';
import { COVERAGE_WITNESS_PROTOCOL, COVERAGE_WITNESS_SCHEMA_NAME, coverageWitnessSchema, type CoverageWitnessAssessment } from './knowledge-coverage-witness';

export type KnowledgeVerificationProtocol = 'v2' | 'compact-v1' | typeof COVERAGE_WITNESS_PROTOCOL;
export type KnowledgeExtractionProtocol = 'v2' | 'literal-evidence-v1';
export function assertKnowledgeExtractionProtocol(value:unknown):asserts value is KnowledgeExtractionProtocol {
  if(value!=='v2'&&value!=='literal-evidence-v1')throw Error('unsupported_knowledge_extraction_protocol');
}
/** Backend configuration, captured once; never selected by a model or customer. */
export function selectKnowledgeExtractionProtocol():KnowledgeExtractionProtocol {
  const value=process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL??'v2';
  assertKnowledgeExtractionProtocol(value);return value;
}
/** Backend configuration only. Capture once before request work; never select
 * from model output, customer text, or a later environment read. */
export function selectKnowledgeVerificationProtocol(): KnowledgeVerificationProtocol {
  const configured = process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL;
  if (configured === undefined) return compactVerificationEnabled() ? 'compact-v1' : 'v2';
  if (configured !== 'v2' && configured !== COVERAGE_WITNESS_PROTOCOL) throw new Error('unsupported_knowledge_verifier_protocol');
  if (compactVerificationEnabled()) throw new Error('conflicting_knowledge_verifier_protocols');
  return configured;
}
export function assertKnowledgeVerificationProtocol(protocol: KnowledgeVerificationProtocol): void {
  if (!['v2','compact-v1',COVERAGE_WITNESS_PROTOCOL].includes(protocol)) throw new Error('unsupported_knowledge_verifier_protocol');
}

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
  'DIRECT_SINGLE_UNIT', 'DIRECT_VERIFIED_UNITS', 'COMPOSED', 'COMPOSER_FALLBACK', 'COMPOSER_SKIPPED_BUDGET', 'LEGACY_ROUTE', 'PUBLICATION_SUPPRESSED',
  'NATURAL_ACCEPTED', 'NATURAL_PROPOSAL_INVALID', 'NATURAL_CONTRACT_INVALID', 'NATURAL_BINDINGS', 'NATURAL_REPETITION', 'NATURAL_IDENTIFIER',
  'NATURAL_VERDICT_INVALID', 'NATURAL_SEMANTIC_REJECTION', 'NATURAL_COVERAGE_REJECTION', 'NATURAL_SINGLE_PARTIAL_DISABLED', 'NATURAL_TIMEOUT',
  'PUBLICATION_RESERVE', 'SOURCE_UNAVAILABLE', 'STAGE_ADMISSION', 'LITERAL_REQUEST_FALLBACK', 'LITERAL_REQUEST_DIRECT',
  'COVERAGE_WITNESS_VALID', 'COVERAGE_WITNESS_UNKNOWN', 'COVERAGE_WITNESS_INVALID',
] as const;
export type DecisionReason = typeof DECISION_REASONS[number];
export type KnowledgeDecision = {
  stage: KnowledgeStage; reason: DecisionReason; unitId?: string; facetId?: string; incompletenessReason?: 'NONE' | 'MISSING_RELEVANT_FACT' | 'MISSING_CONDITION' | 'MISSING_RECOMMENDATION' | 'UNRESOLVED';
  relation?: typeof RELATIONS[number] | 'INVALID';
  flags?: { meaningPreserved: boolean | null; modalityPreserved: boolean | null; qualifiersPreserved: boolean | null;
    relevant: boolean | null; languageCorrect: boolean | null; negativeAbsence: boolean | null; explicitAbsenceEvidence: boolean | null };
  counts?: { proposed: number; parsed: number; verified: number; rejected: number };
  facets?: readonly { type: string; obligations: number; status?: string }[];
  sourceIndex?: number; valid?: boolean; remainingMs?: number; startingBudgetMs?: number; startedAtMs?: number; reserveMs?: number;
  sources?: readonly { index: number; valid: boolean; reason: DecisionReason }[];
  correlationId?: string; durationMs?: number; transportSuccess?: boolean; inputTokens?: number | null; outputTokens?: number | null;
  outputMode?: 'json_schema' | 'validated_text';
  failureCategory?: string;
  citationSubtype?: import('./knowledge-citation').CitationSubtype; typographyHint?: boolean;
  blockId?: string; blockKind?: 'fact'|'uncertainty'|'courtesy'; requestedLanguage?: string;
  semanticVerifiedUnits?: number; publishableUnits?: number; deadlineAt?: number; timeoutMs?: number;
  natural?: { schemaVersion: string; outcome: 'accepted_natural'|'canonical_fallback'|'direct_canonical'; reason: DecisionReason | null };
  route?: 'verified_manifest' | 'partial_manifest' | 'unavailable' | 'suppressed' | 'legacy';
  providerAttempted?: boolean;
  admission?: ReturnType<typeof verificationAdmissionDiagnostic>;
  verificationProtocol?: KnowledgeVerificationProtocol;
  coverageWitness?: CoverageWitnessAssessment;
};

/** Snapshot the existing remaining-minus-reserve guard and trace atomically. */
export function verificationAdmissionDiagnostic(remainingMs: number, publicationReserveMs: number,
  verificationAdmissionFloorMs: number, checkpoint: 'before_queue' | 'after_queue') {
  const bounded = (n: number) => Number.isFinite(n) ? Math.min(60_000, Math.max(0, Math.floor(n))) : 0;
  const remaining = bounded(remainingMs), reserve = bounded(publicationReserveMs), floor = bounded(verificationAdmissionFloorMs);
  const effectiveAllowanceMs = Math.max(0, remaining - reserve);
  return { checkpoint, remainingBudgetMs: remaining, publicationReserveMs: reserve,
    verificationAdmissionFloorMs: floor, effectiveAllowanceMs,
    admitted: effectiveAllowanceMs >= floor,
    rejectionReason: effectiveAllowanceMs >= floor ? 'NONE' as const : 'INSUFFICIENT_VERIFICATION_ALLOWANCE' as const };
}

export function knowledgeDiagnosticFailure(event: KnowledgeDecision) {
  if (event.reason === 'STAGE_ADMISSION') return 'not_admitted';
  if (event.transportSuccess === false && event.failureCategory === 'TIMEOUT') return event.providerAttempted === false ? 'queue_timeout' : 'provider_timeout';
  if (['MALFORMED_JSON', 'MALFORMED_ARRAY', 'MALFORMED_RESPONSE', 'INVALID_FIELDS',
    'MISSING_VERDICT', 'DUPLICATE_VERDICT', 'WRONG_VERDICT_ID', 'INVALID_RELATION', 'INVALID_FLAGS', 'NATURAL_VERDICT_INVALID'].includes(event.reason)) return 'decoder_failure';
  if (['MISSING_COVERAGE', 'INVALID_COVERAGE', 'REQUEST_OBLIGATIONS_MISSING', 'MATERIAL_FACTS_MISSING',
    'OBLIGATION_UNRESOLVED', 'NATURAL_COVERAGE_REJECTION', 'COVERAGE_WITNESS_UNKNOWN', 'COVERAGE_WITNESS_INVALID'].includes(event.reason)) return 'incomplete_coverage';
  if (['SOURCE_INVALID', 'SOURCE_CHANGED', 'SOURCE_SCOPE', 'SOURCE_MISSING_OR_UNAUTHORIZED', 'SOURCE_NOT_READY',
    'SOURCE_REVISION', 'SOURCE_CHUNK', 'SOURCE_QUARANTINED', 'VALIDATOR_ERROR', 'SOURCE_UNAVAILABLE'].includes(event.reason)) return 'source_invalidation';
  if (event.stage === 'verification' && ['UNKNOWN', 'CONTRADICTED', 'NOT_APPLICABLE', 'MEANING_CHANGED',
    'MODALITY_CHANGED', 'QUALIFIERS_CHANGED', 'NOT_RELEVANT', 'NEGATIVE_ABSENCE'].includes(event.reason)) return 'semantic_rejection';
  if (event.reason === 'DEADLINE') return 'deadline';
  if (event.reason === 'PROVIDER_FAILURE') return 'provider_failure';
  return 'none';
}

// These schemas use the adapter's existing OpenAI JSON-schema capability. Bounds
// and cross-reference constraints are also enforced in application code. Gemini
// keeps its validated structured-text protocol; no schema parity is assumed.
const str = { type: 'string' };
const bool = { type: 'boolean' };
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const questionType = enumeration(QUESTION_TYPES);
const coverage = object({ facetId: str, requestAligned: bool, materialFactsComplete: bool,
  incompletenessReason: enumeration(['NONE','MISSING_RELEVANT_FACT','MISSING_CONDITION','MISSING_RECOMMENDATION','UNRESOLVED']),
  materialUnitIds: array(str), obligations: array(object({ obligationId: str,
  status: enumeration(['COVERED', 'UNRESOLVED']), unitIds: array(str) })) });
const extractionUnit = object({ facetIds: array(str), subject: str, predicate: str, value: str,
  modality: enumeration(MODALITIES), negation: bool, scope: str, qualifiers: array(str), language: str, text: str,
  evidenceRefs: array(object({ evidenceId: str, exactQuote: str })) });
const schemas = {
  planning: object({ canonicalMeaning: str, queries: array(str), queryLanguages: array(object({ query: str, language: enumeration(['sv','en','de','es','fa','ar']) })),
    requestKind: enumeration(['BUSINESS_INFORMATION','GENERAL_CONVERSATION']), referenceResolution: enumeration(['RESOLVED','UNRESOLVED','NOT_REQUIRED']), requestedFacets: array(object({ subject: str, attribute: str, questionType,
      obligations: array(object({ description: str, questionType })) })) }),
  extraction: object({ oversized: bool, units: array(extractionUnit) }),
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
export function knowledgeStructuredOutput(stage: keyof typeof schemas|'presentation_verification', natural=false,
  allowedFacetIds?: readonly string[], maximumUnits=6, verificationProtocol?: KnowledgeVerificationProtocol,
  extractionProtocol:KnowledgeExtractionProtocol='v2'): UnifiedAiStructuredOutputRequest {
  assertKnowledgeExtractionProtocol(extractionProtocol);
  if(stage==='verification') {
    const protocol = verificationProtocol ?? selectKnowledgeVerificationProtocol();
    assertKnowledgeVerificationProtocol(protocol);
    if(protocol==='compact-v1')return{name:COMPACT_VERIFICATION_NAME,strict:true,schema:compactVerificationSchema()};
    if(protocol===COVERAGE_WITNESS_PROTOCOL)return{name:COVERAGE_WITNESS_SCHEMA_NAME,strict:true,schema:coverageWitnessSchema(schemas.verification)};
  }
  if(stage==='presentation_verification')return{name:'odinlink_natural_validation_v1',strict:true,schema:naturalValidation};
  // Request-local enum, never a shared-schema mutation or a parser repair.
  // Existing callers without a captured facet set retain their wire contract.
  const literal=extractionProtocol==='literal-evidence-v1';
  let extraction:ReturnType<typeof object> = schemas.extraction;
  if(stage==='extraction'&&literal)extraction=object({...schemas.extraction.properties,units:array(object({
    ...extractionUnit.properties,evidenceRefs:array(object({evidenceId:str})),
  }))});
  if(stage==='extraction' && allowedFacetIds!==undefined) {
    if(!allowedFacetIds.length || allowedFacetIds.length>4 || new Set(allowedFacetIds).size!==allowedFacetIds.length ||
      allowedFacetIds.some(id=>typeof id!=='string'||!id.trim()||id.length>8))throw new Error('invalid_allowed_facet_ids');
    if(!Number.isInteger(maximumUnits)||maximumUnits<1||maximumUnits>6)throw new Error('invalid_unit_limit');
    const bounded=(maxLength:number)=>({type:'string',minLength:1,maxLength});
    extraction = object({...schemas.extraction.properties,units:{...array(object({
      ...extractionUnit.properties,
      subject:bounded(240),predicate:bounded(240),value:bounded(600),scope:bounded(400),text:bounded(800),
      qualifiers:{...array(bounded(300)),maxItems:8},
      evidenceRefs:{...array(object(literal?{evidenceId:str}:{evidenceId:str,exactQuote:bounded(2400)})),minItems:1,maxItems:4},
      facetIds:{type:'array',items:enumeration(allowedFacetIds),minItems:1,maxItems:4},
    })),maxItems:maximumUnits}});
  }
  if(stage==='extraction'&&natural)return{name:literal?'odinlink_natural_extraction_literal_v1':'odinlink_natural_extraction_v1',strict:true,
    schema:object({...extraction.properties,naturalProposal:{anyOf:[{type:'null'},naturalProposal]}})};
  if(stage==='extraction')return{name:literal?'odinlink_knowledge_extraction_literal_v1':'odinlink_knowledge_extraction_v2',strict:true,schema:extraction};
  return { name: `odinlink_knowledge_${stage}_v2`, strict: true, schema: schemas[stage] };
}

export function knowledgeFailureReason(error: unknown): DecisionReason {
  // Never pass exception messages (which may contain provider bodies) into logs.
  const category = (error as any)?.category;
  const message = error instanceof Error ? error.message : '';
  if (category === 'TIMEOUT' || /^information_deadline$/u.test(message)) return 'DEADLINE';
  if (category === 'MALFORMED_RESPONSE') return 'MALFORMED_RESPONSE';
  if (message === 'information_budget_exhausted') return 'BUDGET_EXHAUSTED';
  if (message === 'information_verification_admission' || message === 'information_proposal_admission') return 'STAGE_ADMISSION';
  if (message === 'information_publication_reserve') return 'PUBLICATION_RESERVE';
  return 'PROVIDER_FAILURE';
}

export function safeModelIdentifier(value: string): string {
  return value.length <= 96 && /^[a-z0-9][a-z0-9._/-]*$/iu.test(value) && !/^(?:sk-|AIza)/u.test(value) ? value : 'invalid_identifier';
}
