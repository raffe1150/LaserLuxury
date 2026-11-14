import { HELD_OUT } from '../phase4/held-out';
import { context, NOW } from '../phase4/fixtures';
import { evaluateHeldOut } from '../phase4/semantic-eval';
import { CORPUS } from '../evaluation/corpus';
import { finishTurn, prepareTurn } from '../memory/conversation-memory';
import type { TurnFrame } from '../memory/turn-frame';
import type { Field } from '../semantic/contracts';
import { createInterpretationAdapter } from '../semantic/model-adapter';
import { isRoute } from '../semantic/interpret';

export const completion = {
  sv: 'Tack, nu har jag fått den hjälp jag behövde.',
  en: 'That takes care of everything. Thanks for your help!',
  de: 'Danke, damit sind alle meine Fragen geklärt.',
  es: 'Gracias, con eso tengo todo lo que necesitaba.',
  fa: 'ممنون، دیگر سؤالی ندارم و همین کافی است.',
  ar: 'شكرًا، حصلت على كل ما أحتاج إليه.',
} as const;

const deterministicMisses: Readonly<Record<string, readonly string[]>> = {
  'sv:1': ['intent abstention', 'missing decomposition', 'condition and modality omitted'],
  'sv:2': ['intent abstention', 'lost ordinal reference'],
  'de:1': ['intent abstention', 'missing decomposition', 'negative premise omitted', 'cancellation intent missed'],
  'es:1': ['intentionally unsupported business-information interpretation'],
  'es:2': ['booking intent missed', 'ambiguous clock not identified'],
  'es:3': ['intent abstention', 'earlier goal reference lost'],
  'fa:1': ['intent abstention', 'condition and requirement omitted'],
  'fa:2': ['generic intent clarification instead of date-alternative conflict'],
  'ar:1': ['intent abstention', 'missing decomposition', 'negated action and recommendation omitted'],
  'ar:2': ['intent abstention', 'condition, requirement and reference omitted'],
};

function locate(text: string, phrase: string) {
  const start = text.indexOf(phrase);
  if (start < 0) throw new Error('Unknown fixture anchor');
  return { start, end: start + phrase.length };
}

/** The scripted lane encodes the independent answer key. It tests the adapter
 * and reducer. It cannot estimate how often a real model will match the key. */
export async function evaluateSemantics() {
  const baseline = await evaluateHeldOut();
  const rows = [];
  for (const suite of HELD_OUT) {
    let literalFrame: TurnFrame | undefined;
    let scriptedFrame: TurnFrame | undefined;
    const turns = [...suite.turns, { text: completion[suite.language],
      expected: [{ anchor: completion[suite.language], intent: 'close' as const }] }];
    for (const [i, item] of turns.entries()) {
      if (CORPUS.some(c => c.turns.includes(item.text))) throw new Error('Evaluation overlap with Phase 2');
      const expected = item.expected.map(e => {
        const entities: Partial<Record<Field, ReturnType<typeof locate>>> = {};
        if (suite.language === 'en' && e.intent === 'new_booking') {
          for (const [field, literal] of Object.entries({ service: 'haircut', staff: 'Alex', date: 'next Tuesday', time: '14:20' }))
            entities[field as Field] = locate(item.text, literal);
        }
        if (suite.language === 'en' && e.intent === 'correction') entities.date = locate(item.text, 'Thursday');
        return {
          intent: e.intent, span: locate(item.text, e.anchor),
          questionType: 'questionType' in e ? e.questionType : undefined,
          polarity: 'negative' in e && e.negative ? 'negative' : undefined,
          premise: 'premise' in e ? locate(item.text, e.premise) : undefined,
          conditions: 'condition' in e ? [{ kind: 'if', explicit: true, span: locate(item.text, e.condition) }] : [],
          // On the Arabic follow-up, the earlier booking and information
          // goals occupy separate slots. The receipt refers to information.
          reference: 'reference' in e ? (suite.language === 'ar' && i === 1 ? 1 : e.reference) : undefined, missing: 'missing' in e ? e.missing : undefined,
          change: e.intent === 'correction' ? ['date'] : undefined, entities,
        };
      });
      const turnContext = { ...context, turn: i + 1, nowMs: NOW + i * 1000,
        binding: { ...context.binding, conversationId: 'phase5-' + suite.language },
        language: { deterministicLanguage: suite.language, explicitSwitch: 'switchTo' in item ? item.switchTo : undefined } };
      const literal = finishTurn(await prepareTurn(literalFrame, turnContext, item.text));
      const handle = await prepareTurn(scriptedFrame, turnContext, item.text);
      const adapter = createInterpretationAdapter(async () => JSON.stringify({ version: 1, readings: expected }));
      const scripted = finishTurn(handle, await adapter(handle.request!, new AbortController().signal));
      literalFrame = literal.frame;
      scriptedFrame = scripted.frame;
      const language = turns.slice(0, i + 1).reduce<string>((lang, turn) => 'switchTo' in turn ? turn.switchTo : lang, suite.language);
      const old = baseline.find(b => b.language === suite.language && b.turn === i + 1);
      const measure = (r: typeof literal, exact: boolean) => {
        const allowedRoutes = expected.filter(e => isRoute(e.intent) && e.polarity !== 'negative' && !e.missing).map(e => e.intent);
        const unsafeRoute = r.guidance.some(g => g.kind === 'REFER_TO_BOOKING_AUTHORITY' && !allowedRoutes.includes(g.route));
        const clarificationExpected = expected.some(e => e.missing || e.polarity === 'negative' && isRoute(e.intent));
        return { exact, primary: r.readings[0]?.intent === expected[0].intent,
          obligationCountMatches: r.readings.length === expected.length, languageMatches: r.frame.language.language === language,
          clarificationExpected, clarificationProposed: r.guidance.some(g => g.kind === 'ASK' || g.kind === 'WAIT_FOR_CLARIFICATION'),
          unsafeRoute, guidance: r.guidance, actual: r.readings };
      };
      rows.push({ language: suite.language, turn: i + 1, text: item.text, expected,
        deterministicMisses: old?.exactMatches ? [] : deterministicMisses[suite.language + ':' + (i + 1)] ?? ['completion unsupported'],
        deterministic: measure(literal, old?.exactMatches ?? literal.frame.lifecycle === 'CLOSED'),
        scripted: measure(scripted, JSON.stringify(scripted.readings) === JSON.stringify(expected) ||
          // The decoder normalizes field order. Compare all fields independently.
          scripted.readings.length === expected.length && scripted.readings.every((r, j) =>
            Object.entries(expected[j]).every(([key, value]) => JSON.stringify(r[key as keyof typeof r]) === JSON.stringify(value)))),
      });
    }
  }
  const byLanguage = Object.fromEntries(HELD_OUT.map(({ language }) => [language, {
    turns: rows.filter(r => r.language === language).length,
    ...Object.fromEntries((['deterministic', 'scripted'] as const).map(lane => {
      const data = rows.filter(r => r.language === language).map(r => r[lane]);
      return [lane, { exact: data.filter(r => r.exact).length, primaryIntentErrors: data.filter(r => !r.primary).length,
        obligationCountMatches: data.filter(r => r.obligationCountMatches).length,
        clarificationMatches: data.filter(r => r.clarificationExpected === r.clarificationProposed).length, languageMatches: data.filter(r => r.languageMatches).length,
        unsafeRoutes: data.filter(r => r.unsafeRoute).length }];
    })),
  }]));
  return { byLanguage, rows, genuineModelAccuracy: 'UNMEASURED' };
}
