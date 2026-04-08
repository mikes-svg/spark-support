import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, getDocs, doc, getDoc, updateDoc, serverTimestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { StatusBadge, PriorityBadge } from '../components/Badges';
import { Filter, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { tickets as mockTickets, users as mockUsers, requestTypes as mockRTs } from '../mockData';
import type { TicketStatus, TicketPriority } from '../mockData';

interface Profile { id: string; name: string; photoURL: string; role: string; }
interface Ticket {
  id: string; type: string; title: string; status: TicketStatus; priority: TicketPriority;
  assigneeId: string | null; submitterId: string; participants: string[];
  createdAt: { toDate: () => Date } | string;
}

function mockProfileMap(): Record<string, Profile> {
  const map: Record<string, Profile> = {};
  mockUsers.forEach((u) => { map[u.id] = { id: u.id, name: u.name, photoURL: u.avatar, role: u.role }; });
  map['dev-user'] = { id: 'dev-user', name: 'Dev Admin', photoURL: 'https://ui-avatars.com/api/?name=Dev+Admin&background=1B4332&color=D4A843', role: 'admin' };
  return map;
}

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [adminProfiles, setAdminProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');

  useEffect(() => {
    if (!db) {
      const all = mockTickets.map((t) => ({ ...t, assigneeId: t.assigneeId ?? null, participants: [t.submitterId, t.assigneeId].filter(Boolean) as string[] }));
      setTickets(all as unknown as Ticket[]);
      const pm = mockProfileMap();
      setProfiles(pm);
      setAdminProfiles(Object.values(pm).filter((p) => p.role === 'admin'));
      setRequestTypes([...new Set(mockRTs.map((rt) => rt.name))].sort());
      setLoading(false);
      return;
    }

    async function fetchData() {
      try {
        const ticketsSnap = await getDocs(query(collection(db!, 'tickets'), orderBy('createdAt', 'desc')));
        const ticketList = ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket));
        setTickets(ticketList);
        const rtSnap = await getDocs(collection(db!, 'requestTypes'));
        setRequestTypes(rtSnap.docs.map((d) => d.data().name as string).sort());
        const profileIds = [...new Set([...ticketList.map((t) => t.submitterId), ...ticketList.map((t) => t.assigneeId).filter(Boolean)])] as string[];
        const profileDocs = await Promise.all(profileIds.map((id) => getDoc(doc(db!, 'profiles', id))));
        const profileMap: Record<string, Profile> = {};
        profileDocs.forEach((p) => { if (p.exists()) profileMap[p.id] = { id: p.id, ...p.data() } as Profile; });
        setProfiles(profileMap);
        const adminSnap = await getDocs(query(collection(db!, 'profiles'), where('role', '==', 'admin')));
        setAdminProfiles(adminSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
      } catch (err) {
        console.warn('Firestore unavailable, using mock data:', err);
        const all = mockTickets.map((t) => ({ ...t, assigneeId: t.assigneeId ?? null, participants: [t.submitterId, t.assigneeId].filter(Boolean) as string[] }));
        setTickets(all as unknown as Ticket[]);
        const pm = mockProfileMap();
        setProfiles(pm);
        setAdminProfiles(Object.values(pm).filter((p) => p.role === 'admin'));
        setRequestTypes([...new Set(mockRTs.map((rt) => rt.name))].sort());
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const handleAssigneeChange = async (ticket: Ticket, newAssigneeId: string) => {
    const updatedParticipants = [...new Set([...ticket.participants.filter((p) => p !== ticket.assigneeId), ...(newAssigneeId ? [newAssigneeId] : [])])];
    setTickets((prev) => prev.map((t) => t.id === ticket.id ? { ...t, assigneeId: newAssigneeId || null, participants: updatedParticipants } : t));
    if (!db) return;
    await updateDoc(doc(db, 'tickets', ticket.id), { assigneeId: newAssigneeId || null, participants: updatedParticipants, updatedAt: serverTimestamp() });
  };

  const filteredTickets = tickets.filter((t) => {
    if (statusFilter !== 'All' && t.status !== statusFilter) return false;
    if (typeFilter && t.type !== typeFilter) return false;
    if (assigneeFilter && t.assigneeId !== assigneeFilter) return false;
    return true;
  });

  const formatDate = (ts: Ticket['createdAt']) => {
    if (!ts) return '';
    const d = typeof ts === 'string' ? new Date(ts) : ts.toDate();
    return d.toLocaleDateString();
  };

  const openCount = tickets.filter((t) => t.status === 'Open').length;
  const urgentCount = tickets.filter((t) => t.priority === 'Urgent').length;
  const resolvedCount = tickets.filter((t) => t.status === 'Resolved').length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Total Open', value: loading ? '—' : openCount, Icon: Clock, color: 'bg-blue-100 text-blue-600' },
          { label: 'Urgent Priority', value: loading ? '—' : urgentCount, Icon: AlertCircle, color: 'bg-red-100 text-red-600' },
          { label: 'Resolved This Week', value: loading ? '—' : resolvedCount, Icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-600' },
          { label: 'Avg Resolution', value: '1.2 days', Icon: Clock, color: 'bg-brand-gold/20 text-brand-gold' },
        ].map(({ label, value, Icon, color }) => (
          <div key={label} className="bg-white overflow-hidden shadow-sm rounded-lg border border-gray-200">
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
          {['Open', 'In Progress', 'Resolved', 'Closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border">
          <option value="">All Types</option>
          {requestTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border">
          <option value="">All Assignees</option>
          {adminProfiles.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button onClick={() => { setStatusFilter('All'); setTypeFilter(''); setAssigneeFilter(''); }} className="text-sm text-brand-gold hover:text-yellow-700 font-medium ml-auto">Reset Filters</button>
      </div>

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['Ticket #', 'Submitter', 'Details', 'Status / Priority', 'Assignee', ''].map((h) => (
                  <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400">Loading…</td></tr>
              ) : filteredTickets.map((ticket) => {
                const submitter = profiles[ticket.submitterId];
                return (
                  <tr key={ticket.id} className="hover:bg-gray-50 transition-colors">
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
                    <td className="px-6 py-4 whitespace-nowrap space-y-2">
                      <div className="block"><StatusBadge status={ticket.status} /></div>
                      <div className="block"><PriorityBadge priority={ticket.priority} /></div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select className="block w-full pl-3 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50" value={ticket.assigneeId || ''} onChange={(e) => handleAssigneeChange(ticket, e.target.value)}>
                        <option value="">Unassigned</option>
                        {adminProfiles.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button onClick={() => navigate(`/tickets/${ticket.id}`)} className="text-brand-dark hover:text-brand-gold transition-colors">View</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
