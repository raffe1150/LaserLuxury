/**
 * Knowledge Reliability Evaluation Engine — schema (Unified Brain V2, Phase 2).
 *
 * Ground truth is authored from tenant source material only. It never reads,
 * imports or derives anything from OdinLink planning, extraction, verifier or
 * publication output. Evaluation modules are offline tooling; nothing here is
 * imported by production answering.
 */
export const EVAL_SCHEMA_VERSION = 'odinlink-eval-case-v1' as const;
export const EVAL_LANGUAGES = ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const;
export const EVAL_CHANNELS = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
export const QUESTION_TYPES = ['description', 'recommendation', 'requirement', 'permission', 'prohibition'] as const;
export const ROUTES = ['new_booking', 'cancellation', 'reschedule', 'booking_lookup', 'availability'] as const;

export type EvalLanguage = typeof EVAL_LANGUAGES[number];
export type EvalChannel = typeof EVAL_CHANNELS[number];
export type QuestionType = typeof QUESTION_TYPES[number];
export type Route = typeof ROUTES[number];
export type Modality = 'descriptive' | 'recommended' | 'required' | 'permitted' | 'prohibited';

/** What a correct assistant must do for one requested obligation. */
export type Expectation =
  | 'ANSWER'          // state the required facts (with their conditions/modality)
  | 'DISCLOSE'        // say the requested information is not verified; never claim absence; related facts may be given
  | 'CORRECT_PREMISE' // reject the false assumption using the required facts
  | 'CLARIFY'         // ask which option is meant (options = candidate facts); never pick one silently
  | 'REFUSE_FOREIGN'  // information exists only for another tenant: disclose; never use the foreign facts
  | 'ROUTE';          // hand to the booking engine; Knowledge must not confirm or mutate a booking

export type Obligation = Readonly<{
  id: string;
  expect: Expectation;
  questionType?: QuestionType;
  route?: Route;
  /** Facts that must be conveyed (ANSWER/CORRECT_PREMISE) or are acceptable related context (DISCLOSE). */
  facts: readonly string[];
  /** Fact IDs of another tenant that must NOT be used (REFUSE_FOREIGN) or candidate options (CLARIFY). */
  foreignFacts?: readonly string[];
}>;

export type EvidenceProfile = 'CURRENT' | 'STALE' | 'CROSS_TENANT' | 'CONFLICTING';
export type ReviewStatus = 'AUTHORED_PENDING_NATIVE_REVIEW' | 'REPO_FIXTURE_QUESTION' | 'RECORDED_QUESTION' | 'NEEDS_OWNER_DECISION';
export type Family = 'direct' | 'indirect' | 'modality' | 'premise' | 'numeric' | 'unverified' | 'compound' | 'multiturn' |
  'action' | 'clarify' | 'cross_tenant' | 'stale' | 'conflict' | 'mixed_language' | 'recorded';

export type EvalCase = Readonly<{
  schema: typeof EVAL_SCHEMA_VERSION;
  id: string;
  /** Language-independent semantic signature; variants of one scenario share it. */
  semanticKey: string;
  family: Family;
  tenantId: number;
  language: EvalLanguage;
  /** Acceptable reply languages (mixed-language input may allow more than one). */
  replyLanguages: readonly EvalLanguage[];
  channel: EvalChannel;
  /** Customer turns, oldest first. The last turn is evaluated. */
  turns: readonly string[];
  obligations: readonly Obligation[];
  /** Claims a correct answer must not make (human-readable, reviewed). */
  forbiddenClaims: readonly string[];
  /** Numbers that must not be asserted as source values (deterministic check). */
  forbiddenNumbers?: readonly string[];
  /** Source text that must not be used because it is not current. */
  forbiddenStaleText?: readonly string[];
  evidenceProfile: EvidenceProfile;
  categories: readonly string[];
  provenance: Readonly<{ question: string; review: ReviewStatus; note?: string }>;
}>;

/** One atomic, source-grounded proposition. */
export type Fact = Readonly<{
  id: string;
  tenantId: number;
  source: string;           // SourceRecord.key
  /** Exact substring of the source text (document facts). */
  quote?: string;
  /** Structured configuration value (configuration facts). */
  config?: Readonly<{ path: readonly (string | number)[]; value: unknown }>;
  modality: Modality;
  negation: boolean;
  numbers?: readonly string[];
  conditions?: readonly string[];
  /** Other facts stating the same proposition (e.g. the same rule in another current source). */
  sameAs?: readonly string[];
  /** Reviewer paraphrase in English. Documentation and oracle text only; never used for grading meaning. */
  gloss: string;
}>;

export type SourceStatus = 'CURRENT' | 'HISTORICAL' | 'TEMPORARY' | 'SYNTHETIC_NEGATIVE_CONTROL';
export type SourceRecord = Readonly<{
  key: string;
  tenantId: number;
  businessName: string;
  businessType: string;
  sourceId: string;
  kind: 'document' | 'manual' | 'configuration';
  title: string;
  status: SourceStatus;
  /** sha256 of the exact text (documents) or of the canonical JSON (configuration). */
  revision: string;
  text: string;
  provenance: Readonly<{ file: string; fileSha256: string; capturedAt: string; note: string }>;
}>;

export const GRADES = ['PASS', 'FAIL', 'INDETERMINATE', 'NOT_EVALUATED'] as const;
export type Grade = typeof GRADES[number];
export const METRICS = ['correct_complete', 'safe_partial', 'false_fallback', 'unsupported_claim', 'missing_condition',
  'modality_negation', 'language', 'continuity', 'clarification', 'action_routing', 'latency', 'cost_attempts'] as const;
export type Metric = typeof METRICS[number];
export type Tier = 'T1_DETERMINISTIC' | 'T1_POLICY_ORACLE' | 'T2_RECORDED_REPLAY' | 'T2_RECORDED_DELIVERED';

export type MetricResult = Readonly<{
  metric: Metric; grade: Grade; tier: Tier;
  /** Machine-readable reason; always present for FAIL / INDETERMINATE / NOT_EVALUATED. */
  reason: string;
  /** What actually ran: real shared-core function names and any substituted stage. */
  exercised?: readonly string[];
  substituted?: readonly string[];
  evidence?: Readonly<Record<string, unknown>>;
  pendingReview?: boolean;
}>;
