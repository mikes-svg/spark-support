/**
 * Recurring tasks — the reading and writing half of the engine (plan §4).
 * All the date maths lives in recurrence.js; nothing in this file computes a date.
 *
 * Three entry points:
 *   generateRecurringTasks   scheduled, daily 06:00 America/Chicago
 *   onTaskCompletedRecurrence  Firestore trigger — the DEFAULT `on-completion` mode
 *   previewRecurrence        callable — the only way the client learns a date
 *
 * The schedule is 06:00 deliberately: one hour ahead of the 07:00 morning digest,
 * so a task minted this morning is in this morning's email rather than tomorrow's.
 *
 * Every write follows the shape proven by activateScheduledTickets: a
 * deterministic doc id (`${seriesId}_${occurrenceKey}`), one atomic WriteBatch per
 * occurrence, and per-series try/catch so one malformed series can't abort the run.
 * The doc id is the load-bearing part — a retried or double-fired run is
 * *physically* unable to create a second copy of the same occurrence, which is
 * what the customer's old setup could not say.
 */

'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { admin, db, REGION, todayInTimeZone } = require('./shared');
const {
  addDays,
  diffDays,
  parseDate,
  occurrencesFrom,
  occurrenceDocId,
  buildOccurrenceSubtasks,
  decideMissedAction,
  DEFAULT_TIMEZONE,
} = require('./recurrence');
const { loadStatusesForList, defaultTodoStatus, statusTripleFor, isDoneType } = require('./scheduledTasks');
// FieldValue comes from the MODULAR entry point, never `admin.firestore.FieldValue`.
// The Functions emulator wraps the namespaced `admin.firestore` so its calls reach
// the local Firestore, and that wrapper does not carry FieldValue — so the
// namespaced form throws "Cannot read properties of undefined" at runtime while
// looking perfectly correct in source and resolving fine outside the emulator.
// That made the emulator untrustworthy for exactly the paths most worth testing.
const { FieldValue } = require('firebase-admin/firestore');

const SERIES = 'taskSeries';
const TASKS = 'tasks';
const TASK_EVENTS = 'taskEvents';

/** How many past occurrences to inspect when deciding what is still open.
 *  A series with more than this many unfinished occurrences has a bigger
 *  problem than the generator can solve, and the digest will be saying so. */
const RECENT_WINDOW = 25;

/** Hard ceiling on occurrences minted per series per run. The daily cadence
 *  catches an `accumulate` series up one day at a time; a burst would just be
 *  the pile-up this phase exists to prevent, wearing a different hat. */
const MAX_PER_RUN = 1;

// ─── Reading a series ────────────────────────────────────────────────────────

/** The series' most recent occurrences, newest first. Covered by the deployed
 *  seriesId + occurrenceKey composite index. */
async function recentOccurrences(seriesId) {
  const snap = await db
    .collection(TASKS)
    .where('seriesId', '==', seriesId)
    .orderBy('occurrenceKey', 'desc')
    .limit(RECENT_WINDOW)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
}

/** Unfinished occurrences — keyed off statusType, never a status label. A
 *  `scheduled` occurrence isn't "open" yet, so it doesn't block the next one. */
function openOccurrences(tasks, excludeId) {
  return tasks.filter(
    (t) => t.id !== excludeId && !isDoneType(t.statusType) && t.statusType !== 'scheduled',
  );
}

/** Where the next occurrence is measured from. `lastOccurrenceKey` is written by
 *  this module on every decision — including "missed" ones, which mint no task —
 *  so it, not the newest task, is the authoritative pointer. */
function seriesPointer(series, recent) {
  return series.lastOccurrenceKey || recent[0]?.occurrenceKey || null;
}

/** The date the whole sequence is derived from. Deriving every occurrence from
 *  this (rather than from the previous one) is what makes month-end and leap-day
 *  behave — see buildDateAt in recurrence.js. */
function seriesAnchor(series, recent, today) {
  return (
    series.anchorDate ||
    series.payload?.dueDate ||
    recent[recent.length - 1]?.occurrenceKey ||
    seriesPointer(series, recent) ||
    today
  );
}

// ─── Building an occurrence ──────────────────────────────────────────────────

/**
 * The task document for one occurrence. `previous` is the occurrence this one
 * follows (the completed task, or the newest existing one) and supplies the
 * subtask carryover state.
 *
 * copyOnRecur mirrors ClickUp's "Include in new task" checkboxes: description,
 * subtasks, subtaskAssignees, remapSubtaskDates, assignees, watchers and tags are
 * on by default; comments, attachments and activity are off, and are simply never
 * read here — an occurrence starts with a clean discussion and a clean audit trail.
 */
function buildOccurrenceTask(series, seriesId, occurrenceKey, previous, status) {
  const payload = series.payload || {};
  const copy = series.copyOnRecur || {};

  // Subtask due dates move with the cycle only when remapSubtaskDates is on.
  const shift = previous?.occurrenceKey ? diffDays(previous.occurrenceKey, occurrenceKey) : null;
  const remapDueDate =
    copy.remapSubtaskDates !== false && shift !== null ? (d) => (d ? addDays(d, shift) : null) : () => null;

  const { subtasks, carryStreak, carryFlagged, carriedCount } = buildOccurrenceSubtasks({
    template: payload.subtaskTemplate || [],
    previousSubtasks: previous?.subtasks || [],
    copyOnRecur: copy,
    previousTaskId: previous?.id || null,
    previousCarryStreak: previous?.carryStreak || 0,
    remapDueDate,
    // Deterministic subtask ids, for the same reason the doc id is deterministic:
    // a retried write rebuilds a byte-identical document.
    idFor: (i) => `${occurrenceKey}-st-${i}`,
  });

  const assigneeIds = copy.assignees === false ? [] : (payload.assigneeIds || []).filter(Boolean);
  const watcherIds = copy.watchers === false ? [] : (payload.watcherIds || []).filter(Boolean);
  const creatorId = payload.creatorId || series.creatorId || 'system';

  const offset = Number(series.startOffsetDays);
  const startDate = Number.isFinite(offset) && offset !== 0 ? addDays(occurrenceKey, offset) : null;

  return {
    data: {
      listId: payload.listId || null,
      spaceId: payload.spaceId || null,
      title: payload.title || series.name || 'Recurring task',
      description: copy.description === false ? '' : (payload.description ?? ''),
      ...status,
      waitingOnUserId: null,
      priority: payload.priority ?? null,
      assigneeIds,
      creatorId,
      watcherIds,
      participants: [...new Set([creatorId, ...assigneeIds, ...watcherIds].filter(Boolean))],
      startDate,
      dueDate: occurrenceKey,
      dueTime: payload.dueTime ?? null,
      goLiveDate: null,
      tagIds: copy.tags === false ? [] : (payload.tagIds || []),
      subtasks,
      order: payload.order ?? 0,
      seriesId,
      occurrenceKey,
      // Server-maintained carryover state. `carryFlagged` is what the task row and
      // the morning digest read to say "this has been carrying work for four
      // cycles" instead of letting the checklist quietly get longer forever.
      carryStreak,
      carryFlagged,
      gcalEventId: null,
      gcalSyncedAt: null,
      completedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    carriedCount,
    carryFlagged,
  };
}

/** The status a new occurrence starts in: the series' `resetStatusTo` (ClickUp's
 *  "Update status to: TO DO"), or the list's default todo status. */
async function occurrenceStatus(series, cache) {
  const statuses = await loadStatusesForList(series.payload?.listId, cache);
  const reset = statusTripleFor(statuses, series.resetStatusTo);
  if (reset) return reset;
  const todo = defaultTodoStatus(statuses);
  return todo ? { statusId: todo.id, statusName: todo.name, statusType: todo.type } : null;
}

/**
 * Write one occurrence. Returns 'created' or 'exists'.
 *
 * `batch.create()` rejects if the document is already there, so even if the
 * pre-check below races with a concurrent run, the second writer loses the whole
 * batch rather than overwriting a task someone has already started working on.
 */
async function commitOccurrence(seriesRef, seriesId, series, occurrenceKey, previous, cache) {
  const docId = occurrenceDocId(seriesId, occurrenceKey);
  if (!docId) return 'invalid';

  const taskRef = db.collection(TASKS).doc(docId);
  if ((await taskRef.get()).exists) return 'exists';

  const status = await occurrenceStatus(series, cache);
  if (!status) {
    logger.error(`Series ${seriesId} has no usable status; skipping occurrence ${occurrenceKey}`);
    return 'no-status';
  }

  const { data, carriedCount, carryFlagged } = buildOccurrenceTask(
    series,
    seriesId,
    occurrenceKey,
    previous,
    status,
  );

  const batch = db.batch();
  batch.create(taskRef, data);
  batch.set(db.collection(TASK_EVENTS).doc(), {
    taskId: docId,
    type: 'occurrence_created',
    actorId: data.creatorId,
    toStatusId: status.statusId,
    toStatusType: status.statusType,
    toDueDate: occurrenceKey,
    note: carriedCount
      ? `Occurrence ${occurrenceKey} created, carrying ${carriedCount} unfinished item(s)${carryFlagged ? ' — carried for more than three cycles' : ''}.`
      : `Occurrence ${occurrenceKey} created.`,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(seriesRef, {
    lastOccurrenceKey: occurrenceKey,
    occurrencesCreated: FieldValue.increment(1),
    missedStreak: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return 'created';
}

/** Record a missed occurrence: roll the open task forward (skip-to-next) or leave
 *  it exactly where it is (keep-one-open). Either way the series pointer advances,
 *  so tomorrow's run doesn't re-decide the same date. */
async function commitMissed(seriesRef, seriesId, decision, occurrenceKey, openTask) {
  const batch = db.batch();

  if (decision.action === 'roll-forward' && openTask?.ref) {
    batch.update(openTask.ref, {
      dueDate: occurrenceKey,
      // Move the key too: one task, always current. The event below keeps the
      // record of which occurrence it originally was.
      occurrenceKey,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  if (openTask?.id) {
    batch.set(db.collection(TASK_EVENTS).doc(), {
      taskId: openTask.id,
      type: 'missed_occurrence',
      actorId: 'system',
      fromDueDate: openTask.dueDate ?? null,
      toDueDate: decision.action === 'roll-forward' ? occurrenceKey : (openTask.dueDate ?? null),
      note: decision.note,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  batch.update(seriesRef, {
    lastOccurrenceKey: occurrenceKey,
    missedStreak: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

// ─── The scheduled generator ─────────────────────────────────────────────────

/** One series. Returns a short outcome string for the run log. */
async function processSeries(seriesDoc, cache) {
  const series = seriesDoc.data() || {};
  const seriesId = seriesDoc.id;

  // `on-completion` is the default and is driven by the completion trigger, not
  // the clock — that is the whole point of it. The generator only advances
  // `on-schedule` series.
  if ((series.trigger || 'on-completion') !== 'on-schedule') return 'on-completion';

  const today = todayInTimeZone(series.timezone || DEFAULT_TIMEZONE);
  const recent = await recentOccurrences(seriesId);
  const pointer = seriesPointer(series, recent);
  const anchor = seriesAnchor(series, recent, today);
  const from = pointer ? addDays(pointer, 1) : anchor;
  if (!from) return 'bad-anchor';

  const [due] = occurrencesFrom(series, {
    from,
    count: MAX_PER_RUN,
    anchor,
    alreadyGenerated: series.occurrencesCreated ?? recent.length,
  });

  if (!due) return 'ended';
  if (due > today) return 'not-yet-due';

  const open = openOccurrences(recent);
  const decision = decideMissedAction({
    missedPolicy: series.missedPolicy,
    openTasks: open,
    dueDate: due,
  });

  if (decision.action === 'create') {
    return commitOccurrence(seriesDoc.ref, seriesId, series, due, recent[0] || null, cache);
  }

  await commitMissed(
    seriesDoc.ref,
    seriesId,
    decision,
    due,
    open.find((t) => t.id === decision.openTaskId) || null,
  );
  return decision.action;
}

exports.generateRecurringTasks = onSchedule(
  {
    // 06:00, one hour before the 07:00 morning digest, so the tasks this run
    // mints are in that morning's email rather than waiting a day.
    schedule: 'every day 06:00',
    timeZone: DEFAULT_TIMEZONE,
    region: REGION,
  },
  async () => {
    const snap = await db.collection(SERIES).where('active', '==', true).get();
    logger.info(`generateRecurringTasks: ${snap.size} active series`);

    const cache = new Map();
    const tally = {};
    for (const seriesDoc of snap.docs) {
      try {
        const outcome = await processSeries(seriesDoc, cache);
        tally[outcome] = (tally[outcome] || 0) + 1;
      } catch (err) {
        // Isolated per series: one malformed recurrence can't stop the rest.
        tally.error = (tally.error || 0) + 1;
        logger.error(`generateRecurringTasks: series ${seriesDoc.id} failed`, err);
      }
    }

    logger.info('generateRecurringTasks: done', tally);
  },
);

// ─── on-completion (the default trigger mode) ────────────────────────────────

/**
 * ClickUp's model was "on status change → Complete: create the next one and reset
 * this card to To Do", which reused one card and threw away its history. We mint a
 * *new* occurrence in the series' `resetStatusTo` status and leave the completed
 * one completed — same felt behaviour, but last cycle stays on the record.
 *
 * Exported as a plain function as well as a trigger so the notifications lane's
 * `onTaskUpdated` can call it directly if we'd rather have one trigger on
 * `tasks/{taskId}` than two.
 */
async function advanceSeriesOnCompletion(taskId, before, after, cache) {
  if (!after?.seriesId) return 'not-recurring';
  // Only the transition *into* done. An edit to an already-complete task must not
  // mint a second occurrence.
  if (isDoneType(before?.statusType) || !isDoneType(after.statusType)) return 'not-a-completion';

  const seriesRef = db.collection(SERIES).doc(after.seriesId);
  const seriesSnap = await seriesRef.get();
  const series = seriesSnap.data();
  if (!series) return 'no-series';
  if (series.active === false) return 'inactive';
  if ((series.trigger || 'on-completion') !== 'on-completion') return 'on-schedule';

  const today = todayInTimeZone(series.timezone || DEFAULT_TIMEZONE);
  const recent = await recentOccurrences(after.seriesId);
  const anchor = seriesAnchor(series, recent, today);
  const last = after.occurrenceKey || after.dueDate || today;
  const from = addDays(last, 1);
  if (!from) return 'bad-anchor';

  const [next] = occurrencesFrom(series, {
    from,
    count: 1,
    anchor,
    alreadyGenerated: series.occurrencesCreated ?? recent.length,
  });
  if (!next) return 'ended';

  // The just-completed task is excluded, but an *older* occurrence left open still
  // counts: completing this week's copy shouldn't quietly bury last month's.
  const decision = decideMissedAction({
    missedPolicy: series.missedPolicy,
    openTasks: openOccurrences(recent, taskId),
    dueDate: next,
  });

  if (decision.action !== 'create') {
    const open = openOccurrences(recent, taskId).find((t) => t.id === decision.openTaskId) || null;
    await commitMissed(seriesRef, after.seriesId, decision, next, open);
    return decision.action;
  }

  return commitOccurrence(
    seriesRef,
    after.seriesId,
    series,
    next,
    { ...after, id: taskId },
    cache || new Map(),
  );
}

exports.onTaskCompletedRecurrence = onDocumentUpdated(
  { document: 'tasks/{taskId}', region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;
    try {
      const outcome = await advanceSeriesOnCompletion(event.params.taskId, before, after);
      if (outcome !== 'not-recurring' && outcome !== 'not-a-completion') {
        logger.info(`onTaskCompletedRecurrence: ${event.params.taskId} → ${outcome}`);
      }
    } catch (err) {
      logger.error(`onTaskCompletedRecurrence failed for ${event.params.taskId}`, err);
    }
  },
);

// ─── previewRecurrence ───────────────────────────────────────────────────────

/**
 * The next N occurrence dates for a recurrence config. The client calls this for
 * the "next 5 occurrences" preview and never computes a date itself.
 *
 * `trigger` is accepted because the caller passes the whole draft series, but it
 * doesn't change the dates — it changes *when* a date gets minted into a task, not
 * what the date is. Showing the schedule for an on-completion series is exactly
 * what the editor wants: "this is the cadence you're setting up."
 */
exports.previewRecurrence = onCall({ region: REGION }, (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to preview a recurrence.');
  }

  const data = request.data || {};
  if (!data.recurrence || typeof data.recurrence !== 'object') {
    throw new HttpsError('invalid-argument', 'A recurrence config is required.');
  }

  const timezone = typeof data.timezone === 'string' && data.timezone ? data.timezone : DEFAULT_TIMEZONE;
  const from = parseDate(data.from) ? data.from : todayInTimeZone(timezone);
  const anchor = parseDate(data.anchor) ? data.anchor : from;
  // Capped so a typo in the editor can't ask for ten thousand dates.
  const count = Math.min(50, Math.max(1, Math.floor(Number(data.count)) || 5));

  const occurrences = occurrencesFrom(
    {
      recurrence: data.recurrence,
      skipWeekends: Boolean(data.skipWeekends),
      weekendShift: data.weekendShift === 'previous' ? 'previous' : 'next',
      endDate: data.endDate ?? null,
      occurrenceLimit: data.occurrenceLimit ?? null,
    },
    { from, count, anchor, alreadyGenerated: data.alreadyGenerated ?? 0 },
  );

  return { occurrences };
});

module.exports.advanceSeriesOnCompletion = advanceSeriesOnCompletion;
module.exports.buildOccurrenceTask = buildOccurrenceTask;
module.exports.processSeries = processSeries;
module.exports.openOccurrences = openOccurrences;
