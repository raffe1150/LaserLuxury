import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
process.env.OPENAI_API_KEY = 'synthetic-offline';
process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY = 'accuracy-first-v1';
process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS = '3';

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const { nativeKnowledgeTiming } = await import('./knowledge-timing-policy');

test('Messenger DB-verified tenant 3 activates timing before language resolution', async t => {
  const account = 'offline-messenger-page-3';
  const reads: Array<{table:string; filters:Array<[string,unknown]>}> = [];
  const business = {
    ...incidentConfig,
    id: 3,
    business_id: 3,
    messenger_page_id: account,
    messenger_enabled: true,
    messenger_page_access_token: 'synthetic-offline',
  };

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
        return {data:null,error:null};
      },
      then(resolve:any,reject:any) {
        reads.push({table,filters:[...filters]});
        return Promise.resolve({
          data:table === 'businesses' ? [business] : [],
          error:null,
        }).then(resolve,reject);
      },
    };
    return q;
  };

  let claims = 0;
  let languageCalls = 0;
  let externalCalls = 0;
  const stop = new Error('offline_messenger_probe_stop');

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
        keyHash:'c'.repeat(64),
        storageId:'offline-messenger-claim',
        storagePlatform:'idempotency:messenger',
        state:{
          type:params.type,status:'processing',attempts:1,
          claimedAt:now,updatedAt:now,
        },
      };
    },
    settleOperation:async () => true,
    semanticLanguageResolver:async () => {
      languageCalls++;
      assert.equal(Boolean(nativeKnowledgeTiming()),true,
        'Verified tenant 3 must activate accuracy-first before language resolution');
      throw stop;
    },
    incrementUsage:async () => ({allowed:true,count:1,limit:100}),
  } as any);

  try {
    const event = {
      sender:{id:'offline-messenger-customer'},
      recipient:{id:account},
      timestamp:Date.now(),
      message:{
        mid:'offline-messenger-timing-3',
        text:'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
      },
    };

    try {
      await boundary.messengerInbound(event,{
        id:4,businessId:4,businessRecordId:4,
        messengerPageId:'forged-page',
      });
    } catch (error) {
      if (error !== stop) throw error;
    }

    assert.equal(claims,1);
    assert.equal(languageCalls,1);
    assert.ok(reads.some(r => r.table === 'businesses'),
      'Handler must resolve business from mock DB');
    assert.ok(externalCalls <= 1,
      'Only blocked offline fallback transport is permitted');
  } finally {
    boundary.configure({} as any);
  }
});

test('Messenger DB-verified tenant 4 cannot inherit tenant 3 timing', async t => {
  const account = 'offline-messenger-page-4';
  const reads: Array<{table:string; filters:Array<[string,unknown]>}> = [];
  const business = {
    ...incidentConfig,
    id: 4,
    business_id: 4,
    messenger_page_id: account,
    messenger_enabled: true,
    messenger_page_access_token: 'synthetic-offline',
  };

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
        return {data:null,error:null};
      },
      then(resolve:any,reject:any) {
        reads.push({table,filters:[...filters]});
        return Promise.resolve({
          data:table === 'businesses' ? [business] : [],
          error:null,
        }).then(resolve,reject);
      },
    };
    return q;
  };

  let claims = 0;
  let languageCalls = 0;
  let externalCalls = 0;
  const stop = new Error('offline_messenger_probe_stop');

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
        keyHash:'c'.repeat(64),
        storageId:'offline-messenger-claim',
        storagePlatform:'idempotency:messenger',
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
        'Tenant 4 must not inherit tenant 3 accuracy-first policy');
      throw stop;
    },
    incrementUsage:async () => ({allowed:true,count:1,limit:100}),
  } as any);

  try {
    const event = {
      sender:{id:'offline-messenger-customer'},
      recipient:{id:account},
      timestamp:Date.now(),
      message:{
        mid:'offline-messenger-timing-4',
        text:'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
      },
    };

    try {
      await boundary.messengerInbound(event,{
        id:3,businessId:3,businessRecordId:3,
        messengerPageId:'forged-page',
      });
    } catch (error) {
      if (error !== stop) throw error;
    }

    assert.equal(claims,1);
    assert.equal(languageCalls,1);
    assert.ok(reads.some(r => r.table === 'businesses'),
      'Handler must resolve business from mock DB');
    assert.ok(externalCalls <= 1,
      'Only blocked offline fallback transport is permitted');
  } finally {
    boundary.configure({} as any);
  }
});


for (const status of ['disconnected', 'reconnect_required'] as const) {
  test('Messenger inactive self-service registration blocks legacy fallback: ' + status, async t => {
    const account = 'offline-messenger-inactive-' + status;
    const reads: Array<{table:string;filters:Array<[string,unknown]>}> = [];
    let claims = 0;
    let outbound = 0;

    const from = (table:string) => {
      const filters:Array<[string,unknown]> = [];
      const q:any = {
        select() { return q; },
        eq(key:string,value:unknown) { filters.push([key,value]); return q; },
        maybeSingle:async () => {
          reads.push({table,filters:[...filters]});
          if (table === 'channel_connections') {
            const active = filters.some(([key]) => key === 'status');
            const match = filters.some(([key,value]) =>
              key === 'provider_account_id' && value === account);
            return {
              data:!active && match
                ? {id:'inactive-registration',status,
                   reconnect_required:status === 'reconnect_required'}
                : null,
              error:null,
            };
          }
          throw new Error('Legacy business lookup must be blocked');
        },
        then(resolve:any,reject:any) {
          reads.push({table,filters:[...filters]});
          return Promise.reject(new Error('Legacy query forbidden')).then(resolve,reject);
        },
      };
      return q;
    };

    t.mock.method(globalThis,'fetch',async () => {
      outbound++;
      throw new Error('External request blocked');
    });

    boundary.configure({
      supabaseClient:{from},
      claimOperation:async (params:any) => {
        claims++;
        const now = Date.now();
        return {
          claimed:true,
          keyHash:'d'.repeat(64),
          storageId:'inactive-messenger-' + status,
          storagePlatform:'idempotency:messenger',
          state:{
            type:params.type,status:'processing',attempts:1,
            claimedAt:now,updatedAt:now,
          },
        };
      },
      settleOperation:async () => true,
    } as any);

    try {
      await boundary.messengerInbound({
        sender:{id:'offline-inactive-customer'},
        recipient:{id:account},
        timestamp:Date.now(),
        message:{
          mid:'offline-inactive-event-' + status,
          text:'What are your opening hours?',
        },
      },{
        id:3,businessId:3,businessRecordId:3,
        messengerPageId:account,
      });

      assert.equal(claims,1);
      assert.equal(outbound,0);
      assert.equal(reads.filter(r => r.table === 'businesses').length,0,
        'Inactive self-service identity must block legacy business lookup');

      const connectionReads = reads.filter(r => r.table === 'channel_connections');
      assert.equal(connectionReads.length,3,
        'Two active identity lookups followed by inactive registration lookup');
      assert.ok(connectionReads[2].filters.some(([key,value]) =>
        key === 'provider_account_id' && value === account));
      assert.ok(connectionReads[2].filters.every(([key]) => key !== 'status'),
        'Registration check must include inactive statuses');
    } finally {
      boundary.configure({} as any);
    }
  });
}
