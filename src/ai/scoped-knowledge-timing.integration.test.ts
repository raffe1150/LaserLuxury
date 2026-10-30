import test from 'node:test';
import assert from 'node:assert/strict';
import { Responses } from 'openai/resources/responses';
import { incidentFlags, incidentConfig, incidentCorpus, incidentChannels, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { wholeQuestionInformationPlan } from './knowledge-planning';
import { AiReliabilityError } from './reliability';

// Actual native handlers + SDK adapter; all provider results and sends are offline.
// No database, paid request, genuine credential or semantic-index write is used.
incidentFlags();
Object.assign(process.env,{OPENAI_API_KEY:'synthetic-offline',ODINLINK_KNOWLEDGE_MODEL_PROFILE:'off',
  ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const corpora=new Map([[3,await incidentCorpus(false,3)],[4,await incidentCorpus(false,4)]]);
const conflictingCorpus=await incidentCorpus(false,3);
const conflictText='Vid en försening på mer än 15 minuter avbokas besöket automatiskt.';
await conflictingCorpus.storage.create({...conflictingCorpus.source,id:'conflicting-policy',content:conflictText,
  metadata:{segments:[{start:0,end:conflictText.length,section:'Text'}]}});
await conflictingCorpus.storage.replaceChunks(3,'conflicting-policy',[
  {chunkIndex:0,content:conflictText,metadata:{source:'document',section:'Text'}},
]);
const questions={
  sv:'Om jag blir mer än 15 minuter sen till mitt bokade besök, blir det automatiskt avbokat?',
  en:'If I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
  de:'Was passiert, wenn ich mehr als 15 Minuten zu spät komme? Wird mein Termin automatisch storniert?',
  es:'Si llego más de 15 minutos tarde a mi cita reservada, ¿se cancela automáticamente?',
  fa:'اگر بیش از 15 دقیقه برای مراجعه رزروشده‌ام دیر برسم، آیا مراجعه به‌طور خودکار لغو می‌شود؟',
  ar:'إذا تأخرت أكثر من 15 دقيقة عن زيارتي المحجوزة، فهل تُلغى تلقائيًا؟',
};
type Language=keyof typeof questions;
const statements:Record<Language,string[]>={
  sv:['Kontakta studion så snart som möjligt om du riskerar att bli sen.',
    'Vid mer än 15 minuters försening behöver personalen bedöma situationen.', 'Besöket avbokas inte automatiskt.'],
  en:['Contact the studio as soon as possible if you risk arriving late.',
    'For delays exceeding 15 minutes, staff must assess the situation.', 'The visit is not automatically cancelled.'],
  de:['Informieren Sie das Studio so bald wie möglich, wenn Sie sich verspäten.',
    'Bei mehr als 15 Minuten Verspätung muss das Personal die Situation beurteilen.', 'Der Termin wird nicht automatisch abgesagt.'],
  es:['Contacte con el estudio lo antes posible si cree que llegará tarde.',
    'Si el retraso supera los 15 minutos, el personal debe evaluar la situación.', 'La cita no se cancela automáticamente.'],
  fa:['اگر احتمال می‌دهید دیر برسید، هرچه زودتر با استودیو تماس بگیرید.',
    'اگر تأخیر بیش از 15 دقیقه باشد، کارکنان باید وضعیت را بررسی کنند.', 'نوبت به‌طور خودکار لغو نمی‌شود.'],
  ar:['تواصل مع الاستوديو بأسرع وقت ممكن إذا كنت ستتأخر.',
    'إذا تجاوز التأخير 15 دقيقة، يجب على الموظفين تقييم الموقف.', 'لا يُلغى الموعد تلقائياً.'],
};
type Mode='success'|'verifier_timeout'|'malformed'|'conflict'|'foreign'|'foreign_retrieval'|'revoked'|'incomplete'|'late_completion'|'legacy';

async function exercise(t:any,channel:typeof incidentChannels[number],language:Language,mode:Mode,
  question=questions[language],businessId=3,allowlist:string|null='3') {
  b.reset();const saved={...incidentConfig};const previous=process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS;
  if(allowlist===null)delete process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS;
  else process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS=allowlist;
  Object.assign(incidentConfig,{id:businessId,businessId,language:'sv'});
  const corpus=mode==='conflict'?conflictingCorpus:corpora.get(businessId)!;
  const replies:string[]=[],stages:string[]=[],events:any[]=[],summaries:any[]=[],policies:any[]=[];
  const providerErrors:string[]=[];
  let now=1_800_000_000_000,knowledgeStart:number|undefined,extracted=false,verificationOverhead=false,actions=0;
  const actionStacks:string[]=[];
  const extended=businessId===3&&allowlist==='3';
  t.mock.method(Date,'now',()=>now);
  const forbidden=async()=>{actions++;const error=Error('Booking/calendar mutation forbidden');actionStacks.push(error.stack!);throw error;};
  for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,(label,data)=>{
    if(label==='[KnowledgeTimingPolicy]')policies.push(data);
  });
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    replies.push(interceptedIncidentSend(input,options));
    return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'synthetic'}],message_id:'synthetic'}),{status:200});
  });
  const result=(value:unknown)=>({output_text:JSON.stringify(value),output:[]}) as any;
  t.mock.method(Responses.prototype,'create',async(p:any)=>{
    try {
    assert.equal(p.model,'gpt-5.6-luna','Timing selection cannot activate Sol');
    const d=JSON.parse(p.input[0].content),instruction=p.instructions;
    if(instruction.startsWith('OdinLink source-language search query.'))
      return result({query:'försening minuter personalen bedöma situationen entré innergården'});
    if(instruction.includes('retrieval query planner')){
      stages.push('planning');
      return result({canonicalMeaning:d.question,queries:[d.question],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',
        referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'customer request',attribute:d.question,questionType:'description',
          obligations:[{description:d.question,questionType:'description'}]}]});
    }
    const normalized=(text:string)=>text.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' ');
    assert.equal(normalized(d.question),normalized(question),'Both stages retain the whole request through existing punctuation normalization');
    assert.equal(d.requestedLanguage,language);
    assert.ok(d.evidence.every((e:any)=>e.businessId===businessId));
    if(instruction.includes('UNIT EXTRACTION')){
      stages.push('extraction');assert.equal(!!nativeKnowledgeTiming(),extended);
      assert.ok(knowledgeStart!==undefined);
      // Measured incident: 1592ms before extraction, then 6773ms extraction.
      now+=6773;extracted=true;
      const arrivalQuote=d.evidence.find((e:any)=>/Vid en försening/u.test(e.text)&&/bedöma situationen/u.test(e.text));
      const contactQuote=d.evidence.find((e:any)=>/Om du riskerar/u.test(e.text));
      assert.ok(arrivalQuote&&contactQuote,'Real PDF passages must be retrieved');
      if(mode==='conflict')assert.ok(d.evidence.some((e:any)=>e.text===conflictText),'Conflicting current evidence must reach the independent verifier');
      const facts=statements[language].map((text,i)=>({text,quote:i===0?
        contactQuote.text.match(/Om du riskerar[^]+?med företaget\./u)[0]:
        arrivalQuote.text.match(/Vid en försening[^]+?bedöma situationen\./u)[0],evidence:i===0?contactQuote:arrivalQuote}));
      if(question.startsWith('Wo ist der Eingang')){
        const e=d.evidence.find((e:any)=>/Studions entré/u.test(e.text));assert.ok(e);
        facts.push({text:'Der Eingang liegt im Innenhof, nicht am Haupteingang zur Straße. Benutzen Sie das Tor Aurora 7 und folgen Sie den blauen Schildern zur Rezeption im zweiten Stock.',
          quote:e.text.match(/Studions entré[^]+?andra våningen\./u)[0],evidence:e});
      }
      return result({oversized:false,units:facts.map((fact,i)=>({facetIds:['f1'],subject:'documented visitor policy',predicate:'states',
        value:fact.text,text:fact.text,language,modality:i===0?'recommended':'descriptive',negation:i===2,
        scope:'documented arrival policy; delay threshold is conditional',qualifiers:[],
        evidenceRefs:[{evidenceId:mode==='foreign'?'foreign-tenant-evidence':fact.evidence.id,exactQuote:fact.quote}]}))});
    }
    if(instruction.includes('BATCH ENTAILMENT')){
      stages.push('verification');
      for(const u of d.units)for(const ref of u.evidenceRefs)
        assert.ok(d.evidence.find((e:any)=>e.id===ref.evidenceId)?.text.includes(ref.exactQuote));
      // Former allowance was 9533ms; the measured expiry was 9535ms.
      now+=mode==='legacy'?9535:mode==='verifier_timeout'||mode==='late_completion'?20001:12000;
      if(mode==='verifier_timeout'||mode==='legacy')throw new AiReliabilityError('TIMEOUT','Synthetic verifier timeout');
      if(mode==='malformed')return {output_text:'not-json',output:[]} as any;
      return result({decisions:d.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,
        relation:mode==='conflict'?'CONTRADICTED':'ENTAILED',meaningPreserved:true,modalityPreserved:true,
        qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
        coverage:d.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:mode!=='incomplete',
          materialUnitIds:d.units.map((u:any)=>u.id),incompletenessReason:mode==='incomplete'?'MISSING_RELEVANT_FACT':'NONE',
          obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:mode==='incomplete'?'UNRESOLVED':'COVERED',unitIds:d.units.map((u:any)=>u.id)}))}))});
    }
    assert.fail('No unrelated generation or provider stage');
    } catch(error) {providerErrors.push(String((error as Error).stack));throw error;}
  });
  try {
    b.configure({semanticLanguageResolver:async()=>{assert.equal(!!nativeKnowledgeTiming(),extended);now+=1762;return{language,confidence:1};},
      postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),
      knowledgeSearch:(id,q,limit)=>{
        assert.equal(id,businessId);assert.ok(knowledgeStart!==undefined);now=knowledgeStart!+1592;
        if(mode==='foreign_retrieval')return corpora.get(4)!.service.search(4,q,limit);
        return corpus.service.search(id,q,limit);
      },
      knowledgeSourceLanguages:id=>corpus.service.sourceLanguageHints(id),semanticKnowledgeSearchQueries:async()=>[],
      validateKnowledgeMatches:async(id,matches)=>{
        assert.equal(id,businessId);
        if(extracted&&!verificationOverhead){now+=602;verificationOverhead=true;}
        return mode==='revoked'&&extracted?[]:corpus.service.validateMatches(id,matches,{strictSources:true,captureRevision:true});
      },
      evidenceFirstDiagnostic:e=>summaries.push(e),evidenceFirstDecisionDiagnostic:e=>{
        events.push(e);if(knowledgeStart===undefined&&e.stage==='planning')knowledgeStart=now;
      },
      calendarAdapter:{getCalendarId:()=>'',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,
        cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
    await incidentInbound(b,channel,question);
    assert.equal(actions,0,actionStacks.join('\n'));assert.equal(replies.length,1,'One customer delivery maximum');
    assert.equal(policies.length,extended?1:0);assert.equal(summaries.length,1);
    assert.equal(events.find(e=>e.stage==='planning')?.remainingMs,extended?35000:20000);
    if(mode!=='foreign_retrieval')assert.ok(events.some(e=>e.stage==='extraction'&&e.eventType==='transport'&&e.durationMs===6773));
    assert.doesNotMatch(replies[0],/Video Consultation|300 SEK|bokningsbara tjänster/u);
    const direct=!!wholeQuestionInformationPlan(question,true,false,incidentConfig.services);
    assert.equal(stages.includes('planning'),!direct,'Existing routing is unchanged');
    if(mode==='success'&&extended){
      assert.equal(summaries[0].semanticVerifiedUnits,question.startsWith('Wo ist der Eingang')?4:3,providerErrors.join('\n')||JSON.stringify(events));
      assert.ok(summaries[0].facets.every((f:any)=>f.status==='VERIFIED'));
      for(const text of statements[language])assert.ok(replies[0].includes(text),replies[0]);
      if(question.startsWith('Wo ist der Eingang'))assert.ok(replies[0].includes('Aurora 7'));
      const admission=events.find(e=>e.stage==='verification'&&e.admission?.checkpoint==='before_queue');
      assert.ok(admission.admission.effectiveAllowanceMs>9533);
      assert.equal(policies[0].policyVersion,'accuracy-first-v1');
    }else{
      if(mode!=='incomplete')assert.equal(summaries[0].semanticVerifiedUnits,0,JSON.stringify(events));
      if(mode!=='incomplete')assert.equal(summaries[0].units,0);
      assert.ok(summaries[0].facets.every((f:any)=>f.status!=='VERIFIED'));
      for(const text of statements[language])assert.equal(replies[0].includes(text),false,'Unverified facts must not escape');
      if(mode==='legacy'){
        assert.ok(events.some(e=>e.stage==='verification'&&e.admission?.effectiveAllowanceMs===9533));
        assert.ok(events.some(e=>e.stage==='verification'&&e.timeoutScope==='request'&&e.durationMs===9535));
      }
      if(mode==='foreign'||mode==='foreign_retrieval'||mode==='revoked')assert.equal(stages.includes('verification'),false);
      if(mode==='foreign_retrieval')assert.equal(stages.includes('extraction'),false);
      if(mode==='conflict')assert.ok(events.some(e=>e.relation==='CONTRADICTED'));
      if(mode==='verifier_timeout'||mode==='late_completion')assert.ok(events.some(e=>e.stage==='verification'&&e.failureCategory==='TIMEOUT'));
    }
  } finally {
    if(previous===undefined)delete process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS;
    else process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS=previous;
    Object.assign(incidentConfig,saved);b.reset();
  }
}

for(const language of Object.keys(questions) as Language[])for(const channel of incidentChannels)
  test(`scoped delayed Luna success ${language}/${channel}`,t=>exercise(t,channel,language,'success'));
for(const channel of incidentChannels)for(const mode of ['verifier_timeout','malformed','conflict','foreign','foreign_retrieval','revoked','incomplete','late_completion'] as Mode[])
  test(`scoped verifier safety ${channel}/${mode}`,t=>exercise(t,channel,'de',mode));
for(const channel of incidentChannels){
  test(`measured legacy expiry with global flag only ${channel}`,t=>exercise(t,channel,'de','legacy',questions.de,3,null));
}
for(const list of ['', '3,invalid'])
  test(`invalid backend enrollment retains legacy timing: ${JSON.stringify(list)}`,t=>exercise(t,'telegram','de','legacy',questions.de,3,list));
for(const language of Object.keys(questions) as Language[])for(const channel of incidentChannels)
  test(`other tenant retains legacy timing ${language}/${channel}`,t=>exercise(t,channel,language,'legacy',questions[language],4));
for(const question of [
  'Ich komme wahrscheinlich 20 Minuten zu spät. Wird mein Termin automatisch storniert?',
  'Was passiert bei einer Verspätung?',
  'Wo ist der Eingang und was passiert, wenn ich zu spät komme?',
])for(const channel of incidentChannels)
  test(`German variant retains complete obligations ${channel}/${question}`,t=>exercise(t,channel,'de','success',question));
