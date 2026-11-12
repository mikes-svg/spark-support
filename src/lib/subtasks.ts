import type { Subtask } from '../types';

/**
 * Pure helpers behind the subtask editor's bulk actions: one subtask per
 * property, and setting assignees or a due date across every row at once.
 * Kept out of the component so they can be unit-tested without the DOM.
 */

/** Normalise a title for "already added" matching: trim + case-fold. */
function key(title: string): string {
  return title.trim().toLocaleLowerCase();
}

/** Property names that already appear as a subtask title (case-insensitive). */
export function namesAlreadyAdded(subtasks: Subtask[], names: string[]): Set<string> {
  const have = new Set(subtasks.map((s) => key(s.title)));
  return new Set(names.filter((n) => have.has(key(n))));
}

/**
 * Append one subtask per name that is not already present, in the order
 * given, with `order` re-derived to stay contiguous. Existing rows are kept
 * untouched; duplicates (by case-insensitive title) and blank names are skipped.
 */
export function subtasksFromNames(subtasks: Subtask[], names: string[], makeId: () => string): Subtask[] {
  const sorted = [...subtasks].sort((a, b) => a.order - b.order);
  const seen = new Set(sorted.map((s) => key(s.title)));
  const added: Subtask[] = [];
  for (const raw of names) {
    const title = raw.trim();
    if (!title || seen.has(key(title))) continue;
    seen.add(key(title));
    added.push({ id: makeId(), title, done: false, order: 0 });
  }
  return [...sorted, ...added].map((s, i) => ({ ...s, order: i }));
}

export interface BulkSubtaskPatch {
  /** Replace every row's assignees; omitted leaves them as they are. */
  assigneeIds?: string[];
  /** Set every row's due date; omitted leaves them as they are. */
  dueDate?: string | null;
}

/**
 * Apply the same assignees and/or due date to many rows. Fields left out of
 * the patch are untouched, so "set a date for everyone" does not also wipe
 * the assignees someone already picked. With `onlyOpen`, finished rows keep
 * what they had.
 */
export function applyToSubtasks(subtasks: Subtask[], patch: BulkSubtaskPatch, onlyOpen = false): Subtask[] {
  return subtasks.map((s) => {
    if (onlyOpen && s.done) return s;
    const next = { ...s };
    if (patch.assigneeIds !== undefined) next.assigneeIds = [...patch.assigneeIds];
    if (patch.dueDate !== undefined) next.dueDate = patch.dueDate || null;
    return next;
  });
}
