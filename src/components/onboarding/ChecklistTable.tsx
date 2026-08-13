import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  IndentIncrease,
  IndentDecrease,
  Clock,
} from 'lucide-react';
import { AssigneeSelector } from '../AssigneeSelector';
import { ONBOARDING_STATUSES } from '../../types';
import type { OnboardingStatus, OnboardingDelay, Profile } from '../../types';
import { groupBySection, isTaskDone, isOverdue } from '../../lib/onboarding';
import { todayStr, formatDateOnly } from '../../lib/dates';

/**
 * The row shape both callers share. Template rows simply leave the
 * property-only fields (dueDate/status/notes/delays) undefined.
 */
export interface ChecklistRow {
  id: string;
  section: string;
  order: number;
  code: string;
  indent: 0 | 1;
  title: string;
  responsibleIds: string[];
  daysFromClosing: number | null;
  dueDate?: string | null;
  status?: OnboardingStatus;
  notes?: string;
  delays?: OnboardingDelay[];
}

interface Props {
  rows: ChecklistRow[];
  /** People selectable as responsible — everyone with onboarding access. */
  people: Profile[];
  /** 'template' hides the due date, status and notes columns. */
  mode: 'template' | 'property';
  /** Drives the Days-from-Closing → Due Date formula in property mode. */
  closingDate?: string | null;
  /** When false the table is read-only (no edits, no row/section actions). */
  canEdit: boolean;
  onPatchRow: (row: ChecklistRow, patch: Partial<ChecklistRow>) => void;
  /** Due-date edits route through the parent so it can require a delay reason. */
  onDueDateChange?: (row: ChecklistRow, dueDate: string | null) => void;
  onAddRow: (section: string, afterRow: ChecklistRow | null) => void;
  onDeleteRow: (row: ChecklistRow) => void;
  onMoveRow: (row: ChecklistRow, direction: -1 | 1) => void;
  onRenameSection: (from: string, to: string) => void;
  onDeleteSection: (section: string) => void;
  onAddSection: () => void;
}

const STATUS_STYLES: Record<OnboardingStatus, string> = {
  'Not Started': 'bg-gray-100 text-gray-700 border-gray-200',
  'In Progress': 'bg-amber-100 text-amber-800 border-amber-200',
  Complete: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  'N/A': 'bg-slate-100 text-slate-500 border-slate-200',
};

/**
 * A text cell that edits in place: it keeps a local draft while typing and
 * commits on blur or Enter, so a slow Firestore write never fights the cursor.
 */
function EditableText({
  value,
  onCommit,
  disabled,
  placeholder,
  className = '',
  textarea,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  textarea?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  const base =
    'w-full bg-transparent border border-transparent rounded px-2 py-1 text-sm hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark disabled:hover:border-transparent';

  if (textarea) {
    return (
      <textarea
        value={draft}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className={`${base} resize-y min-h-[2rem] ${className}`}
      />
    );
  }
  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      className={`${base} ${className}`}
    />
  );
}

/** Days-from-Closing cell: an integer or blank, where blank means "no formula". */
function EditableOffset({
  value,
  onCommit,
  disabled,
  ariaLabel,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => setDraft(value == null ? '' : String(value)), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number.parseInt(trimmed, 10);
    if (trimmed !== '' && Number.isNaN(next as number)) {
      setDraft(value == null ? '' : String(value));
      return;
    }
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      disabled={disabled}
      placeholder="—"
      aria-label={ariaLabel}
      title="Days from closing (negative = before closing)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value == null ? '' : String(value));
      }}
      className="w-16 bg-transparent border border-transparent rounded px-2 py-1 text-sm text-center tabular-nums hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark"
    />
  );
}

/** Section header: the name itself is editable, with the section's actions beside it. */
function SectionHeader({
  section,
  done,
  total,
  canEdit,
  columnCount,
  onRename,
  onDelete,
  onAddRow,
}: {
  section: string;
  done: number;
  total: number;
  canEdit: boolean;
  columnCount: number;
  onRename: (next: string) => void;
  onDelete: () => void;
  onAddRow: () => void;
}) {
  return (
    <tr className="bg-brand-dark/5">
      <td colSpan={columnCount} className="px-4 py-2">
        <div className="flex items-center gap-3">
          {canEdit ? (
            <EditableText
              value={section}
              ariaLabel={`Section name: ${section}`}
              onCommit={(next) => next && next !== section && onRename(next)}
              className="!text-sm !font-semibold uppercase tracking-wider text-brand-dark max-w-xs"
            />
          ) : (
            <span className="px-2 py-1 text-sm font-semibold uppercase tracking-wider text-brand-dark">{section}</span>
          )}
          {total > 0 && (
            <span className="text-xs font-medium text-gray-500 tabular-nums whitespace-nowrap">
              {done}/{total} done
            </span>
          )}
          {canEdit && (
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={onAddRow}
                title={`Add a task to ${section}`}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 hover:text-brand-dark hover:bg-white rounded transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />Task
              </button>
              <button
                onClick={onDelete}
                title={`Delete the ${section} section`}
                aria-label={`Delete section ${section}`}
                className="p-1 text-red-400 hover:text-red-600 hover:bg-white rounded transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ChecklistTable({
  rows,
  people,
  mode,
  closingDate,
  canEdit,
  onPatchRow,
  onDueDateChange,
  onAddRow,
  onDeleteRow,
  onMoveRow,
  onRenameSection,
  onDeleteSection,
  onAddSection,
}: Props) {
  const isProperty = mode === 'property';
  const today = useRef(todayStr()).current;
  const groups = groupBySection(rows);
  const sorted = [...rows].sort((a, b) => a.order - b.order);

  const headers = isProperty
    ? ['#', 'Task', 'Responsibility', 'Days', 'Due Date', 'Status', 'Notes']
    : ['#', 'Task', 'Responsibility', 'Days'];
  const columnCount = headers.length + (canEdit ? 1 : 0);

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-white">
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
              {canEdit && <th scope="col" className="px-4 py-3 w-px"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {groups.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-6 py-12 text-center text-sm text-gray-500">
                  No checklist items yet.
                </td>
              </tr>
            )}
            {groups.map((group, groupIndex) => {
              const done = group.rows.filter((r) => isTaskDone({ status: r.status ?? '' })).length;
              // Item numbers are derived, not stored: the Nth section is the
              // N00 block and rows count up from there, so adding, deleting, or
              // moving a row renumbers everything automatically and can't drift.
              const sectionBase = (groupIndex + 1) * 100;
              return (
                <React.Fragment key={`${group.section}-${group.rows[0]?.id}`}>
                  <SectionHeader
                    section={group.section}
                    done={done}
                    total={isProperty ? group.rows.length : 0}
                    canEdit={canEdit}
                    columnCount={columnCount}
                    onRename={(next) => onRenameSection(group.section, next)}
                    onDelete={() => onDeleteSection(group.section)}
                    onAddRow={() => onAddRow(group.section, group.rows[group.rows.length - 1] ?? null)}
                  />
                  {group.rows.map((row, rowIdx) => {
                    const overdue = isProperty && isOverdue({ status: row.status ?? '', dueDate: row.dueDate }, today);
                    const globalIndex = sorted.findIndex((r) => r.id === row.id);
                    const delays = row.delays ?? [];
                    const code = String(sectionBase + rowIdx);
                    // Bare inputs in a grid each need their own accessible name —
                    // the column heading alone doesn't say which row you're in.
                    const rowName = row.title || `item ${code}`;
                    return (
                      <tr key={row.id} className={`group ${overdue ? 'bg-red-50/40' : 'hover:bg-gray-50/60'}`}>
                        {/* Read-only: the number is derived from position, not
                            typed. min-w keeps a four-digit code (1008) unclipped. */}
                        <td className="px-3 py-1.5 align-top min-w-[5rem]">
                          <span className="inline-block px-2 py-1 text-xs tabular-nums text-gray-500">{code}</span>
                        </td>
                        <td className="px-4 py-1.5 align-top min-w-[18rem]">
                          <div className={row.indent === 1 ? 'pl-6' : ''}>
                            <EditableText
                              value={row.title}
                              disabled={!canEdit}
                              placeholder="Task description"
                              ariaLabel={`Task description for item ${code}`}
                              onCommit={(title) => onPatchRow(row, { title })}
                              className={row.indent === 1 ? 'text-gray-700' : 'font-medium text-gray-900'}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-1.5 align-top min-w-[11rem]">
                          <AssigneeSelector
                            value={row.responsibleIds}
                            admins={people}
                            disabled={!canEdit}
                            emptyLabel="Nobody has onboarding access yet"
                            onChange={(responsibleIds) => onPatchRow(row, { responsibleIds })}
                          />
                        </td>
                        <td className="px-4 py-1.5 align-top">
                          <EditableOffset
                            value={row.daysFromClosing}
                            disabled={!canEdit}
                            ariaLabel={`Days from closing for ${rowName}`}
                            onCommit={(daysFromClosing) => onPatchRow(row, { daysFromClosing })}
                          />
                        </td>
                        {isProperty && (
                          <>
                            <td className="px-4 py-1.5 align-top whitespace-nowrap">
                              <div className="flex items-center gap-1">
                                <input
                                  type="date"
                                  value={row.dueDate ?? ''}
                                  disabled={!canEdit}
                                  aria-label={`Due date for ${rowName}`}
                                  onChange={(e) => onDueDateChange?.(row, e.target.value || null)}
                                  className={`bg-transparent border border-transparent rounded px-2 py-1 text-sm hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark ${
                                    overdue ? 'text-red-700 font-medium' : 'text-gray-700'
                                  }`}
                                />
                                {delays.length > 0 && (
                                  <span
                                    title={delays
                                      .map((d) => `Moved to ${formatDateOnly(d.toDate)}: ${d.reason}`)
                                      .join('\n')}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium"
                                  >
                                    <Clock className="h-3 w-3" />
                                    {delays.length}
                                  </span>
                                )}
                              </div>
                              {!closingDate && row.daysFromClosing != null && (
                                <span className="block px-2 text-[10px] text-gray-400">set closing date</span>
                              )}
                            </td>
                            <td className="px-4 py-1.5 align-top">
                              <select
                                value={row.status ?? 'Not Started'}
                                disabled={!canEdit}
                                aria-label={`Status for ${rowName}`}
                                onChange={(e) => onPatchRow(row, { status: e.target.value as OnboardingStatus })}
                                className={`rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-dark ${
                                  STATUS_STYLES[(row.status ?? 'Not Started') as OnboardingStatus]
                                }`}
                              >
                                {ONBOARDING_STATUSES.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-1.5 align-top min-w-[14rem]">
                              <EditableText
                                value={row.notes ?? ''}
                                disabled={!canEdit}
                                placeholder="—"
                                ariaLabel={`Notes for ${rowName}`}
                                textarea
                                onCommit={(notes) => onPatchRow(row, { notes })}
                                className="text-gray-600"
                              />
                            </td>
                          </>
                        )}
                        {canEdit && (
                          <td className="px-2 py-1.5 align-top whitespace-nowrap">
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button
                                onClick={() => onMoveRow(row, -1)}
                                disabled={globalIndex <= 0}
                                title="Move up"
                                aria-label="Move row up"
                                className="p-1 text-gray-400 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => onMoveRow(row, 1)}
                                disabled={globalIndex >= sorted.length - 1}
                                title="Move down"
                                aria-label="Move row down"
                                className="p-1 text-gray-400 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => onPatchRow(row, { indent: row.indent === 1 ? 0 : 1 })}
                                title={row.indent === 1 ? 'Outdent' : 'Indent as sub-item'}
                                aria-label={row.indent === 1 ? 'Outdent row' : 'Indent row'}
                                className="p-1 text-gray-400 hover:text-brand-dark"
                              >
                                {row.indent === 1 ? <IndentDecrease className="h-3.5 w-3.5" /> : <IndentIncrease className="h-3.5 w-3.5" />}
                              </button>
                              <button
                                onClick={() => onAddRow(row.section, row)}
                                title="Insert a row below"
                                aria-label="Insert row below"
                                className="p-1 text-gray-400 hover:text-brand-dark"
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => onDeleteRow(row)}
                                title="Delete this row"
                                aria-label={`Delete ${row.title || 'row'}`}
                                className="p-1 text-red-400 hover:text-red-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="px-4 py-3 border-t border-gray-200 bg-gray-50/50">
          <button
            onClick={onAddSection}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4 mr-1.5" />Add Section
          </button>
        </div>
      )}
    </div>
  );
}
