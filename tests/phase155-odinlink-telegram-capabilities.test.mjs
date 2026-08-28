import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.resolve('server.ts');
const source = fs.readFileSync(serverPath, 'utf8');

test('Phase 15.5 exposes the Telegram capabilities endpoint', () => {
  assert.equal(
    source.includes("'/api/test/telegram-capabilities'") ||
      source.includes('"/api/test/telegram-capabilities"'),
    true
  );
});

test('Phase 15.5 reports Telegram configuration without returning a token', () => {
  assert.equal(source.includes('telegramConfigured'), true);
  assert.equal(source.includes('webhookManagedByOdinLink'), true);
  assert.equal(source.includes('webhookRegistered'), true);
  assert.equal(source.includes('webhookUrl'), true);

  const routeStart = source.indexOf('/api/test/telegram-capabilities');
  const routeSlice = source.slice(routeStart, routeStart + 1800);

  assert.equal(routeSlice.includes('TELEGRAM_TOKEN:'), false);
  assert.equal(routeSlice.includes('TELEGRAM_BOT_TOKEN:'), false);
  assert.equal(routeSlice.includes('token:'), false);
});

test('Phase 15.5 recognizes both supported Telegram environment variable names', () => {
  assert.equal(source.includes('process.env.TELEGRAM_TOKEN'), true);
  assert.equal(source.includes('process.env.TELEGRAM_BOT_TOKEN'), true);
});

test('Phase 15.5 marks OdinLink as webhook owner', () => {
  const routeStart = source.indexOf('/api/test/telegram-capabilities');
  const routeSlice = source.slice(routeStart, routeStart + 1800);

  assert.match(
    routeSlice,
    /webhookManagedByOdinLink\s*:\s*true/
  );
});

test('Phase 15.5 keeps the capability response non-secret and deterministic', () => {
  const routeStart = source.indexOf('/api/test/telegram-capabilities');
  const routeSlice = source.slice(routeStart, routeStart + 1800);

  assert.match(routeSlice, /telegramConfigured\s*:/);
  assert.match(routeSlice, /liveEnabled\s*:/);
  assert.match(routeSlice, /webhookRegistered\s*:/);
});
