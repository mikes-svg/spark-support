import { useEffect, useRef, useState, type ReactNode } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { ChevronDown, Search, X } from 'lucide-react';
import { db } from '../../lib/firebase';
import { addDaysStr, todayStr } from '../../lib/dates';
import type { Profile, TaskFilter, TaskList, TaskPriority, TaskStatusSet, TaskStatusType, TaskTag } from '../../types';

/**
 * Composable filter bar — Phase 4. Controlled: it owns no state beyond open/
 * closed dropdowns and hands the whole TaskFilter back on every change, the
 * way DashboardPage composes its filters today.
 *
 * Status filtering is offered by TYPE, not by label — the status sets differ
 * per list, so "In Progress" on one list and "Working" on another must land in
 * the same bucket.
 */
export interface TaskFiltersProps {
  value: TaskFilter;
  onChange: (value: TaskFilter) => void;
  lists: TaskList[];
  statusSets: TaskStatusSet[];
  people: Profile[];
  /** Hides controls that don't apply to this surface (e.g. list on a list view). */
  hide?: ('list' | 'space' | 'assignee' | 'status' | 'priority' | 'due' | 'tag' | 'search')[];
}

const STATUS_TYPES: { value: TaskStatusType; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'todo', label: 'To Do' },
  { value: 'active', label: 'Active' },
  { value: 'waiting', label: 'Waiting On' },
  { value: 'done', label: 'Done' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITIES: TaskPriority[] = ['Urgent', 'High', 'Medium', 'Low'];

/** Generic checkbox-list popover shared by the status/assignee/tag/priority
 *  controls below — they're all "pick zero or more from a short list". */
function MultiSelect<T extends string>({
  label,
  options,
  selected,
  onToggle,
  renderOption,
}: {
  label: string;
  options: T[];
  selected: T[];
  onToggle: (value: T) => void;
  renderOption?: (value: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (options.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex items-center gap-1.5 min-h-[44px] sm:min-h-0 px-3 py-2 text-sm border rounded-md bg-white hover:border-gray-400 transition-colors ${
          selected.length > 0 ? 'border-brand-dark text-brand-dark font-medium' : 'border-gray-300 text-gray-700'
        }`}
      >
        {label}
        {selected.length > 0 && (
          <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-brand-dark text-white text-[10px]">
            {selected.length}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-64 overflow-y-auto min-w-[200px]">
          {options.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onToggle(opt)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-left min-h-[44px] sm:min-h-0"
              >
                <span
                  className={`w-4 h-4 rounded border flex-shrink-0 ${checked ? 'bg-brand-dark border-brand-dark' : 'border-gray-300'}`}
                />
                <span className="truncate text-gray-900">{renderOption ? renderOption(opt) : opt}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TaskFilters({ value, onChange, lists, statusSets, people, hide = [] }: TaskFiltersProps) {
  // Space and tag names aren't in this bar's props (the foundation's pinned
  // signature only carries lists/statusSets/people), so the two names-only
  // lookups load themselves here rather than widening the contract.
  const [spaceNames, setSpaceNames] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<TaskTag[]>([]);

  useEffect(() => {
    if (!db) return;
    getDocs(collection(db, 'taskSpaces'))
      .then((snap) => {
        const map: Record<string, string> = {};
        snap.docs.forEach((d) => { map[d.id] = (d.data() as { name?: string }).name ?? d.id; });
        setSpaceNames(map);
      })
      .catch(() => {});
    getDocs(collection(db, 'taskTags'))
      .then((snap) => setTags(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskTag))))
      .catch(() => {});
  }, []);

  const show = (key: NonNullable<TaskFiltersProps['hide']>[number]) => !hide.includes(key);
  const patch = (p: Partial<TaskFilter>) => onChange({ ...value, ...p });

  // Spaces come from the spaces collection, NOT from lists.
  //
  // Deriving them from `lists.map(l => l.spaceId)` meant a space with no lists
  // in it yet contributed nothing, so creating a second space and looking for a
  // way to switch to it found nothing at all — the control stayed hidden
  // because, as far as it could tell, only one space existed.
  // `spaceNames` is already every space in the workspace; use its keys, and
  // fall back to the lists only if that load has not landed yet.
  const spaceIds = (Object.keys(spaceNames).length > 0
    ? Object.keys(spaceNames)
    : [...new Set(lists.map((l) => l.spaceId))]
  ).sort((a, b) => (spaceNames[a] ?? a).localeCompare(spaceNames[b] ?? b));
  const sortedLists = [...lists].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sortedPeople = [...people].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const tagIds = tags.map((t) => t.id);
  const assigneeIds = sortedPeople.map((p) => p.id);
  // All status defs across every set, deduped by type — the bar filters by
  // TYPE (see module doc), never by the per-list label.
  const statusTypesInUse = new Set<TaskStatusType>();
  statusSets.forEach((s) => s.statuses.forEach((d) => statusTypesInUse.add(d.type)));
  const statusOptions = STATUS_TYPES.filter((s) => statusTypesInUse.has(s.value));

  // done/closed and scheduled tasks are hidden by listTasks() unless
  // includeDone/includeScheduled are set — so selecting those TYPES here has
  // to flip the matching flag, or the rows would never come back.
  const toggleStatusType = (t: TaskStatusType) => {
    const current = value.statusTypes ?? [];
    const next = current.includes(t) ? current.filter((v) => v !== t) : [...current, t];
    patch({
      statusTypes: next,
      includeDone: next.some((v) => v === 'done' || v === 'closed') || value.includeDone,
      includeScheduled: next.includes('scheduled') || value.includeScheduled,
    });
  };

  const toggleAssignee = (id: string) => {
    const current = value.assigneeIds ?? [];
    patch({ assigneeIds: current.includes(id) ? current.filter((v) => v !== id) : [...current, id] });
  };
  const toggleTag = (id: string) => {
    const current = value.tagIds ?? [];
    patch({ tagIds: current.includes(id) ? current.filter((v) => v !== id) : [...current, id] });
  };
  const togglePriority = (p: TaskPriority) => {
    const current = value.priorities ?? [];
    patch({ priorities: current.includes(p) ? current.filter((v) => v !== p) : [...current, p] });
  };

  const yesterday = addDaysStr(todayStr(), -1);
  const overdueOnly = value.dueTo === yesterday && !value.dueFrom;
  const toggleOverdueOnly = () => {
    patch(overdueOnly ? { dueTo: null } : { dueFrom: null, dueTo: yesterday });
  };

  const anyActive =
    Boolean(value.listId) ||
    Boolean(value.spaceId) ||
    (value.assigneeIds ?? []).length > 0 ||
    (value.statusTypes ?? []).length > 0 ||
    (value.tagIds ?? []).length > 0 ||
    (value.priorities ?? []).length > 0 ||
    Boolean(value.dueFrom) ||
    Boolean(value.dueTo) ||
    Boolean(value.search);

  const clearAll = () =>
    onChange({
      spaceId: null,
      listId: null,
      assigneeIds: [],
      statusTypes: [],
      tagIds: [],
      priorities: [],
      dueFrom: null,
      dueTo: null,
      includeDone: false,
      includeScheduled: false,
      search: '',
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {show('search') && (
        <div className="relative flex-1 min-w-[160px] sm:min-w-[220px] sm:flex-none">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={value.search ?? ''}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Search titles…"
            aria-label="Search tasks"
            className="w-full min-h-[44px] sm:min-h-0 pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
          />
        </div>
      )}

      {show('space') && spaceIds.length > 1 && (
        <select
          value={value.spaceId ?? ''}
          onChange={(e) => patch({ spaceId: e.target.value || null, listId: null })}
          aria-label="Filter by space"
          className="min-h-[44px] sm:min-h-0 px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
        >
          <option value="">All spaces</option>
          {spaceIds.map((id) => (
            <option key={id} value={id}>{spaceNames[id] ?? id}</option>
          ))}
        </select>
      )}

      {show('list') && lists.length > 0 && (
        <select
          value={value.listId ?? ''}
          onChange={(e) => patch({ listId: e.target.value || null })}
          aria-label="Filter by list"
          className="min-h-[44px] sm:min-h-0 px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
        >
          <option value="">All lists</option>
          {sortedLists
            .filter((l) => !value.spaceId || l.spaceId === value.spaceId)
            .map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
        </select>
      )}

      {show('status') && (
        <MultiSelect
          label="Status"
          options={statusOptions.map((s) => s.value)}
          selected={value.statusTypes ?? []}
          onToggle={toggleStatusType}
          renderOption={(v) => statusOptions.find((s) => s.value === v)?.label ?? v}
        />
      )}

      {show('assignee') && (
        <MultiSelect
          label="Assignee"
          options={assigneeIds}
          selected={value.assigneeIds ?? []}
          onToggle={toggleAssignee}
          renderOption={(id) => people.find((p) => p.id === id)?.name ?? id}
        />
      )}

      {show('priority') && (
        <MultiSelect
          label="Priority"
          options={PRIORITIES}
          selected={value.priorities ?? []}
          onToggle={togglePriority}
        />
      )}

      {show('tag') && (
        <MultiSelect
          label="Tag"
          options={tagIds}
          selected={value.tagIds ?? []}
          onToggle={toggleTag}
          renderOption={(id) => tags.find((t) => t.id === id)?.name ?? id}
        />
      )}

      {show('due') && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={overdueOnly ? '' : (value.dueFrom ?? '')}
            disabled={overdueOnly}
            onChange={(e) => patch({ dueFrom: e.target.value || null })}
            aria-label="Due from"
            className="min-h-[44px] sm:min-h-0 px-2 py-2 text-sm border border-gray-300 rounded-md bg-white disabled:bg-gray-100 focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
          />
          <span className="text-xs text-gray-400">–</span>
          <input
            type="date"
            value={overdueOnly ? '' : (value.dueTo ?? '')}
            disabled={overdueOnly}
            onChange={(e) => patch({ dueTo: e.target.value || null })}
            aria-label="Due to"
            className="min-h-[44px] sm:min-h-0 px-2 py-2 text-sm border border-gray-300 rounded-md bg-white disabled:bg-gray-100 focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
          />
          <label className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 text-sm text-gray-700 whitespace-nowrap">
            <input type="checkbox" checked={overdueOnly} onChange={toggleOverdueOnly} className="h-4 w-4 rounded border-gray-300 text-brand-dark focus:ring-brand-dark" />
            Overdue only
          </label>
        </div>
      )}

      {anyActive && (
        <button
          type="button"
          onClick={clearAll}
          className="flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 text-sm text-brand-gold hover:text-yellow-700 font-medium whitespace-nowrap"
        >
          <X className="h-3.5 w-3.5" />
          Clear filters
        </button>
      )}
    </div>
  );
}
