import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectGrammaticalLatinLanguage, germanSwedishDuEvidence, germanSwedishFunctionWordBalance,
  hasSharedGermanSwedishLexeme, resolveSharedGermanSwedishLexeme, scoreGrammaticalLatinLanguage, unicodeWordPattern,
} from './latin-language-markers';

test('Unicode word boundaries match markers that start or end with non-ASCII letters', () => {
  // ASCII \b fails at a non-ASCII word edge (är…, …å, …é); interior letters (några) were never affected.
  assert.equal(/\b(är ledig)\b/i.test('Tiden är ledig.'), false, 'ASCII \\b baseline');
  assert.equal(/\b(hallå)\b/i.test('Hallå!'), false, 'ASCII \\b baseline');
  assert.equal(/\b(qué)\b/u.test('¿qué día?'), false, 'ASCII \\b baseline');
  assert.equal(unicodeWordPattern(/\b(är ledig)\b/i).test('Tiden är ledig.'), true);
  assert.equal(unicodeWordPattern(/\b(hallå)\b/i).test('Hallå!'), true);
  assert.equal(unicodeWordPattern(/\b(qué)\b/u).test('¿qué día?'), true);
  assert.equal(unicodeWordPattern(/\b(några)\b/u).test('vi behöver några uppgifter'), true);
  assert.equal(unicodeWordPattern(/\b(ändra min tid)\b/i).test('Jag vill ändra min tid'), true);
});

test('Unicode word boundaries no longer match ASCII fragments glued to non-ASCII letters', () => {
  assert.equal(/\b(kl)\b/.test('klärung'), true, 'ASCII \\b baseline');
  assert.equal(unicodeWordPattern(/\b(kl)\b/).test('klärung'), false);
  assert.equal(unicodeWordPattern(/\b(che)\b/).test('gespräche'), false);
  assert.equal(unicodeWordPattern(/\b(consultation)\b/i).test('وConsultation'), false);
  assert.equal(unicodeWordPattern(/\b(kl)\b/).test('kl 14:00'), true);
});

test('unicodeWordPattern keeps character classes, flags and repeated global use intact', () => {
  const pattern = unicodeWordPattern(/\b([\b]?du)\b/g);
  assert.ok(pattern.flags.includes('u') && pattern.flags.includes('g'));
  assert.equal('du kan, du vill'.match(pattern)?.length, 2);
  assert.equal(unicodeWordPattern(/\bdu\b/g).test('du'), true);
  assert.equal(unicodeWordPattern(/\bdu\b/g).test('du'), true, 'lastIndex is reset between uses');
});

test('"du" is attributed from its grammatical neighbours', () => {
  assert.deepEqual(germanSwedishDuEvidence('Wenn du möchtest, kannst du die Buchung ändern.'), { sv: 0, de: 2, attribution: 'de' });
  assert.deepEqual(germanSwedishDuEvidence('Om du vill kan du boka en konsultation.'), { sv: 2, de: 0, attribution: 'sv' });
  assert.deepEqual(germanSwedishDuEvidence('Weißt du schon, wann du kommen willst?'), { sv: 0, de: 2, attribution: 'de' });
  // Unframed occurrences keep the previous Swedish attribution without German context.
  assert.deepEqual(germanSwedishDuEvidence('Är du sen ringer du oss.'), { sv: 2, de: 0, attribution: 'sv' });
  // Swedish -st words next to "du" are not German verbs; Swedish neighbours win.
  assert.equal(germanSwedishDuEvidence('Senast du bokade var i mars.').attribution, 'sv');
  assert.equal(germanSwedishDuEvidence('Är du gäst hos oss, du är välkommen.').attribution, 'sv');
  assert.equal(germanSwedishDuEvidence('Just du får gärna komma.').attribution, 'sv');
  // German possessives/object pronouns make unframed "du" German.
  assert.equal(germanSwedishDuEvidence('Du und deine Familie.').attribution, 'de');
  assert.equal(germanSwedishDuEvidence('Booking confirmed.').attribution, 'none');
});

const swedishDu = [
  'Är du gäst hos oss, du är välkommen.', 'Senast du bokade var i mars, du kan boka igen.',
  'Just du får gärna komma, du behöver inte vänta.', 'Du som gäst får parkera gratis, du ringer oss vid frågor.',
  'Hur mår du? Du ser glad ut.', 'Du har bokat en tid, du får ett sms.', 'Om du vill, kan du ta med en vän.',
  'Tack, du är bäst! Du är alltid välkommen.', 'Var du nöjd med besöket? Du får gärna lämna ett omdöme.',
  'Fast du kom sent fick du din behandling.',
];
const germanDu = [
  'Wenn du möchtest, kannst du die Buchung ändern.', 'Hast du Zeit? Du kannst gerne vorbeikommen.',
  'Weißt du schon, wann du kommen willst?', 'Du bist willkommen, du musst nichts mitbringen.',
  'Kannst du mir deine Nummer schicken? Dann kannst du buchen.', 'Du findest uns direkt am Bahnhof, du brauchst kein Auto.',
  'Falls du später kommst, sag uns Bescheid, damit du deinen Termin behältst.', 'Bist du sicher, dass du absagen willst?',
];
for (const text of swedishDu) test(`grammatical detector keeps Swedish du-text Swedish: ${text}`, () =>
  assert.equal(detectGrammaticalLatinLanguage(text), 'sv'));
for (const text of germanDu) test(`grammatical detector reads informal German du-text as German: ${text}`, () =>
  assert.equal(detectGrammaticalLatinLanguage(text), 'de'));

test('grammatical detector still separates the four Latin-script languages', () => {
  assert.equal(detectGrammaticalLatinLanguage('Jag vill boka en tid'), 'sv');
  assert.equal(detectGrammaticalLatinLanguage('Ich möchte einen Termin'), 'de');
  assert.equal(detectGrammaticalLatinLanguage('Quiero una cita para el lunes'), 'es');
  assert.equal(detectGrammaticalLatinLanguage('I want to book an appointment'), 'en');
  assert.equal(detectGrammaticalLatinLanguage('¿Qué horas tienen disponibles?'), 'es');
  assert.equal(detectGrammaticalLatinLanguage('Man mikham vaght begiram'), null);
  assert.equal(detectGrammaticalLatinLanguage(''), null);
  assert.deepEqual(scoreGrammaticalLatinLanguage(''), { sv: 0, de: 0, es: 0, en: 0 });
});

test('shared lexeme "Konsultation" is attributed by exclusive German/Swedish function words', () => {
  assert.equal(hasSharedGermanSwedishLexeme('Die Konsultation dauert 30 Minuten.'), true);
  assert.equal(hasSharedGermanSwedishLexeme('Konsultationen tar 30 minuter.'), false);
  assert.equal(resolveSharedGermanSwedishLexeme('Die Konsultation dauert 30 Minuten.'), 'de');
  assert.equal(resolveSharedGermanSwedishLexeme('Können Sie die Konsultation verschieben?'), 'de');
  assert.equal(resolveSharedGermanSwedishLexeme('Du kannst die Konsultation verschieben.'), 'de');
  assert.equal(resolveSharedGermanSwedishLexeme('Konsultation tar 30 minuter.'), 'sv');
  assert.equal(resolveSharedGermanSwedishLexeme('Vad kostar en konsultation?'), 'sv');
  // No German/Swedish grammar: unchanged Swedish default (English words are not German evidence).
  assert.equal(resolveSharedGermanSwedishLexeme('Konsultation was mentioned in my reference.'), 'sv');
  assert.deepEqual(germanSwedishFunctionWordBalance('The consultation takes 30 minutes.'), { de: 0, sv: 0 });
});
