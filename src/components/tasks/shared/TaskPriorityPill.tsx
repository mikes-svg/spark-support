import type { TaskPriority } from '../../../types';

export interface TaskPriorityPillProps {
  /** Null renders nothing — most tasks in the imported workspace have no
   *  priority, and an "unset" chip on every row is pure noise. */
  priority: TaskPriority | null | undefined;
  className?: string;
}

const COLORS: Record<TaskPriority, string> = {
  Low: 'bg-gray-100 text-gray-800',
  Medium: 'bg-blue-100 text-blue-800',
  High: 'bg-amber-100 text-amber-800',
  Urgent: 'bg-red-100 text-red-800',
};

export function TaskPriorityPill({ priority, className = '' }: TaskPriorityPillProps) {
  if (!priority) return null;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${COLORS[priority]} ${className}`}
    >
      {priority}
    </span>
  );
}
