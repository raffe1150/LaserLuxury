import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const log = console.log;
console.log = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = new Date('2026-09-07T09:00:00+02:00');
const cases = [
  ['fa', 'می‌خواهم برای پنجشنبه ۲۷ مهٔ ۲۰۲۷ عکاسی عروسی رزرو کنم.', 'عکاسی عروسی', '2027-05-27'],
  ['fa', 'می‌خواهم برای سه‌شنبه ۲۲ سپتامبر ۲۰۲۶ عکاسی عروسی رزرو کنم.', 'عکاسی عروسی', '2026-09-22'],
  ['ar', 'أريد حجز تصوير زفاف بتاريخ الاثنين، 14 سبتمبر 2026.', 'تصوير زفاف', '2026-09-14'],
  ['en', "I'd like to book wedding photography for Monday, 14 September 2026.", 'wedding photography', '2026-09-14'],
  ['en', "I'd like to book wedding photography for Tuesday, 22 September 2026.", 'wedding photography', '2026-09-22'],
  ['sv', 'Jag vill boka bröllopsfotografering den tisdag 15 september 2026.', 'bröllopsfotografering', '2026-09-15'],
  ['es', 'Quiero reservar fotografía de bodas para el martes, 22 de septiembre de 2026.', 'fotografía de bodas', '2026-09-22'],
  ['de', 'Ich möchte Hochzeitsfotografie am Dienstag, 22. September 2026 buchen.', 'Hochzeitsfotografie', '2026-09-22'],
  ['fa', 'می‌خواهم عکاسی عروسی برای سه شنبه ۲۲ سپتامبر ۲۰۲۶ رزرو کنم.', 'عکاسی عروسی', '2026-09-22'],
  ['ar', 'أريد حجز تصوير الزفاف في الثلاثاء، ٢٢ سبتمبر ٢٠٢٦.', 'تصوير الزفاف', '2026-09-22'],
];
try {
  for (const platformName of ['instagram', 'whatsapp']) for (const [language, text, service, date] of cases) {
    for (const stale of ['none', 'unresolved', 'availability']) {
      boundary.reset();
      let reads = 0;
      boundary.configure({ calendarAdapter: {
        getCalendarId: () => 'regression-calendar',
        getEvents: async () => { reads++; return []; },
        checkSlots: () => { throw Error('legacy calendar path'); },
      }, postProcess: async () => undefined, incrementUsage: async () => ({ allowed: true }) } as any);
      const businessConfig = { id: 'explicit-date', businessName: 'Clinic', language, timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'regression-calendar', services: [{ name: 'test', duration: 30 }, { name: 'Other', duration: 60 }] };
      const sessionId = `explicit-${platformName}-${language}`;
      const turn = (message: string) => boundary.turn({ sessionId, platformName, recipientUserId: '46701234567', businessConfig, text: message, now });
      if (stale !== 'none') {
        await turn(stale === 'unresolved'
          ? 'I want to book an appointment on 2026-09-08.'
          : 'I want to book Other on 2026-09-08.');
      }
      const readsBefore = reads;
      const result = await turn(text);
      const label = `${platformName}/${language}/stale=${stale}`;
      assert.equal(result.pending?.requestedService, service, label);
      assert.equal(result.pending?.status, 'awaiting_service', label);
      assert.equal(result.pending?.service, 'Bokning', label);
      assert.equal(result.pending?.normalizedBookingRequest?.date?.value, date, label);
      assert.equal(result.pending?.selectedDate, date, label);
      assert.equal(reads, readsBefore, label);
      assert.ok(result.replies.join(' ').includes(service), label);
      assert.ok(result.replies.join(' ').includes('test'), label);
      assert.ok(result.replies.join(' ').includes('Other'), label);
      const rejection = {
        en: /not offered/iu, sv: /erbjuds inte/iu, es: /no ofrecemos/iu,
        de: /nicht angeboten/iu, fa: /ارائه نمی‌شود/u, ar: /غير متاحة/u,
      }[language];
      assert.match(result.replies.join(' '), rejection!, label);
      const resumed = await turn('test');
      assert.equal(resumed.pending?.service, 'test', label);
      assert.equal(resumed.pending?.selectedDate, date, label);
      assert.equal(resumed.pending?.normalizedBookingRequest?.date?.value, date, label);
      assert.ok(reads > readsBefore, label);
      assert.ok(resumed.pending?.ownedOfferedSlots?.length > 0, label);
      for (const slot of resumed.pending?.ownedOfferedSlots || []) assert.equal(slot.start.slice(0, 10), date, label);
    }
  }
  // A time accompanying an unsupported service survives the same recovery path.
  for (const platformName of ['instagram', 'whatsapp']) {
    boundary.reset();
    let reads = 0;
    boundary.configure({ calendarAdapter: {
      getCalendarId: () => 'time-calendar',
      getEvents: async () => { reads++; return []; },
      checkSlots: () => { throw Error('legacy calendar path'); },
    }, postProcess: async () => undefined, incrementUsage: async () => ({ allowed: true }) } as any);
    const businessConfig = { id: 'time-retention', businessName: 'Clinic', language: 'en', timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'time-calendar', services: [{ name: 'test', duration: 30 }, { name: 'Other', duration: 60 }] };
    const turn = (text: string) => boundary.turn({ sessionId: 'time-retention', platformName, recipientUserId: '46701234567', text, businessConfig, now });
    const unresolved = await turn("I'd like to book wedding photography for Monday, 14 September 2026 at 14:00.");
    assert.equal(unresolved.pending?.requestedTime, '14:00');
    assert.equal(reads, 0);
    assert.match(unresolved.replies.join(' '), /not offered/iu);
    const resumed = await turn('test');
    assert.equal(resumed.pending?.selectedDate, '2026-09-14');
    assert.equal(resumed.pending?.normalizedBookingRequest?.timeConstraint?.startMinutes, 14 * 60);
    assert.ok(resumed.pending?.ownedOfferedSlots?.length > 0);
    for (const slot of resumed.pending.ownedOfferedSlots) {
      assert.equal(slot.start.slice(0, 10), '2026-09-14');
      assert.equal(slot.start.slice(11, 16), '14:00');
    }
    assert.ok(reads > 0);
  }
  log('unsupported service explicit date regressions passed');
} finally { boundary.reset(); console.log = log; }
