/** Saved real outputs and explicitly scripted diagnostic envelopes only.
 * These tests make no provider requests and cannot establish model usefulness. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, answerEvidence, publishableKnowledgeManifest,
  completeKnowledgeManifest, pruneAnswerManifest, NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE } from './business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import { configuredServiceEvidence } from './configured-service-evidence';
import { knowledgeStructuredOutput, selectKnowledgeVerificationProtocol, type KnowledgeVerificationProtocol } from './knowledge-answer-protocol';
const base = 'docs/validation/shared-core-2026-10-22';
const folders = { 'A-en': 'aen-accuracy-first-acceptance-20261025', 'B-en': 'ben-direct-acceptance-20261025',
  'C-en': 'cen-direct-acceptance-20261025', 'A-sv': 'asv-direct-acceptance-20261025' } as const;
type Case = keyof typeof folders;
const read = (name: string) => JSON.parse(readFileSync(name, 'utf8'));
const records: any[] = [];
after(() => { if (process.env.ODINLINK_COVERAGE_WITNESS_RESULTS) writeFileSync(process.env.ODINLINK_COVERAGE_WITNESS_RESULTS,
  JSON.stringify({ providerCalls: 0, judgments: 'saved real replay; witness claims and faults SCRIPTED', records }, null, 2), { flag: 'wx' }); });
type Options = {
  protocol?: KnowledgeVerificationProtocol; witness?: (raw: any) => void;
  fault?: 'bad-citation' | 'wrong-alias' | 'missing-quote' | 'foreign' | 'revoked' | 'stale' | 'timeout' | 'unknown' | 'contradicted';
  forceComplete?: boolean; flipEnvironment?: boolean;
};
async function replay(caseId: Case, options: Options = {}) {
  const saved = read(`${base}/${folders[caseId]}/${caseId}.result.json`);
  const ex = saved.state.calls.find((c: any) => c.stage === 'extraction'), vc = saved.state.calls.find((c: any) => c.stage === 'verification');
  const vi = JSON.parse(vc.request.input[0].content), context = JSON.parse(ex.request.input[0].content);
  const proposal = JSON.parse(ex.outputText), verdict = JSON.parse(vc.outputText);
  const fresh = saved.retrieval.filter((r: any) => r.phase === 'freshness').at(-1).matches;
  const matches = vi.evidence.filter((e: any) => e.id !== 'configured-services').map((e: any) => {
    const m = fresh.find((m: any) => m.text.trim() === e.text.trim()); assert.ok(m); return { ...m, text: e.text };
  });
  let evidence = answerEvidence(77, matches), verificationDone = false;
  const catalog = vi.evidence.find((e: any) => e.id === 'configured-services');
  if (catalog) evidence.push(configuredServiceEvidence(77, JSON.parse(catalog.text).services)!);
  if (options.fault === 'foreign') evidence = answerEvidence(77, matches.map((m: any) => ({ ...m, businessId: 88 })));
  if (options.fault === 'bad-citation') proposal.units[0].evidenceRefs[0].exactQuote = 'Not present in any source.';
  if (options.fault === 'wrong-alias') proposal.units[0].evidenceRefs[0].evidenceId = 'e4';
  if (options.fault === 'missing-quote') delete proposal.units[0].evidenceRefs[0].exactQuote;
  let result: any;
  await runAccuracyFirstNative(async () => {
    const facets = parseRequestedFacets(vi.facets).facets, events: any[] = [], stages: string[] = [];
    // A primitive captured once controls both builder and provider schema, even
    // if environment configuration changes while extraction is queued.
    const protocol = options.protocol ?? selectKnowledgeVerificationProtocol();
    const manifest = await buildEvidenceFirstAnswer({ question: vi.question, language: vi.requestedLanguage, facets, evidence,
      verificationProtocol: protocol, foreground: true, omitModelEvidenceVersions: true,
      authoritativeEvidence: vi.authoritativeEvidence, businessTone: context.businessTone, history: context.relevantHistory,
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true,
      languageSafe: u => u.language === vi.requestedLanguage, diagnostic: e => events.push(e),
      revalidateEvidence: async () => verificationDone && options.fault === 'revoked' ? [] : verificationDone && options.fault === 'stale'
        ? evidence.map(e => ({ ...e, version: e.version + '-changed' })) : evidence,
      generate: async (stage, instruction, data: any) => {
        stages.push(stage);
        if (stage === 'extraction') {
          assert.equal(data.question, context.question, 'Existing source-aware document projection unchanged');
          if (options.flipEnvironment) { process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'v2'; process.env.ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION = 'true'; }
          return { text: JSON.stringify(proposal) };
        }
        assert.equal(stage, 'verification', 'No new composition or verifier call');
        assert.equal(data.question, vi.question, 'Verifier always sees complete original request');
        if (options.fault === 'timeout') throw Object.assign(new Error('synthetic deadline'), { category: 'TIMEOUT' });
        const raw = structuredClone(verdict);
        const ids = data.units.map((u: any) => u.id);
        raw.decisions = raw.decisions.filter((d: any) => ids.includes(d.unitId));
        if (options.forceComplete) for (const c of raw.coverage) {
          c.materialFactsComplete = true; c.incompletenessReason = 'NONE'; c.materialUnitIds = ids;
          for (const o of c.obligations) { o.status = 'COVERED'; o.unitIds = ids; }
        }
        if (options.fault === 'unknown' || options.fault === 'contradicted') raw.decisions[0].relation = options.fault === 'unknown' ? 'UNKNOWN' : 'CONTRADICTED';
        if (protocol === 'coverage-witness-v1') {
          assert.match(instruction, /Coverage witness v1/u);
          assert.equal(knowledgeStructuredOutput('verification', false, undefined, 6, protocol).name, 'odinlink_knowledge_verification_witness_v1');
          raw.coverageWitnesses = raw.coverage.flatMap((c: any) => c.obligations.filter((o: any) => o.status === 'UNRESOLVED').map((o: any) => ({
            facetId: c.facetId, obligationId: o.obligationId, reason: c.incompletenessReason,
            location: { kind: 'QUESTION_SPAN', quote: caseId === 'A-sv' ? 'om jag har fått dem' :
              vi.question.split(/(?<=[?؟])\s+/u)[caseId === 'B-en' ? 1 : 0] },
          })));
          options.witness?.(raw);
          // Facts, source text and question are identical to the saved request;
          // only the new output envelope and intentional fault injections vary.
          if (!options.fault) assert.deepEqual(data, vi);
        } else {
          assert.equal(instruction, vc.request.instructions+(caseId==='B-en'?'':'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE)); assert.deepEqual(data, vi);
          assert.deepEqual({ type: 'json_schema', ...knowledgeStructuredOutput('verification', false, undefined, 6, protocol) }, vc.request.text.format);
        }
        verificationDone = true; return { text: JSON.stringify(raw) };
      },
    });
    const current = pruneAnswerManifest(manifest, options.fault === 'revoked' ? [] : options.fault === 'stale'
      ? evidence.map(e => ({ ...e, version: e.version + '-changed' })) : evidence);
    result = { caseId, protocol, fault: options.fault || null, stages, events, manifest: current,
      allowed: publishableKnowledgeManifest(current, 77), complete: completeKnowledgeManifest(current) };
    records.push(result);
  }, async () => {});
  assert.ok(result); return result;
}

for (const caseId of Object.keys(folders) as Case[]) test(`default v2 ${caseId} preserves frozen input/schema/verdict with scoped instructions`, async () => {
  const x = await replay(caseId, { protocol: 'v2' }); assert.equal(x.allowed, caseId !== 'A-sv');
  assert.equal(x.complete, caseId === 'A-en'); assert.ok(!x.events.some((e: any) => e.coverageWitness));
  if (caseId === 'A-sv') {
    assert.equal(x.manifest.units.length, 5); assert.equal(x.manifest.outcomes[0].obligations[0].status, 'UNRESOLVED');
    assert.ok(x.events.some((e: any) => e.incompletenessReason === 'MISSING_CONDITION'));
  }
});
for (const caseId of Object.keys(folders) as Case[]) test(`witness-v1 ${caseId} cannot elevate original outcome or leak witness into answer`, async () => {
  const original = await replay(caseId, { protocol: 'v2' }), x = await replay(caseId, { protocol: 'coverage-witness-v1' });
  assert.equal(x.allowed, original.allowed); assert.equal(x.complete, original.complete); assert.equal(x.manifest.text, original.manifest.text);
  assert.deepEqual(x.manifest.units, original.manifest.units); assert.deepEqual(x.manifest.outcomes, original.manifest.outcomes);
  assert.equal(x.events.find((e: any) => e.coverageWitness)?.coverageWitness.state, 'VALID');
  assert.ok(x.manifest.units.every((u: any) => u.verification === 'ENTAILED'));
  assert.doesNotMatch(x.manifest.text, /UNCONFIRMED_MODEL_CLAIM|coverageWitnesses|MISSING_CONDITION/u);
});
const invalid: Record<string, (raw: any) => void> = {
  absent: x => { delete x.coverageWitnesses; }, empty: x => { x.coverageWitnesses = []; },
  invented: x => { x.coverageWitnesses[0].location.quote = 'An invented customer requirement'; },
  wrongId: x => { x.coverageWitnesses[0].obligationId = 'f1.o9'; },
  duplicate: x => { x.coverageWitnesses.push(structuredClone(x.coverageWitnesses[0])); },
  unknown: x => { x.coverageWitnesses[0].location = { kind: 'UNLOCATED', reason: 'NO_RELIABLE_REQUEST_SPAN' }; },
};
for (const [name, witness] of Object.entries(invalid)) test(`invalid ${name} witness cannot acquire qualified-PARTIAL authority`, async () => {
  const x = await replay('B-en', { protocol: 'coverage-witness-v1', witness });
  assert.equal(x.allowed, false); assert.equal(x.manifest.units.length, 0); assert.equal(x.manifest.qualifiedPartial, undefined);
  assert.ok(x.manifest.outcomes.every((o: any) => !o.materialFactsComplete && o.obligations.every((d: any) => d.status === 'UNRESOLVED')));
  assert.ok(x.events.filter((e: any) => e.unitId && e.reason === 'ACCEPTED').length >= 5, 'Actual unit judgments retained before witness fail-closed');
});
test('unmodified saved A-sv response lacks v1 witness and stays fail-closed, with five ENTAILED judgments retained', async () => {
  const x = await replay('A-sv', { protocol: 'coverage-witness-v1', witness: raw => { delete raw.coverageWitnesses; } });
  assert.equal(x.allowed, false); assert.equal(x.manifest.units.length, 0);
  assert.equal(x.events.filter((e: any) => e.unitId && e.relation === 'ENTAILED' && e.reason === 'ACCEPTED').length, 5);
  assert.equal(x.events.find((e: any) => e.coverageWitness)?.reason, 'COVERAGE_WITNESS_INVALID');
});
test('COMPLETE plus inappropriate missing-condition witness cannot publish', async () => {
  const x = await replay('A-en', { protocol: 'coverage-witness-v1', witness: raw => raw.coverageWitnesses.push({
    facetId: 'f1', obligationId: 'f1.o1', reason: 'MISSING_CONDITION', location: { kind: 'QUESTION_SPAN', quote: 'if I have received them' },
  }) });
  assert.equal(x.allowed, false); assert.equal(x.complete, false); assert.equal(x.manifest.units.length, 0);
});
for (const fault of ['bad-citation','wrong-alias','missing-quote','foreign','revoked','stale','timeout','unknown','contradicted'] as const)
  test(`witness cannot bypass material/source/timeout guard: ${fault}`, async () => {
    const x = await replay('A-sv', { protocol: 'coverage-witness-v1', fault, forceComplete: true });
    assert.equal(x.allowed, false); assert.equal(x.complete, false);
    if (['bad-citation','wrong-alias','missing-quote'].includes(fault)) assert.ok(!x.manifest.units.some((u: any) => u.id === 'u1' && u.text.startsWith('Om du har fått')));
  });
test('environment changes during extraction cannot mix captured prompt/schema/parser', async t => {
  const keys = ['ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL','ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION'];
  const old = keys.map(k => process.env[k]); t.after(() => keys.forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]));
  process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'coverage-witness-v1'; delete process.env.ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION;
  const x = await replay('A-en', { flipEnvironment: true }); assert.equal(x.allowed, true); assert.equal(x.protocol, 'coverage-witness-v1');
});
