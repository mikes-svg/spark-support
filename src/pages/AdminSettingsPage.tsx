import { useState, useEffect } from 'react';
import { collection, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { AssigneeSelector } from '../components/AssigneeSelector';
import { ConfirmModal } from '../components/ConfirmModal';
import { getOrSeedRequestTypes } from '../lib/seedRequestTypes';
import { getDefaultAssigneeIds, isAdminRole } from '../types';
import { PageSpinner } from '../components/PageSpinner';

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
  const [deleteTarget, setDeleteTarget] = useState<RequestType | null>(null);
  const [actionError, setActionError] = useState('');

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
    if (!db) return;
    const next = !rt.active;
    setActionError('');
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, active: next } : t));
    try {
      await updateDoc(doc(db, 'requestTypes', rt.id), { active: next });
    } catch (err) {
      console.error('Failed to update status:', err);
      setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, active: rt.active } : t));
      setActionError('Could not update the status. Please try again.');
    }
  };

  const saveTypeName = async (rt: RequestType) => {
    const newName = editTypeName.trim();
    if (!newName || newName === rt.name) { setEditingType(null); return; }
    if (!db) { setEditingType(null); return; }
    setActionError('');
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, name: newName } : t));
    setEditingType(null);
    try {
      await updateDoc(doc(db, 'requestTypes', rt.id), { name: newName });
    } catch (err) {
      console.error('Failed to rename type:', err);
      setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, name: rt.name } : t));
      setActionError('Could not rename the type. Please try again.');
    }
  };

  const updateDefaultAssignees = async (rt: RequestType, assigneeIds: string[]) => {
    if (!db) return;
    const prevAssignees = getDefaultAssigneeIds(rt);
    setActionError('');
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, defaultAssigneeIds: assigneeIds, defaultAssigneeId: null } : t));
    try {
      await updateDoc(doc(db, 'requestTypes', rt.id), { defaultAssigneeIds: assigneeIds, defaultAssigneeId: null });
    } catch (err) {
      console.error('Failed to update default assignees:', err);
      setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, defaultAssigneeIds: prevAssignees, defaultAssigneeId: null } : t));
      setActionError('Could not update default assignees. Please try again.');
    }
  };

  const confirmDeleteRequestType = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target || !db) return;
    setActionError('');
    setRequestTypes((prev) => prev.filter((t) => t.id !== target.id));
    try {
      await deleteDoc(doc(db, 'requestTypes', target.id));
    } catch (err) {
      console.error('Failed to delete type:', err);
      setRequestTypes((prev) => [...prev, target].sort((a, b) => a.name.localeCompare(b.name)));
      setActionError('Could not delete the type. Please try again.');
    }
  };

  const addRequestType = async () => {
    const name = window.prompt('Enter new request type name:');
    const trimmed = name?.trim();
    if (!trimmed) return;
    if (!db) return;
    setActionError('');
    try {
      // Write first, then add the row with the REAL Firestore id so edit/toggle/
      // delete on the new row target the right document (not a fabricated id).
      const docRef = await addDoc(collection(db, 'requestTypes'), { name: trimmed, defaultAssigneeIds: [], active: true, createdAt: serverTimestamp() });
      setRequestTypes((prev) => [...prev, { id: docRef.id, name: trimmed, defaultAssigneeIds: [], active: true }].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      console.error('Failed to add type:', err);
      setActionError('Could not add the request type. Please try again.');
    }
  };

  if (loading) return <PageSpinner />;

  const admins = profiles.filter((p) => isAdminRole(p.role));

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}
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
                    <button onClick={() => setDeleteTarget(type)} aria-label={`Delete ${type.name}`} className="text-red-400 hover:text-red-600 transition-colors inline-block"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Request Type"
        message={deleteTarget ? `Delete "${deleteTarget.name}"? Existing tickets keep their label, but this type will no longer be selectable on new requests or appear as a dashboard filter. This can't be undone — consider marking it Inactive instead.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteRequestType}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
