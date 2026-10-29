#!/usr/bin/env node
/**
 * ClickUp → Support Portal importer, API edition.
 *
 * Reads the snapshot written by scripts/clickup-pull.js (and, optionally, its
 * --history companion) and writes taskSpaces / taskLists / taskStatusSets /
 * taskTags / taskSeries / tasks / taskComments / taskEvents with the Admin SDK.
 * Not client code; never imported by the app bundle.
 *
 * Why a second importer next to import-clickup.js: that one reads ClickUp's CSV
 * export, which has no comments, checklists, watchers, creators or created
 * dates. The API snapshot has all of them, so this one can carry a task across
 * with its original author, its comment thread, and the people watching it.
 *
 * What it gets right on purpose:
 *
 *  1. HIERARCHY. ClickUp is Space → Folder → List; the portal is Space → List →
 *     Sub-list (one level). A folder becomes a top-level list (holding no tasks)
 *     and its lists become sub-lists of it, so "Accounting > First of the Month
 *     > Housing Payments" survives as the three tiers people actually use.
 *  2. STATUSES. A list whose statuses are ClickUp's stock "to do / in progress /
 *     complete" uses the portal's seeded Default set (ids todo / in-progress /
 *     complete) rather than getting a near-duplicate set of its own. Anything
 *     else becomes a named set; PENDING <person> statuses become the generic
 *     Waiting On status plus waitingOnUserId, as in the CSV importer.
 *  3. RECURRENCE. ClickUp's API does not expose a task's recurrence settings at
 *     all. With --history, the importer looks at every closed copy of a task
 *     (same list, same title) and infers the schedule from the spacing of their
 *     due dates — "monthly on the 14th", "weekly on Monday". Closed copies are
 *     never imported; they only inform the series. Low-confidence inferences
 *     are flagged in the plan so they can be checked against ClickUp by hand.
 *  4. PEOPLE. ClickUp users are matched to `profiles` by email. Anyone without
 *     a profile is listed in the plan; their assignments are dropped and their
 *     comments are kept with the author named in the body.
 *  5. IDEMPOTENT. Every doc id derives from its ClickUp id, and writes are
 *     `set(..., {merge:true})`, so re-running updates in place.
 *
 * --dry-run is the default and prints the full plan. Nothing is written until
 * --commit is passed.
 *
 * Usage:
 *   node scripts/import-clickup-api.js --snapshot <accounting.json> [--history <accounting-history.json>]
 *       [--commit] [--project <id>] [--actor <uid>]
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { marked } = require('marked');
const { generateJSON } = require('@tiptap/html');
const StarterKit = require('@tiptap/starter-kit').default;
const Link = require('@tiptap/extension-link').default;
const Underline = require('@tiptap/extension-underline').default;
const TaskList = require('@tiptap/extension-task-list').default;
const TaskItem = require('@tiptap/extension-task-item').default;

const TZ = 'America/Chicago';
const IMPORT_ACTOR = 'clickup-import';

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { snapshot: null, history: null, commit: false, project: null, actor: null, aliases: {}, spaceId: null, spaceName: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--snapshot') a.snapshot = argv[++i];
    else if (x === '--history') a.history = argv[++i];
    else if (x === '--commit') a.commit = true;
    else if (x === '--dry-run') a.commit = false;
    else if (x === '--project') a.project = argv[++i];
    else if (x === '--actor') a.actor = argv[++i];
    // --alias old@clickup.email=profileId — for a person whose ClickUp login
    // is a different address from the one their portal profile carries.
    else if (x === '--alias') { const [email, id] = String(argv[++i]).split('='); a.aliases[email.toLowerCase()] = id; }
    // Import into a space that already exists instead of creating a new one.
    else if (x === '--space-id') a.spaceId = argv[++i];
    else if (x === '--space-name') a.spaceName = argv[++i];
    else if (x === '--help' || x === '-h') a.help = true;
  }
  return a;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const slugify = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const normTitle = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** ClickUp ms-epoch → 'YYYY-MM-DD' in the portal's timezone. */
function toDay(ms) {
  if (!ms) return null;
  return dateFmt.format(new Date(Number(ms)));
}

/**
 * ClickUp stores an all-day due date at a fixed early-morning local time (every
 * all-day task in the audited workspace lands on 03:00 Chicago). Anything else
 * is a real time the person chose, and becomes dueTime.
 */
function toTime(ms) {
  if (!ms) return null;
  const t = timeFmt.format(new Date(Number(ms)));
  return t === '03:00' || t === '04:00' ? null : t;
}

function daysBetween(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
const weekdayOf = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay();
const dayOfMonthOf = (day) => +day.slice(8, 10);

function mode(values) {
  const c = new Map();
  for (const v of values) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

// ─── Description: ClickUp markdown → TipTap JSON string ──────────────────────

const EXTENSIONS = [StarterKit, Link, Underline, TaskList, TaskItem];

function mdToDescription(markdown) {
  const md = String(markdown || '').trim();
  if (!md) return '';
  try {
    const html = marked.parse(md);
    return JSON.stringify(generateJSON(html, EXTENSIONS));
  } catch {
    // Worst case, keep the words as a single paragraph rather than lose them.
    return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: md }] }] });
  }
}

// ─── Statuses ─────────────────────────────────────────────────────────────────

/** The set the app seeds (src/lib/taskStatuses.ts DEFAULT_STATUS_SET), by ClickUp name. */
const DEFAULT_SET = {
  name: 'Default',
  statuses: [
    { id: 'todo', name: 'To Do', color: '#6B7280', order: 0, type: 'todo' },
    { id: 'in-progress', name: 'In Progress', color: '#B45309', order: 1, type: 'active' },
    { id: 'waiting', name: 'Waiting On', color: '#7C3AED', order: 2, type: 'waiting' },
    { id: 'complete', name: 'Complete', color: '#16A34A', order: 3, type: 'done' },
    { id: 'closed', name: 'Closed', color: '#9CA3AF', order: 4, type: 'closed' },
  ],
};
const DEFAULT_SIGNATURE = 'to do|in progress|complete';
const DEFAULT_NAME_MAP = { 'to do': 'todo', 'in progress': 'in-progress', complete: 'complete' };

function statusTypeOf(cu) {
  const name = String(cu.status || '').toLowerCase();
  if (cu.type === 'closed') return /^closed$/.test(name) ? 'closed' : 'done';
  if (/future/.test(name)) return 'scheduled';
  if (/pending|waiting|on hold|blocked/.test(name)) return 'waiting';
  if (cu.type === 'open') return 'todo';
  if (/complete|done/.test(name)) return 'done';
  return 'active';
}

/** "PENDING EDITA" → { canonical: 'Waiting On', person: 'Edita' }. */
function pendingPerson(name) {
  const m = String(name || '').match(/^\s*(?:pending|waiting(?: on)?)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function statusSignature(statuses) {
  return [...statuses].sort((a, b) => a.orderindex - b.orderindex).map((s) => String(s.status).toLowerCase()).join('|');
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Recurrence inference from history ────────────────────────────────────────

/**
 * Given the due dates of every copy of a task (open + closed), work out the
 * schedule. Returns null when there is nothing to infer from (fewer than two
 * distinct dates). `confidence` is 'high' when every gap agrees with the median
 * within a couple of days and there are at least three dates; 'low' otherwise.
 */
function inferRecurrence(dueDays) {
  const days = [...new Set(dueDays.filter(Boolean))].sort();
  if (days.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1], days[i]));
  const gap = median(gaps);
  // A gap is "on rhythm" when it is a whole number of periods, give or take
  // the calendar's slack (28–31-day months, leap years). A skipped month shows
  // up as a double gap, which is still the same schedule, not evidence against
  // it. Confidence is high when nearly every gap keeps the rhythm.
  const tolerance = gap >= 355 ? 10 : gap >= 85 ? 7 : gap >= 26 ? 4 : 2;
  const onRhythm = gaps.filter((g) => { const k = Math.max(1, Math.round(g / gap)); return Math.abs(g - k * gap) <= tolerance * Math.max(1, Math.ceil(k / 2)); }).length;
  const confidence = days.length >= 3 && onRhythm / gaps.length >= 0.8 ? 'high' : 'low';

  let recurrence;
  if (gap <= 1) recurrence = { freq: 'daily', interval: 1 };
  else if (gap >= 5 && gap <= 9) recurrence = { freq: 'weekly', interval: 1, byWeekday: [mode(days.map(weekdayOf))] };
  else if (gap >= 12 && gap <= 16) recurrence = { freq: 'biweekly', interval: 1, byWeekday: [mode(days.map(weekdayOf))] };
  else if (gap >= 26 && gap <= 35) recurrence = { freq: 'monthly', interval: 1, monthlyMode: 'day-of-month', dayOfMonth: monthDay(days) };
  else if (gap >= 55 && gap <= 70) recurrence = { freq: 'monthly', interval: 2, monthlyMode: 'day-of-month', dayOfMonth: monthDay(days) };
  else if (gap >= 85 && gap <= 95) recurrence = { freq: 'monthly', interval: 3, monthlyMode: 'day-of-month', dayOfMonth: monthDay(days) };
  else if (gap >= 170 && gap <= 190) recurrence = { freq: 'monthly', interval: 6, monthlyMode: 'day-of-month', dayOfMonth: monthDay(days) };
  else if (gap >= 355 && gap <= 375) recurrence = { freq: 'yearly', interval: 1 };
  else recurrence = { freq: 'custom', interval: gap };

  return { recurrence, confidence, gap, samples: days.length, firstDate: days[0], lastDate: days[days.length - 1] };
}

/** Day-of-month for a monthly series; "last" when the copies ride the month end. */
function monthDay(days) {
  const doms = days.map(dayOfMonthOf);
  const m = mode(doms);
  const allLate = doms.every((d) => d >= 28);
  return allLate && new Set(doms).size > 1 ? 'last' : m;
}

function describe(rec) {
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (rec.freq) {
    case 'daily': return 'every day';
    case 'weekly': return `every week on ${WD[rec.byWeekday?.[0]] ?? '?'}`;
    case 'biweekly': return `every other week on ${WD[rec.byWeekday?.[0]] ?? '?'}`;
    case 'monthly': return `${rec.interval === 1 ? 'every month' : `every ${rec.interval} months`} on the ${rec.dayOfMonth === 'last' ? 'last day' : rec.dayOfMonth}`;
    case 'yearly': return 'every year';
    default: return `every ${rec.interval} days`;
  }
}

// ─── Profiles (best-effort, as in import-clickup.js) ──────────────────────────

async function loadProfiles(projectId) {
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) admin.initializeApp(projectId ? { projectId } : undefined);
    const snap = await admin.firestore().collection('profiles').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`(profiles unavailable: ${String(err.message || err).split('\n')[0]})`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.snapshot) {
    console.log(`\nUsage: node scripts/import-clickup-api.js --snapshot <file.json> [--history <file.json>] [--commit] [--project <id>] [--actor <uid>]\n\n  --snapshot   Output of scripts/clickup-pull.js (required).\n  --history    Output of scripts/clickup-pull.js --history; enables recurrence inference.\n  --commit     Write to Firestore. Omit for a dry run (the default).\n  --project    Firebase project id, if not picked up from .firebaserc / ADC.\n  --actor      Profile id to attribute import-created records to when the ClickUp user has no profile.\n  --alias      old@clickup.email=profileId, repeatable — map a ClickUp login to a specific profile.\n  --space-id   Import into this existing taskSpaces doc instead of creating a new space.\n  --space-name Name to give the space (defaults to ClickUp's).\n`);
    process.exit(args.help ? 0 : 1);
  }

  const snapshot = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
  const history = args.history ? JSON.parse(fs.readFileSync(args.history, 'utf8')) : null;
  const warnings = [];

  // ── People ──
  const profiles = await loadProfiles(args.project);
  if (profiles === null) warnings.push('Could not reach Firestore to resolve profiles — people below are shown by email and were NOT converted to profile ids.');
  const byEmail = new Map((profiles || []).map((p) => [String(p.email || '').toLowerCase(), p]));
  const byName = new Map((profiles || []).map((p) => [String(p.name || '').trim().toLowerCase(), p]));
  const people = new Map(); // email -> { username, profileId|null, assigned, created, commented, watching }
  function person(cu) {
    if (!cu) return null;
    const email = String(cu.email || '').toLowerCase();
    const key = email || `name:${cu.username}`;
    if (!people.has(key)) {
      const aliased = args.aliases[email] ? (profiles || []).find((x) => x.id === args.aliases[email]) : null;
      const p = aliased || byEmail.get(email) || byName.get(String(cu.username || '').trim().toLowerCase()) || null;
      people.set(key, { email: email || '(no email)', username: cu.username, profileId: p ? p.id : null, assigned: 0, created: 0, commented: 0, watching: 0 });
    }
    return people.get(key);
  }
  const uid = (cu, role) => { const p = person(cu); if (!p) return null; p[role]++; return p.profileId; };

  const actorId = args.actor || (profiles || []).find((p) => p.role === 'superadmin')?.id || IMPORT_ACTOR;

  // ── Hierarchy ──
  const spaceId = args.spaceId || `sp_clickup_${snapshot.space.id}`;
  const space = { id: spaceId, name: args.spaceName || snapshot.space.name, order: 0, archived: false, existing: !!args.spaceId };
  const lists = []; // { id, name, spaceId, parentListId, order, cu }
  const folderIdFor = new Map();
  snapshot.folders.forEach((f, i) => {
    const id = `ls_clickup_f${f.id}`;
    folderIdFor.set(f.id, id);
    lists.push({ id, name: f.name.trim().replace(/\s+/g, ' '), spaceId, parentListId: null, order: i, cu: null });
  });
  snapshot.lists.forEach((l, i) => {
    lists.push({
      id: `ls_clickup_${l.id}`, name: l.name.trim().replace(/\s+/g, ' '), spaceId,
      parentListId: l.folderId ? folderIdFor.get(l.folderId) : null,
      order: snapshot.folders.length + i, cu: l,
    });
  });

  // ── Status sets ──
  const statusSets = new Map(); // signature -> { id, name, statuses, isDefault, listIds[] }
  for (const list of lists) {
    if (!list.cu) { list.statusSetKey = DEFAULT_SIGNATURE; continue; }
    const sig = statusSignature(list.cu.statuses);
    if (!statusSets.has(sig)) {
      if (sig === DEFAULT_SIGNATURE) {
        statusSets.set(sig, { id: null, ...DEFAULT_SET, isDefault: true, listIds: [] });
      } else {
        const sorted = [...list.cu.statuses].sort((a, b) => a.orderindex - b.orderindex);
        const statuses = [];
        for (const s of sorted) {
          const who = pendingPerson(s.status);
          const name = who ? 'Waiting On' : titleCase(s.status);
          if (statuses.find((x) => x.name === name)) continue; // several PENDING <x> fold into one Waiting On
          statuses.push({ id: slugify(name), name, color: s.color || '#6B7280', order: statuses.length, type: statusTypeOf(s) });
        }
        statusSets.set(sig, { id: `ss_clickup_${shortHash(sig)}`, name: statuses.map((s) => s.name).join(' / '), statuses, isDefault: false, listIds: [] });
      }
    }
    statusSets.get(sig).listIds.push(list.id);
    list.statusSetKey = sig;
  }
  if (!statusSets.has(DEFAULT_SIGNATURE)) statusSets.set(DEFAULT_SIGNATURE, { id: null, ...DEFAULT_SET, isDefault: true, listIds: [] });

  function statusFor(list, cuStatus) {
    const set = statusSets.get(list.statusSetKey);
    const raw = String(cuStatus?.status || '').toLowerCase();
    let def;
    if (set.isDefault) {
      def = set.statuses.find((s) => s.id === DEFAULT_NAME_MAP[raw]) || set.statuses[0];
    } else {
      const who = pendingPerson(raw);
      def = set.statuses.find((s) => s.name === (who ? 'Waiting On' : titleCase(raw))) || set.statuses[0];
    }
    return { statusId: def.id, statusName: def.name, statusType: def.type, pendingPerson: pendingPerson(raw) };
  }

  // ── Tags ──
  const tags = new Map(); // name -> { id, name, color }
  for (const t of snapshot.tags || []) tags.set(t.name, { id: `tg_clickup_${slugify(t.name)}`, name: t.name, color: t.tag_bg || t.tag_fg || '#6B7280' });

  // ── Tasks ──
  const listById = new Map(lists.map((l) => [l.id, l]));
  const allRows = [];
  for (const l of snapshot.lists) for (const t of l.tasks) allRows.push({ ...t, _listId: `ls_clickup_${l.id}` });
  const rowById = new Map(allRows.map((t) => [t.id, t]));
  const childrenOf = new Map();
  for (const t of allRows) {
    if (!t.parent) continue;
    if (!rowById.has(t.parent)) {
      // The parent is closed (closed tasks aren't pulled), so the subtask stands
      // on its own. Prefix the parent's name from history so "The Charlie" is
      // still recognisably "Insurance Renewal › The Charlie".
      const parentName = history?.lists.flatMap((l) => l.tasks).find((r) => r.id === t.parent)?.name;
      if (parentName) t.name = `${parentName} › ${t.name}`;
      warnings.push(`Subtask "${t.name}" (${t.id}) belongs to a closed parent — imported as its own task.`);
      t._orphan = true; continue;
    }
    if (!childrenOf.has(t.parent)) childrenOf.set(t.parent, []);
    childrenOf.get(t.parent).push(t);
  }

  const taskWrites = [];
  const commentWrites = [];
  const eventWrites = [];
  let subtaskCount = 0;
  let waitingUnresolved = 0;

  for (const t of allRows) {
    if (t.parent && !t._orphan) continue;
    const list = listById.get(t._listId);
    const st = statusFor(list, t.status);

    const creatorId = uid(t.creator, 'created');
    const assigneeIds = [...new Set((t.assignees || []).map((a) => uid(a, 'assigned')).filter(Boolean))];
    const watcherIds = [...new Set((t.watchers || []).map((w) => uid(w, 'watching')).filter(Boolean))];
    const creator = creatorId || assigneeIds[0] || actorId;

    let waitingOnUserId = null;
    if (st.pendingPerson) {
      const p = byName.get(st.pendingPerson.toLowerCase()) || [...byName.entries()].find(([n]) => n.split(' ')[0] === st.pendingPerson.toLowerCase())?.[1];
      if (p) waitingOnUserId = p.id; else { waitingUnresolved++; warnings.push(`"${t.name}": status "${t.status.status}" names ${st.pendingPerson}, who has no profile — imported as Waiting On with nobody set.`); }
    }

    // Checklists and child tasks both become subtasks. A child task's own
    // description/comments have nowhere to go on a subtask, so those are
    // appended to the parent's description below rather than dropped.
    const subtasks = [];
    const childNotes = [];
    for (const cl of t.checklists || []) {
      for (const item of [...(cl.items || [])].sort((a, b) => a.orderindex - b.orderindex)) {
        subtasks.push({
          id: `ck_${item.id}`, title: item.name, done: !!item.resolved,
          doneAt: null, doneBy: null,
          assigneeIds: item.assignee ? [uid(item.assignee, 'assigned')].filter(Boolean) : [],
          dueDate: toDay(item.due_date), order: subtasks.length * 100, carriedFromTaskId: null,
        });
      }
    }
    for (const c of [...(childrenOf.get(t.id) || [])].sort((a, b) => Number(a.orderindex) - Number(b.orderindex))) {
      subtasks.push({
        id: `ct_${c.id}`, title: c.name, done: c.status?.type === 'closed',
        doneAt: null, doneBy: null,
        assigneeIds: [...new Set((c.assignees || []).map((a) => uid(a, 'assigned')).filter(Boolean))],
        dueDate: toDay(c.due_date), order: subtasks.length * 100, carriedFromTaskId: null,
      });
      if ((c.markdown_description || '').trim()) childNotes.push(`**${c.name}:** ${c.markdown_description.trim()}`);
      for (const cm of c.comments || []) {
        commentWrites.push(buildComment(cm, `tk_clickup_${t.id}`, `[on subtask "${c.name}"] `));
      }
    }
    subtaskCount += subtasks.length;

    // Custom fields with a value have no home in the portal; keep them as a
    // trailing "Field: value" block so nothing typed into ClickUp is lost.
    const fieldLines = [];
    for (const f of t.custom_fields || []) {
      const v = customFieldText(f);
      if (v) fieldLines.push(`**${f.name}:** ${v}`);
    }
    let md = String(t.markdown_description || '').trim();
    if (childNotes.length) md += `\n\n${childNotes.join('\n\n')}`;
    if (fieldLines.length) md += `\n\n${fieldLines.join('\n')}`;

    const id = `tk_clickup_${t.id}`;
    taskWrites.push({
      id,
      cuId: t.id,
      listId: list.id,
      spaceId,
      title: String(t.name || 'Untitled').trim(),
      description: mdToDescription(md),
      statusId: st.statusId, statusName: st.statusName, statusType: st.statusType,
      waitingOnUserId,
      priority: priorityOf(t.priority),
      assigneeIds, creatorId: creator, watcherIds,
      participants: [...new Set([creator, ...assigneeIds, ...watcherIds])],
      startDate: toDay(t.start_date),
      dueDate: toDay(t.due_date),
      dueTime: toTime(t.due_date),
      goLiveDate: null,
      tagIds: (t.tags || []).map((g) => tags.get(g.name)?.id).filter(Boolean),
      subtasks,
      order: Number(t.orderindex) || 0,
      seriesId: null, occurrenceKey: null,
      gcalEventId: null, gcalSyncedAt: null, completedAt: null,
      createdMs: Number(t.date_created) || Date.now(),
    });
    eventWrites.push({ id: `ev_clickup_${t.id}_created`, taskId: id, type: 'created', actorId: creator, toStatusId: st.statusId, toStatusType: st.statusType, createdMs: Number(t.date_created) || Date.now() });
    for (const cm of t.comments || []) commentWrites.push(buildComment(cm, id, ''));
  }

  function buildComment(cm, taskId, prefix) {
    const authorId = uid(cm.user, 'commented');
    const text = String(cm.comment_text || '').trim();
    return {
      id: `cm_clickup_${cm.id}`,
      taskId,
      userId: authorId || actorId,
      body: authorId ? `${prefix}${text}` : `${prefix}[${cm.user?.username || 'Unknown'} via ClickUp] ${text}`,
      mentionedIds: [],
      createdMs: Number(cm.date) || Date.now(),
    };
  }

  // ── Recurrence (needs --history) ──
  const seriesWrites = [];
  const oneOffsWithHistory = [];
  if (history) {
    const histByList = new Map(history.lists.map((l) => [`ls_clickup_${l.id}`, l.tasks]));
    const groups = new Map(); // listId||title -> { open: taskWrite[], dueDays: [] }
    for (const tw of taskWrites) {
      const key = `${tw.listId}||${normTitle(tw.title)}`;
      if (!groups.has(key)) groups.set(key, { open: [], dueDays: new Set(), copies: 0 });
      groups.get(key).open.push(tw);
    }
    for (const [listId, rows] of histByList) {
      for (const r of rows) {
        if (r.parent) continue;
        const key = `${listId}||${normTitle(r.name)}`;
        const g = groups.get(key);
        if (!g) continue; // nothing open under this title today → nothing to recur
        g.copies++;
        if (r.due_date) g.dueDays.add(toDay(r.due_date));
      }
    }
    for (const [key, g] of groups) {
      const inferred = inferRecurrence([...g.dueDays]);
      if (!inferred) { if (g.copies > 1) oneOffsWithHistory.push({ key, copies: g.copies }); continue; }
      const open = [...g.open].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      const latest = open[open.length - 1];
      const list = listById.get(latest.listId);
      const set = statusSets.get(list.statusSetKey);
      const resetStatusTo = (set.statuses.find((s) => s.type === 'todo') || set.statuses[0]).id;
      const seriesId = `sr_clickup_${shortHash(key)}`;
      const { createdMs: _c, cuId: _k, id: _i, subtasks, description, ...payloadFields } = latest;
      seriesWrites.push({
        id: seriesId,
        name: latest.title,
        payload: {
          listId: latest.listId, spaceId, title: latest.title, description,
          priority: latest.priority, assigneeIds: latest.assigneeIds, watcherIds: latest.watcherIds,
          tagIds: latest.tagIds, dueTime: latest.dueTime,
          subtaskTemplate: subtasks.map((s, i) => ({ title: s.title, order: s.order ?? i * 100 })),
        },
        recurrence: inferred.recurrence,
        // on-completion, whatever the ClickUp dialog says. The history shows
        // every next copy's date_created equal to the previous copy's date_done
        // to the second — for series labelled "On a schedule" and "On status
        // change: Complete" alike — with the new due date snapping to the next
        // rule slot. That is exactly this engine's on-completion behaviour.
        trigger: 'on-completion',
        resetStatusTo,
        skipWeekends: false,
        weekendShift: 'next',
        startOffsetDays: 0,
        copyOnRecur: {
          description: true, subtasks: true, subtaskAssignees: true, remapSubtaskDates: true,
          assignees: true, watchers: true, comments: false, tags: true,
          keepCheckedItems: false, carryMode: 'reset', attachments: false, activity: false,
        },
        missedPolicy: 'skip-to-next',
        endDate: null, occurrenceLimit: null, active: true, timezone: TZ,
        creatorId: latest.creatorId,
        _report: { ...inferred, list: list.name, openCount: open.length, copies: g.copies },
      });
      for (const tw of open) { tw.seriesId = seriesId; tw.occurrenceKey = tw.dueDate || toDay(tw.createdMs); }
      void payloadFields;
    }
  }

  // ── Plan ──
  const mode_ = args.commit ? 'COMMIT' : 'DRY RUN';
  const out = (s = '') => console.log(s);
  out(`\nClickUp API import — ${mode_}\n`);
  out(`Space: ${space.name}  (${space.id}${space.existing ? ', existing — reused' : ', new'})`);
  out(`Lists (${lists.length}):`);
  for (const l of lists.filter((x) => !x.parentListId)) {
    const n = taskWrites.filter((t) => t.listId === l.id).length;
    out(`  ${l.name}${n ? `  — ${n} tasks` : ''}`);
    for (const c of lists.filter((x) => x.parentListId === l.id)) {
      out(`    └ ${c.name}  — ${taskWrites.filter((t) => t.listId === c.id).length} tasks`);
    }
  }
  out(`\nStatus sets:`);
  for (const s of statusSets.values()) out(`  ${s.isDefault ? 'Default (existing, seeded by the app)' : `${s.name}  [new: ${s.id}]`}  ← ${s.listIds.length} lists`);
  out(`\nPeople:`);
  for (const p of [...people.values()].sort((a, b) => b.assigned - a.assigned)) {
    out(`  ${p.username.padEnd(22)} ${p.email.padEnd(28)} → ${p.profileId ? p.profileId : '** NO PROFILE **'}   assigned ${p.assigned}, watching ${p.watching}, created ${p.created}, comments ${p.commented}`);
  }
  out(`  (import actor for anything unattributable: ${actorId})`);
  out(`\nRecurring series${history ? '' : ' (no --history given — nothing inferred)'}: ${seriesWrites.length}`);
  for (const s of seriesWrites.sort((a, b) => a._report.list.localeCompare(b._report.list) || a.name.localeCompare(b.name))) {
    const r = s._report;
    out(`  ${r.confidence === 'low' ? '?? ' : '   '}${r.list} › ${s.name}  — ${describe(s.recurrence)}  (${r.samples} dates ${r.firstDate}→${r.lastDate}, ${r.copies} copies, ${r.openCount} open)`);
  }
  if (oneOffsWithHistory.length) out(`  ${oneOffsWithHistory.length} titles have closed copies but only one due date — imported as one-offs.`);
  out(`\nTasks: ${taskWrites.length}  (${taskWrites.filter((t) => t.seriesId).length} linked to a series, ${taskWrites.filter((t) => t.dueTime).length} with a time of day, ${subtaskCount} subtasks folded in)`);
  out(`Comments: ${commentWrites.length}   Events: ${eventWrites.length}   Tags: ${tags.size}`);
  if (warnings.length) { out(`\nWarnings (${warnings.length}):`); warnings.forEach((w) => out(`  - ${w}`)); }

  if (!args.commit) { out('\nThis was a DRY RUN. No writes were made. Re-run with --commit to apply.\n'); return; }

  // ── Commit ──
  const admin = require('firebase-admin');
  const { FieldValue, Timestamp } = require('firebase-admin/firestore');
  if (!admin.apps.length) admin.initializeApp(args.project ? { projectId: args.project } : undefined);
  const db = admin.firestore();

  // The Default set is seeded with a random id; find it (or seed it) so lists
  // can point at the one the app already uses.
  const defaultSet = statusSets.get(DEFAULT_SIGNATURE);
  const existing = await db.collection('taskStatusSets').where('name', '==', 'Default').limit(1).get();
  if (!existing.empty) defaultSet.id = existing.docs[0].id;
  else {
    const ref = await db.collection('taskStatusSets').add({ name: DEFAULT_SET.name, statuses: DEFAULT_SET.statuses });
    defaultSet.id = ref.id;
  }

  const BATCH = 400;
  async function commitChunks(items, apply) {
    let batch = db.batch(); let n = 0;
    for (const it of items) { apply(batch, it); if (++n >= BATCH) { await batch.commit(); batch = db.batch(); n = 0; } }
    if (n) await batch.commit();
  }
  const now = () => FieldValue.serverTimestamp();

  await commitChunks([space], (b, s) => b.set(db.collection('taskSpaces').doc(s.id), s.existing ? { name: s.name, archived: false } : { name: s.name, order: s.order, archived: false }, { merge: true }));
  await commitChunks(lists, (b, l) => b.set(db.collection('taskLists').doc(l.id), {
    spaceId: l.spaceId, name: l.name, order: l.order, archived: false,
    parentListId: l.parentListId, defaultStatusSetId: statusSets.get(l.statusSetKey).id,
  }, { merge: true }));
  await commitChunks([...statusSets.values()].filter((s) => !s.isDefault), (b, s) => b.set(db.collection('taskStatusSets').doc(s.id), { name: s.name, statuses: s.statuses }, { merge: true }));
  await commitChunks([...tags.values()], (b, t) => b.set(db.collection('taskTags').doc(t.id), { name: t.name, color: t.color }, { merge: true }));
  await commitChunks(seriesWrites, (b, s) => { const { _report, id, ...data } = s; b.set(db.collection('taskSeries').doc(id), { ...data, createdAt: now(), updatedAt: now() }, { merge: true }); });
  await commitChunks(taskWrites, (b, t) => {
    const { id, cuId, createdMs, ...data } = t;
    b.set(db.collection('tasks').doc(id), { ...data, clickupId: cuId, createdAt: Timestamp.fromMillis(createdMs), updatedAt: now() }, { merge: true });
  });
  await commitChunks(commentWrites, (b, c) => { const { id, createdMs, ...data } = c; b.set(db.collection('taskComments').doc(id), { ...data, createdAt: Timestamp.fromMillis(createdMs), editedAt: null }, { merge: true }); });
  await commitChunks(eventWrites, (b, e) => { const { id, createdMs, ...data } = e; b.set(db.collection('taskEvents').doc(id), { ...data, createdAt: Timestamp.fromMillis(createdMs) }, { merge: true }); });

  out(`\nCommitted: 1 space, ${lists.length} lists, ${[...statusSets.values()].filter((s) => !s.isDefault).length} new status sets, ${tags.size} tags, ${seriesWrites.length} series, ${taskWrites.length} tasks, ${commentWrites.length} comments, ${eventWrites.length} events.\n`);
}

function priorityOf(p) {
  const name = String(p?.priority || '').toLowerCase();
  return { urgent: 'Urgent', high: 'High', normal: 'Medium', low: 'Low' }[name] || null;
}

function customFieldText(f) {
  const v = f.value;
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return '';
  switch (f.type) {
    case 'drop_down': return f.type_config?.options?.find((o) => o.orderindex === v || o.id === v)?.name || String(v);
    case 'labels': return (Array.isArray(v) ? v : [v]).map((id) => f.type_config?.options?.find((o) => o.id === id)?.label || id).join(', ');
    case 'date': return toDay(v) || '';
    case 'users': return (Array.isArray(v) ? v : [v]).map((u) => u.username || u.email || u).join(', ');
    case 'checkbox': return v === 'true' || v === true ? 'yes' : 'no';
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

main().catch((err) => { console.error('Import failed:', err); process.exit(1); });
