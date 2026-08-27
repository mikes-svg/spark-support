// STUB — replaced by the Editor lane. The exported interface is the pinned
// contract: a controlled TipTap editor, remounted per page via `key={pageId}`,
// that calls onChange with the current TipTap doc on a debounced edit.
import type { TipTapDoc } from '../../lib/notebooks';

export interface NoteEditorProps {
  /** Parsed TipTap doc to seed the editor (use parseBody on the stored string). */
  initialBody: TipTapDoc;
  /** Read-only when false — toolbar hidden, content not editable. */
  editable: boolean;
  /** Called (debounced ~800ms) with the current TipTap doc as the user types. */
  onChange: (body: TipTapDoc) => void;
}

export function NoteEditor(_props: NoteEditorProps) {
  return null;
}
