// Tenant-scoped Sol extraction canary (default OFF): content-free telemetry and
// the detached shadow replay. Nothing here can change a reply, a delivery or
// booking state. Every Sol request still goes through the production budget
// owner (knowledge-model-policy.ts) with its own permit and reservation.
import { ANSWER_LIMITS, buildEvidenceFirstAnswer, InformationBudget, type AnswerGenerator, type Evidence, type Facet,
  type ProviderResult, type ReExtractionEvent } from './business-information-answer-plan';
import { knowledgeStructuredOutput, type KnowledgeDecision } from './knowledge-answer-protocol';
import { accuracyFirstExtractionAllowance, nativeKnowledgeTiming, runDetachedKnowledgeShadow } from './knowledge-timing-policy';
import { captureSolExtractionShadow, knowledgeReExtractionAvailable, knowledgeStageOptions, solExtractionMode,
  type KnowledgeModelBinding, type KnowledgeModelProfile } from './knowledge-model-policy';
import type { UnifiedAiGenerationRequest, UnifiedAiGenerationResponse } from './providers/provider';
import { managedKnowledgeDefault } from './model-routing';

/** A re-extraction needs a usable window and must leave the verifier reserve. */
export const SOL_REEXTRACTION_MIN_MS = 8_000;

export type SolStageRecord = { stage: 'extraction' | 're_extraction' | 'verification'; model: 'sol' | 'luna';
  durationMs: number; ok: boolean; costNanoUsd?: number };
export type SolCanaryTelemetry = Readonly<{
  schema: 'sol-extraction-canary-v1'; mode: 'active' | 'shadow'; businessId: number; channel: string; language: string;
  profile: 'sol-extraction-v1' | 'default'; fallbackReason?: string;
  stages: readonly SolStageRecord[]; extractionReasons: Readonly<Record<string, number>>;
  reExtraction?: ReExtractionEvent;
  /** active: the live publication decision. shadow: always 'never_published'. */
  publication: 'published' | 'safe_fallback' | 'never_published';
  fallbackReason_publication?: string | null; shadowReachedVerification?: boolean; elapsedMs: number }>;

/** Language tag, channel and reasons are closed vocabularies; no question,
 * evidence, quotation, unit text, recipient or credential is ever recorded. */
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u;
export function safeTelemetry(t: SolCanaryTelemetry): SolCanaryTelemetry {
  return Object.freeze({ ...t, language: LANGUAGE.test(t.language) ? t.language : 'und',
    channel: ['whatsapp', 'telegram', 'instagram', 'messenger', 'internal'].includes(t.channel) ? t.channel : 'other' });
}
export function emitSolCanaryTelemetry(t: SolCanaryTelemetry, sink: (line: string, payload: string) => void = console.info): void {
  try { sink('[SolExtractionCanary]', JSON.stringify(safeTelemetry(t))); } catch { /* optional telemetry */ }
}
export function extractionReasonCounts(events: readonly KnowledgeDecision[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) if (e.stage === 'extraction' && e.unitId) {
    const key = e.reason === 'NUMERICAL_CONSTRAINT' && e.numericalMismatchReason ? `NUMERICAL_CONSTRAINT:${e.numericalMismatchReason}` : e.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Host admission check, re-evaluated immediately before the re_extraction dispatch. */
export function reExtractionAdmission(input: { profile: KnowledgeModelProfile; businessId: number; mode: 'active' | 'shadow' | 'production';
  generationRemainingMs: number; attempts: number; maxAttempts: number; env?: NodeJS.ProcessEnv }): string | null {
  // A flag/routing change mid-turn stops NEW Sol spending; it never switches model.
  if (input.mode === 'production' ? !managedKnowledgeDefault(input.env ?? process.env)
    : solExtractionMode(input.businessId, input.env ?? process.env) !== input.mode) return 'flag_disabled';
  if (!knowledgeReExtractionAvailable(input.profile)) return 'permit_unavailable';
  if (accuracyFirstExtractionAllowance(input.generationRemainingMs) < SOL_REEXTRACTION_MIN_MS) return 'deadline';
  // Leave one admitted attempt for the unchanged verifier.
  if (input.attempts + 2 > input.maxAttempts) return 'attempts';
  return null;
}

type Generate = (request: UnifiedAiGenerationRequest) => Promise<UnifiedAiGenerationResponse>;
class ShadowStop extends Error { constructor() { super('sol_shadow_stop_before_verification'); } }

/** Detached post-delivery replay of the SAME message on Sol: production
 * extraction contract, deterministic parse, at most one re_extraction. It
 * stops before verification (no verifier request is ever sent), never
 * publishes, and never touches the live turn state, reply or booking. */
export async function runSolExtractionShadow(input: {
  binding: KnowledgeModelBinding; businessId: number; channel: string; question: string; language: string;
  facets: readonly Facet[]; evidence: readonly Evidence[]; history: unknown; businessTone: unknown;
  /** Independent document freshness + tenant check; no live-turn state. */
  current: () => Promise<boolean>;
  provider: string; generate: Generate; emit?: (t: SolCanaryTelemetry) => void; env?: NodeJS.ProcessEnv;
}): Promise<SolCanaryTelemetry | undefined> {
  const env = input.env ?? process.env;
  if (solExtractionMode(input.businessId, env) !== 'shadow') return undefined;
  const documentary = input.evidence.length > 0 && input.evidence.every(e => e.businessId === input.businessId &&
    !e.id.startsWith('configured-') && !e.sourceId.startsWith('configured-') && !e.sourceId.startsWith('business-cancellation-configuration:'));
  const started = Date.now();
  const evidence = Object.freeze(input.evidence.map(e => Object.freeze({ ...e })));
  const emit = (t: SolCanaryTelemetry) => { (input.emit ?? emitSolCanaryTelemetry)(t); return t; };
  const base = { schema: 'sol-extraction-canary-v1' as const, mode: 'shadow' as const, businessId: input.businessId,
    channel: input.channel, language: input.language, publication: 'never_published' as const };
  if (!documentary) return emit({ ...base, profile: 'default', fallbackReason: 'shadow_out_of_scope', stages: [], extractionReasons: {}, elapsedMs: 0 });
  return runDetachedKnowledgeShadow(async () => {
    const profile = captureSolExtractionShadow({ ...input.binding, provider: input.provider, nativeForeground: true, natural: false, durable: false,
      extractionProtocol: 'v2', verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: input.current }, env);
    if (profile.id !== 'sol-extraction-v1')
      return emit({ ...base, profile: 'default', fallbackReason: profile.canaryFallback ?? 'shadow_ineligible', stages: [], extractionReasons: {}, elapsedMs: Date.now() - started });
    const timing = nativeKnowledgeTiming()!;
    const budget = new InformationBudget(undefined, timing);
    const events: KnowledgeDecision[] = [], stages: SolStageRecord[] = [];
    let reExtraction: ReExtractionEvent | undefined, reachedVerification = false;
    const generate: AnswerGenerator = async (stage, instruction, data, contract): Promise<ProviderResult> => {
      if (stage === 'verification') { reachedVerification = true; throw new ShadowStop(); }
      if (stage !== 'extraction' && stage !== 're_extraction') throw new ShadowStop();
      const t0 = Date.now(); let ok = false, cost: number | undefined;
      try {
        const options = knowledgeStageOptions(profile, stage, input.binding, Date.now() + accuracyFirstExtractionAllowance(budget.generationRemaining()));
        budget.attempt();
        const response = await input.generate({ messages: [{ role: 'user', content: JSON.stringify(data) }], systemInstruction: instruction, tools: [],
          ...options, signal: timing.signal,
          structuredOutput: knowledgeStructuredOutput('extraction', false, input.facets.map(f => f.id),
            (data as { authorityScope?: unknown })?.authorityScope === 'document_only' ? 5 : 6, 'source-exhaustive-v2', contract?.extractionProtocol, contract?.canonicalConfiguration) });
        cost = response.knowledgeUsage?.estimatedNanoUsd; ok = true;
        return response;
      } finally { stages.push({ stage, model: 'sol', durationMs: Date.now() - t0, ok, ...(cost !== undefined ? { costNanoUsd: cost } : {}) }); }
    };
    try {
      await buildEvidenceFirstAnswer({ question: input.question, language: input.language, facets: input.facets, evidence,
        businessId: input.businessId, verificationProtocol: 'source-exhaustive-v2', extractionProtocol: 'v2', omitModelEvidenceVersions: true,
        foreground: true, authoritativeEvidence: '{}', businessTone: input.businessTone, history: input.history, budget,
        languageSafe: () => false, current: input.current,
        revalidateEvidence: async () => await input.current() ? evidence : [],
        diagnostic: e => { events.push(e); },
        reExtraction: { record: e => { reExtraction = e; },
          admit: () => reExtractionAdmission({ profile, businessId: input.businessId, mode: 'shadow', env, generationRemainingMs: budget.generationRemaining(),
            attempts: budget.attempts, maxAttempts: ANSWER_LIMITS.attempts }) },
        generate });
    } catch { /* shadow failures are telemetry only */ }
    return emit({ ...base, profile: 'sol-extraction-v1', stages, extractionReasons: extractionReasonCounts(events),
      ...(reExtraction ? { reExtraction } : {}), shadowReachedVerification: reachedVerification, elapsedMs: Date.now() - started });
  });
}
