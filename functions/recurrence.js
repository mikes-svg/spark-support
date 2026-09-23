/**
 * Recurrence math — the one and only implementation (plan §4, "One implementation
 * only"). Pure functions, no Firestore, no clock, no I/O: everything that decides
 * *when* an occurrence happens and *what* it contains lives here so it can be
 * tested against fixtures. `tasksRecurring.js` does the reading and writing.
 *
 * The client never re-implements any of this. The "next 5 occurrences" preview in
 * RecurrenceEditor calls the `previewRecurrence` callable, which calls this file.
 * Two copies of date maths is how a feature like this silently drifts apart — and
 * a drift here is invisible until someone's weekly task lands on the wrong day.
 *
 * Calendar days are 'YYYY-MM-DD' strings throughout, as everywhere else in this
 * codebase. They are never passed to `new Date(str)` — that parses as UTC midnight
 * and renders a day early in US timezones. All arithmetic goes through plain
 * integer {y, m, d} triples and Date.UTC, which has no local-timezone opinion.
 */

'use strict';

// ─── Date-only primitives ────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Split 'YYYY-MM-DD' into {y, m, d} (m is 1-12). Null if it isn't a date string. */
function parseDate(dateStr) {
  const m = DATE_RE.exec(String(dateStr ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** Build 'YYYY-MM-DD' from integers, zero-padded. */
function formatDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in month `m` (1-12) of year `y`. Day 0 of the next month is this month's last. */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' → days since the epoch. Only ever compared against other such values. */
function toEpochDay(dateStr) {
  const p = parseDate(dateStr);
  if (!p) return null;
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
}

/** Days since the epoch → 'YYYY-MM-DD'. */
function fromEpochDay(day) {
  const dt = new Date(day * 86400000);
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Add (or subtract) whole calendar days to a 'YYYY-MM-DD' string. Null in, null out. */
function addDays(dateStr, days) {
  const day = toEpochDay(dateStr);
  return day === null ? null : fromEpochDay(day + days);
}

/** Whole days from `from` to `to`, positive when `to` is later. */
function diffDays(from, to) {
  const a = toEpochDay(from);
  const b = toEpochDay(to);
  return a === null || b === null ? null : b - a;
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(dateStr) {
  const p = parseDate(dateStr);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

function isWeekend(dateStr) {
  const wd = weekdayOf(dateStr);
  return wd === 0 || wd === 6;
}

/** The Sunday on or before `dateStr`. */
function weekStart(dateStr) {
  const wd = weekdayOf(dateStr);
  return wd === null ? null : addDays(dateStr, -wd);
}

/**
 * Move a Saturday/Sunday onto the adjacent weekday. `next` → Monday, `previous`
 * → Friday. A weekday is returned untouched. This is the *weekly-and-slower*
 * reading of skipWeekends; the daily reading is "don't generate at all" and is
 * handled in the emit loop, not here. Getting those two confused is a real bug —
 * see the header comment on `occurrencesFrom`.
 */
function shiftOffWeekend(dateStr, direction) {
  const wd = weekdayOf(dateStr);
  if (wd === null || (wd !== 0 && wd !== 6)) return dateStr;
  if (direction === 'previous') return addDays(dateStr, wd === 6 ? -1 : -2);
  return addDays(dateStr, wd === 6 ? 2 : 1);
}

// ─── Occurrence sequences ────────────────────────────────────────────────────

/** Guard on every index scan. A series that can't produce a date in this many
 *  steps is malformed, and we'd rather return short than spin a function. */
const MAX_SCAN = 5000;

/** How many carries in a row before `carry-unfinished` stops growing quietly. */
const CARRY_LIMIT = 3;

const DEFAULT_TIMEZONE = 'America/Chicago';

function normalizeInterval(interval) {
  const n = Math.floor(Number(interval));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function normalizeWeekdays(byWeekday) {
  if (!Array.isArray(byWeekday)) return [];
  const clean = byWeekday
    .map((n) => Math.floor(Number(n)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(clean)].sort((a, b) => a - b);
}

/**
 * Build `dateAt(k)` for a recurrence: the k-th scheduled date (k = 0 is the
 * anchor's own occurrence), ignoring weekend rules and end conditions.
 *
 * Every frequency derives its date from the ANCHOR and an index, never from the
 * previous occurrence. That is what makes month-end and leap-day behave: an
 * anchor of Jan 31 gives Feb 28, Mar 31, Apr 30 — clamping per month but always
 * returning to the 31st — and a Feb 29 anchor gives Feb 28 in common years and
 * Feb 29 again in the next leap year. Chaining off the previous date would
 * ratchet the day-of-month down and never recover.
 */
function buildDateAt(recurrence, anchor) {
  const freq = recurrence?.freq || 'daily';
  const interval = normalizeInterval(recurrence?.interval);
  const anchorParts = parseDate(anchor);
  if (!anchorParts) return null;
  const anchorDay = toEpochDay(anchor);

  if (freq === 'daily' || freq === 'custom') {
    // `custom` is the escape hatch: every N days, optionally narrowed to a set of
    // weekdays. The weekday narrowing is a filter in the emit loop, not part of
    // the index, so `dateAt` stays a simple monotonic formula.
    return (k) => fromEpochDay(anchorDay + k * interval);
  }

  if (freq === 'weekly' || freq === 'biweekly') {
    // Multiple weekdays per cycle, so one index spans (cycle, weekday-slot).
    // `biweekly` is weekly with the stride doubled — a separate freq in the UI
    // because that is how people say it, not a separate rule.
    const days = normalizeWeekdays(recurrence?.byWeekday);
    const slots = days.length ? days : [weekdayOf(anchor)];
    const stride = (freq === 'biweekly' ? 2 : 1) * interval;
    const startOfWeek = toEpochDay(weekStart(anchor));
    return (k) => {
      const cycle = Math.floor(k / slots.length);
      const slot = slots[k % slots.length];
      return fromEpochDay(startOfWeek + cycle * stride * 7 + slot);
    };
  }

  if (freq === 'monthly') {
    const mode = recurrence?.monthlyMode || 'day-of-month';
    const baseMonth = anchorParts.y * 12 + (anchorParts.m - 1);

    if (mode === 'nth-weekday') {
      // "3rd Tuesday", "last Friday". The pinned TaskSeriesRecurrence has no
      // dedicated fields for this, so we read it off the two it does have:
      // byWeekday[0] is the weekday and dayOfMonth is the ordinal (1-5, or
      // 'last'). Both fall back to the anchor's own position in its month, so a
      // series configured by picking a date just works.
      const wd = normalizeWeekdays(recurrence?.byWeekday)[0] ?? weekdayOf(anchor);
      const nth =
        recurrence?.dayOfMonth === 'last'
          ? 'last'
          : Number.isInteger(Number(recurrence?.dayOfMonth))
            ? Math.min(5, Math.max(1, Number(recurrence.dayOfMonth)))
            : Math.ceil(anchorParts.d / 7);
      return (k) => {
        const month = baseMonth + k * interval;
        const y = Math.floor(month / 12);
        const m = (month % 12) + 1;
        return nthWeekdayOfMonth(y, m, wd, nth);
      };
    }

    const dom = recurrence?.dayOfMonth === 'last' ? 'last' : Number(recurrence?.dayOfMonth) || anchorParts.d;
    return (k) => {
      const month = baseMonth + k * interval;
      const y = Math.floor(month / 12);
      const m = (month % 12) + 1;
      const last = daysInMonth(y, m);
      // Clamp rather than skip: a "31st of the month" series should still fire in
      // February. ClickUp skips short months; clamping is what the customer's
      // month-end checklists actually need.
      return formatDate(y, m, dom === 'last' ? last : Math.min(dom, last));
    };
  }

  if (freq === 'yearly') {
    return (k) => {
      const y = anchorParts.y + k * interval;
      const last = daysInMonth(y, anchorParts.m);
      return formatDate(y, anchorParts.m, Math.min(anchorParts.d, last));
    };
  }

  return null;
}

/** The nth (1-5, or 'last') `weekday` of a month, as 'YYYY-MM-DD'. */
function nthWeekdayOfMonth(y, m, weekday, nth) {
  const last = daysInMonth(y, m);
  if (nth === 'last') {
    const lastWd = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
    return formatDate(y, m, last - ((lastWd - weekday + 7) % 7));
  }
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7;
  // A 5th Tuesday doesn't exist every month; fall back to the 4th rather than
  // spilling into the next month, which would double up with its own occurrence.
  return formatDate(y, m, day > last ? day - 7 : day);
}

/**
 * Smallest index k with dateAt(k) >= `from`. Starts from a cheap estimate and
 * walks, so it stays O(1)-ish for every frequency without each one needing its
 * own inverse formula.
 */
function firstIndexOnOrAfter(dateAt, from, guess) {
  let k = Math.max(0, Math.floor(guess) || 0);
  let guard = 0;
  while (k > 0 && dateAt(k - 1) >= from && guard++ < MAX_SCAN) k--;
  guard = 0;
  while (dateAt(k) < from && guard++ < MAX_SCAN) k++;
  return k;
}

function guessIndex(recurrence, anchor, from) {
  const freq = recurrence?.freq || 'daily';
  const interval = normalizeInterval(recurrence?.interval);
  const gap = diffDays(anchor, from) ?? 0;
  if (gap <= 0) return 0;
  if (freq === 'daily' || freq === 'custom') return Math.floor(gap / interval);
  if (freq === 'weekly' || freq === 'biweekly') {
    const slots = Math.max(1, normalizeWeekdays(recurrence?.byWeekday).length || 1);
    const stride = (freq === 'biweekly' ? 2 : 1) * interval;
    return Math.floor(gap / (7 * stride)) * slots;
  }
  if (freq === 'monthly') return Math.floor(gap / 30 / interval);
  if (freq === 'yearly') return Math.floor(gap / 365 / interval);
  return 0;
}

/**
 * The next `count` occurrence dates on or after `from`.
 *
 * `config` is the stored series shape: { recurrence, skipWeekends, weekendShift,
 * endDate, occurrenceLimit }. `opts` is { from, count, anchor, alreadyGenerated }.
 *
 * **skipWeekends means two different things** and conflating them is the bug this
 * function exists to prevent:
 *   - freq `daily` → don't generate at all on a Sat/Sun. The occurrence is
 *     dropped, not moved; a Mon-Fri chore has four occurrences in a week that
 *     contains a holiday, not four-and-two-shuffled.
 *   - every other freq → generate normally, then move a Sat/Sun *due date* onto
 *     the adjacent weekday per `weekendShift`. A monthly report due the 15th is
 *     still a once-a-month thing when the 15th is a Sunday.
 *
 * The end condition applies to the *scheduled* date. A weekend shift of 'next'
 * can therefore place the final occurrence a day or two past `endDate` — the
 * series ends on the month you asked for, and the last task is still workable.
 */
function occurrencesFrom(config, opts) {
  const recurrence = config?.recurrence || {};
  const from = opts?.from;
  const count = Math.max(0, Math.floor(Number(opts?.count ?? 5)));
  const anchor = opts?.anchor || from;
  if (!parseDate(from) || !parseDate(anchor) || count === 0) return [];

  const dateAt = buildDateAt(recurrence, anchor);
  if (!dateAt) return [];

  const freq = recurrence.freq || 'daily';
  const skipWeekends = Boolean(config?.skipWeekends);
  const weekendShift = config?.weekendShift === 'previous' ? 'previous' : 'next';
  const endDate = parseDate(config?.endDate) ? config.endDate : null;
  const limit = Number(config?.occurrenceLimit) > 0 ? Number(config.occurrenceLimit) : null;
  const already = Math.max(0, Math.floor(Number(opts?.alreadyGenerated ?? 0)));
  const customDays = freq === 'custom' ? normalizeWeekdays(recurrence.byWeekday) : [];

  const out = [];
  const seen = new Set();
  let k = firstIndexOnOrAfter(dateAt, from, guessIndex(recurrence, anchor, from));

  for (let scanned = 0; scanned < MAX_SCAN && out.length < count; scanned++) {
    if (limit !== null && already + out.length >= limit) break;

    const raw = dateAt(k);
    k++;
    if (!raw) break;
    if (endDate && raw > endDate) break;
    if (customDays.length && !customDays.includes(weekdayOf(raw))) continue;

    let date = raw;
    if (skipWeekends) {
      if (freq === 'daily') {
        if (isWeekend(raw)) continue; // dropped, not moved
      } else {
        date = shiftOffWeekend(raw, weekendShift);
      }
    }

    // A 'previous' shift can pull an occurrence behind the window we were asked
    // about; two shifted dates can also collapse onto the same Monday.
    if (date < from) continue;
    if (seen.has(date)) continue;

    seen.add(date);
    out.push(date);
  }

  return out;
}

/** The single next occurrence strictly after `after`, or null if the series is done. */
function nextOccurrenceAfter(config, after, anchor) {
  const from = addDays(after, 1);
  if (!from) return null;
  const [next] = occurrencesFrom(config, { from, count: 1, anchor: anchor || after });
  return next || null;
}

/** Deterministic occurrence key and doc id. `${seriesId}_${occurrenceKey}` is
 *  what makes a retried or double-fired run physically unable to duplicate. */
function occurrenceKeyFor(dateStr) {
  return parseDate(dateStr) ? dateStr : null;
}

function occurrenceDocId(seriesId, occurrenceKey) {
  if (!seriesId || !occurrenceKey) return null;
  return `${seriesId}_${occurrenceKey}`;
}

// ─── Subtask carryover ───────────────────────────────────────────────────────

function normalizeTitle(title) {
  return String(title ?? '').trim().toLowerCase();
}

/**
 * Build the new occurrence's subtask list.
 *
 * `reset` (the default, ClickUp parity) hands back the template unchecked — right
 * for a checklist whose every step repeats each cycle.
 *
 * `carry-unfinished` hands back the template *plus* whatever was left undone last
 * cycle, each tagged `carriedFromTaskId` so the UI can mark it. That can grow
 * without bound on a neglected series, so it is bounded the same way missedPolicy
 * bounds occurrences: `carryStreak` counts consecutive cycles that carried
 * something, and past CARRY_LIMIT (3) the result is flagged instead of quietly
 * getting longer. The caller writes the flag onto the task for the UI and the
 * morning digest to read.
 *
 * Returns { subtasks, carryStreak, carryFlagged, carriedCount }.
 */
function buildOccurrenceSubtasks(input) {
  const template = Array.isArray(input?.template) ? input.template : [];
  const previous = Array.isArray(input?.previousSubtasks) ? input.previousSubtasks : [];
  const copy = input?.copyOnRecur || {};
  const previousTaskId = input?.previousTaskId || null;
  const previousStreak = Math.max(0, Math.floor(Number(input?.previousCarryStreak ?? 0)));
  const idFor = typeof input?.idFor === 'function' ? input.idFor : (i) => `st-${i}`;
  // Injected rather than computed here so this module stays free of any notion of
  // "which occurrence we are on" — the caller knows the gap between cycles, and
  // copyOnRecur.remapSubtaskDates decides whether it is applied at all.
  const remapDueDate = typeof input?.remapDueDate === 'function' ? input.remapDueDate : () => null;

  if (copy.subtasks === false) {
    return { subtasks: [], carryStreak: 0, carryFlagged: false, carriedCount: 0 };
  }

  const keepChecked = copy.keepCheckedItems === true;
  const doneTitles = new Set(previous.filter((s) => s?.done).map((s) => normalizeTitle(s.title)));

  const subtasks = template.map((item, i) => ({
    id: idFor(i),
    title: String(item?.title ?? ''),
    // keepCheckedItems is ClickUp's "carry the ticks over". Off by default: an
    // occurrence that arrives half-complete is not a fresh checklist.
    done: keepChecked && doneTitles.has(normalizeTitle(item?.title)),
    doneAt: null,
    doneBy: null,
    assigneeIds: copy.subtaskAssignees === false ? [] : (item?.assigneeIds ?? []),
    dueDate: null,
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : i,
    carriedFromTaskId: null,
  }));

  if (copy.carryMode !== 'carry-unfinished') {
    return { subtasks, carryStreak: 0, carryFlagged: false, carriedCount: 0 };
  }

  // Anything undone last cycle that the template doesn't already cover. Matching
  // on title keeps a repeated step from appearing twice, which is what makes a
  // carried list readable rather than a pile of near-duplicates.
  const templateTitles = new Set(template.map((t) => normalizeTitle(t?.title)));
  const carried = previous
    .filter((s) => s && !s.done && !templateTitles.has(normalizeTitle(s.title)))
    .map((s, i) => ({
      id: idFor(subtasks.length + i),
      title: String(s.title ?? ''),
      done: false,
      doneAt: null,
      doneBy: null,
      assigneeIds: copy.subtaskAssignees === false ? [] : (s.assigneeIds ?? []),
      dueDate: remapDueDate(s.dueDate ?? null),
      order: subtasks.length + i,
      // Preserve the ORIGINAL task a step came from across repeated carries, so
      // "carried over since March" stays traceable instead of resetting each cycle.
      carriedFromTaskId: s.carriedFromTaskId || previousTaskId,
    }));

  const carryStreak = carried.length > 0 ? previousStreak + 1 : 0;
  return {
    subtasks: [...subtasks, ...carried],
    carryStreak,
    carryFlagged: carryStreak > CARRY_LIMIT,
    carriedCount: carried.length,
  };
}

// ─── Missed occurrences ──────────────────────────────────────────────────────

/**
 * What to do when the next occurrence falls due and the previous one is still open.
 *
 * This is the fix for the customer's pile-up: a weekly ClickUp task minted 30+
 * copies over a year and not one was ever completed, because every cycle created
 * a new task regardless of the state of the last.
 *
 *   - `skip-to-next` (DEFAULT) — create nothing. Roll the open task's due date
 *     forward to the new date and record a `missed_occurrence` event. One task,
 *     always current, with a visible history of how often it slipped.
 *   - `accumulate` — create anyway. The old behaviour, kept only because a few
 *     genuinely additive series (invoices, reports) want one record per period.
 *   - `keep-one-open` — create nothing and leave the open task exactly as it is,
 *     due date included. For work that is pinned to the date it was meant for.
 *
 * Returns { action: 'create' | 'roll-forward' | 'skip', openTaskId, note }.
 */
function decideMissedAction(input) {
  const policy = input?.missedPolicy || 'skip-to-next';
  const open = Array.isArray(input?.openTasks) ? input.openTasks.filter(Boolean) : [];
  const dueDate = input?.dueDate || null;

  if (open.length === 0) return { action: 'create', openTaskId: null, note: null };

  // Roll the oldest open one — the furthest behind is the one that needs rescuing.
  const oldest = [...open].sort((a, b) =>
    String(a.occurrenceKey ?? '').localeCompare(String(b.occurrenceKey ?? '')),
  )[0];

  if (policy === 'accumulate') {
    return { action: 'create', openTaskId: oldest.id ?? null, note: null };
  }

  if (policy === 'keep-one-open') {
    return {
      action: 'skip',
      openTaskId: oldest.id ?? null,
      note: `Occurrence ${dueDate} skipped: an earlier occurrence is still open (keep-one-open).`,
    };
  }

  return {
    action: 'roll-forward',
    openTaskId: oldest.id ?? null,
    note: `Occurrence ${dueDate} missed: the open occurrence was rolled forward instead of duplicated (skip-to-next).`,
  };
}

module.exports = {
  // date primitives
  parseDate,
  formatDate,
  daysInMonth,
  addDays,
  diffDays,
  weekdayOf,
  isWeekend,
  weekStart,
  shiftOffWeekend,
  nthWeekdayOfMonth,
  // sequences
  occurrencesFrom,
  nextOccurrenceAfter,
  occurrenceKeyFor,
  occurrenceDocId,
  // occurrence contents
  buildOccurrenceSubtasks,
  decideMissedAction,
  // constants
  CARRY_LIMIT,
  DEFAULT_TIMEZONE,
  MAX_SCAN,
};
