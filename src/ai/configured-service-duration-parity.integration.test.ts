import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;

const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

type Channel = "instagram" | "whatsapp" | "messenger" | "telegram";

const channels: Channel[] = ["instagram", "whatsapp", "messenger", "telegram"];
const now = new Date("2030-09-01T12:00:00+02:00");
const selectedDate = "2030-09-13";

function businessConfig(channel: Channel, durationMinutes: number | null = 60) {
  return {
    id: `duration-parity-${channel}`,
    businessRecordId: `duration-parity-${channel}`,
    businessName: "Duration Parity Clinic",
    language: "en",
    timezone: "Europe/Stockholm",
    calendarProvider: "custom",
    googleCalendarId: `duration-parity-${channel}@example.com`,
    defaultBookingService: "Video Consultation",
    services: [{
      id: "video-consultation",
      name: "Video Consultation",
      ...(durationMinutes === null ? {} : { durationMinutes }),
    }],
    workingHours: Object.fromEntries(
      ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        .map((day) => [day, [{ start: "09:00", end: "10:00" }]]),
    ),
  };
}

function localTime(iso: string) {
  return new Date(iso).toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createFixture(config: any) {
  boundary.reset();
  const events = new Map<string, any>();
  const diagnostics: any[] = [];
  const claims = new Map<string, any>();
  const counters = {
    calendarReads: 0,
    calendarCreates: 0,
    databaseInserts: 0,
    createdDuration: null as number | null,
    databaseDuration: null as number | null,
    databaseStart: null as string | null,
    databaseEnd: null as string | null,
  };

  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => config.googleCalendarId,
      getEvents: async () => {
        counters.calendarReads += 1;
        return [...events.values()];
      },
      checkSlots: async () => {
        throw new Error("legacy availability path must not run");
      },
      insertAppointment: async (
        _name: string,
        _phone: string,
        service: string,
        dateTime: string,
        durationMinutes: number,
        marker: string,
      ) => {
        counters.calendarCreates += 1;
        counters.createdDuration = durationMinutes;
        const platform = marker.startsWith("ig_")
          ? "instagram"
          : marker.startsWith("wa_")
            ? "whatsapp"
            : marker.startsWith("ms_")
              ? "messenger"
              : "telegram";
        const userId = marker.replace(/^(?:ig_|wa_|ms_|tg_)/, "");
        const start = new Date(dateTime).toISOString();
        const end = new Date(new Date(start).getTime() + durationMinutes * 60_000).toISOString();
        const event = {
          id: `event-${counters.calendarCreates}`,
          status: "confirmed",
          start: { dateTime: start },
          end: { dateTime: end },
          extendedProperties: { private: { platform, userId } },
          description: `Service: ${service}`,
        };
        events.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => {
        events.delete(id);
        return { success: true };
      },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    availabilityDiagnostic: (diagnostic: any) => diagnostics.push(structuredClone(diagnostic)),
    recordAppointment: async (params: any) => {
      counters.databaseInserts += 1;
      counters.databaseDuration = Number(params.durationMinutes);
      const start = new Date(params.dateTime).toISOString();
      const end = new Date(
        new Date(start).getTime() + Number(params.durationMinutes) * 60_000,
      ).toISOString();
      counters.databaseStart = start;
      counters.databaseEnd = end;
      return {
        id: counters.databaseInserts,
        business_id: config.id,
        platform: params.platform,
        user_id: String(params.userId),
        service: params.service,
        start_time: start,
        end_time: end,
        status: "booked",
        created_at: new Date().toISOString(),
      };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing) return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      const handle = {
        claimed: true,
        keyHash: key,
        storageId: key,
        state: {
          type: params.type,
          status: "processing",
          attempts: 1,
          claimedAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: "completed" | "failed") => {
      handle.state.status = status;
      return true;
    },
    notifyBooking: async () => true,
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);

  return { events, diagnostics, counters };
}

async function turn(channel: Channel, sessionId: string, text: string, config: any) {
  return boundary.turn({
    sessionId,
    platformName: channel,
    recipientUserId: `${channel}-user`,
    text,
    businessConfig: config,
    now,
  });
}

try {
  const rankedOffersByChannel: Record<string, any> = {};

  for (const channel of channels) {
    const config = businessConfig(channel);
    const { events, diagnostics, counters } = createFixture(config);
    const sessionId = `${channel}-duration-parity`;

    const offered = await turn(
      channel,
      sessionId,
      "Book a Video Consultation next Friday at 09:00.",
      config,
    );

    assert.equal(offered.pending?.status, "awaiting_confirmation", channel);
    assert.equal(offered.pending?.service, "Video Consultation", channel);
    assert.equal(offered.pending?.selectedDate, selectedDate, channel);
    assert.equal(offered.pending?.durationMinutes, 60, channel);
    assert.equal(offered.pending?.ownedOfferedSlots?.length, 1, channel);
    const selected = offered.pending.ownedOfferedSlots[0];
    assert.equal(localTime(selected.start), "09:00", channel);
    assert.equal((new Date(selected.end).getTime() - new Date(selected.start).getTime()) / 60_000, 60, channel);
    assert.equal(counters.calendarReads, 1, `${channel}: initial canonical scan uses one calendar read`);
    assert.equal(diagnostics.length, 1, `${channel}: initial canonical scan emits one diagnostic`);
    assert.equal(diagnostics[0].request.runtimeDurationMinutes, 60, channel);
    assert.equal(diagnostics[0].snapshot.calendarReadCount, 1, channel);
    assert.equal(diagnostics[0].snapshot.pendingSnapshotCount, 1, channel);
    rankedOffersByChannel[channel] = diagnostics[0].finalRankedOfferedSlots;

    const confirmed = await turn(channel, sessionId, "Yes, please book it.", config);
    assert.equal(confirmed.pending?.status, "awaiting_contact", channel);
    const completed = await turn(
      channel,
      sessionId,
      "My name is Alex Testsson and my mobile number is +46701234567.",
      config,
    );
    assert.equal(completed.pending, null, channel);
    assert.equal(counters.calendarCreates, 1, channel);
    assert.equal(counters.createdDuration, 60, channel);
    assert.equal(counters.databaseInserts, 1, channel);
    assert.equal(counters.databaseDuration, 60, channel);
    assert.equal(
      (new Date(counters.databaseEnd!).getTime() - new Date(counters.databaseStart!).getTime()) / 60_000,
      60,
      channel,
    );
    const createdEvent = [...events.values()][0];
    assert.ok(createdEvent, channel);
    assert.equal(
      (new Date(createdEvent.end.dateTime).getTime() - new Date(createdEvent.start.dateTime).getTime()) / 60_000,
      60,
      channel,
    );

    createFixture(config);
    const fitsThirty = await boundary.canonicalOffers({
      businessConfig: config,
      sessionId: `${channel}-fit-control`,
      platform: channel,
      userId: `${channel}-fit-control-user`,
      startDate: selectedDate,
      endDate: selectedDate,
      service: "Video Consultation",
      durationMinutes: 30,
      options: { minTime: "09:15", maxTime: "09:15" },
    });
    assert.equal(fitsThirty.ownedSlots.length, 1, `${channel}: control slot fits 30 minutes`);

    const sixtyFixture = createFixture(config);
    const rejectsSixty = await boundary.canonicalOffers({
      businessConfig: config,
      sessionId: `${channel}-fit-sixty`,
      platform: channel,
      userId: `${channel}-fit-sixty-user`,
      startDate: selectedDate,
      endDate: selectedDate,
      service: "Video Consultation",
      durationMinutes: 60,
      options: { minTime: "09:15", maxTime: "09:15" },
    });
    assert.equal(rejectsSixty.ownedSlots.length, 0, `${channel}: slot that cannot fit 60 minutes is rejected`);
    assert.equal(sixtyFixture.counters.calendarReads, 1, `${channel}: fit scan uses one calendar read`);
    assert.equal(sixtyFixture.diagnostics[0].snapshot.pendingSnapshotCount, 1, `${channel}: fit scan uses one pending snapshot`);
  }

  assert.deepEqual(rankedOffersByChannel.instagram, rankedOffersByChannel.whatsapp);
  assert.deepEqual(rankedOffersByChannel.instagram, rankedOffersByChannel.messenger);
  assert.deepEqual(rankedOffersByChannel.instagram, rankedOffersByChannel.telegram);

  const fallbackConfig = businessConfig("instagram", null);
  const fallbackFixture = createFixture(fallbackConfig);
  const fallback = await turn(
    "instagram",
    "instagram-duration-fallback",
    "Book a Video Consultation next Friday at 09:00.",
    fallbackConfig,
  );
  assert.equal(fallback.pending?.durationMinutes, 30);
  assert.equal(fallbackFixture.diagnostics[0].request.runtimeDurationMinutes, 30);
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}

console.log("configured service duration parity integration tests passed");
