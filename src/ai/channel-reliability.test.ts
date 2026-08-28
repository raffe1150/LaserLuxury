import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyMessagingIntent,
  detectExplicitLanguageSwitch,
  hasStrongLatinPersianEvidence,
  parseNormalizedTimeRange,
  resolveTelegramReplyPreference,
  resolveStableConversationLanguage,
  scoreLatinPersianEvidence,
  selectTelegramDeliveryMode,
} from './channel-reliability';

assert.equal(hasStrongLatinPersianEvidence('Salam khub hastin'), true);
assert.equal(hasStrongLatinPersianEvidence('Mishe begin kare shuma chie?'), true);
assert.equal(hasStrongLatinPersianEvidence('Chera zabaneto avaz mikoni?'), true);
assert.ok(scoreLatinPersianEvidence('hello, what do you do?') < 3);
assert.equal(resolveStableConversationLanguage('fa', 'en'), 'fa');
assert.equal(detectExplicitLanguageSwitch('please reply in English'), 'en');
assert.equal(detectExplicitLanguageSwitch('svara på svenska'), 'sv');
assert.equal(resolveStableConversationLanguage('fa', 'en', 'en'), 'en');
assert.equal(resolveStableConversationLanguage('fa', 'sv', 'sv'), 'sv');

assert.equal(classifyMessagingIntent('Mishe begin kare shuma chie?'), 'normal');
assert.equal(classifyMessagingIntent('Chera zabaneto avaz mikoni?'), 'language_repair');
assert.equal(classifyMessagingIntent('Mikham vaghtam ro taghir bedam'), 'reschedule');
assert.equal(classifyMessagingIntent('Mikham vaghtam ro laghv konam'), 'cancellation');
assert.equal(classifyMessagingIntent('Aya man vaght ghabli daram?'), 'existing_booking_lookup');
assert.equal(classifyMessagingIntent('Dar morede vaghtam soal daram'), 'ambiguous');
assert.equal(classifyMessagingIntent('هل لديكم موعد متاح بعد الساعة 15 يوم الجمعة 25 سبتمبر 2026؟'), 'new_booking');
assert.equal(classifyMessagingIntent('¿Tienen alguna cita después de las 15:00 el viernes 18 de septiembre de 2026?'), 'new_booking');

let preference = resolveTelegramReplyPreference(null, 'voice', 'سلام');
assert.deepEqual(preference, { mode: 'voice', explicit: false });
assert.equal(selectTelegramDeliveryMode(preference, 'voice'), 'voice');
preference = resolveTelegramReplyPreference(preference, 'text', 'سلام دوباره');
assert.deepEqual(preference, { mode: 'auto', explicit: false });
assert.equal(selectTelegramDeliveryMode(preference, 'text'), 'text');
preference = resolveTelegramReplyPreference(preference, 'text', 'reply with voice');
assert.deepEqual(preference, { mode: 'voice', explicit: true });
assert.equal(selectTelegramDeliveryMode(preference, 'text'), 'voice');
preference = resolveTelegramReplyPreference(preference, 'text', 'reply with text');
assert.deepEqual(preference, { mode: 'text', explicit: true });
assert.equal(selectTelegramDeliveryMode(preference, 'voice'), 'text');

assert.deepEqual(parseNormalizedTimeRange('after 16'), { kind: 'exclusive_lower', time: '16:00' });
assert.deepEqual(parseNormalizedTimeRange('at 16'), { kind: 'exact', time: '16:00' });
assert.deepEqual(parseNormalizedTimeRange('from 16'), { kind: 'inclusive_lower', time: '16:00' });
assert.deepEqual(parseNormalizedTimeRange('after 16:30'), { kind: 'exclusive_lower', time: '16:30' });
assert.deepEqual(parseNormalizedTimeRange('before 15'), { kind: 'exclusive_upper', time: '15:00' });
assert.deepEqual(parseNormalizedTimeRange('between 16 and 18'), { kind: 'window', minTime: '16:00', maxTime: '18:00' });
assert.deepEqual(parseNormalizedTimeRange('بعد از ساعت ۱۶'), { kind: 'exclusive_lower', time: '16:00' });
assert.deepEqual(parseNormalizedTimeRange('efter klockan 16'), { kind: 'exclusive_lower', time: '16:00' });
assert.deepEqual(parseNormalizedTimeRange('a bit later'), { kind: 'relative_later' });

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(server, /const whatsappIntent = classifyMessagingIntent\(textMessage\)/);
assert.match(server, /if \(!clearlyNonBookingTurn\)[\s\S]{0,500}handleUnifiedBookingEngine\(/);
assert.match(server, /whatsappIntent === "language_repair"[\s\S]{0,200}formatLanguageRepairAcknowledgement/);
assert.match(server, /whatsappIntent === "ambiguous"[\s\S]{0,200}formatAmbiguousBookingIntentClarification/);
assert.match(server, /const telegramReplyPreferences:/);
assert.match(server, /updateTelegramReplyPreference\([\s\S]{0,300}resolveTelegramReplyPreference/);
assert.match(server, /send:\s*async \(reply\) => \(await sendTelegramPreferredReply/);
assert.match(server, /lastAvailabilityConstraintKey === availabilityConstraintKey/);
assert.match(server, /isSlotListRepeatRequest\(text\)/);
assert.match(server, /offeredSlots: slots,[\s\S]{0,500}lastAvailabilityConstraintKey: availabilityConstraintKey/);
assert.match(server, /enumerateCandidateMinutes\([\s\S]{0,300}boundaryKind: afterMinutes !== null \? "exclusive_lower" : options\.timeBoundary\?\.kind/);
assert.match(server, /const messages = history\.slice\(-20\)/);
assert.match(server, /parseNormalizedTimeRange\(raw\)/);
assert.doesNotMatch(server, /if \(voice\) \{\s*let sentAudio/);
assert.match(server, /runWithInboundMessageClaim\([\s\S]{0,300}platform: "telegram"/);
assert.match(server, /inputMode:\s*voice \? "voice" : "text"/);
assert.match(server, /registerConversationTurn\(telegramSessionId, telegramTurnSequence\)/);
assert.match(server, /if \(!isCurrentConversationTurn\(telegramSessionId, telegramTurnSequence\)\) return/);
const verifiedResult = server.indexOf('const bookingOperationResult = createBookingOperationResult');
const successAuthorization = server.indexOf('verifiedBookingReplyAuthorizations[sessionId] = bookingOperationResult', verifiedResult);
assert.ok(verifiedResult >= 0 && successAuthorization > verifiedResult);

console.log('Channel reliability policy tests passed');
