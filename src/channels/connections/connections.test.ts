import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decryptCredential, encryptCredential } from './credential-crypto';
import { buildAuthorizationUrl, PROVIDER_SCOPES, refreshInstagramCredential, verifyProviderCredential } from './providers';
import { disconnectConnection, resolveConnectionByIdentity, resolveConnectionForBusiness } from './repository';
import { AUTHORIZATION_TTL_MS, authorizationCookie, hashAuthorizationValue, parseCookie, randomAuthorizationValue } from './security';
import { consumeAuthorizationSession } from './api-router';

process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.INSTAGRAM_APP_ID = '123456';
process.env.META_APP_ID = '987654';
process.env.PUBLIC_BASE_URL = 'https://app.example';

function fakeReadClient(rows: any[]) {
  return {
    from(table: string) {
      assert.equal(table, 'channel_connections');
      const filters: Array<(row: any) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        maybeSingle: async () => {
          const found = rows.filter((row) => filters.every((filter) => filter(row)));
          return found.length > 1 ? { data: null, error: new Error('multiple_rows') } : { data: found[0] || null, error: null };
        },
      };
      return builder;
    },
  } as any;
}

function fakeMutableClient(rows: any[]) {
  return {
    from(table: string) {
      assert.equal(table, 'channel_connections');
      const filters: Array<(row: any) => boolean> = [];
      let patch: any = null;
      const builder: any = {
        update: (value: any) => { patch = value; return builder; },
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return builder; },
        select: async () => {
          const matching = rows.filter((row) => filters.every((filter) => filter(row)));
          for (const item of matching) Object.assign(item, patch);
          return { data: matching.map((item) => ({ id: item.id })), error: null };
        },
      };
      return builder;
    },
  } as any;
}

function row(input: { id: string; businessId: number; provider: string; accountId: string; token: string; status?: string }) {
  return {
    id: input.id,
    business_id: input.businessId,
    provider: input.provider,
    provider_account_id: input.accountId,
    provider_connection_id: null,
    credential_ciphertext: encryptCredential({ accessToken: input.token }),
    token_expires_at: null,
    granted_scopes: [],
    status: input.status || 'connected',
    connected_at: '2026-09-22T00:00:00Z',
    last_verified_at: '2026-09-22T00:00:00Z',
    reconnect_required: false,
    metadata: {},
    source: 'self_service',
  };
}

test('credential envelopes are authenticated and never contain the plaintext token', () => {
  const encrypted = encryptCredential({ accessToken: 'secret-A', refreshToken: 'refresh-A' });
  assert.doesNotMatch(encrypted, /secret-A|refresh-A/);
  assert.deepEqual(decryptCredential(encrypted), { accessToken: 'secret-A', refreshToken: 'refresh-A' });
  assert.throws(() => decryptCredential(`${encrypted.slice(0, -1)}x`));
});

test('authorization state is high entropy, hashed at rest, and cookie-bound', () => {
  const state = randomAuthorizationValue();
  assert.ok(state.length >= 40);
  assert.notEqual(hashAuthorizationValue(state), state);
  const cookie = authorizationCookie(state, AUTHORIZATION_TTL_MS / 1000);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(parseCookie(cookie, 'odinlink_channel_auth'), state);
});

test('authorization callback consumes the exact state, browser nonce, provider, and redirect only once', async () => {
  let consumed = false;
  const client = {
    rpc: async (_name: string, params: any) => {
      assert.equal(params.p_state_hash, hashAuthorizationValue('state-A'));
      assert.equal(params.p_browser_nonce_hash, hashAuthorizationValue('browser-A'));
      assert.equal(params.p_provider, 'instagram');
      if (consumed) return { data: [], error: null };
      consumed = true;
      return { data: [{
        business_id: 101,
        user_id: 'user-A',
        provider: 'instagram',
        redirect_uri: 'https://app.example/api/channel-connections/instagram/callback',
      }], error: null };
    },
  } as any;
  const session = await consumeAuthorizationSession(client, 'state-A', 'browser-A', 'instagram');
  assert.equal(session.business_id, 101);
  await assert.rejects(() => consumeAuthorizationSession(client, 'state-A', 'browser-A', 'instagram'), /authorization_state_invalid/);
});

test('official Instagram and Messenger authorization URLs keep state and least-privilege messaging scopes', () => {
  const instagram = new URL(buildAuthorizationUrl('instagram', 'state-value', 'https://app.example/api/channel-connections/instagram/callback'));
  assert.equal(instagram.origin, 'https://www.instagram.com');
  assert.equal(instagram.searchParams.get('state'), 'state-value');
  assert.equal(instagram.searchParams.get('force_reauth'), 'true');
  assert.deepEqual(instagram.searchParams.get('scope')?.split(','), PROVIDER_SCOPES.instagram);
  const messenger = new URL(buildAuthorizationUrl('messenger', 'state-value', 'https://app.example/api/channel-connections/messenger/callback'));
  assert.equal(messenger.origin, 'https://www.facebook.com');
  assert.equal(messenger.searchParams.get('state'), 'state-value');
  assert.deepEqual(messenger.searchParams.get('scope')?.split(','), [
    'pages_show_list', 'pages_messaging', 'pages_manage_metadata',
  ]);
  assert.deepEqual(PROVIDER_SCOPES.messenger, [
    'pages_show_list', 'pages_messaging', 'pages_manage_metadata',
  ]);
});

test('provider health distinguishes revoked credentials, temporary failures, and refresh success', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190 } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(await verifyProviderCredential({
      provider: 'instagram', providerAccountId: 'ig-A', accessToken: 'revoked-token',
    }), 'authorization_invalid');

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 2 } }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(await verifyProviderCredential({
      provider: 'messenger', providerAccountId: 'page-A', accessToken: 'valid-token',
    }), 'provider_unavailable');

    globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: 'refreshed-token', expires_in: 5_183_944,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const refreshed = await refreshInstagramCredential('old-token');
    assert.equal(refreshed.accessToken, 'refreshed-token');
    assert.ok(refreshed.expiresAt && Date.parse(refreshed.expiresAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('two businesses resolve only their own inbound identity and outbound credential on every channel', async () => {
  for (const provider of ['instagram', 'messenger', 'whatsapp', 'telegram'] as const) {
    const client = fakeReadClient([
      row({ id: `${provider}-a`, businessId: 101, provider, accountId: `${provider}-A`, token: `${provider}-token-A` }),
      row({ id: `${provider}-b`, businessId: 202, provider, accountId: `${provider}-B`, token: `${provider}-token-B` }),
    ]);
    const inboundA = await resolveConnectionByIdentity(client, provider, `${provider}-A`);
    const inboundB = await resolveConnectionByIdentity(client, provider, `${provider}-B`);
    assert.equal(inboundA?.businessId, 101);
    assert.equal(inboundA?.credential.accessToken, `${provider}-token-A`);
    assert.equal(inboundB?.businessId, 202);
    assert.equal(inboundB?.credential.accessToken, `${provider}-token-B`);
    const outboundA = await resolveConnectionForBusiness(client, 101, provider);
    assert.equal(outboundA?.providerAccountId, `${provider}-A`);
    assert.equal(outboundA?.credential.accessToken, `${provider}-token-A`);
    assert.equal(await resolveConnectionByIdentity(client, provider, `${provider}-missing`), null);
  }
});

test('disconnected credentials are not eligible for inbound or outbound routing', async () => {
  const client = fakeReadClient([
    row({ id: 'a', businessId: 101, provider: 'whatsapp', accountId: 'phone-A', token: 'token-A', status: 'disconnected' }),
  ]);
  assert.equal(await resolveConnectionByIdentity(client, 'whatsapp', 'phone-A'), null);
  assert.equal(await resolveConnectionForBusiness(client, 101, 'whatsapp'), null);
});

test('disconnect deactivates only the requested business and provider', async () => {
  const rows = [
    row({ id: 'a', businessId: 101, provider: 'messenger', accountId: 'page-A', token: 'token-A' }),
    row({ id: 'b', businessId: 202, provider: 'messenger', accountId: 'page-B', token: 'token-B' }),
  ];
  assert.equal(await disconnectConnection(fakeMutableClient(rows), 101, 'messenger'), true);
  assert.equal(rows[0].status, 'disconnected');
  assert.equal(rows[1].status, 'connected');
});

test('migration enforces tenant uniqueness, RLS, service-role-only access, and single-use authorization', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/20260922160109_create_channel_connections.sql', import.meta.url), 'utf8');
  assert.match(sql, /unique \(business_id, provider\)/i);
  assert.match(sql, /references public\.businesses\(id\) on delete cascade/i);
  assert.match(sql, /unique index channel_connections_active_provider_identity_key/i);
  assert.match(sql, /alter table public\.channel_connections enable row level security/i);
  assert.match(sql, /revoke all on table public\.channel_connections from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.channel_connections to service_role/i);
  assert.match(sql, /session\.consumed_at is null/i);
  assert.match(sql, /session\.expires_at > now\(\)/i);
  assert.match(sql, /session\.browser_nonce_hash = p_browser_nonce_hash/i);
  assert.match(sql, /bind_telegram_channel_authorization_session/i);
  assert.match(sql, /session\.provider_user_id is null or session\.provider_user_id = p_provider_user_id/i);
  assert.match(sql, /unique index channel_authorization_sessions_active_telegram_user_key/i);
  assert.match(sql, /competing_session\.provider_user_id = p_provider_user_id/i);
  assert.match(sql, /when unique_violation then/i);
});

test('production channel adapters resolve authoritative connections before legacy fallback', () => {
  const server = readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
  assert.match(server, /findBusinessByChannelConnection\('instagram', recipientId\)/);
  assert.match(server, /findBusinessByChannelConnection\('whatsapp', phoneNumberId\)/);
  assert.match(server, /findBusinessByChannelConnection\('messenger', pageId\)/);
  assert.match(server, /hydrateBusinessChannelConfig\([\s\S]*requestedChannel as ChannelProvider/);
  assert.match(server, /handleTelegramConnectionUpdate\(supabase, req\.body\)/);
  assert.match(server, /business_connection_id: businessConfig\.telegramBusinessConnectionId/);
  assert.match(server, /verifyMetaWebhookSignature/);
  assert.match(server, /verifyTelegramWebhookSecret/);
});
