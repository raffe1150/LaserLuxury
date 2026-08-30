import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type MetaChannel = 'instagram' | 'whatsapp';

const now = new Date('2026-08-30T10:00:00+02:00');
const initialBookingText = 'Hej, jag vill boka en tid till i morgon.';
const serviceAndDateText = 'Jag vill boka en Video Consultation till i morgon.';
const businessConfig = {
  id: '3',
  businessRecordId: '3',
  businessName: 'admotion studio',
  language: 'sv',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-3',
  services: [{ name: 'Video Consultation', duration: 60 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, [{ start: '09:00', end: '17:00' }]]),
  ),
};

function configure() {
  boundary.reset();
  const reads: Array<{ startDate: string; endDate: string }> = [];
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-3',
      getEvents: async (startDate: string, endDate: string) => {
        reads.push({ startDate, endDate });
        return [];
      },
      checkSlots: async () => {
        throw new Error('legacy availability path must not run');
      },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  return reads;
}

function channelIdentity(channel: MetaChannel, suffix: string) {
  const userId = channel === 'whatsapp' ? `4670000${suffix}` : `ig-user-${suffix}`;
  return {
    userId,
    sessionId: boundary.channelSessionId(channel, userId, businessConfig, `${channel}-tenant`),
  };
}

async function turn(channel: MetaChannel, suffix: string, text: string) {
  const identity = channelIdentity(channel, suffix);
  return boundary.turn({
    sessionId: identity.sessionId,
    platformName: channel,
    recipientUserId: identity.userId,
    text,
    businessConfig,
    now,
  });
}

try {
  assert.equal(boundary.extractConcreteRequestedService(initialBookingText), null);
  assert.equal(boundary.extractConcreteRequestedService('Jag vill boka en tid i morgon.'), null);
  assert.equal(boundary.extractConcreteRequestedService('Jag vill boka en tid på måndag.'), null);
  assert.equal(
    boundary.extractConcreteRequestedService('Jag vill boka en hårbehandling.'),
    'hårbehandling',
  );
  assert.equal(
    boundary.extractConcreteRequestedService('Jag vill boka en tid hårbehandling i morgon.'),
    'tid hårbehandling i morgon',
  );

  const parity: Record<MetaChannel, any> = {} as Record<MetaChannel, any>;
  for (const channel of ['instagram', 'whatsapp'] as const) {
    const reads = configure();
    const result = await turn(channel, `clean-${channel}`, initialBookingText);

    assert.equal(result.handled, true, channel);
    assert.equal(result.pending?.status, 'awaiting_time_selection', channel);
    assert.equal(result.pending?.service, 'Video Consultation', channel);
    assert.equal(result.pending?.selectedDate, '2026-08-31', channel);
    assert.equal(result.pending?.availabilityStartDate, '2026-08-31', channel);
    assert.equal(result.pending?.normalizedBookingRequest?.date?.value, '2026-08-31', channel);
    assert.ok(
      reads.some((read) => read.startDate === '2026-08-31' && read.endDate === '2026-08-31'),
      `${channel}: availability requested for tomorrow`,
    );
    assert.doesNotMatch(result.replies.join(' '), /kan inte matcha/iu, channel);
    assert.match(result.replies.join(' '), /31 augusti/iu, channel);
    assert.ok(result.pending?.ownedOfferedSlots?.length > 0, `${channel}: slots are offered`);
    parity[channel] = {
      status: result.pending?.status,
      service: result.pending?.service,
      selectedDate: result.pending?.selectedDate,
      availabilityStartDate: result.pending?.availabilityStartDate,
    };
  }
  assert.deepEqual(parity.instagram, parity.whatsapp);

  {
    const reads = configure();
    const unsupported = await turn('instagram', 'unsupported', 'Jag vill boka en hårbehandling.');
    assert.equal(unsupported.pending?.status, 'awaiting_service');
    assert.equal(unsupported.pending?.service, 'Bokning');
    assert.equal(unsupported.pending?.requestedService, 'hårbehandling');
    assert.match(unsupported.replies.join(' '), /kan inte matcha/iu);
    assert.equal(reads.length, 0);

    const resumed = await turn('instagram', 'unsupported', serviceAndDateText);
    assert.equal(resumed.pending?.service, 'Video Consultation');
    assert.equal(resumed.pending?.durationMinutes, 60);
    assert.equal(resumed.pending?.status, 'awaiting_time_selection');
    assert.equal(resumed.pending?.selectedDate, '2026-08-31');
    assert.equal(resumed.pending?.availabilityStartDate, '2026-08-31');
    assert.equal(resumed.pending?.normalizedBookingRequest?.date?.value, '2026-08-31');
    assert.ok(
      reads.some((read) => read.startDate === '2026-08-31' && read.endDate === '2026-08-31'),
      'service-and-date continuation runs availability in the same turn',
    );
    assert.doesNotMatch(resumed.replies.join(' '), /Vilka datum finns i åtanke/iu);
    assert.match(resumed.replies.join(' '), /31 augusti/iu);
  }

  {
    const reads = configure();
    const unsupported = await turn('instagram', 'service-only', 'Jag vill boka en hårbehandling.');
    assert.equal(unsupported.pending?.status, 'awaiting_service');

    const serviceOnly = await turn('instagram', 'service-only', 'Video Consultation');
    assert.equal(serviceOnly.pending?.service, 'Video Consultation');
    assert.equal(serviceOnly.pending?.durationMinutes, 60);
    assert.equal(serviceOnly.pending?.status, 'awaiting_date_or_time');
    assert.equal(serviceOnly.pending?.selectedDate, null);
    assert.match(serviceOnly.replies.join(' '), /Vilka datum finns i åtanke/iu);
    assert.equal(reads.length, 0);
  }

  originalLog('Swedish generic booking service/date regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
