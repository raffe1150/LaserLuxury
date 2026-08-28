import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "pending-lifecycle",
  businessRecordId: "pending-lifecycle",
  business_id: "pending-lifecycle",
  businessName: "Pending Lifecycle Test",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
  defaultBookingService: "Konsultation",
  services: ["Konsultation"],
  serviceDurations: { Konsultation: 60 },
};

function fixture(options: { failCalendarCreate?: boolean } = {}) {
  boundary.reset();
  const events = new Map<string, any>();
  let sequence = 0;
  const counters = { calendarCreate: 0, databaseInsert: 0 };
  const adapter = {
    getEvents: async () => [...events.values()],
    checkSlots: () => ({ available_slots_string: "" }),
    insertAppointment: async (_name: string, _phone: string, _service: string, dateTime: string, duration = 60, marker = "") => {
      counters.calendarCreate += 1;
      if (options.failCalendarCreate) return { success: false, code: "PROVIDER_FAILED" };
      const id = `event-${++sequence}`;
      const platform = marker.startsWith("wa_") ? "whatsapp" : "telegram";
      const userId = marker.replace(/^(?:wa_|tg_)/, "");
      const event = {
        id,
        status: "confirmed",
        summary: "Booked",
        start: { dateTime: new Date(dateTime).toISOString() },
        end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
        extendedProperties: { private: { platform, userId, businessId: "pending-lifecycle" } },
      };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => events.get(id) || null,
    cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
    verifyEventDeleted: async (id: string) => !events.has(id),
  };
  boundary.configure({
    calendarAdapter: adapter,
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      return ({
      id: 1,
      business_id: "pending-lifecycle",
      platform: params.platform,
      user_id: params.userId,
      service: params.service,
      start_time: new Date(params.dateTime).toISOString(),
      end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(),
      status: "booked",
      created_at: new Date().toISOString(),
      });
    },
    claimOperation: async () => ({ claimed: true, keyHash: "claim", storageId: "claim", state: { status: "processing" } }),
    settleOperation: async () => true,
    notifyBooking: async () => true,
    postProcess: async () => undefined,
  });
  return { events, counters };
}

const turn = (sessionId: string, userId: string, text: string) => boundary.turn({
  sessionId,
  platformName: "whatsapp",
  recipientUserId: userId,
  text,
  businessConfig,
});
const slotIsOfferedTo = async (sessionId: string, userId: string, date: string, time: string) => {
  const result = await boundary.canonicalOffers({
    businessConfig,
    sessionId,
    platform: "whatsapp",
    userId,
    startDate: date,
    endDate: date,
    service: "Konsultation",
    durationMinutes: 60,
    requestedTime: time,
  });
  return result.ownedSlots.some((slot: any) => slot.start.startsWith(`${date}T${time}:`));
};

try {
  {
    const { events, counters } = fixture();
    const inquiry = await turn(
      "wa_exact-inquiry",
      "exact-inquiry",
      "Är klockan 11 ledig fredagen den 23 oktober 2026?"
    );
    assert.match(inquiry.replies.join(" "), /11:00/);
    assert.equal(inquiry.pending.status, "awaiting_time_selection");
    assert.equal(inquiry.pending.readOnlyExactAvailabilityInquiry, true);
    assert.equal(inquiry.pending.dateTime, null);
    assert.equal(inquiry.pending.selectedSlotEnd, null);
    assert.equal(
      await slotIsOfferedTo("wa_exact-observer", "exact-observer", "2026-10-23", "11:00"),
      true,
      "read-only inquiry must leave pendingHoldCount at zero"
    );
    assert.equal(counters.calendarCreate, 0);
    assert.equal(counters.databaseInsert, 0);
    assert.equal(events.size, 0);

    const confirmed = await turn("wa_exact-inquiry", "exact-inquiry", "Ja, boka den åt mig");
    assert.equal(confirmed.pending.status, "awaiting_contact");
    assert.equal(confirmed.pending.dateTime.slice(0, 16), "2026-10-23T11:00");
    assert.ok(confirmed.pending.selectedSlotEnd);
    assert.equal(
      await slotIsOfferedTo("wa_exact-observer", "exact-observer", "2026-10-23", "11:00"),
      false,
      "explicit confirmation may create the pending hold"
    );
    assert.equal(counters.calendarCreate, 0);
    assert.equal(counters.databaseInsert, 0);
    assert.equal(events.size, 0);
  }

  fixture();
  const selected = await turn("wa_holder-a", "holder-a", "Book a consultation on 2026-08-21 at 14:15");
  assert.equal(selected.pending.status, "awaiting_confirmation");
  assert.equal(selected.pending.dateTime.slice(0, 16), "2026-08-21T14:15");
  assert.equal(selected.pending.ownedOfferedSlots.length, 1);
  assert.equal(await slotIsOfferedTo("wa_other-b", "other-b", "2026-08-21", "14:15"), false);

  const continued = await turn("wa_holder-a", "holder-a", "Yes");
  assert.equal(continued.pending.status, "awaiting_contact");
  assert.equal(continued.pending.dateTime.slice(0, 16), "2026-08-21T14:15");
  const rejected = await turn("wa_holder-a", "holder-a", "No, another time");
  assert.equal(rejected.pending.status, "awaiting_time_selection");
  assert.equal(rejected.pending.dateTime, null);
  assert.equal(rejected.pending.selectedSlotEnd, null);
  assert.equal(await slotIsOfferedTo("wa_other-b", "other-b", "2026-08-21", "14:15"), true);

  fixture();
  await turn("wa_date-change", "date-change", "Book a consultation on 2026-08-21 at 14:15");
  await turn("wa_date-change", "date-change", "2026-08-24 instead");
  assert.equal(await slotIsOfferedTo("wa_date-observer", "date-observer", "2026-08-21", "14:15"), true);

  fixture();
  await turn("wa_time-change", "time-change", "Book a consultation on 2026-08-21 at 14:15");
  const changedTime = await turn("wa_time-change", "time-change", "2026-08-21 at 16:00 instead");
  assert.equal(changedTime.pending.dateTime.slice(0, 16), "2026-08-21T16:00");
  assert.equal(await slotIsOfferedTo("wa_time-observer", "time-observer", "2026-08-21", "14:15"), true);
  assert.equal(await slotIsOfferedTo("wa_time-observer", "time-observer", "2026-08-21", "16:00"), false);

  fixture();
  const expiredSlot = {
    start: "2026-08-21T14:15:00+02:00",
    end: "2026-08-21T13:15:00.000Z",
    durationMinutes: 60,
    service: "Konsultation",
    businessId: "pending-lifecycle",
    platform: "whatsapp",
    userId: "expired-user",
    generatedAt: Date.now(),
  };
  boundary.seedPending("wa_expired", {
    businessId: "pending-lifecycle",
    businessConfig,
    platform: "whatsapp",
    userId: "expired-user",
    status: "awaiting_contact",
    operation: "new_booking",
    dateTime: expiredSlot.start,
    selectedSlotEnd: expiredSlot.end,
    durationMinutes: 60,
    ownedOfferedSlots: [expiredSlot],
    createdAt: Date.now() - 60 * 60 * 1000,
    updatedAt: Date.now(),
  });
  assert.equal(await slotIsOfferedTo("wa_expired-observer", "expired-observer", "2026-08-21", "14:15"), true);

  const { events } = fixture();
  await turn("wa_complete", "complete", "Book a consultation on 2026-08-21 at 14:15");
  await turn("wa_complete", "complete", "Yes");
  const completed = await turn("wa_complete", "complete", "Arman 0701234567");
  assert.equal(completed.pending, null);
  assert.equal(events.size, 1);
  assert.equal(await slotIsOfferedTo("wa_complete-observer", "complete-observer", "2026-08-21", "14:15"), false);

  fixture();
  await turn("wa_abort", "abort", "Book a consultation on 2026-08-21 at 14:15");
  await turn("wa_abort", "abort", "Cancel my booking");
  assert.equal(boundary.pendingStateSnapshot("wa_abort"), null);
  assert.equal(await slotIsOfferedTo("wa_abort-observer", "abort-observer", "2026-08-21", "14:15"), true);

  fixture({ failCalendarCreate: true });
  await turn("wa_recoverable", "recoverable", "Book a consultation on 2026-08-21 at 14:15");
  await turn("wa_recoverable", "recoverable", "Yes");
  const failed = await turn("wa_recoverable", "recoverable", "Arman 0701234567");
  assert.equal(failed.pending.status, "failed_recoverable");
  assert.equal(failed.pending.retryEligible, true);
  assert.equal(await slotIsOfferedTo("wa_recovery-observer", "recovery-observer", "2026-08-21", "14:15"), false);

  const nonRetryableSlot = { ...failed.pending.ownedOfferedSlots[0], userId: "non-retryable" };
  boundary.seedPending("wa_non-retryable", {
    ...failed.pending,
    userId: "non-retryable",
    sessionId: "wa_non-retryable",
    ownedOfferedSlots: [nonRetryableSlot],
    retryEligible: false,
  });
  assert.equal(await slotIsOfferedTo("wa_nonretry-observer", "nonretry-observer", "2026-08-21", "14:15"), false, "the original recoverable claim still blocks");
  boundary.reset();
  boundary.configure({ calendarAdapter: { getEvents: async () => [], checkSlots: () => ({}), insertAppointment: () => ({ success: false }) } });
  boundary.seedPending("wa_non-retryable", {
    ...failed.pending,
    userId: "non-retryable",
    sessionId: "wa_non-retryable",
    ownedOfferedSlots: [nonRetryableSlot],
    retryEligible: false,
  });
  assert.equal(await slotIsOfferedTo("wa_nonretry-observer", "nonretry-observer", "2026-08-21", "14:15"), true);
} finally {
  boundary.reset();
}

console.log("pending hold lifecycle integration tests passed");
