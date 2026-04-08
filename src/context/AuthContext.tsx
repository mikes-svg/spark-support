import React, { useState, createContext, useContext, useEffect, ReactNode } from 'react';
import {
  onAuthStateChanged,
  signOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

// Set to true to bypass Firebase auth during development
const DEV_MOCK_AUTH = false;
const DEV_MOCK_USER: Profile = {
  id: 'dev-user',
  name: 'Dev Admin',
  email: 'dev@standifercapital.com',
  photoURL: 'https://ui-avatars.com/api/?name=Dev+Admin&background=1B4332&color=D4A843',
  role: 'admin',
};

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

async function getOrCreateProfile(firebaseUser: FirebaseUser): Promise<Profile> {
  const profileRef = doc(db, 'profiles', firebaseUser.uid);
  const profileSnap = await getDoc(profileRef);

  if (profileSnap.exists()) {
    return { id: profileSnap.id, ...profileSnap.data() } as Profile;
  }

  const displayName = firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User';
  const newProfile = {
    name: displayName,
    email: firebaseUser.email || '',
    photoURL:
      firebaseUser.photoURL ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1B4332&color=D4A843`,
    role: 'user' as const,
    createdAt: serverTimestamp(),
  };

  await setDoc(profileRef, newProfile);
  return { id: firebaseUser.uid, ...newProfile, createdAt: undefined } as unknown as Profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(DEV_MOCK_AUTH ? DEV_MOCK_USER : null);
  const [loading, setLoading] = useState(!DEV_MOCK_AUTH);

  useEffect(() => {
    if (DEV_MOCK_AUTH) return;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const profile = await getOrCreateProfile(firebaseUser);
          setUser(profile);
        } catch (err) {
          console.warn('Firestore profile fetch failed, using Firebase user data:', err);
          // Fallback: build profile directly from Firebase Auth user
          const displayName = firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User';
          const adminEmails = (import.meta.env.VITE_ADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase());
          const isAdmin = adminEmails.length > 0 && adminEmails.includes((firebaseUser.email || '').toLowerCase());
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
    if (DEV_MOCK_AUTH) return;
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
