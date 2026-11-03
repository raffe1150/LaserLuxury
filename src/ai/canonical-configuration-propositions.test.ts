import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseAnswerUnits,parseRequestedFacets} from './business-information-answer-plan';
import {assessSourceCoverage,SOURCE_EXHAUSTIVE_V2_PROTOCOL} from './source-exhaustive-coverage';
const incident=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json',import.meta.url),'utf8'));
const rejection=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-u2-contradiction-20261102.json',import.meta.url),'utf8'));
const data=JSON.parse(rejection.request.messages[0].content),evidence=[...incident.frozen.evidence,incident.frozen.configurationEvidence];
const facets=parseRequestedFacets(data.facets).facets;
test('original genuine u2 CONTRADICTED verdict remains denied with unchanged full inputs',()=>{
 const raw=JSON.parse(rejection.outputText),units=parseAnswerUnits({units:data.units},facets,evidence,'en').units;
 assert.equal(units.length,4);assert.equal(raw.decisions[1].relation,'CONTRADICTED');assert.equal(raw.decisions[1].meaningPreserved,false);
 assert.equal(assessSourceCoverage(raw,facets,units,evidence,77,SOURCE_EXHAUSTIVE_V2_PROTOCOL).state,'DENIED');
 assert.deepEqual(data,incident.verification.input);
});
test('boolean false violates the string value contract; string false is syntactically valid but not a verification verdict',()=>{
 const original=data.units[3],candidate={...original,subject:'optional late cancellation fee',predicate:'enabled state',value:false,negation:false};
 assert.equal(parseAnswerUnits({units:[candidate]},facets,evidence,'en').units.length,0);
 assert.equal(parseAnswerUnits({units:[{...candidate,value:'false'}]},facets,evidence,'en').units.length,1);
 const neutral=data.units[3];assert.equal(neutral.predicate,'optional late fee');assert.equal(neutral.value,'disabled');
 assert.equal(JSON.parse(rejection.outputText).decisions[3].relation,'ENTAILED');
});

import {captureCanonicalConfigurationProducer,canonicalConfigurationSchema,canonicalConfigurationOutputValid,
  canonicalConfigurationProducerEnabled,CANONICAL_CONFIG_PRODUCER,CANONICAL_CONFIG_SCHEMA} from './canonical-configuration-propositions';
import {cancellationConfigurationProposals} from './cancellation-answer-recovery';
import {configuredCancellationEvidence} from './configured-cancellation-evidence';
import {knowledgeStructuredOutput} from './knowledge-answer-protocol';
import {generateWithOpenAi} from './providers/openai';
const config=incident.frozen.configurationEvidence;
function context(){return captureCanonicalConfigurationProducer(77,cancellationConfigurationProposals(data.question,'en',facets,config),evidence);}
function packet():any{return {oversized:false,units:structuredClone(context().units)};}

test('canonical producer retains the existing genuinely accepted neutral host representation and literal IDs',()=>{
 const c=context();assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.units[1]));
 const host=c.units[1],genuine=data.units[3];const {id,...wire}=genuine;
 assert.deepEqual(host,{...wire,evidenceRefs:[{evidenceId:config.id}]});
 assert.equal(canonicalConfigurationOutputValid(packet(),c,evidence),true);
 assert.deepEqual(Object.keys(host.evidenceRefs[0]),['evidenceId']);
});
test('original ambiguous extraction is rejected whole, before hydration, with no proposal repair',()=>{
 const raw=JSON.parse(incident.extraction.outputText),before=JSON.stringify(raw),c=context();
 assert.equal(canonicalConfigurationOutputValid(raw,c,evidence),false);assert.equal(JSON.stringify(raw),before);
 assert.equal(JSON.parse(rejection.outputText).decisions[1].relation,'CONTRADICTED');
});
for(const [name,change]of Object.entries({
 'charging predicate':r=>{r.units[1].predicate='charges an optional late cancellation fee';},
 'full disabled clause value':r=>{r.units[1].value='the optional late cancellation fee is disabled';},
 'changed state':r=>{r.units[1].value='enabled';},
 'changed negation':r=>{r.units[1].negation=false;},
 'universal free cancellation':r=>{r.units[1].text='All cancellations are always free.';},
 'unrelated mandatory fee absence':r=>{r.units[1].text='No mandatory cancellation fee applies.';},
 'invented deadline':r=>{r.units[1].text='You must cancel 24 hours in advance.';},
 'lost source scope':r=>{r.units[1].scope='all cancellations and all fees';},
 'invalid evidence ID':r=>{r.units[1].evidenceRefs[0].evidenceId='foreign';},
 'model quotation':r=>{r.units[1].evidenceRefs[0].exactQuote='free';},
 'mixed documentary/configuration citations':r=>{r.units[1].evidenceRefs.push({evidenceId:'e1'});},
 'model authority claim':r=>{r.units[1].verification='ENTAILED';},
}as Record<string,(r:any)=>void>))test(`canonical producer rejects whole extraction/${name}`,()=>{
 const r:any=packet();change(r);assert.equal(canonicalConfigurationOutputValid(r,context(),evidence),false);
});
for(const [name,change]of Object.entries({
 missing:(es:any[])=>es.splice(1,1),revision:(es:any[])=>{es[1].version+='-stale';},
 text:(es:any[])=>{es[1].text+=' ';},foreign:(es:any[])=>{es[1].businessId=88;},
 documentaryRevision:(es:any[])=>{es[0].version+='-stale';},
}as Record<string,(es:any[])=>void>))test(`producer inventory fails closed/${name}`,()=>{
 const es=structuredClone(evidence);change(es);assert.equal(canonicalConfigurationOutputValid(packet(),context(),es),false);
});
test('missing or changed configuration cannot construct the source-bound producer context',()=>{
 const ps=cancellationConfigurationProposals(data.question,'en',facets,config);
 assert.throws(()=>captureCanonicalConfigurationProducer(77,ps,evidence.filter(e=>e.id!==config.id)));
 assert.throws(()=>captureCanonicalConfigurationProducer(77,ps,evidence.map(e=>e.id===config.id?{...e,version:'stale'}:e)));
 assert.throws(()=>captureCanonicalConfigurationProducer(88,ps,evidence));
});
test('producer context is request-local host bookkeeping, not a forgeable model certificate',()=>{
 const c=context(),clone=JSON.parse(JSON.stringify(c));
 assert.equal(canonicalConfigurationOutputValid(packet(),clone,evidence),false);
 assert.throws(()=>canonicalConfigurationSchema({},clone));
});

// Independent JSON-Schema example checker for the emitted union's admission
// constraints. This is test-only and never creates verification judgments.
function schemaAccepts(s:any,v:any):boolean{
 if(s.anyOf)return s.anyOf.some((c:any)=>schemaAccepts(c,v));
 if(s.enum&&!s.enum.some((e:any)=>JSON.stringify(e)===JSON.stringify(v)))return false;
 if(s.type==='object')return !!v&&typeof v==='object'&&!Array.isArray(v)&&s.required.every((k:string)=>k in v)&&
   (s.additionalProperties!==false||Object.keys(v).every(k=>k in s.properties))&&Object.entries(v).every(([k,x])=>schemaAccepts(s.properties[k],x));
 if(s.type==='array')return Array.isArray(v)&&v.length>=(s.minItems??0)&&v.length<=(s.maxItems??Infinity)&&v.every(x=>schemaAccepts(s.items,x));
 if(typeof v!==s.type)return false;
 return typeof v!=='string'||v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity);
}
test('strict producer schema has disjoint ID-only branches, accepts canonical facts and blocks ambiguous u2',()=>{
 const c=context(),request=knowledgeStructuredOutput('extraction',false,['f1','f2'],6,'source-exhaustive-v2','literal-evidence-v1',c);
 assert.equal(request.name,CANONICAL_CONFIG_SCHEMA);assert.equal(request.strict,true);
 assert.ok(schemaAccepts(request.schema,packet()));
 assert.equal(schemaAccepts(request.schema,JSON.parse(incident.extraction.outputText)),false);
 const p=packet();p.units[1].predicate='charges';assert.equal(schemaAccepts(request.schema,p),false);
 const doc={...c.units[0],subject:'document',predicate:'describes',value:'customer information',text:'The document gives customer information.',evidenceRefs:[{evidenceId:'e1'}]};
 assert.equal(schemaAccepts(request.schema,{oversized:false,units:[doc,...c.units]}),true);
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:[doc,...c.units]},c,evidence),true);
 assert.throws(()=>knowledgeStructuredOutput('extraction',false,['f1'],6,'source-exhaustive-v2','v2',c));
});
test('profile is explicit opt-in; unsupported selector fails closed',()=>{
 const saved=process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;
 try{delete process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;assert.equal(canonicalConfigurationProducerEnabled(),false);
 process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS=CANONICAL_CONFIG_PRODUCER;assert.equal(canonicalConfigurationProducerEnabled(),true);
 process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS='model-selected';assert.throws(canonicalConfigurationProducerEnabled);
 }finally{if(saved===undefined)delete process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;else process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS=saved;}
});
test('production OpenAI adapter serializes the constrained extraction schema without dispatch or fake verifier output',async t=>{
 const schema=knowledgeStructuredOutput('extraction',false,['f1','f2'],6,'source-exhaustive-v2','literal-evidence-v1',context());let intercepted=0;
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});
 t.mock.method(globalThis,'fetch',async(url,init)=>{intercepted++;assert.equal(String(url),'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(init?.body));assert.equal(body.model,'gpt-5.6-luna');assert.deepEqual(body.text.format,{type:'json_schema',...schema});throw Error('OFFLINE_NO_DISPATCH');});
 await assert.rejects(generateWithOpenAi({model:'gpt-5.6-luna',reasoningEffort:'low',systemInstruction:'UNIT EXTRACTION',messages:[{role:'user',content:'offline schema test'}],tools:[],structuredOutput:schema}));
 assert.equal(intercepted,1);
});


test('producer constraints use host facts rather than fixed tenant, topic or language strings',()=>{
 const e={id:'trusted-toggle',businessId:4382,sourceId:'reminder-settings',chunkId:'c1',version:'r1',text:'Reception reminders are disabled.'};
 const fs=parseRequestedFacets([{subject:'reception reminders',attribute:'enabled state',questionType:'description'}]).facets;
 const p={facetIds:['f1'],subject:'reception reminders',predicate:'enabled state',value:'false',negation:false,modality:'descriptive' as const,
  scope:'this configured reminder feature only',qualifiers:[],language:'en',text:e.text,evidenceRefs:[{evidenceId:e.id,sourceId:e.sourceId,chunkId:e.chunkId,version:e.version,exactQuote:e.text}]};
 const c=captureCanonicalConfigurationProducer(4382,[p],[e]);
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:c.units},c,[e]),true);
 const bound=hydrateForParser(c.units,e);assert.equal(parseAnswerUnits(bound,fs,[e],'en').units.length,1,'PROPOSED only; no factual verification claimed');
});
function hydrateForParser(units:any,e:any){return{units:units.map((u:any)=>({...u,evidenceRefs:u.evidenceRefs.map((r:any)=>({...r,exactQuote:e.text}))}))};}

test('constrained schema construction does not mutate the existing literal schema or canonical proposals',()=>{
 const c=context(),before=JSON.stringify(c.units),base=knowledgeStructuredOutput('extraction',false,['f1','f2'],6,'source-exhaustive-v2','literal-evidence-v1');
 knowledgeStructuredOutput('extraction',false,['f1','f2'],6,'source-exhaustive-v2','literal-evidence-v1',c);
 assert.deepEqual(knowledgeStructuredOutput('extraction',false,['f1','f2'],6,'source-exhaustive-v2','literal-evidence-v1'),base);
 assert.equal(JSON.stringify(c.units),before);
});


test('original u2 alone cannot enter canonical extraction even beside a valid canonical chat unit',()=>{
 const c=context(),{id,...oldFee}=data.units[1];oldFee.evidenceRefs=[{evidenceId:config.id}];
 const packet={oversized:false,units:[c.units[0],oldFee]},before=JSON.stringify(packet);
 assert.equal(canonicalConfigurationOutputValid(packet,c,evidence),false);assert.equal(JSON.stringify(packet),before);
});
