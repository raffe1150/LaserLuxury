import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { productionInventory } from '../../tests/helpers/multidoc-production-inventory';
import { packDocumentEvidence, DOCUMENT_EVIDENCE_LIMITS } from './document-evidence-packing';
import { formatRetrievedBusinessKnowledge } from './retrieved-knowledge-format';
import { answerEvidenceBindings } from '../ai/business-information-answer-plan';

// Evaluate the actual deployed function, not a reimplementation of its bug.
const baselineSource = execFileSync('git', ['show', 'f736834:server.ts'], { encoding: 'utf8', maxBuffer: 20_000_000 });
const baselineFunction = baselineSource.slice(baselineSource.indexOf('function formatRetrievedBusinessKnowledge('), baselineSource.indexOf('\ntype RankedKnowledgeMatch'));
const baseline = new Function('packDocumentEvidence', 'hierarchicalSearchEnabled', transformSync(baselineFunction, { loader: 'ts' }).code + '; return formatRetrievedBusinessKnowledge;')(packDocumentEvidence, () => false);

test('unmodified f736834 reproduces the exact captured two-PDF formatting loss', async () => {
  const old = await productionInventory('old'), added = await productionInventory('new'), both = await productionInventory();
  assert.equal(baseline(old.matches).length, 5208);
  assert.equal(baseline(added.matches).length, 4127);
  assert.equal(both.matches.length, 8);
  assert.equal(both.matches.reduce((n, m) => n + m.text!.length, 0), 7922);
  assert.equal(packDocumentEvidence(both.matches)!.length, 5);
  assert.equal(baseline(both.matches), '');
  const uncapped = new Function('packDocumentEvidence', 'hierarchicalSearchEnabled', transformSync(baselineFunction.replace('next.length > 9000', 'next.length > 1000000'), { loader: 'ts' }).code + ';return formatRetrievedBusinessKnowledge;')(packDocumentEvidence, () => false);
  assert.equal(uncapped(both.matches).length, 10301, 'Measurement only; the supported limit is unchanged');
});

for (const selection of ['old', 'new', 'both'] as const) test(`captured ${selection} inventory retains all source text and authoritative bindings`, async () => {
  const { matches } = await productionInventory(selection);
  const before = structuredClone(matches), bindings = answerEvidenceBindings(3, matches);
  const formatted = formatRetrievedBusinessKnowledge(matches);
  assert.equal(formatted.ok, true);
  if (!formatted.ok) return;
  assert.equal(formatted.serializedChars, { old: 5208, new: 4127, both: 8934 }[selection]);
  assert.ok(formatted.text.length <= DOCUMENT_EVIDENCE_LIMITS.totalChars);
  const texts = formatted.text.split('\n').filter(l => l.startsWith('untrusted_document_text:')).map(l => JSON.parse(l.slice('untrusted_document_text:'.length)));
  assert.deepEqual(texts, bindings.map(b => b.evidence.text));
  const revisions: Record<string,string> = {
    '8eec8b5c-87bc-4a7b-9789-b65d977b5ae4':'f221a237a54c651cdcb654309c4afa70577a02b6f556639e2c8dd667484182c1',
    '2ac009ba-c913-48bc-b13d-c09adf34c8e0':'4b86e3e3f6b07821689017b9a1d996c7c884ff7a8be96d8607a2a203af2cdaf1',
  };
  assert.ok(bindings.every(b => b.evidence.version === revisions[b.evidence.sourceId]), 'Captured production revisions are reconstructed exactly');
  assert.deepEqual(bindings.flatMap(b => b.matches), matches, 'No selected document/chunk may disappear');
  assert.deepEqual(matches, before, 'Formatting cannot mutate canonical metadata or facts');
  assert.deepEqual(answerEvidenceBindings(3, matches), bindings);
  for (const b of bindings) {
    assert.ok(formatted.text.includes(`source_id: ${b.evidence.sourceId}`));
    assert.ok(b.matches.every(m => m.businessId === 3 && m.sourceId === b.evidence.sourceId && m.metadata.documentRevision === b.evidence.version));
    if (b.matches.length > 1) assert.deepEqual(b.evidence.citationRanges!.map(r => b.evidence.text.slice(r.start, r.end)), b.matches.map(m => m.text));
  }
  if (selection !== 'new') assert.ok(texts.some(t => t.includes('fi ktiv')), 'Original document test-only qualification survives');
});

for (const target of [8999, 9000, 9001]) test(`actual serialized budget ${target}: all evidence or explicit refusal`, async () => {
  const { matches } = await productionInventory();
  // SYNTHETIC location padding only. Actual source passages remain byte-identical.
  const row = matches.at(-1)!;
  row.metadata = { ...row.metadata, section: '' };
  const initial = formatRetrievedBusinessKnowledge(matches);
  assert.equal(initial.ok, true);
  row.metadata.section = 's'.repeat(target - initial.serializedChars!);
  const result = formatRetrievedBusinessKnowledge(matches);
  assert.equal(result.serializedChars, target);
  assert.equal(result.ok, target <= 9000);
  if (result.ok === true) assert.equal(result.text.length, target);
  else { assert.equal(result.reason, 'EVIDENCE_FORMAT_OVERFLOW'); assert.ok(!('text' in result)); }
});

for (const fault of ['tenant', 'revision', 'missing-revision', 'group-capacity', 'item-capacity'] as const) test(`packing rejection is explicit and never a prefix: ${fault}`, async () => {
  const { matches } = await productionInventory();
  if (fault === 'tenant') matches[0].businessId = 9;
  if (fault === 'revision') matches[0].metadata!.documentRevision = 'changed';
  if (fault === 'missing-revision') delete matches[0].metadata!.documentRevision;
  if (fault === 'group-capacity') matches.splice(0, matches.length, ...[0, 3, 1, 4, 2, 5, 6, 7].map(i => matches[i]));
  if (fault === 'item-capacity') matches[0].text += 'x'.repeat(2401);
  const result = formatRetrievedBusinessKnowledge(matches);
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.reason, 'EVIDENCE_PACKING_FAILED');
  assert.ok(!('text' in result));
});

test('small inventory never silently truncates a source fact', async () => {
  const { matches } = await productionInventory('new');
  matches[0].text += 'x'.repeat(2401);
  assert.deepEqual(formatRetrievedBusinessKnowledge(matches), { ok: false, reason: 'EVIDENCE_ITEM_OVERFLOW', serializedChars: null });
});
test('quoted text, newlines and backslashes are budgeted after escaping without fact changes', async () => {
  const { matches } = await productionInventory('new');
  matches[1].text += '\n"SYNTHETIC escaping probe\\"';
  const result = formatRetrievedBusinessKnowledge(matches);
  assert.equal(result.ok, true);
  if (result.ok === true) {
    const lines = result.text.split('\n').filter(l => l.startsWith('untrusted_document_text:'));
    assert.deepEqual(lines.map(l => JSON.parse(l.slice('untrusted_document_text:'.length))), matches.map(m => m.text));
    assert.equal(result.serializedChars, result.text.length);
  }
});
test('empty inventory is genuinely empty rather than a formatting failure', () => {
  assert.deepEqual(formatRetrievedBusinessKnowledge([]), { ok: true, text: '', serializedChars: 0 });
});
