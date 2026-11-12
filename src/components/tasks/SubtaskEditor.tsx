import { useState, useRef, useEffect } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, GitBranch, Building2, Users, X } from 'lucide-react';
import type { OnboardingProperty, Profile, Subtask } from '../../types';
import { AssigneeSelector } from '../AssigneeSelector';
import { fetchProperties } from '../../lib/onboarding';
import { applyToSubtasks, namesAlreadyAdded, subtasksFromNames } from '../../lib/subtasks';

/**
 * Checklist editor — Phase 1. Stub with its final prop shape.
 *
 * Toggling is separated from structural edits on purpose: `onToggle` maps to
 * toggleSubtask (one item, one audit event), while `onChange` rewrites the
 * whole array for adds, renames, reorders, and deletes. Recurrence reads this
 * array as its template, so `order` must stay contiguous and meaningful.
 */
export interface SubtaskEditorProps {
  subtasks: Subtask[];
  canEdit: boolean;
  /** For per-subtask assignee chips; omit to hide them. */
  people?: Profile[];
  onToggle: (subtaskId: string, done: boolean) => void | Promise<void>;
  onChange: (subtasks: Subtask[]) => void | Promise<void>;
}

let localIdSeq = 0;
/** A client-local id good enough to key a fresh row before the parent's
 *  persisted write comes back — the parent always owns the array's contents. */
function localId(): string {
  localIdSeq += 1;
  return `local-${Date.now()}-${localIdSeq}`;
}

/** Re-derive contiguous 0..n-1 order after any structural edit, so a later
 *  recurrence copy reads a meaningful template rather than gappy numbers. */
function reindex(items: Subtask[]): Subtask[] {
  return items.map((s, i) => ({ ...s, order: i }));
}

export function SubtaskEditor({ subtasks, canEdit, people, onToggle, onChange }: SubtaskEditorProps) {
  const [newTitle, setNewTitle] = useState('');
  const [openAssigneeId, setOpenAssigneeId] = useState<string | null>(null);
  const assigneeRef = useRef<HTMLDivElement>(null);

  // "One subtask per property": the property list is fetched the first time
  // the picker opens, not on mount, since most tasks never use it.
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [properties, setProperties] = useState<OnboardingProperty[] | null>(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [propertiesError, setPropertiesError] = useState('');
  const [pickedNames, setPickedNames] = useState<string[]>([]);

  // Bulk assignees / due date across every row.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAssigneeIds, setBulkAssigneeIds] = useState<string[]>([]);
  const [bulkDueDate, setBulkDueDate] = useState('');
  const [bulkOnlyOpen, setBulkOnlyOpen] = useState(true);

  useEffect(() => {
    if (!openAssigneeId) return;
    const onMouseDown = (e: MouseEvent) => {
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) setOpenAssigneeId(null);
    };
    // Capture phase + stopPropagation: Escape closes this list, not the
    // New Task modal around it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpenAssigneeId(null); }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKeyDown, true); };
  }, [openAssigneeId]);

  const sorted = [...subtasks].sort((a, b) => a.order - b.order);
  const done = sorted.filter((s) => s.done).length;

  const commit = (next: Subtask[]) => onChange(reindex(next));

  const handleAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    const item: Subtask = { id: localId(), title, done: false, order: sorted.length };
    commit([...sorted, item]);
    setNewTitle('');
  };

  const handleRename = (id: string, title: string) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, title } : s)));
  };

  const handleDelete = (id: string) => {
    commit(sorted.filter((s) => s.id !== id));
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    const idx = sorted.findIndex((s) => s.id === id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    commit(next);
  };

  const handleAssigneesChange = (id: string, ids: string[]) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, assigneeIds: ids } : s)));
    setOpenAssigneeId(null);
  };

  const handleDueDateChange = (id: string, dueDate: string) => {
    commit(sorted.map((s) => (s.id === id ? { ...s, dueDate: dueDate || null } : s)));
  };

  const openProperties = async () => {
    setPropertiesOpen(true);
    setPickedNames([]);
    if (properties !== null || propertiesLoading) return;
    setPropertiesLoading(true);
    setPropertiesError('');
    try {
      setProperties(await fetchProperties());
    } catch (err) {
      console.error('Failed to load properties for subtasks:', err);
      setPropertiesError('Could not load the property list. Please try again.');
    } finally {
      setPropertiesLoading(false);
    }
  };

  // Live properties only, by name; archived ones are past needing signs.
  const propertyNames = (properties ?? [])
    .filter((p) => !p.archived)
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b));
  const alreadyAdded = namesAlreadyAdded(sorted, propertyNames);
  const selectableNames = propertyNames.filter((n) => !alreadyAdded.has(n));
  const allPicked = selectableNames.length > 0 && selectableNames.every((n) => pickedNames.includes(n));

  const togglePicked = (name: string) => {
    setPickedNames((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  };

  const handleAddProperties = () => {
    // Keep the list's alphabetical order regardless of click order.
    const names = selectableNames.filter((n) => pickedNames.includes(n));
    if (names.length === 0) return;
    commit(subtasksFromNames(sorted, names, localId));
    setPickedNames([]);
    setPropertiesOpen(false);
  };

  const bulkTargets = bulkOnlyOpen ? sorted.filter((s) => !s.done) : sorted;
  const bulkHasChange = bulkAssigneeIds.length > 0 || Boolean(bulkDueDate);

  const handleBulkApply = () => {
    if (!bulkHasChange || bulkTargets.length === 0) return;
    // A blank field means "leave what each row has", so only set what was chosen.
    const patch = {
      ...(bulkAssigneeIds.length > 0 ? { assigneeIds: bulkAssigneeIds } : {}),
      ...(bulkDueDate ? { dueDate: bulkDueDate } : {}),
    };
    commit(applyToSubtasks(sorted, patch, bulkOnlyOpen));
    setBulkOpen(false);
    setBulkAssigneeIds([]);
    setBulkDueDate('');
  };

  return (
    <div className="space-y-2">
      {sorted.length > 0 && (
        <p className="text-xs font-medium text-gray-500">
          {done}/{sorted.length} complete
        </p>
      )}

      {sorted.length === 0 && !canEdit && (
        <p className="text-sm text-gray-400 italic py-2">No subtasks.</p>
      )}

      <ul className="space-y-1">
        {sorted.map((s, idx) => {
          const carried = Boolean(s.carriedFromTaskId);
          const assignees = (s.assigneeIds ?? [])
            .map((id) => people?.find((p) => p.id === id))
            .filter((p): p is Profile => Boolean(p));
          return (
            <li
              key={s.id}
              className={`group rounded-lg border px-3 py-2 ${carried ? 'border-dashed border-amber-300 bg-amber-50/50' : 'border-transparent hover:border-gray-200 hover:bg-gray-50'}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.done}
                  disabled={!canEdit}
                  onChange={(e) => onToggle(s.id, e.target.checked)}
                  className="h-5 w-5 min-w-[20px] rounded border-gray-300 text-brand-dark focus:ring-brand-dark disabled:opacity-50"
                  aria-label={s.done ? `Mark "${s.title}" incomplete` : `Mark "${s.title}" complete`}
                />
                {canEdit ? (
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => handleRename(s.id, e.target.value)}
                    className={`flex-1 min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0 ${s.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}
                  />
                ) : (
                  <span className={`flex-1 min-w-0 truncate text-sm ${s.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                    {s.title}
                  </span>
                )}
                {carried && (
                  <span title="Carried over from a previous occurrence" className="inline-flex items-center gap-1 flex-shrink-0 text-[10px] font-medium text-amber-700">
                    <GitBranch className="h-3 w-3" />
                    carried
                  </span>
                )}
                {canEdit && (
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button type="button" onClick={() => handleMove(s.id, -1)} disabled={idx === 0} title="Move up" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => handleMove(s.id, 1)} disabled={idx === sorted.length - 1} title="Move down" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => handleDelete(s.id)} title="Delete subtask" className="p-1.5 min-h-[28px] min-w-[28px] text-gray-400 hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {(canEdit || assignees.length > 0 || s.dueDate) && (
                <div ref={openAssigneeId === s.id ? assigneeRef : undefined} className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                  {canEdit && people && people.length > 0 ? (
                    <div className="w-40">
                      <button
                        type="button"
                        onClick={() => setOpenAssigneeId(openAssigneeId === s.id ? null : s.id)}
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >
                        {assignees.length > 0 ? assignees.map((a) => a.name.split(' ')[0]).join(', ') : '+ assignee'}
                      </button>
                    </div>
                  ) : (
                    assignees.length > 0 && (
                      <span className="text-xs text-gray-500">{assignees.map((a) => a.name).join(', ')}</span>
                    )
                  )}
                  {canEdit ? (
                    <input
                      type="date"
                      value={s.dueDate ?? ''}
                      onChange={(e) => handleDueDateChange(s.id, e.target.value)}
                      className="text-xs border-0 bg-transparent p-0 text-gray-500 focus:ring-0"
                    />
                  ) : (
                    s.dueDate && <span className="text-xs text-gray-500">Due {s.dueDate}</span>
                  )}
                  {/* In normal flow on its own line, so the open list pushes the
                      rows below down instead of covering their inputs. */}
                  {canEdit && people && people.length > 0 && openAssigneeId === s.id && (
                    <div className="basis-full">
                      <div className="w-56">
                        <AssigneeSelector
                          value={s.assigneeIds ?? []}
                          onChange={(ids) => handleAssigneesChange(s.id, ids)}
                          admins={people}
                          variant="compact"
                          inline
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canEdit && (
        // A plain div, not a <form>: this editor is itself embedded inside
        // TaskDetailPage's page chrome and TaskCreateModal's create form, and
        // HTML forbids nesting <form> elements — a nested one gets silently
        // flattened by the parser and Enter here would submit the WRONG form.
        <div className="flex items-center gap-2 pt-1">
          <Plus className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
            }}
            placeholder="Add a subtask…"
            className="flex-1 min-w-0 border-0 border-b border-transparent bg-transparent p-0 text-sm placeholder:text-gray-400 focus:border-brand-dark focus:ring-0"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newTitle.trim()}
            className="px-2.5 py-1 text-xs font-medium text-brand-dark disabled:opacity-40 disabled:cursor-not-allowed hover:text-[#05391B]"
          >
            Add
          </button>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 pl-6">
          <button
            type="button"
            onClick={() => (propertiesOpen ? setPropertiesOpen(false) : openProperties())}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-dark hover:text-[#05391B]"
            aria-expanded={propertiesOpen}
          >
            <Building2 className="h-3.5 w-3.5" />
            Add a subtask per property
          </button>
          {sorted.length > 1 && people && people.length > 0 && (
            <button
              type="button"
              onClick={() => setBulkOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-dark hover:text-[#05391B]"
              aria-expanded={bulkOpen}
            >
              <Users className="h-3.5 w-3.5" />
              Set assignees or due date for all
            </button>
          )}
        </div>
      )}

      {canEdit && propertiesOpen && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2" role="group" aria-label="Add a subtask per property">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-700">Pick properties. Each becomes a subtask named after it.</p>
            <button type="button" onClick={() => setPropertiesOpen(false)} aria-label="Close property list" className="p-1 text-gray-400 hover:text-gray-700">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {propertiesLoading ? (
            <p className="text-xs text-gray-500">Loading properties…</p>
          ) : propertiesError ? (
            <p className="text-xs text-red-600" role="alert">{propertiesError}</p>
          ) : propertyNames.length === 0 ? (
            <p className="text-xs text-gray-500">No properties yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => setPickedNames(allPicked ? [] : selectableNames)}
                  disabled={selectableNames.length === 0}
                  className="font-medium text-brand-dark hover:text-[#05391B] disabled:opacity-40"
                >
                  {allPicked ? 'Select none' : 'Select all'}
                </button>
                <span className="text-gray-400">
                  {pickedNames.length} of {selectableNames.length} selected
                  {alreadyAdded.size > 0 ? ` · ${alreadyAdded.size} already added` : ''}
                </span>
              </div>
              <ul className="max-h-56 overflow-y-auto space-y-1">
                {propertyNames.map((name) => {
                  const added = alreadyAdded.has(name);
                  return (
                    <li key={name}>
                      <label className={`flex items-center gap-2 text-sm ${added ? 'text-gray-400' : 'text-gray-800'}`}>
                        <input
                          type="checkbox"
                          checked={added || pickedNames.includes(name)}
                          disabled={added}
                          onChange={() => togglePicked(name)}
                          className="h-4 w-4 rounded border-gray-300 text-brand-dark focus:ring-brand-dark disabled:opacity-50"
                        />
                        <span className="truncate">{name}</span>
                        {added && <span className="text-[10px] uppercase tracking-wide text-gray-400">added</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleAddProperties}
                  disabled={pickedNames.length === 0}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add {pickedNames.length || ''} subtask{pickedNames.length === 1 ? '' : 's'}
                </button>
                <button type="button" onClick={() => setPropertiesOpen(false)} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900">
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {canEdit && bulkOpen && people && people.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2" role="group" aria-label="Set assignees or due date for all subtasks">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-700">Applies to every subtask. Leave a field blank to keep what each one has.</p>
            <button type="button" onClick={() => setBulkOpen(false)} aria-label="Close bulk edit" className="p-1 text-gray-400 hover:text-gray-700">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Assignees</label>
              <AssigneeSelector value={bulkAssigneeIds} onChange={setBulkAssigneeIds} admins={people} variant="compact" />
            </div>
            <div>
              <label htmlFor="bulk-subtask-due" className="block text-xs text-gray-500 mb-1">Due date</label>
              <input
                id="bulk-subtask-due"
                type="date"
                value={bulkDueDate}
                onChange={(e) => setBulkDueDate(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={bulkOnlyOpen} onChange={(e) => setBulkOnlyOpen(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-brand-dark focus:ring-brand-dark" />
            Skip subtasks already marked complete
          </label>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleBulkApply}
              disabled={!bulkHasChange || bulkTargets.length === 0}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply to {bulkTargets.length} subtask{bulkTargets.length === 1 ? '' : 's'}
            </button>
            <button type="button" onClick={() => setBulkOpen(false)} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
