import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, deleteDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Trash2, Edit2, Check, X, UserPlus, Users } from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';

interface Profile { id: string; name: string; email: string; photoURL: string; role: 'superadmin' | 'admin' | 'user'; }

interface Permission {
  label: string;
  super: boolean;
  admin: boolean;
  user: boolean;
}

interface PermissionSection {
  title: string;
  color: string;
  permissions: Permission[];
}

const PERMISSIONS: PermissionSection[] = [
  {
    title: 'Tickets',
    color: 'bg-blue-50 text-blue-800',
    permissions: [
      { label: 'Submit new tickets', super: true, admin: true, user: true },
      { label: 'Add comments & attachments', super: true, admin: true, user: true },
      { label: 'View all tickets in organization', super: true, admin: true, user: false },
      { label: 'Change ticket status & priority', super: true, admin: true, user: false },
      { label: 'Reassign tickets', super: true, admin: true, user: false },
      { label: 'Delete tickets', super: true, admin: false, user: false },
    ],
  },
  {
    title: 'Team',
    color: 'bg-amber-50 text-amber-800',
    permissions: [
      { label: 'Invite individual users', super: true, admin: true, user: false },
      { label: 'Bulk invite users', super: true, admin: true, user: false },
      { label: 'Change user roles', super: true, admin: true, user: false },
      { label: 'Delete users', super: true, admin: true, user: false },
    ],
  },
  {
    title: 'Categories',
    color: 'bg-emerald-50 text-emerald-800',
    permissions: [
      { label: 'Submit against any category', super: true, admin: true, user: true },
      { label: 'Add & rename categories', super: true, admin: false, user: false },
      { label: 'Set default assignees', super: true, admin: false, user: false },
      { label: 'Activate / deactivate categories', super: true, admin: false, user: false },
      { label: 'Delete categories', super: true, admin: false, user: false },
    ],
  },
];

function Cell({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-emerald-500 text-white">
      <Check className="h-4 w-4" strokeWidth={3} />
    </span>
  ) : (
    <span className="text-gray-300">—</span>
  );
}

export function TeamPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: '', email: '', role: 'user' as Profile['role'] });
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editUserName, setEditUserName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [roleChange, setRoleChange] = useState<{ profile: Profile; newRole: Profile['role'] } | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkEmails, setBulkEmails] = useState('');
  const [bulkRole, setBulkRole] = useState<Profile['role']>('user');
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const snap = await getDocs(collection(db!, 'profiles'));
        setProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
      } catch (err) {
        console.error('Failed to fetch team:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const requestRoleChange = (profile: Profile, newRole: Profile['role']) => {
    if (newRole === profile.role) return;
    setRoleChange({ profile, newRole });
  };

  const confirmRoleChange = async () => {
    if (!roleChange) return;
    const { profile, newRole } = roleChange;
    setRoleChange(null);
    setProfiles((prev) => prev.map((p) => p.id === profile.id ? { ...p, role: newRole } : p));
    if (!db) return;
    await updateDoc(doc(db, 'profiles', profile.id), { role: newRole });
  };

  const roleLabel = (r: Profile['role']) => r === 'superadmin' ? 'Super Administrator' : r === 'admin' ? 'Administrator' : 'User';

  const deleteUser = async () => {
    if (!deleteTarget) return;
    setProfiles((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    if (db) await deleteDoc(doc(db, 'profiles', deleteTarget.id));
    setDeleteTarget(null);
  };

  const saveUserName = async (profile: Profile) => {
    if (!editUserName.trim() || editUserName.trim() === profile.name) {
      setEditingUser(null);
      return;
    }
    const newName = editUserName.trim();
    const newPhotoURL = `https://ui-avatars.com/api/?name=${encodeURIComponent(newName)}&background=1B4332&color=D4A843`;
    setProfiles((prev) => prev.map((p) => p.id === profile.id ? { ...p, name: newName, photoURL: newPhotoURL } : p));
    setEditingUser(null);
    if (!db) return;
    await updateDoc(doc(db, 'profiles', profile.id), { name: newName, photoURL: newPhotoURL });
  };

  const handleInviteUser = async () => {
    if (!inviteForm.name.trim() || !inviteForm.email.trim()) return;
    setInviting(true);
    setInviteError('');
    try {
      const existing = profiles.find((p) => p.email.toLowerCase() === inviteForm.email.trim().toLowerCase());
      if (existing) {
        setInviteError('A user with this email already exists.');
        return;
      }
      const displayName = inviteForm.name.trim();
      const photoURL = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`;
      const emailLower = inviteForm.email.trim().toLowerCase();
      const profileData = { name: displayName, email: emailLower, photoURL, role: inviteForm.role, createdAt: serverTimestamp() };
      const profileId = emailLower.replace(/[^a-z0-9]/g, '_');
      if (db) await setDoc(doc(db, 'profiles', profileId), profileData);
      const newProfile: Profile = { id: profileId, ...profileData, role: inviteForm.role };
      setProfiles((prev) => [...prev, newProfile].sort((a, b) => a.name.localeCompare(b.name)));
      setShowInviteModal(false);
      setInviteForm({ name: '', email: '', role: 'user' });
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : 'Failed to create user.');
    } finally {
      setInviting(false);
    }
  };

  const nameFromEmail = (email: string) =>
    email.split('@')[0].split(/[._-]/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || email;

  const handleBulkImport = async () => {
    if (!db) return;
    setBulkImporting(true);
    setBulkResult(null);
    try {
      const raw = bulkEmails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      const uniqueEmails = [...new Set(raw)];
      const existingEmails = new Set(profiles.map((p) => p.email.toLowerCase()));
      const toCreate = uniqueEmails.filter((e) => !existingEmails.has(e));
      let created = 0;
      const errors: string[] = [];
      const newProfiles: Profile[] = [];
      for (const email of toCreate) {
        try {
          const displayName = nameFromEmail(email);
          const profileId = email.replace(/[^a-z0-9]/g, '_');
          const photoURL = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`;
          const data = { name: displayName, email, photoURL, role: bulkRole, createdAt: serverTimestamp() };
          await setDoc(doc(db, 'profiles', profileId), data);
          newProfiles.push({ id: profileId, name: displayName, email, photoURL, role: bulkRole });
          created++;
        } catch (err) {
          errors.push(`${email}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }
      setProfiles((prev) => [...prev, ...newProfiles].sort((a, b) => a.name.localeCompare(b.name)));
      setBulkResult({ created, skipped: uniqueEmails.length - toCreate.length, errors });
      setBulkEmails('');
    } finally {
      setBulkImporting(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" /></div>;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Manage Users */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-serif font-semibold text-gray-900">Manage Users</h2>
            <p className="mt-1 text-sm text-gray-500">Invite team members and assign their role.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setShowBulkModal(true); setBulkResult(null); }} className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors">
              <Users className="h-4 w-4 mr-2" />Bulk Invite
            </button>
            <button onClick={() => setShowInviteModal(true)} className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors">
              <UserPlus className="h-4 w-4 mr-2" />Add User
            </button>
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
                      {editingUser === profile.id ? (
                        <div className="flex items-center gap-1">
                          <input type="text" value={editUserName} onChange={(e) => setEditUserName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveUserName(profile); if (e.key === 'Escape') setEditingUser(null); }} className="border border-gray-300 rounded px-2 py-1 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-brand-dark" autoFocus />
                          <button onClick={() => saveUserName(profile)} className="text-green-600 hover:text-green-700"><Check className="h-4 w-4" /></button>
                          <button onClick={() => setEditingUser(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
                        </div>
                      ) : (
                        <div className="text-sm font-medium text-gray-900">{profile.name}</div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{profile.email}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <select value={profile.role} onChange={(e) => requestRoleChange(profile, e.target.value as Profile['role'])} className="border border-gray-300 rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-dark bg-white">
                      <option value="user">User</option>
                      <option value="admin">Administrator</option>
                      <option value="superadmin">Super Administrator</option>
                    </select>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-3">
                    <button onClick={() => { setEditingUser(profile.id); setEditUserName(profile.name); }} className="text-gray-400 hover:text-brand-dark transition-colors inline-block">
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button onClick={() => setDeleteTarget(profile)} className="text-red-400 hover:text-red-600 transition-colors inline-block">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role Permissions Matrix */}
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-lg font-serif font-semibold text-gray-900">Role Permissions</h2>
          <p className="mt-1 text-sm text-gray-500">What each role can do in the portal.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/2">Permission</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Super Admin</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Admin</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((section) => (
                <React.Fragment key={section.title}>
                  <tr>
                    <td colSpan={4} className="px-6 pt-5 pb-2">
                      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${section.color}`}>
                        {section.title}
                      </span>
                    </td>
                  </tr>
                  {section.permissions.map((perm, idx) => (
                    <tr key={perm.label} className={idx === section.permissions.length - 1 ? '' : 'border-b border-gray-100'}>
                      <td className="px-6 py-3 text-sm text-gray-700">{perm.label}</td>
                      <td className="px-6 py-3 text-center"><Cell allowed={perm.super} /></td>
                      <td className="px-6 py-3 text-center"><Cell allowed={perm.admin} /></td>
                      <td className="px-6 py-3 text-center"><Cell allowed={perm.user} /></td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invite modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-serif font-semibold text-gray-900">Add New User</h3>
              <button onClick={() => { setShowInviteModal(false); setInviteError(''); }} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              {inviteError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{inviteError}</p>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input type="text" value={inviteForm.name} onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" placeholder="Jane Smith" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" value={inviteForm.email} onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" placeholder="jane@standifercapital.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select value={inviteForm.role} onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value as Profile['role'] }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark">
                  <option value="user">User</option>
                  <option value="admin">Administrator</option>
                  <option value="superadmin">Super Administrator</option>
                </select>
              </div>
              <p className="text-xs text-gray-400">Pre-register a user and set their role. They'll sign in with Google when ready.</p>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => { setShowInviteModal(false); setInviteError(''); }} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
              <button onClick={handleInviteUser} disabled={inviting || !inviteForm.name || !inviteForm.email} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] disabled:opacity-50 transition-colors">
                {inviting ? 'Creating…' : 'Add User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk invite modal */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-serif font-semibold text-gray-900">Bulk Invite Users</h3>
              <button onClick={() => { setShowBulkModal(false); setBulkResult(null); }} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                Paste a list of email addresses (one per line, or separated by commas). Names will be generated from each email. When they sign in with Google, they'll inherit the role you select here.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Emails</label>
                <textarea value={bulkEmails} onChange={(e) => setBulkEmails(e.target.value)} rows={8} placeholder={'alice@company.com\nbob@company.com\ncharlie@company.com'} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-dark" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Assign Role</label>
                <select value={bulkRole} onChange={(e) => setBulkRole(e.target.value as Profile['role'])} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark">
                  <option value="user">User</option>
                  <option value="admin">Administrator</option>
                  <option value="superadmin">Super Administrator</option>
                </select>
              </div>
              {bulkResult && (
                <div className="bg-gray-50 border border-gray-200 rounded-md p-3 text-sm space-y-1">
                  <p className="font-medium text-gray-900">Import complete</p>
                  <p className="text-emerald-700">✓ Created: {bulkResult.created}</p>
                  {bulkResult.skipped > 0 && <p className="text-gray-500">↷ Skipped (already exist): {bulkResult.skipped}</p>}
                  {bulkResult.errors.length > 0 && (
                    <div className="text-red-600">
                      <p>✕ Errors: {bulkResult.errors.length}</p>
                      <ul className="mt-1 list-disc list-inside text-xs">
                        {bulkResult.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => { setShowBulkModal(false); setBulkResult(null); }} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Close</button>
              <button onClick={handleBulkImport} disabled={bulkImporting || !bulkEmails.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] disabled:opacity-50 transition-colors">
                {bulkImporting ? 'Importing…' : 'Import Users'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete User"
        message={deleteTarget ? `Delete "${deleteTarget.name}" (${deleteTarget.email})? This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={deleteUser}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmModal
        open={!!roleChange}
        title="Change Role"
        message={roleChange ? `Change ${roleChange.profile.name}'s role from ${roleLabel(roleChange.profile.role)} to ${roleLabel(roleChange.newRole)}?` : ''}
        confirmLabel="Change Role"
        onConfirm={confirmRoleChange}
        onCancel={() => setRoleChange(null)}
      />
    </div>
  );
}
