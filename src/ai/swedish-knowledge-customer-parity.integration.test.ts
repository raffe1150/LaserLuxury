import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { incidentChannels } from '../../tests/helpers/p0-incident-knowledge';
import { runSwedishCustomerEntry } from '../../tests/helpers/brain-v2-swedish-customer';
import { customerEntryWire } from '../../tests/helpers/brain-v2-native-wires';
import { CONDITIONAL_EXEMPTION_GUIDANCE } from './business-information-answer-plan';
import { swedishKnowledgeFixture as fixture } from '../../tests/helpers/brain-v2-knowledge';

process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY']) delete process.env[key];

function load(suffix: string) {
  const data = JSON.parse(readFileSync(new URL('../../tests/fixtures/brain-v2-swedish-knowledge-genuine' + suffix + '.json', import.meta.url), 'utf8'));
  for (const stage of ['extraction', 'verification']) {
    assert.equal(createHash('sha256').update(data[stage].outputText).digest('hex'), data[stage].outputSha256);
  }
  return data;
}
const full = load('-final');
const partial = load('-rerun');
const rejected = load('');
const question = fixture.first + ' ' + fixture.second;
const expected = JSON.parse(full.extraction.outputText).units.map((unit: { text: string }) => unit.text);
const controls = ['missing', 'contradiction', 'stale', 'foreign', 'numerical'] as const;
const cases = [...incidentChannels.flatMap(channel => (['full', 'partial'] as const).map(mode => ({ mode, channel }))),
  ...controls.map(mode => ({ mode, channel: 'telegram' as const }))];
for (const { mode, channel } of cases) {
  test(`Swedish customer parity: ${channel}/${mode}`, async t => {
    const calls: string[] = [];
    const capturedErrors: unknown[] = [];
    const saved = mode === 'partial' ? partial : mode === 'numerical' ? rejected : full;
    const { candidate, publication: route } = await runSwedishCustomerEntry(async (req, storage) => {
      try {
        const instruction = req.systemInstruction ?? '';
        const data = JSON.parse(req.messages[0].content);
        if (instruction.includes('UNIT EXTRACTION')) {
          calls.push('extraction');
          if (mode === 'full') customerEntryWire(req, 'extraction');
          assert.ok(instruction.includes(CONDITIONAL_EXEMPTION_GUIDANCE));
          assert.equal(data.question, question);
          assert.deepEqual(data.facets.map((facet: { questionType: string }) => facet.questionType), ['requirement', 'recommendation']);
          assert.deepEqual(data.evidence.map((e: { text: string }) => e.text), mode === 'missing' ? fixture.sources.slice(0, 1) : [...fixture.sources]);
          if (mode === 'missing') {
            // Counterfactual control. Never reuse a positive verdict for a changed inventory.
            const output = JSON.parse(saved.extraction.outputText);
            output.units = output.units.filter((unit: { facetIds: string[] }) => unit.facetIds.includes('f1'));
            return { text: JSON.stringify(output), functionCalls: [] };
          }
          return { text: saved.extraction.outputText, functionCalls: [] };
        }
        if (instruction.includes('BATCH ENTAILMENT')) {
          calls.push('verification');
          if (mode === 'full') customerEntryWire(req, 'verification');
          for (const unit of data.units) for (const ref of unit.evidenceRefs)
            assert.ok(data.evidence.find((item: { id: string }) => item.id === ref.evidenceId)?.text.includes(ref.exactQuote));
          if (mode === 'stale') {
            const source = (await storage.list(77)).find(source => source.id === 'bring')!;
            await storage.create({ ...source, title: 'bring-changed' });
          }
          if (mode === 'missing' || mode === 'contradiction') {
            const output = JSON.parse(saved.verification.outputText);
            if (mode === 'missing') {
              output.decisions = output.decisions.slice(0, 2);
              Object.assign(output.coverage[1], { materialFactsComplete: false, incompletenessReason: 'UNRESOLVED', materialUnitIds: [],
                obligations: [{ obligationId: 'f2.o1', status: 'UNRESOLVED', unitIds: [] }] });
            } else output.decisions[2].relation = 'CONTRADICTED';
            return { text: JSON.stringify(output), functionCalls: [] };
          }
          assert.deepEqual(data.units.map((u: { id: string }) => u.id),
            JSON.parse(saved.verification.outputText).decisions.map((row: { unitId: string }) => row.unitId));
          return { text: saved.verification.outputText, functionCalls: [] };
        }
        throw Error('UNEXPECTED_SWEDISH_STAGE');
      } catch (error) { capturedErrors.push(error); throw error; }
    }, { channel, missing: mode === 'missing', foreign: mode === 'foreign' });
    assert.deepEqual(capturedErrors, []);
    assert.deepEqual(calls, ['extraction', 'verification']);
    t.diagnostic(JSON.stringify({ channel, mode, route, reply: candidate }));
    if (mode === 'full' || mode === 'foreign') {
      assert.equal(route, 'verified_manifest');
      assert.equal(candidate, expected.join(' '));
    } else if (mode === 'partial' || mode === 'numerical') {
      assert.equal(route, 'partial_manifest');
      assert.ok(expected.slice(2).every((line: string) => candidate.includes(line)));
      assert.match(candidate, /15 minuter.*formuläret|formuläret.*15 minuter/u);
      assert.ok(expected.slice(0, 2).every((line: string) => !candidate.includes(line)));
    } else if (mode === 'missing') {
      assert.equal(route, 'partial_manifest');
      assert.ok(expected.slice(0, 2).every((line: string) => candidate.includes(line)));
      assert.doesNotMatch(candidate, /betalningskvitto/u);
      assert.match(candidate, /Vad ska jag ta med till besöket/u);
    } else {
      assert.ok(expected.slice(2).every((line: string) => !candidate.includes(line)));
    }
  });
}
