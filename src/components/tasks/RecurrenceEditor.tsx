import type { TaskSeries } from '../../types';

/**
 * Recurrence editor — Phase 3. Stub with its final prop shape.
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

export function RecurrenceEditor(_props: RecurrenceEditorProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Recurrence — coming soon.
    </div>
  );
}
