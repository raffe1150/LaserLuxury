import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

type Appointment = {
  id: string;
  business_id: string;
  customer_name: string;
  phone_number: string;
  platform: string;
  user_id: string;
  service: string;
  start_time: string;
  end_time: string;
  status: string;
  reminder_24_sent: boolean;
  reminder_2_sent: boolean;
};

class ReminderDatabase {
  constructor(readonly row: Appointment) {}

  from(table: string) {
    assert.equal(table, "appointments");
    return {
      update: (values: Partial<Appointment>) => ({
        eq: async (column: keyof Appointment, value: unknown) => {
          if (this.row[column] === value) Object.assign(this.row, values);
          return { error: null };
        },
      }),
    };
  }
}

const start = "2026-08-22T12:00:00.000Z";
const end = "2026-08-22T12:30:00.000Z";

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appointment-1",
    business_id: "7",
    customer_name: "Reminder Customer",
    phone_number: "0701234567",
    platform: "telegram",
    user_id: "owner-7",
    service: "Consultation",
    start_time: start,
    end_time: end,
    status: "booked",
    reminder_24_sent: false,
    reminder_2_sent: false,
    ...overrides,
  };
}

function event(id = "event-1") {
  return {
    id,
    status: "confirmed",
    description: "Tjänst: Consultation\nTelegramChatId: tg_owner-7",
    start: { dateTime: start },
    end: { dateTime: end },
    extendedProperties: {
      private: {
        platform: "telegram",
        userId: "owner-7",
      },
    },
  };
}

const businessConfig = {
  businessRecordId: "7",
  business_id: "7",
  googleCalendarId: "calendar-7",
  calendarProvider: "google",
  businessName: "Business 7",
};

async function runCandidate(options: {
  appointment?: Appointment;
  events?: any[];
  calendarId?: string;
  businessConfig?: any;
  readError?: Error;
  sendSucceeds?: boolean;
  reminderType?: "24h" | "2h";
}) {
  const row = options.appointment || appointment();
  const database = new ReminderDatabase(row);
  const deliveries: string[] = [];
  const reminderType = options.reminderType || "24h";
  boundary.reset();
  boundary.configure({
    supabaseClient: database,
    loadBusinessConfigById: async () => options.businessConfig || businessConfig,
    calendarAdapter: {
      getCalendarId: () => options.calendarId || "calendar-7",
      getEvents: async () => {
        if (options.readError) throw options.readError;
        return options.events || [];
      },
      checkSlots: async () => ({ available_slots_string: "" }),
      insertAppointment: async () => ({ success: false }),
    },
    sendReminder: async (_appointment: Appointment, type: "24h" | "2h") => {
      deliveries.push(type);
      return options.sendSucceeds !== false;
    },
  });
  const result = await boundary.processReminderCandidate(
    row,
    reminderType,
    reminderType === "24h" ? "reminder_24_sent" : "reminder_2_sent",
  );
  return { row, deliveries, result };
}

try {
  const valid24h = await runCandidate({ events: [event()], reminderType: "24h" });
  assert.equal(valid24h.result.sent, true);
  assert.equal(valid24h.result.category, "verified");
  assert.deepEqual(valid24h.deliveries, ["24h"]);
  assert.equal(valid24h.row.reminder_24_sent, true);
  assert.equal(valid24h.row.reminder_2_sent, false);

  const valid2h = await runCandidate({ events: [event()], reminderType: "2h" });
  assert.equal(valid2h.result.sent, true);
  assert.deepEqual(valid2h.deliveries, ["2h"]);
  assert.equal(valid2h.row.reminder_24_sent, false);
  assert.equal(valid2h.row.reminder_2_sent, true);

  const missing = await runCandidate({ events: [] });
  assert.equal(missing.result.category, "stale_calendar_event_missing");
  assert.equal(missing.deliveries.length, 0);
  assert.equal(missing.row.reminder_24_sent, false);

  const readFailure = await runCandidate({ readError: new Error("calendar unavailable") });
  assert.equal(readFailure.result.category, "calendar_read_error");
  assert.equal(readFailure.deliveries.length, 0);
  assert.equal(readFailure.row.reminder_24_sent, false);

  const wrongBusiness = await runCandidate({
    businessConfig: { ...businessConfig, businessRecordId: "8", business_id: "8" },
    events: [event()],
  });
  assert.equal(wrongBusiness.result.category, "business_scope_mismatch");
  assert.equal(wrongBusiness.deliveries.length, 0);

  const wrongCalendar = await runCandidate({ calendarId: "calendar-8", events: [event()] });
  assert.equal(wrongCalendar.result.category, "calendar_scope_mismatch");
  assert.equal(wrongCalendar.deliveries.length, 0);

  const ambiguous = await runCandidate({ events: [event("event-1"), event("event-2")] });
  assert.equal(ambiguous.result.category, "stale_calendar_event_ambiguous");
  assert.equal(ambiguous.deliveries.length, 0);
  assert.equal(ambiguous.row.reminder_24_sent, false);

  const deliveryFailure = await runCandidate({ events: [event()], sendSucceeds: false });
  assert.equal(deliveryFailure.result.category, "delivery_failed");
  assert.equal(deliveryFailure.deliveries.length, 1);
  assert.equal(deliveryFailure.row.reminder_24_sent, false,
    "the reminder flag changes only after successful delivery");
} finally {
  boundary.reset();
}

console.log("reminder calendar verification integration tests passed");
