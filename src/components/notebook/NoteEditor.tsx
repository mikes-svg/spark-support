// Controlled TipTap editor for a notebook page. Remounted per page via
// `key={page.id}` in the panel — seeds initialBody once on mount and does
// not react to later prop changes.
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { useEffect, useRef } from 'react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  ListChecks,
  Link2,
  RemoveFormatting,
} from 'lucide-react';
import type { TipTapDoc } from '../../lib/notebooks';

export interface NoteEditorProps {
  /** Parsed TipTap doc to seed the editor (use parseBody on the stored string). */
  initialBody: TipTapDoc;
  /** Read-only when false — toolbar hidden, content not editable. */
  editable: boolean;
  /** Called (debounced ~800ms) with the current TipTap doc as the user types. */
  onChange: (body: TipTapDoc) => void;
}

const DEBOUNCE_MS = 800;

export function NoteEditor({ initialBody, editable, onChange }: NoteEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TipTapDoc | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Underline,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
    ],
    content: initialBody,
    editable,
    immediatelyRender: true,
    onUpdate: ({ editor }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        pendingRef.current = null;
        onChangeRef.current(editor.getJSON());
      }, DEBOUNCE_MS);
      pendingRef.current = editor.getJSON();
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        if (pendingRef.current) {
          onChangeRef.current(pendingRef.current);
          pendingRef.current = null;
        }
      }
    };
  }, []);

  if (!editor) return null;

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? '');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="flex flex-col gap-2">
      {editable && (
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-gray-50 p-1">
          <ToolbarButton
            active={editor.isActive('bold')}
            label="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('italic')}
            label="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('underline')}
            label="Underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className="h-4 w-4" />
          </ToolbarButton>
          <Divider />
          <ToolbarButton
            active={editor.isActive('heading', { level: 1 })}
            label="Heading 1"
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('heading', { level: 2 })}
            label="Heading 2"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <Divider />
          <ToolbarButton
            active={editor.isActive('bulletList')}
            label="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('orderedList')}
            label="Numbered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('taskList')}
            label="Checklist"
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            <ListChecks className="h-4 w-4" />
          </ToolbarButton>
          <Divider />
          <ToolbarButton active={editor.isActive('link')} label="Link" onClick={setLink}>
            <Link2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={false}
            label="Clear formatting"
            onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
          >
            <RemoveFormatting className="h-4 w-4" />
          </ToolbarButton>
        </div>
      )}
      <EditorContent
        editor={editor}
        className="[&_.ProseMirror]:min-h-[8rem] [&_.ProseMirror]:outline-none
          [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:font-serif [&_h1]:my-2
          [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:font-serif [&_h2]:my-2
          [&_p]:my-2 [&_p]:leading-relaxed
          [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2
          [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2
          [&_a]:text-brand-dark [&_a]:underline
          [&_strong]:font-semibold
          [&_.is-editor-empty:first-child]:before:text-gray-400
          [&_.is-editor-empty:first-child]:before:float-left
          [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]
          [&_.is-editor-empty:first-child]:before:pointer-events-none
          [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0
          [&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start
          [&_ul[data-type=taskList]_li]:gap-2 [&_ul[data-type=taskList]_li]:my-1
          [&_ul[data-type=taskList]_li_>_label]:mt-1
          [&_ul[data-type=taskList]_li_>_div]:flex-1"
      />
    </div>
  );
}

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`rounded p-1.5 transition-colors ${
        active ? 'bg-brand-dark text-white' : 'text-gray-600 hover:bg-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-gray-300" />;
}
