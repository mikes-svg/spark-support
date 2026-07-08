/**
 * GET /api/my-role — the caller's Support role, read live from Support's OWN
 * data (`profiles`) via the Spark badge. The hub calls this to show the right
 * tile — no role copied centrally. Returns { role: "superadmin"|"admin"|"user"|null }.
 * Env: SPARK_AUTH_* (verify badge) + FIREBASE_SERVICE_ACCOUNT_JSON (Support project).
 */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const SPARK_COOKIE = '__spark_session';

function appFor(name, cred) {
  return getApps().find((a) => a.name === name) ?? initializeApp({ credential: cert(cred) }, name);
}
function sparkAuth() {
  return getAuth(appFor('spark-auth', {
    projectId: process.env.SPARK_AUTH_PROJECT_ID,
    clientEmail: process.env.SPARK_AUTH_CLIENT_EMAIL,
    privateKey: process.env.SPARK_AUTH_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }));
}
function dataDb() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  return getFirestore(appFor('support-data', {
    projectId: sa.project_id, clientEmail: sa.client_email,
    privateKey: String(sa.private_key || '').replace(/\\n/g, '\n'),
  }));
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const value = readCookie(req, SPARK_COOKIE);
  if (!value) return res.status(200).json({ role: null });
  try {
    const decoded = await sparkAuth().verifySessionCookie(value, true);
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(200).json({ role: null });
    const snap = await dataDb().collection('profiles').get();
    const doc = snap.docs.find((d) => String(d.data().email || '').toLowerCase() === email);
    return res.status(200).json({ role: doc ? (doc.data().role || null) : null });
  } catch {
    return res.status(200).json({ role: null });
  }
}
