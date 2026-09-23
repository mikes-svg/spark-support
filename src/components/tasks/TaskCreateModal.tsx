import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Profile, Task, TaskList, TaskStatusSet } from '../../types';
import { defaultStatusFor } from '../../lib/taskStatuses';
import { createTask } from '../../lib/tasks';
import { useAuth } from '../../context/AuthContext';
import { Modal } from '../Modal';
import { AssigneeSelector } from '../AssigneeSelector';
import { SubtaskEditor } from './SubtaskEditor';
import { serializeTaskDescription, textToTaskDoc } from './TaskEditor';
import type { Subtask } from '../../types';

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

const emptySubtasks: Subtask[] = [];

export function TaskCreateModal({
  open,
  onClose,
  lists,
  statusSets,
  people,
  defaultListId = null,
  defaultDueDate = null,
  onCreated,
}: TaskCreateModalProps) {
  const { user } = useAuth();
  const activeLists = lists.filter((l) => !l.archived).sort((a, b) => a.order - b.order);

  const [listId, setListId] = useState(defaultListId ?? activeLists[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Task['priority']>(null);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState(defaultDueDate ?? '');
  const [subtasks, setSubtasks] = useState<Subtask[]>(emptySubtasks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset the form each time the dialog opens rather than on every render.
  useEffect(() => {
    if (!open) return;
    setListId(defaultListId ?? activeLists[0]?.id ?? '');
    setTitle('');
    setDescription('');
    setPriority(null);
    setAssigneeIds([]);
    setDueDate(defaultDueDate ?? '');
    setSubtasks(emptySubtasks);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedList = activeLists.find((l) => l.id === listId);
  const statusSet = selectedList
    ? statusSets.find((s) => s.id === selectedList.defaultStatusSetId) ?? statusSets[0] ?? null
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || !listId || !selectedList || !user || saving) return;

    setSaving(true);
    setError('');
    try {
      const def = defaultStatusFor(statusSet);
      const task = await createTask({
        listId,
        spaceId: selectedList.spaceId,
        title: trimmed,
        creatorId: user.id,
        description: description.trim() ? serializeTaskDescription(textToTaskDoc(description)) : '',
        priority,
        assigneeIds,
        watcherIds: [],
        dueDate: dueDate || null,
        subtasks,
        ...(def ? { statusId: def.id, statusName: def.name, statusType: def.type } : {}),
      });
      onCreated(task);
      onClose();
    } catch (err) {
      console.error('Failed to create task:', err);
      setError(err instanceof Error ? err.message : 'Failed to create the task. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="task-create-title" widthClass="max-w-lg">
      <form onSubmit={handleSubmit}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 id="task-create-title" className="text-lg font-serif font-semibold text-gray-900">New Task</h3>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

          <div>
            <label htmlFor="task-title" className="block text-xs font-medium text-gray-500 uppercase mb-1">Title</label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2.5"
            />
          </div>

          <div>
            <label htmlFor="task-list" className="block text-xs font-medium text-gray-500 uppercase mb-1">List</label>
            {activeLists.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No lists exist yet — ask an admin to create one in Task Settings.</p>
            ) : (
              <select
                id="task-list"
                value={listId}
                onChange={(e) => setListId(e.target.value)}
                required
                className="block w-full pl-3 pr-8 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              >
                {activeLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="task-description" className="block text-xs font-medium text-gray-500 uppercase mb-1">Description</label>
            <textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2.5 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="task-priority" className="block text-xs font-medium text-gray-500 uppercase mb-1">Priority</label>
              <select
                id="task-priority"
                value={priority ?? ''}
                onChange={(e) => setPriority((e.target.value || null) as Task['priority'])}
                className="block w-full pl-3 pr-8 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              >
                <option value="">None</option>
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label htmlFor="task-due" className="block text-xs font-medium text-gray-500 uppercase mb-1">Due date</label>
              <input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="block w-full pl-3 pr-3 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              />
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Assignees</span>
            <AssigneeSelector value={assigneeIds} onChange={setAssigneeIds} admins={people} variant="full" placeholder="Unassigned" />
          </div>

          <div>
            <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Subtasks</span>
            <SubtaskEditor
              subtasks={subtasks}
              canEdit
              people={people}
              onToggle={(id, done) => setSubtasks((prev) => prev.map((s) => (s.id === id ? { ...s, done } : s)))}
              onChange={setSubtasks}
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || !listId || saving}
            className="px-5 py-2 text-sm font-medium rounded-lg text-white bg-brand-dark hover:bg-[#05391B] disabled:opacity-50 transition-colors"
          >
            {saving ? 'Creating…' : 'Create Task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
