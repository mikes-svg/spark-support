import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, updateDoc, deleteDoc, addDoc, setDoc, serverTimestamp, orderBy } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut as firebaseSignOut, updateProfile } from 'firebase/auth';
import { db, firebaseConfig } from '../lib/firebase';
import { Plus, Trash2, Edit2, Check, X, UserPlus } from 'lucide-react';
import { users as mockUsers, requestTypes as mockRTs } from '../mockData';

interface Profile { id: string; name: string; email: string; photoURL: string; role: 'admin' | 'user'; }
interface RequestType { id: string; name: string; defaultAssigneeId: string | null; active: boolean; }

export function AdminSettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editTypeName, setEditTypeName] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: '', email: '', role: 'user' as 'admin' | 'user' });
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [userCreated, setUserCreated] = useState(false);

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

  const updateDefaultAssignee = async (rt: RequestType, assigneeId: string) => {
    const newAssigneeId = assigneeId || null;
    setRequestTypes((prev) => prev.map((t) => t.id === rt.id ? { ...t, defaultAssigneeId: newAssigneeId } : t));
    if (!db) return;
    await updateDoc(doc(db, 'requestTypes', rt.id), { defaultAssigneeId: newAssigneeId });
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

  const handleInviteUser = async () => {
    if (!inviteForm.name.trim() || !inviteForm.email.trim()) return;
    setInviting(true);
    setInviteError('');
    try {
      // Use a secondary Firebase app so we don't sign out the current admin
      const secondaryApp = initializeApp(firebaseConfig, `invite-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      let uid: string;
      try {
        const { user: newUser } = await createUserWithEmailAndPassword(secondaryAuth, inviteForm.email.trim(), 'Spark!!');
        await updateProfile(newUser, { displayName: inviteForm.name.trim() });
        uid = newUser.uid;
      } catch (createErr: unknown) {
        const code = (createErr as { code?: string }).code;
        if (code === 'auth/email-already-in-use') {
          // Auth account exists but may be missing a Firestore profile — sign in to get UID
          const { user: existingUser } = await signInWithEmailAndPassword(secondaryAuth, inviteForm.email.trim(), 'Spark!!');
          uid = existingUser.uid;
        } else {
          throw createErr;
        }
      }

      await firebaseSignOut(secondaryAuth);
      await deleteApp(secondaryApp);

      const displayName = inviteForm.name.trim();
      const photoURL = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`;
      const profileData = {
        name: displayName,
        email: inviteForm.email.trim(),
        photoURL,
        role: inviteForm.role,
        createdAt: serverTimestamp(),
      };
      if (db) await setDoc(doc(db, 'profiles', uid), profileData);

      const newProfile: Profile = { id: uid, ...profileData, role: inviteForm.role };
      setProfiles((prev) => {
        const filtered = prev.filter((p) => p.id !== uid);
        return [...filtered, newProfile].sort((a, b) => a.name.localeCompare(b.name));
      });
      setUserCreated(true);
      setInviteForm({ name: '', email: '', role: 'user' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create user.';
      setInviteError(msg.includes('invalid-credential') ? 'User exists with a different password. Have them sign in with Google SSO instead.' : msg);
    } finally {
      setInviting(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" /></div>;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-serif font-semibold text-gray-900">Manage Users</h2>
            <p className="mt-1 text-sm text-gray-500">Toggle admin access for portal users.</p>
          </div>
          <button onClick={() => setShowInviteModal(true)} className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors">
            <UserPlus className="h-4 w-4 mr-2" />Add User
          </button>
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
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <select
                        value={type.defaultAssigneeId || ''}
                        onChange={(e) => updateDefaultAssignee(type, e.target.value)}
                        className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark min-w-[140px]"
                      >
                        <option value="">Unassigned</option>
                        {profiles.filter((p) => p.role === 'admin').map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-serif font-semibold text-gray-900">{userCreated ? 'User Created' : 'Add New User'}</h3>
              <button onClick={() => { setShowInviteModal(false); setInviteError(''); setUserCreated(false); }} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
            </div>
            {userCreated ? (
              <div className="p-6 text-center space-y-4">
                <p className="text-sm text-gray-600">The user can now log in with Google SSO or with their email and the default password <strong>Spark</strong>.</p>
                <div className="bg-brand-dark/5 border border-brand-dark/20 rounded-xl py-6">
                  <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Default Password</p>
                  <p className="text-4xl font-mono font-bold text-brand-dark tracking-[0.3em]">Spark</p>
                </div>
                <p className="text-xs text-gray-400">Google Sign-In is recommended for the best experience.</p>
                <button onClick={() => { setShowInviteModal(false); setUserCreated(false); }} className="w-full py-2.5 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] transition-colors">Done</button>
              </div>
            ) : (
              <>
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
                    <select value={inviteForm.role} onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value as 'admin' | 'user' }))} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark">
                      <option value="user">User</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>
                  <p className="text-xs text-gray-400">Default password is Spark. Users can also sign in with Google.</p>
                </div>
                <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
                  <button onClick={() => { setShowInviteModal(false); setInviteError(''); }} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
                  <button onClick={handleInviteUser} disabled={inviting || !inviteForm.name || !inviteForm.email} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#153427] disabled:opacity-50 transition-colors">
                    {inviting ? 'Creating…' : 'Create User'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
