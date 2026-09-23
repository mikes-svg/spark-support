import type { Profile, Task, TaskList, TaskStatusSet, TaskTag } from '../../types';

/**
 * Inline task editor for the detail page — Phase 1. Stub with its final prop
 * shape.
 *
 * Controlled by the page: it never writes to Firestore itself, it emits a patch
 * and the page does the optimistic update + rollback + actionError banner, the
 * way TicketDetailPage already does. That keeps one error surface per page
 * instead of one per field.
 */
export interface TaskEditorProps {
  task: Task;
  /** From canEditTask(uid, task, profile) — false renders everything read-only. */
  canEdit: boolean;
  lists: TaskList[];
  /** The status set backing this task's list; null while it loads. */
  statusSet: TaskStatusSet | null;
  people: Profile[];
  tags?: TaskTag[];
  /** Emitted per committed field change. The page persists via updateTask. */
  onChange: (patch: Partial<Task>) => void | Promise<void>;
}

export function TaskEditor(_props: TaskEditorProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Task editor — coming soon.
    </div>
  );
}
