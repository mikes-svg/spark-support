import { useState, createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import { onAuthStateChanged, signInWithCustomToken, signOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../lib/firebase';

/**
 * Single sign-on via the Spark badge: if the user already signed in at the hub,
 * call OUR OWN same-origin /api/sso — it reads the shared badge cookie, verifies
 * it, and mints a token for THIS project (spark-support). Signing in with it
 * means the client is authenticated to Support's own Firestore, so the real role
 * (profiles/, e.g. superadmin) reads correctly. (Using the hub's spark-auth
 * token instead would be cross-project and get every read denied → role "user".)
 * Only runs when central auth is on. Returns true if it signed the user in
 * (onAuthStateChanged then fires with the user).
 */
async function trySparkSSO(): Promise<boolean> {
  if (import.meta.env.VITE_USE_CENTRAL_AUTH !== 'true' || !auth) return false;
  // Retry a few times: the badge cookie can lag on first load and /api/sso may
  // cold-start, so one attempt isn't enough — otherwise we'd flash the login screen.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('/api/sso', { credentials: 'include' });
      if (res.ok) {
        const { token } = await res.json();
        if (token) {
          await signInWithCustomToken(auth, token);
          return true;
        }
      }
    } catch {
      /* retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}
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
  const ssoTried = useRef(false);

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
        // Not signed in here — try single sign-on via the Spark badge (once).
        if (!ssoTried.current) {
          ssoTried.current = true;
          const ok = await trySparkSSO();
          if (ok) return; // onAuthStateChanged will fire again with the signed-in user
        }
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
