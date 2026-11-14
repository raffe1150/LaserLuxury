import type { AnswerUnit } from '../../business-information-answer-plan';
import { context, inventory, NOW, reviewed, scriptedCase } from '../phase4/fixtures';
import { shadowTurn } from '../phase4/pipeline';
import { composeResponse } from '../response/compose';
import { loadRecorded, replay } from '../evaluation/tier2';
import { completion } from './semantic-eval';

export const readingWire = (readings: readonly unknown[]) => JSON.stringify({ version: 1, readings });
const anchor = (text: string, part = text) => ({ start: text.indexOf(part), end: text.indexOf(part) + part.length });
const empty = { initial: () => ({ candidates: [], receipts: [] }) };

export async function reviewFixture(id: 'var-cmp-01-sv' | 'rep-04' = 'rep-04') {
  const f = scriptedCase(id);
  const result = await shadowTurn({ ...f, evidence: { inventory, initial: ([first]) => reviewed(first, f.unit) } });
  return { f, result, input: { ...result, current: { ...f.context.binding, turn: 1, nowMs: NOW,
    language: result.semantic.frame.language.language, inventory } } };
}

export async function evaluateResponses() {
  const partial = await reviewFixture();
  const response = composeResponse(partial.input)!;
  const recorded = loadRecorded().find(r => r.id === 'rec-shared-core-de-20261022')!;
  const v1 = await replay(recorded);
  const intake = 'Can you book a haircut for tomorrow at three?';
  const a = await shadowTurn({ context, text: intake, wire: readingWire([{
    intent: 'new_booking', span: anchor(intake), entities: { service: anchor(intake, 'haircut'), date: anchor(intake, 'tomorrow'),
      time: anchor(intake, 'at three') },
  }]), evidence: empty });
  const correction = 'Actually, Friday would be better.';
  const b = await shadowTurn({ frame: a.semantic.frame, context: { ...context, turn: 2 }, text: correction,
    wire: readingWire([{ intent: 'correction', span: anchor(correction), reference: 0, change: ['date'],
      entities: { date: anchor(correction, 'Friday') } }]), evidence: empty });
  const time = '15:00';
  const c = await shadowTurn({ frame: b.semantic.frame, context: { ...context, turn: 3 }, text: time, evidence: empty });
  const again = await shadowTurn({ frame: a.semantic.frame, context: { ...context, turn: 2 }, text: 'Three.',
    wire: readingWire([{ intent: 'new_booking', reference: 0, span: anchor('Three.'), missing: 'time' }]), evidence: empty });
  const closure = await shadowTurn({ context, text: completion.en, wire: readingWire([{ intent: 'close', span: anchor(completion.en) }]), evidence: empty });
  const compose = (r: typeof a) => composeResponse({ ...r, current: { ...context.binding, turn: r.semantic.frame.turn, nowMs: NOW, language: 'en' } })!;
  const premise = 'Is the customer entrance at the main entrance on the street?';
  const quote = 'Studions entré ligger på innergården, inte vid huvudingången mot gatan.';
  const text = 'The studio entrance is in the courtyard, away from the main street entrance.';
  const p = await shadowTurn({ context, text: premise,
    wire: readingWire([{ intent: 'general_question', questionType: 'description', span: anchor(premise), premise: anchor(premise) }]),
    evidence: { inventory, initial: ([scope]) => {
      const chunk = inventory.chunks[0];
      if (!chunk.text.includes(quote)) throw new Error('Missing reviewed entrance quote');
      const unit: AnswerUnit = { id: 'entrance', facetIds: ['entrance'], verification: 'PROPOSED', modality: 'descriptive',
        negation: true, qualifiers: [], scope: 'studio entrance', subject: 'studio entrance', predicate: 'location',
        value: 'courtyard, excluding the main street entrance', language: 'en', text,
        evidenceRefs: [{ evidenceId: chunk.id, sourceId: chunk.sourceId, chunkId: chunk.chunkId, version: chunk.version, exactQuote: quote }] };
      const batch = reviewed(scope, unit);
      return { ...batch, receipts: batch.receipts.map(r => ({ ...r, correctPremise: true })) };
    } },
  });
  return { partial: response, booking: [a, b, c].map(r => ({ response: compose(r),
    parameters: r.semantic.frame.goals.find(g => g.kind === 'booking')?.parameters })),
    repeatedClarification: compose(again), closure: compose(closure), premiseCorrection: composeResponse({ ...p, current: { ...context.binding, turn: 1, nowMs: NOW, language: 'en', inventory } })!,
    comparison: { v1GermanReplay: { id: recorded.id, drift: v1.drift, publishedUnits: v1.units.length }, v2VerifiedFactsExpressed: response.blocks.filter(b => b.kind === 'fact').length,
      v2UnresolvedObligationsDisclosed: response.blocks.filter(b => b.kind === 'uncertainty').length },
  };
}
