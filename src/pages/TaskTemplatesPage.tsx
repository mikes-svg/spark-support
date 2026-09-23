import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDocs, serverTimestamp, updateDoc } from 'firebase/firestore';
import { LayoutTemplate, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { isSuperadminRole } from '../types';
import type { TaskList, TaskPriority, TaskTemplate } from '../types';
import { TASK_LISTS, TASK_TEMPLATES, createTask } from '../lib/tasks';
import { addDaysStr, formatDateOnly, todayStr } from '../lib/dates';
import { PageSpinner } from '../components/PageSpinner';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';

/**
 * Task Templates — Phase 3 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * A template is a named bundle of tasks with due dates expressed as offsets from
 * a start day, so one template covers both "a single task I keep re-creating" and
 * "the seven things that happen when a new property closes". Applying it is the
 * only write most people do here; editing the templates themselves is superadmin,
 * matching the Firestore rules on `taskTemplates`.
 *
 * Deliberately not recurrence: a template is instantiated on demand by a person,
 * a series is minted on a schedule by the server. They share a lane because they
 * share a mental model, not an implementation.
 */

type TemplateRow = TaskTemplate['tasks'][number];

const PRIORITIES: TaskPriority[] = ['Low', 'Medium', 'High', 'Urgent'];

const fieldClass =
  'min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-dark focus:outline-none focus:ring-1 focus:ring-brand-dark';

function emptyRow(order: number): TemplateRow {
  return { title: '', dueOffsetDays: order === 0 ? 0 : null, priority: null };
}

export function TaskTemplatesPage() {
  const { user } = useAuth();
  const canEdit = isSuperadminRole(user?.role);

  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  // Bumping this re-runs the load effect, which is what the error banner's Retry does.
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftRows, setDraftRows] = useState<TemplateRow[]>([]);
  const [saving, setSaving] = useState(false);

  const [applying, setApplying] = useState<TaskTemplate | null>(null);
  const [applyListId, setApplyListId] = useState('');
  const [applyStart, setApplyStart] = useState(todayStr());
  const [applyBusy, setApplyBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<TaskTemplate | null>(null);

  useEffect(() => {
    if (!db) {
      setLoadError('Firestore is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const [templateSnap, listSnap] = await Promise.all([
          getDocs(collection(db!, TASK_TEMPLATES)),
          getDocs(collection(db!, TASK_LISTS)),
        ]);
        setTemplates(
          templateSnap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<TaskTemplate, 'id'>) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setLists(
          listSnap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<TaskList, 'id'>) }))
            .filter((l) => !l.archived)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        );
      } catch (err) {
        console.error('Failed to load task templates:', err);
        setLoadError('Could not load templates.');
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadKey]);

  const listsById = useMemo(() => Object.fromEntries(lists.map((l) => [l.id, l])), [lists]);

  // ── Editing ───────────────────────────────────────────────────────────────

  const openEditor = (template: TaskTemplate | null) => {
    setActionError('');
    setEditing(template ?? ({ id: '', name: '', tasks: [] } as TaskTemplate));
    setDraftName(template?.name ?? '');
    setDraftRows(template?.tasks?.length ? template.tasks.map((t) => ({ ...t })) : [emptyRow(0)]);
  };

  const patchRow = (index: number, partial: Partial<TemplateRow>) =>
    setDraftRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...partial } : r)));

  const saveTemplate = async () => {
    if (!db || !editing) return;
    const name = draftName.trim();
    const tasks = draftRows.filter((r) => r.title.trim()).map((r) => ({ ...r, title: r.title.trim() }));
    if (!name || tasks.length === 0) {
      setActionError('A template needs a name and at least one task.');
      return;
    }

    setSaving(true);
    setActionError('');
    const isNew = !editing.id;
    const previous = templates;

    // Optimistic: the list reflects the save immediately and rolls back whole if
    // the write fails, so the screen never shows a template that isn't stored.
    const optimistic: TaskTemplate = {
      id: editing.id || 'pending',
      name,
      tasks,
      createdBy: editing.createdBy ?? user?.id,
    };
    setTemplates((prev) =>
      (isNew ? [...prev, optimistic] : prev.map((t) => (t.id === editing.id ? optimistic : t))).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );

    try {
      if (isNew) {
        const ref = await addDoc(collection(db, TASK_TEMPLATES), {
          name,
          tasks,
          createdBy: user?.id ?? null,
          createdAt: serverTimestamp(),
        });
        setTemplates((prev) => prev.map((t) => (t.id === 'pending' ? { ...t, id: ref.id } : t)));
      } else {
        await updateDoc(doc(db, TASK_TEMPLATES, editing.id), { name, tasks });
      }
      setEditing(null);
    } catch (err) {
      console.error('Failed to save the template:', err);
      setTemplates(previous);
      setActionError('Could not save that template. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!db || !deleteTarget) return;
    const previous = templates;
    const target = deleteTarget;
    setDeleteTarget(null);
    setActionError('');
    setTemplates((prev) => prev.filter((t) => t.id !== target.id));
    try {
      await deleteDoc(doc(db, TASK_TEMPLATES, target.id));
    } catch (err) {
      console.error('Failed to delete the template:', err);
      setTemplates(previous);
      setActionError('Could not delete that template.');
    }
  };

  // ── Applying ──────────────────────────────────────────────────────────────

  const applyTemplate = async () => {
    if (!applying || !user) return;
    const list = listsById[applyListId];
    if (!list) {
      setActionError('Pick a list first.');
      return;
    }

    setApplyBusy(true);
    setActionError('');
    try {
      // Sequential rather than Promise.all: createTask writes a task and its audit
      // event in one batch each, and a workflow of twelve is small enough that
      // ordered, attributable failures beat saving a few hundred milliseconds.
      for (const row of applying.tasks) {
        await createTask({
          listId: list.id,
          spaceId: list.spaceId,
          title: row.title,
          creatorId: user.id,
          description: row.description ?? '',
          priority: row.priority ?? null,
          assigneeIds: row.assigneeIds ?? [],
          watcherIds: row.watcherIds ?? [],
          tagIds: row.tagIds ?? [],
          // Offsets are calendar days off the chosen start day; addDaysStr keeps
          // it in 'YYYY-MM-DD' space so nothing ever meets new Date(dateStr).
          dueDate: row.dueOffsetDays === null ? null : addDaysStr(applyStart, row.dueOffsetDays),
          subtasks: row.subtasks ?? [],
        });
      }
      setNotice(
        `Created ${applying.tasks.length} task${applying.tasks.length === 1 ? '' : 's'} in ${list.name}.`,
      );
      setApplying(null);
    } catch (err) {
      console.error('Failed to apply the template:', err);
      setActionError('Could not create every task from that template. Check the list and try again.');
    } finally {
      setApplyBusy(false);
    }
  };

  if (loading) return <PageSpinner />;

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-8 text-center">
        <p className="text-sm text-red-800">{loadError}</p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="mt-3 min-h-[44px] rounded-lg bg-brand-dark px-4 text-sm font-medium text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          Reusable sets of tasks you can drop onto a date in one go.
        </p>
        {canEdit && (
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand-dark px-4 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New template
          </button>
        )}
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{actionError}</div>
      )}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {templates.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm">
          <LayoutTemplate className="mx-auto h-10 w-10 text-gray-300" aria-hidden="true" />
          <h2 className="mt-4 font-serif text-lg font-semibold text-gray-900">No templates yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            Bundle the tasks that always happen together — a move-in, a closing, a monthly close — and start them all
            from one date.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {templates.map((template) => (
            <li key={template.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-serif text-base font-semibold text-gray-900">{template.name}</h2>
                  <p className="text-xs text-gray-500">
                    {template.tasks.length} task{template.tasks.length === 1 ? '' : 's'}
                    {template.tasks.length > 1 ? ' — a workflow' : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setApplying(template);
                      setApplyListId(lists[0]?.id ?? '');
                      setApplyStart(todayStr());
                      setActionError('');
                    }}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-brand-dark px-3 text-sm font-medium text-brand-dark hover:bg-brand-cream"
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Use
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() => openEditor(template)}
                        aria-label={`Edit ${template.name}`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(template)}
                        aria-label={`Delete ${template.name}`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <ol className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
                {template.tasks.map((row, i) => (
                  <li key={`${template.id}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate text-gray-800">{row.title}</span>
                    <span className="shrink-0 text-xs text-gray-500">
                      {row.dueOffsetDays === null
                        ? 'no due date'
                        : row.dueOffsetDays === 0
                          ? 'due on the start day'
                          : `due ${row.dueOffsetDays > 0 ? '+' : ''}${row.dueOffsetDays}d`}
                    </span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}

      {/* ── Editor ──────────────────────────────────────────────────────── */}
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} labelledBy="template-editor-title" widthClass="max-w-2xl">
        <h2 id="template-editor-title" className="font-serif text-lg font-semibold text-gray-900">
          {editing?.id ? 'Edit template' : 'New template'}
        </h2>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500" htmlFor="tpl-name">
              Name
            </label>
            <input
              id="tpl-name"
              className={fieldClass}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="New property closing"
            />
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wide text-gray-500">Tasks</span>
            {draftRows.map((row, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_7rem_8rem_2.75rem]">
                <input
                  className={fieldClass}
                  value={row.title}
                  onChange={(e) => patchRow(i, { title: e.target.value })}
                  placeholder="Task title"
                  aria-label={`Task ${i + 1} title`}
                />
                <input
                  type="number"
                  className={fieldClass}
                  value={row.dueOffsetDays ?? ''}
                  placeholder="no due"
                  aria-label={`Task ${i + 1} due offset in days`}
                  onChange={(e) => patchRow(i, { dueOffsetDays: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <select
                  className={fieldClass}
                  value={row.priority ?? ''}
                  aria-label={`Task ${i + 1} priority`}
                  onChange={(e) => patchRow(i, { priority: (e.target.value || null) as TaskPriority | null })}
                >
                  <option value="">No priority</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove task ${i + 1}`}
                  onClick={() => setDraftRows((rows) => (rows.length > 1 ? rows.filter((_, j) => j !== i) : rows))}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setDraftRows((rows) => [...rows, emptyRow(rows.length)])}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add task
            </button>
            <p className="text-xs text-gray-500">
              The offset is calendar days from the day you start the template. Leave it blank for no due date.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveTemplate}
            disabled={saving}
            className="min-h-[44px] rounded-lg bg-brand-dark px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </Modal>

      {/* ── Apply ───────────────────────────────────────────────────────── */}
      <Modal open={Boolean(applying)} onClose={() => setApplying(null)} labelledBy="template-apply-title">
        <h2 id="template-apply-title" className="font-serif text-lg font-semibold text-gray-900">
          Start &ldquo;{applying?.name}&rdquo;
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Creates {applying?.tasks.length} task{applying?.tasks.length === 1 ? '' : 's'}, dated from the day you pick.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500" htmlFor="apply-list">
              List
            </label>
            <select id="apply-list" className={fieldClass} value={applyListId} onChange={(e) => setApplyListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500" htmlFor="apply-start">
              Start day
            </label>
            <input
              id="apply-start"
              type="date"
              className={fieldClass}
              value={applyStart}
              onChange={(e) => setApplyStart(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              First task lands {formatDateOnly(addDaysStr(applyStart, applying?.tasks[0]?.dueOffsetDays ?? 0)) || '—'}.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setApplying(null)}
            className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={applyTemplate}
            disabled={applyBusy || !applyListId}
            className="min-h-[44px] rounded-lg bg-brand-dark px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {applyBusy ? 'Creating…' : 'Create tasks'}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete this template?"
        message={`"${deleteTarget?.name}" will be removed. Tasks already created from it are not affected.`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
