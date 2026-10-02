/**
 * Profile lifecycle and ticket-attachment access.
 *
 * - ensureProfile: called by the client on sign-in. Creates or self-heals the
 *   caller's profile with a SERVER-decided role, so an authenticated user can't
 *   elevate themselves.
 * - getTicketAttachments: the only read path for ticket files, since Storage
 *   rules deny direct client reads and listing.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
// `admin` comes from shared.js rather than firebase-admin directly, so there is
// visibly one initializeApp() in the codebase and no module can load an
// uninitialised SDK by requiring itself first.
const { admin, db, REGION } = require('./shared');

// ─── Role assignment (server-authoritative) ──────────────────────────────────
// Roles are decided HERE, never by the client, so an authenticated user can't
// elevate their own profile. The allowlist lives in this function's environment
// (SUPERADMIN_EMAILS / ADMIN_EMAILS, comma-separated) — set via functions config,
// NOT in the shipped client bundle.

const ROLE_RANK = { user: 0, admin: 1, superadmin: 2 };

function highestRole(roles) {
  let best = 'user';
  for (const r of roles) {
    const norm = typeof r === 'string' ? r.toLowerCase() : r;
    if (ROLE_RANK[norm] !== undefined && ROLE_RANK[norm] > ROLE_RANK[best]) best = norm;
  }
  return best;
}

function envEmails(name) {
  return (process.env[name] || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function allowlistRole(email) {
  if (envEmails('SUPERADMIN_EMAILS').includes(email)) return 'superadmin';
  if (envEmails('ADMIN_EMAILS').includes(email)) return 'admin';
  return 'user';
}

function nameFromEmail(email) {
  return (
    email.split('@')[0].split(/[._-]/).filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || email
  );
}

/**
 * Called by the client on sign-in. Creates or self-heals the caller's profile
 * with a SERVER-decided role (env allowlist or the highest pre-registration
 * invite), migrates/cleans any pre-reg email-slug duplicates, and returns the
 * profile. Throws `permission-denied` for uninvited, non-allowlisted accounts.
 */
exports.ensureProfile = onCall({ region: REGION }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const uid = auth.uid;
  const token = auth.token || {};
  const email = (token.email || '').toLowerCase();
  if (!email) throw new HttpsError('failed-precondition', 'Account has no email.');

  const profileRef = db.collection('profiles').doc(uid);
  const profileSnap = await profileRef.get();

  // Pre-registration / duplicate docs created by a superadmin under an
  // email-slug id, to be migrated into this UID profile.
  const dupSnap = await db.collection('profiles').where('email', '==', email).get();
  const dupes = dupSnap.docs.filter((d) => d.id !== uid);

  const allow = allowlistRole(email);
  const firstTime = !profileSnap.exists;

  // Gate: a brand-new account that was neither invited (no pre-reg dupe) nor on
  // the allowlist is denied — no profile is created.
  if (firstTime && dupes.length === 0 && allow === 'user') {
    throw new HttpsError('permission-denied', 'not-invited');
  }

  const existing = profileSnap.exists ? profileSnap.data() : {};
  const dupeRoles = dupes.map((d) => d.data().role);
  const role = highestRole([existing.role, allow, ...dupeRoles]);

  // Carried through the same way role is: this write merges over the profile on
  // every sign-in, and the client reads the section's visibility straight off
  // the returned object — drop the flag here and a superadmin's grant (or one
  // made on a pre-registration doc) silently disappears on the next sign-in.
  const onboardingAccess = existing.onboardingAccess === true ||
    dupes.some((d) => d.data().onboardingAccess === true);

  // Carried through for exactly the same reason as onboardingAccess above: this
  // write merges over the profile on every sign-in, so omitting the flag here
  // would silently revoke a superadmin's Tasks grant the next time that person
  // signed in.
  const tasksAccess = existing.tasksAccess === true ||
    dupes.some((d) => d.data().tasksAccess === true);

  const dupeName = dupes.map((d) => d.data().name).find(Boolean);
  // Prefer the already-stored name over the Google token, so a superadmin's
  // Team-page rename sticks instead of being reset to the Google display name
  // on the user's next sign-in. Google's name only seeds a brand-new profile.
  const name = existing.name || token.name || dupeName || nameFromEmail(email);
  const photoURL = token.picture || existing.photoURL ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1B4332&color=D4A843`;

  const data = { name, email, photoURL, role, onboardingAccess, tasksAccess };
  if (firstTime) data.createdAt = admin.firestore.FieldValue.serverTimestamp();
  await profileRef.set(data, { merge: true });

  // Migrate then remove pre-reg duplicates.
  if (dupes.length) {
    const batch = db.batch();
    dupes.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  return { id: uid, name, email, photoURL, role, onboardingAccess, tasksAccess };
});

/**
 * Returns a ticket's attachments (name + tokenized download URL) to callers who
 * are participants or admins of that ticket. Storage rules deny direct client
 * reads/listing, so this is the only read path — closing the enumeration hole
 * where any signed-in user could list/read any ticket's files by path.
 *
 * Uses each file's existing Firebase download token (set by the client SDK on
 * upload) to build the download URL, so no signed-URL/IAM setup is required.
 */
exports.getTicketAttachments = onCall({ region: REGION }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const ticketId = request.data?.ticketId;
  if (!ticketId || typeof ticketId !== 'string') {
    throw new HttpsError('invalid-argument', 'ticketId is required.');
  }

  const ticketSnap = await db.collection('tickets').doc(ticketId).get();
  if (!ticketSnap.exists) throw new HttpsError('not-found', 'Ticket not found.');
  const ticket = ticketSnap.data();

  const profileSnap = await db.collection('profiles').doc(auth.uid).get();
  const role = profileSnap.data()?.role;
  const isAdmin = role === 'admin' || role === 'superadmin';
  const isParticipant = Array.isArray(ticket.participants) && ticket.participants.includes(auth.uid);
  if (!isAdmin && !isParticipant) {
    throw new HttpsError('permission-denied', 'You do not have access to this ticket.');
  }

  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({ prefix: `attachments/${ticketId}/` });
  const attachments = [];
  for (const file of files) {
    const [md] = await file.getMetadata();
    const tokens = md.metadata?.firebaseStorageDownloadTokens;
    if (!tokens) continue; // not client-uploaded / no shareable token
    const token = String(tokens).split(',')[0];
    const encodedPath = encodeURIComponent(file.name);
    attachments.push({
      name: file.name.split('/').pop(),
      url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`,
    });
  }
  return attachments;
});

