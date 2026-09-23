#!/usr/bin/env node
/**
 * Seed the Firebase Emulator Suite with a realistic task workspace.
 *
 * Shaped after the real ClickUp workspace this feature replaces (see
 * docs/CLICKUP_MIGRATION_PLAN.md §1) so a walkthrough exercises the cases that
 * actually matter: a status set with a Waiting On state, a pre-live task, an
 * overdue recurring series, subtasks mid-completion, and multi-assignee work.
 *
 * REFUSES TO RUN without FIRESTORE_EMULATOR_HOST set. Pointing a seed script at
 * a production project is the kind of mistake you only make once, so the guard
 * is unconditional rather than a flag.
 *
 *   npm run seed:emulator
 */

const admin = require('firebase-admin');

const REQUIRED = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'];
const missing = REQUIRED.filter((v) => !process.env[v]);
if (missing.length) {
  console.error('\nRefusing to run: ' + missing.join(' and ') + ' not set.');
  console.error('This script only ever writes to the emulators. Start them first:\n');
  console.error('  npm run emulators\n');
  process.exit(1);
}

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'spark-support-28ed9';
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();

// Fixed "today" so the seeded overdue/due-today/upcoming spread stays stable no
// matter when this is run. Matches the date the migration plan was written.
const TODAY = '2026-09-23';
const day = (n) => {
  const d = new Date(Date.UTC(2026, 8, 23) + n * 86400000);
  return d.toISOString().slice(0, 10);
};

const PEOPLE = [
  { id: 'u-mike',   name: 'Mike Sanghvi',       email: 'mikes@sparkmanage.com',   role: 'superadmin' },
  { id: 'u-chloe',  name: "Chloe' Sizer-Clarke", email: 'chloes@sparkmanage.com', role: 'admin' },
  { id: 'u-edita',  name: 'Edita Aleksik',      email: 'editaa@sparkmanage.com',  role: 'user' },
  { id: 'u-michael', name: 'Michael Vaysman',   email: 'michaelv@sparkmanage.com', role: 'admin' },
  { id: 'u-jason',  name: 'Jason Strauss',      email: 'jasons@sparkmanage.com',  role: 'user' },
  { id: 'u-greg',   name: 'Greg Sullivan',      email: 'gregs@sparkmanage.com',   role: 'user' },
];

const S = {
  scheduled: { id: 'st-sched',   name: 'Scheduled',   color: '#9CA3AF', order: 0, type: 'scheduled' },
  todo:      { id: 'st-todo',    name: 'To Do',       color: '#6B7280', order: 1, type: 'todo' },
  active:    { id: 'st-active',  name: 'In Progress', color: '#2563EB', order: 2, type: 'active' },
  waiting:   { id: 'st-waiting', name: 'Waiting On',  color: '#D97706', order: 3, type: 'waiting' },
  done:      { id: 'st-done',    name: 'Complete',    color: '#059669', order: 4, type: 'done' },
  closed:    { id: 'st-closed',  name: 'Closed',      color: '#4B5563', order: 5, type: 'closed' },
};
const STATUSES = Object.values(S);

const SPACES = [
  { id: 'sp-hr',    name: 'Human Resources',  order: 0 },
  { id: 'sp-ops',   name: 'Operations',       order: 1 },
  { id: 'sp-stand', name: 'Standifer Capital', order: 2 },
];

const LISTS = [
  { id: 'li-hr',      spaceId: 'sp-hr',    name: 'HR Checklist',            order: 0 },
  { id: 'li-mkt',     spaceId: 'sp-ops',   name: 'Insurance — Marketing',   order: 1 },
  { id: 'li-general', spaceId: 'sp-ops',   name: 'General',                 order: 2 },
  { id: 'li-mike',    spaceId: 'sp-stand', name: "Mike's To-do",            order: 3 },
];

const TAGS = [
  { id: 'tg-compliance', name: 'Compliance', color: '#DC2626' },
  { id: 'tg-recurring',  name: 'Recurring',  color: '#7C3AED' },
  { id: 'tg-vendor',     name: 'Vendor',     color: '#0891B2' },
];

const sub = (n, title, done) => ({
  id: 's' + n, title, done: !!done, order: n * 100,
  doneAt: done ? admin.firestore.Timestamp.now() : null,
  doneBy: done ? 'u-edita' : null,
});

const desc = (text) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const TASKS = [
  { id: 't-concessions', listId: 'li-general', title: 'Check for Expired Concessions',
    status: S.todo, assigneeIds: ['u-jason'], dueDate: day(-11), priority: 'Medium',
    seriesId: 'ser-concessions', occurrenceKey: day(-11), tagIds: ['tg-recurring'],
    description: desc('Pull the concession report and flag anything past its end date.'),
    subtasks: [sub(1, 'Export the concessions report', true), sub(2, 'Flag expired entries', false), sub(3, 'Email the on-site teams', false)] },

  { id: 't-osha', listId: 'li-hr', title: 'File OSHA Form 300',
    status: S.todo, assigneeIds: ['u-chloe'], dueDate: day(-3), priority: 'High',
    tagIds: ['tg-compliance'], description: desc('Annual filing. Due before the posting deadline.') },

  { id: 't-timeero', listId: 'li-hr', title: 'Bi-Weekly Timeero Review',
    status: S.active, assigneeIds: ['u-chloe'], dueDate: TODAY, priority: 'Medium',
    seriesId: 'ser-timeero', tagIds: ['tg-recurring'],
    subtasks: [sub(1, 'Review flagged punches', true), sub(2, 'Approve timecards', false)] },

  { id: 't-fbmarket', listId: 'li-mkt', title: 'Weekly - Facebook Marketplace Listing Refresh',
    status: S.todo, assigneeIds: ['u-edita'], dueDate: TODAY, priority: null,
    seriesId: 'ser-fb', tagIds: ['tg-recurring'],
    description: desc('Update rent per Jason’s emails, then update specials via ResMan.'),
    subtasks: [sub(1, 'Update rent from Jason’s email', false), sub(2, 'Update specials in ResMan', false)] },

  { id: 't-brochure', listId: 'li-mkt', title: 'Kings View - Brochure',
    status: S.waiting, assigneeIds: ['u-edita'], waitingOnUserId: 'u-chloe',
    dueDate: day(2), priority: 'High', tagIds: ['tg-vendor'],
    description: desc('Waiting on final copy approval before it goes to the printer.') },

  { id: 't-zillow', listId: 'li-mkt', title: 'Zillow 3D Tour - Riverchase',
    status: S.waiting, assigneeIds: ['u-edita'], waitingOnUserId: 'u-greg',
    dueDate: day(5), priority: 'Medium', tagIds: ['tg-vendor'] },

  { id: 't-apts', listId: 'li-mkt', title: 'Apartments - 100% Optimization',
    status: S.active, assigneeIds: ['u-edita', 'u-michael'], dueDate: day(7), priority: 'Medium',
    subtasks: [sub(1, 'Photos', true), sub(2, 'Amenities', true), sub(3, 'Description copy', false)] },

  { id: 't-bonus', listId: 'li-general', title: 'Finalized Q3 2026 On-Site Team Bonus Due',
    status: S.todo, assigneeIds: ['u-jason', 'u-michael', 'u-mike'], dueDate: day(19), priority: 'High' },

  { id: 't-recognition', listId: 'li-hr', title: 'Employee Recognition Programs - AMs',
    status: S.scheduled, assigneeIds: ['u-michael', 'u-mike'], dueDate: day(45),
    goLiveDate: day(14), priority: 'Low',
    description: desc('Pre-live: goes live automatically two weeks out.') },

  { id: 't-holiday', listId: 'li-hr', title: 'Annual - Update Company Holiday Calendar',
    status: S.done, assigneeIds: ['u-chloe'], dueDate: day(-20), priority: 'Medium',
    completedAt: admin.firestore.Timestamp.now() },

  { id: 't-posters', listId: 'li-hr', title: 'Order Annual Labor Law Posters',
    status: S.done, assigneeIds: ['u-chloe'], dueDate: day(-6), priority: 'Low',
    tagIds: ['tg-compliance'], completedAt: admin.firestore.Timestamp.now() },

  { id: 't-rent', listId: 'li-mike', title: 'Office Rent Invoice',
    status: S.todo, assigneeIds: ['u-mike'], dueDate: day(4), priority: 'Medium' },

  { id: 't-godaddy', listId: 'li-mkt', title: 'GoDaddy - Renewal Review',
    status: S.closed, assigneeIds: ['u-chloe'], dueDate: day(-30), priority: null },
];

const SERIES = [
  { id: 'ser-concessions', title: 'Check for Expired Concessions', listId: 'li-general',
    assigneeIds: ['u-jason'], freq: 'weekly', byWeekday: [5], trigger: 'on-schedule',
    carryMode: 'carry-unfinished', missedPolicy: 'skip-to-next', missedCount: 30 },
  { id: 'ser-timeero', title: 'Bi-Weekly Timeero Review', listId: 'li-hr',
    assigneeIds: ['u-chloe'], freq: 'biweekly', byWeekday: [1], trigger: 'on-completion',
    carryMode: 'reset', missedPolicy: 'skip-to-next', missedCount: 0 },
  { id: 'ser-fb', title: 'Weekly - Facebook Marketplace Listing Refresh', listId: 'li-mkt',
    assigneeIds: ['u-edita'], freq: 'weekly', byWeekday: [3], trigger: 'on-completion',
    carryMode: 'reset', missedPolicy: 'skip-to-next', missedCount: 2 },
];

async function main() {
  console.log('Seeding emulator project "' + PROJECT_ID + '"\n');

  // importUsers rather than createUser: the app signs in with signInWithPopup
  // against the GOOGLE provider, and the emulator's account picker only lists
  // users that actually carry google.com provider data. A plain createUser()
  // makes a password user, which shows up as "No Google.com accounts exist" —
  // and signing in through "Add new account" would mint a NEW uid, orphaning
  // every seeded task that references these ids.
  try {
    await auth.importUsers(
      PEOPLE.map((p) => ({
        uid: p.id,
        email: p.email,
        emailVerified: true,
        displayName: p.name,
        providerData: [{ providerId: 'google.com', uid: p.email, email: p.email, displayName: p.name }],
      })),
    );
  } catch (e) {
    if (!/already exists/i.test(e.message || '')) throw e;
  }

  for (const p of PEOPLE) {
    await db.collection('profiles').doc(p.id).set({
      name: p.name, email: p.email, role: p.role, onboardingAccess: true,
      photoURL: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(p.name) + '&background=1B4332&color=D4A843',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  console.log('  profiles + auth users: ' + PEOPLE.length);

  await db.collection('taskStatusSets').doc('set-default').set({
    name: 'Default', statuses: STATUSES, isDefault: true,
  });
  for (const s of SPACES) await db.collection('taskSpaces').doc(s.id).set({ ...s, archived: false });
  for (const l of LISTS) {
    await db.collection('taskLists').doc(l.id).set({ ...l, archived: false, defaultStatusSetId: 'set-default' });
  }
  for (const t of TAGS) await db.collection('taskTags').doc(t.id).set(t);
  console.log('  spaces: ' + SPACES.length + ', lists: ' + LISTS.length + ', tags: ' + TAGS.length + ', 1 status set');

  const batch = db.batch();
  for (const t of TASKS) {
    const list = LISTS.find((l) => l.id === t.listId);
    const assignees = t.assigneeIds || [];
    batch.set(db.collection('tasks').doc(t.id), {
      listId: t.listId,
      spaceId: list.spaceId,
      title: t.title,
      description: t.description || '',
      statusId: t.status.id,
      statusName: t.status.name,
      statusType: t.status.type,
      waitingOnUserId: t.waitingOnUserId || null,
      priority: t.priority || null,
      assigneeIds: assignees,
      creatorId: 'u-mike',
      watcherIds: [],
      participants: [...new Set(['u-mike', ...assignees])],
      startDate: null,
      dueDate: t.dueDate || null,
      goLiveDate: t.goLiveDate || null,
      tagIds: t.tagIds || [],
      subtasks: t.subtasks || [],
      seriesId: t.seriesId || null,
      occurrenceKey: t.occurrenceKey || null,
      completedAt: t.completedAt || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  for (const s of SERIES) {
    batch.set(db.collection('taskSeries').doc(s.id), {
      active: true,
      timezone: 'America/Chicago',
      payload: {
        listId: s.listId, title: s.title, assigneeIds: s.assigneeIds,
        priority: null, tagIds: ['tg-recurring'], subtaskTemplate: [],
      },
      recurrence: { freq: s.freq, interval: 1, byWeekday: s.byWeekday || [], dayOfMonth: null, monthlyMode: 'day-of-month' },
      trigger: s.trigger,
      resetStatusTo: S.todo.id,
      skipWeekends: true,
      weekendShift: 'next',
      startOffsetDays: null,
      carryMode: s.carryMode,
      missedPolicy: s.missedPolicy,
      consecutiveMissed: s.missedCount,
      copyOnRecur: {
        description: true, subtasks: true, subtaskAssignees: true, remapSubtaskDates: true,
        assignees: true, watchers: true, comments: false, tags: true,
        keepCheckedItems: false, attachments: false, activity: false,
      },
      createdBy: 'u-mike',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  console.log('  tasks: ' + TASKS.length + ', series: ' + SERIES.length);

  // Fixed ids, not .add(): everything else here is keyed, so re-running the
  // seed is idempotent — auto-ids would quietly double the comment thread on
  // every run and look like a duplicate-render bug in the app.
  const c = db.collection('taskComments');
  await c.doc('cm-1').set({ taskId: 't-brochure', userId: 'u-edita', body: 'Sent the draft over — waiting on sign-off before it goes to print.', mentionedIds: ['u-chloe'], createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await c.doc('cm-2').set({ taskId: 't-brochure', userId: 'u-chloe', body: 'Looking at it today.', mentionedIds: [], createdAt: admin.firestore.FieldValue.serverTimestamp() });
  const e = db.collection('taskEvents');
  await e.doc('ev-1').set({ taskId: 't-brochure', type: 'created', actorId: 'u-mike', createdAt: admin.firestore.FieldValue.serverTimestamp() });
  // fromStatusId/toStatusId (+Type), NOT fromStatus/toStatus — those are the
  // field names the pinned TaskEvent contract uses and what setStatus() writes.
  // Getting them wrong here renders as "moved this from a status to a status".
  await e.doc('ev-2').set({
    taskId: 't-brochure', type: 'status_changed', actorId: 'u-edita',
    fromStatusId: S.todo.id, fromStatusType: S.todo.type,
    toStatusId: S.waiting.id, toStatusType: S.waiting.type,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('  comments: 2, events: 2');

  console.log('\nDone. Sign in at http://localhost:5176 as any of:');
  PEOPLE.forEach((p) => console.log('  ' + p.email.padEnd(30) + p.role));
  console.log('\nSeeded spread: 2 overdue, 2 due today, 1 pre-live, 2 complete, 1 closed,');
  console.log('2 waiting-on, 3 recurring series (one with 30 missed occurrences).');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
