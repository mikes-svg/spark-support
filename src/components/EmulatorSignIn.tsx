import { useEffect, useState } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { auth } from '../lib/firebase';

/**
 * A one-click account picker for local emulator runs.
 *
 * Gated on `import.meta.env.DEV`, which Vite replaces with a literal false in
 * any production build, so this component and its import are stripped from the
 * shipped bundle entirely. It also only renders when VITE_USE_EMULATORS is on,
 * which only .env.emulator sets.
 *
 * Why this exists rather than the real Google button: the Auth emulator's
 * sign-in widget finishes by calling back through the popup's opener frame.
 * Any browser that reuses the tab — or blocks the popup — drops that frame and
 * the widget dies with "Internal Error: No matching frame", and the redirect
 * fallback loses the pending-redirect state across the 9099 → 5176 origin hop.
 * Neither is a bug in the app; both make the emulator unusable for a walkthrough.
 *
 * The emulator accepts UNSIGNED custom tokens (alg "none"), so a uid is enough
 * to mint one client-side. A real Firebase project rejects these outright —
 * there is no private key here and nothing to leak.
 */

interface DevUser { id: string; name: string; role: string }

function unsignedCustomToken(uid: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({
      uid,
      iat: now,
      exp: now + 3600,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iss: 'firebase-auth-emulator@example.com',
      sub: 'firebase-auth-emulator@example.com',
    }),
    '',
  ].join('.');
}

export function EmulatorSignIn() {
  const [people, setPeople] = useState<DevUser[]>([]);
  const [error, setError] = useState('');

  // Read the seeded accounts straight off the Auth emulator so this list can
  // never drift from what scripts/seed-emulator.js actually created.
  useEffect(() => {
    // The :query endpoint, not /emulator/v1/.../accounts — that path only
    // accepts DELETE (clear all users) and answers GET with a 405.
    fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/spark-support-28ed9/accounts:query', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((r) => r.json())
      .then((d) =>
        setPeople(
          (d.userInfo || []).map((u: { localId: string; displayName?: string; email?: string }) => ({
            id: u.localId,
            name: u.displayName || u.email || u.localId,
            role: u.localId === 'u-mike' ? 'superadmin' : '',
          })),
        ),
      )
      .catch(() => setError('Auth emulator not reachable on :9099 — is `npm run emulators` running?'));
  }, []);

  const signIn = async (uid: string) => {
    if (!auth) return;
    setError('');
    try {
      await signInWithCustomToken(auth, unsignedCustomToken(uid));
    } catch (e) {
      setError('Sign-in failed: ' + String((e as { code?: string }).code || e));
    }
  };

  return (
    <div className="mt-6 border-t border-dashed border-amber-400 pt-4">
      <p className="text-[11px] uppercase tracking-widest text-amber-700 font-semibold mb-2">
        Emulator mode — seeded accounts
      </p>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      <div className="space-y-1">
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id)}
            className="w-full text-left text-sm px-3 py-2 rounded-md border border-gray-200 hover:bg-amber-50 hover:border-amber-300 transition-colors min-h-[44px]"
          >
            {p.name}
            {p.role && <span className="ml-2 text-xs text-amber-700">{p.role}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
