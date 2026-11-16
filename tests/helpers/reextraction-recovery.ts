// OFFLINE, TEST-ONLY Semantic Recovery by one fresh re-extraction.
// No real network: every model call goes through the production OpenAI adapter
// with a TOTAL fetch stub that records the exact wire body and returns a
// scripted Responses envelope. Nothing here is wired into server.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildEvidenceFirstAnswer, InformationBudget, publishableKnowledgeManifest,
  type AnswerGenerator, type AnswerManifest, type Evidence, type Facet,
} from '../../src/ai/business-information-answer-plan';
import { knowledgeStructuredOutput, type KnowledgeDecision } from '../../src/ai/knowledge-answer-protocol';
import { compactKnowledgeVerifierInput } from '../../src/ai/knowledge-verifier-input';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from '../../src/ai/knowledge-timing-policy';
import { generateWithOpenAi } from '../../src/ai/providers/openai';

/** The ONLY difference between the original and the re-extraction request. */
export const REEXTRACTION_GUIDANCE = 'RE-EXTRACTION: A previous proposal used a connective that can also denote a numerical limit. ' +
  'Write every purpose, reason or goal with an unambiguous purpose connective in the requested language; never use a word that can also ' +
  'mean "until", "up to" or a maximum to introduce a purpose. Preserve every quantity, approximation, modality, audience, temporal anchor, ' +
  'condition and qualification from the evidence exactly. Do not add facts.';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export type Wire = { stage: string; body: Record<string, unknown>; bytes: number; requestSha256: string };
type Stage = Parameters<AnswerGenerator>[0];
export type Responder = (stage: Stage, data: any) => unknown;

/** Repository ceilings. Luna mirrors requestCeiling() (scripts/knowledge-aen-single-provider.ts);
 * Sol mirrors the knowledge budget owner quote (proxy x $2.5/M + 8192 x $10/M). */
export const ceilings = (wire: Wire) => {
  const maxOut = Math.min(Number(wire.body.max_output_tokens ?? 8192), 8192);
  return { lunaUsd: ((wire.bytes + 2048) * 0.25 + maxOut * 1.2) / 1e6, solUsd: ((wire.bytes + 2048) * 2500 + 8192 * 10000) / 1e9 };
};

/** Mirrors the server.ts native knowledge generate() for the default profile. */
export function offlineProductionGenerator(facetIds: readonly string[], verificationProtocol: 'source-exhaustive-v2',
  respond: Responder, wires: Wire[], extraGuidance = ''): AnswerGenerator {
  return async (requestedStage, instruction, data, contract) => {
    // Offline harness predates the production re_extraction stage: same schema.
    const stage = requestedStage === 're_extraction' ? 'extraction' : requestedStage;
    const wireData = stage === 'verification' ? compactKnowledgeVerifierInput(data) : data;
    const request = { messages: [{ role: 'user', content: JSON.stringify(wireData) }],
      systemInstruction: stage === 'extraction' && extraGuidance ? instruction + '\n' + extraGuidance : instruction, tools: [],
      ...(stage === 'extraction' || stage === 'verification' ? { reasoningEffort: 'low' as const } : {}),
      ...(stage !== 'composition' ? { structuredOutput: knowledgeStructuredOutput(stage, false, stage === 'extraction' ? facetIds : undefined,
        stage === 'extraction' && (data as { authorityScope?: unknown })?.authorityScope === 'document_only' ? 5 : 6,
        verificationProtocol, contract?.extractionProtocol, contract?.canonicalConfiguration) } : {}) };
    const saved = { fetch: globalThis.fetch, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, base: process.env.OPENAI_BASE_URL };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses', 'offline stub: unexpected destination');
      const body = JSON.parse(String(init?.body));
      const text = JSON.stringify(body);
      wires.push({ stage, body, bytes: Buffer.byteLength(text, 'utf8'), requestSha256: sha256(text) });
      const output = JSON.stringify(respond(stage, JSON.parse(body.input[0].content)));
      return new Response(JSON.stringify({ object: 'response', model: body.model, status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }],
        usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-offline-only', OPENAI_MODEL: 'gpt-5.6-luna' });
    delete process.env.OPENAI_BASE_URL;
    try { return await generateWithOpenAi(request as Parameters<typeof generateWithOpenAi>[0]); }
    finally {
      globalThis.fetch = saved.fetch;
      for (const [key, value] of [['OPENAI_API_KEY', saved.key], ['OPENAI_MODEL', saved.model], ['OPENAI_BASE_URL', saved.base]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

export type Run = { manifest: AnswerManifest; events: KnowledgeDecision[]; wires: Wire[]; publishable: boolean };
export async function runOnce(input: { question: string; language: string; facets: Facet[]; businessId: number;
  evidence: () => Promise<Evidence[]>; respond: Responder; guidance?: string;
  /** Injected transport (experiment runner); default is the offline stub. */ generate?: AnswerGenerator }): Promise<Run> {
  const events: KnowledgeDecision[] = [];
  const wires: Wire[] = [];
  const evidence = await input.evidence();
  const manifest = await runAccuracyFirstNative(() => buildEvidenceFirstAnswer({
    language: input.language, question: input.question, facets: input.facets, evidence, businessId: input.businessId,
    foreground: true, languageSafe: () => true, verificationProtocol: 'source-exhaustive-v2', extractionProtocol: 'v2',
    authoritativeEvidence: '{}', businessTone: {}, history: [], budget: new InformationBudget(undefined, nativeKnowledgeTiming()),
    current: async () => true, revalidateEvidence: input.evidence, diagnostic: event => events.push(event),
    generate: input.generate ?? offlineProductionGenerator(input.facets.map(f => f.id), 'source-exhaustive-v2', input.respond, wires, input.guidance),
  }), async () => { throw new Error('native timing failed'); });
  assert.ok(manifest, 'native timing returned no result');
  return { manifest, events, wires, publishable: publishableKnowledgeManifest(manifest, input.businessId) };
}

/** Narrow trigger from production diagnostics only. Every rejected proposal
 * must be a numerical rejection whose ONLY conflict is a bound the parser
 * attributes to an ambiguous connective after the quantity. Explicit limits,
 * value/unit/anchor/ambiguity/cancellation mismatches and every other
 * rejection reason (citation, scope, tenant, freshness...) are excluded. */
export function ambiguousConnectiveFailure(run: Run) {
  const extraction = run.events.filter(e => e.stage === 'extraction');
  const counts = extraction.find(e => e.reason === 'ACCEPTED')?.counts;
  const rejections = extraction.filter(e => e.reason !== 'ACCEPTED');
  const eligibleRow = (row: any) => row.boundTriggerCategory === 'persian_ta' && row.boundTriggerPosition === 'after_quantity' &&
    row.candidateBound === 'maximum' && row.sourceBound === 'unbounded' && row.temporalAnchorCompatible === true &&
    !row.candidateAmbiguous && !row.sourceAmbiguous && row.candidateCancellationKind === 'none' && row.sourceCancellationKind === 'none';
  const why = run.publishable ? 'PUBLISHABLE' :
    !['INVALID_COVERAGE', 'NO_PARSED_UNITS'].includes(String(run.manifest.fallbackReason)) ? `FALLBACK_${run.manifest.fallbackReason}` :
    rejections.some(e => e.reason !== 'NUMERICAL_CONSTRAINT' || e.numericalMismatchReason !== 'SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH') ? 'OTHER_REJECTION' :
    !counts || !rejections.length || rejections.length !== counts.rejected ? 'REJECTION_COUNT' :
    rejections.some(e => !e.numericalComparisons?.length || !e.numericalComparisons.every(eligibleRow)) ? 'NOT_AMBIGUOUS_CONNECTIVE' : null;
  return { eligible: why === null, reason: why ?? 'ELIGIBLE' };
}

/** Original run, narrow classification, then at most ONE fresh, complete,
 * independent re-extraction. The original run's proposals, units and manifest
 * are discarded; the new run re-reads evidence and passes every unchanged gate. */
export async function recoverByReextraction(input: Omit<Parameters<typeof runOnce>[0], 'respond' | 'guidance'> &
  { original: Responder; reextraction: Responder;
    /** The replacement re-admits evidence from the store (default: same loader). */
    replacementEvidence?: () => Promise<Evidence[]> }) {
  const original = await runOnce({ ...input, respond: input.original });
  const trigger = ambiguousConnectiveFailure(original);
  if (!trigger.eligible) return { original, trigger, replacement: null, publishable: original.publishable, manifest: original.manifest };
  // Deterministic pre-dispatch check on the re-admitted inventory: no request
  // may carry another tenant's text (plan-level v2 extraction does not check
  // this itself; production relies on upstream retrieval scoping).
  const load = input.replacementEvidence ?? input.evidence;
  const readmitted = await load();
  if (!readmitted.length || readmitted.some(item => item.businessId !== input.businessId))
    return { original, trigger, replacement: null, aborted: 'TENANT_OR_EMPTY_BEFORE_DISPATCH' as const,
      publishable: false, manifest: original.manifest };
  let first = true;
  const replacement = await runOnce({ ...input, evidence: async () => first ? (first = false, readmitted) : load(),
    respond: input.reextraction, guidance: REEXTRACTION_GUIDANCE });
  return { original, trigger, replacement, publishable: replacement.publishable, manifest: replacement.manifest };
}

/** Same narrow rule decided from extraction diagnostics alone, so a doomed
 * original verification request never needs to be sent. */
export function extractionTrigger(events: readonly KnowledgeDecision[]) {
  const extraction = events.filter(e => e.stage === 'extraction');
  const counts = extraction.find(e => e.reason === 'ACCEPTED')?.counts;
  const rejections = extraction.filter(e => e.reason !== 'ACCEPTED');
  const eligibleRow = (row: any) => row.boundTriggerCategory === 'persian_ta' && row.boundTriggerPosition === 'after_quantity' &&
    row.candidateBound === 'maximum' && row.sourceBound === 'unbounded' && row.temporalAnchorCompatible === true &&
    !row.candidateAmbiguous && !row.sourceAmbiguous && row.candidateCancellationKind === 'none' && row.sourceCancellationKind === 'none';
  const why = !counts ? 'NO_EXTRACTION' : !rejections.length ? 'NO_REJECTION' :
    rejections.some(e => e.reason !== 'NUMERICAL_CONSTRAINT' || e.numericalMismatchReason !== 'SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH') ? 'OTHER_REJECTION' :
    rejections.length !== counts.rejected ? 'REJECTION_COUNT' :
    rejections.some(e => !e.numericalComparisons?.length || !e.numericalComparisons.every(eligibleRow)) ? 'NOT_AMBIGUOUS_CONNECTIVE' : null;
  return { eligible: why === null, reason: why ?? 'ELIGIBLE' };
}
