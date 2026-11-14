import type { AnswerUnit } from '../../business-information-answer-plan';
import { hashRecord, type Inventory, type Receipt, type Scope } from '../evidence/bind';
import { CORPUS } from '../evaluation/corpus';
import { fact } from '../evaluation/facts';
import { source } from '../evaluation/sources';
import { loadRecorded } from '../evaluation/tier2';
import type { TurnContext } from '../memory/conversation-memory';
import { recordedInput } from '../shadow/recorded-input';

export const NOW = Date.parse('2026-11-16T08:00:00Z');
export const context: TurnContext = {
  binding: { tenantId: 3, conversationId: 'offline-phase4' }, turn: 1, timezone: 'Europe/Stockholm', nowMs: NOW,
  catalog: { services: [{ id: 'cut', label: 'haircut' }], staff: [{ id: 'staff-a', label: 'Alex' }] },
};
const arrival = fact('t3.arrive-10');
const current = source(arrival.source);
const chunk = { id: 'trusted-chunk', sourceId: current.sourceId, businessId: current.tenantId, version: current.revision,
  chunkId: hashRecord(current.text), text: current.text };
export const inventory: Inventory = { tenantId: 3, checkedAtMs: NOW, revisions: [{ sourceId: chunk.sourceId, revision: chunk.version }], chunks: [chunk] };

export function arrivalUnit(language: 'sv' | 'de'): AnswerUnit {
  const ref = { evidenceId: chunk.id, sourceId: chunk.sourceId, chunkId: chunk.chunkId, version: chunk.version, exactQuote: arrival.quote! };
  if (language === 'de') {
    const recording = loadRecorded().find(r => r.id === 'rec-shared-core-de-20261022')!;
    const c = CORPUS.find(c => c.id === recording.caseId)!;
    if (!recordedInput(c, recording).independentlyRebound.includes(arrival.id)) throw new Error('Recorded source review unavailable');
    const unit = JSON.parse(recording.outputs.extraction!).units[0];
    // Preserve recorded claim text. Only the offline adapter replaces the
    // legacy citation with the explicit, independently reviewed binding.
    return { ...unit, id: arrival.id, verification: 'PROPOSED', qualifiers: [...(arrival.conditions ?? []), ...unit.qualifiers], evidenceRefs: [ref] };
  }
  return { id: arrival.id, facetIds: ['arrival'], subject: 'first visit', predicate: 'arrival recommendation',
    value: 'approximately ten minutes early', verification: 'PROPOSED', modality: arrival.modality,
    negation: arrival.negation, scope: 'first visit', qualifiers: arrival.conditions ?? [], language,
    text: arrival.quote!, evidenceRefs: [ref] };
}

export function reviewed(scope: Scope, unit: AnswerUnit) {
  // Offline stand-in for the independent review port. Only call with the
  // known reviewed unit; controls tamper with the candidate after this step.
  const receipt: Receipt = { scope: { ...scope }, checkedAtMs: NOW, coverage: 'COMPLETE', conflict: 'CLEAR', correctPremise: false,
    units: [{ id: unit.id, digest: hashRecord(unit), modality: unit.modality, negated: unit.negation, conditions: unit.qualifiers,
      relation: 'ENTAILED', citations: [{ evidenceId: chunk.id, digest: hashRecord(chunk) }] }] };
  return { candidates: [{ obligationId: scope.obligationId, units: [unit] }], receipts: [receipt] };
}

export function scriptedCase(id: 'var-cmp-01-sv' | 'rep-04') {
  const c = CORPUS.find(c => c.id === id)!;
  const text = c.turns.at(-1)!;
  const split = id === 'rep-04' ? text.indexOf('und muss') : text.indexOf('Behöver');
  if (split < 1) throw new Error('Missing independent obligation anchor');
  const wire = JSON.stringify({ version: 1, readings: [
    { intent: 'general_question', span: { start: 0, end: split }, questionType: 'recommendation' },
    { intent: 'general_question', span: { start: split, end: text.length }, questionType: 'requirement' },
  ] });
  return { id, text, wire, context: { ...context, language: { deterministicLanguage: c.language } },
    unit: arrivalUnit(id === 'rep-04' ? 'de' : 'sv') };
}
