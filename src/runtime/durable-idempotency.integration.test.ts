import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.IDEMPOTENCY_EXHAUSTED_BOOKING_COOLDOWN_MS = "900000";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

type Row = {
  id: number;
  user_id: string;
  platform: string;
  business_id: string | null;
  ai_summary: string | null;
  created_at: string;
};

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private returning = "*";

  constructor(
    private database: FakeAppointmentsLeads,
    private mode: "select" | "update",
    private values?: Partial<Row>,
  ) {}

  eq(column: keyof Row, value: unknown) {
    this.filters.push(row => row[column] === value);
    return this;
  }

  select(columns: string) {
    this.returning = columns;
    return this;
  }

  async maybeSingle() {
    const matches = this.database.rows.filter(row => this.filters.every(filter => filter(row)));
    if (this.mode === "update") {
      for (const row of matches) Object.assign(row, this.values);
    }
    if (matches.length > 1) {
      this.database.pgrst116Count += 1;
      return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    }
    const row = matches[0] || null;
    if (!row) return { data: null, error: null };
    if (this.returning === "user_id") return { data: { user_id: row.user_id }, error: null };
    if (this.returning === "ai_summary") return { data: { ai_summary: row.ai_summary }, error: null };
    return { data: structuredClone(row), error: null };
  }
}

class FakeAppointmentsLeads {
  rows: Row[] = [];
  pgrst116Count = 0;
  private nextId = 1;

  from(table: string) {
    assert.equal(table, "appointments_leads");
    return {
      insert: async (payload: Array<Partial<Row>>) => {
        for (const input of payload) {
          const isIdempotency = String(input.platform || "").startsWith("idempotency:");
          if (isIdempotency && this.rows.some(row =>
            row.user_id === input.user_id && row.platform.startsWith("idempotency:")
          )) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          this.rows.push({
            id: this.nextId++,
            user_id: String(input.user_id || ""),
            platform: String(input.platform || "telegram"),
            business_id: input.business_id == null ? null : String(input.business_id),
            ai_summary: input.ai_summary == null ? null : String(input.ai_summary),
            created_at: input.created_at || new Date().toISOString(),
          });
        }
        return { data: null, error: null };
      },
      select: (_columns: string) => new Query(this, "select"),
      update: (values: Partial<Row>) => new Query(this, "update", values),
    };
  }

  seed(input: Omit<Row, "id"> & { id?: number }) {
    this.rows.push({ ...input, id: input.id ?? this.nextId++ });
    this.nextId = Math.max(this.nextId, (input.id || 0) + 1);
  }

  idempotencyRows(storageId?: string) {
    return this.rows.filter(row =>
      row.platform.startsWith("idempotency:") &&
      (!storageId || row.user_id === storageId)
    );
  }
}

type ClaimType =
  | "inbound_message_claim"
  | "booking_operation_claim"
  | "reschedule_operation_claim"
  | "cancellation_operation_claim";

function claimParams(type: ClaimType, exactId: string) {
  return {
    type,
    tenantScope: "business-7",
    platform: "telegram",
    exactId,
    businessId: "7",
  };
}

const originalDateNow = Date.now;
let nowMs = Date.parse("2026-08-21T12:00:00.000Z");
Date.now = () => nowMs;

try {
  const concurrentDatabase = new FakeAppointmentsLeads();
  const concurrentRow = {
    user_id: "bookop_same-durable-key",
    platform: "idempotency:telegram",
    business_id: "7",
    ai_summary: JSON.stringify({
      type: "booking_operation_claim",
      status: "processing",
      attempts: 1,
      claimedAt: nowMs,
      updatedAt: nowMs,
    }),
  };
  const concurrentResults = await Promise.all([
    concurrentDatabase.from("appointments_leads").insert([concurrentRow]),
    concurrentDatabase.from("appointments_leads").insert([concurrentRow]),
  ]);
  assert.equal(concurrentResults.filter(result => !result.error).length, 1);
  assert.equal(concurrentResults.filter(result => result.error?.code === "23505").length, 1);
  assert.equal(concurrentDatabase.idempotencyRows(concurrentRow.user_id).length, 1,
    "partial uniqueness permits exactly one durable claim");
  const ordinaryResults = await Promise.all([
    concurrentDatabase.from("appointments_leads").insert([{
      user_id: "shared-customer-id", platform: "telegram", business_id: "7",
    }]),
    concurrentDatabase.from("appointments_leads").insert([{
      user_id: "shared-customer-id", platform: "whatsapp", business_id: "8",
    }]),
  ]);
  assert.equal(ordinaryResults.every(result => !result.error), true,
    "ordinary lead rows remain outside the partial uniqueness boundary");

  const database = new FakeAppointmentsLeads();
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const booking = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-1"));
  assert.equal(booking.claimed, true);
  assert.equal(await boundary.settleAtomic(booking, "completed"), true);
  assert.equal(JSON.parse(database.idempotencyRows(booking.storageId)[0].ai_summary!).status, "completed");

  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const completedReplay = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-1"));
  assert.equal(completedReplay.claimed, false);
  assert.equal(completedReplay.duplicateStatus, "completed",
    "completed durable claims suppress duplicate processing");

  const failedAttempt1 = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(failedAttempt1.claimed, true);
  assert.equal(await boundary.settleAtomic(failedAttempt1, "failed"), true);
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const attempt1Cooldown = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(attempt1Cooldown.claimed, false, "failed attempt 1 observes the immediate retry delay");
  assert.equal(attempt1Cooldown.duplicateStatus, "failed");
  nowMs += 5_001;
  const failedAttempt2 = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(failedAttempt2.claimed, true);
  assert.equal(failedAttempt2.state.attempts, 2, "failed claim retries under the existing policy");
  assert.equal(await boundary.settleAtomic(failedAttempt2, "failed"), true);
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const attempt2Cooldown = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(attempt2Cooldown.claimed, false, "failed attempt 2 observes the immediate retry delay");
  nowMs += 5_001;
  const failedAttempt3 = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(failedAttempt3.claimed, true);
  assert.equal(failedAttempt3.state.attempts, 3);
  assert.equal(await boundary.settleAtomic(failedAttempt3, "failed"), true);
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const exhaustedCooldown = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(exhaustedCooldown.claimed, false, "exhausted failed booking is initially suppressed");
  assert.equal(exhaustedCooldown.duplicateStatus, "failed");

  nowMs += 900_001;
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const concurrentReclaims = await Promise.all([
    boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry")),
    boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry")),
  ]);
  const reclaimWinners = concurrentReclaims.filter(result => result.claimed);
  assert.equal(reclaimWinners.length, 1, "concurrent exhausted-claim reclaim has exactly one winner");
  assert.equal(reclaimWinners[0].state.attempts, 1,
    "an exhausted booking starts a new bounded three-attempt lifecycle");
  assert.equal(database.idempotencyRows(reclaimWinners[0].storageId).length, 1,
    "reclaim updates the unique durable row instead of replacing it");
  assert.equal(await boundary.settleAtomic(reclaimWinners[0], "completed"), true,
    "the same legitimate booking operation can complete after failed-claim expiry");

  boundary.reset();
  boundary.configure({ supabaseClient: database });
  const completedAfterCooldown = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-retry"));
  assert.equal(completedAfterCooldown.claimed, false, "completed claim never enters failed-claim reclaim");
  assert.equal(completedAfterCooldown.duplicateStatus, "completed");

  const processing = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-processing"));
  assert.equal(processing.claimed, true);
  boundary.reset();
  boundary.configure({ supabaseClient: database });
  nowMs += 119_999;
  const processingReplay = await boundary.claimAtomic(claimParams("booking_operation_claim", "booking-processing"));
  assert.equal(processingReplay.claimed, false, "processing claim remains protected for its existing TTL");
  assert.equal(processingReplay.duplicateStatus, "processing");

  const casDatabase = new FakeAppointmentsLeads();
  const priorFailedState = JSON.stringify({
    type: "booking_operation_claim",
    status: "failed",
    attempts: 3,
    claimedAt: nowMs - 1_000_000,
    updatedAt: nowMs - 1_000_000,
    retryAfter: nowMs - 999_000,
  });
  casDatabase.seed({
    user_id: "bookop_cross-instance-cas",
    platform: "idempotency:telegram",
    business_id: "7",
    ai_summary: priorFailedState,
    created_at: new Date(nowMs - 1_000_000).toISOString(),
  });
  const reclaimedState = JSON.stringify({
    type: "booking_operation_claim",
    status: "processing",
    attempts: 1,
    claimedAt: nowMs,
    updatedAt: nowMs,
  });
  const crossInstanceCas = await Promise.all([
    casDatabase.from("appointments_leads").update({ ai_summary: reclaimedState })
      .eq("user_id", "bookop_cross-instance-cas")
      .eq("platform", "idempotency:telegram")
      .eq("ai_summary", priorFailedState)
      .select("user_id").maybeSingle(),
    casDatabase.from("appointments_leads").update({ ai_summary: reclaimedState })
      .eq("user_id", "bookop_cross-instance-cas")
      .eq("platform", "idempotency:telegram")
      .eq("ai_summary", priorFailedState)
      .select("user_id").maybeSingle(),
  ]);
  assert.equal(crossInstanceCas.filter(result => result.data).length, 1,
    "the durable compare-and-swap permits one cross-instance reclaim winner");
  assert.equal(casDatabase.idempotencyRows("bookop_cross-instance-cas").length, 1);
  assert.equal(casDatabase.pgrst116Count, 0);

  for (const [type, exactId] of [
    ["inbound_message_claim", "update-100"],
    ["reschedule_operation_claim", "event-reschedule-1"],
    ["cancellation_operation_claim", "event-cancel-1"],
  ] as const) {
    boundary.reset();
    boundary.configure({ supabaseClient: database });
    const first = await boundary.claimAtomic(claimParams(type, exactId));
    assert.equal(first.claimed, true, `${type} is durably claimed`);
    assert.equal(await boundary.settleAtomic(first, "completed"), true);
    boundary.reset();
    boundary.configure({ supabaseClient: database });
    const replay = await boundary.claimAtomic(claimParams(type, exactId));
    assert.equal(replay.claimed, false, `${type} duplicate is suppressed`);
    assert.equal(replay.duplicateStatus, "completed");
  }
  assert.equal(database.pgrst116Count, 0,
    "a valid platform-qualified settlement path cannot match multiple durable claims");

  const migrationPath = path.resolve(
    "supabase/migrations/20260821143000_fix_idempotency_claim_uniqueness.sql",
  );
  const migration = fs.readFileSync(migrationPath, "utf8");
  assert.match(migration, /lock table public\.appointments_leads in share row exclusive mode/i);
  assert.match(migration, /partition by user_id/i);
  assert.match(migration, /\(state_status = 'completed'\) desc/i);
  assert.match(migration, /state_updated_at desc nulls last/i);
  assert.match(migration, /target\.platform like 'idempotency:%'/i);
  assert.match(migration, /create unique index appointments_leads_idempotency_user_id_uidx[\s\S]*where platform like 'idempotency:%'/i);
  assert.doesNotMatch(migration, /delete[\s\S]*platform not like 'idempotency:%'/i);

  const legacyRows = [
    { id: 1, user_id: "customer-ordinary", platform: "telegram", ai_summary: null, created_at: 1 },
    { id: 2, user_id: "customer-ordinary", platform: "whatsapp", ai_summary: null, created_at: 2 },
    { id: 3, user_id: "bookop_duplicate", platform: "idempotency:telegram", ai_summary: { type: "booking_operation_claim", status: "processing", updatedAt: 300, attempts: 2, claimedAt: 100 }, created_at: 3 },
    { id: 4, user_id: "bookop_duplicate", platform: "idempotency:telegram", ai_summary: { type: "booking_operation_claim", status: "failed", updatedAt: 400, attempts: 2, claimedAt: 100 }, created_at: 4 },
    { id: 5, user_id: "bookop_duplicate", platform: "idempotency:telegram", ai_summary: { type: "booking_operation_claim", status: "completed", updatedAt: 200, attempts: 1, claimedAt: 100 }, created_at: 5 },
    { id: 6, user_id: "bookop_duplicate", platform: "idempotency:telegram", ai_summary: "malformed", created_at: 6 },
  ];
  const canonical = legacyRows
    .filter(row => row.platform.startsWith("idempotency:") && row.user_id === "bookop_duplicate")
    .sort((left, right) => {
      const valid = (value: any) => value && typeof value === "object" &&
        ["inbound_message_claim", "booking_operation_claim", "reschedule_operation_claim", "cancellation_operation_claim"].includes(value.type) &&
        ["processing", "completed", "failed"].includes(value.status);
      const leftValid = Number(valid(left.ai_summary));
      const rightValid = Number(valid(right.ai_summary));
      return rightValid - leftValid ||
        Number((right.ai_summary as any)?.status === "completed") - Number((left.ai_summary as any)?.status === "completed") ||
        Number((right.ai_summary as any)?.updatedAt || -1) - Number((left.ai_summary as any)?.updatedAt || -1) ||
        Number((right.ai_summary as any)?.status === "failed") - Number((left.ai_summary as any)?.status === "failed") ||
        Number((right.ai_summary as any)?.attempts || -1) - Number((left.ai_summary as any)?.attempts || -1) ||
        Number((right.ai_summary as any)?.claimedAt || -1) - Number((left.ai_summary as any)?.claimedAt || -1) ||
        right.created_at - left.created_at || left.id - right.id;
    })[0];
  assert.equal(canonical.id, 5, "completed state is retained as the authoritative canonical row");
  assert.deepEqual(
    legacyRows.filter(row => !row.platform.startsWith("idempotency:")).map(row => row.id),
    [1, 2],
    "ordinary appointments_leads rows are outside migration cleanup scope",
  );
} finally {
  Date.now = originalDateNow;
  boundary.reset();
}

console.log("durable idempotency uniqueness integration tests passed");
