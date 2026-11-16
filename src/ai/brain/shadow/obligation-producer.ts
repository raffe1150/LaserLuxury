import type { AnswerManifest, Facet } from '../../business-information-answer-plan';
import { SUPPORTED_CONVERSATION_LANGUAGES } from '../../language-brain';
import { hashRecord } from '../evidence/bind';
import { SEMANTIC_LIMITS, type QuestionType } from '../semantic/contracts';
import type { ShadowObligation } from './knowledge-shadow';

/** Phase 6C: pure, deterministic producer of Brain V2 Knowledge obligations
 * from the product's own planned obligations for one native turn.
 *
 * It never interprets customer text and never calls a model: every Brain V2
 * obligation is exactly one product obligation (same ID, same question type, same
 * order). Anything missing, ambiguous or unsupported fails closed, so the shadow
 * comparison does not run. No I/O, no clock, no logging, no mutation. */

const QUESTION_TYPES: readonly QuestionType[] = Object.freeze(['description', 'recommendation', 'requirement', 'permission', 'prohibition']);
const LANGUAGES: readonly string[] = SUPPORTED_CONVERSATION_LANGUAGES;
export const SHADOW_OBLIGATION_LIMIT = SEMANTIC_LIMITS.goalObligations;
export const SHADOW_SCOPE_SCHEMA = 'odinlink-brain-v2-knowledge-shadow-scope-v1';

export type ObligationProducerInput = Readonly<{
  tenantId: number;
  /** Opaque, server-derived conversation key (never raw customer identifiers). */
  conversationId: string;
  /** Server-assigned turn number for this conversation. */
  turn: number;
  /** The turn's server-resolved reply language. */
  language: string;
  /** The product planner's facets for this turn, exactly as passed to the builder. */
  planned: readonly Facet[];
  /** The same-turn product manifest built from `planned`. */
  manifest: AnswerManifest;
}>;
export type ObligationProducerFailure =
  | 'INVALID_INPUT' | 'LANGUAGE_UNSUPPORTED' | 'LANGUAGE_MISMATCH' | 'TENANT_MISMATCH' | 'NO_OBLIGATIONS'
  | 'OBLIGATION_LIMIT' | 'INVALID_OBLIGATION_ID' | 'DUPLICATE_OBLIGATION_ID' | 'PLAN_MANIFEST_MISMATCH'
  | 'UNSUPPORTED_QUESTION_TYPE' | 'UNSUPPORTED_OBLIGATION';
export type ProducedObligations =
  | Readonly<{ ok: true; tenantId: number; conversationId: string; turn: number; language: string;
      requestDigest: string; obligations: readonly ShadowObligation[] }>
  | Readonly<{ ok: false; reason: ObligationProducerFailure }>;

const fail = (reason: ObligationProducerFailure): ProducedObligations => Object.freeze({ ok: false, reason });
const text = (v: unknown, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;
const object = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deterministic: same input, same output. Never throws. */
export function produceShadowObligations(input: ObligationProducerInput): ProducedObligations {
  try {
    if (!object(input)) return fail('INVALID_INPUT');
    const { tenantId, conversationId, turn, language, planned, manifest } = input;
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !text(conversationId, 256) ||
        !Number.isSafeInteger(turn) || turn < 0 || typeof language !== 'string' ||
        !Array.isArray(planned) || !object(manifest) || !Object.isFrozen(manifest) || !Array.isArray(manifest.facets))
      return fail('INVALID_INPUT');
    if (!LANGUAGES.includes(language)) return fail('LANGUAGE_UNSUPPORTED');
    if (manifest.language !== language) return fail('LANGUAGE_MISMATCH');
    if (!planned.length) return fail('NO_OBLIGATIONS');
    if (planned.length !== manifest.facets.length) return fail('PLAN_MANIFEST_MISMATCH');

    const obligations: ShadowObligation[] = [];
    for (const [i, facet] of planned.entries()) {
      const built = manifest.facets[i];
      if (!object(facet) || !Object.isFrozen(facet) || !object(built) || !Array.isArray(facet.obligations) || !Array.isArray(built.obligations))
        return fail('INVALID_INPUT');
      if (facet.id !== `f${i + 1}`) return fail('INVALID_OBLIGATION_ID');
      if (built.id !== facet.id || built.subject !== facet.subject || built.attribute !== facet.attribute ||
          built.questionType !== facet.questionType || built.obligations.length !== facet.obligations.length)
        return fail('PLAN_MANIFEST_MISMATCH');
      if (!QUESTION_TYPES.includes(facet.questionType)) return fail('UNSUPPORTED_QUESTION_TYPE');
      if (!facet.obligations.length) return fail('NO_OBLIGATIONS');
      for (const [j, obligation] of facet.obligations.entries()) {
        const twin = built.obligations[j];
        if (!object(obligation) || !Object.isFrozen(obligation) || !object(twin)) return fail('INVALID_INPUT');
        if (obligation.id !== `${facet.id}.o${j + 1}`) return fail('INVALID_OBLIGATION_ID');
        if (twin.id !== obligation.id || twin.description !== obligation.description || twin.questionType !== obligation.questionType ||
            (twin.catalogRequirement === undefined) !== (obligation.catalogRequirement === undefined))
          return fail('PLAN_MANIFEST_MISMATCH');
        if (!QUESTION_TYPES.includes(obligation.questionType)) return fail('UNSUPPORTED_QUESTION_TYPE');
        // Catalog price/duration obligations are answered from configured services,
        // not policy evidence; Brain V2 has no binding for them.
        if (obligation.catalogRequirement !== undefined)
          return fail(obligation.catalogRequirement?.businessId !== tenantId ? 'TENANT_MISMATCH' : 'UNSUPPORTED_OBLIGATION');
        obligations.push(Object.freeze({ obligationId: obligation.id, questionType: obligation.questionType }));
      }
    }
    if (obligations.length > SHADOW_OBLIGATION_LIMIT) return fail('OBLIGATION_LIMIT');
    if (new Set(obligations.map(o => o.obligationId)).size !== obligations.length) return fail('DUPLICATE_OBLIGATION_ID');
    // Content-free scope digest: identifiers and structure only, never wording.
    const requestDigest = hashRecord([SHADOW_SCOPE_SCHEMA, tenantId, conversationId, turn, language,
      obligations.map(o => [o.obligationId, o.questionType])]);
    return Object.freeze({ ok: true, tenantId, conversationId, turn, language, requestDigest, obligations: Object.freeze(obligations) });
  } catch {
    return fail('INVALID_INPUT');
  }
}
