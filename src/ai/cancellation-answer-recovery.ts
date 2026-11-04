import type { AnswerUnit, Evidence, Facet } from './business-information-answer-plan';
import { cancellationPolicyNoticePlan } from './knowledge-planning';
import { isBusinessInformationQuestion, isExplicitBusinessActionRequest, reportedCancellationPolicyPremise } from './business-information';
import { hasCancellationInformationTopic } from './cancellation-information';
import { isCancellationInformationRequested } from './cancellation-policy';
import { detectNormalizedIntent } from './booking-intelligence';
import { isDirectAppointmentLookupPhrase } from '../../booking-security';

const wording: Record<string, readonly [string, string]> = {
  en: ['Automatic appointment cancellation through chat is enabled.', 'The optional late cancellation fee is disabled.'],
  sv: ['Automatisk avbokning av tider via chatt är aktiverad.', 'Den valfria avgiften för sen avbokning är inaktiverad.'],
  de: ['Die automatische Terminabsage per Chat ist aktiviert.', 'Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.'],
  es: ['La cancelación automática de citas por chat está habilitada.', 'El cargo opcional por cancelación tardía está desactivado.'],
  fa: ['لغو خودکار نوبت از طریق چت فعال است.', 'هزینه اختیاری لغو دیرهنگام غیرفعال است.'],
  ar: ['إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.', 'رسوم الإلغاء المتأخر الاختيارية معطّلة.'],
};
const statements = ['Automatic appointment cancellation through chat is enabled in the business configuration.',
  'The optional late cancellation fee is disabled in the business configuration.'];

/** Proposal admission only. The native host still owns reference resolution,
 * appointment-status routing and current evidence; this grants no action or
 * publication authority. Inspect each clause so a policy question cannot carry
 * a separate appointment operation into the documentary producer. */
export function readOnlyCancellationProposalRequest(question: string): boolean {
  const text = question.trim();
  const status = (value: string) => isDirectAppointmentLookupPhrase(value) ||
    /\b(?:status|confirmed|cancelled|canceled|avbokad|bekräftad|storniert|bestätigt|cancelad[oa]|confirmad[oa])\b|(?:لغو|تأیید|تاييد)\s+شد|(?:تم|حالة)\s+(?:إلغاء|الغاء|الحجز|الموعد)/iu.test(value) ||
    /\b(?:when is|what time is|wann ist|cuándo es|när är|confirm|check|verify|bestätigen|prüfen|comprobar|confirmar|bekräfta|kontrollera)\b[^.!?؟]{0,45}\b(?:appointment|booking|termin|buchung|cita|reserva|tid|bokning)\b/iu.test(value);
  const operational = (value: string) => isExplicitBusinessActionRequest(value) || status(value) ||
    detectNormalizedIntent(value) === 'booking_lookup';
  const clauses = text.split(/(?<=[.!?؟؛;])\s+|\n+|\s+(?:and|och|und|y|و)\s+/giu).filter(Boolean);
  return !!text && hasCancellationInformationTopic(text) && isCancellationInformationRequested(text) &&
    isBusinessInformationQuestion(text) && !operational(text) && clauses.length <= 6 && clauses.every(value => !operational(value));
}

/** A reported policy assertion is a premise under an explicit confirmation
 * question, never an operation or evidence. Return true only for exact clauses
 * of the original reporting sentence; keep every word in the verifier request.
 * Unknown reporting grammar retains the existing fail-closed admission path. */
export function isReportedCancellationPremiseClause(question: string, clause: string): boolean {
  if(!readOnlyCancellationProposalRequest(question))return false;
  const premise=reportedCancellationPolicyPremise(question);
  return !!premise && premise.split(/\s+(?:and|och|und|y|و)\s+/giu).includes(clause);
}

// These identify requested information, never business facts. Unknown facet
// wording produces no proposal instead of guessing its semantic relationship.
const chatAspect = /(?<![\p{L}\p{M}])(?:chat\p{L}*|chatt\p{L}*|دردشة|الدردشة|المحادثة|محادثة|چت)(?![\p{L}\p{M}])/iu;
const feeAspect = /\b(?:fees?|free|charges?|costs?|avgift\p{L}*|gratis|gebühr\p{L}*|kosten\p{L}*|gebührenfrei|kostenlos|gratuit\p{L}*|cargos?|cobro\p{L}*|tarifas?)\b|هزینه|جریمه|رایگان|رسوم|مجانا|مجانية|مجاني/iu;
const broadPolicy = (value: string) => hasCancellationInformationTopic(value) &&
  /\b(?:polic\p{L}*|rules|terms|avboknings(?:policy|villkor)|stornierungs(?:richtlinie|bedingungen)|bedingungen|política|condiciones)\b|سیاست|شرایط|سياسة|شروط/iu.test(value);
function requestedConfigurationFacets(question: string, facets: readonly Facet[], aspect: RegExp): string[] {
  if (!aspect.test(question) && !broadPolicy(question)) return [];
  return facets.filter(f => (f.questionType === 'description' || f.questionType === 'permission') &&
    f.obligations.some(o => o.questionType === 'description' || o.questionType === 'permission') &&
    (() => {
      const text = [f.subject, f.attribute, ...f.obligations.map(o => o.description)].join(' ');
      return aspect.test(text) || broadPolicy(text);
    })()).map(f => f.id);
}

/** This parameter is supplied ONLY by the host's current cancellation bridge,
 * never discovered by source-ID heuristics in documentary/model data. */
export function cancellationRecoveryEligible(question: string, businessId: number | undefined, item: Evidence | undefined): item is Evidence {
  if (!item || !Number.isSafeInteger(businessId) || item.businessId !== businessId ||
      item.id !== `configured-cancellation:${businessId}` || item.sourceId !== `business-cancellation-configuration:${businessId}` ||
      !/^[a-f0-9]{64}$/u.test(item.version) || item.chunkId !== item.version || !readOnlyCancellationProposalRequest(question)) return false;
  try {
    const p = JSON.parse(item.text);
    return p.authority === 'business_cancellation_configuration' && p.contractVersion === 1 &&
      p.facts?.automaticCancellationEnabled === true && p.facts?.lateFeeEnabled === false &&
      Array.isArray(p.statements) && statements.every(s => p.statements.includes(s) && item.text.includes(s));
  } catch { return false; }
}

/** Proposals, not accepted facts. Every item still enters the unchanged
 * independent entailment, whole-question coverage and publication contracts. */
export function cancellationConfigurationProposals(question: string, language: string, facets: readonly Facet[],
  item: Evidence): readonly Omit<AnswerUnit, 'id' | 'verification'>[] {
  if (!wording[language] || !cancellationRecoveryEligible(question, item.businessId, item)) return [];
  // Preserve the original accepted contract exactly. Broader questions select
  // only their requested aspects and compatible facets; these descriptive
  // proposals do not satisfy permission/requirement coverage by themselves.
  const original = cancellationPolicyNoticePlan(question, true);
  const originalIds = original ? facets.filter(f => f.obligations.some(o => o.questionType === 'description')).map(f => f.id) : undefined;
  return wording[language].flatMap((text, i) => {
    const facetIds = originalIds || requestedConfigurationFacets(question, facets, i ? feeAspect : chatAspect);
    return facetIds.length ? [{ facetIds, subject: 'business cancellation configuration', predicate: i ? 'optional late fee' : 'automatic chat cancellation',
    value: i ? 'disabled' : 'enabled', modality: 'descriptive', negation: i === 1, scope: 'chat automation and this optional late fee only',
    qualifiers: [], language, text, evidenceRefs: [{ evidenceId: item.id, sourceId: item.sourceId, chunkId: item.chunkId, version: item.version, exactQuote: statements[i] }] } as Omit<AnswerUnit, 'id' | 'verification'>] : [];
  });
}

const limitations: Record<string, string> = {
  en: 'The complete cancellation policy and required advance notice cannot be confirmed from the available information.',
  sv: 'De fullständiga avbokningsvillkoren och hur långt i förväg en avbokning krävs kan inte bekräftas utifrån den tillgängliga informationen.',
  de: 'Die vollständigen Stornierungsbedingungen und die erforderliche Vorankündigungsfrist können anhand der verfügbaren Informationen nicht bestätigt werden.',
  es: 'La política completa de cancelación y la antelación requerida no pueden confirmarse con la información disponible.',
  fa: 'سیاست کامل لغو و مهلت اطلاع قبلی لازم را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.',
  ar: 'لا يمكن تأكيد سياسة الإلغاء الكاملة ومهلة الإشعار المسبق المطلوبة من المعلومات المتاحة.',
};

// Explain the scope of already verified settings, never infer which clauses
// are unavailable from a whole-question label or assert source-wide absence.
const configurationScope: Record<string, string> = {
  en: 'These settings alone do not confirm the required cancellation notice period. Disabling this optional fee does not mean that all cancellations are free.',
  sv: 'Enbart de här inställningarna bekräftar inte hur långt i förväg en avbokning krävs. Att den valfria avgiften är inaktiverad innebär inte att alla avbokningar är gratis.',
  de: 'Diese Einstellungen allein bestätigen keine verbindliche Stornierungsfrist. Die deaktivierte optionale Gebühr bedeutet nicht, dass alle Stornierungen kostenlos sind.',
  es: 'Estos ajustes por sí solos no permiten confirmar con cuánta antelación es obligatorio cancelar. Que este cargo opcional esté desactivado no significa que todas las cancelaciones sean gratuitas.',
  fa: 'این تنظیمات به‌تنهایی مهلت الزامی اطلاع پیش از لغو نوبت را تأیید نمی‌کنند. غیرفعال بودن این هزینه اختیاری به این معنی نیست که همه لغوها رایگان هستند.',
  ar: 'هذه الإعدادات وحدها لا تؤكد مهلة الإشعار الإلزامية قبل الإلغاء. وتعطيل هذه الرسوم الاختيارية لا يعني أن جميع الإلغاءات مجانية.',
};
type VerifiedConfigurationScope = { item: Evidence; evidence: readonly Evidence[]; units: readonly AnswerUnit[] };
function wholeQuestionConfigurationScope(question: string, language: string, facets: readonly Facet[],
  unavailable: readonly { facetId: string; obligationId: string }[], context?: VerifiedConfigurationScope) {
  const f=facets[0],o=f?.obligations[0];
  if(!context || !configurationScope[language] || facets.length!==1 || f.questionType!=='description' || f.attribute!==question ||
    f.obligations.length!==1 || o.questionType!=='description' || o.description!==question || unavailable.length!==1 ||
    unavailable[0].facetId!==f.id || unavailable[0].obligationId!==o.id ||
    !cancellationRecoveryEligible(question,context.item.businessId,context.item) || context.evidence.length!==1 ||
    JSON.stringify(context.evidence[0])!==JSON.stringify(context.item))return;
  // This path is intentionally restricted to the original configuration-only
  // snapshot. Documentary facts and richer obligations keep their existing copy.
  const source=JSON.parse(context.item.text);
  if(source.scope!=='Chat automation settings and this optional late fee only; business-wide permission, other fees and mandatory advance notice are outside this source.')return;
  const expected=cancellationConfigurationProposals(question,language,facets,context.item);
  if(expected.length!==2 || context.units.length!==2 || !expected.every(p=>context.units.some(u=>
    u.verification==='ENTAILED' && u.text===p.text && u.subject===p.subject && u.predicate===p.predicate && u.value===p.value &&
    u.language===p.language && u.scope===p.scope && u.modality===p.modality && u.negation===p.negation &&
    JSON.stringify(u.qualifiers)===JSON.stringify(p.qualifiers) && JSON.stringify(u.facetIds)===JSON.stringify(p.facetIds) &&
    u.evidenceRefs.length===1 && ['evidenceId','sourceId','chunkId','version','exactQuote'].every(k=>
      u.evidenceRefs[0][k as keyof typeof u.evidenceRefs[0]]===p.evidenceRefs[0][k as keyof typeof p.evidenceRefs[0]]))))return;
  return Object.freeze([Object.freeze({...unavailable[0],text:configurationScope[language]})]);
}

/** Presentation only; grants no evidence, completeness or publication authority.
 * Both exact bounded request obligations must independently be unavailable. */
export function cancellationSourceLimitations(question: string, language: string, facets: readonly Facet[],
  unavailable: readonly { facetId: string; obligationId: string }[], context?: VerifiedConfigurationScope) {
  const scoped=wholeQuestionConfigurationScope(question,language,facets,unavailable,context);
  if(scoped)return scoped;
  const plan = cancellationPolicyNoticePlan(question, true);
  if (!plan || !limitations[language] || facets.length !== 2 || unavailable.length !== 2 ||
    facets.some((f, i) => f.attribute !== plan.requestedFacets[i].attribute || f.questionType !== plan.requestedFacets[i].questionType ||
      f.obligations.length !== 1 || f.obligations[0].description !== plan.requestedFacets[i].obligations[0].description ||
      !unavailable.some(u => u.facetId === f.id && u.obligationId === f.obligations[0].id))) return undefined;
  return Object.freeze(unavailable.map(u => Object.freeze({ ...u, text: limitations[language] })));
}
