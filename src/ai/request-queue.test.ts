import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AiRequestQueue } from './request-queue';
import { AiReliabilityError, runAiProviderRequest } from './reliability';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('deadline removes a waiting request: abandoned work never executes and FIFO survivors run', async () => {
  const queue = new AiRequestQueue(1);
  const release = deferred(), started = deferred();
  const blocker = queue.run(async () => { started.resolve(); await release.promise; });
  await started.promise;
  let abandoned = 0;
  await assert.rejects(runAiProviderRequest({ timeoutMs: 20, cancelOnTimeout: true,
    invoke: (_, signal) => queue.run(async () => { abandoned++; }, undefined, signal),
  }), (e: any) => e.category === 'TIMEOUT');
  const order: number[] = [];
  const survivors = [1, 2].map(id => queue.run(async () => { order.push(id); }));
  release.resolve();
  await Promise.all([blocker, ...survivors]);
  assert.equal(abandoned, 0);
  assert.deepEqual(order, [1, 2]);
});

test('running abort releases its slot when transport rejects; TIMEOUT wins and is not retried', async () => {
  const queue = new AiRequestQueue(1);
  const started = deferred();
  let attempts = 0, aborted = false;
  const running = runAiProviderRequest({ timeoutMs: 20, cancelOnTimeout: true,
    invoke: (_, signal) => queue.run(() => new Promise<void>((_, reject) => {
      attempts++; started.resolve();
      signal!.addEventListener('abort', () => { aborted = true; reject(new Error('network abort')); }, { once: true });
    }), undefined, signal),
  });
  await started.promise;
  const survivor = queue.run(async () => 'next');
  await assert.rejects(running, (e: any) => e.category === 'TIMEOUT');
  assert.equal(await survivor, 'next');
  assert.equal(attempts, 1);
  assert.equal(aborted, true);
});

test('late non-cooperative completion cannot convert timeout into success or release a still-running slot', async () => {
  const queue = new AiRequestQueue(1);
  const release = deferred();
  let next = false;
  const result = runAiProviderRequest({ timeoutMs: 15, cancelOnTimeout: true,
    invoke: (_, signal) => queue.run(async () => { await release.promise; return 'late'; }, undefined, signal),
  });
  await assert.rejects(result, (e: any) => e.category === 'TIMEOUT');
  const survivor = queue.run(async () => { next = true; });
  await delay(0);
  assert.equal(next, false, 'no premature release for a non-cooperative provider');
  release.resolve();
  await survivor;
  await assert.rejects(result, (e: any) => e.category === 'TIMEOUT');
});

test('admission reserves the slot across microtasks; cancellation after admission prevents job execution', async () => {
  const queue = new AiRequestQueue(1);
  const controller = new AbortController();
  let abandoned = 0, active = 0, maxActive = 0;
  const cancelled = queue.run(async () => { abandoned++; }, undefined, controller.signal);
  controller.abort(new AiReliabilityError('TIMEOUT', 'test deadline'));
  await assert.rejects(cancelled, (e: any) => e.category === 'TIMEOUT');
  await Promise.all(Array.from({ length: 8 }, () => queue.run(async () => {
    active++; maxActive = Math.max(maxActive, active); await delay(1); active--;
  })));
  assert.equal(abandoned, 0);
  assert.equal(maxActive, 1);
});

test('retryable failure receives a fresh signal per attempt; successful and default non-cancellable requests remain unchanged', async () => {
  const signals: AbortSignal[] = [];
  assert.equal(await runAiProviderRequest({ timeoutMs: 100, cancelOnTimeout: true,
    invoke: async (_, signal) => { signals.push(signal!); if (signals.length === 1) throw new Error('503 unavailable'); return 'ok'; },
  }), 'ok');
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(signals.every(s => !s.aborted));
  assert.equal(await runAiProviderRequest({ timeoutMs: 100, invoke: async (_, signal) => { assert.equal(signal, undefined); return 'unchanged'; } }), 'unchanged');
});
