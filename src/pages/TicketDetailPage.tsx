import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { StatusBadge, PriorityBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import { Paperclip, Send, ArrowLeft, Clock } from 'lucide-react';
import { tickets as mockTickets, users as mockUsers, comments as mockComments } from '../mockData';
import type { TicketStatus, TicketPriority } from '../mockData';

interface Profile { id: string; name: string; photoURL: string; }
interface Ticket {
  id: string; type: string; title: string; description: string;
  status: TicketStatus; priority: TicketPriority;
  assigneeId: string | null; submitterId: string;
  createdAt: { toDate: () => Date } | string;
  updatedAt: { toDate: () => Date } | string;
}
interface Comment {
  id: string; ticketId: string; userId: string; body: string;
  createdAt: { toDate: () => Date } | string | null;
}

function toDate(ts: Comment['createdAt'] | Ticket['createdAt']): Date {
  if (!ts) return new Date();
  if (typeof ts === 'string') return new Date(ts);
  return (ts as { toDate: () => Date }).toDate();
}

function mockProfileMap(): Record<string, Profile> {
  const map: Record<string, Profile> = {};
  mockUsers.forEach((u) => { map[u.id] = { id: u.id, name: u.name, photoURL: u.avatar }; });
  map['dev-user'] = { id: 'dev-user', name: 'Dev Admin', photoURL: 'https://ui-avatars.com/api/?name=Dev+Admin&background=1B4332&color=D4A843' };
  return map;
}

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [ticketComments, setTicketComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;

    if (!db) {
      const found = mockTickets.find((t) => t.id === id);
      if (found) {
        setTicket({ ...found, assigneeId: found.assigneeId ?? null } as unknown as Ticket);
        setTicketComments(mockComments.filter((c) => c.ticketId === id) as unknown as Comment[]);
      }
      setProfiles(mockProfileMap());
      setLoading(false);
      return;
    }

    async function fetchTicket() {
      try {
        const ticketDoc = await getDoc(doc(db!, 'tickets', id!));
        if (!ticketDoc.exists()) { setLoading(false); return; }
        const ticketData = { id: ticketDoc.id, ...ticketDoc.data() } as Ticket;
        setTicket(ticketData);
        const profileIds = [ticketData.submitterId, ticketData.assigneeId].filter(Boolean) as string[];
        const profileDocs = await Promise.all(profileIds.map((pid) => getDoc(doc(db!, 'profiles', pid))));
        const profileMap: Record<string, Profile> = {};
        profileDocs.forEach((p) => { if (p.exists()) profileMap[p.id] = { id: p.id, ...p.data() } as Profile; });
        setProfiles(profileMap);
      } catch (err) {
        console.warn('Firestore unavailable, using mock data:', err);
        const found = mockTickets.find((t) => t.id === id);
        if (found) {
          setTicket({ ...found, assigneeId: found.assigneeId ?? null } as unknown as Ticket);
          setTicketComments(mockComments.filter((c) => c.ticketId === id) as unknown as Comment[]);
        }
        setProfiles(mockProfileMap());
      } finally {
        setLoading(false);
      }
    }
    fetchTicket();

    let unsubscribe: (() => void) | undefined;
    try {
    const commentsQuery = query(collection(db!, 'comments'), where('ticketId', '==', id));
    unsubscribe = onSnapshot(commentsQuery, async (snap) => {
      const comments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Comment));
      comments.sort((a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime());
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
    }, (err) => {
      console.warn('Firestore comments listener error:', err);
    });
    } catch (err) {
      console.warn('Firestore comments listener failed:', err);
    }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [id]);

  const sendNotificationEmail = async (recipientId: string, subject: string, html: string) => {
    if (!db || !recipientId) return;
    try {
      const recipientDoc = await getDoc(doc(db, 'profiles', recipientId));
      const recipientEmail = recipientDoc.data()?.email;
      if (recipientEmail) {
        await addDoc(collection(db, 'mail'), { to: recipientEmail, message: { subject, html } });
      }
    } catch (err) {
      console.error('Failed to send notification email:', err);
    }
  };

  const handleStatusChange = async (newStatus: TicketStatus) => {
    if (!ticket || !user || !db) return;
    const oldStatus = ticket.status;
    setTicket({ ...ticket, status: newStatus });
    await updateDoc(doc(db, 'tickets', ticket.id), { status: newStatus, updatedAt: serverTimestamp() });

    const ticketUrl = `${window.location.origin}/tickets/${ticket.id}`;
    const subject = `[Spark Support] ${ticket.id} status changed to ${newStatus}`;
    const html = `<p>Ticket <strong>${ticket.id}</strong> — ${ticket.title}</p><p>Status changed from <strong>${oldStatus}</strong> to <strong>${newStatus}</strong>.</p><p><a href="${ticketUrl}">View ticket →</a></p>`;

    // Notify assignee (if not the one making the change)
    if (ticket.assigneeId && ticket.assigneeId !== user.id) {
      await sendNotificationEmail(ticket.assigneeId, subject, html);
    }
    // Notify submitter (if not the one making the change)
    if (ticket.submitterId !== user.id) {
      await sendNotificationEmail(ticket.submitterId, subject, html);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !user || !ticket) return;
    const body = newComment.trim();
    setNewComment('');

    if (!db) {
      const mockNew: Comment = { id: `c${Date.now()}`, ticketId: ticket.id, userId: user.id, body, createdAt: new Date().toISOString() };
      setTicketComments((prev) => [...prev, mockNew]);
      return;
    }
    try {
      await addDoc(collection(db, 'comments'), { ticketId: ticket.id, userId: user.id, body, createdAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to add comment:', err);
      setNewComment(body);
      return;
    }

    const ticketUrl = `${window.location.origin}/tickets/${ticket.id}`;
    const commenterName = profiles[user.id]?.name || user.name;
    const subject = `[Spark Support] New comment on ${ticket.id}`;
    const html = `<p><strong>${commenterName}</strong> commented on ticket <strong>${ticket.id}</strong> — ${ticket.title}:</p><blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;">${body}</blockquote><p><a href="${ticketUrl}">View ticket →</a></p>`;

    // Notify assignee (if not the commenter)
    if (ticket.assigneeId && ticket.assigneeId !== user.id) {
      await sendNotificationEmail(ticket.assigneeId, subject, html);
    }
    // Notify submitter (if not the commenter)
    if (ticket.submitterId !== user.id) {
      await sendNotificationEmail(ticket.submitterId, subject, html);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" /></div>;
  if (!ticket) return <div className="text-center py-12 text-gray-500">Ticket not found.</div>;

  const assignee = ticket.assigneeId ? profiles[ticket.assigneeId] : null;
  const submitter = profiles[ticket.submitterId];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/" className="p-2 text-gray-400 hover:text-gray-600 bg-white rounded-full shadow-sm border border-gray-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="font-mono text-sm text-gray-500">{ticket.id}</span>
            {user?.role === 'admin' && db ? (
              <select
                value={ticket.status}
                onChange={(e) => handleStatusChange(e.target.value as TicketStatus)}
                className="text-sm font-medium rounded-md border border-gray-300 bg-gray-50 px-2 py-1 focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
              >
                {(['Open', 'In Progress', 'Resolved', 'Closed'] as TicketStatus[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <StatusBadge status={ticket.status} />
            )}
            <PriorityBadge priority={ticket.priority} />
          </div>
          <h1 className="text-2xl font-serif font-bold text-gray-900">{ticket.title}</h1>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-6">
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest mb-4">Description</h3>
              <div className="prose max-w-none text-gray-700 whitespace-pre-wrap">{ticket.description}</div>
            </div>
          </div>

          <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden flex flex-col h-[500px]">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Discussion</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {ticketComments.length === 0 && <p className="text-sm text-gray-400 text-center">No comments yet.</p>}
              {ticketComments.map((comment) => {
                const commentUser = profiles[comment.userId];
                return (
                  <div key={comment.id} className="flex gap-4">
                    <img src={commentUser?.photoURL || `https://ui-avatars.com/api/?name=User&background=1B4332&color=D4A843`} alt="" className="w-10 h-10 rounded-full border border-gray-200" />
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-gray-900">{commentUser?.name || 'Unknown'}</span>
                        <span className="text-xs text-gray-500">{toDate(comment.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="mt-1 text-gray-700 bg-gray-50 p-3 rounded-lg rounded-tl-none border border-gray-100">{comment.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="p-4 border-t border-gray-200 bg-gray-50">
              <form onSubmit={handleAddComment} className="flex items-end gap-3">
                <div className="flex-1 relative">
                  <textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Add a comment…" className="w-full border-gray-300 rounded-lg shadow-sm focus:ring-brand-dark focus:border-brand-dark sm:text-sm border p-3 pr-12 resize-none" rows={2} />
                  <button type="button" className="absolute right-3 bottom-3 text-gray-400 hover:text-gray-600"><Paperclip className="w-5 h-5" /></button>
                </div>
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
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Submitter</span>
                <div className="flex items-center gap-2 mt-1">
                  {submitter && <img src={submitter.photoURL} alt="" className="w-6 h-6 rounded-full" />}
                  <span className="text-sm text-gray-900">{submitter?.name || '—'}</span>
                </div>
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 uppercase mb-1">Assignee</span>
                {assignee ? (
                  <div className="flex items-center gap-2 mt-1">
                    <img src={assignee.photoURL} alt="" className="w-6 h-6 rounded-full" />
                    <span className="text-sm text-gray-900">{assignee.name}</span>
                  </div>
                ) : <span className="text-sm text-gray-500 italic">Unassigned</span>}
              </div>
              <div><span className="block text-xs font-medium text-gray-500 uppercase mb-1">Created</span><span className="text-sm text-gray-900">{toDate(ticket.createdAt).toLocaleDateString()}</span></div>
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
                  <p className="text-xs text-gray-500 flex items-center mt-1"><Clock className="w-3 h-3 mr-1" />{toDate(ticket.createdAt).toLocaleString()}</p>
                </div>
                {ticket.status !== 'Open' && (
                  <div className="relative pl-6">
                    <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-amber-500 border-4 border-white" />
                    <p className="text-sm font-medium text-gray-900">Status changed to In Progress</p>
                    <p className="text-xs text-gray-500 flex items-center mt-1"><Clock className="w-3 h-3 mr-1" />{toDate(ticket.updatedAt).toLocaleString()}</p>
                  </div>
                )}
                {(ticket.status === 'Resolved' || ticket.status === 'Closed') && (
                  <div className="relative pl-6">
                    <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-emerald-500 border-4 border-white" />
                    <p className="text-sm font-medium text-gray-900">Status changed to {ticket.status}</p>
                    <p className="text-xs text-gray-500 flex items-center mt-1"><Clock className="w-3 h-3 mr-1" />{toDate(ticket.updatedAt).toLocaleString()}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
