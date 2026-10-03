import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { Models } from '@google/genai';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan, normalizeGroundedCompoundCatalogReply } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const fact = fixture.sources[0].content;
const address = /kundentrén ligger på (.+)\.$/u.exec(fact)![1];
const exactLocationEvidence = /kundentrén ligger på .+\.$/u.exec(fact)![0];
const catalogPlan = buildConfiguredServiceCatalogPlan(fixture.business.services);
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-compound-final' });
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv); b.reset();
});
const scenarios = [
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', `Sie finden uns in der ${address}.`, `Der Standort befindet sich in der ${address}.`],
  ['en', 'Hello! What services do you offer and where are you located?', `Our location is ${address}.`, `Our location is ${address}.`],
  ['sv', 'Hej! Var ligger ni och vilka tjänster erbjuder ni?', `Vår kundentré ligger på ${address}.`, `Vår kundentré ligger på ${address}.`],
  ['es', '¿Dónde están ubicados y qué servicios ofrecen?', `Nuestra ubicación es ${address}.`, `Nuestra ubicación es ${address}.`],
  ['fa', 'آدرستون کجاست و چه خدماتی دارید؟', `آدرس ما ${address} است.`, `آدرس ما ${address} است.`],
  ['ar', 'ما عنوانكم وما الخدمات التي تقدمونها؟', `عنواننا هو ${address}.`, `عنواننا هو ${address}.`],
] as const;
function claim(atomicClaim: string, candidateQuote: string, source: 'structured_business_config' | 'retrieved_knowledge' | 'business_system_prompt', quote: string, supported = true) {
  return { claim: atomicClaim, candidateQuote, claimKind: 'OTHER' as const, requiresBusinessEvidence: true, supported,
    evidence: [{ source, quote }] };
}
function harness(t: any, language: string, question: string, quote: string, atomicClaim: string,
  relation = 'ENTAILED', citation = exactLocationEvidence, order = 'services-first', locationSupported = true, extraSupported = true,
  options: { catalogQuote?: string; catalogAtomic?: string; catalogEvidence?: { source: string; quote: string }[];
    extraClaims?: ReturnType<typeof claim>[]; businessConfig?: any; includeUnknown?: boolean; catalogVerdict?: string; catalogSupported?: boolean; includeSeparateLocation?: boolean; locationEvidence?: ReturnType<typeof claim>["evidence"] } = {}) {
  const catalog = formatConfiguredServiceCatalogPlan(catalogPlan, language);
  const extra = 'All customer communications use Europe/Stockholm time.';
  const catalogClaim = claim(options.catalogAtomic || catalog, options.catalogQuote || catalog, 'structured_business_config', '"name": "Video Consultation"');
  if (options.catalogSupported === false) catalogClaim.supported = false;
  if (options.catalogEvidence) catalogClaim.evidence = options.catalogEvidence as typeof catalogClaim.evidence;
  const unknown = claim(extra, extra, 'structured_business_config', '"timezone": "Europe/Stockholm"', extraSupported);
  const locationClaim = claim(atomicClaim, quote, 'retrieved_knowledge', citation, locationSupported);
  if (options.locationEvidence) locationClaim.evidence = options.locationEvidence;
  const claims = order === 'location-first' ? [locationClaim, unknown, catalogClaim] : [catalogClaim, unknown, locationClaim];
  if (options.includeSeparateLocation === false) claims.splice(claims.indexOf(locationClaim), 1);
  if (options.includeUnknown === false) claims.splice(claims.indexOf(unknown), 1);
  claims.push(...options.extraClaims || []);
  const candidate = claims.map(c => c.candidateQuote).join('\n');
  const assessments: any[] = [], calls: any[] = [];
  let extractionCalls = 0;
  t.mock.method(console, 'info', () => {}); t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
  t.mock.method(Models.prototype as any, 'generateContentInternal', async () => { throw new Error('Gemini must not run'); });
  b.configure({ businessGroundingDiagnostic: value => assessments.push(value) });
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    const body = JSON.parse(params.input[0].content);
    const value = params.instructions.includes('strict business-response claim and citation extractor')
      ? (extractionCalls++, { hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims })
      : (calls.push(body), { relation: body.atomicClaim === extra ? 'UNKNOWN' : body.atomicClaim === atomicClaim ? relation : body.atomicClaim === catalogClaim.claim ? options.catalogVerdict || 'ENTAILED' : 'ENTAILED',
          claimKind: 'OTHER', explicitAbsenceEvidence: false });
    return { output_text: JSON.stringify(value), output: [] } as any;
  });
  const id = `final-${language}`;
  b.businessInformationState(id, options.businessConfig || fixture.business, question, language, `source_id: ${fixture.sources[0].id}\n${fact}`);
  return { catalog, extra, candidate, assessments, calls, extractionCalls: () => extractionCalls, async run() {
    const recovered = await b.finalizeGeneralAiReply(id, question, candidate, language);
    const budget = b.finalConversationConcisionBudget(question);
    // All four production channel handlers apply these same functions after
    // grounding/recovery, whereas older guard-only tests stopped before this.
    const presented = b.enforceAssistantIdentityLifecycle(b.suppressRepeatedPromotionalCta(id, recovered), question, false);
    const sent = b.finalConversationConcision(presented, budget);
    return { recovered, sent, budget };
  } };
}
for (const [language, question, quote, atomicClaim] of scenarios) {
  test(`${language}: separately ENTAILED location survives UNKNOWN structured claim, authoritative catalog and final channel concision`, async t => {
    const h = harness(t, language, question, quote, atomicClaim);
    const { recovered, sent } = await h.run();
    assert.ok(recovered.includes(quote), 'recovery must preserve the verified quote');
    assert.ok(sent.includes(quote), 'the final channel presentation must preserve the verified quote');
    assert.ok(sent.includes(h.catalog));
    assert.equal(sent.includes(h.extra), false);
    assert.equal(h.assessments[0].verifiedEvidence, true);
    assert.equal(h.assessments[0].claimsEntailed, false);
    assert.equal(h.extractionCalls(), 1);
    assert.equal(h.calls.filter(r => r.atomicClaim === atomicClaim).length, 1);
    assert.equal(h.calls.filter(r => r.atomicClaim === h.extra).length, 3, 'UNKNOWN retains retry and adjudication, without emission');
    for (const service of catalogPlan.displayedServices) assert.equal(sent.split(service.name).length - 1, 1);
    assert.doesNotMatch(sent, /keine konkrete Angabe|can't find a specific answer|ingen specifik uppgift|No encuentro información específica|پاسخ مشخصی|لا أجد/);
    if (language === 'de') {
      assert.equal(quote.length, 40); assert.equal(exactLocationEvidence.length, 39); assert.equal(atomicClaim.length, 52);
      assert.equal(b.finalConversationConcision(recovered, 45).includes(address), true, 'verified location must survive final concision');
    }
  });
}
for (const [label, supported, relation, citation] of [
  ['unsupported location', false, 'ENTAILED', exactLocationEvidence],
  ['contradicted location', true, 'CONTRADICTED', exactLocationEvidence],
  ['fabricated citation', true, 'ENTAILED', 'This exact quote is absent from tenant knowledge.'],
] as const) {
  test(`${label}: location is omitted, catalog is authoritative and missing-topic handling remains`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[0];
    const h = harness(t, language, question, quote, atomicClaim, relation, citation, 'services-first', supported, true, catalogOptions(language));
    const { sent } = await h.run();
    assert.equal(sent.includes(address), false); assert.ok(sent.includes(h.catalog)); assert.equal(sent.includes(h.extra), false);
    assert.match(sent, /Standort\/die Adresse/);
    if (label !== 'contradicted location') assert.equal(h.calls.some(r => r.atomicClaim === atomicClaim), false, 'exact evidence gate precedes entailment');
    else assert.equal(h.calls.filter(r => r.atomicClaim === atomicClaim).length, 1);
  });
}
test('English reversed topic and claim order preserve both supported topics', async t => {
  const [, , quote, atomicClaim] = scenarios[1];
  const h = harness(t, 'en', 'Where are you located and what services do you offer?', quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'location-first');
  const { sent } = await h.run(); assert.ok(sent.includes(h.catalog)); assert.ok(sent.includes(quote)); assert.equal(sent.includes(h.extra), false);
});
test('a verified compound quote exceeding a finite word limit cannot be silently lost', async t => {
  const [language, question, location, atomicClaim] = scenarios[1];
  const detail = 'Video Consultation services include a written creative brief with an overview of the planned visual direction, a summary of the agreed goals, a description of the intended audience, and a detailed account of the next preparation steps for the customer to review before the scheduled session.';
  const quote = `${location} ${detail}`;
  const h = harness(t, language, question, quote, `${atomicClaim} ${detail}`, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
    { businessConfig: { ...fixture.business, systemPrompt: detail }, locationEvidence: [
      { source: 'retrieved_knowledge', quote: exactLocationEvidence }, { source: 'business_system_prompt', quote: detail },
    ] });
  const { recovered, sent } = await h.run();
  assert.ok(recovered.split(/\s+/u).length > 90);
  assert.ok(sent.includes(quote)); assert.equal(sent.includes(h.extra), false);
});
test('recommendation, single services, single location and actual booking-action presentation budgets stay unchanged', () => {
  for (const [question, budget] of [
    ['What services do you offer?', 90], ['Where are you located?', 45],
    ['What services and location would you recommend for a first visit?', 90],
    ['What services do you offer and where are you located? Please book an appointment.', 45],
  ] as const) assert.equal(b.finalConversationConcisionBudget(question), budget);
});
test('single-topic services and location replies still require exact evidence and independent entailment', async t => {
  for (const [question, text, source, evidence] of [
    ['What services do you offer?', formatConfiguredServiceCatalogPlan(catalogPlan, 'en'), 'structured_business_config', '"name": "Video Consultation"'],
    ['Where are you located?', scenarios[1][2], 'retrieved_knowledge', exactLocationEvidence],
  ] as const) {
    let entailments = 0;
    b.configure({
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [claim(text, text, source, evidence)] }),
      assessBusinessClaimEntailment: async () => { entailments++; return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
    });
    b.businessInformationState('single-topic', fixture.business, question, 'en', fact);
    const grounded = await b.finalizeGeneralAiReply('single-topic', question, text, 'en');
    assert.equal(b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question)), text);
    assert.equal(entailments, 1);
    b.reset();
  }
});


test('unsupported extra structured claim does not leak or prevent the independently verified location', async t => {
  const [language, question, quote, atomicClaim] = scenarios[0];
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, false);
  const { sent } = await h.run();
  assert.ok(sent.includes(quote)); assert.ok(sent.includes(h.catalog)); assert.equal(sent.includes(h.extra), false);
  assert.equal(h.calls.some(r => r.atomicClaim === h.extra), false, 'unsupported extraction flag fails the exact-evidence gate');
});

test('recommendation catalog and natural clarification remain unchanged through final presentation', async () => {
  const question = 'Welche Dienstleistungen bieten Sie an und welche empfehlen Sie mir?';
  const catalog = formatConfiguredServiceCatalogPlan(catalogPlan, 'de');
  const text = `${catalog}\nWelches Ergebnis möchten Sie erreichen?`;
  let entailments = 0;
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [claim(catalog, catalog, 'structured_business_config', '"name": "Video Consultation"')] }),
    assessBusinessClaimEntailment: async () => { entailments++; return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
  });
  b.businessInformationState('recommendation-final', fixture.business, question, 'de', fact);
  const grounded = await b.finalizeGeneralAiReply('recommendation-final', question, text, 'de');
  assert.equal(b.finalConversationConcisionBudget(question), 90);
  assert.equal(b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question)), text);
  assert.equal(entailments, 1);
});

const naturalIntros: Record<string, string> = {
  de: 'AdMotion Studio bietet an:', en: 'AdMotion Studio offers:', sv: 'AdMotion Studio erbjuder:',
  es: 'AdMotion Studio ofrece:', ar: 'AdMotion Studio يقدم الخدمات التالية:', fa: 'AdMotion Studio این خدمات را ارائه می‌دهد:',
};
const catalogAtomic = 'The business offers the listed services with their configured durations and prices.';
function catalogOptions(language: string) {
  const catalogQuote = formatConfiguredServiceCatalogPlan(catalogPlan, language)
    .replace(/^[^\n]+/u, naturalIntros[language]);
  // The extractor may cite complete exact service objects, not just leaf lines.
  const catalogEvidence = catalogPlan.displayedServices.map(service => ({ source: 'structured_business_config',
    quote: JSON.stringify({ name: service.name, durationMinutes: service.durationMinutes,
      price: service.price, currency: service.currency, active: true }, null, 2) }));
  return { catalogQuote, catalogAtomic, catalogEvidence };
}
for (const [language, question, quote, atomicClaim] of scenarios) {
  test(`${language}: production-shaped natural catalog with object citations is replaced exactly once, with location retained`, async t => {
    const options = catalogOptions(language);
    const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true, options);
    const { recovered, sent, budget } = await h.run();
    assert.equal(budget, Number.POSITIVE_INFINITY, 'compound presentation exemption remains');
    assert.equal(recovered.split(h.catalog).length - 1, 1);
    assert.equal(sent.split(h.catalog).length - 1, 1);
    assert.equal(sent.includes(naturalIntros[language]), false, 'the second catalog preamble is redundant');
    assert.equal(sent.split(quote).length - 1, 1);
    for (const service of catalogPlan.displayedServices) assert.equal(sent.split(service.name).length - 1, 1);
    assert.equal(sent.includes(h.extra), false);
    assert.equal(h.assessments[0].verifiedEvidence, true);
    assert.equal(h.assessments[0].claimsEntailed, false);
    assert.equal(h.calls.filter(r => r.atomicClaim === catalogAtomic).length, 1, 'catalog still passes independent entailment');
    assert.equal(h.calls.filter(r => r.atomicClaim === h.extra).length, 3, 'UNKNOWN still retries and adjudicates');
    assert.equal(h.calls.filter(r => r.atomicClaim === atomicClaim).length, 1);
  });
}
for (const shape of ['leaf-company', 'leaf-services', 'object-services', 'services-fragment'] as const) {
  test(`catalog replacement handles ${shape} citations and topic wording`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[1];
    const options = catalogOptions(language);
    if (shape.startsWith('leaf')) options.catalogEvidence = catalogPlan.displayedServices.map(s => ({
      source: 'structured_business_config', quote: `"name": "${s.name}"`,
    }));
    if (shape.endsWith('services')) options.catalogAtomic = 'The listed services have the configured durations and prices.';
    if (shape === 'services-fragment') options.catalogEvidence = [{ source: 'structured_business_config',
      quote: `"services": [\n${options.catalogEvidence.map(e => e.quote).join(',\n')}\n]` }];
    const businessConfig = shape === 'services-fragment'
      ? { ...fixture.business, services: fixture.business.services.slice(0, 5) } : fixture.business;
    const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'location-first', true, true, { ...options, businessConfig });
    const { sent } = await h.run();
    for (const service of catalogPlan.displayedServices) assert.equal(sent.split(service.name).length - 1, 1);
    assert.equal(sent.split(quote).length - 1, 1);
    assert.equal(h.calls.filter(r => r.atomicClaim === options.catalogAtomic).length, 1);
  });
}
for (const [label, text, field] of [
  ['service description', 'Video Consultation services include a written creative brief.', 'description'],
  ['service preparation', 'Preparation for Video Consultation services requires photo ID.', 'preparation'],
  ['company fact', 'The company was founded in 2018.', 'prompt'],
  ['contact fact', 'Contact us at studio@example.test.', 'prompt'],
  ['hours fact', 'Opening hours are 09:00 to 17:00.', 'prompt'],
] as const) {
  test(`catalog replacement preserves a separate verified ${label}`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[1];
    const businessConfig = { ...fixture.business, systemPrompt: text,
      services: fixture.business.services.map((s: any, i: number) => i === 0 && field !== 'prompt' ? { ...s, [field]: text } : s) };
    const additional = claim(text, text, field === 'prompt' ? 'business_system_prompt' : 'structured_business_config',
      field === 'prompt' ? text : `"${field}": "${text}"`);
    const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
      { ...catalogOptions(language), businessConfig, extraClaims: [additional] });
    const { sent } = await h.run();
    assert.equal(sent.split(text).length - 1, 1);
    assert.equal(sent.split(quote).length - 1, 1);
    assert.equal(sent.includes(h.extra), false);
  });
}
test('verified service outside the displayed catalog is not suppressed', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const omitted = fixture.business.services[5];
  const text = `Our services also include ${omitted.name}.`;
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
    { ...catalogOptions(language), extraClaims: [claim(text, text, 'structured_business_config', `"name": "${omitted.name}"`)] });
  const { sent } = await h.run();
  assert.ok(sent.includes(text)); assert.equal(sent.split(quote).length - 1, 1);
});
test('a shared price value does not suppress a different service outside the displayed catalog', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const omitted = fixture.business.services[5];
  const price = fixture.business.services[0].price;
  const text = `Our services include ${omitted.name} at ${price} SEK.`;
  const businessConfig = { ...fixture.business,
    services: fixture.business.services.map((s: any, i: number) => i === 5 ? { ...s, price } : s) };
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
    { ...catalogOptions(language), businessConfig, extraClaims: [claim(text, text, 'structured_business_config', `"price": ${price}`)] });
  const { sent } = await h.run();
  assert.ok(sent.includes(text)); assert.equal(sent.split(quote).length - 1, 1);
});
test('mixed catalog and location quotation preserves the separate verified location role', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const options = catalogOptions(language);
  options.catalogQuote += `\n${quote}`;
  options.catalogAtomic += ` ${atomicClaim}`;
  options.catalogEvidence.push({ source: 'retrieved_knowledge', quote: exactLocationEvidence });
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true, options);
  const { sent } = await h.run();
  assert.ok(sent.includes(quote), 'preserve the independently verified other topic');
  assertCatalogRoleOnce(sent);
  assert.equal(sent.split(quote).length - 1, 1);
});
test('individual service duration entries already represented by the catalog are not appended again', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const extraClaims = catalogPlan.displayedServices.map(service => {
    const text = `${service.name}: ${service.durationMinutes} minutes.`;
    const entry = claim(text, text, 'structured_business_config', `"name": "${service.name}"`);
    entry.evidence.push({ source: 'structured_business_config', quote: `"durationMinutes": ${service.durationMinutes}` });
    return entry;
  });
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
    { ...catalogOptions(language), extraClaims });
  const { sent } = await h.run();
  for (const service of catalogPlan.displayedServices) assert.equal(sent.split(service.name).length - 1, 1);
  assert.equal(sent.split(quote).length - 1, 1);
});
test('a verified service price for a separate package scope remains', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const text = 'A package of two Video Consultation services costs 500 SEK.';
  const additional = claim(text, text, 'business_system_prompt', text);
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, true,
    { ...catalogOptions(language), businessConfig: { ...fixture.business, id: 717, systemPrompt: text }, extraClaims: [additional] });
  const { sent } = await h.run();
  assert.ok(sent.includes(text)); assert.equal(sent.split(quote).length - 1, 1);
});

// Catalog-role invariant: count configured names in list rows/enumerations,
// separately from legitimate descriptions/preparation referring to those names.
function assertCatalogRoleOnce(reply: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const connectors = ['de', 'en', 'sv', 'es', 'ar', 'fa'].flatMap(locale =>
    new Intl.ListFormat(locale).formatToParts(['@a', '@b'])
      .filter(part => part.type === 'literal').map(part => escape(part.value)));
  const patterns = catalogPlan.displayedServices.map(service =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}]|${connectors.join('|')})${escape(service.name)}(?![\\p{L}\\p{N}])`, 'gu'));

  const roleCounts = catalogPlan.displayedServices.map(() => 0);
  for (const part of reply.split(/\n+/u)) {
    const counts = patterns.map(pattern => [...part.matchAll(pattern)].length);
    // Independently inspect enumeration structure; prose references to a name
    // are not catalog rows. No literal catalog/preamble equality is involved.
    const catalogRole = /^\s*[•*-]\s/u.test(part) || counts.every(count => count > 0) ||
      catalogPlan.displayedServices.some(service => part.startsWith(service.name) &&
        /^\s*[:(–-]/u.test(part.slice(service.name.length)));
    if (catalogRole) counts.forEach((count, index) => { roleCounts[index] += count; });
  }
  catalogPlan.displayedServices.forEach((service, index) =>
    assert.equal(roleCounts[index], 1, `catalog role must display ${service.name} once`));
}

const availableIntros: Record<string, string> = {
  de: 'Verfügbare Dienstleistungen:', en: 'Available services:', sv: 'Tillgängliga tjänster:',
  es: 'Servicios disponibles:', ar: 'الخدمات المتاحة:', fa: 'خدمات موجود:',
};
function inlineCatalog(language: string) {
  return `${availableIntros[language]} ${catalogPlan.displayedServices.map(service =>
    `${service.name} – ${service.durationMinutes} min / ${service.currency} ${service.price?.toFixed(2)}`
  ).join('; ')}.`;
}
for (const [language, question, quote, atomicClaim] of scenarios) {
  for (const includeUnknown of [true, false]) {
    test(`${language}: final catalog-role invariant for mixed inline catalog/location (${includeUnknown ? 'recovery' : 'fully grounded candidate'})`, async t => {
      const location = language === 'de' ? `Unser Kundeneingang befindet sich in der ${address}.` : quote;
      const options = catalogOptions(language);
      options.catalogQuote = `${inlineCatalog(language)}\n${location}`;
      options.catalogAtomic += ` ${atomicClaim}`;
      options.catalogEvidence.push({ source: 'retrieved_knowledge', quote: exactLocationEvidence });
      const h = harness(t, language, question, location, atomicClaim, 'ENTAILED', exactLocationEvidence,
        'services-first', true, true, { ...options, includeUnknown, includeSeparateLocation: false });
      const { sent } = await h.run();
      if (language === 'de' && includeUnknown) console.error('[local-production-shape]', sent);
      assertCatalogRoleOnce(sent);
      assert.ok(sent.includes(h.catalog), 'authoritative catalog is selected once');
      assert.equal(sent.split(location).length - 1, 1);
      assert.equal(sent.includes(h.extra), false);
    });
  }
}
test('fully verified candidate already containing bullet and inline catalogs is normalized before the early return', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const options = catalogOptions(language);
  options.catalogQuote = `${formatConfiguredServiceCatalogPlan(catalogPlan, language)}\n${inlineCatalog(language)}`;
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
    'services-first', true, true, { ...options, includeUnknown: false });
  const { sent } = await h.run();
  assertCatalogRoleOnce(sent); assert.equal(sent.split(quote).length - 1, 1);
});
test('final role normalization preserves non-catalog service facts and all other requested topics in a mixed quote', async t => {
  const [language, , quote, atomicClaim] = scenarios[1];
  const question = 'What services do you offer, where are you located, and what are your opening hours and preparation requirements?';
  const facts = 'Video Consultation services include a written creative brief. Preparation for Video Consultation services requires photo ID. Opening hours are 09:00 to 17:00. Contact us at studio@example.test.';
  const options = catalogOptions(language);
  options.catalogQuote = `${inlineCatalog(language)}\n${facts}\n${quote}`;
  options.catalogAtomic += ` ${facts} ${atomicClaim}`;
  options.catalogEvidence.push({ source: 'retrieved_knowledge', quote: exactLocationEvidence },
    { source: 'business_system_prompt', quote: facts });
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
    'services-first', true, true, { ...options, businessConfig: { ...fixture.business, id: 812, systemPrompt: facts } });
  const { sent } = await h.run();
  assertCatalogRoleOnce(sent);
  for (const fact of facts.split(/(?<=[.])\s/u)) assert.ok(sent.includes(fact));
  assert.equal(sent.split(quote).length - 1, 1);
});

for (const [label, supported, verdict] of [
  ['unsupported', false, 'ENTAILED'], ['contradicted', true, 'CONTRADICTED'],
] as const) {
  test(`mixed catalog with ${label} location cannot be promoted by final role normalization`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[0];
    const options = catalogOptions(language);
    options.catalogQuote = `${inlineCatalog(language)}\n${quote}`;
    options.catalogAtomic += ` ${atomicClaim}`;
    options.catalogEvidence.push({ source: 'retrieved_knowledge', quote: exactLocationEvidence });
    const h = harness(t, language, question, quote, atomicClaim, verdict, exactLocationEvidence,
      'services-first', supported, true, { ...options, catalogVerdict: verdict, catalogSupported: supported });
    const { sent } = await h.run();
    assertCatalogRoleOnce(sent); assert.equal(sent.includes(address), false);
    assert.equal(sent.includes(h.extra), false); assert.match(sent, /Standort\/die Adresse/);
  });
}
test('complete model catalog without UNKNOWN or duplicate clauses is normalized once', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
    'services-first', true, true, { ...catalogOptions(language), includeUnknown: false });
  const { sent } = await h.run(); assertCatalogRoleOnce(sent); assert.equal(sent.split(quote).length - 1, 1);
});
for (const [language] of scenarios) {
  test(`${language}: final-role invariant handles company heading, localized short hour units and decimal prices`, () => {
    const businessName = 'Example Creative Studio';
    const rows = catalogPlan.displayedServices.map(service => `${service.name} – ${
      new Intl.NumberFormat(language, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(service.durationMinutes! / 60)
    } / ${new Intl.NumberFormat(language, { minimumFractionDigits: 2 }).format(service.price!)} ${service.currency}`);
    const duplicate = `${businessName}: ${rows.join('; ')}.`;
    const location = scenarios.find(scenario => scenario[0] === language)![2];
    const original = `${formatConfiguredServiceCatalogPlan(catalogPlan, language)}\n${duplicate}\n${location}`;
    const normalized = normalizeGroundedCompoundCatalogReply(original, catalogPlan, language, businessName);
    assertCatalogRoleOnce(normalized);
    // No second service enumeration can hide behind a different company heading.
    for (const service of catalogPlan.displayedServices) assert.equal(normalized.split(service.name).length - 1, 1);
    assert.equal(normalized.split(location).length - 1, 1);
    assert.equal(normalizeGroundedCompoundCatalogReply(normalized, catalogPlan, language, businessName), normalized, 'normalization is idempotent');
  });
}

test('UNKNOWN extra factual clause attached to a catalog remains excluded after retry/adjudication', async t => {
  const [language, question, quote, atomicClaim] = scenarios[1];
  const options = catalogOptions(language);
  const extra = 'All customer communications use Europe/Stockholm time.';
  options.catalogQuote = `${inlineCatalog(language)}\n${extra}`;
  options.catalogAtomic += ` ${extra}`;
  options.catalogEvidence.push({ source: 'structured_business_config', quote: '\"timezone\": \"Europe/Stockholm\"' });
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
    'services-first', true, true, { ...options, catalogVerdict: 'UNKNOWN' });
  const { sent } = await h.run();
  assertCatalogRoleOnce(sent); assert.equal(sent.includes(extra), false);
  assert.equal(sent.split(quote).length - 1, 1);
  assert.equal(h.calls.filter(call => call.atomicClaim === options.catalogAtomic).length, 3);
});

test('final role normalization retains separately grounded numeric service facts outside catalog values', () => {
  const text = 'Video Consultation (18+).';
  const catalog = formatConfiguredServiceCatalogPlan(catalogPlan, 'en');
  const normalized = normalizeGroundedCompoundCatalogReply(`${catalog}\n${text}`, catalogPlan, 'en');
  assert.ok(normalized.includes(text)); assert.equal(normalized.split(catalog).length - 1, 1);
});

const exactLiveReply = readFileSync(new URL('../../tests/fixtures/compound-catalog-inline-production-de.txt', import.meta.url), 'utf8').trim();
const liveOfferingIntros: Record<string, string> = {
  de: 'Wir bieten an:', en: 'We provide:', sv: 'Vi erbjuder:', es: 'Ofrecemos:', ar: 'نقدم:', fa: 'ارائه می‌دهیم:',
};
for (const [language, question, quote, atomicClaim] of scenarios) {
  const rows = catalogPlan.displayedServices.map(service => `${service.name} (${new Intl.NumberFormat(language,
    { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(service.durationMinutes!)}, ${
      new Intl.NumberFormat(language).format(service.price!)} ${service.currency})`);
  const liveReply = language === 'de' ? exactLiveReply : `${formatConfiguredServiceCatalogPlan(catalogPlan, language)}\n\n${
    liveOfferingIntros[language]} ${new Intl.ListFormat(language).format(rows)}.\n\n${quote}`;
  test(`${language}: boundary invariant detects a complete inline duplicate despite abbreviated units`, () => {
    assert.throws(() => assertCatalogRoleOnce(liveReply), /catalog role must display/);
  });
  for (const includeUnknown of [true, false]) {
    test(`${language}: literal live inline shape at actual normalization boundary: ${includeUnknown ? 'compound recovery' : 'fully grounded early return'}`, async t => {
      const options = catalogOptions(language);
      options.catalogQuote = liveReply;
      options.catalogAtomic += ` ${atomicClaim}`;
      options.catalogEvidence.push({ source: 'retrieved_knowledge', quote: exactLocationEvidence });
      const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
        'services-first', true, true, { ...options, includeUnknown, includeSeparateLocation: false });
      const { recovered, sent } = await h.run();
      // Actual grounded composition return, before channel presentation. Inspect
      // whole lines: Min. punctuation must never hide a complete representation.
      assertCatalogRoleOnce(recovered); assertCatalogRoleOnce(sent);
      assert.equal(recovered, `${h.catalog}\n${quote}`);
      assert.equal(sent.split(quote).length - 1, 1);
      assert.equal(sent.includes(h.extra), false);
      assert.equal(h.assessments[0].claimsEntailed, !includeUnknown, 'prove which grounding return path executed');
    });
  }
}

for (const includeUnknown of [true, false]) {
  test(`verified unknown factual heading survives actual ${includeUnknown ? 'compound recovery' : 'fully grounded early return'}`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[1];
    const heading = 'Each session includes a written creative brief:';
    const body = exactLiveReply.split('\n').find(line => line.startsWith('Wir bieten an:'))!.split(': ')[1];
    const scopedFact = `${heading} ${body}`;
    const options = catalogOptions(language);
    options.catalogQuote = `${formatConfiguredServiceCatalogPlan(catalogPlan, language)}\n${scopedFact}\n${quote}`;
    options.catalogAtomic += ` ${heading} ${atomicClaim}`;
    options.catalogEvidence.push({ source: 'business_system_prompt', quote: heading },
      { source: 'retrieved_knowledge', quote: exactLocationEvidence });
    const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence,
      'services-first', true, true, { ...options, includeUnknown, includeSeparateLocation: false,
        businessConfig: { ...fixture.business, systemPrompt: heading } });
    const { recovered, sent } = await h.run();
    assert.ok(recovered.includes(scopedFact)); assert.ok(sent.includes(scopedFact));
    assert.equal(sent.split(quote).length - 1, 1); assert.equal(sent.includes(h.extra), false);
    assert.equal(h.assessments[0].claimsEntailed, !includeUnknown);
  });
}
