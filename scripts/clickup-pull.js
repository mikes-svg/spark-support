#!/usr/bin/env node
/**
 * Pull one ClickUp space into a JSON snapshot, via the REST API (v2).
 *
 * The CSV export that import-clickup.js reads drops comments, attachments,
 * checklists, watchers and custom fields. The API has all of those, so a
 * "to the dot" migration pulls through here and imports from the snapshot
 * (scripts/import-clickup-api.js). Pulling and importing are separate steps on
 * purpose: the snapshot is reviewable, the import is re-runnable against it
 * without re-hitting ClickUp, and the token can be revoked as soon as this
 * script has run once.
 *
 * Token: CLICKUP_API_TOKEN, read from scripts/clickup-token.local (gitignored)
 * or the environment. Never committed, never logged.
 *
 * Usage: node scripts/clickup-pull.js --space <spaceId> --out <file.json>
 *        node scripts/clickup-pull.js --space <spaceId> --out <file.json> --history
 *
 * --history pulls a second, much lighter shape: every task INCLUDING closed
 * ones, but only the handful of fields needed to infer recurrence schedules
 * (title, list, dates, status) and no comments. Closed tasks are never
 * imported — the history is read purely so the importer can tell "monthly on
 * the 14th" from "weekly on Monday", which ClickUp's API does not expose.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = 'https://api.clickup.com/api/v2';
// Free/Unlimited plans allow 100 requests/minute. 700ms between calls keeps us
// comfortably under, and a 429 backs off and retries rather than failing a
// 20-minute pull at minute 19.
const MIN_GAP_MS = 700;

function loadToken() {
  if (process.env.CLICKUP_API_TOKEN) return process.env.CLICKUP_API_TOKEN;
  const file = path.join(__dirname, 'clickup-token.local');
  if (fs.existsSync(file)) {
    const m = fs.readFileSync(file, 'utf8').match(/^CLICKUP_API_TOKEN=(.+)$/m);
    if (m && m[1].trim() && m[1].trim() !== 'paste_token_here') return m[1].trim();
  }
  console.error('No ClickUp token. Put CLICKUP_API_TOKEN=... in scripts/clickup-token.local');
  process.exit(1);
}

function parseArgs(argv) {
  const a = { space: null, out: null, history: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--space') a.space = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--history') a.history = true;
  }
  if (!a.space || !a.out) {
    console.error('Usage: node scripts/clickup-pull.js --space <spaceId> --out <file.json>');
    process.exit(1);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
let calls = 0;
async function get(token, url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls++;
    const res = await fetch(url, { headers: { Authorization: token } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') || 60);
      console.error(`  429 — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      // Transient 5xx: back off and retry. Anything else is a real error.
      if (res.status >= 500 && attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`${res.status} ${url}\n${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`gave up on ${url}`);
}

async function allTasks(token, listId, includeClosed = false) {
  // Paged, 100 per page; `last_page` tells us when to stop. Open tasks only —
  // closed history stays in ClickUp by decision. subtasks=true inlines them as
  // rows with `parent`.

  const out = [];
  for (let page = 0; ; page++) {
    const q = `archived=false&subtasks=true&include_markdown_description=${includeClosed ? 'false' : 'true'}&include_closed=${includeClosed}&page=${page}`;
    const d = await get(token, `${API}/list/${listId}/task?${q}`);
    out.push(...(d.tasks || []));
    if (d.last_page || !d.tasks || d.tasks.length === 0) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = loadToken();
  const log = (s) => console.error(s);

  const snapshot = { pulledAt: new Date().toISOString(), space: null, tags: [], members: [], folders: [], lists: [] };

  snapshot.space = await get(token, `${API}/space/${args.space}`);
  log(`Space: ${snapshot.space.name}`);
  snapshot.tags = (await get(token, `${API}/space/${args.space}/tag`)).tags || [];

  const teamId = String(snapshot.space.team_id || '');
  if (teamId) {
    const teams = (await get(token, `${API}/team`)).teams || [];
    const team = teams.find((t) => String(t.id) === teamId);
    snapshot.members = (team?.members || []).map((m) => ({
      id: m.user.id, username: m.user.username, email: m.user.email, role: m.user.role,
    }));
  }

  // Folders + their lists, then folderless lists. Each list carries its own
  // statuses (ClickUp lets lists override the space's) and we fetch its custom
  // field definitions separately — the task rows only hold values.
  const folders = (await get(token, `${API}/space/${args.space}/folder?archived=false`)).folders || [];
  const lists = [];
  for (const f of folders) {
    snapshot.folders.push({ id: f.id, name: f.name, orderindex: f.orderindex, hidden: f.hidden });
    for (const l of f.lists || []) lists.push({ ...l, folderId: f.id, folderName: f.name });
  }
  const loose = (await get(token, `${API}/space/${args.space}/list?archived=false`)).lists || [];
  for (const l of loose) lists.push({ ...l, folderId: null, folderName: null });
  log(`${folders.length} folders, ${lists.length} lists`);

  if (args.history) {
    const history = { pulledAt: snapshot.pulledAt, spaceId: args.space, lists: [] };
    for (const l of lists) {
      const tasks = await allTasks(token, l.id, true);
      log(`  ${l.folderName ? l.folderName + ' / ' : ''}${l.name}: ${tasks.length} tasks incl. closed`);
      history.lists.push({
        id: l.id, name: l.name, folderName: l.folderName,
        tasks: tasks.map((t) => ({
          id: t.id, name: t.name, parent: t.parent || null,
          status: t.status?.status || null, statusType: t.status?.type || null,
          due_date: t.due_date || null, start_date: t.start_date || null,
          date_created: t.date_created || null, date_done: t.date_done || null, date_closed: t.date_closed || null,
          assignees: (t.assignees || []).map((a) => a.email || a.username),
        })),
      });
    }
    fs.writeFileSync(args.out, JSON.stringify(history, null, 2));
    const total = history.lists.reduce((n, l) => n + l.tasks.length, 0);
    log(`\nWrote ${args.out}: ${total} tasks (history only), ${calls} API calls.`);
    return;
  }

  for (const l of lists) {
    const detail = await get(token, `${API}/list/${l.id}`);
    const fields = (await get(token, `${API}/list/${l.id}/field`)).fields || [];
    const tasks = await allTasks(token, l.id);
    log(`  ${l.folderName ? l.folderName + ' / ' : ''}${l.name}: ${tasks.length} open tasks (incl. subtasks)`);
    for (const t of tasks) {
      // Comments are the one thing not on the task row; one call per task.
      const c = await get(token, `${API}/task/${t.id}/comment`);
      t.comments = c.comments || [];
    }
    snapshot.lists.push({
      id: l.id, name: l.name, folderId: l.folderId, folderName: l.folderName,
      orderindex: l.orderindex, archived: !!l.archived,
      statuses: detail.statuses || [],
      customFields: fields,
      tasks,
    });
  }

  fs.writeFileSync(args.out, JSON.stringify(snapshot, null, 2));
  const total = snapshot.lists.reduce((n, l) => n + l.tasks.length, 0);
  const comments = snapshot.lists.reduce((n, l) => n + l.tasks.reduce((m, t) => m + t.comments.length, 0), 0);
  const attachments = snapshot.lists.reduce((n, l) => n + l.tasks.reduce((m, t) => m + (t.attachments || []).length, 0), 0);
  log(`\nWrote ${args.out}: ${total} tasks, ${comments} comments, ${attachments} attachments, ${calls} API calls.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
