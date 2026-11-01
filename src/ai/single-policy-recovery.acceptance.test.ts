import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.AI_PROVIDER='gemini';process.env.GEMINI_API_KEY='synthetic-offline';
globalThis.fetch=async()=>{throw Error('Offline recovery regressions forbid provider network');};
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const question='What cancellation deadline applies to my appointment?';
const policy='En bokad tid ska avbokas senast 37 timmar före besöket.';
const same='Samma tidsgräns gäller för ombokning.';
const exception='Förfrågningar om undantag behöver hanteras av receptionen och detta blad ger inget automatiskt undantag.';
const source=policy+' '+same+' '+exception+' Parkeringsgrindens märkning är TALL-742.';
const config={id:8801,businessName:'Synthetic Fjord Studio',language:'en',services:[],systemPrompt:''};
const candidate='Please cancel your appointment at least 37 hours before the visit. The same deadline applies to rescheduling; exceptions must be handled by reception and are not automatic.';
const requested='Please cancel your appointment at least 37 hours before the visit.';
function claim(text:string,quote=text,evidence=policy,supported=true,kind:'OTHER'|'NEGATIVE_ABSENCE'='OTHER'){return{claim:text,candidateQuote:quote,claimKind:kind,requiresBusinessEvidence:true,supported,evidence:supported?[{source:'retrieved_knowledge' as const,quote:evidence}]:[]};}
function recorded(){return[
 claim('Appointments must be cancelled at least 37 hours before the visit.',requested),
 claim('The same 37-hour deadline applies to rescheduling.','The same deadline applies to rescheduling;',same),
 claim('Exceptions must be handled by reception.','exceptions must be handled by reception','Förfrågningar om undantag behöver hanteras av receptionen'),
 claim('Exceptions are not automatic.','are not automatic.','detta blad ger inget automatiskt undantag.',true,'NEGATIVE_ABSENCE'),
];}
function quiet(t:any){b.reset();for(const m of ['log','warn','error','info'] as const)t.mock.method(console,m,()=>undefined);}
afterEach(()=>b.reset());
async function run(t:any,claims:any[],reply=candidate,options:{question?:string;source?:string;ordinary?:(r:any)=>string|null;requested?:(r:any)=>string|null;config?:any;language?:string}={}){
 quiet(t);const calls:any[]=[];
 b.configure({assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:claims.every(c=>c.supported),claims}),assessBusinessClaimEntailment:async r=>{
  calls.push(r);const relation=r.requireRequestedFact?(options.requested?options.requested(r):'ENTAILED'):options.ordinary?options.ordinary(r):r.atomicClaim===claims[0]?.claim?'ENTAILED':'UNKNOWN';
  return relation===null?null:{relation:relation as any,claimKind:r.claimKind,explicitAbsenceEvidence:false};
 }});
 b.businessInformationState('single-policy',options.config||config,options.question||question,options.language||'en',options.source??source);
 return{answer:await b.businessSupportGrounding('single-policy',options.question||question,reply,options.language||'en'),calls};
}
test('exact recorded English failure retains only the complete independently entailed requested deadline',async t=>{
 const original=recorded();const copy=structuredClone(original);const r=await run(t,original,candidate,{ordinary:r=>[original[0].claim,original[2].claim].includes(r.atomicClaim)?'ENTAILED':'UNKNOWN'});
 assert.equal(r.answer,requested);assert.deepEqual(original,copy);assert.doesNotMatch(r.answer,/reschedul|exception/u);
 const scope=r.calls.filter(x=>x.requireRequestedFact);assert.equal(scope.length,1);assert.equal(scope[0].candidateQuote,requested);assert.deepEqual(scope[0].citedEvidence,original[0].evidence);
 assert.equal(r.calls.filter(x=>!x.requireRequestedFact&&x.atomicClaim===original[0].claim).length,1,'Same request ordinary verdict reused, not regenerated');
});
test('supported requested fact survives unsupported unrelated clauses without rewriting generated text',async t=>{
 const other='Reception handles requests for exceptions.';const r=await run(t,[claim(requested),claim(other,other,'',false)],requested+' '+other);
 assert.equal(r.answer,requested);assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,1);
});
test('unsupported requested fact plus supported unrelated facts preserves a gap, not a deadline answer',async t=>{
 const wrong='Appointments require at most 37 hours notice before the visit.';const other='Exceptions must be handled by reception.';
 const r=await run(t,[claim(wrong,wrong,'',false),claim(other,other,'Förfrågningar om undantag behöver hanteras av receptionen')],wrong+' '+other,{ordinary:()=> 'ENTAILED',requested:()=> 'NOT_APPLICABLE'});
 assert.doesNotMatch(r.answer,/37|at most/u);assert.match(r.answer,/can't find/u);
});
for(const verdict of ['UNKNOWN','NEUTRAL','CONTRADICTED','NOT_APPLICABLE',null] as const)test(`requested clause ordinary ${verdict} cannot be rescued by the relevance check`,async t=>{
 const r=await run(t,recorded(),candidate,{ordinary:()=>verdict});
 assert.doesNotMatch(r.answer,/37/u);assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0);
});
for(const verdict of ['UNKNOWN','NEUTRAL','CONTRADICTED','NOT_APPLICABLE',null] as const)test(`requested-fact check ${verdict} fails closed with no retry or adjudication`,async t=>{
 const r=await run(t,recorded(),candidate,{requested:()=>verdict});assert.doesNotMatch(r.answer,/37/u);
 const scope=r.calls.filter(x=>x.requireRequestedFact);assert.equal(scope.length,1);assert.ok(!scope[0].adjudication);
});
for(const wrong of ['Please cancel at most 37 hours before the visit.','Please cancel at least 37 hours after the visit.'])test(`numerical constraint rejects ${wrong}`,async t=>{
 const claims=[claim(wrong),claim('Exceptions are free.','Exceptions are free.','',false)];const r=await run(t,claims,wrong+' Exceptions are free.',{ordinary:()=> 'ENTAILED'});
 assert.doesNotMatch(r.answer,/37/u);assert.ok(r.calls.every(x=>x.atomicClaim!==wrong),'No semantic grant can bypass direction veto');
});
test('missing policy cannot manufacture requested evidence or reach entailment',async t=>{
 const r=await run(t,[claim(requested),claim('Exceptions are free.','Exceptions are free.','',false)],requested+' Exceptions are free.',{source:'Parking is behind the studio.',ordinary:()=> 'ENTAILED'});
 assert.doesNotMatch(r.answer,/37/u);assert.equal(r.calls.length,0);
});
test('contradictory current policies remain unavailable when ordinary verification returns UNKNOWN',async t=>{
 const conflict=source+' En bokad tid ska avbokas senast 49 timmar före besöket.';
 const r=await run(t,recorded(),candidate,{source:conflict,ordinary:r=>{assert.ok(r.evidenceCorpus.includes('49 timmar'));return 'UNKNOWN';}});
 assert.doesNotMatch(r.answer,/37|49/u);assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0);
});
test('structured cancellation authority cannot be overridden by a recovered document sentence',async t=>{
 const r=await run(t,recorded(),candidate,{config:{...config,cancellationDeadlineMinutes:120},ordinary:()=> 'ENTAILED'});
 assert.doesNotMatch(r.answer,/37/u);assert.ok(r.calls.every(x=>x.atomicClaim!==recorded()[0].claim));assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0);
});
for(const [name,reply,quote] of [
 ['partial value',candidate,'37 hours'],
 ['partial predicate',candidate,'at least 37 hours before the visit.'],
 ['truncated clause',candidate,'Please cancel your appointment at least 37 hours.'],
 ['wrong identifier/quantity',candidate.replace('37','38'),requested],
 ['question suffix',requested+'? Unknown exceptions.',requested],
 ['decimal-looking suffix',requested+'5 Unknown exceptions.',requested],
 ['unlocated leading context','This assertion is false: '+candidate,requested],
 ['repeated sentence',requested+' '+candidate,requested],
 ['punctuation reconstruction',candidate.replace('visit.','visit;'),requested],
] as const)test(`single policy sentence recovery rejects ${name}`,async t=>{
 const claims=[claim('Appointments must be cancelled at least 37 hours before the visit.',quote),claim('Unknown exceptions.','Unknown exceptions.','',false)];
 const r=await run(t,claims,reply,{ordinary:()=> 'ENTAILED'});assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0);assert.match(r.answer,/can't find/u);assert.doesNotMatch(r.answer,/37|38/u);
});
for(const mode of ['exact','substring','normalized','unlocated','later-UNKNOWN-same-claim'] as const)test(`requested recovery rejects ${mode} rejected boundary`,async t=>{
 const rejected=mode==='exact'?requested:mode==='substring'?'at least 37 hours':mode==='normalized'?'AT LEAST  37 HOURS':mode==='unlocated'?'':requested;
 const other=mode==='later-UNKNOWN-same-claim'?claim(recorded()[0].claim,candidate):claim('Rejected statement',rejected,'',false);
 const r=await run(t,[recorded()[0],other],candidate,{ordinary:r=> r.atomicClaim===recorded()[0].claim?(r.candidateQuote===requested?'ENTAILED':'UNKNOWN'):'UNKNOWN'});
 assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0);assert.match(r.answer,/can't find/u);assert.doesNotMatch(r.answer,/37/u);
});

const examples=[
 ['sv','Vilken avbokningsfrist gäller och vad är märkningen vid parkeringen?','Avboka minst 37 timmar före besöket.','Kundparkeringens märkning är TALL-742.'],
 ['en','What cancellation deadline and customer parking marker apply?','Cancel at least 37 hours before the visit.','The customer parking marker is TALL-742.'],
 ['de','Welche Stornierungsfrist gilt und wie ist der Parkplatz gekennzeichnet?','Stornieren Sie mindestens 37 Stunden vor dem Besuch.','Der Kundenparkplatz ist mit TALL-742 gekennzeichnet.'],
 ['es','¿Cuál es el plazo de cancelación y la marca del aparcamiento?','Cancela con al menos 37 horas de antelación.','La marca del aparcamiento es TALL-742.'],
 ['fa','مهلت لغو نوبت و شناسه پارکینگ مشتریان چیست؟','نوبت باید حداقل ۳۷ ساعت پیش از مراجعه لغو شود.','شناسه پارکینگ مشتریان TALL-742 است.'],
 ['ar','ما مهلة إلغاء الموعد وما علامة موقف سيارات العملاء؟','يجب إلغاء الموعد قبل 37 ساعة على الأقل.','علامة موقف سيارات العملاء هي TALL-742.'],
] as const;
for(const [language,q,deadline,marker] of examples)test(`existing ${language} compound recovery retains supported parts with uncertainty`,async t=>{
 const unknown=({sv:'Undantag är gratis.',en:'Exceptions are free.',de:'Ausnahmen sind kostenlos.',es:'Las excepciones son gratuitas.',fa:'استثناها رایگان هستند.',ar:'الاستثناءات مجانية.'} as any)[language];
 const r=await run(t,[claim(deadline),claim(marker,marker,'Parkeringsgrindens märkning är TALL-742.'),claim(unknown,unknown,'',false)],deadline+' '+marker+' '+unknown,{question:q,language,ordinary:()=> 'ENTAILED'});
 assert.ok(r.answer.includes(deadline));assert.ok(r.answer.includes(marker));assert.ok(!r.answer.includes(unknown));assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,0,'Compound path remains independent');
});

async function pipeline(t:any,mode:'manual'|'delete'|'revise'|'foreign'|'failed'){
 quiet(t);const storage=new InMemoryKnowledgeStorage();const service=new KnowledgeService(storage,storage);const d=documentChunks([{text:source,section:'Text'}],'Synthetic.txt');
 await storage.create({id:'A',businessId:mode==='foreign'?8802:8801,type:mode==='manual'?'text':'document',status:mode==='failed'?'failed':'ready',title:'Synthetic',content:d.content,metadata:mode==='manual'?{}:d.metadata,createdAt:'2026',updatedAt:'2026'});
 await storage.replaceChunks(mode==='foreign'?8802:8801,'A',d.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:mode==='manual'?{}:c.metadata as any})));
 let validated=0,relevance=0;const forbidden=async()=>{assert.fail('Information recovery cannot perform bookings or analysis writes');};
 b.configure({semanticLanguageResolver:async()=>({language:'en',confidence:1}),knowledgeSearch:(id,q,l)=>service.search(mode==='foreign'?8802:id,q,l),semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(id,m)=>{validated++;return service.validateMatches(id,m);},
  geminiGenerate:async(p:any)=>{assert.equal(p.config.tools?.length||0,0);if(p.config.systemInstruction.includes('retrieval query planner'))return{text:'{"canonicalMeaning":"cancellation notice","queries":["avbokas"]}'};
   assert.match(p.config.systemInstruction,/REQUESTED FACT SCOPE/u);assert.match(p.config.systemInstruction,/Do not append adjacent policies/u);return{text:candidate};},
  assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:recorded()}),assessBusinessClaimEntailment:async r=>{
   if(r.requireRequestedFact){relevance++;if(mode==='delete')await storage.delete(8801,'A');if(mode==='revise'){const old=(await storage.list(8801))[0];await storage.create({...old,content:old.content+' Changed revision.'});}return{relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};}
   return{relation:r.atomicClaim===recorded()[0].claim?'ENTAILED':'UNKNOWN',claimKind:r.claimKind,explicitAbsenceEvidence:false};},
  calendarAdapter:{getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden},recordAppointment:forbidden,postProcess:forbidden});
 const reply=await b.promptAuditWeb({chatId:mode,message:question},config);
 if(mode==='manual'){assert.equal(reply.body.text,requested);assert.equal(relevance,1);}else{assert.doesNotMatch(reply.body.text,/37/u);if(mode==='delete'||mode==='revise'){assert.equal(relevance,1);assert.ok(validated>=4);}}
}
for(const mode of ['manual','delete','revise','foreign','failed'] as const)test(`shared information publication: ${mode} evidence and tool safety`,t=>pipeline(t,mode));

test('requested-fact provider prompt requires a complete requested aspect and no quote rewrite',async t=>{
 quiet(t);const instructions:string[]=[];
 b.configure({assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:recorded()}),geminiGenerate:async(p:any)=>{
  const instruction=p.config.systemInstruction;instructions.push(instruction);const data=JSON.parse(p.contents[0].parts[0].text);
  if(instruction.includes('REQUESTED-FACT RECOVERY CHECK')){assert.equal(data.exactCandidateQuote,requested);assert.equal(data.relevantContext.customerQuestion,question);assert.match(instruction,/directly answers at least one explicitly requested aspect/u);assert.match(instruction,/complete-question coverage is checked separately/u);assert.match(instruction,/sharing a topic is insufficient/u);assert.match(instruction,/Do not rewrite or complete the quote/u);return{text:'{"relation":"ENTAILED","claimKind":"OTHER","explicitAbsenceEvidence":false}'};}
  return{text:JSON.stringify({relation:data.atomicClaim===recorded()[0].claim?'ENTAILED':'UNKNOWN',claimKind:data.atomicClaim==='Exceptions are not automatic.'?'NEGATIVE_ABSENCE':'OTHER',explicitAbsenceEvidence:false})};
 }});
 b.businessInformationState('prompt',config,question,'en',source);
 assert.equal(await b.businessSupportGrounding('prompt',question,candidate,'en'),requested);assert.equal(instructions.filter(x=>x.includes('REQUESTED-FACT RECOVERY CHECK')).length,1);
});

 test('identical independently verified duplicate claims remain harmless in recovery',async t=>{
 const main=recorded()[0];const claims=[main,structuredClone(main),claim('Unsupported exception.','Unsupported exception.','',false)];
 const r=await run(t,claims,requested+' Unsupported exception.',{ordinary:()=> 'ENTAILED'});
 assert.equal(r.answer,requested);assert.equal(r.calls.filter(x=>x.requireRequestedFact).length,1);
});
