import assert from 'node:assert/strict';
import test from 'node:test';
import { detectExplicitLanguageSwitch } from './channel-reliability';
const incidental = ['Meine Freundin lernt Svenska an der Universität.', 'دوست من در دانشگاه English یاد می‌گیرد.', 'صديقي يدرس Deutsch في الجامعة.', 'Mi amiga estudia Persian en la universidad.', 'My friend studies Arabic at university.', 'Min vän studerar Español på universitetet.'];
for (const input of incidental) test(`language mention is not a switch: ${input}`, () => assert.equal(detectExplicitLanguageSwitch(input), null));
for (const [input, expected] of [
  ['Bitte antworten Sie auf Deutsch.', 'de'], ['لطفاً به فارسی پاسخ دهید.', 'fa'], ['من فضلك تحدث بالعربية.', 'ar'], ['Por favor responde en español.', 'es'], ['Please reply in English.', 'en'], ['Svara på svenska tack.', 'sv'],
  ['bitte deutsch', 'de'], ['English please', 'en'], ['فارسی صحبت کنیم', 'fa'], ['Deutsch', 'de'], ['فارسی', 'fa'], ['العربية', 'ar'], ['Español', 'es'], ['English', 'en'], ['Svenska', 'sv'],
  ['لطفاً به فارسی با من صحبت کنید', 'fa'], ['تحدث العربية', 'ar'], ['فارسیزبان', null], ['العربيةabc', null],
] as const) test(`explicit request or token boundary: ${input}`, () => assert.equal(detectExplicitLanguageSwitch(input), expected));
