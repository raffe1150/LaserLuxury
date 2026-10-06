export type MetaFailure = { http_status: number | null; provider_code: number | null;
  kind: 'permission' | 'rate_limit' | 'failed' | 'uncertain'; retry_after_ms: number };
export type MetaResult = { ok: true; data: any } | { ok: false; error: MetaFailure };

// Never exposes provider messages, request URLs, response examples or credentials.
// Reads and creation deliberately share redirect, timeout and pagination safety.
export function createWhatsAppMetaClient(input: { accessToken: string; graphVersion: string; fetchImpl?: typeof fetch }) {
  if (!/^v\d+\.\d+$/u.test(input.graphVersion)) throw new Error('meta_version_invalid');
  const request = async (path: string, params: Record<string, string>, body?: unknown): Promise<MetaResult> => {
    const url = new URL(`https://graph.facebook.com/${input.graphVersion}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await (input.fetchImpl || fetch)(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${input.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const data = await response.json().catch(() => null);
      if (response.ok && data && !data.error) return { ok: true, data };
      const code = Number.isSafeInteger(data?.error?.code) ? data.error.code as number : null;
      const rateLimited = response.status === 429 || [4, 17, 32, 613, 80007].includes(code || 0);
      const denied = response.status === 401 || response.status === 403 || [10, 190, 200, 294].includes(code || 0);
      const retrySeconds = Number(response.headers.get('Retry-After'));
      return { ok: false, error: { http_status: response.status, provider_code: code,
        kind: response.status >= 500 || response.ok || !data?.error ? 'uncertain' : rateLimited ? 'rate_limit' : denied ? 'permission' : 'failed',
        retry_after_ms: Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(retrySeconds * 1000, 86_400_000) : 60_000 } };
    } catch { return { ok: false, error: { http_status: null, provider_code: null, kind: 'uncertain', retry_after_ms: 60_000 } }; }
  };
  const read = async (path: string, params: Record<string, string> = {}): Promise<any | null> => {
    const result = await request(path, params);
    return result.ok ? result.data : null;
  };
  const list = async (path: string, params: Record<string, string> = {}): Promise<any[] | null> => {
    const rows: any[] = [], seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = await read(path, { ...params, limit: '100', ...(after ? { after } : {}) });
      if (!body || !Array.isArray(body.data)) return null;
      rows.push(...body.data);
      if (!body.paging?.next) return rows;
      const cursor = body.paging?.cursors?.after;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) return null;
      seen.add(cursor); after = cursor; // Never follow a paging URL, even on the same origin.
    }
    return null;
  };
  return { read, list, createTemplate: (wabaId: string, body: unknown) => {
    if (!/^\d+$/u.test(wabaId)) throw new Error('meta_asset_invalid');
    return request(`${wabaId}/message_templates`, {}, body);
  } };
}
