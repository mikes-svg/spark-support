/**
 * GET /api/sso — single sign-on for Support.
 *
 * Turns the shared "Spark badge" (the __spark_session cookie set by Spark Central
 * on .sparkmanage.com) into a Support login — so someone who already signed in at
 * the hub doesn't log in again.
 *
 * WHY this exists (and why Support does NOT use the hub's spark-auth token):
 * Support's roles + data (profiles, tickets) live in its OWN Firebase project
 * (spark-support-28ed9). A token minted for the shared spark-auth project is NOT
 * valid for Support's Firestore (cross-project) — every read is denied, so the
 * user's real role (e.g. superadmin, stored in profiles/) can't be read and they
 * fall back to "user". Fix: verify the badge against spark-auth, then mint a
 * token for SUPPORT'S OWN project. The client signs in with it → it's a valid
 * same-project token → profiles/roles/tickets all read normally, straight from
 * Support's own data ("extract from the website").
 *
 * Env: SPARK_AUTH_* (verify the badge) + FIREBASE_SERVICE_ACCOUNT_JSON (Support's
 * own service account for spark-support-28ed9). Google login is unchanged.
 */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const SPARK_COOKIE = '__spark_session';

function appFor(name, credential) {
  return (
    getApps().find((a) => a.name === name) ??
    initializeApp({ credential: cert(credential) }, name)
  );
}

/** spark-auth admin (verifies the badge). */
function sparkAuth() {
  return getAuth(
    appFor('spark-auth', {
      projectId: process.env.SPARK_AUTH_PROJECT_ID,
      clientEmail: process.env.SPARK_AUTH_CLIENT_EMAIL,
      privateKey: process.env.SPARK_AUTH_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  );
}

/** Support's OWN project admin (mints the token for spark-support-28ed9). */
function supportAuth() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  return getAuth(
    appFor('support-data', {
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    })
  );
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const value = readCookie(req, SPARK_COOKIE);
  if (!value) return res.status(401).json({ error: 'no-badge' });

  try {
    const decoded = await sparkAuth().verifySessionCookie(value, true);
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(401).json({ error: 'no-email' });

    // Look up (or provision) the Support user for this email so the minted token
    // carries a uid that lines up with their existing profiles/ doc — that's
    // where their real role (superadmin/admin/user) lives. If they have no
    // Support auth user yet, create one; the client's getOrCreateProfile then
    // matches their profile by email and migrates it to this uid.
    const sa = supportAuth();
    let userRecord;
    try {
      userRecord = await sa.getUserByEmail(email);
    } catch {
      userRecord = await sa.createUser({ email, emailVerified: true });
    }

    const token = await sa.createCustomToken(userRecord.uid);
    return res.status(200).json({ token });
  } catch (err) {
    console.error('sso error:', err.message);
    return res.status(401).json({ error: 'invalid-badge' });
  }
}
