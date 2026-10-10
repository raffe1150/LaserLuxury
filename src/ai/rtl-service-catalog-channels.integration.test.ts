import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';
import { beginBusinessInformationTiming } from './business-information-timing';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const config = {
  ...fixture.business,
  services: fixture.business.services.map((service: any, index: number) => ({
    ...service, currency: ['SEK', 'EUR', 'USD'][index % 3],
  })),
  whatsappAccessToken: 'offline-whatsapp-token', whatsappPhoneNumberId: 'rtl-test-phone-id',
  messengerPageAccessToken: 'offline-messenger-token', messengerPageId: 'rtl-test-page-id',
  instagramAccessToken: 'offline-instagram-token',
  telegramToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
};
const plan = buildConfiguredServiceCatalogPlan(config.services);
const cases = [
  ['ar', 'ما الخدمات التي تقدمونها وأين يقع مكانكم؟', 'تجدوننا في Aurora Street 742.', '\u206660 min, 300 SEK\u2069'],
  ['fa', 'چه خدماتی دارید و کجا هستین؟', 'ما را در Aurora Street 742 پیدا می‌کنید.', '\u206660 min, 300 SEK\u2069'],
] as const;
for (const [language, question, location, fields] of cases) {
  for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram'] as const) {
    test(`${channel}/${language}: shared grounded multiline catalog survives real text adapter JSON serialization`, async t => {
      b.reset(); t.after(() => b.reset());
      const timings: any[] = [];
      for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (label: string, event: any) => {
        if (label === '[BusinessInformationTiming]') timings.push(event);
      });
      const recipient = channel === 'whatsapp' ? '46700000001' : channel === 'telegram' ? '123456789' : `rtl-${channel}-customer`;
      const scope = channel === 'whatsapp' ? config.whatsappPhoneNumberId : channel === 'messenger' ? config.messengerPageId : undefined;
      const session = channel === 'telegram' ? recipient : b.channelSessionId(channel, recipient, config, scope);
      b.seedFlowLanguage(session, language);
      beginBusinessInformationTiming(session, question, config.id);
      b.businessInformationState(session, config, question, language, fixture.sources[0].content);
      const catalog = formatConfiguredServiceCatalogPlan(plan, language);
      b.configure({
        assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [
          { claim: catalog, candidateQuote: catalog, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
            evidence: [{ source: 'structured_business_config', quote: '"name": "Video Consultation"' }] },
          { claim: location, candidateQuote: location, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
            evidence: [{ source: 'retrieved_knowledge', quote: fixture.sources[0].content }] },
        ] }),
        assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
      });
      const grounded = await b.finalizeGeneralAiReply(session, question, `${catalog}\n${location}`, language);
      const final = b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question));
      assert.equal(final, `${catalog}\n${location}`);
      assert.ok(final.includes(fields));
      const requests: any[] = [];
      t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
        requests.push({ url: String(url), payload: JSON.parse(init.body) });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.offline-rtl' }], ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      });
      assert.equal(await b.sendCustomerMessage(channel, recipient, final, config, 'conversation'), true);
      assert.equal(requests.length, 1);
      const deliveryEvents = timings.filter(event => event.stage === 'delivery_complete');
      assert.equal(deliveryEvents.length, 1);
      assert.equal(deliveryEvents[0].success, true);
      assert.equal(deliveryEvents[0].httpStatus, 200);
      assert.equal(new Set(timings.map(event => event.businessInfoTurnId)).size, 1);
      const { url, payload } = requests[0];
      const delivered = channel === 'whatsapp' ? payload.text.body : channel === 'telegram' ? payload.text : payload.message.text;
      assert.equal(delivered, final, 'conversation guard and adapter preserve all fields and line breaks byte-for-byte');
      assert.equal(payload.parse_mode, undefined, 'plain text must not introduce markup interpretation');
      assert.match(url, channel === 'telegram' ? /^https:\/\/api.telegram.org\//u : channel === 'instagram' ? /^https:\/\/graph.instagram.com\//u : /^https:\/\/graph.facebook.com\//u);
      for (const service of plan.displayedServices) assert.equal(delivered.split(service.name).length - 1, 1);
      assert.equal(delivered.split('Aurora Street 742').length - 1, 1);
      for (const service of plan.displayedServices) {
        assert.ok(delivered.includes(`\u2066${service.durationMinutes} min, ${service.price} ${service.currency}\u2069`));
      }
      for (const currency of ['SEK', 'EUR', 'USD']) assert.ok(delivered.includes(currency));
      assert.doesNotMatch(delivered, /دقيقة|دقیقه|\u2067| · /u);
      let isolateDepth = 0;
      for (const character of delivered) {
        if (/[\u2066\u2067\u2068]/u.test(character)) isolateDepth++;
        if (character === '\u2069') {
          assert.ok(isolateDepth > 0, 'PDI must close an existing LRI, RLI or FSI');
          isolateDepth--;
        }
        if (character === '\n') assert.equal(isolateDepth, 0, 'isolation must close within each paragraph');
      }
      assert.equal(isolateDepth, 0, 'all directional isolates must have an explicit PDI');
    });
  }
}
