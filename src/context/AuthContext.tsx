import { useState, createContext, useContext, useEffect, ReactNode } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../lib/firebase';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const authInstance = auth;
    if (!authInstance || !functions) { setLoading(false); return; }

    // Role is assigned server-side: the client no longer reads any allowlist or
    // writes its own role. On sign-in we ask the `ensureProfile` Cloud Function
    // to create/heal the profile and tell us who we are.
    const ensureProfile = httpsCallable<void, Profile>(functions, 'ensureProfile');

    const unsubscribe = onAuthStateChanged(authInstance, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const res = await ensureProfile();
          setUser(res.data as Profile);
          setAuthError(null);
        } catch (err) {
          const code = String((err as { code?: string }).code || '');
          const message = String((err as { message?: string }).message || '');
          if (code.includes('permission-denied') || message.includes('not-invited')) {
            const attemptedEmail = firebaseUser.email || 'your account';
            await signOut(authInstance);
            setUser(null);
            setAuthError(`Access denied. ${attemptedEmail} has not been invited to this portal. Contact your administrator to request access.`);
            setLoading(false);
            return;
          }
          // Transient/unknown failure: sign out rather than leave a broken,
          // role-less session. The user can retry.
          console.error('Sign-in could not be completed:', err);
          await signOut(authInstance);
          setUser(null);
          setAuthError('We could not complete sign-in. Please try again.');
          setLoading(false);
          return;
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const logout = async () => {
    if (auth) await signOut(auth);
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
