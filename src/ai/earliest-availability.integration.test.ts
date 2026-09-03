import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary } = await import("../../server");

let calendarEvents: any[] = [];
const adapter = {
  getEvents: async () => structuredClone(calendarEvents),
  checkSlots: () => ({ available_slots_string: "" }),
  insertAppointment: () => ({ success: false }),
};

const config = (id: string) => ({
  id,
  businessRecordId: id,
  business_id: id,
  businessName: "Earliest Test Business",
  timezone: "Europe/Stockholm",
  calendarProvider: "google",
  services: [{ name: "Consultation", active: true, bookable: true }],
  serviceDurations: { Consultation: 60 },
});
const event = (date: string, start: string, end: string) => ({
  id: `${date}-${start}-${end}`,
  summary: "Busy",
  start: { dateTime: `${date}T${start}:00+02:00` },
  end: { dateTime: `${date}T${end}:00+02:00` },
});
const localStarts = (offers: any) => offers.ownedSlots.map((slot: any) => slot.start.slice(0, 16));
const offers = (overrides: Record<string, any> = {}) => priority1hUnifiedEngineTestBoundary.canonicalOffers({
  businessConfig: config(overrides.businessId || "earliest-1"),
  sessionId: overrides.sessionId || "requesting-session",
  platform: "telegram",
  userId: "requesting-user",
  startDate: "2026-08-17",
  endDate: "2026-08-17",
  durationMinutes: 60,
  options: { selectFirstAvailable: true, ...(overrides.options || {}) },
  now: new Date("2026-08-16T12:00:00+02:00"),
  ...overrides,
});

priority1hUnifiedEngineTestBoundary.configure({ calendarAdapter: adapter });
try {
  calendarEvents = [event("2026-08-17", "09:00", "11:00")];
  assert.equal(localStarts(await offers())[0], "2026-08-17T11:00");

  calendarEvents = [
    event("2026-08-17", "09:00", "20:00"),
    event("2026-08-18", "09:00", "10:00"),
  ];
  assert.equal(localStarts(await offers({ endDate: "2026-08-18" }))[0], "2026-08-18T10:00");

  calendarEvents = [event("2026-08-17", "09:00", "10:00")];
  assert.equal(localStarts(await offers())[0], "2026-08-17T10:00");

  calendarEvents = [];
  const holdConfig = config("pending-earliest");
  const heldSlot = {
    start: "2026-08-17T09:00:00+02:00",
    end: "2026-08-17T08:00:00.000Z",
    durationMinutes: 60,
    service: "Consultation",
    businessId: "pending-earliest",
    platform: "telegram",
    userId: "holder-user",
    generatedAt: Date.now(),
  };
  priority1hUnifiedEngineTestBoundary.seedPending("holder-session", {
    businessId: "pending-earliest",
    businessConfig: holdConfig,
    platform: "telegram",
    userId: "holder-user",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: heldSlot.start,
    selectedSlotEnd: heldSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [heldSlot],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(localStarts(await offers({ businessId: "pending-earliest" }))[0], "2026-08-17T10:00");

  const expiredConfig = config("expired-earliest");
  const expiredSlot = { ...heldSlot, businessId: "expired-earliest" };
  priority1hUnifiedEngineTestBoundary.seedPending("expired-holder-session", {
    businessId: "expired-earliest",
    businessConfig: expiredConfig,
    platform: "telegram",
    userId: "holder-user",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: expiredSlot.start,
    selectedSlotEnd: expiredSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [expiredSlot],
    createdAt: Date.now() - 60 * 60 * 1000,
    updatedAt: Date.now(),
  });
  assert.equal(localStarts(await offers({ businessId: "expired-earliest" }))[0], "2026-08-17T09:00");

  assert.equal(localStarts(await offers({ options: { selectFirstAvailable: true, timeBoundary: { kind: "exclusive_lower", time: "15:00" } } }))[0], "2026-08-17T15:15");
  assert.equal(localStarts(await offers({ options: { selectFirstAvailable: true, timeBoundary: { kind: "exclusive_upper", time: "12:00" } } }))[0], "2026-08-17T09:00");
  assert.equal(localStarts(await offers({ options: { selectFirstAvailable: true, minTime: "09:00", maxTime: "11:59" } }))[0], "2026-08-17T09:00");

  const rangeStarts = localStarts(await offers({ endDate: "2026-08-19" }));
  assert.deepEqual(rangeStarts.slice(0, 3), [
    "2026-08-17T09:00",
    "2026-08-17T09:15",
    "2026-08-17T09:30",
  ]);
  assert.deepEqual(localStarts(await offers()).slice(0, 3), [
    "2026-08-17T09:00",
    "2026-08-17T09:15",
    "2026-08-17T09:30",
  ]);

  calendarEvents = [event("2026-08-17", "09:45", "10:00")];
  assert.equal(localStarts(await offers())[0], "2026-08-17T10:00");
  assert.ok(localStarts(await offers()).every((start: string) => /:(?:00|15|30|45)$/.test(start)));

  calendarEvents = [];
  const semanticConfig = config("semantic-earliest");
  const semanticTurn = await priority1hUnifiedEngineTestBoundary.turn({
    sessionId: "semantic-earliest-session",
    platformName: "telegram",
    recipientUserId: "semantic-user",
    text: "I want the earliest available Consultation on 2026-08-17",
    businessConfig: semanticConfig,
    now: new Date("2026-08-16T12:00:00+02:00"),
  });
  assert.equal(semanticTurn.handled, true);
  const semanticPending = priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("semantic-earliest-session");
  assert.equal(semanticPending.ownedOfferedSlots[0].start.slice(0, 16), "2026-08-17T09:00");
  assert.deepEqual(
    semanticPending.ownedOfferedSlots.map((slot: any) => slot.start.slice(0, 16)),
    ["2026-08-17T09:00", "2026-08-17T09:15", "2026-08-17T09:30"],
  );
} finally {
  priority1hUnifiedEngineTestBoundary.reset();
}

console.log("earliest availability integration tests passed");
