/**
 * Task comments — Phase 2 of docs/CLICKUP_MIGRATION_PLAN.md. Stub with its
 * final prop shape. Model on the comments block in TicketDetailPage: read
 * `taskComments` where taskId == …, ordered by createdAt (the composite index
 * is already deployed), compose with MentionTextarea, and let the Cloud
 * Function send the mail — clients never write to `mail`.
 */
export interface TaskCommentsProps {
  taskId: string;
  /** Hides the composer for people who can only read the task. */
  canComment?: boolean;
}

export function TaskComments(_props: TaskCommentsProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Comments — coming soon.
    </div>
  );
}
