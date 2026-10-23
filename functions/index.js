/**
 * Cloud Functions for Spark Support — entry point.
 *
 * This file is re-exports ONLY. The implementations live in:
 *
 *   shared.js            admin.initializeApp(), db, REGION, APP_URL and the
 *                        helpers every module needs (escapeHtml, sendMail, date maths).
 *   profile.js           ensureProfile, getTicketAttachments.
 *   tickets.js           the scheduled-ticket activator and the three ticket
 *                        notification triggers.
 *   onboarding.js        property-onboarding helpers.
 *   digest.js            the single 07:00 "Your morning brief".
 *   taskNotifications.js task create/update/comment triggers.
 *   tasksRecurring.js    the recurring-task generator and previewRecurrence.
 *   scheduledTasks.js    pre-live (statusType 'scheduled') task activation.
 *   gcal.js              Google Calendar OAuth, sync and channel renewal.
 *   gcalWebhook.js       the Google push receiver.
 *   reassign.js          the superadmin mass-reassignment callable.
 *
 * Every export below must keep its exact name: Firebase deploys functions by
 * export name, so renaming one here deletes the deployed function and creates a
 * new one — losing its schedule, its triggers, and any pending retries.
 *
 * DELIBERATELY NOT EXPORTED ANY MORE: `sendTicketReminders` and
 * `sendOnboardingReminders`. Both were 07:00 schedules, and tasks would have
 * made a third — three emails every morning to the same dozen people.
 * `digest.sendMorningBrief` reproduces all three sections in one send. The next
 * deploy DELETES those two scheduled functions, which is the intent; their
 * bodies remain in tickets.js / onboarding.js only because other exports there
 * still use the same module.
 */

const profile = require('./profile');
const tickets = require('./tickets');
const onboarding = require('./onboarding');
const digest = require('./digest');
const taskNotifications = require('./taskNotifications');
const tasksRecurring = require('./tasksRecurring');
const scheduledTasks = require('./scheduledTasks');
const gcal = require('./gcal');
const gcalWebhook = require('./gcalWebhook');
const reassign = require('./reassign');
const adminIds = require('./adminIds');
const taskStages = require('./taskStages');

// ─── profile.js ──────────────────────────────────────────────────────────────
exports.ensureProfile = profile.ensureProfile;
exports.getTicketAttachments = profile.getTicketAttachments;

// ─── tickets.js ──────────────────────────────────────────────────────────────
exports.activateScheduledTickets = tickets.activateScheduledTickets;
exports.onTicketCreated = tickets.onTicketCreated;
exports.onTicketUpdated = tickets.onTicketUpdated;
exports.onCommentCreated = tickets.onCommentCreated;

// ─── digest.js ───────────────────────────────────────────────────────────────
// The ONLY 07:00 scheduled function. See the note above before adding another.
exports.sendMorningBrief = digest.sendMorningBrief;

// ─── taskNotifications.js ────────────────────────────────────────────────────
exports.onTaskCreated = taskNotifications.onTaskCreated;
exports.onTaskUpdated = taskNotifications.onTaskUpdated;
exports.onTaskCommentCreated = taskNotifications.onTaskCommentCreated;

// ─── tasksRecurring.js ───────────────────────────────────────────────────────
exports.generateRecurringTasks = tasksRecurring.generateRecurringTasks;
exports.onTaskCompletedRecurrence = tasksRecurring.onTaskCompletedRecurrence;
exports.previewRecurrence = tasksRecurring.previewRecurrence;

// ─── scheduledTasks.js ───────────────────────────────────────────────────────
exports.activateScheduledTasks = scheduledTasks.activateScheduledTasks;

// ─── gcal.js / gcalWebhook.js ────────────────────────────────────────────────
// All no-op while the GCAL_* env vars are unset, so these are safe to deploy
// before the OAuth client exists. onTaskWrittenGcalSync is deliberately SEPARATE
// from taskNotifications' triggers on the same path: merging them would let a
// Google outage swallow assignment emails.
exports.gcalAuthUrl = gcal.gcalAuthUrl;
exports.gcalConnect = gcal.gcalConnect;
exports.gcalDisconnect = gcal.gcalDisconnect;
exports.gcalStatus = gcal.gcalStatus;
exports.onTaskWrittenGcalSync = gcal.onTaskWrittenGcalSync;
exports.renewGcalChannels = gcal.renewGcalChannels;
exports.gcalWebhook = gcalWebhook.gcalWebhook;

// ─── reassign.js ─────────────────────────────────────────────────────────────
exports.reassignWork = reassign.reassignWork;

// ─── adminIds.js ─────────────────────────────────────────────────────────────
// Maintains meta/adminIds, which firestore.rules reads to decide whether a
// ticket still has a Manager assigned. backfillAdminIds builds it the first
// time; the trigger keeps it current after that.
exports.syncAdminIds = adminIds.syncAdminIds;
exports.backfillAdminIds = adminIds.backfillAdminIds;

// ─── taskStages.js ───────────────────────────────────────────────────────────
// Sequential sign-off chains: advancing the baton and closing the task on the
// final sign-off happen server-side so a closed laptop cannot strand a task.
exports.onTaskStageAdvanced = taskStages.onTaskStageAdvanced;
