import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Bold, Italic, Underline as UnderlineIcon, List, ListOrdered, ListChecks, Link2 } from 'lucide-react';
import type { Profile, Task, TaskList as TaskListType, TaskStatusSet, TaskTag } from '../../types';
import { isTaskWaiting } from '../../types';
import { AssigneeSelector } from '../AssigneeSelector';
import { TaskTagPill } from './shared/TaskTagPill';

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
  lists: TaskListType[];
  /** The status set backing this task's list; null while it loads. */
  statusSet: TaskStatusSet | null;
  people: Profile[];
  tags?: TaskTag[];
  /** Emitted per committed field change. The page persists via updateTask. */
  onChange: (patch: Partial<Task>) => void | Promise<void>;
}

// ─── Description codec ───────────────────────────────────────────────────────
// Task.description is JSON.stringify(<TipTap doc>) — a plain string, same as a
// notebook page body (src/lib/notebooks.ts) — so the deeply-nested rich-text
// tree never trips Firestore's 20-level map-nesting cap. TaskCreateModal (a
// plain textarea, no TipTap mount there) reuses these so a task created there
// still opens correctly in this editor.

export const EMPTY_TASK_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

export function parseTaskDescription(raw: string | undefined | null): JSONContent {
  if (!raw) return EMPTY_TASK_DOC;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as JSONContent;
  } catch {
    /* fall through */
  }
  return EMPTY_TASK_DOC;
}

export function serializeTaskDescription(doc: JSONContent | null | undefined): string {
  return JSON.stringify(doc ?? EMPTY_TASK_DOC);
}

/** Wraps plain typed text (e.g. TaskCreateModal's textarea) into a minimal
 *  TipTap doc — one paragraph per blank-line-separated chunk. */
export function textToTaskDoc(text: string): JSONContent {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return EMPTY_TASK_DOC;
  return { type: 'doc', content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) };
}

const PRIORITIES: Task['priority'][] = ['Low', 'Medium', 'High', 'Urgent'];
const DEBOUNCE_MS = 800;

export function TaskEditor({ task, canEdit, statusSet, people, tags, onChange }: TaskEditorProps) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  useEffect(() => setTitleDraft(task.title), [task.id, task.title]);

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) onChange({ title: trimmed });
    else setTitleDraft(task.title);
  };

  // Description: debounced like NoteEditor, remounted per task via `key` from
  // the caller so a fresh task never inherits the previous one's live doc.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Underline,
      Placeholder.configure({ placeholder: canEdit ? 'Add a description…' : 'No description.' }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: parseTaskDescription(task.description),
    editable: canEdit,
    immediatelyRender: true,
    onUpdate: ({ editor }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const json = editor.getJSON();
      const serialized = serializeTaskDescription(json);
      pendingRef.current = serialized;
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        pendingRef.current = null;
        onChangeRef.current({ description: serialized });
      }, DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        if (pendingRef.current) {
          onChangeRef.current({ description: pendingRef.current });
          pendingRef.current = null;
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statuses = [...(statusSet?.statuses ?? [])].sort((a, b) => a.order - b.order);
  const waiting = isTaskWaiting(task);
  const rowTags = (task.tagIds ?? []).map((id) => tags?.find((t) => t.id === id)).filter((t): t is TaskTag => Boolean(t));

  return (
    <div className="space-y-6">
      <div>
        {canEdit ? (
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              if (e.key === 'Escape') { setTitleDraft(task.title); (e.target as HTMLInputElement).blur(); }
            }}
            className="w-full border-0 border-b-2 border-transparent bg-transparent p-0 text-2xl font-serif font-bold text-gray-900 focus:border-brand-dark focus:ring-0"
            aria-label="Task title"
          />
        ) : (
          <h1 className="text-2xl font-serif font-bold text-gray-900">{task.title}</h1>
        )}
      </div>

      {rowTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rowTags.map((t) => <TaskTagPill key={t.id} tag={t} />)}
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest mb-2">Description</h3>
        {canEdit && editor && (
          <div className="mb-2 flex flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-gray-50 p-1">
            <EditorToolbarButton active={editor.isActive('bold')} label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton active={editor.isActive('italic')} label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton active={editor.isActive('underline')} label="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton active={editor.isActive('bulletList')} label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton active={editor.isActive('orderedList')} label="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton active={editor.isActive('taskList')} label="Checklist" onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks className="h-4 w-4" /></EditorToolbarButton>
            <EditorToolbarButton
              active={editor.isActive('link')}
              label="Link"
              onClick={() => {
                const previous = editor.getAttributes('link').href as string | undefined;
                const url = window.prompt('Link URL', previous ?? '');
                if (url === null) return;
                if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
                editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
              }}
            >
              <Link2 className="h-4 w-4" />
            </EditorToolbarButton>
          </div>
        )}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <EditorContent
            editor={editor}
            className="[&_.ProseMirror]:min-h-[6rem] [&_.ProseMirror]:outline-none
              [&_p]:my-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5
              [&_a]:text-brand-dark [&_a]:underline [&_strong]:font-semibold
              [&_.is-editor-empty:first-child]:before:text-gray-400
              [&_.is-editor-empty:first-child]:before:float-left
              [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]
              [&_.is-editor-empty:first-child]:before:pointer-events-none
              [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0
              [&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2
              [&_ul[data-type=taskList]_li_>_label]:mt-1 [&_ul[data-type=taskList]_li_>_div]:flex-1"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Field label="Status">
          {canEdit && statuses.length > 0 ? (
            <select
              value={task.statusId}
              onChange={(e) => onChange({ statusId: e.target.value })}
              className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
            >
              {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (
            <span className="text-sm text-gray-900">{task.statusName}</span>
          )}
        </Field>

        <Field label="Priority">
          {canEdit ? (
            <select
              value={task.priority ?? ''}
              onChange={(e) => onChange({ priority: (e.target.value || null) as Task['priority'] })}
              className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
            >
              <option value="">None</option>
              {PRIORITIES.map((p) => <option key={p} value={p!}>{p}</option>)}
            </select>
          ) : (
            <span className="text-sm text-gray-900">{task.priority ?? 'None'}</span>
          )}
        </Field>

        <Field label="Start date">
          {canEdit ? (
            <input
              type="date"
              value={task.startDate ?? ''}
              onChange={(e) => onChange({ startDate: e.target.value || null })}
              className="block w-full pl-3 pr-3 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
            />
          ) : (
            <span className="text-sm text-gray-900">{task.startDate ?? '—'}</span>
          )}
        </Field>

        <Field label="Due date">
          {canEdit ? (
            <div className="flex gap-2">
              <input
                type="date"
                value={task.dueDate ?? ''}
                onChange={(e) => onChange({ dueDate: e.target.value || null })}
                className="block w-full pl-3 pr-3 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              />
              <input
                type="time"
                value={task.dueTime ?? ''}
                onChange={(e) => onChange({ dueTime: e.target.value || null })}
                className="block w-28 pl-3 pr-2 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              />
            </div>
          ) : (
            <span className="text-sm text-gray-900">{task.dueDate ?? '—'}{task.dueTime ? ` ${task.dueTime}` : ''}</span>
          )}
        </Field>

        <Field label="Assignees">
          {canEdit ? (
            <AssigneeSelector
              value={task.assigneeIds ?? []}
              onChange={(ids) => onChange({ assigneeIds: ids })}
              admins={people}
              variant="full"
              placeholder="Unassigned"
            />
          ) : (task.assigneeIds ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(task.assigneeIds ?? []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean).map((n) => (
                <span key={n} className="text-sm text-gray-900">{n}</span>
              ))}
            </div>
          ) : (
            <span className="text-sm text-gray-500 italic">Unassigned</span>
          )}
        </Field>

        <Field label="Watchers">
          {canEdit ? (
            <AssigneeSelector
              value={task.watcherIds ?? []}
              onChange={(ids) => onChange({ watcherIds: ids })}
              admins={people}
              variant="full"
              placeholder="No watchers"
            />
          ) : (task.watcherIds ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(task.watcherIds ?? []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean).map((n) => (
                <span key={n} className="text-sm text-gray-900">{n}</span>
              ))}
            </div>
          ) : (
            <span className="text-sm text-gray-500 italic">None</span>
          )}
        </Field>

        {waiting && (
          <Field label="Waiting on">
            {canEdit ? (
              <select
                value={task.waitingOnUserId ?? ''}
                onChange={(e) => onChange({ waitingOnUserId: e.target.value || null })}
                className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
              >
                <option value="">Unspecified</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <span className="text-sm text-gray-900">
                {people.find((p) => p.id === task.waitingOnUserId)?.name ?? 'Unspecified'}
              </span>
            )}
          </Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="block text-xs font-medium text-gray-500 uppercase mb-1">{label}</span>
      {children}
    </div>
  );
}

function EditorToolbarButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`rounded p-1.5 transition-colors ${active ? 'bg-brand-dark text-white' : 'text-gray-600 hover:bg-gray-200'}`}
    >
      {children}
    </button>
  );
}
