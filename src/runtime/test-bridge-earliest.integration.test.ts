import assert from "node:assert/strict";
import express from "express";

process.env.NODE_ENV = "test";
process.env.ODINLINK_TEST_BRIDGE_ENABLED = "true";
process.env.ODINLINK_TEST_BRIDGE_TOKEN = "test-bridge-earliest-token-at-least-32-bytes";
const { createTestBridgeRouter, priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "earliest-business",
  businessRecordId: "earliest-business",
  business_id: "earliest-business",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
};
let calendarEvents: any[] = [];
let calendarReadError: Error | null = null;
let calendarMutationCount = 0;
let bookingMutationCount = 0;
let calendarReadCount = 0;

const adapter = {
  getEvents: async () => {
    calendarReadCount += 1;
    if (calendarReadError) throw calendarReadError;
    return structuredClone(calendarEvents);
  },
  checkSlots: () => ({ available_slots_string: "" }),
  insertAppointment: () => { calendarMutationCount += 1; return { success: true }; },
  updateAppointment: () => { calendarMutationCount += 1; return { success: true }; },
  cancelAppointment: () => { calendarMutationCount += 1; return { success: true }; },
};

function configure() {
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    loadBusinessConfigById: async (businessId: string) => businessId === businessConfig.id ? businessConfig : null,
    recordAppointment: async () => { bookingMutationCount += 1; return null; },
    testBridgeNow: () => Date.parse("2026-08-01T12:00:00.000Z"),
  });
  calendarEvents = [];
  calendarReadError = null;
  calendarReadCount = 0;
}

const event = (id: string, date: string, start: string, end: string) => ({
  id,
  summary: `private-${id}`,
  description: "secret provider payload",
  start: { dateTime: `${date}T${start}:00+02:00` },
  end: { dateTime: `${date}T${end}:00+02:00` },
});

const earliestBody = (overrides: Record<string, unknown> = {}) => ({
  operation: "availability.earliest.verify",
  businessId: businessConfig.id,
  startDate: "2026-09-07",
  endDate: "2026-09-07",
  durationMinutes: 60,
  channel: "telegram",
  userId: "raw-test-user",
  ...overrides,
});

async function withServer(run: (baseUrl: string) => Promise<void>) {
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

async function post(baseUrl: string, body: any) {
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

try {
  configure();
  await withServer(async baseUrl => {
    const capabilities = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`, {
      headers: { Authorization: `Bearer ${process.env.ODINLINK_TEST_BRIDGE_TOKEN}` },
    });
    assert.deepEqual((await capabilities.json()).operations, [
      "availability.verify",
      "availability.earliest.verify",
      "availability.pending-blockers.inspect",
      "test-execution.create",
      "test-execution.inspect",
    ]);

    // Same-day chronological ordering is independent of preferred afternoon ranking.
    calendarEvents = [event("morning-busy", "2026-09-07", "09:00", "11:00")];
    let result = await post(baseUrl, earliestBody({ constraints: { maxTime: "14:15" } }));
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.json.result, {
      available: true,
      earliestSlot: { date: "2026-09-07", time: "11:00" },
      category: "available",
    });
    assert.equal(calendarReadCount, 1, "one canonical snapshot is reused for the complete scan");
    const sanitizedResponse = JSON.stringify(result.json);
    for (const secret of ["raw-test-user", "morning-busy", "private-morning-busy", "secret provider payload"]) {
      assert.equal(sanitizedResponse.includes(secret), false, `earliest verification leaked ${secret}`);
    }

    // The complete range is searched and its exact boundaries are honored.
    calendarReadCount = 0;
    calendarEvents = [event("first-day-full", "2026-09-07", "09:00", "20:00")];
    result = await post(baseUrl, earliestBody({ endDate: "2026-09-08" }));
    assert.deepEqual(result.json.result.earliestSlot, { date: "2026-09-08", time: "09:00" });
    assert.equal(calendarReadCount, 1);

    // Calendar conflict advances to the next 15-minute candidate.
    calendarEvents = [event("first-quarter", "2026-09-07", "09:00", "09:15")];
    result = await post(baseUrl, earliestBody({ durationMinutes: 15 }));
    assert.equal(result.json.result.earliestSlot.time, "09:15");
    assert.equal(Number(result.json.result.earliestSlot.time.slice(3)) % 15, 0);

    // A legitimate pending claim blocks other owners; the exact same seeded state is not mutated.
    configure();
    const pendingSlot = {
      start: "2026-09-07T09:00:00+02:00",
      end: "2026-09-07T10:00:00+02:00",
      durationMinutes: 60,
      service: "",
      businessId: businessConfig.id,
      platform: "telegram",
      userId: "pending-owner",
      generatedAt: Date.now(),
    };
    boundary.seedPending("raw-pending-session", {
      businessId: businessConfig.id,
      businessConfig,
      platform: "telegram",
      userId: "pending-owner",
      sessionId: "raw-pending-session",
      status: "awaiting_confirmation",
      operation: "new_booking",
      dateTime: pendingSlot.start,
      selectedSlotEnd: pendingSlot.end,
      durationMinutes: 60,
      ownedOfferedSlots: [pendingSlot],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      customerName: "Secret Person",
      customerPhone: "+46700000000",
    });
    const pendingBefore = boundary.pendingStateSnapshot("raw-pending-session");
    result = await post(baseUrl, earliestBody());
    assert.deepEqual(result.json.result.earliestSlot, { date: "2026-09-07", time: "10:00" });
    assert.equal(result.json.evidence.pendingHoldCount, 1);
    assert.deepEqual(boundary.pendingStateSnapshot("raw-pending-session"), pendingBefore);
    assert.equal(JSON.stringify(result.json).includes("raw-pending-session"), false);
    assert.equal(JSON.stringify(result.json).includes("Secret Person"), false);

    // Expired state cannot hide the earliest candidate.
    boundary.seedPending("raw-pending-session", {
      ...pendingBefore,
      createdAt: Date.now() - 60 * 60 * 1000,
    });
    result = await post(baseUrl, earliestBody());
    assert.deepEqual(result.json.result.earliestSlot, { date: "2026-09-07", time: "09:00" });
    assert.equal(result.json.evidence.pendingHoldCount, 0);

    // No valid slot in the full range is distinct from provider failure.
    configure();
    calendarEvents = [
      event("full-one", "2026-09-07", "09:00", "20:00"),
      event("full-two", "2026-09-08", "09:00", "20:00"),
    ];
    result = await post(baseUrl, earliestBody({ endDate: "2026-09-08" }));
    assert.deepEqual(result.json.result, { available: false, earliestSlot: null, category: "none_available" });

    // Full duration, working hours, interval, safe constraints, and post-validation ranking.
    calendarEvents = [event("starts-at-ten", "2026-09-07", "10:00", "19:00")];
    result = await post(baseUrl, earliestBody({ durationMinutes: 60, constraints: { minTime: "09:00", maxTime: "09:00" } }));
    assert.equal(result.json.result.earliestSlot.time, "09:00");
    result = await post(baseUrl, earliestBody({ durationMinutes: 75, constraints: { minTime: "09:00", maxTime: "09:00" } }));
    assert.equal(result.json.result.earliestSlot, null);
    result = await post(baseUrl, earliestBody({ durationMinutes: 30, constraints: { beforeTime: "09:00" } }));
    assert.equal(result.json.result.earliestSlot, null);
    result = await post(baseUrl, earliestBody({ durationMinutes: 15, constraints: { daypart: "evening", excludedTimes: ["19:00"] } }));
    assert.equal(result.json.result.earliestSlot.time, "19:15");

    calendarEvents = [event("many-leading-blockers", "2026-09-07", "09:00", "14:00")];
    result = await post(baseUrl, earliestBody({ durationMinutes: 15 }));
    assert.equal(result.json.result.earliestSlot.time, "14:00", "candidates are not truncated before validation");

    result = await post(baseUrl, earliestBody({ constraints: { unsupportedPreference: "afternoon" } }));
    assert.equal(result.response.status, 400);
    assert.equal(result.json.category, "invalid_request");
    result = await post(baseUrl, earliestBody({ constraints: { afterTime: "10:00", beforeTime: "12:00" } }));
    assert.equal(result.response.status, 400);

    // Existing exact-slot behavior, including the known calendar conflict, remains canonical.
    calendarEvents = [event("known-conflict", "2026-08-14", "14:00", "15:00")];
    result = await post(baseUrl, {
      operation: "availability.verify",
      businessId: businessConfig.id,
      date: "2026-08-14",
      time: "14:15",
      durationMinutes: 60,
      channel: "telegram",
      userId: "raw-test-user",
    });
    assert.equal(result.json.result.category, "calendar_conflict");

    calendarReadError = new Error("credentials secret provider failure");
    result = await post(baseUrl, earliestBody());
    assert.equal(result.response.status, 503);
    assert.equal(result.json.status, "inconclusive");
    assert.equal(result.json.category, "calendar_read_failure");
    assert.equal(result.json.result, undefined);
    assert.equal(JSON.stringify(result.json).includes("credentials"), false);

    assert.equal(calendarMutationCount, 0);
    assert.equal(bookingMutationCount, 0);

    process.env.ODINLINK_TEST_BRIDGE_ENABLED = "false";
    const disabled = await fetch(`${baseUrl}/api/test-bridge/v1/verify`, { method: "POST" });
    assert.equal(disabled.status, 404);
  });
} finally {
  delete process.env.ODINLINK_TEST_BRIDGE_ENABLED;
  delete process.env.ODINLINK_TEST_BRIDGE_TOKEN;
  boundary.reset();
}

console.log("test bridge earliest availability integration tests passed");
