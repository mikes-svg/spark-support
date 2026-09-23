/**
 * Cloud Functions for Spark Support — entry point.
 *
 * This file is re-exports ONLY. The implementations live in:
 *
 *   shared.js      admin.initializeApp(), db, REGION, APP_URL and the helpers
 *                  every module needs (escapeHtml, sendMail, date maths).
 *   profile.js     ensureProfile, getTicketAttachments.
 *   tickets.js     the ticket digest, the scheduled-ticket activator, and the
 *                  three notification triggers.
 *   onboarding.js  the property-onboarding overdue digest.
 *
 * Every export below must keep its exact name: Firebase deploys functions by
 * export name, so renaming one here deletes the deployed function and creates a
 * new one — losing its schedule, its triggers, and any pending retries.
 *
 * Adding a module (tasks.js, recurrence.js, gcal.js) means adding a require and
 * its re-exports here, and nothing else.
 */

const profile = require('./profile');
const tickets = require('./tickets');
const onboarding = require('./onboarding');

// ─── profile.js ──────────────────────────────────────────────────────────────
exports.ensureProfile = profile.ensureProfile;
exports.getTicketAttachments = profile.getTicketAttachments;

// ─── tickets.js ──────────────────────────────────────────────────────────────
exports.sendTicketReminders = tickets.sendTicketReminders;
exports.activateScheduledTickets = tickets.activateScheduledTickets;
exports.onTicketCreated = tickets.onTicketCreated;
exports.onTicketUpdated = tickets.onTicketUpdated;
exports.onCommentCreated = tickets.onCommentCreated;

// ─── onboarding.js ───────────────────────────────────────────────────────────
exports.sendOnboardingReminders = onboarding.sendOnboardingReminders;
