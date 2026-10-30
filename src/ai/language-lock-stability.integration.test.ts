import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "language-lock-regression",
  language: "sv",
  services: [],
};

function resolve(session: string, text: string) {
  return boundary.resolveConversationLanguage(session, text, businessConfig);
}

test("established conversations ignore one to three foreign words", () => {
  const cases = [
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", [
      "Hej, ich möchte mehr über die Dienstleistungen wissen.",
      "Hej tack, ich möchte mehr über die Dienstleistungen wissen.",
      "Hej tack hola, ich möchte mehr über die Dienstleistungen wissen.",
    ]],
    ["sv", "Hej, jag vill fortsätta på svenska.", [
      "Hello, jag vill veta mer om tjänsterna.",
      "Hello danke, jag vill veta mer om tjänsterna.",
      "Hello danke hola, jag vill veta mer om tjänsterna.",
    ]],
    ["en", "Hello, I want to continue in English.", [
      "Hej, I want to know more about the services.",
      "Hej tack, I want to know more about the services.",
      "Hej tack hola, I want to know more about the services.",
    ]],
    ["es", "Hola, quiero continuar en español.", [
      "Hello, quiero saber más sobre los servicios.",
      "Hello danke, quiero saber más sobre los servicios.",
      "Hello danke hej, quiero saber más sobre los servicios.",
    ]],
  ] as const;

  for (const [base, start, messages] of cases) {
    const session = `foreign-words-${base}`;
    resolve(session, start);

    for (const message of messages) {
      assert.equal(
        resolve(session, message),
        base,
        `${base} drifted on: ${message}`,
      );
    }
  }
});

test("explicit multilingual language-change requests override the lock", () => {
  const cases = [
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "sv", "Bitte antworten Sie ab jetzt auf Schwedisch."],
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "en", "Bitte antworten Sie ab jetzt auf Englisch."],
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "es", "Bitte antworten Sie ab jetzt auf Spanisch."],

    ["sv", "Hej, jag vill fortsätta på svenska.", "de", "Kan du svara på tyska från och med nu?"],
    ["sv", "Hej, jag vill fortsätta på svenska.", "en", "Kan du svara på engelska från och med nu?"],
    ["sv", "Hej, jag vill fortsätta på svenska.", "es", "Kan du svara på spanska från och med nu?"],

    ["en", "Hello, I want to continue in English.", "de", "Please reply in German from now on."],
    ["en", "Hello, I want to continue in English.", "sv", "Please reply in Swedish from now on."],
    ["en", "Hello, I want to continue in English.", "es", "Please reply in Spanish from now on."],

    ["es", "Hola, quiero continuar en español.", "de", "Por favor, responde en alemán a partir de ahora."],
    ["es", "Hola, quiero continuar en español.", "sv", "Por favor, responde en sueco a partir de ahora."],
    ["es", "Hola, quiero continuar en español.", "en", "Por favor, responde en inglés a partir de ahora."],

    ["fa", "سلام، می‌خواهم به فارسی ادامه بدهم.", "en", "لطفاً از این به بعد به انگلیسی پاسخ بده."],
    ["fa", "سلام، می‌خواهم به فارسی ادامه بدهم.", "de", "لطفاً از این به بعد به آلمانی پاسخ بده."],
    ["fa", "سلام، می‌خواهم به فارسی ادامه بدهم.", "sv", "لطفاً از این به بعد به سوئدی پاسخ بده."],

    ["ar", "مرحبا، أريد أن أستمر باللغة العربية.", "en", "من فضلك أجب باللغة الإنجليزية من الآن."],
    ["ar", "مرحبا، أريد أن أستمر باللغة العربية.", "de", "من فضلك أجب باللغة الألمانية من الآن."],
    ["ar", "مرحبا، أريد أن أستمر باللغة العربية.", "sv", "من فضلك أجب باللغة السويدية من الآن."],
  ] as const;

  cases.forEach(([base, start, expected, message], index) => {
    const session = `explicit-${index}`;
    resolve(session, start);
    assert.equal(resolve(session, message), expected, message);
  });
});

test("clear full messages can naturally change conversation language", () => {
  const cases = [
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "es", "Hola, quiero reservar una cita para mañana."],
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "en", "Hello, I want to book an appointment for tomorrow."],
    ["sv", "Hej, jag vill fortsätta på svenska.", "de", "Hallo, ich möchte einen Termin für morgen buchen."],
    ["sv", "Hej, jag vill fortsätta på svenska.", "en", "Hello, I would like to know what services you offer."],
    ["en", "Hello, I want to continue in English.", "sv", "Hej, jag vill boka en tid imorgon och veta vilka tjänster ni erbjuder."],
    ["en", "Hello, I want to continue in English.", "es", "Hola, quiero saber qué servicios ofrecen y reservar una cita."],
    ["es", "Hola, quiero continuar en español.", "de", "Hallo, ich möchte wissen, welche Dienstleistungen Sie anbieten."],
    ["es", "Hola, quiero continuar en español.", "sv", "Hej, jag vill veta vilka tjänster ni erbjuder och boka en tid."],
    ["fa", "سلام، می‌خواهم به فارسی ادامه بدهم.", "en", "Hello, I want to know what services you offer and book an appointment."],
    ["ar", "مرحبا، أريد أن أستمر باللغة العربية.", "en", "Hello, I want to know what services you offer and book an appointment."],
  ] as const;

  cases.forEach(([base, start, expected, message], index) => {
    const session = `natural-${index}`;
    resolve(session, start);
    assert.equal(resolve(session, message), expected, message);
  });
});

test("incidental foreign-language mentions do not overwrite six-language locks", () => {
  const cases = [
    ["de", "Hallo, ich möchte auf Deutsch weitersprechen.", "Hola, aber meine Frage bleibt auf Deutsch."],
    ["sv", "Hej, jag vill fortsätta på svenska.", "Hello danke, men fortsätt på svenska."],
    ["en", "Hello, I want to continue in English.", "Hola gracias, but keep speaking English."],
    ["es", "Hola, quiero continuar en español.", "Hej danke, pero continúa en español."],
    ["fa", "سلام، می‌خواهم به فارسی ادامه بدهم.", "hello hej ولی لطفاً فارسی ادامه بده"],
    ["ar", "مرحبا، أريد أن أستمر باللغة العربية.", "hello hej لكن أجبني بالعربية"],
  ] as const;

  cases.forEach(([base, start, message], index) => {
    const session = `six-language-lock-${index}`;
    resolve(session, start);
    assert.equal(resolve(session, message), base, message);
  });
});

test("established language survives ambiguous or falsely detected natural messages", () => {
  const cases = [
    [
      "es",
      "Hola, quiero continuar en español.",
      "No estoy muy seguro de qué me conviene. ¿Qué me recomendarías?",
    ],
    [
      "es",
      "Hola, quiero continuar en español.",
      "No sé cuál me conviene más.",
    ],
    [
      "es",
      "Hola, quiero continuar en español.",
      "¿Qué me recomiendas?",
    ],
    [
      "sv",
      "Hej, jag vill fortsätta på svenska.",
      "Jag är inte säker på vad som passar mig. Vad rekommenderar du?",
    ],
    [
      "de",
      "Hallo, ich möchte auf Deutsch weitersprechen.",
      "Ich bin mir nicht sicher, was zu mir passt. Was würden Sie empfehlen?",
    ],
    [
      "en",
      "Hello, I want to continue in English.",
      "I'm not sure what would suit me. What would you recommend?",
    ],
  ] as const;

  cases.forEach(([base, start, message], index) => {
    const session = `ambiguous-natural-${index}`;
    resolve(session, start);
    assert.equal(resolve(session, message), base, message);
  });
});

test("production regression: completed Persian state cannot resurrect after German switch and Passt", async () => {
  boundary.reset();

  const session = "telegram-fa-de-passt-regression";

  boundary.configure({
    semanticLanguageResolver: async (text: string) => {
      if (text.includes("آلمانی")) {
        return {
          language: "fa",
          requestedReplyLanguage: "de",
          confidence: 0.99,
        };
      }

      return null;
    },
  });

  boundary.rememberCompletedBookingForLanguageTest(
    session,
    "fa",
  );

  const switched = await boundary.prepareConversationLanguageForTest(
    session,
    "میشه از اینجا به بعد آلمانی صحبت کنیم؟",
    businessConfig,
  );

  assert.equal(switched, "de");

  const shortReply = await boundary.prepareConversationLanguageForTest(
    session,
    "Passt.",
    businessConfig,
  );

  assert.equal(
    shortReply,
    "de",
    "short acknowledgement must preserve the new German conversation language",
  );

  boundary.reset();
});

test("production regression: Persian address question must override stale Arabic state in the same turn", async () => {
  boundary.reset();

  boundary.configure({
    semanticLanguageResolver: async () => null,
  });

  const session = "stale-arabic-to-persian-address-regression";

  const arabic = await boundary.prepareConversationLanguageForTest(
    session,
    "أين عنوانكم؟",
    businessConfig,
  );

  assert.equal(
    arabic,
    "ar",
    "Arabic setup turn must establish Arabic as the previous conversation language",
  );

  const persian = await boundary.prepareConversationLanguageForTest(
    session,
    "سلام، آدرستون کجاست؟",
    businessConfig,
  );

  assert.equal(
    persian,
    "fa",
    "Persian-specific script evidence must override stale Arabic state in the same turn",
  );

  boundary.reset();
});

test("production regression: short Persian address question must resolve as Persian, not Arabic", async () => {
  boundary.reset();

  boundary.configure({
    semanticLanguageResolver: async (text: string) => {
      if (text === "آدرستون کجاست؟") {
        return {
          language: "fa",
          requestedReplyLanguage: null,
          confidence: 0.99,
        };
      }

      if (text === "أين عنوانكم؟") {
        return {
          language: "ar",
          requestedReplyLanguage: null,
          confidence: 0.99,
        };
      }

      return null;
    },
  });

  const persian = await boundary.prepareConversationLanguageForTest(
    "short-persian-address-regression",
    "آدرستون کجاست؟",
    businessConfig,
  );

  assert.equal(
    persian,
    "fa",
    "short meaningful Persian question must reach semantic resolution instead of defaulting to Arabic",
  );

  const arabic = await boundary.prepareConversationLanguageForTest(
    "short-arabic-address-control",
    "أين عنوانكم؟",
    businessConfig,
  );

  assert.equal(
    arabic,
    "ar",
    "Arabic control must remain Arabic",
  );

  boundary.reset();
});

const offlineLanguageBodies = [
  ['en','Hello, I want to continue in English.','I want to know more about the services.'],
  ['sv','Hej, jag vill fortsätta på svenska.','Jag vill veta mer om tjänsterna.'],
  ['de','Hallo, ich möchte auf Deutsch weitersprechen.','Ich möchte mehr über die Dienstleistungen wissen.'],
  ['es','Hola, quiero continuar en español.','Quiero saber qué servicios ofrecen.'],
  ['fa','سلام، می‌خواهم به فارسی ادامه بدهم.','برای اولین مراجعه چقدر زودتر باید برسم؟'],
  ['ar','مرحبا، أريد أن أستمر باللغة العربية.','أريد معرفة المزيد عن الخدمات التي تقدمونها.'],
] as const;
for(const [language,start,body] of offlineLanguageBodies)test(`offline mixed-message lock and natural switch: ${language}`,()=>{
  const session=`offline-prefix-lock-${language}`;
  assert.equal(resolve(session,start),language);
  for(const prefix of ['Hej','Hej tack','Hej tack hola'])assert.equal(resolve(session,`${prefix}, ${body}`),language);
  const target=language==='en'?'sv':'en';
  const targetBody=offlineLanguageBodies.find(([code])=>code===target)![2];
  assert.equal(resolve(session,targetBody),target,'A meaningful full message can still switch language');
});
test('Swedish preposition i stays neutral and explicit switches still override English verb frames',()=>{
 const session='offline-preposition-switch';
 assert.equal(resolve(session,'Hej, jag vill fortsätta på svenska.'),'sv');
 assert.equal(resolve(session,'Jag vill boka en tid i studion i morgon.'),'sv');
 assert.equal(resolve(session,'Please reply in German from now on.'),'de');
 assert.equal(resolve(session,'Please reply in Persian from now on.'),'fa');
 assert.equal(resolve(session,'Please reply in Arabic from now on.'),'ar');
});

// Keep this discovered limitation visible; do not broaden switch parsing to
// arbitrary mentions or hide it with an expected-failure assertion.
test('compound explicit switch request overrides the language of its preamble',()=>{
 const session='offline-compound-switch';
 resolve(session,'Hej, jag vill fortsätta på svenska.');
 assert.equal(resolve(session,'I want to continue, but please reply in German from now on.'),'de');
});

for(const [target,request]of [
 ['en','Please reply in English from now on'],['de','Bitte antworten Sie auf Deutsch'],
 ['sv','Svara på svenska tack'],['es','Por favor responde en español'],
 ['fa','لطفاً به فارسی پاسخ بده'],['ar','من فضلك أجب باللغة العربية'],
]as const)test(`six-language compound switch continuity: ${target}`,()=>{
 for(const[position,text]of [`${request}; I need help.`,`I need help; ${request}; I want to continue.`,`I want to continue, but ${request}.`].entries()){
  const session=`compound-continuity-${target}-${position}`;
  resolve(session,target==='en'?'Bitte antworten Sie auf Deutsch.':'Please reply in English.');
  assert.equal(resolve(session,text),target);
  assert.equal(resolve(session,'OK.'),target);
  const back=target==='en'?'de':'en';
  assert.equal(resolve(session,back==='en'?'Please reply in English.':'Bitte antworten Sie auf Deutsch.'),back);
 }
});
test('quoted requests and language questions preserve the established conversation language',()=>{
 const session='quoted-request-continuity';
 resolve(session,'Please reply in English.');
 for(const text of ['What does "Bitte antworten Sie auf Deutsch" mean?','What does “لطفاً به فارسی پاسخ بده” mean?','Can you speak German?','What does the phrase `Svara på svenska` mean?'])
  assert.equal(resolve(session,text),'en',text);
});
test('semantic language resolution receives unquoted instruction context only',async()=>{
 boundary.reset();let evaluated=false;
 boundary.configure({semanticLanguageResolver:async(text:string)=>{
  evaluated=true;assert.doesNotMatch(text,/فارسی|لطفاً/);
  return{language:'en',confidence:.99};
 }});
 const session='semantic-quoted-switch';resolve(session,'Please reply in English.');
 assert.equal(await boundary.prepareConversationLanguageForTest(session,'What does “لطفاً به فارسی پاسخ بده” mean?',businessConfig),'en');
 assert.equal(evaluated,true);boundary.reset();
});
