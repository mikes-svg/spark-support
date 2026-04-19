import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, query, where, orderBy, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/Badges';
import { Plus } from 'lucide-react';
import { getAssigneeIds } from '../types';
import type { TicketStatus, TicketPriority } from '../types';

interface Ticket {
  id: string;
  type: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeIds?: string[];
  assigneeId?: string | null;
  submitterId: string;
  createdAt: { toDate: () => Date } | string;
  participants: string[];
}

interface Profile { id: string; name: string; photoURL: string; }

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !db) { setLoading(false); return; }

    async function fetchTickets() {
      try {
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
      } finally {
        setLoading(false);
      }
    }
    fetchTickets();
  }, [user]);

  const openCount = tickets.filter((t) => t.status === 'Open').length;
  const inProgressCount = tickets.filter((t) => t.status === 'In Progress').length;
  const resolvedCount = tickets.filter((t) => t.status === 'Resolved').length;

  const formatDate = (ts: Ticket['createdAt']) => {
    if (!ts) return '';
    const d = typeof ts === 'string' ? new Date(ts) : ts.toDate();
    return d.toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Overview</h2>
        <Link to="/submit" className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-brand-gold hover:bg-yellow-600 shadow-sm transition-colors">
          <Plus className="h-4 w-4 mr-2" />Submit New Request
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        {[
          { label: 'Open Tickets', count: openCount, color: 'bg-blue-500' },
          { label: 'In Progress', count: inProgressCount, color: 'bg-amber-500' },
          { label: 'Resolved', count: resolvedCount, color: 'bg-emerald-500' },
        ].map(({ label, count, color }) => (
          <div key={label} className="bg-white overflow-hidden shadow-sm rounded-lg border border-gray-200 relative">
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${color}`} />
            <div className="p-5 pl-6">
              <dt className="text-sm font-medium text-gray-500 truncate">{label}</dt>
              <dd className="mt-1 text-3xl font-semibold text-gray-900">{loading ? '—' : count}</dd>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-5 sm:px-6 border-b border-gray-200">
          <h3 className="text-lg leading-6 font-serif font-semibold text-gray-900">Recent Requests</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['Ticket #', 'Type', 'Title', 'Status', 'Assignee', 'Date'].map((h) => (
                  <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400">Loading…</td></tr>
              ) : tickets.length > 0 ? (
                tickets.map((ticket) => {
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
                              <img key={a.id} className="h-6 w-6 rounded-full border-2 border-white" src={a.photoURL} alt={a.name} title={a.name} />
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
