import { businessInformationTopics, isExplicitBusinessActionRequest } from './business-information';
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

/** Skip a planning round trip only for an explicit, self-contained description
 * question. This is the same literal contract as transport recovery, not an
 * answer or coverage decision. Ambiguity and operational wording keep planning.
 */
export function literalInformationPlan(question: string, businessInformationRecognized: boolean, referenceRequired = false) {
  const text = question.trim();
  if (!businessInformationRecognized || referenceRequired || !text || text.length > 240 || businessInformationTopics(text).length !== 1 ||
      (text.match(/[?؟]/gu) || []).length !== 1 || !/[?؟]$/u.test(text) ||
      /[.!;:؛\n\r<>\[\]{}"`\\]/u.test(text)) return null;
  if (!/^(?:¿?\s*(?:is|are|does|do|what|where|which|how|finns|är|var|vad|hur|vilken|vilka|gibt|ist|sind|wo|wie|welche|hay|es|son|dónde|cómo|qué|cuál)\b|(?:آیا|کجا|چگونه|چه|هل|أين|اين|كيف|ما)(?:\s|$))/iu.test(text)) return null;
  if (/(?<![\p{L}\p{M}])(?:here|these|those|such|another|other|dieser|diese|dieses|ese|esa|esto|esta|este|این|اینجا|همین|هذا|هذه|هو|هي)(?![\p{L}\p{M}])/iu.test(text)) return null;
  // Topic recognition is not exhaustive. A second independent clause can name
  // an unrecognized topic; allow only a single predicative continuation of the
  // in-question subject, never arbitrary compound clauses or a second noun.
  const conjunctions=[...text.matchAll(/\b(?:and|och|und|y)\b|(?<![\p{L}\p{M}])و(?![\p{L}\p{M}])/giu)];
  if (conjunctions.length > 1 || conjunctions.length && !/^(?:and\s+is\s+it\s+(?:not\s+)?[\p{L}\p{M}-]+|och\s+är\s+(?:den|det)\s+(?:inte\s+)?[\p{L}\p{M}-]+|und\s+ist\s+(?:es|das)\s+(?:nicht\s+)?[\p{L}\p{M}-]+|y\s+es\s+(?:no\s+)?[\p{L}\p{M}-]+|و\s+[\p{L}\p{M}]+\s+است)[?؟]$/iu.test(text.slice(conjunctions[0].index))) return null;
  // Be deliberately conservative: permission/requirements, alternatives,
  // history-dependent wording and requests to operate tools need model planning.
  if (/\b(?:can|could|may|should|must|need\w*|require\w*|mandatory|necessary|optional|prohibit\w*|forbid\w*|allowed|permitted|recommend\w*|or|unless|if|previous|earlier|again|instead|book\w*|reserv\w*|schedul\w*|cancel\w*|appointment\w*|boka|avboka|omboka|bokning\w*|måste|behöver|borde|får|rekommend\w*|kräv\w*|krav\w*|förbjud\w*|tillåt\w*|eller|samma|buchen|stornier\w*|verschieb\w*|muss|darf|soll\w*|empfehl\w*|erforderlich|erlaubt|oder|reservar|cancelar|cambiar|permit\w*|debo|deber\w*|recomend\w*|necesit\w*|oblig\w*|o|ignore|override|instruction\w*|rules|system|prompt|tool\w*|function\w*|execute|invoke|call|delete|remove|wipe|send|email|create|update|change|write|run|reveal|pretend|json|api|ignorera|verktyg|radera|skicka|ignorier\w*|werkzeug\w*|löschen|ignora\w*|herramienta\w*|eliminar)\b|\bwhat\s+about\b/iu.test(text) ||
      /(?<![\p{L}\p{M}])و?(?:رزرو|نوبت|لغو|باید|اجازه|پیشنهاد|مجاز|لازم|توصیه|ضروری|ممنوع|یا|قبلی|همان|دستور|ابزار|نادیده|حذف|ارسال|احجز|حجز|موعد|إلغاء|الغاء|يجب|مسموح|مطلوب|ينبغي|توصي|يحق|أو|ذلك|تعليمات|تجاهل|أداة|احذف|أرسل)(?![\p{L}\p{M}])/u.test(text)) return null;
  return literalInformationFallback(text, businessInformationRecognized, referenceRequired);
}
// Successful production verification took 6123ms and 6963ms. Reserve a
// conservative six-second admission window; it is not a completion guarantee.
export const KNOWLEDGE_VERIFICATION_MIN_MS=6000;

/** Two sequential model stages share the remaining generation window. A slow
 * proposal cannot spend the verifier's half or its existing admission floor.
 * This is scheduling, not permission to publish after a timeout. */
export function knowledgeProposalAllowance(generationRemainingMs: number): number {
  if (!Number.isFinite(generationRemainingMs)) return 0;
  return Math.max(0, Math.floor(Math.min(generationRemainingMs / 2,
    generationRemainingMs - KNOWLEDGE_VERIFICATION_MIN_MS)));
}
