/**
 * Task attachments — Phase 2. Stub with its final prop shape.
 *
 * Unlike ticket attachments (listed through a callable, because Storage listing
 * is denied), tasks write a metadata doc to `tasks/{taskId}/attachments` on
 * upload: delete, uploader attribution, and size display need no function round
 * trip. Storage path is `taskAttachments/{taskId}/{filename}`; storage.rules
 * caps it at 200MB and allows image/video/pdf/office/text.
 */
export interface TaskAttachmentsProps {
  taskId: string;
  /** False renders the list read-only — no upload control, no delete buttons. */
  canEdit: boolean;
}

export function TaskAttachments(_props: TaskAttachmentsProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
      Attachments — coming soon.
    </div>
  );
}
