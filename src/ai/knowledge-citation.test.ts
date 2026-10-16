import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveEvidenceQuote as resolve} from './knowledge-citation';
const raw='Nordpark .\nGaragets infart ligger på Stjärngatan 14 .\nParkering är inte gratis.';
for(const quote of ['Nordpark .','Nordpark.','Nordpark. Garagets infart ligger på Stjärngatan 14.','Garagets\tinfart ligger på Stjärngatan 14.'])test(`bounded raw offset mapping: ${JSON.stringify(quote)}`,()=>{
 const r=resolve(raw,quote);assert.ok(r.quote);assert.equal(raw.slice(r.start,r.end),r.quote);assert.ok(r.quote!.includes('Nordpark')||r.quote!.includes('Stjärngatan 14'));
});
for(const quote of ['Stjärngatan 19.','Stjärngatan 1 4.','Star Street 14.','Nord Park.','Nordpark!','Parkering är gratis.','Parkering är inte alltid gratis.','Parkering är inte gratis. I promise.'])test(`changed meaning/identifier is never whitespace repair: ${quote}`,()=>assert.equal(resolve(raw,quote).quote,undefined));
for(const [source,quote,reason] of [['same same','same','AMBIGUOUS_QUOTE'],['A  B A\nB','A B','AMBIGUOUS_QUOTE'],['ZX-7429','ZX-742','TOKEN_BOUNDARY'],['Nordpark','park','TOKEN_BOUNDARY'],['fi nns','finns','QUOTE_NOT_FOUND']] as const)test(`citation diagnostic ${reason}`,()=>assert.equal(resolve(source,quote).subtype,reason));

test('decimal/digit whitespace and oversized raw spans are not repaired',()=>{
 assert.equal(resolve('Price 14 .5','Price 14.5').quote,undefined);
 assert.equal(resolve('A'+ ' '.repeat(2500)+'B','A B').quote,undefined);
 assert.equal(resolve('fi nns','finns').typographyHint,true);
});
