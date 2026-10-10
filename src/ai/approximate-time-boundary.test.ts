import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { enumerateCandidateMinutes, isCanonicalSlotFree, type SlotMinuteConstraint } from './canonical-availability';
import { parseTimeConstraint, zonedLocalIso, type NormalizedTimeConstraint } from './booking-intelligence';
import { parseNormalizedTimeRange } from './channel-reliability';

// Execute the actual private parser and legacy caller, without server startup.
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const names = ['normalizeLocalizedDigits', 'normalizeRequestedTime', 'inferRequestedTimeFromText',
  'parseRescheduleTimeFollowUp', 'timeTextToMinutes', 'isSlotFree', 'getDailySlots'];
const bodies = names.map(name => {
  const matches = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(matches.length, 1, `actual server function: ${name}`);
  return matches[0].getText(parsed);
}).join('\n');
const executable = ts.transpileModule(bodies, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
type BoundaryKind = 'approximate' | NonNullable<SlotMinuteConstraint['boundaryKind']>;
interface Options {
  timeBoundary?: { kind: BoundaryKind; time: string };
  afterTime?: string;
  minTime?: string;
  maxTime?: string;
  excludedTimes?: string[];
}
interface FollowUp {
  explicitTime: string | null;
  boundary: Options['timeBoundary'] | null;
}
interface PrivateFunctions {
  parseRescheduleTimeFollowUp(text: string): FollowUp;
  getDailySlots(start: string, end: string, events: object[], duration: number, requested?: string, options?: Options): string;
}
function privateFunctions() {
  const calls: SlotMinuteConstraint[] = [];
  const context = vm.createContext({
    parseTimeConstraint, parseNormalizedTimeRange, zonedLocalIso, isCanonicalSlotFree,
    Date: class extends Date { static now() { return Date.parse('2026-10-08T08:00:00Z'); } },
    BOOKING_OPEN_MINUTES: 540, BOOKING_CLOSE_MINUTES: 1200, BOOKING_INTERVAL_MINUTES: 15,
    enumerateCandidateMinutes: (open: number, close: number, duration: number, step: number, constraint: SlotMinuteConstraint) => {
      calls.push(constraint);
      return enumerateCandidateMinutes(open, close, duration, step, constraint);
    },
  });
  vm.runInContext(executable, context);
  const functions: PrivateFunctions = vm.runInContext('({parseRescheduleTimeFollowUp, getDailySlots})', context);
  return { functions, calls };
}
const date = '2026-11-02'; // Monday, future relative to this review.
const candidates = [750, 780, 810, 840];
const excludedTimes = enumerateCandidateMinutes(540, 1200, 30, 15)
  .filter(m => !candidates.includes(m)).map(m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
const clocks = (value: string) => [...value.matchAll(/kl (\d{2}:\d{2})/g)].map(match => match[1]);
const busy = [{ start: { dateTime: `${date}T13:00:00+01:00` }, end: { dateTime: `${date}T13:30:00+01:00` } }];

test('legacy caller passes only true comparators; approximate stays a separate requested-time preference', () => {
  const { functions, calls } = privateFunctions();
  const result = functions.getDailySlots(date, date, busy, 30, '13:00', {
    excludedTimes, timeBoundary: { kind: 'approximate', time: '13:00' },
  });
  assert.deepEqual(clocks(result), ['12:30', '13:30', '14:00']);
  assert.equal(calls[0].boundaryKind, undefined);
  assert.equal(calls[0].boundaryMinutes, 780);
});

for (const [kind, expected] of [
  ['exclusive_lower', ['14:00', '13:30']], ['inclusive_lower', ['14:00', '13:30', '13:00']],
  ['exclusive_upper', ['12:30']], ['inclusive_upper', ['13:00', '12:30']],
] as const) {
  test(`legacy ${kind} preserves comparator meaning`, () => {
    const { functions, calls } = privateFunctions();
    assert.deepEqual(clocks(functions.getDailySlots(date, date, [], 30, undefined, {
      excludedTimes, timeBoundary: { kind, time: '13:00' },
    })), [...expected]);
    assert.equal(calls[0].boundaryKind, kind);
  });
}

test('legacy exact preference, inclusive window, and afterTime precedence remain unchanged', () => {
  const { functions, calls } = privateFunctions();
  assert.deepEqual(clocks(functions.getDailySlots(date, date, [], 30, '13:00', { excludedTimes })), ['13:00']);
  assert.deepEqual(clocks(functions.getDailySlots(date, date, busy, 30, '13:00', {
    excludedTimes, minTime: '13:00', maxTime: '14:00', timeBoundary: { kind: 'approximate', time: '13:00' },
  })), ['13:30', '14:00']);
  assert.deepEqual(clocks(functions.getDailySlots(date, date, [], 30, '13:00', {
    excludedTimes, afterTime: '13:00', timeBoundary: { kind: 'approximate', time: '13:00' },
  })), ['13:30', '14:00']);
  assert.equal(calls.at(-1)?.boundaryKind, 'exclusive_lower');
});

// All six languages use the existing follow-up parser. These variants already
// produce approximate boundaries; no parser vocabulary is added by this repair.
const phrases = [
  ['en', 'around 13:00'], ['sv', 'cirka 13'], ['de', 'gegen 13'],
  ['es', 'aproximadamente 13'], ['fa', 'حدود ساعت ۱۳'], ['ar', 'حوالي الساعة ١٣'],
] as const;
for (const [language, phrase] of phrases) {
  test(`${language}: existing approximate boundary keeps candidates on both sides`, () => {
    const { functions } = privateFunctions();
    const follow = functions.parseRescheduleTimeFollowUp(phrase);
    assert.equal(follow.boundary?.kind, 'approximate');
    assert.equal(follow.explicitTime, '13:00');
    assert.deepEqual(clocks(functions.getDailySlots(date, date, busy, 30, follow.explicitTime || undefined, {
      excludedTimes, timeBoundary: follow.boundary || undefined,
    })), ['12:30', '13:30', '14:00']);
  });
}

test('existing combined phrase parsing preserves the hard comparator/window separately from a clock preference', () => {
  const { functions } = privateFunctions();
  for (const [text, kind, time] of [
    ['around 13:00 after 12:00', 'exclusive_lower', '12:00'],
    ['around 13:00 before 15:00', 'exclusive_upper', '15:00'],
    ['at 13:00 after 12:00', 'exclusive_lower', '12:00'],
  ] as const) {
    const follow = functions.parseRescheduleTimeFollowUp(text);
    assert.equal(follow.boundary?.kind, kind);
    assert.equal(follow.boundary?.time, time);
    assert.equal(follow.explicitTime, '13:00');
  }
  assert.equal(parseTimeConstraint('between 12:00 and 15:00 around 13:00')?.kind, 'between');
  assert.equal(functions.parseRescheduleTimeFollowUp('around 13:00 on Monday').boundary?.kind, 'approximate');
});

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const businessConfig = {
  id: 'synthetic-approximate-business', businessRecordId: 'synthetic-approximate-business',
  business_id: 'synthetic-approximate-business', businessName: 'Synthetic boundary review',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', systemPrompt: 'Keep 0 minutes between appointments.',
  workingHours: { monday: candidates.map(m => ({
    start: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`,
    end: `${Math.floor((m + 30) / 60)}:${String((m + 30) % 60).padStart(2, '0')}`,
  })) },
  services: [{ id: 'synthetic-service', name: 'Consultation', durationMinutes: 30, active: true }],
};
for (const platform of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) {
  test(`${platform}: canonical preference/filter separation, full scan, one calendar read, no mutation`, async () => {
    let reads = 0;
    let calendarEvents: object[] = [];
    boundary.reset();
    boundary.configure({ calendarAdapter: {
      getEvents: async () => { reads++; return calendarEvents; },
      checkSlots: () => { throw new Error('no second slot scan'); },
      insertAppointment: () => { throw new Error('offers must not mutate'); },
    } });
    const request = {
      businessConfig, platform, userId: `synthetic-${platform}`, sessionId: `synthetic-${platform}`,
      startDate: date, endDate: date, durationMinutes: 30, requestedTime: '13:00',
      now: new Date('2026-10-08T08:00:00Z'),
    };
    const offers = async (options: Options, normalizedConstraint?: NormalizedTimeConstraint) => {
      const before = reads;
      const result = await boundary.canonicalOffers({ ...request, options, normalizedConstraint });
      assert.equal(reads - before, 1);
      assert.ok(result.ownedSlots.every(slot => slot.businessId === businessConfig.id && slot.platform === platform));
      return result.ownedSlots.map(slot => slot.start.slice(11, 16));
    };
    try {
      assert.deepEqual(await offers({ timeBoundary: { kind: 'approximate', time: '13:00' } }), ['13:00', '12:30', '13:30']);
      const { functions } = privateFunctions();
      for (const [, phrase] of phrases) {
        const follow = functions.parseRescheduleTimeFollowUp(phrase);
        assert.deepEqual(await offers({ timeBoundary: follow.boundary || undefined }), ['13:00', '12:30', '13:30']);
      }
      for (const phrase of ['around 13:00 after 12:00', 'around 13:00 before 15:00']) {
        const follow = functions.parseRescheduleTimeFollowUp(phrase);
        assert.deepEqual(await offers({ timeBoundary: follow.boundary || undefined }), ['13:00', '12:30', '13:30']);
      }
      assert.deepEqual(await offers({}, { kind: 'exact', startMinutes: 780, confidence: 'high' }), ['13:00']);
      assert.deepEqual(await offers({ timeBoundary: { kind: 'exclusive_lower', time: '13:00' } }), ['13:30', '14:00']);
      assert.deepEqual(await offers({ timeBoundary: { kind: 'exclusive_upper', time: '13:00' } }), ['12:30']);
      assert.deepEqual(await offers({ timeBoundary: { kind: 'inclusive_lower', time: '13:00' } }), ['13:00', '13:30', '14:00']);
      assert.deepEqual(await offers({ timeBoundary: { kind: 'inclusive_upper', time: '13:00' } }), ['13:00', '12:30']);
      assert.deepEqual(await offers({ minTime: '13:30', maxTime: '14:00', timeBoundary: { kind: 'approximate', time: '13:00' } }), ['13:30', '14:00']);
      // A later valid slot must survive filtering before top-three ranking.
      assert.deepEqual(await offers({ timeBoundary: { kind: 'exclusive_lower', time: '13:30' } }), ['14:00']);
      assert.deepEqual(await offers({ timeBoundary: { kind: 'exclusive_lower', time: '13:00' } }, { kind: 'exact', startMinutes: 780, confidence: 'high' }), []);
      calendarEvents = busy;
      assert.deepEqual(await offers({ timeBoundary: { kind: 'approximate', time: '13:00' } }), ['12:30', '13:30', '14:00']);
      assert.deepEqual(await offers({}, { kind: 'exact', startMinutes: 780, confidence: 'high' }), []);
    } finally { boundary.reset(); }
  });
}
