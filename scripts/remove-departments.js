#!/usr/bin/env node
/**
 * One-off cleanup after the department-routing feature was removed.
 *
 * Departments were live in production briefly (PR #9). Anything that touched
 * them left data behind that the app now ignores but that should not linger:
 *
 *   - tickets        `departmentId` field; `participants` still holding the
 *                    members who were denormalised in by the routing
 *   - requestTypes   `defaultDepartmentId` field
 *   - departments    the collection itself
 *
 * Audit events of type `department_changed` are left alone: they are history,
 * and the analytics page ignores event types it does not know.
 *
 * Dry run by default — prints what would change and writes nothing:
 *
 *   node scripts/remove-departments.js [--project spark-support-28ed9]
 *
 * Then apply:
 *
 *   node scripts/remove-departments.js --commit [--project spark-support-28ed9]
 *
 * Needs Admin SDK credentials for the project (GOOGLE_APPLICATION_CREDENTIALS
 * or `gcloud auth application-default login`), the same as the ClickUp import
 * in scripts/README.md. With FIRESTORE_EMULATOR_HOST set it runs against the
 * emulator instead, which is a good rehearsal.
 *
 * Order of operations for the rollout: deploy rules + functions first (the
 * deploy removes the onDepartmentWritten trigger), then run this with
 * --commit. Running it before the deploy also works — the trigger would just
 * clear each department's tickets itself as the docs are deleted.
 */

const path = require('path');
// The Admin SDK lives in functions/node_modules, like the other scripts here.
module.paths.push(path.join(__dirname, '..', 'functions', 'node_modules'));
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

function parseArgs(argv) {
  const args = { commit: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--dry-run') args.commit = false;
    else if (a === '--project') args.project = argv[++i];
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

/** Who can see a ticket once departments are gone: submitter + assignees. */
function participantsFor(ticket) {
  if (ticket.status === 'Scheduled') return [ticket.submitterId];
  const assignees = Array.isArray(ticket.assigneeIds)
    ? ticket.assigneeIds
    : ticket.assigneeId ? [ticket.assigneeId] : [];
  return [...new Set([ticket.submitterId, ...assignees].filter(Boolean))];
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!admin.apps.length) admin.initializeApp(args.project ? { projectId: args.project } : undefined);
  const db = admin.firestore();
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`
    : `project ${args.project || '(default credentials)'}`;
  console.log(`${args.commit ? 'Cleaning up' : 'DRY RUN against'} ${target}\n`);

  const batch = db.batch();
  let writes = 0;

  // Tickets: drop the field; recompute participants where routing had added
  // department members to them.
  const tickets = await db.collection('tickets').get();
  let withField = 0;
  let participantsFixed = 0;
  for (const snap of tickets.docs) {
    const t = snap.data();
    if (!('departmentId' in t)) continue;
    withField++;
    const update = { departmentId: FieldValue.delete() };
    const wanted = participantsFor(t);
    const current = Array.isArray(t.participants) ? t.participants : [];
    if (!sameSet(current, wanted)) {
      update.participants = wanted;
      participantsFixed++;
      console.log(`  ${snap.id}: participants ${JSON.stringify(current)} -> ${JSON.stringify(wanted)}`);
    }
    batch.update(snap.ref, update);
    writes++;
  }
  console.log(`Tickets: ${tickets.size} total, ${withField} carry departmentId, ${participantsFixed} need participants recomputed`);

  // Request types: drop the default department.
  const types = await db.collection('requestTypes').get();
  let typesWithField = 0;
  for (const snap of types.docs) {
    if (!('defaultDepartmentId' in snap.data())) continue;
    typesWithField++;
    batch.update(snap.ref, { defaultDepartmentId: FieldValue.delete() });
    writes++;
  }
  console.log(`Request types: ${types.size} total, ${typesWithField} carry defaultDepartmentId`);

  // The departments themselves.
  const departments = await db.collection('departments').get();
  for (const snap of departments.docs) {
    console.log(`  department ${snap.id}: ${JSON.stringify(snap.data().name)} (${(snap.data().memberIds || []).length} members)`);
    batch.delete(snap.ref);
    writes++;
  }
  console.log(`Departments: ${departments.size} to delete`);

  if (!args.commit) {
    console.log(`\nThis was a DRY RUN: ${writes} writes would be made. Re-run with --commit to apply.`);
    return;
  }
  if (writes === 0) { console.log('\nNothing to do.'); return; }
  if (writes > 450) {
    // A batch holds 500 operations; this cleanup is far smaller in practice.
    throw new Error(`${writes} writes exceed one batch; split the run or raise the limit deliberately.`);
  }
  await batch.commit();
  console.log(`\nDone: ${writes} writes committed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
