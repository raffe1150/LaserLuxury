import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completeConditionalCitations as complete} from './conditional-citation-completeness';
import {parseAnswerUnits,parseRequestedFacets,type Evidence} from './business-information-answer-plan';
const pinned=JSON.parse(readFileSync(new URL('../../tests/fixtures/conditional-citation-genuine-036c3df.json',import.meta.url),'utf8'));
const audited=JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json',import.meta.url),'utf8'));
const pdf=audited.sources.find((s:any)=>s.title.endsWith('.pdf')).content.replace(/\s+/gu,' ');
const policy=pinned.antecedent,consequence=pinned.originalQuotes[0];
assert.ok(pdf.includes(policy));assert.ok(pdf.includes(consequence));
const evidence:Evidence={id:'e1',sourceId:'pdf',chunkId:'canonical',version:'revision1',businessId:3,text:policy+'\n'+consequence};
const ref={evidenceId:evidence.id,sourceId:evidence.sourceId,chunkId:evidence.chunkId,version:evidence.version,exactQuote:consequence};
const texts={
 es:pinned.text,
 en:'With more than 15 minutes of delay, the appointment is not automatically cancelled; staff must first assess the situation.',
 sv:'Vid mer än 15 minuter försening avbokas besöket inte automatiskt; personalen behöver först bedöma situationen.',
 de:'Bei mehr als 15 Minuten Verspätung wird der Termin nicht automatisch storniert; das Personal muss zuerst die Situation beurteilen.',
 fa:'با بیش از ۱۵ دقیقه تأخیر، نوبت به طور خودکار لغو نمی‌شود؛ کارکنان باید ابتدا وضعیت را ارزیابی کنند.',
 ar:'مع التأخر أكثر من ١٥ دقيقة لا يلغى الموعد تلقائيا؛ يجب على الموظفين تقييم الوضع أولا.',
};
const candidate=(text=pinned.text)=>({text,modality:'descriptive' as const,negation:true});
for(const [lang,text]of Object.entries(texts)){
 test(`${lang}: conditional citation completion preserves exact claim and strict threshold`,()=>{
  const c=candidate(text),before=JSON.stringify(c),refs=complete(c,[ref],[evidence],3);
  assert.equal(refs.length,2);assert.equal(refs[1].exactQuote,policy);assert.equal(JSON.stringify(c),before);
  assert.equal(complete(c,refs,[evidence],3),refs,'idempotent');
 });
 test(`${lang}: invented threshold cannot acquire a binding`,()=>{
  const refs=[ref];assert.equal(complete(candidate(text.replace('15','16').replace('۱۵','۱۶').replace('١٥','١٦')),refs,[evidence],3),refs);
 });
}
const negativeSources={
 'unrelated same-document antecedent':policy.replace('försening','parkering'),
 'missing source condition':'',
 'missing explicit anaphoric relationship':policy+' An unrelated intervening sentence.',
 'additional audience condition':policy.replace('Vid en försening','För barn: Vid en försening'),
 'different strictness':policy.replace('mer än','minst'),
 'different threshold':policy.replace('15','16'),
};
for(const [name,source]of Object.entries(negativeSources))test(name,()=>{
 const refs=[ref];assert.equal(complete(candidate(),refs,[{...evidence,text:source+'\n'+consequence}],3),refs);
});
for(const [name,text]of Object.entries({
 inclusive:pinned.text.replace('más de','al menos'),
 numericalNegation:pinned.text.replace('más de','no más de'),
 automaticCancellation:pinned.text.replace('no se cancela','se cancela'),
 unsupportedConsequence:pinned.text.replace('evaluar primero la situación','garantizar la disponibilidad'),
 missingStaff:pinned.text.split(';')[0]+'.',
 missingCondition:'La visita no se cancela automáticamente; el personal debe evaluar primero la situación.',
 contradictory:pinned.text+' La visita se cancela automáticamente.',
 unknownTail:pinned.text+' Metadata not retained from the provider.',
}))test(`unsupported claim: ${name}`,()=>{const refs=[ref];assert.equal(complete(candidate(text),refs,[evidence],3),refs);});
for(const [name,change]of Object.entries({
 wrongTenant:{businessId:4},wrongRevision:{version:'revision2'},wrongChunk:{chunkId:'other'},wrongSource:{sourceId:'other'},
 fabricatedQuote:{text:policy+'\n'+consequence.replace('inte','alltid')},
 crossConstituent:{citationRanges:[{start:0,end:policy.length},{start:policy.length+1,end:evidence.text.length}]},
}))test(`source isolation: ${name}`,()=>{const refs=[ref];assert.equal(complete(candidate(),refs,[{...evidence,...change}],3),refs);});
test('mixed revisions and duplicate identities fail closed',()=>{
 const refs=[ref];for(const other of [{...evidence,id:'e2',version:'revision2'},evidence])assert.equal(complete(candidate(),refs,[evidence,other],3),refs);
});
test('neither unrelated evidence nor a different tenant can supply the condition',()=>{
 const refs=[ref];assert.equal(complete(candidate(),refs,[{...evidence,text:consequence},{...evidence,id:'e2',text:policy}],3),refs);
 assert.equal(complete(candidate(),refs,[evidence],4),refs);
});
test('full binding is a no-op; reference limits are unchanged',()=>{
 const refs=[ref,{...ref,exactQuote:policy}];assert.equal(complete(candidate(),refs,[evidence],3),refs);
 const full=[ref,ref,ref,ref];assert.equal(complete(candidate(),full,[evidence],3),full);
});
test('threshold is dynamic, not a hard-coded policy override',()=>{
 assert.equal(complete(candidate(pinned.text.replace('15','37')),[ref],[{...evidence,text:evidence.text.replace('15','37')}],3).length,2);
});
const facets=parseRequestedFacets([{subject:'visit',attribute:'late arrival',questionType:'description'}]).facets;
const raw=()=>({units:[{...candidate(),subject:'visita',predicate:'cancelación',value:'no; el personal debe evaluar primero la situación',scope:'retraso de más de 15 minutos',qualifiers:[],language:'es',facetIds:['f1'],evidenceRefs:[{evidenceId:'e1',exactQuote:consequence}]}]});
test('parser opts in only via backend context, validates exact final refs, and never verifies a claim',()=>{
 const proposal=raw(),before=JSON.stringify(proposal);
 assert.equal(parseAnswerUnits(proposal,facets,[evidence],'es').units.length,0);
 assert.equal(parseAnswerUnits(proposal,facets,[evidence],'es',undefined,'quotation',{businessId:3,question:'test',language:'es'}).units.length,0);
 const parsed=parseAnswerUnits(proposal,facets,[evidence],'es',undefined,'quotation',undefined,{businessId:3,protocol:'source-exhaustive-v2'});
 assert.equal(parsed.units.length,1);assert.equal(parsed.units[0].verification,'PROPOSED');assert.equal(parsed.units[0].evidenceRefs.length,2);
 assert.equal(parsed.units[0].text,pinned.text);assert.equal(JSON.stringify(proposal),before);
});
test('fabricated original citation is rejected before completion',()=>{
 const proposal=raw();proposal.units[0].evidenceRefs[0].exactQuote='invented';
 assert.equal(parseAnswerUnits(proposal,facets,[evidence],'es',undefined,'quotation',undefined,{businessId:3,protocol:'source-exhaustive-v2'}).units.length,0);
});

test('genuine two-source citation set retains the document-wide qualification unchanged',()=>{
 const qualification=pinned.originalQuotes[1],q={...evidence,id:'e2',chunkId:'qualification',text:qualification};
 const original=[ref,{...ref,evidenceId:'e2',chunkId:q.chunkId,exactQuote:qualification}];
 const completed=complete(candidate(),original,[evidence,q],3);
 assert.equal(completed.length,3);assert.deepEqual(completed.slice(0,2),original);assert.equal(completed[2].exactQuote,policy);
});
test('line wraps and same canonical constituent retain explicit adjacency',()=>{
 const wrapped={...evidence,text:policy.replace('studion behöva','studion\nbehöva')+'\n'+consequence};
 const ranged={...wrapped,citationRanges:[{start:0,end:wrapped.text.length}]};
 assert.equal(complete(candidate(),[ref],[ranged],3).length,2);
});

test('recognized policy grammar is independent of the captured phrasing and quantity',()=>{
 const source={...evidence,text:evidence.text.replace('15','37').replace('studion','personalen').replace('Detta innebär','Det innebär')};
 const changedRef={...ref,exactQuote:source.text.slice(source.text.indexOf('Det innebär'))};
 const text=pinned.text.replace('15','37').replace('por un','debido a un').replace('debe evaluar','necesita valorar');
 assert.equal(complete(candidate(text),[changedRef],[source],3).length,2);
});
