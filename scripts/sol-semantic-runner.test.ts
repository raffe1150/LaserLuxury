import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ExperimentLedger, pinsFromCurrent } from './experiment-accounting';
import { executeSolCountedInference, rehearseSolCountedInference, executeSolSemanticManualCanary, rehearseSolManualCanary, executeSolSemanticCanary, executeSolSemanticLive, rehearseSolLiveAdmission, solLedgerPinsSha256 } from './sol-semantic-live';
import { planSolCanary, rehearseSolSemanticRun, solSemanticPins, type Approval } from './sol-semantic-runner';

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
  return { args: { manifest, pins, approval, credentialRoot, meter: (wire: string) => meter(wire) }, meter,  dir, path, other, original,
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
      assert.equal(wire.text.format.type, 'json_object');
      assert.deepEqual(wire.input.map((message: { role: string }) => message.role), ['developer', 'user']);
      assert.match(wire.input[0].content, /\bJSON\b/i);
      assert.equal(JSON.parse(wire.input[1].content).text, turns[calls].text);
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
    const run = (meter: Parameters<typeof rehearseSolSemanticRun>[0]['meter']) => rehearseSolSemanticRun({ ...f.args, meter, simulate: never });
    await assert.rejects(run(undefined), /INPUT_BOUND_UNPROVEN/);
    // A caller-supplied imitation of an official response does not authorize
    // the rehearsal (and cannot be used as live input evidence).
    await assert.rejects(run(wire => ({ object: 'response.input_tokens', input_tokens: 120,
      model: 'gpt-6.1-sol', wireSha256: sha(wire) }) as unknown as ReturnType<typeof f.meter>), /INPUT_BOUND_UNPROVEN/);
    for (const count of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(run(wire => f.meter(wire, count)), /INPUT_BOUND_UNPROVEN/);
    }
    await assert.rejects(run(wire => ({ ...f.args.meter(wire), model: 'other-model' })), /INPUT_BOUND_UNPROVEN/);
    await assert.rejects(run(wire => ({ ...f.args.meter(wire), wireSha256: sha(wire + ' ') })), /INPUT_BOUND_UNPROVEN/);
    await assert.rejects(run(wire => f.meter(wire, 16001)), /INPUT_TOKEN_LIMIT/);
    assert.deepEqual(f.read(), f.original);
    let calls = 0;
    await assert.rejects(rehearseSolSemanticRun({ ...f.args, meter: wire => f.meter(wire, 16000), simulate: async request => {
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


test('a matching non-simulation credential cannot enter the rehearsal', async () => {
  const f = fixture();
  try {
    const key = 'sk-proj-placeholder-for-negative-control';
    const root = f.args.credentialRoot;
    writeFileSync(root + '/work-openai.env', 'OPENAI_API_KEY=' + key);
    writeFileSync(root + '/work-openai-project.json', JSON.stringify({
      expectedProjectId: f.args.approval.project, credentialSha256: sha(key),
    }));
    await assert.rejects(rehearseSolSemanticRun({ ...f.args, simulate: never }), /SIMULATION_CREDENTIAL_REQUIRED/);
    assert.deepEqual(f.read(), f.original);
    assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
  } finally { f.cleanup(); }
});

function liveFixture(f: ReturnType<typeof fixture>) {
  const a = f.args.approval;
  return { ...f.args, authorization: {
    id: a.id, issuedAtMs: Date.now(), expiresAtMs: a.expiresAtMs, manifestSha256: a.manifestSha256,
    sourcesSha256: solSemanticPins.sourcesSha256, model: solSemanticPins.model, project: a.project,
    credentialSha256: sha('sk-synthetic-fixture-only-no-provider'), ledgerPinsSha256: solLedgerPinsSha256(f.args.pins),
    countCalls: 18 as const, inferenceCalls: 18 as const, retryCalls: 0 as const,
    maxRunUsd: 1.008, maxRequestUsd: 0.15, cumulativeUsd: 4,
  } };
}

test('live admission is blocked for real transport, even when all local pins match', () => {
  const f = fixture();
  try {
    const input = liveFixture(f);
    assert.throws(() => executeSolSemanticLive(input), /LIVE_CREDENTIAL_EXCLUSION_UNPROVEN/);
    for (const patch of [{ expiresAtMs: 0 }, { sourcesSha256: 'wrong' }, { ledgerPinsSha256: 'wrong' }])
      assert.throws(() => executeSolSemanticLive({ ...input, authorization: { ...input.authorization, ...patch } }), /LIVE_APPROVAL_INVALID/);
    for (const patch of [{ credentialSha256: 'wrong' }, { project: 'proj_different' }])
      assert.throws(() => executeSolSemanticLive({ ...input, authorization: { ...input.authorization, ...patch } }), /LIVE_CREDENTIAL_PIN_MISMATCH/);
    assert.deepEqual(f.read(), f.original);
    assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
  } finally { f.cleanup(); }
});

test('18 mocked official counts precede 18 reserved requests and cover model-visible fields', async () => {
  const f = fixture();
  try {
    let counts = 0, calls = 0;
    let nextHash: string | undefined;
    let countBody: unknown;
    const result = await rehearseSolLiveAdmission({ ...liveFixture(f), count: async request => {
      assert.equal(counts++, calls);
      assert.match(request.endpoint, /\/responses\/input_tokens$/);
      nextHash = request.generationSha256;
      countBody = JSON.parse(request.body);
      return { httpStatus: 200, project: request.project, body: { object: 'response.input_tokens', input_tokens: 16000 } };
    }, simulate: async request => {
      assert.equal(counts, calls + 1);
      assert.equal(sha(request.body), nextHash);
      const { model, instructions, input, reasoning, text } = JSON.parse(request.body);
      assert.deepEqual(countBody, { model, instructions, input, reasoning, text });
      assert.equal(f.read().calls.at(-1).requestSha256, nextHash);
      assert.equal(f.read().calls.at(-1).conservativeReservationUsd, 0.056);
      return reply(calls++);
    } });
    assert.deepEqual([counts, calls], [18, 18]);
    assert.ok(result.results.every(row => row.exact));
  } finally { f.cleanup(); }
});

test('invalid official count evidence cannot reserve or reach inference', async () => {
  const f = fixture();
  try {
    const input = liveFixture(f);
    for (const body of [null, { object: 'response', input_tokens: 10 },
      { object: 'response.input_tokens' }, { object: 'response.input_tokens', input_tokens: 1.5 },
      { object: 'response.input_tokens', input_tokens: 16001 }]) {
      let calls = 0;
      await assert.rejects(rehearseSolLiveAdmission({ ...input, count: async request => {
        calls++;
        return { httpStatus: 200, project: request.project, body };
      }, simulate: never }), /OFFICIAL_COUNT_INVALID|INPUT_TOKEN_LIMIT/);
      assert.equal(calls, 1);
      assert.deepEqual(f.read(), f.original);
    }
  } finally { f.cleanup(); }
});

test('interruption retains the hold across reopen and blocks reuse of the authorization', async () => {
  const f = fixture();
  try {
    let counts = 0, calls = 0;
    const input = liveFixture(f);
    const stop = new AbortController();
    const count: Parameters<typeof rehearseSolLiveAdmission>[0]['count'] = async request => {
      counts++;
      return { httpStatus: 200, project: request.project, body: { object: 'response.input_tokens', input_tokens: 120 } };
    };
    await assert.rejects(rehearseSolLiveAdmission({ ...input, count, signal: stop.signal, simulate: async () => {
      calls++;
      stop.abort();
      throw new Error('interrupted');
    } }));
    const pins = pinsFromCurrent(f.path, 2, [f.other]);
    const disk = new ExperimentLedger(pins, 'inspect-interruption', solSemanticPins.historicalCarryUsd).read();
    assert.equal(disk.ledger.calls[1].reservationStatus, 'RESERVED');
    assert.ok(Math.abs(disk.ledger.unmeteredReserveUsd - f.original.unmeteredReserveUsd - 0.056) < 1e-10);
    await assert.rejects(rehearseSolLiveAdmission({ ...input, pins, count, simulate: never,
      authorization: { ...input.authorization, ledgerPinsSha256: solLedgerPinsSha256(pins) },
      approval: { ...input.approval, primaryLedgerSha256: pins.expectedSha256 } }), /APPROVAL_ALREADY_USED/);
    assert.deepEqual([counts, calls], [1, 1]);
  } finally { f.cleanup(); }
});

test('first-turn canary binds one wire, claims approval before counting, and reserves before inference', async () => {
  const f = fixture();
  try {
    const plan = await planSolCanary(f.args.manifest);
    const base = liveFixture(f);
    const input = { ...base, approval: { ...base.approval, maxUsd: 0.056 }, authorization: {
      ...base.authorization, requestSha256: plan.requestSha256, countCalls: 1 as const, inferenceCalls: 1 as const, maxRunUsd: 0.056,
    } };
    assert.equal(plan.requestSha256, 'd4ba9ed34d15df92a0ee61bd2b4196ad29cf64aeee9eb198b5c2bde4f510b16c');
    const wire = JSON.parse(plan.body);
    assert.deepEqual(wire.input[0], { role: 'developer', content: 'Return the semantic interpretation as a JSON object.' });
    assert.equal(wire.text.format.type, 'json_object');
    const customer = JSON.parse(wire.input[1].content);
    assert.equal(customer.text, turns[0].text);
    assert.equal(customer.language, 'sv');
    assert.deepEqual(customer.references, []);
    assert.deepEqual(turns[0].expected.map((label: { questionType: string }) => label.questionType), ['requirement', 'recommendation']);
    assert.equal(turns[0].expected[0].conditions.length, 1);
    const stale = { ...input, authorization: { ...input.authorization,
      requestSha256: '5c6f7ebfaa94e556b08d839206ab02552a3c9fdd86f0dc476975b743a2ade6b7' } };
    await assert.rejects(rehearseSolLiveAdmission({ ...stale, count: never, simulate: never }), /LIVE_APPROVAL_INVALID/);
    assert.deepEqual(f.read(), f.original);
    await assert.rejects(executeSolSemanticCanary(input), /LIVE_CREDENTIAL_EXCLUSION_UNPROVEN/);
    await assert.rejects(executeSolSemanticCanary({ ...input, authorization: { ...input.authorization, expiresAtMs: 0 } }), /LIVE_APPROVAL_INVALID/);
    await assert.rejects(executeSolSemanticCanary({ ...input, authorization: { ...input.authorization, requestSha256: 'wrong' } }), /LIVE_APPROVAL_INVALID/);
    let counts = 0, calls = 0;
    const result = await rehearseSolLiveAdmission({ ...input, count: async request => {
      counts++;
      assert.equal(request.generationSha256, plan.requestSha256);
      const { model, instructions, input, reasoning, text } = JSON.parse(plan.body);
      assert.deepEqual(JSON.parse(request.body), { model, instructions, input, reasoning, text });
      assert.equal(f.read().calls.at(-1).reservationStatus, 'CANARY_APPROVAL_CLAIMED');
      return { httpStatus: 200, project: request.project, body: { object: 'response.input_tokens', input_tokens: 120 } };
    }, simulate: async request => {
      calls++;
      assert.equal(request.body, plan.body);
      const row = f.read().calls.at(-1);
      assert.equal(row.requestSha256, plan.requestSha256);
      assert.equal(row.conservativeReservationUsd, 0.056);
      return reply(0);
    } });
    assert.deepEqual([counts, calls], [1, 1]);
    assert.equal(result.results[0].id, plan.turnId);
  } finally { f.cleanup(); }
});

test('failed canary count consumes approval and inference identity failures retain the hold', async () => {
  for (const mismatch of ['count-project', 'inference-project', 'inference-model', 'unknown-usage']) {
    const f = fixture();
    try {
      const plan = await planSolCanary(f.args.manifest);
      const base = liveFixture(f);
      const input = { ...base, approval: { ...base.approval, maxUsd: 0.056 }, authorization: {
        ...base.authorization, requestSha256: plan.requestSha256, countCalls: 1 as const, inferenceCalls: 1 as const, maxRunUsd: 0.056,
      } };
      let counts = 0, calls = 0;
      const count: Parameters<typeof rehearseSolLiveAdmission>[0]['count'] = async request => {
        counts++;
        return { httpStatus: 200, project: mismatch === 'count-project' ? 'proj_wrong' : request.project,
          body: { object: 'response.input_tokens', input_tokens: 120 } };
      };
      await assert.rejects(rehearseSolLiveAdmission({ ...input, count, simulate: async () => {
        calls++;
        const r = reply(0);
        if (mismatch === 'inference-project') r.project = 'proj_wrong';
        if (mismatch === 'inference-model') r.body.model = 'wrong';
        if (mismatch === 'unknown-usage') Reflect.deleteProperty(r.body, 'usage');
        return r;
      } }), /OFFICIAL_COUNT_INVALID|RESPONSE_IDENTITY|UNVERIFIED_USAGE/);
      const noInference = mismatch === 'count-project';
      assert.deepEqual([counts, calls], [1, noInference ? 0 : 1]);
      const retained = f.read();
      assert.equal(retained.calls.at(-1).reservationStatus, noInference ? 'CANARY_APPROVAL_CLAIMED' : 'RESERVED');
      assert.ok(Math.abs(retained.unmeteredReserveUsd - f.original.unmeteredReserveUsd - (noInference ? 0 : 0.056)) < 1e-10);
      const pins = pinsFromCurrent(f.path, retained.calls.length, [f.other]);
      await assert.rejects(rehearseSolLiveAdmission({ ...input, pins, count, simulate: never,
        authorization: { ...input.authorization, ledgerPinsSha256: solLedgerPinsSha256(pins) },
        approval: { ...input.approval, primaryLedgerSha256: pins.expectedSha256 } }), /APPROVAL_ALREADY_USED/);
      assert.deepEqual([counts, calls], [1, noInference ? 0 : 1]);
    } finally { f.cleanup(); }
  }
});

test('manual canary admits only the pinned simulation and retains unknown billing without retry', async () => {
  const f = fixture();
  try {
    const plan = await planSolCanary(f.args.manifest);
    const base = liveFixture(f);
    const input = { ...base, approval: { ...base.approval, maxUsd: 0.056 }, authorization: {
      ...base.authorization, requestSha256: plan.requestSha256, countCalls: 0 as const, inferenceCalls: 1 as const, maxRunUsd: 0.056,
    } };
    await assert.rejects(executeSolSemanticManualCanary(input), /MANUAL_INPUT_BOUND_UNPROVEN/);
    await assert.rejects(rehearseSolManualCanary({ ...input, authorization: { ...input.authorization, requestSha256: 'wrong' },
      simulatedFramingTokenLimit: 0, simulate: never }), /LIVE_APPROVAL_INVALID/);
    const maxFraming = 16_000 - Buffer.byteLength(plan.body);
    await assert.rejects(rehearseSolManualCanary({ ...input, simulatedFramingTokenLimit: maxFraming + 1, simulate: never }),
      /MANUAL_CANARY_BUDGET/);
    assert.deepEqual(f.read(), f.original);
    let calls = 0;
    await assert.rejects(rehearseSolManualCanary({ ...input, simulatedFramingTokenLimit: maxFraming, simulate: async request => {
      calls++;
      assert.equal(request.body, plan.body);
      assert.equal(sha(request.body), plan.requestSha256);
      const wire = JSON.parse(request.body);
      assert.equal(wire.max_output_tokens, 1600);
      assert.equal(f.read().calls.at(-1).conservativeReservationUsd, 0.056);
      assert.equal(f.read().calls.at(-1).reservationStatus, 'RESERVED');
      const response = reply(0);
      Reflect.deleteProperty(response.body, 'usage');
      return response;
    } }), /UNVERIFIED_USAGE/);
    assert.equal(calls, 1);
    const state = f.read();
    assert.ok(Math.abs(state.unmeteredReserveUsd - f.original.unmeteredReserveUsd - 0.056) < 1e-10);
    const pins = pinsFromCurrent(f.path, state.calls.length, [f.other]);
    await assert.rejects(rehearseSolManualCanary({ ...input, pins, simulatedFramingTokenLimit: maxFraming, simulate: never,
      authorization: { ...input.authorization, ledgerPinsSha256: solLedgerPinsSha256(pins) },
      approval: { ...input.approval, primaryLedgerSha256: pins.expectedSha256 } }), /APPROVAL_ALREADY_USED/);
  } finally { f.cleanup(); }
});

test('counted inference HTTP transport pins the wire and project and reserves before its single POST', async () => {
  const f = fixture();
  try {
    const plan = await planSolCanary(f.args.manifest);
    const base = liveFixture(f);
    const input = { ...base, approval: { ...base.approval, maxUsd: 0.056 }, authorization: {
      ...base.authorization, requestSha256: plan.requestSha256, countCalls: 0 as const, inferenceCalls: 1 as const, maxRunUsd: 0.056,
    } };
    await assert.rejects(executeSolCountedInference(input), /LIVE_COUNT_PROVENANCE_AND_CREDENTIAL_EXCLUSION_UNPROVEN/);
    await assert.rejects(rehearseSolCountedInference({ ...input, mockFetch: globalThis.fetch }), /MOCK_FETCH_REQUIRED/);
    let calls = 0;
    const mockFetch: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.body, plan.body);
      assert.equal(sha(String(init?.body)), plan.requestSha256);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('OpenAI-Project'), input.authorization.project);
      assert.equal(headers.get('Authorization'), 'Bearer sk-synthetic-fixture-only-no-provider');
      const rows = f.read().calls;
      assert.deepEqual(rows[0], f.original.calls[0]);
      assert.equal(rows.at(-2).reservationStatus, 'CANARY_APPROVAL_CLAIMED');
      assert.equal(rows.at(-1).conservativeReservationUsd, 0.056);
      assert.equal(rows.at(-1).requestSha256, plan.requestSha256);
      return Response.json(reply(0).body, { headers: { 'openai-project': input.authorization.project } });
    };
    await assert.rejects(rehearseSolCountedInference({ ...input, mockFetch,
      authorization: { ...input.authorization, expiresAtMs: 0 } }), /LIVE_APPROVAL_INVALID/);
    await assert.rejects(rehearseSolCountedInference({ ...input, mockFetch,
      authorization: { ...input.authorization, requestSha256: sha(plan.body + ' ') } }), /LIVE_APPROVAL_INVALID/);
    assert.equal(calls, 0);
    const result = await rehearseSolCountedInference({ ...input, mockFetch });
    assert.deepEqual(result.results.map(r => r.id), ['sv:1']);
    assert.equal(calls, 1);
    const pins = pinsFromCurrent(f.path, f.read().calls.length, [f.other]);
    await assert.rejects(rehearseSolCountedInference({ ...input, mockFetch, pins,
      authorization: { ...input.authorization, ledgerPinsSha256: solLedgerPinsSha256(pins) },
      approval: { ...input.approval, primaryLedgerSha256: pins.expectedSha256 } }), /APPROVAL_ALREADY_USED/);
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});

test('counted inference retains the full hold on invalid HTTP receipts or interrupted transport', async () => {
  for (const mode of ['missing-project', 'wrong-project', 'bad-body', 'unverified-usage', 'input-over-count', 'interruption']) {
    const f = fixture();
    try {
      const plan = await planSolCanary(f.args.manifest);
      const base = liveFixture(f);
      const signal = new AbortController();
      let calls = 0;
      await assert.rejects(rehearseSolCountedInference({ ...base, signal: signal.signal,
        approval: { ...base.approval, maxUsd: 0.056 }, authorization: {
          ...base.authorization, requestSha256: plan.requestSha256, countCalls: 0, inferenceCalls: 1, maxRunUsd: 0.056,
        }, mockFetch: async () => {
          calls++;
          if (mode === 'interruption') { signal.abort(); throw new Error('interrupted after reservation'); }
          const headers = new Headers();
          if (mode !== 'missing-project') headers.set('openai-project', mode === 'wrong-project' ? 'proj_other' : base.authorization.project);
          if (mode === 'bad-body') return new Response('{', { headers });
          const body = reply(0).body;
          if (mode === 'unverified-usage') Reflect.deleteProperty(body, 'usage');
          if (mode === 'input-over-count') { body.usage.input_tokens = 388; body.usage.total_tokens = 408; }
          return Response.json(body, { headers });
        } }));
      const after = f.read();
      assert.equal(calls, 1);
      assert.equal(after.calls.at(-1).reservationStatus, 'RESERVED');
      assert.ok(Math.abs(after.unmeteredReserveUsd - f.original.unmeteredReserveUsd - 0.056) < 1e-10);
      assert.deepEqual(after.calls[0], f.original.calls[0]);
      assert.ok(!existsSync(f.path + '.semantic-recovery.lock'));
    } finally { f.cleanup(); }
  }
});
