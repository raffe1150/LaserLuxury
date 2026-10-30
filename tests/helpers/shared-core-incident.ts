import { DisposableNativeKnowledgeDatabase } from './disposable-native-knowledge-db';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { incidentCorpus, incidentConfig } from './p0-incident-knowledge';
import { documentChunks } from '../../src/knowledge/documents/service';
import { extractInProcess } from '../../src/knowledge/documents/extraction-process';
export const sharedQuestions = {
 es: [
 'Voy a visitarles por primera vez. ¿Con cuánta antelación debo llegar y necesito llevar algo?',
 'Estoy pensando en reservar una Video Consultation. ¿Cuánto cuesta, cuánto dura y puede sustituir una visita presencial?',
 'Si llego más de 15 minutos tarde a mi cita reservada, ¿se cancela automáticamente?',
 'Si olvido un objeto de valor en el estudio, ¿cuánto tiempo lo guardan y qué debo hacer para recuperarlo?',
 ],
 ar: [
 'سأزوركم للمرة الأولى. قبل موعدي بكم من الوقت ينبغي أن أصل، وهل أحتاج إلى إحضار شيء؟',
 'أفكر في حجز Video Consultation. ما سعرها وما مدتها، وهل يمكن أن تحل محل زيارة حضورية؟',
 'إذا تأخرت أكثر من 15 دقيقة عن زيارتي المحجوزة، فهل تُلغى تلقائيًا؟',
 'إذا نسيت غرضًا ثمينًا في الاستوديو، فكم من الوقت تحتفظون به وماذا يجب أن أفعل لاستعادته؟',
 ],
 sv: [
 'Jag ska besöka er för första gången. Hur tidigt bör jag komma och behöver jag ta med mig något?',
 'Jag funderar på att boka en videokonsultation. Vad kostar den, hur lång tid tar den och kan den ersätta ett besök på plats?',
 'Okej, och om jag blir mer än 15 minuter sen till mitt bokade besök, blir det automatiskt avbokat?',
 'Om jag glömmer kvar något värdefullt hos er, hur länge sparar ni det och vad behöver jag göra för att få tillbaka det?',
 ],
 en: [
 'I am visiting you for the first time. How early should I arrive, and do I need to bring anything?',
 'I am considering booking a Video Consultation. What does it cost, how long does it last, and can it replace an in-person visit?',
 'Okay, if I am more than 15 minutes late for my booked visit, is it automatically cancelled?',
 'If I leave a valuable item with you, how long do you keep it and what must I do to get it back?',
 ],
 de: [
 'Ich besuche Sie zum ersten Mal. Wie früh sollte ich kommen und muss ich etwas mitbringen?',
 'Ich überlege, eine Video Consultation zu buchen. Was kostet sie, wie lange dauert sie und kann sie einen Besuch vor Ort ersetzen?',
 'Wenn ich mehr als 15 Minuten zu spät zu meinem gebuchten Besuch komme, wird er automatisch abgesagt?',
 'Wenn ich einen Wertgegenstand bei Ihnen vergesse, wie lange bewahren Sie ihn auf und was muss ich tun, um ihn zurückzubekommen?',
 ],
 fa: [
 'برای اولین بار به شما مراجعه می‌کنم. چقدر زودتر باید برسم و آیا لازم است چیزی همراه داشته باشم؟',
 'به رزرو Video Consultation فکر می‌کنم. قیمت و مدت آن چقدر است و آیا می‌تواند جایگزین مراجعه حضوری شود؟',
 'اگر بیش از 15 دقیقه برای مراجعه رزروشده‌ام دیر برسم، آیا مراجعه به‌طور خودکار لغو می‌شود؟',
 'اگر وسیله باارزشی نزد شما جا بگذارم، تا چه مدت آن را نگه می‌دارید و برای پس گرفتن آن چه باید بکنم؟',
 ],
} as const;
export async function sharedCorpus(real = false, production = true) {
 const base = await incidentCorpus(real);
 const raw = production ? JSON.parse(readFileSync(new URL('../fixtures/admotion-production-document.json', import.meta.url),'utf8')) :
 documentChunks(await extractInProcess(readFileSync(new URL('../fixtures/admotion-studio-shared-core.pdf',import.meta.url)),'admotion studio1.pdf','application/pdf'),'admotion studio1.pdf');
 await base.storage.create({...base.source,content:raw.content,metadata:raw.metadata});
 await base.storage.replaceChunks(77,base.source.id,raw.chunks.map((c:any)=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata})));
 // Read-only production query verified these values on 22 October 2026.
 incidentConfig.services = [{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true} as any];
 let cleanup=()=>{};
 if(process.env.ODINLINK_SHARED_PG==='true') {
  const pg=new DisposableNativeKnowledgeDatabase();cleanup=()=>pg.close();
  pg.sql(`CREATE TABLE public.knowledge_sources(id uuid PRIMARY KEY,business_id bigint,title text,status text);
   CREATE TABLE public.knowledge_chunks(source_id uuid,business_id bigint,chunk_index integer,content text,metadata jsonb,search_vector tsvector);
   GRANT SELECT ON public.knowledge_sources,public.knowledge_chunks TO service_role;`);
  pg.sql(readFileSync('supabase/migrations/20260926112616_improve_knowledge_search_language_relevance.sql','utf8'));
  const literal=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
  const sources=await base.storage.list(77);const ids=new Map(sources.map((src,index)=>[src.id,`00000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`]));
  for(const src of sources) {
   const id=ids.get(src.id)!;pg.sql(`INSERT INTO public.knowledge_sources VALUES(${literal(id)},77,${literal(src.title)},'ready');`);
   for(const c of (src.id===base.source.id ? raw.chunks.map((c:any)=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata})) : [{chunkIndex:0,content:src.content,metadata:{source:'document',section:'Text'}}]))pg.sql(`INSERT INTO public.knowledge_chunks VALUES(${literal(id)},77,${c.chunkIndex},${literal(c.content)},${literal(JSON.stringify(c.metadata))}::jsonb,to_tsvector('simple',${literal(c.content)}));`);
  }
  base.storage.search=async(businessId,query,limit=5)=>{
   const rows=JSON.parse(pg.sql(`SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM public.search_knowledge_chunks(${Number(businessId)},${literal(query)},${Number(limit)}) t;`));
   return rows.map((r:any)=>({sourceId:[...ids].find(([,id])=>id===r.source_id)?.[0]||'unknown',businessId:Number(r.business_id),text:r.content,score:r.score,metadata:r.metadata}));
  };
 }
 return {...base,chunkCount:raw.chunks.length+1,cleanup};
}
export function assertSharedFacts(index:number,reply:string,language:string) {
 assert.ok(reply.trim());
 assert.doesNotMatch(reply,/Vad syftar du|What are you referring|Worauf beziehen|منظورتان چه چیزی/iu);
 // Minimum smoke assertions only. These never establish semantic acceptance.
 const normalized=reply.replace(/[٠-٩]/gu,c=>String(c.charCodeAt(0)-1632));
 if(index===0){assert.match(normalized,/(?:10|۱۰)/u);assert.match(reply,/bekräft|confirmation|bestätigung|تأیید|تایید|confirmación|تأكيد/iu);assert.match(reply,/instruk|instruction|anweisung|hinweis|دستور|instrucci|تعليمات/iu);}
 if(index===1){assert.match(reply,/Video Consultation/u);assert.match(normalized,/(?:300|۳۰۰)/u);assert.match(normalized,/(?:60|۶۰)/u);assert.match(reply,/inte|not|nicht|نمی|نیست|no |لا /iu);assert.match(reply,/digital|اطلاعات|اطلاع|رقمي|رقمية|رقميًا/iu);}
 if(index===2){assert.match(normalized,/(?:15|۱۵)/u);assert.match(reply,/inte|not|nicht|نمی|نیست|no |لا /iu);assert.match(reply,/bedöm|assess|beurteil|prüf|ارزیابی|بررسی|evalu|تقييم/iu);assert.match(reply,/kontakt|contact|meld|اطلاع|تماس|تواصل|اتصل/iu);}
 if(index===3){assert.match(normalized,/(?:21|۲۱)/u);assert.match(reply,/registr|separat|gesondert|ثبت|تسجيل|تُسجل/iu);assert.match(reply,/beskriv|describ|beschreib|توصیف|شرح|describir|وصف/iu);}
}

/** A focused acceptance checklist, not an entailment substitute. Actual unit
 * provenance and prose still require manual review before widening the gate. */
export function focusedSemanticChecklist(index:number,text:string,language:string):Record<string,boolean>|null {
 if(!['en','de'].includes(language)||![0,1].includes(index))return null;
 const en=language==='en';
 if(index===0)return {
  firstVisit:en?/first[ -](?:time|visit)|first time/iu.test(text):/ersten? (?:Besuch|Mal)|zum ersten/iu.test(text),
  approximateTenBefore:en?/(?:approximately|about|around|roughly)\s+(?:10|ten)\s+minutes?\s+before/iu.test(text):/(?:etwa|ungefähr|circa|ca\.?)\s+(?:10|zehn)\s+Minuten\s+vor/iu.test(text),
  confirmationFormats:en?/confirmation/iu.test(text)&&/digital/iu.test(text)&&/paper/iu.test(text):/bestätigung/iu.test(text)&&/digital/iu.test(text)&&/Papier/iu.test(text),
  conditionalRequiredPreparation:en?/(?:if|when|who (?:has|have)).{0,100}(?:received|given).{0,130}(?:must|need to|have to).{0,35}(?:follow|comply)/iu.test(text):/(?:wenn|falls|sofern).{0,160}(?:erhalten|bekommen).{0,90}(?:müssen|muss|befolgen Sie)|(?:müssen|muss).{0,100}befolgen.{0,50}(?:wenn|falls|sofern).{0,100}(?:erhalten|bekommen)/iu.test(text),
  noGenericPartialNotice:!/I can (?:currently )?only confirm|Ich kann derzeit nur diese Angaben bestätigen|I cannot verify that part right now|Diesen Teil kann ich gerade nicht überprüfen/iu.test(text),
 };
 return {
  catalogAmounts:/Video Consultation/u.test(text)&&/300\s*SEK/u.test(text)&&/60\s*(?:minutes|Minuten)/u.test(text),
  distinctDocumentOffering:en?/digital (?:information(?:al)?|introductory)/iu.test(text):/digital\p{L}*\s+Informations/iu.test(text),
  introductoryOnly:en?/(?:only|solely).{0,30}(?:initial|introductory)|(?:initial|introductory).{0,30}only/iu.test(text):/(?:nur|ausschließlich).{0,50}(?:Information|Orientierung)|(?:Information|Orientierung).{0,50}(?:nur|ausschließlich)/iu.test(text),
  noAutomaticReplacement:en?/(?:not|never|don't|do not|does not).{0,25}automatically.{0,20}replac|(?:not|never|don't|do not|does not).{0,20}replac.{0,45}automatically|not an automatic replacement/iu.test(text):/nicht automatisch.{0,55}ersetz|ersetz.{0,65}nicht automatisch/iu.test(text),
  notAllDigital:en?/not all.{0,90}digital|cannot.{0,40}(?:all|every).{0,50}digital/iu.test(text):/nicht alle.{0,90}digital/iu.test(text),
  relationshipUncertainty:en?/cannot confirm whether the document's information applies to Video Consultation/u.test(text):/nicht bestätigen, ob die Angaben im Dokument für Video Consultation gelten/u.test(text),
 };
}
