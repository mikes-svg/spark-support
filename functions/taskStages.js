/**
 * Sequential sign-off chains ("stages").
 *
 * The handoff lives here rather than in the client because it is the part that
 * must not be skipped: when someone signs off a stage, the task has to move to
 * the next person and tell them, whether the sign-off came from the task page,
 * a future mobile view, or a script. A client that closed its laptop mid-write
 * would otherwise strand the task on a completed stage with nobody assigned.
 *
 * Stages are deliberately NOT subtasks. A subtask is a checklist item anyone on
 * the task can tick in any order; a stage is a baton.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { FieldValue } = require('firebase-admin/firestore');
const { db, REGION, APP_URL, escapeHtml, sendMail } = require('./shared');

const TASKS = 'tasks';
const DONE_TYPES = new Set(['done', 'closed']);

const ordered = (stages) => [...(stages || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const currentStage = (stages) => ordered(stages).find((s) => !s.done) || null;
const allComplete = (stages) => !!stages && stages.length > 0 && stages.every((s) => s.done);

/** Which stage ids newly flipped to done in this write. */
function newlyCompleted(before, after) {
  const was = new Map((before?.stages || []).map((s) => [s.id, !!s.done]));
  return (after.stages || []).filter((s) => s.done && !was.get(s.id)).map((s) => s.id);
}

async function notifyStage(taskId, task, stage) {
  const ids = stage.assigneeIds && stage.assigneeIds.length ? stage.assigneeIds : (task.assigneeIds || []);
  for (const uid of [...new Set(ids.filter(Boolean))]) {
    try {
      const snap = await db.collection('profiles').doc(uid).get();
      const email = snap.data()?.email;
      if (!email) continue;
      await sendMail(
        email,
        `Ready for you: ${task.title}`,
        `<p>A task has reached the <strong>${escapeHtml(stage.name)}</strong> stage and is now with you.</p>` +
        `<p><strong>${escapeHtml(task.title)}</strong></p>` +
        `<p><a href="${APP_URL}/tasks/${taskId}">Open task →</a></p>`,
      );
    } catch (err) {
      // One bad recipient must not stop the handoff itself.
      logger.error(`Stage notification failed for ${uid} on ${taskId}`, err);
    }
  }
}

/**
 * Advance the chain when a stage is signed off.
 *
 * Reassigns the task to the next stage's people so "who is this with?" is
 * answerable from the task's own assignees, exactly as it is for a task with no
 * stages at all. The final sign-off closes the task, which is what makes the
 * chain worth having rather than just a labelled checklist.
 */
exports.onTaskStageAdvanced = onDocumentUpdated(
  { document: 'tasks/{taskId}', region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after || !after.stages || after.stages.length === 0) return;

    const completed = newlyCompleted(before, after);
    if (completed.length === 0) return;

    const taskId = event.params.taskId;
    try {
      const next = currentStage(after.stages);

      if (next) {
        const assignees = next.assigneeIds && next.assigneeIds.length ? next.assigneeIds : (after.assigneeIds || []);
        const participants = [...new Set([after.creatorId, ...(after.watcherIds || []), ...assignees].filter(Boolean))];
        await db.collection(TASKS).doc(taskId).update({
          assigneeIds: assignees,
          participants,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('taskEvents').add({
          taskId, type: 'stage_advanced', actorId: after.stages.find((s) => s.id === completed[0])?.doneBy || null,
          note: `Advanced to “${next.name}”`, createdAt: FieldValue.serverTimestamp(),
        });
        await notifyStage(taskId, after, next);
        logger.info(`onTaskStageAdvanced: ${taskId} → stage "${next.name}"`);
        return;
      }

      if (allComplete(after.stages) && !DONE_TYPES.has(after.statusType)) {
        // Last sign-off closes the task. The status comes from the list's own
        // set, so a custom "Complete" keeps its name and colour.
        const listSnap = after.listId ? await db.collection('taskLists').doc(after.listId).get() : null;
        const setId = listSnap?.data()?.defaultStatusSetId;
        const setSnap = setId ? await db.collection('taskStatusSets').doc(setId).get() : null;
        const statuses = setSnap?.data()?.statuses || [];
        const done = statuses.find((s) => s.type === 'done') || null;
        if (!done) {
          logger.warn(`onTaskStageAdvanced: ${taskId} finished all stages but its list has no 'done' status`);
          return;
        }
        await db.collection(TASKS).doc(taskId).update({
          statusId: done.id, statusName: done.name, statusType: done.type,
          completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('taskEvents').add({
          taskId, type: 'stage_advanced', actorId: null,
          note: 'All stages signed off; task closed', createdAt: FieldValue.serverTimestamp(),
        });
        logger.info(`onTaskStageAdvanced: ${taskId} → all stages complete, task closed`);
      }
    } catch (err) {
      logger.error(`onTaskStageAdvanced failed for ${taskId}`, err);
    }
  },
);

module.exports.currentStage = currentStage;
module.exports.allComplete = allComplete;
module.exports.newlyCompleted = newlyCompleted;
