import { useCallback, useEffect, useMemo, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { functions } from '../../lib/firebase';
import { formatDateOnly, todayStr } from '../../lib/dates';
import type { TaskCopyOnRecur, TaskRecurrenceFreq, TaskSeries } from '../../types';

/**
 * Recurrence editor — Phase 3.
 *
 * Controlled: it edits the stored definition only. It must NOT compute the next
 * occurrences itself — the "next 5 occurrences" preview calls the
 * `previewRecurrence` callable, because recurrence math lives in exactly one
 * place (functions/recurrence.js). Two copies of date math is how these
 * features silently drift apart.
 */
export interface RecurrenceEditorProps {
  /** Null means "not recurring yet" — the editor offers to turn it on. */
  value: Pick<TaskSeries, 'recurrence' | 'trigger' | 'skipWeekends' | 'weekendShift' | 'startOffsetDays' | 'copyOnRecur' | 'missedPolicy' | 'resetStatusTo' | 'endDate' | 'occurrenceLimit' | 'active' | 'timezone'> | null;
  onChange: (value: RecurrenceEditorProps['value']) => void;
  disabled?: boolean;
}

type Value = NonNullable<RecurrenceEditorProps['value']>;

const WEEKDAYS = [
  { value: 0, short: 'S', label: 'Sunday' },
  { value: 1, short: 'M', label: 'Monday' },
  { value: 2, short: 'T', label: 'Tuesday' },
  { value: 3, short: 'W', label: 'Wednesday' },
  { value: 4, short: 'T', label: 'Thursday' },
  { value: 5, short: 'F', label: 'Friday' },
  { value: 6, short: 'S', label: 'Saturday' },
];

const FREQ_LABELS: Record<TaskRecurrenceFreq, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every other week',
  monthly: 'Monthly',
  yearly: 'Yearly',
  custom: 'Custom (every N days)',
};

/** Mirrors ClickUp's "Include in new task" checkboxes, in the order it showed them. */
const COPY_FIELDS: { key: keyof TaskCopyOnRecur; label: string }[] = [
  { key: 'description', label: 'Description' },
  { key: 'subtasks', label: 'Subtasks' },
  { key: 'subtaskAssignees', label: 'Subtask assignees' },
  { key: 'remapSubtaskDates', label: 'Remap subtask dates' },
  { key: 'assignees', label: 'Assignees' },
  { key: 'watchers', label: 'Watchers' },
  { key: 'tags', label: 'Tags' },
  { key: 'comments', label: 'Comments' },
  { key: 'attachments', label: 'Attachments' },
  { key: 'activity', label: 'Activity' },
];

const DEFAULT_COPY_ON_RECUR: TaskCopyOnRecur = {
  description: true,
  subtasks: true,
  subtaskAssignees: true,
  remapSubtaskDates: true,
  assignees: true,
  watchers: true,
  comments: false,
  tags: true,
  keepCheckedItems: false,
  carryMode: 'reset',
  attachments: false,
  activity: false,
};

/**
 * What a series looks like the moment someone flips "Repeats" on.
 *
 * `trigger` is 'on-completion' because that is what the audited ClickUp series
 * actually used ("On status change: Complete → create next"), not because it is
 * alphabetically first. `missedPolicy` is 'skip-to-next' because the default has
 * to be the one that cannot pile up — that is the bug this phase exists to fix.
 *
 * `resetStatusTo` is left empty: the status set belongs to the list, which this
 * component isn't given, so the server falls back to the list's default To Do.
 */
function defaultValue(): Value {
  return {
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [new Date().getDay()] },
    trigger: 'on-completion',
    resetStatusTo: '',
    skipWeekends: false,
    weekendShift: 'next',
    startOffsetDays: 0,
    copyOnRecur: { ...DEFAULT_COPY_ON_RECUR },
    missedPolicy: 'skip-to-next',
    endDate: null,
    occurrenceLimit: null,
    active: true,
    timezone: 'America/Chicago',
  };
}

const fieldClass =
  'min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-dark focus:outline-none focus:ring-1 focus:ring-brand-dark disabled:bg-gray-50 disabled:text-gray-400';
const labelClass = 'block text-xs font-medium uppercase tracking-wide text-gray-500 mb-1';

export function RecurrenceEditor({ value, onChange, disabled = false }: RecurrenceEditorProps) {
  const [preview, setPreview] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const patch = useCallback(
    (partial: Partial<Value>) => {
      if (!value) return;
      onChange({ ...value, ...partial });
    },
    [value, onChange],
  );

  const patchRecurrence = useCallback(
    (partial: Partial<Value['recurrence']>) => {
      if (!value) return;
      onChange({ ...value, recurrence: { ...value.recurrence, ...partial } });
    },
    [value, onChange],
  );

  const patchCopy = useCallback(
    (partial: Partial<TaskCopyOnRecur>) => {
      if (!value) return;
      onChange({ ...value, copyOnRecur: { ...DEFAULT_COPY_ON_RECUR, ...value.copyOnRecur, ...partial } });
    },
    [value, onChange],
  );

  const freq = value?.recurrence.freq ?? 'weekly';
  const isDaily = freq === 'daily';
  const showWeekdays = freq === 'weekly' || freq === 'biweekly' || freq === 'custom';
  const monthlyMode = value?.recurrence.monthlyMode ?? 'day-of-month';

  // The request body, as a string, so the preview effect can depend on the
  // *content* of the config rather than the object identity — the parent rebuilds
  // `value` on every keystroke, and depending on the object would refire per key.
  const previewKey = useMemo(() => {
    if (!value) return '';
    return JSON.stringify({
      recurrence: value.recurrence,
      trigger: value.trigger,
      skipWeekends: value.skipWeekends,
      weekendShift: value.weekendShift,
      endDate: value.endDate ?? null,
      occurrenceLimit: value.occurrenceLimit ?? null,
      timezone: value.timezone,
    });
  }, [value]);

  useEffect(() => {
    if (!previewKey) {
      setPreview([]);
      setPreviewError('');
      return;
    }
    if (!functions) {
      setPreviewError('Preview is unavailable — Cloud Functions are not configured.');
      return;
    }

    let cancelled = false;
    setPreviewing(true);
    // Debounced: typing "14" in the interval box shouldn't cost two round trips.
    const timer = setTimeout(async () => {
      try {
        const call = httpsCallable<Record<string, unknown>, { occurrences: string[] }>(
          functions!,
          'previewRecurrence',
        );
        const res = await call({ ...JSON.parse(previewKey), from: todayStr(), count: 5 });
        if (cancelled) return;
        setPreview(res.data?.occurrences ?? []);
        setPreviewError('');
      } catch (err) {
        if (cancelled) return;
        console.error('Recurrence preview failed:', err);
        setPreview([]);
        setPreviewError('Could not preview this schedule.');
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewKey]);

  if (!value) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center">
        <CalendarClock className="mx-auto h-8 w-8 text-gray-300" aria-hidden="true" />
        <p className="mt-2 text-sm text-gray-500">This task doesn&apos;t repeat.</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(defaultValue())}
          className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand-dark px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Make it repeat
        </button>
      </div>
    );
  }

  const toggleWeekday = (day: number) => {
    const current = value.recurrence.byWeekday ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b);
    // Never let the list empty out — a weekly series with no weekday has no dates
    // at all, and the preview would just silently go blank.
    patchRecurrence({ byWeekday: next.length ? next : current });
  };

  return (
    <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-base font-semibold text-gray-900">Repeats</h3>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="min-h-[44px] rounded-lg px-3 text-sm font-medium text-gray-500 hover:text-gray-800 disabled:opacity-40"
        >
          Turn off
        </button>
      </div>

      {/* ── Cadence ─────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="rec-freq">
            Frequency
          </label>
          <select
            id="rec-freq"
            className={fieldClass}
            disabled={disabled}
            value={freq}
            onChange={(e) => patchRecurrence({ freq: e.target.value as TaskRecurrenceFreq })}
          >
            {(Object.keys(FREQ_LABELS) as TaskRecurrenceFreq[]).map((f) => (
              <option key={f} value={f}>
                {FREQ_LABELS[f]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="rec-interval">
            Every
          </label>
          <input
            id="rec-interval"
            type="number"
            min={1}
            max={99}
            className={fieldClass}
            disabled={disabled}
            value={value.recurrence.interval}
            onChange={(e) => patchRecurrence({ interval: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
      </div>

      {showWeekdays && (
        <div>
          <span className={labelClass}>On these days</span>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => {
              const on = (value.recurrence.byWeekday ?? []).includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  aria-label={d.label}
                  onClick={() => toggleWeekday(d.value)}
                  className={`h-11 w-11 rounded-full border text-sm font-medium disabled:opacity-40 ${
                    on ? 'border-brand-dark bg-brand-dark text-white' : 'border-gray-300 bg-white text-gray-600'
                  }`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {freq === 'monthly' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            {(['day-of-month', 'nth-weekday'] as const).map((mode) => (
              <label key={mode} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="rec-monthly-mode"
                  disabled={disabled}
                  checked={monthlyMode === mode}
                  onChange={() => patchRecurrence({ monthlyMode: mode })}
                />
                {mode === 'day-of-month' ? 'On a day of the month' : 'On the nth weekday'}
              </label>
            ))}
          </div>

          {monthlyMode === 'day-of-month' ? (
            <div className="sm:w-1/2">
              <label className={labelClass} htmlFor="rec-dom">
                Day of the month
              </label>
              <select
                id="rec-dom"
                className={fieldClass}
                disabled={disabled}
                value={String(value.recurrence.dayOfMonth ?? 1)}
                onChange={(e) =>
                  patchRecurrence({ dayOfMonth: e.target.value === 'last' ? 'last' : Number(e.target.value) })
                }
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value="last">Last day</option>
              </select>
              {/* Says out loud what the engine does, so nobody has to discover it. */}
              <p className="mt-1 text-xs text-gray-500">
                Short months clamp to their last day — the 31st still fires in February.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="rec-nth">
                  Which
                </label>
                <select
                  id="rec-nth"
                  className={fieldClass}
                  disabled={disabled}
                  value={String(value.recurrence.dayOfMonth ?? 1)}
                  onChange={(e) =>
                    patchRecurrence({ dayOfMonth: e.target.value === 'last' ? 'last' : Number(e.target.value) })
                  }
                >
                  {['First', 'Second', 'Third', 'Fourth', 'Fifth'].map((label, i) => (
                    <option key={label} value={i + 1}>
                      {label}
                    </option>
                  ))}
                  <option value="last">Last</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="rec-nth-day">
                  Weekday
                </label>
                <select
                  id="rec-nth-day"
                  className={fieldClass}
                  disabled={disabled}
                  value={String(value.recurrence.byWeekday?.[0] ?? 1)}
                  onChange={(e) => patchRecurrence({ byWeekday: [Number(e.target.value)] })}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Trigger ─────────────────────────────────────────────────────── */}
      <fieldset className="space-y-2">
        <legend className={labelClass}>Create the next one</legend>
        {(
          [
            ['on-completion', 'When this one is completed', 'How the migrated ClickUp series worked. Nothing appears until someone finishes the current task.'],
            ['on-schedule', 'On the schedule above', 'A new task appears on each date, whether or not the last one is done.'],
          ] as const
        ).map(([mode, title, hint]) => (
          <label
            key={mode}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
              value.trigger === mode ? 'border-brand-dark bg-brand-cream/40' : 'border-gray-200'
            }`}
          >
            <input
              type="radio"
              name="rec-trigger"
              className="mt-1"
              disabled={disabled}
              checked={value.trigger === mode}
              onChange={() => patch({ trigger: mode })}
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">{title}</span>
              <span className="block text-xs text-gray-500">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* ── Weekends ────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.skipWeekends}
            onChange={(e) => patch({ skipWeekends: e.target.checked })}
          />
          Skip weekends
        </label>
        {value.skipWeekends &&
          (isDaily ? (
            // The daily reading and the weekly-and-slower reading are genuinely
            // different behaviours, so the editor states which one is in force
            // rather than letting people assume.
            <p className="text-xs text-gray-500">
              Daily series don&apos;t generate at all on Saturday or Sunday — those days are skipped, not moved.
            </p>
          ) : (
            <div className="sm:w-2/3">
              <label className={labelClass} htmlFor="rec-shift">
                Move a weekend due date to
              </label>
              <select
                id="rec-shift"
                className={fieldClass}
                disabled={disabled}
                value={value.weekendShift}
                onChange={(e) => patch({ weekendShift: e.target.value as 'next' | 'previous' })}
              >
                <option value="next">The next weekday (Monday)</option>
                <option value="previous">The previous weekday (Friday)</option>
              </select>
            </div>
          ))}
      </div>

      {/* ── Behaviour ───────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="rec-missed">
            If the last one is still open
          </label>
          <select
            id="rec-missed"
            className={fieldClass}
            disabled={disabled}
            value={value.missedPolicy}
            onChange={(e) => patch({ missedPolicy: e.target.value as Value['missedPolicy'] })}
          >
            <option value="skip-to-next">Roll it forward — don&apos;t make a second one</option>
            <option value="accumulate">Make a new one anyway</option>
            <option value="keep-one-open">Leave it alone and skip this cycle</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Rolling forward is the default: it keeps one live task with a record of every cycle it slipped, instead of
            a stack of copies nobody works.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="rec-carry">
            Subtasks each cycle
          </label>
          <select
            id="rec-carry"
            className={fieldClass}
            disabled={disabled}
            value={value.copyOnRecur?.carryMode ?? 'reset'}
            onChange={(e) => patchCopy({ carryMode: e.target.value as TaskCopyOnRecur['carryMode'] })}
          >
            <option value="reset">Start fresh from the template</option>
            <option value="carry-unfinished">Carry anything left unfinished</option>
          </select>
          {value.copyOnRecur?.carryMode === 'carry-unfinished' && (
            <p className="mt-1 text-xs text-gray-500">
              After three cycles of carrying the same work, the task is flagged in the list and the morning digest.
            </p>
          )}
        </div>
      </div>

      {/* ── Include in new task ─────────────────────────────────────────── */}
      <div>
        <span className={labelClass}>Include in each new task</span>
        <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
          {COPY_FIELDS.map((f) => (
            <label key={f.key} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                disabled={disabled}
                checked={Boolean((value.copyOnRecur ?? DEFAULT_COPY_ON_RECUR)[f.key])}
                onChange={(e) => patchCopy({ [f.key]: e.target.checked } as Partial<TaskCopyOnRecur>)}
              />
              {f.label}
            </label>
          ))}
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              disabled={disabled}
              checked={Boolean(value.copyOnRecur?.keepCheckedItems)}
              onChange={(e) => patchCopy({ keepCheckedItems: e.target.checked })}
            />
            Keep ticked subtasks
          </label>
        </div>
      </div>

      {/* ── End ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="rec-end">
            Stop repeating after
          </label>
          <input
            id="rec-end"
            type="date"
            className={fieldClass}
            disabled={disabled}
            value={value.endDate ?? ''}
            onChange={(e) => patch({ endDate: e.target.value || null })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="rec-limit">
            Or after this many
          </label>
          <input
            id="rec-limit"
            type="number"
            min={1}
            placeholder="No limit"
            className={fieldClass}
            disabled={disabled}
            value={value.occurrenceLimit ?? ''}
            onChange={(e) => patch({ occurrenceLimit: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
          />
        </div>
      </div>

      {/* ── Preview ─────────────────────────────────────────────────────── */}
      <div className="rounded-lg bg-brand-cream/50 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600">Next 5 occurrences</span>
          {previewing && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" aria-hidden="true" />}
        </div>
        {previewError ? (
          <p className="mt-2 text-sm text-red-700">{previewError}</p>
        ) : preview.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            {previewing ? 'Working it out…' : 'This schedule produces no more occurrences.'}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {preview.map((date) => (
              <li key={date} className="rounded-full bg-white px-3 py-1 text-sm text-gray-800 shadow-sm">
                {formatDateOnly(date)}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-gray-500">
          Calculated on the server, by the same code that creates the tasks.
        </p>
      </div>
    </div>
  );
}
