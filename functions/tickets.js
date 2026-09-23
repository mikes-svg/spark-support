/**
 * Everything ticket-shaped: the daily digest, the scheduled-ticket activator,
 * and the three notification triggers.
 *
 * activateScheduledTickets commits each ticket's writes in a single atomic
 * WriteBatch and isolates per-ticket failures, so a partial failure can't
 * half-apply (dropping a scheduled ticket's notifications) and one bad ticket
 * can't abort the rest of the run. The digest isolates per-recipient failures
 * so one bad address can't abort a run.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const {
  admin,
  db,
  REGION,
  APP_URL,
  getAssigneeIds,
  escapeHtml,
  emailsForAssignees,
  sendMail,
} = require('./shared');

/** Absolute URL to a ticket detail page. */
function ticketLink(ticketId) {
  return `${APP_URL}/tickets/${ticketId}`;
}

exports.sendTicketReminders = onSchedule(
  {
    // Fixed 7am send (like sendOnboardingReminders) rather than 'every 24 hours',
    // which anchors to deploy time and drifted the digest to ~9pm.
    schedule: 'every day 07:00',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
  },
  async () => {
    const now = Date.now();

    // Every open/in-progress ticket. Grouped by assignee below into one digest
    // per person, rather than one email per ticket.
    const ticketsSnap = await db
      .collection('tickets')
      .where('status', 'in', ['Open', 'In Progress'])
      .get();

    // assignee id -> the tickets assigned to them. A ticket with two assignees
    // lands in both digests; an unassigned ticket has no recipient and is skipped.
    const byPerson = new Map();
    for (const ticketDoc of ticketsSnap.docs) {
      const ticket = ticketDoc.data();
      const assigneeIds = getAssigneeIds(ticket);
      if (assigneeIds.length === 0) continue;
      const entry = {
        id: ticketDoc.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt?.toDate?.() || new Date(ticket.createdAt),
      };
      for (const personId of assigneeIds) {
        if (!byPerson.has(personId)) byPerson.set(personId, []);
        byPerson.get(personId).push(entry);
      }
    }

    logger.info(`Ticket digest: ${ticketsSnap.size} open/in-progress tickets for ${byPerson.size} assignees`);

    // Sort each digest most-urgent first, then longest-open first.
    const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
    let sent = 0;

    for (const [personId, tickets] of byPerson) {
      try {
        const [email] = await emailsForAssignees([personId]);
        if (!email) continue;

        tickets.sort((a, b) => {
          const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
          return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
        });

        const rows = tickets.map((t) => {
          const daysOpen = Math.floor((now - t.createdAt.getTime()) / (1000 * 60 * 60 * 24));
          return (
            `<li><a href="${APP_URL}/tickets/${t.id}">${escapeHtml(t.id)}</a> — ${escapeHtml(t.title)} ` +
            `(<strong>${escapeHtml(t.status)}</strong>, ${escapeHtml(t.priority)} priority, ` +
            `open ${daysOpen} day${daysOpen === 1 ? '' : 's'})</li>`
          );
        });

        await sendMail(
          email,
          `Your open tickets: ${tickets.length} still need attention`,
          `<p>You have <strong>${tickets.length}</strong> open ticket${tickets.length === 1 ? '' : 's'} assigned to you:</p>` +
          `<ul>${rows.join('')}</ul>` +
          `<p><a href="${APP_URL}/">Open My Tickets →</a></p>` +
          `<hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>` +
          `<p style="color:#9ca3af;font-size:12px">This is your daily summary. Please do not reply to this email.</p>`,
        );
        sent++;
      } catch (err) {
        logger.error(`Ticket digest failed for ${personId}`, err);
      }
    }

    logger.info(`Sent ${sent} ticket digest emails`);
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

// ─── Notification triggers (server-authoritative email) ──────────────────────
// All ticket email is sent from these Firestore triggers, so the client never
// writes to the `mail` collection (rules forbid it) — closing the open-relay
// surface. User-supplied text is HTML-escaped before interpolation.

exports.onTicketCreated = onDocumentCreated(
  { document: 'tickets/{ticketId}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ticket = snap.data();
    const ticketId = event.params.ticketId;
    const link = ticketLink(ticketId);
    const safeTitle = escapeHtml(ticket.title);
    const safeType = escapeHtml(ticket.type);
    const safePriority = escapeHtml(ticket.priority);

    try {
      const submitterDoc = await db.collection('profiles').doc(ticket.submitterId).get();
      const submitterEmail = submitterDoc.data()?.email;

      if (ticket.status === 'Scheduled') {
        // Assignees are notified on go-live (activateScheduledTickets); just
        // confirm the schedule to the submitter.
        if (submitterEmail && ticket.scheduledFor?.toDate) {
          const goLive = ticket.scheduledFor.toDate().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
          await sendMail(
            submitterEmail,
            `Your request ${ticketId} is scheduled for ${goLive}`,
            `<p>Your support request has been scheduled and will go live on <strong>${escapeHtml(goLive)}</strong>. Assignees will be notified then.</p><p><strong>${ticketId}</strong> — ${safeTitle}</p><p>Priority: ${safePriority} · Type: ${safeType}</p><p><a href="${link}">View ticket →</a></p>`,
          );
        }
        return;
      }

      // Open ticket: confirm to the submitter, then notify each assignee.
      if (submitterEmail) {
        await sendMail(
          submitterEmail,
          `Your request ${ticketId} has been submitted`,
          `<p>Your support request has been submitted successfully.</p><p><strong>${ticketId}</strong> — ${safeTitle}</p><p>Priority: ${safePriority} · Type: ${safeType}</p><p><a href="${link}">View ticket →</a></p>`,
        );
      }
      const emails = await emailsForAssignees(getAssigneeIds(ticket));
      for (const email of emails) {
        await sendMail(
          email,
          `New ${ticket.priority} ticket: ${ticket.title}`,
          `<p>A new support request has been assigned to you.</p><p><strong>${ticketId}</strong> — ${safeTitle}</p><p><a href="${link}">View ticket →</a></p>`,
        );
      }
    } catch (err) {
      logger.error(`onTicketCreated mail failed for ${ticketId}`, err);
    }
  }
);

exports.onTicketUpdated = onDocumentUpdated(
  { document: 'tickets/{ticketId}', region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    const ticketId = event.params.ticketId;
    const link = ticketLink(ticketId);
    const safeTitle = escapeHtml(after.title);

    try {
      // Status change → notify the submitter. Skip the Scheduled→Open go-live
      // flip, which activateScheduledTickets already handles for assignees.
      if (before.status !== after.status && before.status !== 'Scheduled') {
        const submitterDoc = await db.collection('profiles').doc(after.submitterId).get();
        const submitterEmail = submitterDoc.data()?.email;
        if (submitterEmail) {
          await sendMail(
            submitterEmail,
            `${ticketId} status changed to ${after.status}`,
            `<p>Your ticket <strong>${ticketId}</strong> — ${safeTitle} — has been updated to <strong>${escapeHtml(after.status)}</strong>.</p><p><a href="${link}">View ticket →</a></p>`,
          );
        }
      }

      // Newly added assignees → notify them (not while still scheduled).
      if (after.status !== 'Scheduled') {
        const beforeIds = getAssigneeIds(before);
        const afterIds = getAssigneeIds(after);
        const added = afterIds.filter((id) => !beforeIds.includes(id));
        const emails = await emailsForAssignees(added);
        for (const email of emails) {
          await sendMail(
            email,
            `${ticketId} has been assigned to you`,
            `<p>Ticket <strong>${ticketId}</strong> — ${safeTitle} — has been assigned to you.</p><p><a href="${link}">View ticket →</a></p>`,
          );
        }
      }
    } catch (err) {
      logger.error(`onTicketUpdated mail failed for ${ticketId}`, err);
    }
  }
);

exports.onCommentCreated = onDocumentCreated(
  { document: 'comments/{commentId}', region: REGION },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const c = snap.data();

    try {
      const ticketSnap = await db.collection('tickets').doc(c.ticketId).get();
      if (!ticketSnap.exists) return;
      const ticket = ticketSnap.data();
      const link = ticketLink(c.ticketId);

      const authorDoc = await db.collection('profiles').doc(c.userId).get();
      const authorName = authorDoc.data()?.name || 'Someone';
      const safeName = escapeHtml(authorName);
      const safeBody = escapeHtml(c.body || '');

      const mentioned = Array.isArray(c.mentionedIds) ? c.mentionedIds : [];
      const participants = Array.isArray(ticket.participants) ? ticket.participants : [];
      const recipientIds = [...new Set([...participants, ...mentioned])].filter((id) => id && id !== c.userId);

      for (const rid of recipientIds) {
        const rdoc = await db.collection('profiles').doc(rid).get();
        const email = rdoc.data()?.email;
        if (!email) continue;
        const wasMentioned = mentioned.includes(rid);
        const subject = wasMentioned
          ? `${authorName} mentioned you on ${c.ticketId}: ${ticket.title}`
          : `New comment on ${c.ticketId}: ${ticket.title}`;
        const lead = wasMentioned
          ? `<p><strong>${safeName}</strong> mentioned you in a comment on <strong>${c.ticketId}</strong>:</p>`
          : `<p><strong>${safeName}</strong> commented on <strong>${c.ticketId}</strong>:</p>`;
        await sendMail(
          email,
          subject,
          `${lead}<p>${safeBody}</p><p><a href="${link}">View ticket →</a></p><hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/><p style="color:#9ca3af;font-size:12px">Please do not reply to this email. To respond, <a href="${link}">click here to view the ticket</a> and add your comment there.</p>`,
        );
      }
    } catch (err) {
      logger.error('onCommentCreated mail failed', err);
    }
  }
);

