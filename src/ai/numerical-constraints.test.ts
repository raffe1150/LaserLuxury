import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numericalConstraintSafe } from './numerical-constraints';

test('whole-source citations do not impose an unrelated arrival time on a location fact', () => {
 const source = 'First-time visitors should arrive 10 minutes before the appointment. Use gate Aurora 7. The elevator is on the right.';
 for (const text of ['Use gate Aurora 7.', 'The elevator is on the right.'])
  assert.equal(numericalConstraintSafe(text, text, [source], undefined, 'whole_source'), true);
 // The old quotation contract remains strict when extraction drops its bound.
 assert.equal(numericalConstraintSafe('Cancel your appointment.', 'Cancel your appointment.', ['Cancel at least 91 hours before the visit.']), false);
});
for (const text of ['Normally up to 21 days.', 'Normalt upp till 21 dagar.', 'Normalerweise bis zu 21 Tage.', 'Normalmente hasta 21 días.', 'معمولاً تا ۲۱ روز.', 'عادةً حتى ٢١ يوم.'])
 test(`literal retention upper bound is preserved: ${text}`, () => {
  assert.equal(numericalConstraintSafe(text, text, ['Kvarglömda föremål förvaras normalt i upp till 21 dagar. First-time visitors arrive 10 minutes before the visit.'], undefined, 'whole_source'), true);
 });
for (const text of ['At least 21 days.', 'Exactly 21 days.', '21 days.', 'Up to 22 days.', 'Up to 21 hours.'])
 test(`whole-source citation cannot change the retention limit: ${text}`, () =>
  assert.equal(numericalConstraintSafe(text, text, ['Normally up to 21 days. First-time visitors arrive 10 minutes before the visit.'], undefined, 'whole_source'), false));
const source = 'För Synthetic Birch Studio ska en bokad tid avbokas senast 91 timmar före besöket.';
const minimum: Record<string,string> = {
 sv: 'Avboka minst 91 timmar före besöket.', en: 'Cancel at least 91 hours before the visit.',
 de: 'Mindestens 91 Stunden vor dem Termin absagen.', es: 'Cancelar al menos 91 horas antes de la cita.',
 fa: 'نوبت باید حداقل ۹۱ ساعت پیش از زمان مراجعه لغو شود.', ar: 'يجب إلغاء الموعد على الأقل ٩١ ساعة قبل الزيارة.',
};
const maximum: Record<string,string> = {
 sv: 'Avboka högst 91 timmar före besöket.', en: 'Cancel at most 91 hours before the visit.',
 de: 'Höchstens 91 Stunden vor dem Termin absagen.', es: 'Cancelar como máximo 91 horas antes de la cita.',
 fa: 'نوبت باید حداکثر ۹۱ ساعت پیش از زمان مراجعه لغو شود.', ar: 'يجب إلغاء الموعد على الأكثر ٩١ ساعة قبل الزيارة.',
};
for (const language of Object.keys(minimum)) {
 test(`${language}: minimum before is preserved across Swedish evidence`, () => {
  assert.equal(numericalConstraintSafe(minimum[language],minimum[language],[source]),true);
 });
 test(`${language}: maximum before contradicts minimum notice despite same 91`, () => {
  assert.equal(numericalConstraintSafe(maximum[language],maximum[language],[source]),false);
 });
 test(`${language}: maximum policies stay maximum, not minimum`, () => {
  assert.equal(numericalConstraintSafe(maximum[language],maximum[language],[maximum.en]),true);
  assert.equal(numericalConstraintSafe(minimum[language],minimum[language],[maximum.en]),false);
 });
}
for (const text of [
 'Cancel no later than 91 hours before the visit.', 'Avboka senast 91 timmar före besöket.',
 'Spätestens 91 Stunden vor dem Termin absagen.', 'Cancelar a más tardar 91 horas antes de la cita.',
 'لغو نوبت نه دیرتر از ۹۱ ساعت پیش از مراجعه است.', 'إلغاء الموعد في موعد أقصاه ٩١ ساعة قبل الزيارة.',
]) test(`latest before means minimum notice: ${text}`,()=>assert.equal(numericalConstraintSafe(text,text,[source]),true));
for (const text of [
 'Cancel no earlier than 91 hours before the visit.', 'Avboka tidigast 91 timmar före besöket.',
 'Frühestens 91 Stunden vor dem Termin absagen.', 'Cancelar no antes de 91 horas antes de la cita.',
 'لغو نوبت نه زودتر از ۹۱ ساعت پیش از مراجعه است.', 'إلغاء الموعد ليس قبل ٩١ ساعة قبل الزيارة.',
]) test(`earliest before means maximum notice: ${text}`,()=>assert.equal(numericalConstraintSafe(text,text,[maximum.en]),true));
for (const [name, quote, claim, evidence] of [
 ['opposite temporal anchor','Cancel at least 91 hours after the visit.',minimum.en,source],
 ['claim hides incorrect published qualifier',maximum.fa,minimum.fa,source],
 ['same number alone is insufficient','Cancel 91 hours before the visit.','Cancel 91 hours before the visit.',source],
 ['ambiguous evidence',minimum.en,minimum.en,'Cancel 91 hours before the visit.'],
 ['conflicting equal-value evidence',minimum.en,minimum.en,source+' Cancel at most 91 hours before the visit.'],
 ['different value',minimum.en.replace('91','92'),minimum.en.replace('91','92'),source],
 ['negated requirement','Do not cancel at least 91 hours before the visit.',minimum.en,source],
 ['two quantities in one clause','Cancel at least 91 or 92 hours before the visit.',minimum.en,source],
 ['unknown unit', 'Cancel at least 91 fortnights before the visit.',minimum.en,source],
 ['unsupported comparison', 'Cancel > 91 hours before the visit.',minimum.en,source],
] as const) test(`fails closed: ${name}`,()=>assert.equal(numericalConstraintSafe(quote,claim,[evidence]),false));
test('latest after means a maximum delay, before/after never interchangeable',()=>{
 const text='Submit no later than 91 hours after the visit.';
 assert.equal(numericalConstraintSafe(text,'Submit at most 91 hours after the visit.',[text]),true);
 assert.equal(numericalConstraintSafe(text,maximum.en,[text]),false);
});
test('ordinary supported service duration and gate marker still require ordinary verifier',()=>{
 assert.equal(numericalConstraintSafe('Introduktionsbesök lasts 45 minutes.','Introduktionsbesök lasts 45 minutes.',['"durationMinutes":45']),true);
 assert.equal(numericalConstraintSafe('The gate is BJORK-915.','The gate is BJORK-915.',['Parkeringsgrindens märkning är BJORK-915.']),true);
});
for(const [language,text] of Object.entries({sv:'Minst 91 timmar efter besöket.',en:'At least 91 hours after the visit.',de:'Mindestens 91 Stunden nach dem Termin.',es:'Al menos 91 horas después de la cita.',fa:'حداقل ۹۱ ساعت پس از مراجعه.',ar:'على الأقل ٩١ ساعة بعد الزيارة.'}))test(`${language}: after stays after and contradicts before`,()=>{
 assert.equal(numericalConstraintSafe(text,text,['At least 91 hours after the visit.']),true);
 assert.equal(numericalConstraintSafe(text,text,[source]),false);
});
test('unit conversion preserves the same minimum constraint without changing the number in a reply',()=>{
 const text='Cancel at least 5460 minutes before the visit.';assert.equal(numericalConstraintSafe(text,text,[source]),true);
});
test('unknown comparative grammar or word-only quantities fail closed',()=>{
 for(const text of ['Cancel minimum ninety-one hours before the visit.','Cancel at least 91 business days before the visit.'])assert.equal(numericalConstraintSafe(text,text,[source]),false);
});
for(const text of ['Cancellation requires 91 hours notice before the visit.','Avbokning kräver 91 timmar förvarning före besöket.','Absagen erfordert 91 Stunden Vorlauf vor dem Termin.','Cancelar requiere 91 horas de aviso antes de la cita.','لغو نوبت به اطلاع ۹۱ ساعت قبل نیاز دارد.','إلغاء الموعد يتطلب إشعار ٩١ ساعة قبل الزيارة.'])test(`literal advance-notice requirement retains minimum: ${text}`,()=>assert.equal(numericalConstraintSafe(text,text,[source]),true));
test('typed free-cancellation window retains minimum before; neither hard notice nor document JSON inherits it',()=>{
 const structured={source:'structured_business_config',quote:'"freeCancellationDeadlineMinutes": 5460'};
 const free='Free cancellation is available at least 91 hours before the visit.';
 assert.equal(numericalConstraintSafe(free,free,[structured]),true);
 assert.equal(numericalConstraintSafe(minimum.en,minimum.en,[structured]),false);
 assert.equal(numericalConstraintSafe(maximum.fa,maximum.fa,[structured]),false);
 assert.equal(numericalConstraintSafe(free,free,[{...structured,source:'retrieved_knowledge'}]),false);
});
test('an exact notice interval or negated notice requirement cannot be rescued as minimum',()=>{
 for(const text of ['Cancellation requires exactly 91 hours notice before the visit.','Cancellation does not require 91 hours notice before the visit.'])assert.equal(numericalConstraintSafe(text,text,[source]),false);
});
test('configured free window does not contradict independently documented notice or establish a hard cutoff',()=>{
 const config=JSON.stringify({cancellation:{available:true,automaticCancellationEnabled:true,freeCancellationDeadlineMinutes:120,lateFeeEnabled:true,hardCancellationCutoffMinutes:null}});
 assert.equal(numericalConstraintSafe(minimum.en,minimum.en,[source],config),true);
 assert.equal(numericalConstraintSafe(minimum.en,minimum.en,[{source:'structured_business_config',quote:'"freeCancellationDeadlineMinutes":120'}],config),false);
 const good='Free cancellation is available at least 2 hours before the visit.';
 assert.equal(numericalConstraintSafe(good,good,['Free cancellation is available no later than 2 hours before the visit.'],config),true);
 assert.equal(numericalConstraintSafe('Service lasts 45 minutes.','Service lasts 45 minutes.',['"durationMinutes":45'],config),true);
});

test('documentary free windows cannot establish mandatory notice even with equal values, bounds and direction',()=>{
 const free='Free cancellation is available at least 2 hours before the visit.';
 const hard='Cancel at least 2 hours before the visit.';
 for(const config of [undefined, JSON.stringify({cancellation:{available:true,lateFeeEnabled:true,freeCancellationDeadlineMinutes:120,hardCancellationCutoffMinutes:null}})]) {
  assert.equal(numericalConstraintSafe(hard,hard,[free],config),false);
  assert.equal(numericalConstraintSafe(free,free,[hard],config),false);
  assert.equal(numericalConstraintSafe(free,hard,[free],config),false);
  assert.equal(numericalConstraintSafe(hard,free,[free],config),false);
 }
 // Attribute binding is per clause, including in whole-source citations.
 const combined='Cancel at least 91 hours before the visit. '+free;
 assert.equal(numericalConstraintSafe(minimum.en,minimum.en,[combined],undefined,'whole_source'),true);
 assert.equal(numericalConstraintSafe(hard,hard,[combined],undefined,'whole_source'),false);
});
test('identical bare cancellation numbers cannot make an incomplete deadline authoritative',()=>{
 for(const text of ['Cancel 91 before the visit.','Cancel ninety-one hours before the visit.','Cancellation requires 91 hours.'])assert.equal(numericalConstraintSafe(text,text,[text]),false);
});
test('a gate identifier near before wording is not a numerical deadline',()=>{
 const text='Check BJORK-915 before the appointment.';assert.equal(numericalConstraintSafe(text,text,[text]),true);
});

const spatialSource='Besökare ska använda porten märkt   Aurora 7   och därefter följa de blå skyltarna till receptionen på andra våningen.';
for (const text of [
 'Usa la puerta marcada Aurora 7 y sigue las señales azules hasta la recepción en la segunda planta.',
 'از درِ دارای نشان Aurora 7 وارد شوید و تابلوهای آبی را تا پذیرش در طبقه دوم دنبال کنید.',
 'Camina hasta la salida.', 'Siga hasta el ascensor.', 'Continúa hasta la oficina.',
 'تا اتاق بروید.', 'تا راهرو ادامه دهید.',
]) test(`spatial destination is not a numerical upper bound: ${text}`,()=>{
 assert.equal(numericalConstraintSafe(text,text,[spatialSource]),true,'Only numerical admissibility; factual support requires the independent verifier');
});
for(const text of [
 'Normalmente hasta 21 días.', 'معمولاً تا ۲۱ روز.',
 'Camina hasta 21 días antes de la cita.', 'تا ۲۱ روز قبل از نوبت بروید.',
 'Camina hasta noventa fortnights antes de la cita.', 'تا بیست هفته قبل از نوبت بروید.',
 'Camina hasta la recepción y cancela hasta 21 días antes de la cita.',
 'تا پذیرش بروید و نوبت را تا ۲۱ روز قبل لغو کنید.',
 'Camina durante 21 fortnights hasta la recepción.', 'تا پذیرش به مدت ۲۱ هفته بروید.',
 'Camina hasta la recepción si debes cancelar.', 'اگر باید لغو کنید تا پذیرش بروید.',
 'Hasta la recepción.', 'تا پذیرش.',
]) test(`spatial vocabulary cannot exempt an ambiguous numerical/policy proposal: ${text}`,()=>{
 assert.equal(numericalConstraintSafe(text,text,[spatialSource]),false);
});
for(const [valid,changed] of [
 ['Normalmente hasta 21 días.','Normalmente al menos 21 días.'],
 ['معمولاً تا ۲۱ روز.','معمولاً حداقل ۲۱ روز.'],
 ['Cancelar al menos 21 horas antes de la cita.','Cancelar al menos 21 horas después de la cita.'],
 ['لغو حداقل ۲۱ ساعت قبل از نوبت.','لغو حداکثر ۲۱ ساعت قبل از نوبت.'],
] as const) test(`genuine numerical direction remains strict: ${valid}`,()=>{
 assert.equal(numericalConstraintSafe(valid,valid,[valid]),true);
 assert.equal(numericalConstraintSafe(changed,changed,[valid]),false);
});
test('a spatial clause cannot hide a separate unsupported or negated temporal claim',()=>{
 for(const suffix of [' Cancel at most 21 hours before the visit.',' Cancel at least 21 hours after the visit.',' Do not cancel at least 21 hours before the visit.',
  ' No cancelar al menos 21 horas antes de la cita.',' لغو نباید حداقل ۲۱ ساعت قبل از نوبت باشد.']){
  const route='Camina hasta la recepción.';
  assert.equal(numericalConstraintSafe(route+suffix,route+suffix,[spatialSource,'Cancel at least 21 hours before the visit.']),false);
 }
});

test('Persian arrival recommendation preserves relative time and a trailing purpose clause', () => {
  const source = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
  const text = 'به مشتریانی که برای نخستین بار به AdMotion Studio مراجعه می‌کنند توصیه می‌شود حدود 10 دقیقه زودتر از زمان رزروشده حاضر شوند تا فرصت آماده‌شدن با آرامش را داشته باشند.';
  const safe = (claim: string) => numericalConstraintSafe(claim, claim, [source]);
  assert.equal(safe(text), true);
  for (const changed of [
    text.replace('10', '11'),
    text.replace('حدود', 'حداقل'),
    text.replace('حدود', 'تا'),
    text.replace('زودتر از', 'دیرتر از'),
    text.replace('زودتر از زمان رزروشده', ''),
  ]) assert.equal(safe(changed), false, changed);
});
