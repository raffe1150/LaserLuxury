import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const platforms = ['telegram', 'instagram', 'whatsapp', 'messenger'] as const;
const languages = {
  en: {
    initial: 'Hello, I want to book an appointment for tomorrow.',
    exact: (time: string) => `Hello, I want to book an appointment tomorrow at ${time}.`,
    select: (time: string) => `I'll take the ${time} slot, please.`,
    confirm: 'Yes, please book it for me.',
    equivalentConfirm: 'Yes, please. What information do you need from me to finalize the booking?',
  },
  sv: {
    initial: 'Hej, jag vill boka en tid i morgon.',
    exact: (time: string) => `Hej, jag vill boka en tid i morgon klockan ${time}.`,
    select: (time: string) => `Jag väljer tiden ${time}.`,
    confirm: 'Ja tack, boka den åt mig.',
    equivalentConfirm: 'Ja, tack! Det vore jättebra.',
  },
  fa: {
    initial: 'سلام، می‌خواهم برای فردا وقت رزرو کنم.',
    exact: (time: string) => `سلام، برای فردا ساعت ${time} وقت می‌خواهم.`,
    select: (time: string) => `ساعت ${time} را می‌خواهم.`,
    confirm: 'بله، لطفاً آن را برای من رزرو کنید.',
    equivalentConfirm: 'بله، لطفاً همان زمان را رزرو کنید.',
  },
} as const;

let eventSequence = 0;
boundary.reset();
boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'booking-progression@example.com',
    getEvents: async () => [],
    checkSlots: async () => { throw new Error('legacy availability path must not run'); },
  },
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
} as any);

function localTime(iso: string) {
  return new Date(iso).toLocaleTimeString('sv-SE', {
    timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit',
  });
}

async function turn(platform: typeof platforms[number], sessionId: string, text: string, businessConfig: any) {
  return boundary.inboundTurn({
    eventId: `${sessionId}:${++eventSequence}`,
    sessionId,
    platformName: platform,
    recipientUserId: `user-${sessionId}`,
    text,
    businessConfig,
  });
}

for (const platform of platforms) {
  for (const [language, wording] of Object.entries(languages)) {
    const businessConfig = {
      id: `progression-${platform}-${language}`,
      businessName: 'Progression Clinic',
      language,
      timezone: 'Europe/Stockholm',
      defaultBookingService: 'Konsultation',
      calendarProvider: 'google',
      googleCalendarId: 'booking-progression@example.com',
    };

    const selectionSession = `${platform}-${language}-selection`;
    const offered = await turn(platform, selectionSession, wording.initial, businessConfig);
    assert.equal(offered.pending?.status, 'awaiting_time_selection', `${platform}/${language}: offers await selection`);
    assert.ok(offered.pending?.ownedOfferedSlots?.length > 1, `${platform}/${language}: multiple owned offers exist`);
    const selectedTime = localTime(offered.pending.ownedOfferedSlots[1].start);
    const selected = await turn(platform, selectionSession, wording.select(selectedTime), businessConfig);
    assert.equal(selected.pending?.status, 'awaiting_confirmation', `${platform}/${language}: contextual owned-slot selection advances to confirmation`);
    assert.equal(localTime(selected.pending.dateTime), selectedTime);
    assert.doesNotMatch(selected.replies.join(' '), /Which proposed time|Vilken av de föreslagna|کدام‌یک از زمان‌های/u);
    const selectionConfirmed = await turn(platform, selectionSession, wording.equivalentConfirm, businessConfig);
    assert.equal(selectionConfirmed.pending?.status, 'awaiting_contact', `${platform}/${language}: natural confirmation advances to contact`);
    assert.doesNotMatch(selectionConfirmed.replies.join(' '), /Would you like me to book|Ska jag boka|می‌خواهید برایتان رزرو/u);

    if (language === 'sv') {
      const combinedSession =
        `${platform}-${language}-confirmation-contact-same-turn`;

      const combinedBusinessConfig = {
        ...businessConfig,
        id:
          `${businessConfig.id}-confirmation-contact-same-turn`
      };

      const combinedProposed = await turn(
        platform,
        combinedSession,
        wording.exact('11:30'),
        combinedBusinessConfig
      );

      assert.equal(
        combinedProposed.pending?.status,
        'awaiting_confirmation',
        `${platform}/${language}: combined confirmation/contact setup awaits confirmation`
      );

      const combinedCompleted = await turn(
        platform,
        combinedSession,
        'Ja tack, boka den. Mitt namn är Test Customer och telefonnumret är +46700000000.',
        combinedBusinessConfig
      );

      assert.notEqual(
        combinedCompleted.pending?.status,
        'awaiting_confirmation',
        `${platform}/${language}: explicit confirmation plus contact must not reopen confirmation`
      );

      assert.doesNotMatch(
        combinedCompleted.replies.join(' '),
        /Ska jag boka den åt dig/iu,
        `${platform}/${language}: combined confirmation/contact must not ask for confirmation again`
      );

      assert.doesNotMatch(
        combinedCompleted.replies.join(' '),
        /behöver jag bara ditt namn|mobilnummer|telefonnummer/iu,
        `${platform}/${language}: already supplied contact must not be requested again`
      );
    }

    const confirmationSession = `${platform}-${language}-confirmation`;
    const confirmationBusinessConfig = { ...businessConfig, id: `${businessConfig.id}-confirmation` };
    const proposed = await turn(platform, confirmationSession, wording.exact('11:00'), confirmationBusinessConfig);
    assert.equal(proposed.pending?.status, 'awaiting_confirmation', `${platform}/${language}: exact owned slot awaits confirmation`);
    const confirmed = await turn(platform, confirmationSession, wording.confirm, confirmationBusinessConfig);
    assert.equal(confirmed.pending?.status, 'awaiting_contact', `${platform}/${language}: explicit confirmation advances`);
    const repeated = await turn(platform, confirmationSession, wording.confirm, confirmationBusinessConfig);
    assert.equal(repeated.pending?.status, 'awaiting_contact', `${platform}/${language}: repeated confirmation cannot reopen confirmation`);
    assert.doesNotMatch(repeated.replies.join(' '), /Would you like me to book|Ska jag boka|می‌خواهید برایتان رزرو/u);
  }
}

console.log('multichannel booking progression regressions passed');
