import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "telegram-earliest-parity",
  businessRecordId: "telegram-earliest-parity",
  business_id: "telegram-earliest-parity",
  businessName: "Earliest Parity Clinic",
  language: "sv",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
  defaultBookingService: "Consultation",
  services: [{ name: "Consultation", durationMinutes: 60 }],
  serviceDurations: { Consultation: 60, Konsultation: 60, Bokning: 60 },
};
let events: any[] = [];
const adapter = {
  getEvents: async () => structuredClone(events),
  checkSlots: () => ({ available_slots_string: "" }),
};
const event = (date: string, start: string, end: string) => ({
  id: `${date}-${start}-${end}`,
  summary: "Busy",
  start: { dateTime: `${date}T${start}:00+02:00` },
  end: { dateTime: `${date}T${end}:00+02:00` },
});
const localStart = (slot: any) => String(slot?.start || "").slice(0, 16);
const productionTurn = (sessionId: string, text: string, config = businessConfig) => boundary.turn({
  sessionId,
  platformName: "telegram",
  recipientUserId: `${sessionId}-user`,
  text,
  businessConfig: config,
});
const reset = () => {
  boundary.reset();
  boundary.configure({ calendarAdapter: adapter, postProcess: async () => undefined });
  events = [];
};

reset();
try {
  const request = "Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti?";
  const production = await productionTurn("telegram-range-production", request);
  assert.equal(production.handled, true);
  assert.equal(production.pending.availabilityConstraint.startDate, "2026-08-15");
  assert.equal(production.pending.availabilityConstraint.endDate, "2026-08-21");
  assert.equal(production.pending.availabilityConstraint.selectFirstAvailable, true);
  assert.equal(production.pending.durationMinutes, 60);
  assert.equal(localStart(production.pending.ownedOfferedSlots[0]), "2026-08-17T09:00");
  assert.doesNotMatch(production.replies.join(" "), /ingen ledig tid för samma dag/iu);
  assert.match(production.replies.join(" "), /17 augusti[^\d]*09:00/iu);

  const canonical = await boundary.canonicalOffers({
    businessConfig,
    sessionId: "test-bridge-equivalent",
    platform: "telegram",
    userId: "bridge-user",
    startDate: "2026-08-15",
    endDate: "2026-08-21",
    service: "Consultation",
    durationMinutes: 60,
    options: { selectFirstAvailable: true },
  });
  assert.equal(localStart(canonical.ownedSlots[0]), localStart(production.pending.ownedOfferedSlots[0]));

  reset();
  events = [event("2026-08-17", "09:00", "09:15")];
  const blocked = await productionTurn("telegram-range-calendar", request);
  assert.equal(localStart(blocked.pending.ownedOfferedSlots[0]), "2026-08-17T09:15");

  reset();
  const heldSlot = {
    start: "2026-08-17T09:00:00+02:00",
    end: "2026-08-17T08:00:00.000Z",
    durationMinutes: 60,
    service: "Consultation",
    businessId: businessConfig.id,
    platform: "telegram",
    userId: "holder-user",
    generatedAt: Date.now(),
  };
  boundary.seedPending("holder-session", {
    businessId: businessConfig.id,
    businessConfig,
    platform: "telegram",
    userId: "holder-user",
    sessionId: "holder-session",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: heldSlot.start,
    selectedSlotEnd: heldSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [heldSlot],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const pendingBlocked = await productionTurn("telegram-range-pending", request);
  assert.equal(localStart(pendingBlocked.pending.ownedOfferedSlots[0]), "2026-08-17T10:00");

  reset();
  boundary.seedPending("expired-holder-session", {
    businessId: businessConfig.id,
    businessConfig,
    platform: "telegram",
    userId: "expired-holder-user",
    sessionId: "expired-holder-session",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: heldSlot.start,
    selectedSlotEnd: heldSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [{ ...heldSlot, userId: "expired-holder-user" }],
    createdAt: Date.now() - 60 * 60 * 1000,
    updatedAt: Date.now(),
  });
  const expired = await productionTurn("telegram-range-expired", request);
  assert.equal(localStart(expired.pending.ownedOfferedSlots[0]), "2026-08-17T09:00");

  reset();
  events = [event("2026-08-17", "10:00", "10:15")];
  const longDurationConfig = {
    ...businessConfig,
    serviceDurations: { Consultation: 75, Konsultation: 75, Bokning: 75 },
    services: [{ name: "Consultation", durationMinutes: 75 }],
  };
  const durationAware = await productionTurn("telegram-range-duration", request, longDurationConfig);
  assert.equal(durationAware.pending.durationMinutes, 75);
  assert.equal(localStart(durationAware.pending.ownedOfferedSlots[0]), "2026-08-17T10:15");

  reset();
  const after = await productionTurn(
    "telegram-range-after",
    "Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti efter kl 13:00?"
  );
  assert.equal(localStart(after.pending.ownedOfferedSlots[0]), "2026-08-17T13:15");
  const before = await productionTurn(
    "telegram-range-before",
    "Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti före kl 12:00?"
  );
  assert.equal(localStart(before.pending.ownedOfferedSlots[0]), "2026-08-17T09:00");

  reset();
  events = [];
  const nearestAfterDate = await productionTurn(
    "telegram-earliest-after-explicit-date",
    "Ja, tack! Har ni någon tid närmast efter den 17 augusti? Gärna så snart som möjligt."
  );

  assert.equal(nearestAfterDate.handled, true);
  assert.equal(
    nearestAfterDate.pending.availabilityConstraint.startDate,
    "2026-08-18"
  );
  assert.ok(
    nearestAfterDate.pending.availabilityConstraint.endDate >
      nearestAfterDate.pending.availabilityConstraint.startDate
  );
  assert.equal(
    nearestAfterDate.pending.availabilityConstraint.selectFirstAvailable,
    true
  );
  assert.equal(
    localStart(nearestAfterDate.pending.ownedOfferedSlots[0]),
    "2026-08-18T09:00"
  );

  reset();
  const normallyRanked = await productionTurn(
    "telegram-range-normal",
    "Jag vill boka en tid mellan 15 och 21 augusti."
  );
  assert.equal(normallyRanked.pending.availabilityConstraint.selectFirstAvailable, undefined);
  assert.equal(localStart(normallyRanked.pending.ownedOfferedSlots[0]), "2026-08-17T14:00");

  reset();
  const previousSelection = await productionTurn(
    "telegram-range-replacement",
    "Book Consultation on 2026-08-19 at 15:00"
  );
  assert.equal(previousSelection.pending.status, "awaiting_confirmation");
  const replacedByEarliest = await productionTurn("telegram-range-replacement", request);
  assert.equal(replacedByEarliest.pending.availabilityConstraint.startDate, "2026-08-15");
  assert.equal(replacedByEarliest.pending.availabilityConstraint.endDate, "2026-08-21");
  assert.equal(localStart(replacedByEarliest.pending.ownedOfferedSlots[0]), "2026-08-17T09:00");
} finally {
  boundary.reset();
}

console.log("Telegram earliest range parity integration tests passed");
