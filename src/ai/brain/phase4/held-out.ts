/** Independent interpretation targets for new fictional turns. No factual answer keys. */
export const HELD_OUT = [
  { language: 'sv', turns: [
    { text: 'Måste jag komma en kvart i förväg om jag redan har fyllt i blanketten, och vad rekommenderar ni att jag tar med?', expected: [
      { anchor: 'Måste jag komma en kvart i förväg om jag redan har fyllt i blanketten', intent: 'general_question', questionType: 'requirement', condition: 'om jag redan har fyllt i blanketten' },
      { anchor: 'vad rekommenderar ni att jag tar med', intent: 'general_question', questionType: 'recommendation' }] },
    { text: 'Är det första fortfarande ett krav?', expected: [{ anchor: 'Är det första fortfarande ett krav', intent: 'general_question', questionType: 'requirement', reference: 0 }] },
  ] },
  { language: 'en', turns: [
    { text: 'Please book a haircut with Alex next Tuesday at 14:20.', expected: [{ anchor: 'Please book a haircut with Alex next Tuesday at 14:20', intent: 'new_booking' }] },
    { text: 'Actually, make it Thursday.', expected: [{ anchor: 'Actually, make it Thursday', intent: 'correction', reference: 0 }] },
  ] },
  { language: 'de', turns: [
    { text: 'Ich dachte, der Parkplatz ist nicht kostenlos. Stimmt das, und können Sie meinen Termin absagen?', expected: [
      { anchor: 'Ich dachte, der Parkplatz ist nicht kostenlos. Stimmt das', intent: 'general_question', questionType: 'description', premise: 'der Parkplatz ist nicht kostenlos', negative: true },
      { anchor: 'können Sie meinen Termin absagen', intent: 'cancellation' }] },
  ] },
  { language: 'es', turns: [
    { text: '¿Cuánto cuesta el corte de pelo?', expected: [{ anchor: 'Cuánto cuesta el corte de pelo', intent: 'general_question', questionType: 'description' }] },
    { text: 'Reserva un corte mañana a las tres, por favor.', expected: [{ anchor: 'Reserva un corte mañana a las tres, por favor', intent: 'new_booking', missing: 'time' }] },
    { text: 'Volviendo al precio, ¿incluye el lavado?', expected: [{ anchor: 'Volviendo al precio, ¿incluye el lavado', intent: 'general_question', questionType: 'description', reference: 0 }] },
  ] },
  { language: 'fa', turns: [
    { text: 'اگر شماره پیگیری را ندارم، آیا آوردن رسید لازم است؟', expected: [
      { anchor: 'اگر شماره پیگیری را ندارم، آیا آوردن رسید لازم است', intent: 'general_question', questionType: 'requirement', condition: 'اگر شماره پیگیری را ندارم' }] },
    { text: 'Friday or Saturday, please answer in English.', switchTo: 'en', expected: [
      { anchor: 'Friday or Saturday', intent: 'unknown', missing: 'conflict' }] },
  ] },
  { language: 'ar', turns: [
    { text: 'لا تلغ موعدي. هل تنصحون بإحضار إيصال الدفع؟', expected: [
      { anchor: 'لا تلغ موعدي', intent: 'cancellation', negative: true },
      { anchor: 'هل تنصحون بإحضار إيصال الدفع', intent: 'general_question', questionType: 'recommendation' }] },
    { text: 'وهل يجب إحضاره إذا دفع شخص آخر؟', expected: [
      { anchor: 'وهل يجب إحضاره إذا دفع شخص آخر', intent: 'general_question', questionType: 'requirement', reference: 0, condition: 'إذا دفع شخص آخر' }] },
  ] },
] as const;
