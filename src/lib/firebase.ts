import { initializeApp, FirebaseApp } from 'firebase/app';
import { Auth, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { FirebaseStorage, getStorage } from 'firebase/storage';

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

// ── CENTRAL LOGIN project ("spark-auth") ───────────────────────────────
// The shared "security desk". When VITE_USE_CENTRAL_AUTH === 'true', sign-in
// happens here instead of in the data project — the first step toward one
// login across all Spark portals. Public values, safe to commit.
const SPARK_AUTH_CONFIG = {
  apiKey: 'AIzaSyDD172ed3HWIsH3PFBqThFJ7WGvhA9dAhc',
  authDomain: 'spark-auth-fccb2.firebaseapp.com',
  projectId: 'spark-auth-fccb2',
  storageBucket: 'spark-auth-fccb2.firebasestorage.app',
  messagingSenderId: '898172856452',
  appId: '1:898172856452:web:161d605209390ef6e7bad1',
};

const USE_CENTRAL_AUTH = import.meta.env.VITE_USE_CENTRAL_AUTH === 'true';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;
let googleProvider: GoogleAuthProvider | null = null;

// Data app — Firestore + Storage live here, exactly as before.
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  storage = getStorage(app);
} catch (e) {
  console.warn('Data Firebase project not configured — Firestore/Storage disabled.');
}

// Auth — handled independently so login works even if the data project config
// is missing (useful for local testing of the central login on its own).
try {
  googleProvider = new GoogleAuthProvider();
  if (USE_CENTRAL_AUTH) {
    // Authentication comes from the shared spark-auth project (separate app
    // instance so it doesn't disturb the data app). Restrict to company accounts.
    const authApp = initializeApp(SPARK_AUTH_CONFIG, 'spark-auth');
    auth = getAuth(authApp);
    googleProvider.setCustomParameters({ hd: 'sparkmanage.com' });
  } else if (app) {
    // Legacy path — login still happens in the data project (unchanged).
    auth = getAuth(app);
  }
} catch (e) {
  console.warn('Auth not configured — running in mock/dev mode');
}

export { auth, db, storage, googleProvider };
