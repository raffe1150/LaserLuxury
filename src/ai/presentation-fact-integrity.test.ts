import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDeterministicBookingConfirmation as confirmation, renderDeterministicAvailabilityReply as availability } from './deterministic-booking-presentation';
const fixtures = [
  { language: 'de', name: 'Nadira', service: 'Beratung', date: '14. September', time: '14:00' },
  { language: 'es', name: 'Dante Rossi', service: 'Consulta', date: '14 septiembre', time: '14:00' },
  { language: 'en', name: 'Alex Example', service: 'Here’s Wellness', date: '14 September', time: '14:00' },
];
for (const { language, ...facts } of fixtures) for (const responseLength of ['short','balanced','detailed']) test(`${language}/${responseLength}: tone cannot rewrite supplied facts`, () => {
  for (const tonePreset of ['professional','warm','casual']) for (const formality of ['formal','balanced','casual']) {
    const tone = { tonePreset, formality, responseLength, emojiUsage:'none' };
    const result=confirmation(language,facts,tone);
    for (const fact of Object.values(facts)) assert.ok(result.includes(fact), `${tonePreset}/${formality} changed ${fact}: ${result}`);
    const slots=`${facts.name}: ${facts.date} ${facts.time}`;
    assert.ok(availability(language,{kind:'found',slots},tone).includes(slots));
  }
});
test('fact substitution preserves literal replacement characters and delimiters', () => {
  const facts={name:'Nadira $&',service:'\uE0000\uE001 Beratung',date:'14 September',time:'14:00'};
  const result=confirmation('de',facts,{tonePreset:'warm',formality:'formal'});
  for(const value of Object.values(facts)) assert.ok(result.includes(value));
});
