/**
 * Workload — Phase 5 of docs/CLICKUP_MIGRATION_PLAN.md (§10).
 *
 * Per person: open / overdue / due this week (current state, not range-scoped
 * — the same "right now" convention AnalyticsPage uses for open ticket
 * counts), completed in the last 30 days (a fixed window — it's the metric's
 * name), on-time completion % and average cycle time for the selected range,
 * and recurring compliance — how often a recurring task actually gets done
 * within its own cycle, evaluated across every series occurrence regardless
 * of range, because a series that's been silently failing for a year (the
 * "Check for Expired Concessions" case, plan §10) shouldn't disappear just
 * because someone picked "Last 7 days".
 *
 * Every number below is derived from `statusType` via the shared predicates in
 * src/types.ts — never a status label. That's what keeps this page honest
 * when someone renames or reorders a list's statuses.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  collection,
  getCountFromServer,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  isTaskDone,
  isTaskLive,
  isTaskOverdue,
  type Profile,
  type Task,
  type TaskEventType,
} from '../types';
import { addDaysStr, formatDateOnly, parseDateOnly, todayStr, toDate } from '../lib/dates';
import { PageSpinner } from '../components/PageSpinner';
import { WorkloadChart, type WorkloadRow } from '../components/tasks/WorkloadChart';
import { Gauge, Clock, ListChecks, AlertTriangle, CalendarClock, CheckCircle2, Repeat } from 'lucide-react';

interface TaskEventRow {
  id: string;
  taskId: string;
  type: TaskEventType;
  toStatusType?: string | null;
  createdAt: { toDate: () => Date } | string;
}

type RangePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

const PRESETS: { id: RangePreset; label: string; days?: number }[] = [
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

const METRICS: { id: 'open' | 'overdue' | 'dueThisWeek' | 'completed30d'; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'dueThisWeek', label: 'Due this week' },
  { id: 'completed30d', label: 'Completed (30d)' },
];

function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

interface PersonStats extends WorkloadRow {
  onTimeCompletionPct: number | null;
  avgCycleTimeMs: number | null;
  seriesJudged: number; // denominator behind recurringCompliance, for the tooltip/empty state
}

export function WorkloadPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [events, setEvents] = useState<TaskEventRow[]>([]);
  const [eventsExist, setEventsExist] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState<string>(addDaysStr(todayStr(), -30) as string);
  const [customEnd, setCustomEnd] = useState<string>(todayStr());
  const [metric, setMetric] = useState<'open' | 'overdue' | 'dueThisWeek' | 'completed30d'>('open');

  // Tasks + profiles load once — every "right now" metric and the recurring-
  // compliance metric need the full set, not just what's in the selected
  // range. taskEvents (used only for average cycle time) load per-range below,
  // gated by a cheap existence count, mirroring AnalyticsPage.
  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const [tasksSnap, profilesSnap, eventsCount] = await Promise.all([
          getDocs(collection(db!, 'tasks')),
          getDocs(collection(db!, 'profiles')),
          getCountFromServer(collection(db!, 'taskEvents')).catch(() => null),
        ]);
        setTasks(tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Task)));
        setProfiles(profilesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        setEventsExist(!!eventsCount && eventsCount.data().count > 0);
        setError(false);
      } catch (err) {
        console.error('Failed to load workload data:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const range = useMemo(() => {
    const endDay = preset === 'custom' ? customEnd : todayStr();
    let startDay: string;
    if (preset === 'all') {
      startDay = '1970-01-01';
    } else if (preset === 'custom') {
      startDay = customStart;
    } else {
      const days = PRESETS.find((p) => p.id === preset)?.days ?? 30;
      startDay = addDaysStr(todayStr(), -(days - 1)) as string;
    }
    const start = parseDateOnly(startDay) ?? new Date(0);
    const end = parseDateOnly(endDay) ?? new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [preset, customStart, customEnd]);

  // Cycle-time completion instants come from the audit log (mirrors
  // AnalyticsPage's resolution-time calc), not the task's own `completedAt` —
  // a reopened-then-recompleted task's current field only reflects the latest
  // cycle, while the event log lets a range pick out the completion that
  // actually happened in it.
  useEffect(() => {
    const database = db;
    if (!database || !eventsExist) { setEvents([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(database, 'taskEvents'),
          where('createdAt', '>=', Timestamp.fromDate(range.start)),
          where('createdAt', '<=', Timestamp.fromDate(range.end)),
          orderBy('createdAt', 'asc'),
        ));
        if (!cancelled) setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskEventRow)));
      } catch (err) {
        if (!cancelled) { console.error('Failed to load workload events:', err); setEvents([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [range, eventsExist]);

  const today = todayStr();
  const weekEnd = addDaysStr(today, 6) as string;
  const thirtyDaysAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }, []);

  // Latest 'status_changed' event landing on a done/closed status, per task,
  // within the selected range — the completion instant for cycle time.
  const completionEventByTask = useMemo(() => {
    const map = new Map<string, Date>();
    for (const e of events) {
      if (e.type !== 'status_changed') continue;
      if (e.toStatusType !== 'done' && e.toStatusType !== 'closed') continue;
      const d = toDate(e.createdAt);
      if (d) map.set(e.taskId, d); // events are ordered asc, so the last write wins
    }
    return map;
  }, [events]);

  const rows: PersonStats[] = useMemo(() => {
    const byPerson = new Map<string, PersonStats>();
    const ensure = (id: string, name: string): PersonStats => {
      let row = byPerson.get(id);
      if (!row) {
        row = {
          userId: id, name, open: 0, overdue: 0, dueThisWeek: 0, completed30d: 0,
          recurringCompliance: null, onTimeCompletionPct: null, avgCycleTimeMs: null, seriesJudged: 0,
        };
        byPerson.set(id, row);
      }
      return row;
    };

    const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name || 'Unknown';
    profiles.forEach((p) => ensure(p.id, p.name));

    // Accumulators kept alongside the row so percentages can be finalized once
    // every task has been visited, without a second pass over `tasks`.
    const onTime = new Map<string, { num: number; den: number }>();
    const cycle = new Map<string, number[]>();
    const compliance = new Map<string, { num: number; den: number }>();

    for (const task of tasks) {
      const assigneeIds = task.assigneeIds ?? [];
      if (assigneeIds.length === 0) continue;

      const live = isTaskLive(task);
      const overdue = isTaskOverdue(task, today);
      const dueThisWeek = live && !!task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd;
      const done = isTaskDone(task);
      const completedDate = toDate(task.completedAt ?? null);
      const completedRecently = done && !!completedDate && completedDate >= thirtyDaysAgo;

      for (const uid of assigneeIds) {
        const row = ensure(uid, nameOf(uid));
        if (live) row.open++;
        if (overdue) row.overdue++;
        if (dueThisWeek) row.dueThisWeek++;
        if (completedRecently) row.completed30d++;

        // On-time completion % (range-scoped): only tasks completed in range
        // with a due date count — an undated task was never "late".
        if (done && task.dueDate && completedDate && completedDate >= range.start && completedDate <= range.end) {
          const acc = onTime.get(uid) ?? { num: 0, den: 0 };
          const completedDay = completedDate.toISOString().slice(0, 10);
          // Local-day compare would be more precise, but this is a summary
          // metric and a Firestore Timestamp's UTC day is at most one day off
          // from the local one — acceptable slack for "on time", unlike the
          // hard rule against `new Date(dateStr)` on a stored calendar string.
          acc.den++;
          if (completedDay <= task.dueDate) acc.num++;
          onTime.set(uid, acc);
        }

        // Average cycle time (range-scoped, from the audit log).
        const completionEvent = completionEventByTask.get(task.id);
        if (completionEvent && task.createdAt) {
          const created = toDate(task.createdAt);
          if (created) {
            const list = cycle.get(uid) ?? [];
            list.push(completionEvent.getTime() - created.getTime());
            cycle.set(uid, list);
          }
        }

        // Recurring compliance: of this person's series occurrences that have
        // been judged (finished, or overdue and therefore missed on-time),
        // how many finished on or before their own due date. Not range-scoped
        // — a series that's been failing all year should show that.
        if (task.seriesId) {
          const judged = done || overdue;
          if (judged) {
            const acc = compliance.get(uid) ?? { num: 0, den: 0 };
            acc.den++;
            const onTimeDone = done && (!task.dueDate || !completedDate ||
              completedDate.toISOString().slice(0, 10) <= task.dueDate);
            if (onTimeDone) acc.num++;
            compliance.set(uid, acc);
          }
        }
      }
    }

    for (const [uid, row] of byPerson) {
      const ot = onTime.get(uid);
      row.onTimeCompletionPct = ot && ot.den > 0 ? (ot.num / ot.den) * 100 : null;
      const cyc = cycle.get(uid);
      row.avgCycleTimeMs = cyc && cyc.length > 0 ? cyc.reduce((a, b) => a + b, 0) / cyc.length : null;
      const comp = compliance.get(uid);
      row.recurringCompliance = comp && comp.den > 0 ? (comp.num / comp.den) * 100 : null;
      row.seriesJudged = comp?.den ?? 0;
    }

    return [...byPerson.values()].sort((a, b) => b.open - a.open || b.overdue - a.overdue);
  }, [tasks, profiles, today, weekEnd, thirtyDaysAgo, completionEventByTask, range]);

  const totals = useMemo(() => ({
    open: rows.reduce((s, r) => s + r.open, 0),
    overdue: rows.reduce((s, r) => s + r.overdue, 0),
    dueThisWeek: rows.reduce((s, r) => s + r.dueThisWeek, 0),
    completed30d: rows.reduce((s, r) => s + r.completed30d, 0),
  }), [rows]);

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">
          Couldn't load workload data. Some figures may be missing — check your connection and refresh.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-brand-dark" aria-hidden="true" />
        <h1 className="text-xl font-serif font-semibold text-gray-900">Workload</h1>
      </div>

      {/* Range filter — governs on-time completion % and average cycle time
          only; open/overdue/due-this-week/completed-30d/compliance are not
          range-scoped (see the file header). */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-gray-700">Completion range:</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            className={`min-h-[44px] px-3 py-1.5 text-sm rounded-md border transition-colors ${
              preset === p.id
                ? 'bg-brand-dark text-white border-brand-dark'
                : 'bg-white text-gray-700 border-gray-300 hover:border-brand-dark'
            }`}
          >
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customStart}
              max={customEnd}
              onChange={(e) => setCustomStart(e.target.value)}
              className="min-h-[44px] px-2 py-1 text-sm border border-gray-300 rounded-md focus:ring-brand-dark focus:border-brand-dark"
            />
            <span className="text-sm text-gray-500">to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart}
              max={todayStr()}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="min-h-[44px] px-2 py-1 text-sm border border-gray-300 rounded-md focus:ring-brand-dark focus:border-brand-dark"
            />
          </div>
        )}
      </div>

      {/* Team totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={<ListChecks className="h-5 w-5" />} label="Open" value={totals.open} color="bg-blue-100 text-blue-600" />
        <KpiCard icon={<AlertTriangle className="h-5 w-5" />} label="Overdue" value={totals.overdue} color="bg-red-100 text-red-600" />
        <KpiCard icon={<CalendarClock className="h-5 w-5" />} label="Due this week" value={totals.dueThisWeek} color="bg-amber-100 text-amber-600" />
        <KpiCard icon={<CheckCircle2 className="h-5 w-5" />} label="Completed (30d)" value={totals.completed30d} color="bg-emerald-100 text-emerald-600" />
      </div>

      {/* Chart */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Repeat className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Per person
          </h3>
          <div className="flex gap-1.5 flex-wrap">
            {METRICS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMetric(m.id)}
                className={`min-h-[44px] px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  metric === m.id
                    ? 'bg-brand-dark text-white border-brand-dark'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-brand-dark'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <WorkloadChart rows={rows} metric={metric} />
      </div>

      {/* Full metrics table */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-gray-700">All metrics</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="py-2 pl-4 pr-4">Person</th>
                <th className="py-2 pr-4">Open</th>
                <th className="py-2 pr-4">Overdue</th>
                <th className="py-2 pr-4">Due this week</th>
                <th className="py-2 pr-4">Completed (30d)</th>
                <th className="py-2 pr-4">On-time completion</th>
                <th className="py-2 pr-4">Avg. cycle time</th>
                <th className="py-2 pr-4">Recurring compliance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="py-4 pl-4 text-sm text-gray-400">No one to show yet.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.userId}>
                  <td className="py-2 pl-4 pr-4 text-gray-900 font-medium">{r.name}</td>
                  <td className="py-2 pr-4 text-gray-700">{r.open}</td>
                  <td className={`py-2 pr-4 ${r.overdue > 0 ? 'text-red-600 font-medium' : 'text-gray-700'}`}>{r.overdue}</td>
                  <td className="py-2 pr-4 text-gray-700">{r.dueThisWeek}</td>
                  <td className="py-2 pr-4 text-gray-700">{r.completed30d}</td>
                  <td className="py-2 pr-4 text-gray-700">{r.onTimeCompletionPct == null ? '—' : `${Math.round(r.onTimeCompletionPct)}%`}</td>
                  <td className="py-2 pr-4 text-gray-700">{fmtDuration(r.avgCycleTimeMs)}</td>
                  <td className="py-2 pr-4">
                    {r.recurringCompliance == null ? (
                      <span className="text-gray-400">no recurring tasks</span>
                    ) : (
                      <span className={
                        r.recurringCompliance < 50 ? 'text-red-600 font-semibold'
                          : r.recurringCompliance < 80 ? 'text-amber-600 font-medium'
                          : 'text-emerald-700'
                      }>
                        {Math.round(r.recurringCompliance)}% <span className="text-gray-400 font-normal">({r.seriesJudged} judged)</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        As of {formatDateOnly(today)}. Open/overdue/due-this-week/completed and recurring compliance reflect
        current state; on-time completion and average cycle time are scoped to the completion range above.
      </p>
    </div>
  );
}

function KpiCard({ icon, label, value, color }: { icon: ReactNode; label: string; value: ReactNode; color: string }) {
  return (
    <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-md ${color}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-gray-500 truncate">{label}</div>
          <div className="text-2xl font-semibold text-gray-900 leading-tight">{value}</div>
        </div>
      </div>
    </div>
  );
}
