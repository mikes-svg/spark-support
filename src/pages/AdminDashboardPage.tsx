import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, getDocs, doc, getDoc, updateDoc, addDoc, serverTimestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Filter, AlertCircle, CheckCircle2, Clock, RefreshCw } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import { AssigneeSelector } from '../components/AssigneeSelector';
import { getAssigneeIds } from '../types';
import type { TicketStatus, TicketPriority } from '../types';

interface Profile { id: string; name: string; photoURL: string; role: string; email?: string; }
interface Ticket {
  id: string; type: string; title: string; status: TicketStatus; priority: TicketPriority;
  assigneeIds?: string[]; assigneeId?: string | null;
  submitterId: string; participants?: string[];
  createdAt: { toDate: () => Date } | string;
}

const STATUSES: TicketStatus[] = ['Open', 'In Progress', 'On Hold', 'Resolved'];
const PRIORITIES: TicketPriority[] = ['Low', 'Medium', 'High', 'Urgent'];

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');

  const fetchData = useCallback(async (showLoading = true) => {
    if (!db) { setLoading(false); return; }
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const ticketsSnap = await getDocs(query(collection(db, 'tickets'), orderBy('createdAt', 'desc')));
      const ticketList = ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket));
      setTickets(ticketList);
      const rtSnap = await getDocs(collection(db, 'requestTypes'));
      setRequestTypes(rtSnap.docs.map((d) => d.data().name as string).sort());
      const allAssigneeIds = ticketList.flatMap((t) => getAssigneeIds(t));
      const profileIds = [...new Set([...ticketList.map((t) => t.submitterId), ...allAssigneeIds])] as string[];
      const profileDocs = await Promise.all(profileIds.map((id) => getDoc(doc(db, 'profiles', id))));
      const profileMap: Record<string, Profile> = {};
      profileDocs.forEach((p) => { if (p.exists()) profileMap[p.id] = { id: p.id, ...p.data() } as Profile; });
      setProfiles(profileMap);
      const adminSnap = await getDocs(query(collection(db, 'profiles'), where('role', 'in', ['admin', 'superadmin'])));
      setAdminProfiles(adminSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
    } catch (err) {
      console.error('Failed to fetch admin data:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const [pendingChange, setPendingChange] = useState<
    | { type: 'status'; ticket: Ticket; value: TicketStatus }
    | { type: 'priority'; ticket: Ticket; value: TicketPriority }
    | { type: 'assignees'; ticket: Ticket; value: string[] }
    | null
  >(null);

  const pendingMessage = (() => {
    if (!pendingChange) return '';
    const { ticket, value } = pendingChange;
    if (pendingChange.type === 'assignees') {
      if (value.length === 0) return `Remove all assignees from ${ticket.id}?`;
      const names = value.map((id) => adminProfiles.find((a) => a.id === id)?.name || 'Unknown').join(', ');
      return `Set assignees for ${ticket.id} to: ${names}?`;
    }
    return `Change ${pendingChange.type} for ${ticket.id} to "${value}"?`;
  })();

  const sendMail = async (to: string, subject: string, html: string) => {
    if (!db) return;
    await addDoc(collection(db, 'mail'), { to, message: { subject, html } });
  };

  const handleFieldChangeConfirm = async () => {
    if (!pendingChange || !db) return;
    const change = pendingChange;
    setPendingChange(null);

    const updates: Record<string, unknown> = { updatedAt: serverTimestamp() };

    if (change.type === 'assignees') {
      const { ticket, value: newAssigneeIds } = change;
      const oldAssigneeIds = getAssigneeIds(ticket);
      const added = newAssigneeIds.filter((id) => !oldAssigneeIds.includes(id));
      const participants = [...new Set([ticket.submitterId, ...newAssigneeIds])];
      updates.assigneeIds = newAssigneeIds;
      updates.assigneeId = null;
      updates.participants = participants;
      setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, assigneeIds: newAssigneeIds, assigneeId: null, participants } : t));
      await updateDoc(doc(db, 'tickets', ticket.id), updates);

      // Email newly added assignees
      for (const addedId of added) {
        const assigneeDoc = await getDoc(doc(db, 'profiles', addedId));
        const email = assigneeDoc.data()?.email;
        if (email) {
          await sendMail(email, `${ticket.id} has been assigned to you`,
            `<p>Ticket <strong>${ticket.id}</strong> — ${ticket.title} — has been assigned to you.</p><p><a href="${window.location.origin}/tickets/${ticket.id}">View ticket →</a></p>`);
        }
      }
    } else {
      const { ticket, value } = change;
      updates[change.type] = value;
      setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, [change.type]: value } : t));
      await updateDoc(doc(db, 'tickets', ticket.id), updates);

      if (change.type === 'status') {
        const submitterDoc = await getDoc(doc(db, 'profiles', ticket.submitterId));
        const submitterEmail = submitterDoc.data()?.email;
        if (submitterEmail) {
          await sendMail(submitterEmail, `${ticket.id} status changed to ${value}`,
            `<p>Your ticket <strong>${ticket.id}</strong> — ${ticket.title} — has been updated to <strong>${value}</strong>.</p><p><a href="${window.location.origin}/tickets/${ticket.id}">View ticket →</a></p>`);
        }
      }
    }
  };

  const filteredTickets = tickets.filter((t) => {
    if (statusFilter !== 'All' && t.status !== statusFilter) return false;
    if (typeFilter && t.type !== typeFilter) return false;
    if (assigneeFilter && !getAssigneeIds(t).includes(assigneeFilter)) return false;
    return true;
  });

  const formatDate = (ts: Ticket['createdAt']) => {
    if (!ts) return '';
    const d = typeof ts === 'string' ? new Date(ts) : ts.toDate();
    return d.toLocaleDateString();
  };

  const openCount = tickets.filter((t) => t.status === 'Open').length;
  const inProgressCount = tickets.filter((t) => t.status === 'In Progress').length;
  const onHoldCount = tickets.filter((t) => t.status === 'On Hold').length;
  const resolvedCount = tickets.filter((t) => t.status === 'Resolved').length;

  const handleStatClick = (filter: string) => {
    setStatusFilter((prev) => prev === filter ? 'All' : filter);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Open', value: loading ? '—' : openCount, Icon: Clock, color: 'bg-blue-100 text-blue-600', filter: 'Open' },
          { label: 'In Progress', value: loading ? '—' : inProgressCount, Icon: AlertCircle, color: 'bg-amber-100 text-amber-600', filter: 'In Progress' },
          { label: 'On Hold', value: loading ? '—' : onHoldCount, Icon: Clock, color: 'bg-orange-100 text-orange-600', filter: 'On Hold' },
          { label: 'Resolved', value: loading ? '—' : resolvedCount, Icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-600', filter: 'Resolved' },
        ].map(({ label, value, Icon, color, filter }) => (
          <div
            key={label}
            onClick={() => handleStatClick(filter)}
            className={`bg-white overflow-hidden shadow-sm rounded-lg border-2 cursor-pointer transition-all hover:shadow-md ${statusFilter === filter ? 'border-brand-dark ring-1 ring-brand-dark/20' : 'border-gray-200'}`}
          >
            <div className="p-5 flex items-center">
              <div className={`flex-shrink-0 ${color} rounded-md p-3`}><Icon className="h-6 w-6" /></div>
              <div className="ml-5 w-0 flex-1">
                <dt className="text-sm font-medium text-gray-500 truncate">{label}</dt>
                <dd className="text-2xl font-semibold text-gray-900">{value}</dd>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center text-gray-500 mr-2"><Filter className="w-5 h-5 mr-2" /><span className="text-sm font-medium">Filters:</span></div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border">
          <option value="All">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border">
          <option value="">All Types</option>
          {requestTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border">
          <option value="">All Assignees</option>
          {adminProfiles.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button onClick={() => { setStatusFilter('All'); setTypeFilter(''); setAssigneeFilter(''); }} className="text-sm text-brand-gold hover:text-yellow-700 font-medium">Reset Filters</button>
        <button onClick={() => fetchData(false)} disabled={refreshing} className="ml-auto p-2 text-gray-400 hover:text-brand-dark transition-colors rounded-md hover:bg-gray-100 disabled:opacity-50" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['Ticket #', 'Submitter', 'Details', 'Status', 'Priority', 'Assignees'].map((h) => (
                  <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400">Loading…</td></tr>
              ) : filteredTickets.length > 0 ? (
                filteredTickets.map((ticket) => {
                  const submitter = profiles[ticket.submitterId];
                  const ticketAssigneeIds = getAssigneeIds(ticket);
                  return (
                    <tr key={ticket.id} onClick={() => navigate(`/tickets/${ticket.id}`)} className="hover:bg-gray-50 cursor-pointer transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-500">{ticket.id}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          {submitter && <img className="h-8 w-8 rounded-full mr-3" src={submitter.photoURL} alt="" />}
                          <div className="text-sm font-medium text-gray-900">{submitter?.name || '—'}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900 font-medium mb-1">{ticket.title}</div>
                        <div className="text-xs text-gray-500">{ticket.type} · {formatDate(ticket.createdAt)}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <select
                          className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
                          value={ticket.status}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPendingChange({ type: 'status', ticket, value: e.target.value as TicketStatus })}
                        >
                          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <select
                          className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
                          value={ticket.priority}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPendingChange({ type: 'priority', ticket, value: e.target.value as TicketPriority })}
                        >
                          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <AssigneeSelector
                          value={ticketAssigneeIds}
                          onChange={(ids) => setPendingChange({ type: 'assignees', ticket, value: ids })}
                          admins={adminProfiles}
                          variant="compact"
                        />
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-500">No tickets found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmModal
        open={!!pendingChange}
        title="Confirm Change"
        message={pendingMessage}
        confirmLabel="Update"
        onConfirm={handleFieldChangeConfirm}
        onCancel={() => setPendingChange(null)}
      />
    </div>
  );
}
