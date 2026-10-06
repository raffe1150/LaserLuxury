import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

export type LeadRow = {
  id: number;
  user_id: string;
  platform: string;
  business_id: string | null;
  ai_summary: string | null;
};

// Exercise the installed PostgREST client, including its cardinality handling.
// Every request is intercepted here; no database or external service is contacted.
export class PendingLeadStore {
  constructor(private readonly otherRequest?: (url: URL, init?: RequestInit) => Promise<Response>) {}
  rows: LeadRow[] = [];
  requests: Array<{ method: string; url: URL; body: any }> = [];
  readError: { code: string; message: string; details?: string } | null = null;
  private sequence = 100;
  readonly client = createClient('https://pending-lead.invalid', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'pending-lead.invalid');
      const method = init?.method || 'GET';
      if (url.pathname !== '/rest/v1/appointments_leads') {
        if (this.otherRequest) return this.otherRequest(url, init);
        assert.equal(method, 'GET', 'only lead writes are allowed in this fixture');
        assert.ok(['/rest/v1/appointments', '/rest/v1/chat_history'].includes(url.pathname));
        return new Response('[]', { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      this.requests.push({ method, url, body });
      if (method === 'GET' && this.readError) {
        return new Response(JSON.stringify(this.readError), { status: 400 });
      }
      const matches = (row: LeadRow) => {
        for (const [key, value] of url.searchParams) {
          if (value.startsWith('eq.') && String(row[key as keyof LeadRow]) !== value.slice(3)) return false;
          if (value === 'is.null' && row[key as keyof LeadRow] != null) return false;
        }
        const or = url.searchParams.get('or');
        if (or) {
          const match = or.match(/^\(business_id\.eq\.([1-9][0-9]*),business_id\.is\.null\)$/);
          assert.ok(match, `unsupported test filter: ${or}`);
          if (row.business_id != null && String(row.business_id) !== match[1]) return false;
        }
        return true;
      };
      if (method === 'POST') {
        for (const row of Array.isArray(body) ? body : [body]) {
          this.rows.push({ id: ++this.sequence, business_id: null, ai_summary: null, ...row });
        }
        return new Response(null, { status: 201 });
      }
      let selected = this.rows.filter(matches);
      const limit = url.searchParams.get('limit');
      if (limit) selected = selected.slice(0, Number(limit));
      if (method === 'PATCH') {
        selected.forEach(row => Object.assign(row, body));
        if (!url.searchParams.has('select')) return new Response(null, { status: 204 });
      }
      assert.ok(method === 'GET' || method === 'PATCH');
      const columns = url.searchParams.get('select');
      const data = selected.map(row => columns && columns !== '*'
        ? Object.fromEntries(columns.split(',').map(key => [key, row[key as keyof LeadRow]]))
        : row);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });

  from(table: string) { return this.client.from(table); }
}
