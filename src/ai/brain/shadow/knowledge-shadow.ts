import type { AnswerManifest } from '../../business-information-answer-plan';
import { nativeKnowledgeTiming } from '../../knowledge-timing-policy';
import type { QuestionType } from '../semantic/contracts';
import { bindEvidence, type BindingResult, type Scope } from '../evidence/bind';
import { bindV1Manifest, type CurrentEvidence, type ObligationLink, type V1BindingFailure, type V1PublicationKind } from '../evidence/v1-manifest-binding';

/**
 * Phase 6B: default-disabled Brain V2 Knowledge shadow comparison.
 *
 * Observation only. The existing product remains the sole source of every
 * customer-facing decision: this module never returns text, never throws,
 * performs no provider, network, database, booking, calendar, logging or clock
 * operations, and records no customer or business content. It is not wired
 * into any request path; a host integration requires a separate review.
 *
 * Provenance: only a manifest attested in the same native turn, by the same
 * in-process timing owner and tenant, is accepted. A serialized, cloned or
 * external manifest is a different object and is always rejected.
 */
export const KNOWLEDGE_SHADOW_FLAG = 'ODINLINK_BRAIN_V2_KNOWLEDGE_SHADOW';
export const KNOWLEDGE_SHADOW_TENANTS = 'ODINLINK_BRAIN_V2_KNOWLEDGE_SHADOW_TENANTS';

export type KnowledgeShadowConfig = Readonly<{ enabled: boolean; tenants: ReadonlySet<number> }>;
const DISABLED: KnowledgeShadowConfig = Object.freeze({ enabled: false, tenants: Object.freeze(new Set<number>()) });

/** Exactly `on` plus a non-empty list of positive tenant IDs; anything else is OFF. */
export function knowledgeShadowConfig(env: Readonly<Record<string, string | undefined>> = process.env): KnowledgeShadowConfig {
  if (env[KNOWLEDGE_SHADOW_FLAG] !== 'on') return DISABLED;
  const raw = (env[KNOWLEDGE_SHADOW_TENANTS] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!raw.length || raw.some(s => !/^[1-9][0-9]{0,15}$/.test(s) || !Number.isSafeInteger(Number(s)))) return DISABLED;
  return Object.freeze({ enabled: true, tenants: Object.freeze(new Set(raw.map(Number))) });
}

type Attestation = Readonly<{ tenantId: number; owner: object }>;
const sameTurn = new WeakMap<object, Attestation>();

/** Called by the host immediately after the product builds the manifest, inside
 * that native turn. Returns false (and attests nothing) outside a native turn. */
export function attestSameTurnManifest(manifest: AnswerManifest, tenantId: number): boolean {
  const owner = nativeKnowledgeTiming();
  if (!owner || !manifest || typeof manifest !== 'object' || !Object.isFrozen(manifest) ||
      !Number.isSafeInteger(tenantId) || tenantId <= 0 || sameTurn.has(manifest)) return false;
  sameTurn.set(manifest, Object.freeze({ tenantId, owner }));
  return true;
}

export type ShadowObligation = Readonly<{ obligationId: string; questionType: QuestionType }>;
export type KnowledgeShadowInput = Readonly<{
  tenantId: number; conversationId: string; turn: number; requestDigest: string;
  manifest: AnswerManifest; current: CurrentEvidence;
  /** Brain V2 obligations for this turn, in interpretation order. */
  obligations: readonly ShadowObligation[];
  env?: Readonly<Record<string, string | undefined>>;
}>;
export type ShadowRejection = 'PROVENANCE' | 'MAPPING_UNAVAILABLE' | 'INVALID_INPUT' | V1BindingFailure;
export type KnowledgeShadowRecord =
  | Readonly<{ status: 'DISABLED' | 'NOT_ALLOWLISTED' }>
  | Readonly<{ status: 'REJECTED'; reason: ShadowRejection }>
  | Readonly<{ status: 'ERROR' }>
  | Readonly<{ status: 'COMPARED'; publication: V1PublicationKind; agreement: boolean;
      obligations: readonly Readonly<{ index: number; questionType: QuestionType; v1Coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
        v2Status: BindingResult['status']; v2Reason: string }>[] }>;

const record = <T extends KnowledgeShadowRecord>(value: T) => Object.freeze(value);

/** Deterministic comparison of the product's attested verdicts with Brain V2 binding. Never throws. */
export function runKnowledgeShadow(input: KnowledgeShadowInput): KnowledgeShadowRecord {
  try {
    const config = knowledgeShadowConfig(input?.env);
    if (!config.enabled) return record({ status: 'DISABLED' });
    if (!config.tenants.has(input.tenantId)) return record({ status: 'NOT_ALLOWLISTED' });
    const { tenantId, manifest, current, obligations } = input;
    if (!/^[a-f0-9]{64}$/.test(input.requestDigest ?? '') || typeof input.conversationId !== 'string' || !input.conversationId ||
        !Number.isSafeInteger(input.turn) || input.turn < 0 || !Array.isArray(obligations) || !current)
      return record({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    // Same-turn, same-owner, same-tenant, untouched in-process object only.
    const attested = manifest && typeof manifest === 'object' ? sameTurn.get(manifest) : undefined;
    const owner = nativeKnowledgeTiming();
    if (!attested || !owner || attested.owner !== owner || attested.tenantId !== tenantId || !Object.isFrozen(manifest))
      return record({ status: 'REJECTED', reason: 'PROVENANCE' });
    // Deterministic mapping: same count and pairwise question types, product order.
    const product = manifest.facets.flatMap(facet => facet.obligations.map(obligation => ({ facet, obligation })));
    if (!obligations.length || product.length !== obligations.length ||
        new Set(obligations.map(o => o?.obligationId)).size !== obligations.length ||
        obligations.some((o, i) => typeof o?.obligationId !== 'string' || !o.obligationId || o.questionType !== product[i].obligation.questionType))
      return record({ status: 'REJECTED', reason: 'MAPPING_UNAVAILABLE' });
    const links: ObligationLink[] = obligations.map((o, i) => ({
      facetId: product[i].facet.id, obligationId: product[i].obligation.id,
      scope: Object.freeze({ tenantId, conversationId: input.conversationId, turn: input.turn, obligationId: o.obligationId,
        requestDigest: input.requestDigest, language: manifest.language, questionType: o.questionType }) as Scope,
    }));
    const bound = bindV1Manifest({ tenantId, manifest, current, links });
    if (!bound.ok) return record({ status: 'REJECTED', reason: 'reason' in bound ? bound.reason : 'INVALID_INPUT' });
    // Brain V2 binding at the product's own read time: deterministic, no clock.
    const rows = links.map((link, index) => {
      const result = bindEvidence(link.scope, current.checkedAtMs, bound.inventory, bound.candidates, bound.receipts);
      const v1Coverage = bound.obligations[index]?.coverage ?? 'UNKNOWN';
      return Object.freeze({ index, questionType: link.scope.questionType, v1Coverage, v2Status: result.status, v2Reason: result.reason });
    });
    const agreement = rows.every(r => (r.v1Coverage === 'COMPLETE') === (r.v2Status === 'BOUND'));
    return record({ status: 'COMPARED', publication: bound.publication, agreement, obligations: Object.freeze(rows) });
  } catch {
    return record({ status: 'ERROR' });
  }
}
