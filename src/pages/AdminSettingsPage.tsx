import { useState, useEffect } from 'react';
import { collection, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { AssigneeSelector } from '../components/AssigneeSelector';
import { ConfirmModal } from '../components/ConfirmModal';
import { Modal } from '../components/Modal';
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [addingType, setAddingType] = useState(false);
  const [addError, setAddError] = useState('');

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

  const openAddModal = () => {
    setNewTypeName('');
    setAddError('');
    setShowAddModal(true);
  };

  const handleAddType = async () => {
    const trimmed = newTypeName.trim();
    if (!trimmed || !db) return;
    // Duplicate-name guard (case-insensitive): names drive ticket linkage + the
    // dashboard filter, so two types with the same name would be ambiguous.
    if (requestTypes.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      setAddError(`A request type named "${trimmed}" already exists.`);
      return;
    }
    setAddingType(true);
    setAddError('');
    try {
      // Write first, then add the row with the REAL Firestore id so edit/toggle/
      // delete on the new row target the right document (not a fabricated id).
      const docRef = await addDoc(collection(db, 'requestTypes'), { name: trimmed, defaultAssigneeIds: [], active: true, createdAt: serverTimestamp() });
      setRequestTypes((prev) => [...prev, { id: docRef.id, name: trimmed, defaultAssigneeIds: [], active: true }].sort((a, b) => a.name.localeCompare(b.name)));
      setShowAddModal(false);
      setNewTypeName('');
    } catch (err) {
      console.error('Failed to add type:', err);
      setAddError('Could not add the request type. Please try again.');
    } finally {
      setAddingType(false);
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
          <button onClick={openAddModal} className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors">
            <Plus className="h-4 w-4 mr-2" />Add Type
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-white">
              <tr>{['Type Name', 'Default Assignees', 'Status', 'Actions'].map((h) => <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {requestTypes.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-sm text-gray-500">No request types yet. Click “Add Type” to create one.</td></tr>
              )}
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
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} labelledBy="add-type-title" widthClass="max-w-sm">
        <div className="px-6 py-5 border-b border-gray-200">
          <h3 id="add-type-title" className="text-lg font-serif font-semibold text-gray-900">Add Request Type</h3>
        </div>
        <div className="p-6 space-y-2">
          <label htmlFor="new-type-name" className="block text-sm font-medium text-gray-700">Type name</label>
          <input
            id="new-type-name"
            value={newTypeName}
            onChange={(e) => setNewTypeName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddType(); }}
            autoFocus
            placeholder="e.g. Facilities"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
          />
          {addError && <p className="text-sm text-red-600" role="alert">{addError}</p>}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button onClick={handleAddType} disabled={addingType || !newTypeName.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] disabled:opacity-50 transition-colors">
            {addingType ? 'Adding…' : 'Add Type'}
          </button>
        </div>
      </Modal>
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
