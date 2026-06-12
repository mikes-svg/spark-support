export type FsTimestamp = { toDate: () => Date } | string;

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
