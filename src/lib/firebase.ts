import { initializeApp, FirebaseApp } from 'firebase/app';
import { Auth, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { FirebaseStorage, getStorage } from 'firebase/storage';
import { Functions, getFunctions } from 'firebase/functions';

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

export { auth, db, storage, functions, googleProvider };
