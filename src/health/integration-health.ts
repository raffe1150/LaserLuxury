import type { IntegrationHealth, IntegrationKey } from '../types/dashboard';

export const HEALTH_CACHE_TTL_MS = 5 * 60_000;
export const HEALTH_CHECK_TIMEOUT_MS = 6_000;

export interface IntegrationHealthConfig {
  telegramToken?: string;
  instagramAccessToken?: string;
  messengerPageId?: string;
  messengerAccessToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  calendarId?: string;
  googleClientEmail?: string;
  googlePrivateKey?: string;
}

type CachedHealth = {
  status: 'connected' | 'degraded' | 'disconnected';
  checkedAt: string;
  reasonCode: IntegrationHealth['reasonCode'];
};

type ProbeResult = Pick<CachedHealth, 'status' | 'reasonCode'>;
type FetchLike = typeof fetch;
type CalendarProbe = (config: IntegrationHealthConfig) => Promise<ProbeResult>;

const labels: Record<IntegrationKey, string> = {
  instagram: 'Instagram',
  messenger: 'Facebook Messenger',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  google_calendar: 'Google Calendar',
};
const integrations: IntegrationKey[] = ['instagram', 'messenger', 'telegram', 'whatsapp', 'google_calendar'];
const cache = new Map<string, CachedHealth>();
const inFlight = new Map<string, Promise<CachedHealth>>();

function cacheKey(businessId: number, integration: IntegrationKey) {
  return `${businessId}:${integration}`;
}

export function isIntegrationConfigured(integration: IntegrationKey, config: IntegrationHealthConfig): boolean {
  if (integration === 'telegram') return Boolean(config.telegramToken);
  if (integration === 'instagram') return Boolean(config.instagramAccessToken);
  if (integration === 'messenger') return Boolean(config.messengerPageId && config.messengerAccessToken);
  if (integration === 'whatsapp') return Boolean(config.whatsappPhoneNumberId && config.whatsappAccessToken);
  return Boolean(config.calendarId && config.googleClientEmail && config.googlePrivateKey);
}

function setupDetail(integration: IntegrationKey): string {
  if (integration === 'google_calendar') return 'Connect a calendar to enable booking sync.';
  return `Complete ${labels[integration]} setup to enable this channel.`;
}

function detailFor(status: IntegrationHealth['status'], integration: IntegrationKey): string {
  if (status === 'connected') return integration === 'google_calendar' ? 'Calendar is configured and reachable.' : 'Connection verified.';
  if (status === 'degraded') return 'The provider could not be reached reliably.';
  if (status === 'disconnected') return 'Authorization is invalid or has expired.';
  if (status === 'checking') return 'Checking connection…';
  if (status === 'unknown') return 'Configured, awaiting verification.';
  return setupDetail(integration);
}

export function getIntegrationHealthSnapshot(
  businessId: number,
  config: IntegrationHealthConfig,
  now = new Date(),
): IntegrationHealth[] {
  return integrations.map((integration) => {
    const configured = isIntegrationConfigured(integration, config);
    if (!configured) {
      return {
        key: integration,
        label: labels[integration],
        status: 'setup_required',
        detail: setupDetail(integration),
        lastCheckedAt: null,
        stale: false,
        refreshInProgress: false,
        reasonCode: 'not_configured',
        action: 'complete_setup',
      };
    }

    const key = cacheKey(businessId, integration);
    const cached = cache.get(key);
    const refreshing = inFlight.has(key);
    if (!cached) {
      return {
        key: integration,
        label: labels[integration],
        status: refreshing ? 'checking' : 'unknown',
        detail: detailFor(refreshing ? 'checking' : 'unknown', integration),
        lastCheckedAt: null,
        stale: true,
        refreshInProgress: refreshing,
        reasonCode: refreshing ? 'check_in_progress' : 'not_yet_checked',
        action: 'check_now',
      };
    }

    const stale = now.getTime() - Date.parse(cached.checkedAt) >= HEALTH_CACHE_TTL_MS;
    return {
      key: integration,
      label: labels[integration],
      status: cached.status,
      detail: detailFor(cached.status, integration),
      lastCheckedAt: cached.checkedAt,
      stale,
      refreshInProgress: refreshing,
      reasonCode: cached.reasonCode,
      action: cached.status === 'disconnected' ? 'reconnect' : cached.status === 'degraded' ? 'retry' : 'check_now',
    };
  });
}

async function fetchJson(url: URL | string, fetchImpl: FetchLike, signal: AbortSignal): Promise<{ response: Response; data: any }> {
  const response = await fetchImpl(url, { signal });
  const data = await response.json().catch(() => null);
  return { response, data };
}

function fromHttp(response: Response, data?: any): ProbeResult {
  const providerCode = Number(data?.error?.code);
  const providerType = String(data?.error?.type || '');
  if (
    response.status === 401 ||
    response.status === 403 ||
    providerCode === 190 ||
    /oauth/i.test(providerType)
  ) {
    return { status: 'disconnected', reasonCode: 'authorization_invalid' };
  }
  return { status: 'degraded', reasonCode: response.status === 429 ? 'rate_limited' : 'provider_unavailable' };
}

async function probe(
  integration: IntegrationKey,
  config: IntegrationHealthConfig,
  fetchImpl: FetchLike,
  calendarProbe: CalendarProbe,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (integration === 'google_calendar') return calendarProbe(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (integration === 'telegram') {
      const { response, data } = await fetchJson(`https://api.telegram.org/bot${config.telegramToken}/getMe`, fetchImpl, controller.signal);
      return response.ok && data?.ok !== false ? { status: 'connected', reasonCode: 'verified' } : fromHttp(response, data);
    }
    if (integration === 'instagram') {
      const url = new URL('https://graph.instagram.com/v25.0/me');
      url.searchParams.set('fields', 'id');
      url.searchParams.set('access_token', config.instagramAccessToken || '');
      const { response, data } = await fetchJson(url, fetchImpl, controller.signal);
      return response.ok && !data?.error ? { status: 'connected', reasonCode: 'verified' } : fromHttp(response, data);
    }
    const identifier = integration === 'messenger' ? config.messengerPageId : config.whatsappPhoneNumberId;
    const token = integration === 'messenger' ? config.messengerAccessToken : config.whatsappAccessToken;
    const url = new URL(`https://graph.facebook.com/v22.0/${encodeURIComponent(identifier || '')}`);
    url.searchParams.set('fields', 'id');
    url.searchParams.set('access_token', token || '');
    const { response, data } = await fetchJson(url, fetchImpl, controller.signal);
    return response.ok && !data?.error ? { status: 'connected', reasonCode: 'verified' } : fromHttp(response, data);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { status: 'degraded', reasonCode: 'timeout' };
    return { status: 'degraded', reasonCode: 'provider_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshIntegrationHealth(options: {
  businessId: number;
  integration: IntegrationKey;
  config: IntegrationHealthConfig;
  fetchImpl?: FetchLike;
  calendarProbe: CalendarProbe;
  now?: () => Date;
  force?: boolean;
  timeoutMs?: number;
}): Promise<CachedHealth> {
  const { businessId, integration, config } = options;
  if (!isIntegrationConfigured(integration, config)) {
    return { status: 'disconnected', checkedAt: (options.now || (() => new Date()))().toISOString(), reasonCode: 'not_configured' };
  }
  const key = cacheKey(businessId, integration);
  const existingFlight = inFlight.get(key);
  if (existingFlight) return existingFlight;
  const cached = cache.get(key);
  const now = options.now || (() => new Date());
  if (!options.force && cached && now().getTime() - Date.parse(cached.checkedAt) < HEALTH_CACHE_TTL_MS) return cached;

  const operation = (async () => {
    const result = await probe(
      integration,
      config,
      options.fetchImpl || fetch,
      options.calendarProbe,
      options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS,
    );
    const record: CachedHealth = { ...result, checkedAt: now().toISOString() };
    if (cache.size >= 5_000) cache.delete(cache.keys().next().value as string);
    cache.set(key, record);
    return record;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}

/** @internal Focused-test reset only. */
export function resetIntegrationHealthCache() {
  cache.clear();
  inFlight.clear();
}

export function invalidateIntegrationHealthCache(
  businessId: number,
  integrations: readonly IntegrationKey[],
) {
  for (const integration of integrations) {
    const key = cacheKey(businessId, integration);
    cache.delete(key);
    inFlight.delete(key);
  }
}
