/**
 * Task detail — Phase 1 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Modelled on src/pages/TicketDetailPage.tsx: inline edit with optimistic
 * update + rollback + an actionError banner, comments and activity in the
 * right rail, attachments below. The comments, activity, attachments, editor,
 * and subtask components already exist as typed stubs under
 * src/components/tasks/ — wired here rather than inlining their markup.
 */
import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { collection, getDocs } from 'firebase/firestore';
import { ArrowLeft, Trash2, ListChecks, MessageSquare, Activity, Paperclip, Repeat } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { PageSpinner } from '../components/PageSpinner';
import { ConfirmModal } from '../components/ConfirmModal';
import { TaskEditor } from '../components/tasks/TaskEditor';
import { SubtaskEditor } from '../components/tasks/SubtaskEditor';
import { TaskComments } from '../components/tasks/TaskComments';
import { TaskActivity } from '../components/tasks/TaskActivity';
import { TaskAttachments } from '../components/tasks/TaskAttachments';
import { getTask, updateTask, deleteTask, setStatus, toggleSubtask, canEditTask, TASK_LISTS } from '../lib/tasks';
import { getOrSeedStatusSets } from '../lib/taskStatuses';
import { isSuperadminRole } from '../types';
import type { Profile, Task, TaskList, TaskStatusSet } from '../types';

type Tab = 'comments' | 'activity' | 'attachments';

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [actionError, setActionError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tab, setTab] = useState<Tab>('comments');

  useEffect(() => {
    if (!id || !db) { setLoading(false); return; }
    let cancelled = false;

    async function load() {
      try {
        const [taskData, listsSnap, sets, peopleSnap] = await Promise.all([
          getTask(id!),
          getDocs(collection(db!, TASK_LISTS)),
          getOrSeedStatusSets(),
          getDocs(collection(db!, 'profiles')),
        ]);
        if (cancelled) return;
        if (!taskData) { setNotFound(true); return; }
        setTask(taskData);
        setLists(listsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskList)));
        setStatusSets(sets);
        setPeople(peopleSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
      } catch (err) {
        console.error('Failed to load task:', err);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <PageSpinner />;
  if (notFound || !task) {
    return (
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
        <ListChecks className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Task not found</h2>
        <Link to="/tasks" className="mt-5 inline-flex items-center px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] transition-colors">
          Back to My Tasks
        </Link>
      </div>
    );
  }

  const list = lists.find((l) => l.id === task.listId);
  const statusSet = list
    ? statusSets.find((s) => s.id === list.defaultStatusSetId) ?? statusSets[0] ?? null
    : statusSets[0] ?? null;
  const canEdit = canEditTask(user?.id, task, user);
  const canDelete = Boolean(user) && (task.creatorId === user!.id || isSuperadminRole(user!.role));

  /**
   * TaskEditor emits a plain patch for every field. A status change is routed
   * through setStatus (not updateTask) so the label/type resolve off the set
   * and the transition gets its audit event, same contract src/lib/tasks.ts
   * documents. Everything else is a direct optimistic updateTask.
   */
  const handleEditorChange = async (patch: Partial<Task>) => {
    if (!task || !user) return;
    const prev = task;

    if ('statusId' in patch && patch.statusId) {
      const def = statusSet?.statuses.find((s) => s.id === patch.statusId);
      // Optimistic: reflect the new status immediately; setStatus resolves and
      // persists the authoritative label/type/completedAt server-round-trip.
      if (def) setTask({ ...task, statusId: def.id, statusName: def.name, statusType: def.type });
      try {
        await setStatus(task.id, patch.statusId, user.id);
        const fresh = await getTask(task.id);
        if (fresh) setTask(fresh);
      } catch (err) {
        console.error('Failed to change status:', err);
        setTask(prev);
        setActionError('Failed to change status. Please try again.');
      }
      return;
    }

    setTask({ ...task, ...patch } as Task);
    try {
      await updateTask(task.id, patch);
      setActionError('');
    } catch (err) {
      console.error('Failed to update task:', err);
      setTask(prev);
      setActionError('Failed to save your change. Please try again.');
    }
  };

  const handleSubtaskToggle = async (subtaskId: string, done: boolean) => {
    if (!task || !user) return;
    const prev = task;
    setTask({
      ...task,
      subtasks: task.subtasks.map((s) => (s.id === subtaskId ? { ...s, done } : s)),
    });
    try {
      await toggleSubtask(task.id, subtaskId, done, user.id);
    } catch (err) {
      console.error('Failed to toggle subtask:', err);
      setTask(prev);
      setActionError('Failed to update the subtask. Please try again.');
    }
  };

  const handleSubtasksChange = async (subtasks: Task['subtasks']) => {
    if (!task) return;
    const prev = task;
    setTask({ ...task, subtasks });
    try {
      await updateTask(task.id, { subtasks });
      setActionError('');
    } catch (err) {
      console.error('Failed to save subtasks:', err);
      setTask(prev);
      setActionError('Failed to save subtasks. Please try again.');
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setShowDeleteConfirm(false);
    try {
      await deleteTask(task.id);
      navigate('/tasks');
    } catch (err) {
      console.error('Failed to delete task:', err);
      setActionError('Failed to delete the task. Please try again.');
    }
  };

  const TABS: { key: Tab; label: string; icon: typeof MessageSquare }[] = [
    { key: 'comments', label: 'Comments', icon: MessageSquare },
    { key: 'activity', label: 'Activity', icon: Activity },
    { key: 'attachments', label: 'Attachments', icon: Paperclip },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/tasks" className="p-2 text-gray-400 hover:text-gray-600 bg-white rounded-full shadow-sm border border-gray-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            {list && <span className="truncate">{list.name}</span>}
            {task.seriesId && (
              <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" />Recurring</span>
            )}
          </div>
        </div>
        {canDelete && (
          <button onClick={() => setShowDeleteConfirm(true)} className="p-2 text-red-400 hover:text-red-600 bg-white rounded-full shadow-sm border border-gray-200 transition-colors" title="Delete task">
            <Trash2 className="w-5 h-5" />
          </button>
        )}
      </div>

      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3" role="alert">
          {actionError}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0 space-y-6">
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6">
            <TaskEditor
              key={task.id}
              task={task}
              canEdit={canEdit}
              lists={lists}
              statusSet={statusSet}
              people={people}
              onChange={handleEditorChange}
            />
          </div>

          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Subtasks</h3>
            </div>
            <div className="p-6">
              <SubtaskEditor
                subtasks={task.subtasks}
                canEdit={canEdit}
                people={people}
                onToggle={handleSubtaskToggle}
                onChange={handleSubtasksChange}
              />
            </div>
          </div>
        </div>

        <div className="w-full lg:w-96 space-y-4">
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex border-b border-gray-200">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                    tab === key ? 'border-brand-dark text-brand-dark' : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === 'comments' && <TaskComments taskId={task.id} canComment={canEdit} />}
              {tab === 'activity' && <TaskActivity taskId={task.id} />}
              {tab === 'attachments' && <TaskAttachments taskId={task.id} canEdit={canEdit} />}
            </div>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete Task"
        message="Permanently delete this task? Comments, activity, and attachments are not removed automatically. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
