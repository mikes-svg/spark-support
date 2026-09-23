/**
 * Team Tasks — Phase 4 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Every task in the workspace, grouped and filtered. Task visibility is OPEN
 * (§2 of the plan / CONTRACTS-TASKS.md) — any signed-in user reads every task,
 * so this page queries across everyone rather than scoping to `user.id`.
 *
 * Rows are rendered with the shared TaskRow component rather than a literal
 * <table>: TaskRow already carries the same columns (due date, priority,
 * subtask progress, status, assignees) and already collapses gracefully on a
 * phone via its own responsive classes, which a horizontally-scrolling table
 * would not do nearly as well for a title-first list like this one.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { ListTodo } from 'lucide-react';
import { db } from '../lib/firebase';
import { listTasks } from '../lib/tasks';
import { getOrSeedStatusSets } from '../lib/taskStatuses';
import { addDaysStr, todayStr } from '../lib/dates';
import { TaskFilters } from '../components/tasks/TaskFilters';
import { TaskRow } from '../components/tasks/shared/TaskRow';
import { PageSpinner } from '../components/PageSpinner';
import type { Profile, Task, TaskFilter, TaskList, TaskStatusSet, TaskStatusType, TaskTag } from '../types';

type GroupBy = 'status' | 'assignee' | 'list' | 'due-week';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'list', label: 'List' },
  { value: 'due-week', label: 'Due' },
];

// Fixed so groups read in a sensible order regardless of which statuses a
// given task happens to carry (scheduled work first, closed work last).
const STATUS_TYPE_ORDER: TaskStatusType[] = ['scheduled', 'todo', 'active', 'waiting', 'done', 'closed'];

interface Group {
  key: string;
  label: string;
  tasks: Task[];
}

export function TeamTasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [tags, setTags] = useState<Record<string, TaskTag>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [filter, setFilter] = useState<TaskFilter>({});

  const today = todayStr();

  // Lists, status sets, people, and tags change rarely — load them once,
  // independent of the filter/task refetch below.
  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const [listSnap, sets, peopleSnap, tagSnap] = await Promise.all([
          getDocs(collection(db!, 'taskLists')),
          getOrSeedStatusSets(),
          getDocs(collection(db!, 'profiles')),
          getDocs(collection(db!, 'taskTags')),
        ]);
        setLists(listSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskList)));
        setStatusSets(sets);
        setPeople(peopleSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        const tagMap: Record<string, TaskTag> = {};
        tagSnap.docs.forEach((d) => { tagMap[d.id] = { id: d.id, ...d.data() } as TaskTag; });
        setTags(tagMap);
      } catch (err) {
        console.error('Failed to load task reference data:', err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    listTasks(filter)
      .then((rows) => { if (!cancelled) setTasks(rows); })
      .catch((err) => {
        console.error('Failed to load tasks:', err);
        if (!cancelled) setError(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filter]);

  const peopleById = useMemo(() => {
    const map: Record<string, Profile> = {};
    people.forEach((p) => { map[p.id] = p; });
    return map;
  }, [people]);

  const listsById = useMemo(() => {
    const map: Record<string, TaskList> = {};
    lists.forEach((l) => { map[l.id] = l; });
    return map;
  }, [lists]);

  const groups = useMemo(() => buildGroups(tasks, groupBy, peopleById, listsById, today), [tasks, groupBy, peopleById, listsById, today]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-between sm:items-center">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-widest">Team Tasks</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="group-by" className="text-sm text-gray-500 whitespace-nowrap">Group by</label>
          <select
            id="group-by"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="min-h-[44px] sm:min-h-0 px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
          >
            {GROUP_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </div>
      </div>

      <TaskFilters value={filter} onChange={setFilter} lists={lists} statusSets={statusSets} people={people} />

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 px-6 py-12 text-center text-sm text-red-600">
          Couldn't load tasks. Check your connection and refresh.
        </div>
      ) : tasks.length === 0 ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
          <ListTodo className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
          <h3 className="mt-4 text-lg font-serif font-semibold text-gray-900">No tasks match</h3>
          <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">
            Nothing fits the current filters. Try clearing a filter, or create a task from a list.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key} className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-sm font-serif font-semibold text-gray-900">{group.label}</h3>
                <span className="text-xs text-gray-500">{group.tasks.length}</span>
              </div>
              <div className="divide-y divide-gray-100">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={`${group.key}-${task.id}`}
                    task={task}
                    today={today}
                    people={peopleById}
                    tags={tags}
                    contextLabel={groupBy === 'list' ? undefined : listsById[task.listId]?.name}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildGroups(
  tasks: Task[],
  groupBy: GroupBy,
  people: Record<string, Profile>,
  lists: Record<string, TaskList>,
  today: string,
): Group[] {
  if (groupBy === 'status') {
    const byKey = new Map<string, Group>();
    for (const t of tasks) {
      const key = `${t.statusType}::${t.statusName}`;
      const existing = byKey.get(key);
      if (existing) existing.tasks.push(t);
      else byKey.set(key, { key, label: t.statusName, tasks: [t] });
    }
    return [...byKey.values()].sort((a, b) => {
      const [aType] = a.key.split('::');
      const [bType] = b.key.split('::');
      const order = STATUS_TYPE_ORDER.indexOf(aType as TaskStatusType) - STATUS_TYPE_ORDER.indexOf(bType as TaskStatusType);
      return order !== 0 ? order : a.label.localeCompare(b.label);
    });
  }

  if (groupBy === 'assignee') {
    const byKey = new Map<string, Group>();
    for (const t of tasks) {
      const ids = t.assigneeIds.length > 0 ? t.assigneeIds : ['__unassigned__'];
      for (const id of ids) {
        const label = id === '__unassigned__' ? 'Unassigned' : (people[id]?.name ?? 'Unknown');
        const existing = byKey.get(id);
        if (existing) existing.tasks.push(t);
        else byKey.set(id, { key: id, label, tasks: [t] });
      }
    }
    return [...byKey.values()].sort((a, b) => {
      if (a.key === '__unassigned__') return 1;
      if (b.key === '__unassigned__') return -1;
      return a.label.localeCompare(b.label);
    });
  }

  if (groupBy === 'list') {
    const byKey = new Map<string, Group>();
    for (const t of tasks) {
      const label = lists[t.listId]?.name ?? 'Unknown list';
      const existing = byKey.get(t.listId);
      if (existing) existing.tasks.push(t);
      else byKey.set(t.listId, { key: t.listId, label, tasks: [t] });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  // due-week: practical buckets rather than raw week numbers, since "overdue"
  // and "this week" are what a person scanning the list actually wants to know.
  const weekEnd = addDaysStr(today, 7) ?? today;
  const nextWeekEnd = addDaysStr(today, 14) ?? today;
  const buckets: Group[] = [
    { key: 'overdue', label: 'Overdue', tasks: [] },
    { key: 'this-week', label: 'This Week', tasks: [] },
    { key: 'next-week', label: 'Next Week', tasks: [] },
    { key: 'later', label: 'Later', tasks: [] },
    { key: 'no-date', label: 'No Due Date', tasks: [] },
  ];
  for (const t of tasks) {
    if (!t.dueDate) { buckets[4].tasks.push(t); continue; }
    if (t.dueDate < today) buckets[0].tasks.push(t);
    else if (t.dueDate <= weekEnd) buckets[1].tasks.push(t);
    else if (t.dueDate <= nextWeekEnd) buckets[2].tasks.push(t);
    else buckets[3].tasks.push(t);
  }
  return buckets.filter((b) => b.tasks.length > 0);
}
