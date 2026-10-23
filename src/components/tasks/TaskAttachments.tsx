import { useEffect, useState } from 'react';
import { FileText, Film, Image as ImageIcon, Trash2, UploadCloud } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ConfirmModal } from '../ConfirmModal';
import {
  ATTACHMENT_HINT,
  deleteTaskAttachment,
  formatFileSize,
  partitionFiles,
  uploadTaskAttachment,
  watchTaskAttachments,
} from '../../lib/taskAttachments';
import { toDate } from '../../lib/dates';
import type { TaskAttachment } from '../../types';

/**
 * Task attachments — Phase 2. Unlike ticket attachments (listed through a
 * callable, because Storage listing is denied), tasks write a metadata doc to
 * `tasks/{taskId}/attachments` on upload: delete, uploader attribution, and
 * size display need no function round trip. Storage path is
 * `taskAttachments/{taskId}/{filename}`; storage.rules caps it at 200MB and
 * allows image/video/pdf/office/text.
 */
export interface TaskAttachmentsProps {
  taskId: string;
  /** False renders the list read-only — no upload control, no delete buttons. */
  canEdit: boolean;
}

function iconFor(contentType: string) {
  if (contentType.startsWith('image/')) return ImageIcon;
  if (contentType.startsWith('video/')) return Film;
  return FileText;
}

export function TaskAttachments({ taskId, canEdit }: TaskAttachmentsProps) {
  const { user } = useAuth();
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deleting, setDeleting] = useState<TaskAttachment | null>(null);

  useEffect(() => {
    if (!taskId) { setLoading(false); return; }
    const unsubscribe = watchTaskAttachments(
      taskId,
      (rows) => { setAttachments(rows); setLoading(false); },
      () => setLoading(false),
    );
    return unsubscribe;
  }, [taskId]);

  const handleUpload = async (files: FileList) => {
    if (!user || files.length === 0) return;
    const { accepted, rejected } = partitionFiles(Array.from(files));
    setActionError(rejected.length ? `Skipped: ${rejected.join(', ')}. ${ATTACHMENT_HINT}` : '');
    if (accepted.length === 0) return;

    setUploading(true);
    try {
      // Sequential, not Promise.all: keeps upload order predictable and avoids
      // saturating the connection on a batch of large video files.
      for (const file of accepted) {
        await uploadTaskAttachment(taskId, file, user.id);
      }
      // The metadata doc write above is what the live onSnapshot listener
      // picks up — no local state push needed here.
    } catch (err) {
      console.error('Failed to upload attachment:', err);
      setActionError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    // Optimistic: drop it locally, roll back on failure.
    const prev = attachments;
    setAttachments((cur) => cur.filter((a) => a.id !== target.id));
    try {
      await deleteTaskAttachment(taskId, target);
    } catch (err) {
      console.error('Failed to delete attachment:', err);
      setAttachments(prev);
      setActionError('Failed to delete the attachment. Please try again.');
    }
  };

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Attachments</h3>
        {canEdit && (
          <label className="inline-flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
            {uploading ? (
              <div className="h-3.5 w-3.5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            ) : (
              <UploadCloud className="h-3.5 w-3.5" />
            )}
            Add Files
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => { if (e.target.files) { handleUpload(e.target.files); e.target.value = ''; } }}
            />
          </label>
        )}
      </div>
      <div className="p-4">
        {actionError && <p className="text-xs text-red-600 mb-2" role="alert">{actionError}</p>}
        {loading ? (
          <p className="text-sm text-gray-400 text-center py-2">Loading…</p>
        ) : attachments.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-2">No attachments.</p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((att) => {
              const isImage = att.contentType.startsWith('image/');
              const Icon = iconFor(att.contentType);
              const uploadedAt = toDate(att.uploadedAt);
              return (
                <li key={att.id} className="flex items-center gap-3 group">
                  {isImage ? (
                    <a href={att.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                      <img src={att.url} alt="" className="w-10 h-10 rounded-md object-cover border border-gray-200" />
                    </a>
                  ) : (
                    <span className="flex-shrink-0 w-10 h-10 rounded-md bg-gray-100 border border-gray-200 flex items-center justify-center">
                      <Icon className="h-4 w-4 text-gray-500" />
                    </span>
                  )}
                  <a
                    href={att.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 text-sm text-brand-dark hover:text-brand-gold transition-colors truncate"
                    title={att.name}
                  >
                    {att.name}
                  </a>
                  <span className="flex-shrink-0 text-xs text-gray-400">
                    {formatFileSize(att.size)}
                    {uploadedAt ? ` · ${uploadedAt.toLocaleDateString()}` : ''}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => setDeleting(att)}
                      className="flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-300 hover:text-red-600 transition-colors"
                      aria-label={`Delete ${att.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmModal
        open={!!deleting}
        title="Delete Attachment"
        message={`Delete "${deleting?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
