/**
 * Cloud Functions for Spark Support
 *
 * - sendTicketReminders: scheduled every 24 hours. For each ticket with status
 *   'Open' or 'In Progress' that is at least 24 hours old, email all assignees
 *   a reminder. Tracks `lastReminderAt` on each ticket to avoid duplicate emails.
 *
 * - activateScheduledTickets: runs every 5 minutes. For each ticket with status
 *   'Scheduled' whose `scheduledFor` date has passed, flip it to 'Open' as if
 *   freshly submitted (reset createdAt, restore assignees to participants),
 *   log the 'created' audit event, and email the assignees.
 *
 * Both handlers commit all of a ticket's writes in a single atomic WriteBatch,
 * and isolate per-ticket failures, so a partial failure can't half-apply
 * (re-spamming reminders or dropping a scheduled ticket's notifications) and one
 * bad ticket can't abort the rest of the run.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
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

// ─── Role assignment (server-authoritative) ──────────────────────────────────
// Roles are decided HERE, never by the client, so an authenticated user can't
// elevate their own profile. The allowlist lives in this function's environment
// (SUPERADMIN_EMAILS / ADMIN_EMAILS, comma-separated) — set via functions config,
// NOT in the shipped client bundle.

const ROLE_RANK = { user: 0, admin: 1, superadmin: 2 };

function highestRole(roles) {
  let best = 'user';
  for (const r of roles) {
    const norm = typeof r === 'string' ? r.toLowerCase() : r;
    if (ROLE_RANK[norm] !== undefined && ROLE_RANK[norm] > ROLE_RANK[best]) best = norm;
  }
  return best;
}

function envEmails(name) {
  return (process.env[name] || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function allowlistRole(email) {
  if (envEmails('SUPERADMIN_EMAILS').includes(email)) return 'superadmin';
  if (envEmails('ADMIN_EMAILS').includes(email)) return 'admin';
  return 'user';
}

function nameFromEmail(email) {
  return (
    email.split('@')[0].split(/[._-]/).filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || email
  );
}

/**
 * Called by the client on sign-in. Creates or self-heals the caller's profile
 * with a SERVER-decided role (env allowlist or the highest pre-registration
 * invite), migrates/cleans any pre-reg email-slug duplicates, and returns the
 * profile. Throws `permission-denied` for uninvited, non-allowlisted accounts.
 */
exports.ensureProfile = onCall({ region: REGION }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const uid = auth.uid;
  const token = auth.token || {};
  const email = (token.email || '').toLowerCase();
  if (!email) throw new HttpsError('failed-precondition', 'Account has no email.');

  const profileRef = db.collection('profiles').doc(uid);
  const profileSnap = await profileRef.get();

  // Pre-registration / duplicate docs created by a superadmin under an
  // email-slug id, to be migrated into this UID profile.
  const dupSnap = await db.collection('profiles').where('email', '==', email).get();
  const dupes = dupSnap.docs.filter((d) => d.id !== uid);

  const allow = allowlistRole(email);
  const firstTime = !profileSnap.exists;

  // Gate: a brand-new account that was neither invited (no pre-reg dupe) nor on
  // the allowlist is denied — no profile is created.
  if (firstTime && dupes.length === 0 && allow === 'user') {
    throw new HttpsError('permission-denied', 'not-invited');
  }

  const existing = profileSnap.exists ? profileSnap.data() : {};
  const dupeRoles = dupes.map((d) => d.data().role);
  const role = highestRole([existing.role, allow, ...dupeRoles]);

  const dupeName = dupes.map((d) => d.data().name).find(Boolean);
  const name = token.name || existing.name || dupeName || nameFromEmail(email);
  const photoURL = token.picture || existing.photoURL ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1B4332&color=D4A843`;

  const data = { name, email, photoURL, role };
  if (firstTime) data.createdAt = admin.firestore.FieldValue.serverTimestamp();
  await profileRef.set(data, { merge: true });

  // Migrate then remove pre-reg duplicates.
  if (dupes.length) {
    const batch = db.batch();
    dupes.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  return { id: uid, name, email, photoURL, role };
});

exports.sendTicketReminders = onSchedule(
  {
    schedule: 'every 24 hours',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
  },
  async () => {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Query open/in-progress tickets
    const ticketsSnap = await db
      .collection('tickets')
      .where('status', 'in', ['Open', 'In Progress'])
      .get();

    logger.info(`Checking ${ticketsSnap.size} open/in-progress tickets`);

    let remindersSent = 0;

    for (const ticketDoc of ticketsSnap.docs) {
      try {
        const ticket = ticketDoc.data();
        const createdAt = ticket.createdAt?.toDate?.() || new Date(ticket.createdAt);
        const lastReminderAt = ticket.lastReminderAt?.toDate?.();

        // Skip tickets younger than 24h
        if (createdAt > dayAgo) continue;

        // Skip if reminded in the last 24h
        if (lastReminderAt && lastReminderAt > dayAgo) continue;

        const emails = await emailsForAssignees(getAssigneeIds(ticket));
        if (emails.length === 0) continue;

        // Calculate days open
        const daysOpen = Math.floor((now - createdAt.getTime()) / (1000 * 60 * 60 * 24));
        const title = escapeHtml(ticket.title);
        const status = escapeHtml(ticket.status);
        const priority = escapeHtml(ticket.priority);

        // All mail docs + the dedup timestamp commit atomically: a partial
        // failure can't leave lastReminderAt stale and re-spam on the next run.
        const batch = db.batch();
        for (const email of emails) {
          batch.set(db.collection('mail').doc(), {
            to: email,
            message: {
              subject: `Reminder: ${ticketDoc.id} is still ${ticket.status}`,
              html: `
                <p>This is a reminder that ticket <strong>${ticketDoc.id}</strong> — ${title} — is still <strong>${status}</strong> after ${daysOpen} day${daysOpen === 1 ? '' : 's'}.</p>
                <p>Priority: <strong>${priority}</strong></p>
                <p><a href="${APP_URL}/tickets/${ticketDoc.id}">View ticket →</a></p>
                <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>
                <p style="color:#9ca3af;font-size:12px">Please do not reply to this email. To respond, <a href="${APP_URL}/tickets/${ticketDoc.id}">click here to view the ticket</a>.</p>
              `,
            },
          });
        }
        batch.update(ticketDoc.ref, {
          lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await batch.commit();
        remindersSent += emails.length;
      } catch (err) {
        logger.error(`Reminder failed for ticket ${ticketDoc.id}`, err);
      }
    }

    logger.info(`Sent ${remindersSent} reminder emails`);
  }
);

exports.activateScheduledTickets = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
  },
  async () => {
    const now = admin.firestore.Timestamp.now();

    const snap = await db
      .collection('tickets')
      .where('status', '==', 'Scheduled')
      .where('scheduledFor', '<=', now)
      .get();

    logger.info(`Found ${snap.size} scheduled tickets due to go live`);

    let activated = 0;

    for (const ticketDoc of snap.docs) {
      try {
        const ticket = ticketDoc.data();
        const assigneeIds = getAssigneeIds(ticket);
        const participants = [...new Set([ticket.submitterId, ...assigneeIds].filter(Boolean))];
        const emails = await emailsForAssignees(assigneeIds);
        const title = escapeHtml(ticket.title);

        // One atomic batch: status flip + audit event + every assignee email.
        // Either the ticket goes live with its notifications, or nothing changes
        // and the next run retries cleanly — no half-activated tickets, no
        // duplicate 'created' events, no dropped notifications.
        const batch = db.batch();

        // Go live: behave like a same-day submission — reset createdAt so the
        // reminder clock starts now, restore assignees to participants so they
        // can see the ticket, and clear the now-stale scheduledFor.
        batch.update(ticketDoc.ref, {
          status: 'Open',
          participants,
          scheduledFor: admin.firestore.FieldValue.delete(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Audit 'created' now so analytics clock from the go-live date.
        batch.set(db.collection('ticketEvents').doc(), {
          ticketId: ticketDoc.id,
          type: 'created',
          actorId: ticket.submitterId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Notify assignees, mirroring the submit-time assignment email.
        for (const email of emails) {
          batch.set(db.collection('mail').doc(), {
            to: email,
            message: {
              subject: `New ${ticket.priority} ticket: ${ticket.title}`,
              html: `<p>A new support request has been assigned to you.</p><p><strong>${ticketDoc.id}</strong> — ${title}</p><p><a href="${APP_URL}/tickets/${ticketDoc.id}">View ticket →</a></p>`,
            },
          });
        }

        await batch.commit();
        activated++;
      } catch (err) {
        logger.error(`Activation failed for ticket ${ticketDoc.id}`, err);
      }
    }

    logger.info(`Activated ${activated} scheduled tickets`);
  }
);
