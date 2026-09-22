import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import { createMetaComplianceRouter, processMetaComplianceRequest, verifyMetaSignedRequest } from './meta-compliance';
import { validMetaWebhookSignature } from './meta-webhook-security';

process.env.META_APP_SECRET = 'facebook-test-secret';
process.env.INSTAGRAM_APP_SECRET = 'instagram-test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.example';

function signed(provider: 'messenger' | 'instagram', userId: string, issuedAt = Math.floor(Date.now() / 1000)) {
  const secret = provider === 'messenger' ? process.env.META_APP_SECRET! : process.env.INSTAGRAM_APP_SECRET!;
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: userId, issued_at: issuedAt })).toString('base64url');
  return `${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}.${payload}`;
}

function fakeClient() {
  const connections: any[] = [
    { id: 'page-A', business_id: 101, provider: 'messenger', provider_account_id: 'page-1',
      connected_at: '2026-01-01T00:00:00Z', status: 'connected', metadata: { authorizing_meta_user_id: '111' } },
    { id: 'page-B', business_id: 202, provider: 'messenger', provider_account_id: 'page-2',
      connected_at: '2026-01-01T00:00:00Z', status: 'connected', metadata: { authorizing_meta_user_id: '222' } },
    { id: 'ig-A', business_id: 101, provider: 'instagram', provider_account_id: '333',
      connected_at: '2026-01-01T00:00:00Z', status: 'connected', metadata: {} },
    { id: 'ig-B', business_id: 202, provider: 'instagram', provider_account_id: '444',
      connected_at: '2026-01-01T00:00:00Z', status: 'connected', metadata: {} },
  ];
  const requests: any[] = [];
  const client = {
    from(table: string) {
      const rows = table === 'channel_connections' ? connections : requests;
      let patch: any;
      let inserted: any;
      const filters: Array<(row: any) => boolean> = [];
      const matching = () => rows.filter((row) => filters.every((filter) => filter(row)));
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: any) => { filters.push((row) => row[key] === value); return builder; },
        neq: (key: string, value: any) => { filters.push((row) => row[key] !== value); return builder; },
        lte: (key: string, value: string) => { filters.push((row) => row[key] <= value); return builder; },
        contains: (key: string, value: any) => {
          filters.push((row) => Object.entries(value).every(([field, expected]) => row[key]?.[field] === expected));
          return builder;
        },
        update: (value: any) => { patch = value; return builder; },
        upsert: async (value: any) => {
          inserted = value;
          if (!requests.some((row) => row.provider === inserted.provider && row.request_type === inserted.request_type &&
            row.request_fingerprint === inserted.request_fingerprint)) {
            requests.push({ ...inserted, status: 'pending_review', received_at: '2026-09-23T00:00:00Z' });
          }
          return { error: null };
        },
        maybeSingle: async () => ({ data: matching()[0] || null, error: null }),
        then(resolve: any) {
          const found = matching();
          if (patch) for (const row of found) Object.assign(row, patch);
          return Promise.resolve(resolve({ data: found, error: null }));
        },
      };
      return builder;
    },
  } as any;
  return { client, connections, requests };
}

test('signed request accepts only the correct app secret, user identity, and algorithm', () => {
  const value = signed('messenger', '111');
  assert.equal(verifyMetaSignedRequest(value, process.env.META_APP_SECRET!).userId, '111');
  assert.throws(() => verifyMetaSignedRequest(value, process.env.INSTAGRAM_APP_SECRET!), /invalid_signed_request/);
  assert.throws(() => verifyMetaSignedRequest(`${value.slice(0, 8)}x${value.slice(9)}`, process.env.META_APP_SECRET!), /invalid_signed_request/);
  assert.throws(() => verifyMetaSignedRequest(signed('messenger', '111', Math.floor(Date.now() / 1000) + 3600), process.env.META_APP_SECRET!), /invalid_signed_request/);
});

test('missing Instagram app secret cannot authenticate a signed callback', async () => {
  const value = signed('instagram', '333');
  const saved = process.env.INSTAGRAM_APP_SECRET;
  try {
    delete process.env.INSTAGRAM_APP_SECRET;
    await assert.rejects(() => processMetaComplianceRequest(fakeClient().client, {
      provider: 'instagram', requestType: 'data_deletion', signedRequest: value,
    }), /invalid_signed_request/);
  } finally {
    process.env.INSTAGRAM_APP_SECRET = saved;
  }
});

test('Meta webhook signatures fail closed on missing secret, wrong app secret, or body tampering', () => {
  const body = Buffer.from('{"object":"instagram"}');
  const signature = `sha256=${crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET!).update(body).digest('hex')}`;
  assert.equal(validMetaWebhookSignature(body, signature, process.env.INSTAGRAM_APP_SECRET!), true);
  assert.equal(validMetaWebhookSignature(body, signature, process.env.META_APP_SECRET!), false);
  assert.equal(validMetaWebhookSignature(Buffer.from('{"object":"page"}'), signature, process.env.INSTAGRAM_APP_SECRET!), false);
  assert.equal(validMetaWebhookSignature(body, signature, ''), false);
  assert.equal(validMetaWebhookSignature(body, '', process.env.INSTAGRAM_APP_SECRET!), false);
});

test('deauthorization is exact, idempotent, and preserves other businesses and channels', async () => {
  const { client, connections, requests } = fakeClient();
  const input = { provider: 'messenger' as const, requestType: 'deauthorization' as const, signedRequest: signed('messenger', '111') };
  const first = await processMetaComplianceRequest(client, input);
  assert.deepEqual(first.matchedConnectionIds, ['page-A']);
  assert.equal(connections[0].status, 'disconnected');
  assert.equal(connections[1].status, 'connected');
  assert.equal(connections[2].status, 'connected');
  assert.equal(requests[0].status, 'deactivated');
  await processMetaComplianceRequest(client, input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'deactivated');
  assert.equal(connections[1].status, 'connected');

  await processMetaComplianceRequest(client, {
    provider: 'instagram', requestType: 'deauthorization', signedRequest: signed('instagram', '333'),
  });
  assert.equal(connections[2].status, 'disconnected');
  assert.equal(connections[3].status, 'connected');
});

test('unmapped or newly reconnected Messenger account is never deactivated from old request', async () => {
  const { client, connections, requests } = fakeClient();
  connections[0].metadata = {};
  await processMetaComplianceRequest(client, {
    provider: 'messenger', requestType: 'deauthorization', signedRequest: signed('messenger', '111'),
  });
  assert.equal(connections[0].status, 'connected');
  assert.equal(requests[0].status, 'pending_review');
  connections[0].metadata = { authorizing_meta_user_id: '111' };
  connections[0].connected_at = '2099-01-01T00:00:00Z';
  await processMetaComplianceRequest(client, {
    provider: 'messenger', requestType: 'deauthorization', signedRequest: signed('messenger', '111'),
  });
  assert.equal(connections[0].status, 'connected');
});

test('data deletion intake and status are stable across duplicate delivery and process restart', async () => {
  const { client, connections, requests } = fakeClient();
  const app = express();
  app.use(express.json());
  app.use('/api/meta', createMetaComplianceRouter(client));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const input = new URLSearchParams({ signed_request: signed('messenger', '111') });
    const post = () => fetch(`${base}/api/meta/messenger/data-deletion`, { method: 'POST', body: input });
    const first = await post();
    assert.equal(first.status, 200);
    const result = await first.json() as any;
    assert.match(result.url, /^https:\/\/app\.example\/api\/meta\/data-deletion\/status\/[a-f0-9]{64}$/);
    assert.equal(result.confirmation_code.length, 64);
    const duplicate = await post();
    assert.deepEqual(await duplicate.json(), result);
    assert.equal(requests.length, 1);
    const status = await fetch(result.url.replace('https://app.example', base));
    assert.equal((await status.json() as any).status, 'pending_review');
    assert.equal(connections[0].status, 'connected'); // No automatic business-wide deletion.
    requests[0].status = 'completed';
    requests[0].completed_at = '2026-09-23T12:00:00Z';
    assert.deepEqual(await (await post()).json(), result);
    assert.equal(requests[0].status, 'completed');
    const invalid = await fetch(`${base}/api/meta/messenger/data-deletion`, {
      method: 'POST', body: new URLSearchParams({ signed_request: signed('instagram', '333') }),
    });
    assert.equal(invalid.status, 401);
    assert.equal(requests.length, 1);
  } finally {
    server.close();
  }
});

test('deauthorization HTTP callback rejects foreign signatures and repeats safely', async () => {
  const { client, connections, requests } = fakeClient();
  const app = express();
  app.use('/api/meta', createMetaComplianceRouter(client));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/meta/messenger/deauthorize`;
    const send = (value: string) => fetch(url, {
      method: 'POST', body: new URLSearchParams({ signed_request: value }),
    });
    assert.equal((await send(signed('instagram', '333'))).status, 401);
    assert.equal(connections[0].status, 'connected');
    const value = signed('messenger', '111');
    assert.equal((await send(value)).status, 200);
    assert.equal((await send(value)).status, 200);
    assert.equal(requests.length, 1);
    assert.equal(connections[0].status, 'disconnected');
    assert.equal(connections[1].status, 'connected');
    assert.equal(connections[2].status, 'connected');
  } finally {
    server.close();
  }
});

test('compliance migration is backend-only with durable idempotent intake', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/20260922221958_meta_compliance_requests.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table public\.meta_compliance_requests/i);
  assert.match(sql, /unique \(provider, request_type, request_fingerprint\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.meta_compliance_requests from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on table public\.meta_compliance_requests to service_role/i);
  const server = readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
  assert.match(server, /app\.use\('\/api\/meta', createMetaComplianceRouter\(supabase\)\)/);
  assert.match(server, /if \(!secret\) return res\.sendStatus\(503\)/);
  assert.match(server, /req\.path === '\/webhook\/instagram'/);
});
