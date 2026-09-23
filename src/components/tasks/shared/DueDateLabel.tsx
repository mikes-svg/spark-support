import { isTaskOverdue } from '../../../types';
import type { TaskStatusType } from '../../../types';
import { diffDaysStr, formatDateOnly } from '../../../lib/dates';

export interface DueDateLabelProps {
  /** 'YYYY-MM-DD' or null. NEVER pass a Date — see src/lib/dates.ts. */
  dueDate: string | null | undefined;
  /** Today as 'YYYY-MM-DD' (`todayStr()`), passed in so a whole list renders
   *  against one consistent day and doesn't drift mid-render at midnight. */
  today: string;
  /** Overdue styling is suppressed for done/closed and not-yet-live tasks. */
  statusType: TaskStatusType;
  /** Optional 'HH:mm' appended for timed tasks. */
  dueTime?: string | null;
  /** Renders an em dash instead of nothing when there's no due date. */
  showEmpty?: boolean;
  className?: string;
}

/** "3 days overdue" / "today" / "in 2 days" — the wording used on the
 *  onboarding checklist, so the two task surfaces read the same. */
function hint(dueDate: string, today: string): string {
  const diff = diffDaysStr(today, dueDate);
  if (diff == null) return '';
  if (diff === 0) return 'today';
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} overdue`;
  if (diff <= 7) return `in ${diff} day${diff === 1 ? '' : 's'}`;
  return '';
}

export function DueDateLabel({
  dueDate,
  today,
  statusType,
  dueTime,
  showEmpty = false,
  className = '',
}: DueDateLabelProps) {
  if (!dueDate) return showEmpty ? <span className={`text-sm text-gray-400 ${className}`}>—</span> : null;

  const overdue = isTaskOverdue({ statusType, dueDate }, today);
  const note = hint(dueDate, today);

  return (
    <span className={`inline-flex items-baseline gap-1.5 text-sm whitespace-nowrap ${className}`}>
      <span className={overdue ? 'font-medium text-red-600' : 'text-gray-700'}>
        {formatDateOnly(dueDate)}
        {dueTime ? ` ${dueTime}` : ''}
      </span>
      {note && (
        <span className={`text-xs ${overdue ? 'text-red-600' : 'text-gray-500'}`}>{note}</span>
      )}
    </span>
  );
}
