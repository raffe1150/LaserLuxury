import type { Facet, FacetOutcome } from './business-information-answer-plan';
import {isExplicitBusinessActionRequest} from './business-information';
import {hasCancellationInformationTopic} from './cancellation-information';

/** Request-local references, never new business facts or model-authored prose. */
export type UncertaintyReference = Readonly<{ facetId: string; obligationId: string; text: string; kind?:'requested-attribute' }>;
export type RequirementNotice = Readonly<{ facetId: string; obligationId: string; text: string }>;
type Copy = { about: (text: string) => string; description: string; recommendation: string; requirement: string; permission: string; prohibition: string; conflict: string };
const copy: Record<string, Copy> = {
  sv: { about: t => `När det gäller ”${t}”:`, description: 'Jag kan bara bekräfta de här uppgifterna just nu.', recommendation: 'Jag kan däremot inte bekräfta vilken rekommendation som gäller.', requirement: 'Jag kan däremot inte bekräfta vilka krav som gäller.', permission: 'Jag kan däremot inte bekräfta vad som är tillåtet.', prohibition: 'Jag kan däremot inte bekräfta vad som är förbjudet.', conflict: 'Uppgifterna behöver klargöras innan jag kan ge ett säkert svar.' },
  en: { about: t => `Regarding “${t}”:`, description: 'I can only confirm these details for now.', recommendation: 'However, I cannot confirm what is recommended.', requirement: 'However, I cannot confirm what is required.', permission: 'However, I cannot confirm what is permitted.', prohibition: 'However, I cannot confirm what is prohibited.', conflict: 'The information needs clarification before I can give a reliable answer.' },
  de: { about: t => `Zu „${t}“:`, description: 'Ich kann derzeit nur diese Angaben bestätigen.', recommendation: 'Welche Empfehlung gilt, kann ich allerdings nicht bestätigen.', requirement: 'Welche Anforderungen gelten, kann ich allerdings nicht bestätigen.', permission: 'Was erlaubt ist, kann ich allerdings nicht bestätigen.', prohibition: 'Was verboten ist, kann ich allerdings nicht bestätigen.', conflict: 'Die Angaben müssen geklärt werden, bevor ich eine verlässliche Antwort geben kann.' },
  es: { about: t => `Sobre «${t}»:`, description: 'Por ahora solo puedo confirmar estos detalles.', recommendation: 'Sin embargo, no puedo confirmar qué se recomienda.', requirement: 'Sin embargo, no puedo confirmar qué se exige.', permission: 'Sin embargo, no puedo confirmar qué está permitido.', prohibition: 'Sin embargo, no puedo confirmar qué está prohibido.', conflict: 'Es necesario aclarar la información antes de poder dar una respuesta fiable.' },
  fa: { about: t => `دربارهٔ «${t}»:`, description: 'فعلاً فقط می‌توانم این جزئیات را تأیید کنم.', recommendation: 'با این حال، نمی‌توانم تأیید کنم چه چیزی توصیه می‌شود.', requirement: 'با این حال، نمی‌توانم تأیید کنم چه الزاماتی وجود دارد.', permission: 'با این حال، نمی‌توانم تأیید کنم چه چیزی مجاز است.', prohibition: 'با این حال، نمی‌توانم تأیید کنم چه چیزی ممنوع است.', conflict: 'پیش از ارائهٔ پاسخی قابل اتکا، اطلاعات باید روشن شود.' },
  ar: { about: t => `بخصوص «${t}»:`, description: 'يمكنني تأكيد هذه التفاصيل فقط في الوقت الحالي.', recommendation: 'لكن لا أستطيع تأكيد ما يُوصى به.', requirement: 'لكن لا أستطيع تأكيد المتطلبات.', permission: 'لكن لا أستطيع تأكيد ما هو مسموح به.', prohibition: 'لكن لا أستطيع تأكيد ما هو ممنوع.', conflict: 'تحتاج المعلومات إلى توضيح قبل أن أتمكن من تقديم إجابة موثوقة.' },
};

// Do not echo markup, identifiers, control characters or long prose.
// An exact user span is a question reference, never evidence for a business policy.
const safeReference = (text: string, limit: number) => text.length >= 8 && text.length <= limit &&
  /^[\p{L}\p{M}\p{N}\u200c .,;،؛'’\-!?؟¿()]+$/u.test(text) && !/\d{4}|[?!؟].+[?!؟]/u.test(text);
const userSpan = (question: string, label: string, allowArabicConjunction = false) => {
  const at = question.indexOf(label), token = /[\p{L}\p{M}\p{N}_-]/u;
  // Arabic joins the conjunction waw to the following word. Admit that single
  // bounded prefix, never an arbitrary suffix of a longer word or identifier.
  const arabicConjunction = allowArabicConjunction && at > 0 && question[at-1] === 'و' && /^\p{Script=Arabic}/u.test(label) &&
    (at === 1 || !token.test(question[at-2]));
  return at >= 0 && (!(at > 0 && token.test(question[at-1])) || arabicConjunction) &&
    !(at+label.length < question.length && token.test(question[at+label.length]));
};

// Bounded request grammar, never a source fact or an absence assertion. Keep
// exact spans; unknown, conditional, compound and referential labels stay generic.
const documentAttributeForms:Record<string,RegExp>={
 en:/^Do the documents (?:state|specify|give) (.+)\?$/iu,
 sv:/^Anger dokumenten (.+)\?$/iu,
 de:/^Nennen die Dokumente (.+)\?$/iu,
 es:/^¿?Indican los documentos (.+)\?$/iu,
 fa:/^آیا اسناد (.+) را مشخص می(?:‌| )کنند[؟?]$/u,
 ar:/^هل تحدد المستندات (.+)[؟?]$/u,
};
const descriptiveQuestion:Record<string,RegExp>={
 en:/^(?:Does|Do|Is|Are)\b/iu,sv:/^(?:Erbjuder|Har|Finns|Är)\b/iu,
 de:/^(?:Bietet|Gibt|Ist|Sind|Hat|Haben)\b/iu,es:/^¿?(?:Ofrece|Hay|Es|Son|Tiene)\b/iu,
 fa:/^آیا\s/u,ar:/^هل\s/u,
};
const unsafeAttribute=/(?<![\p{L}\p{M}])(?:and|or|if|unless|when|not|no|it|this|that|these|those|them|their|previous|earlier|other|another|some|how|can|must|should|ignore|instructions?|system|prompt|execute|delete|remove|create|update|return|json|tools?|book|cancel|send|och|eller|om|inte|det|den|dessa|und|oder|wenn|falls|nicht|das|es|jene|y|o|si|eso|esa|esos|esas|و|یا|اگر|آن|این|قبلی|أو|او|إذا|اذا|ذلك|هذا|هذه|هو|هي)(?![\p{L}\p{M}])/iu;
function documentAttributeSpan(question:string,language:string):string|undefined {
 const value=documentAttributeForms[language]?.exec(question.trim())?.[1];
 return value && safeReference(value,90) && userSpan(question,value) && !/[\d,.!?؟،;؛]/u.test(value) &&
   value.trim().split(/\s+/u).length>=2 && value.trim().split(/\s+/u).length<=8 && !unsafeAttribute.test(value) ? value : undefined;
}

/** Partition only an existing whole-question descriptive obligation. Both exact
 * questions remain in coverage; the original facet/question is unchanged. The
 * verifier, not clause order or missing lexical matches, decides which is unknown.
 */
export function requestUncertaintyFacets(question:string,language:string,facets:readonly Facet[]):readonly Facet[] {
 if(facets.length!==1 || facets[0].questionType!=='description' || facets[0].attribute!==question ||
   facets[0].obligations.length!==1 || facets[0].obligations[0].description!==question ||
   facets[0].obligations[0].questionType!=='description' || facets[0].obligations[0].catalogRequirement ||
   facets[0].obligations[0].id!==`${facets[0].id}.o1`)return facets;
 const clauses=documentAttributeQuestions(question,language);
 if(!clauses)return facets;
 const f=facets[0],base=f.obligations[0];
 return Object.freeze([Object.freeze({...f,obligations:Object.freeze([
   Object.freeze({...base,description:clauses[0]}),
   Object.freeze({id:`${f.id}.o2`,description:clauses[1],questionType:'description' as const}),
 ])})]);
}

/** Shared syntax check only; supplies no source, answer or coverage decision. */
export function documentAttributeQuestions(question:string,language:string):readonly [string,string]|undefined {
 if(question.length>240 || /[.!;:؛\n\r<>\[\]{}"`\\]/u.test(question) || isExplicitBusinessActionRequest(question))return;
 const clauses=/^([^?؟]+[?؟])\s+([^?؟]+[?؟])$/u.exec(question);
 if(!clauses || !documentAttributeSpan(clauses[1],language) || !descriptiveQuestion[language]?.test(clauses[2]) ||
   /\b(?:if|unless|when|om|wenn|falls|si)\b|اگر|(?<![\p{L}\p{M}])(?:إذا|اذا)(?![\p{L}\p{M}])/iu.test(question))return;
 return Object.freeze([clauses[1],clauses[2]] as const);
}

const unknownAttribute:Record<string,(text:string)=>string>={
 en:t=>`I cannot verify “${t}” from the available information.`,
 sv:t=>`Jag kan inte verifiera ”${t}” utifrån den tillgängliga informationen.`,
 de:t=>`Ich kann „${t}“ anhand der verfügbaren Informationen nicht verifizieren.`,
 es:t=>`No puedo verificar «${t}» con la información disponible.`,
 fa:t=>`نمی‌توانم «${t}» را بر اساس اطلاعات موجود تأیید کنم.`,
 ar:t=>`لا أستطيع التحقق من «${t}» استناداً إلى المعلومات المتاحة.`,
};

export function uncertaintyReferences(question: string, language: string, facets: readonly Facet[], outcomes: readonly FacetOutcome[],
  languageSafe: (text: string) => boolean, contextTexts: readonly string[] = []): readonly UncertaintyReference[] {
  if (!copy[language]) return Object.freeze([]);
  const refs: UncertaintyReference[] = [];
  const requestedAttribute=documentAttributeSpan(question.split(/(?<=[?؟])\s+/u)[0],language);
  for (const facet of facets) {
    const outcome = outcomes.find(o => o.facetId === facet.id);
    if (!outcome?.requestAligned) continue;
    for (const obligation of facet.obligations) {
      const label = obligation.description.trim();
      const attribute=obligation.questionType==='description'
        ?documentAttributeSpan(label,language)||(label===requestedAttribute?requestedAttribute:undefined):undefined;
      try {
        // A source/entailed unit literally discussing this attribute makes a
        // precise absence-of-verification label unsafe to infer from coverage
        // alone. This veto establishes no support and never changes a verdict.
        const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
        const mentioned=attribute&&contextTexts.some(t=>userSpan(normalize(t),normalize(attribute)));
        if(mentioned)continue;
        if(attribute && !mentioned && userSpan(question,label) && languageSafe(attribute)) {
          refs.push(Object.freeze({facetId:facet.id,obligationId:obligation.id,text:attribute,kind:'requested-attribute'}));
          continue;
        }
      } catch { /* Keep the same generic fallback on a failed language check. */ }
      // A planner label alone is not approved customer-facing language. Require a
      // literal user span and the existing local language guard before quoting it.
      const requirementGap = obligation.questionType === 'requirement' && outcome.obligations?.some(d => d.obligationId === obligation.id && d.status === 'UNRESOLVED');
      const reference = safeReference(label, 90) && userSpan(question, label, requirementGap) ? label : '';
      try {
        if (reference && reference.trim().replace(/[?؟？.!。]+$/u,'') !== question.trim().replace(/[?؟？.!。]+$/u,'') && !/[?؟？]/u.test(reference) && languageSafe(reference)) refs.push(Object.freeze({ facetId: facet.id, obligationId: obligation.id, text: reference }));
      } catch { /* Optional presentation references must never discard verified facts. */ }
    }
  }
  return Object.freeze(refs);
}

export function uncertaintyNotice(language: string, facet: Facet | undefined, outcome: FacetOutcome, references: readonly UncertaintyReference[] = []): string {
  const wording = copy[language] || copy.en;
  // A failed/malformed coverage assessment cannot authorize a precise label or
  // modality. Nor can a covered obligation stand in for missing material facts.
  const unresolved = outcome.requestAligned && facet ? facet.obligations.filter(o => outcome.obligations.some(d => d.obligationId === o.id && d.status === 'UNRESOLVED')) : [];
  const types = new Set(unresolved.map(o => o.questionType));
  const type = types.size === 1 ? unresolved[0].questionType : 'description';
  const reference = unresolved.length === 1 ? references.find(r => r.facetId === facet?.id && r.obligationId === unresolved[0].id) : undefined;
  const notice = outcome.status === 'CONFLICT' ? wording.conflict : wording[type];
  if(reference?.kind==='requested-attribute')return type==='description' && outcome.status==='PARTIAL' &&
    outcome.materialFactsComplete===false ? unknownAttribute[language]?.(reference.text)||notice : notice;
  return reference ? `${wording.about(reference.text)} ${notice}` : notice;
}

const unavailableAnswer: Record<string, (label: string) => string> = {
 en: t => `The full answer to “${t}” cannot be confirmed from the available information.`,
 sv: t => `Det fullständiga svaret på ”${t}” kan inte bekräftas utifrån den tillgängliga informationen.`,
 de: t => `Die vollständige Antwort auf „${t}“ kann anhand der verfügbaren Informationen nicht bestätigt werden.`,
 es: t => `La respuesta completa a «${t}» no puede confirmarse con la información disponible.`,
 fa: t => `پاسخ کامل به «${t}» را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.`,
 ar: t => `لا يمكن تأكيد الإجابة الكاملة عن «${t}» من المعلومات المتاحة.`,
};

/** Never render a model-authored missing-proposition explanation as a business
 * fact. General limitations name bounded literal spans of the user's request. */
export function sourceExhaustiveLimitations(question: string, language: string, facets: readonly Facet[],
 unavailable: readonly { facetId: string; obligationId: string }[]): readonly RequirementNotice[] | undefined {
 if (!unavailableAnswer[language] || !unavailable.length || unavailable.length > 8) return;
 const result: RequirementNotice[] = [];
 for (const gap of unavailable) {
  const f = facets.find(f => f.id === gap.facetId), o = f?.obligations.find(o => o.id === gap.obligationId);
  const label = o?.description.trim();
  if (!label || !safeReference(label, 90) || !userSpan(question, label, o.questionType === 'requirement')) return;
  result.push(Object.freeze({ ...gap, text: unavailableAnswer[language](label) }));
 }
 return Object.freeze(result);
}

// A localized uncertainty label, never a cancellation rule or evidence of
// absence. Require both the independently unresolved typed obligation and a
// matching user request. Unknown/scoped/conditional labels retain literal copy.
const cancellationNoticeCopy:Record<string,string>={
 en:'The required advance notice for cancelling an appointment could not be confirmed.',
 sv:'Det gick inte att bekräfta hur långt i förväg en tid måste avbokas.',
 de:'Die erforderliche Vorankündigungsfrist für die Absage eines Termins konnte nicht bestätigt werden.',
 es:'No se pudo confirmar con cuánta antelación es obligatorio cancelar una cita.',
 fa:'مشخص نشد که لغو نوبت باید از چه مدت قبل اعلام شود.',
 ar:'تعذّر تأكيد مهلة الإشعار المسبق المطلوبة لإلغاء الموعد.',
};
const noticeLabels=/^(?:(?:mandatory|required|cancellation) )?advance notice$|^framförhållning$|^(?:obligatorisk )?förvarning$|^Vorankündigung$|^Vorankündigungsfrist$|^antelación necesaria$|^مهلت اطلاع قبلی$|^مهلة الإشعار المسبق$/iu;
const noticeRequest:Record<string,RegExp>={
 en:/\bhow (?:far|long|much)[^.!?؟\n]{0,50}(?:in advance|notice)[^.!?؟\n]{0,65}(?:need|must|have to|required)[^.!?؟\n]{0,60}cancel\p{L}*[^.!?؟\n]{0,20}\bappointments?\b/iu,
 sv:/\bhur (?:långt|länge)[^.!?؟\n]{0,35}(?:förväg|innan|före)[^.!?؟\n]{0,35}(?:måste|behöver)[^.!?؟\n]{0,35}avboka[^.!?؟\n]{0,15}\btid\b/iu,
 de:/\bwie (?:weit|lange)[^.!?؟\n]{0,35}(?:Voraus|vorher)[^.!?؟\n]{0,35}muss[^.!?؟\n]{0,55}\bTermin\b[^.!?؟\n]{0,15}(?:stornieren|absagen)/iu,
 es:/(?:con cu[aá]nta antelación|cu[aá]ntas? horas antes)[^.!?؟\n]{0,45}(?:debo|tengo que|es obligatorio)[^.!?؟\n]{0,35}cancelar[^.!?؟\n]{0,15}\bcita\b/iu,
 fa:/(?:چند|چه مدت|چقدر)[^.!?؟\n]{0,30}(?:قبل|پیش)[^.!?؟\n]{0,25}باید[^.!?؟\n]{0,35}نوبت[^.!?؟\n]{0,20}لغو/iu,
 ar:/(?:كم|ما)[^.!?؟\n]{0,35}(?:قبل|مسبق)[^.!?؟\n]{0,30}يجب[^.!?؟\n]{0,35}(?:إلغاء|الغاء)[^.!?؟\n]{0,15}(?:الحجز|الموعد)/iu,
};
function cancellationNoticeBound(question:string,language:string,label:string,reference:UncertaintyReference|undefined):boolean {
 if(!hasCancellationInformationTopic(question)||!noticeLabels.test(label.trim())||!cancellationNoticeCopy[language])return false;
 // A generic sentence must not erase a requested condition/service scope.
 if(/\b(?:if|unless|when|only|specific|for|om|endast|bara|wenn|falls|nur|für|si|solo|sólo)\b|اگر|فقط|برای|إذا|اذا|فقط/iu.test(question))return false;
 return noticeRequest[language]?.test(question)===true || !!reference && noticeLabels.test(reference.text.trim());
}

/** Backend uncertainty only, never a missing business rule. Multiple requirements
 * need distinct safe literal request references; a single requested requirement
 * can use the localized generic requirement notice without inventing a label. */
export function unresolvedRequirementNotices(language: string, facets: readonly Facet[], outcomes: readonly FacetOutcome[],
  references: readonly UncertaintyReference[], question = ''): readonly RequirementNotice[] | null {
  const wording = copy[language];
  if (!wording) return null;
  const requirements = facets.flatMap(f => f.obligations.filter(o => o.questionType === 'requirement').map(o => ({ f, o })));
  const unresolved = requirements.filter(({ f, o }) => outcomes.some(outcome => outcome.facetId === f.id && outcome.requestAligned &&
    outcome.obligations.some(d => d.obligationId === o.id && d.status === 'UNRESOLVED' && !d.unitIds.length)));
  if (!unresolved.length) return null;
  const labels = new Set<string>(), notices: RequirementNotice[] = [];
  for (const { f, o } of unresolved) {
    const reference = references.find(r => r.facetId === f.id && r.obligationId === o.id && !r.kind);
    const cancellationNotice=cancellationNoticeBound(question,language,o.description,reference);
    if (!reference && requirements.length !== 1) return null;
    const label = cancellationNotice ? 'cancellation-advance-notice' : reference?.text.normalize('NFKC').toLowerCase();
    if (label && labels.has(label)) return null;
    if (label) labels.add(label);
    notices.push(Object.freeze({ facetId: f.id, obligationId: o.id,
      text: cancellationNotice ? cancellationNoticeCopy[language] : reference ? `${wording.about(reference.text)} ${wording.requirement}` : wording.requirement }));
  }
  return Object.freeze(notices);
}
