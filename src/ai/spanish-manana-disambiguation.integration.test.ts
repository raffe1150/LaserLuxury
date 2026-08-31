import assert from "node:assert/strict";
import {
  classifySpanishManana,
  normalizeBookingRequest,
} from "./booking-intelligence";

process.env.NODE_ENV = "test";
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;

const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const timezone = "Europe/Stockholm";
const liveNow = new Date("2026-08-31T10:00:00+02:00");
const weekdayNow = new Date("2026-09-02T10:00:00+02:00");

function normalized(text: string, now = liveNow) {
  return normalizeBookingRequest({
    businessId: "3",
    channel: "instagram",
    conversationKey: text,
    inputMode: "text",
    text,
    activeLanguage: "es",
    timezone,
    now,
  });
}

const businessConfig = {
  id: "3",
  businessRecordId: "3",
  businessName: "admotion studio",
  language: "es",
  timezone,
  calendarProvider: "custom",
  googleCalendarId: "cal-3",
  services: [{
    id: "video-consultation",
    name: "Video Consultation",
    durationMinutes: 60,
  }],
  workingHours: Object.fromEntries(
    ["monday", "tuesday", "wednesday", "thursday", "friday"]
      .map((day) => [day, [
        { start: "09:00", end: "13:00" },
        { start: "13:00", end: "14:00" },
        { start: "14:00", end: "21:00" },
      ]]),
  ),
};

function fixture() {
  boundary.reset();
  const diagnostics: any[] = [];
  let calendarReads = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => "cal-3",
      getEvents: async () => {
        calendarReads += 1;
        return [];
      },
      checkSlots: async () => {
        throw new Error("legacy availability path must not run");
      },
    },
    availabilityDiagnostic: (diagnostic: any) => diagnostics.push(structuredClone(diagnostic)),
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  return { diagnostics, calendarReads: () => calendarReads };
}

async function turn(sessionId: string, text: string, now = liveNow) {
  return boundary.turn({
    sessionId,
    platformName: "instagram",
    recipientUserId: sessionId,
    text,
    businessConfig,
    now,
  });
}

function assertRelativeDate(text: string, relative: string, value: string, now = liveNow) {
  const request = normalized(text, now);
  assert.equal(request.date?.kind, "relative_date", text);
  assert.equal(request.date?.relative, relative, text);
  assert.equal(request.date?.value, value, text);
}

try {
  for (const text of [
    "Quiero reservar para mañana.",
    "Hola, quiero reservar una cita para mañana.",
    "Quiero reservar para manana.",
  ]) {
    assertRelativeDate(text, "tomorrow", "2026-09-01");
    assert.deepEqual(classifySpanishManana(text), {
      relativeTomorrow: true,
      morningDaypart: false,
    });
  }

  for (const text of [
    "Quiero reservar mañana por la mañana.",
    "Quiero reservar mañana en la mañana.",
    "Quiero reservar manana por la manana.",
    "Quiero reservar manana en la manana.",
  ]) {
    assertRelativeDate(text, "tomorrow", "2026-09-01");
    assert.deepEqual(classifySpanishManana(text), {
      relativeTomorrow: true,
      morningDaypart: true,
    });
  }

  for (const text of [
    "¿Tienes algo por la mañana?",
    "¿Tienes algo en la mañana?",
    "¿Tienes algo por la manana?",
  ]) {
    assert.equal(normalized(text).date, undefined, text);
    assert.deepEqual(classifySpanishManana(text), {
      relativeTomorrow: false,
      morningDaypart: true,
    });
  }

  const tuesdayMorning = "Quiero reservar el martes por la mañana.";
  const tuesdayRequest = normalized(tuesdayMorning, weekdayNow);
  assert.equal(tuesdayRequest.date?.kind, "weekday");
  assert.equal(tuesdayRequest.date?.weekday, 2);
  assert.equal(tuesdayRequest.date?.value, "2026-09-08");
  assert.deepEqual(classifySpanishManana(tuesdayMorning), {
    relativeTomorrow: false,
    morningDaypart: true,
  });

  for (const text of [
    "Quiero reservar pasado mañana.",
    "Quiero reservar pasado manana.",
  ]) {
    assertRelativeDate(text, "day_after_tomorrow", "2026-09-02");
    assert.deepEqual(classifySpanishManana(text), {
      relativeTomorrow: false,
      morningDaypart: false,
    });
  }

  for (const text of [
    "Quiero reservar pasado mañana por la mañana.",
    "Quiero reservar pasado manana por la manana.",
  ]) {
    assertRelativeDate(text, "day_after_tomorrow", "2026-09-02");
    assert.deepEqual(classifySpanishManana(text), {
      relativeTomorrow: false,
      morningDaypart: true,
    });
  }

  const liveFixture = fixture();
  const live = await turn(
    "spanish-manana-live",
    "Hola, quiero reservar una cita para mañana.",
  );
  assert.equal(live.pending?.selectedDate, "2026-09-01");
  assert.equal(live.pending?.durationMinutes, 60);
  assert.equal(live.pending?.availabilityConstraint?.kind, "whole_day");
  assert.equal(live.pending?.availabilityConstraint?.minTime, undefined);
  assert.equal(live.pending?.availabilityConstraint?.maxTime, undefined);
  assert.equal(liveFixture.calendarReads(), 1);
  assert.equal(liveFixture.diagnostics.length, 1);
  const liveDiagnostic = liveFixture.diagnostics[0];
  assert.equal(liveDiagnostic.request.selectedDate, "2026-09-01");
  assert.equal(liveDiagnostic.request.canonicalConstraintKind, "whole_day");
  assert.equal(liveDiagnostic.request.runtimeDurationMinutes, 60);
  assert.equal(liveDiagnostic.snapshot.calendarReadCount, 1);
  assert.equal(liveDiagnostic.snapshot.pendingSnapshotCount, 1);
  assert.equal(liveDiagnostic.candidates.candidateSlotCount, 39);
  assert.equal(liveDiagnostic.candidates.constraintBlockedCount, 0);

  const rankedWholeDay = liveDiagnostic.finalRankedOfferedSlots;
  const controlFixture = fixture();
  const wholeDayControl = await boundary.canonicalOffers({
    businessConfig,
    sessionId: "spanish-manana-whole-day-control",
    platform: "instagram",
    userId: "spanish-manana-whole-day-control",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
    service: "Video Consultation",
    durationMinutes: 60,
    diagnosticContext: {
      language: "es",
      selectedDate: "2026-09-01",
      canonicalConstraintKind: "whole_day",
    },
  });
  assert.deepEqual(
    rankedWholeDay,
    wholeDayControl.ownedSlots.map((slot: any) => ({ start: slot.start, end: slot.end })),
  );
  assert.equal(controlFixture.calendarReads(), 1);

  const morningFixture = fixture();
  const tomorrowMorning = await turn(
    "spanish-manana-tomorrow-morning",
    "Hola, quiero reservar una cita para mañana por la mañana.",
  );
  assert.equal(tomorrowMorning.pending?.selectedDate, "2026-09-01");
  assert.equal(tomorrowMorning.pending?.availabilityConstraint?.kind, "daypart");
  assert.equal(tomorrowMorning.pending?.availabilityConstraint?.daypart, "morning");
  assert.equal(tomorrowMorning.pending?.availabilityConstraint?.minTime, "09:00");
  assert.equal(tomorrowMorning.pending?.availabilityConstraint?.maxTime, "11:59");
  assert.equal(morningFixture.diagnostics[0].candidates.constraintBlockedCount, 27);

  fixture();
  const accentlessTomorrowMorning = await turn(
    "spanish-manana-accentless-morning",
    "Hola, quiero reservar una cita para manana en la manana.",
  );
  assert.equal(accentlessTomorrowMorning.pending?.selectedDate, "2026-09-01");
  assert.equal(accentlessTomorrowMorning.pending?.availabilityConstraint?.kind, "daypart");
  assert.equal(accentlessTomorrowMorning.pending?.availabilityConstraint?.daypart, "morning");

  fixture();
  const explicitTuesday = await turn(
    "spanish-manana-explicit-tuesday",
    "Hola, quiero reservar una cita para el martes por la mañana.",
    weekdayNow,
  );
  assert.equal(explicitTuesday.pending?.selectedDate, "2026-09-08");
  assert.equal(explicitTuesday.pending?.availabilityConstraint?.kind, "daypart");
  assert.equal(explicitTuesday.pending?.availabilityConstraint?.daypart, "morning");

  const contextFixture = fixture();
  const contextDate = await turn(
    "spanish-manana-context",
    "Hola, quiero reservar una cita para el viernes.",
    weekdayNow,
  );
  assert.equal(contextDate.pending?.selectedDate, "2026-09-04");
  assert.equal(contextDate.pending?.availabilityConstraint?.kind, "whole_day");
  const morningFollowUp = await turn(
    "spanish-manana-context",
    "¿Tienes algo por la mañana?",
    weekdayNow,
  );
  assert.equal(morningFollowUp.pending?.selectedDate, "2026-09-04");
  assert.equal(morningFollowUp.pending?.availabilityConstraint?.kind, "daypart");
  assert.equal(morningFollowUp.pending?.availabilityConstraint?.daypart, "morning");
  assert.equal(contextFixture.diagnostics.at(-1).request.selectedDate, "2026-09-04");

  fixture();
  const dayAfterTomorrow = await turn(
    "spanish-manana-day-after",
    "Hola, quiero reservar una cita para pasado mañana.",
  );
  assert.equal(dayAfterTomorrow.pending?.selectedDate, "2026-09-02");
  assert.equal(dayAfterTomorrow.pending?.availabilityConstraint?.kind, "whole_day");

  fixture();
  const dayAfterTomorrowMorning = await turn(
    "spanish-manana-day-after-morning",
    "Hola, quiero reservar una cita para pasado mañana por la mañana.",
  );
  assert.equal(dayAfterTomorrowMorning.pending?.selectedDate, "2026-09-02");
  assert.equal(dayAfterTomorrowMorning.pending?.availabilityConstraint?.kind, "daypart");
  assert.equal(dayAfterTomorrowMorning.pending?.availabilityConstraint?.daypart, "morning");
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}

console.log("Spanish mañana date/daypart disambiguation regressions passed");
