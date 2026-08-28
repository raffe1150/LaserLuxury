import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HealthStatus from '../components/dashboard/HealthStatus';
import {
  HEALTH_CACHE_TTL_MS,
  getIntegrationHealthSnapshot,
  invalidateIntegrationHealthCache,
  refreshIntegrationHealth,
  resetIntegrationHealthCache,
  type IntegrationHealthConfig,
} from './integration-health';

const calendarProbe = async () => ({ status: 'connected' as const, reasonCode: 'verified' as const });
const configured: IntegrationHealthConfig = { telegramToken: '123456789:abcdefghijklmnopqrstuv' };

resetIntegrationHealthCache();
const initial = getIntegrationHealthSnapshot(7, configured, new Date('2026-08-24T10:00:00Z'));
assert.equal(initial.find((item) => item.key === 'telegram')?.status, 'unknown');
assert.equal(initial.find((item) => item.key === 'telegram')?.reasonCode, 'not_yet_checked');
assert.equal(initial.find((item) => item.key === 'instagram')?.status, 'setup_required');
assert.equal(initial.find((item) => item.key === 'google_calendar')?.action, 'complete_setup');

let fetchCalls = 0;
const successFetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const checkedAt = new Date('2026-08-24T10:01:00Z');
const configBefore = structuredClone(configured);
await Promise.all([
  refreshIntegrationHealth({ businessId: 7, integration: 'telegram', config: configured, fetchImpl: successFetch as typeof fetch, calendarProbe, now: () => checkedAt }),
  refreshIntegrationHealth({ businessId: 7, integration: 'telegram', config: configured, fetchImpl: successFetch as typeof fetch, calendarProbe, now: () => checkedAt }),
]);
assert.equal(fetchCalls, 1, 'concurrent refreshes use one provider request');
assert.deepEqual(configured, configBefore, 'health checks never mutate integration configuration');

const connected = getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')!;
assert.equal(connected.status, 'connected');
assert.equal(connected.lastCheckedAt, checkedAt.toISOString());
assert.equal(connected.stale, false);
assert.equal(connected.reasonCode, 'verified');
assert.doesNotMatch(JSON.stringify(connected), /123456789|abcdefghijkl|token|credential/i);

await refreshIntegrationHealth({ businessId: 7, integration: 'telegram', config: configured, fetchImpl: successFetch as typeof fetch, calendarProbe, now: () => checkedAt });
assert.equal(fetchCalls, 1, 'fresh cache suppresses repeat refreshes');
await refreshIntegrationHealth({ businessId: 7, integration: 'telegram', config: configured, fetchImpl: successFetch as typeof fetch, calendarProbe, now: () => checkedAt, force: true });
assert.equal(fetchCalls, 2, 'manual force performs one recheck');

const staleAt = new Date(checkedAt.getTime() + HEALTH_CACHE_TTL_MS);
assert.equal(getIntegrationHealthSnapshot(7, configured, staleAt).find((item) => item.key === 'telegram')?.stale, true);
assert.equal(getIntegrationHealthSnapshot(8, configured, checkedAt).find((item) => item.key === 'telegram')?.status, 'unknown', 'cache is tenant scoped');
invalidateIntegrationHealthCache(7, ['telegram']);
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.status, 'unknown', 'credential saves invalidate only the selected tenant health result');

resetIntegrationHealthCache();
await refreshIntegrationHealth({
  businessId: 7,
  integration: 'telegram',
  config: configured,
  fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch,
  calendarProbe,
  now: () => checkedAt,
});
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.status, 'degraded');
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.reasonCode, 'provider_unavailable');

resetIntegrationHealthCache();
await refreshIntegrationHealth({
  businessId: 7,
  integration: 'telegram',
  config: configured,
  fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
  calendarProbe,
  now: () => checkedAt,
});
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.status, 'disconnected');
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.reasonCode, 'authorization_invalid');

resetIntegrationHealthCache();
await refreshIntegrationHealth({
  businessId: 7,
  integration: 'telegram',
  config: configured,
  fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 190, type: 'OAuthException' } }), { status: 400 })) as typeof fetch,
  calendarProbe,
  now: () => checkedAt,
});
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.status, 'disconnected');

resetIntegrationHealthCache();
const hangingFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
})) as typeof fetch;
await refreshIntegrationHealth({
  businessId: 7,
  integration: 'telegram',
  config: configured,
  fetchImpl: hangingFetch,
  calendarProbe,
  now: () => checkedAt,
  timeoutMs: 5,
});
assert.equal(getIntegrationHealthSnapshot(7, configured, checkedAt).find((item) => item.key === 'telegram')?.reasonCode, 'timeout');

const markup = renderToStaticMarkup(createElement(HealthStatus, { businessId: '7' }));
assert.match(markup, /Integration health/);
assert.match(markup, /Loading integration health/);
assert.match(markup, /Loading health/);

const componentSource = readFileSync(new URL('../components/dashboard/HealthStatus.tsx', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(componentSource, /AbortController/);
assert.match(componentSource, /backgroundStarted\.current\.has/);
assert.match(componentSource, /requestId !== requestGeneration\.current/);
assert.match(componentSource, /setHealth\(\[\]\)/);
assert.match(componentSource, /Check now/);
assert.match(componentSource, /All systems operational/);

const readRoute = serverSource.match(/app\.get\('\/api\/businesses\/:businessId\/integrations\/health'[\s\S]*?\n\}\);/)?.[0] || '';
const refreshRoute = serverSource.match(/app\.post\('\/api\/businesses\/:businessId\/integrations\/health\/refresh'[\s\S]*?\n\}\);/)?.[0] || '';
const configLoader = serverSource.match(/function getHealthCheckConfig[\s\S]*?\n\}/)?.[0] || '';
assert.match(readRoute, /requireBusinessPermission\('business\.read'\)/);
assert.match(refreshRoute, /requireBusinessPermission\('business\.read'\)/);
assert.match(refreshRoute, /loadHealthBusiness\(businessId\)/);
assert.doesNotMatch(`${readRoute}\n${refreshRoute}`, /accessToken:|telegramToken:|privateKey:|provider payload/i);
assert.doesNotMatch(refreshRoute, /\.update\(|\.insert\(|\.delete\(/, 'health refresh is configuration read-only');
assert.doesNotMatch(configLoader, /activeConfig|TELEGRAM_TOKEN|INSTAGRAM_ACCESS_TOKEN|WHATSAPP_ACCESS_TOKEN|MESSENGER_ACCESS_TOKEN/, 'messaging health cannot borrow another/global tenant identity');

console.log('Automatic integration health cache, timeout, isolation, and UX-state tests passed.');
