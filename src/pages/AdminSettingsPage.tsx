import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, orderBy } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { users as mockUsers, requestTypes as mockRTs } from '../mockData';

interface Profile { id: string; name: string; email: string; photoURL: string; role: 'admin' | 'user'; }
interface RequestType { id: string; name: string; defaultAssigneeId: string | null; active: boolean; }

export function AdminSettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editTypeName, setEditTypeName] = useState('');

  useEffect(() => {
    if (!db) {
      setProfiles(mockUsers.map((u) => ({ id: u.id, name: u.name, email: u.email, photoURL: u.avatar, role: u.role })));
      setRequestTypes(mockRTs.map((rt) => ({ id: rt.id, name: rt.name, defaultAssigneeId: rt.defaultAssigneeId, active: rt.active })));
      setLoading(false);
      return;
    }
    async function fetchData() {
      try {
        const profilesSnap = await getDocs(collection(db!, 'profiles'));
        setProfiles(profilesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        const rtSnap = await getDocs(query(collection(db!, 'requestTypes'), orderBy('name')));
        setRequestTypes(rtSnap.docs.map((d) => ({ id: d.id, ...d.data() } as RequestType)));
      } catch (err) {
        console.warn('Firestore unavailable, using mock data:', err);
        setProfiles(mockUsers.map((u) => ({ id: u.id, name: u.name, email: u.email, photoURL: u.avatar, role: u.role })));
        setRequestTypes(mockRTs.map((rt) => ({ id: rt.id, name: rt.name, defaultAssigneeId: rt.defaultAssigneeId, active: rt.active })));
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const toggleRole = async (profile: Profile) => {
    const newRole: 'admin' | 'user' = profile.role === 'admin' ? 'user' : 'admin';
    setProfiles((prev) => prev.map((p) => p.id === profile.id ? { ...p, role: newRole } : p));
    if (!db) return;
    await updateDoc(doc(db, 'profiles', profile.id), { role: newRole });
  };

  const toggleRequestTypeActive = async (rt: RequestType) => {
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, active: !t.active } : t));
    if (!db) return;
    await updateDoc(doc(db, 'requestTypes', rt.id), { active: !rt.active });
  };

  const saveTypeName = async (rt: RequestType) => {
    if (!editTypeName.trim()) return;
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, name: editTypeName.trim() } : t));
    setEditingType(null);
    if (!db) return;
    await updateDoc(doc(db, 'requestTypes', rt.id), { name: editTypeName.trim() });
  };

  const deleteRequestType = async (id: string) => {
    setRequestTypes((prev) => prev.filter((t) => t.id !== id));
    if (!db) return;
    await deleteDoc(doc(db, 'requestTypes', id));
  };

  const addRequestType = async () => {
    const name = window.prompt('Enter new request type name:');
    if (!name?.trim()) return;
    const newType: RequestType = { id: `rt-${Date.now()}`, name: name.trim(), defaultAssigneeId: null, active: true };
    setRequestTypes((prev) => [...prev, newType].sort((a, b) => a.name.localeCompare(b.name)));
    if (!db) return;
    await addDoc(collection(db, 'requestTypes'), { name: name.trim(), defaultAssigneeId: null, active: true, createdAt: serverTimestamp() });
  };

  const profilesMap = Object.fromEntries(profiles.map((p) => [p.id, p]));

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" /></div>;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-serif font-semibold text-gray-900">Manage Users</h2>
            <p className="mt-1 text-sm text-gray-500">Toggle admin access for portal users.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-white">
              <tr>{['Name', 'Email', 'Role', 'Actions'].map((h) => <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <img className="h-8 w-8 rounded-full mr-3" src={profile.photoURL} alt="" />
                      <div className="text-sm font-medium text-gray-900">{profile.name}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{profile.email}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${profile.role === 'admin' ? 'bg-brand-dark/10 text-brand-dark' : 'bg-gray-100 text-gray-600'}`}>
                      {profile.role === 'admin' ? 'Administrator' : 'User'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button onClick={() => toggleRole(profile)} className="text-brand-dark hover:text-brand-gold text-xs font-medium transition-colors">
                      {profile.role === 'admin' ? 'Revoke Admin' : 'Make Admin'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-serif font-semibold text-gray-900">Request Types & Routing</h2>
            <p className="mt-1 text-sm text-gray-500">Configure categories and default assignees for new tickets.</p>
          </div>
          <button onClick={addRequestType} className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors">
            <Plus className="h-4 w-4 mr-2" />Add Type
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-white">
              <tr>{['Type Name', 'Default Assignee', 'Status', 'Actions'].map((h) => <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {requestTypes.map((type) => {
                const defaultAssignee = type.defaultAssigneeId ? profilesMap[type.defaultAssigneeId] : null;
                return (
                  <tr key={type.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {editingType === type.id ? (
                        <div className="flex items-center gap-2">
                          <input value={editTypeName} onChange={(e) => setEditTypeName(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm" autoFocus />
                          <button onClick={() => saveTypeName(type)} className="text-emerald-600 hover:text-emerald-800"><Check className="h-4 w-4" /></button>
                          <button onClick={() => setEditingType(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
                        </div>
                      ) : type.name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{defaultAssignee ? defaultAssignee.name : 'Unassigned'}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button onClick={() => toggleRequestTypeActive(type)} className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer ${type.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                        {type.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-3">
                      <button onClick={() => { setEditingType(type.id); setEditTypeName(type.name); }} className="text-gray-400 hover:text-brand-dark transition-colors inline-block"><Edit2 className="h-4 w-4" /></button>
                      <button onClick={() => deleteRequestType(type.id)} className="text-red-400 hover:text-red-600 transition-colors inline-block"><Trash2 className="h-4 w-4" /></button>
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
