import type { TaskTag } from '../../../types';

export interface TaskTagPillProps {
  tag: TaskTag;
  className?: string;
}

/** Small, quiet chip — tags are decoration on a row, not its headline. */
export function TaskTagPill({ tag, className = '' }: TaskTagPillProps) {
  const color = /^#[0-9a-fA-F]{6}$/.test(tag.color || '') ? tag.color : '#6B7280';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border whitespace-nowrap ${className}`}
      style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}
    >
      {tag.name}
    </span>
  );
}
