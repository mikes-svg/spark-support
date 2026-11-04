/**
 * Department routing, server side.
 *
 * A ticket routed to a department is visible to its members through the
 * ticket's participants[] (that is what firestore.rules and the My Tickets
 * query read), which the client denormalises at routing time. Membership
 * changes afterwards would leave that list stale — a new hire would not see
 * the department's open tickets, someone who moved teams would keep seeing
 * them — so this trigger rebuilds participants on every ticket of a department
 * whose membership changed, and clears the routing when a department is
 * deleted so nothing points at a document that no longer exists.
 *
 * Writes go through chunked batches under Firestore's 500-write cap, the same
 * pattern as reassign.js, since a busy department can have many tickets.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
// The MODULAR FieldValue: under the Functions emulator the namespaced
// admin.firestore is wrapped and loses FieldValue (see shared.js callers).
const { FieldValue } = require('firebase-admin/firestore');
const { db, REGION, ticketParticipants } = require('./shared');

const BATCH_LIMIT = 400;

function sameMembers(a, b) {
  const x = [...new Set((a || []).filter(Boolean))].sort();
  const y = [...new Set((b || []).filter(Boolean))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Rewrite every ticket routed to `departmentId`. `memberIds` null means the
 * department is gone: the routing is cleared and participants shrink back to
 * submitter + assignees.
 */
async function resyncTickets(departmentId, memberIds) {
  const snap = await db.collection('tickets').where('departmentId', '==', departmentId).get();
  let batch = db.batch();
  let pending = 0;
  let touched = 0;
  for (const ticketDoc of snap.docs) {
    const ticket = ticketDoc.data();
    const participants = ticketParticipants(ticket, memberIds || []);
    const patch = { participants, updatedAt: FieldValue.serverTimestamp() };
    if (memberIds === null) patch.departmentId = null;
    else if (sameMembers(participants, ticket.participants)) continue;
    batch.update(ticketDoc.ref, patch);
    touched++;
    if (++pending >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending) await batch.commit();
  return { total: snap.size, touched };
}

exports.onDepartmentWritten = onDocumentWritten(
  { document: 'departments/{departmentId}', region: REGION },
  async (event) => {
    const departmentId = event.params.departmentId;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    try {
      if (!after) {
        const r = await resyncTickets(departmentId, null);
        logger.info(`Department ${departmentId} deleted: cleared routing on ${r.touched} ticket(s)`);
        return;
      }
      // A rename or a brand-new department changes nothing about who can see
      // what; only membership does.
      if (before && sameMembers(before.memberIds, after.memberIds)) return;
      const r = await resyncTickets(departmentId, (after.memberIds || []).filter(Boolean));
      logger.info(`Department ${departmentId} membership changed: resynced ${r.touched} of ${r.total} ticket(s)`);
    } catch (err) {
      logger.error(`Department resync failed for ${departmentId}`, err);
    }
  }
);
