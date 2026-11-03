import type { AnswerUnit, Evidence, Facet } from './business-information-answer-plan';
import { cancellationPolicyNoticePlan } from './knowledge-planning';

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

/** This parameter is supplied ONLY by the host's current cancellation bridge,
 * never discovered by source-ID heuristics in documentary/model data. */
export function cancellationRecoveryEligible(question: string, businessId: number | undefined, item: Evidence | undefined): item is Evidence {
  if (!item || !Number.isSafeInteger(businessId) || item.businessId !== businessId ||
      item.id !== `configured-cancellation:${businessId}` || item.sourceId !== `business-cancellation-configuration:${businessId}` ||
      !/^[a-f0-9]{64}$/u.test(item.version) || item.chunkId !== item.version || !cancellationPolicyNoticePlan(question, true)) return false;
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
  const facetIds = facets.filter(f => f.obligations.some(o => o.questionType === 'description')).map(f => f.id);
  if (!facetIds.length) return [];
  return wording[language].map((text, i) => ({ facetIds, subject: 'business cancellation configuration', predicate: i ? 'optional late fee' : 'automatic chat cancellation',
    value: i ? 'disabled' : 'enabled', modality: 'descriptive', negation: i === 1, scope: 'chat automation and this optional late fee only',
    qualifiers: [], language, text, evidenceRefs: [{ evidenceId: item.id, sourceId: item.sourceId, chunkId: item.chunkId, version: item.version, exactQuote: statements[i] }] }));
}

const limitations: Record<string, string> = {
  en: 'The complete cancellation policy and required advance notice cannot be confirmed from the available information.',
  sv: 'De fullständiga avbokningsvillkoren och hur långt i förväg en avbokning krävs kan inte bekräftas utifrån den tillgängliga informationen.',
  de: 'Die vollständigen Stornierungsbedingungen und die erforderliche Vorankündigungsfrist können anhand der verfügbaren Informationen nicht bestätigt werden.',
  es: 'La política completa de cancelación y la antelación requerida no pueden confirmarse con la información disponible.',
  fa: 'سیاست کامل لغو و مهلت اطلاع قبلی لازم را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.',
  ar: 'لا يمكن تأكيد سياسة الإلغاء الكاملة ومهلة الإشعار المسبق المطلوبة من المعلومات المتاحة.',
};

/** Presentation only; grants no evidence, completeness or publication authority.
 * Both exact bounded request obligations must independently be unavailable. */
export function cancellationSourceLimitations(question: string, language: string, facets: readonly Facet[],
  unavailable: readonly { facetId: string; obligationId: string }[]) {
  const plan = cancellationPolicyNoticePlan(question, true);
  if (!plan || !limitations[language] || facets.length !== 2 || unavailable.length !== 2 ||
    facets.some((f, i) => f.attribute !== plan.requestedFacets[i].attribute || f.questionType !== plan.requestedFacets[i].questionType ||
      f.obligations.length !== 1 || f.obligations[0].description !== plan.requestedFacets[i].obligations[0].description ||
      !unavailable.some(u => u.facetId === f.id && u.obligationId === f.obligations[0].id))) return undefined;
  return Object.freeze(unavailable.map(u => Object.freeze({ ...u, text: limitations[language] })));
}
