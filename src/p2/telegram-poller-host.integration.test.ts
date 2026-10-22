import test from 'node:test';
import assert from 'node:assert/strict';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { TelegramPollerLease } from './telegram-poller-lease';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.ODINLINK_ASYNC_KNOWLEDGE_ADMISSION = 'false'; process.env.ODINLINK_ASYNC_KNOWLEDGE_PROCESSING = 'false';
process.env.ODINLINK_ASYNC_KNOWLEDGE_DELIVERY = 'false'; process.env.ODINLINK_SMART_WAITING = 'false';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

test('real server poll loop replaces a timed-out owner and retries the persisted offset with async Knowledge OFF', async t => {
  const pg = new DisposableNativeKnowledgeDatabase(); t.after(() => pg.close());
  const seed = new TelegramPollerLease(pg.db, 77, '123456', randomUUID());
  await seed.acquire(); await seed.commit(100); await seed.stop();
  pg.sql('CREATE TABLE public.synthetic_handled_updates(id bigint PRIMARY KEY);');
  const rpc = pg.db.rpc; let renews = 0, handled = 0;
  pg.db.rpc = async (name, args) => {
    if (args.p_command === 'renew' && ++renews === 3) return new Promise(() => {});
    return rpc(name, args);
  };
  const offsets: number[] = []; let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = String(input); assert.ok(url.startsWith('https://api.telegram.org/bot123456:synthetic-offline/'));
    const response = (result: any) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (url.endsWith('/getMe')) return response({ id: 123456, is_bot: true, username: 'synthetic_bot' });
    if (url.endsWith('/deleteWebhook')) return response(true);
    if (url.endsWith('/getWebhookInfo')) return response({ url: '', pending_update_count: 1 });
    assert.ok(url.endsWith('/getUpdates'), 'no outbound customer messages');
    offsets.push(JSON.parse(String(options?.body)).offset);
    if (offsets.length <= 2) return response([{ update_id: 101, message: { text: 'synthetic test' } }]);
    completed();
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('test_poll_cancelled')), { once: true }));
  });
  b.configure({ supabaseClient: pg.db, telegramPollerUpdate: async update => {
    const inserted = pg.sql(`INSERT INTO public.synthetic_handled_updates VALUES(${Number(update.update_id)}) ON CONFLICT DO NOTHING RETURNING id;`);
    if (inserted) handled++; return true;
  } });
  t.after(async () => { await b.stopTelegramPollers(); b.reset(); });
  const config = { id: 77, businessId: 77, telegramBusinessResolved: true, telegramToken: '123456:synthetic-offline' };
  await b.startTelegramPoller(config);
  const owner = b.telegramPollerSnapshot(config.telegramToken)!.instanceId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('automatic recovery did not occur')), 12_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  assert.deepEqual(offsets, [101, 101, 102]); assert.equal(handled, 1);
  const successor = b.telegramPollerSnapshot(config.telegramToken)!;
  assert.notEqual(successor.instanceId, owner); assert.equal(successor.lastUpdateId, 101);
  assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='123456';"), '101');
});

test('server poller does not supervise invalid credentials back into a restart loop', async t => {
  const pg = new DisposableNativeKnowledgeDatabase(); t.after(() => pg.close());
  let starts = 0;
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  t.mock.method(globalThis, 'fetch', async () => { starts++; return new Response(JSON.stringify({ ok: false }), { status: 401 }); });
  b.configure({ supabaseClient: pg.db });
  t.after(async () => { await b.stopTelegramPollers(); b.reset(); });
  await b.startTelegramPoller({ id: 77, businessId: 77, telegramBusinessResolved: true, telegramToken: '222222:synthetic-offline' });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(starts, 1); assert.equal(b.telegramPollerSnapshot('222222:synthetic-offline')?.isPolling, false);
});
