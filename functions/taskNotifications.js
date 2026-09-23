/**
 * Task email: three Firestore triggers mirroring the ticket ones in tickets.js
 * (HTML-escaped interpolation, server-side only — clients never write to the
 * `mail` collection, rules forbid it) plus a `notificationPrefs` gate that
 * tickets don't need, because tasks carry recurring-series volume that would
 * otherwise train people to ignore portal mail (see CONTRACTS-TASKS.md §7).
 *
 * Every recipient send is isolated in its own try/catch — one bad address or
 * a missing profile can't drop the rest of the notification.
 */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { db, REGION, APP_URL, escapeHtml, sendMail } = require('./shared');

/** Absolute URL to a task detail page. */
function taskLink(taskId) {
  return `${APP_URL}/tasks/${taskId}`;
}

/**
 * `notificationPrefs` lives on the profile (`immediate` | `digest-only` |
 * `mentions-only`; undefined/unknown behaves like `immediate` so existing
 * profiles keep working without a migration). `digest-only` drops immediate
 * mail entirely — that person only ever sees these in the morning brief.
 * `mentions-only` still gets a comment where they were @mentioned, just
 * nothing else immediately.
 */
function wantsImmediate(profile, { isMention = false } = {}) {
  const pref = profile?.notificationPrefs;
  if (pref === 'digest-only') return false;
  if (pref === 'mentions-only') return isMention;
  return true; // 'immediate', unset, or an unrecognized value.
}

/**
 * Resolve recipient ids to `{ id, email }` pairs, filtered to people who want
 * this mail immediately. Never throws — a missing/unreadable profile just
 * drops that one recipient rather than aborting everyone else's mail.
 */
async function resolveRecipients(userIds, { isMention = false } = {}) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = [];
  for (const id of unique) {
    try {
      const snap = await db.collection('profiles').doc(id).get();
      if (!snap.exists) continue;
      const profile = snap.data();
      if (!profile.email || !wantsImmediate(profile, { isMention })) continue;
      out.push({ id, email: profile.email });
    } catch (err) {
      logger.error(`Could not resolve task-notification recipient ${id}`, err);
    }
  }
  return out;
}

/** Send to each recipient with per-recipient failure isolation. */
async function sendToEach(recipients, subject, buildHtml) {
  let sent = 0;
  for (const { id, email } of recipients) {
    try {
      await sendMail(email, subject, buildHtml(id));
      sent++;
    } catch (err) {
      logger.error(`Task notification mail failed for ${id}`, err);
    }
  }
  return sent;
}

/**
 * Most recent audit event of `type` on `taskId` matching `match` fields — used
 * to recover "who did this" for a trigger that only sees the document, not the
 * request. Returns null (never throws) if nothing matches yet, which happens
 * legitimately whenever the writer hasn't logged an event for this change.
 */
async function findActor(taskId, type, match = {}) {
  try {
    let q = db.collection('taskEvents')
      .where('taskId', '==', taskId)
      .where('type', '==', type)
      .orderBy('createdAt', 'desc')
      .limit(5);
    const snap = await q.get();
    for (const doc of snap.docs) {
      const e = doc.data();
      if (Object.entries(match).every(([k, v]) => e[k] === v)) return e.actorId || null;
    }
    return null;
  } catch (err) {
    logger.warn(`Could not resolve actor for ${type} on ${taskId}`, err);
    return null;
  }
}

// ─── onTaskCreated ────────────────────────────────────────────────────────────
// Notify assignees. A `scheduled` task isn't live yet — its assignees are
// notified at go-live instead (activateScheduledTasks, lane 1), same as a
// Scheduled ticket's assignees are notified by activateScheduledTickets.

exports.onTaskCreated = onDocumentCreated(
  { document: 'tasks/{taskId}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const task = snap.data();
    const taskId = event.params.taskId;

    if (task.statusType === 'scheduled') return;

    try {
      const assigneeIds = Array.isArray(task.assigneeIds) ? task.assigneeIds : [];
      const recipients = await resolveRecipients(assigneeIds);
      const link = taskLink(taskId);
      const safeTitle = escapeHtml(task.title);
      const safePriority = task.priority ? escapeHtml(task.priority) : null;

      const sent = await sendToEach(
        recipients,
        `New task: ${task.title}`,
        () =>
          `<p>A new task has been assigned to you.</p><p><strong>${safeTitle}</strong></p>` +
          (safePriority ? `<p>Priority: ${safePriority}</p>` : '') +
          `<p><a href="${link}">View task →</a></p>`,
      );
      logger.info(`onTaskCreated: notified ${sent} assignee(s) for ${taskId}`);
    } catch (err) {
      logger.error(`onTaskCreated mail failed for ${taskId}`, err);
    }
  }
);

// ─── onTaskUpdated ────────────────────────────────────────────────────────────
// Status change -> assignees + watchers + creator, minus the actor. Newly
// added assignees. Due-date change -> the same audience, minus the actor.
// All three skip a task that is still `scheduled` — it isn't live yet, and
// go-live notifications are activateScheduledTasks's job, not this trigger's
// (mirrors onTicketUpdated skipping the Scheduled→Open flip).

exports.onTaskUpdated = onDocumentUpdated(
  { document: 'tasks/{taskId}', region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    const taskId = event.params.taskId;
    const link = taskLink(taskId);
    const safeTitle = escapeHtml(after.title);

    if (after.statusType === 'scheduled') return;

    // "Everyone attached" mirrors participantsOf() in src/lib/tasks.ts — kept
    // in sync manually since Cloud Functions don't import client TS source.
    const audience = [
      ...(Array.isArray(after.assigneeIds) ? after.assigneeIds : []),
      ...(Array.isArray(after.watcherIds) ? after.watcherIds : []),
      after.creatorId,
    ].filter(Boolean);

    try {
      // Status change (skip the scheduled→live go-live flip; that's the
      // activator's notification to send, not this trigger's).
      if (before.statusId !== after.statusId && before.statusType !== 'scheduled') {
        const actorId = await findActor(taskId, 'status_changed', { toStatusId: after.statusId });
        const recipients = await resolveRecipients(
          audience.filter((id) => id !== actorId),
        );
        const sent = await sendToEach(
          recipients,
          `${after.title}: status changed to ${after.statusName}`,
          () =>
            `<p><strong>${safeTitle}</strong> has been updated to <strong>${escapeHtml(after.statusName)}</strong>.</p>` +
            `<p><a href="${link}">View task →</a></p>`,
        );
        logger.info(`onTaskUpdated: notified ${sent} for status change on ${taskId}`);
      }

      // Newly added assignees.
      const beforeIds = Array.isArray(before.assigneeIds) ? before.assigneeIds : [];
      const afterIds = Array.isArray(after.assigneeIds) ? after.assigneeIds : [];
      const added = afterIds.filter((id) => !beforeIds.includes(id));
      if (added.length) {
        const recipients = await resolveRecipients(added);
        const sent = await sendToEach(
          recipients,
          `${after.title} has been assigned to you`,
          () => `<p><strong>${safeTitle}</strong> has been assigned to you.</p><p><a href="${link}">View task →</a></p>`,
        );
        logger.info(`onTaskUpdated: notified ${sent} newly-added assignee(s) on ${taskId}`);
      }

      // Due-date change.
      if (before.dueDate !== after.dueDate) {
        const actorId = await findActor(taskId, 'due_date_changed', { toDueDate: after.dueDate ?? null });
        const recipients = await resolveRecipients(
          audience.filter((id) => id !== actorId),
        );
        const dueText = after.dueDate ? `now due ${escapeHtml(after.dueDate)}` : 'no longer has a due date';
        const sent = await sendToEach(
          recipients,
          `${after.title}: due date changed`,
          () => `<p><strong>${safeTitle}</strong> is ${dueText}.</p><p><a href="${link}">View task →</a></p>`,
        );
        logger.info(`onTaskUpdated: notified ${sent} for due-date change on ${taskId}`);
      }
    } catch (err) {
      logger.error(`onTaskUpdated mail failed for ${taskId}`, err);
    }
  }
);

// ─── onTaskCommentCreated ─────────────────────────────────────────────────────
// Participants + @mentioned, minus the author. Mentioned recipients pass
// isMention so a mentions-only profile still hears about it.

exports.onTaskCommentCreated = onDocumentCreated(
  { document: 'taskComments/{commentId}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const comment = snap.data();

    try {
      const taskSnap = await db.collection('tasks').doc(comment.taskId).get();
      if (!taskSnap.exists) return;
      const task = taskSnap.data();
      const link = taskLink(comment.taskId);

      const authorSnap = await db.collection('profiles').doc(comment.userId).get();
      const authorName = authorSnap.data()?.name || 'Someone';
      const safeName = escapeHtml(authorName);
      const safeBody = escapeHtml(comment.body || '');
      const safeTitle = escapeHtml(task.title);

      const mentioned = Array.isArray(comment.mentionedIds) ? comment.mentionedIds : [];
      const participants = Array.isArray(task.participants) ? task.participants : [];
      const everyone = [...new Set([...participants, ...mentioned])].filter((id) => id && id !== comment.userId);

      let sent = 0;
      for (const id of everyone) {
        try {
          const wasMentioned = mentioned.includes(id);
          const recipients = await resolveRecipients([id], { isMention: wasMentioned });
          if (recipients.length === 0) continue;
          const subject = wasMentioned
            ? `${authorName} mentioned you on ${task.title}`
            : `New comment on ${task.title}`;
          const lead = wasMentioned
            ? `<p><strong>${safeName}</strong> mentioned you in a comment on <strong>${safeTitle}</strong>:</p>`
            : `<p><strong>${safeName}</strong> commented on <strong>${safeTitle}</strong>:</p>`;
          await sendMail(
            recipients[0].email,
            subject,
            `${lead}<p>${safeBody}</p><p><a href="${link}">View task →</a></p>`,
          );
          sent++;
        } catch (err) {
          logger.error(`onTaskCommentCreated mail failed for ${id}`, err);
        }
      }
      logger.info(`onTaskCommentCreated: notified ${sent} for comment on ${comment.taskId}`);
    } catch (err) {
      logger.error('onTaskCommentCreated mail failed', err);
    }
  }
);
