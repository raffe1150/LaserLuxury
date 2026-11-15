/** Semantic-only rehearsal. No CLI entry point, credential transmission or
 * provider transport is installed. Exercise with temporary ledgers only. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { actualUsd, ENDPOINT, ExperimentLedger, loadCredential, type LedgerPins } from './experiment-accounting';
import { prepareTurn, finishTurn, type TurnContext } from '../src/ai/brain/memory/conversation-memory';
import type { TurnFrame } from '../src/ai/brain/memory/turn-frame';
import type { Reading } from '../src/ai/brain/semantic/contracts';
import { INTERPRETATION_INSTRUCTION, interpretationPacket, createInterpretationAdapter } from '../src/ai/brain/semantic/model-adapter';
import { isRoute } from '../src/ai/brain/semantic/interpret';
import { EVAL_LANGUAGES, type EvalLanguage } from '../src/ai/brain/evaluation/types';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const manifestHash = 'e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d';
const model = 'gpt-6.1-sol';
const maxCost = 0.056;
const carry = 0.00000780;
const counts = [3, 3, 2, 4, 3, 3];
const inputLimit = 16_000;
const outputLimit = 1600;
// Preserve the pinned rehearsal's fictional clock and entities without
// loading the Phase 4 evidence, corpus or recorded provider fixtures.
const context: TurnContext = {
  binding: { tenantId: 3, conversationId: 'offline-phase4' }, turn: 1,
  timezone: 'Europe/Stockholm', nowMs: Date.parse('2026-11-16T08:00:00Z'),
  catalog: { services: [{ id: 'cut', label: 'haircut' }], staff: [{ id: 'staff-a', label: 'Alex' }] },
};

type Turn = { id: string; language: EvalLanguage; turn: number; text: string; switchTo: EvalLanguage | null;
  expected: Reading[]; sha256: string };
export type Approval = Readonly<{ id: string; manifestSha256: string; primaryLedgerSha256: string; otherLedgerSha256: string;
  primaryPath: string; otherPath: string; project: string; expiresAtMs: number; maxUsd: number; cumulativeUsd: number;
  requestUsd: number; mode: 'OFFLINE_SIMULATION' }>;
export type SimulatedResponse = Readonly<{ httpStatus: number; project: string; body: unknown }>;
// An offline test double exercises the admission policy with a count tied
// to the complete wire. It is never accepted as a real provider's proof.
type RehearsalCount = Readonly<{
  kind: 'SIMULATED_EXACT_COUNT'; model: string; wireSha256: string; inputTokens: number;
}>;
type RehearsalMeter = (wire: string, signal: AbortSignal) => RehearsalCount | undefined | Promise<RehearsalCount | undefined>;
const sourcePins = {
  '../src/ai/brain/phase4/held-out.ts': '757ddf4173f1853b7426e7a2897d6ccb733862bf6fb74e78a993a522f387ab7c',
  '../src/ai/brain/phase5/semantic-eval.ts': '71be25389cbb84f892719aad19fdbebbfe79b3954843b3ef10ec8b583e7185d9',
  '../src/ai/brain/semantic/model-adapter.ts': '072dd1f863bfa5eae8891641aafd5b7cf01beddb1ac1b1d025c2fb9319915840',
  '../src/ai/brain/memory/conversation-memory.ts': 'a3b91e4ed07020871ccb70a204092b05f29fa785b0325dce988a20c6c9865913',
} as const;
export const solSemanticPins = Object.freeze({ manifestSha256: manifestHash, sourcesSha256: sha(JSON.stringify(sourcePins)), model,
  requestExposureUsd: maxCost, requestedTurns: 18, historicalCarryUsd: carry, inputLimit, outputLimit });
type Simulation = (request: Readonly<{ endpoint: string; body: string; project: string }>, signal: AbortSignal) => Promise<SimulatedResponse>;
const uint = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function manifestTurns(bytes: Buffer): Turn[] {
  if (sha(bytes) !== manifestHash) throw new Error('MANIFEST_HASH');
  const m = JSON.parse(bytes.toString()) as { model: string; requestCount: number; instructionSha256: string; turns: Turn[] };
  if (m.model !== model || m.requestCount !== 18 || m.turns.length !== 18 || m.instructionSha256 !== sha(INTERPRETATION_INSTRUCTION) ||
      m.turns.some(({ sha256, ...row }) => sha(JSON.stringify(row)) !== sha256) ||
      EVAL_LANGUAGES.some((language, i) => m.turns.filter(t => t.language === language)
        .map(t => t.id).join() !== Array.from({ length: counts[i] }, (_, j) => language + ':' + (j + 1)).join())) throw new Error('MANIFEST_CONTENT');
  return m.turns;
}

function solWire(packet: NonNullable<ReturnType<typeof interpretationPacket>>) {
  return JSON.stringify({ model, instructions: packet.instruction, input: [
    // JSON mode validates the input messages. Keep this instruction outside
    // the serialized customer turn and its conversation context.
    { role: 'developer', content: 'Return the semantic interpretation as a JSON object.' },
    { role: 'user', content: packet.data },
  ],
    store: false, stream: false, service_tier: 'default', reasoning: { effort: 'low' },
    prompt_cache_options: { mode: 'implicit', ttl: '30m' }, max_output_tokens: packet.maxOutputTokens,
    text: { format: { type: 'json_object' } } });
}

function turnContext(turn: Turn) {
  return { ...context, turn: turn.turn, binding: { ...context.binding, conversationId: 'sol-semantic-' + turn.language },
    language: { deterministicLanguage: turn.language, explicitSwitch: turn.switchTo } };
}

export async function planSolCanary(manifest: Buffer) {
  verifySolSemanticSources();
  const turn = manifestTurns(manifest)[0];
  const handle = await prepareTurn(undefined, turnContext(turn), turn.text);
  const packet = handle.request && interpretationPacket(handle.request);
  if (!packet) throw new Error('INPUT_UNAVAILABLE');
  const body = solWire(packet);
  return { turnId: turn.id, body, requestSha256: sha(body) };
}

function validatedReceipt(response: SimulatedResponse, project: string, seen: Set<string>, inputBound: number) {
  // Unknown provider data is decoded field by field before reducing the hold.
  const b = response.body as Record<string, any> | null;
  if (!b || response.httpStatus !== 200 || response.project !== project || b.model !== model ||
      b.object !== 'response' || b.status !== 'completed' || b.service_tier !== 'default' || b.reasoning?.effort !== 'low' ||
      b.prompt_cache_options?.mode !== 'implicit' || b.prompt_cache_options?.ttl !== '30m' ||
      b.max_output_tokens !== outputLimit || typeof b.id !== 'string' || !/^resp_[a-zA-Z0-9_-]+$/.test(b.id) || seen.has(b.id))
    throw new Error('RESPONSE_IDENTITY');
  const u = b.usage, d = u?.input_tokens_details;
  const input = u?.input_tokens, output = u?.output_tokens, reasoning = u?.output_tokens_details?.reasoning_tokens;
  const cached = d?.cached_tokens, written = d?.cache_write_tokens;
  const ttl = d?.cache_write_tokens_details;
  if (![input, output, reasoning, cached, written, u?.total_tokens].every(uint) || !input || !output ||
      input > inputBound || output > outputLimit || reasoning > output || cached + written > input ||
      u.total_tokens !== input + output || (ttl?.ttl_12h_tokens ?? 0) !== 0 ||
      (ttl?.ttl_30m_tokens ?? 0) !== written) throw new Error('UNVERIFIED_USAGE');
  const cost = actualUsd('sol', u);
  if (cost === null || cost > maxCost) throw new Error('USAGE_EXCEEDS_RESERVE');
  if (!Array.isArray(b.output) || b.output.some((o: any) => !['reasoning', 'message'].includes(o?.type))) throw new Error('UNEXPECTED_OUTPUT');
  const messages = b.output.filter((o: any) => o.type === 'message');
  const content = messages[0]?.content;
  if (messages.length !== 1 || messages[0]?.role !== 'assistant' || !Array.isArray(content) ||
      content.length !== 1 || content[0]?.type !== 'output_text' || typeof content[0]?.text !== 'string')
    throw new Error('UNEXPECTED_OUTPUT');
  return { id: b.id as string, cost, text: content[0].text as string };
}

export function verifySolSemanticSources() {
  for (const [path, expected] of Object.entries(sourcePins)) {
    if (sha(readFileSync(new URL(path, import.meta.url))) !== expected) throw new Error('SEMANTIC_SOURCE_HASH');
  }
}

export async function rehearseSolSemanticRun(input: Readonly<{ manifest: Buffer; pins: LedgerPins; approval: Approval;
  credentialRoot: string; meter?: RehearsalMeter; simulate: Simulation; signal?: AbortSignal; canaryRequestSha256?: string }>) {
  const canaryHash = input.canaryRequestSha256;
  const canary = canaryHash !== undefined;
  const turns = manifestTurns(input.manifest).slice(0, canary ? 1 : undefined);
  const ceilingUsd = canary ? maxCost : 1.008;
  verifySolSemanticSources();
  const meter = input.meter;
  if (!meter) throw new Error('INPUT_BOUND_UNPROVEN');
  const a = Object.freeze({ ...input.approval });
  const p = { ...input.pins, path: realpathSync(input.pins.path), others: input.pins.others.map(o => ({ ...o, path: realpathSync(o.path) })) };
  const other = p.others[0];
  if (p.others.length !== 1 || dirname(p.path) !== dirname(other.path)) throw new Error('LEDGER_SCOPE');
  // This entry point cannot write the authoritative experiment ledgers.
  const directory = dirname(p.path);
  if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('odin-sol-sim-') ||
      basename(p.path) !== 'source-aware-usage.json' || basename(other.path) !== 'budget-resumed-usage.json' ||
      realpathSync(input.credentialRoot) !== directory + '/credentials') throw new Error('LIVE_EXECUTION_DISABLED');
  // Copies of live credentials are also out of scope for this entry point,
  // even if placed in a valid temporary directory with a matching fingerprint.
  const loadSimulationCredential = () => {
    const credential = loadCredential(input.credentialRoot);
    if (!/^sk-synthetic-[A-Za-z0-9_-]+$/.test(credential.key))
      throw new Error('SIMULATION_CREDENTIAL_REQUIRED');
    return credential;
  };
  const credentialFingerprint = sha(loadSimulationCredential().key);
  const checkApproval = () => {
    if (a.mode !== 'OFFLINE_SIMULATION' || !/^[-\w]{8,80}$/.test(a.id) || !uint(a.expiresAtMs) || a.expiresAtMs <= Date.now() ||
        a.manifestSha256 !== manifestHash || a.primaryLedgerSha256 !== p.expectedSha256 || a.otherLedgerSha256 !== other.expectedSha256 ||
        a.primaryPath !== p.path || a.otherPath !== other.path || a.maxUsd !== ceilingUsd || a.cumulativeUsd !== 4 || a.requestUsd !== 0.15)
      throw new Error('APPROVAL_INVALID');
    const credential = loadSimulationCredential();
    if (credential.expectedProjectId !== a.project || sha(credential.key) !== credentialFingerprint)
      throw new Error('CREDENTIAL_PROJECT_MISMATCH');
    input.signal?.throwIfAborted();
  };
  checkApproval();
  for (const file of [p.path, other.path]) {
    const s = statSync(file);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.()) throw new Error('LEDGER_PERMISSIONS');
  }
  const ledger = new ExperimentLedger(p, a.id, carry);
  ledger.acquire();
  try {
    const state = ledger.read();
    if (state.ledger.calls.some(r => r.authorizationId === a.id)) throw new Error('APPROVAL_ALREADY_USED');
    if (Math.ceil(state.reservedUsd * 1e9) + Math.round(ceilingUsd * 1e9) > 4_000_000_000) throw new Error('RUN_BUDGET');
    const otherRows = JSON.parse(readFileSync(other.path, 'utf8')).calls as Record<string, unknown>[];
    if (!Array.isArray(otherRows)) throw new Error('OTHER_LEDGER_ROWS_INVALID');
    if (otherRows.some(r => r.authorizationId === a.id)) throw new Error('APPROVAL_ALREADY_USED');
    const seen = new Set([...state.ledger.calls, ...otherRows].map(row => row.providerResponseId).filter((id): id is string => typeof id === 'string'));
    const frames = new Map<EvalLanguage, TurnFrame>();
    const results = [];
    for (const turn of turns) {
      const handle = await prepareTurn(frames.get(turn.language), turnContext(turn), turn.text);
      if (!handle.request || !interpretationPacket(handle.request)) throw new Error('INPUT_UNAVAILABLE');
      const requestId = a.id + '-' + turn.id;
      let receipt: ReturnType<typeof validatedReceipt> | undefined;
      let failure: unknown;
      const adapter = createInterpretationAdapter(async (packet, signal) => {
        try {
          const body = solWire(packet);
          const requestSha256 = sha(body);
          if (canary) {
            if (requestSha256 !== canaryHash) throw new Error('CANARY_WIRE_MISMATCH');
            checkApproval();
            signal.throwIfAborted();
            // Consume the approval before the first counted request. This is
            // an append-only zero-cost marker, not an inference reservation.
            ledger.claimCanary(turn.id, requestSha256);
            ledger.assertOwnership();
            checkApproval();
            signal.throwIfAborted();
          }
          const proof = await meter(body, signal);
          signal.throwIfAborted();
          if (proof?.kind !== 'SIMULATED_EXACT_COUNT' || proof.model !== model ||
              proof.wireSha256 !== requestSha256 || !uint(proof.inputTokens) || proof.inputTokens === 0)
            throw new Error('INPUT_BOUND_UNPROVEN');
          const inputBound = proof.inputTokens;
          if (inputBound > inputLimit) throw new Error('INPUT_TOKEN_LIMIT');
          checkApproval();
          signal.throwIfAborted();
          ledger.reserve({ requestId, caseId: turn.id, model, stage: 'semantic', requestSha256, ceilingUsd: maxCost });
          signal.throwIfAborted();
          ledger.assertOwnership();
          ledger.read();
          checkApproval();
          signal.throwIfAborted();
          const response = await input.simulate({ endpoint: ENDPOINT, body, project: a.project }, signal);
          signal.throwIfAborted();
          receipt = validatedReceipt(response, a.project, seen, inputBound);
          return receipt.text;
        } catch (error) { failure = error; return null; }
      });
      const wire = await adapter(handle.request, input.signal ?? new AbortController().signal);
      // A failed, timed-out or unverifiable attempt leaves the durable
      // reservation untouched. No detached continuation can settle it.
      if (!wire || !receipt) throw failure ?? new Error('SEMANTIC_RESPONSE_UNVERIFIED');
      const semantic = finishTurn(handle, wire);
      ledger.settle(requestId, { status: 'SETTLED', estimatedUsd: receipt.cost, providerResponseId: receipt.id });
      seen.add(receipt.id);
      frames.set(turn.language, semantic.frame);
      const allowed = turn.expected.filter(e => isRoute(e.intent) && e.polarity !== 'negative' && !e.missing).map(e => e.intent);
      const unsafeRoute = semantic.guidance.some(g => g.kind === 'REFER_TO_BOOKING_AUTHORITY' && !allowed.includes(g.route));
      const fields: (keyof Reading)[] = ['intent', 'span', 'questionType', 'polarity', 'premise', 'conditions', 'reference', 'missing', 'change', 'entities'];
      const exact = semantic.readings.length === turn.expected.length && semantic.readings.every((r, i) =>
        fields.every(key => JSON.stringify(r[key]) === JSON.stringify(turn.expected[i][key])));
      results.push({ id: turn.id, language: turn.language, exact, unsafeRoute, readings: semantic.readings, guidance: semantic.guidance });
    }
    return { mode: 'OFFLINE_SIMULATION' as const, genuineAccuracy: 'UNMEASURED', results };
  } finally { ledger.release(); }
}
