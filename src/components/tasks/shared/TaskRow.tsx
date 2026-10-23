import { Link } from 'react-router-dom';
import { Repeat, MessageSquare } from 'lucide-react';
import type { Profile, Task, TaskTag } from '../../../types';
import { isTaskDone } from '../../../types';
import { Avatar } from '../../Avatar';
import { TaskStatusPill } from './TaskStatusPill';
import { TaskPriorityPill } from './TaskPriorityPill';
import { TaskTagPill } from './TaskTagPill';
import { SubtaskProgress } from './SubtaskProgress';
import { DueDateLabel } from './DueDateLabel';

export interface TaskRowProps {
  task: Task;
  /** Today as 'YYYY-MM-DD' (`todayStr()`) — one value for the whole list. */
  today: string;
  /** Profiles by id, for assignee avatars. Ids with no profile are skipped. */
  people?: Record<string, Profile>;
  /** Tags by id. Only the task's own tagIds are rendered. */
  tags?: Record<string, TaskTag>;
  /** Secondary context under the title, e.g. the list or space name. */
  contextLabel?: string;
  /** Destination for the row. Defaults to the task detail page. */
  to?: string;
  /** When given, the row becomes a button and calls this instead of navigating
   *  — for pickers and calendar popovers that open a task in place. */
  onOpen?: (taskId: string) => void;
  /** `compact` drops the context line and the progress bar for dense views. */
  variant?: 'default' | 'compact';
  className?: string;
}

/**
 * One task as a list row. Purely presentational: it never reads Firestore and
 * never mutates, so My Tasks, Team Tasks, the calendar, and the workload page
 * can all render the same row without agreeing on a data-loading strategy.
 *
 * Tap target is at least 44px tall on every variant — these lists get used on
 * phones far more than the ticket tables do.
 */
export function TaskRow({
  task,
  today,
  people,
  tags,
  contextLabel,
  to,
  onOpen,
  variant = 'default',
  className = '',
}: TaskRowProps) {
  const compact = variant === 'compact';
  const done = isTaskDone(task);
  const assignees = (task.assigneeIds ?? [])
    .map((id) => people?.[id])
    .filter((p): p is Profile => Boolean(p));
  const rowTags = (task.tagIds ?? [])
    .map((id) => tags?.[id])
    .filter((t): t is TaskTag => Boolean(t));

  const body = (
    <div className="flex items-center gap-3 w-full min-h-[44px] px-4 py-2.5 text-left">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`truncate text-sm font-medium ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}
          >
            {task.title}
          </span>
          {task.seriesId && (
            <Repeat className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-label="Recurring" />
          )}
          {task.waitingOnUserId && people?.[task.waitingOnUserId] && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-orange-700">
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {people[task.waitingOnUserId].name}
            </span>
          )}
        </div>
        {!compact && (contextLabel || rowTags.length > 0) && (
          <div className="mt-1 flex items-center gap-2 min-w-0">
            {contextLabel && <span className="truncate text-xs text-gray-500">{contextLabel}</span>}
            {rowTags.map((tag) => (
              <TaskTagPill key={tag.id} tag={tag} />
            ))}
          </div>
        )}
      </div>

      <SubtaskProgress subtasks={task.subtasks} compact={compact} className="hidden sm:inline-flex" />
      <DueDateLabel
        dueDate={task.dueDate}
        dueTime={task.dueTime}
        today={today}
        statusType={task.statusType}
        className="hidden sm:inline-flex"
      />
      <TaskPriorityPill priority={task.priority} className="hidden md:inline-flex" />
      <TaskStatusPill name={task.statusName} type={task.statusType} />

      {assignees.length > 0 && (
        <span className="flex -space-x-1.5 flex-shrink-0">
          {assignees.slice(0, 3).map((p) => (
            <Avatar
              key={p.id}
              src={p.photoURL}
              name={p.name}
              className="h-6 w-6 rounded-full ring-2 ring-white"
            />
          ))}
          {assignees.length > 3 && (
            <span className="inline-flex items-center justify-center h-6 w-6 rounded-full ring-2 ring-white bg-gray-200 text-[10px] font-semibold text-gray-600">
              +{assignees.length - 3}
            </span>
          )}
        </span>
      )}
    </div>
  );

  const shell = `block w-full rounded-lg hover:bg-gray-50 transition-colors ${className}`;

  if (onOpen) {
    return (
      <button type="button" onClick={() => onOpen(task.id)} className={shell}>
        {body}
      </button>
    );
  }
  return (
    <Link to={to ?? `/tasks/${task.id}`} className={shell}>
      {body}
    </Link>
  );
}
