import { useState } from 'react';
import { Modal } from '../Modal';
import { Avatar } from '../Avatar';
import { shareLevelOf } from '../../lib/notebooks';
import type {
  OnboardingNotebook,
  OnboardingNotebookPage,
  NotebookShareLevel,
  Profile,
} from '../../types';

/** What is being shared: the whole notebook, or one page within it. */
export type ShareTarget =
  | { kind: 'notebook'; notebook: OnboardingNotebook }
  | { kind: 'page'; notebook: OnboardingNotebook; page: OnboardingNotebookPage };

export interface ShareNotebookDialogProps {
  open: boolean;
  /** Null when closed. Carries the notebook/page whose share arrays hold the
   *  current levels (read them with shareLevelOf from lib/notebooks). */
  target: ShareTarget | null;
  /** People the notebook may be shared with (onboarding users). */
  people: Profile[];
  /** Persist a level change for one user; the parent writes it and refreshes. */
  onShare: (userId: string, level: NotebookShareLevel) => Promise<void>;
  onClose: () => void;
}

const LEVELS: { value: NotebookShareLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'view', label: 'View' },
  { value: 'edit', label: 'Edit' },
];

export function ShareNotebookDialog({ open, target, people, onShare, onClose }: ShareNotebookDialogProps) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Optimistic per-row level, keyed by userId; falls back to the target's
  // share arrays when a row hasn't been touched locally yet.
  const [overrides, setOverrides] = useState<Record<string, NotebookShareLevel>>({});

  if (!target) return null;

  const shareSource = target.kind === 'notebook' ? target.notebook : target.page;
  const ownerId = target.notebook.ownerId;

  const filtered = people
    .filter((p) => p.id !== ownerId)
    .filter((p) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q);
    });

  const heading = target.kind === 'notebook' ? 'Share notebook' : `Share "${target.page.title}"`;

  async function handleChange(personId: string, level: NotebookShareLevel) {
    const previous = overrides[personId] ?? shareLevelOf(shareSource, personId);
    setOverrides((prev) => ({ ...prev, [personId]: level }));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[personId];
      return next;
    });
    setPendingId(personId);
    try {
      await onShare(personId, level);
    } catch (err) {
      setOverrides((prev) => ({ ...prev, [personId]: previous }));
      setRowErrors((prev) => ({
        ...prev,
        [personId]: err instanceof Error ? err.message : 'Failed to update access.',
      }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="share-notebook-title" widthClass="max-w-lg">
      <div className="px-6 py-5 border-b border-gray-100">
        <h2 id="share-notebook-title" className="font-serif text-lg font-semibold text-brand-dark">
          {heading}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          View lets someone read {target.kind === 'notebook' ? 'every page' : 'this page'}. Edit also lets them
          add and change content.
        </p>
      </div>

      <div className="px-6 pt-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-gold"
        />
      </div>

      <div className="px-6 py-4 max-h-80 overflow-y-auto space-y-1">
        {filtered.length === 0 && (
          <p className="text-sm text-gray-500 py-6 text-center">No matching people.</p>
        )}
        {filtered.map((person) => {
          const level = overrides[person.id] ?? shareLevelOf(shareSource, person.id);
          const isPending = pendingId === person.id;
          const error = rowErrors[person.id];
          return (
            <div key={person.id} className="py-2">
              <div className="flex items-center gap-3">
                <Avatar src={person.photoURL} name={person.name} className="w-9 h-9 rounded-full flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{person.name}</p>
                  {person.email && <p className="text-xs text-gray-500 truncate">{person.email}</p>}
                </div>
                <div className="flex-shrink-0 inline-flex rounded-md border border-gray-300 overflow-hidden">
                  {LEVELS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isPending}
                      onClick={() => handleChange(person.id, value)}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        level === value
                          ? 'bg-brand-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      } ${value !== 'none' ? 'border-l border-gray-300' : ''}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {isPending && (
                  <span className="text-xs text-gray-400 flex-shrink-0">Saving…</span>
                )}
              </div>
              {error && (
                <p className="mt-1 text-xs text-red-700" role="alert">{error}</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-md bg-brand-dark text-white text-sm font-medium hover:bg-brand-dark/90"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}
