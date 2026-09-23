/**
 * Task activity feed — Phase 2. Stub with its final prop shape. Reads
 * `taskEvents` where taskId == …, ordered by createdAt (index deployed), and
 * renders one line per event. Every label must be derived from the event's
 * status TYPE or the stored status name, never from a hard-coded status list.
 */
export interface TaskActivityProps {
  taskId: string;
  /** Cap the feed and show a "show all" affordance past this many events. */
  initialCount?: number;
}

export function TaskActivity(_props: TaskActivityProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Activity — coming soon.
    </div>
  );
}
