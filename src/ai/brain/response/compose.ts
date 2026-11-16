import { containsUnverifiedBookingSuccessClaim } from '../../reliability';
import { containsWebOperationSuccess } from '../../web-response-integrity';
import type { SupportedConversationLanguage } from '../../language-brain';
import type { TurnDecision } from '../decide-turn';
import { hashRecord, type Inventory } from '../evidence/bind';
import type { TurnResult } from '../memory/conversation-memory';
import { recheckShadowComposition } from '../phase4/pipeline';
import type { Binding } from '../semantic/contracts';
import { phrases } from './phrases';

const MAX_RESPONSE_CHARS = 1800;
const otherQuestion = { en: 'On your other question: ', sv: 'Om din andra fråga: ', de: 'Zu Ihrer anderen Frage: ',
  es: 'Sobre tu otra pregunta: ', fa: 'دربارهٔ سؤال دیگرتان: ', ar: 'بخصوص سؤالك الآخر: ' } as const;
const numbered = { en: 'Question', sv: 'Fråga', de: 'Frage', es: 'Pregunta', fa: 'سؤال', ar: 'السؤال' } as const;
type Block = Readonly<{ kind: 'fact' | 'uncertainty' | 'clarification' | 'handoff' | 'correction' | 'close';
  obligationIds: readonly string[]; factIds: readonly string[]; text: string }>;
export type CompositionInput = Readonly<{
  semantic: TurnResult;
  decision: TurnDecision;
  /** Trusted offline wording for a requirement question, without a factual answer. */
  swedishRequirementSubject?: Readonly<{ obligationId: string; clause: string }>;
  current: Readonly<Binding & { turn: number; nowMs: number; language: SupportedConversationLanguage; inventory?: Inventory }>;
}>;
export type ResponseCandidate = Readonly<{
  publication: 'OFFLINE_ONLY'; language: SupportedConversationLanguage; text: string; blocks: readonly Block[];
  withheld: readonly string[];
}>;

/** Only independently reviewed wording is eligible for factual blocks. The
 * caller supplies a current inventory separately from the earlier decision.
 * Optional free-form prose is deliberately outside this offline contract. */
export function composeResponse({ semantic, decision, current, swedishRequirementSubject }: CompositionInput): ResponseCandidate | null {
  const { language } = current;
  if (semantic.frame.language.language !== language || decision.publication !== 'OFFLINE_ONLY') return null;
  const checks = recheckShadowComposition(semantic, decision, current, current.turn, current.nowMs, current.inventory);
  if (!checks) return null;
  const copy = phrases[language];
  const blocks: { kind: Block['kind']; obligationIds: string[]; factIds: string[]; text: string }[] = [];
  const withheld: string[] = [];
  const disclosed: { id: string; index: number; text: string; specific?: boolean }[] = [];
  const add = (kind: Block['kind'], id: string, text: string, factIds: string[] = []) => {
    const same = blocks.find(b => b.kind === kind && b.text === text);
    if (same) { same.obligationIds.push(id); same.factIds.push(...factIds); }
    else blocks.push({ kind, obligationIds: [id], factIds, text });
  };
  for (const [index, guide] of semantic.guidance.entries()) {
    const id = guide.obligationId;
    const d = decision.obligations.find(o => o.obligationId === id);
    if (guide.kind === 'CHECK_KNOWLEDGE') {
      const check = checks.find(row => row.obligation.id === id);
      if (d?.outcome === 'ANSWER' && check?.status === 'BOUND' &&
          hashRecord(check.proposals) === hashRecord(d.supportingFacts) &&
          Boolean(d.correctPremise) === Boolean(check.obligation.correctPremise)) {
        if (d.supportingFacts.some(f => containsUnverifiedBookingSuccessClaim(f.proposition.payload) ||
            containsWebOperationSuccess(f.proposition.payload))) {
          withheld.push(id);
          disclosed.push({ id, index, text: copy.unknown });
          continue;
        }
        const ids = new Map<string, string[]>();
        for (const fact of d.supportingFacts) {
          const payload = fact.proposition.payload;
          if (!payload.trim() || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(payload)) return null;
          ids.set(payload, [...(ids.get(payload) ?? []), fact.id]);
        }
        for (const [text, factIds] of ids) add('fact', id, text, factIds);
        continue;
      }
      if (d?.outcome === 'ANSWER') withheld.push(id);
      const q = semantic.readings[index]?.questionType;
      if (language === 'sv' && q === 'requirement' && swedishRequirementSubject?.obligationId === id) {
        disclosed.push({ id, index, text: 'Jag kunde inte bekräfta ' + swedishRequirementSubject.clause + '.', specific: true });
      } else disclosed.push({ id, index, text: q && q !== 'description' ? copy[q] : copy.unknown });
    } else if (guide.kind === 'ASK' && d?.outcome === 'CLARIFY') {
      add('clarification', id, copy.ask[guide.field]);
    } else if (guide.kind === 'REFER_TO_BOOKING_AUTHORITY' && d?.outcome === 'HANDOFF' && d.route === guide.route) {
      add('handoff', id, copy.handoff);
    } else if (guide.kind === 'CORRECTION') add('correction', id, copy.correction);
    else if (guide.kind === 'CLOSE') add('close', id, copy.close);
  }
  const hasFacts = blocks.some(b => b.kind === 'fact');
  for (const row of disclosed) {
    const prefix = row.specific || semantic.guidance.length === 1 ? '' : semantic.guidance.length === 2 && hasFacts && disclosed.length === 1
      ? otherQuestion[language] : numbered[language] + ' ' + (row.index + 1) + ': ';
    add('uncertainty', row.id, prefix + row.text);
  }
  const order = new Map(semantic.guidance.map((guide, index) => [guide.obligationId, index]));
  blocks.sort((a, b) => order.get(a.obligationIds[0])! - order.get(b.obligationIds[0])!);
  const text = blocks.map(b => b.text).join(' ');
  if (text.length > MAX_RESPONSE_CHARS) return null; // Never truncate a verified statement.
  return { publication: 'OFFLINE_ONLY', language, text, blocks, withheld };
}
