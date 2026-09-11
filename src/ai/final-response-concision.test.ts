import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { priority1hUnifiedEngineTestBoundary } = await import("../../server");

test("keeps normal concise replies unchanged", () => {
  const reply = "Gerne. Welche Dienstleistung interessiert Sie?";
  assert.equal(priority1hUnifiedEngineTestBoundary.enforceConversationConcision(reply), reply);
});

test("shortens long multi-sentence replies only at a complete sentence boundary", () => {
  const reply =
    "Wir bieten verschiedene Videodienstleistungen für unterschiedliche Marketingziele an. " +
    "Eine Beratung hilft dabei, zuerst das passende Format und Ziel zu bestimmen. " +
    "Danach können wir gemeinsam entscheiden, welche Produktion am besten zu Ihrem Unternehmen und Ihrer Zielgruppe passt. " +
    "Zusätzlich können wir weitere Optionen erklären, wenn Sie mehr Details benötigen.";

  const result = priority1hUnifiedEngineTestBoundary.enforceConversationConcision(reply, 30);
  const count = result.split(/\s+/u).filter(Boolean).length;

  assert.ok(count <= 30);
  assert.ok(/[.!?؟。！？]["'”’»)]*$/u.test(result));
  assert.ok(reply.startsWith(result));
});

test("does not hard-cut a long single sentence", () => {
  const reply = Array.from({ length: 50 }, (_, i) => `word${i + 1}`).join(" ");
  assert.equal(priority1hUnifiedEngineTestBoundary.enforceConversationConcision(reply), reply);
});

test("supports Persian and Arabic sentence punctuation", () => {
  const reply =
    "این یک پاسخ کامل درباره خدمات موجود است و اطلاعات اصلی را توضیح می‌دهد. " +
    "اگر هنوز مطمئن نیستید، می‌توانیم گزینه‌های مناسب را بر اساس نیاز شما بررسی کنیم؟ " +
    "اطلاعات اضافی دیگری هم وجود دارد که در صورت نیاز می‌توانیم بعداً توضیح دهیم.";

  const result = priority1hUnifiedEngineTestBoundary.enforceConversationConcision(reply, 24);
  assert.ok(result.split(/\s+/u).filter(Boolean).length <= 24);
  assert.ok(/[.!?؟。！？]["'”’»)]*$/u.test(result));
});
