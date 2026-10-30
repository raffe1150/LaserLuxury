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

const compoundRequests=[
 ['en','Please reply in English from now on'],
 ['de','Bitte antworten Sie ab jetzt auf Deutsch'],
 ['sv','Snälla svara på svenska'],
 ['es','Por favor responde en español'],
 ['fa','لطفاً از این به بعد به فارسی پاسخ بده'],
 ['ar','من فضلك أجب باللغة العربية'],
] as const;
for(const [language,request]of compoundRequests){
 for(const text of [`${request}. I need help.`,`I need help; ${request}; I have a question.`,`I want to continue, but ${request}.`,`I want to continue but ${request}.`])
  test(`clause-local communication target ${language}: ${text}`,()=>assert.equal(detectExplicitLanguageSwitch(text),language));
 for(const quote of [`"${request}"`,`“${request}”`,`«${request}»`,`'${request}'`,`\`${request}\``,`\`\`\`\n${request}\n\`\`\``])
  test(`quoted language request is data ${language}: ${quote}`,()=>assert.equal(detectExplicitLanguageSwitch(`What does ${quote} mean?`),null));
}
for(const text of ['Can you speak German?','Please reply about German grammar.','What languages do you speak?','What does this instruction mean: please reply in German?','My friend studies German, English.','Please do not reply in German.','Do you translate from German to English?','Please reply in German; please reply in Spanish.'])
 test(`not a unique language-switch instruction: ${text}`,()=>assert.equal(detectExplicitLanguageSwitch(text),null));
test('quoted target cannot override the actual unquoted target',()=>assert.equal(detectExplicitLanguageSwitch('The note says "Please reply in German"; please reply in Spanish.'),'es'));
for(const text of ['Can you speak English?','Sprichst du Deutsch?','Talar du svenska?','¿Hablas español?','آیا به فارسی صحبت می‌کنی؟','هل تتحدث العربية؟','Please reply not in English.','Bitte antworten Sie nicht auf Deutsch.','Svara inte på svenska.','Por favor no respondas en español.','لطفاً به فارسی پاسخ نده.','لا تجب باللغة العربية.'])
 test(`capability or negated communication is not a switch: ${text}`,()=>assert.equal(detectExplicitLanguageSwitch(text),null));
