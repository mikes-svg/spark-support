import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, query, where, orderBy, getDocs, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ClipboardList, Clock } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { ONBOARDING_STATUSES } from '../types';
import type { OnboardingProperty, OnboardingTask, OnboardingStatus } from '../types';
import { PageSpinner } from '../components/PageSpinner';
import { PostponeModal } from '../components/onboarding/PostponeModal';
import { TASKS, fetchProperties, isOverdue, isTaskDone, deriveDaysFromClosing } from '../lib/onboarding';
import { todayStr, formatDateOnly, diffDaysStr } from '../lib/dates';

const STATUS_STYLES: Record<OnboardingStatus, string> = {
  'Not Started': 'bg-gray-100 text-gray-700 border-gray-200',
  'In Progress': 'bg-amber-100 text-amber-800 border-amber-200',
  Complete: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  'N/A': 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Human hint for a due date relative to today, e.g. "3 days overdue" / "due in 2 days" / "today". */
function dueHint(dueDate: string | null, today: string): string {
  const diff = diffDaysStr(today, dueDate);
  if (diff == null) return '';
  if (diff === 0) return 'today';
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} overdue`;
  return `due in ${diff} day${diff === 1 ? '' : 's'}`;
}

/**
 * A notes cell that edits in place: it keeps a local draft while typing and
 * commits on blur or Enter, so a slow Firestore write never fights the cursor.
 * (Local equivalent of ChecklistTable's EditableText, which isn't exported.)
 */
function EditableNotes({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      className="w-full bg-transparent border border-transparent rounded px-2 py-1 text-sm text-gray-600 hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark"
    />
  );
}

export function OnboardingMyTasksPage() {
  const { user } = useAuth();

  const [tasks, setTasks] = useState<OnboardingTask[]>([]);
  const [properties, setProperties] = useState<Map<string, OnboardingProperty>>(new Map());
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [postponeTarget, setPostponeTarget] = useState<{ task: OnboardingTask; newDate: string | null } | null>(null);

  const today = useMemo(() => todayStr(), []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const props = await fetchProperties();
        const propMap = new Map(props.filter((p) => !p.archived).map((p) => [p.id, p]));

        if (!db) {
          if (!cancelled) { setProperties(propMap); setTasks([]); }
          return;
        }
        const snap = await getDocs(
          query(collection(db, TASKS), where('responsibleIds', 'array-contains', user.id), orderBy('dueDate'))
        );
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as OnboardingTask))
          .filter((t) => propMap.has(t.propertyId));

        if (!cancelled) {
          setProperties(propMap);
          setTasks(rows);
        }
      } catch (err) {
        console.error('Failed to load My Tasks:', err);
        const code = String((err as { code?: string }).code || '');
        if (!cancelled) {
          setActionError(
            code === 'failed-precondition'
              ? 'This view needs a database index that has not finished deploying yet. Please try again shortly.'
              : 'Could not load your tasks. Please refresh.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  /** Optimistically apply a task patch, rolling back if the write fails. */
  const patchTask = async (task: OnboardingTask, patch: Partial<OnboardingTask>) => {
    if (!db) return;
    setActionError('');
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    try {
      await updateDoc(doc(db, TASKS, task.id), { ...patch, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update task:', err);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      setActionError('Could not save that change. Please try again.');
    }
  };

  const handleDueDateChange = (task: OnboardingTask, dueDate: string | null) => {
    if (isOverdue(task, today)) {
      setPostponeTarget({ task, newDate: dueDate });
      return;
    }
    const closingDate = properties.get(task.propertyId)?.closingDate ?? null;
    patchTask(task, { dueDate, daysFromClosing: deriveDaysFromClosing(closingDate, dueDate) });
  };

  const confirmPostpone = async (toDate: string | null, reason: string) => {
    const target = postponeTarget;
    setPostponeTarget(null);
    if (!target || !user) return;
    const { task } = target;
    const closingDate = properties.get(task.propertyId)?.closingDate ?? null;
    const delay = {
      at: new Date().toISOString(),
      byId: user.id,
      fromDate: task.dueDate ?? null,
      toDate,
      reason,
    };
    await patchTask(task, {
      dueDate: toDate,
      daysFromClosing: deriveDaysFromClosing(closingDate, toDate),
      delays: [...(task.delays ?? []), delay],
    });
  };

  const overdueCount = tasks.filter((t) => isOverdue(t, today)).length;
  const dueSoonCount = tasks.filter((t) => {
    if (isTaskDone(t) || !t.dueDate || isOverdue(t, today)) return false;
    const diff = diffDaysStr(today, t.dueDate);
    return diff != null && diff >= 0 && diff <= 7;
  }).length;
  const openCount = tasks.filter((t) => !isTaskDone(t)).length;

  const visibleTasks = showCompleted ? tasks : tasks.filter((t) => !isTaskDone(t));

  // Overdue first (oldest due date first), then dated tasks ascending, then undated last.
  const sortedTasks = [...visibleTasks].sort((a, b) => {
    const aOverdue = isOverdue(a, today);
    const bOverdue = isOverdue(b, today);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
  });

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-6">
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}

      <div>
        <h1 className="text-2xl font-serif font-semibold text-gray-900">My Tasks</h1>
        <p className="mt-1 text-sm text-gray-500">Your onboarding tasks across every property, sorted by urgency.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-medium text-red-600 uppercase tracking-wider">Overdue</p>
          <p className="mt-1 text-2xl font-serif font-semibold text-red-600">{overdueCount}</p>
        </div>
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wider">Due soon</p>
          <p className="mt-1 text-2xl font-serif font-semibold text-amber-600">{dueSoonCount}</p>
        </div>
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Open total</p>
          <p className="mt-1 text-2xl font-serif font-semibold text-gray-900">{openCount}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <label className="inline-flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded border-gray-300 text-brand-dark focus:ring-brand-dark"
          />
          Show completed
        </label>
      </div>

      {sortedTasks.length === 0 ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
          <ClipboardList className="h-10 w-10 mx-auto text-gray-300" />
          <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Nothing assigned to you</h2>
          <p className="mt-1 text-sm text-gray-500">
            {tasks.length === 0
              ? "You're not responsible for any onboarding tasks right now."
              : 'Everything assigned to you is complete. Nice work.'}
          </p>
        </div>
      ) : (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-white">
                <tr>
                  {['Property', 'Task', 'Section', 'Due', 'Status', 'Notes'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedTasks.map((task) => {
                  const property = properties.get(task.propertyId);
                  const overdue = isOverdue(task, today);
                  const done = isTaskDone(task);
                  const hint = dueHint(task.dueDate ?? null, today);
                  const delays = task.delays ?? [];
                  return (
                    <tr key={task.id} className={`${overdue ? 'bg-red-50/40' : ''} ${done ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-2 align-top whitespace-nowrap">
                        <Link
                          to={`/onboarding/properties/${task.propertyId}`}
                          className="text-sm font-medium text-brand-dark hover:underline"
                        >
                          {property?.name ?? 'Unknown property'}
                        </Link>
                      </td>
                      <td className="px-4 py-2 align-top min-w-[16rem]">
                        <div className={task.indent === 1 ? 'pl-6' : ''}>
                          <span className={task.indent === 1 ? 'text-sm text-gray-700' : 'text-sm font-medium text-gray-900'}>
                            {task.title}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2 align-top whitespace-nowrap text-sm text-gray-500">{task.section}</td>
                      <td className="px-4 py-2 align-top whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={task.dueDate ?? ''}
                            onChange={(e) => handleDueDateChange(task, e.target.value || null)}
                            className={`bg-transparent border border-transparent rounded px-2 py-1 text-sm hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark ${
                              overdue ? 'text-red-700 font-bold' : 'text-gray-700'
                            }`}
                          />
                          {delays.length > 0 && (
                            <span
                              title={delays.map((d) => `Moved to ${formatDateOnly(d.toDate)}: ${d.reason}`).join('\n')}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium"
                            >
                              <Clock className="h-3 w-3" />
                              {delays.length}
                            </span>
                          )}
                        </div>
                        {task.dueDate && (
                          <span className={`block px-2 text-[11px] ${overdue ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                            {hint}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 align-top">
                        <select
                          value={task.status}
                          onChange={(e) => patchTask(task, { status: e.target.value as OnboardingStatus })}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-dark ${STATUS_STYLES[task.status]}`}
                        >
                          {ONBOARDING_STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2 align-top min-w-[12rem]">
                        <EditableNotes value={task.notes ?? ''} onCommit={(notes) => patchTask(task, { notes })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <PostponeModal
        open={!!postponeTarget}
        taskTitle={postponeTarget?.task.title ?? ''}
        fromDate={postponeTarget?.task.dueDate ?? null}
        initialDate={postponeTarget?.newDate ?? null}
        onCancel={() => setPostponeTarget(null)}
        onConfirm={confirmPostpone}
      />
    </div>
  );
}
