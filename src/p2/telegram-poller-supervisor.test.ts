import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { TelegramPollerLease } from './telegram-poller-lease';
import { TelegramPollerSupervisor, recoverableTelegramLeaseFailure } from './telegram-poller-supervisor';

test('restart frequency is capped, cancellation fences callbacks, and credentials are terminal', async () => {
  const delays: number[] = []; const callbacks: (() => void)[] = [];
  const supervisor = new TelegramPollerSupervisor((work, ms) => { delays.push(ms); callbacks.push(work); return () => {}; });
  let attempts = 0;
  supervisor.activate();
  const retry = async () => { attempts++; supervisor.recover(retry, 0); };
  supervisor.recover(retry, 0);
  for (let i = 0; i < 8; i++) callbacks[i]();
  assert.deepEqual(delays.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 30000, 300000, 1000]);
  supervisor.cancel(); callbacks.at(-1)!(); assert.equal(attempts, 8);
  assert.equal(recoverableTelegramLeaseFailure(new Error('telegram_poller_storage_timeout')), true);
  for (const reason of ['telegram_poller_scope', 'terminal_http_401', 'terminal_http_403', 'telegram_poller_stopped'])
    assert.equal(recoverableTelegramLeaseFailure(new Error(reason)), false);
});

test('disposable PostgreSQL: renewal timeout creates a fresh owner, retries the unacknowledged update, and fences replay', async t => {
  const pg = new DisposableNativeKnowledgeDatabase(); t.after(() => pg.close());
  pg.sql('CREATE TABLE public.synthetic_processed_updates(id bigint PRIMARY KEY);');
  const firstOwner = randomUUID();
  const first = new TelegramPollerLease(pg.db, 77, '123456', firstOwner); t.after(() => first.stop());
  assert.equal(await first.acquire(), true); await first.commit(100);
  const rpc = pg.db.rpc;
  pg.db.rpc = async (name, args) => args.p_command === 'renew' ? new Promise(() => {}) : rpc(name, args);
  let executed = 0;
  await assert.rejects(first.dispose(101, async () => { executed++; return true; }), /storage_timeout/);
  assert.equal(executed, 0);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='123456';"), '100');
  pg.db.rpc = rpc; await first.stop();
  let restart!: () => void; let successor: TelegramPollerLease | undefined;
  const supervisor = new TelegramPollerSupervisor(work => { restart = work; return () => {}; }); t.after(() => supervisor.cancel());
  const done = new Promise<void>((resolve, reject) => supervisor.recover(async () => {
    try {
      successor = new TelegramPollerLease(pg.db, 77, '123456', randomUUID());
      assert.equal(await successor.acquire(), true); assert.equal(successor.nextOffset, 101);
      const processOnce = async () => {
        const inserted = pg.sql('INSERT INTO public.synthetic_processed_updates VALUES(101) ON CONFLICT DO NOTHING RETURNING id;');
        if (inserted) executed++;
        return true;
      };
      await successor.dispose(101, processOnce);
      // Provider redelivery reaches the same durable idempotency boundary.
      await successor.dispose(101, processOnce);
      assert.equal(executed, 1);
      assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='123456';"), '101');
      assert.notEqual(pg.sql("SELECT owner FROM public.odin_telegram_pollers WHERE bot_id='123456';"), firstOwner);
      await assert.rejects(first.acquire(), /stopped/); await assert.rejects(first.commit(102), /stopped/);
      resolve();
    } catch (error) { reject(error); }
  }, 0));
  t.after(async () => { await successor?.stop(); }); restart(); await done;
});

test('uncertain commit retries through durable idempotency without acknowledging an unfinished update', async t => {
  const pg = new DisposableNativeKnowledgeDatabase(); t.after(() => pg.close());
  pg.sql('CREATE TABLE public.synthetic_idempotent_effects(id bigint PRIMARY KEY);');
  const first = new TelegramPollerLease(pg.db, 77, '654321', randomUUID()); t.after(() => first.stop());
  await first.acquire(); await first.commit(200);
  let effects = 0;
  const handler = async () => {
    if (pg.sql('INSERT INTO public.synthetic_idempotent_effects VALUES(201) ON CONFLICT DO NOTHING RETURNING id;')) effects++;
    return true;
  };
  const rpc = pg.db.rpc;
  pg.db.rpc = async (name, args) => args.p_command === 'commit' ? new Promise(() => {}) : rpc(name, args);
  await assert.rejects(first.dispose(201, handler), /storage_timeout/);
  assert.equal(effects, 1);
  assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='654321';"), '200');
  pg.db.rpc = rpc; await first.stop();
  const successor = new TelegramPollerLease(pg.db, 77, '654321', randomUUID()); t.after(() => successor.stop());
  await successor.acquire(); assert.equal(successor.nextOffset, 201);
  await successor.dispose(201, handler); assert.equal(effects, 1);
  assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='654321';"), '201');
});

test('a rejected lease transport is classified as recoverable storage unavailability', async () => {
  const lease = new TelegramPollerLease({ rpc: () => Promise.reject(new TypeError('synthetic network failure')) } as any, 77, '123456', randomUUID());
  await assert.rejects(lease.acquire(), /telegram_poller_storage_unavailable/);
  assert.equal(lease.controller.signal.aborted, true);
  assert.equal(recoverableTelegramLeaseFailure(lease.controller.signal.reason), true);
});
