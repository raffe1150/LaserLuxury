import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
process.env.OPENAI_API_KEY = 'synthetic-offline';
process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY = 'accuracy-first-v1';
process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS = '3';

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const { nativeKnowledgeTiming } = await import('./knowledge-timing-policy');

for (const channel of ['messenger', 'instagram'] as const) {
  test(`${channel}: connection registry DB failure cannot activate forged tenant`, async t => {
    const account = `offline-db-error-${channel}`;
    const reads: Array<{table:string;filters:Array<[string,unknown]>}> = [];
    let languageCalls = 0;
    let claims = 0;
    let externalCalls = 0;

    const from = (table:string) => {
      const filters:Array<[string,unknown]> = [];
      const q:any = {
        select() { return q; },
        eq(key:string,value:unknown) {
          filters.push([key,value]);
          return q;
        },
        maybeSingle:async () => {
          reads.push({table,filters:[...filters]});
          if (table === 'channel_connections') {
            return {data:null,error:new Error('synthetic_registry_read_failure')};
          }
          return {data:null,error:null};
        },
        then(resolve:any,reject:any) {
          reads.push({table,filters:[...filters]});
          return Promise.resolve({data:[],error:null}).then(resolve,reject);
        },
      };
      return q;
    };

    t.mock.method(globalThis,'fetch',async () => {
      externalCalls++;
      throw new Error('External request blocked');
    });

    boundary.configure({
      supabaseClient:{from},
      claimOperation:async (params:any) => {
        claims++;
        const now = Date.now();
        return {
          claimed:true,
          keyHash:'b'.repeat(64),
          storageId:`offline-registry-error-${channel}`,
          storagePlatform:`idempotency:${channel}`,
          state:{
            type:params.type,status:'processing',attempts:1,
            claimedAt:now,updatedAt:now,
          },
        };
      },
      settleOperation:async () => true,
      semanticLanguageResolver:async () => {
        languageCalls++;
        assert.equal(Boolean(nativeKnowledgeTiming()),false,
          'Registry failure must not activate tenant timing');
        throw new Error('Unverified message entered language resolution');
      },
      incrementUsage:async () => ({allowed:true,count:1,limit:100}),
    } as any);

    try {
      const event = {
        sender:{id:`offline-customer-${channel}`},
        recipient:{id:account},
        timestamp:Date.now(),
        message:{
          mid:`offline-db-error-${channel}-event`,
          text:'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
        },
      };

      const forgedConfig = {
        ...incidentConfig,
        id:3,businessId:3,businessRecordId:3,business_id:3,
        messengerPageId:account,
        instagramAccountId:account,
        messengerPageAccessToken:'forged-token',
        instagramAccessToken:'forged-token',
      };

      if (channel === 'messenger') {
        await boundary.messengerInbound(event,forgedConfig);
      } else {
        await boundary.instagramInbound(event,forgedConfig);
      }

      assert.equal(claims,1);
      assert.equal(languageCalls,0,
        'Database failure must stop before language resolution');
      assert.equal(externalCalls,0,
        'Unverified inbound must not send any external message');
      assert.ok(reads.some(r => r.table === 'channel_connections'),
        'Connection registry must have been checked');
    } finally {
      boundary.configure({} as any);
    }
  });
}
