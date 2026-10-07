/**
 * Pre-live ("scheduled") tasks — the replacement for HR's ClickUp `FUTURE`
 * status (plan §4, "Scheduled (pre-live) tasks").
 *
 * A task whose `statusType` is `scheduled` is hidden from active lists, the
 * calendar, and the morning digest until its `goLiveDate`. On that date this
 * module flips it to the list's default `todo` status, restores its assignees to
 * `participants`, notifies them, and logs an `activated` event.
 *
 * Tickets have had exactly this mechanic for a while (`activateScheduledTickets`
 * in tickets.js). Rather than copying it, the batch-per-record runner is factored
 * out here as `activateScheduled` and exported, so tickets can be moved onto the
 * same engine without changing their behaviour. One implementation, two
 * collections — a second copy is how the two would drift.
 *
 * Also the home of the status-set lookups every server-side task writer needs,
 * because "what is this list's To Do status?" is precisely the question
 * activation asks. tasksRecurring.js imports them from here.
 */

'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { admin, db, REGION, APP_URL, escapeHtml, emailsForAssignees, todayInTimeZone } = require('./shared');
const { DEFAULT_TIMEZONE } = require('./recurrence');
// FieldValue comes from the MODULAR entry point, never `admin.firestore.FieldValue`.
// The Functions emulator wraps the namespaced `admin.firestore` so its calls reach
// the local Firestore, and that wrapper does not carry FieldValue — so the
// namespaced form throws "Cannot read properties of undefined" at runtime while
// looking perfectly correct in source and resolving fine outside the emulator.
// That made the emulator untrustworthy for exactly the paths most worth testing.
const { FieldValue } = require('firebase-admin/firestore');

/**
 * Mirror of DEFAULT_STATUS_SET in src/lib/taskStatuses.ts, used only when a list
 * has no status set at all. The duplication is unavoidable — the client is ESM
 * and these functions are CommonJS — so if that constant changes, change it here
 * too. Note there is deliberately no `scheduled` status in the default set: it is
 * added per set from Task Settings.
 */
const FALLBACK_STATUSES = [
  { id: 'todo', name: 'To Do', color: '#6B7280', order: 0, type: 'todo' },
  { id: 'in-progress', name: 'In Progress', color: '#B45309', order: 1, type: 'active' },
  { id: 'waiting', name: 'Waiting On', color: '#7C3AED', order: 2, type: 'waiting' },
  { id: 'complete', name: 'Complete', color: '#16A34A', order: 3, type: 'done' },
  { id: 'closed', name: 'Closed', color: '#9CA3AF', order: 4, type: 'closed' },
];

const DONE_TYPES = new Set(['done', 'closed']);

/** Done means done or closed — never a status *label*, which is per-list and renameable. */
function isDoneType(statusType) {
  return DONE_TYPES.has(statusType);
}

/** Live work: not pre-live, not finished. */
function isLiveType(statusType) {
  return statusType === 'todo' || statusType === 'active' || statusType === 'waiting';
}

/**
 * The statuses a list uses. `cache` is a plain Map the caller keeps for the run —
 * a generator pass over 40 series would otherwise re-read the same two documents
 * 40 times.
 */
async function loadStatusesForList(listId, cache) {
  if (!listId) return FALLBACK_STATUSES;
  if (cache && cache.has(listId)) return cache.get(listId);

  let statuses = FALLBACK_STATUSES;
  try {
    const listSnap = await db.collection('taskLists').doc(listId).get();
    const setId = listSnap.data()?.defaultStatusSetId;
    if (setId) {
      const setSnap = await db.collection('taskStatusSets').doc(setId).get();
      const found = setSnap.data()?.statuses;
      if (Array.isArray(found) && found.length > 0) statuses = found;
    }
  } catch (err) {
    // A missing list shouldn't strand a task in `scheduled` forever; the fallback
    // set has the same five ids the seeder writes, so this degrades to correct.
    logger.warn(`Could not load the status set for list ${listId}; using the fallback set`, err);
  }

  if (cache) cache.set(listId, statuses);
  return statuses;
}

/** Lowest-ordered `todo` status, falling back to the lowest-ordered status of any type. */
function defaultTodoStatus(statuses) {
  const ordered = [...(statuses || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return ordered.find((s) => s.type === 'todo') || ordered[0] || null;
}

/** The denormalized status triple a task doc stores, or null when the id is unknown. */
function statusTripleFor(statuses, statusId) {
  const def = (statuses || []).find((s) => s.id === statusId);
  return def ? { statusId: def.id, statusName: def.name, statusType: def.type } : null;
}

/**
 * The batch-per-record activation runner, shared by every collection that has a
 * pre-live state.
 *
 * `loadDue()` returns the documents whose go-live moment has passed.
 * `buildBatch(batch, doc)` fills one atomic WriteBatch — the status flip, the
 * audit event, and the notification mail together — and returns false to decline
 * the record. Either everything lands or nothing does and the next run retries
 * cleanly: no half-activated records, no duplicate events, no dropped mail.
 * Per-record failures are caught so one bad record can't abort the run.
 */
async function activateScheduled({ label, loadDue, buildBatch }) {
  const docs = await loadDue();
  logger.info(`${label}: ${docs.length} record(s) due to go live`);

  let activated = 0;
  for (const doc of docs) {
    try {
      const batch = db.batch();
      if ((await buildBatch(batch, doc)) === false) continue;
      await batch.commit();
      activated++;
    } catch (err) {
      logger.error(`${label}: activation failed for ${doc.id}`, err);
    }
  }

  logger.info(`${label}: activated ${activated} record(s)`);
  return activated;
}

/**
 * Tasks whose goLiveDate has arrived.
 *
 * Deliberately a single-field query plus an in-memory date filter: a
 * statusType + goLiveDate composite index is not among the deployed ones, and
 * pre-live tasks are a small, self-draining set — every run removes the ones it
 * activates. Adding an index for a query over a handful of documents isn't worth
 * the deploy.
 */
async function loadDueScheduledTasks(today) {
  const snap = await db.collection('tasks').where('statusType', '==', 'scheduled').get();
  return snap.docs.filter((doc) => {
    const goLive = doc.data()?.goLiveDate;
    return typeof goLive === 'string' && goLive <= today;
  });
}

/** Fill one task's activation batch. Exported so a test or a backfill can drive it. */
async function buildTaskActivationBatch(batch, taskDoc, cache) {
  const task = taskDoc.data() || {};
  const statuses = await loadStatusesForList(task.listId, cache);
  const todo = defaultTodoStatus(statuses);
  if (!todo) {
    logger.error(`Task ${taskDoc.id} has no usable To Do status; leaving it scheduled`);
    return false;
  }

  const assigneeIds = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
  const watcherIds = Array.isArray(task.watcherIds) ? task.watcherIds.filter(Boolean) : [];
  const participants = [...new Set([task.creatorId, ...assigneeIds, ...watcherIds].filter(Boolean))];

  batch.update(taskDoc.ref, {
    statusId: todo.id,
    statusName: todo.name,
    statusType: todo.type,
    // The go-live date has done its job; leaving it set would keep the task
    // looking pre-live to anything that checks the field rather than the type.
    goLiveDate: FieldValue.delete(),
    participants,
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.set(db.collection('taskEvents').doc(), {
    taskId: taskDoc.id,
    type: 'activated',
    actorId: task.creatorId || 'system',
    fromStatusId: task.statusId ?? null,
    toStatusId: todo.id,
    fromStatusType: 'scheduled',
    toStatusType: todo.type,
    note: 'Scheduled task went live.',
    createdAt: FieldValue.serverTimestamp(),
  });

  // Server-side mail only — the client is forbidden from writing to `mail`, and
  // the task title is free text, so it is escaped before it reaches the HTML.
  const emails = await emailsForAssignees(assigneeIds);
  const safeTitle = escapeHtml(task.title);
  for (const email of emails) {
    batch.set(db.collection('mail').doc(), {
      to: email,
      message: {
        subject: `Task now live: ${task.title}`,
        html:
          `<p>A scheduled task has gone live and is now assigned to you.</p>` +
          `<p><strong>${safeTitle}</strong></p>` +
          `<p><a href="${APP_URL}/tasks/${taskDoc.id}">View task →</a></p>`,
      },
    });
  }

  return true;
}

/**
 * Same 5-minute cadence as the ticket activator. The schedule is a cadence, not a
 * wall-clock time, so the zone only matters for the go-live date comparison —
 * which is resolved in the office's zone, not UTC, so a task set for the 15th
 * doesn't go live at 6pm on the 14th.
 */
exports.activateScheduledTasks = onSchedule(
  { schedule: 'every 5 minutes', timeZone: DEFAULT_TIMEZONE, region: REGION },
  async () => {
    const today = todayInTimeZone(DEFAULT_TIMEZONE);
    const cache = new Map();
    await activateScheduled({
      label: 'activateScheduledTasks',
      loadDue: () => loadDueScheduledTasks(today),
      buildBatch: (batch, doc) => buildTaskActivationBatch(batch, doc, cache),
    });
  },
);

module.exports.activateScheduled = activateScheduled;
module.exports.loadDueScheduledTasks = loadDueScheduledTasks;
module.exports.buildTaskActivationBatch = buildTaskActivationBatch;
module.exports.loadStatusesForList = loadStatusesForList;
module.exports.defaultTodoStatus = defaultTodoStatus;
module.exports.statusTripleFor = statusTripleFor;
module.exports.isDoneType = isDoneType;
module.exports.isLiveType = isLiveType;
module.exports.FALLBACK_STATUSES = FALLBACK_STATUSES;
