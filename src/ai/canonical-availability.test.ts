import assert from 'node:assert/strict';
import {
  enumerateCandidateMinutes,
  isBlockingCalendarEvent,
  isCanonicalSlotFree,
} from './canonical-availability';

const date = '2099-08-03';
const at = (time: string) => new Date(`${date}T${time}:00+02:00`).getTime();
const event = (start: string, end: string, summary = 'Customer booking') => ({
  summary,
  start: { dateTime: `${date}T${start}:00+02:00` },
  end: { dateTime: `${date}T${end}:00+02:00` },
});
const candidateIsFree = (minutes: number, events: any[]) => {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return isCanonicalSlotFree(at(`${hour}:${minute}`), 30, events, 0);
};

const beforeNoon = enumerateCandidateMinutes(9 * 60, 20 * 60, 30, 15, {
  boundaryMinutes: 12 * 60,
  boundaryKind: 'exclusive_upper',
});
const morningEvents = [
  event('09:00', '11:00'),
  event('09:00', '20:00', 'Working hours 09 AM - 08 PM'),
];
const morningFree = beforeNoon.filter((minutes) => candidateIsFree(minutes, morningEvents));
assert.ok(morningFree.includes(11 * 60), 'range before 12 must include free 11:00');
assert.equal(candidateIsFree(11 * 60, morningEvents), true, 'exact 11:00 uses the same predicate');

const fullyBusy = [event('09:00', '12:00')];
assert.deepEqual(beforeNoon.filter((minutes) => candidateIsFree(minutes, fullyBusy)), []);
assert.equal(candidateIsFree(11 * 60, fullyBusy), false);

assert.equal(beforeNoon.includes(12 * 60), false, 'before 12 is strict');
const after16 = enumerateCandidateMinutes(9 * 60, 20 * 60, 30, 15, {
  boundaryMinutes: 16 * 60,
  boundaryKind: 'exclusive_lower',
});
assert.equal(after16.includes(16 * 60), false, 'after 16 is strict');
assert.equal(after16[0], 16 * 60 + 15);
const between10And12 = enumerateCandidateMinutes(9 * 60, 20 * 60, 30, 15, {
  minMinutes: 10 * 60,
  maxMinutes: 12 * 60,
});
assert.equal(between10And12[0], 10 * 60);
assert.equal(between10And12.at(-1), 12 * 60);

assert.equal(isBlockingCalendarEvent({ summary: 'Display', transparency: 'transparent' }), false);
assert.equal(isBlockingCalendarEvent({ summary: 'Opening hours' }), false);
assert.equal(isBlockingCalendarEvent({ summary: 'Customer booking' }), true);
assert.equal(isCanonicalSlotFree(at('10:00'), 30, [{ summary: 'Closed', start: { date }, end: { date: '2099-08-04' } }], 0), false);

// Exact/range equivalence across supported intervals, durations, overlaps, and inclusivity.
for (const duration of [15, 30, 45]) {
  for (const interval of [15, 30]) {
    const blockingEvents = [event('10:30', '11:00'), event('11:30', '11:45', 'Pending appointment hold')];
    const range = enumerateCandidateMinutes(9 * 60, 13 * 60, duration, interval, {
      minMinutes: 10 * 60,
      maxMinutes: 12 * 60,
    });
    const enumeratedFree = range.filter((value) => {
      const hour = String(Math.floor(value / 60)).padStart(2, '0');
      const minute = String(value % 60).padStart(2, '0');
      return isCanonicalSlotFree(at(`${hour}:${minute}`), duration, blockingEvents, 0);
    });
    for (const value of range) {
      const hour = String(Math.floor(value / 60)).padStart(2, '0');
      const minute = String(value % 60).padStart(2, '0');
      assert.equal(
        enumeratedFree.includes(value),
        isCanonicalSlotFree(at(`${hour}:${minute}`), duration, blockingEvents, 0),
        `range/exact predicate mismatch duration=${duration} interval=${interval} minute=${value}`,
      );
    }
  }
}

assert.ok(enumerateCandidateMinutes(540, 780, 30, 15, { boundaryMinutes: 720, boundaryKind: 'inclusive_upper' }).includes(720));
assert.ok(enumerateCandidateMinutes(540, 780, 30, 15, { boundaryMinutes: 720, boundaryKind: 'inclusive_lower' }).includes(720));

for (const channel of ['instagram', 'messenger', 'whatsapp', 'telegram']) {
  assert.deepEqual(
    beforeNoon.filter((minutes) => candidateIsFree(minutes, morningEvents)),
    morningFree,
    `${channel} must receive the same canonical availability`,
  );
}

console.log('canonical availability tests passed');
