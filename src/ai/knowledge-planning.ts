import { isExplicitBusinessActionRequest } from './business-information';
import { hasConversationReference } from './conversation-intent-continuity';

/** A narrow request contract, never evidence or an answer. Unknown/compound
 * wording stays on the semantic planner; full question text remains available
 * to extraction and independent coverage verification. */
export function deterministicLocationPlan(question: string, businessInformationRecognized: boolean) {
  const text=question.trim();
  if(!businessInformationRecognized || !text || text.length>200) return null;
  // Ignore only one explicit leading greeting for shortcut eligibility. Keep the
  // complete original input in the request contract and model/retrieval context.
  const locationQuestion=text.replace(/^(?:hi|hello|hey|hej|hallo|hola|سلام|مرحبا|مرحباً)[ \t]*[,،!.][ \t]*/iu,'');
  // A locative question can follow conversational context or a polite request.
  // Reuse the established read-only intent and the whole-question safety guards
  // below; never discard the preface or infer an answer from this marker.
  const location=/(?<![\p{L}\p{M}\p{N}_])(?:where\b|var\b|wo\b|d[oó]nde\b|کجا(?:\s|$)|(?:أين|اين)(?:\s|$))/iu.exec(locationQuestion);
  if(!location)return null;
  // Do not collapse multiple intents, alternatives or conditional requirements.
  if((locationQuestion.match(/[?؟]/gu)||[]).length>1 || /[?؟].*\S|[,،;:\n]|\b(?:and|or|but|unless|also|plus|without|ohne|utan|sin|och|eller|men|und|oder|aber|y|o|pero)\b|(?:^|\s)(?:و|یا|أو|او|لكن|بدون|دون)(?:\s|$)/iu.test(locationQuestion))return null;
  // References without an explicit topic need the history-aware model planner.
  if(/\b(?:it|that|there|this|them|det|den|där|das|dort|eso|all[ií])\b|(?:^|\s)(?:آنجا|آن|هناك|ذلك)(?:\s|$)/iu.test(locationQuestion))return null;
  if(/\b(?:recommend\w*|should|must|allowed|required|book|cancel|reschedule|rekommender\w*|borde|måste|tillåtet|krävs|soll\w*|muss|darf|empfehl\w*|deber\w*|permit\w*|oblig\w*|recomend\w*|boka|avboka|buchen|stornieren|reservar|cancelar)\b/iu.test(text)||/(?:^|\s)(?:باید|اجازه|پیشنهاد|يجب|مسموح|تنصح|ينبغي)(?:\s|$)/u.test(locationQuestion))return null;
  // Small literal keyword probes supplement (never replace) the full semantic
  // question. No translations or business facts are invented. Stop words affect
  // retrieval only; qualifiers and numbers remain in the full request contract.
  const stop=new Set('where can could may i we you my our your the a an is are do does in at near when visiting visit var kan jag vi ni min vår din er är finns wo kann ich wir sie mein der die das ist sind dónde puedo yo mi el la en está کجا من می توانم أين اين يمكن يمكنني أنا انا'.split(' '));
  const keywords=(locationQuestion.slice(location.index).match(/[\p{L}\p{M}\p{N}]+/gu)||[]).filter(w=>w.length>=3&&!stop.has(w.toLocaleLowerCase())).slice(0,2);
  return {
    canonicalMeaning:text,queries:[...new Set([text,...keywords])],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',
    requestedFacets:[{subject:'business',attribute:text,questionType:'description',
      obligations:[{description:text,questionType:'description'}]}],
  };
}
export const KNOWLEDGE_PLANNING_LIMIT_MS=2500;

/** A literal request container after a planner transport failure, not a semantic
 * decomposition. It supplies no facts, translations, inferred obligations or
 * coverage. The independent verifier must still align the FULL question and
 * establish every material fact; a description container cannot grant permission.
 */
export function literalInformationFallback(question: string, businessInformationRecognized: boolean, referenceRequired = false) {
  const text = question.trim();
  // Keep the entire request within the existing facet/obligation field bound.
  // Never truncate a condition or resolve a missing conversational antecedent.
  if (!businessInformationRecognized || referenceRequired || !text || text.length > 240 ||
      isExplicitBusinessActionRequest(text) || (text.match(/[?؟]/gu) || []).length > 4) return null;
  const references = text
    // Existential "is there" is not a reference to a previous place.
    .replace(/\b(?:is|are)\s+there\b/giu, '')
    .replace(/\bfinns\s+det\b/giu, '')
    // A coordinated predicate stays attached to its literal, in-question subject.
    // No text is removed from the request passed to extraction/verification.
    .replace(/\b(?:and|och|und|y)\s+(?:is|are|är|ist|sind|es)\s+(?:it|den|det|das|eso)\b/giu, '');
  if (hasConversationReference(references)) return null;
  return {
    canonicalMeaning: text, queries: [text], queryLanguages: {}, requestKind: 'BUSINESS_INFORMATION',
    referenceResolution: 'NOT_REQUIRED' as const,
    requestedFacets: [{ subject: 'customer request', attribute: text, questionType: 'description',
      obligations: [{ description: text, questionType: 'description' }] }],
  };
}
// Successful production verification took 6123ms and 6963ms. Reserve a
// conservative six-second admission window; it is not a completion guarantee.
export const KNOWLEDGE_VERIFICATION_MIN_MS=6000;
