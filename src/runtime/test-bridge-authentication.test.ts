import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { authenticateTestBridgeRequest, TEST_BRIDGE_TOKEN_ENV, type TestBridgeAuthenticationResult } from './test-bridge-security';

const TOKEN = 'synthetic-bridge-token-at-least-32-bytes';
const WRONG = 'synthetic-wrong-token-at-least-32-bytes';
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
function extract(file: ts.SourceFile, names: string[]) {
  return names.map(name => {
    const matches = file.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.equal(matches.length, 1, `one actual function required: ${name}`);
    return matches[0].getText(file).replace(/^export /, '');
  }).join('\n');
}
const executable = ts.transpileModule(extract(parsed, ['isTestBridgeEnabled', 'testBridgeUnavailable', 'createTestBridgeRouter']), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
interface Response {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  json(value: unknown): Response;
  sendStatus(code: number): Response;
}
type Middleware = (req: { header(name: string): string | undefined }, res: Response, next: () => void) => void;
function runMiddleware(enabled: string | undefined, configured: string | undefined, authorization?: string) {
  let middleware: Middleware | undefined;
  let authCalls = 0, nextCalls = 0;
  let status: number | undefined, payload: unknown;
  const headers: Record<string, string> = {};
  const logs: unknown[][] = [];
  const env: NodeJS.ProcessEnv = { ODINLINK_TEST_BRIDGE_ENABLED: enabled, [TEST_BRIDGE_TOKEN_ENV]: configured };
  const router = {
    use(path: string, handler: Middleware) { assert.equal(path, '/api/test-bridge/v1'); middleware = handler; },
    get() {}, post() {},
  };
  const context = vm.createContext({
    express: { Router: () => router }, process: { env },
    TEST_BRIDGE_SCHEMA_VERSION: 'odinlink-test-bridge-v1',
    authenticateTestBridgeRequest: (header: string | undefined) => { authCalls++; return authenticateTestBridgeRequest(header, env); },
    console: { error: (...values: unknown[]) => logs.push(JSON.parse(JSON.stringify(values))), warn: (...values: unknown[]) => logs.push(JSON.parse(JSON.stringify(values))) },
  });
  vm.runInContext(executable, context);
  vm.runInContext('createTestBridgeRouter()', context);
  const response: Response = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { status = code; return response; },
    json(value) { payload = JSON.parse(JSON.stringify(value)); return response; },
    sendStatus(code) { status = code; return response; },
  };
  assert.ok(middleware);
  middleware({ header(name) { assert.equal(name, 'authorization'); return authorization; } }, response, () => { nextCalls++; });
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(JSON.stringify({ payload, logs }).includes(TOKEN), false);
  assert.equal(JSON.stringify({ payload, logs }).includes(WRONG), false);
  return { authCalls, nextCalls, status, payload, logs };
}

for (const [name, configured, header, expected] of [
  ['missing configuration', undefined, `Bearer ${TOKEN}`, { authorized: false, category: 'authentication_configuration_error' }],
  ['short configuration', 'x'.repeat(31), `Bearer ${TOKEN}`, { authorized: false, category: 'authentication_configuration_error' }],
  ['missing header', TOKEN, undefined, { authorized: false, category: 'authentication_failed' }],
  ['empty header', TOKEN, '', { authorized: false, category: 'authentication_failed' }],
  ['wrong credential', TOKEN, `Bearer ${WRONG}`, { authorized: false, category: 'authentication_failed' }],
  ['wrong scheme', TOKEN, `Basic ${TOKEN}`, { authorized: false, category: 'authentication_failed' }],
  ['missing bearer credential', TOKEN, 'Bearer', { authorized: false, category: 'authentication_failed' }],
  ['extra credential', TOKEN, `Bearer ${TOKEN} extra`, { authorized: false, category: 'authentication_failed' }],
  ['correct credential', TOKEN, `Bearer ${TOKEN}`, { authorized: true }],
  ['minimum 32-byte credential', 'x'.repeat(32), `Bearer ${'x'.repeat(32)}`, { authorized: true }],
  ['minimum UTF-8 byte length', 'å'.repeat(16), `Bearer ${'å'.repeat(16)}`, { authorized: true }],
  ['existing case/whitespace acceptance', TOKEN, `bEaReR\t${TOKEN}`, { authorized: true }],
] as const) {
  test(`factory: ${name}`, () => {
    const result: TestBridgeAuthenticationResult = authenticateTestBridgeRequest(header, { [TEST_BRIDGE_TOKEN_ENV]: configured });
    assert.deepEqual(result, expected);
    if (result.authorized === false) {
      assert.deepEqual(Object.keys(result).sort(), ['authorized', 'category']);
    } else {
      assert.equal('category' in result, false);
    }
  });
}
for (const enabled of [undefined, '', 'false', '0', '1', 'yes']) {
  test(`middleware: disabled value ${String(enabled)} rejects before authentication`, () => {
    const result = runMiddleware(enabled, undefined, `Bearer ${TOKEN}`);
    assert.equal(result.status, 404);
    assert.equal(result.authCalls, 0);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.logs.length, 0);
  });
}
for (const enabled of ['true', ' TRUE ', 'True']) {
  test(`middleware: existing enablement spelling ${enabled} allows only correct credential`, () => {
    const result = runMiddleware(enabled, TOKEN, `Bearer ${TOKEN}`);
    assert.equal(result.authCalls, 1);
    assert.equal(result.nextCalls, 1);
    assert.equal(result.status, undefined);
    assert.equal(result.payload, undefined);
    assert.equal(result.logs.length, 0);
  });
}
for (const configured of [undefined, '', 'x'.repeat(31)]) {
  test(`middleware: invalid configuration length ${configured?.length ?? 'missing'} is unavailable`, () => {
    const result = runMiddleware('true', configured, `Bearer ${TOKEN}`);
    assert.equal(result.status, 503);
    assert.equal(result.nextCalls, 0);
    assert.deepEqual(result.payload, { schemaVersion: 'odinlink-test-bridge-v1', status: 'unavailable', category: 'authentication_configuration_error' });
    assert.deepEqual(result.logs, [['[TestBridge]', { event: 'test_bridge_auth_configuration_error' }]]);
  });
}
for (const header of [undefined, '', '0', 'false', 'Bearer 0', 'Bearer false', TOKEN, `Basic ${TOKEN}`, `Bearer ${WRONG}`, `Bearer ${TOKEN} extra`]) {
  test(`middleware: missing/malformed/wrong credential case ${String(header).slice(0, 8)} cannot call next`, () => {
    const result = runMiddleware('true', TOKEN, header);
    assert.equal(result.status, 401);
    assert.equal(result.authCalls, 1);
    assert.equal(result.nextCalls, 0);
    assert.deepEqual(result.payload, { schemaVersion: 'odinlink-test-bridge-v1', status: 'unauthorized', category: 'authentication_failed' });
    assert.deepEqual(result.logs, [['[TestBridge]', { event: 'test_bridge_auth_rejected' }]]);
  });
}

test('actual token comparison uses two SHA-256 digests and timingSafeEqual only for valid bearer syntax/configuration', () => {
  const security = ts.createSourceFile('security.ts', readFileSync(new URL('./test-bridge-security.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const compareLengths: number[][] = [];
  const context = vm.createContext({
    Buffer, process: { env: {} }, TEST_BRIDGE_TOKEN_ENV, MINIMUM_TEST_BRIDGE_TOKEN_BYTES: 32,
    BEARER_TOKEN: /^Bearer\s+([^\s]+)$/i,
    crypto: { createHash: crypto.createHash, timingSafeEqual(a: Buffer, b: Buffer) {
      compareLengths.push([a.length, b.length]); return crypto.timingSafeEqual(a, b);
    } },
  });
  vm.runInContext(ts.transpileModule(extract(security, ['sha256', 'authenticateTestBridgeRequest']), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const authenticate: typeof authenticateTestBridgeRequest = vm.runInContext('authenticateTestBridgeRequest', context);
  const env = { [TEST_BRIDGE_TOKEN_ENV]: TOKEN };
  assert.equal(authenticate(undefined, env).authorized, false);
  assert.equal(authenticate(`Bearer ${TOKEN}`, {}).authorized, false);
  assert.equal(compareLengths.length, 0);
  assert.equal(authenticate(`Bearer ${WRONG}`, env).authorized, false);
  assert.equal(authenticate(`Bearer ${TOKEN}`, env).authorized, true);
  assert.deepEqual(compareLengths, [[32, 32], [32, 32]]);
});
