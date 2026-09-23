#!/usr/bin/env node
/**
 * Verify the Google Calendar OAuth config is present and internally consistent,
 * WITHOUT printing secrets. Only lengths, prefixes and shape are reported, so
 * this is safe to run with someone watching or to paste into a chat.
 *
 *   node scripts/check-gcal-config.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '..', 'functions', '.env.local');

if (!fs.existsSync(ENV_PATH)) {
  console.error('\n  functions/.env.local not found.');
  console.error('  Copy functions/.env.example to functions/.env.local and fill it in.\n');
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

const problems = [];
const notes = [];

const id = env.GCAL_CLIENT_ID || '';
const secret = env.GCAL_CLIENT_SECRET || '';
const redirect = env.GCAL_REDIRECT_URI || '';
const webhook = env.GCAL_WEBHOOK_URL || '';

// ── client id ──────────────────────────────────────────────────────────────
if (!id) problems.push('GCAL_CLIENT_ID is empty.');
else if (!/\.apps\.googleusercontent\.com$/.test(id))
  problems.push('GCAL_CLIENT_ID should end in .apps.googleusercontent.com — this looks like the wrong value.');
else notes.push(`client id   ...${id.slice(-32)}`);

// ── client secret ──────────────────────────────────────────────────────────
if (!secret) problems.push('GCAL_CLIENT_SECRET is empty.');
else if (/\.apps\.googleusercontent\.com$/.test(secret))
  problems.push('GCAL_CLIENT_SECRET holds a client ID — the two values are swapped.');
else if (!/^GOCSPX-/.test(secret))
  notes.push(`client secret present (${secret.length} chars) — note Google secrets normally start "GOCSPX-".`);
else notes.push(`client secret present (${secret.length} chars, GOCSPX-…)`);

// ── redirect uri ───────────────────────────────────────────────────────────
if (!redirect) {
  problems.push('GCAL_REDIRECT_URI is empty.');
} else {
  if (!redirect.endsWith('/settings/calendar'))
    problems.push('GCAL_REDIRECT_URI must end in /settings/calendar — that is the path the client sends.');
  if (!/^https:/.test(redirect) && !/^http:\/\/localhost(:\d+)?\//.test(redirect))
    problems.push('GCAL_REDIRECT_URI must be https, or http://localhost for local runs.');
  notes.push(`redirect    ${redirect}`);
}

// ── webhook ────────────────────────────────────────────────────────────────
if (!webhook) {
  notes.push('webhook     (unset) — outbound sync only; Google cannot push to localhost.');
} else if (!/^https:/.test(webhook)) {
  problems.push('GCAL_WEBHOOK_URL must be https — Google refuses to deliver to plain http or localhost.');
} else {
  notes.push(`webhook     ${webhook}`);
}

console.log('\nGoogle Calendar config — functions/.env.local\n');
notes.forEach((n) => console.log('  ' + n));

if (problems.length) {
  console.log('\n  Problems:');
  problems.forEach((p) => console.log('   ✗ ' + p));
  console.log('');
  process.exit(1);
}

console.log('\n  Config looks well-formed. It has NOT been checked against Google yet —');
console.log('  connect an account at /settings/calendar to prove it end to end.\n');
