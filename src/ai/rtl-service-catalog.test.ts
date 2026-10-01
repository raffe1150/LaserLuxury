import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, normalizeGroundedCompoundCatalogReply } from './business-information';
const plan = buildConfiguredServiceCatalogPlan([
  { name: 'Video Consultation', durationMinutes: 60, price: 300, currency: 'SEK' },
  { name: 'خدمة محلية', durationMinutes: 25, price: 450.5, currency: 'SEK' },
  { name: 'Name Only' },
]);
for (const [language, unit] of [['ar', 'دقيقة'], ['fa', 'دقیقه']]) {
  test(`${language}: isolated RTL components preserve exact name, duration, price and currency`, () => {
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(reply.includes(`• \u2068Video Consultation\u2069 — \u206860 ${unit}\u2069 — \u2068300 SEK\u2069`));
    assert.ok(reply.includes(`• \u2068خدمة محلية\u2069 — \u206825 ${unit}\u2069 — \u2068450.5 SEK\u2069`));
    assert.ok(reply.includes('• \u2068Name Only\u2069'));
    assert.doesNotMatch(reply, /[(),]|undefined|null/);
    assert.equal([...reply.matchAll(/\u2068/gu)].length, [...reply.matchAll(/\u2069/gu)].length);
    const location = language === 'ar' ? 'تجدوننا في Aurora Street 742.' : 'ما را در Aurora Street 742 پیدا می‌کنید.';
    const normalized = normalizeGroundedCompoundCatalogReply(`${reply}\n${reply}\n${location}`, plan, language, '', [location]);
    assert.equal(normalized, `${reply}\n${location}`);
    for (const service of plan.displayedServices) assert.equal(normalized.split(service.name).length - 1, 1);
  });
}
for (const [language, unit] of [['en', 'minutes'], ['sv', 'minuter'], ['de', 'Minuten'], ['es', 'minutos']]) {
  test(`${language}: existing LTR rendering remains unchanged`, () => {
    const reply = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(reply.includes(`• Video Consultation (60 ${unit}, 300 SEK)`));
    assert.doesNotMatch(reply, /[\u2068\u2069]/u);
  });
}
