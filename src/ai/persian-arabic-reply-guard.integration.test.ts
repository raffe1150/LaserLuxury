import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

boundary.reset();

const cases = [
  {
    label: "valid Persian catalog reply is preserved",
    language: "fa",
    reply:
      "خدمات قابل رزرو عبارت‌اند از: Video Consultation, test, video for tiktok, Golden video, Reklam.",
    expected:
      "خدمات قابل رزرو عبارت‌اند از: Video Consultation, test, video for tiktok, Golden video, Reklam.",
  },
  {
    label: "valid Arabic catalog reply is preserved",
    language: "ar",
    reply:
      "الخدمات المتاحة للحجز هي: Video Consultation, test, video for tiktok, Golden video, Reklam.",
    expected:
      "الخدمات المتاحة للحجز هي: Video Consultation, test, video for tiktok, Golden video, Reklam.",
  },
] as const;

for (const item of cases) {
  assert.equal(
    boundary.guardReply(`reply-guard-${item.language}`, item.reply, item.language),
    item.expected,
    item.label,
  );
}

assert.notEqual(
  boundary.guardReply(
    "reply-guard-fa-english",
    "The configured bookable services are: Video Consultation, test, video for tiktok, Golden video, Reklam.",
    "fa",
  ),
  "The configured bookable services are: Video Consultation, test, video for tiktok, Golden video, Reklam.",
  "English reply must still be rejected when Persian is expected",
);

assert.notEqual(
  boundary.guardReply(
    "reply-guard-fa-arabic",
    "مرحبا، يمكنني مساعدتك في حجز موعد مناسب.",
    "fa",
  ),
  "مرحبا، يمكنني مساعدتك في حجز موعد مناسب.",
  "Arabic reply must still be rejected when Persian is expected",
);

assert.notEqual(
  boundary.guardReply(
    "reply-guard-ar-persian",
    "سلام، می‌تونم برای رزرو وقت مناسب کمکتون کنم.",
    "ar",
  ),
  "سلام، می‌تونم برای رزرو وقت مناسب کمکتون کنم.",
  "Persian reply must still be rejected when Arabic is expected",
);

console.log("Persian/Arabic reply guard regressions passed");

boundary.reset();
