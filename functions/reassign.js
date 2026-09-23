/**
 * Mass reassignment for when someone leaves (Phase 7, docs/CLICKUP_MIGRATION_PLAN.md §9).
 *
 * A SERVER-SIDE callable, superadmin only: `reassignWork({ fromUserId, toUserIds,
 * scope, statuses })`. Everything assigned to `fromUserId` across the requested
 * `scope` moves to `toUserIds` (their assigneeIds array can grow past one name —
 * splitting a departing person's load across several people is the point).
 *
 * `scope` is an array drawn from:
 *   'tasks'            — task.assigneeIds
 *   'waitingOn'        — task.waitingOnUserId (the whole reason person-named
 *                         statuses were retired — see the module doc in
 *                         src/lib/taskStatuses.ts — is so THIS sweep catches
 *                         them instead of a status label silently going stale)
 *   'subtaskAssignees' — task.subtasks[].assigneeIds
 *   'series'            — taskSeries.payload.assigneeIds (so future occurrences
 *                          come out right, not just the ones already minted)
 *   'tickets'           — ticket.assigneeIds / legacy ticket.assigneeId (optional,
 *                          see the NOTE below before relying on it)
 *   'onboarding'        — onboardingTask.responsibleIds (optional)
 * Defaults to the four task-shaped scopes when omitted; tickets/onboarding are
 * opt-in since the plan calls them out as optional and (for tickets, see below)
 * they carry a real caveat.
 *
 * `statuses` filters which task statusTypes count as "still open" (default:
 * todo/active/waiting — i.e. not done/closed, matching "open tasks" in the plan).
 * It has no effect on the tickets/onboarding scopes, which have their own
 * open-work definitions (ticket.status, onboarding row status).
 *
 * Two things this function exists specifically to get right:
 *
 *   1. CHUNKED WRITES. Every write, across every scope, goes through one shared
 *      400-per-batch committer — the BATCH_LIMIT pattern in src/lib/onboarding.ts
 *      — so a sweep touching hundreds of docs can't exceed Firestore's 500-write
 *      cap no matter how the items are distributed across scopes.
 *   2. ONE SUMMARY, NOT N NOTIFICATIONS. Reassigning through ordinary per-item
 *      updates (updateTask in a client loop, say) would mean 200 individual
 *      "assigned to you" emails and 200 audit rows for one sweep. This function
 *      writes every change as a plain batched Firestore update — no per-item
 *      notification is triggered by anything currently exported for tasks/series/
 *      subtasks/waitingOn/onboarding, because no such trigger exists yet (lane 5
 *      has not landed onTaskUpdated) — and instead sends exactly ONE audit event
 *      and ONE summary email per new assignee, listing everything that moved to
 *      them, after every write has committed.
 *
 * NOTE on the 'tickets' scope: functions/tickets.js's onTicketUpdated trigger
 * (shared code this lane does not own) DOES fire on ticket.assigneeIds changes
 * and sends its own per-ticket "assigned to you" email to each newly-added
 * assignee. This function cannot suppress that trigger without a change to
 * tickets.js, which is outside this lane's fence — see the change request in
 * CONTRACTS-TASKS.md. Until that lands, reassigning a large batch of tickets
 * through this sweep will ALSO send the normal per-ticket emails; the "one
 * summary" guarantee holds fully for tasks/series/subtasks/waitingOn/onboarding,
 * and only partially (audit event yes, email no) for tickets. Scope it narrowly,
 * or wait for the suppression flag, if that matters for a given reassignment.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { admin, db, REGION, APP_URL, escapeHtml, emailsForAssignees, sendMail } = require('./shared');

const BATCH_LIMIT = 400; // Firestore's 500-write cap, with headroom — same limit src/lib/onboarding.ts chunks at.

const TASK_SCOPES = ['tasks', 'waitingOn', 'subtaskAssignees', 'series'];
const OPTIONAL_SCOPES = ['tickets', 'onboarding'];
const ALL_SCOPES = [...TASK_SCOPES, ...OPTIONAL_SCOPES];
const LIVE_TASK_STATUS_TYPES = ['scheduled', 'todo', 'active', 'waiting'];

/** A tiny chunked-batch committer shared by every scope below. */
function makeBatcher() {
  let batch = db.batch();
  let pending = 0;
  return {
    add(apply) {
      apply(batch);
      pending++;
    },
    async flushIfFull() {
      if (pending >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
    },
    async finish() {
      if (pending > 0) await batch.commit();
    },
  };
}

exports.reassignWork = onCall({ region: REGION }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const callerSnap = await db.collection('profiles').doc(auth.uid).get();
  if (callerSnap.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Only a superadmin can reassign work.');
  }

  const data = request.data || {};
  const fromUserId = data.fromUserId;
  const toUserIds = data.toUserIds;
  if (!fromUserId || typeof fromUserId !== 'string') {
    throw new HttpsError('invalid-argument', 'fromUserId is required.');
  }
  if (!Array.isArray(toUserIds) || toUserIds.length === 0 || !toUserIds.every((id) => typeof id === 'string' && id)) {
    throw new HttpsError('invalid-argument', 'toUserIds must be a non-empty array of user ids.');
  }
  if (toUserIds.includes(fromUserId)) {
    throw new HttpsError('invalid-argument', 'toUserIds cannot include the departing person.');
  }

  const requestedScope = Array.isArray(data.scope) && data.scope.length > 0
    ? data.scope.filter((s) => ALL_SCOPES.includes(s))
    : TASK_SCOPES;
  const statusTypes = Array.isArray(data.statuses) && data.statuses.length > 0
    ? data.statuses.filter((s) => LIVE_TASK_STATUS_TYPES.includes(s))
    : ['todo', 'active', 'waiting'];

  const batcher = makeBatcher();
  let updated = 0;
  /** toUserId -> [{ kind, title, link }] — built up for the one summary email each gets. */
  const touchedByPerson = new Map();
  function record(toUserId, kind, title, link) {
    if (!touchedByPerson.has(toUserId)) touchedByPerson.set(toUserId, []);
    touchedByPerson.get(toUserId).push({ kind, title, link });
  }
  function dedupe(ids) {
    return [...new Set(ids.filter(Boolean))];
  }

  // ── tasks.assigneeIds ──
  if (requestedScope.includes('tasks')) {
    const snap = await db.collection('tasks').where('assigneeIds', 'array-contains', fromUserId).get();
    for (const taskDoc of snap.docs) {
      const task = taskDoc.data();
      if (!statusTypes.includes(task.statusType)) continue;
      const nextAssignees = dedupe([...(task.assigneeIds || []).filter((id) => id !== fromUserId), ...toUserIds]);
      const participants = dedupe([task.creatorId, ...nextAssignees, ...(task.watcherIds || [])]);
      batcher.add((batch) => batch.update(taskDoc.ref, {
        assigneeIds: nextAssignees,
        participants,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
      updated++;
      toUserIds.forEach((u) => record(u, 'task', task.title, `${APP_URL}/tasks/${taskDoc.id}`));
      await batcher.flushIfFull();
    }
  }

  // ── tasks.waitingOnUserId — the field person-named statuses were replaced by ──
  if (requestedScope.includes('waitingOn')) {
    const snap = await db.collection('tasks').where('waitingOnUserId', '==', fromUserId).get();
    for (const taskDoc of snap.docs) {
      const task = taskDoc.data();
      if (!statusTypes.includes(task.statusType)) continue;
      // waitingOnUserId holds exactly one person; the first pick-up inherits it.
      batcher.add((batch) => batch.update(taskDoc.ref, {
        waitingOnUserId: toUserIds[0],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
      updated++;
      record(toUserIds[0], 'waitingOn', task.title, `${APP_URL}/tasks/${taskDoc.id}`);
      await batcher.flushIfFull();
    }
  }

  // ── tasks.subtasks[].assigneeIds — no array-of-object query, so scan open tasks ──
  if (requestedScope.includes('subtaskAssignees')) {
    const snap = await db.collection('tasks').where('statusType', 'in', statusTypes.slice(0, 10)).get();
    for (const taskDoc of snap.docs) {
      const task = taskDoc.data();
      const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
      let touched = false;
      const nextSubtasks = subtasks.map((s) => {
        if (!Array.isArray(s.assigneeIds) || !s.assigneeIds.includes(fromUserId)) return s;
        touched = true;
        return { ...s, assigneeIds: dedupe([...s.assigneeIds.filter((id) => id !== fromUserId), ...toUserIds]) };
      });
      if (!touched) continue;
      batcher.add((batch) => batch.update(taskDoc.ref, {
        subtasks: nextSubtasks,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
      updated++;
      toUserIds.forEach((u) => record(u, 'subtask', task.title, `${APP_URL}/tasks/${taskDoc.id}`));
      await batcher.flushIfFull();
    }
  }

  // ── taskSeries.payload.assigneeIds — so future occurrences come out right too ──
  if (requestedScope.includes('series')) {
    const snap = await db.collection('taskSeries').where('active', '==', true).get();
    for (const seriesDoc of snap.docs) {
      const series = seriesDoc.data();
      const assigneeIds = (series.payload && series.payload.assigneeIds) || [];
      if (!assigneeIds.includes(fromUserId)) continue;
      const next = dedupe([...assigneeIds.filter((id) => id !== fromUserId), ...toUserIds]);
      batcher.add((batch) => batch.update(seriesDoc.ref, {
        'payload.assigneeIds': next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
      updated++;
      toUserIds.forEach((u) => record(u, 'series', series.name, `${APP_URL}/tasks/templates`));
      await batcher.flushIfFull();
    }
  }

  // ── tickets (optional) — see the module-doc NOTE on notification suppression ──
  if (requestedScope.includes('tickets')) {
    // Two queries because tickets carry both the current array field and the
    // pre-multi-assignee legacy singular field (see getAssigneeIds in shared.js);
    // an array-contains query alone would silently miss legacy-only tickets.
    const [byArray, byLegacy] = await Promise.all([
      db.collection('tickets').where('assigneeIds', 'array-contains', fromUserId).get(),
      db.collection('tickets').where('assigneeId', '==', fromUserId).get(),
    ]);
    const ticketDocs = new Map();
    [...byArray.docs, ...byLegacy.docs].forEach((d) => ticketDocs.set(d.id, d));

    for (const ticketDoc of ticketDocs.values()) {
      const ticket = ticketDoc.data();
      if (ticket.status !== 'Open' && ticket.status !== 'In Progress') continue;
      const currentIds = Array.isArray(ticket.assigneeIds)
        ? ticket.assigneeIds.filter(Boolean)
        : (ticket.assigneeId ? [ticket.assigneeId] : []);
      const nextAssignees = dedupe([...currentIds.filter((id) => id !== fromUserId), ...toUserIds]);
      const participants = dedupe([ticket.submitterId, ...nextAssignees]);
      batcher.add((batch) => batch.update(ticketDoc.ref, {
        assigneeIds: nextAssignees,
        assigneeId: admin.firestore.FieldValue.delete(),
        participants,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
      updated++;
      toUserIds.forEach((u) => record(u, 'ticket', ticket.title, `${APP_URL}/tickets/${ticketDoc.id}`));
      await batcher.flushIfFull();
    }
  }

  // ── onboarding rows.responsibleIds (optional) — no update trigger exists for
  // this collection today, so unlike tickets this one IS fully covered by the
  // one-summary guarantee. ──
  if (requestedScope.includes('onboarding')) {
    const snap = await db.collection('onboardingTasks').where('responsibleIds', 'array-contains', fromUserId).get();
    for (const rowDoc of snap.docs) {
      const row = rowDoc.data();
      if (row.status === 'Complete' || row.status === 'N/A') continue;
      const next = dedupe([...(row.responsibleIds || []).filter((id) => id !== fromUserId), ...toUserIds]);
      batcher.add((batch) => batch.update(rowDoc.ref, { responsibleIds: next }));
      updated++;
      toUserIds.forEach((u) => record(u, 'onboarding', row.title, `${APP_URL}/onboarding`));
      await batcher.flushIfFull();
    }
  }

  // ONE summary audit event for the whole sweep — not one per item.
  batcher.add((batch) => batch.set(db.collection('taskEvents').doc(), {
    taskId: null, // a workspace-level event, not tied to a single task
    type: 'reassigned',
    actorId: auth.uid,
    fromAssigneeIds: [fromUserId],
    toAssigneeIds: toUserIds,
    note: `Mass reassign: ${updated} item(s) moved from ${fromUserId} to ${toUserIds.join(', ')} (scope: ${requestedScope.join(', ')}).`,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  await batcher.finish();

  // ONE summary email per new assignee, sent only after every write has
  // committed — so a partial failure can't leave someone emailed about work
  // that didn't actually move.
  const fromProfileSnap = await db.collection('profiles').doc(fromUserId).get();
  const fromName = fromProfileSnap.data()?.name || 'a departing team member';
  const safeFromName = escapeHtml(fromName);

  for (const [toUserId, items] of touchedByPerson) {
    try {
      const [email] = await emailsForAssignees([toUserId]);
      if (!email) continue;
      const rows = items.map(
        (i) => `<li>[${escapeHtml(i.kind)}] <a href="${i.link}">${escapeHtml(i.title)}</a></li>`,
      );
      const count = items.length;
      await sendMail(
        email,
        `${count} item${count === 1 ? '' : 's'} reassigned to you from ${fromName}`,
        `<p><strong>${count}</strong> item${count === 1 ? '' : 's'} previously assigned to ${safeFromName} ${count === 1 ? 'has' : 'have'} been reassigned to you:</p>` +
        `<ul>${rows.join('')}</ul>`,
      );
    } catch (err) {
      logger.error(`reassignWork summary email failed for ${toUserId}`, err);
    }
  }

  logger.info(`reassignWork: moved ${updated} item(s) from ${fromUserId} to [${toUserIds.join(', ')}] (scope: ${requestedScope.join(', ')})`);
  return { updated };
});
