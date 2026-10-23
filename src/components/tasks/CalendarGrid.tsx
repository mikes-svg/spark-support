import { Link } from 'react-router-dom';
import type { Profile, Task } from '../../types';
import { isTaskOverdue } from '../../types';
import { Avatar } from '../Avatar';
import { TaskPriorityPill } from './shared/TaskPriorityPill';
import { parseDateOnly, toDateOnly } from '../../lib/dates';

/**
 * Month grid for the calendar view — Phase 4.
 *
 * Every date here is a 'YYYY-MM-DD' string and `month` is 'YYYY-MM'. The grid
 * is built from local y/m/d numbers via `new Date(year, monthIndex, day)` —
 * NOT `new Date(dateStr)` on a 'YYYY-MM-DD' string, which parses as UTC
 * midnight and renders a day early in US timezones (see src/lib/dates.ts).
 */
export interface CalendarGridProps {
  /** The month being shown, as 'YYYY-MM'. */
  month: string;
  tasks: Task[];
  /** Today as 'YYYY-MM-DD', for the highlighted cell and overdue styling. */
  today: string;
  people?: Record<string, Profile>;
  /** Clicking empty space in a day cell — used to open the create dialog. */
  onSelectDate?: (date: string) => void;
  onOpenTask?: (taskId: string) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// A day cell only has room for so many tasks before it needs a "+N more".
const MAX_VISIBLE_PER_DAY = 3;

interface DayCell {
  date: string;
  day: number;
  inMonth: boolean;
}

/** Six full weeks (42 cells) starting on the Sunday on/before the 1st — a
 *  fixed height that never reflows between 4-week Februaries and 6-week
 *  Decembers, and correctly spans a leap-year Feb 29 or any month boundary
 *  because it's plain Date arithmetic, never string parsing. */
function buildGrid(month: string): DayCell[] {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const firstOfMonth = new Date(year, monthIndex, 1);
  const gridStart = new Date(year, monthIndex, 1 - firstOfMonth.getDay());

  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push({ date: toDateOnly(d), day: d.getDate(), inMonth: d.getMonth() === monthIndex });
  }
  return cells;
}

function AssigneeStack({ ids, people }: { ids: string[]; people?: Record<string, Profile> }) {
  const assignees = ids.map((id) => people?.[id]).filter((p): p is Profile => Boolean(p));
  if (assignees.length === 0) return null;
  return (
    <span className="flex -space-x-1.5 flex-shrink-0">
      {assignees.slice(0, 3).map((p) => (
        <Avatar key={p.id} src={p.photoURL} name={p.name} className="h-4 w-4 rounded-full ring-1 ring-white" />
      ))}
      {assignees.length > 3 && (
        <span className="inline-flex items-center justify-center h-4 w-4 rounded-full ring-1 ring-white bg-gray-200 text-[8px] font-semibold text-gray-600">
          +{assignees.length - 3}
        </span>
      )}
    </span>
  );
}

function TaskChip({
  task,
  today,
  people,
  onOpenTask,
}: {
  task: Task;
  today: string;
  people?: Record<string, Profile>;
  onOpenTask?: (taskId: string) => void;
}) {
  const overdue = isTaskOverdue(task, today);
  const body = (
    <span
      className={`flex items-center gap-1 w-full min-w-0 rounded px-1.5 py-1 text-left text-xs truncate transition-colors hover:bg-gray-100 ${
        overdue ? 'text-red-700' : 'text-gray-800'
      }`}
    >
      <span className="truncate flex-1">{task.title}</span>
      <AssigneeStack ids={task.assigneeIds} people={people} />
    </span>
  );

  if (onOpenTask) {
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); onOpenTask(task.id); }} className="block w-full min-h-[28px]">
        {body}
      </button>
    );
  }
  return (
    <Link to={`/tasks/${task.id}`} onClick={(e) => e.stopPropagation()} className="block w-full min-h-[28px]">
      {body}
    </Link>
  );
}

export function CalendarGrid({ month, tasks, today, people, onSelectDate, onOpenTask }: CalendarGridProps) {
  const cells = buildGrid(month);

  const byDate = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.dueDate) continue;
    const list = byDate.get(t.dueDate);
    if (list) list.push(t);
    else byDate.set(t.dueDate, [t]);
  }

  const daysWithTasks = cells.filter((c) => c.inMonth && (byDate.get(c.date)?.length ?? 0) > 0);

  return (
    <div>
      {/* Full month grid — hidden below md, where a 7-column layout is too
          cramped to read a task title, let alone tap one. */}
      <div className="hidden md:block rounded-lg border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
          {WEEKDAY_LABELS.map((w) => (
            <div key={w} className="px-2 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide text-center">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell) => {
            const dayTasks = byDate.get(cell.date) ?? [];
            const visible = dayTasks.slice(0, MAX_VISIBLE_PER_DAY);
            const overflow = dayTasks.length - visible.length;
            const isToday = cell.date === today;
            return (
              <div
                key={cell.date}
                role="button"
                tabIndex={0}
                onClick={() => onSelectDate?.(cell.date)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDate?.(cell.date); } }}
                className={`min-h-[104px] border-b border-r border-gray-100 p-1.5 text-left align-top cursor-pointer hover:bg-gray-50 transition-colors ${
                  cell.inMonth ? 'bg-white' : 'bg-gray-50/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-flex items-center justify-center h-6 w-6 rounded-full text-xs font-medium ${
                      isToday ? 'bg-brand-dark text-white' : cell.inMonth ? 'text-gray-700' : 'text-gray-400'
                    }`}
                  >
                    {cell.day}
                  </span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {visible.map((t) => (
                    <TaskChip key={t.id} task={t} today={today} people={people} onOpenTask={onOpenTask} />
                  ))}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onSelectDate?.(cell.date); }}
                      className="block w-full text-left px-1.5 text-[11px] font-medium text-brand-gold hover:text-yellow-700"
                    >
                      +{overflow} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Agenda list — the calendar's mobile form. A 7-column grid can't carry
          a readable task title at 320px, so under md we drop the grid
          entirely and list only the days that actually have work. */}
      <div className="md:hidden space-y-3">
        {daysWithTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500">
            No tasks due this month.
          </div>
        ) : (
          daysWithTasks.map((cell) => {
            const dayTasks = byDate.get(cell.date) ?? [];
            const isToday = cell.date === today;
            return (
              <div key={cell.date} className="rounded-lg border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => onSelectDate?.(cell.date)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-left min-h-[44px] ${
                    isToday ? 'bg-brand-dark text-white' : 'bg-gray-50 text-gray-700'
                  }`}
                >
                  <span className="text-sm font-medium">
                    {parseDateOnly(cell.date)?.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  <span className="text-xs">{dayTasks.length} task{dayTasks.length === 1 ? '' : 's'}</span>
                </button>
                <div className="divide-y divide-gray-100">
                  {dayTasks.map((t) => {
                    const overdue = isTaskOverdue(t, today);
                    const openTask = () => (onOpenTask ? onOpenTask(t.id) : undefined);
                    const rowClass = 'flex items-center gap-2 w-full min-h-[44px] px-3 py-2 text-left hover:bg-gray-50 transition-colors';
                    const rowContent = (
                      <>
                        <span className={`flex-1 min-w-0 truncate text-sm ${overdue ? 'text-red-600 font-medium' : 'text-gray-900'}`}>
                          {t.title}
                        </span>
                        <TaskPriorityPill priority={t.priority} />
                        <AssigneeStack ids={t.assigneeIds} people={people} />
                      </>
                    );
                    return onOpenTask ? (
                      <button key={t.id} type="button" onClick={openTask} className={rowClass}>
                        {rowContent}
                      </button>
                    ) : (
                      <Link key={t.id} to={`/tasks/${t.id}`} className={rowClass}>
                        {rowContent}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
