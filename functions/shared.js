/**
 * Shared plumbing for every Cloud Functions module.
 *
 * This file owns the single `admin.initializeApp()` call — it is required by
 * profile.js, tickets.js, and onboarding.js, and Node's module cache makes sure
 * it runs exactly once no matter which of them loads first. Nothing here is
 * ticket- or task-specific; anything that is belongs in its own module.
 */

const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'us-central1';
const APP_URL = 'https://support.sparkmanage.com';

/**
 * Normalize a ticket's assignees across old (assigneeId) and new (assigneeIds) schemas.
 */
function getAssigneeIds(ticket) {
  if (Array.isArray(ticket.assigneeIds)) return ticket.assigneeIds.filter(Boolean);
  if (ticket.assigneeId) return [ticket.assigneeId];
  return [];
}

/**
 * Escape values interpolated into email HTML so a crafted ticket title (free
 * text from the submitter) can't inject markup or links into mail sent to staff.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Resolve assignee profile ids to a deduped list of emails. */
async function emailsForAssignees(assigneeIds) {
  if (assigneeIds.length === 0) return [];
  const docs = await Promise.all(
    assigneeIds.map((id) => db.collection('profiles').doc(id).get())
  );
  return [...new Set(docs.map((d) => d.data()?.email).filter(Boolean))];
}

/** Queue a single email via the Trigger Email extension's `mail` collection. */
async function sendMail(to, subject, html) {
  if (!to) return;
  await db.collection('mail').add({ to, message: { subject, html } });
}

/**
 * Today as 'YYYY-MM-DD' in the given timezone. Onboarding dates are calendar
 * days stored as strings, so "today" has to be resolved in the office's zone —
 * toISOString() would answer in UTC and roll the date over hours early.
 */
function todayInTimeZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Whole calendar days between two 'YYYY-MM-DD' strings (to - from). */
function daysBetweenDateStrings(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

module.exports = {
  admin,
  db,
  REGION,
  APP_URL,
  getAssigneeIds,
  escapeHtml,
  emailsForAssignees,
  sendMail,
  todayInTimeZone,
  daysBetweenDateStrings,
};
