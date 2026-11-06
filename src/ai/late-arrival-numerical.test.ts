import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {numericalConstraintSafe as safe} from './numerical-constraints';
const audited=JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json',import.meta.url),'utf8'));
const pdf=audited.sources.find((s:any)=>s.title.endsWith('.pdf')).content;
const threshold=pdf.match(/Vid en försening[^]+?enligt plan\./u)![0];
const cancellation=pdf.match(/Detta innebär[^]+?bedöma situationen\./u)![0];
const variants=[
 ['sv','Vid mer än 15 minuter försening kan personalen behöva bedöma besöket.'],
 ['en','With more than 15 minutes of delay staff may need to assess the visit.'],
 ['de','Bei mehr als 15 Minuten Verspätung kann das Personal den Besuch neu beurteilen.'],
 ['es','Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.'],
 ['fa','با بیش از ۱۵ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.'],
 ['ar','عند التأخر أكثر من ١٥ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.'],
] as const;
for(const [language,text]of variants){
 test(`${language}: exact strict 15-minute threshold is retained`,()=>assert.equal(safe(text,text,[threshold]),true));
 const wrong=text.replace('15','16').replace('۱۵','۱۶').replace('١٥','١٦');
 test(`${language}: invented strict 16-minute threshold is vetoed`,()=>assert.equal(safe(wrong,wrong,[threshold]),false));
}
test('a customer delay of 20 minutes is not source authority for a 20-minute threshold',()=>{
 const claim='Con más de 20 minutos de retraso el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(claim,claim,[threshold]),false);
});
test('inclusive 15 minutes cannot replace strictly more than 15 minutes',()=>{
 const claim='Con al menos 15 minutos de retraso el estudio puede necesitar evaluar la visita.';
 assert.equal(safe(claim,claim,[threshold]),false);
});
test('a plain no-automatic-cancellation claim remains subject to independent semantic verification',()=>{
 const claim='La cita no se cancela automáticamente; el personal debe evaluar primero la situación.';
 assert.equal(safe(claim,claim,[cancellation]),true);
 // This numeric gate alone cannot decide cancellation meaning or staff modality.
 const unsupported='La cita se cancela automáticamente.';
 assert.equal(safe(unsupported,unsupported,[cancellation]),true);
});
test('the numerical gate has no customer-premise input and cannot license contextual numbers',()=>{
 const claim='Si llegas 20 minutos tarde, la cita no se cancela automáticamente.';
 assert.equal(safe(claim,claim,[threshold,cancellation]),false);
});
test('strict upper bounds preserve value and strictness without confusing negated inclusive wording',()=>{
 for(const claim of ['Less than 15 minutes.','Menos de 15 minutos.','Weniger als 15 Minuten.','Mindre än 15 minuter.','کمتر از ۱۵ دقیقه.','أقل من ١٥ دقيقة.'])
  assert.equal(safe(claim,claim,['Less than 15 minutes.']),true);
 assert.equal(safe('At most 15 minutes.','At most 15 minutes.',['Less than 15 minutes.']),false);
 assert.equal(safe('Not more than 15 minutes.','Not more than 15 minutes.',['At most 15 minutes.']),true);
});
