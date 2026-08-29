import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;

const { normalizeBookingRequest, parseBookingDate, parseTimeConstraint } = await import('./booking-intelligence');
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const timezone = 'Europe/Stockholm';
const now = new Date('2026-08-28T12:00:00Z');
const parse = (text: string) => parseBookingDate(text, timezone, now)?.value;

const spanishMonths = [
  ['enero', '01'], ['febrero', '02'], ['marzo', '03'], ['abril', '04'],
  ['mayo', '05'], ['junio', '06'], ['julio', '07'], ['agosto', '08'],
  ['septiembre', '09'], ['octubre', '10'], ['noviembre', '11'], ['diciembre', '12'],
] as const;
const arabicMonths = [
  ['يناير', '01'], ['فبراير', '02'], ['مارس', '03'], ['أبريل', '04'],
  ['مايو', '05'], ['يونيو', '06'], ['يوليو', '07'], ['أغسطس', '08'],
  ['سبتمبر', '09'], ['أكتوبر', '10'], ['نوفمبر', '11'], ['ديسمبر', '12'],
] as const;

try {
  assert.equal(parse('August 31st 2026'), '2026-08-31');
  assert.equal(parse('August 31 2026'), '2026-08-31');
  assert.equal(parse('31 August 2026'), '2026-08-31');
  assert.equal(boundary.resolveExplicitBookingDate('August 31st 2026'), '2026-08-31');

  assert.equal(parse('1:a september 2026'), '2026-09-01');
  assert.equal(parse('2:a september 2026'), '2026-09-02');
  assert.equal(parse('7:e september 2026'), '2026-09-07');
  assert.equal(boundary.resolveExplicitBookingDate('1:a september 2026'), '2026-09-01');

  for (const [month, number] of spanishMonths) {
    const expected = `2027-${number}-15`;
    const text = `El 15 de ${month} de 2027`;
    assert.equal(parse(text), expected, `canonical Spanish month: ${month}`);
    assert.equal(boundary.resolveExplicitBookingDate(text), expected, `server Spanish month: ${month}`);
  }
  assert.equal(parse('mañana'), '2026-08-29');
  assert.equal(parse('pasado mañana'), '2026-08-30');
  assert.equal(parse('el próximo lunes'), '2026-09-07');

  assert.equal(parse('morgen'), '2026-08-29');
  assert.equal(parse('übermorgen'), '2026-08-30');
  assert.equal(parse('nächsten Montag'), '2026-09-07');
  assert.equal(parse('Am 31. August 2026.'), '2026-08-31');

  for (const [month, number] of arabicMonths) {
    const expected = `2027-${number}-15`;
    const text = `١٥ ${month} ٢٠٢٧`;
    assert.equal(parse(text), expected, `canonical Arabic month: ${month}`);
    assert.equal(boundary.resolveExplicitBookingDate(text), expected, `server Arabic month: ${month}`);
  }
  assert.equal(parse('غدًا'), '2026-08-29');
  assert.equal(parse('بعد غد'), '2026-08-30');
  assert.equal(parse('الاثنين القادم'), '2026-09-07');

  const german = normalizeBookingRequest({
    businessId: 'date-test', channel: 'test', conversationKey: 'de-date', inputMode: 'text',
    text: 'morgen um 16 Uhr', activeLanguage: 'de', timezone, now,
  });
  assert.equal(german.date?.value, '2026-08-29');
  assert.equal(german.timeConstraint?.kind, 'exact');
  assert.equal(german.timeConstraint?.startMinutes, 16 * 60);

  const spanish = normalizeBookingRequest({
    businessId: 'date-test', channel: 'test', conversationKey: 'es-date', inputMode: 'text',
    text: 'mañana a las 16:00', activeLanguage: 'es', timezone, now,
  });
  assert.equal(spanish.date?.value, '2026-08-29');
  assert.equal(spanish.timeConstraint?.kind, 'exact');
  assert.equal(spanish.timeConstraint?.startMinutes, 16 * 60);

  assert.equal(parseTimeConstraint('am Morgen')?.kind, undefined);
  assert.equal(parseTimeConstraint('por la mañana')?.kind, undefined);

  originalLog('multilingual date normalization regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
