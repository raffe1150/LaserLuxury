import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test,beforeEach,afterEach,describe} from 'node:test';
import { businessInformationTopics } from './business-information';
process.env.NODE_ENV='test';process.env.GEMINI_API_KEY='synthetic-offline-only';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
let sequence=0; // Event sequence stays monotonic across both real-adapter suites.
for (const evidenceFirst of [false, true]) describe(`evidence-first ${evidenceFirst ? 'ON' : 'OFF'}`, () => {
const channels=['telegram','instagram','whatsapp','messenger'] as const;
type Channel=typeof channels[number];
const question='Kan jag komma utan att boka tid i förväg?';
const policy='Vi rekommenderar att du bokar tid i förväg, eftersom besök sker efter överenskommelse.';
const parking='Det finns parkering nära studion.';
const digital='Vissa tjänster kan genomföras som digitala möten.';
const unsupported='Du måste boka en tid innan varje besök.';
const contact='Du kan kontakta oss för mer information.';
const evidence=[policy,parking,digital,contact].join('\n');
const config={id:77,businessId:77,businessName:'Synthetic studio',language:'sv',timezone:'Europe/Stockholm',
 services:[{id:'video',name:'Video Consultation',durationMinutes:60}],defaultBookingService:'Video Consultation',calendarProvider:'custom',
 channelConnectionId:'synthetic-connection',telegramToken:'123456:synthetic-offline',telegramBusinessResolved:true,whatsappPhoneNumberId:'wa-synthetic',whatsappAccessToken:'synthetic-only',
 instagramAccountId:'ig-synthetic',instagramAccessToken:'synthetic-only',messengerPageId:'ms-synthetic',messengerPageAccessToken:'synthetic-only',
 workingHours:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d=>[d,[{start:'09:00',end:'17:00'}]]))};
let deps:Parameters<typeof b.configure>[0],sent:any[],requests:any[],diags:any[],retrieval:any[],verdicts:any[],reads:number,current:boolean,mode:string,reply:string,claims:any[];
let oldFetch:typeof fetch;let documentText:string;let oldFlag:string|undefined;let unitFault:string;let unitDiags:any[];let legacyGroundingCalls:number;
// Two real provider protocols, sharing only the synthetic source facts and verdict oracle.
// Never manufacture legacy product diagnostics to make enabled-mode assertions pass.
const configure=(d:Parameters<typeof b.configure>[0])=>{deps={...deps,...d};b.configure({...deps,
 geminiGenerate:async p=>evidenceFirst ? structuredProvider(p) : deps.geminiGenerate!(p),
 assessBusinessSupportGrounding:async r=>{legacyGroundingCalls++;return deps.assessBusinessSupportGrounding!(r);},
 evidenceFirstDiagnostic:d=>unitDiags.push(d),
});};
async function structuredProvider(p:any):Promise<any>{
 const instruction=p.config.systemInstruction;
 if(!/retrieval query planner|EVIDENCE-FIRST|VERIFIED-UNIT PRESENTATION/u.test(instruction))return deps.geminiGenerate!(p);
 requests.push(p);assert.deepEqual(p.config.tools||[],[],'information protocol cannot expose tools');
 const raw=p.contents[0].parts[0].text;let data:any;try{data=JSON.parse(raw);}catch{data={question:raw};}
 if(instruction.includes('retrieval query planner')){
  const text=data.question||raw;const topics=businessInformationTopics(text).filter(t=>['policies','parking','meetings'].includes(t));
  return{text:JSON.stringify({canonicalMeaning:'information',queries:[],requestKind:'BUSINESS_INFORMATION',requestedFacets:(topics.length?topics:['policies']).map(t=>({subject:'studio',attribute:t,questionType:t==='policies'?'recommendation':'description'}))})};
 }
 if(instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')){
  const source=data.evidence[0];assert.equal(source.businessId,77);
  const requested=data.facets.map((f:any)=>f.attribute);
  // Extract fixture facts from the supplied source, independently of legacy reply wording.
  const facts=requested.includes('policies')?[documentText.includes(policy)?policy:documentText]:[
   ...(requested.includes('parking')?[parking]:[]),...(requested.includes('meetings')?[digital]:[])];
  const extra=claims.filter(c=>!c.supported&&c.claim!==policy).map(c=>c.claim);
  const units=[...facts,...extra].map((text:string,i:number)=>({facetIds:[data.facets[Math.min(i,data.facets.length-1)].id],subject:'studio',predicate:'states',value:text,
   modality:requested.includes('policies')?(extra.includes(text)?'required':'recommended'):'descriptive',negation:false,scope:'this business',qualifiers:[],language:data.requestedLanguage,text,
   evidenceRefs:[{evidenceId:source.id,exactQuote:facts.includes(text)?text:facts[0]}]}));
  if(unitFault==='missing-source'||unitFault==='invent-citation'||unitFault==='flip-support')units.forEach((u:any)=>{u.evidenceRefs=[{evidenceId:source.id,exactQuote:'NOT IN SOURCE'}];u.verification='ENTAILED';});
  if(unitFault==='question')units.forEach((u:any)=>u.text+='？');
  if(unitFault==='empty-evidence')units.forEach((u:any)=>u.evidenceRefs=[]);
  if(unitFault==='change-claim')units.forEach((u:any)=>u.text='Different proposition');
  return{text:JSON.stringify({units})};
 }
 if(instruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')){
  const decisions=await Promise.all(data.units.map(async(u:any)=>{
   const unsupported=claims.some(c=>c.claim===u.text&&!c.supported);
   const result=await deps.assessBusinessClaimEntailment!({customerMessage:data.question,atomicClaim:u.text,candidateQuote:u.text,claimKind:'OTHER',
    citedEvidence:u.evidenceRefs.map((r:any)=>({source:'retrieved_knowledge',quote:r.exactQuote})),workflow:'business_information',language:data.requestedLanguage,businessId:'77',requireRequestedFact:true});
   return{unitId:u.id,relation:unsupported||unitFault==='overlap'||unitFault==='change-claim'?'UNKNOWN':result?.relation||'UNKNOWN',facetIds:u.facetIds,meaningPreserved:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false};
  }));return{text:JSON.stringify({decisions})};
 }
 return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
}
const claim=(text:string,supported=true,citation=text)=>({claim:text,candidateQuote:text,claimKind:'OTHER' as const,requiresBusinessEvidence:true,supported,evidence:supported?[{source:'retrieved_knowledge' as const,quote:citation}]:[]});
const forbidden=async()=>assert.fail('Unauthorized appointment mutation');
beforeEach((t:any)=>{
 oldFlag=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=String(evidenceFirst);unitFault='';unitDiags=[];legacyGroundingCalls=0;
 b.reset();deps={};sent=[];requests=[];diags=[];retrieval=[];verdicts=[];reads=0;current=true;mode='present';documentText=evidence;reply=`${unsupported} ${policy}`;claims=[claim(unsupported,false),claim(policy)];
 oldFetch=globalThis.fetch;
 for(const m of ['log','info','warn','error'] as const)t.mock.method(console,m,()=>{});
 // Only fake send endpoints are accepted; all provider/DB/Calendar HTTP is forbidden.
 globalThis.fetch=async(input,options)=>{const url=String(input);const body=JSON.parse(String(options?.body||'{}'));
  assert.ok(url.startsWith('https://api.telegram.org/bot123456:synthetic-offline/sendMessage')||/^https:\/\/graph\.(?:facebook|instagram)\.com\//u.test(url),url);
  sent.push({url,body});return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}),{status:200});};
 configure({semanticLanguageResolver:async()=>({language:'sv',confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
  knowledgeSearch:async(id)=>{assert.equal(id,77);return mode==='missing'?[]:[{businessId:mode==='foreign'?88:77,sourceId:'synthetic-document',text:documentText,score:1,metadata:{source:'document'}}];},semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(_id,m)=>current?m:[],
  knowledgeRetrievalDiagnostic:d=>retrieval.push(d),businessGroundingDiagnostic:d=>diags.push(d),
  geminiGenerate:async p=>{requests.push(p);if(p.config.systemInstruction.includes('retrieval query planner'))return{text:'{"canonicalMeaning":"information","queries":[]}'};
   if(p.config.systemInstruction.includes('COMPLETENESS REPAIR'))return{text:policy};return{text:reply};},
  assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:claims.every(c=>c.supported),claims}),
  assessBusinessClaimEntailment:async r=>{verdicts.push(r);return{relation:r.requireRequestedFact&&r.atomicClaim===contact?'NOT_APPLICABLE':'ENTAILED',claimKind:r.claimKind,explicitAbsenceEvidence:false};},
  calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>{reads++;return[];},checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
});
afterEach(()=>{globalThis.fetch=oldFetch;if(oldFlag===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=oldFlag;b.reset();});
function session(ch:Channel,id='customer'){return ch==='telegram'?`tg:77:${createHash('sha256').update(config.telegramToken).digest('hex').slice(0,12)}:${id}`:b.channelSessionId(ch,id,config,ch==='instagram'?'ig-synthetic':ch==='whatsapp'?'wa-synthetic':'ms-synthetic');}
async function inbound(ch:Channel,text:string,id='customer',eventId?:string){
 const mid=eventId||String(++sequence),now=Date.now();
 if(ch==='telegram')return b.telegramInbound({update_id:mid,message:{chat:{id},text,date:Math.floor(now/1000)}},config);
 if(ch==='whatsapp')return b.whatsappInbound({id:mid,from:id,text:{body:text},type:'text',timestamp:String(Math.floor(now/1000))},{phone_number_id:'wa-synthetic'},config);
 const event={sender:{id},recipient:{id:ch==='instagram'?'ig-synthetic':'ms-synthetic'},timestamp:now,message:{mid,text}};
 return ch==='instagram'?b.instagramInbound(event,config):b.messengerInbound(event,config);
}
function published(){assert.ok(sent.length,'real adapter reached fake send boundary');const p=sent.at(-1).body;return (typeof p.text==='string'?p.text:p.text?.body)||p.message?.text;}
for(const ch of channels)for(const mixed of [false,true])test(`${ch}: real adapter preserves recommendation with ${mixed?'unsupported sibling':'full supported output'}`,async()=>{
 if(!mixed){reply=policy;claims=[claim(policy)];}await inbound(ch,question,ch==='whatsapp'?'46700000001':'customer');
 assert.equal(published(),policy);assert.equal(reads,0);assert.equal(retrieval.at(-1)?.businessId,77);
 if(evidenceFirst){
  const extraction=requests.find(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST UNIT EXTRACTION'));
  assert.ok(extraction,'retrieved evidence reached structured generation');assert.ok(JSON.parse(extraction.contents[0].parts[0].text).evidence.some((e:any)=>e.text===documentText&&e.businessId===77));
  assert.equal(unitDiags.at(-1)?.units,1);assert.equal(unitDiags.at(-1)?.facets[0].status,'VERIFIED');assert.equal(legacyGroundingCalls,0);
  assert.equal(requests.filter(p=>p.config.systemInstruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')).length,1);
 }else{
  assert.ok(requests.some(p=>p.config.systemInstruction.includes('untrusted_document_text:')),'retrieved evidence reached actual adapter generation');
  assert.equal(diags.at(-1)?.assessmentCoverageOk,true);if(mixed)assert.equal(diags.at(-1)?.verifiedEvidence,false,'whole candidate remains rejected');
 }
});

async function seed(ch:Channel,id:string){const sid=session(ch,id);
 await inbound(ch,'Jag vill boka Video Consultation nästa vecka. Visa lediga tider.',id);
 assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation','actual adapter created a resumable draft');
 assert.equal(b.pendingStateSnapshot(sid)?.dateTime,null);
 sent=[];requests=[];retrieval=[];diags=[];reads=0;return sid;
}
for(const ch of channels)for(const context of ['paraphrase','history','active','covered-mixed','incomplete-mixed'] as const)test(`${ch}/${context}: adapter context cannot discard the supported recommendation`,async()=>{
 const id=ch==='whatsapp'?'46700000002':'context';const sid=session(ch,id);
 if(context==='history')b.promptAuditHistory(sid,[{role:'user',content:'Jag kanske vill boka Video Consultation senare.'},{role:'assistant',content:'Vi kan titta på tider när du vill.'}]);
 if(context==='active')await seed(ch,id);
 if(context==='covered-mixed'){reply=`${unsupported} ${contact} ${policy}`;claims=[claim(unsupported,false),claim(contact),claim(policy)];}
 if(context==='incomplete-mixed')reply+= ' Berätta gärna mer när du vill.';
 await inbound(ch,context==='paraphrase'?'Behöver jag boka i förväg för att besöka er?':question,id);
 assert.equal(published(),policy);assert.equal(reads,0);assert.doesNotMatch(published(),/måste|ingen specifik|kontakta/iu);
 if(context==='active'){assert.equal(b.pendingStateSnapshot(sid)?.continuationPaused,true);assert.equal(b.pendingStateSnapshot(sid)?.service,'Video Consultation');assert.equal(b.pendingStateSnapshot(sid)?.dateTime,null);}
 assert.equal(requests.filter(p=>p.config.systemInstruction.includes('COMPLETENESS REPAIR')).length,0,'a complete verified sentence needs no new generation');
});
for(const ch of channels)for(const [name,text,facts,active] of [
 ['parking','Hej! Finns det parkering i närheten av er studio?',[parking],false],
 ['parking-detour','Tack! Innan jag väljer en tid, kan du berätta om det finns parkering nära studion?',[parking],true],
 ['digital-intro','Innan vi bokar, kan du berätta om ni erbjuder digitala möten?',[digital],false],
 ['digital-direct','Erbjuder ni digitala möten?',[digital],false],
 ['compound','Jag har två frågor: Finns det parkering nära er studio, och erbjuder ni digitala möten?',[parking,digital],false],
] as const)test(`${ch}/${name}: actual adapter publishes the same authorized facts`,async()=>{
 const id=ch==='whatsapp'?'46700000003':'information';if(active)await seed(ch,id);reply=facts.join(' ');claims=facts.map(f=>claim(f));
 await inbound(ch,text,id);for(const fact of facts)assert.ok(published().includes(fact));assert.equal(reads,0);assert.equal(retrieval.at(-1).lexicalMatchCount,1);assert.equal(retrieval.at(-1).semanticMatchCount,0);
 if(evidenceFirst){assert.equal(retrieval.at(-1).businessId,77);assert.equal(unitDiags.at(-1).units,facts.length);assert.equal(legacyGroundingCalls,0);}else assert.equal(diags.at(-1).businessId,77);
});
for(const ch of channels)for(const state of ['missing','foreign','revoked','stale'] as const)test(`${ch}/${state}: adapter publication fails closed`,async()=>{
 mode=state;if(state==='revoked')current=false;
 if(state==='stale')configure({assessBusinessClaimEntailment:async r=>{current=false;return{relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false};}});
 await inbound(ch,question,ch==='whatsapp'?'46700000004':'absent');assert.equal(published().includes(policy),false);assert.equal(reads,0);
});
const languages=[
 ['sv',question,policy,'Du måste alltid boka.'],
 ['en','Can I come without booking in advance?','We recommend booking ahead because visits are arranged by agreement.','You must always book.'],
 ['de','Kann ich ohne vorherige Buchung vorbeikommen?','Wir empfehlen eine vorherige Buchung, da Besuche nach Vereinbarung stattfinden.','Sie müssen immer buchen.'],
 ['es','¿Puedo venir sin reservar con antelación?','Recomendamos reservar con antelación porque las visitas se organizan por acuerdo.','Debe reservar siempre.'],
 ['fa','آیا می‌توانم بدون رزرو قبلی مراجعه کنم؟','توصیه می‌کنیم از قبل رزرو کنید، زیرا مراجعه با هماهنگی انجام می‌شود.','باید همیشه رزرو کنید.'],
 ['ar','هل يمكنني الحضور بدون حجز مسبق؟','نوصي بالحجز مسبقًا لأن الزيارات تتم بالاتفاق.','يجب الحجز دائمًا.'],
] as const;
for(const ch of channels)for(const [language,text,fact,bad] of languages)test(`${ch}/${language}: meaningful language switch preserves recommendation scope`,async()=>{
 const id=ch==='whatsapp'?'46700000005':'language';b.seedFlowLanguage(session(ch,id),'sv');documentText=fact;reply=`${bad} ${fact}`;claims=[claim(bad,false),claim(fact)];
 configure({semanticLanguageResolver:async()=>({language,confidence:1})});await inbound(ch,text,id);
 assert.equal(published(),fact);assert.equal(b.conversationState(session(ch,id)).language,language);assert.equal(reads,0);
});
for(const ch of channels)for(const [kind,text] of [['booking','Jag vill boka Video Consultation nästa vecka. Visa lediga tider.'],['cancellation','Jag vill avboka min bokade tid.'],['rescheduling','Jag vill omboka min bokade tid till nästa vecka.']] as const)test(`${ch}/${kind}: real adapter retains deterministic appointment authority`,async()=>{
 await inbound(ch,text,ch==='whatsapp'?'46700000006':'action');assert.equal(retrieval.length,0);assert.ok(reads>0);assert.equal(published().includes(policy),false);
 assert.doesNotMatch(published(),/bokning är bekräftad|har avbokats|har ombokats/iu);
});
for(const ch of channels)test(`${ch}: duplicate event reaches neither provider nor publication twice`,async()=>{
 reply=policy;claims=[claim(policy)];const id=ch==='whatsapp'?'46700000007':'duplicate';await inbound(ch,question,id,'999');const count=sent.length,generated=requests.length;
 await inbound(ch,question,id,'999');assert.equal(sent.length,count);assert.equal(requests.length,generated);
});
for(const ch of channels)test(`${ch}: wrong channel recipient cannot acquire another business scope`,async()=>{
 const wrong={...config,instagramAccountId:'other',whatsappPhoneNumberId:'other',messengerPageId:'other',telegramBusinessResolved:false};
 if(ch==='telegram')await b.telegramInbound({update_id:80,message:{chat:{id:80},text:question}},wrong);
 else if(ch==='whatsapp')await b.whatsappInbound({id:'wrong',from:'46700000008',text:{body:question}},{phone_number_id:'wa-synthetic'},wrong);
 else {const e={sender:{id:'wrong'},recipient:{id:ch==='instagram'?'ig-synthetic':'ms-synthetic'},message:{mid:'wrong',text:question},timestamp:Date.now()};await(ch==='instagram'?b.instagramInbound(e,wrong):b.messengerInbound(e,wrong));}
 assert.equal(retrieval.length,0);assert.equal(requests.length,0);assert.ok(sent.every(x=>!JSON.stringify(x.body).includes(policy)));
});
for(const outcome of ['unknown','contradicted','unrelated','missing-source','overlap','question'] as const)test(`${outcome}: policy recovery still requires exact evidence, independent entailment and requested-fact relevance`,async()=>{
 unitFault=outcome;
 if(outcome==='question'){reply=`${unsupported} ${policy.slice(0,-1)}？`;claims=[claim(unsupported,false),claim(policy.slice(0,-1)+'？',true,policy)];}
 if(outcome==='missing-source')claims=[claim(policy,true,'NOT IN SOURCE'),claim(unsupported,false)];
 if(outcome==='overlap')claims=[claim(policy),claim(policy,false)];
 configure({assessBusinessClaimEntailment:async r=>({relation:outcome==='unknown'?'UNKNOWN':outcome==='contradicted'?'CONTRADICTED':outcome==='unrelated'&&r.requireRequestedFact?'NOT_APPLICABLE':'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false})});
 await inbound('instagram',question,'unsafe');assert.equal(published().includes(policy),false);
});

for(const ch of channels)for(const mixed of [false,true])test(`${ch}: split atomic clauses retain their verified complete sentence (${mixed?'mixed':'complete'})`,async()=>{
 const first=policy.slice(0,policy.indexOf(',')),second=policy.slice(policy.indexOf(',')+2,-1);
 reply=mixed?`${unsupported} ${policy}`:policy;claims=[...(mixed?[claim(unsupported,false)]:[]),claim(first,true,policy),claim(second,true,policy)];
 await inbound(ch,question,ch==='whatsapp'?'46700000009':'split');assert.equal(published(),policy);assert.equal(reads,0);
});
for(const ch of channels)for(const repair of ['evidence','candidate'] as const)test(`${ch}: ${repair} quote repair preserves unsupported sibling decisions`,async()=>{
 const good=claim(policy);claims=[claim(unsupported,false),{...good,...(repair==='evidence'?{evidence:[{source:'retrieved_knowledge',quote:'PARAPHRASED CITATION NOT IN SOURCE'}]}:{candidateQuote:'Vi rekommenderar bokning i förväg.'})}];
 configure({assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:false,claims:r.evidenceQuoteRepair||r.candidateQuoteRepair?[claim(unsupported,false),good]:claims})});
 await inbound(ch,question,ch==='whatsapp'?'46700000010':'quote-repair');assert.equal(published(),policy);if(evidenceFirst){assert.equal(unitDiags.at(-1).units,1);assert.equal(legacyGroundingCalls,0);}else assert.equal(diags.at(-1).verifiedEvidence,false);
});
for(const bad of ['flip-support','change-claim','invent-citation','empty-evidence'])test(`mixed citation repair rejects ${bad}`,async()=>{
 unitFault=bad;claims=[claim(unsupported,false),claim(policy,true,'PARAPHRASED CITATION NOT IN SOURCE')];
 configure({assessBusinessSupportGrounding:async r=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:false,claims:r.evidenceQuoteRepair?[{...claim(unsupported,false),...(bad==='flip-support'?{supported:true}:{})},{...claim(policy),...(bad==='change-claim'?{claim:'Different proposition'}:bad==='invent-citation'?{evidence:[{source:'retrieved_knowledge',quote:'INVENTED'}]}:bad==='empty-evidence'?{evidence:[]}: {})}]:claims})});
 await inbound('messenger',question,'repair-safety');assert.equal(published().includes(policy),false);
});

});
