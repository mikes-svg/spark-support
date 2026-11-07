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
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { ListTodo, X } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { canEditTask, listTasks, setStatusMany } from '../lib/tasks';
import { getOrSeedStatusSets } from '../lib/taskStatuses';
import { addDaysStr, todayStr } from '../lib/dates';
import { TaskFilters } from '../components/tasks/TaskFilters';
import { TaskRow } from '../components/tasks/shared/TaskRow';
import { PageSpinner } from '../components/PageSpinner';
import type { Profile, Task, TaskFilter, TaskList, TaskStatusDef, TaskStatusSet, TaskStatusType, TaskTag } from '../types';

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
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [tags, setTags] = useState<Record<string, TaskTag>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [filter, setFilter] = useState<TaskFilter>({});

  // Bulk selection. Ids only — the task objects are looked up at apply time so
  // a refetch underneath the selection can't apply a stale status.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkStatusId, setBulkStatusId] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

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

  // A new filter means a new result set; carrying a selection across it would
  // let someone bulk-edit rows they can no longer see.
  useEffect(() => { setSelectedIds(new Set()); setBulkMessage(null); }, [filter]);

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

  const tasksById = useMemo(() => {
    const map: Record<string, Task> = {};
    tasks.forEach((t) => { map[t.id] = t; });
    return map;
  }, [tasks]);

  /** Mirrors loadStatusSetForList in src/lib/tasks.ts: the list's own set,
   *  else the first set, so the options offered match what the write resolves. */
  const statusSetForTask = (task: Task): TaskStatusSet | null => {
    const setId = listsById[task.listId]?.defaultStatusSetId;
    return (setId && statusSets.find((s) => s.id === setId)) || statusSets[0] || null;
  };

  const selectableReason = (task: Task): string | undefined =>
    canEditTask(user?.id, task, user) ? undefined : "You're not on this task, so you can't change it.";

  const selectedTasks = useMemo(
    () => [...selectedIds].map((id) => tasksById[id]).filter((t): t is Task => Boolean(t)),
    [selectedIds, tasksById],
  );

  // Statuses the bulk bar can offer: those present, by id, in EVERY selected
  // task's status set. Tasks in lists with different sets shrink the options to
  // the overlap; no overlap at all is reported rather than guessed around.
  const bulkOptions = useMemo<TaskStatusDef[]>(() => {
    if (selectedTasks.length === 0) return [];
    const sets = selectedTasks.map(statusSetForTask);
    if (sets.some((s) => !s)) return [];
    const [first, ...rest] = sets as TaskStatusSet[];
    return [...first.statuses]
      .sort((a, b) => a.order - b.order)
      .filter((def) => rest.every((s) => s.statuses.some((d) => d.id === def.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTasks, listsById, statusSets]);

  // Drop a chosen status that the current selection can no longer reach.
  useEffect(() => {
    if (bulkStatusId && !bulkOptions.some((d) => d.id === bulkStatusId)) setBulkStatusId('');
  }, [bulkOptions, bulkStatusId]);

  const toggleSelected = (taskId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(taskId); else next.delete(taskId);
      return next;
    });
  };

  const setGroupSelected = (group: Group, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      group.tasks.forEach((t) => {
        if (selectableReason(t)) return;
        if (selected) next.add(t.id); else next.delete(t.id);
      });
      return next;
    });
  };

  const clearSelection = () => { setSelectedIds(new Set()); setBulkStatusId(''); };

  const applyBulkStatus = async () => {
    if (!user || !bulkStatusId || selectedTasks.length === 0) return;
    const def = bulkOptions.find((d) => d.id === bulkStatusId);
    if (!def) return;
    setBulkSaving(true);
    setBulkMessage(null);
    try {
      const result = await setStatusMany(selectedTasks.map((t) => t.id), bulkStatusId, user.id);
      const changedById = new Map(result.changed.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => changedById.get(t.id) ?? t));
      // Keep the failures selected so they can be retried; release the rest.
      setSelectedIds(new Set(result.failed.map((f) => f.id)));
      setBulkStatusId('');
      if (result.failed.length === 0) {
        setBulkMessage({ tone: 'ok', text: `${result.changed.length} task${result.changed.length === 1 ? '' : 's'} moved to ${def.name}.` });
      } else {
        console.error('Bulk status change failures:', result.failed);
        setBulkMessage({
          tone: 'error',
          text: `${result.changed.length} moved to ${def.name}; ${result.failed.length} couldn't be changed (${result.failed[0].error})`,
        });
      }
    } catch (err) {
      console.error('Bulk status change failed:', err);
      setBulkMessage({ tone: 'error', text: "Couldn't change those tasks. Check your connection and try again." });
    } finally {
      setBulkSaving(false);
    }
  };

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
              <div className="pl-3 pr-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <GroupCheckbox
                    group={group}
                    selectedIds={selectedIds}
                    isSelectable={(t) => !selectableReason(t)}
                    onChange={(checked) => setGroupSelected(group, checked)}
                  />
                  <h3 className="text-sm font-serif font-semibold text-gray-900 truncate">{group.label}</h3>
                </div>
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
                    selectable
                    selected={selectedIds.has(task.id)}
                    selectDisabledReason={selectableReason(task)}
                    onSelectChange={toggleSelected}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {bulkMessage && selectedIds.size === 0 && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100vw-2rem)] rounded-lg px-4 py-2.5 text-sm shadow-lg border ${bulkMessage.tone === 'ok' ? 'bg-white border-gray-200 text-gray-800' : 'bg-red-50 border-red-200 text-red-800'}`}
        >
          <span>{bulkMessage.text}</span>
          <button type="button" onClick={() => setBulkMessage(null)} aria-label="Dismiss" className="ml-3 align-middle text-gray-400 hover:text-gray-700">
            <X className="h-4 w-4 inline" />
          </button>
        </div>
      )}

      {selectedIds.size > 0 && (
        <BulkStatusBar
          count={selectedTasks.length}
          options={bulkOptions}
          value={bulkStatusId}
          onValueChange={setBulkStatusId}
          saving={bulkSaving}
          message={bulkMessage}
          onApply={applyBulkStatus}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

/** Header checkbox for one group: checked, unchecked, or indeterminate for a
 *  partial selection. Only the group's editable tasks count toward "all". */
function GroupCheckbox({
  group,
  selectedIds,
  isSelectable,
  onChange,
}: {
  group: Group;
  selectedIds: Set<string>;
  isSelectable: (task: Task) => boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const eligible = group.tasks.filter(isSelectable);
  const picked = eligible.filter((t) => selectedIds.has(t.id)).length;
  const all = eligible.length > 0 && picked === eligible.length;
  const some = picked > 0 && !all;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      disabled={eligible.length === 0}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={`Select all in ${group.label}`}
      title={eligible.length === 0 ? 'No tasks here that you can change' : undefined}
      className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-brand-dark focus:ring-brand-dark disabled:opacity-40"
    />
  );
}

/**
 * Floating action bar for the current selection. Fixed to the bottom of the
 * viewport rather than sticky inside the page, so it stays reachable while
 * someone scrolls through several hundred rows ticking boxes.
 */
function BulkStatusBar({
  count,
  options,
  value,
  onValueChange,
  saving,
  message,
  onApply,
  onClear,
}: {
  count: number;
  options: TaskStatusDef[];
  value: string;
  onValueChange: (id: string) => void;
  saving: boolean;
  message: { tone: 'ok' | 'error'; text: string } | null;
  onApply: () => void;
  onClear: () => void;
}) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(100vw-2rem)] max-w-2xl">
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl px-4 py-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex items-center justify-between gap-3 sm:justify-start">
          <span className="text-sm font-semibold text-gray-900 whitespace-nowrap">
            {count} selected
          </span>
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <label htmlFor="bulk-status" className="sr-only">Change status to</label>
          <select
            id="bulk-status"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            disabled={saving || options.length === 0}
            className="min-h-[40px] flex-1 sm:flex-none px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark disabled:opacity-50"
          >
            <option value="">{options.length === 0 ? 'No status shared by these lists' : 'Change status to…'}</option>
            {options.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onApply}
            disabled={saving || !value}
            className="min-h-[40px] px-4 py-2 text-sm font-medium text-white bg-brand-dark rounded-md hover:bg-[#05391B] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
        {message && (
          <p className={`text-xs sm:basis-full sm:order-last ${message.tone === 'ok' ? 'text-gray-600' : 'text-red-700'}`}>{message.text}</p>
        )}
      </div>
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
