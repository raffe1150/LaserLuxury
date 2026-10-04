import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const hour = 60 * 60 * 1000;
const now = Date.parse("2026-10-04T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now });
let scenarios = 0;
const config = {
  businessRecordId: "7", business_id: "7", businessName: "Business 7",
  googleCalendarId: "calendar-7", calendarProvider: "google",
  whatsappAccessToken: "tenant-7-wa-token", whatsappPhoneNumberId: "tenant-7-wa-phone",
  messengerPageAccessToken: "tenant-7-ms-token", messengerPageId: "tenant-7-page",
  instagramAccessToken: "tenant-7-ig-token", telegramToken: "tenant-7-tg-token",
};

class ReminderDatabase {
  queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  updates = 0;
  constructor(readonly row: any, readonly history: any[], readonly options: any) {}
  from(table: string) {
    const record = { table, filters: [] as Array<[string, unknown]> };
    this.queries.push(record);
    let values: any;
    let single = false;
    let selectedColumns: string[] = [];
    const query: any = {
      select: (columns: string) => {
        selectedColumns = columns.split(",");
        if (table === "chat_history") assert.ok(columns.split(",").includes("provider_event_at"),
          "actual provider event time must be requested from persistence");
        return query;
      },
      update: (input: any) => { values = input; return query; },
      eq: (column: string, value: unknown) => { record.filters.push([column, value]); return query; },
      in: (column: string, value: unknown) => { record.filters.push([column, value]); return query; },
      not: (column: string, operator: string, value: unknown) => { record.filters.push(["not", [column, operator, value]]); return query; },
      is: (column: string, value: unknown) => { record.filters.push(["is", [column, value]]); return query; },
      gt: (column: string, value: unknown) => { record.filters.push(["gt", [column, value]]); return query; },
      lte: (column: string, value: unknown) => { record.filters.push(["lte", [column, value]]); return query; },
      order: (column: string, value: unknown) => { record.filters.push(["order", [column, value]]); return query; },
      limit: (value: number) => { record.filters.push(["limit", value]); return query; },
      maybeSingle: () => { single = true; return query; },
      then: (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (table === "chat_history") {
          assert.deepEqual(record.filters.slice(0, 4), [
            ["business_id", "7"], ["platform", this.row.platform],
            ["user_id", [this.row.user_id, boundary.channelSessionId(this.row.platform, this.row.user_id, config)]],
            ["sender", ["user", "customer"]],
          ], "history is scoped to this tenant, canonical identity, channel and inbound senders");
          const identities = record.filters[2]?.[1] as string[];
          assert.equal(new Set(identities).size, identities.length, "history identity candidates are deduplicated");
          const providerQuery = record.filters[4]?.[0] === "not";
          const clockMs = Date.now();
          assert.deepEqual(record.filters.slice(4), providerQuery ? [
            ["not", ["provider_event_at", "is", null]],
            ["order", ["provider_event_at", { ascending: false, nullsFirst: false }]], ["limit", 1],
          ] : [
            ["is", ["provider_event_at", null]],
            ["gt", ["reminder_provider_time_cutover_at", new Date(clockMs - 24 * hour).toISOString()]],
            ["lte", ["reminder_provider_time_cutover_at", new Date(clockMs).toISOString()]],
            ["order", ["created_at", { ascending: false }]], ["limit", 1],
          ], "provider evidence and unexpired legacy evidence are requested separately");
          if (this.options.historyThrows) throw new Error("private storage failure");
          const candidates = this.history.filter(row =>
            (this.options.unscopedHistoryResponse || identities.includes(row.user_id)) &&
            (providerQuery ? row.provider_event_at != null : row.provider_event_at == null &&
              Date.parse(row.reminder_provider_time_cutover_at) > clockMs - 24 * hour &&
              Date.parse(row.reminder_provider_time_cutover_at) <= clockMs));
          candidates.sort((a, b) => Date.parse(providerQuery ? b.provider_event_at : b.created_at) -
            Date.parse(providerQuery ? a.provider_event_at : a.created_at));
          return { data: candidates.slice(0, 1).map(row => Object.fromEntries(
            selectedColumns.map(column => [column, row[column]]),
          )), error: this.options.historyError ? { code: "storage_error" } : null };
        }
        if (table === "channel_connections") {
          assert.ok(record.filters.some(([column, value]) => column === "business_id" && value === 7));
          if (this.options.nowAfterHydration !== undefined) mock.timers.setTime(this.options.nowAfterHydration);
          return { data: single ? null : [], error: null };
        }
        assert.equal(table, "appointments");
        if (this.options.updateThrows) throw new Error("private flag failure");
        if (this.options.updateError) return { data: null, error: { code: "write_error" } };
        if (this.options.updateNoRows) return { data: [], error: null };
        this.updates++;
        Object.assign(this.row, values);
        return { data: [{ id: this.row.id }], error: null };
      }).then(resolve, reject),
    };
    return query;
  }
}

async function run(channel: string, options: any = {}) {
  scenarios++;
  const clockMs = options.nowMs ?? now;
  mock.timers.setTime(clockMs);
  const row = {
    id: "appointment-policy-7", business_id: "7", platform: channel,
    user_id: channel === "whatsapp" ? "46701234567" : "customer-7",
    customer_name: "Sensitive Customer", service: "Consultation", language: "de",
    start_time: "2026-10-05T12:00:00.000Z", end_time: "2026-10-05T12:30:00.000Z",
    reminder_24_sent: false, reminder_2_sent: false,
  };
  const history = options.history ?? [{
    business_id: "7", platform: channel, user_id: row.user_id, sender: "user",
    created_at: new Date(clockMs - 1000).toISOString(),
    provider_event_at: new Date(clockMs - (options.ageMs ?? (options.ageHours ?? 1) * hour)).toISOString(),
  }];
  const db = new ReminderDatabase(row, history, options);
  const requests: Array<{ url: string; body: any; headers: any }> = [];
  const logs: any[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  boundary.reset();
  boundary.configure({
    supabaseClient: db,
    loadBusinessConfigById: async () => ({ ...config, ...options.config }),
    calendarAdapter: {
      getCalendarId: () => "calendar-7",
      getEvents: async () => [{
        id: "event-7", status: "confirmed", description: "Tjänst: Consultation",
        start: { dateTime: row.start_time }, end: { dateTime: row.end_time },
        extendedProperties: { private: { platform: channel, userId: row.user_id } },
      }],
      checkSlots: async () => ({ available_slots_string: "" }),
      insertAppointment: async () => ({ success: false }),
    },
  });
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers });
    if (options.transportThrows) throw new Error("private transport failure");
    const body = options.body ?? (channel === "whatsapp"
      ? { messages: [{ id: "wamid.reminder-policy-test" }] }
      : { recipient_id: row.user_id, message_id: "mid.reminder-policy-test", ok: true });
    return new Response(JSON.stringify(body), { status: options.status ?? 200 });
  };
  console.log = (...args) => { logs.push(args); };
  console.error = (...args) => { logs.push(args); };
  try {
    const type = options.type ?? "24h";
    const result = await boundary.processReminderCandidate(row, type,
      type === "24h" ? "reminder_24_sent" : "reminder_2_sent");
    assert.equal(row.reminder_24_sent || row.reminder_2_sent, db.updates > 0);
    assert.ok(!JSON.stringify(logs).includes(row.customer_name));
    assert.ok(!JSON.stringify(logs).includes("tenant-7-wa-token"));
    assert.ok(!JSON.stringify(logs).includes("private transport failure"));
    const diagnostic = logs.find(args => args[0] === "[ReminderDelivery]")?.[1];
    assert.equal(diagnostic?.appointmentId, row.id);
    assert.equal(diagnostic?.businessId, row.business_id);
    assert.equal(diagnostic?.channel, channel);
    assert.equal(diagnostic?.reminderType, type);
    return { result, row, requests, logs, db };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    boundary.reset();
    mock.timers.setTime(now);
  }
}

// Documented provider rule: closed-window WhatsApp requires an approved template.
for (const type of ["24h", "2h"]) {
  const closed = await run("whatsapp", { ageHours: 25, type });
  assert.equal(closed.requests.length, 0, "closed-window WhatsApp must never send ordinary text");
  assert.equal(closed.result.sent, false);
  assert.equal(closed.result.category, "whatsapp_template_required");
  assert.equal(closed.result.reason, "whatsapp_template_missing");
}

for (const channel of ["whatsapp", "instagram", "telegram"]) {
  for (const type of ["24h", "2h"]) {
    const accepted = await run(channel, { type });
    assert.equal(accepted.result.sent, true, `${channel} valid reminder is accepted`);
    assert.equal(accepted.result.deliveryCategory, "accepted");
    assert.equal(accepted.row[type === "24h" ? "reminder_24_sent" : "reminder_2_sent"], true);
    assert.equal(accepted.requests.length, 1);
    assert.deepEqual(accepted.db.queries.find(q => q.table === "appointments")?.filters,
      [["id", accepted.row.id], ["business_id", "7"]]);
    const { body, url } = accepted.requests[0];
    if (channel === "whatsapp") {
      assert.equal(body.type, "text");
      assert.equal(body.to, accepted.row.user_id);
      assert.match(body.text.body, /Hallo Sensitive Customer/);
      assert.match(url, /tenant-7-wa-phone\/messages$/);
    } else if (channel === "instagram") {
      assert.equal(body.tag, undefined);
      assert.equal(body.human_agent, undefined);
    } else {
      assert.match(url, /api.telegram.org\/bottenant-7-tg-token\/sendMessage$/);
      assert.equal(body.chat_id, accepted.row.user_id);
      assert.equal(accepted.db.queries.some(q => q.table === "chat_history"), false);
    }
  }
  const rejected = await run(channel, { status: 400, body: { error: { code: 131047 } } });
  assert.equal(rejected.result.sent, false);
  assert.equal(rejected.result.category, "provider_rejected");
  assert.equal(rejected.db.updates, 0);
  const transportFailure = await run(channel, { transportThrows: true });
  assert.equal(transportFailure.result.sent, false);
  assert.equal(transportFailure.db.updates, 0);
  for (const failure of ["updateError", "updateThrows", "updateNoRows"]) {
    const update = await run(channel, { [failure]: true });
    assert.equal(update.result.sent, true, "provider acceptance survives a flag write failure");
    assert.equal(update.result.category, "flag_update_failed");
    assert.equal(update.db.updates, 0);
  }
}

for (const channel of ["whatsapp", "messenger", "instagram"]) {
  // OdinLink conservatively expires at equality; Meta documents 24 hours,
  // without millisecond equality semantics. No verified ad-entry extension exists.
  for (const ageMs of [24 * hour, 24 * hour + 1, -1]) {
    const closed = await run(channel, { ageMs });
    assert.equal(closed.requests.length, 0);
    assert.equal(closed.db.updates, 0);
    if (channel === "whatsapp") {
      assert.equal(closed.result.category, "whatsapp_template_required");
      assert.equal(closed.result.reason, "whatsapp_template_missing");
    } else {
      assert.equal(closed.result.category, "channel_policy_window_closed");
      assert.equal(closed.result.reason, "unsupported_proactive_delivery_path");
    }
  }
  const latest = await run(channel, { ageMs: 24 * hour - 1 });
  assert.equal(latest.result.sent, channel !== "messenger", "just inside ordinary window: verified paths only");
  if (channel === "messenger") {
    assert.equal(latest.result.category, "unsupported_proactive_delivery_path");
    assert.equal(latest.result.reason, "messenger_reminder_wire_type_unverified");
    assert.equal(latest.requests.length, 0);
  }
  const customer = await run(channel, { history: [{
    business_id: "7", platform: channel,
    user_id: channel === "whatsapp" ? "46701234567" : "customer-7", sender: "customer",
    created_at: new Date(now - 1000).toISOString(),
    provider_event_at: new Date(now - 1000).toISOString(),
  }] });
  assert.equal(customer.result.sent, channel !== "messenger");
  for (const overrides of [
    { business_id: "8" }, { user_id: "other-customer" }, { platform: "telegram" },
    { sender: "bot" }, { sender: "human" }, { provider_event_at: "invalid" },
    { provider_event_at: null }, { provider_event_at: undefined },
  ]) {
    const invalid = await run(channel, { history: [{
      business_id: "7", platform: channel,
      user_id: channel === "whatsapp" ? "46701234567" : "customer-7", sender: "user",
      created_at: new Date(now - 1000).toISOString(),
      provider_event_at: new Date(now - 1000).toISOString(), ...overrides,
    }] });
    assert.equal(invalid.requests.length, 0, "unrelated or invalid history cannot authorize delivery");
    assert.equal(invalid.db.updates, 0);
  }
  for (const options of [{ history: [] }, { historyError: true }, { historyThrows: true }]) {
    const missing = await run(channel, options);
    assert.equal(missing.requests.length, 0);
    assert.equal(missing.db.updates, 0);
  }
  for (const body of [{}, { error: { code: 100 } },
    channel === "whatsapp" ? { messages: [{ id: "invalid" }] } : { message_id: "" },
    channel === "whatsapp" ? { messages: [{ id: "wamid." }] }
      : { recipient_id: "other-customer", message_id: "mid.wrong-recipient" },
    channel === "whatsapp" ? { messages: [{ id: "wamid.error" }], error: { code: 100 } }
      : { recipient_id: "customer-7", message_id: "mid.error", error: { code: 100 } }]) {
    const unacknowledged = await run(channel, { body });
    assert.equal(unacknowledged.result.sent, false, "HTTP success alone cannot mark a Meta reminder sent");
    assert.equal(unacknowledged.db.updates, 0);
    if (channel === "messenger") {
      assert.equal(unacknowledged.requests.length, 0, "unverified wire type is blocked before provider response matters");
      assert.equal(unacknowledged.result.reason, "messenger_reminder_wire_type_unverified");
    }
  }
}

// Unverified provider behavior: an eligible window does not prove a Messenger
// reminder wire type. Neither HTTP success nor a configured Page may override it.
for (const type of ["24h", "2h"]) {
  const blocked = await run("messenger", { type });
  assert.equal(blocked.result.sent, false);
  assert.equal(blocked.result.category, "unsupported_proactive_delivery_path");
  assert.equal(blocked.result.reason, "messenger_reminder_wire_type_unverified");
  assert.equal(blocked.requests.length, 0);
  assert.equal(blocked.db.updates, 0);
}

// Documented windows start at the provider event, not local database persistence.
for (const channel of ["whatsapp", "messenger", "instagram"]) {
  const delayed = await run(channel, { ageHours: 25 });
  assert.equal(delayed.requests.length, 0, "old event recently persisted cannot authorize delivery");
  assert.equal(delayed.db.updates, 0);
  const actualRecent = await run(channel, { history: [{
    business_id: "7", platform: channel,
    user_id: channel === "whatsapp" ? "46701234567" : "customer-7", sender: "user",
    created_at: new Date(now - 25 * hour).toISOString(),
    provider_event_at: new Date(now - hour).toISOString(),
  }] });
  assert.equal(actualRecent.result.sent, channel !== "messenger", "eligibility uses actual event, not created_at");
  const legacy = await run(channel, { history: [{
    business_id: "7", platform: channel,
    user_id: channel === "whatsapp" ? "46701234567" : "customer-7", sender: "user",
    created_at: new Date(now - 1000).toISOString(),
  }] });
  assert.equal(legacy.requests.length, 0, "local timestamp alone is not provider-window evidence");
  assert.equal(legacy.db.updates, 0);
}

// Temporary rollout compatibility, not a documented provider timestamp rule.
// The migration supplies one database cutover marker only on pre-existing rows.
for (const channel of ["whatsapp", "messenger", "instagram"]) {
  const cutover = now;
  const legacy = {
    business_id: "7", platform: channel,
    user_id: channel === "whatsapp" ? "46701234567" : "customer-7", sender: "user",
    provider_event_at: null,
    created_at: new Date(cutover - 1).toISOString(),
    reminder_provider_time_cutover_at: new Date(cutover).toISOString(),
  };
  const expectEligible = (result: Awaited<ReturnType<typeof run>>) => {
    assert.equal(result.result.sent, channel !== "messenger");
    if (channel === "messenger") {
      assert.equal(result.result.category, "unsupported_proactive_delivery_path");
      assert.equal(result.result.reason, "messenger_reminder_wire_type_unverified");
      assert.equal(result.requests.length, 0);
    } else {
      assert.equal(result.result.deliveryCategory, "accepted");
      assert.equal(result.requests.length, 1);
      assert.match(result.requests[0].url, channel === "whatsapp"
        ? /graph.facebook.com.*tenant-7-wa-phone/ : /graph.instagram.com/,
      "reminder stays on its booking channel");
    }
  };
  const expectBlocked = (result: Awaited<ReturnType<typeof run>>) => {
    assert.equal(result.requests.length, 0, "blocked reminder never reroutes to another channel");
    assert.equal(result.db.updates, 0);
    assert.equal(result.result.category, channel === "whatsapp"
      ? "whatsapp_template_required" : "channel_policy_window_closed");
  };

  for (const type of ["24h", "2h"]) {
    expectEligible(await run(channel, { type, history: [legacy] }));
  }
  expectEligible(await run(channel, { nowMs: cutover + 24 * hour - 2, history: [legacy] }));
  // Equality conservatively expires both the ordinary window and transition.
  for (const clockMs of [cutover + 24 * hour, cutover + 24 * hour + 1]) {
    expectBlocked(await run(channel, { nowMs: clockMs, history: [legacy] }));
  }
  expectBlocked(await run(channel, { nowMs: cutover - 1, history: [legacy] }));
  for (const createdAt of [cutover, cutover + 1]) {
    expectBlocked(await run(channel, { nowMs: cutover + hour, history: [{
      ...legacy, created_at: new Date(createdAt).toISOString(),
    }] }));
  }
  for (const overrides of [
    { business_id: "8" }, { platform: "telegram" }, { user_id: "other-customer" },
    { sender: "bot" }, { sender: "human" }, { created_at: "invalid" },
    { reminder_provider_time_cutover_at: null }, { reminder_provider_time_cutover_at: "invalid" },
  ]) {
    expectBlocked(await run(channel, { history: [{ ...legacy, ...overrides }] }));
  }
  for (const providerEventAt of [new Date(now - 25 * hour).toISOString(),
    new Date(now - 24 * hour).toISOString(), new Date(now + 1).toISOString(), "invalid"]) {
    expectBlocked(await run(channel, { history: [{ ...legacy, provider_event_at: providerEventAt }] }));
  }
  expectEligible(await run(channel, { history: [{
    ...legacy, provider_event_at: new Date(now - hour).toISOString(), created_at: new Date(now - 30 * hour).toISOString(),
  }] }));
  expectEligible(await run(channel, { nowMs: cutover + 25 * hour, history: [{
    ...legacy, provider_event_at: new Date(cutover + 24 * hour).toISOString(),
  }] }));
  // An expired provider row must not hide a different eligible legacy inbound.
  expectEligible(await run(channel, { history: [
    { ...legacy, provider_event_at: new Date(now - 25 * hour).toISOString() }, legacy,
  ] }));
  // A backdated new row still has no migration marker and cannot use created_at.
  expectBlocked(await run(channel, { history: [{ ...legacy, reminder_provider_time_cutover_at: null }] }));
  if (channel !== "messenger") {
    expectBlocked(await run(channel, { history: [legacy], nowMs: cutover + 23 * hour,
      nowAfterHydration: cutover + 24 * hour }));
  }
}

// Reminder identity compatibility is an exact allowlist, not a scoped-ID parser.
for (const channel of ["whatsapp", "messenger", "instagram"] as const) {
  const customerId = channel === "whatsapp" ? "46701234567" : "customer-7";
  const scopedId = boundary.channelSessionId(channel, customerId, config);
  const prefix = channel === "whatsapp" ? "wa_" : channel === "messenger" ? "ms_" : "ig_";
  assert.equal(scopedId, `${prefix}7:${customerId}`);
  const base = {
    business_id: "7", platform: channel, user_id: customerId, sender: "user",
    provider_event_at: new Date(now - hour).toISOString(),
    created_at: new Date(now - 1).toISOString(),
    reminder_provider_time_cutover_at: new Date(now).toISOString(),
  };
  const expectEligible = (result: Awaited<ReturnType<typeof run>>) => {
    assert.equal(result.result.sent, channel !== "messenger");
    if (channel === "messenger") {
      assert.equal(result.result.reason, "messenger_reminder_wire_type_unverified");
      assert.equal(result.requests.length, 0);
    } else {
      assert.equal(result.result.deliveryCategory, "accepted");
      assert.equal(result.requests.length, 1);
      const request = result.requests[0];
      assert.equal(channel === "whatsapp" ? request.body.to : request.body.recipient.id, customerId,
        "history compatibility never changes the canonical provider recipient");
      assert.match(request.url, channel === "whatsapp"
        ? /graph.facebook.com.*tenant-7-wa-phone/ : /graph.instagram.com/,
      "reminder is sent only on its booking channel");
    }
  };
  const expectBlocked = (result: Awaited<ReturnType<typeof run>>) => {
    assert.equal(result.requests.length, 0, "invalid history cannot send or reroute a reminder");
    assert.equal(result.db.updates, 0);
    assert.equal(result.result.category, channel === "whatsapp"
      ? "whatsapp_template_required" : "channel_policy_window_closed");
  };
  for (const identity of [customerId, scopedId]) {
    for (const type of ["24h", "2h"]) {
      expectEligible(await run(channel, { type, history: [{ ...base, user_id: identity }] }));
      expectEligible(await run(channel, { type, history: [{ ...base, user_id: identity, provider_event_at: null }] }));
    }
    for (const providerEventAt of [new Date(now - 25 * hour).toISOString(),
      new Date(now - 24 * hour).toISOString(), new Date(now + 1).toISOString(), "invalid"]) {
      expectBlocked(await run(channel, { history: [{ ...base, user_id: identity, provider_event_at: providerEventAt }] }));
    }
    for (const clockMs of [now + 24 * hour, now + 24 * hour + 1]) {
      expectBlocked(await run(channel, { nowMs: clockMs,
        history: [{ ...base, user_id: identity, provider_event_at: null }] }));
    }
    expectBlocked(await run(channel, { history: [{ ...base, user_id: identity, business_id: "8" }],
      unscopedHistoryResponse: true }));
  }
  const otherTenantId = boundary.channelSessionId(channel, customerId, { id: "8" });
  for (const invalidId of [otherTenantId, `${prefix}07:${customerId}`, `${prefix}7${customerId}`,
    `${prefix}7:${customerId}:extra`, `${prefix}${customerId}`, `${prefix}7:other-customer`,
    `${channel}_7:${customerId}`, scopedId.toUpperCase(), ` ${scopedId}`, `${scopedId} `,
    `7${customerId}`, `${prefix}7%3A${customerId}`,
    boundary.channelSessionId(channel === "instagram" ? "messenger" : "instagram", customerId, config)]) {
    for (const providerEventAt of [base.provider_event_at, null]) {
      // Deliberately return an unfiltered DB result too: exact membership must be
      // checked before the window helper can normalize a history identity.
      expectBlocked(await run(channel, { history: [{ ...base, user_id: invalidId, provider_event_at: providerEventAt }],
        unscopedHistoryResponse: true }));
    }
  }
  expectBlocked(await run(channel, { history: [{ ...base, user_id: otherTenantId, business_id: "8" }],
    unscopedHistoryResponse: true }));
  for (const overrides of [{ platform: "telegram" }, { platform: `${channel}-webhook` },
    { sender: "bot" }, { sender: "human" }, { sender: " user" }]) {
    for (const providerEventAt of [base.provider_event_at, null]) {
      expectBlocked(await run(channel, { history: [{ ...base, user_id: scopedId,
        provider_event_at: providerEventAt, ...overrides }], unscopedHistoryResponse: true }));
    }
  }
  expectEligible(await run(channel, { history: [
    { ...base, provider_event_at: new Date(now - 25 * hour).toISOString() },
    { ...base, user_id: scopedId },
  ] }));
  expectEligible(await run(channel, { history: [
    base, { ...base, user_id: scopedId, provider_event_at: new Date(now - 25 * hour).toISOString() },
  ] }));
}

// There is no template configuration contract in this repository. Arbitrary names
// must not be mistaken for an approved, tenant-owned template in the right language.
const unconfigured = await run("whatsapp", { ageHours: 25, config: {
  whatsappReminderTemplate: "arbitrary_template", whatsappReminderTemplateLanguage: "en",
} });
assert.equal(unconfigured.requests.length, 0);
assert.equal(unconfigured.result.reason, "whatsapp_template_missing");

const oldTelegram = await run("telegram", { ageHours: 1000, historyError: true, body: {} });
assert.equal(oldTelegram.result.sent, true, "Telegram retains its existing HTTP success semantics");
const unsupported = await run("email");
assert.equal(unsupported.result.category, "unsupported_proactive_delivery_path");
assert.equal(unsupported.requests.length, 0);

// Global fallback credentials and inherited snake-case aliases cannot authorize
// a send when the tenant's canonical normalized credentials are absent.
const fallbackEnvironment = {
  WHATSAPP_ACCESS_TOKEN: "other-tenant-wa-token", WHATSAPP_PHONE_NUMBER_ID: "other-tenant-wa-phone",
  MESSENGER_PAGE_ACCESS_TOKEN: "other-tenant-ms-token", MESSENGER_PAGE_ID: "other-tenant-page",
  TELEGRAM_TOKEN: "other-tenant-tg-token",
};
const previousEnvironment = Object.fromEntries(Object.keys(fallbackEnvironment).map(key => [key, process.env[key]]));
Object.assign(process.env, fallbackEnvironment);
try {
  for (const [channel, missingConfig] of [
    ["whatsapp", { whatsappAccessToken: "", whatsapp_access_token: "inherited-token" }],
    ["whatsapp", { whatsappPhoneNumberId: "", whatsapp_phone_number_id: "inherited-phone" }],
    ["messenger", { messengerPageAccessToken: "", messenger_page_access_token: "inherited-token" }],
    ["messenger", { messengerPageId: "", messenger_page_id: "inherited-page" }],
    ["instagram", { instagramAccessToken: "", instagramToken: "inherited-token" }],
    ["telegram", { telegramToken: "" }],
    ["messenger", { channelConnectionInactive: true }],
    ["instagram", { channelConnectionInactive: true }],
  ] as const) {
    const missingCredentials = await run(channel, { config: missingConfig });
    assert.equal(missingCredentials.result.category, channel === "messenger"
      ? "unsupported_proactive_delivery_path" : "channel_configuration_missing");
    assert.equal(missingCredentials.requests.length, 0);
    assert.equal(missingCredentials.db.updates, 0);
  }
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Persistence regression: use the same webhook time scope and chat-history write
// as production. Analytics' fallback-to-now timestamp must not authorize reminders.
async function persistProviderEvent(channel: "whatsapp" | "messenger" | "instagram", timestamp: unknown, options: any = {}) {
  scenarios++;
  const rows: any[] = [];
  const customerId = channel === "whatsapp" ? "46701234567" : "customer-7";
  boundary.reset();
  boundary.configure({ supabaseClient: {
    from(table: string) {
      assert.equal(table, "chat_history");
      return { insert(payload: any[]) {
        rows.push(...structuredClone(payload));
        return { select: async () => ({ error: null }) };
      } };
    },
  } });
  await boundary.withMetaInboundEventTime(channel, customerId, timestamp, "7", async () => {
    await Promise.resolve(); // Time context must survive async reply/booking work.
    await boundary.persistCustomerExchange(options.customerId ?? customerId,
      options.channel ?? channel, "Customer input", "Reply", options.businessId ?? "7");
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].provider_event_at, undefined, "outbound cannot open a provider window");
  assert.equal(rows[0].created_at, undefined, "database persistence time keeps its existing meaning");
  assert.equal(rows[0].reminder_provider_time_cutover_at, undefined, "new webhook never supplies a legacy marker");
  if (Object.keys(options).length === 0) assert.equal(rows[0].user_id, customerId,
    "new inbound rows retain the canonical provider identity");
  boundary.reset();
  return rows[0];
}

for (const channel of ["whatsapp", "messenger", "instagram"] as const) {
  const oldEventMs = now - 25 * hour;
  const oldTimestamp = channel === "whatsapp" ? String(oldEventMs / 1000) : oldEventMs;
  const persisted = await persistProviderEvent(channel, oldTimestamp);
  assert.equal(persisted.provider_event_at, new Date(oldEventMs).toISOString());
  const delayed = await run(channel, { history: [{ ...persisted, created_at: new Date(now).toISOString() }] });
  assert.equal(delayed.requests.length, 0, "real persisted old event plus recent created_at stays blocked");
  assert.equal(delayed.db.updates, 0);

  const recentMs = now - hour;
  const recentTimestamp = channel === "whatsapp" ? recentMs / 1000 : recentMs;
  const recent = await persistProviderEvent(channel, recentTimestamp);
  assert.equal(recent.provider_event_at, new Date(recentMs).toISOString());
  const eligible = await run(channel, { history: [{ ...recent, created_at: new Date(now).toISOString() }] });
  assert.equal(eligible.result.sent, channel !== "messenger");
  for (const timestamp of [undefined, null, "", "invalid", 0, -1, NaN, true,
    channel === "whatsapp" ? (now + hour) / 1000 : now + hour]) {
    const unknown = await persistProviderEvent(channel, timestamp);
    assert.equal(unknown.provider_event_at, null, "unverified event time never falls back to now");
  }
  for (const options of [{ customerId: "other-customer" }, { businessId: "8" }, { channel: "telegram" }]) {
    const mismatch = await persistProviderEvent(channel, recentTimestamp, options);
    assert.ok(mismatch.provider_event_at == null, "event evidence cannot cross customer, tenant or channel");
  }
  if (channel !== "whatsapp") {
    const scoped = await persistProviderEvent(channel, recentTimestamp, {
      customerId: boundary.channelSessionId(channel, "customer-7", { id: "7" }),
    });
    assert.equal(scoped.user_id, "customer-7", "verified scoped session persists actual provider identity");
    assert.equal(scoped.provider_event_at, new Date(recentMs).toISOString());
  }
}

// Concurrent webhooks for the same customer at different businesses must retain
// their own event time. A later write outside a webhook has no timestamp evidence.
boundary.configure({ supabaseClient: {
  from(table: string) {
    assert.equal(table, "chat_history");
    return { insert(rows: any[]) {
      concurrentRows.push(...structuredClone(rows));
      return { select: async () => ({ error: null }) };
    } };
  },
} });
const concurrentRows: any[] = [];
await Promise.all(["7", "8"].map((businessId, index) => {
  scenarios++;
  return boundary.withMetaInboundEventTime("instagram", "same-customer", now - (index + 1) * hour, businessId, async () => {
    await Promise.resolve();
    await boundary.persistCustomerExchange("same-customer", "instagram", "Input", "Reply", businessId);
  });
}));
for (const [index, businessId] of ["7", "8"].entries()) {
  assert.equal(concurrentRows.find(row => row.sender === "user" && row.business_id === businessId)?.provider_event_at,
    new Date(now - (index + 1) * hour).toISOString());
}
scenarios++;
await boundary.persistCustomerExchange("same-customer", "instagram", "Input", "Reply", "7");
assert.equal(concurrentRows.at(-2)?.provider_event_at, null, "webhook timestamp does not leak into later writes");
boundary.reset();

// Existing normal Messenger conversation replies retain their current payload.
const originalFetch = globalThis.fetch;
try {
  scenarios++;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messaging_type, "RESPONSE");
    assert.equal(body.tag, undefined);
    return new Response("{}", { status: 200 });
  };
  assert.equal(await boundary.sendCustomerMessage("messenger", "customer-7", "Reply", config, "conversation"), true);
} finally {
  globalThis.fetch = originalFetch;
  boundary.reset();
}

mock.timers.reset();
console.log(`reminder delivery policy integration tests passed (${scenarios} scenarios)`);
