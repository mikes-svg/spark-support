import type { Profile, Task } from '../../types';

/**
 * Month grid for the calendar view — Phase 4. Stub with its final prop shape.
 *
 * Every date here is a 'YYYY-MM-DD' string and `month` is 'YYYY-MM'. Build the
 * grid with the helpers in src/lib/dates.ts — `new Date(dateStr)` parses as UTC
 * midnight and renders a day early in US timezones, which on a calendar is not
 * a subtle bug.
 */
export interface CalendarGridProps {
  /** The month being shown, as 'YYYY-MM'. */
  month: string;
  tasks: Task[];
  /** Today as 'YYYY-MM-DD', for the highlighted cell and overdue styling. */
  today: string;
  people?: Record<string, Profile>;
  /** Clicking empty space in a day cell — used to open the create dialog. */
  onSelectDate?: (date: string) => void;
  onOpenTask?: (taskId: string) => void;
}

export function CalendarGrid(_props: CalendarGridProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-16 text-center text-sm text-gray-500">
      Calendar — coming soon.
    </div>
  );
}
