import type { Profile, Subtask } from '../../types';

/**
 * Checklist editor — Phase 1. Stub with its final prop shape.
 *
 * Toggling is separated from structural edits on purpose: `onToggle` maps to
 * toggleSubtask (one item, one audit event), while `onChange` rewrites the
 * whole array for adds, renames, reorders, and deletes. Recurrence reads this
 * array as its template, so `order` must stay contiguous and meaningful.
 */
export interface SubtaskEditorProps {
  subtasks: Subtask[];
  canEdit: boolean;
  /** For per-subtask assignee chips; omit to hide them. */
  people?: Profile[];
  onToggle: (subtaskId: string, done: boolean) => void | Promise<void>;
  onChange: (subtasks: Subtask[]) => void | Promise<void>;
}

export function SubtaskEditor(_props: SubtaskEditorProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Subtasks — coming soon.
    </div>
  );
}
