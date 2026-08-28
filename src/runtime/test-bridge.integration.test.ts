import assert from "node:assert/strict";
import express from "express";

process.env.NODE_ENV = "test";
process.env.ODINLINK_TEST_BRIDGE_TOKEN = "test-bridge-integration-token-at-least-32-bytes";
const { createTestBridgeRouter, priority1hUnifiedEngineTestBoundary } = await import("../../server");

const businessConfig = {
  id: "business-1",
  businessRecordId: "business-1",
  business_id: "business-1",
  timezone: "Europe/Stockholm",
  calendarProvider: "google",
};

let calendarEvents: any[] = [];
let calendarReadError: Error | null = null;
let mutationCount = 0;

const adapter = {
  getEvents: async () => {
    if (calendarReadError) throw calendarReadError;
    return structuredClone(calendarEvents);
  },
  checkSlots: () => ({ available_slots_string: "" }),
  insertAppointment: () => { mutationCount += 1; return { success: true }; },
  updateAppointment: () => { mutationCount += 1; return { success: true }; },
  cancelAppointment: () => { mutationCount += 1; return { success: true }; },
};

const requestBody = (overrides: Record<string, unknown> = {}) => ({
  operation: "availability.verify",
  businessId: "business-1",
  date: "2026-08-14",
  time: "14:15",
  durationMinutes: 60,
  service: "Consultation",
  channel: "telegram",
  userId: "test-user-id",
  ...overrides,
});

const ownedSlot = (
  start: string,
  end: string,
  businessId = "business-1",
  userId = "another-user",
) => ({
  start,
  end,
  durationMinutes: 60,
  service: "Consultation",
  businessId,
  platform: "telegram",
  userId,
  generatedAt: Date.now(),
});

async function withTestServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(createTestBridgeRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function postVerify(baseUrl: string, body: any) {
  const response = await fetch(`${baseUrl}/api/test-bridge/v1/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ODINLINK_TEST_BRIDGE_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => null) };
}

process.env.ODINLINK_TEST_BRIDGE_ENABLED = "true";
priority1hUnifiedEngineTestBoundary.configure({
  calendarAdapter: adapter,
  loadBusinessConfigById: async businessId => businessId === "business-1" ? businessConfig : null,
  testBridgeNow: () => Date.parse("2026-08-01T12:00:00.000Z"),
});

try {
  await withTestServer(async baseUrl => {
    const capabilities = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`, {
      headers: { Authorization: `Bearer ${process.env.ODINLINK_TEST_BRIDGE_TOKEN}` },
    });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(await capabilities.json(), {
      schemaVersion: "odinlink-test-bridge-v1",
      enabled: true,
      operations: [
        "availability.verify",
        "availability.earliest.verify",
        "availability.pending-blockers.inspect",
        "test-execution.create",
        "test-execution.inspect",
      ],
      readOnly: true,
      authentication: { required: true, scheme: "bearer" },
      executionProvenance: {
        schemaVersion: "odinlink-test-execution-v1",
        durable: true,
        survivesRestart: true,
        testMetadataWrites: true,
        ttlMs: 30 * 60 * 1000,
        operations: ["test-execution.create", "test-execution.inspect"],
        cleanupSupported: false,
      },
      safety: {
        calendarMutationSupported: false,
        bookingMutationSupported: false,
        pendingMutationSupported: false,
      },
    });

    // Required deterministic regression: 2026-08-14 14:15 is genuinely free.
    calendarEvents = [];
    let result = await postVerify(baseUrl, requestBody());
    assert.equal(result.response.status, 200);
    assert.equal(result.json.status, "verified");
    assert.equal(result.json.result.available, true);
    assert.equal(result.json.result.category, "available");
    assert.equal(result.json.evidence.calendarEventCount, 0);
    assert.equal(result.json.evidence.pendingHoldCount, 0);

    calendarEvents = [{
      id: "busy-1",
      summary: "Private booking details must not leak",
      description: "private customer data",
      start: { dateTime: "2026-08-14T14:00:00+02:00" },
      end: { dateTime: "2026-08-14T15:00:00+02:00" },
    }];
    result = await postVerify(baseUrl, requestBody());
    assert.equal(result.json.result.available, false);
    assert.equal(result.json.result.category, "calendar_conflict");
    assert.equal(JSON.stringify(result.json).includes("private customer data"), false);

    calendarEvents = [];
    priority1hUnifiedEngineTestBoundary.seedPending("another-session", {
      businessId: "business-1",
      businessConfig,
      platform: "telegram",
      userId: "another-user",
      status: "awaiting_confirmation",
      dateTime: "2026-08-14T14:15:00+02:00",
      durationMinutes: 60,
      createdAt: Date.now(),
      updatedAt: Date.now() - 5_000,
      operation: "new_booking",
      selectedSlotEnd: "2026-08-14T15:15:00+02:00",
      ownedOfferedSlots: [ownedSlot(
        "2026-08-14T14:15:00+02:00",
        "2026-08-14T15:15:00+02:00",
      )],
      customerName: "Secret Customer Name",
      customerPhone: "+46709999999",
    });
    result = await postVerify(baseUrl, requestBody());
    assert.equal(result.json.result.available, false);
    assert.equal(result.json.result.category, "pending_conflict");
    assert.equal(result.json.evidence.pendingHoldCount, 1);

    priority1hUnifiedEngineTestBoundary.seedPending("non-overlap-raw-session", {
      businessId: "business-1",
      businessConfig,
      platform: "telegram",
      userId: "non-overlap-raw-user",
      status: "awaiting_contact",
      operation: "new_booking",
      dateTime: "2026-08-14T18:00:00+02:00",
      selectedSlotEnd: "2026-08-14T19:00:00+02:00",
      ownedOfferedSlots: [ownedSlot(
        "2026-08-14T18:00:00+02:00",
        "2026-08-14T19:00:00+02:00",
        "business-1",
        "non-overlap-raw-user",
      )],
      durationMinutes: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      customerName: "Non Overlap Secret",
      customerPhone: "+46708888888",
    });
    priority1hUnifiedEngineTestBoundary.seedPending("expired-raw-session", {
      businessId: "business-1",
      businessConfig,
      platform: "telegram",
      userId: "expired-raw-user",
      status: "awaiting_confirmation",
      operation: "new_booking",
      dateTime: "2026-08-14T14:30:00+02:00",
      selectedSlotEnd: "2026-08-14T15:30:00+02:00",
      ownedOfferedSlots: [ownedSlot(
        "2026-08-14T14:30:00+02:00",
        "2026-08-14T15:30:00+02:00",
        "business-1",
        "expired-raw-user",
      )],
      durationMinutes: 60,
      createdAt: Date.now() - 60 * 60 * 1000,
      updatedAt: Date.now() - 1_000,
      customerName: "Expired Secret",
      customerPhone: "+46707777777",
    });
    priority1hUnifiedEngineTestBoundary.seedPending("other-business-raw-session", {
      businessId: "business-2",
      businessConfig: { ...businessConfig, id: "business-2", businessRecordId: "business-2", business_id: "business-2" },
      platform: "telegram",
      userId: "other-business-raw-user",
      status: "awaiting_confirmation",
      operation: "new_booking",
      dateTime: "2026-08-14T14:15:00+02:00",
      selectedSlotEnd: "2026-08-14T15:15:00+02:00",
      ownedOfferedSlots: [ownedSlot(
        "2026-08-14T14:15:00+02:00",
        "2026-08-14T15:15:00+02:00",
        "business-2",
        "other-business-raw-user",
      )],
      durationMinutes: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      customerName: "Other Business Secret",
      customerPhone: "+46706666666",
    });

    const pendingBeforeInspection = {
      overlap: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("another-session"),
      nonOverlap: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("non-overlap-raw-session"),
      expired: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("expired-raw-session"),
      otherBusiness: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("other-business-raw-session"),
    };
    result = await postVerify(baseUrl, requestBody({
      operation: "availability.pending-blockers.inspect",
    }));
    assert.equal(result.response.status, 200);
    assert.equal(result.json.status, "inspected");
    assert.deepEqual(result.json.counts, {
      totalPendingRecordsInspected: 4,
      sameBusinessPendingCount: 3,
      activeBlockingPendingCount: 2,
      overlappingBlockerCount: 1,
    });
    assert.equal(result.json.pendingRecords.length, 3);
    assert.equal(result.json.overlappingBlockers.length, 1);
    const blocker = result.json.overlappingBlockers[0];
    assert.match(blocker.sessionFingerprint, /^[a-f0-9]{12}$/);
    assert.equal(blocker.businessId, "business-1");
    assert.equal(blocker.platform, "telegram");
    assert.equal(blocker.status, "awaiting_confirmation");
    assert.equal(blocker.operation, "new_booking");
    assert.equal(blocker.startTime, "2026-08-14T14:15:00+02:00");
    assert.equal(blocker.selectedEndTime, "2026-08-14T15:15:00+02:00");
    assert.equal(blocker.durationMinutes, 60);
    assert.equal(blocker.expired, false);
    assert.equal(blocker.blockingStatus, true);
    assert.equal(blocker.overlapsRequestedInterval, true);
    assert.equal(blocker.belongsToRequestingOwner, false);
    assert.equal(blocker.canonicalOverlappingBlocker, true);
    assert.equal(blocker.source, "in-memory");
    assert.equal(typeof blocker.ageMs, "number");
    assert.equal(typeof blocker.inactivityMs, "number");
    assert.equal(blocker.configuredTtlMs, 45 * 60 * 1000);

    const nonOverlap = result.json.pendingRecords.find((record: any) => record.startTime === "2026-08-14T18:00:00+02:00");
    assert.ok(nonOverlap);
    assert.equal(nonOverlap.activeBlockingPending, true);
    assert.equal(nonOverlap.overlapsRequestedInterval, false);
    assert.equal(nonOverlap.canonicalOverlappingBlocker, false);
    const expired = result.json.pendingRecords.find((record: any) => record.startTime === "2026-08-14T14:30:00+02:00");
    assert.ok(expired);
    assert.equal(expired.expired, true);
    assert.equal(expired.blockingStatus, true);
    assert.equal(expired.overlapsRequestedInterval, true);
    assert.equal(expired.activeBlockingPending, false);
    assert.equal(expired.canonicalOverlappingBlocker, false);

    const diagnosticText = JSON.stringify(result.json);
    for (const secret of [
      "another-session", "another-user", "Secret Customer Name", "+46709999999",
      "non-overlap-raw-session", "non-overlap-raw-user", "Non Overlap Secret", "+46708888888",
      "expired-raw-session", "expired-raw-user", "Expired Secret", "+46707777777",
      "other-business-raw-session", "other-business-raw-user", "Other Business Secret", "+46706666666",
      "business-2",
    ]) assert.equal(diagnosticText.includes(secret), false, `diagnostic leaked ${secret}`);
    assert.deepEqual(
      {
        overlap: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("another-session"),
        nonOverlap: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("non-overlap-raw-session"),
        expired: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("expired-raw-session"),
        otherBusiness: priority1hUnifiedEngineTestBoundary.pendingStateSnapshot("other-business-raw-session"),
      },
      pendingBeforeInspection,
      "pending inspection must not mutate in-memory state",
    );
    assert.equal(result.json.safety.pendingModified, false);

    result = await postVerify(baseUrl, requestBody({ time: "08:45" }));
    assert.equal(result.json.result.category, "outside_working_hours");
    result = await postVerify(baseUrl, requestBody({ time: "14:10" }));
    assert.equal(result.json.result.category, "invalid_interval");

    result = await postVerify(baseUrl, requestBody({ businessId: "missing-business" }));
    assert.equal(result.response.status, 404);
    assert.equal(result.json.category, "business_not_found");
    result = await postVerify(baseUrl, requestBody({ businessId: "" }));
    assert.equal(result.response.status, 400);
    assert.equal(result.json.status, "invalid_request");

    calendarReadError = new Error("provider credentials and private details");
    result = await postVerify(baseUrl, requestBody());
    assert.equal(result.response.status, 503);
    assert.equal(result.json.status, "inconclusive");
    assert.equal(result.json.category, "calendar_read_failure");
    assert.notEqual(result.json.result?.available, true);
    assert.equal(JSON.stringify(result.json).includes("credentials"), false);
    calendarReadError = null;

    assert.equal(mutationCount, 0, "the test bridge must never call calendar mutations");

    process.env.ODINLINK_TEST_BRIDGE_ENABLED = "false";
    const disabledVerify = await fetch(`${baseUrl}/api/test-bridge/v1/verify`, { method: "POST" });
    const disabledCapabilities = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`);
    assert.equal(disabledVerify.status, 404);
    assert.equal(disabledCapabilities.status, 404);
  });
} finally {
  delete process.env.ODINLINK_TEST_BRIDGE_ENABLED;
  delete process.env.ODINLINK_TEST_BRIDGE_TOKEN;
  priority1hUnifiedEngineTestBoundary.reset();
}

console.log("test bridge integration tests passed");
