/** A narrow request contract, never evidence or an answer. Unknown/compound
 * wording stays on the semantic planner; full question text remains available
 * to extraction and independent coverage verification. */
export function deterministicLocationPlan(question: string, businessInformationRecognized: boolean) {
  const text=question.trim();
  if(!businessInformationRecognized || !text || text.length>200) return null;
  if(!/^(?:where\b|var\b|wo\b|d[oó]nde\b|کجا(?:\s|$)|(?:أين|اين)(?:\s|$))/iu.test(text))return null;
  // Do not collapse multiple intents, alternatives or conditional requirements.
  if((text.match(/[?؟]/gu)||[]).length>1 || /[?؟].*\S|[,،;:\n]|\b(?:and|or|but|unless|also|plus|without|ohne|utan|sin|och|eller|men|und|oder|aber|y|o|pero)\b|(?:^|\s)(?:و|یا|أو|او|لكن|بدون|دون)(?:\s|$)/iu.test(text))return null;
  // References without an explicit topic need the history-aware model planner.
  if(/\b(?:it|that|there|this|them|det|den|där|das|dort|eso|all[ií])\b|(?:^|\s)(?:آنجا|آن|هناك|ذلك)(?:\s|$)/iu.test(text))return null;
  if(/\b(?:recommend\w*|should|must|allowed|required|book|cancel|reschedule|rekommender\w*|borde|måste|tillåtet|krävs|soll\w*|muss|darf|empfehl\w*|deber\w*|permit\w*|oblig\w*|recomend\w*|boka|avboka|buchen|stornieren|reservar|cancelar)\b/iu.test(text)||/(?:^|\s)(?:باید|اجازه|پیشنهاد|يجب|مسموح|تنصح|ينبغي)(?:\s|$)/u.test(text))return null;
  // Small literal keyword probes supplement (never replace) the full semantic
  // question. No translations or business facts are invented. Stop words affect
  // retrieval only; qualifiers and numbers remain in the full request contract.
  const stop=new Set('where can could may i we you my our your the a an is are do does in at near when visiting visit var kan jag vi ni min vår din er är finns wo kann ich wir sie mein der die das ist sind dónde puedo yo mi el la en está کجا من می توانم أين اين يمكن يمكنني أنا انا'.split(' '));
  const keywords=(text.match(/[\p{L}\p{M}\p{N}]+/gu)||[]).filter(w=>w.length>=3&&!stop.has(w.toLocaleLowerCase())).slice(0,2);
  return {
    canonicalMeaning:text,queries:[...new Set([text,...keywords])],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',
    requestedFacets:[{subject:'business',attribute:text,questionType:'description',
      obligations:[{description:text,questionType:'description'}]}],
  };
}
export const KNOWLEDGE_PLANNING_LIMIT_MS=2500;
// Successful production verification took 6123ms and 6963ms. Reserve a
// conservative six-second admission window; it is not a completion guarantee.
export const KNOWLEDGE_VERIFICATION_MIN_MS=6000;
