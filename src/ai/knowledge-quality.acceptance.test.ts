import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { extractDocument } from '../knowledge/documents/extract';
import { documentChunks } from '../knowledge/documents/service';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'synthetic-offline';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const persianQuestion = 'چند ساعت قبل باید نوبت را لغو کنم، شناسه دروازه پارکینگ مشتریان چیست و سرویس Introduktionsbesök چند دقیقه طول می‌کشد؟';
const actualCandidate = 'نوبت باید حداقل ۳۷ ساعت قبل لغو شود. شناسه دروازه پارکینگ مشتریان TALL-742 است و سرویس Introduktionsbesök مدت ۴۵ دقیقه دارد.';
const doc = 'En bokad tid ska avbokas senast 37 timmar före besöket.\nKundparkeringen ligger bakom studion. Kör in genom Tallgrinden; parkeringsgrindens märkning är TALL-742.\nIntroduktionsbesök tar 52 minuter.';
const config = { id: 8801, businessName: 'Synthetic Fjord Studio', language: 'fa', services: [{ name: 'Introduktionsbesök', durationMinutes: 45 }], systemPrompt: '' };
const assessment = (claims: any[]) => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims });
const claim = (text: string, quote = text, evidence = text, supported = true, source = 'retrieved_knowledge') => ({
  claim: text, candidateQuote: quote, claimKind: 'OTHER', requiresBusinessEvidence: true, supported,
  evidence: supported ? [{ source, quote: evidence }] : [],
});
function actualClaims() {
  return [
    claim('نوبت باید حداقل ۳۷ ساعت قبل لغو شود.', undefined, 'En bokad tid ska avbokas senast 37 timmar före besöket.'),
    claim('شناسه دروازه پارکینگ مشتریان TALL-742 است.', undefined, 'Kundparkeringen ligger bakom studion. Kör in genom Tallgrinden; parkeringsgrindens märkning är TALL-742.'),
    claim('سرویس Introduktionsbesök مدت ۴۵ دقیقه دارد.', undefined, '"durationMinutes": 45', true, 'structured_business_config'),
  ];
}
function quiet(t: any) {
  b.reset(); for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
}
afterEach(() => b.reset());

test('recorded Persian punctuation failure preserves all three supported facts without changing candidate text', async t => {
  quiet(t); const verdicts: any[] = []; const extractionRequests: any[] = [];
  const original = actualClaims();
  b.configure({ assessBusinessSupportGrounding: async r => { extractionRequests.push(r); return assessment(original); },
    assessBusinessClaimEntailment: async r => { verdicts.push(r); return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; } });
  b.businessInformationState('punctuation', config, persianQuestion, 'fa', doc);
  assert.equal(await b.businessSupportGrounding('punctuation', persianQuestion, actualCandidate, 'fa'), actualCandidate);
  assert.equal(extractionRequests.length, 1, 'A bounded punctuation repair must not need another model extraction');
  assert.equal(verdicts.length, 3);
  const parking = verdicts.find(r => r.atomicClaim.includes('TALL-742'));
  assert.equal(parking.candidateQuote, 'شناسه دروازه پارکینگ مشتریان TALL-742 است');
  assert.equal(parking.atomicClaim, original[1].claim);
  assert.deepEqual(parking.citedEvidence, original[1].evidence);
  assert.equal(original[1].candidateQuote.endsWith('.'), true, 'Extractor-owned assessment must remain immutable');
});

const englishFact = 'The gate marker is TALL-742';
async function englishCase(t: any, candidate: string, quote = englishFact + '.', extras: any[] = [], relation: 'ENTAILED' | 'CONTRADICTED' = 'ENTAILED') {
  quiet(t); const verdicts: any[] = [];
  b.configure({ assessBusinessSupportGrounding: async () => assessment([claim(englishFact + '.', quote, englishFact + '.'), ...extras]),
    assessBusinessClaimEntailment: async r => { verdicts.push(r); return { relation, claimKind: 'OTHER', explicitAbsenceEvidence: false }; } });
  b.businessInformationState('english-punctuation', { ...config, language: 'en' }, 'What is the customer parking gate marker?', 'en', englishFact + '.');
  return { reply: await b.businessSupportGrounding('english-punctuation', 'What is the customer parking gate marker?', candidate, 'en'), verdicts };
}
test('single terminal full stop can be removed at an exact unique end-of-answer clause', async t => {
  const result = await englishCase(t, englishFact); assert.equal(result.reply, englishFact); assert.equal(result.verdicts[0].candidateQuote, englishFact);
});
for (const [name, candidate, quote] of [
  ['different factual value', 'The gate marker is TALL-743', englishFact + '.'],
  ['identifier prefix', englishFact + '9', englishFact + '.'],
  ['decimal-looking identifier suffix', englishFact + '.5', englishFact + '.'],
  ['omitted qualifier', englishFact + ' only on weekdays', englishFact + '.'],
  ['question instead of assertion', englishFact + '?', englishFact + '.'],
  ['extractor question mark', englishFact, englishFact + '?'],
  ['ellipsis', englishFact, englishFact + '...'],
  ['unicode ellipsis plus full stop', englishFact + '…', englishFact + '….'],
  ['reconstructed internal whitespace', 'The gate  marker is TALL-742', englishFact + '.'],
  ['unlocated leading context', 'The claim is false: ' + englishFact, englishFact + '.'],
  ['ambiguous repeated clause', englishFact + ' and ' + englishFact, englishFact + '.'],
] as const) test(`terminal punctuation repair rejects ${name}`, async t => {
  const result = await englishCase(t, candidate, quote);
  assert.doesNotMatch(result.reply, /TALL-742|TALL-743/u);
  assert.equal(result.verdicts.length, 0, 'Near-matches must not reach entailment through punctuation repair');
});
test('a normalized quote cannot overlap an explicitly rejected atomic clause', async t => {
  const result = await englishCase(t, englishFact, englishFact + '.', [claim('Unsupported contextual claim', englishFact, '', false)]);
  assert.doesNotMatch(result.reply, /TALL-742/u);
  assert.equal(result.verdicts.length, 0);
});
test('missing rejected boundary cannot be repaired away', async t => {
  const result = await englishCase(t, englishFact, englishFact + '.', [claim('Unlocated rejection', '', '', false)]);
  assert.doesNotMatch(result.reply, /TALL-742/u);
});
test('punctuation recovery still requires independent entailment', async t => {
  const result = await englishCase(t, englishFact, englishFact + '.', [], 'CONTRADICTED');
  assert.doesNotMatch(result.reply, /TALL-742/u); assert.ok(result.verdicts.length > 0);
});

async function ready(storage: InMemoryKnowledgeStorage, id: string, businessId: number, text: string, title: string) {
  const extracted = documentChunks(await extractDocument(Buffer.from(text), 'txt'), title);
  await storage.create({ id, businessId, title, type: 'document', status: 'ready', content: extracted.content, metadata: extracted.metadata,
    createdAt: '2026-10-13', updatedAt: '2026-10-13' });
  await storage.replaceChunks(businessId, id, extracted.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as Record<string, unknown> })));
}
for (const change of ['delete', 'revise'] as const) test(`normalized Persian quote cannot survive document ${change} during entailment`, async t => {
  quiet(t); const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage, storage);
  await ready(storage, 'A', 8801, doc, 'Synthetic Fjord Studio.txt'); let mutated = false;
  b.configure({ semanticLanguageResolver: async () => ({ language: 'fa', confidence: 1 }),
    knowledgeSearch: (id, q, limit) => service.search(id, q, limit), semanticKnowledgeSearch: async () => [],
    validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches),
    geminiGenerate: async (p: any) => ({ text: p.config.systemInstruction.includes('retrieval query planner') ? '{"canonicalMeaning":"policy parking duration","queries":["avbokas","parkeringsgrindens"]}' : actualCandidate }),
    assessBusinessSupportGrounding: async () => assessment(actualClaims()),
    assessBusinessClaimEntailment: async () => {
      if (!mutated) { mutated = true; if (change === 'delete') await storage.delete(8801, 'A'); else await ready(storage, 'A', 8801, 'Avbokning kräver 49 timmar. Grindens märkning är TALL-843.', 'Synthetic Fjord Studio.txt'); }
      return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false };
    },
  });
  const result = await b.promptAuditWeb({ chatId: change, message: persianQuestion }, config);
  assert.equal(mutated, true); assert.doesNotMatch(result.body.text, /TALL-742|۳۷/u);
});

const namedB = readFileSync(new URL('../../tests/fixtures/knowledge-named-business-b.txt', import.meta.url), 'utf8');
for (const refused of [false, true]) test(`named business-B fixture: correct isolated facts; simulated ${refused ? 'provider refusal stays fail-closed' : 'supported answer survives'}`, async t => {
  quiet(t); const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage, storage);
  await ready(storage, 'A', 8801, doc, 'Synthetic Fjord Studio.txt');
  await ready(storage, 'B', 8802, namedB, 'Synthetic Birch Studio.txt');
  const question = 'چند ساعت قبل باید نوبت را لغو کنم و شناسه دروازه پارکینگ مشتریان چیست؟';
  const answer = 'نوبت باید حداقل ۹۱ ساعت قبل لغو شود. شناسه دروازه پارکینگ مشتریان BJORK-915 است.';
  const refusal = 'اطلاعات قابل‌تأییدی درباره مهلت لغو نوبت یا شناسه دروازه پارکینگ مشتریان این کسب‌وکار در دسترس نیست.';
  const requests: any[] = []; const forbidden = async () => { assert.fail('Website information cannot execute booking or analysis operations'); };
  b.configure({ semanticLanguageResolver: async () => ({ language: 'fa', confidence: 1 }),
    knowledgeSearch: (id, q, limit) => { assert.equal(id, 8802); return service.search(id, q, limit); },
    semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches),
    geminiGenerate: async (p: any) => {
      if (p.config.systemInstruction.includes('retrieval query planner')) return { text: '{"canonicalMeaning":"cancellation and parking","queries":["avbokas","parkeringsgrindens"]}' };
      requests.push(p); return { text: refused ? refusal : answer };
    },
    assessBusinessSupportGrounding: async () => refused ? assessment([claim(refusal, refusal, '', false)]) : assessment([
      claim('نوبت باید حداقل ۹۱ ساعت قبل لغو شود.', undefined, 'För Synthetic Birch Studio ska en bokad tid avbokas senast 91 timmar före besöket.'),
      claim('شناسه دروازه پارکینگ مشتریان BJORK-915 است.', undefined, 'Parkeringsgrindens märkning är BJORK-915.'),
    ]),
    assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
    calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden }, recordAppointment: forbidden, postProcess: forbidden,
  });
  const result = await b.promptAuditWeb({ chatId: 'same-visitor', message: question }, { ...config, id: 8802, businessName: 'Synthetic Birch Studio' });
  assert.equal(requests.length, 1); assert.equal((requests[0].config.tools || []).length, 0);
  const instruction = requests[0].config.systemInstruction;
  assert.ok(instruction.includes(JSON.stringify(namedB.trim()))); assert.doesNotMatch(instruction, /TALL-742|37 timmar|andra syntetiska/u);
  assert.match(instruction, /untrusted_document_text:/u);
  assert.match(instruction, /answering from foreign-language evidence does not require a document-translation request/u);
  assert.match(instruction, /another business or workflow cannot support claims about this business merely because it is stored here/u);
  assert.doesNotMatch(result.body.text, /TALL-742|۳۷/u);
  if (refused) assert.notEqual(result.body.text, refusal); else assert.equal(result.body.text, answer);
  const foreign = await service.search(8801, 'parkeringsgrindens'); assert.deepEqual(await service.validateMatches(8802, foreign), []);
});
