import { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { Send, Pencil, Trash2, X, Check } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { Avatar } from '../Avatar';
import { ConfirmModal } from '../ConfirmModal';
import { MentionTextarea, renderCommentBody } from '../MentionTextarea';
import { logTaskComment } from '../../lib/taskEvents';
import { toDate } from '../../lib/dates';
import type { Profile, TaskComment } from '../../types';

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

export function TaskComments({ taskId, canComment = true }: TaskCommentsProps) {
  const { user } = useAuth();
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');

  const [newComment, setNewComment] = useState('');
  const [pendingMentionIds, setPendingMentionIds] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [editingMentionIds, setEditingMentionIds] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingComment, setDeletingComment] = useState<TaskComment | null>(null);

  // Mirror `profiles` into a ref so the onSnapshot listener (whose effect only
  // depends on `taskId`) can read the latest loaded profiles instead of a
  // stale closure value, avoiding redundant re-fetches of authors we already have.
  const profilesRef = useRef<Record<string, Profile>>({});
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);

  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!db || !taskId) { setLoading(false); return; }

    // Everyone who can read the task can be @mentioned — task reads are open
    // to every signed-in user (plan §2), unlike ticket participants-only reads.
    getDocs(collection(db, 'profiles'))
      .then((snap) => setAllProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile))))
      .catch(() => {});

    let unsubscribe: (() => void) | undefined;
    try {
      const q = query(collection(db, 'taskComments'), where('taskId', '==', taskId), orderBy('createdAt', 'asc'));
      unsubscribe = onSnapshot(
        q,
        async (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskComment));
          setComments(rows);
          setLoading(false);
          const userIds = [...new Set(rows.map((c) => c.userId))];
          const missing = userIds.filter((uid) => !profilesRef.current[uid]);
          if (missing.length) {
            const docs = await Promise.all(missing.map((uid) => getDoc(doc(db!, 'profiles', uid))));
            setProfiles((prev) => {
              const updated = { ...prev };
              docs.forEach((p) => { if (p.exists()) updated[p.id] = { id: p.id, ...p.data() } as Profile; });
              return updated;
            });
          }
        },
        (err) => {
          // Stream-level failures (permission-denied, dropped Listen channel) are
          // delivered here — without this handler Firestore rethrows as uncaught.
          console.warn('Task comments listener failed:', err);
          setLoading(false);
        },
      );
    } catch (err) {
      console.warn('Task comments listener failed:', err);
      setLoading(false);
    }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [taskId]);

  // Auto-scroll to the newest comment as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments]);

  const handleAddComment = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    // Guard against double-submit (Enter + click), which would post duplicates.
    if (!newComment.trim() || !user || !db || posting) return;
    const body = newComment.trim();
    const mentionedIds = pendingMentionIds.filter((id) => id !== user.id);

    setPosting(true);
    setActionError('');
    try {
      await addDoc(collection(db, 'taskComments'), {
        taskId,
        userId: user.id,
        body,
        mentionedIds,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      // Keep the typed text in the composer so the user doesn't lose it.
      console.error('Failed to post comment:', err);
      setActionError('Failed to post your comment. Please try again.');
      setPosting(false);
      return;
    }
    setNewComment('');
    setPendingMentionIds([]);
    setPosting(false);

    // Audit log is best-effort and must not error the already-saved comment.
    // Participant/@mention notification email is sent server-side by
    // onTaskCommentCreated — clients never write to `mail`.
    await logTaskComment(taskId, user.id);
  };

  const startEdit = (comment: TaskComment) => {
    setEditingId(comment.id);
    setEditingText(comment.body);
    setEditingMentionIds(comment.mentionedIds || []);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
    setEditingMentionIds([]);
  };

  const saveEdit = async () => {
    const body = editingText.trim();
    if (!editingId || !body || !user || !db || savingEdit) return;
    const mentionedIds = editingMentionIds.filter((mid) => mid !== user.id);
    setSavingEdit(true);
    setActionError('');
    try {
      await updateDoc(doc(db, 'taskComments', editingId), {
        body,
        mentionedIds,
        editedAt: serverTimestamp(),
      });
      cancelEdit();
    } catch (err) {
      console.error('Failed to edit comment:', err);
      setActionError('Failed to save your edit. Please try again.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingComment || !db) return;
    const target = deletingComment;
    setDeletingComment(null);
    if (editingId === target.id) cancelEdit();
    // Optimistic: drop it locally, roll back on failure.
    const prev = comments;
    setComments((cur) => cur.filter((c) => c.id !== target.id));
    try {
      await deleteDoc(doc(db, 'taskComments', target.id));
    } catch (err) {
      console.error('Failed to delete comment:', err);
      setComments(prev);
      setActionError('Failed to delete the comment. Please try again.');
    }
  };

  // Anyone who can read the task can be @mentioned — matches task reads being
  // open to every signed-in user rather than gated to participants.
  const mentionableProfiles = allProfiles;

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden flex flex-col h-[500px]">
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Comments</h3>
      </div>
      {actionError && (
        <p className="px-4 pt-3 text-xs text-red-600" role="alert">{actionError}</p>
      )}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {loading && <p className="text-sm text-gray-400 text-center">Loading…</p>}
        {!loading && comments.length === 0 && (
          <p className="text-sm text-gray-400 text-center">No comments yet.</p>
        )}
        {comments.map((comment) => {
          const commentUser = profiles[comment.userId];
          const isOwn = comment.userId === user?.id;
          const isEditing = editingId === comment.id;
          return (
            <div key={comment.id} className={`group flex items-end gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
              <Avatar src={commentUser?.photoURL} name={commentUser?.name} className="w-8 h-8 rounded-full border border-gray-200 flex-shrink-0" />
              <div className={`max-w-[75%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col`}>
                <div className={`flex items-baseline gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
                  <span className="font-medium text-xs text-gray-600">{commentUser?.name || 'Unknown'}</span>
                  <span className="text-[10px] text-gray-400">
                    {(toDate(comment.createdAt) ?? new Date()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {comment.editedAt && <span className="italic"> · edited</span>}
                  </span>
                </div>
                {isEditing ? (
                  <div className="mt-1 w-full min-w-[220px]">
                    <MentionTextarea
                      value={editingText}
                      onChange={(text, ids) => { setEditingText(text); setEditingMentionIds(ids); }}
                      users={mentionableProfiles}
                      rows={2}
                      className="w-full border-gray-300 rounded-lg shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2 resize-none"
                      onSubmit={saveEdit}
                    />
                    <div className="flex justify-end gap-2 mt-1">
                      <button type="button" onClick={cancelEdit} className="inline-flex min-h-[44px] items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900">
                        <X className="w-3.5 h-3.5" />Cancel
                      </button>
                      <button type="button" onClick={saveEdit} disabled={!editingText.trim() || savingEdit} className="inline-flex min-h-[44px] items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-brand-dark rounded-md hover:bg-[#05391B] disabled:opacity-50 transition-colors">
                        <Check className="w-3.5 h-3.5" />Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={`mt-1 p-3 rounded-2xl text-sm whitespace-pre-wrap break-words ${isOwn ? 'bg-brand-dark text-white rounded-br-sm' : 'bg-gray-100 text-gray-800 rounded-bl-sm'}`}>
                      {renderCommentBody(comment.body, comment.mentionedIds || [], profiles, isOwn ? 'dark' : 'light')}
                    </div>
                    {isOwn && (
                      <div className="flex gap-3 mt-1 opacity-70 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button type="button" onClick={() => startEdit(comment)} className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-700 transition-colors">
                          <Pencil className="w-3 h-3" />Edit
                        </button>
                        <button type="button" onClick={() => setDeletingComment(comment)} className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-red-600 transition-colors">
                          <Trash2 className="w-3 h-3" />Delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canComment && (
        <div className="p-4 border-t border-gray-200 bg-gray-50">
          <form onSubmit={handleAddComment} className="flex items-end gap-3">
            <MentionTextarea
              value={newComment}
              onChange={(text, ids) => { setNewComment(text); setPendingMentionIds(ids); }}
              users={mentionableProfiles}
              placeholder="Add a comment… type @ to mention"
              rows={2}
              className="flex-1 w-full border-gray-300 rounded-lg shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-3 resize-none"
              onSubmit={() => handleAddComment()}
            />
            <button type="submit" disabled={!newComment.trim() || posting} aria-label="Send comment" className="min-h-[44px] min-w-[44px] p-3 bg-brand-dark text-white rounded-lg hover:bg-[#05391B] disabled:opacity-50 transition-colors shadow-sm flex items-center justify-center">
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      )}
      <ConfirmModal
        open={!!deletingComment}
        title="Delete Comment"
        message="Delete this comment? This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeletingComment(null)}
      />
    </div>
  );
}
