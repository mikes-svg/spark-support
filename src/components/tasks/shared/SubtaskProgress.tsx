import type { Subtask } from '../../../types';

export interface SubtaskProgressProps {
  subtasks: Subtask[] | null | undefined;
  /** Hide the bar and show only "2/5" — for dense table rows. */
  compact?: boolean;
  className?: string;
}

/** Checklist completion. Renders nothing when a task has no subtasks, so rows
 *  without a checklist don't carry an empty "0/0". */
export function SubtaskProgress({ subtasks, compact = false, className = '' }: SubtaskProgressProps) {
  const items = subtasks ?? [];
  if (items.length === 0) return null;

  const done = items.filter((s) => s.done).length;
  const pct = Math.round((done / items.length) * 100);
  const complete = done === items.length;

  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      title={`${done} of ${items.length} subtasks complete`}
    >
      <span className={`text-xs font-medium tabular-nums ${complete ? 'text-emerald-700' : 'text-gray-500'}`}>
        {done}/{items.length}
      </span>
      {!compact && (
        <span className="inline-block h-1.5 w-16 rounded-full bg-gray-200 overflow-hidden" aria-hidden="true">
          <span
            className={`block h-full rounded-full ${complete ? 'bg-emerald-500' : 'bg-brand-dark'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
    </span>
  );
}
