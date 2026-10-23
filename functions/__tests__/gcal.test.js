/**
 * Unit tests for the Google Calendar lane.
 *
 * There is no Google OAuth client yet (the Workspace admin creates it after
 * this lands), so nothing here touches the network. Everything runs against the
 * fake transport below, which is the reason gcalTransport.js exists as a
 * separate module: it is the one seam the whole integration passes through.
 *
 * What is covered is deliberately the set of rules that fail SILENTLY in
 * production — loop suppression, the refresh/401 dance, the webhook's only
 * security check, all-day vs timed mapping, and channel renewal. What is NOT
 * covered, and cannot be until a real account is connected, is the shape of
 * Google's actual responses; every fixture here is hand-written to the
 * documented Calendar v3 schema.
 *
 * Run: node --test functions/__tests__/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const gcal = require('../gcal');
const webhook = require('../gcalWebhook');
const { createTransport } = require('../gcalTransport');

// ─── Doubles ─────────────────────────────────────────────────────────────────

/** Minimal in-memory Firestore: doc get/set(merge)/delete, collection get, where+limit. */
function fakeDb(seed = {}) {
  const store = new Map();
  for (const [col, docs] of Object.entries(seed)) {
    store.set(col, new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }])));
  }
  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  const snapshot = (id, data) => ({ id, exists: data !== undefined, data: () => data });

  function collection(name) {
    const query = (filters, max) => ({
      where: (field, op, value) => query([...filters, { field, op, value }], max),
      limit: (n) => query(filters, n),
      async get() {
        let docs = [...col(name).entries()]
          .filter(([, data]) => filters.every(({ field, op, value }) =>
            op === '==' ? data[field] === value : true))
          .map(([id, data]) => snapshot(id, data));
        if (max !== undefined) docs = docs.slice(0, max);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    });
    return {
      doc: (id) => ({
        async get() { return snapshot(id, col(name).get(id)); },
        async set(data, options) {
          const prev = options && options.merge ? col(name).get(id) || {} : {};
          col(name).set(id, { ...prev, ...data });
        },
        async delete() { col(name).delete(id); },
      }),
      ...query([], undefined),
    };
  }
  collection.raw = store;
  return { collection, _store: store };
}

/**
 * A fake transport with the same surface as createTransport(). `handlers` maps a
 * key — 'refresh', 'exchange', 'revoke', an exact `${method} ${path}`, or
 * 'calendar' as a catch-all — to a response, or to a function of the request.
 * Anything unmatched answers an empty 200, so a test only has to describe the
 * calls it actually cares about. Every call is recorded on `.calls`.
 */
function fakeTransport(handlers = {}) {
  const calls = [];
  const resolve = (keys, req) => {
    for (const key of keys) {
      const h = handlers[key];
      if (h !== undefined) return typeof h === 'function' ? h(req, calls) : h;
    }
    return { status: 200, ok: true, body: {} };
  };
  return {
    calls,
    async exchangeCode(req) { calls.push({ kind: 'exchange', req }); return resolve(['exchange'], req); },
    async refreshAccessToken(req) { calls.push({ kind: 'refresh', req }); return resolve(['refresh'], req); },
    async revokeToken(req) { calls.push({ kind: 'revoke', req }); return resolve(['revoke'], req); },
    async calendar(req) {
      calls.push({ kind: 'calendar', req });
      return resolve([`${req.method} ${req.path}`, 'calendar'], req);
    },
  };
}

const NOW = Date.parse('2026-09-23T12:00:00Z');

function depsWith({ db, transport, now = () => NOW } = {}) {
  return {
    db: db || fakeDb(),
    transport: transport || fakeTransport(),
    config: {
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      redirectUri: 'https://support.sparkmanage.com/settings/calendar',
      webhookUrl: 'https://example.test/gcalWebhook',
      timeZone: 'America/Chicago',
      appUrl: 'https://support.sparkmanage.com',
      configured: true,
    },
    now,
    // Firestore's sentinel is unreadable in a fake, so the double stamps a real
    // ISO instant — which is also what the suppression rules parse in prod.
    serverTimestamp: () => new Date(now()).toISOString(),
    newId: () => 'chan-new',
    newToken: () => 'token-new',
  };
}

// ─── Loop suppression ────────────────────────────────────────────────────────

test('loop suppression: our own stamp write does not re-trigger a push', () => {
  const before = { title: 'Renew insurance', dueDate: '2026-10-01', statusType: 'todo' };
  // Exactly what pushTaskToGoogle writes back after a successful upsert.
  const after = { ...before, gcalEventId: 'ev-1', gcalSyncedAt: '2026-09-23T12:00:00Z' };

  assert.equal(gcal.shouldPushToGoogle(before, after), false);
});

test('loop suppression: a write that came from Google does not bounce back', () => {
  const before = { title: 'Renew insurance', dueDate: '2026-10-01', gcalSyncedAt: '2026-09-23T12:00:00Z' };
  // The webhook moves a sync field AND gcalSyncedAt in one write.
  const after = { title: 'Renew insurance policy', dueDate: '2026-10-02', gcalSyncedAt: '2026-09-23T12:05:00Z' };

  assert.equal(gcal.shouldPushToGoogle(before, after), false);
});

test('a genuine portal edit still pushes', () => {
  const before = { title: 'Renew insurance', dueDate: '2026-10-01', gcalSyncedAt: '2026-09-23T12:00:00Z' };
  // A user edit changes the title and leaves gcalSyncedAt untouched — the whole
  // basis of the distinction.
  const after = { ...before, title: 'Renew flood insurance' };

  assert.equal(gcal.shouldPushToGoogle(before, after), true);
});

test('creating a task pushes; irrelevant field churn does not', () => {
  assert.equal(gcal.shouldPushToGoogle(null, { title: 'New', dueDate: '2026-10-01' }), true);

  const before = { title: 'T', dueDate: '2026-10-01', assigneeIds: ['a'] };
  const after = { title: 'T', dueDate: '2026-10-01', assigneeIds: ['a', 'b'], description: 'x' };
  assert.equal(gcal.shouldPushToGoogle(before, after), false);
});

test('loop suppression, Google side: an event we just wrote is not re-applied', () => {
  const task = { title: 'Old title', dueDate: '2026-10-01', gcalSyncedAt: '2026-09-23T12:00:00Z' };

  // Google's `updated` is not newer than our push watermark => our own echo.
  const echo = { summary: 'New title', start: { date: '2026-10-05' }, updated: '2026-09-23T11:59:58Z' };
  assert.equal(gcal.shouldApplyFromGoogle(task, echo), false);

  // A real later edit by the user in Google Calendar.
  const real = { summary: 'New title', start: { date: '2026-10-05' }, updated: '2026-09-23T12:30:00Z' };
  assert.equal(gcal.shouldApplyFromGoogle(task, real), true);
});

test('an incoming event that changes nothing is not written', () => {
  const task = { title: 'Same', dueDate: '2026-10-01', dueTime: null, gcalSyncedAt: '2026-09-23T10:00:00Z' };
  const event = { summary: 'Same', start: { date: '2026-10-01' }, updated: '2026-09-23T12:30:00Z' };
  assert.equal(gcal.shouldApplyFromGoogle(task, event), false);
});

test('the webhook applying a change stamps gcalSyncedAt in the same write', async () => {
  const deps = depsWith({
    db: fakeDb({
      tasks: { 't1': { title: 'Old', dueDate: '2026-10-01', gcalEventId: 'ev-1', gcalSyncedAt: '2026-09-23T10:00:00Z' } },
    }),
  });
  const event = {
    id: 'ev-1',
    summary: 'Renamed in Google',
    start: { date: '2026-10-09' },
    updated: '2026-09-23T11:55:00Z',
    extendedProperties: { private: { sparkTaskId: 't1' } },
  };

  const result = await webhook.applyEventToTask(event, deps);
  assert.equal(result.applied, true);

  const task = deps.db._store.get('tasks').get('t1');
  assert.equal(task.title, 'Renamed in Google');
  assert.equal(task.dueDate, '2026-10-09');
  // The pairing is what onTaskWrittenGcalSync reads as "came from Google".
  assert.equal(gcal.shouldPushToGoogle(
    { title: 'Old', dueDate: '2026-10-01', gcalSyncedAt: '2026-09-23T10:00:00Z' },
    task,
  ), false);
});

// ─── All-day vs timed mapping ────────────────────────────────────────────────

test('a date-only due date maps to an all-day event with an EXCLUSIVE end date', () => {
  const body = gcal.eventBodyForTask(
    { id: 't1', title: 'File taxes', dueDate: '2026-04-15', statusType: 'todo' },
    { timeZone: 'America/Chicago', appUrl: 'https://support.sparkmanage.com' },
  );

  assert.deepEqual(body.start, { date: '2026-04-15' });
  // Google's all-day end is exclusive: 04-16 renders as a single day on 04-15.
  assert.deepEqual(body.end, { date: '2026-04-16' });
  assert.equal(body.summary, 'File taxes');
  assert.equal(body.extendedProperties.private.sparkTaskId, 't1');
  assert.equal(body.description, 'https://support.sparkmanage.com/tasks/t1');
});

test('a due time maps to a timed event in the configured zone', () => {
  const body = gcal.eventBodyForTask(
    { id: 't2', title: 'Walkthrough', dueDate: '2026-04-15', dueTime: '14:30', statusType: 'active' },
    { timeZone: 'America/Chicago' },
  );

  assert.deepEqual(body.start, { dateTime: '2026-04-15T14:30:00', timeZone: 'America/Chicago' });
  assert.deepEqual(body.end, { dateTime: '2026-04-15T15:00:00', timeZone: 'America/Chicago' });
});

test('a timed event late in the day rolls its end onto the next date', () => {
  const body = gcal.eventBodyForTask(
    { id: 't3', title: 'Late', dueDate: '2026-04-15', dueTime: '23:50', statusType: 'todo' },
    {},
  );
  assert.equal(body.end.dateTime, '2026-04-16T00:20:00');
});

test('month and year boundaries are crossed by string arithmetic, not Date parsing', () => {
  // new Date('2026-02-28') would be UTC midnight and render 02-27 in US zones.
  assert.equal(gcal.addDaysToDateString('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
  assert.equal(gcal.addDaysToDateString('2026-12-31', 1), '2027-01-01');
  assert.equal(gcal.addDaysToDateString('2028-02-28', 1), '2028-02-29'); // leap year
});

test('no due date, or a finished task, means no event', () => {
  assert.equal(gcal.eventBodyForTask({ id: 't', title: 'x', dueDate: null }), null);
  assert.equal(gcal.eventBodyForTask({ id: 't', title: 'x', dueDate: '2026-04-15', statusType: 'done' }), null);
  assert.equal(gcal.eventBodyForTask({ id: 't', title: 'x', dueDate: '2026-04-15', statusType: 'closed' }), null);
});

test('reverse mapping reads the wall time Google sent, not a converted instant', () => {
  assert.deepEqual(
    gcal.taskPatchFromEvent({ summary: 'A', start: { date: '2026-04-15' } }),
    { title: 'A', dueDate: '2026-04-15', dueTime: null },
  );
  // The offset belongs to the event's own zone; slicing keeps 09:00 as 09:00
  // instead of shifting it into the server's timezone.
  assert.deepEqual(
    gcal.taskPatchFromEvent({ summary: 'B', start: { dateTime: '2026-04-15T09:00:00-05:00' } }),
    { title: 'B', dueDate: '2026-04-15', dueTime: '09:00' },
  );
});

test('a completed task has its event deleted', async () => {
  const deps = depsWith({
    db: fakeDb({
      gcalConnections: {
        u1: {
          calendarId: 'cal-1', status: 'connected', refreshToken: 'r', accessToken: 'good',
          accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(),
        },
      },
    }),
    transport: fakeTransport(),
  });
  const result = await gcal.pushTaskToGoogle(
    'u1',
    { id: 't1', title: 'Done thing', dueDate: '2026-04-15', statusType: 'done', gcalEventId: 'ev-9' },
    deps,
  );

  assert.equal(result.action, 'deleted');
  const del = deps.transport.calls.find((c) => c.kind === 'calendar' && c.req.method === 'DELETE');
  assert.ok(del, 'expected a DELETE to Google');
  assert.equal(deps.db._store.get('tasks').get('t1').gcalEventId, null);
});

// ─── Token refresh ───────────────────────────────────────────────────────────

test('an expired access token is refreshed and the new one persisted', async () => {
  const db = fakeDb({
    gcalConnections: {
      u1: {
        refreshToken: 'refresh-1',
        accessToken: 'stale',
        accessTokenExpiresAt: new Date(NOW - 60000).toISOString(), // already expired
        status: 'connected',
      },
    },
  });
  const transport = fakeTransport({
    refresh: { status: 200, ok: true, body: { access_token: 'fresh', expires_in: 3600 } },
  });
  const deps = depsWith({ db, transport });

  const { accessToken } = await gcal.getAccessToken('u1', deps);
  assert.equal(accessToken, 'fresh');

  const stored = db._store.get('gcalConnections').get('u1');
  assert.equal(stored.accessToken, 'fresh');
  assert.equal(Date.parse(stored.accessTokenExpiresAt), NOW + 3600000);
  assert.equal(transport.calls.filter((c) => c.kind === 'refresh').length, 1);
});

test('a still-valid access token is reused without hitting Google', async () => {
  const deps = depsWith({
    db: fakeDb({
      gcalConnections: {
        u1: {
          refreshToken: 'r', accessToken: 'good',
          accessTokenExpiresAt: new Date(NOW + 30 * 60000).toISOString(),
          status: 'connected',
        },
      },
    }),
  });

  const { accessToken } = await gcal.getAccessToken('u1', deps);
  assert.equal(accessToken, 'good');
  assert.equal(deps.transport.calls.length, 0);
});

test('a rotated refresh token is persisted, not dropped', async () => {
  const db = fakeDb({
    gcalConnections: {
      u1: { refreshToken: 'old', accessTokenExpiresAt: new Date(NOW - 1).toISOString(), status: 'connected' },
    },
  });
  const deps = depsWith({
    db,
    transport: fakeTransport({
      refresh: { status: 200, ok: true, body: { access_token: 'a', expires_in: 3600, refresh_token: 'rotated' } },
    }),
  });

  await gcal.getAccessToken('u1', deps);
  assert.equal(db._store.get('gcalConnections').get('u1').refreshToken, 'rotated');
});

test('invalid_grant marks the connection revoked and clears every secret', async () => {
  const db = fakeDb({
    gcalConnections: {
      u1: { refreshToken: 'revoked-at-google', accessTokenExpiresAt: new Date(NOW - 1).toISOString(), status: 'connected' },
    },
  });
  const deps = depsWith({
    db,
    transport: fakeTransport({ refresh: { status: 400, ok: false, body: { error: 'invalid_grant' } } }),
  });

  await assert.rejects(() => gcal.getAccessToken('u1', deps), gcal.GcalRevokedError);

  const stored = db._store.get('gcalConnections').get('u1');
  assert.equal(stored.status, 'revoked');
  assert.equal(stored.refreshToken, null);
  assert.equal(stored.accessToken, null);
});

test('a 401 from Calendar forces one refresh and retries exactly once', async () => {
  let calendarCalls = 0;
  const transport = fakeTransport({
    refresh: { status: 200, ok: true, body: { access_token: 'fresh', expires_in: 3600 } },
    calendar: () => {
      calendarCalls += 1;
      return calendarCalls === 1
        ? { status: 401, ok: false, body: { error: 'unauthorized' } }
        : { status: 200, ok: true, body: { id: 'ev-1' } };
    },
  });
  const deps = depsWith({
    db: fakeDb({
      gcalConnections: {
        u1: { refreshToken: 'r', accessToken: 'good', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected' },
      },
    }),
    transport,
  });

  const res = await gcal.callCalendar('u1', { method: 'GET', path: '/calendars/x/events' }, deps);
  assert.equal(res.status, 200);
  assert.equal(calendarCalls, 2);
  assert.equal(transport.calls.filter((c) => c.kind === 'refresh').length, 1);
  // The retry used the refreshed token, not the stale one.
  const retried = transport.calls.filter((c) => c.kind === 'calendar').pop();
  assert.equal(retried.req.accessToken, 'fresh');
});

test('a second 401 after a fresh token is a real revocation, not an infinite retry', async () => {
  const deps = depsWith({
    db: fakeDb({
      gcalConnections: {
        u1: { refreshToken: 'r', accessToken: 'good', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected' },
      },
    }),
    transport: fakeTransport({
      refresh: { status: 200, ok: true, body: { access_token: 'fresh', expires_in: 3600 } },
      calendar: { status: 401, ok: false, body: {} },
    }),
  });

  await assert.rejects(
    () => gcal.callCalendar('u1', { method: 'GET', path: '/calendars/x/events' }, deps),
    gcal.GcalRevokedError,
  );
  assert.equal(deps.db._store.get('gcalConnections').get('u1').status, 'revoked');
});

// ─── Webhook authentication ──────────────────────────────────────────────────

function fakeRes() {
  const out = {};
  return {
    out,
    status(code) { out.status = code; return this; },
    send(body) { out.body = body; return this; },
  };
}

const CHANNEL = { uid: 'u1', calendarId: 'cal-1', token: 'secret-token-value', resourceId: 'res-1', expiration: NOW + 86400000 };

test('an unauthenticated POST is rejected and mutates nothing', async () => {
  const db = fakeDb({
    gcalChannels: { 'chan-1': { ...CHANNEL } },
    tasks: { t1: { title: 'Untouched', dueDate: '2026-10-01', gcalEventId: 'ev-1' } },
  });
  const deps = depsWith({ db });
  const res = fakeRes();

  // No token header at all — the shape of a drive-by POST at the public URL.
  const result = await webhook.handleWebhook(
    { headers: { 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'exists' } },
    res,
    deps,
  );

  assert.equal(res.out.status, 403);
  assert.equal(result.rejected, 'bad channel token');
  assert.equal(deps.transport.calls.length, 0, 'a rejected request must not even call Google');
  assert.deepEqual(db._store.get('tasks').get('t1'), { title: 'Untouched', dueDate: '2026-10-01', gcalEventId: 'ev-1' });
});

test('a wrong channel token is rejected', async () => {
  const deps = depsWith({ db: fakeDb({ gcalChannels: { 'chan-1': { ...CHANNEL } } }) });
  const res = fakeRes();

  await webhook.handleWebhook(
    { headers: { 'x-goog-channel-id': 'chan-1', 'x-goog-channel-token': 'secret-token-valuX', 'x-goog-resource-state': 'exists' } },
    res,
    deps,
  );
  assert.equal(res.out.status, 403);
});

test('an unknown channel answers 404 so Google stops delivering', async () => {
  const deps = depsWith({ db: fakeDb({ gcalChannels: {} }) });
  const res = fakeRes();

  await webhook.handleWebhook(
    { headers: { 'x-goog-channel-id': 'ghost', 'x-goog-channel-token': 'anything' } },
    res,
    deps,
  );
  assert.equal(res.out.status, 404);
});

test('a resource-id mismatch is rejected even with a valid token', async () => {
  const deps = depsWith({ db: fakeDb({ gcalChannels: { 'chan-1': { ...CHANNEL } } }) });
  const res = fakeRes();

  await webhook.handleWebhook(
    {
      headers: {
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': CHANNEL.token,
        'x-goog-resource-id': 'someone-elses-resource',
        'x-goog-resource-state': 'exists',
      },
    },
    res,
    deps,
  );
  assert.equal(res.out.status, 403);
});

test('token comparison rejects a length-prefix guess without throwing', () => {
  // timingSafeEqual throws on unequal lengths — the guard must handle that.
  assert.equal(gcal.verifyChannelToken('secret', 'secret-token-value'), false);
  assert.equal(gcal.verifyChannelToken('', ''), false);
  assert.equal(gcal.verifyChannelToken(undefined, 'x'), false);
  assert.equal(gcal.verifyChannelToken('secret-token-value', 'secret-token-value'), true);
});

test("Google's opening sync handshake is acknowledged without doing work", async () => {
  const deps = depsWith({ db: fakeDb({ gcalChannels: { 'chan-1': { ...CHANNEL } } }) });
  const res = fakeRes();

  const result = await webhook.handleWebhook(
    {
      headers: {
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': CHANNEL.token,
        'x-goog-resource-id': 'res-1',
        'x-goog-resource-state': 'sync',
      },
    },
    res,
    deps,
  );

  assert.equal(res.out.status, 200);
  assert.equal(result.handshake, true);
  assert.equal(deps.transport.calls.length, 0);
});

test('an authorized notification pulls changes and applies them', async () => {
  const db = fakeDb({
    gcalChannels: { 'chan-1': { ...CHANNEL, syncToken: 'sync-1' } },
    gcalConnections: { u1: { refreshToken: 'r', accessToken: 'good', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected', calendarId: 'cal-1' } },
    tasks: { t1: { title: 'Old', dueDate: '2026-10-01', gcalEventId: 'ev-1', gcalSyncedAt: '2026-09-23T10:00:00Z' } },
  });
  const deps = depsWith({
    db,
    transport: fakeTransport({
      'GET /calendars/cal-1/events': {
        status: 200, ok: true,
        body: {
          items: [{
            id: 'ev-1', summary: 'Moved in Google', start: { date: '2026-10-20' },
            updated: '2026-09-23T11:59:00Z',
            extendedProperties: { private: { sparkTaskId: 't1' } },
          }],
          nextSyncToken: 'sync-2',
        },
      },
    }),
  });
  const res = fakeRes();

  const result = await webhook.handleWebhook(
    {
      headers: {
        'x-goog-channel-id': 'chan-1', 'x-goog-channel-token': CHANNEL.token,
        'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'exists',
      },
    },
    res,
    deps,
  );

  assert.equal(res.out.status, 200);
  assert.equal(result.applied[0].applied, true);
  assert.equal(db._store.get('tasks').get('t1').dueDate, '2026-10-20');
  // The sync token advances, so the next pull is incremental.
  assert.equal(db._store.get('gcalChannels').get('chan-1').syncToken, 'sync-2');
});

test('a cancelled event clears the pointer but never deletes the task', async () => {
  const deps = depsWith({
    db: fakeDb({ tasks: { t1: { title: 'Still here', dueDate: '2026-10-01', gcalEventId: 'ev-1' } } }),
  });

  await webhook.applyEventToTask(
    { id: 'ev-1', status: 'cancelled', extendedProperties: { private: { sparkTaskId: 't1' } } },
    deps,
  );

  const task = deps.db._store.get('tasks').get('t1');
  assert.equal(task.gcalEventId, null);
  assert.equal(task.title, 'Still here');
});

// ─── Channel renewal ─────────────────────────────────────────────────────────

test('channels inside the lead window are due for renewal, later ones are not', () => {
  const channels = [
    { id: 'soon', expiration: NOW + 12 * 3600000 },
    { id: 'edge', expiration: NOW + gcal.CHANNEL_RENEWAL_LEAD_MS },
    { id: 'later', expiration: NOW + 6 * 86400000 },
    { id: 'lapsed', expiration: NOW - 3600000 },
    { id: 'unknown' }, // no expiry recorded: renew rather than guess
  ];

  const due = gcal.channelsDueForRenewal(channels, NOW).map((c) => c.id);
  assert.deepEqual(due, ['soon', 'edge', 'lapsed', 'unknown']);
});

test('renewal stops the old channel, opens a new one, and rewires the connection', async () => {
  const db = fakeDb({
    gcalChannels: { 'chan-old': { uid: 'u1', calendarId: 'cal-1', token: 't', resourceId: 'res-1', expiration: NOW + 3600000 } },
    gcalConnections: {
      u1: { refreshToken: 'r', accessToken: 'good', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected', calendarId: 'cal-1', channelId: 'chan-old' },
    },
  });
  const deps = depsWith({
    db,
    transport: fakeTransport({
      'POST /channels/stop': { status: 204, ok: true, body: null },
      'POST /calendars/cal-1/events/watch': {
        status: 200, ok: true,
        body: { id: 'chan-new', resourceId: 'res-2', expiration: String(NOW + gcal.CHANNEL_TTL_MS) },
      },
    }),
  });

  const result = await gcal.renewChannels(deps);
  assert.deepEqual(result, { checked: 1, due: 1, renewed: 1 });

  assert.equal(db._store.get('gcalChannels').has('chan-old'), false);
  const fresh = db._store.get('gcalChannels').get('chan-new');
  assert.equal(fresh.uid, 'u1');
  assert.equal(fresh.resourceId, 'res-2');
  assert.equal(fresh.token, 'token-new', 'each channel gets its own fresh secret');
  assert.equal(fresh.expiration, NOW + gcal.CHANNEL_TTL_MS);
  assert.equal(db._store.get('gcalConnections').get('u1').channelId, 'chan-new');
});

test('one failing renewal does not abort the rest of the fleet', async () => {
  const db = fakeDb({
    gcalChannels: {
      bad: { uid: 'u1', calendarId: 'cal-1', token: 't', resourceId: 'r1', expiration: NOW + 3600000 },
      good: { uid: 'u2', calendarId: 'cal-2', token: 't', resourceId: 'r2', expiration: NOW + 3600000 },
    },
    gcalConnections: {
      u1: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected', calendarId: 'cal-1' },
      u2: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected', calendarId: 'cal-2' },
    },
  });
  const deps = depsWith({
    db,
    transport: fakeTransport({
      'POST /channels/stop': { status: 204, ok: true, body: null },
      'POST /calendars/cal-1/events/watch': { status: 500, ok: false, body: {} },
      'POST /calendars/cal-2/events/watch': {
        status: 200, ok: true, body: { id: 'chan-new', resourceId: 'res-2', expiration: String(NOW + gcal.CHANNEL_TTL_MS) },
      },
    }),
  });

  const result = await gcal.renewChannels(deps);
  assert.equal(result.due, 2);
  assert.equal(result.renewed, 1);
});

test('a new channel carries a random per-channel token, not a shared secret', async () => {
  const deps = depsWith({
    db: fakeDb({
      gcalConnections: {
        u1: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), status: 'connected', calendarId: 'cal-1' },
      },
    }),
    transport: fakeTransport({
      'POST /calendars/cal-1/events/watch': (req) => ({
        status: 200, ok: true,
        body: { id: req.body.id, resourceId: 'res-1', expiration: req.body.expiration },
      }),
    }),
  });

  const channel = await gcal.startWatchChannel('u1', deps);
  const watchCall = deps.transport.calls.find((c) => c.kind === 'calendar' && c.req.path.endsWith('/watch'));
  assert.equal(watchCall.req.body.token, channel.token);
  assert.equal(watchCall.req.body.address, deps.config.webhookUrl);
  assert.equal(watchCall.req.body.type, 'web_hook');
});

// ─── Ownership, connect/disconnect, config ───────────────────────────────────

test('a task syncs to the first connected assignee, falling back to the creator', () => {
  const task = { assigneeIds: ['u2', 'u3'], creatorId: 'u1' };
  assert.equal(gcal.syncOwnerFor(task, ['u1', 'u3']), 'u3');
  assert.equal(gcal.syncOwnerFor(task, ['u3', 'u2']), 'u2', 'assignee order, not connection order, decides');
  assert.equal(gcal.syncOwnerFor(task, ['u1']), 'u1');
  assert.equal(gcal.syncOwnerFor(task, []), null);
});

test('connect refuses a grant that came back without a refresh token', async () => {
  const deps = depsWith({
    transport: fakeTransport({ exchange: { status: 200, ok: true, body: { access_token: 'a', expires_in: 3600 } } }),
  });

  await assert.rejects(
    () => gcal.connectAccount({ uid: 'u1', code: 'c', redirectUri: deps.config.redirectUri, deps }),
    /refresh token/i,
  );
});

test('disconnect revokes at Google and deletes the stored connection', async () => {
  const db = fakeDb({
    gcalConnections: { u1: { refreshToken: 'r', channelId: 'chan-1', status: 'connected', accessToken: 'a', accessTokenExpiresAt: new Date(NOW + 3600000).toISOString(), calendarId: 'cal-1' } },
    gcalChannels: { 'chan-1': { uid: 'u1', resourceId: 'res-1', token: 't', calendarId: 'cal-1' } },
  });
  const deps = depsWith({ db, transport: fakeTransport({ 'POST /channels/stop': { status: 204, ok: true, body: null } }) });

  await gcal.disconnectAccount({ uid: 'u1', deps });

  assert.equal(db._store.get('gcalConnections').has('u1'), false);
  assert.equal(db._store.get('gcalChannels').has('chan-1'), false);
  assert.ok(deps.transport.calls.some((c) => c.kind === 'revoke'));
});

test('the status payload carries no secrets', () => {
  const status = gcal.publicStatus({
    refreshToken: 'SHOULD-NEVER-LEAVE-THE-SERVER',
    accessToken: 'ALSO-SECRET',
    status: 'connected',
    connectedAt: '2026-09-01T00:00:00Z',
    lastSyncedAt: '2026-09-23T11:00:00Z',
    channelId: 'chan-1',
  });

  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('SHOULD-NEVER-LEAVE-THE-SERVER'));
  assert.ok(!serialized.includes('ALSO-SECRET'));
  assert.equal(status.connected, true);
  assert.equal(status.watching, true);
});

test('missing OAuth config reads as unconfigured rather than half-working', () => {
  assert.equal(gcal.loadConfig({}).configured, false);
  assert.equal(gcal.loadConfig({ GCAL_CLIENT_ID: 'a', GCAL_CLIENT_SECRET: 'b' }).configured, false);
  assert.equal(
    gcal.loadConfig({ GCAL_CLIENT_ID: 'a', GCAL_CLIENT_SECRET: 'b', GCAL_REDIRECT_URI: 'https://x/y' }).configured,
    true,
  );
});

// ─── Transport ───────────────────────────────────────────────────────────────

test('the transport returns non-2xx as data instead of throwing', async () => {
  const transport = createTransport({
    fetchImpl: async () => ({ status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) }),
  });

  const res = await transport.calendar({ method: 'GET', path: '/calendars/x/events', accessToken: 't' });
  assert.equal(res.status, 401);
  assert.equal(res.ok, false);
  assert.equal(res.body.error, 'unauthorized');
});

test('the transport sends the bearer token and JSON body Google expects', async () => {
  let seen;
  const transport = createTransport({
    fetchImpl: async (url, init) => { seen = { url, init }; return { status: 200, text: async () => '{"id":"ev-1"}' }; },
  });

  await transport.calendar({
    method: 'POST', path: '/calendars/cal%201/events', accessToken: 'tok', body: { summary: 'x' },
  });

  assert.ok(seen.url.endsWith('/calendar/v3/calendars/cal%201/events'));
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.body, '{"summary":"x"}');
});

test('a 204 with an empty body does not crash the parser', async () => {
  const transport = createTransport({ fetchImpl: async () => ({ status: 204, text: async () => '' }) });
  const res = await transport.calendar({ method: 'DELETE', path: '/calendars/x/events/y', accessToken: 't' });
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
});
