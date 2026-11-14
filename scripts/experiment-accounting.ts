/** Shared experimental accounting and credential checks. Node built-ins only. */
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export const EXPERIMENT_LIMITS = Object.freeze({ perRequestUsd: 0.15, cumulativeUsd: 4.0, timeoutMs: 60_000 });
export const ENDPOINT = 'https://api.openai.com/v1/responses';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type Ledger = { calls: Record<string, unknown>[]; estimatedUsd: number; unmeteredReserveUsd: number };

// ---------------------------------------------------------------------------
// Pricing (actual cost from usage). Luna: estimateUsage() in
// scripts/knowledge-aen-single-provider.ts. Sol: knowledge budget owner quote.
export function actualUsd(model: 'luna' | 'sol', usage: any): number | null {
  const input = usage?.input_tokens, output = usage?.output_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0, written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  if (![input, output, cached, written].every(n => Number.isSafeInteger(n) && n >= 0) || cached + written > input) return null;
  return model === 'luna' ? ((input - cached - written) * 0.2 + cached * 0.02 + written * 0.25 + output * 1.2) / 1e6
    : ((input - cached - written) * 2000 + cached * 100 + written * 2500 + output * 10000) / 1e9;
}

// ---------------------------------------------------------------------------
// Exclusive, append-only ledger writer.
export type LedgerPins = { path: string; expectedSha256: string; historicalRows: number; historicalPrefixSha256: string;
  others: { path: string; expectedSha256: string }[] };
export function pinsFromCurrent(path: string, historicalRows: number, others: string[]): LedgerPins {
  const bytes = readFileSync(path), ledger = JSON.parse(bytes.toString('utf8')) as Ledger;
  if (ledger.calls.length !== historicalRows) throw new Error(`ledger has ${ledger.calls.length} rows, expected ${historicalRows}`);
  return { path, expectedSha256: sha256(bytes), historicalRows, historicalPrefixSha256: sha256(JSON.stringify(ledger.calls.slice(0, historicalRows))),
    others: others.map(p => ({ path: p, expectedSha256: sha256(readFileSync(p)) })) };
}
export class ExperimentLedger {
  private lockPath: string;
  private lockFd: number | undefined;
  private reservations = new Map<string, number>();
  constructor(private pins: LedgerPins, private authorizationId: string, private historicalCarryUsd = 0) {
    const path = realpathSync(pins.path);
    const others = pins.others.map(other => ({ ...other, path: realpathSync(other.path) }));
    const identities = [path, ...others.map(other => other.path)].map(p => {
      const file = statSync(p);
      return file.dev + ':' + file.ino;
    });
    if (new Set(identities).size !== identities.length) throw new Error('DUPLICATE_LEDGER_IDENTITY');
    if (!Number.isFinite(historicalCarryUsd) || historicalCarryUsd < 0) throw new Error('INVALID_HISTORICAL_CARRY');
    this.pins = { ...pins, path, others };
    // Both known experimental ledgers share one directory and writer lock.
    this.lockPath = dirname(path) + '/source-aware-usage.json.semantic-recovery.lock';
  }
  /** Verified read: current sha, immutable historical prefix, totals sane. */
  read(): { ledger: Ledger; reservedUsd: number } {
    const bytes = readFileSync(this.pins.path);
    if (sha256(bytes) !== this.pins.expectedSha256) throw new Error('LEDGER_CHANGED_OUTSIDE_WRITER');
    const ledger = JSON.parse(bytes.toString('utf8')) as Ledger;
    if (!Array.isArray(ledger.calls) || ledger.calls.length < this.pins.historicalRows ||
        sha256(JSON.stringify(ledger.calls.slice(0, this.pins.historicalRows))) !== this.pins.historicalPrefixSha256) throw new Error('HISTORICAL_PREFIX_CHANGED');
    if (![ledger.estimatedUsd, ledger.unmeteredReserveUsd].every(n => Number.isFinite(n) && n >= 0)) throw new Error('LEDGER_TOTALS_INVALID');
    let reservedUsd = ledger.estimatedUsd + ledger.unmeteredReserveUsd + this.historicalCarryUsd;
    for (const other of this.pins.others) {
      const otherBytes = readFileSync(other.path);
      if (sha256(otherBytes) !== other.expectedSha256) throw new Error('OTHER_LEDGER_CHANGED');
      const parsed = JSON.parse(otherBytes.toString('utf8')) as Ledger;
      if (![parsed.estimatedUsd, parsed.unmeteredReserveUsd].every(n => Number.isFinite(n) && n >= 0)) throw new Error('OTHER_LEDGER_TOTALS_INVALID');
      reservedUsd += parsed.estimatedUsd + parsed.unmeteredReserveUsd;
    }
    return { ledger, reservedUsd };
  }
  acquire() {
    if (this.lockFd !== undefined) throw new Error('LEDGER_ALREADY_LOCKED');
    this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    try { this.read(); } catch (error) { this.release(); throw error; }
  }
  assertOwnership() {
    if (this.lockFd === undefined) throw new Error('LEDGER_NOT_LOCKED');
    const held = fstatSync(this.lockFd);
    let current;
    try { current = lstatSync(this.lockPath); } catch { throw new Error('LEDGER_LOCK_LOST'); }
    if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino || held.nlink !== 1)
      throw new Error('LEDGER_LOCK_LOST');
  }
  release() {
    if (this.lockFd === undefined) return;
    try {
      try { this.assertOwnership(); } catch { return; }
      unlinkSync(this.lockPath);
    } finally {
      closeSync(this.lockFd);
      this.lockFd = undefined;
    }
  }
  private append(row: Record<string, unknown>, delta: { estimatedUsd?: number; unmeteredReserveUsd?: number }) {
    this.assertOwnership();
    const { ledger } = this.read();
    const next: Ledger = { ...ledger, calls: [...ledger.calls, Object.freeze({ ...row, authorizationId: this.authorizationId,
        ledgerConvention: 'append-only-settlement-v1' })],
      estimatedUsd: ledger.estimatedUsd + (delta.estimatedUsd ?? 0), unmeteredReserveUsd: ledger.unmeteredReserveUsd + (delta.unmeteredReserveUsd ?? 0) };
    const text = JSON.stringify(next, null, 2);
    const tmp = this.pins.path + '.semantic-recovery.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    this.assertOwnership();
    renameSync(tmp, this.pins.path);
    const parent = openSync(dirname(this.pins.path), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    this.pins = { ...this.pins, expectedSha256: sha256(Buffer.from(text)) };
    this.read();                                         // re-verify what was written
  }
  reserve(request: { requestId: string; caseId: string; stage: string; model: string; requestSha256: string; ceilingUsd: number }) {
    if (!(request.ceilingUsd > 0 && request.ceilingUsd <= EXPERIMENT_LIMITS.perRequestUsd)) throw new Error('PER_REQUEST_CEILING_EXCEEDED');
    const { ledger, reservedUsd } = this.read();
    if (ledger.calls.some(row => row.requestId === request.requestId)) throw new Error('DUPLICATE_REQUEST_ID');
    if (reservedUsd + request.ceilingUsd > EXPERIMENT_LIMITS.cumulativeUsd) throw new Error('CUMULATIVE_CEILING_EXCEEDED');
    this.append({ requestId: request.requestId, case: request.caseId, stage: request.stage, model: request.model, requestSha256: request.requestSha256,
      conservativeReservationUsd: request.ceilingUsd, reservationStatus: 'RESERVED', estimatedUsd: 0, createdAt: new Date().toISOString() },
      { unmeteredReserveUsd: request.ceilingUsd });
    this.reservations.set(request.requestId, request.ceilingUsd);
  }
  settle(requestId: string, outcome: { status: 'SETTLED' | 'UNKNOWN_RETAINED' | 'NOT_DISPATCHED_RELEASED'; estimatedUsd?: number } & Record<string, unknown>) {
    const reserved = this.reservations.get(requestId);
    if (reserved === undefined) throw new Error('UNKNOWN_RESERVATION');
    const { status, estimatedUsd = 0, ...details } = outcome;
    if (status === 'SETTLED' && (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || estimatedUsd > reserved))
      throw new Error('SETTLEMENT_OUTSIDE_RESERVATION');
    this.append({ ...details, settlementOf: requestId, reservationStatus: status, estimatedUsd: status === 'SETTLED' ? estimatedUsd : 0,
      settledAt: new Date().toISOString() },
      status === 'UNKNOWN_RETAINED' ? {} : { unmeteredReserveUsd: -reserved, estimatedUsd: status === 'SETTLED' ? estimatedUsd : 0 });
    this.reservations.delete(requestId);
  }
}

export function loadCredential(root: string) {
  const keyFile = `${root}/work-openai.env`, projectFile = `${root}/work-openai-project.json`;
  for (const [path, mode] of [[root, 0o700], [keyFile, 0o600], [projectFile, 0o600]] as const) {
    const info = statSync(path);
    if ((info.mode & 0o777) !== mode || info.uid !== process.getuid?.()) throw new Error('CREDENTIAL_PERMISSIONS_INVALID');
  }
  const match = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/mu.exec(readFileSync(keyFile, 'utf8'));
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  if (!match || !/^sk-[A-Za-z0-9_-]{20,}$/u.test(match[1]) || sha256(match[1]) !== project.credentialSha256 ||
      !/^proj_[A-Za-z0-9_-]+$/u.test(project.expectedProjectId)) throw new Error('CREDENTIAL_INVALID');
  return { key: match[1], expectedProjectId: project.expectedProjectId as string };
}
