/**
 * Property-onboarding reminders: one daily digest per person listing every
 * unfinished task of theirs whose due date has passed, grouped by property.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const {
  db,
  APP_URL,
  escapeHtml,
  emailsForAssignees,
  sendMail,
  todayInTimeZone,
  daysBetweenDateStrings,
} = require('./shared');

const ONBOARDING_TZ = 'America/Chicago';

/**
 * Daily overdue digest for property onboarding. Sends ONE email per person
 * listing every unfinished task of theirs whose due date has passed, grouped by
 * property. A task with two responsible people appears in both digests; a
 * person with nothing overdue gets no mail. Per-recipient failures are isolated
 * so one bad address can't abort the run.
 */
exports.sendOnboardingReminders = onSchedule(
  {
    schedule: 'every day 07:00',
    timeZone: ONBOARDING_TZ,
    region: 'us-central1',
  },
  async () => {
    const today = todayInTimeZone(ONBOARDING_TZ);

    const tasksSnap = await db
      .collection('onboardingTasks')
      .where('status', 'in', ['Not Started', 'In Progress'])
      .where('dueDate', '<', today)
      .get();

    // Strictly before today, matching isOverdue() in src/lib/onboarding.ts — a
    // task due today is not yet late, and a digest that counted it would
    // contradict the zero the app shows the recipient.
    //
    // Due dates are 'YYYY-MM-DD' STRINGS and Firestore orders null before every
    // string, so the range above also returns every undated task. Filter them
    // out here — without this, tasks that were never scheduled would be emailed
    // as overdue every single morning, forever.
    const dated = tasksSnap.docs.filter((d) => {
      const dueDate = d.data().dueDate;
      return typeof dueDate === 'string' && dueDate !== '';
    });

    // Resolve each referenced property once; archived and deleted properties
    // drop out of the digest entirely.
    const propertyIds = [...new Set(dated.map((d) => d.data().propertyId).filter(Boolean))];
    const properties = new Map();
    if (propertyIds.length) {
      const refs = propertyIds.map((id) => db.collection('onboardingProperties').doc(id));
      const snaps = await db.getAll(...refs);
      for (const snap of snaps) {
        if (snap.exists && snap.data().archived !== true) properties.set(snap.id, snap.data());
      }
    }

    // person id -> overdue tasks
    const byPerson = new Map();
    let overdueCount = 0;
    for (const doc of dated) {
      const task = doc.data();
      if (!properties.has(task.propertyId)) continue;
      const responsibleIds = Array.isArray(task.responsibleIds) ? task.responsibleIds.filter(Boolean) : [];
      if (responsibleIds.length === 0) continue;
      overdueCount++;
      for (const personId of responsibleIds) {
        if (!byPerson.has(personId)) byPerson.set(personId, []);
        byPerson.get(personId).push({ id: doc.id, ...task });
      }
    }

    logger.info(`Onboarding digest: ${overdueCount} overdue tasks for ${byPerson.size} people`);

    let sent = 0;

    for (const [personId, tasks] of byPerson) {
      try {
        const [email] = await emailsForAssignees([personId]);
        if (!email) continue;

        const byProperty = new Map();
        for (const task of tasks) {
          if (!byProperty.has(task.propertyId)) byProperty.set(task.propertyId, []);
          byProperty.get(task.propertyId).push(task);
        }

        const sections = [];
        for (const [propertyId, propertyTasks] of byProperty) {
          propertyTasks.sort((a, b) =>
            a.dueDate === b.dueDate ? (a.order || 0) - (b.order || 0) : a.dueDate.localeCompare(b.dueDate)
          );
          const propertyName = escapeHtml(properties.get(propertyId).name);
          const lines = propertyTasks.map((task) => {
            const daysOverdue = daysBetweenDateStrings(task.dueDate, today);
            const note = task.notes ? ` — ${escapeHtml(task.notes)}` : '';
            return `<li>${escapeHtml(task.title)} — due ${escapeHtml(task.dueDate)}, ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue${note}</li>`;
          });
          sections.push(
            `<p><strong>${propertyName}</strong></p><ul>${lines.join('')}</ul>` +
            `<p><a href="${APP_URL}/onboarding/properties/${propertyId}">Open checklist →</a></p>`
          );
        }

        await sendMail(
          email,
          `Onboarding: ${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}`,
          `<p>These onboarding tasks are past their due date:</p>${sections.join('')}` +
          `<hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>` +
          `<p style="color:#9ca3af;font-size:12px">Please do not reply to this email.</p>`,
        );
        sent++;
      } catch (err) {
        logger.error(`Onboarding digest failed for ${personId}`, err);
      }
    }

    logger.info(`Sent ${sent} onboarding digest emails`);
  }
);
