import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const selectedDate = "2026-09-07";
const businessConfig = {
  id: "availability-observability-business",
  businessRecordId: "availability-observability-business",
  business_id: "availability-observability-business",
  businessName: "Observability Test Business",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
  systemPrompt: "Keep 0 minutes between appointments.",
  services: [
    { id: "video-consultation", name: "Video Consultation", durationMinutes: 60 },
  ],
  workingHours: {
    monday: [{ start: "09:00", end: "12:00" }],
  },
};

let calendarReadCount = 0;
const calendarEvents = [
  {
    id: "private-calendar-event-id",
    summary: "Private Customer Name +46700000001",
    description: "private inbound message content",
    start: { dateTime: `${selectedDate}T11:00:00+02:00` },
    end: { dateTime: `${selectedDate}T12:00:00+02:00` },
  },
];
const adapter = {
  getEvents: async () => {
    calendarReadCount += 1;
    return structuredClone(calendarEvents);
  },
  checkSlots: () => ({ available_slots_string: "" }),
  insertAppointment: () => ({ success: false }),
};

const activeCreatedAt = Date.now() - 5 * 60_000;
const expiredCreatedAt = Date.now() - 365 * 24 * 60 * 60_000;

function slot(startTime: string, owner: string) {
  const start = `${selectedDate}T${startTime}:00+02:00`;
  return {
    start,
    end: new Date(new Date(start).getTime() + 60 * 60_000).toISOString(),
    durationMinutes: 60,
    service: "Video Consultation",
    businessId: businessConfig.id,
    platform: "instagram",
    userId: owner,
    generatedAt: Date.now(),
    searchStartDate: selectedDate,
    searchEndDate: selectedDate,
  };
}

function seedPendingHolds() {
  const activeSlot = slot("09:00", "private-active-owner");
  boundary.seedPending("private-active-session", {
    businessId: businessConfig.id,
    businessConfig,
    platform: "instagram",
    userId: activeSlot.userId,
    sessionId: "private-active-session",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: activeSlot.start,
    selectedSlotEnd: activeSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [activeSlot],
    createdAt: activeCreatedAt,
    updatedAt: Date.now(),
    customerName: "Private Active Customer",
    customerPhone: "+46700000002",
    message: "private active customer message",
  });

  const expiredSlot = slot("10:00", "private-expired-owner");
  boundary.seedPending("private-expired-session", {
    businessId: businessConfig.id,
    businessConfig,
    platform: "instagram",
    userId: expiredSlot.userId,
    sessionId: "private-expired-session",
    status: "awaiting_confirmation",
    operation: "new_booking",
    dateTime: expiredSlot.start,
    selectedSlotEnd: expiredSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [expiredSlot],
    createdAt: expiredCreatedAt,
    updatedAt: Date.now(),
    customerName: "Private Expired Customer",
    customerPhone: "+46700000003",
    message: "private expired customer message",
  });
}

const request = {
  businessConfig,
  sessionId: "private-requesting-session",
  platform: "instagram",
  userId: "private-requesting-owner",
  startDate: selectedDate,
  endDate: selectedDate,
  service: "Video Consultation",
  durationMinutes: 60,
  options: { selectFirstAvailable: true },
  diagnosticContext: {
    language: "es",
    selectedDate,
    canonicalConstraintKind: "whole_day",
  },
};

const stableOffers = (offers: any) => ({
  displaySlots: offers.displaySlots,
  ownedSlots: offers.ownedSlots.map(({ generatedAt: _generatedAt, ...owned }: any) => owned),
});

try {
  const diagnostics: any[] = [];
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    availabilityDiagnostic: (diagnostic: any) => diagnostics.push(structuredClone(diagnostic)),
  });
  seedPendingHolds();
  const activeBefore = boundary.pendingStateSnapshot("private-active-session");
  const expiredBefore = boundary.pendingStateSnapshot("private-expired-session");
  calendarReadCount = 0;

  const observedOffers = await boundary.canonicalOffers(request);

  assert.equal(calendarReadCount, 1, "observability must not add a calendar read");
  assert.equal(diagnostics.length, 1, "one canonical scan emits one structured diagnostic object");
  const diagnostic = diagnostics[0];
  assert.equal(diagnostic.diagnosticMarker, "canonical_availability_snapshot_v1");
  assert.deepEqual(diagnostic.snapshot, {
    calendarReadCount: 1,
    calendarEventCount: 1,
    pendingSnapshotCount: 1,
    pendingHoldCount: 1,
  });
  assert.equal(diagnostic.request.language, "es");
  assert.equal(diagnostic.request.selectedDate, selectedDate);
  assert.equal(diagnostic.request.serviceId, "video-consultation");
  assert.equal(diagnostic.request.serviceName, "Video Consultation");
  assert.equal(diagnostic.request.runtimeDurationMinutes, 60);
  assert.equal(diagnostic.request.canonicalConstraintKind, "whole_day");

  const activeDiagnostic = diagnostic.pendingHolds.find(
    (pending: any) => pending.status === "awaiting_contact"
  );
  assert.ok(activeDiagnostic);
  assert.equal(activeDiagnostic.sameBusiness, true);
  assert.equal(activeDiagnostic.expired, false);
  assert.equal(activeDiagnostic.legitimatelyOwned, true);
  assert.equal(activeDiagnostic.eligibleToBlockRequest, true);
  assert.equal(activeDiagnostic.ttlMs > 0, true);
  assert.equal(typeof activeDiagnostic.ageMs, "number");
  assert.equal(typeof activeDiagnostic.expiresAt, "string");
  assert.notEqual(activeDiagnostic.ownerSessionFingerprint, "private-active-session");

  const expiredDiagnostic = diagnostic.pendingHolds.find(
    (pending: any) => pending.status === "awaiting_confirmation"
  );
  assert.ok(expiredDiagnostic);
  assert.equal(expiredDiagnostic.expired, true);
  assert.equal(expiredDiagnostic.legitimatelyOwned, true);
  assert.equal(expiredDiagnostic.eligibleToBlockRequest, false);

  assert.ok(diagnostic.candidates.pendingHoldBlockedCount > 0);
  assert.ok(diagnostic.candidates.pendingBlockedCandidates.length > 0);
  const blockedCandidate = diagnostic.candidates.pendingBlockedCandidates[0];
  assert.equal(blockedCandidate.blockingPendingFingerprint, activeDiagnostic.ownerSessionFingerprint);
  assert.equal(blockedCandidate.blockingStatus, "awaiting_contact");
  assert.equal(blockedCandidate.blockingStart, activeDiagnostic.selectedStart);
  assert.equal(blockedCandidate.blockingEnd, activeDiagnostic.selectedEnd);
  assert.equal(blockedCandidate.blockingExpired, false);
  assert.deepEqual(
    diagnostic.finalRankedOfferedSlots,
    observedOffers.ownedSlots.map((owned: any) => ({ start: owned.start, end: owned.end })),
  );
  assert.deepEqual(boundary.pendingStateSnapshot("private-active-session"), activeBefore);
  assert.deepEqual(boundary.pendingStateSnapshot("private-expired-session"), expiredBefore);

  const serializedDiagnostic = JSON.stringify(diagnostic);
  for (const privateValue of [
    "private-requesting-session",
    "private-requesting-owner",
    "private-active-session",
    "private-active-owner",
    "private-expired-session",
    "private-expired-owner",
    "Private Active Customer",
    "Private Expired Customer",
    "+46700000002",
    "+46700000003",
    "private active customer message",
    "private expired customer message",
    "Private Customer Name",
    "+46700000001",
    "private inbound message content",
  ]) {
    assert.equal(serializedDiagnostic.includes(privateValue), false, `diagnostic leaked ${privateValue}`);
  }

  boundary.reset();
  boundary.configure({ calendarAdapter: adapter });
  seedPendingHolds();
  calendarReadCount = 0;
  const controlOffers = await boundary.canonicalOffers(request);
  assert.equal(calendarReadCount, 1, "control scan must retain one calendar read");
  assert.deepEqual(
    stableOffers(observedOffers),
    stableOffers(controlOffers),
    "diagnostic observation must not change canonical candidate results or ranking",
  );
} finally {
  boundary.reset();
}

console.log("canonical availability observability integration tests passed");
