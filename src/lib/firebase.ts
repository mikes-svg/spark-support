import { initializeApp, FirebaseApp } from 'firebase/app';
import { Auth, getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import { Firestore, getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { FirebaseStorage, getStorage, connectStorageEmulator } from 'firebase/storage';
import { Functions, getFunctions, connectFunctionsEmulator } from 'firebase/functions';

// ── DATA project (this portal's own Firestore + Storage) ───────────────
// Unchanged: Support's tickets, profiles, files all stay in its own project.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Sign-in always happens on the data project (see the auth block below); when
// VITE_USE_CENTRAL_AUTH is set, the Google fallback is restricted to company
// accounts. SSO itself is delivered via /api/sso, not a separate auth project.
const USE_CENTRAL_AUTH = import.meta.env.VITE_USE_CENTRAL_AUTH === 'true';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;
let functions: Functions | null = null;
let googleProvider: GoogleAuthProvider | null = null;

// Data app — Firestore + Storage live here, exactly as before.
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  storage = getStorage(app);
  // Cloud Functions (prod: server-side ticket mail lives here). googleProvider
  // and auth are set up below in the auth block so SSO keeps auth on the data
  // project — do NOT initialize googleProvider here.
  functions = getFunctions(app, 'us-central1');
} catch (e) {
  console.warn('Data Firebase project not configured — Firestore/Storage disabled.');
}

// Auth — ALWAYS the data project (spark-support), so tokens are valid for this
// portal's own Firestore (profiles/tickets). Single sign-on is delivered by our
// own /api/sso endpoint, which verifies the shared Spark badge and mints a
// data-project custom token — NOT a spark-auth token. (A spark-auth token would
// be cross-project and rejected by this project's Firestore, dropping every user
// to role "user". See api/sso.js.) Google login stays on the data project too,
// so the tool keeps its own independent login if central is ever down.
try {
  googleProvider = new GoogleAuthProvider();
  if (app) {
    auth = getAuth(app);
    if (USE_CENTRAL_AUTH) {
      // Restrict the Google-login fallback to company accounts.
      googleProvider.setCustomParameters({ hd: 'sparkmanage.com' });
    }
  }
} catch (e) {
  console.warn('Auth not configured — running in mock/dev mode');
}

/**
 * Local Firebase Emulator Suite, for walking the app against seeded data
 * without touching the real project.
 *
 * Gated on `import.meta.env.DEV`, which Vite statically replaces with `false`
 * in any production build — so this entire block is eliminated from the shipped
 * bundle and NO environment variable can switch it on in production. It reaches
 * the dev server only via `npx vite --mode emulator` (see .env.emulator), and
 * that file's Firebase config is deliberately fake, so a half-applied flag
 * fails loudly instead of silently reaching prod.
 *
 * Each connect* call is idempotent per SDK instance but throws if the service
 * has already issued a request, so this runs immediately after init and is
 * wrapped defensively — a failure here must not take the app down.
 */
const USE_EMULATORS = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';

if (USE_EMULATORS) {
  try {
    if (auth) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    if (db) connectFirestoreEmulator(db, '127.0.0.1', 8080);
    if (storage) connectStorageEmulator(storage, '127.0.0.1', 9199);
    if (functions) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    console.info('[emulator] Firebase pointed at local emulators — no production data is reachable.');
  } catch (e) {
    console.error('[emulator] Failed to connect to the Firebase emulators:', e);
  }
}

export { auth, db, storage, functions, googleProvider };
