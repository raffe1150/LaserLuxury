import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
process.env.OPENAI_API_KEY = 'synthetic-offline';
process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY = 'accuracy-first-v1';
process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS = '3';

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const { nativeKnowledgeTiming } = await import('./knowledge-timing-policy');
const { encryptCredential } = await import('../channels/connections/credential-crypto');

for (const channel of ['messenger', 'instagram'] as const) {
  test(`${channel}: active self-service verifies tenant before timing`, async t => {
    const previousKey = process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
    process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

    const account = `offline-active-${channel}-3`;
    const token = `verified-${channel}-token`;
    const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    let claims = 0;
    let languageCalls = 0;
    let externalCalls = 0;
    const stop = new Error('offline_active_self_service_stop');

    const connection = {
      id: `offline-connection-${channel}-3`,
      business_id: 3,
      provider: channel,
      provider_account_id: account,
      provider_connection_id: `offline-provider-${channel}-3`,
      credential_ciphertext: encryptCredential({ accessToken: token }),
      status: 'connected',
      reconnect_required: false,
      granted_scopes: [],
      metadata: {},
      source: 'self_service',
    };

    const business = {
      ...incidentConfig,
      id: 3,
      business_id: 3,
      business_name: 'Verified Active Self-Service Tenant',
      messenger_page_id: null,
      instagram_account_id: null,
      messenger_enabled: true,
      instagram_enabled: true,
    };

    const from = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        select() { return q; },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return q;
        },
        maybeSingle: async () => {
          reads.push({ table, filters: [...filters] });
          const row = table === 'channel_connections'
            ? connection
            : table === 'businesses'
              ? business
              : null;
          return {
            data: row && filters.every(([key, value]) => (row as any)[key] === value)
              ? row
              : null,
            error: null,
          };
        },
        then(resolve: any, reject: any) {
          reads.push({ table, filters: [...filters] });
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return q;
    };

    t.mock.method(globalThis, 'fetch', async () => {
      externalCalls++;
      throw new Error('External request blocked');
    });

    try {
      boundary.configure({
        supabaseClient: { from },
        claimOperation: async (params: any) => {
          claims++;
          const now = Date.now();
          return {
            claimed: true,
            keyHash: 'a'.repeat(64),
            storageId: `offline-active-${channel}`,
            storagePlatform: `idempotency:${channel}`,
            state: {
              type: params.type,
              status: 'processing',
              attempts: 1,
              claimedAt: now,
              updatedAt: now,
            },
          };
        },
        settleOperation: async () => true,
        semanticLanguageResolver: async () => {
          languageCalls++;
          assert.equal(Boolean(nativeKnowledgeTiming()), true,
            'Verified tenant 3 must activate accuracy-first before language detection');
          throw stop;
        },
        incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      } as any);

      const event = {
        sender: { id: `offline-customer-${channel}` },
        recipient: { id: account },
        timestamp: Date.now(),
        message: {
          mid: `offline-active-${channel}-event`,
          text: 'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
        },
      };

      const forgedConfig = {
        id: 4,
        businessId: 4,
        businessRecordId: 4,
        messengerPageId: 'forged-messenger-page',
        instagramAccountId: 'forged-instagram-account',
        messengerPageAccessToken: 'forged-token',
        instagramAccessToken: 'forged-token',
      };

      try {
        if (channel === 'messenger') {
          await boundary.messengerInbound(event, forgedConfig);
        } else {
          await boundary.instagramInbound(event, forgedConfig);
        }
      } catch (error) {
        if (error !== stop) throw error;
      }

      assert.equal(claims, 1);
      assert.equal(languageCalls, 1,
        'Active verified connection must reach language resolution');

      assert.ok(reads.some(r =>
        r.table === 'channel_connections' &&
        r.filters.some(([k, v]) => k === 'provider_account_id' && v === account) &&
        r.filters.some(([k, v]) => k === 'status' && v === 'connected')
      ), 'Active connection must be resolved by provider identity');

      assert.ok(reads.some(r =>
        r.table === 'businesses' &&
        r.filters.some(([k, v]) => k === 'id' && v === 3)
      ), 'Business must be loaded by verified tenant ID');

      assert.equal(reads.filter(r =>
        r.table === 'businesses' &&
        r.filters.some(([k]) =>
          ['messenger_page_id', 'instagram_account_id'].includes(k))
      ).length, 0, 'Active connection must not use legacy identity lookup');

      assert.ok(externalCalls <= 1,
        'Only the blocked accuracy-first fallback transport is permitted');

    } finally {
      boundary.configure({} as any);
      if (previousKey === undefined) {
        delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
      } else {
        process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = previousKey;
      }
    }
  });
}
