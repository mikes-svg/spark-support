/**
 * Per-space mute for task notifications.
 *
 * A superadmin can switch task notifications off for a whole space from Task
 * Settings (`taskSpaces/{id}.notificationsMuted = true`). A task doesn't carry
 * its space — only its list — so every mailer resolves task → list → space
 * here before writing to `mail`. The field is absent on every space that
 * predates it, and absent means notifications stay on, so nothing needed a
 * migration.
 *
 * Fails OPEN: if the list or space can't be read, the mail goes out as it
 * always has. A mute is a convenience, and silently dropping mail because of a
 * transient read error would be the worse surprise.
 *
 * `db` is injected rather than required from ./shared so the resolution logic
 * can be unit-tested against a fake without initialising firebase-admin.
 */

const { logger } = require('firebase-functions');

/** True when a space document has notifications switched off. */
function isSpaceMuted(space) {
  return space?.notificationsMuted === true;
}

/** A per-run cache so one trigger or one scheduler pass reads each list and space once. */
function createMuteCache() {
  return { listSpace: new Map(), spaceMuted: new Map() };
}

async function spaceIdForList(db, listId, cache) {
  if (cache.listSpace.has(listId)) return cache.listSpace.get(listId);
  const snap = await db.collection('taskLists').doc(listId).get();
  const spaceId = snap.exists ? snap.data()?.spaceId || null : null;
  cache.listSpace.set(listId, spaceId);
  return spaceId;
}

async function spaceMuted(db, spaceId, cache) {
  if (cache.spaceMuted.has(spaceId)) return cache.spaceMuted.get(spaceId);
  const snap = await db.collection('taskSpaces').doc(spaceId).get();
  const muted = snap.exists ? isSpaceMuted(snap.data()) : false;
  cache.spaceMuted.set(spaceId, muted);
  return muted;
}

/**
 * Whether notifications for this task are muted by its space. Never throws.
 * Pass a `cache` from createMuteCache() when checking many tasks in one run.
 */
async function isTaskInMutedSpace(db, task, cache = createMuteCache()) {
  const listId = task?.listId;
  if (!listId) return false;
  try {
    const spaceId = await spaceIdForList(db, listId, cache);
    if (!spaceId) return false;
    return await spaceMuted(db, spaceId, cache);
  } catch (err) {
    logger.warn(`Could not resolve the space mute for list ${listId}; sending as usual`, err);
    return false;
  }
}

/**
 * Every list id whose space is muted — for the digest, which scans all tasks
 * at once and would otherwise pay a read per task. Never throws; an error
 * yields an empty set, i.e. nothing muted (fail open, as above).
 */
async function mutedListIds(db) {
  try {
    const spacesSnap = await db.collection('taskSpaces').get();
    const mutedSpaces = new Set(spacesSnap.docs.filter((d) => isSpaceMuted(d.data())).map((d) => d.id));
    if (mutedSpaces.size === 0) return new Set();
    const listsSnap = await db.collection('taskLists').get();
    return new Set(listsSnap.docs.filter((d) => mutedSpaces.has(d.data()?.spaceId)).map((d) => d.id));
  } catch (err) {
    logger.warn('Could not load muted spaces for the digest; including every task', err);
    return new Set();
  }
}

module.exports = { isSpaceMuted, createMuteCache, isTaskInMutedSpace, mutedListIds };
