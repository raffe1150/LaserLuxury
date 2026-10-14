export const MAX_SEMANTIC_QUERIES = 3; // Original + at most two planned queries.
export type SourceLanguage = 'sv' | 'en' | 'de' | 'es' | 'fa' | 'ar';
export type PlannedQueryLanguages = Record<string, SourceLanguage>;
export const normalizeSemanticQuery = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/gu, ' ').trim();
// Planner labels affect query preference only, never source trust or tenant scope.
// Accept labels only for exact queries already retained from this invocation.
export function retainPlannedQueryLanguages(queries: string[], metadata: unknown): PlannedQueryLanguages {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const entries: Array<[string, SourceLanguage]> = [];
  for (const query of queries.slice(0, 7)) {
    if (!Object.prototype.hasOwnProperty.call(metadata, query)) continue;
    const language = (metadata as Record<string, unknown>)[query];
    if (typeof language === 'string' && ['sv', 'en', 'de', 'es', 'fa', 'ar'].includes(language)) {
      entries.push([query, language as SourceLanguage]);
    }
  }
  return Object.fromEntries(entries);
}
// Language hints only; never authorization, grounding or customer-language routing.
// Require multiple distinctive words from actual current source text. Unknown or
// mixed snippets produce no hint; no business locale or editable metadata is used.
const signals: Record<SourceLanguage, string[]> = {
  sv: ['ska', 'före', 'timmar', 'kundparkeringen', 'märkning', 'besöket', 'avbokas', 'avboka', 'avbokning', 'kundparkeringens', 'kundparkering', 'hur', 'länge', 'längd', 'antal', 'grind'],
  en: ['the', 'hours', 'before', 'customer', 'parking', 'appointment', 'cancel'],
  de: ['stunden', 'vor', 'kundenparkplatz', 'kennzeichnung', 'termin', 'absagen', 'muss'],
  es: ['horas', 'antes', 'clientes', 'aparcamiento', 'puerta', 'cita', 'cancelar'],
  fa: ['ساعت', 'قبل', 'نوبت', 'پارکینگ', 'مشتریان', 'شناسه', 'دروازه'],
  ar: ['ساعة', 'قبل', 'الموعد', 'العملاء', 'سيارات', 'بوابة', 'إلغاء'],
};
export function confirmedTextLanguage(text: string): SourceLanguage | null {
  const tokens = new Set(normalizeSemanticQuery(text).split(' '));
  const ranked = (Object.keys(signals) as SourceLanguage[]).map(language => ({ language, count: signals[language].filter(w => tokens.has(w)).length }))
    .sort((a, b) => b.count - a.count);
  return ranked[0].count >= 3 && ranked[0].count - ranked[1].count >= 2 ? ranked[0].language : null;
}
export function selectSemanticQueries(original: string, planned: string[], sourceLanguages: SourceLanguage[] = [], metadata: PlannedQueryLanguages = {}): string[] {
  const labels = retainPlannedQueryLanguages(planned, metadata);
  const seen = new Set([normalizeSemanticQuery(original)]);
  const choices = planned.slice(0, 7).flatMap((text, order) => {
    const query = String(text).trim().slice(0, 120); const key = normalizeSemanticQuery(query);
    if (!key || seen.has(key) || key === normalizeSemanticQuery(original.slice(0, 120))) return [];
    seen.add(key);
    const language = Object.prototype.hasOwnProperty.call(labels, text) ? labels[text] : confirmedTextLanguage(query);
    const preference = language ? sourceLanguages.indexOf(language) : -1;
    return [{ query, language, order, preference: preference < 0 ? 100 : preference }];
  }).sort((a, b) => a.preference - b.preference || a.order - b.order);
  const chosen: typeof choices = [];
  // Cover mixed source languages first, rather than two phrasings of one language.
  for (const choice of choices) {
    if (chosen.some(c => c.language && c.language === choice.language)) continue;
    chosen.push(choice); if (chosen.length === MAX_SEMANTIC_QUERIES - 1) break;
  }
  for (const choice of choices) if (chosen.length < MAX_SEMANTIC_QUERIES - 1 && !chosen.includes(choice)) chosen.push(choice);
  return [original, ...chosen.map(c => c.query)];
}

// Reject explicitly scoped other-workflow evidence before ranking. This narrow
// exclusion grammar is not a general relevance classifier. Unknown relevance
// still needs the existing complete-claim, workflow-aware grounding gate.
const workflows = [
  /personal(?:ens)?\s+(?:interna\s+)?utbildning|staff training|mitarbeiterschulung|formación del personal|آموزش کارکنان|تدريب الموظفين/iu,
  /leveranser|varugrind|deliveries|delivery gate|lieferungen|entregas|تحویل کالا|تسليم البضائع/iu,
  /lagerinventering|inventory|inventur|inventario|موجودی انبار|جرد المخزون/iu,
  /personalparkering|staff parking|mitarbeiterparkplatz|aparcamiento del personal|پارکینگ کارکنان|موقف الموظفين/iu,
];
const exclusiveScope = /(?:endast för|inte kund|inte en kund|är inte kund|gäller personal|only for|not (?:for )?customer|nur für|nicht (?:für )?kunden|solo para|no (?:para )?clientes|نه برای مشتری|مربوط به مشتریان نیست|ليس للعملاء|لا يخص العملاء)/iu;
export function explicitlyWrongWorkflow(text: string, questionMeaning: string): boolean {
  if (!exclusiveScope.test(text) || !workflows.some(workflow => workflow.test(text) && !workflow.test(questionMeaning))) return false;
  // A mixed chunk with an affirmative customer clause is not solely other-workflow
  // material. Preserve it, and let atomic grounding select the applicable facts.
  const customerClause = text.split(/[.;。\n]/u).some(clause =>
    /kund|customer|kunden|clientes|مشتریان|العملاء/iu.test(clause) && !exclusiveScope.test(clause));
  return !customerClause;
}
