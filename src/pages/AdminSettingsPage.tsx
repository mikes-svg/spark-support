import React, { useState, useEffect } from 'react';
import { collection, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { AssigneeSelector } from '../components/AssigneeSelector';
import { getOrSeedRequestTypes } from '../lib/seedRequestTypes';
import { getDefaultAssigneeIds } from '../types';

interface Profile { id: string; name: string; email: string; photoURL: string; role: 'superadmin' | 'admin' | 'user'; }
interface RequestType {
  id: string;
  name: string;
  defaultAssigneeIds?: string[];
  defaultAssigneeId?: string | null;
  active: boolean;
}

export function AdminSettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editTypeName, setEditTypeName] = useState('');

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const profilesSnap = await getDocs(collection(db!, 'profiles'));
        setProfiles(profilesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        const types = await getOrSeedRequestTypes();
        setRequestTypes(types as RequestType[]);
      } catch (err) {
        console.error('Failed to fetch settings data:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

  const updateDefaultAssignees = async (rt: RequestType, assigneeIds: string[]) => {
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, defaultAssigneeIds: assigneeIds, defaultAssigneeId: null } : t));
    if (!db) return;
    await updateDoc(doc(db, 'requestTypes', rt.id), { defaultAssigneeIds: assigneeIds, defaultAssigneeId: null });
  };

  const deleteRequestType = async (id: string) => {
    setRequestTypes((prev) => prev.filter((t) => t.id !== id));
    if (!db) return;
    await deleteDoc(doc(db, 'requestTypes', id));
  };

  const addRequestType = async () => {
    const name = window.prompt('Enter new request type name:');
    if (!name?.trim()) return;
    const newType: RequestType = { id: `rt-${Date.now()}`, name: name.trim(), defaultAssigneeIds: [], active: true };
    setRequestTypes((prev) => [...prev, newType].sort((a, b) => a.name.localeCompare(b.name)));
    if (!db) return;
    await addDoc(collection(db, 'requestTypes'), { name: name.trim(), defaultAssigneeIds: [], active: true, createdAt: serverTimestamp() });
  };

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" /></div>;

  const admins = profiles.filter((p) => p.role === 'admin' || p.role === 'superadmin');

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
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
              <tr>{['Type Name', 'Default Assignees', 'Status', 'Actions'].map((h) => <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {requestTypes.map((type) => (
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
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 min-w-[200px]">
                    <AssigneeSelector
                      value={getDefaultAssigneeIds(type)}
                      onChange={(ids) => updateDefaultAssignees(type, ids)}
                      admins={admins}
                    />
                  </td>
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
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
