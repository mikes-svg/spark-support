import React, { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Users } from 'lucide-react';

interface Profile { id: string; name: string; photoURL: string; }

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  admins: Profile[];
  disabled?: boolean;
  /** compact: avatar stack only (for table rows); full: names as chips */
  variant?: 'compact' | 'full';
  placeholder?: string;
}

export function AssigneeSelector({ value, onChange, admins, disabled, variant = 'full', placeholder = 'Unassigned' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
    onChange(next);
  };

  const selected = admins.filter((a) => value.includes(a.id));

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
                <img key={p.id} src={p.photoURL} alt={p.name} title={p.name} className="w-6 h-6 rounded-full border-2 border-white" />
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
                  <img src={p.photoURL} alt="" className="w-4 h-4 rounded-full" />
                  {p.name.split(' ')[0]}
                </span>
              ))}
            </div>
          )}
        </div>
        <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-64 overflow-y-auto min-w-[220px] left-0 right-0 md:right-auto md:w-64">
          {admins.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500">
              <Users className="h-4 w-4" />
              No admins available
            </div>
          ) : (
            admins.map((a) => {
              const checked = value.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(a.id);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left"
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${checked ? 'bg-brand-dark border-brand-dark' : 'border-gray-300'}`}>
                    {checked && <Check className="h-3 w-3 text-white" />}
                  </div>
                  <img src={a.photoURL} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
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
