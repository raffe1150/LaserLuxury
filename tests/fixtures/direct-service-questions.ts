export const serviceQuestionLanguages=['en','sv','de','es','fa','ar'] as const;
export type ServiceQuestionLanguage=typeof serviceQuestionLanguages[number];
export const directServiceQuestions:Record<ServiceQuestionLanguage,(name:string)=>[string,string,string]>={
 en:n=>[`What is the configured price of ${n}?`,`How long does ${n} last?`,`What is the configured price of ${n}, and how long does it last?`],
 sv:n=>[`Vad kostar ${n}?`,`Hur lång tid tar ${n}?`,`Vad kostar ${n} och hur lång tid tar den?`],
 de:n=>[`Was kostet ${n}?`,`Wie lange dauert ${n}?`,`Was kostet ${n} und wie lange dauert sie?`],
 es:n=>[`¿Cuánto cuesta ${n}?`,`¿Cuánto dura ${n}?`,`¿Cuánto cuesta ${n} y cuánto dura?`],
 fa:n=>[`قیمت ${n} چقدر است؟`,`مدت ${n} چقدر است؟`,`قیمت ${n} چقدر است و مدت آن چقدر است؟`],
 ar:n=>[`ما سعر ${n}؟`,`كم تستغرق ${n}؟`,`ما سعر ${n} وما مدتها؟`],
};
export const serviceFactText:Record<ServiceQuestionLanguage,(n:string,p:number,c:string,d:number,attribute:number)=>string>={
 en:(n,p,c,d,a)=>a===0?`${n} costs ${p} ${c}.`:a===1?`${n} lasts ${d} minutes.`:`${n} costs ${p} ${c} and lasts ${d} minutes.`,
 sv:(n,p,c,d,a)=>a===0?`${n} kostar ${p} ${c}.`:a===1?`${n} tar ${d} minuter.`:`${n} kostar ${p} ${c} och tar ${d} minuter.`,
 de:(n,p,c,d,a)=>a===0?`${n} kostet ${p} ${c}.`:a===1?`${n} dauert ${d} Minuten.`:`${n} kostet ${p} ${c} und dauert ${d} Minuten.`,
 es:(n,p,c,d,a)=>a===0?`${n} cuesta ${p} ${c}.`:a===1?`${n} dura ${d} minutos.`:`${n} cuesta ${p} ${c} y dura ${d} minutos.`,
 fa:(n,p,c,d,a)=>a===0?`قیمت ${n} برابر با ${p} ${c} است.`:a===1?`مدت ${n} برابر با ${d} دقیقه است.`:`قیمت ${n} برابر با ${p} ${c} و مدت آن ${d} دقیقه است.`,
 ar:(n,p,c,d,a)=>a===0?`سعر ${n} هو ${p} ${c}.`:a===1?`مدة ${n} هي ${d} دقيقة.`:`سعر ${n} هو ${p} ${c} ومدته ${d} دقيقة.`,
};
