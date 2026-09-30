import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { generateWithOpenAi, toOpenAiInput, toOpenAiTools } from './openai';
import { generateWithConfiguredProvider, normalizeGenerationRequestForProvider } from './router';
import { buildGeminiGenerationParams } from './gemini';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from '../business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../server');
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-offline-temperature-test';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  b.reset();
});

for (const model of ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-5', 'o3', 'unverified-model', 'gpt-4.1-unknown-snapshot']) {
  for (const withTools of [false, true]) {
    test(`${model}: unsupported/unverified temperature omitted, ${withTools ? 'tool' : 'no-tool'} payload otherwise unchanged`, async t => {
      const request = {
        model, temperature: 0, systemInstruction: 'Verify the complete factual proposition.',
        messages: [
          { role: 'user', content: 'Verify a business fact.' },
          { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'checkSlots', arguments: '{"date":"2026-10-01"}' } }] },
          { role: 'tool', id: 'call-1', content: '{"available":true}' },
        ],
        tools: withTools ? [{ functionDeclarations: [{ name: 'checkSlots', description: 'Check availability', parameters: {
          type: 'OBJECT', required: ['date'], properties: { date: { type: 'STRING', enum: ['2026-10-01'] } },
        } }] }] : undefined,
      };
      const original = structuredClone(request);
      const create = t.mock.method(Responses.prototype, 'create', async (params: any) => {
        if (Object.hasOwn(params, 'temperature')) throw new Error('400 Unsupported parameter: temperature');
        assert.deepEqual(params, { model, instructions: request.systemInstruction, input: toOpenAiInput(request.messages), tools: toOpenAiTools(request.tools) });
        return { output_text: 'Verified.', output: withTools ? [{ type: 'function_call', call_id: 'call-2', name: 'checkSlots', arguments: '{"date":"2026-10-01"}' }] : [] } as any;
      });
      assert.deepEqual(await generateWithOpenAi(request), {
        text: 'Verified.', functionCalls: withTools ? [{ id: 'call-2', function: { name: 'checkSlots', arguments: '{"date":"2026-10-01"}' } }] : [],
      });
      assert.equal(create.mock.callCount(), 1);
      assert.deepEqual(request, original);
    });
  }
}

for (const model of [
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini',
  'gpt-4.1-2025-04-14', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano-2025-04-14',
  'gpt-4o-2024-08-06', 'gpt-4o-mini-2024-07-18',
]) {
  test(`${model}: documented non-reasoning Responses model retains caller temperature`, async t => {
    const create = t.mock.method(Responses.prototype, 'create', async (params: any) => {
      assert.equal(params.model, model);
      assert.equal(params.temperature, 0.2);
      return { output_text: 'OK', output: [] } as any;
    });
    await generateWithOpenAi({ model, temperature: 0.2, messages: [{ role: 'user', content: 'Hello' }] });
    assert.equal(create.mock.callCount(), 1);
  });
}

test('supported model without caller temperature does not acquire a default sampling field', async t => {
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    return { output_text: 'OK', output: [] } as any;
  });
  await generateWithOpenAi({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hello' }] });
});

test('model precedence stays explicit OpenAI model, then env override, then existing default', async t => {
  const models: string[] = [];
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    models.push(params.model);
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    return { output_text: 'OK', output: [] } as any;
  });
  const request = { model: 'gemini-2.5-flash', temperature: 0, messages: [{ role: 'user', content: 'Verify' }] };
  await generateWithConfiguredProvider(request);
  process.env.OPENAI_MODEL = 'gpt-6-luna';
  await generateWithConfiguredProvider(request);
  await generateWithConfiguredProvider({ ...request, model: 'gpt-5.6-luna' });
  delete process.env.OPENAI_MODEL;
  await generateWithConfiguredProvider(request);
  assert.deepEqual(models, ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna']);
});

test('Gemini verifier temperature and request normalization remain unchanged', () => {
  const request = { model: 'gemini-2.5-flash', temperature: 0, systemInstruction: 'Verify evidence.', messages: [{ role: 'user', content: 'Fact' }] };
  assert.equal(normalizeGenerationRequestForProvider('gemini', request), request);
  const params = buildGeminiGenerationParams(request);
  assert.equal(params.model, request.model);
  assert.equal(params.config.temperature, 0);
  assert.equal(params.config.systemInstruction, request.systemInstruction);
});

const snapshot = JSON.parse(readFileSync(new URL('../../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
for (const relation of ['ENTAILED', 'CONTRADICTED'] as const) {
  test(`real German compound grounding path executes and honors the SDK entailment result: ${relation}`, async t => {
    const question = 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?';
    const config = snapshot.business;
    const fact = snapshot.sources[0].content;
    const address = /kundentrén ligger på (.+)\.$/u.exec(fact)![1];
    const catalog = formatConfiguredServiceCatalogPlan(buildConfiguredServiceCatalogPlan(config.services), 'de');
    const location = `Unser Kundeneingang befindet sich in ${address}.`;
    const candidate = `${catalog}\n${location}`;
    const assessment = {
      hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [
        { claim: catalog, candidateQuote: catalog, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"name": "Video Consultation"' }] },
        { claim: location, candidateQuote: location, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
          evidence: [{ source: 'retrieved_knowledge', quote: fact }] },
      ],
    };
    let extractionCalls = 0;
    let locationEntailmentCalls = 0;
    const failures: any[] = [];
    const diagnostics: any[] = [];
    t.mock.method(console, 'error', (...args: any[]) => failures.push(args));
    t.mock.method(Responses.prototype, 'create', async (params: any) => {
      assert.equal(params.model, 'gpt-5.6-luna');
      assert.equal(Object.hasOwn(params, 'temperature'), false);
      assert.equal(params.tools, undefined);
      const body = JSON.parse(params.input[0].content);
      if (params.instructions.includes('strict business-response claim and citation extractor')) {
        extractionCalls++;
        assert.equal(body.customerMessage, question);
        assert.ok(body.groundingEvidence.includes(fact));
        return { output_text: JSON.stringify(assessment), output: [] } as any;
      }
      assert.match(params.instructions, /final strict entailment gate/);
      const locationClaim = body.atomicClaim === location;
      if (locationClaim) {
        locationEntailmentCalls++;
        assert.equal(body.exactCandidateQuote, location);
        assert.deepEqual(body.citedEvidence, assessment.claims[1].evidence);
        assert.equal(body.relevantContext.customerQuestion, question);
      }
      return { output_text: JSON.stringify({ relation: locationClaim ? relation : 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }), output: [] } as any;
    });
    // Neither claim extraction nor entailment is replaced with a test seam.
    b.configure({ businessGroundingDiagnostic: d => diagnostics.push(d) });
    b.businessInformationState('temperature-verifier', config, question, 'de', `source_id: ${snapshot.sources[0].id}\n${fact}`);
    const reply = await b.businessSupportGrounding('temperature-verifier', question, candidate, 'de');
    assert.equal(extractionCalls, 1);
    assert.ok(locationEntailmentCalls >= 1);
    assert.equal(diagnostics[0].verifiedEvidence, true);
    assert.equal(diagnostics[0].claimsEntailed, relation === 'ENTAILED');
    if (relation === 'ENTAILED') assert.equal(reply, candidate);
    else assert.equal(reply.includes(address), false, 'a rejected location remains rejected');
    assert.equal(failures.length, 0);
  });
}
