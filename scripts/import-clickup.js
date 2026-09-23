#!/usr/bin/env node
/**
 * One-off ClickUp → Support Portal importer (Phase 8, docs/CLICKUP_MIGRATION_PLAN.md §13).
 *
 * Reads a ClickUp CSV export and writes taskSpaces / taskLists / taskStatusSets /
 * tasks / taskSeries with the Admin SDK — NOT client code, and never imported by
 * the app bundle. Run it from the repo root: `node scripts/import-clickup.js ...`.
 * See scripts/README.md for the export steps and the full dry-run → commit flow.
 *
 * Four things this script exists specifically to get right (each is a finding
 * from the live workspace audit in the plan, §1):
 *
 *  1. COLLAPSE PRE-MATERIALIZED RECURRENCES. ClickUp's "recur on completion"
 *     setting plus a year of nobody finishing "Check for Expired Concessions"
 *     left ~30 open copies of the same task, one per week, none ever done. A
 *     naive import would faithfully recreate that pile. Instead we detect runs
 *     of same-title/same-assignee/same-list tasks on a regular date interval and
 *     write ONE taskSeries + ONE open occurrence — see collapseRecurrences().
 *  2. FLATTEN Space/Folder/List → Space/List. This workspace uses a folder
 *     exactly once ("Operations / Insurance"); it becomes the list
 *     "Insurance — Marketing", matching the two-level hierarchy the app has
 *     (§3 of the plan — there is no folder concept in taskLists).
 *  3. PENDING <person> statuses become the generic "Waiting On" status plus
 *     waitingOnUserId, resolved by name against `profiles` — the entire reason
 *     person-named statuses were retired (they break when someone leaves,
 *     which is the exact scenario Reassign Work exists to handle).
 *  4. IDEMPOTENT. Every doc gets a deterministic id derived from its content
 *     (list, title, ClickUp task id, or — for a collapsed series — its
 *     occurrence date), and commits use `set(..., {merge:true})`. Re-running
 *     the same export updates in place; it never duplicates.
 *
 * --dry-run is the default: it parses the CSV, runs every mapping/collapse
 * decision, and prints the full plan without touching Firestore. Nothing is
 * written until --commit is passed explicitly. Profile lookups (for assignees
 * and waitingOnUserId) are attempted even in dry-run, best-effort — if Firestore
 * isn't reachable (no credentials, offline fixture run) the script degrades to
 * reporting unresolved names rather than failing, since a dry run's job is to
 * show the plan, not to require production access.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { file: null, commit: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--dry-run') args.commit = false; // explicit no-op; commit defaults to false anyway
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/import-clickup.js --file <export.csv> [--commit] [--project <id>]

  --file <path>     Path to a ClickUp CSV export (required).
  --commit          Actually write to Firestore. Omit for a dry run (the default).
  --project <id>    Firebase project id, if not picked up from .firebaserc / ADC.

Always run without --commit first and read the summary before committing.
`);
}

// ─── Small string/date helpers (no Date parsing of day strings — see house rule) ─

/** Lowercase, hyphenated, alnum-only — stable across runs for the same input. */
function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

/** Cheap deterministic hash for short, stable doc-id suffixes (djb2 in base36). */
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function titleCase(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_, sp, c) => sp + c.toUpperCase());
}

/**
 * ClickUp exports dates as 'M/D/YYYY' (optionally with a time we discard —
 * tasks carry dueTime separately and CSV exports don't reliably include one).
 * Built entirely from string parts, matching the house rule against
 * `new Date(dateStr)` on a day string — there's no Date object in this
 * function at all, so there's no UTC-midnight/timezone trap to fall into.
 */
function clickupDateToISO(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (us) {
    const [, mm, dd, yyyy] = us;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return iso[0];
  return null;
}

/** Whole days between two 'YYYY-MM-DD' strings (b - a). No Date-of-day-string parsing. */
function daysBetweenISO(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ─── CSV parsing (RFC4180-ish: quoted fields, embedded commas, "" escapes) ───

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Normalize line endings up front so \r\n exports don't leave a trailing \r
  // on the last field of every row.
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // Last field/row (files don't always end with a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

// ─── Status mapping ──────────────────────────────────────────────────────────
// Every status becomes { canonicalName, type }. `type` is what the rest of the
// app keys off (statusType — never the label, per CONTRACTS-TASKS.md), so this
// mapping is the one place the source label matters at all.

const HOUSE_COLORS = {
  Scheduled: '#7C3AED',
  'To Do': '#6B7280',
  'In Progress': '#B45309',
  'Waiting On': '#EA580C',
  Complete: '#16A34A',
  Closed: '#9CA3AF',
};
const FALLBACK_PALETTE = ['#0EA5E9', '#DB2777', '#65A30D', '#CA8A04', '#0891B2', '#9333EA'];

/**
 * PENDING <person> is the one case that needs the raw label (to extract who),
 * so it's matched before the rest. Everything else infers TYPE from the name
 * ("to do" -> todo, "in progress" -> active, "complete"/"closed" -> done/closed,
 * "future" -> scheduled — mirroring the ticket Scheduled mechanic) and falls
 * back to `todo` for anything unrecognized rather than guessing.
 */
function mapStatus(rawStatus) {
  const raw = String(rawStatus || '').trim();
  const lower = raw.toLowerCase();

  const pendingMatch = /^pending\s+(.+)$/i.exec(raw);
  if (pendingMatch) {
    // Strip a trailing ClickUp typo-apostrophe ("PENDING CHLOE'") and any
    // punctuation around the name before we try to match it to a profile.
    const person = pendingMatch[1].replace(/['".]+$/g, '').trim();
    return { canonicalName: 'Waiting On', type: 'waiting', pendingPerson: person, recognized: true };
  }
  if (lower === 'future') return { canonicalName: 'Scheduled', type: 'scheduled', recognized: true };
  if (['to do', 'todo', 'open', 'backlog', 'new'].includes(lower)) return { canonicalName: 'To Do', type: 'todo', recognized: true };
  if (['in progress', 'in-progress', 'review', 'in review'].includes(lower)) return { canonicalName: 'In Progress', type: 'active', recognized: true };
  if (['blocked', 'waiting', 'on hold'].includes(lower)) return { canonicalName: 'Waiting On', type: 'waiting', recognized: true };
  if (['complete', 'completed', 'done'].includes(lower)) return { canonicalName: 'Complete', type: 'done', recognized: true };
  if (['closed', 'cancelled', 'canceled'].includes(lower)) return { canonicalName: 'Closed', type: 'closed', recognized: true };
  if (!raw) return { canonicalName: 'To Do', type: 'todo', recognized: true };
  // Unrecognized label: keep it (title-cased) and default to `todo` so the
  // task is at least visible and live, flagged in the summary for a human to
  // fix in Task Settings after import rather than silently mis-filed.
  return { canonicalName: titleCase(raw), type: 'todo', recognized: false };
}

function mapPriority(raw) {
  const p = titleCase(String(raw || '').trim());
  return ['Low', 'Medium', 'High', 'Urgent'].includes(p) ? p : null;
}

// ─── Space/List flattening ────────────────────────────────────────────────────

/** "Insurance" + "Marketing" -> "Insurance — Marketing"; no folder -> just the list name. */
function flattenListName(folder, list) {
  const f = String(folder || '').trim();
  const l = String(list || '').trim();
  return f ? `${f} — ${l}` : l;
}

// ─── Recurrence collapse ──────────────────────────────────────────────────────

const MIN_RUN_LENGTH = 3; // below this, "same title 3 weeks running" is more likely coincidence than a series
const GAP_TOLERANCE_DAYS = 2; // ClickUp's own generation jitters by a day or two around holidays/weekends

function freqFromGapDays(days) {
  if (days === 1) return { freq: 'daily', interval: 1 };
  if (days === 7) return { freq: 'weekly', interval: 1 };
  if (days === 14) return { freq: 'biweekly', interval: 1 };
  if (days >= 28 && days <= 31) return { freq: 'monthly', interval: 1 };
  if (days === 365 || days === 366) return { freq: 'yearly', interval: 1 };
  return { freq: 'custom', interval: days };
}

/**
 * Group tasks by (list, title, assignees) and pull out any run of
 * MIN_RUN_LENGTH+ that lands on a regular date interval — the signature of a
 * ClickUp "recur on completion" series nobody ever finished (plan §1, finding
 * 2). Only UNFINISHED tasks are candidates: a completed task isn't part of the
 * backlog pile-up, and grouping across done copies would risk collapsing
 * genuinely distinct work that happens to share a title.
 *
 * Returns { collapsed: [...], leftoverTasks: [...] } — leftoverTasks includes
 * every task that either wasn't part of a run, or was excluded from
 * consideration (done/closed) and should import as-is.
 */
function collapseRecurrences(tasks) {
  const candidates = tasks.filter((t) => ['todo', 'active', 'waiting'].includes(t.statusType));
  const rest = tasks.filter((t) => !['todo', 'active', 'waiting'].includes(t.statusType));

  const groups = new Map();
  for (const t of candidates) {
    const key = `${t.listKey}||${t.title.trim().toLowerCase()}||${[...t.assigneeNames].sort().join(',').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const collapsed = [];
  const leftover = [...rest];

  for (const [, group] of groups) {
    if (group.length < MIN_RUN_LENGTH) { leftover.push(...group); continue; }

    // Order by due date if every row has one, else fall back to created date;
    // a mixed group (some dated, some not) can't be interval-tested reliably.
    const dateKey = group.every((t) => t.dueDate) ? 'dueDate' : (group.every((t) => t.createdDate) ? 'createdDate' : null);
    if (!dateKey) { leftover.push(...group); continue; }

    const sorted = [...group].sort((a, b) => a[dateKey].localeCompare(b[dateKey]));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetweenISO(sorted[i - 1][dateKey], sorted[i][dateKey]));

    // Modal gap (most common value) — a handful of outliers (a skipped
    // holiday week) shouldn't disqualify an otherwise-regular series.
    const counts = new Map();
    for (const g of gaps) counts.set(g, (counts.get(g) || 0) + 1);
    const modalGap = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const regular = gaps.filter((g) => Math.abs(g - modalGap) <= GAP_TOLERANCE_DAYS).length;
    const isRegular = modalGap > 0 && modalGap <= 45 && regular >= Math.ceil(gaps.length * 0.7);

    if (!isRegular) { leftover.push(...group); continue; }

    const kept = sorted[sorted.length - 1]; // most recent occurrence — the one still meaningfully "open" today
    const first = sorted[0];
    const { freq, interval } = freqFromGapDays(modalGap);

    collapsed.push({
      title: kept.title,
      listKey: kept.listKey,
      assigneeNames: kept.assigneeNames,
      count: sorted.length,
      freq,
      interval,
      firstDate: first[dateKey],
      lastDate: kept[dateKey],
      kept,
    });
  }

  return { collapsed, leftoverTasks: leftover };
}

// ─── Profile resolution (best-effort; see module doc) ─────────────────────────

function findProfileByName(profiles, name) {
  if (!name || !profiles || profiles.length === 0) return null;
  const needle = name.trim().toLowerCase();
  return (
    profiles.find((p) => (p.name || '').trim().toLowerCase() === needle) ||
    profiles.find((p) => (p.name || '').trim().toLowerCase().split(/\s+/)[0] === needle.split(/\s+/)[0]) ||
    profiles.find((p) => (p.name || '').toLowerCase().includes(needle)) ||
    null
  );
}

async function loadProfiles(projectId) {
  try {
    // Required lazily so a machine with no Admin SDK credentials configured can
    // still run a pure --dry-run summary (this whole function is wrapped by the
    // caller in a try/catch expectation) — see the module doc for why dry-run
    // degrades instead of failing when Firestore isn't reachable.
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp(projectId ? { projectId } : undefined);
    }
    const db = admin.firestore();
    const snap = await db.collection('profiles').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch {
    return null; // signals "couldn't load" — caller reports unresolved names, doesn't crash
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) { printHelp(); process.exit(args.help ? 0 : 1); return; }

  const filePath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const objects = rowsToObjects(parseCsv(raw));
  if (objects.length === 0) {
    console.error('No data rows found in the CSV. Check the export and try again.');
    process.exit(1);
    return;
  }

  const warnings = [];

  // ── Parse each row into a working task record ──
  const parsed = objects.map((o, idx) => {
    const spaceName = (o['Space'] || 'Unfiled').trim() || 'Unfiled';
    const listName = flattenListName(o['Folder'], o['List'] || 'List');
    const listKey = `${spaceName}||${listName}`;
    const status = mapStatus(o['Status']);
    if (!status.recognized) {
      warnings.push(`Row ${idx + 2} (${o['Task ID'] || o['Task Name']}): status "${o['Status']}" wasn't recognized — imported as "${status.canonicalName}" / type todo. Fix it in Task Settings after import.`);
    }
    const assigneeNames = String(o['Assignees'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      clickupId: o['Task ID'] || null,
      title: (o['Task Name'] || 'Untitled').trim(),
      spaceName,
      listName,
      listKey,
      statusRaw: o['Status'],
      statusCanonicalName: status.canonicalName,
      statusType: status.type,
      pendingPerson: status.pendingPerson || null,
      priority: mapPriority(o['Priority']),
      assigneeNames,
      dueDate: clickupDateToISO(o['Due Date']),
      createdDate: clickupDateToISO(o['Date Created']),
    };
  });

  // ── Spaces & lists (flattened, deduped, deterministic ids) ──
  const spaces = new Map(); // slug -> { id, name, order }
  const lists = new Map(); // listKey -> { id, name, spaceSlug, order }
  let spaceOrder = 0;
  let listOrder = 0;
  for (const t of parsed) {
    const spaceSlug = slugify(t.spaceName);
    if (!spaces.has(spaceSlug)) spaces.set(spaceSlug, { id: `sp_${spaceSlug}`, name: t.spaceName, order: spaceOrder++ });
    if (!lists.has(t.listKey)) {
      const listSlug = `${spaceSlug}_${slugify(t.listName)}`;
      lists.set(t.listKey, { id: `ls_${listSlug}`, name: t.listName, spaceSlug, spaceId: `sp_${spaceSlug}`, order: listOrder++ });
    }
  }

  // ── Status sets — one per list, in first-seen order, deduped by canonical name ──
  const statusSets = new Map(); // listKey -> { id, name, statuses: [...] }
  for (const t of parsed) {
    if (!statusSets.has(t.listKey)) statusSets.set(t.listKey, { id: `ss_${lists.get(t.listKey).id.slice(3)}`, name: `${lists.get(t.listKey).name} statuses`, statuses: [] });
    const set = statusSets.get(t.listKey);
    if (!set.statuses.find((s) => s.name === t.statusCanonicalName)) {
      const color = HOUSE_COLORS[t.statusCanonicalName] || FALLBACK_PALETTE[set.statuses.length % FALLBACK_PALETTE.length];
      set.statuses.push({
        id: slugify(t.statusCanonicalName),
        name: t.statusCanonicalName,
        color,
        order: set.statuses.length,
        type: t.statusType,
      });
    }
  }
  for (const [listKey, list] of lists) list.defaultStatusSetId = statusSets.get(listKey).id;

  // ── Recurrence collapse ──
  const { collapsed, leftoverTasks } = collapseRecurrences(parsed);

  // ── Profile resolution (best-effort) ──
  const profiles = await loadProfiles(args.project);
  if (profiles === null) {
    warnings.push('Could not reach Firestore to resolve profiles — assignee and "waiting on" names below are shown as-typed and were NOT converted to profile ids. Run again with Admin SDK credentials (or after --commit sets them up) to resolve them for real.');
  }
  function resolveIds(names) {
    if (!profiles) return { ids: [], unresolved: names };
    const ids = [];
    const unresolved = [];
    for (const n of names) {
      const p = findProfileByName(profiles, n);
      if (p) ids.push(p.id); else unresolved.push(n);
    }
    return { ids, unresolved };
  }

  // ── Build the final task write-list: leftovers as-is, one task per collapsed series ──
  const statusIdFor = (listKey, canonicalName) => statusSets.get(listKey).statuses.find((s) => s.name === canonicalName).id;

  const taskWrites = [];
  const unresolvedNames = new Set();

  for (const t of leftoverTasks) {
    const { ids: assigneeIds, unresolved: u1 } = resolveIds(t.assigneeNames);
    u1.forEach((n) => unresolvedNames.add(n));
    let waitingOnUserId = null;
    if (t.pendingPerson) {
      const { ids } = resolveIds([t.pendingPerson]);
      if (ids[0]) waitingOnUserId = ids[0]; else unresolvedNames.add(t.pendingPerson);
    }
    const listId = lists.get(t.listKey).id;
    const id = t.clickupId ? `tk_clickup_${slugify(t.clickupId)}` : `tk_${shortHash(`${t.listKey}|${t.title}|${t.dueDate}|${t.clickupId || ''}`)}`;
    taskWrites.push({
      id,
      listId,
      spaceId: lists.get(t.listKey).spaceId,
      title: t.title,
      statusId: statusIdFor(t.listKey, t.statusCanonicalName),
      statusName: t.statusCanonicalName,
      statusType: t.statusType,
      waitingOnUserId,
      priority: t.priority,
      assigneeIds,
      dueDate: t.dueDate,
      goLiveDate: t.statusType === 'scheduled' ? t.dueDate : null,
      seriesId: null,
      occurrenceKey: null,
    });
  }

  const seriesWrites = [];
  for (const c of collapsed) {
    const { ids: assigneeIds, unresolved } = resolveIds(c.assigneeNames);
    unresolved.forEach((n) => unresolvedNames.add(n));
    const list = lists.get(c.listKey);
    const seriesId = `sr_${shortHash(`${list.id}|${c.title.toLowerCase()}|${c.assigneeNames.sort().join(',').toLowerCase()}`)}`;
    const statusId = statusIdFor(c.listKey, c.kept.statusCanonicalName);
    seriesWrites.push({
      id: seriesId,
      name: c.title,
      listId: list.id,
      spaceId: list.spaceId,
      recurrence: { freq: c.freq, interval: c.interval },
      trigger: 'on-completion',
      resetStatusTo: statusId,
      skipWeekends: false,
      weekendShift: 'next',
      startOffsetDays: 0,
      copyOnRecur: {
        description: true, subtasks: true, subtaskAssignees: true, remapSubtaskDates: true,
        assignees: true, watchers: true, comments: false, tags: true,
        keepCheckedItems: false, carryMode: 'reset', attachments: false, activity: false,
      },
      missedPolicy: 'skip-to-next',
      active: true,
      timezone: 'America/Chicago',
      payload: { listId: list.id, spaceId: list.spaceId, title: c.title, priority: c.kept.priority, assigneeIds },
      // The single open occurrence this import materializes for the series.
      occurrence: {
        id: `${seriesId}_${c.kept.dueDate || c.kept.createdDate}`,
        listId: list.id,
        spaceId: list.spaceId,
        title: c.title,
        statusId,
        statusName: c.kept.statusCanonicalName,
        statusType: c.kept.statusType,
        priority: c.kept.priority,
        assigneeIds,
        dueDate: c.kept.dueDate,
        seriesId,
        occurrenceKey: c.kept.dueDate || c.kept.createdDate,
      },
      collapsedFrom: c.count,
      firstDate: c.firstDate,
      lastDate: c.lastDate,
    });
    taskWrites.push({ ...seriesWrites[seriesWrites.length - 1].occurrence, goLiveDate: null });
  }

  // ── Print the plan ──
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  console.log(`\nClickUp import — ${mode} (${path.relative(process.cwd(), filePath)})\n`);

  console.log(`Spaces (${spaces.size}): ${[...spaces.values()].map((s) => s.name).join(', ')}`);
  console.log(`Lists (${lists.size}):`);
  for (const listKey of lists.keys()) {
    const statusNames = statusSets.get(listKey).statuses.map((s) => s.name).join(', ');
    console.log(`  ${listKey.replace('||', ' — ')}  [${statusNames}]`);
  }

  console.log(`\nRecurrence collapse:`);
  if (collapsed.length === 0) {
    console.log('  No pre-materialized recurrence runs detected.');
  } else {
    for (const c of collapsed) {
      console.log(
        `  Collapsed ${c.count} copies of "${c.title}" (${c.listKey.replace('||', ' — ')}, ${c.assigneeNames.join(', ') || 'unassigned'}) — ` +
        `${c.freq} (${c.firstDate} → ${c.lastDate}) — into 1 series + 1 open occurrence (due ${c.lastDate}).`,
      );
    }
  }
  console.log(`\nSeries collapsed: ${collapsed.length}${collapsed.length ? ` (${collapsed.reduce((n, c) => n + c.count, 0)} rows → ${collapsed.length} series)` : ''}`);
  console.log(`Tasks to import: ${taskWrites.length} (${leftoverTasks.length} standalone + ${collapsed.length} from collapsed series)`);
  console.log(`Series to create: ${seriesWrites.length}`);

  if (unresolvedNames.size > 0) {
    console.log(`\nUnresolved names (${unresolvedNames.size}): ${[...unresolvedNames].join(', ')}`);
  }
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  if (!args.commit) {
    console.log('\nThis was a DRY RUN. No writes were made. Re-run with --commit to apply.\n');
    return;
  }

  // ── Commit ──
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp(args.project ? { projectId: args.project } : undefined);
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  const BATCH_LIMIT = 400; // Firestore's 500-write cap, with headroom — mirrors src/lib/onboarding.ts
  async function commitChunks(items, apply) {
    let batch = db.batch();
    let pending = 0;
    for (const item of items) {
      apply(batch, item);
      pending++;
      if (pending >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
  }

  await commitChunks([...spaces.values()], (batch, s) => {
    batch.set(db.collection('taskSpaces').doc(s.id), { name: s.name, order: s.order, archived: false }, { merge: true });
  });
  await commitChunks([...lists.values()], (batch, l) => {
    batch.set(db.collection('taskLists').doc(l.id), { spaceId: l.spaceId, name: l.name, order: l.order, archived: false, defaultStatusSetId: l.defaultStatusSetId }, { merge: true });
  });
  await commitChunks([...statusSets.values()], (batch, s) => {
    batch.set(db.collection('taskStatusSets').doc(s.id), { name: s.name, statuses: s.statuses }, { merge: true });
  });
  await commitChunks(seriesWrites, (batch, s) => {
    // occurrence/collapsedFrom/firstDate/lastDate are report-only fields folded
    // onto the write plan above; taskSeries itself only wants the series shape.
    const { occurrence: _occurrence, collapsedFrom: _collapsedFrom, firstDate: _firstDate, lastDate: _lastDate, ...seriesData } = s;
    batch.set(db.collection('taskSeries').doc(s.id), { ...seriesData, creatorId: 'clickup-import', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  await commitChunks(taskWrites, (batch, t) => {
    const { id, ...data } = t;
    batch.set(db.collection('tasks').doc(id), {
      ...data,
      description: '',
      creatorId: data.assigneeIds[0] || 'clickup-import',
      watcherIds: [],
      participants: [...new Set([data.assigneeIds[0] || 'clickup-import', ...data.assigneeIds])],
      startDate: null,
      dueTime: null,
      tagIds: [],
      subtasks: [],
      gcalEventId: null,
      gcalSyncedAt: null,
      completedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  console.log(`\nCommitted: ${spaces.size} spaces, ${lists.size} lists, ${statusSets.size} status sets, ${seriesWrites.length} series, ${taskWrites.length} tasks.\n`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
