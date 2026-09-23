import type { Profile, TaskFilter, TaskList, TaskStatusSet } from '../../types';

/**
 * Composable filter bar — Phase 4. Stub with its final prop shape. Controlled:
 * it owns no state beyond open/closed dropdowns and hands the whole TaskFilter
 * back on every change, the way DashboardPage composes its filters today.
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

export function TaskFilters(_props: TaskFiltersProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500">
      Filters — coming soon.
    </div>
  );
}
