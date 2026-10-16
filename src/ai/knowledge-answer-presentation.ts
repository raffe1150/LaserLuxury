import type { Facet, FacetOutcome } from './business-information-answer-plan';

/** Request-local references, never new business facts or model-authored prose. */
export type UncertaintyReference = Readonly<{ facetId: string; obligationId: string; text: string }>;
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

export function uncertaintyReferences(question: string, language: string, facets: readonly Facet[], outcomes: readonly FacetOutcome[],
  languageSafe: (text: string) => boolean): readonly UncertaintyReference[] {
  if (!copy[language]) return Object.freeze([]);
  const refs: UncertaintyReference[] = [];
  for (const facet of facets) {
    const outcome = outcomes.find(o => o.facetId === facet.id);
    if (!outcome?.requestAligned) continue;
    for (const obligation of facet.obligations) {
      const label = obligation.description.trim();
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
  return reference ? `${wording.about(reference.text)} ${notice}` : notice;
}
