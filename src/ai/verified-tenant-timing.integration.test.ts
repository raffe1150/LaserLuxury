import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyFirstEnabled } from './knowledge-timing-policy';

type Channel = 'whatsapp' | 'instagram' | 'messenger';

import { timingTenantFromVerifiedContext } from './verified-tenant-context';

type TenantResolution = {
  businessId: number;
  channel: Channel;
  providerAccountId: string;
  verified: boolean;
};

function selectTimingTenant(
  context: TenantResolution | null,
  channel: Channel,
  incomingAccountId: string,
): number | null {
  return timingTenantFromVerifiedContext(
    context?.verified ? {...context, verified: true as const} : null,
    channel,
    incomingAccountId,
  );
}

const env = {
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3',
} as NodeJS.ProcessEnv;

for (const channel of ['whatsapp', 'instagram', 'messenger'] as const) {
  test(`${channel}: verified tenant 3 activates scoped timing`, () => {
    const context: TenantResolution = {
      businessId: 3,
      channel,
      providerAccountId: `${channel}-account-1`,
      verified: true,
    };

    const tenantId = selectTimingTenant(
      context,
      channel,
      `${channel}-account-1`,
    );

    assert.equal(tenantId, 3);
    assert.equal(accuracyFirstEnabled(tenantId!, env), true);
  });

  test(`${channel}: unverified tenant cannot activate timing`, () => {
    const context: TenantResolution = {
      businessId: 3,
      channel,
      providerAccountId: `${channel}-account-1`,
      verified: false,
    };

    const tenantId = selectTimingTenant(
      context,
      channel,
      `${channel}-account-1`,
    );

    assert.equal(tenantId, null);
  });

  test(`${channel}: mismatched provider account is rejected`, () => {
    const context: TenantResolution = {
      businessId: 3,
      channel,
      providerAccountId: `${channel}-account-1`,
      verified: true,
    };

    assert.equal(
      selectTimingTenant(context, channel, 'different-account'),
      null,
    );
  });

  test(`${channel}: tenant 4 retains legacy timing`, () => {
    const context: TenantResolution = {
      businessId: 4,
      channel,
      providerAccountId: `${channel}-account-1`,
      verified: true,
    };

    const tenantId = selectTimingTenant(
      context,
      channel,
      `${channel}-account-1`,
    );

    assert.equal(accuracyFirstEnabled(tenantId!, env), false);
  });
}

test('missing verified tenant context fails closed', () => {
  for (const channel of ['whatsapp', 'instagram', 'messenger'] as const) {
    assert.equal(timingTenantFromVerifiedContext(null, channel, 'account-1'), null);
    assert.equal(timingTenantFromVerifiedContext(undefined, channel, 'account-1'), null);
  }
});

test('invalid tenant identifiers fail closed', () => {
  for (const id of [0, -1, NaN, Infinity, 3.5]) {
    assert.equal(timingTenantFromVerifiedContext({
      businessId: id,
      channel: 'whatsapp',
      providerAccountId: 'account-1',
      verified: true,
    }, 'whatsapp', 'account-1'), null);
  }
});
