import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixtureChannelSessionId } from './fixtures/channel-session';

test('Meta/WhatsApp fixtures keep their exact helper result and business/user arguments', () => {
  for (const channel of ['instagram', 'messenger', 'whatsapp'] as const) {
    const business = { id: '7' };
    let calls = 0;
    const boundary = { channelSessionId: (...args: [typeof channel, string, typeof business]) => {
      calls++; assert.deepEqual(args, [channel, 'customer', business]); return 'unchanged-helper-result';
    } };
    assert.equal(fixtureChannelSessionId(boundary, channel, 'customer', business), 'unchanged-helper-result');
    assert.equal(calls, 1);
  }
});

test('Telegram fixtures use tg scope and never invoke the Meta helper', () => {
  const boundary = { channelSessionId: () => { throw new Error('Telegram must not enter the Meta session helper'); } };
  const id = fixtureChannelSessionId(boundary, 'telegram', 'customer', { id: '7' });
  assert.equal(id, 'tg:7:missing:customer');
  assert.doesNotMatch(id, /^(ig_|ms_|wa_)/);
  assert.notEqual(id, fixtureChannelSessionId(boundary, 'telegram', 'customer', { id: '8' }));
  assert.notEqual(id, fixtureChannelSessionId(boundary, 'telegram', 'other-customer', { id: '7' }));
});

test('Telegram bot fingerprint is normalized, isolated and never exposes a token', () => {
  const boundary = { channelSessionId: () => { throw new Error('unexpected Meta helper'); } };
  const token = 'synthetic-bot-token';
  const id = fixtureChannelSessionId(boundary, 'telegram', '42', { id: 7, telegramToken: ` ${token}\r\n` });
  assert.equal(id, `tg:7:${createHash('sha256').update(token).digest('hex').slice(0, 12)}:42`);
  assert.doesNotMatch(id, new RegExp(token));
  assert.notEqual(id, fixtureChannelSessionId(boundary, 'telegram', '42', { id: 7, telegramToken: 'other-bot-token' }));
});
