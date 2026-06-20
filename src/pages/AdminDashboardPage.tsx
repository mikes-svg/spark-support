import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  collection,
  query,
  orderBy,
  where,
  limit,
  startAfter,
  getDocs,
  getCountFromServer,
  doc,
  getDoc,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { Filter, AlertCircle, CheckCircle2, Clock, RefreshCw } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import { AssigneeSelector } from '../components/AssigneeSelector';
import { StatusBadge } from '../components/Badges';
import { getAssigneeIds, isSuperadminRole } from '../types';
import type { TicketStatus, TicketPriority, Ticket, Profile } from '../types';
import { formatDate, formatDateTime } from '../lib/dates';
import {
  updateTicketStatus,
  updateTicketPriority,
  updateTicketAssignees,
} from '../lib/ticketEvents';

const STATUSES: TicketStatus[] = ['Open', 'In Progress', 'On Hold', 'Resolved'];
const PRIORITIES: TicketPriority[] = ['Low', 'Medium', 'High', 'Urgent'];
const COUNT_STATUSES: TicketStatus[] = ['Open', 'In Progress', 'On Hold', 'Resolved', 'Scheduled'];
const PAGE_SIZE = 50;

type Counts = Record<string, number>;

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<string[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  // Default view hides Resolved tickets so admins focus on actionable work.
  // 'Active' = anything not Resolved; 'All' = include Resolved; else exact status match.
  const [statusFilter, setStatusFilter] = useState('Active');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  // Scheduled (not-yet-live) tickets are hidden by default; this toggle reveals them.
  const [showScheduled, setShowScheduled] = useState(false);

  // Pagination cursor and a live mirror of loaded profiles (read inside async
  // loaders without stale-closure re-fetches).
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const profilesRef = useRef<Record<string, Profile>>({});
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);

  // Which statuses the list query should fetch, given the status filter + the
  // show-scheduled toggle. Status is filtered SERVER-side (one composite index);
  // type/assignee are narrowed client-side on the loaded pages.
  const statusesForFilter = useCallback((): TicketStatus[] => {
    if (statusFilter === 'All') {
      return showScheduled
        ? ['Open', 'In Progress', 'On Hold', 'Resolved', 'Scheduled']
        : ['Open', 'In Progress', 'On Hold', 'Resolved'];
    }
    if (statusFilter === 'Active') {
      return showScheduled
        ? ['Open', 'In Progress', 'On Hold', 'Scheduled']
        : ['Open', 'In Progress', 'On Hold'];
    }
    return [statusFilter as TicketStatus];
  }, [statusFilter, showScheduled]);

  const loadProfilesFor = useCallback(async (pageTickets: Ticket[], database: NonNullable<typeof db>) => {
    const ids = [...new Set(pageTickets.flatMap((t) => [t.submitterId, ...getAssigneeIds(t)]))]
      .filter((id) => id && !profilesRef.current[id]) as string[];
    if (ids.length === 0) return;
    const docs = await Promise.all(ids.map((id) => getDoc(doc(database, 'profiles', id))));
    setProfiles((prev) => {
      const next = { ...prev };
      docs.forEach((p) => { if (p.exists()) next[p.id] = { id: p.id, ...p.data() } as Profile; });
      return next;
    });
  }, []);

  // Aggregate counts straight from the server (no full-collection read), so the
  // stat cards stay accurate at any data size.
  const fetchCounts = useCallback(async () => {
    const database = db;
    if (!database) return;
    try {
      const results = await Promise.all(
        COUNT_STATUSES.map((s) => getCountFromServer(query(collection(database, 'tickets'), where('status', '==', s)))),
      );
      const c: Counts = {};
      COUNT_STATUSES.forEach((s, i) => { c[s] = results[i].data().count; });
      setCounts(c);
    } catch (err) {
      console.error('Failed to load ticket counts:', err);
    }
  }, []);

  const loadPage = useCallback(async (reset: boolean) => {
    const database = db;
    if (!database) { setLoading(false); return; }
    if (reset) { setLoading(true); cursorRef.current = null; }
    else setLoadingMore(true);
    try {
      const statuses = statusesForFilter();
      const col = collection(database, 'tickets');
      const q = !reset && cursorRef.current
        ? query(col, where('status', 'in', statuses), orderBy('createdAt', 'desc'), startAfter(cursorRef.current), limit(PAGE_SIZE))
        : query(col, where('status', 'in', statuses), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
      const snap = await getDocs(q);
      const pageTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket));
      cursorRef.current = snap.docs[snap.docs.length - 1] ?? cursorRef.current;
      setHasMore(snap.size === PAGE_SIZE);
      setTickets((prev) => (reset ? pageTickets : [...prev, ...pageTickets]));
      await loadProfilesFor(pageTickets, database);
      setError(false);
    } catch (err) {
      console.error('Failed to load admin tickets:', err);
      setError(true);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [statusesForFilter, loadProfilesFor]);

  // Static data (admin directory + request types) loads once.
  useEffect(() => {
    const database = db;
    if (!database) return;
    (async () => {
      try {
        const rtSnap = await getDocs(collection(database, 'requestTypes'));
        setRequestTypes(rtSnap.docs.map((d) => d.data().name as string).sort());
        const adminSnap = await getDocs(query(collection(database, 'profiles'), where('role', 'in', ['admin', 'superadmin'])));
        setAdminProfiles(adminSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
      } catch (err) {
        console.error('Failed to load admin directory/types:', err);
      }
    })();
    fetchCounts();
  }, [fetchCounts]);

  // (Re)load the first page whenever the server-side filter changes.
  useEffect(() => { loadPage(true); }, [loadPage]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchCounts(), loadPage(true)]);
    setRefreshing(false);
  }, [fetchCounts, loadPage]);

  const [pendingChange, setPendingChange] = useState<
    | { type: 'status'; ticket: Ticket; value: TicketStatus }
    | { type: 'priority'; ticket: Ticket; value: TicketPriority }
    | { type: 'assignees'; ticket: Ticket; value: string[] }
    | null
  >(null);

  const pendingMessage = (() => {
    if (!pendingChange) return '';
    // Narrow on the discriminant FIRST so `value` is the specific member type
    // (string[] vs TicketStatus/TicketPriority) inside each branch.
    if (pendingChange.type === 'assignees') {
      const { ticket, value } = pendingChange;
      if (value.length === 0) return `Remove all assignees from ${ticket.id}?`;
      const names = value.map((id) => adminProfiles.find((a) => a.id === id)?.name || 'Unknown').join(', ');
      return `Set assignees for ${ticket.id} to: ${names}?`;
    }
    const { ticket, value } = pendingChange;
    return `Change ${pendingChange.type} for ${ticket.id} to "${value}"?`;
  })();

  const handleFieldChangeConfirm = async () => {
    if (!pendingChange || !db || !user) return;
    const change = pendingChange;
    setPendingChange(null);

    if (change.type === 'assignees') {
      const { ticket, value: newAssigneeIds } = change;
      const oldAssigneeIds = getAssigneeIds(ticket);
      const participants = [...new Set([ticket.submitterId, ...newAssigneeIds])];
      setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, assigneeIds: newAssigneeIds, assigneeId: null, participants } : t));
      try {
        await updateTicketAssignees(ticket.id, oldAssigneeIds, newAssigneeIds, participants, user.id);
      } catch (err) {
        console.error('Failed to update assignees:', err);
        setTickets((prev) => prev.map((t) => t.id === ticket.id ? ticket : t));
        alert('Failed to update assignees. Please try again.');
        return;
      }
      // Assignee notification emails are sent server-side by onTicketUpdated.
    } else if (change.type === 'status') {
      const { ticket, value } = change;
      setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, status: value } : t));
      try {
        await updateTicketStatus(ticket.id, ticket.status, value, user.id);
      } catch (err) {
        console.error('Failed to update status:', err);
        setTickets((prev) => prev.map((t) => t.id === ticket.id ? ticket : t));
        alert('Failed to update status. Please try again.');
        return;
      }
      // The submitter notification is sent server-side by onTicketUpdated.
      // Status changed → refresh the server-side count cards.
      fetchCounts();
    } else {
      const { ticket, value } = change;
      setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, priority: value } : t));
      try {
        await updateTicketPriority(ticket.id, ticket.priority, value, user.id);
      } catch (err) {
        console.error('Failed to update priority:', err);
        setTickets((prev) => prev.map((t) => t.id === ticket.id ? ticket : t));
        alert('Failed to update priority. Please try again.');
      }
    }
  };

  // Status + scheduled are filtered server-side; narrow the loaded pages by
  // type/assignee here, and re-apply the status set so optimistic status changes
  // that move a ticket out of view disappear immediately.
  const activeStatuses = statusesForFilter();
  const visibleTickets = tickets.filter((t) => {
    if (!activeStatuses.includes(t.status)) return false;
    if (typeFilter && t.type !== typeFilter) return false;
    if (assigneeFilter && !getAssigneeIds(t).includes(assigneeFilter)) return false;
    return true;
  });

  // Scheduling is a superadmin-only feature; only they can reveal scheduled tickets.
  const isSuperadmin = isSuperadminRole(user?.role);
  const scheduledCount = counts?.Scheduled ?? 0;
  const clientFiltered = typeFilter !== '' || assigneeFilter !== '';

  const handleStatClick = (filter: string) => {
    // Re-clicking the active stat card returns to the default 'Active' view
    // (which still hides Resolved). Clicking the Resolved card temporarily
    // surfaces resolved tickets without permanently changing the default.
    setStatusFilter((prev) => prev === filter ? 'Active' : filter);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Open', value: counts ? counts.Open : '—', Icon: Clock, color: 'bg-blue-100 text-blue-600', filter: 'Open' },
          { label: 'In Progress', value: counts ? counts['In Progress'] : '—', Icon: AlertCircle, color: 'bg-amber-100 text-amber-600', filter: 'In Progress' },
          { label: 'On Hold', value: counts ? counts['On Hold'] : '—', Icon: Clock, color: 'bg-orange-100 text-orange-600', filter: 'On Hold' },
          { label: 'Resolved', value: counts ? counts.Resolved : '—', Icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-600', filter: 'Resolved' },
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
          <option value="Active">Active (hide Resolved)</option>
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
        {isSuperadmin && (
          <button
            onClick={() => setShowScheduled((s) => !s)}
            className={`text-sm font-medium px-3 py-1.5 rounded-md border transition-colors ${showScheduled ? 'bg-purple-100 text-purple-800 border-purple-300' : 'text-gray-600 border-gray-300 hover:bg-gray-50'}`}
          >
            {showScheduled ? 'Hide scheduled' : `Show scheduled${scheduledCount ? ` (${scheduledCount})` : ''}`}
          </button>
        )}
        <button onClick={() => { setStatusFilter('Active'); setTypeFilter(''); setAssigneeFilter(''); setShowScheduled(false); }} className="text-sm text-brand-gold hover:text-yellow-700 font-medium">Reset Filters</button>
        <button onClick={refreshAll} disabled={refreshing} className="ml-auto p-2 text-gray-400 hover:text-brand-dark transition-colors rounded-md hover:bg-gray-100 disabled:opacity-50" title="Refresh">
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
              ) : error ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-red-600">Couldn't load tickets. Check your connection and refresh.</td></tr>
              ) : visibleTickets.length > 0 ? (
                visibleTickets.map((ticket) => {
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
                        {ticket.status === 'Scheduled' ? (
                          <div className="flex flex-col gap-1">
                            <StatusBadge status="Scheduled" />
                            <span className="text-[11px] text-purple-700">Goes live {formatDateTime(ticket.scheduledFor)}</span>
                          </div>
                        ) : (
                          <select
                            className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50"
                            value={ticket.status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setPendingChange({ type: 'status', ticket, value: e.target.value as TicketStatus })}
                          >
                            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        )}
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
        {!loading && !error && (visibleTickets.length > 0 || hasMore) && (
          <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
            <span>
              Showing {visibleTickets.length} ticket{visibleTickets.length === 1 ? '' : 's'}
              {clientFiltered && ' (type/assignee filters apply to loaded tickets — load more to search further back)'}
            </span>
            {hasMore && (
              <button
                onClick={() => loadPage(false)}
                disabled={loadingMore}
                className="px-4 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
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
