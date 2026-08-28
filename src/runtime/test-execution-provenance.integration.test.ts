import assert from "node:assert/strict";
import {
  DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
  getTestExecutionCorrelationMaxAgeMs,
  resolveInferredTestExecutionContext,
  type TestExecutionResourceProvenance,
  type TestExecutionResourceProvenanceStore,
} from "./test-execution-provenance";
import type {
  StoredTestExecution,
  TestExecutionScope,
  TestExecutionStore,
} from "./test-bridge-security";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const appointmentCreatedAtMs = Date.parse("2026-08-21T10:00:00.000Z");
const lookupAtMs = appointmentCreatedAtMs + 1_000;
const scope: TestExecutionScope = {
  businessId: "7",
  channel: "whatsapp",
  ownerId: "46700000123",
};

function execution(
  suffix: string,
  overrides: Partial<StoredTestExecution> = {},
): StoredTestExecution {
  return {
    type: "test_execution",
    schemaVersion: "odinlink-test-execution-v1",
    idHash: suffix.repeat(64).slice(0, 64),
    ...scope,
    createdAt: appointmentCreatedAtMs - 60_000,
    expiresAt: appointmentCreatedAtMs + 60_000,
    status: "active",
    ...overrides,
  };
}

function executionStore(
  candidates: StoredTestExecution[],
  options: { queryFailure?: boolean } = {},
): TestExecutionStore {
  return {
    async create() { return true; },
    async get() { return null; },
    async update() { return true; },
    async findByScopeAndCreatedAt() {
      if (options.queryFailure) throw new Error("injected_scope_query_failure");
      return structuredClone(candidates.slice(0, 2));
    },
  };
}

assert.equal(
  getTestExecutionCorrelationMaxAgeMs({} as NodeJS.ProcessEnv),
  DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
);
assert.equal(getTestExecutionCorrelationMaxAgeMs({
  ODINLINK_TEST_EXECUTION_CORRELATION_MAX_AGE_MS: "1",
} as NodeJS.ProcessEnv), 60_000, "correlation window has a narrow lower clamp");
assert.equal(getTestExecutionCorrelationMaxAgeMs({
  ODINLINK_TEST_EXECUTION_CORRELATION_MAX_AGE_MS: "99999999",
} as NodeJS.ProcessEnv), 30 * 60_000, "correlation window has a narrow upper clamp");

const unique = execution("a");
let capturedQuery: Parameters<TestExecutionStore["findByScopeAndCreatedAt"]>[0] | null = null;
const boundedStore = executionStore([unique]);
const findBounded = boundedStore.findByScopeAndCreatedAt.bind(boundedStore);
boundedStore.findByScopeAndCreatedAt = async (params) => {
  capturedQuery = structuredClone(params);
  return findBounded(params);
};
const inferred = await resolveInferredTestExecutionContext({
  scope,
  store: boundedStore,
  appointmentCreatedAtMs,
  lookupAtMs,
  maxAgeMs: DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
});
assert.deepEqual(capturedQuery, {
  scope,
  createdAfterMs: appointmentCreatedAtMs - DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
  createdBeforeMs: appointmentCreatedAtMs,
  limit: 2,
}, "correlation uses one exact bounded scope/time query");
assert.deepEqual(inferred, {
  testExecutionFingerprint: unique.idHash,
  correlationMethod: "inferred_scope_time",
});
assert.equal(Object.isFrozen(inferred), true);

for (const [label, candidates] of [
  ["zero candidates", []],
  ["overlapping candidates", [unique, execution("b")]],
  ["expired at booking", [execution("c", { expiresAt: appointmentCreatedAtMs })]],
  ["expired at lookup", [execution("d", { expiresAt: lookupAtMs })]],
  ["stale", [execution("e", {
    createdAt: appointmentCreatedAtMs - DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS - 1,
  })]],
  ["created after appointment", [execution("f", { createdAt: appointmentCreatedAtMs + 1 })]],
  ["malformed record", [execution("a", { idHash: "malformed" })]],
  ["business mismatch", [execution("1", { businessId: "8" })]],
  ["channel mismatch", [execution("2", { channel: "telegram" })]],
  ["owner mismatch", [execution("3", { ownerId: "another-owner" })]],
] as const) {
  assert.equal(await resolveInferredTestExecutionContext({
    scope,
    store: executionStore([...candidates]),
    appointmentCreatedAtMs,
    lookupAtMs,
    maxAgeMs: DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
  }), null, `${label} fails closed`);
}

assert.equal(await resolveInferredTestExecutionContext({
  scope,
  store: executionStore([], { queryFailure: true }),
  appointmentCreatedAtMs,
  lookupAtMs,
}), null, "query failure fails closed");

type BookingRun = {
  replies: string[][];
  appointmentInput: any;
  createdStart: string;
  availabilityReads: number;
  attachments: TestExecutionResourceProvenance[];
  completed: boolean;
};

const businessConfig = {
  id: "7",
  businessName: "Test Clinic",
  timezone: "Europe/Stockholm",
  defaultBookingService: "Konsultation",
  calendarProvider: "custom",
  googleCalendarId: "cal-7",
};

async function runBooking(options: {
  candidates?: StoredTestExecution[];
  queryFailure?: boolean;
  noStore?: boolean;
  provenanceStore?: TestExecutionResourceProvenanceStore;
} = {}): Promise<BookingRun> {
  boundary.reset();
  const events = new Map<string, any>();
  const attachments: TestExecutionResourceProvenance[] = [];
  let availabilityReads = 0;
  let appointmentInput: any = null;
  let createdStart = "";
  const provenanceStore = options.provenanceStore || {
    async attach(record: TestExecutionResourceProvenance) {
      attachments.push(structuredClone(record));
      return true;
    },
  };
  const adapter = {
    getCalendarId: () => "cal-7",
    getEvents: async () => { availabilityReads += 1; return [...events.values()]; },
    checkSlots: async () => ({ available_slots_string: "" }),
    insertAppointment: async (
      name: string,
      phone: string,
      service: string,
      dateTime: string,
      duration = 30,
      marker = "",
    ) => {
      createdStart = new Date(dateTime).toISOString();
      const userId = marker.replace(/^(?:wa_|tg_|ig_|ms_)/, "");
      const event = {
        id: "event-1",
        status: "confirmed",
        summary: `Bokad: ${name} - ${phone}`,
        start: { dateTime: createdStart },
        end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
        extendedProperties: {
          private: { platform: "whatsapp", userId, businessId: "7" },
        },
        description: `BusinessId: 7\nPlatform: whatsapp\nUserId: ${userId}`,
      };
      events.set(event.id, event);
      return { success: true, event };
    },
    getEventById: async (eventId: string) => events.get(eventId) || null,
    cancelAppointment: async (eventId: string) => {
      events.delete(eventId);
      return { success: true };
    },
    verifyEventDeleted: async (eventId: string) => !events.has(eventId),
  };
  boundary.configure({
    calendarAdapter: adapter,
    testExecutionStore: options.noStore
      ? null
      : executionStore(options.candidates || [], { queryFailure: options.queryFailure }),
    testExecutionProvenanceStore: provenanceStore,
    testBridgeNow: () => lookupAtMs,
    recordAppointment: async (params: any) => {
      appointmentInput = structuredClone(params);
      const start = new Date(params.dateTime).toISOString();
      return {
        id: 1,
        business_id: "7",
        platform: params.platform,
        user_id: String(params.userId),
        service: params.service,
        start_time: start,
        end_time: new Date(new Date(start).getTime() + Number(params.durationMinutes) * 60_000).toISOString(),
        status: "booked",
        created_at: new Date(appointmentCreatedAtMs).toISOString(),
      };
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    claimOperation: async (params: any) => ({
      claimed: true,
      keyHash: `${params.type}:${params.exactId}`,
      storageId: `${params.type}:${params.exactId}`,
      state: { type: params.type, status: "processing", attempts: 1, claimedAt: lookupAtMs, updatedAt: lookupAtMs },
    }),
    settleOperation: async () => true,
  });

  const turn = (text: string) => boundary.turn({
    sessionId: "wa_46700000123",
    platformName: "whatsapp",
    recipientUserId: "46700000123",
    text,
    businessConfig,
    now: new Date(appointmentCreatedAtMs),
  });
  const first = await turn("Book a consultation next Friday at 14:00");
  const second = await turn("Yes, book that time");
  const completed = await turn("Arman");
  return {
    replies: [first.replies, second.replies, completed.replies],
    appointmentInput,
    createdStart,
    availabilityReads,
    attachments,
    completed: completed.pending === null && Boolean(appointmentInput),
  };
}

try {
  const production = await runBooking({ noStore: true });
  const attributed = await runBooking({ candidates: [unique] });
  const ambiguous = await runBooking({ candidates: [unique, execution("b")] });
  const queryFailure = await runBooking({ queryFailure: true });

  assert.equal(production.completed, true);
  assert.equal(attributed.completed, true);
  assert.equal(ambiguous.completed, true);
  assert.equal(queryFailure.completed, true, "query failure cannot fail the booking");
  assert.deepEqual(attributed.replies, production.replies);
  assert.deepEqual(ambiguous.replies, production.replies);
  assert.deepEqual(queryFailure.replies, production.replies);
  assert.deepEqual(attributed.appointmentInput, production.appointmentInput,
    "normal appointment resource is unchanged");
  assert.equal(attributed.createdStart, production.createdStart,
    "slot selection is unchanged");
  assert.equal(attributed.availabilityReads, production.availabilityReads,
    "availability behavior is unchanged");
  assert.equal(production.attachments.length, 0);
  assert.equal(attributed.attachments.length, 1,
    "exactly one valid execution attaches provenance");
  assert.equal(ambiguous.attachments.length, 0,
    "overlapping executions are ambiguous and attach nothing");
  assert.equal(queryFailure.attachments.length, 0);
  assert.deepEqual(attributed.attachments[0], {
    type: "test_execution_provenance",
    schemaVersion: "odinlink-test-execution-provenance-v1",
    testExecutionFingerprint: unique.idHash,
    resourceType: "appointment",
    resourceId: "1",
    businessId: "7",
    channel: "whatsapp",
    correlationMethod: "inferred_scope_time",
  });
} finally {
  boundary.reset();
}

console.log("inferred test execution provenance integration tests passed");
