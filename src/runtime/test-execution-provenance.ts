import crypto from "node:crypto";
import {
  type TestExecutionScope,
  type TestExecutionStore,
} from "./test-bridge-security";

export const TEST_EXECUTION_PROVENANCE_SCHEMA_VERSION =
  "odinlink-test-execution-provenance-v1";
export const TEST_EXECUTION_CORRELATION_MAX_AGE_ENV =
  "ODINLINK_TEST_EXECUTION_CORRELATION_MAX_AGE_MS";
export const DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS = 10 * 60 * 1000;
const MIN_TEST_EXECUTION_CORRELATION_MAX_AGE_MS = 60 * 1000;
const MAX_TEST_EXECUTION_CORRELATION_MAX_AGE_MS = 30 * 60 * 1000;

export type ValidatedTestExecutionContext = Readonly<{
  testExecutionFingerprint: string;
  correlationMethod: "inferred_scope_time";
}>;

export type TestExecutionResourceProvenance = Readonly<{
  type: "test_execution_provenance";
  schemaVersion: typeof TEST_EXECUTION_PROVENANCE_SCHEMA_VERSION;
  testExecutionFingerprint: string;
  resourceType: "appointment";
  resourceId: string;
  businessId: string;
  channel: string;
  correlationMethod: "inferred_scope_time";
}>;

export interface TestExecutionResourceProvenanceStore {
  attach(record: TestExecutionResourceProvenance): Promise<boolean>;
}

export function getTestExecutionCorrelationMaxAgeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawConfigured = String(env[TEST_EXECUTION_CORRELATION_MAX_AGE_ENV] || "").trim();
  if (!rawConfigured) return DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS;
  const configured = Number(rawConfigured);
  if (!Number.isFinite(configured)) {
    return DEFAULT_TEST_EXECUTION_CORRELATION_MAX_AGE_MS;
  }
  return Math.min(
    MAX_TEST_EXECUTION_CORRELATION_MAX_AGE_MS,
    Math.max(MIN_TEST_EXECUTION_CORRELATION_MAX_AGE_MS, Math.trunc(configured)),
  );
}

export async function resolveInferredTestExecutionContext(params: {
  scope: TestExecutionScope;
  store: TestExecutionStore | null;
  appointmentCreatedAtMs: number;
  lookupAtMs: number;
  maxAgeMs?: number;
}): Promise<ValidatedTestExecutionContext | null> {
  if (
    !params.store ||
    !params.scope.businessId ||
    !params.scope.channel ||
    !params.scope.ownerId ||
    !Number.isFinite(params.appointmentCreatedAtMs) ||
    !Number.isFinite(params.lookupAtMs) ||
    params.lookupAtMs < params.appointmentCreatedAtMs
  ) return null;

  const maxAgeMs = params.maxAgeMs ?? getTestExecutionCorrelationMaxAgeMs();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null;

  let records;
  try {
    records = await params.store.findByScopeAndCreatedAt({
      scope: params.scope,
      createdAfterMs: params.appointmentCreatedAtMs - maxAgeMs,
      createdBeforeMs: params.appointmentCreatedAtMs,
      limit: 2,
    });
  } catch {
    return null;
  }

  if (!Array.isArray(records) || records.length !== 1) return null;
  const record = records[0];
  if (
    !record ||
    record.type !== "test_execution" ||
    record.schemaVersion !== "odinlink-test-execution-v1" ||
    !/^[a-f0-9]{64}$/.test(String(record.idHash || "")) ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= record.createdAt ||
    record.status !== "active" ||
    record.expiresAt <= params.appointmentCreatedAtMs ||
    record.expiresAt <= params.lookupAtMs ||
    record.createdAt > params.appointmentCreatedAtMs ||
    record.createdAt < params.appointmentCreatedAtMs - maxAgeMs ||
    record.businessId !== params.scope.businessId ||
    record.channel !== params.scope.channel ||
    record.ownerId !== params.scope.ownerId
  ) {
    return null;
  }

  return Object.freeze({
    testExecutionFingerprint: record.idHash,
    correlationMethod: "inferred_scope_time",
  });
}

function provenanceStorageId(record: TestExecutionResourceProvenance): string {
  const resourceFingerprint = crypto
    .createHash("sha256")
    .update(`${record.resourceType}:${record.resourceId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `tbprov_${record.testExecutionFingerprint.slice(0, 32)}_${resourceFingerprint}`;
}

export function createSupabaseTestExecutionResourceProvenanceStore(
  client: any,
): TestExecutionResourceProvenanceStore {
  return {
    async attach(record) {
      const { error } = await client.from("appointments_leads").insert([{
        user_id: provenanceStorageId(record),
        platform: `test_provenance:${record.channel}:${record.resourceType}`,
        business_id: record.businessId,
        ai_summary: JSON.stringify(record),
      }]);
      if (!error) return true;
      if (
        String(error.code || "") === "23505" ||
        String(error.message || "").toLowerCase().includes("duplicate")
      ) {
        return true;
      }
      throw new Error("test_execution_provenance_storage_failed");
    },
  };
}

export async function attachTestExecutionResourceProvenance(params: {
  context?: ValidatedTestExecutionContext | null;
  store: TestExecutionResourceProvenanceStore | null;
  resourceType: "appointment";
  resourceId: unknown;
  businessId: unknown;
  channel: unknown;
}): Promise<boolean> {
  const resourceId = String(params.resourceId || "").trim();
  const businessId = String(params.businessId || "").trim();
  const channel = String(params.channel || "").trim();
  if (!params.context || !params.store || !resourceId || !businessId || !channel) {
    return false;
  }

  const record: TestExecutionResourceProvenance = Object.freeze({
    type: "test_execution_provenance",
    schemaVersion: TEST_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    testExecutionFingerprint: params.context.testExecutionFingerprint,
    resourceType: params.resourceType,
    resourceId,
    businessId,
    channel,
    correlationMethod: params.context.correlationMethod,
  });
  try {
    return await params.store.attach(record);
  } catch {
    // Provenance is non-authoritative sidecar metadata and cannot affect booking success.
    return false;
  }
}
