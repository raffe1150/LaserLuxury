import assert from "node:assert/strict";
import express from "express";
import type { StoredTestExecution, TestExecutionStore } from "./test-bridge-security";

process.env.NODE_ENV = "test";
const TOKEN = "dedicated-test-bridge-security-token-32-bytes-minimum";
const { createTestBridgeRouter, priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const records = new Map<string, StoredTestExecution>();
let nowMs = Date.parse("2026-08-15T12:00:00.000Z");
let calendarMutationCount = 0;
let bookingMutationCount = 0;

function durableStore(): TestExecutionStore {
  return {
    async create(record) {
      if (records.has(record.idHash)) return false;
      records.set(record.idHash, structuredClone(record));
      return true;
    },
    async get(idHash) {
      const record = records.get(idHash);
      return record ? structuredClone(record) : null;
    },
    async update(record) {
      if (!records.has(record.idHash)) return false;
      records.set(record.idHash, structuredClone(record));
      return true;
    },
    async findByScopeAndCreatedAt(params) {
      return [...records.values()]
        .filter(record =>
          record.businessId === params.scope.businessId &&
          record.channel === params.scope.channel &&
          record.ownerId === params.scope.ownerId &&
          record.createdAt >= params.createdAfterMs &&
          record.createdAt <= params.createdBeforeMs
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, params.limit)
        .map(record => structuredClone(record));
    },
  };
}

const businessConfig = {
  id: "security-business",
  businessRecordId: "security-business",
  business_id: "security-business",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
};

const adapter = {
  getEvents: async () => [],
  checkSlots: () => ({ available_slots_string: "" }),
  insertAppointment: () => { calendarMutationCount += 1; return { success: true }; },
  updateAppointment: () => { calendarMutationCount += 1; return { success: true }; },
  cancelAppointment: () => { calendarMutationCount += 1; return { success: true }; },
};

function configure(store: TestExecutionStore | null = durableStore()) {
  boundary.reset();
  boundary.configure({
    calendarAdapter: adapter,
    loadBusinessConfigById: async (businessId: string) =>
      businessId === businessConfig.id ? businessConfig : null,
    recordAppointment: async () => { bookingMutationCount += 1; return null; },
    testExecutionStore: store,
    testBridgeNow: () => nowMs,
  });
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.get("/normal-health", (_req, res) => res.status(200).json({ ok: true }));
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
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

const authHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
});

async function createExecution(baseUrl: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/api/test-bridge/v1/executions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      businessId: businessConfig.id,
      channel: "telegram",
      userId: "tg_scope-owner",
      ...body,
    }),
  });
  return { response, json: await response.json().catch(() => null) };
}

function inspectUrl(baseUrl: string, executionId: string, scope: Record<string, string> = {}) {
  const query = new URLSearchParams({
    businessId: businessConfig.id,
    channel: "telegram",
    userId: "scope-owner",
    ...scope,
  });
  return `${baseUrl}/api/test-bridge/v1/executions/${executionId}?${query}`;
}

try {
  configure();
  await withServer(async baseUrl => {
    process.env.ODINLINK_TEST_BRIDGE_ENABLED = "false";
    process.env.ODINLINK_TEST_BRIDGE_TOKEN = TOKEN;
    let response = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`, { headers: authHeaders() });
    assert.equal(response.status, 404, "disabled bridge must fail closed before authentication");

    process.env.ODINLINK_TEST_BRIDGE_ENABLED = "true";
    delete process.env.ODINLINK_TEST_BRIDGE_TOKEN;
    response = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`);
    assert.equal(response.status, 503, "missing server token configuration must fail closed");

    process.env.ODINLINK_TEST_BRIDGE_TOKEN = TOKEN;
    response = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`);
    assert.equal(response.status, 401);
    response = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`, {
      headers: { Authorization: "Bearer definitely-the-wrong-credential" },
    });
    assert.equal(response.status, 401);

    response = await fetch(`${baseUrl}/api/test-bridge/v1/capabilities`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const capabilities = await response.json();
    assert.deepEqual(capabilities.authentication, { required: true, scheme: "bearer" });
    assert.equal(capabilities.executionProvenance.schemaVersion, "odinlink-test-execution-v1");
    assert.equal(capabilities.executionProvenance.durable, true);
    assert.equal(capabilities.executionProvenance.survivesRestart, true);
    assert.equal(capabilities.executionProvenance.testMetadataWrites, true);
    assert.equal(capabilities.executionProvenance.cleanupSupported, false);
    assert.deepEqual(capabilities.executionProvenance.operations, [
      "test-execution.create",
      "test-execution.inspect",
    ]);
    assert.equal(JSON.stringify(capabilities).toLowerCase().includes("booking.cleanup"), false);
    assert.equal(JSON.stringify(capabilities).includes(TOKEN), false);

    response = await fetch(`${baseUrl}/normal-health`);
    assert.equal(response.status, 200, "normal routes must not require Test Bridge authentication");

    const callerChosen = await createExecution(baseUrl, { executionId: "caller-chosen" });
    assert.equal(callerChosen.response.status, 400);

    const first = await createExecution(baseUrl);
    const second = await createExecution(baseUrl);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.match(first.json.execution.executionId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(second.json.execution.executionId, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.json.execution.executionId, second.json.execution.executionId);
    assert.equal(first.json.execution.businessId, businessConfig.id);
    assert.equal(first.json.execution.channel, "telegram");
    assert.match(first.json.execution.ownerFingerprint, /^[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(first.json).includes("scope-owner"), false);
    assert.equal(JSON.stringify(first.json).includes(TOKEN), false);

    const stored = [...records.values()].find(record =>
      record.businessId === businessConfig.id && record.channel === "telegram" && record.ownerId === "scope-owner");
    assert.ok(stored, "durable execution must use canonical scope fields");
    assert.equal(JSON.stringify(stored).includes(first.json.execution.executionId), false,
      "durable execution must not store its raw opaque ID");

    configure(durableStore());
    response = await fetch(inspectUrl(baseUrl, first.json.execution.executionId), { headers: authHeaders() });
    assert.equal(response.status, 200, "execution remains inspectable through a fresh store adapter");
    const inspection = await response.json();
    assert.equal(inspection.status, "active");
    assert.equal(inspection.execution.businessId, businessConfig.id);
    assert.equal(inspection.execution.channel, "telegram");
    assert.match(inspection.execution.executionFingerprint, /^[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(inspection).includes(first.json.execution.executionId), false);
    assert.equal(JSON.stringify(inspection).includes("scope-owner"), false);

    response = await fetch(inspectUrl(baseUrl, "A".repeat(43)), { headers: authHeaders() });
    assert.equal(response.status, 404, "unknown execution must fail closed");

    for (const scope of [
      { businessId: "another-business" },
      { channel: "messenger" },
      { userId: "another-owner" },
    ]) {
      response = await fetch(inspectUrl(baseUrl, first.json.execution.executionId, scope), { headers: authHeaders() });
      assert.equal(response.status, 403, "execution scope mismatch must fail closed");
    }

    response = await fetch(inspectUrl(baseUrl, first.json.execution.executionId));
    assert.equal(response.status, 401, "execution ID alone must not authenticate a bridge caller");

    nowMs = Date.parse(first.json.execution.expiresAt) + 1;
    response = await fetch(inspectUrl(baseUrl, first.json.execution.executionId), { headers: authHeaders() });
    assert.equal(response.status, 410, "expired execution must fail closed");
    assert.equal((await response.json()).category, "execution_expired");
    assert.equal([...records.values()].find(record => record.idHash === stored.idHash)?.status, "expired");

    configure(null);
    const unavailable = await createExecution(baseUrl);
    assert.equal(unavailable.response.status, 503, "execution creation requires durable storage");

    assert.equal(calendarMutationCount, 0);
    assert.equal(bookingMutationCount, 0);
  });
} finally {
  delete process.env.ODINLINK_TEST_BRIDGE_ENABLED;
  delete process.env.ODINLINK_TEST_BRIDGE_TOKEN;
  boundary.reset();
}

console.log("test bridge security and execution provenance integration tests passed");
