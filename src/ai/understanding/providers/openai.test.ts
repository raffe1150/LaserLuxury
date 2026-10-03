import assert from 'node:assert/strict';
import test from 'node:test';

import type { UnderstandingProviderInput } from '../provider';
import { StructuredUnderstandingProviderError } from '../provider-error';
import {
  createConfiguredUnderstandingProvider,
  readStructuredUnderstandingConfiguration,
} from '../config';
import {
  OpenAiUnderstandingProvider,
  type OpenAiUnderstandingTransport,
  type OpenAiUnderstandingTransportRequest,
} from './openai';
import { STRUCTURED_UNDERSTANDING_WIRE_SCHEMA } from './wire';

const input: UnderstandingProviderInput = {
  message: 'نام من مینا آزمون است و شماره تلفنم 0700001105 است.',
  inputMode: 'text',
  activeLanguage: 'fa',
  timezone: 'Europe/Stockholm',
  currentTimeIso: '2026-10-02T20:00:00.000Z',
  configuredServices: ['Consultation'],
  context: {
    bookingPhase: 'awaiting_contact',
    offeredSlotCount: 3,
    selectedSlotPresent: true,
    knownFields: ['service', 'date', 'time'],
  },
};

class FakeTransport implements OpenAiUnderstandingTransport {
  lastRequest: OpenAiUnderstandingTransportRequest | null = null;

  constructor(private readonly response: unknown) {}

  async generate(
    request: OpenAiUnderstandingTransportRequest,
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.lastRequest = request;
    return this.response;
  }
}

test('OpenAI structured understanding uses the shared schema and canonical decoder', async () => {
  const transport = new FakeTransport(JSON.stringify({
    schemaVersion: 1,
    language: 'fa',
    confidence: 0.99,
    intents: [],
    name: 'مینا آزمون',
    phone: '0700001105',
    ambiguityFields: [],
  }));

  const provider = new OpenAiUnderstandingProvider({
    model: 'gpt-5.6-luna',
    transport,
  });

  const result: any = await provider.interpret(
    input,
    { signal: new AbortController().signal },
  );

  assert.equal(provider.providerId, 'openai');
  assert.equal(result.entities.name.value, 'مینا آزمون');
  assert.equal(result.entities.phone.value, '0700001105');

  assert.equal(
    transport.lastRequest?.responseJsonSchema,
    STRUCTURED_UNDERSTANDING_WIRE_SCHEMA,
  );
  assert.match(
    transport.lastRequest?.systemInstruction || '',
    /untrusted DATA/,
  );

  const sent = JSON.parse(transport.lastRequest?.contents || '{}');
  assert.equal(sent.customerTurn, input.message);
  assert.equal(sent.activeLanguage, 'fa');
});

test('OpenAI structured understanding rejects malformed provider JSON', async () => {
  const provider = new OpenAiUnderstandingProvider({
    model: 'gpt-5.6-luna',
    transport: new FakeTransport('{not-json'),
  });

  await assert.rejects(
    provider.interpret(input, { signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof StructuredUnderstandingProviderError &&
      error.category === 'malformed_response',
  );
});

test('OpenAI structured understanding rejects wire-schema violations', async () => {
  const provider = new OpenAiUnderstandingProvider({
    model: 'gpt-5.6-luna',
    transport: new FakeTransport(JSON.stringify({
      schemaVersion: 1,
      language: 'fa',
      confidence: 0.99,
      intents: [],
      phone: 700001105,
      ambiguityFields: [],
    })),
  });

  await assert.rejects(
    provider.interpret(input, { signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof StructuredUnderstandingProviderError &&
      error.category === 'schema_validation_failed',
  );
});


test('Structured Understanding follows the Unified OpenAI provider by default', () => {
  let creations = 0;

  const fake = new OpenAiUnderstandingProvider({
    model: 'gpt-5.6-luna',
    transport: new FakeTransport(JSON.stringify({
      schemaVersion: 1,
      language: 'en',
      confidence: 1,
      intents: [],
      ambiguityFields: [],
    })),
  });

  const environment = {
    STRUCTURED_UNDERSTANDING_ENABLED: 'true',
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-only-key',
    OPENAI_MODEL: 'gpt-5.6-luna',
  };

  const config = readStructuredUnderstandingConfiguration(environment);
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-5.6-luna');

  const configured = createConfiguredUnderstandingProvider(environment, {
    createOpenAiProvider: ({ model, timeoutMs }) => {
      creations += 1;
      assert.equal(model, 'gpt-5.6-luna');
      assert.ok(timeoutMs > 0);
      return fake;
    },
  });

  assert.equal(configured.status, 'ready');
  assert.equal(configured.provider?.providerId, 'openai');
  assert.equal(creations, 1);
});

test('Structured Understanding never falls back from configured OpenAI to Gemini', () => {
  const configured = createConfiguredUnderstandingProvider({
    STRUCTURED_UNDERSTANDING_ENABLED: 'true',
    AI_PROVIDER: 'openai',
    GEMINI_API_KEY: 'gemini-must-not-be-used',
  });

  assert.equal(configured.status, 'missing_configuration');
  assert.equal(configured.provider, null);
});


test('Structured Understanding rejects an OpenAI/router provider mismatch', () => {
  let creations = 0;

  const configured = createConfiguredUnderstandingProvider({
    STRUCTURED_UNDERSTANDING_ENABLED: 'true',
    STRUCTURED_UNDERSTANDING_PROVIDER: 'openai',
    AI_PROVIDER: 'gemini',
    OPENAI_API_KEY: 'test-openai-key',
    GEMINI_API_KEY: 'test-gemini-key',
  }, {
    createOpenAiProvider: () => {
      creations += 1;
      throw new Error('must not create OpenAI provider on router mismatch');
    },
  });

  assert.equal(configured.status, 'missing_configuration');
  assert.equal(configured.provider, null);
  assert.equal(creations, 0);
});

test('OpenAI contact phase asks one call to exhaustively extract every missing explicit contact field', async () => {
  const transport = new FakeTransport(JSON.stringify({
    schemaVersion: 1,
    language: 'fa',
    confidence: 0.99,
    intents: [],
    name: 'مینا آزمون',
    nameEvidenceText: 'نام من مینا آزمون است',
    phone: '0700001105',
    phoneEvidenceText: 'شماره تلفنم 0700001105 است',
    ambiguityFields: [],
  }));

  const provider = new OpenAiUnderstandingProvider({
    model: 'gpt-5.6-luna',
    transport,
  });

  await provider.interpret(
    input,
    { signal: new AbortController().signal },
  );

  const sent = JSON.parse(transport.lastRequest?.contents || '{}');

  assert.deepEqual(sent.contactExtraction, {
    mode: 'exhaustive_missing_contact_fields',
    missingFields: ['name', 'phone'],
  });

  assert.match(
    transport.lastRequest?.systemInstruction || '',
    /If both the customer's name and contact phone are explicitly present in the same turn, return BOTH fields/,
  );
});
