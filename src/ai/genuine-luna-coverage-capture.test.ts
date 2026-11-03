/** Saved genuine judgments are replayed verbatim. No provider or database access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { completeKnowledgeManifest, publishableKnowledgeManifest } from './business-information-answer-plan';
import { resolveOpenAiTextModel } from './providers/openai';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', import.meta.url), 'utf8'));
incidentFlags();
Object.assign(process.env, { ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'v2', ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2' });
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

test('retained genuine outputs contain no missing-proposition witness or COVERED obligation', () => {
  for (const stage of ['extraction', 'verification']) {
    assert.equal(createHash('sha256').update(fixture[stage].outputText).digest('hex'), fixture[stage].outputSha256);
    assert.equal(fixture[stage].model, 'gpt-5.6-luna');
  }
  assert.equal(fixture.extraction.responseId, 'resp_096450103d7e6bfb006ae8ae8df1dc87d2ab912b5651870133');
  assert.equal(fixture.verification.responseId, 'resp_006f2f9a10a76c3f006ae8ae94bb4087d293c109c3f40fc4ea');
  const verdict = JSON.parse(fixture.verification.outputText);
  assert.equal(verdict.decisions.length, 4);
  assert.ok(verdict.decisions.every((d: any) => d.relation === 'ENTAILED'));
  for (const row of verdict.coverage) {
    assert.equal(row.materialFactsComplete, false);
    assert.equal(row.incompletenessReason, 'MISSING_RELEVANT_FACT');
    assert.ok(row.obligations.every((o: any) => o.status === 'UNRESOLVED'));
    assert.equal(Object.hasOwn(row, 'missingProposition'), false);
  }
  const fields = fixture.verification.structuredOutput.schema.properties.coverage.items.properties;
  assert.deepEqual(Object.keys(fields), ['facetId', 'requestAligned', 'materialFactsComplete', 'incompletenessReason', 'materialUnitIds', 'obligations']);
});

for (const compose of ['blocked', 'valid-order-only'] as const)
test(`genuine coverage capture denies native publication with ${compose} composition`, async t => {
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  boundary.reset();
  const savedConfig = structuredClone(incidentConfig);
  const row = structuredClone(fixture.frozen.rawCancellationSettings);
  const normalized = boundary.promptAuditNormalize(row);
  const events: any[] = [], stages: string[] = [];
  let actions = 0;
  const forbidden = async () => { actions++; throw Error('OFFLINE_ACTION_FORBIDDEN'); };
  try {
    Object.assign(incidentConfig, row, { id: 77, businessId: 77, businessRecordId: 77, business_id: 77, language: 'en',
      cancellationSettingsEvidence: normalized.cancellationSettingsEvidence, allowCancellation: true, cancellationDeadlineMinutes: 1440,
      cancellationFeeEnabled: false, cancellationFeeAmount: 0, cancellationFeeCurrency: 'SEK' });
    boundary.configure({ offlineAi: true, postProcess: async () => {},
      knowledgeCancellationConfig: async (id, signal) => { assert.equal(id, 77); signal.throwIfAborted(); return structuredClone(row); },
      validateKnowledgeMatches: async (id, matches) => { assert.equal(id, 77); return matches; },
      knowledgeServiceCatalog: async () => incidentConfig.services,
      evidenceFirstDecisionDiagnostic: e => events.push(e),
      aiGenerate: async request => {
        const stage = request.systemInstruction.includes('UNIT EXTRACTION') ? 'extraction'
          : request.systemInstruction.includes('BATCH ENTAILMENT') ? 'verification' : 'composition';
        stages.push(stage);
        const data = JSON.parse(request.messages[0].content);
        if (stage === 'composition') {
          // No factual generation or new coverage verdict. A valid ordering
          // control proves the prior coverage denial is not a composer failure.
          if (compose === 'blocked') throw Error('OFFLINE_COMPOSITION_WITHHELD');
          return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }), functionCalls: [] };
        }
        const capture = fixture[stage];
        assert.equal(resolveOpenAiTextModel(request.model), capture.model);
        assert.equal(request.reasoningEffort, 'low');
        assert.equal(request.systemInstruction, capture.instruction);
        assert.deepEqual(request.structuredOutput, capture.structuredOutput);
        assert.deepEqual(data, capture.input, 'Entire evidence, question, authority, obligations and four verifier units must match the real request');
        return { text: capture.outputText, functionCalls: [] };
      },
      calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
        cancelAppointment: forbidden, updateAppointment: forbidden }, recordAppointment: forbidden,
      cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
    await boundary.nativeKnowledgeEvidenceRequest({ sessionId: `genuine-coverage-${compose}`, channel: 'telegram', businessConfig: incidentConfig,
      question: fixture.frozen.question, language: 'en', facets: fixture.verification.input.facets, matches: fixture.frozen.matches }, async api => {
      const generated = await api.generate();
      const manifest = api.manifest()!;
      assert.equal(manifest.units.length, 4);
      assert.ok(manifest.units.every(u => u.verification === 'ENTAILED'));
      assert.deepEqual(manifest.outcomes.map(o => ({ id: o.facetId, status: o.status, aligned: o.requestAligned, complete: o.materialFactsComplete,
        obligations: o.obligations.map(x => x.status) })), [
        { id: 'f1', status: 'PARTIAL', aligned: true, complete: false, obligations: ['UNRESOLVED'] },
        { id: 'f2', status: 'UNAVAILABLE', aligned: true, complete: false, obligations: ['UNRESOLVED'] },
      ]);
      assert.equal(manifest.qualifiedPartial, undefined);
      assert.equal(completeKnowledgeManifest(manifest), false);
      assert.equal(publishableKnowledgeManifest(manifest, 77), false);
      assert.equal(generated.text, fixture.finalInterceptedResponse);
      assert.equal(await api.publish(generated.text), fixture.finalInterceptedResponse);
      assert.equal(events.some(e => e.reason === 'INVALID_CITATION'), false);
      for (const id of ['f1', 'f2']) assert.ok(events.some(e => e.stage === 'verification' && e.facetId === id && e.reason === 'MATERIAL_FACTS_MISSING'));
    });
    assert.deepEqual(stages, ['extraction', 'verification', 'composition']);
    assert.equal(actions, 0);
  } finally {
    for (const name of Object.keys(incidentConfig)) delete (incidentConfig as any)[name];
    Object.assign(incidentConfig, savedConfig);
    boundary.reset();
  }
});
