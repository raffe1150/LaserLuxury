/** Documentary access directions, distinct from structured business contact details. */
export function hasDocumentaryVisitAccess(text: string): boolean {
  if (/\b(?:address|adresse|adress|direcci[oó]n|phone|email|e-mail|website|telephone|telefon|webbplats|kontaktuppgifter|teléfono|correo|webseite)\b|آدرس|تلفن|ایمیل|وب.?سایت|عنوان|هاتف|بريد|موقع\s+إلكتروني/iu.test(text)) return false;
  return /(?<![\p{L}\p{M}])(?:entrance\p{L}*|entry|elevator\p{L}*|lift|accessib\p{L}*|ingång\p{L}*|entré\p{L}*|kundentré\p{L}*|hiss\p{L}*|tillgänglig\p{L}*|eingang\p{L}*|kundeneingang\p{L}*|aufzug\p{L}*|fahrstuhl\p{L}*|barrierefrei\p{L}*|entrada\p{L}*|ascensor\p{L}*|accesib\p{L}*)(?![\p{L}\p{M}])|ورودی|آسانسور|دسترس.?پذیر|مدخل|مصعد|إمكانية\s+الوصول/iu.test(text);
}

/** Classify the policy workflow, never a policy fact or permission to act. */
export function isArrivalInformationQuestion(text: string): boolean {
  const late = /\b(?:late|lateness|tardy|delays?|delayed|försen\p{L}*|sen|sent|verspät\p{L}*|spät|tarde|retras\p{L}*)\b|دیر|تاخیر|تأخیر|تأخر|تأخير/iu.test(text);
  const arrival = /\b(?:arriv\p{L}*|come|coming|visit|kom\p{L}*|besök\p{L}*|anländ\p{L}*|ankomm\p{L}*|besuch\p{L}*|lleg\p{L}*|visita\p{L}*|cita)\b|برس|مراجعه|رسید|زيار|الوصول|أصل|موعد/iu.test(text);
  const feeOrNotice = /\b(?:fees?|free|notice|deadline|avgift\p{L}*|gratis|varsel|frist|gebühr\p{L}*|kostenlos|cargo\p{L}*|tarifa\p{L}*|aviso|antelación|plazo)\b|هزینه|رایگان|مهلت|رسوم|غرامة|إشعار|اشعار|مهلة/iu.test(text);
  // Relative arrival wording need not contain a literal "late" word. Match a
  // duration AFTER an appointment, never an actual date/time to operate on.
  const appointment = /\b(?:appointments?|bookings?|scheduled\s+time|bokning\p{L}*|bokade\s+tid|termin\p{L}*|buchung\p{L}*|citas?|reservas?)\b|نوبت|وقت|رزرو|موعد|حجز/iu;
  const relative = /\b(?:minutes?|hours?|minuter|halvtimme|timme|timmar|minuten|stunden?)\b[^.!?؟\n]{0,25}\b(?:after|efter|nach)\b[^.!?؟\n]{0,45}(?:appointment\p{L}*|booking\p{L}*|scheduled\s+time|bokning\p{L}*|bokade\s+tid|termin\p{L}*|buchung\p{L}*)\b|\b(?:minutos?|horas?)\b[^.!?؟\n]{0,25}después\s+de[^.!?؟\n]{0,35}\b(?:cita|reserva)\b|(?:دقیقه|ساعت)[^.!?؟\n]{0,20}بعد\s+از[^.!?؟\n]{0,25}(?:نوبت|وقت|رزرو)|(?:دقيقة|دقائق|ساعة|ساعات)[^.!?؟\n]{0,20}بعد[^.!?؟\n]{0,25}(?:موعد|حجز)/iu.test(text);
  const consequence = /\b(?:automatic\p{L}*|automatisk\p{L}*|automatisch\p{L}*|automátic\p{L}*|staff|personalen|personal|employees|mitarbeiter\p{L}*|what\s+happens|vad\s+händer|was\s+(?:passiert|geschieht)|qué\s+(?:pasa|ocurre))\b|خودکار|کارکنان|چه\s+می|تلقائ|الموظف|ماذا\s+يحدث/iu.test(text);
  const recordLookup = /\b(?:check|look\s+up|status|already|bereits|prüf\p{L}*|kontrollera|redan|verifica\p{L}*|ya\s+(?:está|se))\b|استعلام|قبلاً|بالفعل|تحقق/iu.test(text);
  return !feeOrNotice && (late && arrival || !recordLookup && appointment.test(text) && consequence && (late || relative));
}

/** Bounded visit-policy context, not a question/action classifier or authority
 * for any business fact. Callers still require a question and reject actions. */
export function hasVisitInformationContext(text:string):boolean {
  return isArrivalInformationQuestion(text) ||
    /\b(?:first[ -](?:visit|time)|första\s+(?:besök\p{L}*|gången)|ersten?\s+(?:Besuch|Mal)|primera\s+(?:visita|vez))\b|اولین\s+(?:مراجعه|بار)|بار اول|للمرة\s+الأولى|زيار\p{L}*\s+الأولى/iu.test(text) ||
    /\b(?:lost\s+(?:propert\p{L}*|items?|valuables?)|(?:leave|forget|forgot|left).{0,45}(?:items?|valuabl\p{L}*)|kvarglömd\p{L}*|glömmer.{0,30}(?:något|värde\p{L}*)|(?:Wertgegenstand|Fundsach\p{L}*).{0,35}vergess\p{L}*|olvid\p{L}*.{0,35}(?:objeto|pertenencia))\b|وسیله.{0,35}جا بگذار|نسيت.{0,35}(?:غرض|شيء|متعلقات)|(?:غرض|أغراض|ممتلكات).{0,25}(?:منسي|مفقود)/iu.test(text);
}

/** A hypothetical arrival policy does not ask whether an existing booking
 * succeeded. Callers must still reject explicit actions and real status queries. */
export function isConditionalArrivalInformationQuestion(text:string):boolean {
  return isArrivalInformationQuestion(text)&&/[?؟]/u.test(text)&&
    // Only the hypothetical automatic consequence can override an attributive
    // booking-status match. A real confirmation/lookup retains its authority.
    /automatic\p{L}*|automatisk\p{L}*|automatisch\p{L}*|automátic\p{L}*|خودکار|تلقائ/iu.test(text)&&
    /^(?:(?:okay|ok|okej|well)[,،]?\s*(?:(?:and|och)\s+)?)?(?:if|om|wenn|falls|si)\b|^\s*(?:اگر|إذا|اذا)\s/iu.test(text);
}

/** A prior indefinite/possessive noun phrase can introduce a referent in the
 * same question. This grammar supplies no source facts and never resolves a
 * bare deictic such as "it there" from document contents. */
export function hasIntroducedReferent(text: string): boolean {
  const reference = /(?<![\p{L}\p{M}])(?:it|that|them|det|den|das|eso|آن)(?![\p{L}\p{M}])/iu.exec(text);
  if (!reference) return false;
  const prefix = text.slice(0, reference.index);
  // A new clause must follow the introduced subject before an anaphor can
  // reuse it; an indefinite object cannot resolve 'that place' in its clause.
  if (!/[.,;،؛?؟]|\b(?:and|och|und)\b|(?:^|\s)و(?:\s|$)/iu.test(prefix)) return false;
  if (/^\s+[\p{L}\p{M}]/u.test(text.slice(reference.index + reference[0].length)) && /^(?:that|das|eso)$/iu.test(reference[0])) return false;
  if (/\b(?:there|där|dort|all[ií])\b|آنجا/iu.test(prefix)) return false;
  if (/\b\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+/u.test(prefix)) return true;
  if (/^\s*اگر\s/u.test(prefix) && /[\p{Script=Arabic}]{2,}ی(?=\s)/u.test(prefix)) return true;
  return /(?<![\p{L}\p{M}])(?:something|anything|något|någonting|etwas|چیزی|یک)(?![\p{L}\p{M}])|\b(?:an?|my|our|your|en|ett|min|mitt|vår|vårt|einen?|mein\p{L}*)\s+[\p{L}\p{M}]+(?:\s+[\p{L}\p{M}]+)?/iu.test(prefix);
}

/** Classification-only projection for explicitly attached parking fees. Never
 * use this text for retrieval, extraction or verification: amounts, conditions
 * and the complete original question must remain available to those stages. */
export function withoutExplicitParkingFeeTerms(text:string):string {
 return text.replace(/\b(?:parking(?:[ -]space)?|car park)\s+fees?\b|\bfees?\s+(?:for|of)\s+(?:parking|the car park)\b|\bparkeringsavgift\p{L}*\b|\bavgift\p{L}*\s+för\s+parkering\p{L}*\b|\bparkgebühr\p{L}*\b|\bgebühr\p{L}*\s+für\s+(?:(?:das|den)\s+)?(?:parken|parkplatz|parkhaus)\b|\bcargos?\s+(?:de|por)\s+(?:aparcamiento|estacionamiento)\b|هزینه(?:ٔ|‌ی| ی|ی)?\s*پارکینگ|رسوم\s+(?:(?:ال)?موقف|(?:ال)?مواقف|ركن\s+السيارات|وقوف\s+السيارات)/giu,' ');
}
