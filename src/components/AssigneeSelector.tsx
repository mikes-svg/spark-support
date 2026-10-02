import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Users, Search } from 'lucide-react';
import type { Profile } from '../types';
import { Avatar } from './Avatar';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  admins: Profile[];
  disabled?: boolean;
  /** compact: avatar stack only (for table rows); full: names as chips */
  variant?: 'compact' | 'full';
  placeholder?: string;
  /** Shown when the list is empty. Onboarding picks from people with access, not admins. */
  emptyLabel?: string;
  /**
   * Selected ids that cannot be deselected — used to keep the last Manager on a
   * ticket. Still rendered as selected; the control is inert and explains why.
   */
  lockedIds?: string[];
  /** Tooltip shown when a locked id is clicked. */
  lockedReason?: string;
}

export function AssigneeSelector({ value, onChange, admins, disabled, variant = 'full', placeholder = 'Unassigned', emptyLabel = 'No admins available', lockedIds = [], lockedReason }: Props) {
  const [open, setOpen] = useState(false);
  // Type-to-filter. AssigneeChips already had this; the dropdown did not, so
  // picking someone on a team of any size meant scrolling and reading.
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (id: string) => {
    // Locked ids are already selected and must stay that way; adding is always
    // fine, so only the removal direction is blocked.
    if (lockedIds.includes(id) && value.includes(id)) return;
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
    onChange(next);
  };

  const selected = admins.filter((a) => value.includes(a.id));

  // Alphabetical, always: the source lists arrive in Firestore document-id
  // order, which is effectively random to a reader.
  const sorted = [...admins].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const term = search.trim().toLowerCase();
  const shown = term
    ? sorted.filter((a) => (a.name || '').toLowerCase().includes(term) || (a.email || '').toLowerCase().includes(term))
    : sorted;

  return (
    <div className="relative inline-block w-full" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((o) => !o);
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-gray-50 hover:bg-white hover:border-gray-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selected.length === 0 ? (
            <span className="text-gray-500 italic">{placeholder}</span>
          ) : variant === 'compact' ? (
            <div className="flex -space-x-2">
              {selected.slice(0, 3).map((p) => (
                <Avatar key={p.id} src={p.photoURL} name={p.name} className="w-6 h-6 rounded-full border-2 border-white" />
              ))}
              {selected.length > 3 && (
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-xs font-medium text-gray-600 border-2 border-white">
                  +{selected.length - 3}
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 min-w-0">
              {selected.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand-dark/10 text-brand-dark text-xs rounded-full">
                  <Avatar src={p.photoURL} name={p.name} className="w-4 h-4 rounded-full" />
                  {p.name.split(' ')[0]}
                </span>
              ))}
            </div>
          )}
        </div>
        <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto min-w-[220px] left-0 right-0 md:right-auto md:w-64">
          {admins.length > 5 && (
            // Only worth the row when the list is long enough to scan badly.
            <div className="sticky top-0 bg-white px-2 pt-1 pb-2 border-b border-gray-100">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input
                  type="search"
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Search people…"
                  aria-label="Search people"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-dark focus:border-brand-dark"
                />
              </div>
            </div>
          )}
          {admins.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500">
              <Users className="h-4 w-4" />
              {emptyLabel}
            </div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500">No one matches “{search.trim()}”.</div>
          ) : (
            shown.map((a) => {
              const checked = value.includes(a.id);
              const locked = checked && lockedIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(a.id);
                  }}
                  aria-disabled={locked}
                  title={locked ? lockedReason : undefined}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left ${locked ? 'cursor-not-allowed opacity-60' : 'hover:bg-gray-50'}`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${checked ? 'bg-brand-dark border-brand-dark' : 'border-gray-300'}`}>
                    {checked && <Check className="h-3 w-3 text-white" />}
                  </div>
                  <Avatar src={a.photoURL} name={a.name} className="w-6 h-6 rounded-full flex-shrink-0" />
                  <span className="text-sm text-gray-900 truncate">{a.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
