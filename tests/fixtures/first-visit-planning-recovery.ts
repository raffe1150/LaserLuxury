// Production-safe source wording; all answer/model fixtures below are synthetic.
export const firstVisitSource = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
export const firstVisitQuestion = "How many minutes before my appointment should I arrive if it's my first visit?";
export const firstVisitCases = [
  ['en', firstVisitQuestion, 'First-time visitors are recommended to arrive approximately 10 minutes before their booked appointment.'],
  ['en', firstVisitQuestion.replace("it's", 'it is'), 'First-time visitors are recommended to arrive approximately 10 minutes before their booked appointment.'],
  ['en', 'How early should I arrive? I am a first-time visitor.', 'First-time visitors are recommended to arrive approximately 10 minutes before their booked appointment.'],
  ['sv', 'Hur många minuter före min bokning bör jag komma om det är mitt första besök?', 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid.'],
  ['de', 'Wie viele Minuten vor meinem Termin sollte ich kommen, wenn ich zum ersten Mal zu Besuch bin?', 'Erstbesuchern wird empfohlen, ungefähr 10 Minuten vor ihrem gebuchten Termin zu kommen.'],
  ['es', '¿Cuántos minutos antes de mi cita debería llegar si es mi primera visita?', 'Se recomienda a quienes visitan por primera vez llegar aproximadamente 10 minutos antes de la hora reservada para su cita.'],
  ['fa', 'چند دقیقه قبل از نوبتم باید برسم اگر اولین مراجعه من است؟', 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.'],
  ['ar', 'كم دقيقة قبل موعدي يُنصح أن أصل إذا كانت هذه زيارتي الأولى؟', 'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم المحجوز بحوالي 10 دقائق.'],
] as const;
