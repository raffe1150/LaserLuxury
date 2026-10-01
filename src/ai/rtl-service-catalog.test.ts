import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, formatRecommendationServiceSummary, normalizeGroundedCompoundCatalogReply } from './business-information';
const plan = buildConfiguredServiceCatalogPlan([
  { name: 'Video Consultation', durationMinutes: 60, price: 300, currency: 'SEK' },
  { name: 'خدمة محلية', durationMinutes: 25, price: 450.5, currency: 'SEK' },
  { name: 'Name Only' },
]);
for (const [language, unit, durationLabel, priceLabel] of [
  ['ar', 'دقيقة', 'المدة', 'السعر'], ['fa', 'دقیقه', 'مدت', 'قیمت'],
]) {
  const block = `• Video Consultation\n${durationLabel}:\n60 ${unit}\n${priceLabel}:\n300 SEK`;
  test(`${language}: one fact per labeled line preserves exact names, duration, price and currency`, () => {
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(reply.includes(block));
    assert.ok(reply.includes(`• خدمة محلية\n${durationLabel}:\n25 ${unit}\n${priceLabel}:\n450.5 SEK`));
    assert.ok(reply.endsWith('• Name Only'));
    assert.doesNotMatch(reply, /[(),\u2066-\u2069]|undefined|null/);
    assert.ok(reply.split('\n').every(line => !(line.includes(unit) && line.includes('SEK'))));
    assert.ok(reply.split('\n').every(line => !(line.includes(priceLabel) && /[0-9]/u.test(line))));
    assert.ok(reply.split('\n').includes('300 SEK'));
    assert.ok(reply.split('\n').includes(`60 ${unit}`));
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
  test(`${language}: matching detail text under an unknown factual heading is preserved`, () => {
    const fact = `OTHER FACTUAL HEADING:\n${durationLabel}:\n60 ${unit}\n${priceLabel}:\n300 SEK`;
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
