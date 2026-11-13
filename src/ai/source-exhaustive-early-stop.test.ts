import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, type Evidence } from './business-information-answer-plan';
import { runAccuracyFirstNative, nativeKnowledgeTiming } from './knowledge-timing-policy';

// SYNTHETIC tenant evidence. Covers the paths the six-language late-arrival
// matrix does not: freshness invalidation, complete inventories and other protocols.
const arrival = 'First-time visitors are recommended to arrive about 10 minutes before their booked time.';
const confirmation = 'Please bring your booking confirmation.';
const evidence: Evidence[] = [
  { id: 'e1', businessId: 3, sourceId: 's1', chunkId: 'c1', version: 'r1', text: arrival },
  { id: 'e2', businessId: 3, sourceId: 's2', chunkId: 'c2', version: 'r1', text: confirmation },
];
const question = 'What should I know before my first visit to the studio?';
const unit = (text: string, evidenceId: string, exactQuote: string) => ({ facetIds: ['f1'], subject: 'first visit', predicate: 'preparation',
  value: text, text, scope: 'first-time visitors', qualifiers: [], negation: false, modality: 'recommended', language: 'en',
  evidenceRefs: [{ evidenceId, exactQuote }] });
const verdict = (data: any) => JSON.stringify({
  decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true,
    qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
  coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
    materialUnitIds: data.units.map((u: any) => u.id),
    obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })),
  sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true,
    conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: data.units.map((u: any) => u.id),
    obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: 'COMPLETE' }))) } });

async function run(t: any, options: { units: unknown[]; protocol?: 'source-exhaustive-v2'; fresh?: (call: number) => Evidence[] }) {
  const saved = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'off';
  t.after(() => { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = saved; });
  const stages: string[] = [], events: any[] = [];
  let manifest: any, calls = 0;
  const facets = parseRequestedFacets([{ subject: 'first visit', attribute: 'preparation before the first visit', questionType: 'description' }]).facets;
  await runAccuracyFirstNative(async () => {
    manifest = await buildEvidenceFirstAnswer({ businessId: 3, question, language: 'en', facets, evidence, foreground: true, extractionProtocol: 'v2',
      ...(options.protocol ? { verificationProtocol: options.protocol } : {}), authoritativeEvidence: '{}', businessTone: {}, history: [],
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true,
      revalidateEvidence: async () => options.fresh ? options.fresh(++calls) : evidence,
      diagnostic: e => events.push({ stage: e.stage, reason: e.reason, unitId: e.unitId }),
      generate: async (stage, _instruction, data: any) => {
        stages.push(stage);
        if (stage === 'extraction') return { text: JSON.stringify({ oversized: false, units: options.units }) };
        return { text: verdict(data) };
      } } as any);
  }, async () => assert.fail('unexpected native timeout'));
  return { stages, events, manifest };
}

test('source-exhaustive: a parse-rejected proposal stops before paid Verification with the same fallback', async t => {
  const r = await run(t, { protocol: 'source-exhaustive-v2', units: [unit('Arrive about 10 minutes early.', 'e1', arrival),
    unit('Bring your passport.', 'e2', 'Please bring your passport.')] });
  assert.deepEqual(r.stages, ['extraction']);
  assert.equal(r.manifest.fallbackReason, 'INVALID_COVERAGE');
  assert.equal(r.manifest.units.length, 0);
  assert.ok(r.events.some(e => e.stage === 'extraction' && e.unitId === 'u2' && e.reason !== 'ACCEPTED'), JSON.stringify(r.events));
  assert.ok(r.events.some(e => e.stage === 'verification' && e.reason === 'INVALID_COVERAGE'));
});

test('source-exhaustive: a source invalidated after extraction also stops before Verification', async t => {
  const r = await run(t, { protocol: 'source-exhaustive-v2', fresh: call => call === 1 ? evidence : [evidence[0]],
    units: [unit('Arrive about 10 minutes early.', 'e1', arrival), unit('Bring your booking confirmation.', 'e2', confirmation)] });
  assert.deepEqual(r.stages, ['extraction']);
  assert.notEqual(r.manifest.presentationPath, 'direct_verified_units');
  assert.equal(r.manifest.units.length, 0);
});

test('source-exhaustive: a complete inventory is still independently verified', async t => {
  const r = await run(t, { protocol: 'source-exhaustive-v2',
    units: [unit('Arrive about 10 minutes early.', 'e1', arrival), unit('Bring your booking confirmation.', 'e2', confirmation)] });
  assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.ok(!r.events.some(e => e.stage === 'verification' && e.reason === 'INVALID_COVERAGE'), JSON.stringify(r.events));
});

test('other protocols keep verifying after a parse rejection (no early stop)', async t => {
  const r = await run(t, { units: [unit('Arrive about 10 minutes early.', 'e1', arrival),
    unit('Bring your passport.', 'e2', 'Please bring your passport.')] });
  assert.deepEqual(r.stages, ['extraction', 'verification']);
});
