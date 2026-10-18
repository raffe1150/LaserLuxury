import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { businessInformationTopics, isBusinessInformationQuestion } from './business-information';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { cancellationGroundingConfig } from './cancellation-policy';
import { numericalConstraintSafe } from './numerical-constraints';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'synthetic-offline';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const cases = [
  ['sv', 'Hur långt innan måste jag avboka min tid?', 'Jag vill avboka min tid.', 'Avboka min tid.'],
  ['en', 'What cancellation deadline applies to my appointment?', 'I want to cancel my appointment.', 'Cancel my appointment.'],
  ['de', 'Welche Stornierungsfrist gilt für meinen Termin?', 'Ich möchte meinen Termin stornieren.', 'Bitte stornieren Sie meinen Termin.'],
  ['es', '¿Con cuánto tiempo de antelación debo cancelar?', 'Quiero cancelar mi cita.', 'Por favor cancelar mi cita.'],
  ['fa', 'چند ساعت قبل باید نوبت را لغو کنم؟', 'می‌خواهم نوبتم را لغو کنم.', 'لطفاً نوبتم را لغو کنید.'],
  ['ar', 'كم ساعة قبل الموعد يجب إلغاء الحجز؟', 'أريد إلغاء موعدي.', 'إلغاء موعدي.'],
] as const;
const persianCompound = 'چند ساعت قبل باید نوبت را لغو کنم، شناسه دروازه پارکینگ مشتریان چیست و سرویس Introduktionsbesök چند دقیقه طول می‌کشد؟';
const persianBusinessB = 'چند ساعت قبل باید نوبت را لغو کنم و شناسه دروازه پارکینگ مشتریان چیست؟';
const config = { id: 77, language: 'en', businessName: 'Synthetic studio', systemPrompt: '', allowCancellation: true,
  calendarProvider: 'custom', services: [{ name: 'Introduktionsbesök', durationMinutes: 45 }] };
afterEach(() => b.reset());

for (const [language, policy, desire, command] of cases) {
  test(`${language}: informational cancellation policy versus explicit action`, () => {
    assert.ok(businessInformationTopics(policy).includes('policies'));
    assert.equal(isBusinessInformationQuestion(policy), true);
    for (const action of [desire, command, `${policy} ${command}`]) assert.equal(isBusinessInformationQuestion(action), false, action);
  });
  test(`${language}: Website Chat policy retrieves Knowledge; actual cancellation remains contained and tool-free`, async t => {
    b.reset();
    for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
    let retrievals = 0;
    const requests: any[] = [];
    const forbidden = async () => { assert.fail('Website Chat cannot read or mutate bookings'); };
    b.configure({ semanticLanguageResolver: async () => null,
      knowledgeSearch: async () => { retrievals++; return []; }, semanticKnowledgeSearch: async () => [],
      geminiGenerate: async (p: any) => {
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: '{"canonicalMeaning":"cancellation policy","queries":["avbokning"]}' };
        requests.push(p); return { text: 'Synthetic unsupported answer.' };
      }, assessBusinessSupportGrounding: async () => null,
      calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden },
      recordAppointment: forbidden, postProcess: forbidden,
    });
    const scoped = { ...config, language };
    assert.equal((await b.promptAuditWeb({ chatId: language, message: policy }, scoped)).status, 200);
    assert.ok(retrievals > 0);
    assert.equal(requests.length, 1);
    assert.equal((requests[0].config.tools || []).length, 0);
    const before = retrievals;
    for (const action of [desire, command]) {
      const result = await b.promptAuditWeb({ chatId: language, message: action }, scoped);
      assert.equal(result.status, 200);
      assert.equal(retrievals, before, 'Cancellation actions must not enter the information provider');
    }
    assert.equal(requests.length, 1);
  });

  test(`${language}: policy questions enter shared Knowledge on all four messaging channels`, async t => {
    for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
    const storage = new InMemoryKnowledgeStorage();
    const service = new KnowledgeService(storage, storage);
    const fact = 'Avbokning: En bokad tid ska avbokas senast 37 timmar före besöket.';
    const extracted = documentChunks([{ text: fact }], 'Policy.txt');
    await storage.create({ id: 'policy', businessId: 77, type: 'document', status: 'ready', title: 'Policy.txt',
      content: extracted.content, metadata: extracted.metadata, createdAt: '2026-10-13', updatedAt: '2026-10-13' });
    await storage.replaceChunks(77, 'policy', extracted.chunks.map(chunk => ({
      chunkIndex: Number(chunk.chunk_index), content: String(chunk.content), metadata: chunk.metadata as Record<string, unknown>,
    })));
    for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) {
      b.reset(); let retrievals = 0;
      const forbidden = async () => { assert.fail('An informational policy question must not read or mutate appointments'); };
      b.configure({ semanticLanguageResolver: async () => ({ language, confidence: 1 }), postProcess: async () => {},
        knowledgeSearch: async (id, q, limit) => { retrievals++; return service.search(id, q, limit); },
        semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches),
        geminiGenerate: async () => ({ text: '{"canonicalMeaning":"cancellation policy","queries":["avbokning"]}' }),
        calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden }, recordAppointment: forbidden,
      });
      const id = `policy-${language}-${channel}`;
      const result = await b.turn({ sessionId: id, platformName: channel, recipientUserId: 'synthetic',
        text: policy, businessConfig: { ...config, language } });
      assert.equal(result.handled, false, 'The deterministic booking engine must hand information questions to the shared provider');
      assert.ok(retrievals > 0);
      assert.ok(b.completedSupportInstruction(id).includes(fact));
      assert.deepEqual(b.geminiToolNames(id), []);
    }
  });
}

for (const text of [persianCompound, persianBusinessB, 'What is your cancellation deadline?']) {
  test(`recorded acceptance information question is routed to Knowledge: ${text}`, () => {
    assert.equal(isBusinessInformationQuestion(text), true);
    assert.ok(businessInformationTopics(text).includes('policies'));
  });
}

test('recorded Persian compound and business-B questions use real tenant-filtered Knowledge and structured 45-minute authority (offline models)', async t => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage, storage);
  const factsA = 'Avbokning: En bokad tid ska avbokas senast 37 timmar före besöket. Parkeringsgrindens märkning är TALL-742. Introduktionsbesök tar 52 minuter.';
  const factsB = 'Avbokning: En bokad tid ska avbokas senast 91 timmar före besöket. Parkeringsgrindens märkning är BJORK-915.';
  for (const [businessId, content] of [[77, factsA], [88, factsB]] as const) {
    const extracted = documentChunks([{ text: content }], 'Synthetic.txt');
    await storage.create({ id: 'document-' + businessId, businessId, type: 'document', title: 'Synthetic.txt', status: 'ready', content,
      metadata: extracted.metadata, createdAt: '2026-10-13', updatedAt: '2026-10-13' });
    await storage.replaceChunks(businessId, 'document-' + businessId, extracted.chunks.map(chunk => ({
      chunkIndex: Number(chunk.chunk_index), content: String(chunk.content), metadata: chunk.metadata as Record<string, unknown>,
    })));
  }
  await service.addSource({ businessId: 77, type: 'text', status: 'ready', title: 'Manual', content: 'Manuell information: kvittot skickas inom åtta arbetsdagar.' });
  const queries: number[] = [];
  // This fixture exercises document-owned notice periods, not configured fee
  // windows. Keep cancellation settings on the action fixtures above/below;
  // allowCancellation alone creates authoritative zero-window settings.
  const { allowCancellation: _allowCancellation, ...documentPolicyConfig } = config;
  assert.equal(cancellationGroundingConfig(documentPolicyConfig), undefined);
  for (const [id, text, facts, foreign, reply] of [
    [77, persianCompound, factsA, 'BJORK-915', 'لغو نوبت به اطلاع 37 ساعت قبل نیاز دارد. شناسه دروازه پارکینگ TALL-742 است. سرویس Introduktionsbesök مدت 45 دقیقه دارد.'],
    [88, persianBusinessB, factsB, 'TALL-742', 'لغو نوبت به اطلاع 91 ساعت قبل نیاز دارد. شناسه دروازه پارکینگ BJORK-915 است.'],
  ] as const) {
    b.reset();
    const requests: any[] = [];
    b.configure({ semanticLanguageResolver: async () => null,
      knowledgeSearch: async (businessId, q, limit) => { queries.push(businessId); return service.search(businessId, q, limit); },
      semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: (businessId, matches) => service.validateMatches(businessId, matches),
      geminiGenerate: async (p: any) => {
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: '{"canonicalMeaning":"policy and parking","queries":["avbokning","parkeringsgrindens"]}' };
        requests.push(p); return { text: reply };
      },
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: reply.split(/(?<=\.)\s/u).map((quote, index) => ({ claim: quote, candidateQuote: quote, claimKind: 'OTHER',
          requiresBusinessEvidence: true, supported: true, evidence: index === 2
            ? [{ source: 'structured_business_config', quote: '"durationMinutes": 45' }]
            : [{ source: 'retrieved_knowledge', quote: facts.split('. ')[index] + (index === 0 ? '.' : '') }] })) }),
      assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
    });
    const result = await b.promptAuditWeb({ chatId: 'same-visitor', message: text }, { ...documentPolicyConfig, id, language: 'fa' });
    assert.equal(result.body.text, reply);
    assert.equal(requests.length, 1);
    const instruction = requests[0].config.systemInstruction;
    assert.ok(instruction.includes(facts));
    assert.ok(!instruction.includes(foreign));
    assert.equal((requests[0].config.tools || []).length, 0);
    assert.match(instruction, /"durationMinutes": 45/u);
  }
  assert.ok(queries.includes(77) && queries.includes(88));
  assert.ok((await service.search(77, 'kvittot')).some(match => match.metadata?.source !== 'document'));
});

test('Persian document notice remains subordinate to explicit structured cancellation settings', async t => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
  const notice = 'لغو نوبت به اطلاع 37 ساعت قبل نیاز دارد.';
  const gate = 'شناسه دروازه پارکینگ TALL-742 است.';
  const policy = 'Avbokning: En bokad tid ska avbokas senast 37 timmar före besöket.';
  const parking = 'Parkeringsgrindens märkning är TALL-742.';
  const structured = JSON.stringify({ cancellation: cancellationGroundingConfig(config) });
  assert.equal(numericalConstraintSafe(notice, notice, [policy]), true);
  assert.equal(numericalConstraintSafe(notice, notice, [policy], structured), false);
  const verified: string[] = [];
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [[notice, policy], [gate, parking]].map(([claim, quote]) => ({ claim, candidateQuote: claim,
        claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
        evidence: [{ source: 'retrieved_knowledge', quote }] })) }),
    assessBusinessClaimEntailment: async request => { verified.push(request.atomicClaim);
      return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
  });
  b.businessInformationState('structured-policy-conflict', { ...config, language: 'fa' }, persianBusinessB, 'fa', policy + '\n' + parking);
  const reply = await b.businessSupportGrounding('structured-policy-conflict', persianBusinessB, notice + ' ' + gate, 'fa');
  assert.ok(reply.includes(gate), 'Preserve the independently supported parking fact');
  assert.ok(!reply.includes(notice) && !/37|۳۷/u.test(reply), 'Do not publish a conflicting mandatory notice');
  assert.ok(verified.includes(gate), 'Supported facts still require independent verification');
  assert.ok(!verified.includes(notice), 'A positive model verdict cannot override the structured-policy veto');
});

test('actual cancellation requests still enter the deterministic engine on all four messaging channels', async t => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
  for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) {
    b.reset(); let retrievals = 0;
    b.configure({ semanticLanguageResolver: async () => null, postProcess: async () => {},
      knowledgeSearch: async () => { retrievals++; return []; }, semanticKnowledgeSearch: async () => [],
      calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }),
        cancelAppointment: async () => { assert.fail('No cancellation may execute without ownership and confirmation'); } } as any,
    });
    const result = await b.turn({ sessionId: 'cancel-' + channel, platformName: channel, recipientUserId: 'synthetic',
      text: 'I want to cancel my appointment.', businessConfig: config });
    assert.equal(result.handled, true);
    assert.equal(result.operation?.operation, 'cancellation');
    assert.equal(retrievals, 0);
  }
});
