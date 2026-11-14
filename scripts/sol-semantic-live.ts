/** Dedicated Sol live admission boundary. Provider access remains disabled
 * until a credential owner outside the legacy writers can enforce exclusion.
 * This module has no network client and never sends a credential. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ExperimentLedger, EXPERIMENT_LIMITS, loadCredential, type LedgerPins } from './experiment-accounting';
import { rehearseSolSemanticRun, planSolCanary, solSemanticPins, verifySolSemanticSources } from './sol-semantic-runner';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const countEndpoint = 'https://api.openai.com/v1/responses/input_tokens';
const maxRunUsd = 1.008;
const maxApprovalMs = 15 * 60_000;
type RunnerInput = Parameters<typeof rehearseSolSemanticRun>[0];
type Authorization = Readonly<{
  id: string; issuedAtMs: number; expiresAtMs: number; manifestSha256: string; sourcesSha256: string;
  model: string; project: string; credentialSha256: string; ledgerPinsSha256: string;
  countCalls: 1 | 18; inferenceCalls: 1 | 18; retryCalls: 0; requestSha256?: string;
  maxRunUsd: number; maxRequestUsd: number; cumulativeUsd: number;
}>;
export const solLedgerPinsSha256 = (p: LedgerPins) => sha(JSON.stringify([
  realpathSync(p.path), p.expectedSha256, p.historicalRows, p.historicalPrefixSha256,
  p.others.map(o => [realpathSync(o.path), o.expectedSha256]),
]));

type Admission = Readonly<{ manifest: Buffer; pins: LedgerPins; credentialRoot: string; authorization: Authorization }>;
function checkAdmission(input: Admission, canaryHash?: string) {
  const { authorization: a, manifest, pins } = input;
  const now = Date.now();
  const count = canaryHash === undefined ? 18 : 1;
  const ceiling = count === 1 ? solSemanticPins.requestExposureUsd : maxRunUsd;
  if (!a || !/^[-\w]{8,80}$/.test(a.id) || !Number.isSafeInteger(a.issuedAtMs) || !Number.isSafeInteger(a.expiresAtMs) ||
      a.issuedAtMs > now || a.expiresAtMs <= now || a.expiresAtMs - a.issuedAtMs > maxApprovalMs ||
      sha(manifest) !== a.manifestSha256 || a.manifestSha256 !== solSemanticPins.manifestSha256 ||
      a.sourcesSha256 !== solSemanticPins.sourcesSha256 || a.model !== solSemanticPins.model ||
      a.countCalls !== count || a.inferenceCalls !== count || a.requestSha256 !== canaryHash || a.retryCalls !== 0 ||
      a.maxRunUsd !== ceiling || a.maxRequestUsd !== EXPERIMENT_LIMITS.perRequestUsd ||
      a.cumulativeUsd !== EXPERIMENT_LIMITS.cumulativeUsd || pins.others.length !== 1 ||
      solLedgerPinsSha256(pins) !== a.ledgerPinsSha256) throw new Error('LIVE_APPROVAL_INVALID');
  verifySolSemanticSources();
  const credential = loadCredential(input.credentialRoot);
  if (sha(credential.key) !== a.credentialSha256 || credential.expectedProjectId !== a.project)
    throw new Error('LIVE_CREDENTIAL_PIN_MISMATCH');
  const ledger = new ExperimentLedger(pins, a.id, solSemanticPins.historicalCarryUsd).read();
  if (Math.ceil(ledger.reservedUsd * 1e9) + Math.round(ceiling * 1e9) > 4_000_000_000) throw new Error('RUN_BUDGET');
}

/** Real entry point is deliberately preflight-only. An approval, an unlocked
 * file or a caller-provided flag cannot prove exclusive credential access. */
export function executeSolSemanticLive(input: Admission): never {
  checkAdmission(input);
  throw new Error('LIVE_CREDENTIAL_EXCLUSION_UNPROVEN');
}

export async function executeSolSemanticCanary(input: Admission): Promise<never> {
  const plan = await planSolCanary(input.manifest);
  checkAdmission(input, plan.requestSha256);
  throw new Error('LIVE_CREDENTIAL_EXCLUSION_UNPROVEN');
}

type CountExchange = Readonly<{ httpStatus: number; project: string; body: unknown }>;
type MockCountTransport = (request: Readonly<{
  endpoint: typeof countEndpoint; model: string; project: string; generationSha256: string; body: string;
}>, signal: AbortSignal) => Promise<CountExchange>;

/** Test the live gate using the existing simulation-only execution boundary.
 * No mock path may accept a real key or the original historical ledgers. */
export async function rehearseSolLiveAdmission(input: Admission & Readonly<{
  approval: RunnerInput['approval']; count: MockCountTransport; simulate: RunnerInput['simulate']; signal?: AbortSignal;
}>) {
  const authorization = Object.freeze({ ...input.authorization });
  const canaryRequestSha256 = authorization.inferenceCalls === 1
    ? (await planSolCanary(input.manifest)).requestSha256 : undefined;
  checkAdmission({ ...input, authorization }, canaryRequestSha256);
  if (authorization.id !== input.approval.id || authorization.project !== input.approval.project ||
      authorization.expiresAtMs !== input.approval.expiresAtMs) throw new Error('LIVE_APPROVAL_MISMATCH');
  let countCalls = 0;
  return rehearseSolSemanticRun({ ...input, canaryRequestSha256, meter: async (body, signal) => {
    if (signal.aborted || Date.now() >= authorization.expiresAtMs || countCalls >= authorization.countCalls)
      throw new Error('COUNT_NOT_ADMITTED');
    const wire = JSON.parse(body);
    const generationSha256 = sha(body);
    // Candidate projection of model-visible fields only. Live usage requires
    // confirming equivalent framing and JSON-object support at count time.
    const countBody = JSON.stringify({ model: wire.model, instructions: wire.instructions, input: wire.input,
      reasoning: wire.reasoning, text: wire.text });
    countCalls++;
    const response = await input.count(Object.freeze({ endpoint: countEndpoint, body: countBody, generationSha256,
      model: wire.model, project: authorization.project }), signal);
    signal.throwIfAborted();
    const r = response.body as { object?: unknown; input_tokens?: unknown } | null;
    if (response.httpStatus !== 200 || response.project !== authorization.project || r?.object !== 'response.input_tokens' ||
        typeof r.input_tokens !== 'number' || !Number.isSafeInteger(r.input_tokens) || r.input_tokens < 1)
      throw new Error('OFFICIAL_COUNT_INVALID');
    // Attribution comes from the exact request in this call, not an echo in
    // the untrusted response. The existing guard checks hash/model/limit.
    return { kind: 'SIMULATED_EXACT_COUNT', model: wire.model, wireSha256: generationSha256, inputTokens: r.input_tokens };
  } });
}
