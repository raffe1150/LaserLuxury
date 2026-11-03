/** Source ownership tests; no scripted decision is genuine provider acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureCanonicalConfigurationProducer,canonicalConfigurationSchema,canonicalConfigurationOutputValid,
 SOURCE_PARTITIONED_PRODUCER,SOURCE_PARTITIONED_SCHEMA,selectCanonicalConfigurationProducer} from './canonical-configuration-propositions';
import {knowledgeStructuredOutput} from './knowledge-answer-protocol';
import {generateWithOpenAi} from './providers/openai';
const docs=[{id:'document-one',businessId:4382,sourceId:'handbook',chunkId:'c1',version:'d-r1',text:'Visitors may bring a water bottle.'},
 {id:'document-two',businessId:4382,sourceId:'conditions',chunkId:'c2',version:'d-r2',text:'Food is permitted only in the waiting room.'}];
const config={id:'private-settings',businessId:4382,sourceId:'reminder-configuration',chunkId:'r3',version:'r3',text:'HOST_CANARY_REMINDER_STATE: disabled'};
const proposal={facetIds:['f1'],subject:'reception reminders',predicate:'enabled state',value:'disabled',modality:'descriptive' as const,negation:true,
 scope:'this configured feature only',qualifiers:[],language:'en',text:'HOST_CANARY_REMINDER_STATE: disabled',evidenceRefs:[{evidenceId:config.id,sourceId:config.sourceId,chunkId:config.chunkId,version:config.version,exactQuote:config.text}]};
const inventory=[...docs,config];
const context=()=>captureCanonicalConfigurationProducer(4382,[proposal],inventory,SOURCE_PARTITIONED_PRODUCER);
const docUnit=()=>({...proposal,subject:'visitors',predicate:'may bring',value:'water bottle',negation:false,scope:'documented visit',text:docs[0].text,evidenceRefs:[{evidenceId:docs[0].id}]});
const packet=()=>({oversized:false,units:[docUnit()]});
function accepts(s:any,v:any):boolean{
 if(s.anyOf)return s.anyOf.some((x:any)=>accepts(x,v));
 if(s.enum&&!s.enum.some((x:any)=>JSON.stringify(x)===JSON.stringify(v)))return false;
 if(s.type==='object')return !!v&&typeof v==='object'&&!Array.isArray(v)&&s.required.every((k:string)=>k in v)&&(s.additionalProperties!==false||Object.keys(v).every(k=>k in s.properties))&&Object.entries(v).every(([k,x])=>accepts(s.properties[k],x));
 if(s.type==='array')return Array.isArray(v)&&v.length>=(s.minItems??0)&&v.length<=(s.maxItems??Infinity)&&v.every(x=>accepts(s.items,x));
 return typeof v===s.type&&(typeof v!=='string'||v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity));
}
function schema(c=context()):any{return knowledgeStructuredOutput('extraction',false,['f1'],6,'source-exhaustive-v2','literal-evidence-v1',c);}
test('document schema has no configuration alternative, value, text or citation authority',()=>{
 const c=context(),s=schema(c);assert.equal(s.name,SOURCE_PARTITIONED_SCHEMA);assert.equal(s.strict,true);
 const text=JSON.stringify(s);for(const value of [config.id,config.text,proposal.subject,proposal.predicate,proposal.scope])assert.ok(!text.includes(value));
 assert.equal(s.schema.properties.units.maxItems,5);assert.equal(s.schema.properties.units.items.anyOf,undefined);
 assert.deepEqual(s.schema.properties.units.items.properties.evidenceRefs.items.properties.evidenceId.enum,docs.map(e=>e.id));
 assert.equal(accepts(s.schema,packet()),true);assert.equal(canonicalConfigurationOutputValid(packet(),c,inventory),true);
 assert.equal(accepts(s.schema,{oversized:false,units:c.units}),false);
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:c.units},c,inventory),false,'model cannot originate even correct host configuration proposals');
});
test('changing host settings does not change document schema or leak host fields',()=>{
 const changed={...config,text:'HOST_CANARY_DIFFERENT_STATE: enabled',version:'r4',chunkId:'r4'};
 const p={...proposal,value:'enabled',negation:false,text:changed.text,evidenceRefs:[{evidenceId:changed.id,sourceId:changed.sourceId,chunkId:changed.chunkId,version:changed.version,exactQuote:changed.text}]};
 const c=captureCanonicalConfigurationProducer(4382,[p],[...docs,changed],SOURCE_PARTITIONED_PRODUCER);
 assert.deepEqual(schema(c),schema());
});
test('valid documentary multi-source references remain intact',()=>{
 const p=packet();p.units[0]={...p.units[0],text:'Visitors may bring a water bottle; food is permitted only in the waiting room.',evidenceRefs:docs.map(e=>({evidenceId:e.id}))};
 assert.equal(accepts(schema().schema,p),true);const before=JSON.stringify(p);assert.equal(canonicalConfigurationOutputValid(p,context(),inventory),true);assert.equal(JSON.stringify(p),before);
});
for(const [name,change] of Object.entries({
 'reserved fields':(p:any)=>{p.units[0]={...context().units[0],text:'Different rendering',evidenceRefs:[{evidenceId:docs[0].id}]};},
 'reserved assertion text':(p:any)=>{p.units[0].text=proposal.text;},
 'host ID':(p:any)=>{p.units[0].evidenceRefs=[{evidenceId:config.id}];},
 unknown:(p:any)=>{p.units[0].evidenceRefs=[{evidenceId:'foreign'}];},
 mixed:(p:any)=>{p.units[0].evidenceRefs.push({evidenceId:config.id});},
 quote:(p:any)=>{p.units[0].evidenceRefs[0].exactQuote='invented';},
 oversized:(p:any)=>{p.oversized=true;p.units=[];},
 malformed:(p:any)=>{delete p.units;},
 extra:(p:any)=>{p.units[0].verification='ENTAILED';},
 overrun:(p:any)=>{p.units=Array.from({length:6},docUnit);},
}as Record<string,(p:any)=>void>))test(`whole document packet rejects/${name}`,()=>{
 const p=packet();change(p);const before=JSON.stringify(p);assert.equal(canonicalConfigurationOutputValid(p,context(),inventory),false);assert.equal(JSON.stringify(p),before);
});
for(const [name,change]of Object.entries({
 'stale configuration':(es:any[])=>{es[2].version='stale';},
 'changed configuration':(es:any[])=>{es[2].text='changed';},
 'revoked configuration':(es:any[])=>{es.pop();},
 'foreign tenant':(es:any[])=>{es[2].businessId=9;},
 'stale uncited documentary source':(es:any[])=>{es[1].version='stale';},
}as Record<string,(es:any[])=>void>))test(`full private inventory remains binding/${name}`,()=>{
 const es=structuredClone(inventory);change(es);assert.equal(canonicalConfigurationOutputValid(packet(),context(),es),false);
});
test('valid empty document packet is not a fact or a provider result; bounds reserve host capacity',()=>{
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:[]},context(),inventory),true);
 const c=captureCanonicalConfigurationProducer(4382,Array.from({length:2},()=>proposal),inventory,SOURCE_PARTITIONED_PRODUCER);
 assert.equal(schema(c).schema.properties.units.maxItems,4);
 const full={oversized:false,units:Array.from({length:4},docUnit)};assert.equal(canonicalConfigurationOutputValid(full,c,inventory),true);
 full.units.push(docUnit());assert.equal(canonicalConfigurationOutputValid(full,c,inventory),false);
});
test('no-document and zero-capacity requests cannot emit an empty enum or silently truncate',()=>{
 const c=captureCanonicalConfigurationProducer(4382,[proposal],[config],SOURCE_PARTITIONED_PRODUCER);
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:[]},c,[config]),true);
 assert.throws(()=>schema(c),/documentary_partition_unrepresentable/);
 const full=captureCanonicalConfigurationProducer(4382,Array.from({length:6},()=>proposal),inventory,SOURCE_PARTITIONED_PRODUCER);
 assert.throws(()=>schema(full),/documentary_partition_unrepresentable/);
});
test('partition requires backend-owned context and explicit selection',()=>{
 const c=context();assert.throws(()=>canonicalConfigurationSchema({},JSON.parse(JSON.stringify(c))));
 assert.equal(canonicalConfigurationOutputValid(packet(),JSON.parse(JSON.stringify(c)),inventory),false);
 const saved=process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;try{process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS=SOURCE_PARTITIONED_PRODUCER;assert.equal(selectCanonicalConfigurationProducer(),SOURCE_PARTITIONED_PRODUCER);}finally{if(saved===undefined)delete process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;else process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS=saved;}
});
test('production OpenAI adapter serializes documentary schema with no external dispatch',async t=>{
 for(const m of ['log','info','warn','error']as const)t.mock.method(console,m,()=>{});let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(String(url),'https://api.openai.com/v1/responses');const body=JSON.parse(String(init?.body));assert.equal(body.model,'gpt-5.6-luna');assert.deepEqual(body.text.format,{type:'json_schema',...schema()});assert.ok(!JSON.stringify(body).includes(config.id));throw Error('OFFLINE_ONLY');});
 await assert.rejects(generateWithOpenAi({model:'gpt-5.6-luna',reasoningEffort:'low',tools:[],systemInstruction:'UNIT EXTRACTION documentary-only',messages:[{role:'user',content:'offline document request'}],structuredOutput:schema()}));assert.equal(calls,1);
});
