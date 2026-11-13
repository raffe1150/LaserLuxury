// Synthetic, deterministic German/Swedish language-classification cases shared
// by the pure marker tests and the server boundary integration test. No
// production prose: every sentence below was written for this test.
export type Target = 'sv' | 'de' | 'en' | 'es' | 'fa' | 'ar';

/** Outgoing Knowledge answer units: [target language, unit text, expected local verdict, category]. */
export const OUTGOING_UNITS: ReadonlyArray<readonly [Target, string, 'accept' | 'reject', string]> = [
  // German, informal (du): previously rejected as Swedish.
  ['de', 'Wenn du möchtest, kannst du die Buchung ändern.', 'accept', 'de-informal'],
  ['de', 'Du kannst deine Buchung jederzeit online ändern, wenn du magst.', 'accept', 'de-informal'],
  ['de', 'Kannst du bitte zehn Minuten vorher da sein? Dann kannst du entspannt ankommen.', 'accept', 'de-informal'],
  ['de', 'Wenn du Fragen hast, kannst du uns jederzeit schreiben.', 'accept', 'de-informal'],
  ['de', 'Du bist herzlich willkommen, du musst nichts mitbringen.', 'accept', 'de-informal'],
  ['de', 'Möchtest du einen Termin am Freitag?', 'accept', 'de-informal'],
  ['de', 'Wenn du bereit bist, schick mir deinen Namen.', 'accept', 'de-informal'],
  ['de', 'Hast du noch Fragen zu deinem Termin?', 'accept', 'de-informal'],
  ['de', 'Du kannst die Konsultation verschieben.', 'accept', 'de-informal-shared-lexeme'],
  // German, formal.
  ['de', 'Sie können Ihre Buchung jederzeit online ändern.', 'accept', 'de-formal'],
  ['de', 'Ihr Termin ist am Freitag um 14:00 Uhr bestätigt.', 'accept', 'de-formal-booking'],
  ['de', 'Ihre Buchung wurde bestätigt.', 'accept', 'de-formal-booking'],
  ['de', 'Bitte bringen Sie Ihre Buchungsbestätigung mit.', 'accept', 'de-formal-booking'],
  ['de', 'Können Sie die Konsultation verschieben?', 'accept', 'de-formal-shared-lexeme'],
  ['de', 'Für die Konsultation brauchen Sie keinen Ausweis.', 'accept', 'de-formal-shared-lexeme'],
  // Shared German/Swedish vocabulary.
  ['de', 'Die Konsultation dauert 30 Minuten.', 'accept', 'de-shared-lexeme'],
  ['de', 'Eine Konsultation ist kostenlos und unverbindlich.', 'accept', 'de-shared-lexeme'],
  ['de', 'Die erste Konsultation kostet 450 Kronen.', 'accept', 'de-shared-lexeme'],
  ['de', 'Den Termin kannst du online buchen.', 'accept', 'de-shared-article'],
  ['de', 'Man kann das Auto direkt vor dem Studio parken.', 'accept', 'de-man'],
  ['de', 'Man sollte zehn Minuten vorher da sein.', 'accept', 'de-man'],
  // Numbers, addresses, configured entities.
  ['de', 'Das kostet 500 kr.', 'accept', 'de-numbers'],
  ['de', 'Öffnungszeiten: 10–18 Uhr.', 'accept', 'de-numbers'],
  ['de', 'Wir haben montags bis freitags von 9 bis 17 Uhr geöffnet.', 'accept', 'de-numbers'],
  ['de', 'Das Studio liegt in der Storgatan 12 in Stockholm.', 'accept', 'de-address'],
  ['de', 'Sie finden uns bei Storgatan 12.', 'accept', 'de-address'],
  ['de', 'Du findest uns auf der Storgatan 12.', 'accept', 'de-address'],
  ['de', 'Die Hejsan Massage dauert 60 Minuten.', 'accept', 'de-configured-entity'],
  ['de', 'Die Ganzkörpermassage dauert 60 Minuten und kostet 700 kr.', 'accept', 'de-booking'],
  ['de', 'Eine Stornierung ist bis 24 Stunden vorher kostenlos.', 'accept', 'de-policy'],
  // Genuine Swedish under a German target stays rejected.
  ['de', 'Du kan ändra din bokning online.', 'reject', 'sv-under-de'],
  ['de', 'Om du vill kan du boka en konsultation.', 'reject', 'sv-under-de'],
  ['de', 'Är du sen ringer du oss.', 'reject', 'sv-under-de-unframed-du'],
  ['de', 'Du får gärna komma tio minuter innan, du behöver inte ta med något.', 'reject', 'sv-under-de'],
  ['de', 'Tiden är ledig.', 'reject', 'sv-under-de-unicode'],
  ['de', 'Tyvärr är tiden bokad.', 'reject', 'sv-under-de'],
  ['de', 'Konsultation tar 30 minuter.', 'reject', 'sv-under-de-shared-lexeme'],
  ['de', 'Ändra din tid senast 24 timmar innan.', 'reject', 'sv-under-de-unicode'],
  ['de', 'Studion ligger på Storgatan 12.', 'reject', 'sv-under-de-address'],
  ['de', 'Det finns lediga tider på fredag.', 'reject', 'sv-under-de'],
  ['de', 'Ta gärna med din bokningsbekräftelse.', 'reject', 'sv-under-de-confirmation'],
  ['de', 'Är du gäst hos oss, du är välkommen.', 'reject', 'sv-under-de-st-noun'],
  ['de', 'Senast du bokade var i mars, du kan boka igen.', 'reject', 'sv-under-de-st-adverb'],
  // Other genuine foreign languages under a German target stay rejected.
  ['de', 'Your appointment is confirmed for Friday at 2 pm.', 'reject', 'en-under-de'],
  ['de', 'Su cita está confirmada para el viernes a las 14:00.', 'reject', 'es-under-de'],
  ['de', 'Man mikham vaghtam ro taghir bedam.', 'reject', 'fa-finglish-under-de'],
  ['de', 'وقت شما برای جمعه ساعت ۱۴ تایید شد.', 'reject', 'fa-under-de'],
  ['de', 'تم تأكيد موعدك يوم الجمعة الساعة 2.', 'reject', 'ar-under-de'],
  // Swedish target.
  ['sv', 'Du kan ändra din bokning online.', 'accept', 'sv'],
  ['sv', 'Om du vill kan du boka en konsultation.', 'accept', 'sv'],
  ['sv', 'Är du sen ringer du oss.', 'accept', 'sv'],
  ['sv', 'Konsultation tar 30 minuter.', 'accept', 'sv-shared-lexeme'],
  ['sv', 'Konsultationen tar 30 minuter.', 'accept', 'sv'],
  ['sv', 'Vi behöver några uppgifter.', 'accept', 'sv'],
  ['sv', 'Ändra din tid senast 24 timmar innan.', 'accept', 'sv-unicode'],
  ['sv', 'Man kan parkera gratis utanför studion.', 'accept', 'sv-man'],
  ['sv', 'Studion ligger på Storgatan 12.', 'accept', 'sv-address'],
  ['sv', 'Din tid är bekräftad på fredag klockan 14:00.', 'accept', 'sv-booking'],
  ['sv', 'Det kostar 500 kr och tar en timme.', 'accept', 'sv-numbers'],
  ['sv', 'Vi har öppet måndag till fredag 9 till 17.', 'accept', 'sv-numbers'],
  ['sv', 'Du är välkommen tio minuter innan.', 'accept', 'sv'],
  ['sv', 'Senast du bokade var i mars.', 'accept', 'sv-st-adverb'],
  ['sv', 'Wenn du möchtest, kannst du die Buchung ändern.', 'reject', 'de-under-sv'],
  ['sv', 'Ich möchte einen Termin.', 'reject', 'de-under-sv'],
  ['sv', 'Sie können Ihre Buchung jederzeit online ändern.', 'reject', 'de-under-sv'],
  ['sv', 'Die Konsultation dauert 30 Minuten.', 'reject', 'de-under-sv-shared-lexeme'],
  ['sv', 'Your appointment is confirmed for Friday at 2 pm.', 'reject', 'en-under-sv'],
  // English, Spanish, Persian, Arabic targets.
  ['en', 'Your appointment is confirmed for Friday at 2 pm.', 'accept', 'en'],
  ['en', 'The consultation takes 30 minutes.', 'accept', 'en'],
  ['en', 'You can find us at Storgatan 12.', 'accept', 'en-address'],
  ['en', 'Man, the parking is free.', 'accept', 'en-man'],
  ['en', 'Du kan boka online.', 'reject', 'sv-under-en'],
  ['en', 'Det finns lediga tider på fredag.', 'reject', 'sv-under-en'],
  ['en', 'Konsultation kostar 300 kr.', 'reject', 'sv-under-en-shared-lexeme'],
  ['en', 'Wenn du möchtest, kannst du die Buchung ändern.', 'reject', 'de-under-en'],
  ['en', 'Ich möchte einen Termin.', 'reject', 'de-under-en'],
  ['es', 'La consulta dura 30 minutos.', 'accept', 'es'],
  ['es', 'Su cita está confirmada para el viernes a las 14:00.', 'accept', 'es'],
  ['es', '¿Qué día prefiere para la cita?', 'accept', 'es-unicode'],
  ['es', 'Qué bien, la consulta es gratis.', 'accept', 'es-unicode'],
  ['es', 'El estudio está en Storgatan 12.', 'accept', 'es-address'],
  ['es', 'Du kannst die Konsultation verschieben.', 'reject', 'de-under-es'],
  ['es', 'Du kan boka online.', 'reject', 'sv-under-es'],
  ['fa', 'وقت شما برای جمعه ساعت ۱۴ تایید شد.', 'accept', 'fa'],
  ['fa', 'Man mikham vaghtam ro taghir bedam.', 'accept', 'fa-finglish'],
  ['fa', 'Du kan boka en konsultation hos oss.', 'reject', 'sv-under-fa'],
  ['fa', 'Wenn du möchtest, kannst du die Buchung ändern.', 'reject', 'de-under-fa'],
  ['ar', 'تم تأكيد موعدك يوم الجمعة الساعة 2.', 'accept', 'ar'],
  ['ar', 'الاستشارة تستغرق 30 دقيقة.', 'accept', 'ar'],
  ['ar', 'Du kan boka online.', 'reject', 'sv-under-ar'],
];

/** Pre-existing Swedish/mixed under-detection, unchanged by this repair (HEAD 1db0a6c behaves the same). */
export const KNOWN_OUTGOING_GAPS: ReadonlyArray<readonly [Target, string, 'reject', string]> = [
  ['de', 'Konsultationen tar 30 minuter.', 'reject', 'sv-under-de: no Swedish marker beyond tar/minuter'],
  ['de', 'Vi behöver några uppgifter.', 'reject', 'sv-under-de: "några" alone scores below threshold'],
  ['de', 'Det är möjligt, aber nur nach Absprache.', 'reject', 'mixed Swedish/German sentence'],
];

/** Incoming customer messages: [text, expected strong deterministic language, category]. */
export const INCOMING_MESSAGES: ReadonlyArray<readonly [string, Target | null, string]> = [
  ['Kannst du mir sagen, ob du morgen offen hast?', 'de', 'de-informal'],
  ['Hast du am Freitag noch einen Termin frei?', 'de', 'de-informal'],
  ['Wenn du Zeit hast, möchte ich am Montag kommen.', 'de', 'de-informal'],
  ['Kannst du mir die Konsultation erklären?', 'de', 'de-informal-shared-lexeme'],
  ['Ich möchte einen Termin am Freitag.', 'de', 'de-formal'],
  ['Haben Sie morgen freie Zeiten?', 'de', 'de-formal'],
  ['Wie lange dauert die Konsultation?', 'de', 'de-shared-lexeme'],
  ['Was kostet eine Konsultation?', 'de', 'de-shared-lexeme'],
  ['Kan du boka mig på fredag?', 'sv', 'sv'],
  ['Har du lediga tider imorgon?', 'sv', 'sv'],
  ['Är du öppen på lördag?', 'sv', 'sv-unicode'],
  ['Vad kostar en konsultation?', 'sv', 'sv-shared-lexeme'],
  ['Hur lång tid tar konsultationen?', 'sv', 'sv'],
  ['Jag vill boka en tid', 'sv', 'sv'],
  ['Do you have any time on Friday?', 'en', 'en'],
  ['I want to book a consultation', 'en', 'en'],
  ['¿Qué horas tienen disponibles el viernes?', 'es', 'es-unicode'],
  ['Quiero una cita para el lunes', 'es', 'es'],
  ['Salam, mikham vaght begiram baraye farda', 'fa', 'fa-finglish'],
  ['سلام، می‌خواهم برای فردا وقت بگیرم', 'fa', 'fa'],
  ['مرحبا، أريد حجز موعد يوم الخميس', 'ar', 'ar'],
];

/** Deterministic implicit switch decision: [previous language, message, expected switch target or null]. */
export const LANGUAGE_SWITCHES: ReadonlyArray<readonly [Target, string, Target | null]> = [
  ['de', 'Kannst du mir sagen, ob du morgen offen hast?', null],
  ['de', 'Hast du am Freitag noch einen Termin frei?', null],
  ['de', 'Wie lange dauert die Konsultation?', null],
  ['de', 'Kan du boka mig på fredag?', 'sv'],
  ['sv', 'Kannst du mir sagen, ob du morgen offen hast?', 'de'],
  ['sv', 'Hur lång tid tar konsultationen?', null],
  ['en', 'Jag vill boka en tid på fredag', 'sv'],
  ['sv', 'I want to book a consultation on Friday', 'en'],
];

export const LANGUAGE_CASE_BUSINESS_CONFIG = Object.freeze({ businessId: 3, services: [{ name: 'Hejsan Massage' }] });
