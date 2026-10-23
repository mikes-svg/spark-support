/**
 * My Tasks — Phase 1 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * The signed-in user's own tasks (assigneeIds contains them), grouped by
 * status with due-date sorting inherited from listTasks, overdue highlighted
 * via TaskRow/DueDateLabel. Composable filters (list, status, assignee,
 * overdue-only) are modelled on DashboardPage.tsx's stat-tile + dropdown
 * pattern. Scheduled tasks are excluded from the query by default — they
 * aren't live work yet — behind an explicit toggle.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { ListChecks, Plus, ListFilter, Users as UsersIcon, CalendarClock } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { PageSpinner } from '../components/PageSpinner';
import { TaskRow } from '../components/tasks/shared/TaskRow';
import { TaskCreateModal } from '../components/tasks/TaskCreateModal';
import { listTasks, TASK_LISTS } from '../lib/tasks';
import { getOrSeedStatusSets } from '../lib/taskStatuses';
import { isTaskOverdue } from '../types';
import { todayStr } from '../lib/dates';
import type { Profile, Task, TaskList, TaskStatusSet, TaskStatusType } from '../types';

// Display order for grouping by statusType — mirrors the type's lifecycle,
// never the (per-list, renameable) status label.
const TYPE_ORDER: TaskStatusType[] = ['todo', 'active', 'waiting', 'done', 'closed'];
const TYPE_LABEL: Record<TaskStatusType, string> = {
  scheduled: 'Scheduled', todo: 'To Do', active: 'In Progress', waiting: 'Waiting On', done: 'Complete', closed: 'Closed',
};

export function TasksPage() {
  const { user } = useAuth();
  const today = todayStr();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [people, setPeople] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const [listFilter, setListFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatusType | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);

  useEffect(() => {
    if (!user || !db) { setLoading(false); return; }
    let cancelled = false;

    async function load() {
      try {
        setError(false);
        const [rows, listsSnap, sets, peopleSnap] = await Promise.all([
          listTasks({ assigneeIds: [user!.id], includeDone: true, includeScheduled: showScheduled }),
          getDocs(collection(db!, TASK_LISTS)),
          getOrSeedStatusSets(),
          getDocs(collection(db!, 'profiles')),
        ]);
        if (cancelled) return;
        setTasks(rows);
        setLists(listsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskList)));
        setStatusSets(sets);
        const map: Record<string, Profile> = {};
        peopleSnap.docs.forEach((d) => { map[d.id] = { id: d.id, ...d.data() } as Profile; });
        setPeople(map);
      } catch (err) {
        console.error('Failed to load tasks:', err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user, showScheduled]);

  const listsById = useMemo(() => {
    const m: Record<string, TaskList> = {};
    lists.forEach((l) => { m[l.id] = l; });
    return m;
  }, [lists]);

  // Options are drawn from the loaded tasks themselves (not the whole
  // directory/every list), so a dropdown never offers a choice that would
  // immediately empty the table — same rule DashboardPage's assignee filter follows.
  const listOptions = useMemo(() => {
    const ids = new Set(tasks.map((t) => t.listId));
    return [...ids].map((id) => listsById[id]).filter((l): l is TaskList => Boolean(l)).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, listsById]);

  const statusTypeOptions = useMemo(() => {
    const present = new Set(tasks.map((t) => t.statusType));
    return TYPE_ORDER.filter((t) => present.has(t));
  }, [tasks]);

  const assigneeOptions = useMemo(() => {
    const ids = new Set<string>();
    tasks.forEach((t) => (t.assigneeIds ?? []).forEach((id) => ids.add(id)));
    return [...ids].map((id) => people[id]).filter((p): p is Profile => Boolean(p)).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, people]);

  const matchesFilters = (t: Task) => {
    if (listFilter && t.listId !== listFilter) return false;
    if (statusFilter && t.statusType !== statusFilter) return false;
    if (assigneeFilter && !(t.assigneeIds ?? []).includes(assigneeFilter)) return false;
    if (overdueOnly && !isTaskOverdue(t, today)) return false;
    return true;
  };

  const visible = tasks.filter(matchesFilters);

  // Group by the task's current denormalized status (statusId+statusName) —
  // no lookup needed — ordered by statusType lifecycle, then by name within a type.
  const groups = useMemo(() => {
    const byKey = new Map<string, { statusId: string; statusName: string; statusType: TaskStatusType; tasks: Task[] }>();
    for (const t of visible) {
      const key = t.statusId || t.statusName;
      let g = byKey.get(key);
      if (!g) { g = { statusId: t.statusId, statusName: t.statusName, statusType: t.statusType, tasks: [] }; byKey.set(key, g); }
      g.tasks.push(t);
    }
    return [...byKey.values()].sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.statusType);
      const tb = TYPE_ORDER.indexOf(b.statusType);
      if (ta !== tb) return ta - tb;
      return a.statusName.localeCompare(b.statusName);
    });
  }, [visible]);

  const anyFilterActive = listFilter !== '' || statusFilter !== null || assigneeFilter !== '' || overdueOnly;
  const canFilterByList = listOptions.length > 1;
  const canFilterByStatus = statusTypeOptions.length > 1;
  const canFilterByAssignee = assigneeOptions.length > 0;

  const overdueCount = tasks.filter((t) => isTaskOverdue(t, today)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-between sm:items-center">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-widest">My Tasks</h2>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:flex-wrap">
          {canFilterByList && (
            <div className="relative">
              <ListFilter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <select
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                aria-label="Filter by list"
                className="block w-full sm:w-44 pl-9 pr-10 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
              >
                <option value="">All lists</option>
                {listOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          {canFilterByStatus && (
            <select
              value={statusFilter ?? ''}
              onChange={(e) => setStatusFilter((e.target.value || null) as TaskStatusType | null)}
              aria-label="Filter by status"
              className="block w-full sm:w-40 pl-3 pr-10 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
            >
              <option value="">All statuses</option>
              {statusTypeOptions.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          )}
          {canFilterByAssignee && (
            <div className="relative">
              <UsersIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label="Filter by assignee"
                className="block w-full sm:w-48 pl-9 pr-10 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
              >
                <option value="">All assignees</option>
                {assigneeOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <label className="inline-flex items-center gap-2 min-h-[44px] px-1 text-sm text-gray-700 select-none">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} className="rounded border-gray-300 text-brand-dark focus:ring-brand-dark" />
            Overdue only{overdueCount > 0 ? ` (${overdueCount})` : ''}
          </label>
          <label className="inline-flex items-center gap-2 min-h-[44px] px-1 text-sm text-gray-700 select-none">
            <input type="checkbox" checked={showScheduled} onChange={(e) => setShowScheduled(e.target.checked)} className="rounded border-gray-300 text-brand-dark focus:ring-brand-dark" />
            <CalendarClock className="h-4 w-4 text-gray-400" />
            Show scheduled
          </label>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center justify-center whitespace-nowrap px-4 py-2 min-h-[44px] border border-transparent text-sm font-medium rounded-md text-brand-dark bg-brand-gold hover:bg-brand-gold/80 shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4 mr-2" />New Task
          </button>
        </div>
      </div>

      {anyFilterActive && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => { setListFilter(''); setStatusFilter(null); setAssigneeFilter(''); setOverdueOnly(false); }}
            className="text-sm text-brand-gold hover:text-yellow-700 font-medium"
          >
            Clear filters
          </button>
        </div>
      )}

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center text-sm text-red-600">
          Couldn't load your tasks. Check your connection and refresh.
        </div>
      ) : tasks.length === 0 ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
          <ListChecks className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Nothing assigned to you</h2>
          <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">
            Everything assigned to you, across every space and list, sorted by urgency, will show up here.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center text-sm text-gray-500">
          No tasks match the current filters.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.statusId} className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/50 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-700">{g.statusName}</h3>
                <span className="text-xs text-gray-400">{g.tasks.length}</span>
              </div>
              <div className="divide-y divide-gray-100">
                {g.tasks.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} people={people} contextLabel={listsById[t.listId]?.name} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <TaskCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        lists={lists}
        statusSets={statusSets}
        people={Object.values(people)}
        defaultListId={listFilter || null}
        onCreated={(task) => setTasks((prev) => [task, ...prev])}
      />
    </div>
  );
}
