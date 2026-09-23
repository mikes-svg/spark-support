import type { TaskStatusType } from '../../../types';

export interface TaskStatusPillProps {
  /** The status label as stored on the task (`task.statusName`). */
  name: string;
  /** Drives the fallback colour. Never style off the label — it's renameable. */
  type: TaskStatusType;
  /** The status set's own hex colour, if it has one. Overrides the fallback. */
  color?: string | null;
  className?: string;
}

/**
 * Fallback palette, keyed by status TYPE so a workspace that renames "To Do" to
 * "Backlog" — or adds a sixth status — still gets a sensible colour with no
 * code change. Matches the tone of StatusBadge in src/components/Badges.tsx.
 */
const TYPE_STYLES: Record<TaskStatusType, string> = {
  scheduled: 'bg-purple-100 text-purple-800 border-purple-200',
  todo: 'bg-gray-100 text-gray-700 border-gray-200',
  active: 'bg-amber-100 text-amber-800 border-amber-200',
  waiting: 'bg-orange-100 text-orange-800 border-orange-200',
  done: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function TaskStatusPill({ name, type, color, className = '' }: TaskStatusPillProps) {
  const base = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap';

  // A set-defined colour wins, tinted into a pill via 8-digit hex alpha rather
  // than a second palette to keep it to one source of truth.
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return (
      <span
        className={`${base} ${className}`}
        style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}
      >
        {name}
      </span>
    );
  }

  return <span className={`${base} ${TYPE_STYLES[type] ?? TYPE_STYLES.todo} ${className}`}>{name}</span>;
}
