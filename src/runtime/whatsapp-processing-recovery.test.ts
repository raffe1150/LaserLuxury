import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real handler/sender bodies without importing server startup,
// loading environment files, accessing a database, or reaching a provider.
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const functionNames = [
  'processWhatsAppMessageClaimed', 'getBusinessIdFromConfig',
  'getAppointmentBusinessScope', 'getScopedChannelSessionId',
  'normalizePlatformName', 'normalizePlatformUserId',
  'canonicalWhatsAppProviderCustomerId', 'prepareConversationLanguageForTurn',
  'getErrorMessageByLanguage', 'cleanMetaToken', 'getBusinessWhatsAppToken',
  'getBusinessWhatsAppPhoneNumberId', 'prepareWhatsAppOutboundText',
  'sendWhatsAppMessage', 'recordDeliveredAssistantResponse',
];
const functions = functionNames.map((name) => {
  const matches = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `one actual server function required: ${name}`);
  return matches[0].getText(parsed);
}).join('\n');
const executable = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

interface Business {
  id: number;
  businessName: string;
  language: string;
  whatsappPhoneNumberId: string;
  whatsappAccessToken: string;
  systemPrompt: string;
}
interface Inbound {
  id: string;
  from: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}
interface Accepted {
  businessId: number;
  sessionId: string;
  platform: string;
  language: string;
}
interface Outbound {
  url: string;
  authorization: string | null;
  payload: {
    messaging_product: string;
    recipient_type: string;
    to: string;
    type: string;
    text: { preview_url: boolean; body: string };
  };
}
interface Delivery {
  businessId: number;
  channel: string;
  sessionId: string;
  source: string;
  sourceEventId: string;
  language: string;
  metadata: { delivery_type: string };
}
interface Generation { text: string; functionCalls?: never[]; }
interface GenerationOptions { context: { businessId: number; channel: string; language: string }; }
const A: Business = { id: 101, businessName: 'Synthetic A', language: 'en', whatsappPhoneNumberId: 'synthetic-phone-A', whatsappAccessToken: 'synthetic-token-A', systemPrompt: 'Synthetic business information.' };
const B: Business = { ...A, id: 202, businessName: 'Synthetic B', language: 'sv', whatsappPhoneNumberId: 'synthetic-phone-B', whatsappAccessToken: 'synthetic-token-B' };
const recipientA = '46700000101';
const recipientB = '46700000202';
const englishFallback = 'Sorry, a technical problem occurred. Please try again in a few minutes.';
const swedishFallback = 'Ursäkta, jag stötte på ett tekniskt problem. Försök gärna igen om några minuter.';

function fixture(options: {
  generate?: (businessId: number) => Promise<Generation>;
  groundingFailure?: boolean;
  outboundFailure?: 'http' | 'network';
  postProcessFailure?: boolean;
} = {}) {
  const accepted: Accepted[] = [];
  const outbound: Outbound[] = [];
  const deliveries: Delivery[] = [];
  const logs: unknown[][] = [];
  const usage: { businessId: number; platform: string; userId: string; language: string }[] = [];
  const postProcess: unknown[][] = [];
  const credentialFailures: { businessId: number; status: number; code: number }[] = [];
  const prepared: { sessionId: string; text: string; businessId: number }[] = [];
  const generations: GenerationOptions[] = [];
  const languages = new Map<string, string>();
  const history: Record<string, { role: string; content: string }[]> = {};
  const context = vm.createContext({
    process: { env: {} }, // Neither real credentials nor environment files enter this fixture.
    supabase: null, activeConfig: {}, chatSessions: history,
    nonMutatingSupportTurns: {}, languageEngine: '',
    console: { log: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
    bindMetaInboundEventBusiness: () => undefined,
    resetSessionIfBusinessConfigChanged: () => undefined,
    clearAppointmentConversationState: () => undefined,
    isBusinessInformationQuestion: () => false,
    clearBusinessInformationTiming: () => undefined,
    resolveConversationLanguageForTurn: async (sessionId: string, text: string, business: Business) => {
      prepared.push({ sessionId, text, businessId: business.id });
      languages.set(sessionId, business.language);
      return business.language;
    },
    getStoredFlowLanguage: (sessionId: string) => languages.get(sessionId),
    getConversationLanguage: (sessionId: string) => languages.get(sessionId),
    normalizeAcceptedMessageTimestamp: (seconds: string) => new Date(Number(seconds) * 1000).toISOString(),
    recordAcceptedCustomerMessage: (event: Accepted) => accepted.push(event),
    mirrorP2InboundTextShadow: () => undefined,
    checkAndIncrementDailyUsage: async (event: typeof usage[number]) => { usage.push(event); return { allowed: true }; },
    planWhatsAppStateFirstRouting: async () => ({ authoritativeStatePresent: false, intent: 'normal_conversation' }),
    shouldReturnWhatsAppAmbiguousClarification: () => false,
    shouldDispatchWhatsAppUnifiedBooking: () => false,
    buildRecentConversationHistory: (messages: typeof history[string]) => [...messages],
    isFirstAssistantReplyInConversationWindow: async () => false,
    buildBusinessPromptWithTone: (prompt: string) => prompt,
    buildLanguageLockInstruction: () => '',
    buildRecentCompletedSupportInstruction: () => '',
    buildAssistantIdentityLifecycleInstruction: () => '',
    markBusinessInformationTiming: () => undefined,
    businessInformationTimingContext: () => ({}),
    minimizeBusinessSupportMessages: (_sessionId: string, messages: unknown[]) => messages,
    getGeminiSupportTools: () => [],
    generateContentWithFallback: async (_ai: null, request: GenerationOptions) => {
      assert.ok(accepted.some((event) => event.businessId === request.context.businessId), 'inbound scope is established before injected failure');
      generations.push(request);
      if (options.generate) return options.generate(request.context.businessId);
      return { text: 'Existing normal reply.' };
    },
    guardCustomerFacingReply: (_sessionId: string, reply: string) => reply,
    guardBusinessSupportGrounding: async (_sessionId: string, _text: string, reply: string) => {
      if (options.groundingFailure) throw new Error('synthetic grounding failure');
      return reply;
    },
    guardGeneralAiReplyRepetition: (_sessionId: string, reply: string) => reply,
    suppressRepeatedPromotionalCta: (_sessionId: string, reply: string) => reply,
    enforceAssistantIdentityLifecycle: (reply: string) => reply,
    enforceFinalConversationConcision: (reply: string) => reply,
    getFinalConversationConcisionBudget: () => 45,
    settleHumanHandoffReply: async (request: { proposedReply: string }) => request.proposedReply,
    prepareMetaOutboundText: (_sessionId: string, text: string, outboundContext: string) => {
      assert.equal(outboundContext, 'conversation');
      return text;
    },
    timeBusinessInformationDelivery: (_sessionId: string, work: () => Promise<Response>) => work(),
    fetch: async (url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected actual WhatsApp JSON payload');
      const payload: Outbound['payload'] = JSON.parse(init.body);
      outbound.push({ url, authorization: new Headers(init.headers).get('Authorization'), payload });
      if (options.outboundFailure === 'network') throw new Error('synthetic network failure');
      return options.outboundFailure === 'http'
        ? new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400 })
        : new Response(JSON.stringify({ messages: [{ id: 'wamid.synthetic' }] }), { status: 200 });
    },
    markChannelCredentialFailure: async (business: Business, status: number, code: number) => credentialFailures.push({ businessId: business.id, status, code }),
    recordRuntimeAnalyticsEvent: (event: string, category: string, result: string, delivery: Delivery) => {
      assert.deepEqual([event, category, result], ['assistant_response_sent', 'conversation', 'sent']);
      deliveries.push(structuredClone(delivery));
    },
    postProcessMessage: async (...args: unknown[]) => {
      postProcess.push(args);
      if (options.postProcessFailure) throw new Error('synthetic persistence failure');
    },
    classifyAiFailure: () => 'synthetic_failure',
  });
  vm.runInContext(executable, context, { filename: 'actual-whatsapp-handler.fixture.js' });
  const handle: (message: Inbound, metadata: { phone_number_id: string }, business: Business) => Promise<void> = vm.runInContext('processWhatsAppMessageClaimed', context);
  const run = (business = A, recipient = recipientA, eventId = 'synthetic-inbound-A') => handle({
    id: eventId, from: recipient, timestamp: '1791457200', type: 'text', text: { body: 'Synthetic customer question.' },
  }, { phone_number_id: business.whatsappPhoneNumberId }, business).catch((error: unknown) => {
    console.error('Synthetic recovery regression trace', {
      accepted: accepted.length, generation: generations.length, outbound: outbound.length,
      delivered: deliveries.length, persistence: postProcess.length,
      processingErrors: logs.filter(([label]) => label === '[ChannelProcessing]').length,
    });
    throw error;
  });
  return { run, handle, accepted, outbound, deliveries, logs, usage, postProcess, credentialFailures, prepared, generations, history };
}

function assertDelivered(f: ReturnType<typeof fixture>, business: Business, recipient: string, text: string, source: string, eventId: string) {
  const request = f.outbound.find((item) => item.payload.to === recipient);
  assert.ok(request);
  assert.equal(request.url, `https://graph.facebook.com/v25.0/${business.whatsappPhoneNumberId}/messages`);
  assert.equal(request.authorization, `Bearer ${business.whatsappAccessToken}`);
  assert.deepEqual(request.payload, { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { preview_url: false, body: text } });
  assert.deepEqual(f.deliveries.find((item) => item.businessId === business.id), {
    businessId: business.id, channel: 'whatsapp', sessionId: `wa_${business.id}:${recipient}`,
    source, sourceEventId: `${eventId}:${source}`, language: business.language, metadata: { delivery_type: 'text' },
  });
}

for (const [business, recipient, fallback] of [[A, recipientA, englishFallback], [B, recipientB, swedishFallback]] as const) {
  test(`${business.language}: processing failure recovers once with the existing localized reply and accounting`, async () => {
    const failure = new Error('synthetic conversation processing failure');
    const f = fixture({ generate: async () => { throw failure; } });
    await f.run(business, recipient);
    assert.equal(f.accepted.length, 1);
    assert.equal(f.prepared.length, 1);
    assert.equal(f.generations.length, 1);
    assert.equal(f.usage.length, 1);
    assert.equal(f.outbound.length, 1, 'fallback only, never a normal send');
    assert.equal(f.deliveries.length, 1);
    assertDelivered(f, business, recipient, fallback, 'processing_error_fallback', 'synthetic-inbound-A');
    assert.equal(f.postProcess.length, 0, 'catch does not invent history/database persistence');
    assert.equal(f.history[`wa_${business.id}:${recipient}`].length, 0);
    assert.equal(f.credentialFailures.length, 0);
    assert.ok(f.logs.some(([label, detail]) => label === '[ChannelProcessing]' && JSON.stringify(detail) === JSON.stringify({ channel: 'whatsapp', businessId: business.id, stage: 'conversation', success: false, errorCategory: 'synthetic_failure' })));
  });

  test(`${business.language}: normal reply retains recipient, payload, accounting and history without fallback`, async () => {
    const f = fixture();
    await f.run(business, recipient);
    assert.equal(f.outbound.length, 1);
    assert.equal(f.deliveries.length, 1);
    assertDelivered(f, business, recipient, 'Existing normal reply.', 'gemini_conversation_reply', 'synthetic-inbound-A');
    assert.equal(f.postProcess.length, 1);
    assert.equal(f.postProcess[0][0], recipient);
    assert.equal(f.postProcess[0][1], 'whatsapp-webhook');
    assert.equal(f.postProcess[0][6], business.id);
    assert.equal(f.history[`wa_${business.id}:${recipient}`].length, 2);
    assert.ok(!f.logs.some(([label]) => label === '[ChannelProcessing]'));
  });
}

test('failure after generation but before send cannot emit both normal and fallback replies', async () => {
  const f = fixture({ groundingFailure: true });
  await f.run();
  assert.equal(f.generations.length, 1);
  assert.equal(f.outbound.length, 1);
  assertDelivered(f, A, recipientA, englishFallback, 'processing_error_fallback', 'synthetic-inbound-A');
  assert.equal(f.postProcess.length, 0);
});

test('concurrent A failure and B normal processing retain separate recipient/business/channel context', async () => {
  let rejectA: (error: Error) => void = () => { throw new Error('A generation not started'); };
  let resolveB: (value: Generation) => void = () => { throw new Error('B generation not started'); };
  const f = fixture({ generate: (businessId) => businessId === A.id
    ? new Promise((_resolve, reject) => { rejectA = reject; })
    : new Promise((resolve) => { resolveB = resolve; }) });
  const a = f.run(A, recipientA, 'event-A');
  const b = f.run(B, recipientB, 'event-B');
  // Both actual handlers suspend at their mocked generation call.
  for (let turns = 0; f.generations.length < 2 && turns < 100; turns++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.generations.length, 2);
  resolveB({ text: 'Existing normal reply.' });
  await b;
  rejectA(new Error('synthetic A failure'));
  await a;
  assert.equal(f.outbound.length, 2);
  assert.equal(f.deliveries.length, 2);
  assertDelivered(f, A, recipientA, englishFallback, 'processing_error_fallback', 'event-A');
  assertDelivered(f, B, recipientB, 'Existing normal reply.', 'gemini_conversation_reply', 'event-B');
  assert.equal(f.outbound.filter((item) => item.payload.to === recipientA).length, 1);
  assert.equal(f.outbound.filter((item) => item.payload.to === recipientB).length, 1);
  assert.equal(f.postProcess.length, 1);
  assert.equal(f.postProcess[0][6], B.id);
});

for (const outboundFailure of ['http', 'network'] as const) {
  test(`${outboundFailure}: failed fallback delivery is attempted once without retry or successful-delivery accounting`, async () => {
    const f = fixture({ generate: async () => { throw new Error('synthetic processing failure'); }, outboundFailure });
    await f.run();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].payload.to, recipientA);
    assert.equal(f.outbound[0].payload.text.body, englishFallback);
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.postProcess.length, 0);
    assert.equal(f.generations.length, 1);
    assert.deepEqual(f.credentialFailures, outboundFailure === 'http' ? [{ businessId: A.id, status: 400, code: 131047 }] : []);
  });
}

test('normal post-processing failure retains its existing local catch and does not trigger fallback', async () => {
  const f = fixture({ postProcessFailure: true });
  await f.run();
  assert.equal(f.outbound.length, 1);
  assert.equal(f.deliveries[0].source, 'gemini_conversation_reply');
  assert.equal(f.postProcess.length, 1);
  assert.ok(f.logs.some(([label]) => label === 'WhatsApp postProcessMessage failed:'));
  assert.ok(!f.logs.some(([label]) => label === '[ChannelProcessing]'));
});

test('unverified phone/business binding still exits before inbound accounting or outbound delivery', async () => {
  const f = fixture();
  await f.handle({ id: 'unverified', from: recipientA, timestamp: '1791457200', type: 'text', text: { body: 'Question' } },
    { phone_number_id: B.whatsappPhoneNumberId }, A);
  assert.equal(f.accepted.length, 0);
  assert.equal(f.outbound.length, 0);
  assert.equal(f.generations.length, 0);
});
