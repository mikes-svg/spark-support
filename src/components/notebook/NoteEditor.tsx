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
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  ListChecks,
  Link2,
  RemoveFormatting,
  Baseline,
  ImagePlus,
} from 'lucide-react';
import type { TipTapDoc } from '../../lib/notebooks';

export interface NoteEditorProps {
  /** Parsed TipTap doc to seed the editor (use parseBody on the stored string). */
  initialBody: TipTapDoc;
  /** Read-only when false — toolbar hidden, content not editable. */
  editable: boolean;
  /** Called (debounced ~800ms) with the current TipTap doc as the user types. */
  onChange: (body: TipTapDoc) => void;
  /**
   * Upload an image (pasted, dropped, or picked) and resolve its URL for
   * embedding. When omitted, image insertion is disabled. Should throw on
   * failure; the editor reports the message inline.
   */
  onImageUpload?: (file: File) => Promise<string>;
}

const DEBOUNCE_MS = 800;

/** Text-color swatches offered in the toolbar. */
const TEXT_COLORS: { name: string; value: string }[] = [
  { name: 'Green', value: '#064923' },
  { name: 'Red', value: '#DC2626' },
  { name: 'Orange', value: '#EA580C' },
  { name: 'Amber', value: '#B45309' },
  { name: 'Emerald', value: '#16A34A' },
  { name: 'Blue', value: '#2563EB' },
  { name: 'Purple', value: '#7C3AED' },
  { name: 'Gray', value: '#6B7280' },
];

export function NoteEditor({ initialBody, editable, onChange, onImageUpload }: NoteEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onImageUploadRef = useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TipTapDoc | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const insertImagesRef = useRef<(files: File[]) => void>(() => {});
  const [colorOpen, setColorOpen] = useState(false);
  const [imageError, setImageError] = useState('');
  const [uploading, setUploading] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Underline,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
      TextStyle,
      Color,
    ],
    content: initialBody,
    editable,
    immediatelyRender: true,
    editorProps: {
      handlePaste: (_view, event) => {
        const files = imageFilesFrom(event.clipboardData?.files);
        if (!files.length || !onImageUploadRef.current) return false;
        event.preventDefault();
        insertImagesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = imageFilesFrom(event.dataTransfer?.files);
        if (!files.length || !onImageUploadRef.current) return false;
        event.preventDefault();
        insertImagesRef.current(files);
        return true;
      },
    },
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

  editorRef.current = editor;

  // Upload each image and insert it at the cursor once its URL resolves. Held in
  // a ref so the editor's paste/drop handlers (bound once at init) always call
  // the current implementation.
  insertImagesRef.current = (files: File[]) => {
    const upload = onImageUploadRef.current;
    if (!upload) return;
    setImageError('');
    setUploading(true);
    (async () => {
      for (const file of files) {
        try {
          const url = await upload(file);
          editorRef.current?.chain().focus().setImage({ src: url }).run();
        } catch (err) {
          console.error('Failed to add image:', err);
          setImageError(err instanceof Error ? err.message : 'Could not add the image.');
        }
      }
      setUploading(false);
    })();
  };

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
          <ToolbarButton
            active={editor.isActive('strike')}
            label="Strikethrough"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough className="h-4 w-4" />
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
          <Divider />
          <div className="relative">
            <ToolbarButton
              active={colorOpen || !!(editor.getAttributes('textStyle').color)}
              label="Text color"
              onClick={() => setColorOpen((v) => !v)}
            >
              <Baseline
                className="h-4 w-4"
                style={{ color: (editor.getAttributes('textStyle').color as string) || undefined }}
              />
            </ToolbarButton>
            {colorOpen && (
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setColorOpen(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
                  <div className="grid grid-cols-4 gap-1.5">
                    {TEXT_COLORS.map((c) => {
                      const isActive = editor.getAttributes('textStyle').color === c.value;
                      return (
                        <button
                          key={c.value}
                          type="button"
                          aria-label={c.name}
                          title={c.name}
                          onClick={() => {
                            editor.chain().focus().setColor(c.value).run();
                            setColorOpen(false);
                          }}
                          className={`h-6 w-6 rounded-full border transition-transform hover:scale-110 ${
                            isActive ? 'ring-2 ring-offset-1 ring-gray-400' : 'border-gray-200'
                          }`}
                          style={{ backgroundColor: c.value }}
                        />
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      editor.chain().focus().unsetColor().run();
                      setColorOpen(false);
                    }}
                    className="mt-2 w-full rounded px-2 py-1 text-left text-xs font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Default color
                  </button>
                </div>
              </>
            )}
          </div>
          {onImageUpload && (
            <>
              <Divider />
              <ToolbarButton
                active={false}
                disabled={uploading}
                label={uploading ? 'Adding image…' : 'Insert image'}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
              </ToolbarButton>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  insertImagesRef.current(imageFilesFrom(e.target.files));
                  e.target.value = '';
                }}
              />
            </>
          )}
          <Divider />
          <ToolbarButton
            active={false}
            label="Clear formatting"
            onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
          >
            <RemoveFormatting className="h-4 w-4" />
          </ToolbarButton>
        </div>
      )}
      {imageError && (
        <p className="text-xs text-red-700" role="alert">{imageError}</p>
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
          [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-md [&_img]:my-2
          [&_img.ProseMirror-selectednode]:outline [&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-brand-dark
          [&_strong]:font-semibold
          [&_.is-editor-empty:first-child]:before:text-gray-400
          [&_.is-editor-empty:first-child]:before:float-left
          [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]
          [&_.is-editor-empty:first-child]:before:pointer-events-none
          [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0
          [&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start
          [&_ul[data-type=taskList]_li]:gap-2 [&_ul[data-type=taskList]_li]:my-1
          [&_ul[data-type=taskList]_li_>_label]:mt-1
          [&_ul[data-type=taskList]_li_>_div]:flex-1
          [&_ul[data-type=taskList]_li[data-checked=true]_>_div]:line-through
          [&_ul[data-type=taskList]_li[data-checked=true]_>_div]:text-gray-400"
      />
    </div>
  );
}

function ToolbarButton({
  active,
  label,
  onClick,
  children,
  disabled = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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

/** Pull image files out of a paste/drop FileList (ignores non-images). */
function imageFilesFrom(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.type.startsWith('image/'));
}
