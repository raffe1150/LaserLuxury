import assert from "node:assert/strict";
import test from "node:test";

import { priority1hUnifiedEngineTestBoundary as boundary } from "../../server";

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
