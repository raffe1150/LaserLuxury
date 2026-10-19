import { businessInformationTopics } from '../ai/business-information';
/** Reviewed fact-free presentation only. No new intent classifier, model call,
 * raw question/document interpolation, calendar claim, finding or delivery ETA. */
export type WaitingStage = 'extraction' | 'verification';
export type WaitingTopic = 'parking' | 'location' | 'information';
export function waitingTopic(labels:readonly string[]=[]):WaitingTopic {
  const safe=labels.slice(0,8).map(v=>typeof v==='string'?v.slice(0,240).toLowerCase().trim():'');
  // Reuse read-only existing topic recognition for literal planner facets too.
  // This only selects a fact-free noun phrase; it grants no execution authority.
  if(safe.some(label=>businessInformationTopics(label).includes('parking')))return 'parking';
  if(safe.includes('location')||safe.includes('directions'))return 'location';
  return 'information';
}
const copy={
 en:{parking:'your parking question',location:'your question about getting here',information:'your question',
  extraction:['I’m reviewing the relevant information for {topic}.','I’m taking a closer look at the information for {topic}.','I’m working through the available information for {topic}.'],
  verification:['I’m cross-checking the details for {topic}.','I’m checking the details against the information for {topic}.','I’m carefully reviewing the details for {topic}.']},
 sv:{parking:'din fråga om parkering',location:'din fråga om hur du hittar hit',information:'din fråga',
  extraction:['Jag går igenom informationen för {topic}.','Jag tittar närmare på underlaget för {topic}.','Jag arbetar igenom uppgifterna för {topic}.'],
  verification:['Jag dubbelkollar detaljerna för {topic}.','Jag stämmer av detaljerna i {topic} mot underlaget.','Jag granskar uppgifterna i {topic} lite närmare.']},
 de:{parking:'Ihrer Frage zum Parken',location:'Ihrer Frage zur Anfahrt',information:'Ihrer Frage',
  extraction:['Ich sehe mir die Informationen zu {topic} genauer an.','Ich gehe die verfügbaren Informationen zu {topic} durch.','Ich prüfe gerade die relevanten Angaben zu {topic}.'],
  verification:['Ich gleiche die Details zu {topic} mit den Informationen ab.','Ich überprüfe die Einzelheiten zu {topic}.','Ich sehe mir die Details zu {topic} noch einmal sorgfältig an.']},
 es:{parking:'su pregunta sobre aparcamiento',location:'su pregunta sobre cómo llegar',information:'su pregunta',
  extraction:['Estoy revisando la información relacionada con {topic}.','Estoy consultando la información disponible para {topic}.','Estoy mirando con más detalle la información para {topic}.'],
  verification:['Estoy contrastando los detalles de {topic}.','Estoy comprobando los detalles de {topic} con la información disponible.','Estoy revisando con cuidado los detalles de {topic}.']},
 fa:{parking:'پرسش شما درباره پارکینگ',location:'پرسش شما درباره مسیر دسترسی',information:'پرسش شما',
  extraction:['در حال مرور اطلاعات مرتبط با {topic} هستم.','دارم اطلاعات موجود برای {topic} را بررسی می‌کنم.','اطلاعات مربوط به {topic} را دقیق‌تر مرور می‌کنم.'],
  verification:['دارم جزئیات {topic} را با اطلاعات موجود تطبیق می‌دهم.','در حال بررسی دقیق‌تر جزئیات {topic} هستم.','جزئیات مربوط به {topic} را دوباره بررسی می‌کنم.']},
 ar:{parking:'سؤالك عن مواقف السيارات',location:'سؤالك عن كيفية الوصول',information:'سؤالك',
  extraction:['أراجع المعلومات المتعلقة ب{topic}.','أطّلع على المعلومات المتاحة بشأن {topic}.','أراجع المعلومات الخاصة ب{topic} بمزيد من العناية.'],
  verification:['أتحقق من تفاصيل {topic} بمقارنتها بالمعلومات المتاحة.','أراجع تفاصيل {topic} بعناية.','أدقق في التفاصيل المتعلقة ب{topic}.']},
} as const;
export function waitingLanguage(language:string):keyof typeof copy|null {
  const code=language.toLowerCase().split('-')[0];return Object.hasOwn(copy,code)?code as keyof typeof copy:null;
}
export function waitingText(language:string,stage:WaitingStage,topic:WaitingTopic,variant:number):string|null {
  const lang=waitingLanguage(language);if(!lang)return null;
  const row=copy[lang];return row[stage][Math.abs(variant)%3].replace('{topic}',row[topic]);
}
export function approvedWaitingText(language:string,text:string,phase?:WaitingStage):boolean {
  const stages:readonly WaitingStage[]=phase?[phase]:['extraction','verification'];
  return stages.some(stage=>(['parking','location','information'] as const)
    .some(topic=>[0,1,2].some(i=>waitingText(language,stage,topic,i)===text)));
}
