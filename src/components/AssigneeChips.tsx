import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, Users } from 'lucide-react';

interface Profile { id: string; name: string; photoURL: string; }

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  admins: Profile[];
  disabled?: boolean;
}

export function AssigneeChips({ value, onChange, admins, disabled }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setSearch('');
      }
    };
    if (pickerOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const selected = admins.filter((a) => value.includes(a.id));
  const available = admins.filter(
    (a) => !value.includes(a.id) && a.name?.toLowerCase().includes(search.toLowerCase()),
  );

  const add = (id: string) => {
    onChange([...value, id]);
    setSearch('');
    setPickerOpen(false);
  };

  const remove = (id: string) => {
    onChange(value.filter((v) => v !== id));
  };

  return (
    <div className="relative" ref={ref}>
      <div className="flex flex-wrap gap-1.5 items-center">
        {selected.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1.5 pl-1 pr-1 py-0.5 bg-brand-dark/10 text-brand-dark text-xs rounded-full"
          >
            <img src={p.photoURL} alt="" className="w-5 h-5 rounded-full" />
            <span className="max-w-[110px] truncate">{p.name}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="ml-0.5 p-0.5 rounded-full hover:bg-brand-dark/20 transition-colors"
                title={`Remove ${p.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-600 bg-white border border-dashed border-gray-300 rounded-full hover:border-brand-dark hover:text-brand-dark transition-colors"
          >
            <Plus className="w-3 h-3" />
            {selected.length === 0 ? 'Assign' : 'Add'}
          </button>
        )}
      </div>

      {pickerOpen && (
        <div className="absolute z-20 mt-2 left-0 w-64 bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people…"
              className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-dark focus:border-brand-dark"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {available.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500">
                <Users className="h-4 w-4" />
                {admins.length === 0 ? 'No admins available' : 'Everyone is already added'}
              </div>
            ) : (
              available.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => add(a.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left"
                >
                  <img src={a.photoURL} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
                  <span className="text-sm text-gray-900 truncate">{a.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
