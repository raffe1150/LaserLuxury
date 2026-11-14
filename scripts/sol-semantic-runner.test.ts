import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ExperimentLedger, pinsFromCurrent } from './experiment-accounting';
import { rehearseSolSemanticRun, type Approval } from './sol-semantic-runner';

const manifest = readFileSync(new URL('../docs/validation/brain-v2-sol-readiness/manifest.json', import.meta.url));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const turns = JSON.parse(manifest.toString()).turns;
function fixture(balance = 2.43327206) {
  const dir = realpathSync(mkdtempSync(tmpdir() + '/odin-sol-sim-'));
  const path = dir + '/source-aware-usage.json', other = dir + '/budget-resumed-usage.json';
  const credentialRoot = dir + '/credentials', key = 'sk-synthetic-fixture-only-no-provider', project = 'proj_OFFLINE_TEST';
  mkdirSync(credentialRoot, { mode: 0o700 });
  writeFileSync(credentialRoot + '/work-openai.env', 'OPENAI_API_KEY=' + key, { mode: 0o600 });
  writeFileSync(credentialRoot + '/work-openai-project.json', JSON.stringify({ expectedProjectId: project, credentialSha256: sha(key) }), { mode: 0o600 });
  const original = { calls: [{ historical: true }], estimatedUsd: 0, unmeteredReserveUsd: balance };
  writeFileSync(path, JSON.stringify(original), { mode: 0o600 });
  writeFileSync(other, JSON.stringify({ calls: [], estimatedUsd: 0.07664257, unmeteredReserveUsd: 0.26 }), { mode: 0o600 });
  const pins = pinsFromCurrent(path, 1, [other]);
  const approval: Approval = { id: 'test-sol-run', manifestSha256: sha(manifest), primaryLedgerSha256: pins.expectedSha256,
    otherLedgerSha256: pins.others[0].expectedSha256, primaryPath: path, otherPath: other, project, expiresAtMs: Date.now() + 60_000,
    maxUsd: 1.008, cumulativeUsd: 4, requestUsd: 0.15, mode: 'OFFLINE_SIMULATION' };
  const meter = (wire: string, inputTokens = 120) => ({
    kind: 'SIMULATED_EXACT_COUNT' as const, model: 'gpt-6.1-sol', wireSha256: sha(wire), inputTokens,
  });
  return { args: { manifest, pins, approval, credentialRoot, meter },  dir, path, other, original,
    read: () => JSON.parse(readFileSync(path, 'utf8')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function reply(i: number) {
  return { project: 'proj_OFFLINE_TEST', httpStatus: 200, body: { id: 'resp_mock_' + i,
    object: 'response', model: 'gpt-6.1-sol', status: 'completed', max_output_tokens: 1600, service_tier: 'default',
    reasoning: { effort: 'low' }, prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
      text: JSON.stringify({ version: 1, readings: turns[i].expected }) }] }],
  } };
}
test('18 ordered simulations reserve before calling and preserve the historical prefix', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await rehearseSolSemanticRun({ ...f.args, simulate: async request => {
      const hold = f.read().calls.at(-1);
      assert.equal(hold.requestSha256, sha(request.body));
      assert.equal(hold.conservativeReservationUsd, 0.056);
      assert.ok(existsSync(f.path + '.semantic-recovery.lock'));
      const wire = JSON.parse(request.body);
      assert.equal(wire.max_output_tokens, 1600);
      assert.ok(!('tools' in wire) && !('previous_response_id' in wire));
      assert.ok(!request.body.includes('"expected"'));
      assert.equal(JSON.parse(wire.input[0].content).text, turns[calls].text);
      return reply(calls++);
    } });
    assert.equal(calls, 18);
    assert.ok(result.results.every(row => row.exact && !row.unsafeRoute));
    assert.equal(result.genuineAccuracy, 'UNMEASURED');
    assert.deepEqual(f.read().calls[0], f.original.calls[0]);
    assert.equal(f.read().calls.length, 37);
    assert.ok(Math.abs(f.read().unmeteredReserveUsd - f.original.unmeteredReserveUsd) < 1e-10);
    assert.equal(sha(readFileSync(f.other)), f.args.pins.others[0].expectedSha256);
    const pins = pinsFromCurrent(f.path, 37, [f.other]);
    await assert.rejects(rehearseSolSemanticRun({ ...f.args, pins,
      approval: { ...f.args.approval, primaryLedgerSha256: pins.expectedSha256 }, simulate: never }), /APPROVAL_ALREADY_USED/);
    assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
  } finally { f.cleanup(); }
});
const never = async () => { throw new Error('unexpected call'); };
test('aliases and either ledger contend for one writer lock', async () => {
  const f = fixture();
  try {
    const alias = f.dir + '/alias.json';
    symlinkSync(f.path, alias);
    assert.throws(() => new ExperimentLedger(pinsFromCurrent(f.path, 1, [alias]), 'alias'), /DUPLICATE_LEDGER/);
    const writer = new ExperimentLedger(pinsFromCurrent(f.other, 0, [f.path]), 'competing');
    writer.acquire();
    try { await assert.rejects(rehearseSolSemanticRun({ ...f.args, simulate: never }), /EEXIST/); }
    finally { writer.release(); }
    assert.deepEqual(f.read(), f.original);
  } finally { f.cleanup(); }
});
test('approval, budget, credential and hash failures leave the ledger unchanged', async () => {
  const f = fixture(3.9);
  try {
    const input = { ...f.args, simulate: never };
    await assert.rejects(rehearseSolSemanticRun(input), /RUN_BUDGET/);
    await assert.rejects(rehearseSolSemanticRun({ ...input, approval: { ...input.approval, expiresAtMs: 0 } }), /APPROVAL_INVALID/);
    await assert.rejects(rehearseSolSemanticRun({ ...input, approval: { ...input.approval, project: 'proj_wrong' } }), /CREDENTIAL_PROJECT_MISMATCH/);
    await assert.rejects(rehearseSolSemanticRun({ ...input, manifest: Buffer.concat([manifest, Buffer.from(' ')]) }), /MANIFEST_HASH/);
    writeFileSync(f.other, '{}');
    await assert.rejects(rehearseSolSemanticRun(input), /OTHER_LEDGER_CHANGED/);
    assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
    assert.deepEqual(f.read(), f.original);
  } finally { f.cleanup(); }
});
test('unverifiable receipts retain the entire hold and stop without retries', async () => {
  for (const mode of ['transport', 'project', 'model', 'usage', 'input', 'output', 'reasoning', 'wire', 'abort']) {
    const f = fixture(), controller = new AbortController();
    try {
      let calls = 0;
      await assert.rejects(rehearseSolSemanticRun({ ...f.args, signal: controller.signal, simulate: async () => {
        const r = reply(calls++);
        if (mode === 'transport') throw new Error('transport timeout');
        if (mode === 'project') r.project = 'proj_wrong';
        if (mode === 'model') r.body.model = 'wrong';
        if (mode === 'usage') Reflect.deleteProperty(r.body, 'usage');
        if (mode === 'input') r.body.usage.input_tokens = 16001;
        if (mode === 'output') r.body.usage.output_tokens = 1601;
        if (mode === 'reasoning') r.body.usage.output_tokens_details.reasoning_tokens = 21;
        if (mode === 'wire') r.body.output[0].content[0].text = '{}';
        if (mode === 'abort') controller.abort();
        return r;
      } }));
      assert.equal(calls, 1, mode);
      const after = f.read();
      assert.deepEqual(after.calls[0], f.original.calls[0]);
      assert.equal(after.calls.length, 2);
      assert.equal(after.calls[1].reservationStatus, 'RESERVED');
      assert.ok(Math.abs(after.unmeteredReserveUsd - f.original.unmeteredReserveUsd - 0.056) < 1e-10);
      assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
    } finally { f.cleanup(); }
  }
});

test('deadline expires even if a transport ignores cancellation and responds late', async () => {
  const f = fixture();
  try {
    let release: (result: ReturnType<typeof reply>) => void = () => {};
    let signal: AbortSignal | undefined;
    await assert.rejects(rehearseSolSemanticRun({ ...f.args, simulate: async (_, supplied) => {
      signal = supplied;
      return new Promise(resolve => { release = resolve; });
    } }), /SEMANTIC_RESPONSE_UNVERIFIED/);
    assert.ok(signal?.aborted);
    const bytes = readFileSync(f.path, 'utf8');
    release(reply(0));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    assert.equal(f.read().calls.at(-1).reservationStatus, 'RESERVED');
  } finally { f.cleanup(); }
});


test('input admission rejects absent or stale proof and applies the exact 16,000 boundary', async () => {
  const f = fixture();
  try {
    const run = (meter: typeof f.args.meter | undefined) => rehearseSolSemanticRun({ ...f.args, meter, simulate: never });
    await assert.rejects(run(undefined), /INPUT_BOUND_UNPROVEN/);
    await assert.rejects(run(wire => ({ ...f.args.meter(wire), wireSha256: sha(wire + ' ') })), /INPUT_BOUND_UNPROVEN/);
    await assert.rejects(run(wire => f.args.meter(wire, 16001)), /INPUT_TOKEN_LIMIT/);
    assert.deepEqual(f.read(), f.original);
    let calls = 0;
    await assert.rejects(rehearseSolSemanticRun({ ...f.args, meter: wire => f.args.meter(wire, 16000), simulate: async request => {
      calls++;
      assert.equal(sha(request.body), f.read().calls.at(-1).requestSha256);
      throw new Error('simulation stopped at boundary');
    } }), /simulation stopped at boundary/);
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});

test('losing the canonical lock or changing a companion ledger retains the hold', async () => {
  for (const attack of ['replace lock', 'change companion']) {
    const f = fixture();
    try {
      const lock = f.path + '.semantic-recovery.lock';
      let calls = 0;
      await assert.rejects(rehearseSolSemanticRun({ ...f.args, simulate: async () => {
        calls++;
        if (attack === 'replace lock') {
          unlinkSync(lock);
          writeFileSync(lock, 'other writer', { flag: 'wx' });
        } else writeFileSync(f.other, '{}');
        return reply(0);
      } }), /LEDGER_LOCK_LOST|OTHER_LEDGER_CHANGED/);
      assert.equal(calls, 1);
      assert.equal(f.read().calls.length, 2);
      assert.equal(f.read().calls.at(-1).reservationStatus, 'RESERVED');
      if (attack === 'replace lock') assert.equal(readFileSync(lock, 'utf8'), 'other writer');
    } finally { f.cleanup(); }
  }
});
