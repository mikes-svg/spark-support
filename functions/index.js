/**
 * Cloud Functions for Spark Support
 *
 * - sendTicketReminders: scheduled every 24 hours. For each ticket with status
 *   'Open' or 'In Progress' that is at least 24 hours old, email all assignees
 *   a reminder. Tracks `lastReminderAt` on each ticket to avoid duplicate emails.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const APP_URL = 'https://support.sparkmanage.com';

/**
 * Normalize a ticket's assignees across old (assigneeId) and new (assigneeIds) schemas.
 */
function getAssigneeIds(ticket) {
  if (Array.isArray(ticket.assigneeIds)) return ticket.assigneeIds.filter(Boolean);
  if (ticket.assigneeId) return [ticket.assigneeId];
  return [];
}

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
      const ticket = ticketDoc.data();
      const createdAt = ticket.createdAt?.toDate?.() || new Date(ticket.createdAt);
      const lastReminderAt = ticket.lastReminderAt?.toDate?.();

      // Skip tickets younger than 24h
      if (createdAt > dayAgo) continue;

      // Skip if reminded in the last 24h
      if (lastReminderAt && lastReminderAt > dayAgo) continue;

      const assigneeIds = getAssigneeIds(ticket);
      if (assigneeIds.length === 0) continue;

      // Fetch assignee emails
      const assigneeDocs = await Promise.all(
        assigneeIds.map((id) => db.collection('profiles').doc(id).get())
      );

      const emails = assigneeDocs
        .map((d) => d.data()?.email)
        .filter(Boolean);

      if (emails.length === 0) continue;

      // Calculate days open
      const daysOpen = Math.floor((now - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      for (const email of emails) {
        await db.collection('mail').add({
          to: email,
          message: {
            subject: `Reminder: ${ticketDoc.id} is still ${ticket.status}`,
            html: `
              <p>This is a reminder that ticket <strong>${ticketDoc.id}</strong> — ${ticket.title} — is still <strong>${ticket.status}</strong> after ${daysOpen} day${daysOpen === 1 ? '' : 's'}.</p>
              <p>Priority: <strong>${ticket.priority}</strong></p>
              <p><a href="${APP_URL}/tickets/${ticketDoc.id}">View ticket →</a></p>
              <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>
              <p style="color:#9ca3af;font-size:12px">Please do not reply to this email. To respond, <a href="${APP_URL}/tickets/${ticketDoc.id}">click here to view the ticket</a>.</p>
            `,
          },
        });
        remindersSent++;
      }

      // Mark the reminder timestamp
      await ticketDoc.ref.update({ lastReminderAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    logger.info(`Sent ${remindersSent} reminder emails`);
  }
);
