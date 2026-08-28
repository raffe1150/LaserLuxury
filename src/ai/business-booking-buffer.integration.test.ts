import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { priority1hUnifiedEngineTestBoundary: boundary } =
  await import("../../server");

const events = [
  {
    id: "existing-1",
    summary: "Existing appointment",
    startTime: "2026-08-24T10:00:00+02:00",
    endTime: "2026-08-24T10:30:00+02:00"
  }
];

const adapter = {
  getCalendarId: () => "buffer-test-calendar",

  getEvents: async () => events,

  checkSlots: async () => ({
    available_slots_string: ""
  }),

  insertAppointment: async (
    name: string,
    phone: string,
    service: string,
    dateTime: string,
    durationMinutes = 30
  ) => {
    const start = new Date(dateTime);
    return {
      success: true,
      event: {
        id: "created-test",
        summary: `Bokad: ${name}`,
        startTime: start.toISOString(),
        endTime: new Date(
          start.getTime() + durationMinutes * 60_000
        ).toISOString()
      }
    };
  }
};

boundary.reset();
boundary.configure({
  calendarAdapter: adapter
});

const businessConfig = {
  id: "buffer-business",
  businessName: "Buffer Test Business",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
  googleCalendarId: "buffer-test-calendar",

  // This is intentionally defined in the business prompt,
  // not hard-coded in the booking engine.
  systemPrompt: `
Booking rules:
Keep 15 minutes between appointments.
`
};

const common = {
  businessConfig,
  sessionId: "buffer-test-session",
  platform: "telegram",
  userId: "buffer-test-user",
  startDate: "2026-08-24",
  endDate: "2026-08-24",
  service: "Konsultation",
  durationMinutes: 30
};

function localTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));

  const hour = parts.find(p => p.type === "hour")?.value;
  const minute = parts.find(p => p.type === "minute")?.value;

  return `${hour}:${minute}`;
}

// ---------------------------------------------------------
// AFTER EXISTING APPOINTMENT
// Existing: 10:00–10:30
// Buffer:   until 10:45
// ---------------------------------------------------------

const afterOffers = await boundary.canonicalOffers({
  ...common,
  requestedTime: "10:30"
});

assert.equal(
  afterOffers.ownedSlots.some(
    (slot: any) => localTime(slot.start) === "10:30"
  ),
  false,
  "10:30 must be blocked because the existing appointment ends at 10:30 and requires a 15-minute buffer"
);

assert.equal(
  afterOffers.ownedSlots.some(
    (slot: any) => localTime(slot.start) === "10:45"
  ),
  true,
  "10:45 must be available because the 15-minute post-appointment buffer has elapsed"
);

// ---------------------------------------------------------
// BEFORE EXISTING APPOINTMENT
// A 30-minute service ending at 10:00 would need its
// 15-minute buffer until 10:15, so 09:30 must be blocked.
// 09:15 ends at 09:45 and is valid.
// ---------------------------------------------------------

const beforeOffers = await boundary.canonicalOffers({
  ...common,
  requestedTime: "09:30"
});

assert.equal(
  beforeOffers.ownedSlots.some(
    (slot: any) => localTime(slot.start) === "09:30"
  ),
  false,
  "09:30 must be blocked because its required buffer would overlap the 10:00 appointment"
);

assert.equal(
  beforeOffers.ownedSlots.some(
    (slot: any) => localTime(slot.start) === "09:15"
  ),
  true,
  "09:15 must remain available"
);

// ---------------------------------------------------------
// SERVICE DURATION MUST STAY 30 MINUTES
// Buffer must never become part of the calendar event length.
// ---------------------------------------------------------

const validSlot = afterOffers.ownedSlots.find(
  (slot: any) => localTime(slot.start) === "10:45"
);

assert.ok(validSlot, "Expected 10:45 test slot");

assert.equal(
  (
    new Date(validSlot.end).getTime() -
    new Date(validSlot.start).getTime()
  ) / 60_000,
  30,
  "Owned offered slot must keep the real 30-minute service duration"
);

// ---------------------------------------------------------
// ZERO-BUFFER BUSINESS
// Adjacent 10:30 must be legal again.
// ---------------------------------------------------------

const zeroBufferOffers = await boundary.canonicalOffers({
  ...common,
  sessionId: "zero-buffer-session",
  businessConfig: {
    ...businessConfig,
    systemPrompt: `
Booking rules:
Keep 0 minutes between appointments.
`
  },
  requestedTime: "10:30"
});

assert.equal(
  zeroBufferOffers.ownedSlots.some(
    (slot: any) => localTime(slot.start) === "10:30"
  ),
  true,
  "10:30 must be available when the business explicitly configures a zero-minute buffer"
);

boundary.reset();

console.log(
  "Business booking buffer regression passed: prompt-defined 15-minute symmetric buffer, real 30-minute service duration, and zero-buffer override."
);
