import { useState } from 'react';
import { Plus, X, Check, ArrowDown } from 'lucide-react';
import { AssigneeSelector } from '../AssigneeSelector';
import { Avatar } from '../Avatar';
import { currentStage, canCompleteStage } from '../../types';
import type { Profile, TaskStage } from '../../types';

/**
 * Sequential sign-off chain on a task.
 *
 * Only the current stage is actionable — later ones are shown but inert — so
 * the screen answers "whose turn is it?" without anybody having to read dates
 * or guess. Completing the current stage hands the task to the next stage's
 * people; that reassignment and the final close are done server-side by
 * onTaskStageAdvanced, not here, so a half-finished click cannot strand a task.
 */

export interface StageEditorProps {
  stages: TaskStage[];
  taskAssignees: string[];
  people: Profile[];
  canEdit: boolean;
  currentUserId: string;
  onChange: (stages: TaskStage[]) => void;
}

export function StageEditor({ stages, taskAssignees, people, canEdit, currentUserId, onChange }: StageEditorProps) {
  const [newName, setNewName] = useState('');
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  const active = currentStage(stages);

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onChange([
      ...stages,
      {
        id: `stage-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        name,
        assigneeIds: [],
        done: false,
        order: (stages.length ? Math.max(...stages.map((s) => s.order)) : 0) + 100,
      },
    ]);
    setNewName('');
  };

  const patch = (id: string, next: Partial<TaskStage>) =>
    onChange(stages.map((s) => (s.id === id ? { ...s, ...next } : s)));

  const remove = (id: string) => onChange(stages.filter((s) => s.id !== id));

  const signOff = (stage: TaskStage) =>
    patch(stage.id, { done: true, doneBy: currentUserId, doneAt: null });

  if (ordered.length === 0 && !canEdit) {
    return <p className="text-sm text-gray-500">No sign-off stages on this task.</p>;
  }

  return (
    <div className="space-y-3">
      {ordered.map((stage, i) => {
        const isActive = active?.id === stage.id;
        const maySign = isActive && canCompleteStage(currentUserId, stage, taskAssignees);
        return (
          <div key={stage.id}>
            <div
              className={`rounded-lg border px-4 py-3 ${
                stage.done
                  ? 'border-emerald-200 bg-emerald-50/50'
                  : isActive
                    ? 'border-brand-dark/30 bg-brand-dark/5'
                    : 'border-gray-200 bg-white opacity-70'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                      stage.done ? 'bg-emerald-600 text-white' : isActive ? 'bg-brand-dark text-white' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {stage.done ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    <span className="text-sm font-medium text-gray-900 truncate">{stage.name}</span>
                    {isActive && !stage.done && (
                      <span className="text-[11px] uppercase tracking-wide text-brand-dark font-semibold">Current</span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {canEdit && !stage.done ? (
                      <div className="w-full sm:w-64">
                        <AssigneeSelector
                          value={stage.assigneeIds}
                          onChange={(ids) => patch(stage.id, { assigneeIds: ids })}
                          admins={people}
                          variant="full"
                          placeholder="Whoever is on the task"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {stage.assigneeIds.length === 0 && (
                          <span className="text-xs text-gray-500">Whoever is on the task</span>
                        )}
                        {stage.assigneeIds.map((id) => {
                          const p = people.find((x) => x.id === id);
                          return p ? (
                            <span key={id} className="inline-flex items-center gap-1 text-xs text-gray-600">
                              <Avatar src={p.photoURL} name={p.name} className="h-4 w-4 rounded-full" />
                              {p.name}
                            </span>
                          ) : null;
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {maySign && (
                    <button
                      type="button"
                      onClick={() => signOff(stage)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-dark text-white hover:bg-[#05391B] transition-colors min-h-[32px]"
                    >
                      Sign off
                    </button>
                  )}
                  {canEdit && !stage.done && (
                    <button
                      type="button"
                      onClick={() => remove(stage.id)}
                      aria-label={`Remove stage ${stage.name}`}
                      className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {i < ordered.length - 1 && (
              <div className="flex justify-center py-0.5">
                <ArrowDown className="h-3.5 w-3.5 text-gray-300" aria-hidden="true" />
              </div>
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="Add a stage, e.g. Manager review"
            aria-label="New stage name"
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-brand-dark focus:border-brand-dark min-h-[44px] sm:min-h-0"
          />
          <button
            type="button"
            onClick={add}
            disabled={!newName.trim()}
            className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Plus className="h-4 w-4 mr-1" />Add
          </button>
        </div>
      )}

      {ordered.length > 0 && (
        <p className="text-xs text-gray-500">
          Signing off a stage reassigns the task to the next stage&rsquo;s people and emails them. The last
          sign-off closes the task.
        </p>
      )}
    </div>
  );
}
