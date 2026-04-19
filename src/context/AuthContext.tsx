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

/**
 * Find any email-slug duplicate profiles (pre-reg docs from admin invites) and
 * delete them, since the canonical profile is keyed by Firebase UID.
 */
async function cleanupDuplicateProfiles(uid: string, lowerEmail: string) {
  if (!lowerEmail || !db) return;
  const all = await getDocs(collection(db, 'profiles'));
  const dupes = all.docs.filter((d) => {
    if (d.id === uid) return false;
    return (d.data().email || '').toLowerCase() === lowerEmail;
  });
  for (const d of dupes) {
    await deleteDoc(doc(db!, 'profiles', d.id));
  }
}

async function getOrCreateProfile(firebaseUser: FirebaseUser): Promise<Profile> {
  const profileRef = doc(db!, 'profiles', firebaseUser.uid);
  const profileSnap = await getDoc(profileRef);
  const email = (firebaseUser.email || '').toLowerCase();

  // Always check for and clean up duplicate email-keyed profiles, even if a UID
  // profile already exists. Handles the case where an admin re-invites a user
  // who has already signed in with Google.
  await cleanupDuplicateProfiles(firebaseUser.uid, email);

  if (profileSnap.exists()) {
    const data = profileSnap.data();
    const updates: Record<string, unknown> = {};

    // Promote to superadmin/admin if email is in env whitelist but stored role is lower
    const envRole = isSuperadminEmail(email) ? 'superadmin' : isAdminEmail(email) ? 'admin' : null;
    if (envRole && data.role !== envRole && (envRole === 'superadmin' || data.role === 'user' || !data.role)) {
      updates.role = envRole;
    }

    // Sync Google photo: replace auto-generated ui-avatars with real Google photo
    const hasGooglePhoto = !!firebaseUser.photoURL;
    const hasPlaceholder = !data.photoURL || data.photoURL.includes('ui-avatars.com');
    if (hasGooglePhoto && hasPlaceholder) {
      updates.photoURL = firebaseUser.photoURL;
    }

    if (Object.keys(updates).length > 0) {
      await setDoc(profileRef, updates, { merge: true });
      return { id: profileSnap.id, ...data, ...updates } as Profile;
    }
    return { id: profileSnap.id, ...data } as Profile;
  }

  // First-time sign-in: check for a pre-registered profile to inherit role from
  const allProfilesSnap = await getDocs(collection(db!, 'profiles'));
  const preRegDocs = allProfilesSnap.docs.filter((d) => {
    const docEmail = (d.data().email || '').toLowerCase();
    return docEmail === email && d.id !== firebaseUser.uid;
  });

  if (preRegDocs.length > 0) {
    const preRegDoc = preRegDocs[0];
    const data = preRegDoc.data();
    const role = roleForEmail(email, data.role);
    const migratedProfile = {
      ...data,
      name: firebaseUser.displayName || data.name,
      photoURL: firebaseUser.photoURL || data.photoURL,
      email,
      role,
      createdAt: serverTimestamp(),
    };
    await setDoc(profileRef, migratedProfile);
    for (const d of preRegDocs) {
      await deleteDoc(doc(db!, 'profiles', d.id));
    }
    return { id: firebaseUser.uid, ...migratedProfile } as unknown as Profile;
  }

  // Brand new user — create fresh profile
  const displayName = firebaseUser.displayName || email.split('@')[0] || 'User';
  const newProfile = {
    name: displayName,
    email,
    photoURL:
      firebaseUser.photoURL ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`,
    role: roleForEmail(email),
    createdAt: serverTimestamp(),
  };

  await setDoc(profileRef, newProfile);
  return { id: firebaseUser.uid, ...newProfile, createdAt: undefined } as unknown as Profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const profile = await getOrCreateProfile(firebaseUser);
          setUser(profile);
        } catch (err) {
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
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout }}>
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
