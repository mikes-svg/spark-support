/**
 * Fixture tests for the recurrence engine.
 *
 * These are the real done-check for Phase 3. Nothing else in the app can catch a
 * date-maths bug: a recurrence that fires a day early looks completely normal in
 * the UI, in the digest, and in Firestore — it just quietly puts the wrong date
 * on somebody's work every week. Every assertion below is a literal expected
 * date, not a re-derivation, so a bug can't agree with itself.
 *
 * `recurrence.js` is CommonJS (the functions/ directory is Node, not the app's
 * ESM), hence the default import and destructure.
 */

import { describe, it, expect } from 'vitest';
import recurrence from '../recurrence.js';

const {
  addDays,
  diffDays,
  weekdayOf,
  isWeekend,
  shiftOffWeekend,
  nthWeekdayOfMonth,
  occurrencesFrom,
  nextOccurrenceAfter,
  occurrenceDocId,
  buildOccurrenceSubtasks,
  decideMissedAction,
  CARRY_LIMIT,
} = recurrence;

/** Series defaults, so each test states only what it is actually about. */
function series(overrides = {}) {
  return {
    recurrence: { freq: 'daily', interval: 1 },
    skipWeekends: false,
    weekendShift: 'next',
    endDate: null,
    occurrenceLimit: null,
    ...overrides,
  };
}

describe('date primitives', () => {
  it('never parses a date string through the local timezone', () => {
    // The whole reason this module does integer maths: new Date('2026-03-01')
    // is UTC midnight, which is Feb 28 in every US zone.
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
  });

  it('knows its weekdays', () => {
    expect(weekdayOf('2026-10-11')).toBe(0); // Sunday
    expect(weekdayOf('2026-10-15')).toBe(4); // Thursday
    expect(weekdayOf('2026-10-17')).toBe(6); // Saturday
    expect(isWeekend('2026-10-17')).toBe(true);
    expect(isWeekend('2026-10-16')).toBe(false);
  });

  it('shifts a weekend date both directions and leaves weekdays alone', () => {
    expect(shiftOffWeekend('2026-10-17', 'next')).toBe('2026-10-19'); // Sat → Mon
    expect(shiftOffWeekend('2026-10-18', 'next')).toBe('2026-10-19'); // Sun → Mon
    expect(shiftOffWeekend('2026-10-17', 'previous')).toBe('2026-10-16'); // Sat → Fri
    expect(shiftOffWeekend('2026-10-18', 'previous')).toBe('2026-10-16'); // Sun → Fri
    expect(shiftOffWeekend('2026-10-15', 'next')).toBe('2026-10-15');
  });

  it('finds the nth weekday of a month, and the last one', () => {
    expect(nthWeekdayOfMonth(2026, 10, 2, 3)).toBe('2026-10-20'); // 3rd Tuesday
    expect(nthWeekdayOfMonth(2026, 10, 5, 'last')).toBe('2026-10-30'); // last Friday
    // A 5th Thursday exists in Oct 2026 (29th) but not in Nov; fall back rather
    // than spilling into the next month.
    expect(nthWeekdayOfMonth(2026, 10, 4, 5)).toBe('2026-10-29');
    expect(nthWeekdayOfMonth(2026, 11, 4, 5)).toBe('2026-11-26');
  });
});

describe('each frequency', () => {
  it('daily', () => {
    expect(occurrencesFrom(series(), { from: '2026-10-12', count: 4 })).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
  });

  it('daily with an interval', () => {
    const cfg = series({ recurrence: { freq: 'daily', interval: 3 } });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 3 })).toEqual([
      '2026-10-12',
      '2026-10-15',
      '2026-10-18',
    ]);
  });

  it('weekly on several weekdays', () => {
    const cfg = series({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] } });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 5 })).toEqual([
      '2026-10-12', // Mon
      '2026-10-14', // Wed
      '2026-10-16', // Fri
      '2026-10-19', // Mon
      '2026-10-21', // Wed
    ]);
  });

  it('biweekly skips the intervening week', () => {
    const cfg = series({ recurrence: { freq: 'biweekly', interval: 1, byWeekday: [4] } });
    expect(occurrencesFrom(cfg, { from: '2026-10-15', count: 3 })).toEqual([
      '2026-10-15',
      '2026-10-29',
      '2026-11-12',
    ]);
  });

  it('monthly on a fixed day of the month', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 15 } });
    expect(occurrencesFrom(cfg, { from: '2026-10-15', count: 4 })).toEqual([
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
    ]);
  });

  it('monthly on the last day of the month', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 'last' } });
    expect(occurrencesFrom(cfg, { from: '2027-12-31', count: 4 })).toEqual([
      '2027-12-31',
      '2028-01-31',
      '2028-02-29', // 2028 is a leap year
      '2028-03-31',
    ]);
  });

  it('yearly', () => {
    const cfg = series({ recurrence: { freq: 'yearly', interval: 1 } });
    expect(occurrencesFrom(cfg, { from: '2026-07-04', count: 3 })).toEqual([
      '2026-07-04',
      '2027-07-04',
      '2028-07-04',
    ]);
  });

  it('custom: every N days, narrowed to weekdays', () => {
    const cfg = series({ recurrence: { freq: 'custom', interval: 2, byWeekday: [1, 2, 3, 4, 5] } });
    // Every 2 days from Mon 12th: 12, 14, 16, 18(Sun, filtered), 20, 22…
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 5 })).toEqual([
      '2026-10-12',
      '2026-10-14',
      '2026-10-16',
      '2026-10-20',
      '2026-10-22',
    ]);
  });
});

describe('skipWeekends — the two distinct meanings', () => {
  it('daily: never yields a Saturday or Sunday at all', () => {
    const cfg = series({ recurrence: { freq: 'daily', interval: 1 }, skipWeekends: true });
    const dates = occurrencesFrom(cfg, { from: '2026-10-15', count: 10 });
    expect(dates).toEqual([
      '2026-10-15', // Thu
      '2026-10-16', // Fri
      '2026-10-19', // Mon  (17th/18th dropped, not moved)
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
    ]);
    expect(dates.some((d) => isWeekend(d))).toBe(false);
  });

  it('daily: a whole year of it never lands on a weekend', () => {
    const cfg = series({ recurrence: { freq: 'daily', interval: 1 }, skipWeekends: true });
    const dates = occurrencesFrom(cfg, { from: '2026-01-01', count: 260 });
    expect(dates).toHaveLength(260);
    expect(dates.filter((d) => isWeekend(d))).toEqual([]);
  });

  it('weekly: shifts a weekend due date forward', () => {
    const cfg = series({
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [6] }, // Saturdays
      skipWeekends: true,
      weekendShift: 'next',
    });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 3 })).toEqual([
      '2026-10-19', // Sat 17th → Mon 19th
      '2026-10-26', // Sat 24th → Mon 26th
      '2026-11-02', // Sat 31st → Mon 2nd
    ]);
  });

  it('weekly: shifts a weekend due date backward', () => {
    const cfg = series({
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] }, // Sundays
      skipWeekends: true,
      weekendShift: 'previous',
    });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 3 })).toEqual([
      '2026-10-16', // Sun 18th → Fri 16th
      '2026-10-23', // Sun 25th → Fri 23rd
      '2026-10-30', // Sun 1st Nov → Fri 30th Oct
    ]);
  });

  it('weekly: a Saturday and a Sunday shifting onto the same Monday collapse to one', () => {
    const cfg = series({
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0, 6] },
      skipWeekends: true,
      weekendShift: 'next',
    });
    // Sat 17th → Mon 19th and Sun 18th → Mon 19th are one occurrence, not two.
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 3 })).toEqual([
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
    ]);
  });

  it('monthly: shifts, and does not drop, a weekend occurrence', () => {
    const cfg = series({
      recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 15 },
      skipWeekends: true,
      weekendShift: 'next',
    });
    const dates = occurrencesFrom(cfg, { from: '2026-08-15', count: 4 });
    expect(dates).toEqual([
      '2026-08-17', // Sat 15 Aug → Mon 17
      '2026-09-15', // Tue
      '2026-10-15', // Thu
      '2026-11-16', // Sun 15 Nov → Mon 16
    ]);
    expect(dates).toHaveLength(4); // still one per month
  });
});

describe('month-end and leap-day rollover', () => {
  it('a 31st-of-the-month series clamps in short months and comes back', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 31 } });
    expect(occurrencesFrom(cfg, { from: '2027-01-31', count: 6 })).toEqual([
      '2027-01-31',
      '2027-02-28', // clamped
      '2027-03-31', // and back to the 31st — not ratcheted down to the 28th
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
    ]);
  });

  it('a Feb-29 yearly series falls back to Feb 28 and returns on the next leap year', () => {
    const cfg = series({ recurrence: { freq: 'yearly', interval: 1 } });
    expect(occurrencesFrom(cfg, { from: '2028-02-29', count: 5 })).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29', // leap again
    ]);
  });

  it('monthly across a leap February', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 30 } });
    expect(occurrencesFrom(cfg, { from: '2028-01-30', count: 3 })).toEqual([
      '2028-01-30',
      '2028-02-29',
      '2028-03-30',
    ]);
  });
});

describe('nth-weekday monthly', () => {
  it('third Tuesday of every month', () => {
    const cfg = series({
      recurrence: { freq: 'monthly', interval: 1, monthlyMode: 'nth-weekday', byWeekday: [2], dayOfMonth: 3 },
    });
    expect(occurrencesFrom(cfg, { from: '2026-10-01', count: 4 })).toEqual([
      '2026-10-20',
      '2026-11-17',
      '2026-12-15',
      '2027-01-19',
    ]);
  });

  it('last Friday of every month', () => {
    const cfg = series({
      recurrence: { freq: 'monthly', interval: 1, monthlyMode: 'nth-weekday', byWeekday: [5], dayOfMonth: 'last' },
    });
    expect(occurrencesFrom(cfg, { from: '2026-10-01', count: 4 })).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
      '2027-01-29',
    ]);
  });

  it('infers the ordinal from the anchor when the config does not state one', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, monthlyMode: 'nth-weekday' } });
    // Anchor Thu 8 Oct 2026 is the 2nd Thursday.
    expect(occurrencesFrom(cfg, { from: '2026-10-08', count: 3 })).toEqual([
      '2026-10-08',
      '2026-11-12',
      '2026-12-10',
    ]);
  });
});

describe('end conditions', () => {
  it('stops at endDate', () => {
    const cfg = series({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] }, endDate: '2026-11-05' });
    expect(occurrencesFrom(cfg, { from: '2026-10-15', count: 10 })).toEqual([
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
    ]);
  });

  it('stops at occurrenceLimit, counting what the series already minted', () => {
    const cfg = series({ recurrence: { freq: 'daily', interval: 1 }, occurrenceLimit: 5 });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 10 })).toHaveLength(5);
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 10, alreadyGenerated: 3 })).toEqual([
      '2026-10-12',
      '2026-10-13',
    ]);
  });

  it('nextOccurrenceAfter walks one step and respects the anchor', () => {
    const cfg = series({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] } });
    expect(nextOccurrenceAfter(cfg, '2026-10-15', '2026-10-15')).toBe('2026-10-22');
    expect(nextOccurrenceAfter(series({ endDate: '2026-10-15' }), '2026-10-15', '2026-10-12')).toBeNull();
  });
});

describe('carryMode', () => {
  const template = [
    { title: 'Pull the report', order: 0 },
    { title: 'Reconcile', order: 1 },
  ];
  const previous = [
    { id: 'a', title: 'Pull the report', done: true, order: 0 },
    { id: 'b', title: 'Reconcile', done: false, order: 1 },
    { id: 'c', title: 'Chase the vendor', done: false, order: 2 },
  ];

  it('reset hands back the template, unchecked, and carries nothing', () => {
    const out = buildOccurrenceSubtasks({
      template,
      previousSubtasks: previous,
      copyOnRecur: { subtasks: true, carryMode: 'reset', keepCheckedItems: false },
      previousTaskId: 'task-1',
    });
    expect(out.subtasks.map((s) => s.title)).toEqual(['Pull the report', 'Reconcile']);
    expect(out.subtasks.every((s) => s.done === false)).toBe(true);
    expect(out.subtasks.every((s) => s.carriedFromTaskId === null)).toBe(true);
    expect(out.carryStreak).toBe(0);
    expect(out.carryFlagged).toBe(false);
  });

  it('reset + keepCheckedItems preserves ticks by title', () => {
    const out = buildOccurrenceSubtasks({
      template,
      previousSubtasks: previous,
      copyOnRecur: { subtasks: true, carryMode: 'reset', keepCheckedItems: true },
    });
    expect(out.subtasks.map((s) => s.done)).toEqual([true, false]);
  });

  it('carry-unfinished appends undone work the template does not already cover', () => {
    const out = buildOccurrenceSubtasks({
      template,
      previousSubtasks: previous,
      copyOnRecur: { subtasks: true, carryMode: 'carry-unfinished', keepCheckedItems: false },
      previousTaskId: 'task-1',
    });
    // 'Reconcile' is undone but IS in the template, so it isn't duplicated.
    expect(out.subtasks.map((s) => s.title)).toEqual(['Pull the report', 'Reconcile', 'Chase the vendor']);
    expect(out.subtasks[2].carriedFromTaskId).toBe('task-1');
    expect(out.carriedCount).toBe(1);
    expect(out.carryStreak).toBe(1);
    expect(out.carryFlagged).toBe(false);
  });

  it('carry-unfinished resets the streak when nothing is left over', () => {
    const out = buildOccurrenceSubtasks({
      template,
      previousSubtasks: [{ id: 'a', title: 'Pull the report', done: true, order: 0 }],
      copyOnRecur: { subtasks: true, carryMode: 'carry-unfinished' },
      previousCarryStreak: 2,
    });
    expect(out.carriedCount).toBe(0);
    expect(out.carryStreak).toBe(0);
    expect(out.carryFlagged).toBe(false);
  });

  it('flags the task past three consecutive carries instead of growing silently', () => {
    const copyOnRecur = { subtasks: true, carryMode: 'carry-unfinished' };
    const stale = [{ id: 'c', title: 'Chase the vendor', done: false, order: 2 }];

    const streaks = [0, 1, 2, 3].map(
      (previousCarryStreak) =>
        buildOccurrenceSubtasks({ template, previousSubtasks: stale, copyOnRecur, previousCarryStreak, previousTaskId: 't' }),
    );

    expect(streaks.map((s) => s.carryStreak)).toEqual([1, 2, 3, 4]);
    expect(streaks.map((s) => s.carryFlagged)).toEqual([false, false, false, true]);
    expect(CARRY_LIMIT).toBe(3);
  });

  it('keeps the original source task across repeated carries', () => {
    const out = buildOccurrenceSubtasks({
      template: [],
      previousSubtasks: [{ id: 'c', title: 'Chase the vendor', done: false, order: 0, carriedFromTaskId: 'task-origin' }],
      copyOnRecur: { subtasks: true, carryMode: 'carry-unfinished' },
      previousTaskId: 'task-latest',
    });
    expect(out.subtasks[0].carriedFromTaskId).toBe('task-origin');
  });

  it('copies no subtasks at all when copyOnRecur.subtasks is off', () => {
    const out = buildOccurrenceSubtasks({
      template,
      previousSubtasks: previous,
      copyOnRecur: { subtasks: false, carryMode: 'carry-unfinished' },
    });
    expect(out.subtasks).toEqual([]);
  });
});

describe('missedPolicy', () => {
  const open = [{ id: 'task-old', occurrenceKey: '2026-10-08' }];

  it('creates when nothing is open, whatever the policy', () => {
    for (const missedPolicy of ['skip-to-next', 'accumulate', 'keep-one-open']) {
      expect(decideMissedAction({ missedPolicy, openTasks: [], dueDate: '2026-10-15' }).action).toBe('create');
    }
  });

  it('skip-to-next rolls the open occurrence forward instead of duplicating', () => {
    const out = decideMissedAction({ missedPolicy: 'skip-to-next', openTasks: open, dueDate: '2026-10-15' });
    expect(out.action).toBe('roll-forward');
    expect(out.openTaskId).toBe('task-old');
    expect(out.note).toContain('rolled forward');
  });

  it('skip-to-next is the default when no policy is stored', () => {
    expect(decideMissedAction({ openTasks: open, dueDate: '2026-10-15' }).action).toBe('roll-forward');
  });

  it('skip-to-next rolls the OLDEST open occurrence, not the newest', () => {
    const out = decideMissedAction({
      missedPolicy: 'skip-to-next',
      openTasks: [{ id: 'newer', occurrenceKey: '2026-10-14' }, { id: 'older', occurrenceKey: '2026-09-01' }],
      dueDate: '2026-10-15',
    });
    expect(out.openTaskId).toBe('older');
  });

  it('accumulate creates a second task — the old pile-up behaviour, kept on purpose', () => {
    expect(decideMissedAction({ missedPolicy: 'accumulate', openTasks: open, dueDate: '2026-10-15' }).action).toBe(
      'create',
    );
  });

  it('keep-one-open creates nothing and leaves the open task alone', () => {
    const out = decideMissedAction({ missedPolicy: 'keep-one-open', openTasks: open, dueDate: '2026-10-15' });
    expect(out.action).toBe('skip');
    expect(out.note).toContain('keep-one-open');
  });

  it('a year of a neglected weekly series under the default policy yields ONE task', () => {
    // The regression this whole phase exists for: the customer's ClickUp minted
    // 30+ copies of one weekly task over a year and none was ever completed.
    const cfg = series({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } });
    const dates = occurrencesFrom(cfg, { from: '2026-01-05', count: 52 });
    expect(dates.length).toBe(52);

    let created = 0;
    let openTasks = [];
    for (const dueDate of dates) {
      const decision = decideMissedAction({ missedPolicy: 'skip-to-next', openTasks, dueDate });
      if (decision.action === 'create') {
        created++;
        openTasks = [{ id: `task-${dueDate}`, occurrenceKey: dueDate }]; // nobody ever completes it
      }
    }
    expect(created).toBe(1);
  });
});

describe('deterministic ids — idempotency', () => {
  it('builds seriesId_occurrenceKey', () => {
    expect(occurrenceDocId('abc', '2026-10-15')).toBe('abc_2026-10-15');
    expect(occurrenceDocId('abc', null)).toBeNull();
    expect(occurrenceDocId(null, '2026-10-15')).toBeNull();
  });

  it('generating twice for the same occurrence produces one task', () => {
    // Stand-in for Firestore: a map keyed by doc id, written with create-if-absent
    // semantics exactly as the generator's WriteBatch does.
    const store = new Map();
    const writeOccurrence = (seriesId, date) => {
      const id = occurrenceDocId(seriesId, date);
      if (store.has(id)) return false; // batch.create() would reject this
      store.set(id, { seriesId, occurrenceKey: date });
      return true;
    };

    const cfg = series({ recurrence: { freq: 'daily', interval: 1 } });
    const run = () => occurrencesFrom(cfg, { from: '2026-10-12', count: 3 }).map((d) => writeOccurrence('abc', d));

    expect(run()).toEqual([true, true, true]);
    expect(run()).toEqual([false, false, false]); // the retried / double-fired run
    expect(store.size).toBe(3);
    expect([...store.keys()]).toEqual(['abc_2026-10-12', 'abc_2026-10-13', 'abc_2026-10-14']);
  });

  it('the same config always yields the same dates, so the ids are stable', () => {
    const cfg = series({ recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 'last' }, skipWeekends: true });
    const a = occurrencesFrom(cfg, { from: '2026-10-01', count: 6 });
    const b = occurrencesFrom(cfg, { from: '2026-10-01', count: 6 });
    expect(a).toEqual(b);
  });
});

describe('malformed input is inert, not explosive', () => {
  it('returns nothing rather than throwing', () => {
    expect(occurrencesFrom(series(), { from: 'not-a-date', count: 3 })).toEqual([]);
    expect(occurrencesFrom(series(), { from: '2026-13-01', count: 3 })).toEqual([]);
    expect(occurrencesFrom(series({ recurrence: { freq: 'fortnightly' } }), { from: '2026-10-12', count: 3 })).toEqual(
      [],
    );
    expect(occurrencesFrom(series(), { from: '2026-10-12', count: 0 })).toEqual([]);
  });

  it('treats a zero or negative interval as 1 rather than looping forever', () => {
    const cfg = series({ recurrence: { freq: 'daily', interval: 0 } });
    expect(occurrencesFrom(cfg, { from: '2026-10-12', count: 3 })).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
  });
});
