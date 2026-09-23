/**
 * Google → Portal: the push-notification receiver and the incremental pull it
 * triggers (§8.4 of docs/CLICKUP_MIGRATION_PLAN.md).
 *
 * How the push protocol actually works, because it shapes everything here:
 * Google's notification carries NO event data. It is a bare POST with headers
 * saying "something on this resource changed". The body is empty. So a
 * notification is only a prompt to go and read the changes ourselves, via
 * events.list with the channel's sync token.
 *
 * Security posture. This is a public, unauthenticated HTTPS endpoint that can
 * modify tasks, which makes the channel-token check the entire security
 * boundary. Every request must present `X-Goog-Channel-Token` matching the
 * random per-channel secret we minted in gcal.js, compared in constant time. A
 * request that fails that check is answered 403 and mutates NOTHING — it does
 * not even trigger a pull, so an attacker cannot use the endpoint to make us
 * burn quota either.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

const {
  GCAL_CHANNELS,
  callCalendar,
  shouldApplyFromGoogle,
  taskPatchFromEvent,
  verifyChannelToken,
  loadConfig,
  realDeps,
} = require('./gcal');

const REGION = 'us-central1';
const TASKS = 'tasks';

/** Read a header case-insensitively from either an Express req or a plain object. */
function header(req, name) {
  if (!req) return '';
  if (typeof req.get === 'function') return req.get(name) || '';
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || '';
}

/**
 * Authenticate a notification against the stored channel.
 *
 * Returns a verdict rather than writing a response, so the decision is
 * testable on its own and so there is exactly one place that can get it wrong.
 * An unknown channel answers 404 on purpose: that is Google's documented signal
 * to stop delivering, which cleans up channels we lost track of (e.g. a
 * connection deleted while a channel was still live).
 */
function authorizeNotification(req, channel) {
  const channelId = header(req, 'x-goog-channel-id');
  if (!channelId) return { ok: false, status: 400, reason: 'missing channel id' };
  if (!channel) return { ok: false, status: 404, reason: 'unknown channel' };
  if (!verifyChannelToken(header(req, 'x-goog-channel-token'), channel.token || '')) {
    return { ok: false, status: 403, reason: 'bad channel token' };
  }
  // Google re-delivers with the same resource id for the life of a channel; a
  // mismatch means the notification does not belong to this channel.
  const resourceId = header(req, 'x-goog-resource-id');
  if (channel.resourceId && resourceId && resourceId !== channel.resourceId) {
    return { ok: false, status: 403, reason: 'resource id mismatch' };
  }
  return { ok: true, status: 200, channelId };
}

/** Find the task an event belongs to, preferring the id we stamped on the event. */
async function findTaskForEvent(event, deps) {
  const stamped = event?.extendedProperties?.private?.sparkTaskId;
  if (stamped) {
    const snap = await deps.db.collection(TASKS).doc(String(stamped)).get();
    if (snap.exists) return { id: snap.id, ...snap.data() };
  }
  if (event?.id) {
    // Falls back to the pointer on our side, which covers events created before
    // extendedProperties existed on them.
    const q = await deps.db.collection(TASKS).where('gcalEventId', '==', event.id).limit(1).get();
    const doc = q.docs[0];
    if (doc) return { id: doc.id, ...doc.data() };
  }
  return null;
}

/**
 * Apply one incoming event to its task.
 *
 * A cancelled event clears `gcalEventId` and leaves the task alone. Deleting an
 * event in Google must NOT delete the task: a calendar is a view of the work,
 * not the record of it, and an accidental swipe in the Google Calendar app
 * would otherwise destroy a task and its whole audit trail.
 */
async function applyEventToTask(event, deps) {
  const task = await findTaskForEvent(event, deps);
  if (!task) return { applied: false, reason: 'no matching task' };

  if (event.status === 'cancelled') {
    await deps.db
      .collection(TASKS)
      .doc(task.id)
      .set({ gcalEventId: null, gcalSyncedAt: deps.serverTimestamp() }, { merge: true });
    return { applied: true, taskId: task.id, reason: 'event cancelled' };
  }

  if (!shouldApplyFromGoogle(task, event)) {
    return { applied: false, taskId: task.id, reason: 'suppressed (our own write)' };
  }

  const patch = taskPatchFromEvent(event);
  // gcalSyncedAt moves in the SAME write as the fields: that pairing is what
  // onTaskWrittenGcalSync reads as "this change came from Google", and it is
  // what stops the change bouncing straight back out again.
  await deps.db
    .collection(TASKS)
    .doc(task.id)
    .set({ ...patch, gcalSyncedAt: deps.serverTimestamp() }, { merge: true });
  return { applied: true, taskId: task.id, patch };
}

/**
 * Pull everything that changed on a channel's calendar and apply it.
 *
 * Uses a sync token when we have one. Google answers 410 GONE when a token has
 * aged out; the documented recovery is to discard it and do a full resync, so
 * that is what happens rather than the sync quietly stopping.
 */
async function pullChannelChanges(channelId, channel, deps) {
  const path = `/calendars/${encodeURIComponent(channel.calendarId)}/events`;
  const results = [];
  let pageToken;
  let syncToken = channel.syncToken || null;
  let nextSyncToken = null;

  for (let page = 0; page < 10; page += 1) {
    const query = syncToken
      ? { syncToken, pageToken, showDeleted: 'true' }
      : { updatedMin: channel.lastPulledAt || undefined, pageToken, showDeleted: 'true', singleEvents: 'true' };

    let res = await callCalendar(channel.uid, { method: 'GET', path, query }, deps);

    if (res.status === 410 && syncToken) {
      logger.info(`gcal: sync token expired for channel ${channelId}, falling back to a full resync`);
      syncToken = null;
      pageToken = undefined;
      continue;
    }
    if (!res.ok) throw new Error(`events.list failed with ${res.status}`);

    for (const event of res.body.items || []) {
      try {
        results.push(await applyEventToTask(event, deps));
      } catch (err) {
        // Per-event isolation: one malformed event must not abandon the rest of
        // the page, the same way activateScheduledTickets isolates per record.
        logger.error(`gcal: could not apply event ${event.id}`, err);
      }
    }

    pageToken = res.body.nextPageToken;
    if (res.body.nextSyncToken) nextSyncToken = res.body.nextSyncToken;
    if (!pageToken) break;
  }

  const now = deps.now ? deps.now() : Date.now();
  await deps.db
    .collection(GCAL_CHANNELS)
    .doc(channelId)
    .set(
      { syncToken: nextSyncToken || channel.syncToken || null, lastPulledAt: new Date(now).toISOString() },
      { merge: true }
    );

  return results;
}

/**
 * The whole request handler, with `deps` injected so a test can drive it with a
 * fake transport and an in-memory Firestore.
 */
async function handleWebhook(req, res, deps) {
  const channelId = header(req, 'x-goog-channel-id');
  const channelSnap = channelId
    ? await deps.db.collection(GCAL_CHANNELS).doc(String(channelId)).get()
    : { exists: false };
  const channel = channelSnap.exists ? channelSnap.data() : null;

  const verdict = authorizeNotification(req, channel);
  if (!verdict.ok) {
    logger.warn(`gcal webhook: rejected (${verdict.reason})`);
    res.status(verdict.status).send(verdict.reason);
    return { applied: [], rejected: verdict.reason };
  }

  // Google opens every channel with a `sync` notification that means nothing
  // more than "the channel is live". Acknowledge and do no work.
  if (header(req, 'x-goog-resource-state') === 'sync') {
    res.status(200).send('ok');
    return { applied: [], handshake: true };
  }

  try {
    const applied = await pullChannelChanges(String(channelId), channel, deps);
    res.status(200).send('ok');
    return { applied };
  } catch (err) {
    logger.error(`gcal webhook: pull failed for channel ${channelId}`, err);
    // 200 on purpose. Google retries a non-2xx with backoff for hours; the next
    // real change will prompt another pull anyway, and the sync token means
    // nothing is lost by declining this one.
    res.status(200).send('deferred');
    return { applied: [], error: String(err && err.message) };
  }
}

exports.gcalWebhook = onRequest({ region: REGION }, async (req, res) => {
  const config = loadConfig();
  if (!config.configured) {
    res.status(503).send('calendar sync not configured');
    return;
  }
  await handleWebhook(req, res, { ...realDeps(), config });
});

module.exports = Object.assign(module.exports, {
  header,
  authorizeNotification,
  findTaskForEvent,
  applyEventToTask,
  pullChannelChanges,
  handleWebhook,
});
