import type { FsTimestamp } from '../types';
export type { FsTimestamp };

/** Robust conversion of a Firestore Timestamp or ISO string to a Date. Returns null for falsy input. */
export function toDate(ts: FsTimestamp | null | undefined): Date | null {
  if (!ts) return null;
  if (typeof ts === 'string') return new Date(ts);
  return ts.toDate();
}

/** Locale date string (e.g. "6/11/2026"), or '' if the timestamp is missing. */
export function formatDate(ts: FsTimestamp | null | undefined): string {
  const d = toDate(ts);
  return d ? d.toLocaleDateString() : '';
}

/** Compact local date-time (e.g. "Jun 11, 02:30 PM"), or '' if the timestamp is missing. */
export function formatDateTime(ts: FsTimestamp | null | undefined): string {
  const d = toDate(ts);
  return d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

/** Local-time "now" formatted for a datetime-local input's min attribute (YYYY-MM-DDTHH:mm). */
export function localDateTimeMin(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// ─── Date-only helpers ───────────────────────────────────────────────────────
// Onboarding due dates and property milestones are calendar days, not instants,
// so they're stored as 'YYYY-MM-DD' strings. That sorts and range-queries
// correctly in Firestore and avoids the timezone shifts a Timestamp would
// introduce. Everything below treats such a string as a LOCAL calendar date —
// `new Date('2026-09-25')` would parse as UTC midnight and render as the day
// before in US timezones, so we never do that.

/** Parse a 'YYYY-MM-DD' string as a local-midnight Date. Returns null if unparseable. */
export function parseDateOnly(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a local Date back to 'YYYY-MM-DD'. */
export function toDateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today as 'YYYY-MM-DD' in the viewer's local timezone. */
export function todayStr(): string {
  return toDateOnly(new Date());
}

/** Add (or subtract, for negative n) calendar days to a 'YYYY-MM-DD' string. */
export function addDaysStr(dateStr: string | null | undefined, days: number): string | null {
  const d = parseDateOnly(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return toDateOnly(d);
}

/** Whole days from `from` to `to` (positive when `to` is later). Null if either is unparseable. */
export function diffDaysStr(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Display a 'YYYY-MM-DD' string as a locale date (e.g. "9/25/2026"), or '' if missing. */
export function formatDateOnly(dateStr: string | null | undefined): string {
  const d = parseDateOnly(dateStr);
  return d ? d.toLocaleDateString() : '';
}
