import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const baseAppointment = {
  customer_name: "Alex Test",
  service: "Consultation",
  start_time: "2026-10-13T11:00:00.000Z",
};
const businessConfig = { businessName: "Clinic Test" };

try {
  const german24h = boundary.formatReminder(
    { ...baseAppointment, language: "de" },
    businessConfig,
    "24h",
  );
  assert.match(german24h, /Hallo Alex Test|Erinnerung|morgen|Beratung/u);
  assert.doesNotMatch(german24h, /En vänlig påminnelse|imorgon/u);

  const german2h = boundary.formatReminder(
    { ...baseAppointment, language: "de" },
    businessConfig,
    "2h",
  );
  assert.match(german2h, /Hallo Alex Test|Erinnerung|heute|Beratung/u);
  assert.doesNotMatch(german2h, /En vänlig påminnelse|idag/u);

  const english = boundary.formatReminder(
    { ...baseAppointment, language: "en" },
    businessConfig,
    "24h",
  );
  assert.match(english, /Hi Alex Test|friendly reminder|tomorrow|consultation/u);
  assert.doesNotMatch(english, /En vänlig påminnelse|imorgon/u);

  const swedish = boundary.formatReminder(
    { ...baseAppointment, language: "sv" },
    businessConfig,
    "2h",
  );
  assert.match(swedish, /Hej Alex Test|vänlig påminnelse|idag/u);

  const arabic = boundary.formatReminder(
    { ...baseAppointment, language: "ar" },
    businessConfig,
    "24h",
  );
  assert.match(arabic, /تذكير|غدًا|الاستشارة/u);

  const customService = "Premium Glow Ritual";
  const persianCustomService = boundary.formatReminder(
    { ...baseAppointment, service: customService, language: "fa" },
    businessConfig,
    "24h",
  );
  assert.match(persianCustomService, /Premium Glow Ritual/u);

  const arabicCustomService = boundary.formatReminder(
    { ...baseAppointment, service: customService, language: "ar" },
    businessConfig,
    "2h",
  );
  assert.match(arabicCustomService, /Premium Glow Ritual/u);

  const legacy = boundary.formatReminder(baseAppointment, businessConfig, "24h");
  assert.match(legacy, /Hej Alex Test|vänlig påminnelse|imorgon/u);
} finally {
  boundary.reset();
}

console.log("reminder language integration tests passed");
