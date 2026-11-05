import test from 'node:test';
import assert from 'node:assert/strict';
import { packDocumentEvidence } from './document-evidence-packing';
import { answerEvidence, answerEvidenceBindings, parseAnswerUnits, parseRequestedFacets } from '../ai/business-information-answer-plan';

const rows = () => Array.from({length:6}, (_,i) => ({businessId:77, sourceId:i<5?'guide':'conditions', text:`Original passage ${i}.`,
  metadata:{source:'document',documentRevision:i<5?'revision-guide':'revision-conditions',page:i+1}}));
test('grouping preserves all canonical text and separate source identities within unchanged transport bounds',()=>{
  const input=rows(),groups=packDocumentEvidence(input)!;
  assert.equal(groups.length,2);assert.equal(groups[0].matches.length,5);
  assert.equal(groups[0].text,input.slice(0,5).map(m=>m.text).join('\n\n'));
  assert.equal(groups[1].text,input[5].text);
  const bound=answerEvidenceBindings(77,input),evidence=answerEvidence(77,input);
  assert.equal(bound.flatMap(b=>b.matches).length,6);assert.equal(evidence.length,2);
  assert.deepEqual(evidence.map(e=>e.sourceId),['guide','conditions']);
  assert.ok(evidence.every(e=>e.text.length<=2400));assert.ok(evidence.reduce((n,e)=>n+e.text.length,0)<=9000);
});
for(const fault of ['foreign','revision','missing-revision','six-chunks','six-sources','item-overflow','total-overflow','record-overflow'] as const)
test(`group transport refuses ${fault} without dropping constituents`,()=>{
  const input=rows();
  if(fault==='foreign')input[5].businessId=88;
  if(fault==='revision')input[1].metadata.documentRevision='changed';
  if(fault==='missing-revision')input[1].metadata.documentRevision='';
  if(fault==='six-chunks')input[5].sourceId='guide';
  if(fault==='six-sources')input.forEach((m,i)=>m.sourceId=String(i));
  if(fault==='item-overflow')input[0].text='x'.repeat(2401);
  if(fault==='total-overflow')input.forEach(m=>m.text='x'.repeat(1600));
  if(fault==='record-overflow')input.forEach(m=>m.text='x'.repeat(1300));
  assert.equal(packDocumentEvidence(input),null);assert.deepEqual(answerEvidence(77,input),[]);
});
test('German, Persian and Spanish bytes and exact quotes survive; quotes may not cross a synthetic seam',()=>{
  const input=rows();input[0].text='Der Eingang liegt im Innenhof.';input[1].text='این یک سند تخیلی آزمونی است.';
  input[2].text='La recepción está en la segunda planta.';
  const evidence=answerEvidence(77,input),facets=parseRequestedFacets([{subject:'visitor',attribute:'entrance',questionType:'description'}]).facets;
  const proposal=(exactQuote:string)=>({units:[{facetIds:['f1'],subject:'visitor',predicate:'entrance location',value:'courtyard',scope:'document',
    modality:'descriptive',negation:false,qualifiers:[],language:'en',text:'The entrance is in the courtyard.',evidenceRefs:[{evidenceId:'e1',exactQuote}]}]});
  assert.equal(parseAnswerUnits(proposal(input[0].text),facets,evidence,'en').units.length,1);
  assert.equal(parseAnswerUnits(proposal(input[0].text+'\n\n'+input[1].text),facets,evidence,'en').units.length,0);
  for(const row of input)assert.ok(evidence.some(e=>e.text.includes(row.text)));
  const changed=structuredClone(input);changed[0].metadata.page=99;
  assert.notEqual(answerEvidence(77,changed)[0].chunkId,evidence[0].chunkId,'Grouped identity binds constituent provenance');
});
test('existing five-record transport remains byte-identical and does not group unrelated sources',()=>{
  const input=rows().slice(0,5),evidence=answerEvidence(77,input);
  assert.equal(evidence.length,5);assert.deepEqual(evidence.map(e=>e.text),input.map(m=>m.text));
  assert.ok(evidence.every(e=>!e.citationRanges));
});
