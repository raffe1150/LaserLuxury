import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, normalizeGroundedCompoundCatalogReply, businessInformationTopics } from './business-information';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const plan = buildConfiguredServiceCatalogPlan(fixture.business.services);
const productionReply = readFileSync(new URL('../../tests/fixtures/compound-catalog-inline-production-de.txt', import.meta.url), 'utf8').trim();
const location = 'Sie finden uns in der Aurora Street 742.';

test('exact fa30dfe live reply: Wir bieten an inline catalog is removed at the normalization boundary', () => {
  const normalized = normalizeGroundedCompoundCatalogReply(productionReply, plan, 'de');
  for (const service of plan.displayedServices) {
    assert.equal(normalized.split(service.name).length - 1, 1, `${service.name} must be displayed once`);
  }
  assert.equal(normalized.includes('Wir bieten an:'), false);
  assert.equal(normalized.split(location).length - 1, 1);
  assert.equal(normalized.split('Sagen Sie mir, wonach Sie suchen, dann helfe ich Ihnen, die passende zu finden.').length - 1, 1);
  assert.equal(normalized, `${formatConfiguredServiceCatalogPlan(plan, 'de')}\n${location}`);
});

const equivalentPreambles: Record<string, string> = {
  en: 'We provide:', sv: 'Vi erbjuder:', es: 'Ofrecemos:', ar: 'نقدم:', fa: 'ارائه می‌دهیم:',
};
for (const [language, preamble] of Object.entries(equivalentPreambles)) {
  test(`${language}: complete inline duplicate with an offering preamble needs no services keyword`, () => {
    const rows = plan.displayedServices.map(service => `${service.name} (${new Intl.NumberFormat(language,
      { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(service.durationMinutes!)}, ${
        new Intl.NumberFormat(language).format(service.price!)} ${service.currency})`);
    const inline = `${preamble} ${new Intl.ListFormat(language).format(rows)}.`;
    const catalog = formatConfiguredServiceCatalogPlan(plan, language);
    const normalized = normalizeGroundedCompoundCatalogReply(`${catalog}\n\n${inline}\n\n${location}`, plan, language);
    // Boundary invariant counts names across complete representations, so unit
    // abbreviations and inline punctuation cannot hide duplicate entries.
    for (const service of plan.displayedServices) assert.equal(normalized.split(service.name).length - 1, 1);
    assert.equal(normalized, `${catalog}\n${location}`);
    assert.equal(normalizeGroundedCompoundCatalogReply(normalized, plan, language), normalized);
  });
}
for (const extra of [
  'Video Consultation services include a written creative brief.',
  'Preparation for Video Consultation requires photo ID.',
  'Opening hours are 09:00 to 17:00.',
  'Contact us at studio@example.test.',
]) {
  test(`literal production normalization preserves separate fact: ${extra}`, () => {
    const normalized = normalizeGroundedCompoundCatalogReply(`${productionReply}\n${extra}`, plan, 'de');
    assert.ok(normalized.includes(extra)); assert.equal(normalized.split(location).length - 1, 1);
    assert.equal(normalized.includes('Wir bieten an:'), false);
  });
}
for (const heading of ['Preparation requirements:', 'Opening hours:', 'Contact details:', 'For customers aged 18+:']) {
  test(`complete enumeration does not erase a separately scoped ${heading} fact`, () => {
    const inline = productionReply.split('\n').find(line => line.startsWith('Wir bieten an:'))!.replace('Wir bieten an:', heading);
    const catalog = formatConfiguredServiceCatalogPlan(plan, 'de');
    const normalized = normalizeGroundedCompoundCatalogReply(`${catalog}\n${inline}`, plan, 'de');
    assert.ok(normalized.includes(inline));
  });
}

test('an incomplete enumeration cannot establish an unrecognized heading as catalog role', () => {
  const partial = 'We provide: Video Consultation (60 min, 300 SEK).';
  const catalog = formatConfiguredServiceCatalogPlan(plan, 'en');
  assert.ok(normalizeGroundedCompoundCatalogReply(`${catalog}\n${partial}`, plan, 'en').includes(partial));
});

const unknownFactualHeadings: Record<string, string> = {
  en: 'A written creative brief is included:',
  de: 'Ein schriftliches Kreativkonzept ist enthalten:',
  sv: 'Ett skriftligt kreativt underlag ingår:',
  es: 'Se incluye un resumen creativo escrito:',
  ar: 'يتضمن موجزًا إبداعيًا مكتوبًا:',
  fa: 'یک خلاصه خلاقانه مکتوب گنجانده شده است:',
};
for (const [language, heading] of Object.entries(unknownFactualHeadings)) {
  for (const separator of [' ', '\n']) {
    test(`${language}: unknown factual heading survives complete enumeration (${separator === ' ' ? 'inline' : 'separate line'})`, () => {
      assert.deepEqual(businessInformationTopics(heading), [], 'exercise the empty-topic edge precisely');
      const original = productionReply.split('\n').find(line => line.startsWith('Wir bieten an:'))!;
      const body = original.slice(original.indexOf(':') + 1).trim();
      const scoped = `${heading}${separator}${body}`;
      const catalog = formatConfiguredServiceCatalogPlan(plan, language);
      const normalized = normalizeGroundedCompoundCatalogReply(`${catalog}\n${scoped}\n${location}`, plan, language);
      assert.ok(normalized.includes(heading), 'a complete enumeration is not permission to delete a factual heading');
      if (separator === ' ') assert.ok(normalized.includes(scoped), 'preserve ambiguous inline scope intact');
      assert.equal(normalized.split(location).length - 1, 1);
    });
  }
}
for (const [language, heading] of [
  ['en', 'We provide a written creative brief:'], ['en', 'We provide only remote sessions:'],
  ['en', 'We do not provide:'], ['de', 'Wir bieten ein schriftliches Kreativkonzept an:'],
  ['de', 'Wir bieten nicht an:'], ['sv', 'Vi erbjuder ett skriftligt underlag:'],
  ['es', 'Ofrecemos un resumen creativo:'], ['ar', 'نقدم موجزًا إبداعيًا:'], ['fa', 'ما ارائه نمی‌دهیم:'],
]) {
  test(`offering word alone cannot erase extra factual or negative prose: ${heading}`, () => {
    const original = productionReply.split('\n').find(line => line.startsWith('Wir bieten an:'))!;
    const inline = original.replace('Wir bieten an:', heading);
    assert.deepEqual(businessInformationTopics(heading), []);
    const catalog = formatConfiguredServiceCatalogPlan(plan, language);
    assert.ok(normalizeGroundedCompoundCatalogReply(`${catalog}\n${inline}`, plan, language).includes(inline));
  });
}

for (const [language, heading] of [
  ['de', 'Ich biete an:'], ['en', 'I provide:'], ['sv', 'Jag erbjuder:'],
  ['es', 'Nosotros ofrecemos:'], ['ar', 'نحن نقدم:'], ['fa', 'ما ارائه می‌دهیم:'],
]) {
  test(`${language}: offering grammar recognizes framing variants rather than one fixed phrase`, () => {
    const inline = productionReply.split('\n').find(line => line.startsWith('Wir bieten an:'))!.replace('Wir bieten an:', heading);
    const catalog = formatConfiguredServiceCatalogPlan(plan, language);
    const normalized = normalizeGroundedCompoundCatalogReply(`${catalog}\n${inline}\n${location}`, plan, language);
    for (const service of plan.displayedServices) assert.equal(normalized.split(service.name).length - 1, 1);
    assert.equal(normalized, `${catalog}\n${location}`);
  });
}
