import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getAssigneeIds } from '../types';
import type { TicketStatus, TicketPriority } from '../types';
import {
  Clock,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  RotateCcw,
  Users,
  Mail,
  Activity,
} from 'lucide-react';

interface Ticket {
  id: string;
  type: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeIds?: string[];
  assigneeId?: string | null;
  submitterId: string;
  createdAt: { toDate: () => Date } | string;
  updatedAt: { toDate: () => Date } | string;
}

interface Profile {
  id: string;
  name: string;
  email?: string;
  photoURL?: string;
  role?: string;
}

interface TicketEvent {
  id: string;
  ticketId: string;
  type: 'created' | 'status_changed' | 'priority_changed' | 'assignees_changed' | 'commented';
  actorId: string;
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  fromAssigneeIds?: string[];
  toAssigneeIds?: string[];
  isFirstResponse?: boolean;
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

const PRIORITY_ORDER: TicketPriority[] = ['Urgent', 'High', 'Medium', 'Low'];
const STATUS_ORDER: TicketStatus[] = ['Open', 'In Progress', 'On Hold', 'Resolved'];

function toDate(ts: Ticket['createdAt'] | TicketEvent['createdAt'] | undefined | null): Date | null {
  if (!ts) return null;
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  try {
    return ts.toDate();
  } catch {
    return null;
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function AnalyticsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState<string>(isoDate(startOfDay(new Date(Date.now() - 30 * 86_400_000))));
  const [customEnd, setCustomEnd] = useState<string>(isoDate(startOfDay(new Date())));

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const [ticketsSnap, eventsSnap, profilesSnap] = await Promise.all([
          getDocs(query(collection(db!, 'tickets'), orderBy('createdAt', 'desc'))),
          getDocs(query(collection(db!, 'ticketEvents'), orderBy('createdAt', 'asc'))).catch(() => null),
          getDocs(collection(db!, 'profiles')),
        ]);
        setTickets(ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket)));
        if (eventsSnap) {
          setEvents(eventsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TicketEvent)));
        }
        const map: Record<string, Profile> = {};
        profilesSnap.docs.forEach((d) => { map[d.id] = { id: d.id, ...d.data() } as Profile; });
        setProfiles(map);
      } catch (err) {
        console.error('Failed to load analytics data:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const range = useMemo(() => {
    const end = preset === 'custom' ? parseLocalDate(customEnd) : startOfDay(new Date());
    end.setHours(23, 59, 59, 999);
    let start: Date;
    if (preset === 'all') {
      start = new Date(0);
    } else if (preset === 'custom') {
      start = parseLocalDate(customStart);
    } else {
      const days = PRESETS.find((p) => p.id === preset)?.days ?? 30;
      start = startOfDay(new Date(Date.now() - (days - 1) * 86_400_000));
    }
    return { start, end };
  }, [preset, customStart, customEnd]);

  const inRange = (d: Date | null): boolean => {
    if (!d) return false;
    return d >= range.start && d <= range.end;
  };

  const ticketsInRange = useMemo(
    () => tickets.filter((t) => inRange(toDate(t.createdAt))),
    [tickets, range],
  );

  // ---------- METRICS ----------

  // Open right now (across all time, not range — these are live)
  const openNow = tickets.filter((t) => t.status !== 'Resolved');
  const openByStatus = STATUS_ORDER.reduce<Record<TicketStatus, number>>((acc, s) => {
    acc[s] = tickets.filter((t) => t.status === s).length;
    return acc;
  }, {} as Record<TicketStatus, number>);
  const openByPriority = PRIORITY_ORDER.reduce<Record<TicketPriority, number>>((acc, p) => {
    acc[p] = openNow.filter((t) => t.priority === p).length;
    return acc;
  }, {} as Record<TicketPriority, number>);

  // Aging — open tickets bucketed by how long they've been open
  const now = Date.now();
  const aging = openNow.reduce(
    (acc, t) => {
      const created = toDate(t.createdAt);
      if (!created) return acc;
      const days = (now - created.getTime()) / 86_400_000;
      if (days > 30) acc.over30++;
      else if (days > 14) acc.over14++;
      else if (days > 7) acc.over7++;
      else acc.recent++;
      return acc;
    },
    { recent: 0, over7: 0, over14: 0, over30: 0 },
  );

  // Resolution time (for tickets resolved inside the range)
  // We approximate: resolved-at = updatedAt for tickets currently Resolved AND created inside the range.
  // If we have a status_changed event to "Resolved" inside the range, that's more accurate.
  const resolveEventByTicket = new Map<string, Date>();
  events.forEach((e) => {
    if (e.type === 'status_changed' && e.toStatus === 'Resolved') {
      const d = toDate(e.createdAt);
      if (d) resolveEventByTicket.set(e.ticketId, d);
    }
  });
  const resolvedDurations: { priority: TicketPriority; ms: number }[] = [];
  tickets.forEach((t) => {
    const created = toDate(t.createdAt);
    if (!created) return;
    const resolvedAt = resolveEventByTicket.get(t.id) || (t.status === 'Resolved' ? toDate(t.updatedAt) : null);
    if (!resolvedAt) return;
    if (!inRange(resolvedAt)) return;
    resolvedDurations.push({ priority: t.priority, ms: resolvedAt.getTime() - created.getTime() });
  });
  const allResolveMs = resolvedDurations.map((r) => r.ms);
  const avgResolveMs = allResolveMs.length ? allResolveMs.reduce((a, b) => a + b, 0) / allResolveMs.length : 0;
  const medianResolveMs = median(allResolveMs);
  const resolveByPriority = PRIORITY_ORDER.map((p) => {
    const ms = resolvedDurations.filter((r) => r.priority === p).map((r) => r.ms);
    return { priority: p, count: ms.length, median: median(ms), p90: percentile(ms, 90) };
  });

  // Time to first response (from `commented` events with isFirstResponse=true)
  const firstResponseMs: number[] = [];
  const ticketCreatedMap = new Map(tickets.map((t) => [t.id, toDate(t.createdAt)]));
  events.forEach((e) => {
    if (e.type === 'commented' && e.isFirstResponse) {
      const respondedAt = toDate(e.createdAt);
      const created = ticketCreatedMap.get(e.ticketId);
      if (respondedAt && created && inRange(respondedAt)) {
        firstResponseMs.push(respondedAt.getTime() - created.getTime());
      }
    }
  });
  const medianFirstResponseMs = median(firstResponseMs);

  // Reopen rate (status_changed from Resolved → anything else, in range)
  const reopens = events.filter(
    (e) => e.type === 'status_changed' && e.fromStatus === 'Resolved' && e.toStatus !== 'Resolved' && inRange(toDate(e.createdAt)),
  ).length;
  const resolutions = events.filter(
    (e) => e.type === 'status_changed' && e.toStatus === 'Resolved' && inRange(toDate(e.createdAt)),
  ).length;
  const reopenRate = resolutions > 0 ? (reopens / resolutions) * 100 : 0;

  // Per category (within range)
  const byCategory = ticketsInRange.reduce<Record<string, number>>((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {});
  const byCategorySorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  // Per assignee — total handled in range + currently open
  const handledByAssignee = ticketsInRange.reduce<Record<string, number>>((acc, t) => {
    getAssigneeIds(t).forEach((id) => { acc[id] = (acc[id] || 0) + 1; });
    return acc;
  }, {});
  const openByAssignee = openNow.reduce<Record<string, number>>((acc, t) => {
    getAssigneeIds(t).forEach((id) => { acc[id] = (acc[id] || 0) + 1; });
    return acc;
  }, {});
  const assigneeRows = [
    ...new Set([...Object.keys(handledByAssignee), ...Object.keys(openByAssignee)]),
  ]
    .map((id) => ({
      id,
      name: profiles[id]?.name || 'Unknown',
      photoURL: profiles[id]?.photoURL,
      handled: handledByAssignee[id] || 0,
      openNow: openByAssignee[id] || 0,
    }))
    .sort((a, b) => b.handled - a.handled || b.openNow - a.openNow);

  // Top submitters (within range)
  const submitterCount = ticketsInRange.reduce<Record<string, number>>((acc, t) => {
    acc[t.submitterId] = (acc[t.submitterId] || 0) + 1;
    return acc;
  }, {});
  const topSubmitters = Object.entries(submitterCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, count]) => ({ id, count, name: profiles[id]?.name || 'Unknown', photoURL: profiles[id]?.photoURL }));

  // Opened vs resolved per day (within range, capped at 60 buckets)
  const trend = useMemo(() => {
    const days = Math.min(
      60,
      Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1),
    );
    const buckets = Array.from({ length: days }).map((_, i) => {
      const d = startOfDay(new Date(range.end.getTime() - (days - 1 - i) * 86_400_000));
      return { date: d, opened: 0, resolved: 0 };
    });
    const idxFor = (d: Date): number => {
      const offset = Math.floor((startOfDay(d).getTime() - buckets[0].date.getTime()) / 86_400_000);
      return offset >= 0 && offset < buckets.length ? offset : -1;
    };
    tickets.forEach((t) => {
      const created = toDate(t.createdAt);
      if (created) {
        const i = idxFor(created);
        if (i >= 0) buckets[i].opened++;
      }
    });
    events.forEach((e) => {
      if (e.type === 'status_changed' && e.toStatus === 'Resolved') {
        const d = toDate(e.createdAt);
        if (d) {
          const i = idxFor(d);
          if (i >= 0) buckets[i].resolved++;
        }
      }
    });
    // Fallback: if no events, also count tickets currently Resolved by their updatedAt
    if (events.length === 0) {
      tickets.forEach((t) => {
        if (t.status === 'Resolved') {
          const d = toDate(t.updatedAt);
          if (d) {
            const i = idxFor(d);
            if (i >= 0) buckets[i].resolved++;
          }
        }
      });
    }
    return buckets;
  }, [tickets, events, range]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" />
      </div>
    );
  }

  const noEvents = events.length === 0;

  return (
    <div className="space-y-6">
      {/* Header + range filter */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-gray-700">Time range:</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
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
              className="px-2 py-1 text-sm border border-gray-300 rounded-md focus:ring-brand-dark focus:border-brand-dark"
            />
            <span className="text-sm text-gray-500">to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart}
              max={isoDate(new Date())}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-300 rounded-md focus:ring-brand-dark focus:border-brand-dark"
            />
          </div>
        )}
      </div>

      {noEvents && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md px-4 py-3">
          The audit log was just added — historical metrics like time-to-first-response and reopen rate
          will fill in as new ticket activity occurs. Counts based on ticket records (opened, resolved
          using <code>updatedAt</code>) work today.
        </div>
      )}

      {/* Top KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Tickets opened"
          value={ticketsInRange.length}
          sublabel="in selected range"
          color="bg-blue-100 text-blue-600"
        />
        <KpiCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Resolved"
          value={resolvedDurations.length}
          sublabel="in selected range"
          color="bg-emerald-100 text-emerald-600"
        />
        <KpiCard
          icon={<Clock className="h-5 w-5" />}
          label="Avg. time to resolve"
          value={fmtDuration(avgResolveMs)}
          sublabel={`median ${fmtDuration(medianResolveMs)}`}
          color="bg-amber-100 text-amber-600"
        />
        <KpiCard
          icon={<Activity className="h-5 w-5" />}
          label="Median first response"
          value={firstResponseMs.length ? fmtDuration(medianFirstResponseMs) : '—'}
          sublabel={firstResponseMs.length ? `${firstResponseMs.length} responses` : 'no events yet'}
          color="bg-violet-100 text-violet-600"
        />
      </div>

      {/* Open right now & aging */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Open right now" icon={<AlertCircle className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">By status</div>
              <ul className="space-y-1.5">
                {STATUS_ORDER.filter((s) => s !== 'Resolved').map((s) => (
                  <li key={s} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700">{s}</span>
                    <span className="font-semibold text-gray-900">{openByStatus[s]}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">By priority</div>
              <ul className="space-y-1.5">
                {PRIORITY_ORDER.map((p) => (
                  <li key={p} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700">{p}</span>
                    <span className="font-semibold text-gray-900">{openByPriority[p]}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>

        <Card title="Aging (open tickets)" icon={<Clock className="h-4 w-4" />}>
          <ul className="space-y-2">
            {[
              { label: '< 7 days', value: aging.recent, tone: 'text-emerald-700 bg-emerald-50' },
              { label: '7–14 days', value: aging.over7, tone: 'text-amber-700 bg-amber-50' },
              { label: '14–30 days', value: aging.over14, tone: 'text-orange-700 bg-orange-50' },
              { label: '> 30 days', value: aging.over30, tone: 'text-red-700 bg-red-50' },
            ].map((row) => (
              <li key={row.label} className="flex items-center justify-between text-sm">
                <span className={`px-2 py-0.5 rounded ${row.tone}`}>{row.label}</span>
                <span className="font-semibold text-gray-900">{row.value}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Trend chart */}
      <Card title="Opened vs resolved per day" icon={<TrendingUp className="h-4 w-4" />}>
        <TrendChart data={trend} />
      </Card>

      {/* Resolution time by priority */}
      <Card title="Resolution time by priority (in range)" icon={<Clock className="h-4 w-4" />}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="py-2 pr-4">Priority</th>
                <th className="py-2 pr-4">Resolved</th>
                <th className="py-2 pr-4">Median</th>
                <th className="py-2 pr-4">P90</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {resolveByPriority.map((row) => (
                <tr key={row.priority}>
                  <td className="py-2 pr-4 font-medium text-gray-900">{row.priority}</td>
                  <td className="py-2 pr-4 text-gray-700">{row.count}</td>
                  <td className="py-2 pr-4 text-gray-700">{fmtDuration(row.median)}</td>
                  <td className="py-2 pr-4 text-gray-700">{fmtDuration(row.p90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Reopen rate */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card title="Reopen rate" icon={<RotateCcw className="h-4 w-4" />}>
          <div className="text-3xl font-semibold text-gray-900">{reopenRate.toFixed(1)}%</div>
          <p className="text-xs text-gray-500 mt-1">
            {reopens} of {resolutions} resolutions reopened
          </p>
        </Card>

        <Card title="Tickets per category" icon={<Activity className="h-4 w-4" />} className="lg:col-span-2">
          {byCategorySorted.length === 0 ? (
            <p className="text-sm text-gray-400">No tickets in range.</p>
          ) : (
            <BarList
              data={byCategorySorted.map(([label, value]) => ({ label, value }))}
              max={byCategorySorted[0][1]}
            />
          )}
        </Card>
      </div>

      {/* Per-assignee table */}
      <Card title="Workload by assignee" icon={<Users className="h-4 w-4" />}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="py-2 pr-4">Assignee</th>
                <th className="py-2 pr-4">Handled in range</th>
                <th className="py-2 pr-4">Open right now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {assigneeRows.length === 0 ? (
                <tr><td colSpan={3} className="py-4 text-sm text-gray-400">No assignee activity.</td></tr>
              ) : assigneeRows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      {row.photoURL && <img src={row.photoURL} alt="" className="w-6 h-6 rounded-full" />}
                      <span className="text-gray-900">{row.name}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-gray-700">{row.handled}</td>
                  <td className="py-2 pr-4 text-gray-700">{row.openNow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Top submitters */}
      <Card title="Top submitters" icon={<Mail className="h-4 w-4" />}>
        {topSubmitters.length === 0 ? (
          <p className="text-sm text-gray-400">No tickets submitted in range.</p>
        ) : (
          <ul className="space-y-2">
            {topSubmitters.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {s.photoURL && <img src={s.photoURL} alt="" className="w-6 h-6 rounded-full" />}
                  <span className="text-gray-900">{s.name}</span>
                </div>
                <span className="font-semibold text-gray-900">{s.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function KpiCard({ icon, label, value, sublabel, color }: { icon: React.ReactNode; label: string; value: React.ReactNode; sublabel?: string; color: string }) {
  return (
    <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-md ${color}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-gray-500 truncate">{label}</div>
          <div className="text-2xl font-semibold text-gray-900 leading-tight">{value}</div>
          {sublabel && <div className="text-xs text-gray-500 mt-0.5">{sublabel}</div>}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon, children, className = '' }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white shadow-sm rounded-lg border border-gray-200 ${className}`}>
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        {icon && <span className="text-gray-400">{icon}</span>}
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function BarList({ data, max }: { data: { label: string; value: number }[]; max: number }) {
  return (
    <ul className="space-y-2">
      {data.map((row) => (
        <li key={row.label}>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-gray-700">{row.label}</span>
            <span className="font-semibold text-gray-900">{row.value}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded overflow-hidden">
            <div
              className="h-full bg-brand-dark"
              style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TrendChart({ data }: { data: { date: Date; opened: number; resolved: number }[] }) {
  if (data.length === 0) return <p className="text-sm text-gray-400">No data.</p>;
  const max = Math.max(1, ...data.map((d) => Math.max(d.opened, d.resolved)));
  const w = 760;
  const h = 180;
  const pad = { l: 28, r: 12, t: 10, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const line = (key: 'opened' | 'resolved') =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
  const tickStep = Math.max(1, Math.floor(data.length / 6));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-44 min-w-[600px]">
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={pad.l} x2={w - pad.r} y1={pad.t + innerH * (1 - f)} y2={pad.t + innerH * (1 - f)} stroke="#e5e7eb" strokeWidth="1" />
        ))}
        {/* y-axis labels */}
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={pad.l - 6} y={pad.t + innerH * (1 - f) + 3} fontSize="10" textAnchor="end" fill="#9ca3af">
            {Math.round(max * f)}
          </text>
        ))}
        {/* x-axis labels */}
        {data.map((d, i) =>
          i % tickStep === 0 || i === data.length - 1 ? (
            <text key={i} x={x(i)} y={h - 8} fontSize="10" textAnchor="middle" fill="#9ca3af">
              {d.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </text>
          ) : null,
        )}
        <path d={line('opened')} stroke="#1B4332" strokeWidth="2" fill="none" />
        <path d={line('resolved')} stroke="#D4A843" strokeWidth="2" fill="none" />
        {data.map((d, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(d.opened)} r="2.5" fill="#1B4332" />
            <circle cx={x(i)} cy={y(d.resolved)} r="2.5" fill="#D4A843" />
          </g>
        ))}
      </svg>
      <div className="flex items-center gap-4 text-xs text-gray-600 mt-1 px-2">
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-[#1B4332] inline-block" /> Opened</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-[#D4A843] inline-block" /> Resolved</span>
      </div>
    </div>
  );
}
