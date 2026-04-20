import React, { useState, createContext, useContext, useEffect, ReactNode } from 'react';
import {
  onAuthStateChanged,
  signOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import type { Role } from '../types';

export interface Profile {
  id: string;
  name: string;
  email: string;
  photoURL: string;
  role: Role;
}

interface AuthContextType {
  user: Profile | null;
  loading: boolean;
  logout: () => Promise<void>;
  authError: string | null;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isSuperadminEmail(email: string): boolean {
  const superEmails = (import.meta.env.VITE_SUPERADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean);
  return superEmails.includes(email.toLowerCase());
}

function isAdminEmail(email: string): boolean {
  const adminEmails = (import.meta.env.VITE_ADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes(email.toLowerCase());
}

function roleForEmail(email: string, existingRole?: string): Role {
  if (isSuperadminEmail(email)) return 'superadmin';
  if (isAdminEmail(email)) return 'admin';
  return (existingRole as Role) || 'user';
}

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

function highestRole(roles: (string | undefined)[]): string | undefined {
  const valid = roles.filter((r): r is string => !!r && ROLE_RANK[r] !== undefined);
  if (valid.length === 0) return undefined;
  return valid.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
}

async function getOrCreateProfile(firebaseUser: FirebaseUser): Promise<Profile> {
  const profileRef = doc(db!, 'profiles', firebaseUser.uid);
  const profileSnap = await getDoc(profileRef);
  const email = (firebaseUser.email || '').toLowerCase();

  // Find any pre-reg / duplicate docs by email (case-insensitive)
  const allProfilesSnap = await getDocs(collection(db!, 'profiles'));
  const dupes = allProfilesSnap.docs.filter((d) => {
    if (d.id === firebaseUser.uid) return false;
    return (d.data().email || '').toLowerCase() === email;
  });

  // ─── Existing UID profile path ───────────────────────────────────────
  if (profileSnap.exists()) {
    const data = profileSnap.data();
    const updates: Record<string, unknown> = {};

    // Apply highest role from env whitelist OR from any pre-reg dupe (whichever is higher)
    const envRole = isSuperadminEmail(email) ? 'superadmin' : isAdminEmail(email) ? 'admin' : null;
    const candidateRoles = [data.role, envRole, ...dupes.map((d) => d.data().role)];
    const newRole = highestRole(candidateRoles);
    if (newRole && newRole !== data.role && (ROLE_RANK[newRole] ?? 0) > (ROLE_RANK[data.role] ?? 0)) {
      updates.role = newRole;
    }

    // Sync Google photo if current is placeholder
    if (firebaseUser.photoURL && (!data.photoURL || data.photoURL.includes('ui-avatars.com'))) {
      updates.photoURL = firebaseUser.photoURL;
    }

    // Sync Google name if current looks generated/placeholder
    if (firebaseUser.displayName && firebaseUser.displayName !== data.name) {
      const emailPrefix = email.split('@')[0];
      const looksGenerated = !data.name
        || data.name.toLowerCase() === emailPrefix.toLowerCase()
        || data.name.toLowerCase() === emailPrefix.replace(/[._-]+/g, ' ').toLowerCase()
        // Also overwrite if current name matches a dupe's name (means it was set by a pre-reg)
        || dupes.some((d) => (d.data().name || '').toLowerCase() === data.name.toLowerCase());
      if (looksGenerated) {
        updates.name = firebaseUser.displayName;
      }
    }

    if (Object.keys(updates).length > 0) {
      await setDoc(profileRef, updates, { merge: true });
    }
    // Delete dupes
    for (const d of dupes) {
      await deleteDoc(doc(db!, 'profiles', d.id));
    }
    return { id: profileSnap.id, ...data, ...updates } as Profile;
  }

  // ─── First-time sign-in path ─────────────────────────────────────────
  // Deny access if the user is NOT pre-registered and NOT in an env whitelist.
  // This prevents random Google accounts from joining without invitation.
  const isWhitelisted = isSuperadminEmail(email) || isAdminEmail(email);
  if (dupes.length === 0 && !isWhitelisted) {
    const err: Error & { code?: string } = new Error('not-invited');
    err.code = 'not-invited';
    throw err;
  }

  // Inherit role from highest pre-reg dupe (or env), prefer Google name/photo
  const dupeRole = highestRole(dupes.map((d) => d.data().role));
  const role = roleForEmail(email, dupeRole);

  const fallbackName = email.split('@')[0].split(/[._-]/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || email;
  const displayName = firebaseUser.displayName || fallbackName;
  const photoURL = firebaseUser.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`;

  const newProfile = {
    name: displayName,
    email,
    photoURL,
    role,
    createdAt: serverTimestamp(),
  };
  await setDoc(profileRef, newProfile);

  // Clean up dupes
  for (const d of dupes) {
    await deleteDoc(doc(db!, 'profiles', d.id));
  }

  return { id: firebaseUser.uid, ...newProfile, createdAt: undefined } as unknown as Profile;

  // Brand new user — create fresh profile
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const profile = await getOrCreateProfile(firebaseUser);
          setUser(profile);
          setAuthError(null);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'not-invited') {
            const attemptedEmail = firebaseUser.email || 'your account';
            await signOut(auth);
            setUser(null);
            setAuthError(`Access denied. ${attemptedEmail} has not been invited to this portal. Contact your administrator to request access.`);
            setLoading(false);
            return;
          }
          console.warn('Firestore profile fetch failed, using Firebase user data:', err);
          const displayName = firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User';
          setUser({
            id: firebaseUser.uid,
            name: displayName,
            email: firebaseUser.email || '',
            photoURL:
              firebaseUser.photoURL ||
              `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`,
            role: roleForEmail(firebaseUser.email || ''),
          });
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const logout = async () => {
    await signOut(auth);
    setUser(null);
    setAuthError(null);
  };

  const clearAuthError = () => setAuthError(null);

  return (
    <AuthContext.Provider value={{ user, loading, logout, authError, clearAuthError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
