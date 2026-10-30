import {directServiceQuestions,type ServiceQuestionLanguage} from './direct-service-questions';
export const mixedBusinesses=[
 {id:88,name:'Cedar Repair Lab',service:{name:'Remote Assessment',price:145,currency:'EUR',durationMinutes:25,active:true},subject:'photo briefings',source:'Photo briefings provide initial orientation only. A photo briefing does not automatically replace a workshop inspection. Safety-critical faults cannot be assessed from photographs. Visitors should bring the device serial number if one is available.'},
 {id:99,name:'Summit Bike Workshop',service:{name:'Remote Bike Review',price:89,currency:'GBP',durationMinutes:20,active:true},subject:'setup briefings',source:'Setup briefings provide preliminary setup guidance only. A setup briefing does not automatically replace a bicycle inspection. Brake defects cannot be assessed from images. Riders should bring the frame identifier if one is available.'},
];
export const documentaryRequest:Record<ServiceQuestionLanguage,(subject:string)=>string>={
 en:s=>`Please also explain the documented purpose and limits of ${s}.`,
 sv:s=>`Beskriv även det dokumenterade syftet och begränsningarna för ${s}.`,
 de:s=>`Bitte erläutern Sie auch den dokumentierten Zweck und die Grenzen von ${s}.`,
 es:s=>`Explica también el propósito y los límites documentados de ${s}.`,
 fa:s=>`لطفاً هدف و محدودیت‌های مستند ${s} را توضیح دهید.`,
 ar:s=>`اشرح أيضاً الغرض والحدود الموثقة لـ ${s}.`,
};
/** Every translation retains price, duration, service replacement, and the
 * separately named documentary purpose/limits. Proper offering names stay exact. */
export const replacementRequest:Record<ServiceQuestionLanguage,(bike:boolean)=>string>={
 en:bike=>`and can it replace a ${bike?'bicycle':'workshop'} inspection?`,
 sv:bike=>`och kan den ersätta en ${bike?'cykelinspektion':'verkstadsinspektion'}?`,
 de:bike=>`und kann sie ${bike?'eine Fahrradinspektion':'eine Untersuchung in der Werkstatt'} ersetzen?`,
 es:bike=>`y puede sustituir ${bike?'una inspección de la bicicleta':'una inspección en el taller'}?`,
 fa:bike=>`و آیا می‌تواند جایگزین ${bike?'بازرسی دوچرخه':'بازرسی در کارگاه'} شود؟`,
 ar:bike=>`وهل يمكن أن تحل محل ${bike?'فحص للدراجة':'فحص في الورشة'}؟`,
};
export function mixedQuestion(b:typeof mixedBusinesses[number],language:ServiceQuestionLanguage){
 if(language==='en')return `What does ${b.service.name} cost and how long does it last, ${replacementRequest.en(b.id===99)} ${documentaryRequest.en(b.subject)}`;
 const catalog=directServiceQuestions[language](b.service.name)[2].replace(/[?؟]$/u,'');
 return `${catalog}${language==='fa'||language==='ar'?'،':','} ${replacementRequest[language](b.id===99)} ${documentaryRequest[language](b.subject)}`;
}

// Alternate natural paraphrases retain every obligation. Shapes outside the
// bounded direct grammar may use the established semantic planner in tests.
export const replacementParaphrase:Record<ServiceQuestionLanguage,(name:string,bike:boolean)=>string>={
 en:(n,bike)=>`Could I use it instead of a ${bike?'bicycle':'workshop'} inspection?`,
 sv:(n,bike)=>`Kan jag använda den i stället för en ${bike?'cykelinspektion':'verkstadsinspektion'}?`,
 de:(n,bike)=>`Kann ich mir damit ${bike?'die Fahrradinspektion':'den Werkstattbesuch'} sparen?`,
 es:(n,bike)=>`¿Puedo usarlo en lugar de ${bike?'una inspección de la bicicleta':'una inspección en el taller'}?`,
 fa:(n,bike)=>`آیا با ${n} دیگر نیازی به ${bike?'بازرسی دوچرخه':'بازرسی در کارگاه'} ندارم؟`,
 ar:(n,bike)=>`هل تغنيني ${n} عن ${bike?'فحص للدراجة':'الفحص في الورشة'}؟`,
};
export function mixedParaphraseQuestion(b:typeof mixedBusinesses[number],language:ServiceQuestionLanguage){
 return `${directServiceQuestions[language](b.service.name)[2]} ${replacementParaphrase[language](b.service.name,b.id===99)} ${documentaryRequest[language](b.subject)}`;
}
export function independentMixedQuestion(b:typeof mixedBusinesses[number],language:ServiceQuestionLanguage){
 return `${directServiceQuestions[language](b.service.name)[2]} ${documentaryRequest[language](b.subject)}`;
}
