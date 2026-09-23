import type { Profile, Task, TaskList, TaskStatusSet } from '../../types';

/**
 * New-task dialog — Phase 1. Stub with its final prop shape. Build it on the
 * shared Modal shell (src/components/Modal.tsx) so it inherits the focus trap
 * and Escape handling; call createTask, then hand the created task back so the
 * caller can insert it optimistically instead of refetching the list.
 */
export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  lists: TaskList[];
  statusSets: TaskStatusSet[];
  people: Profile[];
  /** Preselects a list (and its space) when opened from inside one. */
  defaultListId?: string | null;
  /** Prefills the due date when opened from a calendar cell ('YYYY-MM-DD'). */
  defaultDueDate?: string | null;
  onCreated: (task: Task) => void;
}

export function TaskCreateModal(_props: TaskCreateModalProps) {
  return null;
}
