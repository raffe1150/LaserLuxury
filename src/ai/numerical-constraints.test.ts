import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numericalConstraintSafe } from './numerical-constraints';
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
test('configured free-cancellation window overrides conflicting notice prose without inventing a hard cutoff or binding service facts',()=>{
 const config=JSON.stringify({cancellation:{available:true,automaticCancellationEnabled:true,freeCancellationDeadlineMinutes:120,lateFeeEnabled:true,hardCancellationCutoffMinutes:null}});
 assert.equal(numericalConstraintSafe(minimum.en,minimum.en,[source],config),false);
 const good='Free cancellation is available at least 2 hours before the visit.';
 assert.equal(numericalConstraintSafe(good,good,['Free cancellation is available no later than 2 hours before the visit.'],config),true);
 assert.equal(numericalConstraintSafe('Service lasts 45 minutes.','Service lasts 45 minutes.',['"durationMinutes":45'],config),true);
});
test('identical bare cancellation numbers cannot make an incomplete deadline authoritative',()=>{
 for(const text of ['Cancel 91 before the visit.','Cancel ninety-one hours before the visit.','Cancellation requires 91 hours.'])assert.equal(numericalConstraintSafe(text,text,[text]),false);
});
test('a gate identifier near before wording is not a numerical deadline',()=>{
 const text='Check BJORK-915 before the appointment.';assert.equal(numericalConstraintSafe(text,text,[text]),true);
});
