import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { composeGroundedBookingReply } from '../grounded-booking-composition';
import { generateWithConfiguredProvider } from './router';

test('booking composition uses one routed OpenAI Responses request, strict JSON, no tools and bounded context', async t => {
  const original = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-offline-booking-composition';
  process.env.OPENAI_MODEL = 'configured-booking-model';
  const facts = { kind: 'unsupported_service' as const, language: 'en', requestedService: 'Haircut', services: ['Video Consultation'] };
  const snapshot = structuredClone(facts);
  const create = t.mock.method(Responses.prototype, 'create', async (request: any, options: any) => {
    assert.equal(request.model, 'configured-booking-model');
    assert.equal(request.tools, undefined);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(request.instructions, /AUTHORITATIVE_BOOKING_FACTS/);
    assert.match(request.instructions, /untrusted context/);
    const context = JSON.parse(request.input[0].content);
    assert.equal(context.recentConversation.length, 10);
    assert.ok(context.recentConversation.every((message: any) => message.content.length <= 1200));
    assert.equal(context.latestCustomerText.length, 1200);
    return { output_text: JSON.stringify({ reply: 'Haircut is not bookable here. Which service would you like: Video Consultation?' }), output: [] } as any;
  });
  const result = await composeGroundedBookingReply({ scope: 'responses-offline', facts, fallback: 'fallback', languageMatches: () => true,
    history: Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })), latestText: 'x'.repeat(2000), generate: generateWithConfiguredProvider,
  });
  assert.equal(result.source, 'openai');
  assert.equal(create.mock.callCount(), 1);
  assert.deepEqual(facts, snapshot);
});
