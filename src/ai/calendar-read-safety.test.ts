import assert from "node:assert/strict";
import test from "node:test";
import { CalendarReadFailure, readCalendarEventsStrict } from "./calendar-read-safety";

test("strict calendar read accepts a successful empty calendar", async () => {
  assert.deepEqual(await readCalendarEventsStrict({ read: async () => [] }), []);
});

test("strict calendar read preserves successful conflicting events", async () => {
  const events = [{ id: "busy", startTime: "2026-10-01T10:00:00Z" }];
  assert.deepEqual(await readCalendarEventsStrict({ read: async () => events }), events);
});

test("strict calendar read fails closed on timeout", async () => {
  await assert.rejects(
    readCalendarEventsStrict({
      read: () => new Promise(() => undefined),
      timeoutMs: 10,
    }),
    (error: unknown) => error instanceof CalendarReadFailure && error.causeCategory === "timeout",
  );
});

test("strict calendar read fails closed on provider error", async () => {
  await assert.rejects(
    readCalendarEventsStrict({ read: async () => { throw new Error("provider 503"); } }),
    (error: unknown) => error instanceof CalendarReadFailure && error.causeCategory === "provider",
  );
});

test("strict calendar read fails closed on malformed provider response", async () => {
  await assert.rejects(
    readCalendarEventsStrict({ read: async () => ({ events: [] }) }),
    (error: unknown) => error instanceof CalendarReadFailure && error.causeCategory === "malformed",
  );
});
