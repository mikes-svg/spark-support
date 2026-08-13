import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, query, where, orderBy, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/Badges';
import { Avatar } from '../components/Avatar';
import { Plus } from 'lucide-react';
import { getAssigneeIds } from '../types';
import type { Ticket, Profile, TicketStatus } from '../types';
import { formatDate } from '../lib/dates';

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Clicking a stat tile filters the Recent Requests table to that status;
  // null = show everything. Re-clicking the active tile clears the filter.
  const [statusFilter, setStatusFilter] = useState<TicketStatus | null>(null);

  useEffect(() => {
    if (!user || !db) { setLoading(false); return; }

    async function fetchTickets() {
      try {
        setError(false);
        const q = query(collection(db!, 'tickets'), where('participants', 'array-contains', user!.id), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        const ticketList = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket));
        setTickets(ticketList);
        const allAssignees = ticketList.flatMap((t) => getAssigneeIds(t));
        const profileIds = [...new Set([...ticketList.map((t) => t.submitterId), ...allAssignees])] as string[];
        const profileDocs = await Promise.all(profileIds.map((id) => getDoc(doc(db!, 'profiles', id))));
        const profileMap: Record<string, Profile> = {};
        profileDocs.forEach((p) => { if (p.exists()) profileMap[p.id] = { id: p.id, ...p.data() } as Profile; });
        setProfiles(profileMap);
      } catch (err) {
        console.error('Failed to fetch tickets:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    fetchTickets();
  }, [user]);

  const openCount = tickets.filter((t) => t.status === 'Open').length;
  const inProgressCount = tickets.filter((t) => t.status === 'In Progress').length;
  const onHoldCount = tickets.filter((t) => t.status === 'On Hold').length;
  const resolvedCount = tickets.filter((t) => t.status === 'Resolved').length;

  // Re-clicking the active tile clears the filter; otherwise select it.
  const handleStatClick = (filter: TicketStatus) =>
    setStatusFilter((prev) => (prev === filter ? null : filter));

  const visibleTickets = statusFilter ? tickets.filter((t) => t.status === statusFilter) : tickets;

  return (
    <div className="space-y-6">
      {/* Below ~sm the label and the CTA stack: side by side there isn't room for
          both at 320px and the button's label wraps mid-word. */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-between sm:items-center">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-widest">Overview</h2>
        <Link to="/submit" className="inline-flex items-center justify-center whitespace-nowrap px-4 py-2 border border-transparent text-sm font-medium rounded-md text-brand-dark bg-brand-gold hover:bg-brand-gold/80 shadow-sm transition-colors">
          <Plus className="h-4 w-4 mr-2" />Submit New Request
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {[
          { label: 'Open Tickets', count: openCount, color: 'bg-blue-500', filter: 'Open' as TicketStatus },
          { label: 'In Progress', count: inProgressCount, color: 'bg-amber-500', filter: 'In Progress' as TicketStatus },
          { label: 'On Hold', count: onHoldCount, color: 'bg-orange-500', filter: 'On Hold' as TicketStatus },
          { label: 'Resolved', count: resolvedCount, color: 'bg-emerald-500', filter: 'Resolved' as TicketStatus },
        ].map(({ label, count, color, filter }) => {
          const active = statusFilter === filter;
          return (
            <div
              key={label}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => handleStatClick(filter)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleStatClick(filter); } }}
              className={`bg-white overflow-hidden shadow-sm rounded-lg border relative cursor-pointer transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-dark/30 ${active ? 'border-brand-dark ring-1 ring-brand-dark/20' : 'border-gray-200'}`}
            >
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${color}`} />
              <div className="p-5 pl-6">
                <dt className="text-sm font-medium text-gray-500 break-words">{label}</dt>
                <dd className="mt-1 text-3xl font-semibold text-gray-900">{loading ? '—' : count}</dd>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-5 sm:px-6 border-b border-gray-200 flex items-center justify-between gap-4">
          <h3 className="text-lg leading-6 font-serif font-semibold text-gray-900">
            {statusFilter ? `${statusFilter} Requests` : 'Recent Requests'}
          </h3>
          {statusFilter && (
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className="text-sm text-brand-gold hover:text-yellow-700 font-medium whitespace-nowrap"
            >
              Clear filter
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            {/* The column headers set the table's minimum width, so in the error state
                hide them and let the message wrap to the card instead of scrolling sideways. */}
            <thead className={`bg-gray-50 ${error ? 'hidden' : ''}`}>
              <tr>
                {['Ticket #', 'Type', 'Title', 'Status', 'Assignee', 'Date'].map((h) => (
                  <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-red-600">Couldn't load your requests. Check your connection and refresh.</td></tr>
              ) : visibleTickets.length > 0 ? (
                visibleTickets.map((ticket) => {
                  const assignees = getAssigneeIds(ticket).map((id) => profiles[id]).filter(Boolean);
                  return (
                    <tr key={ticket.id} onClick={() => navigate(`/tickets/${ticket.id}`)} className="hover:bg-gray-50 cursor-pointer transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-500">{ticket.id}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ticket.type}</td>
                      <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-xs truncate">{ticket.title}</td>
                      <td className="px-6 py-4 whitespace-nowrap"><StatusBadge status={ticket.status} /></td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {assignees.length > 0 ? (
                          <div className="flex items-center -space-x-2">
                            {assignees.slice(0, 3).map((a) => (
                              <Avatar key={a.id} className="h-6 w-6 rounded-full border-2 border-white" src={a.photoURL} name={a.name} />
                            ))}
                            {assignees.length > 3 && (
                              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-gray-200 text-[10px] font-medium text-gray-600 border-2 border-white">
                                +{assignees.length - 3}
                              </span>
                            )}
                          </div>
                        ) : <span className="text-sm text-gray-400 italic">Unassigned</span>}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatDate(ticket.createdAt)}</td>
                    </tr>
                  );
                })
              ) : statusFilter ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-500">No {statusFilter.toLowerCase()} tickets.</td></tr>
              ) : (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-500">No tickets found. Create a new request to get started.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
