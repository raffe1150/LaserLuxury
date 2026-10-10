// Canonical runner for the browser API contract; no real session, env file or network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = mkdtempSync(resolve(tmpdir(), 'odinlink-tone-contract-'));
const browserAuthFile = resolve(root, 'src/auth/supabase-browser.ts');
const originalFetch = globalThis.fetch;
let server;

try {
  // The contract supplies its own fetch response. Any other network use must fail.
  globalThis.fetch = async () => { throw new Error('Network is unavailable in the business-tone fixture'); };
  server = await createServer({
    root,
    configFile: false,
    mode: 'test',
    envDir: fixtureDirectory,
    envPrefix: 'ODINLINK_TONE_TEST_',
    cacheDir: resolve(fixtureDirectory, 'cache'),
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [{
      name: 'business-tone-fixture-auth',
      enforce: 'pre',
      load(id) {
        if (id !== browserAuthFile) return;
        return `
          let sessionReads = 0;
          export async function getCurrentAccessToken() { sessionReads++; return null; }
          export function getFixtureSessionReads() { return sessionReads; }
          export function getBrowserSupabaseClient() { throw new Error('No real browser auth client in this fixture'); }
        `;
      },
    }],
  });
  await server.ssrLoadModule('/src/business/business-tone-update.test.ts');
  const auth = await server.ssrLoadModule('/src/auth/supabase-browser.ts');
  assert.equal(auth.getFixtureSessionReads(), 1, 'the existing API request still consults its auth boundary once');
} finally {
  globalThis.fetch = originalFetch;
  await server?.close();
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
