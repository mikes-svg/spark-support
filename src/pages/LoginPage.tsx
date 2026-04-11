import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { motion } from 'framer-motion';

const ALLOWED_DOMAINS = ['standifercapital.com', 'sparkmanage.com'];

function isAllowedDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return ALLOWED_DOMAINS.includes(domain);
}

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);

  const handleGoogleSSO = async () => {
    if (!auth || !googleProvider) return;
    setSsoLoading(true);
    setError('');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const userEmail = result.user.email || '';
      if (!isAllowedDomain(userEmail)) {
        await auth.signOut();
        setError('Access restricted to @standifercapital.com and @sparkmanage.com accounts.');
        return;
      }
      navigate('/');
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        setError('Google sign-in failed. Please try again.');
      }
    } finally {
      setSsoLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    if (!isAllowedDomain(email.trim())) {
      setError('Access restricted to @standifercapital.com and @sparkmanage.com accounts.');
      return;
    }
    setLoading(true);
    setError('');
    // Firebase requires 6+ char passwords; pad internally so users can type "Spark"
    const firebasePassword = password.trim() + '!!';
    try {
      await signInWithEmailAndPassword(auth!, email.trim(), firebasePassword);
      navigate('/');
    } catch {
      // Account may not exist yet — auto-create for allowed domains
      try {
        await createUserWithEmailAndPassword(auth!, email.trim(), firebasePassword);
        navigate('/');
      } catch (createErr: unknown) {
        const code = (createErr as { code?: string }).code;
        if (code === 'auth/email-already-in-use') {
          setError('Invalid password.');
        } else {
          setError('Sign in failed. Please try again.');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-cream flex flex-col justify-center py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-64 bg-brand-dark rounded-b-[100px] opacity-10" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="sm:mx-auto sm:w-full sm:max-w-md relative z-10"
      >
        <div className="bg-white py-10 px-4 shadow-xl shadow-gray-200/50 sm:rounded-2xl sm:px-10 border border-gray-100">
          <div className="text-center mb-8">
            <div className="mx-auto h-12 w-12 text-brand-gold mb-4">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <h2 className="text-3xl font-serif font-bold text-gray-900 tracking-tight">Spark Support</h2>
            <p className="mt-2 text-xs uppercase tracking-[0.2em] text-gray-500 font-semibold">
              Standifer Capital · Internal Portal
            </p>
          </div>

          <div className="w-16 h-0.5 bg-brand-gold mx-auto mb-8" />

          {error && (
            <p className="text-sm text-red-600 text-center bg-red-50 py-2 px-3 rounded-md mb-4">
              {error}
            </p>
          )}

          {/* Google SSO */}
          <button
            onClick={handleGoogleSSO}
            disabled={ssoLoading}
            className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50"
          >
            {ssoLoading ? (
              <div className="h-5 w-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            Sign in with Google
          </button>

          {/* TODO: Remove password fallback at launch */}
          {!showPasswordLogin ? (
            <button
              onClick={() => setShowPasswordLogin(true)}
              className="mt-4 w-full text-center text-xs text-gray-300 hover:text-gray-400 transition-colors"
            >
              Use password
            </button>
          ) : (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="px-3 bg-white text-gray-400 uppercase tracking-wider">password login</span>
                </div>
              </div>
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark focus:border-transparent"
                    placeholder="you@standifercapital.com"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark focus:border-transparent"
                    placeholder="Enter password"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !email || !password}
                  className="w-full flex justify-center py-3 px-4 rounded-lg shadow-sm bg-brand-dark text-sm font-medium text-white hover:bg-brand-dark/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-dark transition-colors disabled:opacity-50"
                >
                  {loading ? 'Signing in…' : 'Sign In'}
                </button>
              </form>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
