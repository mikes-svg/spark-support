/**
 * Google Calendar two-way sync — Phase 6 of docs/CLICKUP_MIGRATION_PLAN.md (§8).
 *
 * Shape of this module
 * --------------------
 * Three layers, deliberately separated so the risky parts are testable without
 * a Google account (the OAuth client does not exist yet — the Workspace admin
 * creates it after this lands):
 *
 *   1. Pure functions — loop suppression, field mapping, all-day vs timed,
 *      renewal scheduling. No I/O at all. These hold every rule that can be
 *      silently wrong, and they are what functions/__tests__/gcal.test.js
 *      exercises directly.
 *   2. Dependency-injected operations — take `{ db, transport, config, now }`
 *      and do the actual reads/writes. Tests drive these with a fake transport
 *      and an in-memory db double.
 *   3. Firebase wrappers at the bottom — callables, the task trigger, and the
 *      scheduled renewal. Thin; they only assemble real dependencies.
 *
 * Token storage
 * -------------
 * Refresh tokens live in `gcalConnections/{uid}` and channel secrets in
 * `gcalChannels/{channelId}`. NEITHER collection appears anywhere in
 * firestore.rules, and there is no catch-all `match /{document=**}` — so
 * Firestore's default deny means no client can read them under any role. That
 * is the whole reason connection status reaches the UI through the `gcalStatus`
 * callable instead of a Firestore listener: adding a readable mirror of this
 * document is exactly the mistake that would put a refresh token one rules typo
 * away from the browser.
 *
 * The client id and secret come from this function's environment, never source
 * and never the client bundle — same rule as SUPERADMIN_EMAILS in profile.js.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const crypto = require('crypto');

const { createTransport, buildAuthUrl, CALENDAR_SCOPE } = require('./gcalTransport');

// shared.js calls admin.initializeApp() at require time, so it is loaded lazily:
// the pure layer above must stay importable in a plain `node --test` process
// that has no Firebase credentials.
function shared() {
  return require('./shared');
}

const REGION = 'us-central1';

const GCAL_CONNECTIONS = 'gcalConnections';
const GCAL_CHANNELS = 'gcalChannels';
const TASKS = 'tasks';

/** The calendar we create and own. Users' personal events are never touched. */
const SYNC_CALENDAR_NAME = 'Spark Tasks';

/** A timed task blocks this long; ClickUp had no duration concept and neither do we. */
const DEFAULT_EVENT_MINUTES = 30;

/** Refresh an access token this long before it actually expires. */
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

/** Renew a push channel this long before expiry. Google caps channels at ~7 days. */
const CHANNEL_RENEWAL_LEAD_MS = 48 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Task fields whose change is worth a Google round trip. Deliberately narrow:
 * an assignee or a comment changing must not rewrite the calendar event, or a
 * busy task would burn quota on every edit.
 */
const SYNC_FIELDS = ['title', 'dueDate', 'dueTime', 'statusType'];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure layer
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Add calendar days to a 'YYYY-MM-DD' string.
 *
 * Done entirely in UTC arithmetic on the parsed parts. `new Date(dateStr)`
 * would parse the string as UTC midnight and then render in local time, which
 * is a day early everywhere in the US — the bug src/lib/dates.ts exists to
 * avoid, and it would be just as wrong here.
 */
function addDaysToDateString(dateStr, days) {
  const m = DATE_ONLY.exec(dateStr || '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Add minutes to an 'HH:mm' wall time, returning { time, dayOffset }. */
function addMinutesToTimeString(timeStr, minutes) {
  const m = /^(\d{2}):(\d{2})$/.exec(timeStr || '');
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const dayOffset = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  return { time: `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`, dayOffset };
}

/** Milliseconds from a Firestore Timestamp, an ISO string, a number, or a Date. Null if absent. */
function toMillis(value) {
  if (!value) return null;
  // Google returns channel expirations as epoch-millisecond strings/numbers.
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return null;
}

/** True if any field Google cares about differs between two task snapshots. */
function syncRelevantChange(before, after) {
  if (!after) return false;
  if (!before) return true;
  return SYNC_FIELDS.some((f) => (before[f] ?? null) !== (after[f] ?? null));
}

/** True if this write moved `gcalSyncedAt` forward. */
function syncedAtAdvanced(before, after) {
  const prev = toMillis(before && before.gcalSyncedAt);
  const next = toMillis(after && after.gcalSyncedAt);
  if (next === null) return false;
  if (prev === null) return true;
  return next > prev;
}

/**
 * Loop suppression, portal side — the subtlest rule in the lane.
 *
 * Two kinds of write must NOT be pushed back to Google:
 *
 *   a) our own bookkeeping stamp. After a successful push we write back
 *      { gcalEventId, gcalSyncedAt }. That re-fires this trigger, but it
 *      changes no SYNC_FIELD, so the first clause stops it.
 *
 *   b) a change Google gave us. The webhook applies the incoming title/due date
 *      and bumps `gcalSyncedAt` in the SAME write. So a write that moves both a
 *      sync field and gcalSyncedAt came from Google; the second clause stops it.
 *
 * A genuine portal edit changes a sync field and leaves gcalSyncedAt alone —
 * nothing in the client ever writes that field (it is not in any TaskInput
 * path, and src/lib/tasks.ts does not set it), which is what makes the
 * distinction reliable rather than a timing heuristic. No clock window is
 * involved, so this cannot flap under load or clock skew.
 */
function shouldPushToGoogle(before, after) {
  if (!after) return false;
  if (!syncRelevantChange(before, after)) return false;
  if (syncedAtAdvanced(before, after)) return false;
  return true;
}

/** A done/closed task keeps no calendar event — §8 says completion removes it. */
function isTerminalStatus(statusType) {
  return statusType === 'done' || statusType === 'closed';
}

/**
 * The Google event body for a task, or null when the task should have no event
 * (no due date, or finished).
 *
 * All-day events use `start.date` / `end.date`, and Google's all-day end date is
 * EXCLUSIVE: a task due 2026-09-25 must send end.date 2026-09-26, or the event
 * renders as a zero-length day and disappears from month view.
 */
function eventBodyForTask(task, { timeZone = 'America/Chicago', appUrl = '' } = {}) {
  if (!task || !task.dueDate || isTerminalStatus(task.statusType)) return null;
  if (!DATE_ONLY.test(task.dueDate)) return null;

  const body = {
    summary: task.title || 'Untitled task',
    // The portal is the source of truth for detail; the event carries a link
    // back rather than a copy of the (TipTap JSON) description.
    description: appUrl && task.id ? `${appUrl}/tasks/${task.id}` : undefined,
    // Mapped back by the webhook even if gcalEventId is lost on our side, which
    // makes the reverse direction resilient to a half-finished write.
    extendedProperties: { private: { sparkTaskId: String(task.id || '') } },
  };

  if (task.dueTime && /^(\d{2}):(\d{2})$/.test(task.dueTime)) {
    const end = addMinutesToTimeString(task.dueTime, DEFAULT_EVENT_MINUTES);
    body.start = { dateTime: `${task.dueDate}T${task.dueTime}:00`, timeZone };
    body.end = {
      dateTime: `${addDaysToDateString(task.dueDate, end.dayOffset)}T${end.time}:00`,
      timeZone,
    };
  } else {
    body.start = { date: task.dueDate };
    body.end = { date: addDaysToDateString(task.dueDate, 1) };
  }

  return body;
}

/**
 * The task patch implied by a Google event. Only the two fields §8 lets Google
 * own — title and due date/time. Status, assignees and priority stay portal-only
 * so a calendar edit can never change who owns work.
 *
 * Timed events are read by SLICING the RFC3339 string rather than parsing it:
 * `start.dateTime` already carries the event's own wall time, and Date.parse
 * would convert it to the server's zone and shift the stored day.
 */
function taskPatchFromEvent(event) {
  if (!event) return null;
  const patch = {};
  if (typeof event.summary === 'string' && event.summary.trim()) {
    patch.title = event.summary.trim();
  }

  const start = event.start || {};
  if (start.date && DATE_ONLY.test(start.date)) {
    patch.dueDate = start.date;
    patch.dueTime = null;
  } else if (typeof start.dateTime === 'string' && start.dateTime.length >= 16) {
    const date = start.dateTime.slice(0, 10);
    const time = start.dateTime.slice(11, 16);
    if (DATE_ONLY.test(date) && /^\d{2}:\d{2}$/.test(time)) {
      patch.dueDate = date;
      patch.dueTime = time;
    }
  }

  return Object.keys(patch).length ? patch : null;
}

/**
 * Loop suppression, Google side.
 *
 * Google echoes every event we write back down the push channel, so the webhook
 * must recognise its own reflection. `event.updated` is Google's modification
 * time; if it is not newer than the moment we last pushed, the event state is
 * one we produced. `skewMs` absorbs the small disagreement between Google's
 * clock and Firestore's — without it, a fast round trip could read as a genuine
 * remote edit and ping-pong once.
 *
 * The second guard catches the case where clocks lie outright: if applying the
 * patch would change nothing, there is no reason to write.
 */
function shouldApplyFromGoogle(task, event, { skewMs = 5000 } = {}) {
  if (!task || !event) return false;
  if (event.status === 'cancelled') return false;

  const patch = taskPatchFromEvent(event);
  if (!patch) return false;

  const noop = Object.entries(patch).every(([k, v]) => (task[k] ?? null) === (v ?? null));
  if (noop) return false;

  const syncedAt = toMillis(task.gcalSyncedAt);
  const updated = toMillis(event.updated);
  if (syncedAt !== null && updated !== null && updated <= syncedAt + skewMs) return false;

  return true;
}

/**
 * Whose calendar a task belongs on. `gcalEventId` is a single string by
 * contract, so a task lives on exactly one calendar: the first connected
 * assignee, falling back to the creator. Deterministic ordering matters — a
 * non-deterministic pick would strand events on a calendar nobody reads.
 */
function syncOwnerFor(task, connectedUids) {
  if (!task) return null;
  const connected = new Set(connectedUids || []);
  for (const uid of task.assigneeIds || []) {
    if (connected.has(uid)) return uid;
  }
  if (task.creatorId && connected.has(task.creatorId)) return task.creatorId;
  return null;
}

/**
 * Channels that need renewing. Google caps a watch at ~7 days and stops
 * delivering the instant it lapses — silently, with no error anywhere. Renewing
 * on a lead time rather than at expiry means a failed run has another day of
 * retries before the sync goes quiet.
 */
function channelsDueForRenewal(channels, nowMs, leadMs = CHANNEL_RENEWAL_LEAD_MS) {
  return (channels || []).filter((c) => {
    const expiration = toMillis(c && c.expiration);
    if (expiration === null) return true; // unknown expiry: renew rather than guess
    return expiration - nowMs <= leadMs;
  });
}

/**
 * Constant-time comparison of the channel token Google echoes back.
 *
 * The webhook is a public HTTPS endpoint that mutates tasks, so this is the
 * only thing standing between an anonymous POST and arbitrary task edits. A
 * plain `===` would leak the token a byte at a time under timing analysis.
 */
function verifyChannelToken(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dependency-injected operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OAuth credentials from the environment. Absent config is a deployment
 * mistake, not a user error, so it surfaces as failed-precondition with a
 * message an admin can act on rather than a 500.
 */
function loadConfig(env = process.env) {
  const clientId = env.GCAL_CLIENT_ID || '';
  const clientSecret = env.GCAL_CLIENT_SECRET || '';
  const redirectUri = env.GCAL_REDIRECT_URI || '';
  const webhookUrl = env.GCAL_WEBHOOK_URL || '';
  const timeZone = env.GCAL_TIME_ZONE || 'America/Chicago';
  const appUrl = env.APP_URL || 'https://support.sparkmanage.com';
  return {
    clientId,
    clientSecret,
    redirectUri,
    webhookUrl,
    timeZone,
    appUrl,
    configured: Boolean(clientId && clientSecret && redirectUri),
  };
}

function requireConfig(env) {
  const config = loadConfig(env);
  if (!config.configured) {
    throw new HttpsError(
      'failed-precondition',
      'Google Calendar is not configured on the server. Set GCAL_CLIENT_ID, GCAL_CLIENT_SECRET and GCAL_REDIRECT_URI in the functions environment.'
    );
  }
  return config;
}

/** Thrown when Google has revoked us; the caller clears the connection. */
class GcalRevokedError extends Error {
  constructor(message = 'Google access was revoked') {
    super(message);
    this.name = 'GcalRevokedError';
  }
}

function connectionRef(deps, uid) {
  return deps.db.collection(GCAL_CONNECTIONS).doc(uid);
}

/**
 * A usable access token for `uid`, refreshing when the cached one is within
 * TOKEN_REFRESH_SKEW_MS of expiry.
 *
 * `force` is used by the 401 retry path: Google occasionally rejects a token we
 * still believe is valid (early revocation, a password change), and the only
 * way through is to refresh regardless of the stored expiry.
 */
async function getAccessToken(uid, deps, { force = false } = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const snap = await connectionRef(deps, uid).get();
  const conn = snap.exists ? snap.data() : null;
  if (!conn || !conn.refreshToken) throw new GcalRevokedError('No Google connection for this user');

  const expiresAt = toMillis(conn.accessTokenExpiresAt) ?? 0;
  if (!force && conn.accessToken && expiresAt - now > TOKEN_REFRESH_SKEW_MS) {
    return { accessToken: conn.accessToken, connection: conn };
  }

  const res = await deps.transport.refreshAccessToken({
    clientId: deps.config.clientId,
    clientSecret: deps.config.clientSecret,
    refreshToken: conn.refreshToken,
  });

  if (!res.ok) {
    // invalid_grant is terminal: the user revoked access in their Google
    // account, or the token aged out. Retrying can never succeed, so the
    // connection is marked revoked and the UI can ask them to reconnect.
    const error = res.body && res.body.error;
    if (res.status === 400 || res.status === 401 || error === 'invalid_grant') {
      await markRevoked(uid, deps, error || `token refresh failed (${res.status})`);
      throw new GcalRevokedError(`Google refused the refresh token: ${error || res.status}`);
    }
    throw new Error(`Google token refresh failed with ${res.status}`);
  }

  const accessToken = res.body.access_token;
  const expiresIn = Number(res.body.expires_in || 3600) * 1000;
  const update = {
    accessToken,
    accessTokenExpiresAt: new Date(now + expiresIn).toISOString(),
    status: 'connected',
    lastError: null,
  };
  // Google only returns a refresh token on the first consent; a rotated one
  // (rare, but it happens after a security event) must be persisted or the
  // connection dies at the next refresh.
  if (res.body.refresh_token) update.refreshToken = res.body.refresh_token;

  await connectionRef(deps, uid).set(update, { merge: true });
  return { accessToken, connection: { ...conn, ...update } };
}

/** Flag a connection as needing re-consent, without destroying its history. */
async function markRevoked(uid, deps, reason) {
  await connectionRef(deps, uid).set(
    {
      status: 'revoked',
      accessToken: null,
      accessTokenExpiresAt: null,
      refreshToken: null,
      lastError: String(reason || 'revoked'),
    },
    { merge: true }
  );
}

/**
 * A Calendar call with the one retry that matters: a 401 means the token went
 * stale between our expiry check and Google's, so we force a refresh and try
 * exactly once more. A second 401 is a real authorization failure.
 */
async function callCalendar(uid, request, deps) {
  const { accessToken } = await getAccessToken(uid, deps);
  let res = await deps.transport.calendar({ ...request, accessToken });
  if (res.status !== 401) return res;

  const retry = await getAccessToken(uid, deps, { force: true });
  res = await deps.transport.calendar({ ...request, accessToken: retry.accessToken });
  if (res.status === 401) {
    await markRevoked(uid, deps, 'calendar rejected a freshly refreshed token');
    throw new GcalRevokedError('Google rejected a freshly refreshed token');
  }
  return res;
}

/** The user's "Spark Tasks" calendar, creating it on first use. */
async function ensureSyncCalendar(uid, deps) {
  const snap = await connectionRef(deps, uid).get();
  const existing = snap.exists ? snap.data().calendarId : null;
  if (existing) return existing;

  const res = await callCalendar(
    uid,
    { method: 'POST', path: '/calendars', body: { summary: SYNC_CALENDAR_NAME } },
    deps
  );
  if (!res.ok) throw new Error(`Could not create the ${SYNC_CALENDAR_NAME} calendar (${res.status})`);

  const calendarId = res.body.id;
  await connectionRef(deps, uid).set({ calendarId }, { merge: true });
  return calendarId;
}

/**
 * Push one task to Google and stamp the result back onto the task.
 *
 * The stamp write is what closes the loop: it sets gcalSyncedAt, which both
 * suppresses the trigger it re-fires (no sync field changed) and gives the
 * webhook the "everything up to here came from us" watermark.
 */
async function pushTaskToGoogle(uid, task, deps) {
  const calendarId = await ensureSyncCalendar(uid, deps);
  const body = eventBodyForTask(task, { timeZone: deps.config.timeZone, appUrl: deps.config.appUrl });
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;

  if (!body) {
    // No due date, or the task finished: the event should not exist.
    if (task.gcalEventId) {
      await callCalendar(uid, { method: 'DELETE', path: `${path}/${encodeURIComponent(task.gcalEventId)}` }, deps);
    }
    await stampTask(task.id, { gcalEventId: null }, deps);
    return { action: 'deleted', eventId: null };
  }

  let res;
  if (task.gcalEventId) {
    res = await callCalendar(
      uid,
      { method: 'PATCH', path: `${path}/${encodeURIComponent(task.gcalEventId)}`, body },
      deps
    );
    // 404/410: the user deleted the event in Google. Recreating it is the right
    // answer — the portal is the source of truth for whether the task exists.
    if (res.status === 404 || res.status === 410) {
      res = await callCalendar(uid, { method: 'POST', path, body }, deps);
    }
  } else {
    res = await callCalendar(uid, { method: 'POST', path, body }, deps);
  }

  if (!res.ok) throw new Error(`Google rejected the event write (${res.status})`);

  await stampTask(task.id, { gcalEventId: res.body.id }, deps);
  return { action: task.gcalEventId ? 'updated' : 'created', eventId: res.body.id };
}

/** Write gcalEventId + gcalSyncedAt. Always both, so the watermark can't drift. */
async function stampTask(taskId, fields, deps) {
  await deps.db
    .collection(TASKS)
    .doc(taskId)
    .set({ ...fields, gcalSyncedAt: deps.serverTimestamp() }, { merge: true });
}

/** Remove a task's event, e.g. when the task itself is deleted. */
async function removeTaskEvent(uid, task, deps) {
  if (!task || !task.gcalEventId) return;
  const snap = await connectionRef(deps, uid).get();
  const calendarId = snap.exists ? snap.data().calendarId : null;
  if (!calendarId) return;
  await callCalendar(
    uid,
    {
      method: 'DELETE',
      path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(task.gcalEventId)}`,
    },
    deps
  );
}

/** Every uid with a live connection — the input to syncOwnerFor. */
async function connectedUids(deps) {
  const snap = await deps.db.collection(GCAL_CONNECTIONS).where('status', '==', 'connected').get();
  return snap.docs.map((d) => d.id);
}

/**
 * Open a push channel on the user's Spark Tasks calendar.
 *
 * Each channel gets its own random token. Google echoes it in the
 * `X-Goog-Channel-Token` header on every notification, and gcalWebhook.js
 * refuses anything that does not match — per-channel rather than one global
 * secret, so a leak from one user's channel cannot be replayed against another.
 */
async function startWatchChannel(uid, deps) {
  if (!deps.config.webhookUrl) return null;
  const calendarId = await ensureSyncCalendar(uid, deps);
  const channelId = deps.newId ? deps.newId() : crypto.randomUUID();
  const token = deps.newToken ? deps.newToken() : crypto.randomBytes(32).toString('hex');
  const now = deps.now ? deps.now() : Date.now();

  const res = await callCalendar(
    uid,
    {
      method: 'POST',
      path: `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      body: {
        id: channelId,
        type: 'web_hook',
        address: deps.config.webhookUrl,
        token,
        expiration: String(now + CHANNEL_TTL_MS),
      },
    },
    deps
  );
  if (!res.ok) throw new Error(`Google refused the watch request (${res.status})`);

  const channel = {
    uid,
    calendarId,
    token,
    resourceId: res.body.resourceId || null,
    expiration: Number(res.body.expiration) || now + CHANNEL_TTL_MS,
    createdAt: new Date(now).toISOString(),
  };
  await deps.db.collection(GCAL_CHANNELS).doc(channelId).set(channel);
  await connectionRef(deps, uid).set({ channelId }, { merge: true });
  return { channelId, ...channel };
}

/** Best-effort channel teardown. A dead channel is harmless; a thrown error is not. */
async function stopWatchChannel(uid, channelId, channel, deps) {
  try {
    if (channel && channel.resourceId) {
      await callCalendar(
        uid,
        { method: 'POST', path: '/channels/stop', body: { id: channelId, resourceId: channel.resourceId } },
        deps
      );
    }
  } catch (err) {
    logger.warn(`gcal: could not stop channel ${channelId}`, err);
  }
  await deps.db.collection(GCAL_CHANNELS).doc(channelId).delete();
}

/**
 * Renew every channel inside the lead window. Per-channel failures are isolated
 * so one broken connection cannot stop the rest of the fleet from renewing —
 * the same isolation activateScheduledTickets uses.
 */
async function renewChannels(deps) {
  const snap = await deps.db.collection(GCAL_CHANNELS).get();
  const channels = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const now = deps.now ? deps.now() : Date.now();
  const due = channelsDueForRenewal(channels, now);

  let renewed = 0;
  for (const channel of due) {
    try {
      await stopWatchChannel(channel.uid, channel.id, channel, deps);
      await startWatchChannel(channel.uid, deps);
      renewed += 1;
    } catch (err) {
      logger.error(`gcal: channel renewal failed for ${channel.uid}`, err);
    }
  }
  return { checked: channels.length, due: due.length, renewed };
}

/** Exchange the consent code and open the push channel. */
async function connectAccount({ uid, code, redirectUri, deps }) {
  const res = await deps.transport.exchangeCode({
    clientId: deps.config.clientId,
    clientSecret: deps.config.clientSecret,
    code,
    redirectUri,
  });
  if (!res.ok) {
    throw new HttpsError('permission-denied', `Google refused the authorization code (${res.status})`);
  }
  if (!res.body.refresh_token) {
    // Without a refresh token the connection would work for an hour and then
    // die with no way to renew. Better to fail loudly now.
    throw new HttpsError(
      'failed-precondition',
      'Google did not return a refresh token. Remove the portal from your Google account permissions and connect again.'
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  await connectionRef(deps, uid).set(
    {
      uid,
      refreshToken: res.body.refresh_token,
      accessToken: res.body.access_token || null,
      accessTokenExpiresAt: new Date(now + Number(res.body.expires_in || 3600) * 1000).toISOString(),
      scope: res.body.scope || CALENDAR_SCOPE,
      status: 'connected',
      lastError: null,
      connectedAt: new Date(now).toISOString(),
    },
    { merge: true }
  );

  // A failed watch must not fail the connect: portal → Google still works, and
  // the scheduled renewal picks the channel up on its next pass.
  let channel = null;
  try {
    channel = await startWatchChannel(uid, deps);
  } catch (err) {
    logger.error(`gcal: watch failed for ${uid} right after connect`, err);
  }
  return { connected: true, watching: Boolean(channel) };
}

/** Revoke at Google, stop the channel, and delete every stored secret. */
async function disconnectAccount({ uid, deps }) {
  const snap = await connectionRef(deps, uid).get();
  const conn = snap.exists ? snap.data() : null;
  if (!conn) return { disconnected: true };

  if (conn.channelId) {
    const chSnap = await deps.db.collection(GCAL_CHANNELS).doc(conn.channelId).get();
    await stopWatchChannel(uid, conn.channelId, chSnap.exists ? chSnap.data() : null, deps);
  }
  if (conn.refreshToken) {
    try {
      await deps.transport.revokeToken({ token: conn.refreshToken });
    } catch (err) {
      // Revocation is courtesy; the tokens are about to be deleted regardless.
      logger.warn(`gcal: revoke failed for ${uid}`, err);
    }
  }
  await connectionRef(deps, uid).delete();
  return { disconnected: true };
}

/** The non-secret view of a connection, safe to hand the browser. */
function publicStatus(conn) {
  if (!conn) return { connected: false, status: 'disconnected' };
  return {
    connected: conn.status === 'connected',
    status: conn.status || 'disconnected',
    calendarName: SYNC_CALENDAR_NAME,
    connectedAt: conn.connectedAt || null,
    lastSyncedAt: conn.lastSyncedAt || null,
    watching: Boolean(conn.channelId),
    lastError: conn.lastError || null,
  };
}

/** Assemble real dependencies. Kept in one place so a test can swap all of it. */
function realDeps(env = process.env) {
  const { db, admin } = shared();
  return {
    db,
    config: loadConfig(env),
    transport: createTransport(),
    now: () => Date.now(),
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Firebase wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The consent URL. Built server-side so the client id stays out of the bundle,
 * and so the redirect URI the browser will use is validated against the one
 * registered with Google before the user ever leaves the page.
 */
exports.gcalAuthUrl = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const config = requireConfig();
  const redirectUri = String(request.data?.redirectUri || '');
  if (redirectUri !== config.redirectUri) {
    throw new HttpsError('invalid-argument', 'That redirect URI is not registered for this app.');
  }
  return {
    url: buildAuthUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: String(request.data?.state || ''),
      loginHint: request.auth.token?.email,
    }),
  };
});

exports.gcalConnect = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const config = requireConfig();
  const code = String(request.data?.code || '');
  const redirectUri = String(request.data?.redirectUri || '');
  if (!code) throw new HttpsError('invalid-argument', 'Missing authorization code.');
  if (redirectUri !== config.redirectUri) {
    throw new HttpsError('invalid-argument', 'That redirect URI is not registered for this app.');
  }

  const deps = { ...realDeps(), config };
  return connectAccount({ uid: request.auth.uid, code, redirectUri, deps });
});

exports.gcalDisconnect = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const deps = realDeps();
  return disconnectAccount({ uid: request.auth.uid, deps });
});

/**
 * Connection status for the settings page.
 *
 * A callable rather than a Firestore read on purpose: gcalConnections holds the
 * refresh token and is unreachable from any client by rules. This returns only
 * the fields in publicStatus().
 */
exports.gcalStatus = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const config = loadConfig();
  const { db } = shared();
  const snap = await db.collection(GCAL_CONNECTIONS).doc(request.auth.uid).get();
  return { ...publicStatus(snap.exists ? snap.data() : null), serverConfigured: config.configured };
});

/**
 * Portal → Google. A separate trigger from lane 5's onTaskCreated/onTaskUpdated
 * by design: two v2 triggers can watch the same path, and coupling calendar
 * sync to the notification function would mean a Google outage swallowing
 * someone's assignment email.
 */
exports.onTaskWrittenGcalSync = onDocumentWritten(
  { document: 'tasks/{taskId}', region: REGION },
  async (event) => {
    const config = loadConfig();
    if (!config.configured) return; // nothing to sync to until the admin sets this up

    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const taskId = event.params.taskId;
    const deps = { ...realDeps(), config };

    try {
      const uids = await connectedUids(deps);

      // Deleted: tear the event down on whichever calendar it landed on.
      if (!after) {
        const owner = syncOwnerFor(before, uids);
        if (owner) await removeTaskEvent(owner, { ...before, id: taskId }, deps);
        return;
      }

      if (!shouldPushToGoogle(before, after)) return;

      const owner = syncOwnerFor(after, uids);
      if (!owner) return; // nobody on this task has connected a calendar

      await pushTaskToGoogle(owner, { ...after, id: taskId }, deps);
      await connectionRef(deps, owner).set(
        { lastSyncedAt: new Date(deps.now()).toISOString() },
        { merge: true }
      );
    } catch (err) {
      // Calendar sync is an accessory to the task, never a gate on it: a Google
      // failure is logged and dropped rather than retried into a write storm.
      logger.error(`gcal: sync failed for task ${taskId}`, err);
    }
  }
);

/** Channels expire after ~7 days and fail silently. Renew daily, well ahead. */
exports.renewGcalChannels = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'America/Chicago', region: REGION },
  async () => {
    const config = loadConfig();
    if (!config.configured) return;
    const result = await renewChannels({ ...realDeps(), config });
    logger.info(`gcal: channel renewal — ${JSON.stringify(result)}`);
  }
);

module.exports = Object.assign(module.exports, {
  // Constants
  GCAL_CONNECTIONS,
  GCAL_CHANNELS,
  SYNC_CALENDAR_NAME,
  SYNC_FIELDS,
  CHANNEL_RENEWAL_LEAD_MS,
  CHANNEL_TTL_MS,
  DEFAULT_EVENT_MINUTES,
  // Pure layer
  addDaysToDateString,
  addMinutesToTimeString,
  toMillis,
  syncRelevantChange,
  syncedAtAdvanced,
  shouldPushToGoogle,
  isTerminalStatus,
  eventBodyForTask,
  taskPatchFromEvent,
  shouldApplyFromGoogle,
  syncOwnerFor,
  channelsDueForRenewal,
  verifyChannelToken,
  publicStatus,
  loadConfig,
  // Injected operations
  GcalRevokedError,
  getAccessToken,
  markRevoked,
  callCalendar,
  ensureSyncCalendar,
  pushTaskToGoogle,
  stampTask,
  removeTaskEvent,
  connectedUids,
  startWatchChannel,
  stopWatchChannel,
  renewChannels,
  connectAccount,
  disconnectAccount,
  realDeps,
});
