import { businessInformationTopics, isExplicitBusinessActionRequest } from './business-information';
import {withoutExplicitParkingFeeTerms, hasDocumentaryVisitAccess, isArrivalInformationQuestion} from './information-request-contract';
import { hasConversationReference, hasExternalConversationReference } from './conversation-intent-continuity';
import { documentAttributeQuestions } from './knowledge-answer-presentation';
import { hasServiceName } from './source-aware-service-proposal';

/** A garage's location is document information, not the studio's structured
 * contact address. Other structured topics retain their existing authority. */
export function documentKnowledgeTopicsEligible(question: string): boolean {
  const topics = businessInformationTopics(question);
  if (topics.some(t => ['services', 'company', 'hours'].includes(t))) return false;
  // A documented parking fee is not a configured service price. Remove only
  // that explicit attachment from this topic probe, never from the request.
  if (topics.includes('prices') && businessInformationTopics(withoutExplicitParkingFeeTerms(question)).includes('prices')) return false;
  if (!topics.includes('contact')) return true;
  if (hasDocumentaryVisitAccess(question)) return true;
  return !/\b(?:phone|email|website|telephone|telefon|webbplats|kontaktuppgifter|teléfono|correo|webseite)\b/iu.test(question) && topics.includes('parking') &&
    /\b(?:garage|car\s*park|parkeringsgarage|parkhaus|tiefgarage|aparcamiento|garaje)\b|پارکینگ|موقف/u.test(question.toLowerCase()) &&
    !/\b(?:(?:your|our|studio|business)(?:'s)?\s+(?:address|phone|email)|(?:er|studions)\s+adress|adresse\s+(?:des\s+studios|ihrer)|dirección\s+del\s+estudio)\b/iu.test(question);
}

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
  if (hasExternalConversationReference(references)) return null;
  return {
    canonicalMeaning: text, queries: [text], queryLanguages: {}, requestKind: 'BUSINESS_INFORMATION',
    referenceResolution: 'NOT_REQUIRED' as const,
    requestedFacets: [{ subject: 'customer request', attribute: text, questionType: 'description',
      obligations: [{ description: text, questionType: 'description' }] }],
  };
}

/** Reuse the existing whole-question recovery contract before a model round
 * trip for bounded documentary questions with an explicit inline condition.
 * This interprets no condition, selects no source and grants no coverage. */
export function directConditionalDocumentPlan(question: string, recognized: boolean, referenceRequired = false) {
  const text=question.trim();
  const literal=literalInformationFallback(text,recognized,referenceRequired);
  if(!literal || (text.match(/[?؟]/gu)||[]).length!==1 || !/[?؟]$/u.test(text) || /[.!;:؛\n\r<>\[\]{}"`\\]/u.test(text))return null;
  const topics=businessInformationTopics(text);
  // Structured services/prices/contact/hours and other workflows retain their
  // existing routing. No business/topic vocabulary is inferred from documents.
  if(topics.length!==1 || topics[0]!=='policies')return null;
  const conditions=[...text.matchAll(/(?<![\p{L}\p{M}])(?:if|om|wenn|falls|si|اگر|إذا|اذا)(?![\p{L}\p{M}])/giu)];
  const condition=conditions[0];
  if(conditions.length!==1 || condition.index===0)return null;
  if((text.match(/(?<![\p{L}\p{M}])(?:what|which|how|vad|vilk\p{L}*|hur|was|welch\p{L}*|wie|qué|cuál\p{L}*|cómo|چه|چگونه|ما|ماذا|كيف|أي)(?![\p{L}\p{M}])/giu)||[]).length!==1)return null;
  const conditionalText=text.slice(condition.index+condition[0].length);
  // Do not use the earlier named business as a guessed antecedent for an
  // ambiguous object in the conditional clause (e.g. "if it is available").
  if((conditionalText.match(/[\p{L}\p{M}]+/gu)||[]).length<3 || hasConversationReference(conditionalText) ||
      /(?<![\p{L}\p{M}])(?:he|she|they|these|those|es|sie|dies\p{L}*|هو|هي|این)(?![\p{L}\p{M}])/iu.test(conditionalText))return null;
  if(/\b(?:book\p{L}*|appointments?|reserv\p{L}*|schedul\p{L}*|cancel\p{L}*|calendar\p{L}*|slots?|times?|zeiten|uhrzeiten|horas?|confirmed|fees?|deadline\p{L}*|notice|boka|bokning\p{L}*|avbok\p{L}*|omboka|tider|avgift\p{L}*|varsel|buchen|buche|buchung\p{L}*|termin\p{L}*|stornier\p{L}*|verschieb\p{L}*|gebühr\p{L}*|frist\p{L}*|bestätigt|citas?|cancel\p{L}*|tarifa\p{L}*|plazo\p{L}*|aviso|ignore|override|tools?|system|prompt|json|execute|delete|remove|send|create|update|call)\b|رزرو|نوبت|زمان|وقت|لغو|مهلت|هزینه|حجز|موعد|مواعيد|أوقات|الأوقات|إلغاء|الغاء|رسوم|مهلة|إشعار/iu.test(text))return null;
  return literal;
}

/** Local grammar probes only; the original request is never translated,
 * decomposed or used as evidence. Unknown grammar retains semantic planning. */
function localizedVisitPolicyChecklistPlan(question: string, recognized: boolean, referenceRequired: boolean) {
  const text=question.trim();
  if(!recognized || referenceRequired || !text || text.length>240 || !/[?؟]$/u.test(text) ||
    /[.!;؛\n\r<>\[\]{}"`\\“”«»‘’]/u.test(text))return null;
  const topics=businessInformationTopics(text);
  // The existing caller must recognize an information request. Some Spanish
  // conduct wording has no coarse topic tag; explicit grammar below supplies
  // admission, while any competing structured topic still vetoes it.
  if(topics.some(t=>t!=='policies'))return null;
  // Remove Arabic vocalization for eligibility only. Never alter wire fields.
  const probe=text.replace(/[\u064b-\u065f\u0670]/gu,'');
  const profiles=[
    {language:'sv',lead:/^(?:inför|före|under)\s+(?:(?:mitt|vårt|ett|det|första)\s+)?besök(?:et)?\s*[:,،]\s*/iu,
      heads:/(?<![\p{L}\p{M}])(?:måste|bör|får|kan)\s+jag\s+(?:inte\s+)?(?:följa|ta\s+med|undvika|bära|äta|dricka|lämna)\b/giu,maxQuestions:1,action:null},
    {language:'de',lead:/^(?:vor|bei|während)\s+(?:(?:meinem|unserem|dem|einem|ersten)\s+){0,2}besuch\s*[:,،]\s*/iu,
      heads:/(?<![\p{L}\p{M}])(?:muss|sollte|darf|kann)\s+ich\s+(?:nicht\s+)?/giu,maxQuestions:1,
      action:/\b(?:befolgen|mitbringen|tragen|meiden|vermeiden|essen|trinken|mitnehmen|lassen)\b/iu},
    {language:'es',lead:/^(?:antes|durante)\s+(?:de\s+)?(?:la|mi|una)\s+visita\s*[:,،]\s*/iu,
      heads:/(?:¿\s*)?(?<![\p{L}\p{M}])(?:debo|debería|puedo)\s+(?:no\s+)?(?:seguir|traer|llevar|evitar|comer|beber)\b/giu,maxQuestions:1,action:null},
    {language:'ar',lead:/^(?:قبل|أثناء|اثناء)\s+(?:الزيارة|زيارتي)\s*[,،:]\s*/u,
      heads:/(?<![\p{L}\p{M}])و?هل\s+(?:يجب\s+اتباع|ينصح\s+بتجنب|يمكنني\s+(?:إحضار|احضار))\s+/gu,maxQuestions:3,action:null},
  ];
  const profile=profiles.find(p=>p.lead.test(probe));if(!profile)return null;
  const body=probe.replace(profile.lead,'');
  const questions=(body.match(/[?؟]/gu)||[]).length;
  if(!questions || questions>profile.maxQuestions || /:/u.test(body))return null;
  // Conduct-information admission must not absorb finance, status, service
  // selection, operational instructions or historical/ambiguous follow-ups.
  if(/\b(?:book\p{L}*|appointments?|reserv\p{L}*|schedul\p{L}*|cancel\p{L}*|calendar|availability|slots?|fees?|prices?|duration|services?|instead|replace\p{L}*|previous|earlier|again|same|ignore|override|system|prompt|tools?|json|execute|delete|send|create|update|boka|bokning\p{L}*|avbok\p{L}*|ombok\p{L}*|tider|ledig\p{L}*|avgift\p{L}*|pris\p{L}*|tjänst\p{L}*|istället|samma|tidigare|ignorera|verktyg|radera|skicka|buchen|buchung\p{L}*|termin\p{L}*|stornier\p{L}*|verfügbar\p{L}*|gebühr\p{L}*|preis\p{L}*|leistung\p{L}*|anstelle|vorher|wieder|ignorier\p{L}*|werkzeug\p{L}*|löschen|senden|citas?|cancel\p{L}*|tarifa\p{L}*|precio\p{L}*|servicio\p{L}*|disponib\p{L}*|sustitu\p{L}*|anterior|ignora\p{L}*|herramienta\p{L}*|eliminar|enviar)\b|رزرو|نوبت|لغو|هزینه|قیمت|خدمت|خدمات|جایگزین|قبلی|همان|دستور سیستم|ابزار|نادیده|حذف|ارسال|حجز|موعد|مواعيد|إلغاء|الغاء|رسوم|سعر|خدمة|خدمات|بدلا|بدلاً|سابق|تجاهل|أداة|احذف|أرسل/iu.test(body))return null;
  if(/(?<![\p{L}\p{M}])(?:what|where|when|why|how|vad|var|när|varför|hur|was|wo|wann|warum|wie|qué|dónde|cuándo|porqué|cómo|چرا|کجا|چگونه|أين|اين|متى|لماذا|كيف)(?![\p{L}\p{M}])/iu.test(body))return null;
  const heads=[...body.matchAll(profile.heads)];
  if(heads.length<2 || heads.length>4)return null;
  let references=body;
  // A received-object anaphor is local only when its explicit object and
  // receipt condition occur together in the same conduct clause.
  if(profile.language==='sv')references=references.replace(/(?:måste|bör)\s+jag\s+(?:inte\s+)?följa\s+(?:[\p{L}\p{M}-]+\s+){1,6}om\s+jag\s+(?:inte\s+)?har\s+fått\s+dem\b/giu,s=>s.replace(/dem$/iu,''));
  if(hasConversationReference(references) || /(?<![\p{L}\p{M}])(?:dem|dieser|diese|dieses|dasselbe|esto|esta|este|aquello|هناك|هذا|هذه|همان)(?![\p{L}\p{M}])/iu.test(references))return null;
  if(heads[0].index!==0)return null;
  for(let i=0;i<heads.length;i++){
    const clause=body.slice(heads[i].index,heads[i+1]?.index);
    if(profile.action && !profile.action.test(clause))return null;
    // Each subsequent question must itself start with a recognized modal
    // conduct head; a trailing unrelated question cannot ride the checklist.
    if(/[?؟]\s*[^?؟\s]+/u.test(clause.slice(0,-1)))return null;
  }
  return literalInformationFallback(text,recognized,referenceRequired);
}

/** A bounded visitor-conduct checklist can use the existing literal recovery
 * contract without guessing separate facets or interpreting its conditions.
 * Explicit localized conduct forms reuse the same literal contract; unrecognized
 * forms and unresolved references retain planning. It grants no factual coverage.
 */
export function directVisitPolicyChecklistPlan(question: string, recognized: boolean, referenceRequired = false) {
  const localized=localizedVisitPolicyChecklistPlan(question,recognized,referenceRequired);
  if(localized)return localized;
  const text=question.trim();
  if(!recognized || referenceRequired || !text || text.length>240 || (text.match(/[?؟]/gu)||[]).length!==1 || !/\?$/u.test(text) ||
      /[.!;:؛\n\r<>\[\]{}"`\\]/u.test(text))return null;
  const topics=businessInformationTopics(text);
  if(topics.length!==1 || topics[0]!=='policies')return null;
  const lead=/^(?:for|before|during)\s+(?:(?:my|our|a|the)\s+)?(?:first\s+)?visit\s*,\s*/iu.exec(text);
  if(!lead)return null;
  const checklist=text.slice(lead[0].length);
  // Only bounded conduct questions, never service selection, tool instructions,
  // scheduling/status, financial policies, comparisons or history resolution.
  if(/\b(?:book\p{L}*|appointments?|reserv\p{L}*|schedul\p{L}*|cancel\p{L}*|calendar\p{L}*|slots?|availability|available|confirmed|fees?|prices?|cost\p{L}*|duration|services?|deadline\p{L}*|notice|instead|replac\p{L}*|substitut\p{L}*|compar\p{L}*|previous|earlier|again|same|contact\p{L}*|phone|email|address|ignore|override|tools?|system|prompt|json|execute|delete|send|create|update|call)\b/iu.test(text))return null;
  const heads=[...checklist.matchAll(/\b(?:must|should|may|can)\s+I\s+/giu)];
  if(heads.length<2 || heads.length>4 || heads[0].index!==0)return null;
  for(const head of heads){
    if(!/^(?:not\s+)?(?:follow|bring|wear|avoid|eat|drink|carry|keep|leave|remove)\b/iu.test(checklist.slice(head.index!+head[0].length)))return null;
    if(head.index && !/(?:,\s*(?:and\s+)?|\s+and\s+)$/iu.test(checklist.slice(0,head.index)))return null;
  }
  if(/\b(?:what|which|where|when|who|why|how|would|could|shall)\b/iu.test(checklist))return null;
  // A received-object condition may refer back to the explicit object in the
  // same modal clause. Remove only that anaphor from this eligibility probe;
  // the original question/condition remains byte-for-byte in every wire field.
  const references=checklist.replace(/\b(?:must|should|may|can)\s+I\s+(?:not\s+)?[\p{L}-]+\s+(?:[\p{L}-]+\s+){1,6}if\s+I\s+(?:have\s+)?received\s+them\b/giu,span=>span.replace(/them$/iu,''));
  if(hasConversationReference(references))return null;
  return literalInformationFallback(text,recognized,referenceRequired);
}

/** Skip a planning round trip only for an explicit, self-contained description
 * question. This is the same literal contract as transport recovery, not an
 * answer or coverage decision. Ambiguity and operational wording keep planning.
 */
export function literalInformationPlan(question: string, businessInformationRecognized: boolean, referenceRequired = false) {
  const text = question.trim();
  // The same full-question container already used after planner transport
  // failure can be admitted directly for bounded, self-contained document
  // requests. It decomposes no meaning and grants no factual authority: the
  // independent verifier still checks the full request and every qualification.
  const topics = businessInformationTopics(text);
  const conjunctions = text.match(/\b(?:and|och|und|y)\b|(?<![\p{L}\p{M}])و(?![\p{L}\p{M}])/giu) || [];
  const locationAndDistance = /garage|car\s*park|parkeringsgarage|parkplatz|parkhaus|aparcamiento|پارکینگ|موقف/iu.test(text) && /how far|walking|walk|hur långt|wie weit|cuánto|فاصله|چقدر|يبعد/iu.test(text);
  const companionAndRoom = /bring\s+(?:someone|a\s+companion|one\s+adult)|accompany/iu.test(text) && /treatment\s+room|work\s+room/iu.test(text);
  const parkingBenefits = /parking/iu.test(text) && /free/iu.test(text) && /studio/iu.test(text) && /reserve\s+a\s+parking/iu.test(text);
  const boundedDocumentRequest = locationAndDistance || companionAndRoom || parkingBenefits;
  if (boundedDocumentRequest && topics.length && topics.every(t => ['parking', 'policies', 'contact'].includes(t)) &&
      documentKnowledgeTopicsEligible(text) && conjunctions.length <= 1 &&
      (text.match(/[?؟]/gu) || []).length === 1 && /[?؟]$/u.test(text) &&
      /^(?:¿?\s*(?:is|are|what|where|how|can|may|kan|får|var|vad|hur|wo|wie|kann|darf|dónde|puedo)\b|(?:آیا|ورودی|کجا|هل|أين|اين)(?:\s|$))/iu.test(text) &&
      !/[.!;:؛\n\r<>\[\]{}"`\\]/u.test(text) &&
      !/\b(?:book\w*|appointment\w*|calendar\w*|cancel\w*|reschedul\w*|boka|avboka|omboka|buchen|stornier\w*|unless|instead|previous|earlier|ignore|instructions?|system|prompt|tools?|execute|delete|remove|return|json)\b/iu.test(text)) {
    const literal = literalInformationFallback(text, businessInformationRecognized, referenceRequired);
    // Commas can attach to a named subject in Arabic ("Nordpark،").
    // Separate punctuation for lexical lookup only; the complete original
    // question remains the verifier contract and the semantic query.
    if (literal) return { ...literal, queries: [text.replace(/[,،]/gu, ' ')] };
  }
  if (!businessInformationRecognized || referenceRequired || !text || text.length > 240 || businessInformationTopics(text).length !== 1 ||
      (text.match(/[?؟]/gu) || []).length !== 1 || !/[?؟]$/u.test(text) ||
      /[.!;:؛\n\r<>\[\]{}"`\\]/u.test(text)) return null;
  if (!/^(?:¿?\s*(?:is|are|does|do|what|where|which|how|finns|är|var|vad|hur|vilken|vilka|gibt|ist|sind|wo|wie|welche|hay|es|son|dónde|cómo|qué|cuál)\b|(?:آیا|کجا|چگونه|چه|هل|أين|اين|كيف|ما)(?:\s|$))/iu.test(text)) return null;
  if (/(?<![\p{L}\p{M}])(?:here|these|those|such|another|other|dieser|diese|dieses|ese|esa|esto|esta|este|این|اینجا|همین|هذا|هذه|هو|هي)(?![\p{L}\p{M}])/iu.test(text)) return null;
  // Topic recognition is not exhaustive. A second independent clause can name
  // an unrecognized topic; allow only a single predicative continuation of the
  // in-question subject, never arbitrary compound clauses or a second noun.
  const boundaries=[...text.matchAll(/\b(?:and|och|und|y)\b|(?<![\p{L}\p{M}])و(?![\p{L}\p{M}])/giu)];
  if (boundaries.length > 1 || boundaries.length && !/^(?:and\s+is\s+it\s+(?:not\s+)?[\p{L}\p{M}-]+|och\s+är\s+(?:den|det)\s+(?:inte\s+)?[\p{L}\p{M}-]+|und\s+ist\s+(?:es|das)\s+(?:nicht\s+)?[\p{L}\p{M}-]+|y\s+es\s+(?:no\s+)?[\p{L}\p{M}-]+|و\s+[\p{L}\p{M}]+\s+است)[?؟]$/iu.test(text.slice(boundaries[0].index))) return null;
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

/** Preserve an already recognized read-only question as one complete request.
 * The literal container establishes no facet coverage or factual authority. */
export function wholeQuestionInformationPlan(question: string, recognized: boolean, referenceRequired = false, services?:unknown) {
  // Preserve a self-contained hypothetical arrival consequence and its explicit
  // automatic-cancellation subquestion as ONE complete verifier obligation.
  // This skips planning, never extraction, entailment, coverage or freshness.
  const arrivalQuestions=question.trim().match(/[^?؟]+[?؟]/gu);
  if (isArrivalInformationQuestion(question) && documentKnowledgeTopicsEligible(question) &&
      !/[.!;:؛\n\r<>\[\]{}"`\\]/u.test(question) &&
      arrivalQuestions && arrivalQuestions.length===2 && arrivalQuestions.join('').replace(/\s/gu,'')===question.replace(/\s/gu,'') &&
      /(?<![\p{L}\p{M}])(?:if|om|wenn|falls|si|اگر|إذا|اذا)(?![\p{L}\p{M}])/iu.test(arrivalQuestions[0]) &&
      /automatic\p{L}*|automatisk\p{L}*|automatisch\p{L}*|automátic\p{L}*|خودکار|تلقائ/iu.test(arrivalQuestions[1])) {
    const arrival=literalInformationFallback(question,recognized,referenceRequired);
    if(arrival)return arrival;
  }
  const checklist=directVisitPolicyChecklistPlan(question,recognized,referenceRequired);
  if(checklist)return checklist;
  const conditional=directConditionalDocumentPlan(question,recognized,referenceRequired);
  if(conditional)return conditional;
  // Reuse the accepted two-question document contract. Catalog mentions and
  // other workflows keep their existing authority/planner; no topic or fact is
  // removed from the literal request. Unknown catalog scope fails closed.
  // Reuse only the reviewed English/Persian two-question grammars. These
  // anchored probes select a literal request container, never a translation,
  // inferred obligation or evidence. Other localized forms keep their routes.
  const attributeQuestions=documentAttributeQuestions(question,'en') ||
    (!/(?<![\p{L}\p{M}])(?:همان|این|آن|آنجا|قبلی|دستور|سیستم|ابزار|نادیده|لغو|نوبت|کن|کنید|کنی|می[‌ ]?توانی(?:د)?)(?![\p{L}\p{M}])/u.test(question) &&
      documentAttributeQuestions(question,'fa'));
  if(Array.isArray(services) && documentKnowledgeTopicsEligible(question) &&
    attributeQuestions &&
    services.every(s=>s&&typeof s.name==='string'&&s.name.trim()&&s.name.length<=128&&!hasServiceName(question,s.name)) &&
    !/\p{N}/u.test(question) &&
    !/\b(?:book\w*|appointment\w*|calendar\w*|schedul\w*|reschedul\w*|cancel\w*|availability|available|slots?|times?|today|tomorrow|tonight|next|now|monday|tuesday|wednesday|thursday|friday|saturday|sunday|confirmed|duration|services?|prices?|cost\w*|payment|pay|instead|replace\w*|must|should|may|can|allowed|permitted|require\w*|recommend\w*|ignore|override|instructions?|system|prompt|tools?|execute|delete|remove|return|json|send|create|update)\b/iu.test(question)) {
    const literal=literalInformationFallback(question,recognized,referenceRequired);
    if(literal)return literal;
  }
  // A context-setting sentence or conditional introduces the question's
  // referent locally. Preserve it intact rather than guessing facet labels.
  const firstSentence = question.split(/[.!]/u)[0];
  const contextLead = firstSentence.trim().split(/\s+/u).length >= 3 && /[.!]\s+[^.!]*[?؟]/u.test(question) ||
    /^(?:(?:okay|ok|okej|well)[,،]?\s*(?:(?:and|och)\s+)?)?(?:if|om|wenn|falls)\b|^\s*اگر\s/iu.test(question);
  return contextLead ? literalInformationFallback(question, recognized, referenceRequired)
    : literalInformationPlan(question, recognized, referenceRequired);
}
