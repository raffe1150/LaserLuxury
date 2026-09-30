import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { generateWithOpenAi } from '../src/ai/providers/openai';
import { runAiProviderRequest } from '../src/ai/reliability';
import { AiRequestQueue } from '../src/ai/request-queue';

// Run separately without the external-network blocker. All HTTP traffic is
// restricted to this ephemeral loopback server; no real API key is needed.
test('real Node fetch + installed OpenAI SDK close the HTTP connection at application deadline and free the queue slot', async t => {
  const previousEnv = { ...process.env };
  const nativeFetch = globalThis.fetch;
  let received = false, connectionClosed!: () => void;
  const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/responses');
    received = true;
    response.on('close', () => { assert.equal(response.writableEnded, false); connectionClosed(); });
    // Send headers and begin a body, then leave it unfinished. Cancellation
    // must stop a real response body read, not merely reject a local timer.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"resp_loopback",');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  process.env.OPENAI_BASE_URL = base; process.env.OPENAI_API_KEY = 'sk-loopback-only';
  t.mock.method(globalThis, 'fetch', (url: any, init: any) => {
    assert.ok(String(url).startsWith(base + '/'), 'no external endpoint is permitted');
    return nativeFetch(url, init);
  });
  t.mock.method(console, 'error', () => {});
  try {
    const queue = new AiRequestQueue(1);
    const result = runAiProviderRequest({ timeoutMs: 250, cancelOnTimeout: true,
      invoke: (_, signal) => queue.run(() => generateWithOpenAi({
        messages: [{ role: 'user', content: 'offline cancellation test' }], model: 'gpt-5.6-luna', signal,
      }), undefined, signal),
    });
    const next = queue.run(async () => 'slot released');
    await assert.rejects(result, (e: any) => e.category === 'TIMEOUT');
    assert.equal(await next, 'slot released');
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('connection not closed')), 1000); timer.unref(); })]);
    assert.equal(received, true);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
