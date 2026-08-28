import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnalyticsRecorder } from './analytics';
import { createAnalyticsCorrelationId, sha256 } from './hash';
import {
  createInboundMessageAnalyticsIdentity,
  recordRuntimeAnalyticsEvent,
} from './runtime-events';

type Ingress = {
  businessId: number;
  channel: 'telegram' | 'whatsapp' | 'instagram' | 'messenger';
  transportSource: string;
  providerMessageId: string;
  providerScope?: string;
};

async function runTests(): Promise<void> {
  const previousSecret = process.env.ANALYTICS_HASH_SECRET;
  process.env.ANALYTICS_HASH_SECRET = '0123456789abcdef0123456789abcdef';
  const persisted = new Map<string, unknown>();
  const recorder = createAnalyticsRecorder({
    persist: async (event) => {
      // Mirrors analytics_events unique (business_id, idempotency_key).
      persisted.set(`${event.business_id}:${event.idempotency_key}`, event);
    },
    reportError: () => assert.fail('valid ingress event should persist'),
  });

  async function emit(input: Ingress): Promise<void> {
    const identity = createInboundMessageAnalyticsIdentity(input);
    assert.ok(identity);
    await recordRuntimeAnalyticsEvent(
      'customer_message_received',
      'conversation',
      'received',
      {
        businessId: input.businessId,
        channel: input.channel,
        source: identity.source,
        sourceEventId: identity.sourceEventId,
        metadata: { message_type: 'text' },
      },
      recorder,
    );
  }

  await emit({
    businessId: 7,
    channel: 'telegram',
    transportSource: 'telegram_polling',
    providerMessageId: 'update-100',
    providerScope: 'bot-a-fingerprint',
  });
  await emit({
    businessId: 7,
    channel: 'telegram',
    transportSource: 'telegram_webhook',
    providerMessageId: 'update-100',
    providerScope: 'bot-a-fingerprint',
  });
  assert.equal(persisted.size, 1, 'polling and webhook persist one logical event');

  await emit({
    businessId: 7,
    channel: 'telegram',
    transportSource: 'telegram_webhook',
    providerMessageId: 'update-101',
    providerScope: 'bot-a-fingerprint',
  });
  assert.equal(persisted.size, 2, 'different Telegram update IDs remain distinct');

  await emit({
    businessId: 8,
    channel: 'telegram',
    transportSource: 'telegram_polling',
    providerMessageId: 'update-100',
    providerScope: 'bot-a-fingerprint',
  });
  assert.equal(persisted.size, 3, 'the same update in another business remains distinct');

  const otherChannels = [
    ['whatsapp', 'whatsapp_webhook'],
    ['instagram', 'instagram_webhook'],
    ['messenger', 'messenger_webhook'],
  ] as const;
  for (const [channel, transportSource] of otherChannels) {
    const identity = createInboundMessageAnalyticsIdentity({
      channel,
      transportSource,
      providerMessageId: 'provider-message-1',
    });
    assert.deepEqual(identity, {
      source: transportSource,
      sourceEventId: sha256('provider-message-1'),
    });
  }

  const otherBot = createInboundMessageAnalyticsIdentity({
    channel: 'telegram',
    transportSource: 'telegram_webhook',
    providerMessageId: 'update-100',
    providerScope: 'bot-b-fingerprint',
  });
  const originalBot = createInboundMessageAnalyticsIdentity({
    channel: 'telegram',
    transportSource: 'telegram_polling',
    providerMessageId: 'update-100',
    providerScope: 'bot-a-fingerprint',
  });
  assert.notEqual(otherBot?.sourceEventId, originalBot?.sourceEventId);

  const acceptedEvents = new Map<string, any>();
  const acceptedRecorder = createAnalyticsRecorder({
    persist: async (event) => {
      // Mirrors analytics_events unique (business_id, idempotency_key).
      acceptedEvents.set(`${event.business_id}:${event.idempotency_key}`, event);
    },
    reportError: () => assert.fail('valid accepted-message analytics should persist'),
  });

  async function recordAccepted(input: Ingress & { sessionId: string }): Promise<void> {
    const identity = createInboundMessageAnalyticsIdentity(input);
    const conversationId = createAnalyticsCorrelationId({
      businessId: input.businessId,
      identifier: input.sessionId,
    });
    assert.ok(identity);
    assert.ok(conversationId);
    await recordRuntimeAnalyticsEvent('conversation_started', 'conversation', 'started', {
      businessId: input.businessId,
      channel: input.channel,
      source: identity.source,
      sourceEventId: conversationId,
      sessionId: input.sessionId,
    }, acceptedRecorder);
    await recordRuntimeAnalyticsEvent('customer_message_received', 'conversation', 'received', {
      businessId: input.businessId,
      channel: input.channel,
      source: identity.source,
      sourceEventId: identity.sourceEventId,
      sessionId: input.sessionId,
      metadata: { message_type: 'text' },
    }, acceptedRecorder);
  }

  const acceptedChannels = [
    { channel: 'telegram', transportSource: 'telegram_polling', providerScope: 'bot-a-fingerprint' },
    { channel: 'whatsapp', transportSource: 'whatsapp_webhook' },
    { channel: 'instagram', transportSource: 'instagram_webhook' },
    { channel: 'messenger', transportSource: 'messenger_webhook' },
  ] as const;
  for (const input of acceptedChannels) {
    const sessionId = `${input.channel}:tenant-7:customer-1`;
    await recordAccepted({ ...input, businessId: 7, providerMessageId: 'message-1', sessionId });
    await recordAccepted({ ...input, businessId: 7, providerMessageId: 'message-2', sessionId });
    await recordAccepted({ ...input, businessId: 7, providerMessageId: 'message-2', sessionId });
  }

  const tenantSevenStarts = [...acceptedEvents.values()].filter(
    (event) => event.business_id === 7 && event.event_name === 'conversation_started',
  );
  const tenantSevenMessages = [...acceptedEvents.values()].filter(
    (event) => event.business_id === 7 && event.event_name === 'customer_message_received',
  );
  assert.equal(tenantSevenStarts.length, 4, 'each genuinely new channel conversation persists one start');
  assert.equal(tenantSevenMessages.length, 8, 'distinct messages remain distinct while retries deduplicate');
  for (const event of tenantSevenStarts) {
    assert.equal(event.business_id, 7);
    assert.match(event.conversation_id || '', /^[a-f0-9]{64}$/);
    assert.ok(acceptedChannels.some(({ channel }) => channel === event.channel));
    assert.doesNotMatch(event.conversation_id, /tenant-7|customer-1/);
  }

  await recordAccepted({
    businessId: 8,
    channel: 'whatsapp',
    transportSource: 'whatsapp_webhook',
    providerMessageId: 'message-1',
    sessionId: 'whatsapp:tenant-7:customer-1',
  });
  assert.equal(
    [...acceptedEvents.values()].filter((event) => event.event_name === 'conversation_started').length,
    5,
    'the same raw session in another tenant has a separate start identity',
  );

  const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  assert.equal((serverSource.match(/recordAcceptedCustomerMessage\(\{/g) || []).length, 4);
  assert.match(serverSource, /recordAcceptedCustomerMessage[\s\S]*?conversation_started[\s\S]*?customer_message_received/);

  if (previousSecret === undefined) delete process.env.ANALYTICS_HASH_SECRET;
  else process.env.ANALYTICS_HASH_SECRET = previousSecret;

  console.log('Analytics ingress idempotency tests passed.');
}

void runTests();
