import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, query, where, orderBy, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/Badges';
import { Avatar } from '../components/Avatar';
import { Plus, Users, Tag } from 'lucide-react';
import { getAssigneeIds } from '../types';
import type { Ticket, Profile, TicketStatus } from '../types';
import { formatDate } from '../lib/dates';

// Sentinel for the "Unassigned" choice in the assignee filter, kept distinct
// from '' which means "all assignees".
const UNASSIGNED = '__unassigned__';

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
  // Filter the view to tickets involving one assignee (or the Unassigned
  // bucket). '' = all assignees. Composes with the status tile filter below.
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  // Filter the view to one request type (e.g. MOR). '' = all types. Composes
  // with the assignee and status filters below.
  const [typeFilter, setTypeFilter] = useState<string>('');

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

  // The assignees actually present on the user's own tickets, plus whether any
  // are unassigned — this drives the filter dropdown. We only offer people who
  // appear on these tickets (not the whole directory), so the list stays short
  // and every option matches something.
  const assigneeOptions = useMemo(() => {
    const ids = new Set<string>();
    let hasUnassigned = false;
    for (const t of tickets) {
      const a = getAssigneeIds(t);
      if (a.length === 0) hasUnassigned = true;
      else a.forEach((id) => ids.add(id));
    }
    const people = [...ids]
      .map((id) => profiles[id])
      .filter((p): p is Profile => Boolean(p))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { people, hasUnassigned };
  }, [tickets, profiles]);

  // Only worth showing the control when it can actually narrow anything — i.e.
  // there's more than one bucket to choose between.
  const assigneeBucketCount = assigneeOptions.people.length + (assigneeOptions.hasUnassigned ? 1 : 0);
  const canFilterByAssignee = assigneeBucketCount > 1;

  // Request types present on the user's own tickets, for the type filter.
  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tickets) if (t.type) set.add(t.type);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tickets]);
  const canFilterByType = typeOptions.length > 1;

  const matchesAssignee = (t: Ticket) => {
    if (!assigneeFilter) return true;
    const ids = getAssigneeIds(t);
    if (assigneeFilter === UNASSIGNED) return ids.length === 0;
    return ids.includes(assigneeFilter);
  };
  const matchesType = (t: Ticket) => !typeFilter || t.type === typeFilter;

  // The assignee and type filters scope the whole view — both the status tile
  // counts and the table — so the tiles always reconcile with the rows below.
  const scopedTickets = assigneeFilter || typeFilter
    ? tickets.filter((t) => matchesAssignee(t) && matchesType(t))
    : tickets;

  const openCount = scopedTickets.filter((t) => t.status === 'Open').length;
  const inProgressCount = scopedTickets.filter((t) => t.status === 'In Progress').length;
  const onHoldCount = scopedTickets.filter((t) => t.status === 'On Hold').length;
  const resolvedCount = scopedTickets.filter((t) => t.status === 'Resolved').length;

  // Re-clicking the active tile clears the filter; otherwise select it.
  const handleStatClick = (filter: TicketStatus) =>
    setStatusFilter((prev) => (prev === filter ? null : filter));

  const visibleTickets = statusFilter ? scopedTickets.filter((t) => t.status === statusFilter) : scopedTickets;

  const anyFilterActive = statusFilter !== null || assigneeFilter !== '' || typeFilter !== '';
  const selectedAssigneeLabel =
    assigneeFilter === UNASSIGNED ? 'Unassigned'
    : assigneeFilter ? (profiles[assigneeFilter]?.name ?? 'Assignee')
    : null;
  // Non-status facets shown after the table title (status is already the title).
  const filterSuffixParts = [typeFilter || null, selectedAssigneeLabel].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      {/* Below ~sm the label and the CTA stack: side by side there isn't room for
          both at 320px and the button's label wraps mid-word. */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-between sm:items-center">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-widest">Overview</h2>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          {canFilterByType && (
            <div className="relative">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label="Filter by type"
                className="block w-full sm:w-44 pl-9 pr-10 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
              >
                <option value="">All types</option>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}
          {canFilterByAssignee && (
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label="Filter by assignee"
                className="block w-full sm:w-52 pl-9 pr-10 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-brand-dark focus:border-brand-dark"
              >
                <option value="">All assignees</option>
                {assigneeOptions.people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                {assigneeOptions.hasUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
              </select>
            </div>
          )}
          <Link to="/submit" className="inline-flex items-center justify-center whitespace-nowrap px-4 py-2 border border-transparent text-sm font-medium rounded-md text-brand-dark bg-brand-gold hover:bg-brand-gold/80 shadow-sm transition-colors">
            <Plus className="h-4 w-4 mr-2" />Submit New Request
          </Link>
        </div>
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
            {filterSuffixParts.length > 0 && (
              <span className="font-sans font-normal text-gray-500"> · {filterSuffixParts.join(' · ')}</span>
            )}
          </h3>
          {anyFilterActive && (
            <button
              type="button"
              onClick={() => { setStatusFilter(null); setAssigneeFilter(''); setTypeFilter(''); }}
              className="text-sm text-brand-gold hover:text-yellow-700 font-medium whitespace-nowrap"
            >
              Clear filters
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
              ) : (assigneeFilter || typeFilter) ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-500">No tickets match the current filters.</td></tr>
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
