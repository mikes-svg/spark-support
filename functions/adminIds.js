/**
 * Keeps `meta/adminIds` holding the uid of every Manager / Administrator.
 *
 * firestore.rules has to answer "does this ticket still have a Manager on it?"
 * on every ticket update. Rules cannot iterate a ticket's assignees and look up
 * each profile's role, so the answer is denormalised into one document the rule
 * reads with a single get(). These functions are its only writers — the rules
 * deny client writes to that document, because anyone who could forge it would
 * grant themselves edit rights over every ticket.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
// The MODULAR FieldValue, not FieldValue: under the Functions
// emulator the namespaced admin.firestore is wrapped and loses FieldValue, so
// the namespaced form throws at runtime while looking correct in source.
const { FieldValue } = require('firebase-admin/firestore');
const { db, REGION } = require('./shared');

const MANAGER_ROLES = ['admin', 'superadmin'];

async function rebuild() {
  const snap = await db.collection('profiles').where('role', 'in', MANAGER_ROLES).get();
  const ids = snap.docs.map((d) => d.id).sort();
  await db.collection('meta').doc('adminIds').set({ ids, updatedAt: FieldValue.serverTimestamp() });
  return ids;
}

const isManager = (data) => !!data && MANAGER_ROLES.includes(data.role);

/**
 * Rebuild whenever a profile's manager-ness could have changed.
 *
 * Profile writes are frequent — ensureProfile merges on every sign-in — while
 * role changes are rare, so this skips the writes that cannot affect the answer
 * rather than rewriting the document a hundred times a day.
 */
exports.syncAdminIds = onDocumentWritten(
  { document: 'profiles/{uid}', region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (isManager(before) === isManager(after) && !!before === !!after) return;
    try {
      const ids = await rebuild();
      logger.info(`meta/adminIds rebuilt: ${ids.length} managers/administrators`);
    } catch (err) {
      logger.error('Failed to rebuild meta/adminIds', err);
    }
  }
);

/**
 * One-shot build for the initial rollout, and a repair hatch afterwards.
 *
 * The trigger above only fires on a role change, so on a project where the
 * document has never existed nothing would create it — and the ticket rule
 * would have nothing to read. Superadmin-only, and idempotent.
 */
exports.backfillAdminIds = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const caller = await db.collection('profiles').doc(request.auth.uid).get();
  if (caller.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Administrators only.');
  }
  const ids = await rebuild();
  logger.info(`meta/adminIds backfilled by ${request.auth.uid}: ${ids.length} entries`);
  return { count: ids.length, ids };
});
