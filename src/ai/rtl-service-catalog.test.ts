import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, formatRecommendationServiceSummary, normalizeGroundedCompoundCatalogReply } from './business-information';
const plan = buildConfiguredServiceCatalogPlan([
  { name: 'Video Consultation', durationMinutes: 60, price: 300, currency: 'SEK' },
  { name: 'خدمة محلية', durationMinutes: 25, price: 450.5, currency: 'EUR' },
  { name: 'US Service', durationMinutes: 37.5, price: 9.95, currency: 'USD' },
  { name: 'Name Only' },
]);
for (const [language, unit, durationLabel, priceLabel] of [
  ['ar', 'دقيقة', 'المدة', 'السعر'], ['fa', 'دقیقه', 'مدت', 'قیمت'],
]) {
  const detail = '\u206660 min, 300 SEK\u2069';
  const block = `• Video Consultation\n  ${detail}`;
  test(`${language}: compact two-line service blocks preserves exact names, duration, price and currency`, () => {
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(reply.includes(block));
    assert.ok(reply.includes('• خدمة محلية\n  \u206625 min, 450.5 EUR\u2069'));
    assert.ok(reply.includes('• US Service\n  \u206637.5 min, 9.95 USD\u2069'));
    assert.ok(reply.endsWith('• Name Only'));
    assert.doesNotMatch(reply, /[()]|undefined|null|دقيقة|دقیقه|\u2067| · /u);
    assert.equal([...reply.matchAll(/[\u2066\u2067]/gu)].length, [...reply.matchAll(/\u2069/gu)].length);
    assert.doesNotMatch(reply, new RegExp(`${durationLabel}|${priceLabel}`, 'u'));
    assert.ok(reply.includes(detail));
    assert.equal(block.split('\n').length, 2);
    assert.ok(reply.includes('\n\n• خدمة محلية'), 'service blocks are separated');
    const location = language === 'ar' ? 'تجدوننا في Aurora Street 742.' : 'ما را در Aurora Street 742 پیدا می‌کنید.';
    const normalized = normalizeGroundedCompoundCatalogReply(`${reply}\n${reply}\n${location}`, plan, language, '', [location]);
    assert.equal(normalized, `${reply}\n${location}`);
    for (const service of plan.displayedServices) assert.equal(normalized.split(service.name).length - 1, 1);
    assert.equal(normalizeGroundedCompoundCatalogReply(normalized, plan, language, '', [location]), normalized);
  });
  test(`${language}: recommendation service summary uses the same rendering without changing its service selection`, () => {
    const summary = formatRecommendationServiceSummary(plan, language);
    assert.ok(summary.includes(block));
    assert.equal(summary.split('Video Consultation').length - 1, 1);
  });
  test(`${language}: legacy five-line catalog blocks normalize to one compact catalog`, () => {
    const legacy = `• Video Consultation\n${durationLabel}:\n60 ${unit}\n${priceLabel}:\n300 SEK`;
    const catalog = formatConfiguredServiceCatalogPlan(plan, language);
    assert.equal(normalizeGroundedCompoundCatalogReply(`${catalog}\n${legacy}`, plan, language), catalog);
  });
  test(`${language}: previous localized two-line metadata normalizes without duplicates`, () => {
    const legacy = `• Video Consultation\n  \u206760 ${unit}\u2069 · \u2066300 SEK\u2069`;
    const catalog = formatConfiguredServiceCatalogPlan(plan, language);
    assert.equal(normalizeGroundedCompoundCatalogReply(`${catalog}\n${legacy}`, plan, language), catalog);
  });
  test(`${language}: metadata preserves every configured currency without inference or conversion`, () => {
    for (const currency of ['SEK', 'EUR', 'USD', 'GBP', 'xbt']) {
      const configured = buildConfiguredServiceCatalogPlan([{ name: 'Currency Service', durationMinutes: 60, price: 300, currency }]);
      const reply = formatConfiguredServiceCatalogPlan(configured, language);
      assert.ok(reply.endsWith(`• Currency Service\n  \u206660 min, 300 ${currency}\u2069`));
      if (currency !== 'SEK') assert.doesNotMatch(reply, /SEK/u);
    }
  });
  test(`${language}: missing metadata fields do not introduce separators or infer currency`, () => {
    const configured = buildConfiguredServiceCatalogPlan([
      { name: 'Duration Only', durationMinutes: 20 },
      { name: 'Price Only', price: 75, currency: 'EUR' },
      { name: 'No Currency', durationMinutes: 30, price: 100 },
      { name: 'Free Service', durationMinutes: 15, price: 0, currency: 'USD' },
    ]);
    const reply = formatConfiguredServiceCatalogPlan(configured, language);
    assert.ok(reply.includes('• Duration Only\n  \u206620 min\u2069'));
    assert.ok(reply.includes('• Price Only\n  \u206675 EUR\u2069'));
    assert.ok(reply.includes('• No Currency\n  \u206630 min, 100\u2069'));
    assert.ok(reply.includes('• Free Service\n  \u206615 min, 0 USD\u2069'));
    assert.doesNotMatch(reply, /SEK|undefined|null/u);
  });
  test(`${language}: matching detail text under an unknown factual heading is preserved`, () => {
    const fact = `OTHER FACTUAL HEADING:\n${detail}`;
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.equal(normalizeGroundedCompoundCatalogReply(`${reply}\n${fact}`, plan, language), `${reply}\n${fact}`);
  });
  test(`${language}: qualified detail is never stripped as a catalog field`, () => {
    const qualified = `${durationLabel}: 60 ${unit} — ONLY WITH PRIOR APPROVAL`;
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(normalizeGroundedCompoundCatalogReply(`${reply}\n${qualified}`, plan, language).includes(qualified));
  });
}
for (const [language, unit] of [['en', 'minutes'], ['sv', 'minuter'], ['de', 'Minuten'], ['es', 'minutos']]) {
  test(`${language}: existing LTR rendering remains unchanged`, () => {
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(reply.includes(`• Video Consultation (60 ${unit}, 300 SEK)`));
    assert.doesNotMatch(reply, /[\u2068\u2069]/u);
  });
}
