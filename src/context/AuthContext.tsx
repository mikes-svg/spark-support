import React, { useState, createContext, useContext, useEffect, ReactNode } from 'react';
import {
  onAuthStateChanged,
  signOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

export interface Profile {
  id: string;
  name: string;
  email: string;
  photoURL: string;
  role: 'admin' | 'user';
}

interface AuthContextType {
  user: Profile | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isAdminEmail(email: string): boolean {
  const adminEmails = (import.meta.env.VITE_ADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase());
  return adminEmails.length > 0 && adminEmails.includes(email.toLowerCase());
}

async function getOrCreateProfile(firebaseUser: FirebaseUser): Promise<Profile> {
  const profileRef = doc(db!, 'profiles', firebaseUser.uid);
  const profileSnap = await getDoc(profileRef);
  const email = firebaseUser.email || '';

  if (profileSnap.exists()) {
    const data = profileSnap.data();
    // Promote to admin if in VITE_ADMIN_EMAILS but stored as user
    if (data.role !== 'admin' && isAdminEmail(email)) {
      await setDoc(profileRef, { role: 'admin' }, { merge: true });
      return { id: profileSnap.id, ...data, role: 'admin' } as Profile;
    }
    return { id: profileSnap.id, ...data } as Profile;
  }

  // Check if admin pre-registered this user by email (profile keyed by email slug)
  const preRegQuery = query(collection(db!, 'profiles'), where('email', '==', email));
  const preRegSnap = await getDocs(preRegQuery);
  if (!preRegSnap.empty) {
    const preRegDoc = preRegSnap.docs[0];
    const data = preRegDoc.data();
    // Migrate pre-registered profile to real UID
    const role = isAdminEmail(email) ? 'admin' : (data.role || 'user');
    const migratedProfile = { ...data, role, createdAt: serverTimestamp() };
    await setDoc(profileRef, migratedProfile);
    // Remove the old email-keyed doc
    if (preRegDoc.id !== firebaseUser.uid) {
      await deleteDoc(doc(db!, 'profiles', preRegDoc.id));
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
    role: isAdminEmail(email) ? ('admin' as const) : ('user' as const),
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
          const isAdmin = isAdminEmail(firebaseUser.email || '');
          setUser({
            id: firebaseUser.uid,
            name: displayName,
            email: firebaseUser.email || '',
            photoURL:
              firebaseUser.photoURL ||
              `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`,
            role: isAdmin ? 'admin' : 'user',
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
