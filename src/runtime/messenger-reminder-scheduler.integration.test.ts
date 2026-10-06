import assert from "node:assert/strict";
import { mock } from "node:test";
import cron from "node-cron";
import { encryptCredential } from "../channels/connections/credential-crypto";

process.env.NODE_ENV = "test";
process.env.ODINLINK_LOCAL_TEST_MODE = "false";
process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");
const now = Date.parse("2026-10-06T10:00:00Z");
const hour = 3_600_000;
mock.timers.enable({ apis: ["Date"], now });

const config = { businessRecordId: "7", googleCalendarId: "calendar-7", calendarProvider: "google", businessName: "Business 7" };
const row = (id: string, hours: number, patch: any = {}) => ({
  id, business_id: "7", platform: "messenger", user_id: `customer-${id}`, status: "booked",
  service: "Consultation", language: "en", customer_name: "Test Customer",
  start_time: new Date(now + hours * hour).toISOString(),
  end_time: new Date(now + hours * hour + 30 * 60_000).toISOString(),
  reminder_24_sent: false, reminder_2_sent: false, ...patch,
});
const rows = [
  row("24-lower", 23.5), row("24-upper", 24.5), row("2-lower", 1.75), row("2-upper", 2.25),
  row("retry", 2), row("too-early-24", 23.5 - 1 / hour), row("too-late-24", 24.5 + 1 / hour),
  row("too-early-2", 1.75 - 1 / hour), row("too-late-2", 2.25 + 1 / hour),
  row("cancelled", 24, { status: "cancelled" }), row("already-sent", 24, { reminder_24_sent: true }),
];
const selectionQueries: any[] = [];
const db = {
  from(table: string) {
    const filters: any[] = [];
    let patch: any;
    const query: any = {
      select: () => query,
      eq: (key: string, value: any) => { filters.push([key, "eq", value]); return query; },
      in: (key: string, value: any) => { filters.push([key, "in", value]); return query; },
      gte: (key: string, value: any) => { filters.push([key, "gte", value]); return query; },
      lte: (key: string, value: any) => { filters.push([key, "lte", value]); return query; },
      not: () => query, order: () => query, limit: () => query,
      maybeSingle: () => query,
      update: (value: any) => { patch = value; return query; },
      then: (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (table === "appointments") {
          const selected = rows.filter(row => filters.every(([key, op, value]) =>
            op === "gte" ? row[key] >= value : op === "lte" ? row[key] <= value : row[key] === value));
          if (patch) {
            assert.equal(selected.length, 1);
            Object.assign(selected[0], patch);
          } else selectionQueries.push(filters);
          return { data: selected, error: null };
        }
        if (table === "chat_history") {
          assert.deepEqual(filters.slice(0, 2), [["business_id", "eq", "7"], ["platform", "eq", "messenger"]]);
          return { data: [{ business_id: "7", platform: "messenger", user_id: filters[2][2][0], sender: "user",
            provider_event_at: new Date(now - 1000).toISOString() }], error: null };
        }
        assert.equal(table, "channel_connections");
        assert.deepEqual(filters, [["business_id", "eq", 7], ["provider", "eq", "messenger"],
          ["status", "eq", "connected"], ["reconnect_required", "eq", false]]);
        return { data: {
          id: "connection-7", business_id: 7, provider: "messenger", provider_account_id: "page-7",
          status: "connected", reconnect_required: false, connected_at: "2026-09-24T00:00:00Z",
          granted_scopes: ["pages_messaging"], token_expires_at: null,
          credential_ciphertext: encryptCredential({ accessToken: "test-ms-token", tokenType: "page" }),
        }, error: null };
      }).then(resolve, reject),
    };
    return query;
  },
};
const requests: any[] = [];
let failOnce = true;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const logs: any[] = [];
let tick: (() => Promise<void>) | undefined;
const schedule = mock.method(cron, "schedule", (expression: string, callback: any, options: any) => {
  assert.equal(expression, "*/5 * * * *");
  assert.deepEqual(options, { timezone: "Europe/Stockholm" });
  tick = callback;
  return {} as any;
});
try {
  boundary.reset();
  boundary.configure({ supabaseClient: db, loadBusinessConfigById: async () => config,
    calendarAdapter: {
      getCalendarId: () => "calendar-7", checkSlots: async () => ({ available_slots_string: "" }),
      insertAppointment: async () => ({ success: false }),
      getEvents: async () => rows.map(row => ({ id: `event-${row.id}`, status: "confirmed",
        description: "Tjänst: Consultation", start: { dateTime: row.start_time }, end: { dateTime: row.end_time },
        extendedProperties: { private: { businessId: "7", platform: row.platform, userId: row.user_id } },
      })),
    },
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-ms-token");
    assert.equal(init?.redirect, "error");
    if (init?.method === "GET") {
      assert.equal(String(input), "https://graph.facebook.com/v25.0/me?fields=id");
      return new Response(JSON.stringify({ id: "page-7" }), { status: 200 });
    }
    assert.equal(String(input), "https://graph.facebook.com/v25.0/page-7/messages");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.messaging_type, "UPDATE");
    assert.equal(payload.tag, undefined);
    const appointment = rows.find(row => row.user_id === payload.recipient.id)!;
    assert.ok(appointment);
    assert.equal(appointment.platform, "messenger");
    requests.push(payload);
    if (appointment.id === "retry" && failOnce) {
      failOnce = false;
      return new Response(JSON.stringify({ error: { code: 2 } }), { status: 503 });
    }
    return new Response(JSON.stringify({ recipient_id: payload.recipient.id, message_id: `mid.${appointment.id}` }), { status: 200 });
  };
  console.log = (...args) => { logs.push(args); };
  console.error = (...args) => { logs.push(args); };

  // The low-level reminder flag alone cannot bypass policy or invoke Graph.
  assert.equal(await boundary.sendCustomerMessage("messenger", "customer-7", "Reminder", config, "proactive", true), false);
  assert.equal(requests.length, 0);
  boundary.scheduleReminders();
  assert.ok(tick);
  await tick();
  assert.deepEqual(selectionQueries.slice(0, 2), [
    [["status", "eq", "booked"], ["reminder_24_sent", "eq", false],
      ["start_time", "gte", new Date(now + 23.5 * hour).toISOString()], ["start_time", "lte", new Date(now + 24.5 * hour).toISOString()]],
    [["status", "eq", "booked"], ["reminder_2_sent", "eq", false],
      ["start_time", "gte", new Date(now + 1.75 * hour).toISOString()], ["start_time", "lte", new Date(now + 2.25 * hour).toISOString()]],
  ]);
  assert.deepEqual(requests.map(p => p.recipient.id), ["customer-24-lower", "customer-24-upper", "customer-2-lower", "customer-2-upper", "customer-retry"]);
  assert.equal(rows.find(row => row.id === "retry")!.reminder_2_sent, false);
  for (const id of ["24-lower", "24-upper"]) assert.equal(rows.find(row => row.id === id)!.reminder_24_sent, true);
  for (const id of ["2-lower", "2-upper"]) assert.equal(rows.find(row => row.id === id)!.reminder_2_sent, true);

  mock.timers.setTime(now + 5 * 60_000);
  await tick();
  assert.equal(requests.length, 8, "retry and the formerly just-outside upper boundaries become due on the next tick");
  assert.equal(rows.find(row => row.id === "retry")!.reminder_2_sent, true);
  assert.equal(requests.filter(p => p.recipient.id === "customer-retry").length, 2);
  await tick();
  assert.equal(requests.length, 8, "accepted reminders are not resent on a later sweep");
  assert.equal(rows.find(row => row.id === "cancelled")!.reminder_24_sent, false);
  assert.equal(requests.some(p => p.recipient.id === "customer-already-sent"), false);
} finally {
  schedule.mock.restore();
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  boundary.reset();
  mock.timers.reset();
}
console.log("Messenger reminder scheduler, same-channel delivery and retry integration tests passed");
