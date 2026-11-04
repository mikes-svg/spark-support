/**
 * The consolidated 07:00 "Your morning brief" (CONTRACTS-TASKS.md §7 / plan
 * §7): tickets + onboarding + tasks in ONE email per person instead of three
 * separate digests hitting the same dozen inboxes every morning. Sections are
 * skipped when empty, and a person with nothing due anywhere gets no mail at
 * all — same standard each of the three digests already held on its own.
 *
 * tickets.js and onboarding.js are foundation-owned (CONTRACTS-TASKS.md), and
 * `sendTicketReminders` / `sendOnboardingReminders` each export the ENTIRE
 * onSchedule() registration as one value — there is no separate "body" to
 * import and call. Re-exporting them as-is would mean three emails, not one,
 * so the section builders below reproduce their query/sort/copy instead
 * (documented per-section below). Retiring the two old scheduled functions
 * from functions/index.js so this is the only 07:00 digest is a change
 * request — see CONTRACTS-TASKS.md → Change requests; functions/index.js,
 * tickets.js and onboarding.js are outside this lane's fence.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const {
  db,
  APP_URL,
  escapeHtml,
  emailsForAssignees,
  getAssigneeIds,
  sendMail,
  todayInTimeZone,
  daysBetweenDateStrings,
} = require('./shared');

// One send, one schedule, one timezone for the whole brief. America/Chicago
// matches generateRecurringTasks' 06:00 run (lane 3) — an hour before this,
// so a freshly-minted recurring task lands in the same morning's email.
const DIGEST_TZ = 'America/Chicago';

const SECTION_DIVIDER = '<hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>';

// ─── statusType-driven task predicates ───────────────────────────────────────
// Mirrors isTaskLive / isTaskOverdue in src/types.ts. Cloud Functions don't
// bundle client TS source, so these are kept here rather than imported — keep
// them in lockstep with src/types.ts if that file's predicates ever change.

function isLive(task) {
  return task.statusType === 'todo' || task.statusType === 'active' || task.statusType === 'waiting';
}

function isOverdue(task, today) {
  if (!task.dueDate || !today) return false;
  if (task.statusType === 'done' || task.statusType === 'closed' || task.statusType === 'scheduled') return false;
  return task.dueDate < today;
}

// ─── Section 1: tickets ───────────────────────────────────────────────────────
// Reproduces sendTicketReminders' query, grouping, sort ('most urgent first,
// then longest-open first'), and per-row copy from tickets.js.

async function buildTicketSections() {
  const now = Date.now();
  const byPerson = new Map();

  const ticketsSnap = await db
    .collection('tickets')
    .where('status', 'in', ['Open', 'In Progress'])
    .get();

  const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const raw = new Map();
  for (const doc of ticketsSnap.docs) {
    const ticket = doc.data();
    const assigneeIds = getAssigneeIds(ticket);
    if (assigneeIds.length === 0) continue;
    const entry = {
      id: doc.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt?.toDate?.() || new Date(ticket.createdAt),
    };
    for (const personId of assigneeIds) {
      if (!raw.has(personId)) raw.set(personId, []);
      raw.get(personId).push(entry);
    }
  }

  for (const [personId, tickets] of raw) {
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
    const html =
      `<h3 style="margin:0 0 8px">Tickets — ${tickets.length} still need attention</h3>` +
      `<ul style="margin:0 0 8px">${rows.join('')}</ul>` +
      `<p style="margin:0"><a href="${APP_URL}/">Open My Tickets →</a></p>`;
    byPerson.set(personId, { count: tickets.length, html });
  }

  logger.info(`Morning brief / tickets: ${ticketsSnap.size} open/in-progress for ${byPerson.size} assignees`);
  return byPerson;
}

// ─── Section 2: onboarding ────────────────────────────────────────────────────
// Reproduces sendOnboardingReminders' query (overdue, dated, non-archived-
// property tasks), per-property grouping and sort, and copy from onboarding.js.

async function buildOnboardingSections(today) {
  const byPerson = new Map();

  const tasksSnap = await db
    .collection('onboardingTasks')
    .where('status', 'in', ['Not Started', 'In Progress'])
    .where('dueDate', '<', today)
    .get();

  const dated = tasksSnap.docs.filter((d) => {
    const dueDate = d.data().dueDate;
    return typeof dueDate === 'string' && dueDate !== '';
  });

  const propertyIds = [...new Set(dated.map((d) => d.data().propertyId).filter(Boolean))];
  const properties = new Map();
  if (propertyIds.length) {
    const refs = propertyIds.map((id) => db.collection('onboardingProperties').doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists && snap.data().archived !== true) properties.set(snap.id, snap.data());
    }
  }

  const raw = new Map();
  let overdueCount = 0;
  for (const doc of dated) {
    const task = doc.data();
    if (!properties.has(task.propertyId)) continue;
    const responsibleIds = Array.isArray(task.responsibleIds) ? task.responsibleIds.filter(Boolean) : [];
    if (responsibleIds.length === 0) continue;
    overdueCount++;
    for (const personId of responsibleIds) {
      if (!raw.has(personId)) raw.set(personId, []);
      raw.get(personId).push({ id: doc.id, ...task });
    }
  }

  for (const [personId, tasks] of raw) {
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
        `<p style="margin:8px 0 2px"><strong>${propertyName}</strong></p><ul style="margin:0 0 4px">${lines.join('')}</ul>` +
        `<p style="margin:0 0 4px"><a href="${APP_URL}/onboarding/properties/${propertyId}">Open checklist →</a></p>`
      );
    }
    const html =
      `<h3 style="margin:0 0 8px">Onboarding — ${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}</h3>` +
      sections.join('');
    byPerson.set(personId, { count: tasks.length, html });
  }

  logger.info(`Morning brief / onboarding: ${overdueCount} overdue for ${byPerson.size} people`);
  return byPerson;
}

// ─── Series flags: missed occurrences + exceeded carry bound ─────────────────
// Best-effort against lane 3's not-yet-landed recurrence engine: there is no
// pinned "consecutive misses" or "carry depth" field to read (see
// CONTRACTS-TASKS.md), so both are reconstructed from what IS pinned —
// taskEvents and Subtask.carriedFromTaskId — capped and failure-isolated so a
// bad chain can't take down the run. Once lane 3 lands a direct field, this
// can be simplified to read it instead.

const MISS_THRESHOLD = 3; // "3 missed in a row" (plan §4, missedPolicy: skip-to-next)
const CARRY_THRESHOLD = 3; // "past 3 consecutive carries" (plan §4, carry-unfinished)
const CARRY_WALK_DEPTH = 5; // hard cap on how far back a carry chain is walked

/** taskId -> count of missed_occurrence events recorded against it. */
async function missedOccurrenceCounts() {
  const counts = new Map();
  try {
    const snap = await db.collection('taskEvents').where('type', '==', 'missed_occurrence').get();
    for (const doc of snap.docs) {
      const taskId = doc.data().taskId;
      if (!taskId) continue;
      counts.set(taskId, (counts.get(taskId) || 0) + 1);
    }
  } catch (err) {
    logger.warn('Morning brief: could not read missed-occurrence events', err);
  }
  return counts;
}

/** How many consecutive carriedFromTaskId links precede this task's subtasks. */
async function carryChainDepth(task, tasksById) {
  const carried = (task.subtasks || []).filter((s) => s.carriedFromTaskId);
  if (carried.length === 0) return 0;

  let depth = 1;
  let parentId = carried[0].carriedFromTaskId;
  let subtaskTitle = carried[0].title;

  for (let i = 0; i < CARRY_WALK_DEPTH && parentId; i++) {
    try {
      const parent = tasksById.get(parentId) || (await db.collection('tasks').doc(parentId).get()).data();
      if (!parent) break;
      const match = (parent.subtasks || []).find(
        (s) => s.title?.trim().toLowerCase() === subtaskTitle?.trim().toLowerCase(),
      );
      if (!match?.carriedFromTaskId) break;
      depth++;
      parentId = match.carriedFromTaskId;
    } catch (err) {
      logger.warn(`Morning brief: carry-chain walk stopped at ${parentId}`, err);
      break;
    }
  }
  return depth;
}

// ─── Section 3: tasks ─────────────────────────────────────────────────────────
// Overdue, due today, and any series flagged for missed occurrences or an
// exceeded carry bound — all statusType-driven, never a status label.

async function buildTaskSections(today) {
  const byPerson = new Map();

  const tasksSnap = await db.collection('tasks').get();
  const tasksById = new Map();
  const allTasks = [];
  tasksSnap.docs.forEach((doc) => {
    const t = { id: doc.id, ...doc.data() };
    tasksById.set(doc.id, t);
    allTasks.push(t);
  });

  const overdue = allTasks.filter((t) => isOverdue(t, today));
  const dueToday = allTasks.filter((t) => isLive(t) && t.dueDate === today);

  const missedCounts = await missedOccurrenceCounts();
  const flagged = [];
  for (const t of allTasks) {
    if (!isLive(t)) continue;
    const missCount = missedCounts.get(t.id) || 0;
    if (missCount >= MISS_THRESHOLD) {
      flagged.push({ task: t, reason: `missed ${missCount} occurrences in a row` });
      continue; // one flag per task is plenty for a digest line
    }
    try {
      const depth = await carryChainDepth(t, tasksById);
      if (depth >= CARRY_THRESHOLD) {
        flagged.push({ task: t, reason: `carried forward ${depth} cycles in a row` });
      }
    } catch (err) {
      logger.warn(`Morning brief: carry-bound check failed for ${t.id}`, err);
    }
  }

  const raw = new Map(); // personId -> { overdue: [], dueToday: [], flagged: [] }
  const add = (bucket, task, extra) => {
    const assigneeIds = Array.isArray(task.assigneeIds) ? task.assigneeIds : [];
    for (const personId of assigneeIds) {
      if (!raw.has(personId)) raw.set(personId, { overdue: [], dueToday: [], flagged: [] });
      raw.get(personId)[bucket].push(extra ? { task, ...extra } : { task });
    }
  };
  overdue.forEach((t) => add('overdue', t));
  dueToday.forEach((t) => add('dueToday', t));
  flagged.forEach(({ task, reason }) => add('flagged', task, { reason }));

  for (const [personId, buckets] of raw) {
    const total = buckets.overdue.length + buckets.dueToday.length + buckets.flagged.length;
    if (total === 0) continue;

    const rowFor = (task) =>
      `<li><a href="${APP_URL}/tasks/${task.id}">${escapeHtml(task.title)}</a>` +
      (task.dueDate ? ` — due ${escapeHtml(task.dueDate)}` : '') + `</li>`;

    const parts = [];
    if (buckets.overdue.length) {
      parts.push(
        `<p style="margin:8px 0 2px"><strong>Overdue (${buckets.overdue.length})</strong></p>` +
        `<ul style="margin:0 0 4px">${buckets.overdue.map((r) => rowFor(r.task)).join('')}</ul>`,
      );
    }
    if (buckets.dueToday.length) {
      parts.push(
        `<p style="margin:8px 0 2px"><strong>Due today (${buckets.dueToday.length})</strong></p>` +
        `<ul style="margin:0 0 4px">${buckets.dueToday.map((r) => rowFor(r.task)).join('')}</ul>`,
      );
    }
    if (buckets.flagged.length) {
      parts.push(
        `<p style="margin:8px 0 2px"><strong>Recurring series needing attention (${buckets.flagged.length})</strong></p>` +
        `<ul style="margin:0 0 4px">${buckets.flagged.map((r) =>
          `<li><a href="${APP_URL}/tasks/${r.task.id}">${escapeHtml(r.task.title)}</a> — ${escapeHtml(r.reason)}</li>`
        ).join('')}</ul>`,
      );
    }

    const html = `<h3 style="margin:0 0 8px">Tasks — ${total} item${total === 1 ? '' : 's'} need attention</h3>` + parts.join('');
    byPerson.set(personId, { count: total, html });
  }

  logger.info(
    `Morning brief / tasks: ${overdue.length} overdue, ${dueToday.length} due today, ${flagged.length} flagged series for ${byPerson.size} people`,
  );
  return byPerson;
}

// ─── Merge + send ─────────────────────────────────────────────────────────────

exports.sendMorningBrief = onSchedule(
  {
    schedule: 'every day 07:00',
    timeZone: DIGEST_TZ,
    region: 'us-central1',
  },
  async () => {
    const today = todayInTimeZone(DIGEST_TZ);

    const [tickets, onboarding, tasks] = await Promise.all([
      buildTicketSections(),
      buildOnboardingSections(today),
      buildTaskSections(today),
    ]);

    const everyone = new Set([...tickets.keys(), ...onboarding.keys(), ...tasks.keys()]);
    logger.info(`Morning brief: ${everyone.size} people have something due`);

    let sent = 0;
    for (const personId of everyone) {
      try {
        const sections = [tickets.get(personId), onboarding.get(personId), tasks.get(personId)]
          .filter(Boolean);
        if (sections.length === 0) continue; // shouldn't happen — belt and suspenders

        const [email] = await emailsForAssignees([personId]);
        if (!email) continue;

        const totalCount = sections.reduce((sum, s) => sum + s.count, 0);
        const html =
          `<p>Here's your morning brief — ${totalCount} item${totalCount === 1 ? '' : 's'} across ${sections.length} area${sections.length === 1 ? '' : 's'}:</p>` +
          sections.map((s) => s.html).join(SECTION_DIVIDER) +
          SECTION_DIVIDER +
          `<p style="color:#9ca3af;font-size:12px">This is your daily summary. Please do not reply to this email.</p>`;

        await sendMail(email, `Your morning brief: ${totalCount} item${totalCount === 1 ? '' : 's'} need attention`, html);
        sent++;
      } catch (err) {
        logger.error(`Morning brief failed for ${personId}`, err);
      }
    }

    logger.info(`Sent ${sent} morning brief emails`);
  }
);
