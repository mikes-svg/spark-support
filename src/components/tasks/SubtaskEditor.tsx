import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, GitBranch } from 'lucide-react';
import type { Profile, Subtask } from '../../types';
import { AssigneeSelector } from '../AssigneeSelector';

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

let localIdSeq = 0;
/** A client-local id good enough to key a fresh row before the parent's
 *  persisted write comes back — the parent always owns the array's contents. */
function localId(): string {
  localIdSeq += 1;
  return `local-${Date.now()}-${localIdSeq}`;
}

/** Re-derive contiguous 0..n-1 order after any structural edit, so a later
 *  recurrence copy reads a meaningful template rather than gappy numbers. */
function reindex(items: Subtask[]): Subtask[] {
  return items.map((s, i) => ({ ...s, order: i }));
}

export function SubtaskEditor({ subtasks, canEdit, people, onToggle, onChange }: SubtaskEditorProps) {
  const [newTitle, setNewTitle] = useState('');
  const [openAssigneeId, setOpenAssigneeId] = useState<string | null>(null);

  const sorted = [...subtasks].sort((a, b) => a.order - b.order);
  const done = sorted.filter((s) => s.done).length;

  const commit = (next: Subtask[]) => onChange(reindex(next));

  const handleAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    const item: Subtask = { id: localId(), title, done: false, order: sorted.length };
    commit([...sorted, item]);
    setNewTitle('');
  };

  const handleRename = (id: string, title: string) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, title } : s)));
  };

  const handleDelete = (id: string) => {
    commit(sorted.filter((s) => s.id !== id));
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    const idx = sorted.findIndex((s) => s.id === id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    commit(next);
  };

  const handleAssigneesChange = (id: string, ids: string[]) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, assigneeIds: ids } : s)));
  };

  const handleDueDateChange = (id: string, dueDate: string) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, dueDate: dueDate || null } : s)));
  };

  return (
    <div className="space-y-2">
      {sorted.length > 0 && (
        <p className="text-xs font-medium text-gray-500">
          {done}/{sorted.length} complete
        </p>
      )}

      {sorted.length === 0 && !canEdit && (
        <p className="text-sm text-gray-400 italic py-2">No subtasks.</p>
      )}

      <ul className="space-y-1">
        {sorted.map((s, idx) => {
          const carried = Boolean(s.carriedFromTaskId);
          const assignees = (s.assigneeIds ?? [])
            .map((id) => people?.find((p) => p.id === id))
            .filter((p): p is Profile => Boolean(p));
          return (
            <li
              key={s.id}
              className={`group rounded-lg border px-3 py-2 ${carried ? 'border-dashed border-amber-300 bg-amber-50/50' : 'border-transparent hover:border-gray-200 hover:bg-gray-50'}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.done}
                  disabled={!canEdit}
                  onChange={(e) => onToggle(s.id, e.target.checked)}
                  className="h-5 w-5 min-w-[20px] rounded border-gray-300 text-brand-dark focus:ring-brand-dark disabled:opacity-50"
                  aria-label={s.done ? `Mark "${s.title}" incomplete` : `Mark "${s.title}" complete`}
                />
                {canEdit ? (
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => handleRename(s.id, e.target.value)}
                    className={`flex-1 min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0 ${s.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}
                  />
                ) : (
                  <span className={`flex-1 min-w-0 truncate text-sm ${s.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                    {s.title}
                  </span>
                )}
                {carried && (
                  <span title="Carried over from a previous occurrence" className="inline-flex items-center gap-1 flex-shrink-0 text-[10px] font-medium text-amber-700">
                    <GitBranch className="h-3 w-3" />
                    carried
                  </span>
                )}
                {canEdit && (
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button type="button" onClick={() => handleMove(s.id, -1)} disabled={idx === 0} title="Move up" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => handleMove(s.id, 1)} disabled={idx === sorted.length - 1} title="Move down" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => handleDelete(s.id)} title="Delete subtask" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {(canEdit || assignees.length > 0 || s.dueDate) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                  {canEdit && people && people.length > 0 ? (
                    <div className="relative w-40">
                      <button
                        type="button"
                        onClick={() => setOpenAssigneeId(openAssigneeId === s.id ? null : s.id)}
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >
                        {assignees.length > 0 ? assignees.map((a) => a.name.split(' ')[0]).join(', ') : '+ assignee'}
                      </button>
                      {openAssigneeId === s.id && (
                        <div className="absolute z-10 mt-1 w-56">
                          <AssigneeSelector
                            value={s.assigneeIds ?? []}
                            onChange={(ids) => handleAssigneesChange(s.id, ids)}
                            admins={people}
                            variant="compact"
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    assignees.length > 0 && (
                      <span className="text-xs text-gray-500">{assignees.map((a) => a.name).join(', ')}</span>
                    )
                  )}
                  {canEdit ? (
                    <input
                      type="date"
                      value={s.dueDate ?? ''}
                      onChange={(e) => handleDueDateChange(s.id, e.target.value)}
                      className="text-xs border-0 bg-transparent p-0 text-gray-500 focus:ring-0"
                    />
                  ) : (
                    s.dueDate && <span className="text-xs text-gray-500">Due {s.dueDate}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canEdit && (
        // A plain div, not a <form>: this editor is itself embedded inside
        // TaskDetailPage's page chrome and TaskCreateModal's create form, and
        // HTML forbids nesting <form> elements — a nested one gets silently
        // flattened by the parser and Enter here would submit the WRONG form.
        <div className="flex items-center gap-2 pt-1">
          <Plus className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
            }}
            placeholder="Add a subtask…"
            className="flex-1 min-w-0 border-0 border-b border-transparent bg-transparent p-0 text-sm placeholder:text-gray-400 focus:border-brand-dark focus:ring-0"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newTitle.trim()}
            className="px-2.5 py-1 text-xs font-medium text-brand-dark disabled:opacity-40 disabled:cursor-not-allowed hover:text-[#05391B]"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
