import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'synthetic-offline';
globalThis.fetch = async () => { throw Error('Offline regression forbids provider network'); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const config = { id: 8801, businessName: 'Synthetic Fjord Studio', language: 'ar', systemPrompt: '', services: [{ name: 'Introduktionsbesök', durationMinutes: 45 }] };
const question = 'قبل كم ساعة يجب إلغاء الموعد، وما علامة بوابة موقف سيارات العملاء، وكم دقيقة تستغرق خدمة Introduktionsbesök؟';
const policy = 'En bokad tid ska avbokas senast 37 timmar före besöket.';
const parking = 'parkeringsgrindens märkning är TALL-742.';
const docDuration = 'Vårt introduktionsbesök beskrivs i detta dokument som 52 minuter långt.';
const document = policy + '\n' + parking + '\n' + docDuration;
const structuredQuote = '"name": "Introduktionsbesök",\n      "durationMinutes": 45';
const claim = (text: string, candidateQuote: string, quote: string, source = 'retrieved_knowledge', supported = true) => ({ claim: text, candidateQuote, claimKind: 'OTHER', requiresBusinessEvidence: true, supported, evidence: [{ source, quote }] });
const assessment = (claims: any[]) => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims });
function quiet(t: any) { b.reset(); for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => undefined); }
afterEach(() => b.reset());

const durationCandidate = 'يجب إلغاء الموعد قبل 37 ساعة على الأقل. علامة بوابة موقف العملاء هي **TALL-742**، وتستغرق خدمة **Introduktionsbesök** مدة **45 دقيقة**.';
function durationClaims() {
  const duration = claim('تستغرق خدمة Introduktionsbesök مدة 45 دقيقة.', 'وتستغرق خدمة **Introduktionsbesök** مدة **45 دقيقة**.', structuredQuote, 'structured_business_config', false);
  duration.evidence.push({ source: 'retrieved_knowledge', quote: docDuration });
  return [
    claim('يجب إلغاء الموعد قبل 37 ساعة على الأقل.', 'يجب إلغاء الموعد قبل 37 ساعة على الأقل.', policy),
    claim('علامة بوابة موقف العملاء هي TALL-742.', 'علامة بوابة موقف العملاء هي **TALL-742**،', parking),
    duration,
  ];
}
test('actual Arabic mixed-citation duration failure: initial extraction receives authoritative hierarchy; ordinary gates retain 45', async t => {
  quiet(t); const original = durationClaims(); const requests: any[] = []; const entailed: any[] = [];
  b.configure({ geminiGenerate: async (p: any) => {
    requests.push(p); const data = JSON.parse(p.contents[0].parts[0].text);
    assert.match(p.config.systemInstruction, /Structured service configuration is authoritative/u);
    assert.match(p.config.systemInstruction, /overrides conflicting uploaded document prose/u);
    assert.match(p.config.systemInstruction, /Identical numbers alone are not support/u);
    assert.match(p.config.systemInstruction, /minimum\/at least is not maximum\/at most/u);
    assert.match(data.groundingEvidence, /"durationMinutes": 45/u); assert.ok(data.groundingEvidence.includes(docDuration));
    assert.equal(data.candidateReply, durationCandidate);
    // Offline provider contract: same recorded atomic claim, now assessed using
    // explicit authority. This does not prove how a real model will comply.
    const corrected = structuredClone(original); corrected[2].supported = true;
    corrected[2].evidence = [{ source: 'structured_business_config', quote: structuredQuote }];
    return { text: JSON.stringify(assessment(corrected)) };
  }, assessBusinessClaimEntailment: async r => { entailed.push(r); return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; } });
  b.businessInformationState('authority', config, question, 'ar', document);
  assert.equal(await b.businessSupportGrounding('authority', question, durationCandidate, 'ar'), durationCandidate);
  assert.equal(requests.length, 1); assert.equal(entailed.length, 3);
  assert.equal(original[2].supported, false); assert.equal(original[2].evidence.length, 2, 'Recorded failed assessment remains unchanged');
  assert.deepEqual(entailed.find(r => r.atomicClaim.includes('45')).citedEvidence, [{ source: 'structured_business_config', quote: structuredQuote }]);
});
for (const fixture of ['recorded rejection', 'unsupported 54', 'wrong service same number'] as const) test(`authority guidance never promotes ${fixture}`, async t => {
  quiet(t); let calls = 0; const claims = durationClaims();
  let candidate = durationCandidate;
  if (fixture === 'unsupported 54') { candidate = candidate.replace('45 دقيقة', '54 دقيقة'); claims[2].claim = claims[2].claim.replace('45', '54'); claims[2].candidateQuote = claims[2].candidateQuote.replace('45', '54'); }
  if (fixture === 'wrong service same number') { candidate = candidate.replace('Introduktionsbesök', 'UnknownService'); claims[2].claim = claims[2].claim.replace('Introduktionsbesök', 'UnknownService'); claims[2].candidateQuote = claims[2].candidateQuote.replace('Introduktionsbesök', 'UnknownService'); }
  b.configure({ assessBusinessSupportGrounding: async () => assessment(claims), assessBusinessClaimEntailment: async r => {
    assert.ok(!r.atomicClaim.includes('دقيقة'), 'Rejected duration must never be auto-granted or sent for recovery entailment'); calls++; return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false };
  } });
  b.businessInformationState('unsupported', config, question, 'ar', document);
  const answer = await b.businessSupportGrounding('unsupported', question, candidate, 'ar');
  assert.doesNotMatch(answer, /45|54|52|UnknownService/u); assert.ok(calls <= 2);
});

const punctuationCandidate = 'يجب إلغاء الموعد قبل **37 ساعة على الأقل** من الزيارة. علامة بوابة موقف العملاء هي **TALL-742**، وتستغرق خدمة **Introduktionsbesök** مدة **45 دقيقة**.';
function punctuationClaims() {
  return [
    claim('يجب إلغاء الموعد قبل 37 ساعة على الأقل من الزيارة.', 'يجب إلغاء الموعد قبل **37 ساعة على الأقل** من الزيارة.', policy),
    claim('علامة بوابة موقف العملاء هي TALL-742.', 'علامة بوابة موقف العملاء هي **TALL-742**.', parking),
    claim('تستغرق خدمة Introduktionsbesök مدة 45 دقيقة.', 'وتستغرق خدمة **Introduktionsbesök** مدة **45 دقيقة**.', structuredQuote, 'structured_business_config'),
  ];
}
async function punctuationCase(t: any, candidate = punctuationCandidate, edit?: (claims: any[]) => void) {
  quiet(t); const claims = punctuationClaims(); edit?.(claims); const calls: any[] = [];
  b.configure({ assessBusinessSupportGrounding: async () => assessment(claims), assessBusinessClaimEntailment: async r => { calls.push(r); return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; } });
  b.businessInformationState('arabic-punctuation', config, question, 'ar', document);
  return { answer: await b.businessSupportGrounding('arabic-punctuation', question, candidate, 'ar'), calls, claims };
}
test('exact Arabic comma/ASCII-period failure preserves generated text and all three independently verified claims', async t => {
  const result = await punctuationCase(t);
  assert.equal(result.answer, punctuationCandidate); assert.equal(result.calls.length, 3);
  const parked = result.calls.find(r => r.atomicClaim.includes('TALL-742'));
  assert.equal(parked.candidateQuote, 'علامة بوابة موقف العملاء هي **TALL-742**،');
  assert.deepEqual(parked.citedEvidence, [{ source: 'retrieved_knowledge', quote: parking }]);
  assert.ok(result.claims[1].candidateQuote.endsWith('.'), 'Extractor-owned original remains immutable');
});
for (const [name, candidate, edit] of [
  ['changed identifier', punctuationCandidate.replace('TALL-742', 'TALL-743'), undefined],
  ['identifier suffix', punctuationCandidate.replace('TALL-742', 'TALL-7429'), undefined],
  ['omitted qualifier', punctuationCandidate.replace('**TALL-742**،', '**TALL-742** أيام الاثنين فقط،'), undefined],
  ['internal whitespace', punctuationCandidate.replace('علامة بوابة', 'علامة  بوابة'), undefined],
  ['question boundary', punctuationCandidate.replace('**TALL-742**،', '**TALL-742**؟'), undefined],
  ['unverified leading context', punctuationCandidate.replace('علامة بوابة', 'هذه عبارة خاطئة: علامة بوابة'), undefined],
  ['unaccounted clause between facts', punctuationCandidate.replace('، وتستغرق', '، الدخول مجاني، وتستغرق'), undefined],
  ['repeated clause', punctuationCandidate + ' علامة بوابة موقف العملاء هي **TALL-742**،', undefined],
  ['partial identifier quote', punctuationCandidate, (c: any[]) => { c[1].candidateQuote = '**TALL-742**.'; }],
  ['partial predicate quote', punctuationCandidate, (c: any[]) => { c[1].candidateQuote = 'هي **TALL-742**.'; }],
  ['unverified next clause', punctuationCandidate, (c: any[]) => { c[2].supported = false; }],
  ['untrusted document next boundary', punctuationCandidate, (c: any[]) => { c[2].evidence = [{ source: 'retrieved_knowledge', quote: docDuration }]; }],
  ['overlapping rejected claim', punctuationCandidate, (c: any[]) => { c.push(claim('Rejected contextual claim', 'علامة بوابة موقف العملاء هي **TALL-742**،', '', 'retrieved_knowledge', false)); }],
  ['unlocated rejected claim', punctuationCandidate, (c: any[]) => { c.push(claim('Unlocated rejected fact', '', '', 'retrieved_knowledge', false)); }],
] as const) test(`Arabic punctuation rejects ${name}`, async t => {
  const result = await punctuationCase(t, candidate, edit);
  assert.doesNotMatch(result.answer, /TALL-742|TALL-743/u);
  assert.ok(result.calls.every(r => !r.atomicClaim.includes('TALL-742')), 'Unsafe quote must not reach entailment');
});

for (const language of ['sv', 'en', 'de', 'es', 'fa', 'ar']) test(`short ${language} question retains tagged Swedish planner query in actual shared retrieval`, async t => {
  quiet(t); const storage = new InMemoryKnowledgeStorage();
  const text = policy + '\n' + parking; const parsed = documentChunks([{ text, section: 'Text' }], 'Synthetic.txt');
  for (const [id, businessId, status] of [['A',8801,'ready'],['B',8802,'ready'],['failed',8801,'failed']] as const) {
    await storage.create({id,businessId,status,type:'document',title:'Synthetic.txt',content:parsed.content,metadata:parsed.metadata,createdAt:'2026',updatedAt:'2026'});
  }
  const vectors = (texts: string[]) => texts.map(() => ({ values: Array.from({length:768}, (_,i)=>i===0?1:0), model:'synthetic', provider:'openai', dimensions:768 }));
  const service = new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>{throw Error('Must batch');},embedDocuments:async texts=>vectors(texts) as any});
  const original = ({sv:'Vilken avbokningsfrist gäller?',en:'What cancellation deadline applies?',de:'Welche Stornierungsfrist gilt?',es:'¿Qué plazo de cancelación aplica?',fa:'مهلت لغو نوبت چیست؟',ar:'ما مهلة إلغاء الموعد؟'} as any)[language];
  const selected: string[][] = [];
  b.configure({knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),knowledgeSearch:async()=>[],
    semanticKnowledgeSearchQueries:async(id,queries,limit)=>{assert.equal(id,8801);selected.push(queries);return service.semanticSearchQueries(id,queries,limit);},
    validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m),geminiGenerate:async(p:any)=>{
      assert.match(p.config.systemInstruction,/queryLanguages/u);
      return{text:JSON.stringify({canonicalMeaning:'cancellation notice',queries:['cancellation deadline','deadline to cancel','avbokningsfrist för tid'],queryLanguages:{'cancellation deadline':'en','deadline to cancel':'en','avbokningsfrist för tid':'sv'}})};
    }});
  const output = await b.retrieveBusinessKnowledge(original,config);
  assert.equal(selected.length,1);assert.equal(selected[0][0],original);assert.ok(selected[0].includes('avbokningsfrist för tid'));assert.ok(selected[0].length<=3);
  assert.match(output,/source_id: A/u);assert.doesNotMatch(output,/source_id: B|source_id: failed/u);
});

test('Arabic comma repair cannot bypass independent contradiction verdict',async t=>{
 quiet(t);const calls:any[]=[];
 b.configure({assessBusinessSupportGrounding:async()=>assessment(punctuationClaims()),assessBusinessClaimEntailment:async r=>{
  calls.push(r);return{relation:r.atomicClaim.includes('TALL-742')?'CONTRADICTED':'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};
 }});
 b.businessInformationState('contradicted-comma',config,question,'ar',document);
 const answer=await b.businessSupportGrounding('contradicted-comma',question,punctuationCandidate,'ar');
 assert.doesNotMatch(answer,/TALL-742/u);assert.ok(calls.some(r=>r.atomicClaim.includes('TALL-742')));
});
test('parser retains only exact planner query language metadata; legacy string plans still work',async t=>{
 quiet(t);
 b.configure({geminiGenerate:async()=>({text:JSON.stringify({canonicalMeaning:'cancellation notice',queries:['avbokningsfrist för tid','deadline'],queryLanguages:{'avbokningsfrist för tid':'sv','deadline':'invalid','injected foreign':'de'}})})});
 const plan=await b.semanticKnowledgeQueries('What deadline?',config);
 assert.deepEqual(plan.queryLanguages,{'avbokningsfrist för tid':'sv'});
 b.configure({geminiGenerate:async()=>({text:'{"canonicalMeaning":"cancellation notice","queries":["deadline"]}'})});
 const legacy=await b.semanticKnowledgeQueries('What deadline?',config);
 assert.deepEqual(legacy.queryLanguages,{});assert.deepEqual(legacy.queries,['What deadline?','deadline']);
});
