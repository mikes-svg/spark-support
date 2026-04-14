import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion } from 'framer-motion';

export function LoginPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [error, setError] = useState('');
  const [ssoLoading, setSsoLoading] = useState(false);

  // Redirect when auth state resolves after login
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const handleGoogleSSO = async () => {
    if (!auth || !googleProvider) return;
    setSsoLoading(true);
    setError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        setError('Google sign-in failed. Please try again.');
      }
    } finally {
      setSsoLoading(false);
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
            <img src="/spark-logo.png" alt="Spark Management" className="mx-auto h-20 mb-4" />
            <p className="text-xs uppercase tracking-[0.2em] text-gray-500 font-semibold">
              Support Portal
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
        </div>
      </motion.div>
    </div>
  );
}
