import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleTelegramConnectionUpdate } from './api-router';
import { disconnectConnection, resolveConnectionForBusiness } from './repository';
import { hashAuthorizationValue } from './security';
import { selectTelegramOutboundToken } from './telegram-routing';

process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.TELEGRAM_PLATFORM_BOT_TOKEN = 'platform-token';

type Session = {
  id: string;
  business_id: number;
  user_id: string;
  provider: 'telegram';
  state_hash: string;
  provider_user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

class TelegramClient {
  sessions: Session[] = [];
  memberships = [{ business_id: 101, user_id: 'odin-user', role: 'owner', status: 'active' }];
  connections: any[] = [];

  async rpc(name: string, params: any) {
    assert.equal(name, 'bind_telegram_channel_authorization_session');
    const now = Date.now();
    const competing = this.sessions.some((row) =>
      row.provider_user_id === params.p_provider_user_id && !row.consumed_at && Date.parse(row.expires_at) > now,
    );
    const row = this.sessions.find((candidate) =>
      candidate.state_hash === params.p_state_hash &&
      !candidate.consumed_at &&
      Date.parse(candidate.expires_at) > now &&
      (candidate.provider_user_id === null || candidate.provider_user_id === params.p_provider_user_id) &&
      (!competing || candidate.provider_user_id === params.p_provider_user_id),
    );
    if (!row) return { data: [], error: null };
    row.provider_user_id = params.p_provider_user_id;
    return { data: [{ id: row.id, business_id: row.business_id, user_id: row.user_id }], error: null };
  }

  from(table: string) {
    const rows = table === 'channel_authorization_sessions'
      ? this.sessions
      : table === 'business_memberships'
        ? this.memberships
        : this.connections;
    const filters: Array<(row: any) => boolean> = [];
    let update: any = null;
    let upsert: any = null;
    const matching = () => rows.filter((row) => filters.every((filter) => filter(row)));
    const result = () => {
      const found = matching();
      if (update) found.forEach((row) => Object.assign(row, update));
      return { data: found, error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return builder; },
      is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      gt: (key: string, value: string) => { filters.push((row) => row[key] > value); return builder; },
      order: () => builder,
      limit: async (count: number) => ({ data: matching().slice(0, count), error: null }),
      update: (value: any) => { update = value; return builder; },
      upsert: (value: any) => { upsert = value; return builder; },
      maybeSingle: async () => {
        const found = matching();
        return found.length > 1 ? { data: null, error: new Error('multiple_rows') } : { data: found[0] || null, error: null };
      },
      single: async () => {
        if (!upsert) return { data: matching()[0] || null, error: null };
        const duplicate = this.connections.find((row) =>
          row.provider === upsert.provider && row.status !== 'disconnected' &&
          (row.provider_account_id === upsert.provider_account_id || row.provider_connection_id === upsert.provider_connection_id) &&
          row.business_id !== upsert.business_id,
        );
        if (duplicate) return { data: null, error: Object.assign(new Error('duplicate'), { code: '23505' }) };
        const existing = this.connections.find((row) => row.business_id === upsert.business_id && row.provider === upsert.provider);
        if (existing) Object.assign(existing, upsert);
        else this.connections.push({ id: `connection-${this.connections.length + 1}`, ...upsert });
        return { data: existing || this.connections.at(-1), error: null };
      },
      then: (resolve: (value: any) => void) => Promise.resolve(result()).then(resolve),
    };
    return builder;
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    business_id: 101,
    user_id: 'odin-user',
    provider: 'telegram',
    state_hash: hashAuthorizationValue('state-value-with-enough-entropy'),
    provider_user_id: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function businessConnection(userChatId = '7001', accountId = '8001', connectionId = 'business-connection-1') {
  return {
    update_id: 2,
    business_connection: {
      id: connectionId,
      user_chat_id: Number(userChatId),
      user: { id: Number(accountId), username: 'tenant_business' },
      rights: { can_reply: true, can_read_messages: true },
      is_enabled: true,
    },
  };
}

test('Telegram self-service validates the dedicated business bot and declares every production prerequisite', () => {
  const router = readFileSync(new URL('./api-router.ts', import.meta.url), 'utf8');
  const render = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  assert.match(router, /TELEGRAM_PLATFORM_BOT_TOKEN/);
  assert.match(router, /TELEGRAM_PLATFORM_BOT_USERNAME/);
  assert.match(router, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(router, /telegram_platform_bot_must_be_dedicated/);
  assert.match(router, /\/getMe/);
  assert.match(router, /can_connect_to_business !== true/);
  assert.match(router, /connection\.rights\?\.can_reply !== true/);
  for (const key of ['TELEGRAM_PLATFORM_BOT_TOKEN', 'TELEGRAM_PLATFORM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET']) {
    assert.match(render, new RegExp(`key: ${key}`));
  }
});

test('Telegram authorization binds once, completes for the same user, and routes inbound without returning a token', async () => {
  const client = new TelegramClient();
  client.sessions.push(session());
  const originalFetch = globalThis.fetch;
  const messages: any[] = [];
  try {
    globalThis.fetch = async (_url: any, init?: RequestInit) => {
      messages.push(JSON.parse(String(init?.body || '{}')));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    assert.deepEqual(await handleTelegramConnectionUpdate(client as any, {
      update_id: 1,
      message: { chat: { id: 7001 }, text: '/start ol_state-value-with-enough-entropy' },
    }), { handled: true });
    assert.equal(client.sessions[0].provider_user_id, '7001');

    assert.deepEqual(await handleTelegramConnectionUpdate(client as any, businessConnection()), { handled: true });
    assert.ok(client.sessions[0].consumed_at);
    assert.equal(client.connections.length, 1);
    assert.equal(client.connections[0].business_id, 101);
    assert.equal(client.connections[0].provider_account_id, '8001');
    assert.equal(client.connections[0].provider_connection_id, 'business-connection-1');
    assert.doesNotMatch(client.connections[0].credential_ciphertext, /platform-token/);
    assert.match(messages.at(-1).text, /connected to OdinLink/);

    const inbound = await handleTelegramConnectionUpdate(client as any, {
      update_id: 3,
      business_message: { business_connection_id: 'business-connection-1', chat: { id: 9001 }, text: 'Hello' },
    });
    assert.equal(inbound.handled, false);
    assert.equal(inbound.connectionBusinessId, 101);
    assert.equal(inbound.businessConnectionId, 'business-connection-1');
    assert.equal('token' in inbound, false);
    assert.equal(inbound.translatedUpdate.message.text, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('expired, reused, and wrong-user Telegram authorization sessions cannot complete', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    for (const invalid of [
      session({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      session({ consumed_at: new Date().toISOString() }),
    ]) {
      const client = new TelegramClient();
      client.sessions.push(invalid);
      await handleTelegramConnectionUpdate(client as any, {
        message: { chat: { id: 7001 }, text: '/start ol_state-value-with-enough-entropy' },
      });
      assert.equal(client.sessions[0].provider_user_id, null);
    }

    const wrongUser = new TelegramClient();
    wrongUser.sessions.push(session({ provider_user_id: '7001' }));
    assert.deepEqual(await handleTelegramConnectionUpdate(wrongUser as any, businessConnection('7002')), { handled: true });
    assert.equal(wrongUser.connections.length, 0);
    assert.equal(wrongUser.sessions[0].consumed_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram connection requires reply rights and rejects cross-tenant provider identity reuse', async () => {
  const originalFetch = globalThis.fetch;
  const notices: string[] = [];
  globalThis.fetch = async (_url: any, init?: RequestInit) => {
    notices.push(JSON.parse(String(init?.body || '{}')).text || '');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const missingRights = new TelegramClient();
    missingRights.sessions.push(session({ provider_user_id: '7001' }));
    const update = businessConnection();
    update.business_connection.rights.can_reply = false;
    await handleTelegramConnectionUpdate(missingRights as any, update);
    assert.equal(missingRights.connections.length, 0);
    assert.equal(missingRights.sessions[0].consumed_at, null);
    assert.match(notices.at(-1) || '', /permission to reply/);

    const duplicate = new TelegramClient();
    duplicate.sessions.push(session({ provider_user_id: '7001' }));
    duplicate.connections.push({
      id: 'other', business_id: 202, provider: 'telegram', provider_account_id: '8001',
      provider_connection_id: 'business-connection-other', status: 'connected', reconnect_required: false,
    });
    await handleTelegramConnectionUpdate(duplicate as any, businessConnection());
    assert.equal(duplicate.connections.length, 1);
    assert.equal(duplicate.sessions[0].consumed_at, null);
    assert.match(notices.at(-1) || '', /already connected to another OdinLink business/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram disconnect and reconnect stay business-scoped, and self-service outbound never borrows legacy credentials', async () => {
  const client = new TelegramClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    client.sessions.push(session({ provider_user_id: '7001' }));
    await handleTelegramConnectionUpdate(client as any, businessConnection());
    assert.equal(await disconnectConnection(client as any, 101, 'telegram'), true);
    assert.equal(await resolveConnectionForBusiness(client as any, 101, 'telegram'), null);

    client.sessions.push(session({ id: 'session-2', provider_user_id: '7001' }));
    await handleTelegramConnectionUpdate(client as any, businessConnection());
    const reconnected = await resolveConnectionForBusiness(client as any, 101, 'telegram');
    assert.equal(reconnected?.credential.accessToken, 'platform-token');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(selectTelegramOutboundToken({
    channelConnectionSource: 'self_service', telegramBusinessConnectionId: 'connection', telegramToken: 'tenant-token',
  }, { telegramToken: 'legacy-other-tenant' }), 'tenant-token');
  assert.equal(selectTelegramOutboundToken({
    channelConnectionSource: 'self_service', telegramBusinessConnectionId: 'connection',
  }, { telegramToken: 'legacy-other-tenant' }, { TELEGRAM_BOT_TOKEN: 'environment-other-tenant' } as any), '');
  assert.equal(selectTelegramOutboundToken({}, { telegramToken: 'legacy-token' }), 'legacy-token');
});
