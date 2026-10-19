import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from './business-information';

/** Only separate independently understood literal clauses. Never synthesize an
 * action, infer its target from the question, or execute multiple action clauses. */
export function splitMixedBusinessRequest(text: string, isAction = isExplicitBusinessActionRequest): { action: string; information: string } | null {
  const clauses: Array<{ text: string; start: number; before: number }> = [];
  let start = 0, before = 0;
  for (const boundary of text.matchAll(/(?<=[.!?؟؛;])\s+|\n+|\s+(?:and|och|und|y|و)\s+/giu)) {
    clauses.push({ text: text.slice(start, boundary.index).trim(), start, before });
    before = boundary.index;
    start = boundary.index + boundary[0].length;
  }
  clauses.push({ text: text.slice(start).trim(), start, before });
  if (clauses.length < 2 || clauses.length > 6) return null;
  const actions = clauses.map((s,i) => isAction(s.text) ? i : -1).filter(i => i >= 0);
  const information = clauses.map((s,i) => !isAction(s.text) && isBusinessInformationQuestion(s.text) ? i : -1).filter(i => i >= 0);
  if (actions.length !== 1 || !information.length) return null;
  const actionIndex = actions[0];
  // Slice original spans, rather than rejoining clauses: "between Tuesday and
  // Friday" and catalog labels containing conjunctions must stay byte-for-byte.
  if (actionIndex < information[0]) return {
    action: text.slice(0, clauses[information[0]].before).trim(),
    information: text.slice(clauses[information[0]].start).trim(),
  };
  if (actionIndex > information.at(-1)!) return {
    action: text.slice(clauses[actionIndex].start).trim(),
    information: text.slice(0, clauses[actionIndex].before).trim(),
  };
  return null;
}

/** Reference recognition is not reference resolution and never supplies facts. */
export function hasConversationReference(text: string): boolean {
  return /(?<![\p{L}\p{M}])(?:it|that|there|this|them|same\s+place|det|den|där|samma\s+plats|das|dort|demselben\s+ort|eso|all[ií]|mismo\s+lugar|آنجا|آن|همان\s+مکان|هناك|ذلك|نفس\s+المكان)(?![\p{L}\p{M}])/iu.test(text);
}

/** No factual or booking claims: these are requests for a missing referent. The
 * second attempt gives a concrete instruction instead of repeating the question. */
export function referenceClarificationReply(language: string, repeated = false): string {
  const copy: Record<string, [string, string]> = {
    en: ['What are you referring to, and which place do you mean?', 'Please name what you mean and the specific place so I can help.'],
    sv: ['Vad syftar du på, och vilken plats menar du?', 'Ange det du syftar på och den specifika platsen, så att jag kan besvara frågan.'],
    de: ['Worauf beziehen Sie sich, und welchen Ort meinen Sie?', 'Bitte nennen Sie den konkreten Gegenstand und Ort Ihrer Frage, damit ich sie beantworten kann.'],
    es: ['¿A qué te refieres y de qué lugar hablas?', 'Indica concretamente a qué te refieres y el lugar para que pueda responder.'],
    fa: ['منظورتان چه چیزی و کدام مکان است؟ لطفاً مشخص کنید تا بتوانم پاسخ بدهم.', 'لطفاً موضوع و مکان مورد نظرتان را به‌طور مشخص نام ببرید تا بتوانم پاسخ بدهم.'],
    ar: ['ما المقصود، وأي مكان تعني؟ يرجى تحديدهما حتى أتمكن من الإجابة عن سؤالك.', 'يرجى ذكر الموضوع والمكان المقصودين تحديدًا حتى أتمكن من الإجابة.'],
  };
  return (copy[language] || copy.en)[repeated ? 1 : 0];
}

export function mixedActionClarificationReply(language: string): string {
  const copy: Record<string, string> = {
    en: 'Which service or appointment would you like help with?',
    sv: 'Vilken tjänst eller bokning vill du ha hjälp med?',
    de: 'Bei welcher Leistung oder welchem Termin möchten Sie Hilfe?',
    es: 'Para realizar lo que pides, ¿a qué servicio o cita te refieres?',
    fa: 'برای انجام درخواستتان، منظورتان کدام خدمت یا نوبت است؟',
    ar: 'لتنفيذ طلبك، أي خدمة أو موعد تقصد؟',
  };
  return copy[language] || copy.en;
}

/** Literal preparation only. Semantic reference resolution and mutation
 * authorization remain in their existing engines; this is not a TurnDecision. */
export type LiteralTurnPreparation = Readonly<{
  kind: 'single' | 'mixed';
  clauses: readonly Readonly<{ kind: 'action' | 'information' | 'unclassified'; text: string }>[];
  executionOrder: readonly number[];
}>;

export function prepareLiteralTurn(text: string, isAction = isExplicitBusinessActionRequest): LiteralTurnPreparation {
  const mixed = splitMixedBusinessRequest(text, isAction);
  if (!mixed) return Object.freeze({ kind: 'single', clauses: Object.freeze([
    Object.freeze({ kind: 'unclassified' as const, text }),
  ]), executionOrder: Object.freeze([0]) });
  const actionFirst = text.startsWith(mixed.action);
  const action = Object.freeze({ kind: 'action' as const, text: mixed.action });
  const information = Object.freeze({ kind: 'information' as const, text: mixed.information });
  return Object.freeze({ kind: 'mixed',
    clauses: Object.freeze(actionFirst ? [action, information] : [information, action]),
    executionOrder: Object.freeze(actionFirst ? [0, 1] : [1, 0]),
  });
}

export type SharedTurnExecutionResult =
  | Readonly<{ kind: 'handled'; preparation: LiteralTurnPreparation }>
  | Readonly<{ kind: 'information_prepared'; preparation: LiteralTurnPreparation; question: string }>
  | Readonly<{ kind: 'continue_conversation'; preparation: LiteralTurnPreparation }>;
