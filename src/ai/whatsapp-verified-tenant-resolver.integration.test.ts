import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.OPENAI_API_KEY = 'synthetic-offline';
process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY = 'accuracy-first-v1';
process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS = '3';

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

function fakeSupabase(businessId: number, expectedAccount: string) {
  const reads: Array<{table: string; filters: Array<[string, unknown]>}> = [];

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query: any = {
      select() { return query; },
      eq(key: string, value: unknown) {
        filters.push([key, value]);
        return query;
      },
      in() { return query; },
      is() { return query; },
      limit() { return query; },
      order() { return query; },
      maybeSingle: async () => {
        reads.push({table, filters: [...filters]});
        if (table !== 'businesses') return {data: null, error: null};
        const matches = filters.some(([key, value]) =>
          key === 'whatsapp_phone_number_id' && value === expectedAccount);
        return {
          data: matches ? {
            ...incidentConfig,
            id: businessId,
            business_id: businessId,
            business_name: 'Offline Tenant ' + businessId,
            whatsapp_phone_number_id: expectedAccount,
            whatsapp_enabled: true,
            whatsapp_access_token: 'synthetic-offline',
          } : null,
          error: null,
        };
      },
      single: async () => ({data:null,error:null}),
      then(resolve: any, reject: any) {
        return query.maybeSingle().then(resolve, reject);
      },
    };
    return query;
  };

  return {client: {from}, reads};
}

for (const businessId of [3, 4]) {
  test('WhatsApp legacy DB resolves tenant ' + businessId + ' without input businessId', async () => {
    const db = fakeSupabase(businessId, '10001');
    boundary.configure({supabaseClient: db.client} as any);
    try {
      const result = await boundary.resolveWhatsAppTenantForTest({}, '10001');
      assert.equal(result.whatsappBusinessScopeVerified, true);
      assert.equal(Number(result.businessConfig.id), businessId);
      assert.ok(db.reads.some(r => r.table === 'businesses' &&
        r.filters.some(([key, value]) =>
          key === 'whatsapp_phone_number_id' && value === '10001')));
    } finally {
      boundary.configure({} as any);
    }
  });
}

test('unknown WhatsApp account cannot inherit tenant identity', async () => {
  const db = fakeSupabase(3, '10001');
  boundary.configure({supabaseClient: db.client} as any);
  try {
    const result = await boundary.resolveWhatsAppTenantForTest({}, 'wrong-account');
    assert.equal(result.whatsappBusinessScopeVerified, false);
  } finally {
    boundary.configure({} as any);
  }
});

for (const businessId of [3, 4]) {
  test('WhatsApp inbound timing for tenant ' + businessId, async (t) => {
    const { nativeKnowledgeTiming } = await import('./knowledge-timing-policy');
    const db = fakeSupabase(businessId, '10001');
    let languageCalls = 0;
    let claims = 0;
    let deliveries = 0;

    const stop = new Error('offline_timing_probe_complete');

    t.mock.method(globalThis, 'fetch', async () => {
      deliveries++;
      throw new Error('Unexpected external fetch');
    });

    boundary.configure({
      supabaseClient: db.client,
      claimOperation: async (params: any) => {
        claims++;
        const now = Date.now();
        return {
          claimed: true,
          keyHash: ('f'.repeat(63) + businessId),
          storageId: 'offline-claim-' + businessId,
          storagePlatform: 'idempotency:whatsapp',
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
      semanticLanguageResolver: async (_text: string, _language: string, businessConfig: any) => {
        languageCalls++;
        const diagnostic = boundary.inspectWhatsAppTimingForTest(
          '10001', 'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?', businessConfig
        );
        console.log('[OfflineWhatsAppTimingProbe]', {
          businessId,
          ...diagnostic,
          timingActive: Boolean(nativeKnowledgeTiming()),
        });
        assert.equal(Boolean(nativeKnowledgeTiming()), businessId === 3,
          'Tenant-specific timing must be active before AI language resolution');
        throw stop;
      },
      postProcess: async () => {},
      incrementUsage: async () => ({allowed:true,count:1,limit:100}),
    } as any);

    try {
      const message = {
        id: 'offline-inbound-' + businessId,
        from: '46700000001',
        type: 'text',
        text: {body:'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?'},
        timestamp: String(Math.floor(Date.now()/1000)),
      };
      try {
        await boundary.whatsappInbound(message, {phone_number_id:'10001'}, {});
      } catch (error) {
        if (error !== stop) throw error;
      }

      assert.equal(claims, 1, 'Exactly one inbound claim');
      assert.equal(languageCalls, 1, 'Real handler must reach language resolution');
      assert.equal(deliveries, businessId === 3 ? 1 : 0,
        'Accuracy-first may attempt one controlled fallback after a simulated AI failure');
      assert.equal(
        db.reads.filter(r => r.table === 'businesses' &&
          r.filters.some(([key,value]) =>
            key === 'whatsapp_phone_number_id' && value === '10001')).length,
        1,
        'Resolve the tenant once'
      );
    } finally {
      boundary.configure({} as any);
    }
  });
}


test('WhatsApp verified DB identity overrides forged initial tenant', async () => {
  const db = fakeSupabase(3, '10001');
  boundary.configure({supabaseClient: db.client} as any);

  try {
    const result = await boundary.resolveWhatsAppTenantForTest({
      id: 4,
      businessId: 4,
      businessRecordId: 4,
      business_id: 4,
      whatsappPhoneNumberId: 'forged-account',
      whatsappAccessToken: 'forged-token',
    }, '10001');

    assert.equal(result.whatsappBusinessScopeVerified, true);
    assert.equal(Number(result.businessConfig.id), 3);
    assert.equal(Number(result.businessConfig.businessId), 3);
    assert.equal(Number(result.businessConfig.businessRecordId), 3);
    assert.equal(Number(result.businessConfig.business_id), 3);
    assert.equal(result.businessConfig.whatsappPhoneNumberId, '10001');
    assert.equal(result.businessConfig.whatsappAccessToken, 'synthetic-offline');
  } finally {
    boundary.configure({} as any);
  }
});


async function selfServiceFixture(
  status: 'connected' | 'disconnected' | 'reconnect_required',
  legacyPhone: string | null,
) {
  const { encryptCredential } = await import('../channels/connections/credential-crypto');

  const account = 'self-service-phone-3';
  const connection = {
    id: 'offline-connection-3',
    business_id: 3,
    provider: 'whatsapp',
    provider_account_id: account,
    provider_connection_id: 'offline-waba-3',
    credential_ciphertext: encryptCredential({
      accessToken: 'verified-self-service-token',
    }),
    status,
    reconnect_required: status === 'reconnect_required',
    granted_scopes: [],
    metadata: {},
    source: 'self_service',
  };

  const business = {
    ...incidentConfig,
    id: 3,
    business_id: 3,
    business_name: 'Verified Self-Service Tenant',
    whatsapp_phone_number_id: legacyPhone,
    whatsapp_enabled: true,
    whatsapp_access_token: 'legacy-token',
  };

  const reads: Array<{
    table: string;
    filters: Array<[string, unknown]>;
  }> = [];

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query: any = {
      select() { return query; },
      eq(key: string, value: unknown) {
        filters.push([key, value]);
        return query;
      },
      maybeSingle: async () => {
        reads.push({ table, filters: [...filters] });

        const matches = (row: Record<string, any>) =>
          filters.every(([key, value]) => row[key] === value);

        const data = table === 'channel_connections'
          ? (matches(connection) ? connection : null)
          : table === 'businesses'
            ? (matches(business) ? business : null)
            : null;

        return { data, error: null };
      },
    };
    return query;
  };

  return { client: { from }, account, reads };
}

test('WhatsApp self-service active connection uses its verified tenant', async () => {
  const previousKey = process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString('base64');

  try {
    const db = await selfServiceFixture('connected', null);
    boundary.configure({ supabaseClient: db.client } as any);

    const result = await boundary.resolveWhatsAppTenantForTest({
      id: 4,
      businessId: 4,
      whatsappAccessToken: 'forged-token',
    }, db.account);

    assert.equal(result.whatsappBusinessScopeVerified, true);
    assert.equal(Number(result.businessConfig.businessId), 3);
    assert.equal(result.businessConfig.channelConnectionSource, 'self_service');
    assert.equal(result.businessConfig.whatsappPhoneNumberId, db.account);
    assert.equal(result.businessConfig.whatsappAccessToken,
      'verified-self-service-token');

    assert.equal(db.reads.filter(r =>
      r.table === 'businesses' &&
      r.filters.some(([key]) => key === 'whatsapp_phone_number_id')
    ).length, 0, 'Active self-service must not fall back to legacy');
  } finally {
    boundary.configure({} as any);
    if (previousKey === undefined)
      delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = previousKey;
  }
});

for (const status of ['disconnected', 'reconnect_required'] as const) {
  test('WhatsApp ' + status + ' self-service must not reactivate via legacy', async () => {
    const previousKey = process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
    process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY =
      Buffer.alloc(32, 7).toString('base64');

    try {
      const db = await selfServiceFixture(status, 'self-service-phone-3');
      boundary.configure({ supabaseClient: db.client } as any);

      const result = await boundary.resolveWhatsAppTenantForTest({
        id: 4,
        businessId: 4,
      }, db.account);

      assert.equal(result.whatsappBusinessScopeVerified, false,
        'Disabled self-service connection must not be restored by legacy lookup');
    } finally {
      boundary.configure({} as any);
      if (previousKey === undefined)
        delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = previousKey;
    }
  });
}


test('WhatsApp inactive provider_connection_id blocks legacy fallback', async () => {
  const account = '10001';
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const q: any = {
      select() { return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      maybeSingle: async () => {
        reads.push(table + ':' + JSON.stringify(filters));
        if (table === 'channel_connections') {
          const isSecondIdentity = filters.some(([k, v]) =>
            k === 'provider_connection_id' && v === account);
          const activeOnly = filters.some(([k]) => k === 'status');
          return {data: isSecondIdentity && !activeOnly
            ? {id:'inactive-connection', status:'disconnected', reconnect_required:false}
            : null, error:null};
        }
        if (table === 'businesses') {
          return {data:{id:3, whatsapp_phone_number_id:account},error:null};
        }
        return {data:null,error:null};
      },
    };
    return q;
  };

  boundary.configure({supabaseClient:{from}} as any);
  try {
    const result = await boundary.resolveWhatsAppTenantForTest({},account);
    assert.equal(result.whatsappBusinessScopeVerified,false);
    assert.equal(reads.some(r => r.startsWith('businesses:')),false,
      'Inactive registered connection must block legacy business lookup');
  } finally {
    boundary.configure({} as any);
  }
});

test('WhatsApp connection registration read failure blocks legacy fallback', async () => {
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const q: any = {
      select() { return q; },
      eq(k: string, v: unknown) { filters.push([k,v]); return q; },
      maybeSingle: async () => {
        reads.push(table + ':' + JSON.stringify(filters));
        if (table === 'channel_connections') {
          const isRegistrationCheck = !filters.some(([k]) => k === 'status');
          return {data:null,error: isRegistrationCheck
            ? {code:'PGRST_TEST', message:'offline registration lookup failure'}
            : null};
        }
        return {data:{id:3,whatsapp_phone_number_id:'10001'},error:null};
      },
    };
    return q;
  };

  boundary.configure({supabaseClient:{from}} as any);
  try {
    const result = await boundary.resolveWhatsAppTenantForTest({},'10001');
    assert.equal(result.whatsappBusinessScopeVerified,false);
    assert.equal(reads.some(r => r.startsWith('businesses:')),false,
      'Registration lookup error must not permit legacy fallback');
  } finally {
    boundary.configure({} as any);
  }
});



test('WhatsApp old legacy number must not bypass a different registered self-service number', async () => {
  const reads: Array<{table:string;filters:Array<[string,unknown]>}> = [];
  const from = (table:string) => {
    const filters:Array<[string,unknown]> = [];
    const q:any = {
      select() { return q; },
      eq(key:string,value:unknown) { filters.push([key,value]); return q; },
      maybeSingle:async () => {
        reads.push({table,filters:[...filters]});
        if (table === 'channel_connections') {
          const businessCheck = filters.some(([key,value]) =>
            key === 'business_id' && value === 3);
          if (businessCheck) return {
            data:{id:'new-number-registration'},error:null
          };
          return {data:null,error:null};
        }
        if (table === 'businesses') return {
          data:{id:3,whatsapp_phone_number_id:'old-number'},error:null
        };
        return {data:null,error:null};
      },
    };
    return q;
  };

  boundary.configure({supabaseClient:{from}} as any);
  try {
    const result = await boundary.resolveWhatsAppTenantForTest({},'old-number');
    assert.equal(result.whatsappBusinessScopeVerified,false,
      'Old legacy number must not be verified when business has a self-service connection');
    assert.ok(reads.some(r => r.table === 'channel_connections' &&
      r.filters.some(([key,value]) => key === 'business_id' && value === 3)),
      'Resolver must check registration by business ID');
  } finally {
    boundary.configure({} as any);
  }
});

test('WhatsApp rejected inbound reuses tenant resolution once', async (t) => {
  const account = 'blocked-phone-3';
  const reads: Array<{table:string;filters:Array<[string,unknown]>}> = [];
  let claims = 0;
  let externalCalls = 0;

  const from = (table:string) => {
    const filters:Array<[string,unknown]> = [];
    const q:any = {
      select() {return q;},
      eq(key:string,value:unknown) {filters.push([key,value]);return q;},
      maybeSingle:async () => {
        reads.push({table,filters:[...filters]});
        if(table === 'channel_connections') {
          const active = filters.some(([key]) => key === 'status');
          const accountMatch = filters.some(([key,value]) =>
            key === 'provider_account_id' && value === account);
          if(!active && accountMatch) return {
            data:{id:'blocked',status:'disconnected',reconnect_required:false},
            error:null
          };
          return {data:null,error:null};
        }
        if(table === 'businesses') throw new Error('Legacy lookup forbidden');
        return {data:null,error:null};
      }
    };
    return q;
  };

  t.mock.method(globalThis,'fetch',async () => {
    externalCalls++;
    throw new Error('Unexpected outbound request');
  });

  boundary.configure({
    supabaseClient:{from},
    claimOperation:async (params:any) => {
      claims++;
      const now = Date.now();
      return {
        claimed:true,
        keyHash:'b'.repeat(64),
        storageId:'blocked-inbound-test',
        storagePlatform:'idempotency:whatsapp',
        state:{
          type:params.type,status:'processing',attempts:1,
          claimedAt:now,updatedAt:now
        }
      };
    },
    settleOperation:async () => true,
  } as any);

  try {
    await boundary.whatsappInbound({
      id:'blocked-inbound-event',
      from:'46700000002',
      type:'text',
      text:{body:'What are your opening hours?'},
      timestamp:String(Math.floor(Date.now()/1000))
    },{phone_number_id:account},{id:4,businessId:4});

    assert.equal(claims,1);
    assert.equal(externalCalls,0);
    assert.equal(reads.filter(r => r.table === 'businesses').length,0);
    const connectionReads = reads.filter(r => r.table === 'channel_connections');
    assert.equal(connectionReads.length, 3,
      'Two active identity checks, followed by one matching inactive registration check');
    assert.deepEqual(
      connectionReads.map(r => [
        r.filters.some(([key]) => key === 'status'),
        r.filters.find(([key]) =>
          key === 'provider_account_id' || key === 'provider_connection_id')?.[0],
      ]),
      [
        [true, 'provider_account_id'],
        [true, 'provider_connection_id'],
        [false, 'provider_account_id'],
      ],
      'Rejected inbound must resolve once and stop at the inactive registration'
    );
  } finally {
    boundary.configure({} as any);
  }
});
