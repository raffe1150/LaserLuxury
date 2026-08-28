import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type Failure = 'calendar_create' | 'calendar_verify' | 'database_insert' | 'database_verify' | 'settlement';

function fixture(options: { failOnce?: Failure; adminFailure?: boolean } = {}) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = { availabilityReads: 0, calendarCreate: 0, calendarRead: 0, calendarDelete: 0, databaseInsert: 0, databaseRead: 0, databaseCancel: 0, settlement: 0, cancellationSettlement: 0, admin: 0, usage: 0, createdName: '', createdPhone: '' };
  let remainingFailure = options.failOnce;
  let sequence = 0;
  const consume = (stage: Failure) => remainingFailure === stage ? (remainingFailure = undefined, true) : false;
  const adapter = {
    getCalendarId: () => 'cal-7',
    checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => { counters.availabilityReads += 1; return [...events.values()]; },
    insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
      counters.calendarCreate += 1;
      counters.createdName = name;
      counters.createdPhone = phone;
      if (consume('calendar_create')) return { success: false, code: 'PROVIDER_FAILED' };
      const id = `created-${++sequence}`;
      const platform = marker.startsWith('wa_') ? 'whatsapp' : marker.startsWith('ig_') ? 'instagram' : marker.startsWith('ms_') ? 'messenger' : 'unknown';
      const userId = marker.replace(/^(?:wa_|ig_|ms_)/, '');
      const start = new Date(dateTime).toISOString();
      const event = { id, status: 'confirmed', summary: `Bokad: ${name} - ${phone}`, description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${userId}`, start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() }, extendedProperties: { private: { businessId: '7', platform, userId } } };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => { counters.calendarRead += 1; return consume('calendar_verify') ? null : events.get(id) || null; },
    cancelAppointment: async (id: string) => { counters.calendarDelete += 1; events.delete(id); return { success: true }; },
    verifyEventDeleted: async (id: string) => !events.has(id),
    updateAppointment: async (id: string, dateTime: string, duration = 30) => {
      const current = events.get(id);
      const start = new Date(dateTime).toISOString();
      const event = { ...current, start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() } };
      events.set(id, event);
      return { success: true, event };
    },
  };
  const dependencies = {
    calendarAdapter: adapter,
    postProcess: async () => undefined,
    notifyBooking: async () => { counters.admin += 1; if (options.adminFailure) throw new Error('injected admin failure'); return true; },
    notifyReschedule: async () => true,
    notifyCancellation: async () => { counters.admin += 1; if (options.adminFailure) throw new Error('injected admin failure'); return true; },
    incrementUsage: async () => ({ allowed: true, count: ++counters.usage, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    updateAppointmentRow: async (appointment: any, start: string, end: string) => ({ id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, start_time: start, end_time: end, status: 'booked' }),
    cancelAppointmentRow: async (appointment: any) => { counters.databaseCancel += 1; return { id: appointment.id, business_id: '7', platform: appointment.platform, user_id: appointment.userId, service: appointment.service, status: 'cancelled' }; },
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      if (consume('database_insert')) return null;
      counters.databaseRead += 1;
      const start = new Date(params.dateTime).toISOString();
      return { id: counters.databaseInsert, business_id: '7', platform: params.platform, user_id: String(params.userId), service: params.service, start_time: start, end_time: consume('database_verify') ? new Date(new Date(start).getTime() + 999 * 60_000).toISOString() : new Date(new Date(start).getTime() + Number(params.durationMinutes || 30) * 60_000).toISOString(), status: 'booked', created_at: new Date().toISOString() };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing?.state.status === 'completed' || existing?.state.status === 'processing') return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key, state: { type: params.type, status: 'processing', attempts: Number(existing?.state.attempts || 0) + 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: 'completed' | 'failed') => {
      if (status === 'completed' && consume('settlement')) return false;
      handle.state.status = status;
      if (status === 'completed') {
        counters.settlement += 1;
        if (String(handle.keyHash).startsWith('cancellation_operation_claim|')) counters.cancellationSettlement += 1;
      }
      return true;
    },
  };
  const restart = () => { boundary.reset(); boundary.configure(dependencies); };
  restart();
  return { counters, events, restart };
}

const businessConfig = { id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm', defaultBookingService: 'Konsultation', calendarProvider: 'custom', googleCalendarId: 'cal-7', allowCancellation: true };
const canonicalNow = new Date('2026-08-01T12:00:00+02:00');
const turn = (sessionId: string, platformName: 'whatsapp' | 'instagram' | 'messenger' | 'telegram', recipientUserId: string, text: string, extra: Record<string, any> = {}) => boundary.turn({ sessionId, platformName, recipientUserId, text, businessConfig, ...extra });
const inbound = (eventId: string, sessionId: string, platformName: 'whatsapp' | 'instagram' | 'messenger', recipientUserId: string, text: string, extra: Record<string, any> = {}) => boundary.inboundTurn({ eventId, sessionId, platformName, recipientUserId, text, businessConfig, ...extra });
const localMinute = (iso: string) => { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); return Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value); };

// ODIN-BOOKING-004: rejecting a replacement selection and asking for other
// times on the same day must preserve the replacement date and rescan it.
{
  const { counters, events } = fixture();
  const session = 'wa_rejected_replacement_same_day';
  const user = 'rejected-replacement-same-day';
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };

  const initial = await turn(
    session,
    'whatsapp',
    user,
    'Jag vill boka en tid på kvällen tisdagen den 13 oktober 2026. Vilka tider är lediga?',
    now,
  );
  assert.equal(initial.pending?.selectedDate, '2026-10-13');
  assert.ok(initial.pending?.ownedOfferedSlots.some((slot: any) => localMinute(slot.start) === 17 * 60));

  const selected = await turn(
    session,
    'whatsapp',
    user,
    'Jag tar tiden klockan 17:00 den 13 oktober.',
    now,
  );
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  assert.equal(selected.pending?.selectedDate, '2026-10-13');

  const replacement = await turn(
    session,
    'whatsapp',
    user,
    'Jag har ändrat mig. Kan vi ta onsdagen den 14 oktober klockan 17:00 i stället?',
    now,
  );
  assert.equal(replacement.pending?.status, 'awaiting_confirmation');
  assert.equal(replacement.pending?.selectedDate, '2026-10-14');
  assert.equal(localMinute(replacement.pending?.dateTime), 17 * 60);

  const alternatives = await turn(
    session,
    'whatsapp',
    user,
    'Nej, inte den tiden heller. Visa mig andra lediga tider samma dag i stället.',
    now,
  );
  assert.equal(alternatives.pending?.status, 'awaiting_time_selection');
  assert.equal(alternatives.pending?.selectedDate, '2026-10-14');
  assert.equal(alternatives.pending?.availabilityStartDate, '2026-10-14');
  assert.equal(alternatives.pending?.availabilityEndDate, '2026-10-14');
  assert.equal(alternatives.pending?.dateTime, null);
  assert.ok(alternatives.pending?.ownedOfferedSlots.length > 0, 'fresh same-day candidates must be returned');
  assert.ok(alternatives.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) !== 17 * 60));
  assert.doesNotMatch(alternatives.replies.join(' '), /inga lediga tider|ingen ledig tid/iu);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// The same shared recovery applies to a shorter generic selection flow.
{
  const { counters, events } = fixture();
  const session = 'wa_generic_rejected_same_day';
  const user = 'generic-rejected-same-day';
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };

  const offered = await turn(
    session,
    'whatsapp',
    user,
    'Do you have any available appointments on Thursday, 15 October 2026?',
    now,
  );
  assert.equal(offered.pending?.selectedDate, '2026-10-15');
  assert.ok(offered.pending?.ownedOfferedSlots.length > 1);

  const selected = await turn(session, 'whatsapp', user, '1', now);
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  const rejectedMinute = localMinute(selected.pending?.dateTime);

  const rejected = await turn(
    session,
    'whatsapp',
    user,
    'No, another time.',
    now,
  );
  assert.equal(rejected.pending?.status, 'awaiting_time_selection');
  assert.equal(rejected.pending?.selectedDate, '2026-10-15');
  assert.equal(rejected.pending?.dateTime, null);

  const alternatives = await turn(
    session,
    'whatsapp',
    user,
    'Show me other times the same day.',
    now,
  );
  assert.equal(alternatives.pending?.status, 'awaiting_time_selection');
  assert.equal(alternatives.pending?.selectedDate, '2026-10-15');
  assert.equal(alternatives.pending?.availabilityStartDate, '2026-10-15');
  assert.equal(alternatives.pending?.availabilityEndDate, '2026-10-15');
  assert.equal(alternatives.pending?.dateTime, null);
  assert.ok(alternatives.pending?.ownedOfferedSlots.length > 0);
  assert.ok(alternatives.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) !== rejectedMinute));
  assert.doesNotMatch(alternatives.replies.join(' '), /no (?:available|availability)|couldn.t find/iu);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// ODIN-LANGUAGE-RESPONSE-PARITY-003: meaningful customer language owns the
// localized availability reply, while ambiguous continuations preserve the lock.
{
  const { counters, events } = fixture();
  const english = await turn(
    'wa_english_reply_parity',
    'whatsapp',
    'english-reply-parity',
    'Do you have any available appointments in the evening on Friday, 4 September 2026?',
    {
      now: new Date('2026-08-16T12:00:00+02:00'),
      businessConfig: { ...businessConfig, language: 'sv' },
    },
  );
  assert.match(english.replies.join(' '), /I found these available times:/u);
  assert.doesNotMatch(english.replies.join(' '), /Jag hittade lediga tider/u);
  assert.equal(english.pending?.language, 'en');
  assert.equal(english.pending?.selectedDate, '2026-09-04');
  assert.ok(english.pending?.ownedOfferedSlots.length > 0);
  assert.ok(english.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 17 * 60 && minute < 21 * 60;
  }));
  assert.equal(english.pending?.dateTime, null);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);

  fixture();
  const swedish = await turn(
    'wa_swedish_reply_parity',
    'whatsapp',
    'swedish-reply-parity',
    'Har ni någon ledig tid på kvällen onsdagen den 2 september 2026?',
    { now: new Date('2026-08-16T12:00:00+02:00') },
  );
  assert.match(swedish.replies.join(' '), /Jag hittade lediga tider/u);
  assert.equal(swedish.pending?.language, 'sv');

  fixture();
  const persian = await turn(
    'wa_persian_reply_parity',
    'whatsapp',
    'persian-reply-parity',
    'برای دوشنبه ۲۴ اوت ۲۰۲۶ بین ساعت ۱۱ تا ۱۳ وقت خالی دارید؟',
    { now: new Date('2026-08-16T12:00:00+02:00') },
  );
  assert.match(persian.replies.join(' '), /این زمان‌ها خالی هستند/u);
  assert.equal(persian.pending?.language, 'fa');
}

// Fresh channel identities keep independent language state even when processed
// consecutively, and the first meaningful turn overrides the business fallback.
{
  fixture();
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };
  const englishSession = 'wa_fresh_english_then_swedish_a';
  const swedishSession = 'wa_fresh_english_then_swedish_b';
  const english = await turn(
    englishSession,
    'whatsapp',
    'fresh-english-a',
    'Do you have any available appointments in the evening on Tuesday, 8 September 2026?',
    { ...now, businessConfig: { ...businessConfig, language: 'sv' } },
  );
  assert.match(english.replies.join(' '), /I found these available times:/u);
  assert.equal(boundary.conversationState(englishSession).language, 'en');

  const swedish = await turn(
    swedishSession,
    'whatsapp',
    'fresh-swedish-b',
    'Har ni några lediga tider på kvällen onsdagen den 9 september 2026?',
    { ...now, businessConfig: { ...businessConfig, language: 'en' } },
  );
  assert.match(swedish.replies.join(' '), /Jag hittade lediga tider/u);
  assert.doesNotMatch(swedish.replies.join(' '), /I found these available times:/u);
  assert.equal(boundary.conversationState(swedishSession).language, 'sv');
  assert.equal(boundary.conversationState(englishSession).language, 'en');

  const persian = await turn(
    'wa_fresh_persian_after_swedish',
    'whatsapp',
    'fresh-persian-after-swedish',
    'برای دوشنبه ۱۴ سپتامبر ۲۰۲۶ بعد از ساعت ۱۵ وقت خالی دارید؟',
    { ...now, businessConfig: { ...businessConfig, language: 'sv' } },
  );
  assert.match(persian.replies.join(' '), /این زمان‌ها خالی هستند/u);
  assert.equal(persian.pending?.language, 'fa');

  const german = await turn(
    'wa_fresh_german_after_persian',
    'whatsapp',
    'fresh-german-after-persian',
    'Haben Sie am Freitag, 11. September 2026 einen Termin später als 15 Uhr?',
    { ...now, businessConfig: { ...businessConfig, language: 'fa' } },
  );
  assert.match(german.replies.join(' '), /Ich habe diese freien Zeiten gefunden:/u);
  assert.equal(german.pending?.language, 'de');
}

// The reverse fresh-conversation order is equally isolated.
{
  fixture();
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };
  const swedishSession = 'wa_fresh_swedish_then_english_a';
  const englishSession = 'wa_fresh_swedish_then_english_b';
  const swedish = await turn(
    swedishSession,
    'whatsapp',
    'fresh-swedish-a',
    'Har ni några lediga tider på kvällen onsdagen den 9 september 2026?',
    { ...now, businessConfig: { ...businessConfig, language: 'en' } },
  );
  assert.match(swedish.replies.join(' '), /Jag hittade lediga tider/u);
  assert.equal(boundary.conversationState(swedishSession).language, 'sv');

  const english = await turn(
    englishSession,
    'whatsapp',
    'fresh-english-b',
    'Do you have any available appointments in the evening on Tuesday, 8 September 2026?',
    { ...now, businessConfig: { ...businessConfig, language: 'sv' } },
  );
  assert.match(english.replies.join(' '), /I found these available times:/u);
  assert.equal(boundary.conversationState(englishSession).language, 'en');
  assert.equal(boundary.conversationState(swedishSession).language, 'sv');
}

// A meaningful English turn intentionally replaces a Swedish language lock.
{
  fixture();
  const session = 'wa_intentional_language_switch';
  const user = 'intentional-language-switch';
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };
  const swedish = await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid på eftermiddagen måndagen den 31 augusti 2026?',
    now,
  );
  assert.equal(swedish.pending?.language, 'sv');

  const english = await turn(
    session,
    'whatsapp',
    user,
    'Do you have any available appointments in the evening on Friday, 4 September 2026?',
    now,
  );
  assert.match(english.replies.join(' '), /I found these available times:/u);
  assert.doesNotMatch(english.replies.join(' '), /Jag hittade lediga tider/u);
  assert.equal(english.pending?.language, 'en');

  const switchedBack = await turn(
    session,
    'whatsapp',
    user,
    'Har ni några lediga tider på kvällen onsdagen den 9 september 2026?',
    now,
  );
  assert.match(switchedBack.replies.join(' '), /Jag hittade lediga tider/u);
  assert.doesNotMatch(switchedBack.replies.join(' '), /I found these available times:/u);
  assert.equal(switchedBack.pending?.language, 'sv');
}

// Numeric selections and short confirmations inherit the active language.
{
  fixture();
  const session = 'wa_ambiguous_language_lock';
  const user = 'ambiguous-language-lock';
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };
  await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid på kvällen onsdagen den 2 september 2026?',
    now,
  );
  const selected = await turn(session, 'whatsapp', user, '1', now);
  assert.equal(selected.pending?.language, 'sv');
  assert.doesNotMatch(selected.replies.join(' '), /Would you like|Please send|Which one/u);
  const confirmed = await turn(session, 'whatsapp', user, 'yes', now);
  assert.equal(confirmed.pending?.language, 'sv');
  assert.doesNotMatch(confirmed.replies.join(' '), /Please send|What mobile|Which one/u);

  fixture();
  const timeSession = 'wa_time_language_lock';
  const timeUser = 'time-language-lock';
  await turn(
    timeSession,
    'whatsapp',
    timeUser,
    'Har ni någon ledig tid på kvällen onsdagen den 2 september 2026?',
    now,
  );
  const timeSelected = await turn(timeSession, 'whatsapp', timeUser, '17:00', now);
  assert.equal(timeSelected.pending?.language, 'sv');
  assert.doesNotMatch(timeSelected.replies.join(' '), /Would you like|Please send|Which one/u);
}

// ODIN-LANGUAGE-RESPONSE-PARITY-003: plural Arabic availability with an evening
// daypart must not be consumed by existing-appointment lookup/recovery.
{
  const { counters, events } = fixture();
  const result = await turn(
    'wa_arabic_evening_availability',
    'whatsapp',
    'arabic-evening-availability',
    'هل لديكم مواعيد متاحة مساء يوم الأربعاء ٣٠ سبتمبر ٢٠٢٦؟',
    { now: new Date('2026-08-16T12:00:00+02:00') },
  );
  assert.equal(result.operation.operation, 'new_booking');
  assert.equal(result.selection, null, 'availability request must not enter lookup/recovery');
  assert.equal(result.pending?.normalizedBookingRequest.language, 'ar');
  assert.equal(result.pending?.normalizedBookingRequest.intent, 'new_booking');
  assert.equal(result.pending?.selectedDate, '2026-09-30');
  assert.equal(result.pending?.availabilityStartDate, '2026-09-30');
  assert.equal(result.pending?.availabilityEndDate, '2026-09-30');
  assert.equal(result.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(result.pending?.availabilityConstraint.daypart, 'evening');
  assert.equal(result.pending?.normalizedBookingRequest.timeConstraint.kind, 'evening');
  assert.ok(result.pending?.ownedOfferedSlots.length > 0);
  assert.ok(result.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 17 * 60 && minute < 21 * 60;
  }));
  assert.match(result.replies.join(' '), /هذه المواعيد متاحة/u);
  assert.doesNotMatch(result.replies.join(' '), /لم أجد حجزًا|رقم هاتف آخر/u);
  assert.equal(result.pending?.dateTime, null);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// A genuine first-person Arabic existing-booking query retains lookup behavior.
{
  fixture();
  const result = await turn(
    'wa_arabic_genuine_lookup',
    'whatsapp',
    'arabic-genuine-lookup',
    'هل لدي حجز قادم؟',
    { now: new Date('2026-08-16T12:00:00+02:00') },
  );
  assert.equal(result.operation.operation, 'appointment_lookup');
  assert.match(result.replies.join(' '), /لم أجد حجزًا قادمًا/u);
}

// ODIN-BOOKING-TIME-CONSTRAINT-002: Arabic availability must enter the new-booking
// path and preserve the shared strict-after boundary without any lookup or mutation.
{
  const { counters, events } = fixture();
  const result = await turn(
    'wa_arabic_strict_after',
    'whatsapp',
    'arabic-strict-after',
    'هل لديكم موعد متاح بعد الساعة 15 يوم الجمعة 25 سبتمبر 2026؟',
    { now: new Date('2026-08-15T12:00:00+02:00') },
  );
  assert.equal(result.operation.operation, 'new_booking');
  assert.equal(result.selection, null, 'availability request must not enter appointment lookup/recovery');
  assert.equal(result.pending?.selectedDate, '2026-09-25');
  assert.equal(result.pending?.availabilityStartDate, '2026-09-25');
  assert.equal(result.pending?.availabilityEndDate, '2026-09-25');
  assert.equal(result.pending?.availabilityConstraint.timeBoundary.kind, 'exclusive_lower');
  assert.equal(result.pending?.availabilityConstraint.timeBoundary.time, '15:00');
  assert.ok(result.pending?.ownedOfferedSlots.length > 0);
  assert.ok(result.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) > 15 * 60));
  assert.equal(result.pending?.dateTime, null, '15:00 must not become a pending hold');
  assert.equal(result.pending?.customerName ?? null, null);
  assert.equal(result.pending?.customerPhone ?? null, null);
  assert.doesNotMatch(result.replies.join(' '), /phone|mobile|name|هاتف|جوال|اسم/u);
  assert.equal(counters.availabilityReads, 1);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// ODIN-BOOKING-TIME-CONSTRAINT-002: Spanish named-date availability must retain
// the exact date and shared strict-after boundary through final slot filtering.
{
  const { counters, events } = fixture();
  const result = await turn(
    'wa_spanish_strict_after',
    'whatsapp',
    'spanish-strict-after',
    '¿Tienen alguna cita después de las 15:00 el viernes 18 de septiembre de 2026?',
    { now: new Date('2026-08-15T12:00:00+02:00') },
  );
  assert.equal(result.operation.operation, 'new_booking');
  assert.equal(result.pending?.selectedDate, '2026-09-18');
  assert.equal(result.pending?.availabilityStartDate, '2026-09-18');
  assert.equal(result.pending?.availabilityEndDate, '2026-09-18');
  assert.equal(result.pending?.availabilityConstraint.startDate, '2026-09-18');
  assert.equal(result.pending?.availabilityConstraint.endDate, '2026-09-18');
  assert.equal(result.pending?.availabilityConstraint.timeBoundary.kind, 'exclusive_lower');
  assert.equal(result.pending?.availabilityConstraint.timeBoundary.time, '15:00');
  assert.ok(result.pending?.ownedOfferedSlots.length > 0, 'later candidates must not produce false no-availability');
  assert.ok(result.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) > 15 * 60));
  assert.equal(result.pending?.dateTime, null, '15:00 must not become a pending hold');
  assert.doesNotMatch(result.replies.join(' '), /no (?:availability|available)|no (?:hay|encontré|encuentro).*(?:citas|horas|disponib)/iu);
  assert.equal(counters.availabilityReads, 1);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// ODIN-BOOKING-TIME-CONSTRAINT-002-STALE-DAYPART-001: the latest explicit
// daypart replaces an incompatible range from the prior availability turn.
{
  const { counters } = fixture();
  const session = 'wa_stale_daypart';
  const first = await turn(
    session,
    'whatsapp',
    'stale-daypart',
    'برای دوشنبه ۲۴ اوت ۲۰۲۶ بین ساعت ۱۱ تا ۱۳ وقت خالی دارید؟',
    { now: new Date('2026-08-15T12:00:00+02:00') },
  );
  assert.equal(first.pending?.availabilityConstraint.kind, 'time_window');
  assert.equal(first.pending?.availabilityConstraint.minTime, '11:00');
  assert.equal(first.pending?.availabilityConstraint.maxTime, '13:00');

  const changed = await turn(
    session,
    'whatsapp',
    'stale-daypart',
    'Har ni någon ledig tid på morgonen tisdagen den 25 augusti 2026?',
    { now: new Date('2026-08-15T12:00:00+02:00') },
  );
  assert.equal(changed.pending?.selectedDate, '2026-08-25');
  assert.equal(changed.pending?.availabilityStartDate, '2026-08-25');
  assert.equal(changed.pending?.availabilityEndDate, '2026-08-25');
  assert.equal(changed.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(changed.pending?.availabilityConstraint.daypart, 'morning');
  assert.notEqual(changed.pending?.availabilityConstraint.minTime, '11:00');
  assert.notEqual(changed.pending?.availabilityConstraint.maxTime, '13:00');
  assert.equal(changed.pending?.normalizedBookingRequest.timeConstraint.kind, 'morning');
  assert.ok(changed.pending?.ownedOfferedSlots.length > 0);
  assert.ok(changed.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 9 * 60 && minute < 12 * 60;
  }));
  assert.equal(changed.pending?.dateTime, null);
  assert.equal(changed.pending?.selectedSlotEnd, null);
  assert.equal(counters.availabilityReads, 2);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
}

// ODIN-BOOKING-TIME-CONSTRAINT-002-STALE-AFTERNOON-001: the definite Swedish
// afternoon daypart replaces an earlier strict-before constraint and its offers.
{
  const { counters, events } = fixture();
  const session = 'wa_stale_afternoon';
  const user = 'stale-afternoon';
  const now = { now: new Date('2026-08-15T12:00:00+02:00') };

  const before = await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid före klockan 11 fredagen den 28 augusti 2026?',
    now,
  );
  assert.equal(before.pending?.availabilityConstraint.timeBoundary.kind, 'exclusive_upper');
  assert.equal(before.pending?.availabilityConstraint.timeBoundary.time, '11:00');
  assert.ok(before.pending?.ownedOfferedSlots.length > 0);
  assert.ok(before.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) < 11 * 60));

  const afternoon = await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid på eftermiddagen måndagen den 31 augusti 2026?',
    now,
  );
  assert.equal(afternoon.pending?.selectedDate, '2026-08-31');
  assert.equal(afternoon.pending?.availabilityStartDate, '2026-08-31');
  assert.equal(afternoon.pending?.availabilityEndDate, '2026-08-31');
  assert.equal(afternoon.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(afternoon.pending?.availabilityConstraint.daypart, 'afternoon');
  assert.equal(afternoon.pending?.availabilityConstraint.timeBoundary, undefined);
  assert.equal(afternoon.pending?.normalizedBookingRequest.timeConstraint.kind, 'afternoon');
  assert.ok(afternoon.pending?.ownedOfferedSlots.length > 0);
  assert.ok(afternoon.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 12 * 60 && minute < 17 * 60;
  }));
  assert.equal(afternoon.pending?.dateTime, null);
  assert.equal(afternoon.pending?.selectedSlotEnd, null);
  assert.equal(counters.availabilityReads, 2);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// ODIN-BOOKING-TIME-CONSTRAINT-002-STALE-EVENING-001: the definite Swedish
// evening daypart replaces the previous afternoon constraint and offer set.
{
  const { counters, events } = fixture();
  const session = 'wa_stale_evening';
  const user = 'stale-evening';
  const now = { now: new Date('2026-08-15T12:00:00+02:00') };

  const afternoon = await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid på eftermiddagen måndagen den 31 augusti 2026?',
    now,
  );
  assert.equal(afternoon.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(afternoon.pending?.availabilityConstraint.daypart, 'afternoon');
  assert.ok(afternoon.pending?.ownedOfferedSlots.length > 0);
  assert.ok(afternoon.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 12 * 60 && minute < 17 * 60;
  }));

  const evening = await turn(
    session,
    'whatsapp',
    user,
    'Har ni någon ledig tid på kvällen onsdagen den 2 september 2026?',
    now,
  );
  assert.equal(evening.pending?.selectedDate, '2026-09-02');
  assert.equal(evening.pending?.availabilityStartDate, '2026-09-02');
  assert.equal(evening.pending?.availabilityEndDate, '2026-09-02');
  assert.equal(evening.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(evening.pending?.availabilityConstraint.daypart, 'evening');
  assert.equal(evening.pending?.availabilityConstraint.minTime, '17:00');
  assert.equal(evening.pending?.availabilityConstraint.maxTime, '21:00');
  assert.equal(evening.pending?.normalizedBookingRequest.timeConstraint.kind, 'evening');
  assert.ok(evening.pending?.ownedOfferedSlots.length > 0);
  assert.ok(evening.pending.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 17 * 60 && minute < 21 * 60;
  }));
  assert.equal(evening.pending?.dateTime, null);
  assert.equal(evening.pending?.selectedSlotEnd, null);
  assert.equal(counters.availabilityReads, 2);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// The canonical availability state must replace, rather than intersect, each
// incompatible explicit constraint supplied on a later turn.
{
  const { counters } = fixture();
  const session = 'wa_constraint_replacement';
  const user = 'constraint-replacement';
  const now = { now: new Date('2026-08-15T12:00:00+02:00') };

  const after = await turn(
    session,
    'whatsapp',
    user,
    'Do you have availability after 15 on Friday 28 August 2026?',
    now,
  );
  assert.equal(after.pending?.availabilityConstraint.timeBoundary.kind, 'exclusive_lower');
  assert.equal(after.pending?.availabilityConstraint.timeBoundary.time, '15:00');

  const before = await turn(
    session,
    'whatsapp',
    user,
    'Do you have availability before 11 on Friday 28 August 2026 instead?',
    now,
  );
  assert.equal(before.pending?.availabilityConstraint.timeBoundary.kind, 'exclusive_upper');
  assert.equal(before.pending?.availabilityConstraint.timeBoundary.time, '11:00');
  assert.equal(before.pending?.availabilityConstraint.minTime, undefined);
  assert.ok(before.pending?.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) < 11 * 60));

  const morning = await turn(
    session,
    'whatsapp',
    user,
    'Do you have availability in the morning on Friday 28 August 2026 instead?',
    now,
  );
  assert.equal(morning.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(morning.pending?.availabilityConstraint.daypart, 'morning');

  const afternoon = await turn(
    session,
    'whatsapp',
    user,
    'Do you have availability in the afternoon on Friday 28 August 2026 instead?',
    now,
  );
  assert.equal(afternoon.pending?.availabilityConstraint.kind, 'daypart');
  assert.equal(afternoon.pending?.availabilityConstraint.daypart, 'afternoon');
  assert.ok(afternoon.pending?.ownedOfferedSlots.every((slot: any) => {
    const minute = localMinute(slot.start);
    return minute >= 12 * 60 && minute < 17 * 60;
  }));

  const exact = await turn(
    session,
    'whatsapp',
    user,
    'Is the appointment at 14:00 available on Friday 28 August 2026 instead?',
    now,
  );
  assert.equal(exact.pending?.availabilityConstraint.kind, 'exact_time');
  assert.equal(exact.pending?.availabilityConstraint.exactTime, '14:00');
  assert.equal(exact.pending?.availabilityConstraint.daypart, undefined);
  assert.equal(exact.pending?.dateTime, null, 'read-only exact availability must not create a hold');
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
}

// Test 1: WhatsApp before-time correction owns a fresh scan and invalidates old offers.
{
  const { counters } = fixture();
  const session = 'wa_46701110000';
  const first = await turn(session, 'whatsapp', '46701110000', 'Salam man ye vaght moshavereh mikham');
  const oldStarts = new Set((first.pending?.ownedOfferedSlots || []).map((slot: any) => slot.start));
  const oldFingerprint = first.pending?.lastAvailabilityConstraintKey;
  const readsBefore = counters.availabilityReads;
  const corrected = await turn(session, 'whatsapp', '46701110000', 'man ghabl az sate 13 mitonam biam');
  assert.equal(corrected.replies.length, 1);
  assert.equal(counters.availabilityReads, readsBefore + 1);
  assert.ok(corrected.pending?.ownedOfferedSlots.length > 0);
  assert.ok(corrected.pending.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) < 13 * 60));
  assert.ok(corrected.pending.ownedOfferedSlots.every((slot: any) => !oldStarts.has(slot.start)));
  assert.notEqual(corrected.pending.lastAvailabilityConstraintKey, oldFingerprint);
  assert.equal(corrected.pending.availabilityConstraint.timeBoundary.kind, 'exclusive_upper');
}

// Tests 2/3: WhatsApp contact dispatch, verified success, and all isolated terminal failures.
for (const failure of [undefined, 'calendar_create', 'calendar_verify', 'database_insert', 'database_verify', 'settlement'] as const) {
  const { counters, events } = fixture({ failOnce: failure });
  const user = `4670222${String(failure || 'ok').length}00`;
  const session = `wa_${user}`;
  await turn(session, 'whatsapp', user, 'Book a consultation next Friday at 16:30');
  await turn(session, 'whatsapp', user, 'bale mersi');
  assert.equal(boundary.whatsappWouldDispatch(session, 'Maral 03485350634'), true);
  const result = await turn(session, 'whatsapp', user, 'Maral 03485350634');
  assert.equal(result.replies.length, 1);
  assert.doesNotMatch(result.replies[0], /technical problem occurred/i);
  if (failure) {
    assert.equal(result.pending?.status, 'failed_recoverable');
    assert.equal(result.pending?.customerName, 'Maral');
    assert.ok(result.pending?.dateTime && result.pending?.selectedSlotEnd);
    assert.doesNotMatch(result.replies[0], /your appointment has been booked|your booking is confirmed/i);
    assert.ok(result.pending?.failedStage || result.pending?.lastFailureStage);
    assert.ok(counters.calendarCreate <= 1 && counters.calendarRead <= 1 && counters.databaseInsert <= 1 && counters.settlement <= 1);
  } else {
    assert.equal(result.pending, null);
    assert.equal(counters.calendarCreate, 1);
    assert.equal(counters.calendarRead, 1);
    assert.equal(counters.databaseInsert, 1);
    assert.equal(counters.databaseRead, 1);
    assert.equal(counters.settlement, 1);
    assert.equal(counters.createdName, 'Maral');
    assert.ok(counters.createdPhone.length >= 8);
    assert.match(result.replies[0], /booked|confirmed/i);
    assert.equal(events.size, 1);
  }
}

// Customer delivery failure stays terminal; admin failure cannot replace a delivered success.
{
  let state = fixture();
  await turn('wa_delivery', 'whatsapp', 'delivery', 'Book a consultation next Friday at 16:30');
  await turn('wa_delivery', 'whatsapp', 'delivery', 'Yes');
  const failedDelivery = await turn('wa_delivery', 'whatsapp', 'delivery', 'Maral 03485350634', { sendResult: false });
  assert.equal(failedDelivery.handled, true);
  assert.equal(failedDelivery.pending, null);
  assert.equal(failedDelivery.replies.length, 0);
  assert.equal(state.counters.calendarCreate, 1);

  state = fixture({ adminFailure: true });
  await turn('wa_admin', 'whatsapp', 'admin', 'Book a consultation next Friday at 16:30');
  await turn('wa_admin', 'whatsapp', 'admin', 'Yes');
  const adminFailure = await turn('wa_admin', 'whatsapp', 'admin', 'Maral 03485350634');
  assert.equal(adminFailure.pending, null);
  assert.equal(adminFailure.replies.length, 1);
  assert.equal(state.counters.admin, 1);
}

// Test 4: Instagram numeric Finglish weekday exact/range parity uses one snapshot per turn.
{
  const { counters, events } = fixture();
  const displayDate = '2026-08-05';
  events.set('working-hours', { id: 'working-hours', summary: 'Working Hours', start: { dateTime: `${displayDate}T09:00:00+02:00` }, end: { dateTime: `${displayDate}T19:00:00+02:00` } });
  events.set('booked', { id: 'booked', summary: 'Booked appointment', start: { dateTime: `${displayDate}T16:30:00+02:00` }, end: { dateTime: `${displayDate}T17:00:00+02:00` } });
  events.set('pending-hold', { id: 'pending-hold', summary: 'Pending hold', start: { dateTime: `${displayDate}T17:30:00+02:00` }, end: { dateTime: `${displayDate}T18:00:00+02:00` } });
  await turn('ig_range', 'instagram', 'range', 'Salam man ye vaght moshavereh mikham');
  const beforeRangeReads = counters.availabilityReads;
  const range = await turn('ig_range', 'instagram', 'range', '4 shanbe bad az sate 16', {
    now: canonicalNow,
  });
  assert.equal(counters.availabilityReads, beforeRangeReads + 1);
  console.log("DEBUG IG RANGE OWNED SLOTS:", range.pending?.ownedOfferedSlots?.map((slot: any) => ({
    start: slot.start,
    localMinute: localMinute(slot.start),
  })));
  assert.ok(range.pending?.ownedOfferedSlots.every((slot: any) => localMinute(slot.start) > 16 * 60));
  assert.ok(range.pending?.ownedOfferedSlots.some((slot: any) => localMinute(slot.start) === 17 * 60));
  await turn('ig_exact', 'instagram', 'exact', 'Salam man ye vaght moshavereh mikham');
  const beforeExactReads = counters.availabilityReads;
  const exact = await turn('ig_exact', 'instagram', 'exact', '4shanbe sate 17', {
    now: canonicalNow,
  });
  assert.equal(counters.availabilityReads, beforeExactReads + 1);
  assert.equal(localMinute(exact.pending?.dateTime), 17 * 60);
  assert.equal(range.pending?.selectedDate, exact.pending?.selectedDate);
}

// Test 5: Instagram lookup ownership survives restart and never includes another customer.
{
  const { events, restart } = fixture();
  const owned = (id: string, hour: number) => ({ id, status: 'confirmed', summary: `Bokad: Peter - 0701234567`, description: 'BusinessId: 7', start: { dateTime: `2026-08-14T${String(hour).padStart(2, '0')}:00:00+02:00` }, end: { dateTime: `2026-08-14T${String(hour).padStart(2, '0')}:30:00+02:00` }, extendedProperties: { private: { businessId: '7', platform: 'instagram', userId: 'owner' } } });
  events.set('owned-1', owned('owned-1', 10));
  events.set('owned-2', owned('owned-2', 11));
  events.set('other', { ...owned('other', 12), extendedProperties: { private: { businessId: '7', platform: 'instagram', userId: 'other' } } });
  restart();
  const found = await turn('ig_owner', 'instagram', 'owner', 'Jag vill ändra min tid', { now: canonicalNow });
  assert.equal(found.selection?.appointments.length, 2);
  assert.ok(found.selection.appointments.every((item: any) => item.id !== 'other'));
  const selected = await turn('ig_owner', 'instagram', 'owner', '1', { now: canonicalNow });
  assert.ok(['owned-1', 'owned-2'].includes(String(selected.appointment?.id)));
  const stableId = selected.appointment.id;
  await turn('ig_owner', 'instagram', 'owner', 'torsdag kl 15', { now: canonicalNow });
  const corrected = await turn('ig_owner', 'instagram', 'owner', 'torsdag kl 16 istället', { now: canonicalNow });
  assert.equal(corrected.appointment?.id || stableId, stableId);
}

const messengerAppointment = { id: 'row-ms', calendarEventId: 'event-ms', source: 'appointments_table', customerName: 'Peter', phone: '0701234567', platform: 'messenger', userId: 'ms-owner', businessId: '7', service: 'Konsultation', start: '2026-08-14T10:00:00+02:00', end: '2026-08-14T08:30:00.000Z', status: 'booked' };

// Tests 6/7: Messenger cancellation is terminal and duplicate delivery is suppressed.
{
  const { counters, events } = fixture();
  events.set('event-ms', { id: 'event-ms', status: 'confirmed', summary: 'Bokad: Peter - 0701234567', description: 'BusinessId: 7', start: { dateTime: new Date(messengerAppointment.start).toISOString() }, end: { dateTime: messengerAppointment.end }, extendedProperties: { private: { businessId: '7', platform: 'messenger', userId: 'ms-owner' } } });
  boundary.seedOwnedAppointment({ sessionId: 'ms_ms-owner', platform: 'messenger', userId: 'ms-owner', businessConfig, appointment: messengerAppointment, operation: 'cancellation' });
  await inbound('ms-reason', 'ms_ms-owner', 'messenger', 'ms-owner', 'Mina planer ändrades', { now: canonicalNow });
  const confirmed = await inbound('ms-confirm', 'ms_ms-owner', 'messenger', 'ms-owner', 'Bale', { now: canonicalNow });
  const duplicate = await inbound('ms-confirm', 'ms_ms-owner', 'messenger', 'ms-owner', 'Bale', { now: canonicalNow });
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.replies.length, 1);
  assert.match(confirmed.replies[0], /cancelled|canceled|avbokad|لغو/u);
  assert.equal(confirmed.operation.operation, 'none');
  assert.equal(duplicate.replies.length, 0);
  assert.equal(counters.calendarDelete, 1);
  assert.equal(counters.databaseCancel, 1);
  assert.equal(counters.cancellationSettlement, 1);
  assert.equal(counters.admin, 1);
  assert.equal(counters.usage, 2);
}

// Messenger admin notification failure cannot replace or suppress customer success.
{
  const { counters, events } = fixture({ adminFailure: true });
  events.set('event-ms', { id: 'event-ms', status: 'confirmed', summary: 'Bokad appointment', description: 'BusinessId: 7', start: { dateTime: new Date(messengerAppointment.start).toISOString() }, end: { dateTime: messengerAppointment.end }, extendedProperties: { private: { businessId: '7', platform: 'messenger', userId: 'ms-owner' } } });
  boundary.seedOwnedAppointment({ sessionId: 'ms_ms-owner', platform: 'messenger', userId: 'ms-owner', businessConfig, appointment: messengerAppointment, operation: 'cancellation' });
  await turn('ms_ms-owner', 'messenger', 'ms-owner', 'Mina planer ändrades', { now: canonicalNow });
  const confirmed = await turn('ms_ms-owner', 'messenger', 'ms-owner', 'Bale', { now: canonicalNow });
  assert.equal(confirmed.replies.length, 1);
  assert.match(confirmed.replies[0], /cancelled|canceled|avbokad|لغو/u);
  assert.equal(confirmed.operation.operation, 'none');
  assert.equal(counters.admin, 1);
  assert.equal(counters.calendarDelete, 1);
}

console.log('Priority 1J non-Telegram channel-parity real-engine transcripts passed');


// Service guidance yields to the authoritative business/service AI layer while
// retaining only an unresolved booking goal. A selected service resumes booking.
{
  const { counters, events } = fixture();
  const sessionId = 'service-guidance-without-selection';
  const first = await turn(
    sessionId,
    'telegram',
    sessionId,
    'Jag behöver boka en tid, men jag vet inte vilken tjänst som passar.',
  );
  assert.equal(first.handled, false);
  assert.deepEqual(first.replies, []);
  assert.equal(first.pending?.status, 'awaiting_service');
  assert.equal(first.pending?.operation, 'new_booking');
  assert.equal(first.pending?.dateTime, null);
  assert.deepEqual(first.pending?.ownedOfferedSlots, []);
  assert.ok(!boundary.geminiToolNames(sessionId).includes('checkSlots'));

  const staleOffers = [
    ['13:45', '2026-08-17T13:45:00+02:00'],
    ['14:00', '2026-08-17T14:00:00+02:00'],
    ['14:15', '2026-08-17T14:15:00+02:00'],
  ] as const;
  boundary.seedPending(sessionId, {
    ...first.pending,
    status: 'awaiting_time_selection',
    service: 'Konsultation',
    selectedDate: '2026-08-17',
    availabilityStartDate: '2026-08-17',
    availabilityEndDate: '2026-08-17',
    offeredSlots: staleOffers.map(([time, start]) => `Måndag kl ${time} (ISO: ${start})`),
    ownedOfferedSlots: staleOffers.map(([, start]) => ({
      start,
      end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform: 'telegram',
      userId: sessionId,
      generatedAt: Date.now(),
      searchStartDate: '2026-08-17',
      searchEndDate: '2026-08-17',
    })),
    durationMinutes: 30,
  });

  const guidance = await turn(
    sessionId,
    'telegram',
    sessionId,
    'Jag förstår att ni har tider den 17 augusti, men jag vet fortfarande inte vilken typ av tjänst jag ska boka. Kan ni hjälpa mig att reda ut det?',
  );
  assert.equal(guidance.handled, false);
  assert.deepEqual(guidance.replies, []);
  assert.equal(guidance.pending?.status, 'awaiting_service');
  assert.equal(guidance.pending?.dateTime, null);
  assert.deepEqual(guidance.pending?.ownedOfferedSlots, []);
  assert.doesNotMatch(guidance.replies.join(' '), /Jag hittade lediga tider|Vilken av de föreslagna tiderna väljer du/iu);
  assert.ok(!boundary.geminiToolNames(sessionId).includes('checkSlots'));

  const explicitGuidance = await turn(
    sessionId,
    'telegram',
    sessionId,
    'Jag förstår att ni har tider den 17 augusti, men jag behöver först veta vilken typ av tjänst ni erbjuder. Kan ni beskriva de olika tjänsterna ni har så jag kan välja rätt en?',
  );
  assert.equal(explicitGuidance.handled, false);
  assert.deepEqual(explicitGuidance.replies, []);
  assert.equal(explicitGuidance.pending?.status, 'awaiting_service');
  assert.equal(explicitGuidance.pending?.selectedDate, null);
  assert.equal(explicitGuidance.pending?.dateTime, null);
  assert.deepEqual(explicitGuidance.pending?.ownedOfferedSlots, []);
  assert.doesNotMatch(explicitGuidance.replies.join(' '), /Jag hittade lediga tider|Vilken av de föreslagna tiderna väljer du/iu);

  const resumed = await turn(
    sessionId,
    'telegram',
    sessionId,
    'En konsultation låter bra, tack! Jag vill gärna boka in en tid för att få hjälp att välja rätt tjänst.',
  );
  assert.equal(resumed.handled, true);
  assert.equal(resumed.pending?.status, 'awaiting_time_selection');
  assert.equal(resumed.pending?.service, 'Konsultation');
  assert.equal(resumed.pending?.dateTime, null);
  assert.ok(resumed.pending?.ownedOfferedSlots.length > 0);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// An explicit informational question temporarily outranks a pending booking CTA
// without discarding the owned selected slot; readiness resumes normal booking.
{
  const { counters, events } = fixture();
  const sessionId = 'pending-booking-informational-priority';
  const start = '2026-08-19T10:00:00+02:00';
  const end = '2026-08-19T08:30:00.000Z';
  boundary.seedPending(sessionId, {
    businessId: '7',
    platform: 'telegram',
    userId: sessionId,
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking',
    service: 'Konsultation',
    status: 'awaiting_confirmation',
    selectedDate: '2026-08-19',
    dateTime: start,
    selectedSlotEnd: end,
    durationMinutes: 30,
    offeredSlots: [`Onsdag kl 10:00 (ISO: ${start})`],
    ownedOfferedSlots: [{
      start,
      end,
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform: 'telegram',
      userId: sessionId,
      generatedAt: Date.now(),
      searchStartDate: '2026-08-19',
      searchEndDate: '2026-08-19',
    }],
    language: 'sv',
  });

  const firstQuestion = await turn(
    sessionId,
    'telegram',
    sessionId,
    'Ja, det passar bra. Men jag vill gärna veta lite mer om vad den här konsultationen innebär innan jag bokar.',
  );
  assert.equal(firstQuestion.handled, false);
  assert.equal(firstQuestion.pending?.status, 'awaiting_confirmation');
  assert.equal(firstQuestion.pending?.dateTime, start);
  const firstAnswer = boundary.guardReply(
    sessionId,
    'Konsultationen används för att förstå era mål och bedöma vilken lösning som passar. Passar onsdag den 19 augusti kl. 10:00 dig för att boka den tiden?',
  );
  assert.match(firstAnswer, /förstå era mål/iu);
  assert.doesNotMatch(firstAnswer, /Passar onsdag|boka den tiden/iu);

  const detailedQuestion = await turn(
    sessionId,
    'telegram',
    sessionId,
    'Tack! Kan du berätta lite mer om hur själva konsultationen går till? Vad kan jag förvänta mig att vi kommer att gå igenom under de 30 minuterna?',
  );
  assert.equal(detailedQuestion.handled, false);
  assert.equal(detailedQuestion.pending?.status, 'awaiting_confirmation');
  assert.equal(detailedQuestion.pending?.dateTime, start);
  const detailedAnswer = boundary.guardReply(
    sessionId,
    'Under de 30 minuterna går vi igenom målgrupp, budskap, annonsformat och vilka nästa steg som är rimliga. Passar onsdag den 19 augusti kl. 10:00 dig för att boka den tiden?',
  );
  assert.match(detailedAnswer, /målgrupp, budskap, annonsformat/iu);
  assert.doesNotMatch(detailedAnswer, /Passar onsdag|boka den tiden/iu);

  const ready = await turn(sessionId, 'telegram', sessionId, 'Ja tack, boka den.');
  assert.equal(ready.pending?.status, 'awaiting_contact');
  assert.equal(ready.pending?.dateTime, start);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// Same-turn slot selection plus explicit booking authorization advances past
// confirmation; the same selection without authorization still asks first.
{
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };
  const availabilityText = 'Ja, det låter bra. Kan vi boka en tid redan nästa vecka? Jag har lite tid på torsdag eller fredag.';

  const authorizedFixture = fixture();
  const authorizedSession = 'telegram-same-turn-slot-authorization';
  const offered = await turn(
    authorizedSession,
    'telegram',
    authorizedSession,
    availabilityText,
    now,
  );
  assert.ok(offered.pending?.ownedOfferedSlots.some((slot: any) =>
    slot.start.startsWith('2026-08-27T14:00:00')
  ));

  const authorized = await turn(
    authorizedSession,
    'telegram',
    authorizedSession,
    'Torsdag den 27 augusti kl 14:00 passar mig bra. Kan du boka den tiden?',
    now,
  );
  assert.equal(authorized.pending?.status, 'awaiting_contact');
  assert.equal(authorized.pending?.selectedDate, '2026-08-27');
  assert.equal(localMinute(authorized.pending?.dateTime), 14 * 60);
  assert.doesNotMatch(authorized.replies.join(' '), /Ska jag boka den åt dig/iu);
  assert.match(authorized.replies.join(' '), /namn|mobilnummer|telefonnummer/iu);
  assert.equal(authorizedFixture.counters.calendarCreate, 0);
  assert.equal(authorizedFixture.counters.databaseInsert, 0);
  assert.equal(authorizedFixture.events.size, 0);

  const selectionOnlyFixture = fixture();
  const selectionOnlySession = 'telegram-same-turn-slot-selection-only';
  await turn(
    selectionOnlySession,
    'telegram',
    selectionOnlySession,
    availabilityText,
    now,
  );
  const selectionOnly = await turn(
    selectionOnlySession,
    'telegram',
    selectionOnlySession,
    'Torsdag den 27 augusti kl 14:00 passar mig bra.',
    now,
  );
  assert.equal(selectionOnly.pending?.status, 'awaiting_confirmation');
  assert.match(selectionOnly.replies.join(' '), /Ska jag boka den åt dig/iu);
  assert.equal(selectionOnlyFixture.counters.calendarCreate, 0);
  assert.equal(selectionOnlyFixture.counters.databaseInsert, 0);
  assert.equal(selectionOnlyFixture.events.size, 0);
}

// BUG 1: an explicit confirmation that repeats the owned slot's date and time
// must reach the pending-confirmation transition, not restart availability.
{
  const { counters, events } = fixture();
  const sessionId = 'telegram-explicit-confirmation-loop';
  const userId = 'telegram-explicit-confirmation-loop';
  const now = { now: new Date('2026-08-16T12:00:00+02:00') };

  const turn1 = await turn(
    sessionId,
    'telegram',
    userId,
    'Jag behöver boka en tid, men jag vet inte vilken tjänst som passar.',
    now,
  );
  assert.equal(turn1.handled, false);

  const turn2 = await turn(
    sessionId,
    'telegram',
    userId,
    'En konsultation låter bra, tack! Jag vill gärna boka in en tid för att få hjälp att välja rätt tjänst.',
    now,
  );
  assert.equal(turn2.handled, true);
  assert.equal(turn2.pending?.status, 'awaiting_time_selection');
  assert.equal(turn2.pending?.service, 'Konsultation');
  assert.equal(turn2.pending?.selectedDate, '2026-08-17');

  // Preserve the independently observed BlackBox offer set at the shared
  // pending-state boundary; the confirmation transition below is the defect.
  const offered = [
    ['13:30', '2026-08-17T13:30:00+02:00'],
    ['14:30', '2026-08-17T14:30:00+02:00'],
    ['14:45', '2026-08-17T14:45:00+02:00'],
  ] as const;
  boundary.seedPending(sessionId, {
    ...turn2.pending,
    businessId: '7',
    platform: 'telegram',
    userId,
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    selectedDate: '2026-08-17',
    offeredSlots: offered.map(([time, start]) => `Måndag kl ${time} (ISO: ${start})`),
    ownedOfferedSlots: offered.map(([, start]) => ({
      start,
      end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform: 'telegram',
      userId,
      generatedAt: Date.now(),
      searchStartDate: '2026-08-17',
      searchEndDate: '2026-08-17',
    })),
  });

  const selected = await turn(
    sessionId,
    'telegram',
    userId,
    '14:30 passar mig bäst, tack!',
    now,
  );
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  assert.equal(selected.pending?.selectedDate, '2026-08-17');
  assert.equal(localMinute(selected.pending?.dateTime), 14 * 60 + 30);
  assert.match(selected.replies.join(' '), /Ska jag boka den åt dig/iu);

  const confirmed = await turn(
    sessionId,
    'telegram',
    userId,
    'Ja, tack! Då bokar vi in konsultationen för måndag 17 augusti klockan 14:30.',
    now,
  );
  assert.equal(confirmed.pending?.status, 'awaiting_contact');
  assert.equal(confirmed.pending?.selectedDate, '2026-08-17');
  assert.equal(localMinute(confirmed.pending?.dateTime), 14 * 60 + 30);
  assert.doesNotMatch(confirmed.replies.join(' '), /Ska jag boka den åt dig/iu);
  assert.match(confirmed.replies.join(' '), /namn|mobilnummer|telefonnummer/iu);

  const repeated = await turn(
    sessionId,
    'telegram',
    userId,
    'Ja tack, boka den.',
    now,
  );
  assert.equal(repeated.pending?.status, 'awaiting_contact');
  assert.doesNotMatch(repeated.replies.join(' '), /Ska jag boka den åt dig/iu);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// A service-guidance intent change releases an existing provisional selection
// before yielding, so neither the old reply nor its pending hold can survive.
for (const platformName of [
  'whatsapp',
  'instagram',
  'messenger',
  'telegram'
] as const) {
  fixture();

  const userId = `guidance-${platformName}`;
  const sessionId =
    platformName === 'whatsapp'
      ? `wa_${userId}`
      : platformName === 'instagram'
        ? `ig_${userId}`
        : platformName === 'messenger'
          ? `ms_${userId}`
          : userId;

  const offeredSlot = '2026-08-19T09:00:00.000Z';
  const offeredEnd = '2026-08-19T09:30:00.000Z';

  boundary.seedPending(sessionId, {
    businessId: String(businessConfig.id),
    platform: platformName,
    userId,
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking',
    customerName: null,
    customerPhone: null,
    contactPhoneSource: 'missing',
    service: 'Konsultation',
    status: 'awaiting_confirmation',
    offeredSlots: [offeredSlot],
    ownedOfferedSlots: [
      {
        start: offeredSlot,
        end: offeredEnd,
        durationMinutes: 30,
        service: 'Konsultation',
        businessId: '7',
        platform: platformName,
        userId,
        generatedAt: Date.now(),
        searchStartDate: '2026-08-19',
        searchEndDate: '2026-08-19'
      }
    ],
    dateTime: offeredSlot,
    selectedSlotEnd: offeredEnd,
    selectedDate: '2026-08-19',
    durationMinutes: 30,
  });

  const result =
    await turn(
      sessionId,
      platformName,
      userId,
      'Jag vet inte riktigt vilken typ av tjänst jag ska boka. Kan du hjälpa mig att förstå vad som passar för mitt behov?'
    );

  assert.equal(
    result.handled,
    false,
    `${platformName}: general service-guidance question must yield to General AI`
  );

  assert.deepEqual(
    result.replies,
    [],
    `${platformName}: booking engine must not answer a general service-guidance question`
  );

  const suspended = boundary.pendingStateSnapshot(sessionId);
  assert.equal(suspended?.status, 'awaiting_service');
  assert.equal(suspended?.dateTime, null);
  assert.equal(suspended?.selectedDate, null);
  assert.deepEqual(suspended?.ownedOfferedSlots, []);

  const repeated = await turn(
    sessionId,
    platformName,
    userId,
    'Jag vet fortfarande inte vilken tjänst som passar. Kan du hjälpa mig välja?'
  );
  assert.equal(repeated.handled, false);
  assert.deepEqual(repeated.replies, []);
  assert.equal(repeated.pending?.status, 'awaiting_service');
  assert.equal(repeated.pending?.dateTime, null);
  assert.deepEqual(repeated.pending?.ownedOfferedSlots, []);
}

// A natural explicit Swedish authorization advances a tool-created selected
// slot to contact collection instead of repeating the availability question.
for (const platformName of ['telegram', 'instagram'] as const) {
  const { counters, events } = fixture();
  const userId = `natural-confirmation-${platformName}`;
  const sessionId = platformName === 'instagram' ? `ig_${userId}` : userId;
  const start = '2026-08-17T12:00:00.000Z';
  const end = '2026-08-17T12:30:00.000Z';
  boundary.seedPending(sessionId, {
    businessId: '7',
    platform: platformName,
    userId,
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking',
    service: 'Konsultation',
    status: 'awaiting_confirmation',
    selectedDate: '2026-08-17',
    dateTime: start,
    selectedSlotEnd: end,
    durationMinutes: 30,
    offeredSlots: [`Måndag kl 14:00 (ISO: ${start})`],
    ownedOfferedSlots: [{
      start,
      end,
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform: platformName,
      userId,
      generatedAt: Date.now(),
      searchStartDate: '2026-08-17',
      searchEndDate: '2026-08-17',
    }],
    language: 'sv',
  });

  const confirmed = await turn(
    sessionId,
    platformName,
    userId,
    'Ja, det låter bra. Kan du boka den tiden åt mig?',
    { now: new Date('2026-08-16T12:00:00+02:00') },
  );
  assert.equal(confirmed.pending?.status, 'awaiting_contact');
  assert.equal(confirmed.pending?.dateTime, start);
  assert.doesNotMatch(confirmed.replies.join(' '), /Ska jag boka den åt dig/iu);
  assert.match(confirmed.replies.join(' '), /namn|mobilnummer|telefonnummer/iu);
  assert.equal(counters.calendarCreate, 0);
  assert.equal(counters.databaseInsert, 0);
  assert.equal(events.size, 0);
}

// Canonical availability blocks another customer's hold, while the same
// business/channel/user remains the owner across runtime and Test Bridge session keys.
{
  fixture();
  const start = '2026-08-19T09:00:00.000Z';
  const end = '2026-08-19T10:00:00.000Z';
  const seedBlocker = (sessionId: string, userId: string) => boundary.seedPending(sessionId, {
    businessId: '7', platform: 'telegram', userId, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', service: 'Konsultation', status: 'awaiting_confirmation',
    selectedDate: '2026-08-19', dateTime: start, selectedSlotEnd: end,
    durationMinutes: 60, offeredSlots: [`Onsdag kl 11:00 (ISO: ${start})`],
    ownedOfferedSlots: [{
      start, end, durationMinutes: 60, service: 'Konsultation', businessId: '7',
      platform: 'telegram', userId, generatedAt: Date.now(),
      searchStartDate: '2026-08-19', searchEndDate: '2026-08-19',
    }],
  });

  seedBlocker('telegram-other-customer', 'other-customer');
  const foreignOwner = await boundary.canonicalOffers({
    businessConfig,
    sessionId: 'telegram-requesting-customer',
    platform: 'telegram',
    userId: 'requesting-customer',
    startDate: '2026-08-19',
    endDate: '2026-08-19',
    service: 'Konsultation',
    durationMinutes: 60,
    requestedTime: '11:00',
  });
  assert.ok(foreignOwner.ownedSlots.every((slot: any) => localMinute(slot.start) !== 11 * 60));

  fixture();
  seedBlocker('tg:7:bot:same-customer', 'same-customer');
  const sameCanonicalOwner = await boundary.canonicalOffers({
    businessConfig,
    sessionId: 'test-bridge:7:telegram:same-customer',
    platform: 'telegram',
    userId: 'same-customer',
    startDate: '2026-08-19',
    endDate: '2026-08-19',
    service: 'Konsultation',
    durationMinutes: 60,
    requestedTime: '11:00',
  });
  assert.ok(sameCanonicalOwner.ownedSlots.some((slot: any) => localMinute(slot.start) === 11 * 60));
}
