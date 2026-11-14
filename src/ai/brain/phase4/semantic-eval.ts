import { finishTurn, prepareTurn } from '../memory/conversation-memory';
import type { TurnFrame } from '../memory/turn-frame';
import { CORPUS } from '../evaluation/corpus';
import { HELD_OUT } from './held-out';

type Expected = typeof HELD_OUT[number]['turns'][number]['expected'][number];
const equals = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function locate(text: string, anchor: string) {
  const start = text.indexOf(anchor);
  if (start < 0) throw new Error('Missing held-out anchor');
  return { start, end: start + anchor.length };
}

export async function evaluateHeldOut() {
  const rows = [];
  for (const { language, turns } of HELD_OUT) {
    let frame: TurnFrame | undefined;
    for (const [i, item] of turns.entries()) {
      if (CORPUS.some(c => c.turns.some(turn => turn.trim() === item.text.trim())))
        throw new Error('Held-out turn overlaps Phase 2');
      const handle = await prepareTurn(frame, {
        binding: { tenantId: 3, conversationId: 'held-out-' + language },
        turn: i + 1, nowMs: Date.parse('2026-11-16T08:00:00Z') + i * 1000, timezone: 'Europe/Stockholm',
        catalog: { services: [{ id: 'cut', label: 'haircut' }], staff: [{ id: 'staff-a', label: 'Alex' }] },
        language: { deterministicLanguage: language, explicitSwitch: 'switchTo' in item ? item.switchTo : undefined },
      }, item.text);
      const r = finishTurn(handle);
      frame = r.frame;
      const expected = (item.expected as readonly Expected[]).map(x => ({
        intent: x.intent, questionType: 'questionType' in x ? x.questionType : null,
        negative: 'negative' in x && x.negative, premise: 'premise' in x ? locate(item.text, x.premise) : null,
        condition: 'condition' in x ? locate(item.text, x.condition) : null,
        reference: 'reference' in x ? x.reference : null, missing: 'missing' in x ? x.missing : null,
      }));
      const actual = r.readings.map(x => ({ intent: x.intent, questionType: x.questionType ?? null,
        negative: x.polarity === 'negative', premise: x.premise ?? null, condition: x.conditions?.[0]?.span ?? null,
        reference: x.reference ?? null, missing: x.missing ?? null }));
      rows.push({ language, turn: i + 1, expected, actual, primaryMatches: actual[0]?.intent === expected[0]?.intent,
        exactMatches: equals(actual, expected), languageMatches: frame.language.language === ('switchTo' in item ? item.switchTo : language),
        guidance: r.guidance.map(g => g.kind), repeatedQuestion: r.repeatedQuestion,
        context: { activeGoalId: r.frame.activeGoalId, references: r.frame.recent.at(-1)?.referencedGoalIds ?? [],
          bookingParameters: r.frame.goals.find(g => g.kind === 'booking')?.parameters ?? null },
        priorReferenceOptions: handle.request?.references.length ?? 0 });
    }
  }
  return rows;
}
