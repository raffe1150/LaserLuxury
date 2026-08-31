import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => undefined;
console.warn = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-31T12:00:00+02:00');
const businessConfig = {
  id: 'shared-post-completion-business',
  businessName: 'Shared Post-completion Clinic',
  timezone: 'Europe/Stockholm',
  systemPrompt: 'Customers should bring identification. Parking is available behind the clinic.',
  calendarProvider: 'custom',
  googleCalendarId: 'shared-post-completion-calendar',
  services: [
    { name: 'Video Consultation', durationMinutes: 60 },
    { name: 'Laser Treatment', durationMinutes: 60 },
  ],
};

const calls = {
  availability: 0,
  calendarReads: 0,
  bookingMutations: 0,
  databaseMutations: 0,
  claims: 0,
  settlements: 0,
};

const configure = () => {
  boundary.reset();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'shared-post-completion-calendar',
      checkSlots: async () => { calls.availability += 1; return { available_slots_string: '' }; },
      getEvents: async () => { calls.calendarReads += 1; return []; },
      insertAppointment: async () => { calls.bookingMutations += 1; return { success: false }; },
    },
    recordAppointment: async () => { calls.databaseMutations += 1; return null; },
    claimOperation: async () => { calls.claims += 1; return { claimed: false }; },
    settleOperation: async () => { calls.settlements += 1; return true; },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
};

const seedCompleted = (sessionId: string, language: string, sourceChannel = 'instagram') => {
  boundary.seedRecentCompletedBooking(sessionId, language, {
    ok: true,
    bookingId: `booking-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-01T14:30:00+02:00',
    customerName: 'Alex Testsson',
    customerPhone: '0701234567',
    sourceChannel,
  }, 60);
};

const turn = (sessionId: string, platformName: 'instagram' | 'whatsapp' | 'messenger' | 'telegram', text: string) =>
  boundary.turn({
    sessionId,
    platformName,
    recipientUserId: sessionId,
    text,
    inputMode: 'text',
    businessConfig,
    now,
  });

const languages = [
  {
    language: 'es', platform: 'instagram' as const,
    acknowledgement: 'Perfecto, gracias.',
    status: '¿Está confirmada mi reserva?',
    statusContact: 'La cita ya está confirmada con mi nombre y teléfono, ¿verdad?',
    timeDetail: '¿A qué hora reservé la cita?',
    dateDetail: '¿Qué fecha tiene mi cita?',
    dateToken: /septiembre/u,
    nameDetail: '¿A qué nombre está la reserva?',
    summaryDetail: '¿Puedes confirmar los detalles de mi reserva?',
    serviceDetail: '¿Qué servicio reservé para la cita?',
    requirements: '¿Necesitan algún otro dato o confirmación por mi parte?',
    requirementsConfirmation: '¿Tengo que confirmar algo más?',
    support: '¿Necesito traer algo?',
  },
  {
    language: 'sv', platform: 'whatsapp' as const,
    acknowledgement: 'Tack så mycket.',
    status: 'Är min bokning bekräftad?',
    statusContact: 'Är min bokning bekräftad med mitt namn och telefonnummer?',
    timeDetail: 'Vilken tid bokade jag?',
    dateDetail: 'Vilket datum är min bokning?',
    dateToken: /september/u,
    nameDetail: 'Vilket namn står bokningen under?',
    summaryDetail: 'Kan du bekräfta mina bokningsdetaljer?',
    serviceDetail: 'Vilken tjänst bokade jag?',
    requirements: 'Behöver ni något mer information från mig?',
    requirementsConfirmation: 'Behöver jag bekräfta något mer?',
    support: 'Behöver jag ta med något?',
  },
  {
    language: 'en', platform: 'messenger' as const,
    acknowledgement: 'Perfect, thank you.',
    status: 'Is my booking confirmed?',
    statusContact: 'Is my appointment confirmed with my name and phone?',
    timeDetail: 'What time did I book?',
    dateDetail: 'What date is my appointment?',
    dateToken: /September/u,
    nameDetail: 'What name is the booking under?',
    summaryDetail: 'Can you confirm my booking details?',
    serviceDetail: 'What service did I book?',
    requirements: 'Do you need any more information from me?',
    requirementsConfirmation: 'Do I need to confirm anything else?',
    support: 'What should I bring?',
  },
  {
    language: 'de', platform: 'telegram' as const,
    acknowledgement: 'Vielen Dank.',
    status: 'Ist meine Buchung bestätigt?',
    statusContact: 'Ist meine Buchung mit meinem Namen und meiner Telefonnummer bestätigt?',
    timeDetail: 'Um wie viel Uhr habe ich gebucht?',
    dateDetail: 'An welchem Datum ist mein Termin?',
    dateToken: /September/u,
    nameDetail: 'Auf welchen Namen läuft die Buchung?',
    summaryDetail: 'Können Sie meine Buchungsdetails bestätigen?',
    serviceDetail: 'Welche Dienstleistung habe ich gebucht?',
    requirements: 'Benötigen Sie noch weitere Daten von mir?',
    requirementsConfirmation: 'Muss ich noch etwas bestätigen?',
    support: 'Was soll ich mitbringen?',
  },
  {
    language: 'fa', platform: 'instagram' as const,
    acknowledgement: 'ممنون.',
    status: 'آیا رزرو من تأیید شده است؟',
    statusContact: 'آیا رزرو من با نام و شماره تلفنم تأیید شده است؟',
    timeDetail: 'چه ساعتی رزرو کردم؟',
    dateDetail: 'رزرو من چه تاریخی است؟',
    dateToken: /سپتامبر/u,
    nameDetail: 'رزرو به نام چه کسی است؟',
    summaryDetail: 'می‌توانید جزئیات رزرو من را تأیید کنید؟',
    serviceDetail: 'چه خدمتی رزرو کردم؟',
    requirements: 'آیا اطلاعات بیشتری از من لازم است؟',
    requirementsConfirmation: 'آیا باید چیز دیگری را تأیید کنم؟',
    support: 'آیا باید چیزی همراه بیاورم؟',
  },
  {
    language: 'ar', platform: 'whatsapp' as const,
    acknowledgement: 'شكرا.',
    status: 'هل حجزي مؤكد؟',
    statusContact: 'هل حجزي مؤكد باسمي ورقم هاتفي؟',
    timeDetail: 'في أي وقت حجزت؟',
    dateDetail: 'ما تاريخ موعدي؟',
    dateToken: /سبتمبر/u,
    nameDetail: 'باسم من الحجز؟',
    summaryDetail: 'هل يمكنك تأكيد تفاصيل حجزي؟',
    serviceDetail: 'ما الخدمة التي حجزتها؟',
    requirements: 'هل تحتاجون معلومات إضافية مني؟',
    requirementsConfirmation: 'هل يجب أن أؤكد أي شيء آخر؟',
    support: 'هل أحتاج أن أحضر شيئًا؟',
  },
] as const;

try {
  for (const testCase of languages) {
    configure();
    const acknowledgementSession = `ack-${testCase.language}`;
    seedCompleted(acknowledgementSession, testCase.language, testCase.platform);
    const acknowledgement = await turn(acknowledgementSession, testCase.platform, testCase.acknowledgement);
    assert.equal(acknowledgement.handled, true, `${testCase.language} acknowledgement`);
    assert.equal(acknowledgement.replies.length, 1);
    assert.doesNotMatch(acknowledgement.replies[0], /14:30/u);
    assert.equal(acknowledgement.pending, null);

    const statusSession = `status-${testCase.language}`;
    seedCompleted(statusSession, testCase.language, testCase.platform);
    const status = await turn(statusSession, testCase.platform, testCase.status);
    assert.equal(status.handled, true, `${testCase.language} current status`);
    assert.equal(status.replies.length, 1);
    assert.match(status.replies[0], /14:30/u);
    assert.doesNotMatch(status.replies[0], /choose|välja|wählen|elegir|انتخاب|اختيار/u);
    assert.equal(status.pending, null);

    const detailCases = [
      { suffix: 'contact', text: testCase.statusContact, expected: /Alex Testsson/u, alsoExpected: /0701234567/u },
      { suffix: 'time', text: testCase.timeDetail, expected: /14:30/u, absent: /Alex Testsson|0701234567/u },
      { suffix: 'date', text: testCase.dateDetail, expected: testCase.dateToken, absent: /Alex Testsson|0701234567/u },
      { suffix: 'name', text: testCase.nameDetail, expected: /Alex Testsson/u, absent: /0701234567|14:30/u },
      { suffix: 'summary', text: testCase.summaryDetail, expected: /Video Consultation/u, alsoExpected: /Alex Testsson/u },
      { suffix: 'service', text: testCase.serviceDetail, expected: /Video Consultation/u, absent: /Alex Testsson|0701234567|14:30/u },
    ] as const;
    for (const detailCase of detailCases) {
      const detailSession = `detail-${detailCase.suffix}-${testCase.language}`;
      seedCompleted(detailSession, testCase.language, testCase.platform);
      const detail = await turn(detailSession, testCase.platform, detailCase.text);
      assert.equal(detail.handled, true, `${testCase.language} ${detailCase.suffix}`);
      assert.equal(detail.replies.length, 1);
      assert.match(detail.replies[0], detailCase.expected);
      if ('alsoExpected' in detailCase) assert.match(detail.replies[0], detailCase.alsoExpected);
      if ('absent' in detailCase) assert.doesNotMatch(detail.replies[0], detailCase.absent);
      assert.doesNotMatch(detail.replies[0], /nothing else|inget mer|nichts Weiteres|nada más|کار دیگری|شيء آخر/u);
      assert.equal(detail.pending, null);
    }

    const requirementsSession = `requirements-${testCase.language}`;
    seedCompleted(requirementsSession, testCase.language, testCase.platform);
    const requirements = await turn(requirementsSession, testCase.platform, testCase.requirements);
    assert.equal(requirements.handled, true, `${testCase.language} completion requirements`);
    assert.equal(requirements.replies.length, 1);
    assert.doesNotMatch(requirements.replies[0], /14:30|Alex Testsson/u);
    assert.doesNotMatch(requirements.replies[0], /choose|välja|wählen|elegir|انتخاب|اختيار/u);
    assert.equal(requirements.pending, null);

    const requirementsConfirmationSession = `requirements-confirmation-${testCase.language}`;
    seedCompleted(requirementsConfirmationSession, testCase.language, testCase.platform);
    const requirementsConfirmation = await turn(
      requirementsConfirmationSession,
      testCase.platform,
      testCase.requirementsConfirmation,
    );
    assert.equal(requirementsConfirmation.handled, true, `${testCase.language} confirmation requirements`);
    assert.equal(requirementsConfirmation.replies.length, 1);
    assert.doesNotMatch(requirementsConfirmation.replies[0], /Alex Testsson|0701234567|14:30/u);
    assert.equal(requirementsConfirmation.pending, null);

    const supportSession = `support-${testCase.language}`;
    seedCompleted(supportSession, testCase.language, testCase.platform);
    const support = await turn(supportSession, testCase.platform, testCase.support);
    assert.equal(support.handled, false, `${testCase.language} business support`);
    assert.equal(support.replies.length, 0);
    assert.equal(support.pending, null);
    assert.ok(boundary.recentCompletionState(supportSession).support);
    assert.deepEqual(boundary.geminiToolNames(supportSession), ['logSystemAnalysis']);
    const instruction = boundary.completedSupportInstruction(supportSession);
    assert.match(instruction, /READ-ONLY VERIFIED COMPLETION CONTEXT/u);
    assert.match(instruction, /Video Consultation/u);
    assert.match(instruction, /2026-09-01T14:30:00/u);
    assert.doesNotMatch(instruction, /Alex Testsson|0701234567/u);

    assert.deepEqual(calls, {
      availability: 0,
      calendarReads: 0,
      bookingMutations: 0,
      databaseMutations: 0,
      claims: 0,
      settlements: 0,
    }, `${testCase.language} A-D must be read-only`);
  }

  configure();
  const whatsappSession = 'whatsapp-recent-completion-dispatch';
  seedCompleted(whatsappSession, 'es', 'whatsapp');
  assert.equal(
    boundary.whatsappWouldDispatch(
      whatsappSession,
      'Perfecto, gracias. ¿Necesitan algún otro dato o confirmación por mi parte?',
    ),
    true,
  );

  configure();
  const liveSession = 'spanish-live-post-completion-loop';
  seedCompleted(liveSession, 'es');
  const liveTurn4 = await turn(
    liveSession,
    'instagram',
    'Perfecto, gracias. ¿Necesitan algún otro dato o confirmación por mi parte?',
  );
  const liveTurn5 = await turn(
    liveSession,
    'instagram',
    'La cita ya está confirmada con mi nombre y teléfono, ¿verdad?',
  );
  const liveTurn6 = await turn(
    liveSession,
    'instagram',
    'Sí, exactamente. La cita está confirmada para el martes 1 de septiembre a las 14:30 con mi nombre, Alex Testsson, y el teléfono 0701234567.',
  );
  for (const result of [liveTurn4, liveTurn5, liveTurn6]) {
    assert.equal(result.handled, true);
    assert.equal(result.pending, null);
    assert.doesNotMatch(result.replies.join(' '), /¿Qué hora quieres elegir\?/u);
  }
  assert.notEqual(liveTurn5.replies[0], liveTurn6.replies[0]);
  assert.match(liveTurn5.replies[0], /Alex Testsson/u);
  assert.match(liveTurn5.replies[0], /0701234567/u);
  assert.notEqual(
    liveTurn5.replies[0],
    'No hace falta nada más para la reserva. Está verificada y tus datos de contacto están registrados.',
  );
  assert.deepEqual(calls, {
    availability: 0,
    calendarReads: 0,
    bookingMutations: 0,
    databaseMutations: 0,
    claims: 0,
    settlements: 0,
  });

  configure();
  const missingFactsSession = 'recent-completion-missing-contact-facts';
  boundary.seedRecentCompletedBooking(missingFactsSession, 'en', {
    ok: true,
    bookingId: 'booking-missing-contact',
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-01T14:30:00+02:00',
    sourceChannel: 'instagram',
  }, 60);
  const missingFacts = await turn(
    missingFactsSession,
    'instagram',
    'Is my appointment confirmed with my name and phone?',
  );
  assert.equal(missingFacts.handled, true);
  assert.doesNotMatch(missingFacts.replies[0], /Alex Testsson|0701234567/u);
  assert.match(missingFacts.replies[0], /does not contain name, phone/u);
  assert.equal(missingFacts.pending, null);

  configure();
  const integritySession = 'recent-completion-integrity';
  seedCompleted(integritySession, 'en');
  const support = await turn(integritySession, 'instagram', 'What should I bring?');
  assert.equal(support.handled, false);
  const matching = 'Your booking is confirmed for Video Consultation at 14:30.';
  assert.equal(boundary.guardReply(integritySession, matching, 'en'), matching);
  const matchingContact = 'Your booking is confirmed with phone 0701234567.';
  assert.equal(boundary.guardReply(integritySession, matchingContact, 'en'), matchingContact);
  for (const conflicting of [
    'Your booking is confirmed at 15:30.',
    'Your booking is confirmed on 2026-09-02.',
    'Your booking is confirmed for Laser Treatment.',
    'Your booking is cancelled.',
    'Your booking is confirmed with phone 0709999999.',
    'Your booking is confirmed under the name Maria Other.',
  ]) {
    const guarded = boundary.guardReply(integritySession, conflicting, 'en');
    assert.notEqual(guarded, conflicting, conflicting);
    assert.doesNotMatch(guarded, /Which time would you like/u);
  }

  configure();
  const operations = [
    { category: 'new booking', text: 'I want to book a new appointment.', expectedOperation: 'new_booking' },
    { category: 'reschedule', text: 'I want to reschedule my appointment.', expectedOperation: null },
    { category: 'cancellation', text: 'I want to cancel my appointment.', expectedOperation: 'cancellation' },
    { category: 'another lookup', text: 'Can you check another booking for me?', expectedOperation: 'appointment_lookup' },
  ];
  for (const [index, operation] of operations.entries()) {
    const sessionId = `operation-${index}`;
    seedCompleted(sessionId, 'en');
    const result = await turn(sessionId, 'instagram', operation.text);
    assert.equal(
      result.replies.some((reply: string) => /Tuesday 1 September at 14:30/u.test(reply)),
      false,
      operation.category,
    );
    assert.equal(boundary.recentCompletionState(sessionId).support, null, operation.category);
    if (operation.expectedOperation) {
      assert.equal(result.operation.operation, operation.expectedOperation, operation.category);
    }
  }

  configure();
  const expiredSession = 'expired-recent-completion-support';
  seedCompleted(expiredSession, 'en');
  boundary.ageRecentCompletedBooking(expiredSession, 31 * 60_000);
  const expired = await turn(expiredSession, 'instagram', 'What should I bring?');
  assert.equal(expired.handled, false);
  assert.equal(boundary.recentCompletionState(expiredSession).completed, null);
  assert.equal(boundary.recentCompletionState(expiredSession).support, null);

  configure();
  const absent = await turn('absent-recent-completion', 'instagram', 'Is my booking confirmed?');
  assert.equal(
    absent.replies.some((reply: string) => /verified for|14:30/u.test(reply)),
    false,
  );
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
}

console.log('Shared multilingual post-completion routing regression passed.');
