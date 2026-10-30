import type { Facet, FacetOutcome } from './business-information-answer-plan';
import {isExplicitBusinessActionRequest} from './business-information';

/** Request-local references, never new business facts or model-authored prose. */
export type UncertaintyReference = Readonly<{ facetId: string; obligationId: string; text: string; kind?:'requested-attribute' }>;
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
const userSpan = (question: string, label: string) => {
  const at = question.indexOf(label), token = /[\p{L}\p{M}\p{N}_-]/u;
  return at >= 0 && !(at > 0 && token.test(question[at-1])) &&
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
      const reference = safeReference(label, 90) && userSpan(question, label) ? label : '';
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
