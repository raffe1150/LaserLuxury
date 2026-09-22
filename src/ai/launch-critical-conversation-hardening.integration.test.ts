import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.NODE_ENV = "test";
mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T08:00:00.000Z") });
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "7",
  businessRecordId: "7",
  business_id: "7",
  businessName: "Launch Safety Test",
  timezone: "Europe/Stockholm",
  calendarProvider: "custom",
  defaultBookingService: "Consultation",
  services: ["Consultation"],
  serviceDurations: { Consultation: 60 },
};

const exactParams = {
  businessConfig,
  sessionId: "wa:7:customer",
  platform: "whatsapp",
  userId: "46700000000",
  start: "2026-10-23T11:00:00+02:00",
  service: "Consultation",
  durationMinutes: 60,
};

async function exactValidationWith(getEvents: () => Promise<any>) {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getEvents,
      checkSlots: async () => ({ available_slots_string: "" }),
      insertAppointment: async () => ({ success: false }),
    },
  });
  return boundary.exactSlotValidation(exactParams);
}

try {
  const empty = await exactValidationWith(async () => []);
  assert.equal(empty.free, true, "successful empty calendar remains available");

  const conflict = await exactValidationWith(async () => [{
    id: "busy",
    start: { dateTime: "2026-10-23T09:00:00.000Z" },
    end: { dateTime: "2026-10-23T10:00:00.000Z" },
  }]);
  assert.equal(conflict.free, false);
  assert.equal(conflict.category, "calendar_conflict");

  const providerFailure = await exactValidationWith(async () => { throw new Error("provider 503"); });
  assert.equal(providerFailure.free, false);
  assert.equal(providerFailure.category, "calendar_read_failure");

  const malformed = await exactValidationWith(async () => ({ items: [] }));
  assert.equal(malformed.free, false);
  assert.equal(malformed.category, "calendar_read_failure");

  boundary.reset();
  const reservation = {
    businessId: "7",
    calendarIdentity: "calendar-a",
    startTime: "2026-10-23T09:00:00.000Z",
    endTime: "2026-10-23T10:00:00.000Z",
    operationId: "operation-a",
    customerKey: "whatsapp:customer-a",
  };
  const [first, competing] = await Promise.all([
    boundary.claimSlotReservation(reservation),
    boundary.claimSlotReservation({ ...reservation, operationId: "operation-b", customerKey: "whatsapp:customer-b" }),
  ]);
  assert.equal(Number(first.claimed) + Number(competing.claimed), 1, "one durable slot owner wins across concurrent callers");
  const winner = first.claimed ? first : competing;
  const sameOperation = await boundary.claimSlotReservation({
    ...reservation,
    operationId: winner.operationId,
    customerKey: winner.customerKey,
  });
  assert.equal(sameOperation.claimed, true, "same operation reacquires idempotently");
  assert.equal(await boundary.releaseSlotReservation(sameOperation), true);
  const afterRelease = await boundary.claimSlotReservation({ ...reservation, operationId: "operation-c", customerKey: "whatsapp:customer-c" });
  assert.equal(afterRelease.claimed, true, "failed/released booking frees the slot");
  boundary.expireSlotReservation(afterRelease);
  const afterExpiry = await boundary.claimSlotReservation({ ...reservation, operationId: "operation-d", customerKey: "whatsapp:customer-d" });
  assert.equal(afterExpiry.claimed, true, "expired reservation is reclaimable");
  assert.equal(await boundary.settleSlotReservation(afterExpiry), true);
  const sameOperationAfterSettlement = await boundary.claimSlotReservation({
    ...reservation,
    operationId: afterExpiry.operationId,
    customerKey: afterExpiry.customerKey,
  });
  assert.equal(sameOperationAfterSettlement.claimed, false, "same operation cannot reopen a settled reservation");
  const afterSettlement = await boundary.claimSlotReservation({ ...reservation, operationId: "operation-e", customerKey: "whatsapp:customer-e" });
  assert.equal(afterSettlement.claimed, false, "confirmed slot cannot be claimed again");
  boundary.expireSlotReservation(afterExpiry);
  const afterFormerExpiry = await boundary.claimSlotReservation({ ...reservation, operationId: "operation-f", customerKey: "whatsapp:customer-f" });
  assert.equal(afterFormerExpiry.claimed, false, "settled reservation remains terminal beyond its former expiry");
  assert.equal(boundary.slotReservationState(afterExpiry)?.status, "settled");

  const webInfo = boundary.webBookingContained("What services do you offer?", "en");
  assert.equal(webInfo.contained, false, "informational Web support remains available");
  const webBooking = boundary.webBookingContained("Please book Friday at 11", "en");
  assert.equal(webBooking.contained, true);
  assert.match(webBooking.reply, /cannot yet be completed safely/i);
  assert.match(
    boundary.webGuardReply("Your appointment is confirmed for Friday.", "en"),
    /cannot yet be completed safely/i,
    "Web model output cannot falsely claim booking success",
  );
  assert.equal(
    boundary.webGuardReply("We offer consultations on weekdays.", "en"),
    "We offer consultations on weekdays.",
    "informational Web output remains unchanged",
  );

  const whatsappSession = "wa_7:46709999999";
  const seedWhatsAppState = (status: string) => boundary.seedPending(whatsappSession, {
    businessConfig,
    businessId: "7",
    platform: "whatsapp",
    userId: "746709999999",
    sessionId: whatsappSession,
    operation: "new_booking",
    status,
    expectedInput: status === "awaiting_contact" ? "contact" : status === "awaiting_confirmation" ? "confirmation" : "slot_selection",
    service: "Consultation",
    durationMinutes: 60,
    selectedDate: "2026-10-23",
    language: "en",
    offeredSlots: [],
    ownedOfferedSlots: [],
    createdAt: Date.now(),
  });
  for (const [status, message] of [
    ["awaiting_time_selection", "2"],
    ["awaiting_confirmation", "yes"],
    ["awaiting_contact", "Alex Test 0701234567"],
    ["awaiting_contact", "gracias"],
    ["awaiting_contact", "I want to book a new consultation tomorrow"],
  ] as const) {
    boundary.reset();
    seedWhatsAppState(status);
    const plan = await boundary.whatsappStateFirstPlan(whatsappSession, message, businessConfig);
    assert.equal(plan.route, "unified_first", `${status}/${message} must restore state before pre-dispatch classification`);
  }
  boundary.reset();
  const statelessSupport = await boundary.whatsappStateFirstPlan(whatsappSession, "What services do you offer?", businessConfig);
  assert.equal(statelessSupport.route, "support", "stateless support keeps the fast fallback path");

  boundary.reset();
  const events = new Map<string, any>();
  let calendarCreates = 0;
  let databaseCreates = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => "calendar-a",
      getEvents: async () => [...events.values()],
      checkSlots: async () => ({ available_slots_string: "" }),
      insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 60, marker = "") => {
        calendarCreates += 1;
        const event = {
          id: "provider-1",
          status: "confirmed",
          start: { dateTime: new Date(dateTime).toISOString() },
          end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { platform: "whatsapp", userId: marker.replace(/^wa_/, ""), businessId: "7" } },
        };
        events.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    recordAppointment: async (params: any) => {
      databaseCreates += 1;
      return {
        id: "booking-1",
        business_id: "7",
        platform: params.platform,
        user_id: params.userId,
        service: params.service,
        start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(),
        status: "booked",
        created_at: new Date().toISOString(),
      };
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
  });

  const sessionId = "wa_7:46700000000";
  const start = "2026-10-23T11:00:00+02:00";
  const end = "2026-10-23T10:00:00.000Z";
  boundary.seedPending(sessionId, {
    businessConfig,
    businessId: "7",
    platform: "whatsapp",
    userId: "746700000000",
    sessionId,
    operation: "new_booking",
    status: "awaiting_contact",
    expectedInput: "contact",
    service: "Consultation",
    durationMinutes: 60,
    selectedDate: "2026-10-23",
    dateTime: start,
    selectedSlotEnd: end,
    language: "en",
    offeredSlots: [],
    ownedOfferedSlots: [{
      start,
      end,
      durationMinutes: 60,
      service: "Consultation",
      businessId: "7",
      platform: "whatsapp",
      userId: "46700000000",
      generatedAt: Date.now(),
      searchStartDate: "2026-10-23",
      searchEndDate: "2026-10-23",
    }],
  });

  const failedDelivery = await boundary.turn({
    sessionId,
    platformName: "whatsapp",
    recipientUserId: "46700000000",
    text: "My name is Alex Test and my phone is 0701234567",
    businessConfig,
    sendThrows: true,
  });
  assert.equal(failedDelivery.handled, true);
  assert.equal(calendarCreates, 1);
  assert.equal(databaseCreates, 1);

  boundary.dropBookingSessionMemory(sessionId);
  const recovered = await boundary.turn({
    sessionId,
    platformName: "whatsapp",
    recipientUserId: "46700000000",
    text: "Please confirm",
    businessConfig,
  });
  assert.equal(calendarCreates, 1, "restart recovery does not repeat calendar mutation");
  assert.equal(databaseCreates, 1, "restart recovery does not repeat database mutation");
  assert.equal(recovered.replies.length, 1, "exact durable confirmation is delivered later");
  assert.match(recovered.replies[0], /Service: Consultation/i);
  const deliveredOutbox = boundary.bookingOutboxForSession(sessionId);
  assert.equal(deliveredOutbox?.status, "delivered");
  assert.ok(deliveredOutbox?.delivery_token);
  assert.equal(
    await boundary.completeBookingOutboxDelivery(deliveredOutbox.operation_id, deliveredOutbox.delivery_token, true),
    true,
    "same delivery token receives the existing terminal success",
  );
  assert.equal(
    await boundary.completeBookingOutboxDelivery(deliveredOutbox.operation_id, crypto.randomUUID(), true),
    false,
    "foreign delivery token cannot acknowledge a delivered record",
  );
  assert.equal(await boundary.claimBookingOutboxDelivery(deliveredOutbox.operation_id, crypto.randomUUID()), null);
  assert.equal(boundary.bookingOutboxState(deliveredOutbox.operation_id)?.status, "delivered");

  const deliveredAgain = await boundary.turn({
    sessionId,
    platformName: "whatsapp",
    recipientUserId: "46700000000",
    text: "Thanks",
    businessConfig,
  });
  assert.equal(calendarCreates, 1);
  assert.equal(databaseCreates, 1);
  assert.equal(deliveredAgain.replies.filter((reply: string) => reply === recovered.replies[0]).length, 0, "delivered outbox is not resent");

  console.log("launch-critical conversation hardening integration tests passed");
} finally {
  boundary.reset();
  mock.timers.reset();
}
