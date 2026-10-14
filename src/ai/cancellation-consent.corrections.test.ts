import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cancellationConsentAfter, cancellationMessageTime, cancellationFee, readCancellationPolicy,
  withCancellationDelivery, pendingCancellationDelivery, cancellationDeliveryTextComplete,
  cancellationProviderAcknowledged, type CancellationConfirmation } from './cancellation-policy';
process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'synthetic-offline';
globalThis.fetch = async () => { throw Error('Cancellation regressions forbid network and live operations'); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const now = Date.parse('2026-10-14T06:00:00Z');
const channels = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const languages = ['en', 'sv', 'de', 'es', 'fa', 'ar'] as const;
const names = { en: 'English', sv: 'Swedish', de: 'German', es: 'Spanish', fa: 'Persian', ar: 'Arabic' };
const approvals = { en: 'Yes', sv: 'Ja', de: 'Ja', es: 'Sí', fa: 'بله', ar: 'نعم' };
const cancellationWords = { en: /cancel/u, sv: /avboka/u, de: /stornieren/u, es: /cancelar/u, fa: /لغو/u, ar: /إلغاء/u };
afterEach(() => b.reset());

function setup(t: any, language: typeof languages[number] = 'en', platform: typeof channels[number] = 'instagram', hours = 12) {
  t.mock.timers.enable({ apis: ['Date'], now }); b.reset();
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => undefined);
  const config = { id: '8801', businessName: 'Synthetic Audit', timezone: 'Europe/Stockholm', language,
    googleCalendarId: 'cal-8801', calendarProvider: 'custom', allowCancellation: true, cancellationDeadlineMinutes: 1440,
    cancellationFeeEnabled: true, cancellationFeeAmount: 250, cancellationFeeCurrency: 'SEK' };
  const h: any = { config, settings: structuredClone(config), reads: 0, validations: 0, eventReads: 0,
    deletes: 0, rowUpdates: 0, claims: new Map(), rejectDelivery: false, throwDelivery: false, badRender: false,
    onRead: null, onValidation: null, onEvent: null, onClaim: null, unavailableAppointment: false };
  h.id = `${platform}-${language}`; h.user = 'synthetic-owner';
  h.appointment = { id: 'row-A', calendarEventId: 'event-A', source: 'appointments_table', businessId: '8801', platform,
    userId: h.user, customerName: 'Synthetic Visitor', phone: '0701234567', service: 'Consultation',
    start: new Date(now + hours * 3600_000).toISOString(), end: new Date(now + hours * 3600_000 + 45 * 60_000).toISOString(), status: 'booked' };
  h.event = { id: 'event-A', etag: '"synthetic-version-A"', status: 'confirmed', start: { dateTime: h.appointment.start }, end: { dateTime: h.appointment.end },
    extendedProperties: { private: { businessId: '8801', platform, userId: h.user } }, description: 'BusinessId: 8801' };
  b.configure({
    loadCancellationConfig: async id => { assert.equal(id, '8801'); h.reads++; await h.onRead?.(h.reads); return structuredClone(h.settings); },
    validateAppointment: async () => { h.validations++; await h.onValidation?.(h.validations); return h.unavailableAppointment ? null : structuredClone(h.appointment); },
    cancellationConfirmationRender: reply => h.badRender ? 'Ich helfe Ihnen gern auf Deutsch. Was möchten Sie wissen?' : reply,
    calendarAdapter: { getCalendarId: () => config.googleCalendarId, getEvents: async () => h.event ? [h.event] : [],
      getEventById: async () => { h.eventReads++; await h.onEvent?.(h.eventReads); return h.event; },
      checkSlots: async () => ({ available_slots_string: '' }), insertAppointment: async () => { assert.fail('Cancellation must not create bookings'); },
      cancelAppointment: async () => { h.deletes++; h.event = null; return { success: true }; }, verifyEventDeleted: async () => !h.event },
    cancelAppointmentRow: async appointment => { h.rowUpdates++; return { id: appointment.id, business_id: '8801', platform, user_id: h.user, status: 'cancelled', service: appointment.service }; },
    claimOperation: async p => { await h.onClaim?.(); const key = p.type + '|' + p.exactId;
      const old = h.claims.get(key); if (old && old.state.status !== 'failed') return { ...old, claimed: false, duplicateStatus: old.state.status };
      const claim = { claimed: true, keyHash: key, storageId: key, state: { type: p.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } }; h.claims.set(key, claim); return claim; },
    settleOperation: async (handle, status) => { handle.state.status = status; return true; },
    postProcess: async () => undefined, notifyCancellation: async () => true,
    knowledgeSearch: async () => { assert.fail('Executable cancellation policy cannot come from Knowledge'); }, semanticKnowledgeSearch: async () => [],
  });
  b.seedOwnedAppointment({ sessionId: h.id, platform, userId: h.user, businessConfig: config, appointment: structuredClone(h.appointment), operation: 'cancellation' });
  h.turn = (text: string, extra: any = {}) => b.turn({ sessionId: h.id, platformName: platform, recipientUserId: h.user, text,
    businessConfig: config, sendResult: !h.rejectDelivery, sendThrows: h.throwDelivery, ...extra });
  h.reason = () => h.turn(`Please reply in ${names[language]}. My plans changed.`);
  h.yes = (extra: any = {}) => h.turn(approvals[language], extra);
  h.state = () => b.cancellationState(h.id);
  return h;
}

for (const channel of channels) for (const language of languages) test(`${channel}/${language}: complete appointment and fee confirmation precedes one cancellation`, async t => {
  const h = setup(t, language, channel); const reason = await h.reason(); const receipt = h.state()?.confirmation;
  assert.ok(receipt?.deliveredAt !== null); assert.ok(receipt.reply.includes('Consultation')); assert.match(receipt.reply, cancellationWords[language]);
  assert.ok(receipt.reply.includes('SEK')); assert.ok(/250|۲۵۰|٢٥٠/u.test(receipt.reply));
  assert.ok(/2026|۲۰۲۶|٢٠٢٦|۱۴۰۵/u.test(receipt.reply), 'Localized calendar year is retained, including the Persian calendar');
  assert.ok(reason.replies.some((reply: string) => reply.includes(receipt.reply))); assert.equal(h.deletes, 0);
  const result = await h.yes(); assert.equal(h.deletes, 1); assert.equal(h.rowUpdates, 1);
  assert.match(result.replies.join(' '), /cancelled|avbokad|storniert|cancelada|لغو|إلغاء/u);
  assert.ok(result.replies.join(' ').includes('SEK'));
  await h.yes(); assert.equal(h.deletes, 1, 'Repeated consent cannot repeat a completed operation');
});
for (const language of ['de', 'es', 'ar'] as const) test(`${language}: original incomplete language acknowledgement plus yes cannot cancel`, async t => {
  const h = setup(t, language); h.badRender = true; await h.reason(); await h.yes(); assert.equal(h.deletes, 0);
  assert.equal(h.state()?.confirmation?.deliveredAt, null);
  h.badRender = false; const renewed = await h.yes(); assert.equal(h.deletes, 0); assert.match(renewed.replies.join(' '), cancellationWords[language]);
  await h.yes(); assert.equal(h.deletes, 1);
});
for (const channel of channels) test(`${channel}: undelivered confirmation and yes are non-consent`, async t => {
  const h = setup(t, 'en', channel); h.rejectDelivery = true; await h.reason(); await h.yes(); assert.equal(h.deletes, 0);
  h.rejectDelivery = false; await h.yes(); assert.equal(h.deletes, 0); await h.yes(); assert.equal(h.deletes, 1);
});
test('throwing delivery cannot establish consent', async t => {
  const h = setup(t); h.throwDelivery = true; await h.reason(); h.throwDelivery = false; await h.yes(); assert.equal(h.deletes, 0);
  await h.yes(); assert.equal(h.deletes, 1);
});
test('missing confirmation cannot borrow a previous acknowledgement', async t => {
  const h = setup(t); await h.reason(); b.invalidateCancellationConfirmation(h.id); await h.yes(); assert.equal(h.deletes, 0);
  await h.yes(); assert.equal(h.deletes, 1);
});
for (const text of ['Maybe yes', 'Okay', 'Thanks', 'Yes, but change the time', 'Yes and cancel all appointments']) test(`ambiguous consent does not mutate: ${text}`, async t => {
  const h = setup(t); await h.reason(); await h.turn(text); assert.equal(h.deletes, 0);
});
test('delayed yes predating a superseding confirmation cannot execute it', async t => {
  const h = setup(t); await h.reason(); const original = h.state().confirmation;
  t.mock.timers.setTime(now + 60_000); await h.turn('Maybe'); const replacement = h.state().confirmation;
  assert.notEqual(replacement.token, original.token);
  await h.yes({ customerMessageAt: new Date(now + 1000).toISOString() }); assert.equal(h.deletes, 0);
  await h.yes(); assert.equal(h.deletes, 1);
});
test('confirmation expiration and appointment start fail closed', async t => {
  const h = setup(t); await h.reason(); t.mock.timers.setTime(now + 15 * 60_000 + 1); await h.yes(); assert.equal(h.deletes, 0);
});
test('24h05m confirmation followed ten minutes later discloses new fee and requires another yes', async t => {
  const h = setup(t, 'en', 'instagram', 24 + 5 / 60); await h.reason(); assert.equal(h.state().confirmation.feeApplies, false);
  t.mock.timers.setTime(now + 10 * 60_000); const renewed = await h.yes(); assert.equal(h.deletes, 0);
  assert.match(renewed.replies.join(' '), /250 SEK/u); assert.equal(h.state().confirmation.feeApplies, true);
  await h.yes(); assert.equal(h.deletes, 1); assert.equal(h.rowUpdates, 1);
});
for (const hours of [24, 30]) test(`${hours} hours notice uses 24-hour free boundary, not document 37`, async t => {
  const h = setup(t, 'en', 'whatsapp', hours); await h.reason(); assert.equal(h.state().confirmation.feeApplies, false);
  await h.yes(); assert.equal(h.deletes, 1);
});
test('disabled fee with stored positive amount never charges', async t => {
  const h = setup(t); h.settings.cancellationFeeEnabled = false; await h.reason(); assert.equal(h.state().confirmation.feeApplies, false);
  const result = await h.yes(); assert.equal(h.deletes, 1); assert.doesNotMatch(result.replies.join(' '), /250|fee/u);
});
for (const key of ['cancellationFeeAmount', 'cancellationDeadlineMinutes', 'cancellationFeeCurrency', 'cancellationFeeEnabled'] as const) test(`changed ${key} requires fresh disclosure and consent`, async t => {
  const h = setup(t); await h.reason(); const old = h.state().confirmation.token;
  h.settings[key] = ({ cancellationFeeAmount: 500, cancellationDeadlineMinutes: 360, cancellationFeeCurrency: 'EUR', cancellationFeeEnabled: false })[key];
  await h.yes(); assert.equal(h.deletes, 0); assert.notEqual(h.state().confirmation.token, old);
  await h.yes(); assert.equal(h.deletes, 1);
});
for (const phase of ['before-consent', 'validation', 'claimed'] as const) test(`disabled settings ${phase} prevent mutation`, async t => {
  const h = setup(t); await h.reason();
  if (phase === 'before-consent') h.settings.allowCancellation = false;
  if (phase === 'validation') h.onValidation = () => { h.settings.allowCancellation = false; };
  if (phase === 'claimed') h.onClaim = () => { h.settings.allowCancellation = false; };
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.rowUpdates, 0);
});
test('policy update returning to the same values still invalidates old local consent', async t => {
  const h = setup(t); await h.reason(); const old = h.state().confirmation.token; b.cancellationPolicyUpdated(h.settings);
  await h.yes(); assert.equal(h.deletes, 0); assert.notEqual(h.state().confirmation.token, old); await h.yes(); assert.equal(h.deletes, 1);
});
test('mid-claim appointment change refreshes verified details before another consent', async t => {
  const h = setup(t); await h.reason(); h.onClaim = () => { h.onClaim = null;
    h.appointment.start = new Date(now + 14 * 3600_000).toISOString(); h.appointment.end = new Date(now + 14 * 3600_000 + 45 * 60_000).toISOString();
    h.event.start.dateTime = h.appointment.start; h.event.end.dateTime = h.appointment.end; };
  await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.state().confirmation.subject.start, h.appointment.start);
  await h.yes(); assert.equal(h.deletes, 1);
});
for (const calendar of [null, 'replacement-calendar']) test(`current calendar ${calendar ?? 'removed'} cannot reuse captured appointment authority`, async t => {
  const h = setup(t); await h.reason(); h.settings.googleCalendarId = calendar;
  await h.yes(); await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.rowUpdates, 0);
});
for (const invalid of ['missing', 'foreign-business', 'foreign-user', 'stale-status', 'missing-start', 'missing-event'] as const) test(`${invalid} appointment cannot establish consent`, async t => {
  const h = setup(t); if (invalid === 'missing') h.unavailableAppointment = true;
  if (invalid === 'foreign-business') h.appointment.businessId = '8802';
  if (invalid === 'foreign-user') h.appointment.userId = 'foreign-owner';
  if (invalid === 'stale-status') h.appointment.status = 'cancelled';
  if (invalid === 'missing-start') h.appointment.start = '';
  if (invalid === 'missing-event') h.event = null;
  await h.reason(); await h.yes(); assert.equal(h.deletes, 0); assert.equal(h.state()?.confirmation?.deliveredAt ?? null, null);
});
for (const invalid of ['missing-settings', 'foreign-settings', 'missing-fee', 'missing-currency', 'missing-window', 'invalid-fee', 'invalid-currency'] as const) test(`${invalid} policy fails closed`, async t => {
  const h = setup(t); if (invalid === 'missing-settings') h.settings = null;
  if (invalid === 'foreign-settings') h.settings.id = '8802';
  if (invalid === 'missing-fee') delete h.settings.cancellationFeeAmount;
  if (invalid === 'missing-currency') delete h.settings.cancellationFeeCurrency;
  if (invalid === 'missing-window') delete h.settings.cancellationDeadlineMinutes;
  if (invalid === 'invalid-fee') h.settings.cancellationFeeAmount = -1;
  if (invalid === 'invalid-currency') h.settings.cancellationFeeCurrency = '?';
  await h.reason(); await h.yes(); assert.equal(h.deletes, 0);
});
test('coarse provider timestamps must clearly postdate confirmation; no fee is inferred from an amount alone', () => {
  const receipt: any = { deliveredAt: now + 500 };
  assert.equal(cancellationConsentAfter(receipt, now, 1000, now + 500), false);
  assert.equal(cancellationConsentAfter(receipt, now + 1000, 1000, now + 1000), true);
  assert.equal(cancellationConsentAfter({ ...receipt, deliveredAt: now }, now, 1000, now), false);
  assert.equal(cancellationMessageTime(undefined, 1000, now), null);
  assert.equal(cancellationMessageTime((now + 60_000) / 1000, 1000, now), null);
  assert.equal(cancellationMessageTime(now / 1000, 1000, now), new Date(now).toISOString());
  const policy = readCancellationPolicy({ allowCancellation: true, cancellationDeadlineMinutes: 1440, cancellationFeeAmount: 250 })!;
  assert.equal(cancellationFee(policy, new Date(now + 12 * 3600_000).toISOString(), now), false);
});
for (const channel of channels) test(`${channel}: missing or earlier provider timestamps cannot grant consent`, async t => {
  const h = setup(t, 'en', channel); await h.reason();
  await h.yes({ customerMessageAt: null }); assert.equal(h.deletes, 0);
  await h.yes({ customerMessageAt: new Date(now).toISOString() }); assert.equal(h.deletes, 0);
  await h.yes(); assert.equal(h.deletes, 1);
});
for (const channel of channels) test(`${channel}: explicit rejection revokes the delivered confirmation`, async t => {
  const h = setup(t, 'en', channel); await h.reason(); await h.turn('No'); await h.yes(); assert.equal(h.deletes, 0);
});
for (const [language, no] of [['de', 'Nein'], ['es', 'No'], ['ar', 'لا']] as const) test(`${language}: native rejection revokes confirmation`, async t => {
  const h = setup(t, language); await h.reason(); await h.turn(no); await h.yes(); assert.equal(h.deletes, 0);
});

const transportConfig = { id: '8801', timezone: 'Europe/Stockholm', telegramToken: '123456:synthetic-test-token',
  whatsappAccessToken: 'synthetic-whatsapp', whatsappPhoneNumberId: 'synthetic-phone',
  messengerPageAccessToken: 'synthetic-messenger', messengerPageId: 'synthetic-page', instagramAccessToken: 'synthetic-instagram' };
const transportRecipient = '46701234567';
function providerAck(channel: typeof channels[number], recipient = transportRecipient): any {
  if (channel === 'telegram') return { ok: true, result: { message_id: 11, chat: { id: Number(recipient) } } };
  if (channel === 'whatsapp') return { messages: [{ id: 'wamid.synthetic' }], contacts: [{ wa_id: recipient }] };
  return { message_id: 'synthetic-message', recipient_id: recipient };
}
for (const channel of channels) for (const language of languages) test(`${channel}/${language}: final wire text retains complete confirmation and provider acknowledgement`, async t => {
  const h = setup(t, language, channel); await h.reason();
  const receipt: CancellationConfirmation = { ...h.state().confirmation, deliveredAt: null };
  // Exercise the real outbound guard with the shared sender's introductory prefix.
  const outgoing = `Synthetic receptionist. ${receipt.reply}`;
  let sends = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    sends++; const body = JSON.parse(init.body); const text = body.message?.text ?? body.text?.body ?? body.text;
    assert.equal(text, outgoing); return new Response(JSON.stringify(providerAck(channel)), { status: 200 });
  });
  const result = await withCancellationDelivery(receipt, () => b.sendCustomerMessage(channel, transportRecipient, outgoing, transportConfig, 'conversation'));
  assert.equal(result, true); assert.equal(sends, 1); assert.equal(pendingCancellationDelivery(), null);
});
for (const channel of channels) for (const invalid of ['provider-error', 'missing-id', 'foreign-recipient'] as const)
  test(`${channel}: HTTP success with ${invalid} cannot acknowledge cancellation confirmation`, async t => {
    const h = setup(t, 'en', channel); await h.reason(); const receipt: CancellationConfirmation = { ...h.state().confirmation, deliveredAt: null };
    let ack = providerAck(channel, invalid === 'foreign-recipient' ? '46999999999' : transportRecipient);
    if (invalid === 'provider-error') ack = channel === 'telegram' ? { ok: false } : { error: { code: 4 } };
    if (invalid === 'missing-id') ack = {};
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(ack), { status: 200 }));
    assert.equal(await withCancellationDelivery(receipt, () => b.sendCustomerMessage(channel, transportRecipient, receipt.reply, transportConfig, 'conversation')), false);
    assert.equal(receipt.deliveredAt, null);
  });
for (const channel of channels) test(`${channel}: downstream incomplete confirmation is rejected before transport`, async t => {
  const h = setup(t, 'en', channel); await h.reason(); const receipt: CancellationConfirmation = { ...h.state().confirmation, deliveredAt: null };
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Incomplete confirmation must not be sent'));
  assert.equal(await withCancellationDelivery(receipt, () => b.sendCustomerMessage(channel, transportRecipient, 'Okay, I can help.', transportConfig, 'conversation')), false);
});
test('delivery scopes cannot borrow another concurrent request confirmation', async () => {
  const a = { deliveredAt: null, reply: 'Complete confirmation A' } as CancellationConfirmation;
  const b = { deliveredAt: null, reply: 'Complete confirmation B' } as CancellationConfirmation;
  await Promise.all([a, b].map(receipt => withCancellationDelivery(receipt, async () => {
    await Promise.resolve(); assert.equal(pendingCancellationDelivery(), receipt);
    assert.equal(cancellationDeliveryTextComplete(receipt.reply), true);
    assert.equal(cancellationDeliveryTextComplete(receipt === a ? b.reply : a.reply), false);
  })));
  assert.equal(pendingCancellationDelivery(), null); assert.equal(cancellationDeliveryTextComplete('ordinary message'), true);
});
test('Telegram text and voice acknowledgement require a message ID and exact recipient', () => {
  assert.equal(cancellationProviderAcknowledged('telegram', providerAck('telegram'), transportRecipient), true);
  assert.equal(cancellationProviderAcknowledged('telegram', { ok: true, result: { message_id: 11, chat: { id: 999 } } }, transportRecipient), false);
  assert.equal(cancellationProviderAcknowledged('telegram', { ok: true, result: { chat: { id: Number(transportRecipient) } } }, transportRecipient), false);
});
