import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_BUSINESS_TONE_CONFIG } from '../ai/tone-controls';
import {
  api,
  normalizeBusiness,
  toBackendBusinessPayload,
} from '../services/api';
import {
  applyBusinessToneConfigUpdate,
  BUSINESS_TONE_UPDATE_KEYS,
} from './business-tone-update';

const testConfig = {
  ...DEFAULT_BUSINESS_TONE_CONFIG,
  tonePreset: 'warm' as const,
  responseLength: 'short' as const,
  emojiUsage: 'light' as const,
};

assert.equal(BUSINESS_TONE_UPDATE_KEYS[0], 'ai_tone_config');

const serialized = toBackendBusinessPayload({ toneConfig: testConfig });
assert.deepEqual(serialized, { ai_tone_config: testConfig });

const databaseUpdate: Record<string, unknown> = {};
assert.deepEqual(
  applyBusinessToneConfigUpdate(serialized, databaseUpdate),
  testConfig,
);
assert.deepEqual(databaseUpdate, { ai_tone_config: testConfig });

for (const alias of BUSINESS_TONE_UPDATE_KEYS) {
  const payload: Record<string, unknown> = {};
  applyBusinessToneConfigUpdate({ [alias]: testConfig }, payload);
  assert.deepEqual(payload.ai_tone_config, testConfig);
}

assert.throws(
  () => applyBusinessToneConfigUpdate({
    ai_tone_config: { ...testConfig, tonePreset: 'unsafe' },
  }, {}),
  /tonePreset must be one of/,
);
assert.throws(
  () => applyBusinessToneConfigUpdate({
    ai_tone_config: {
      ...testConfig,
      tonePreset: 'custom',
      customToneInstructions: 'x'.repeat(501),
    },
  }, {}),
  /must not exceed 500/,
);

// Simulate the route's database response and a later fresh GET/reload.
const storedRow = {
  id: 42,
  business_name: 'Designated fixture',
  ai_tone_config: databaseUpdate.ai_tone_config,
};
const updateResponse = normalizeBusiness({ success: true, data: storedRow });
const freshRead = normalizeBusiness(JSON.parse(JSON.stringify(storedRow)));
assert.deepEqual(updateResponse.toneConfig, testConfig);
assert.deepEqual(freshRead.toneConfig, testConfig);
assert.equal(freshRead.id, '42');

const originalFetch = globalThis.fetch;
let capturedRequest: { url: string; method?: string; body?: string } | null = null;
globalThis.fetch = async (input, init) => {
  capturedRequest = {
    url: String(input),
    method: init?.method,
    body: typeof init?.body === 'string' ? init.body : undefined,
  };
  return new Response(JSON.stringify({ success: true, data: storedRow }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
try {
  const apiResult = await api.updateBusiness('42', { toneConfig: testConfig });
  assert.equal(capturedRequest?.url, '/api/businesses/42');
  assert.equal(capturedRequest?.method, 'PUT');
  assert.deepEqual(JSON.parse(capturedRequest?.body || '{}'), {
    ai_tone_config: testConfig,
  });
  assert.deepEqual(apiResult.toneConfig, testConfig);
} finally {
  globalThis.fetch = originalFetch;
}

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(
  server,
  /app\.put\('\/api\/businesses\/:id', requireAuth, requireBusinessPermission\('settings\.manage'\)/,
  'the canonical update remains authenticated and tenant-scoped',
);
assert.match(server, /applyBusinessToneConfigUpdate\(body, payload\)/);

console.log('Business Tone canonical update, validation, authorization wiring, and fresh-read tests passed.');
