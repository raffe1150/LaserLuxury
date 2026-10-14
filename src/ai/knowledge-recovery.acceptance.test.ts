import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'synthetic-offline';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const question = 'Finns det en laddstation för elbil vid kundparkeringen?';
const uncertainty = 'Det framgår inte av den tillgängliga kundinformationen om det finns en laddstation för elbil vid kundparkeringen.';
const rejectedQuote = 'Där anges endast att kundparkeringen ligger bakom studion och nås via Tallgrinden.';
const location = 'Kundparkeringen ligger bakom studion.';
const gate = 'Kör in genom Tallgrinden; parkeringsgrindens märkning är TALL-742.';
const config = { id: 77, language: 'sv', businessName: 'Synthetic studio', services: [], systemPrompt: '' };
function claim(text: string, candidateQuote = text, supported = true, evidence = location, kind = 'OTHER') {
  return { claim: text, candidateQuote, claimKind: kind, requiresBusinessEvidence: true, supported,
    evidence: supported ? [{ source: 'retrieved_knowledge', quote: evidence }] : [] };
}
function fixture(t: any, claims: any[], candidate: string, customerQuestion = question) {
  b.reset();
  for (const method of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, method, () => undefined);
  const calls: any[] = [];
  const deps = {
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true,
      allBusinessClaimsSupported: claims.every(c => c.supported), claims }),
    // Reproduce the real UNKNOWN -> UNKNOWN -> ENTAILED sequence without API calls.
    assessBusinessClaimEntailment: async (r: any) => {
      calls.push(r);
      return { relation: r.adjudication ? 'ENTAILED' as const : 'UNKNOWN' as const,
        claimKind: r.claimKind, explicitAbsenceEvidence: false };
    },
  };
  b.configure(deps);
  b.businessInformationState('recovery', config, customerQuestion, 'sv', `${location}\n${gate}`);
  return { calls, deps, run: () => b.businessSupportGrounding('recovery', customerQuestion, candidate, 'sv') };
}
afterEach(() => b.reset());

test('recorded EV-charging failure: supported siblings cannot republish their rejected shared quote', async t => {
  const claims = [
    claim(uncertainty, uncertainty, false, '', 'NEGATIVE_ABSENCE'),
    claim(location, rejectedQuote),
    claim('Kundparkeringen nås via Tallgrinden.', rejectedQuote, true, gate),
    claim('Den tillgängliga kundinformationen anger endast att kundparkeringen ligger bakom studion och nås via Tallgrinden.', rejectedQuote, false, '', 'NEGATIVE_ABSENCE'),
  ];
  const h = fixture(t, claims, `${uncertainty} ${rejectedQuote}`);
  const reply = await h.run();
  assert.doesNotMatch(reply, /Där anges endast|bakom studion|Tallgrinden/u);
  assert.match(reply, /Jag hittar ingen specifik uppgift/u);
  assert.equal(h.calls.length, 0, 'Excluded recovery text must not be rescued by adjudication');
});

for (const overlap of ['exact', 'substring', 'case-and-whitespace', 'unlocatable'] as const) {
  test(`recovery excludes unsupported ${overlap} quote boundaries`, async t => {
    const supported = `${location} Parkering är gratis.`;
    const unsupported = overlap === 'exact' ? supported : overlap === 'substring' ? 'Parkering är gratis.'
      : overlap === 'case-and-whitespace' ? 'PARKERING  ÄR\nGRATIS.' : '';
    const h = fixture(t, [claim(location, supported), claim('Parkering är gratis.', unsupported, false)], supported);
    assert.doesNotMatch(await h.run(), /gratis|bakom studion/u);
  });
}

test('independent supported location survives while a localized knowledge gap remains', async t => {
  const h = fixture(t, [claim(uncertainty, uncertainty, false, '', 'NEGATIVE_ABSENCE'), claim(location)], `${uncertainty} ${location}`);
  const reply = await h.run();
  assert.ok(reply.includes(location));
  assert.match(reply, /Jag hittar ingen specifik uppgift/u);
  assert.equal(h.calls.length, 3, 'Ordinary retry and adjudication still verify the complete atomic quote');
});

test('fully supported factual answer remains unchanged', async t => {
  const h = fixture(t, [claim(location)], location);
  assert.equal(await h.run(), location);
});

test('localized missing-information statement survives messaging sentence limits after partial recovery', async t => {
  const quote = 'Kundparkeringen ligger bakom studion och det kan vara bra att känna till den placeringen när du planerar hur du ska ta dig till ditt besök hos oss.';
  const h = fixture(t, [claim(uncertainty, uncertainty, false, '', 'NEGATIVE_ABSENCE'), claim(location, quote)], `${uncertainty} ${quote}`);
  const reply = await h.run();
  assert.ok(reply.includes(quote), 'Grounding retains the independently verified atomic quotation');
  const sent = b.finalConversationConcision(reply, 45);
  assert.match(sent, /Jag hittar ingen specifik uppgift/u);
  assert.doesNotMatch(sent, /Där anges endast/u);
});

test('two supported atomic claims cannot recover a shared multi-proposition quote', async t => {
  const quote = `${location} Kundparkeringen nås via Tallgrinden.`;
  const h = fixture(t, [claim(location, quote), claim('Kundparkeringen nås via Tallgrinden.', quote, true, gate),
    claim('Parkering är gratis.', 'Parkering är gratis.', false)], `${quote} Parkering är gratis.`);
  assert.doesNotMatch(await h.run(), /bakom studion|Tallgrinden/u);
});

test('compound recovery waits for later rejected verdicts before selecting overlapping earlier quotes', async t => {
  const quote = `${location} Parkering är gratis.`;
  const h = fixture(t, [claim(location, quote), claim('Parkering är gratis.', 'Parkering är gratis.')], quote,
    'Vad är parkeringsreglerna och era öppettider?');
  b.configure({ ...h.deps, assessBusinessClaimEntailment: async (r: any) => ({
    relation: r.atomicClaim === location ? 'ENTAILED' as const : 'CONTRADICTED' as const,
    claimKind: 'OTHER' as const, explicitAbsenceEvidence: false,
  }) });
  assert.doesNotMatch(await h.run(), /gratis|bakom studion/u);
});

test('unavailable recovery verification fails closed', async t => {
  const h = fixture(t, [claim(location), claim(uncertainty, uncertainty, false)], `${location} ${uncertainty}`);
  b.configure({ ...h.deps, assessBusinessClaimEntailment: async () => null });
  assert.doesNotMatch(await h.run(), /bakom studion/u);
});

test('ordinary and adjudication provider prompts both require complete atomic candidate-quote support', async t => {
  const h = fixture(t, [claim(location)], location);
  const instructions: string[] = [];
  b.configure({ assessBusinessSupportGrounding: h.deps.assessBusinessSupportGrounding,
    geminiGenerate: async (p: any) => {
      const instruction = p.config.systemInstruction;
      instructions.push(instruction);
      return { text: JSON.stringify({ relation: 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false }) };
    } });
  assert.doesNotMatch(await h.run(), /bakom studion/u);
  assert.equal(instructions.length, 3);
  for (const instruction of instructions) assert.match(instruction, /exactCandidateQuote must express only that atomic claim/u);
  assert.match(instructions[2], /strict final semantic adjudicator/u);
});
