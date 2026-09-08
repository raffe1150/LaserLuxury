import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const evidence = JSON.parse(readFileSync(new URL('../../tests/fixtures/brain-quality-99dd8079.json', import.meta.url), 'utf8'));
const config = {
  id: 'quality-audit', businessName: 'Example Studio', language: 'sv', timezone: 'Europe/Stockholm',
  systemPrompt: 'Example Studio produces short video advertisements. Parking is behind the studio.',
  toneConfig: { tonePreset: 'warm', responseLength: 'short', formality: 'formal', emojiUsage: 'none', customToneInstructions: '' },
  services: ['Video Consultation', 'test', 'video for tiktok', 'Golden video', 'Reklam'].map(name => ({ name, durationMinutes: 30 })),
};
const now = new Date('2026-09-08T12:30:00Z');
let assessments: any[] = [];
function setup() {
  b.reset(); assessments = [];
  b.configure({
    calendarAdapter: {
      getCalendarId: () => 'mock-calendar',
      getEvents: async () => { throw new Error('information must not read Calendar'); },
      checkSlots: async () => { throw new Error('information must not check slots'); },
      insertAppointment: async () => { throw new Error('information must not book'); },
    },
    recordAppointment: async () => { throw new Error('information must not write DB'); },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    assessBusinessSupportGrounding: async (r: any) => {
      assessments.push(r);
      return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{
        claim: 'Example Studio produces short video advertisements.', candidateQuote: r.candidateReply,
        claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
        evidence: [{ source: 'business_system_prompt', quote: 'Example Studio produces short video advertisements.' }],
      }] };
    },
    assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
}
function completed(sessionId: string, channel: string) {
  b.seedRecentCompletedBooking(sessionId, 'de', { ok: true, bookingId: 'mock-booking', businessId: config.id,
    serviceName: 'Video Consultation', startTime: '2026-09-09T14:00:00+02:00',
    customerName: 'Alex Testsson', customerPhone: '0701234567', sourceChannel: channel }, 30);
}
const turn = (sessionId: string, channel: any, text: string) => b.turn({ sessionId, platformName: channel,
  recipientUserId: sessionId, text, businessConfig: config, now });
const info = evidence.transcripts.find((t: any) => t.scenarioId === 'load-de-business-knowledge' && t.channel === 'instagram');
for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
  test(`${channel}: informational evidence escapes awaiting-service without changing pending state`, async () => {
    setup(); const id = `info-${channel}`;
    await turn(id, channel, 'Hallo, ich möchte für morgen einen Termin buchen.');
    for (const t of info.turns) {
      const result = await turn(id, channel, t.customer);
      assert.equal(result.handled, false, `turn ${t.turn}: ${result.replies.join(' ')}`);
      assert.equal(result.pending?.status, 'awaiting_service');
      assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
      assert.equal(b.resolveConversationLanguage(id, t.customer, config), 'de');
    }
  });
  test(`${channel}: current question and authoritative catalog reach Gemini grounding`, async () => {
    setup(); const id = `ground-${channel}`; completed(id, channel);
    const question = info.turns[0].customer;
    await turn(id, channel, question);
    assert.match(b.completedSupportInstruction(id), /Example Studio produces short video advertisements/);
    assert.match(b.completedSupportInstruction(id), /Golden video/);
    const reply = 'Example Studio erstellt kurze Videoanzeigen.';
    assert.equal(await b.finalizeGeneralAiReply(id, question, reply, 'de'), reply);
    assert.equal(assessments[0].customerMessage, question);
  });
  test(`${channel}: exact post-booking acknowledgment ends naturally`, async () => {
    setup(); const id = `thanks-${channel}`; completed(id, channel);
    const text = evidence.transcripts.find((t: any) => t.scenarioId === 'load-de-booking' && t.channel === 'whatsapp').turns[6].customer;
    const result = await turn(id, channel, text);
    assert.equal(result.handled, true);
    assert.match(result.replies.join(' '), /gern|dank|willkommen/iu);
    assert.doesNotMatch(result.replies.join(' '), /Unternehmensinformationen|buchen\?/);
    assert.equal(assessments.length, 0);
  });
}

for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
  test(`${channel}: changed question cannot inherit the completed service fallback`, async () => {
    setup(); const id = `fresh-${channel}`; completed(id, channel);
    const oldGap = evidence.transcripts.find((t: any) => t.scenarioId === 'load-de-business-knowledge' && t.channel === 'whatsapp').turns[0].assistant;
    const replies: string[] = [];
    for (const [text, expected] of [
      ['Welche Dienstleistungen bieten Sie an?', /Golden video/],
      ['Wie kann ich das Unternehmen erreichen?', /Kontaktmöglichkeiten/],
      ['Was sind Ihre Öffnungszeiten?', /Öffnungszeiten/],
    ] as const) {
      await turn(id, channel, text);
      const answer = await b.finalizeGeneralAiReply(id, text, oldGap, 'de');
      assert.match(answer, expected);
      if (!text.includes('Dienstleistungen')) assert.doesNotMatch(answer, /Video Consultation/);
      replies.push(answer);
    }
    assert.equal(new Set(replies).size, 3);
    assert.equal(assessments.length, 0, 'known stale fallback needs no LLM re-verification');
  });
  test(`${channel}: selected slot survives a business-information detour`, async () => {
    setup(); const id = `selected-${channel}`;
    const start = '2026-09-09T14:00:00+02:00';
    b.seedPending(id, { bookingStateVersion: 3, businessId: config.id, platform: channel, userId: id,
      businessConfig: config, operation: 'new_booking', status: 'awaiting_contact', expectedInput: 'contact',
      language: 'de', service: 'Video Consultation', durationMinutes: 30, selectedDate: '2026-09-09',
      dateTime: start, selectedSlotEnd: '2026-09-09T12:30:00.000Z',
      ownedOfferedSlots: [{ businessId: config.id, platform: channel, userId: id, start,
        end: '2026-09-09T12:30:00.000Z', durationMinutes: 30, service: 'Video Consultation', generatedAt: Date.now() }],
    });
    const before = b.pendingStateSnapshot(id);
    const result = await turn(id, channel, info.turns[0].customer);
    assert.equal(result.handled, false);
    for (const key of ['status', 'service', 'dateTime', 'selectedSlotEnd', 'ownedOfferedSlots']) {
      assert.deepEqual(result.pending?.[key], before?.[key], key);
    }
    assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
  });
}

test('selected tone, language and current evidence are shared across channels', async () => {
  for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
    setup(); const id = `tone-${channel}`;
    await turn(id, channel, info.turns[0].customer);
    const prompt = b.completedSupportInstruction(id);
    assert.match(prompt, /calm, empathetic|warm/i);
    assert.match(prompt, /very short/i);
    assert.match(prompt, /formal phrasing/i);
    assert.match(prompt, /Do not use emoji/i);
    assert.match(prompt, /Answer in de/);
    assert.match(prompt, /no retrieved Knowledge/i);
    assert.match(prompt, /SOURCE structured_business_config/);
  }
});

test('harmless German greeting does not invalidate a grounded factual answer', async () => {
  setup(); const id = 'german-grounding-greeting';
  await turn(id, 'instagram', info.turns[0].customer);
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [{ claim: 'Example Studio produces short video advertisements.',
        candidateQuote: 'Example Studio erstellt kurze Videoanzeigen.', claimKind: 'OTHER', requiresBusinessEvidence: true,
        supported: true, evidence: [{ source: 'business_system_prompt', quote: 'Example Studio produces short video advertisements.' }] }] }),
  });
  const reply = 'Gerne! Example Studio erstellt kurze Videoanzeigen.';
  assert.equal(await b.finalizeGeneralAiReply(id, info.turns[0].customer, reply, 'de'), reply);
});

test('missing evidence fails closed without invented prices, policies, or handoff', async () => {
  setup(); const id = 'missing-information';
  await turn(id, 'instagram', 'Welche Preise und Bedingungen gelten für die Dienstleistungen?');
  b.configure({ assessBusinessSupportGrounding: async () => null });
  const reply = await b.finalizeGeneralAiReply(id, 'Welche Preise und Bedingungen gelten für die Dienstleistungen?',
    'Die Preise sind 50 Euro. Es gibt keine Bedingungen. Ich habe Ihre Anfrage weitergeleitet.', 'de');
  assert.match(reply, /Preise|Bedingungen/);
  assert.doesNotMatch(reply, /50|keine Bedingungen|weitergeleitet/);
});

const localizedQuestions = {
  en: 'Can you tell me about your company and services?', sv: 'Kan du berätta om företaget och era tjänster?',
  de: info.turns[0].customer, es: '¿Puede explicarme qué servicios ofrece la empresa?',
  fa: 'لطفاً درباره شرکت و خدمات توضیح می‌دهید؟', ar: 'هل يمكنك إخباري عن الشركة والخدمات؟',
};
for (const [language, text] of Object.entries(localizedQuestions)) {
  test(`${language}: business information remains read-only across four channels`, async () => {
    for (const channel of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
      setup(); const id = `${language}-${channel}`; b.seedFlowLanguage(id, language);
      const result = await turn(id, channel, text);
      assert.equal(result.handled, false);
      assert.equal(result.pending, null);
      assert.deepEqual(b.geminiToolNames(id), ['logSystemAnalysis']);
      assert.match(b.completedSupportInstruction(id), new RegExp(`Answer in ${language}`));
    }
  });
}

test('different tenant/channel/user sessions cannot share information context', async () => {
  setup();
  const other = { ...config, id: 'other-business', systemPrompt: 'Other business sells flowers.', services: [{ name: 'Flowers', durationMinutes: 30 }] };
  const ids = [b.channelSessionId('instagram', 'same-user', config), b.channelSessionId('whatsapp', 'same-user', config), b.channelSessionId('instagram', 'same-user', other)];
  assert.equal(new Set(ids).size, 3);
  await Promise.all(ids.map((sessionId, i) => b.turn({ sessionId, platformName: i === 1 ? 'whatsapp' : 'instagram',
    recipientUserId: 'same-user', text: info.turns[0].customer, businessConfig: i === 2 ? other : config, now })));
  assert.doesNotMatch(b.completedSupportInstruction(ids[0]), /sells flowers/);
  assert.match(b.completedSupportInstruction(ids[2]), /sells flowers/);
  assert.doesNotMatch(b.completedSupportInstruction(ids[2]), /Parking is behind/);
});
