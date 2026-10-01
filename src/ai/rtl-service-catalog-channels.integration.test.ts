import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const config = {
  ...fixture.business,
  whatsappAccessToken: 'offline-whatsapp-token', whatsappPhoneNumberId: 'rtl-test-phone-id',
  messengerPageAccessToken: 'offline-messenger-token', messengerPageId: 'rtl-test-page-id',
  instagramAccessToken: 'offline-instagram-token',
  telegramToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
};
const plan = buildConfiguredServiceCatalogPlan(config.services);
const cases = [
  ['ar', 'ما الخدمات التي تقدمونها وأين يقع مكانكم؟', 'تجدوننا في Aurora Street 742.', 'المدة:\n60 دقيقة\nالسعر:\n300 SEK'],
  ['fa', 'چه خدماتی دارید و کجا هستین؟', 'ما را در Aurora Street 742 پیدا می‌کنید.', 'مدت:\n60 دقیقه\nقیمت:\n300 SEK'],
] as const;
for (const [language, question, location, fields] of cases) {
  for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram'] as const) {
    test(`${channel}/${language}: shared grounded multiline catalog survives real text adapter JSON serialization`, async t => {
      b.reset(); t.after(() => b.reset());
      for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
      const recipient = channel === 'whatsapp' ? '46700000001' : channel === 'telegram' ? '123456789' : `rtl-${channel}-customer`;
      const scope = channel === 'whatsapp' ? config.whatsappPhoneNumberId : channel === 'messenger' ? config.messengerPageId : undefined;
      const session = channel === 'telegram' ? recipient : b.channelSessionId(channel, recipient, config, scope);
      b.seedFlowLanguage(session, language);
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
      const { url, payload } = requests[0];
      const delivered = channel === 'whatsapp' ? payload.text.body : channel === 'telegram' ? payload.text : payload.message.text;
      assert.equal(delivered, final, 'conversation guard and adapter preserve all fields and line breaks byte-for-byte');
      assert.equal(payload.parse_mode, undefined, 'plain text must not introduce markup interpretation');
      assert.match(url, channel === 'telegram' ? /^https:\/\/api.telegram.org\//u : channel === 'instagram' ? /^https:\/\/graph.instagram.com\//u : /^https:\/\/graph.facebook.com\//u);
      for (const service of plan.displayedServices) assert.equal(delivered.split(service.name).length - 1, 1);
      assert.equal(delivered.split('Aurora Street 742').length - 1, 1);
      assert.doesNotMatch(delivered, /[\u2066-\u2069]/u);
    });
  }
}
