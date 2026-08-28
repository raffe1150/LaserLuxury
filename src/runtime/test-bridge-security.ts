import crypto from "node:crypto";

export const TEST_BRIDGE_TOKEN_ENV = "ODINLINK_TEST_BRIDGE_TOKEN";
export const TEST_EXECUTION_TTL_ENV = "ODINLINK_TEST_EXECUTION_TTL_MS";
export const TEST_EXECUTION_SCHEMA_VERSION = "odinlink-test-execution-v1";
export const DEFAULT_TEST_EXECUTION_TTL_MS = 30 * 60 * 1000;
const MINIMUM_TEST_BRIDGE_TOKEN_BYTES = 32;
const MINIMUM_TEST_EXECUTION_TTL_MS = 60 * 1000;
const MAXIMUM_TEST_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;
const BEARER_TOKEN = /^Bearer\s+([^\s]+)$/i;
const EXECUTION_ID = /^[A-Za-z0-9_-]{43}$/;

export type TestExecutionStatus = "active" | "expired" | "completed";

export type TestExecutionScope = {
  businessId: string;
  channel: string;
  ownerId: string;
};

export type StoredTestExecution = TestExecutionScope & {
  type: "test_execution";
  schemaVersion: typeof TEST_EXECUTION_SCHEMA_VERSION;
  idHash: string;
  createdAt: number;
  expiresAt: number;
  status: TestExecutionStatus;
};

export interface TestExecutionStore {
  create(record: StoredTestExecution): Promise<boolean>;
  get(idHash: string): Promise<StoredTestExecution | null>;
  update(record: StoredTestExecution): Promise<boolean>;
  findByScopeAndCreatedAt(params: {
    scope: TestExecutionScope;
    createdAfterMs: number;
    createdBeforeMs: number;
    limit: 2;
  }): Promise<StoredTestExecution[]>;
}

export type TestBridgeAuthenticationResult =
  | { authorized: true }
  | { authorized: false; category: "authentication_configuration_error" | "authentication_failed" };

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

export function authenticateTestBridgeRequest(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TestBridgeAuthenticationResult {
  const configuredToken = String(env[TEST_BRIDGE_TOKEN_ENV] || "");
  if (
    !configuredToken ||
    Buffer.byteLength(configuredToken, "utf8") < MINIMUM_TEST_BRIDGE_TOKEN_BYTES
  ) {
    return { authorized: false, category: "authentication_configuration_error" };
  }

  const match = BEARER_TOKEN.exec(String(authorization || ""));
  if (!match) return { authorized: false, category: "authentication_failed" };

  const suppliedDigest = sha256(match[1]);
  const configuredDigest = sha256(configuredToken);
  return crypto.timingSafeEqual(suppliedDigest, configuredDigest)
    ? { authorized: true }
    : { authorized: false, category: "authentication_failed" };
}

export function getTestExecutionTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawConfigured = String(env[TEST_EXECUTION_TTL_ENV] || "").trim();
  if (!rawConfigured) return DEFAULT_TEST_EXECUTION_TTL_MS;
  const configured = Number(rawConfigured);
  if (!Number.isFinite(configured)) return DEFAULT_TEST_EXECUTION_TTL_MS;
  return Math.min(
    MAXIMUM_TEST_EXECUTION_TTL_MS,
    Math.max(MINIMUM_TEST_EXECUTION_TTL_MS, Math.trunc(configured)),
  );
}

export function isValidTestExecutionId(value: unknown): value is string {
  return typeof value === "string" && EXECUTION_ID.test(value);
}

export function hashTestExecutionId(executionId: string): string {
  return sha256(executionId).toString("hex");
}

export function testExecutionStorageId(idHash: string): string {
  return `tbexec_${idHash.slice(0, 48)}`;
}

function testExecutionOwnerScopeHash(ownerId: string): string {
  return sha256(ownerId).toString("hex").slice(0, 24);
}

export function testExecutionScopePlatform(scope: TestExecutionScope): string {
  return `test_execution:${scope.channel}:${testExecutionOwnerScopeHash(scope.ownerId)}`;
}

export function testExecutionFingerprintFromHash(idHash: string): string {
  return idHash.slice(0, 12);
}

export function createTestExecutionRecord(params: {
  scope: TestExecutionScope;
  nowMs: number;
  ttlMs: number;
}): { executionId: string; record: StoredTestExecution } {
  const executionId = crypto.randomBytes(32).toString("base64url");
  const idHash = hashTestExecutionId(executionId);
  return {
    executionId,
    record: {
      type: "test_execution",
      schemaVersion: TEST_EXECUTION_SCHEMA_VERSION,
      idHash,
      businessId: params.scope.businessId,
      channel: params.scope.channel,
      ownerId: params.scope.ownerId,
      createdAt: params.nowMs,
      expiresAt: params.nowMs + params.ttlMs,
      status: "active",
    },
  };
}

export function parseStoredTestExecution(value: unknown): StoredTestExecution | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.type !== "test_execution" ||
      parsed.schemaVersion !== TEST_EXECUTION_SCHEMA_VERSION ||
      !/^[a-f0-9]{64}$/.test(String(parsed.idHash || "")) ||
      !String(parsed.businessId || "") ||
      !String(parsed.channel || "") ||
      !String(parsed.ownerId || "") ||
      !Number.isFinite(Number(parsed.createdAt)) ||
      !Number.isFinite(Number(parsed.expiresAt)) ||
      Number(parsed.expiresAt) <= Number(parsed.createdAt) ||
      !["active", "expired", "completed"].includes(String(parsed.status || ""))
    ) return null;

    return {
      type: "test_execution",
      schemaVersion: TEST_EXECUTION_SCHEMA_VERSION,
      idHash: String(parsed.idHash),
      businessId: String(parsed.businessId),
      channel: String(parsed.channel),
      ownerId: String(parsed.ownerId),
      createdAt: Number(parsed.createdAt),
      expiresAt: Number(parsed.expiresAt),
      status: parsed.status as TestExecutionStatus,
    };
  } catch {
    return null;
  }
}

export function createSupabaseTestExecutionStore(client: any): TestExecutionStore {
  return {
    async create(record) {
      const { error } = await client.from("appointments_leads").insert([{
        user_id: testExecutionStorageId(record.idHash),
        platform: testExecutionScopePlatform(record),
        business_id: record.businessId,
        ai_summary: JSON.stringify(record),
      }]);
      if (!error) return true;
      if (String(error.code || "") === "23505" || String(error.message || "").toLowerCase().includes("duplicate")) {
        return false;
      }
      throw new Error("test_execution_storage_create_failed");
    },

    async get(idHash) {
      const { data, error } = await client
        .from("appointments_leads")
        .select("user_id,platform,business_id,ai_summary")
        .eq("user_id", testExecutionStorageId(idHash))
        .maybeSingle();
      if (error) throw new Error("test_execution_storage_read_failed");
      if (!data) return null;
      const record = parseStoredTestExecution(data.ai_summary);
      if (
        !record ||
        record.idHash !== idHash ||
        String(data.business_id || "") !== record.businessId ||
        ![
          `test_execution:${record.channel}`,
          testExecutionScopePlatform(record),
        ].includes(String(data.platform || ""))
      ) return null;
      return record;
    },

    async update(record) {
      const { data, error } = await client
        .from("appointments_leads")
        .update({ ai_summary: JSON.stringify(record) })
        .eq("user_id", testExecutionStorageId(record.idHash))
        .eq("business_id", record.businessId)
        .in("platform", [
          `test_execution:${record.channel}`,
          testExecutionScopePlatform(record),
        ])
        .select("user_id")
        .maybeSingle();
      if (error) throw new Error("test_execution_storage_update_failed");
      return data?.user_id === testExecutionStorageId(record.idHash);
    },

    async findByScopeAndCreatedAt(params) {
      const { data, error } = await client
        .from("appointments_leads")
        .select("user_id,platform,business_id,ai_summary,created_at")
        .eq("business_id", params.scope.businessId)
        .eq("platform", testExecutionScopePlatform(params.scope))
        .gte("created_at", new Date(params.createdAfterMs).toISOString())
        .lte("created_at", new Date(params.createdBeforeMs).toISOString())
        .order("created_at", { ascending: false })
        .limit(params.limit);
      if (error) throw new Error("test_execution_scope_query_failed");
      if (!Array.isArray(data)) throw new Error("test_execution_scope_query_invalid");

      return data.map((row: any) => {
        const record = parseStoredTestExecution(row?.ai_summary);
        const rowCreatedAt = Date.parse(String(row?.created_at || ""));
        if (
          !record ||
          String(row?.business_id || "") !== params.scope.businessId ||
          String(row?.platform || "") !== testExecutionScopePlatform(params.scope) ||
          record.businessId !== params.scope.businessId ||
          record.channel !== params.scope.channel ||
          record.ownerId !== params.scope.ownerId ||
          !Number.isFinite(rowCreatedAt) ||
          rowCreatedAt < params.createdAfterMs ||
          rowCreatedAt > params.createdBeforeMs
        ) {
          throw new Error("test_execution_scope_query_malformed_record");
        }
        return record;
      });
    },
  };
}
