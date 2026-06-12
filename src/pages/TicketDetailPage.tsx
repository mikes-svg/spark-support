import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { doc, getDoc, deleteDoc, updateDoc, collection, query, where, orderBy, onSnapshot, addDoc, serverTimestamp, getDocs, writeBatch, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, listAll, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../lib/firebase';
import { StatusBadge, PriorityBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import { Send, ArrowLeft, Clock, Trash2, UploadCloud, FileText, CalendarClock } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import { AssigneeChips } from '../components/AssigneeChips';
import { MentionTextarea, renderCommentBody } from '../components/MentionTextarea';
import { PageSpinner } from '../components/PageSpinner';
import { getAssigneeIds, isScheduled, isAdminRole, isSuperadminRole } from '../types';
import type { TicketStatus, TicketPriority, Ticket, Profile } from '../types';
import { toDate, localDateTimeMin } from '../lib/dates';
import { sendMail, ticketUrl } from '../lib/mail';
import {
  updateTicketStatus,
  updateTicketPriority,
  updateTicketAssignees,
  logTicketComment,
} from '../lib/ticketEvents';

interface Comment {
  id: string; ticketId: string; userId: string; body: string;
  mentionedIds?: string[];
  createdAt: { toDate: () => Date } | string | null;
}
interface Attachment { name: string; url: string; }

const STATUSES: TicketStatus[] = ['Open', 'In Progress', 'On Hold', 'Resolved'];
const PRIORITIES: TicketPriority[] = ['Low', 'Medium', 'High', 'Urgent'];

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [ticketComments, setTicketComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduleValue, setRescheduleValue] = useState('');
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [pendingMentionIds, setPendingMentionIds] = useState<string[]>([]);

  useEffect(() => {
    if (!id || !db) { setLoading(false); return; }

    async function fetchTicket() {
      try {
        const ticketDoc = await getDoc(doc(db!, 'tickets', id!));
        if (!ticketDoc.exists()) { setLoading(false); return; }
        const ticketData = { id: ticketDoc.id, ...ticketDoc.data() } as Ticket;
        setTicket(ticketData);
        const assigneeIds = getAssigneeIds(ticketData);
        const profileIds = [ticketData.submitterId, ...assigneeIds].filter(Boolean) as string[];
        const profileDocs = await Promise.all(profileIds.map((pid) => getDoc(doc(db!, 'profiles', pid))));
        const profileMap: Record<string, Profile> = {};
        profileDocs.forEach((p) => { if (p.exists()) profileMap[p.id] = { id: p.id, ...p.data() } as Profile; });
        setProfiles(profileMap);
      } catch (err) {
        console.error('Failed to fetch ticket:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchTicket();

    // Load admin profiles for assignee dropdown
    getDocs(query(collection(db!, 'profiles'), where('role', 'in', ['admin', 'superadmin'])))
      .then((snap) => setAdminProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile))))
      .catch(() => {});

    // Load all profiles for the @mention picker (mentionable beyond just admins)
    getDocs(collection(db!, 'profiles'))
      .then((snap) => setAllProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile))))
      .catch(() => {});

    // Load attachments
    if (storage) {
      const attachRef = ref(storage, `attachments/${id}`);
      listAll(attachRef).then(async (res) => {
        const files = await Promise.all(res.items.map(async (item) => ({
          name: item.name,
          url: await getDownloadURL(item),
        })));
        setAttachments(files);
      }).catch(() => { /* no attachments folder yet */ });
    }

    let unsubscribe: (() => void) | undefined;
    try {
      const commentsQuery = query(collection(db!, 'comments'), where('ticketId', '==', id), orderBy('createdAt', 'asc'));
      unsubscribe = onSnapshot(commentsQuery, async (snap) => {
        const comments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Comment));
        setTicketComments(comments);
        const commentUserIds = [...new Set(comments.map((c) => c.userId))];
        const missing = commentUserIds.filter((uid) => !profiles[uid]);
        if (missing.length) {
          const newProfileDocs = await Promise.all(missing.map((uid) => getDoc(doc(db!, 'profiles', uid))));
          setProfiles((prev) => {
            const updated = { ...prev };
            newProfileDocs.forEach((p) => { if (p.exists()) updated[p.id] = { id: p.id, ...p.data() } as Profile; });
            return updated;
          });
        }
      });
    } catch (err) {
      console.warn('Firestore comments listener failed:', err);
    }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [id]);

  const handleAddComment = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newComment.trim() || !user || !ticket || !db) return;
    const body = newComment.trim();
    const mentionedIds = pendingMentionIds.filter((id) => id !== user.id);
    setNewComment('');
    setPendingMentionIds([]);
    await addDoc(collection(db, 'comments'), {
      ticketId: ticket.id,
      userId: user.id,
      body,
      mentionedIds,
      createdAt: serverTimestamp(),
    });

    // Audit log: first-response time only counts when a non-submitter comments first.
    const priorNonSubmitterReply = ticketComments.some(
      (c) => c.userId !== ticket.submitterId,
    );
    const isFirstResponse =
      user.id !== ticket.submitterId && !priorNonSubmitterReply;
    await logTicketComment(ticket.id, user.id, isFirstResponse);

    // Email other parties: participants + anyone mentioned (deduped, excluding commenter)
    const currentAssigneeIds = getAssigneeIds(ticket);
    const recipientIds = [
      ...new Set([ticket.submitterId, ...currentAssigneeIds, ...mentionedIds]),
    ].filter((pid) => pid && pid !== user.id);
    for (const recipientId of recipientIds) {
      const recipientDoc = await getDoc(doc(db, 'profiles', recipientId));
      const recipientEmail = recipientDoc.data()?.email;
      if (!recipientEmail) continue;
      const wasMentioned = mentionedIds.includes(recipientId);
      const subject = wasMentioned
        ? `${user.name} mentioned you on ${ticket.id}: ${ticket.title}`
        : `New comment on ${ticket.id}: ${ticket.title}`;
      const lead = wasMentioned
        ? `<p><strong>${user.name}</strong> mentioned you in a comment on <strong>${ticket.id}</strong>:</p>`
        : `<p><strong>${user.name}</strong> commented on <strong>${ticket.id}</strong>:</p>`;
      await sendMail(
        recipientEmail,
        subject,
        `${lead}<p>${body}</p><p><a href="${ticketUrl(ticket.id)}">View ticket →</a></p><hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/><p style="color:#9ca3af;font-size:12px">Please do not reply to this email. To respond, <a href="${ticketUrl(ticket.id)}">click here to view the ticket</a> and add your comment there.</p>`
      );
    }
  };

  const handleUploadFiles = async (files: FileList) => {
    if (!ticket || !storage || files.length === 0) return;
    setUploading(true);
    try {
      const newAttachments: Attachment[] = [];
      for (const file of Array.from(files)) {
        const fileRef = ref(storage, `attachments/${ticket.id}/${file.name}`);
        await uploadBytes(fileRef, file);
        const url = await getDownloadURL(fileRef);
        newAttachments.push({ name: file.name, url });
      }
      setAttachments((prev) => [...prev, ...newAttachments]);
    } catch (err) {
      console.error('Failed to upload files:', err);
    } finally {
      setUploading(false);
    }
  };

  const handleStatusChange = async (newStatus: TicketStatus) => {
    if (!ticket || !db || !user) return;
    const prev = ticket;
    const fromStatus = ticket.status;
    setTicket({ ...ticket, status: newStatus });
    try {
      await updateTicketStatus(ticket.id, fromStatus, newStatus, user.id);
    } catch (err) {
      console.error('Failed to update status:', err);
      setTicket(prev);
      alert('Failed to update status. Please try again.');
      return;
    }

    const submitterDoc = await getDoc(doc(db, 'profiles', ticket.submitterId));
    const submitterEmail = submitterDoc.data()?.email;
    if (submitterEmail) {
      await sendMail(submitterEmail, `${ticket.id} status changed to ${newStatus}`,
        `<p>Your ticket <strong>${ticket.id}</strong> — ${ticket.title} — has been updated to <strong>${newStatus}</strong>.</p><p><a href="${ticketUrl(ticket.id)}">View ticket →</a></p>`);
    }
  };

  const handlePriorityChange = async (newPriority: TicketPriority) => {
    if (!ticket || !db || !user) return;
    const prev = ticket;
    const fromPriority = ticket.priority;
    setTicket({ ...ticket, priority: newPriority });
    try {
      await updateTicketPriority(ticket.id, fromPriority, newPriority, user.id);
    } catch (err) {
      console.error('Failed to update priority:', err);
      setTicket(prev);
      alert('Failed to update priority. Please try again.');
    }
  };

  const handleAssigneesChange = async (newAssigneeIds: string[]) => {
    if (!ticket || !db || !user) return;
    const oldAssigneeIds = getAssigneeIds(ticket);
    const added = newAssigneeIds.filter((id) => !oldAssigneeIds.includes(id));
    // While scheduled, keep assignees out of participants (and don't email them);
    // the activation function adds + notifies them on the go-live date.
    const scheduled = isScheduled(ticket);
    const participants = scheduled
      ? [ticket.submitterId]
      : [...new Set([ticket.submitterId, ...newAssigneeIds])];

    const prev = ticket;
    setTicket({ ...ticket, assigneeIds: newAssigneeIds, assigneeId: null, participants } as Ticket);
    try {
      await updateTicketAssignees(ticket.id, oldAssigneeIds, newAssigneeIds, participants, user.id);
    } catch (err) {
      console.error('Failed to update assignees:', err);
      setTicket(prev);
      alert('Failed to update assignees. Please try again.');
      return;
    }

    if (scheduled) return; // no notifications until go-live

    // Email every newly added assignee
    for (const addedId of added) {
      const assigneeDoc = await getDoc(doc(db, 'profiles', addedId));
      const assigneeData = assigneeDoc.data();
      if (assigneeData?.email) {
        await sendMail(assigneeData.email, `${ticket.id} has been assigned to you`,
          `<p>Ticket <strong>${ticket.id}</strong> — ${ticket.title} — has been assigned to you.</p><p><a href="${ticketUrl(ticket.id)}">View ticket →</a></p>`);
      } else {
        console.warn(`Skipping assignee notification for ${ticket.id}: profile ${addedId} has no email field. Have them sign in once to self-heal, or fix via /admin/team.`);
      }
      if (!profiles[addedId] && assigneeData) {
        setProfiles((prev) => ({ ...prev, [addedId]: { id: addedId, name: assigneeData.name, photoURL: assigneeData.photoURL, email: assigneeData.email } }));
      }
    }
  };

  const handleDeleteTicket = async () => {
    if (!ticket || !db) return;
    setShowDeleteConfirm(false);
    try {
      const commentsSnap = await getDocs(query(collection(db, 'comments'), where('ticketId', '==', ticket.id)));
      if (commentsSnap.size > 0) {
        const batch = writeBatch(db);
        commentsSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await deleteDoc(doc(db, 'tickets', ticket.id));
      navigate('/admin');
    } catch (err) {
      console.error('Failed to delete ticket:', err);
      alert('Failed to delete ticket. Make sure Firestore rules allow admin deletes.');
    }
  };

  // Cancel a scheduled go-live: the ticket never went live, so we discard it.
  const handleCancelSchedule = async () => {
    if (!ticket || !db) return;
    setShowCancelConfirm(false);
    try {
      await deleteDoc(doc(db, 'tickets', ticket.id));
      navigate('/admin');
    } catch (err) {
      console.error('Failed to cancel scheduled ticket:', err);
      alert('Failed to cancel. Make sure Firestore rules allow deleting scheduled tickets.');
    }
  };

  const handleReschedule = async () => {
    if (!ticket || !db || !rescheduleValue) return;
    const newDate = new Date(rescheduleValue);
    if (newDate.getTime() <= Date.now()) {
      alert('Pick a date in the future.');
      return;
    }
    await updateDoc(doc(db, 'tickets', ticket.id), {
      scheduledFor: Timestamp.fromDate(newDate),
      updatedAt: serverTimestamp(),
    });
    setTicket({ ...ticket, scheduledFor: Timestamp.fromDate(newDate) } as Ticket);
    setRescheduling(false);
  };

  if (loading) return <PageSpinner />;
  if (!ticket) return <div className="text-center py-12 text-gray-500">Ticket not found.</div>;

  const assigneeIds = getAssigneeIds(ticket);
  const assignees = assigneeIds.map((id) => profiles[id]).filter(Boolean);
  const submitter = profiles[ticket.submitterId];
  const isAdmin = isAdminRole(user?.role);
  const isSuperadmin = isSuperadminRole(user?.role);
  const scheduled = isScheduled(ticket);
  const nowLocalMin = localDateTimeMin();

  // Only allow @mentioning people who can actually read this ticket — admins
  // (who can read any ticket) and current participants. Mentioning anyone else
  // would email them a "View ticket" link that the rules deny.
  const mentionableIds = new Set<string>([
    ...adminProfiles.map((a) => a.id),
    ...(ticket.participants ?? []),
  ]);
  const mentionableProfiles = allProfiles.filter((p) => mentionableIds.has(p.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/" className="p-2 text-gray-400 hover:text-gray-600 bg-white rounded-full shadow-sm border border-gray-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <span className="font-mono text-sm text-gray-500">{ticket.id}</span>
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
          </div>
          <h1 className="text-2xl font-serif font-bold text-gray-900">{ticket.title}</h1>
        </div>
        {isSuperadmin && (
          <button onClick={() => setShowDeleteConfirm(true)} className="p-2 text-red-400 hover:text-red-600 bg-white rounded-full shadow-sm border border-gray-200 transition-colors" title="Delete ticket">
            <Trash2 className="w-5 h-5" />
          </button>
        )}
      </div>

      {scheduled && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-[240px]">
              <CalendarClock className="h-5 w-5 text-purple-600 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-purple-900">Scheduled — not yet live</p>
                <p className="text-xs text-purple-700">
                  Goes live on <strong>{(toDate(ticket.scheduledFor) ?? new Date()).toLocaleString()}</strong>, notifying assignees then. Hidden from assignees until then.
                </p>
              </div>
            </div>
            {isSuperadmin && !rescheduling && (
              <div className="flex items-center gap-2">
                <button onClick={() => { setRescheduleValue(''); setRescheduling(true); }} className="px-3 py-1.5 text-sm font-medium text-purple-700 bg-white border border-purple-300 rounded-md hover:bg-purple-50 transition-colors">Reschedule</button>
                <button onClick={() => setShowCancelConfirm(true)} className="px-3 py-1.5 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-md hover:bg-red-50 transition-colors">Cancel</button>
              </div>
            )}
          </div>
          {isSuperadmin && rescheduling && (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-purple-200 pt-4">
              <div>
                <label htmlFor="reschedule" className="block text-xs font-medium text-purple-800 mb-1">New go-live date</label>
                <input
                  type="datetime-local"
                  id="reschedule"
                  min={nowLocalMin}
                  value={rescheduleValue}
                  onChange={(e) => setRescheduleValue(e.target.value)}
                  className="block border-gray-300 rounded-md shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-2"
                />
              </div>
              <button onClick={handleReschedule} disabled={!rescheduleValue} className="px-4 py-2 text-sm font-medium text-white bg-brand-dark rounded-md hover:bg-[#153427] disabled:opacity-50 transition-colors">Save</button>
              <button onClick={() => setRescheduling(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Dismiss</button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-6">
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest mb-4">Description</h3>
              <div className="prose max-w-none text-gray-700 whitespace-pre-wrap">{ticket.description}</div>
            </div>
          </div>

          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Attachments</h3>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 cursor-pointer transition-colors">
                {uploading ? (
                  <div className="h-3.5 w-3.5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                Add Files
                <input type="file" multiple className="sr-only" onChange={(e) => { if (e.target.files) { handleUploadFiles(e.target.files); e.target.value = ''; } }} />
              </label>
            </div>
            <div className="p-4">
              {attachments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-2">No attachments.</p>
              ) : (
                <ul className="space-y-2">
                  {attachments.map((att, idx) => (
                    <li key={idx}>
                      <a href={att.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-brand-dark hover:text-brand-gold transition-colors">
                        <FileText className="h-4 w-4 flex-shrink-0" />
                        {att.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden flex flex-col h-[500px]">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Discussion</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {ticketComments.length === 0 && <p className="text-sm text-gray-400 text-center">No comments yet.</p>}
              {ticketComments.map((comment) => {
                const commentUser = profiles[comment.userId];
                const isOwn = comment.userId === user?.id;
                return (
                  <div key={comment.id} className={`flex items-end gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
                    <img src={commentUser?.photoURL || `https://ui-avatars.com/api/?name=User&background=1B4332&color=D4A843`} alt="" className="w-8 h-8 rounded-full border border-gray-200 flex-shrink-0" />
                    <div className={`max-w-[75%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col`}>
                      <div className={`flex items-baseline gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
                        <span className="font-medium text-xs text-gray-600">{commentUser?.name || 'Unknown'}</span>
                        <span className="text-[10px] text-gray-400">{(toDate(comment.createdAt) ?? new Date()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className={`mt-1 p-3 rounded-2xl text-sm whitespace-pre-wrap break-words ${isOwn ? 'bg-brand-dark text-white rounded-br-sm' : 'bg-gray-100 text-gray-800 rounded-bl-sm'}`}>{renderCommentBody(comment.body, comment.mentionedIds || [], profiles, isOwn ? 'dark' : 'light')}</div>
                    </div>
                  </div>
                );
              })}
            </div>
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
                <button type="submit" disabled={!newComment.trim()} className="p-3 bg-brand-dark text-white rounded-lg hover:bg-[#153427] disabled:opacity-50 transition-colors shadow-sm">
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="w-full lg:w-80 space-y-6">
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Details</h3>
            </div>
            <div className="p-6 space-y-5">
              <div><span className="block text-xs font-medium text-gray-500 uppercase mb-1">Type</span><span className="text-sm text-gray-900 font-medium">{ticket.type}</span></div>
              <div>
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Status</span>
                {isAdmin && !scheduled ? (
                  <select value={ticket.status} onChange={(e) => handleStatusChange(e.target.value as TicketStatus)} className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50">
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <StatusBadge status={ticket.status} />
                )}
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Priority</span>
                {isAdmin ? (
                  <select value={ticket.priority} onChange={(e) => handlePriorityChange(e.target.value as TicketPriority)} className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50">
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <PriorityBadge priority={ticket.priority} />
                )}
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Submitter</span>
                <div className="flex items-center gap-2 mt-1">
                  {submitter && <img src={submitter.photoURL} alt="" className="w-6 h-6 rounded-full" />}
                  <span className="text-sm text-gray-900">{submitter?.name || '—'}</span>
                </div>
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Assignees</span>
                {isAdmin ? (
                  <AssigneeChips value={assigneeIds} onChange={handleAssigneesChange} admins={adminProfiles} />
                ) : assignees.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {assignees.map((a) => (
                      <div key={a.id} className="flex items-center gap-1.5 bg-gray-100 rounded-full pl-1 pr-2 py-0.5">
                        <img src={a.photoURL} alt="" className="w-5 h-5 rounded-full" />
                        <span className="text-xs text-gray-900">{a.name}</span>
                      </div>
                    ))}
                  </div>
                ) : <span className="text-sm text-gray-500 italic">Unassigned</span>}
              </div>
              <div><span className="block text-xs font-medium text-gray-500 uppercase mb-1">Created</span><span className="text-sm text-gray-900">{(toDate(ticket.createdAt) ?? new Date()).toLocaleDateString()}</span></div>
            </div>
          </div>

          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">History</h3>
            </div>
            <div className="p-6">
              <div className="relative border-l-2 border-gray-200 ml-3 space-y-6">
                <div className="relative pl-6">
                  <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-blue-500 border-4 border-white" />
                  <p className="text-sm font-medium text-gray-900">Ticket Created</p>
                  <p className="text-xs text-gray-500 flex items-center mt-1"><Clock className="w-3 h-3 mr-1" />{(toDate(ticket.createdAt) ?? new Date()).toLocaleString()}</p>
                </div>
                {ticket.status !== 'Open' && (
                  <div className="relative pl-6">
                    <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-amber-500 border-4 border-white" />
                    <p className="text-sm font-medium text-gray-900">Status: {ticket.status}</p>
                    <p className="text-xs text-gray-500 flex items-center mt-1"><Clock className="w-3 h-3 mr-1" />{(toDate(ticket.updatedAt) ?? new Date()).toLocaleString()}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete Ticket"
        message={`Permanently delete ${ticket.id}? This will remove all comments and attachments. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteTicket}
        onCancel={() => setShowDeleteConfirm(false)}
      />
      <ConfirmModal
        open={showCancelConfirm}
        title="Cancel Scheduled Ticket"
        message={`Cancel ${ticket.id}? It will never go live and will be removed. This cannot be undone.`}
        confirmLabel="Cancel Ticket"
        danger
        onConfirm={handleCancelSchedule}
        onCancel={() => setShowCancelConfirm(false)}
      />
    </div>
  );
}
