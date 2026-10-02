import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';
import admin from 'firebase-admin';

const PROJECT = 'spark-support-28ed9';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

// ── seed with the Admin SDK (bypasses rules) ────────────────────────────────
admin.initializeApp({ projectId: PROJECT });
const adb = admin.firestore();

const PEOPLE = [
  { id: 'mgr-1', role: 'admin' },
  { id: 'mgr-2', role: 'admin' },
  { id: 'usr-1', role: 'user' },
  { id: 'usr-2', role: 'user' },
];
for (const p of PEOPLE) {
  await adb.collection('profiles').doc(p.id).set({ name: p.id, email: `${p.id}@x.com`, role: p.role });
}
await adb.collection('meta').doc('adminIds').set({ ids: ['mgr-1', 'mgr-2'] });
// Reset the counter so re-running the suite does not fail the monotonic rule.
await adb.collection('meta').doc('ticketCounter').delete().catch(() => {});
await adb.collection('tickets').doc('T1').set({
  title: 'Test', type: 'HR', status: 'Open', priority: 'Low',
  assigneeIds: ['mgr-1', 'usr-1'], submitterId: 'usr-2',
  participants: ['usr-2', 'mgr-1', 'usr-1'], createdAt: admin.firestore.Timestamp.now(),
});

// ── client SDK, as real signed-in users ─────────────────────────────────────
const app = initializeApp({ apiKey: 'demo', projectId: PROJECT });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const cdb = getFirestore(app);
connectFirestoreEmulator(cdb, '127.0.0.1', 8080);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (uid) => {
  const now = Math.floor(Date.now() / 1000);
  return [b64({ alg: 'none', typ: 'JWT' }), b64({
    uid, iat: now, exp: now + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iss: 'firebase-auth-emulator@example.com', sub: 'firebase-auth-emulator@example.com',
  }), ''].join('.');
};
const as = async (uid) => { await signOut(auth).catch(() => {}); await signInWithCustomToken(auth, token(uid)); };

let pass = 0, fail = 0;
const check = async (label, expect, fn) => {
  let got = 'ALLOW';
  try { await fn(); } catch (e) { got = (e.code || '').includes('permission') ? 'DENY' : `ERR(${e.code || e.message})`; }
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  → expected ${expect}, got ${got}`);
};

console.log('\nTicket update rules\n');
await as('mgr-1');
await check('Manager updates status', 'ALLOW', () => updateDoc(doc(cdb, 'tickets/T1'), { status: 'In Progress' }));

await as('usr-1');
await check('ASSIGNED User updates status', 'ALLOW', () => updateDoc(doc(cdb, 'tickets/T1'), { status: 'On Hold' }));
await check('ASSIGNED User reassigns, keeping a Manager', 'ALLOW',
  () => updateDoc(doc(cdb, 'tickets/T1'), { assigneeIds: ['mgr-1', 'usr-1', 'usr-2'] }));
await check('ASSIGNED User removes the last Manager', 'DENY',
  () => updateDoc(doc(cdb, 'tickets/T1'), { assigneeIds: ['usr-1', 'usr-2'] }));

// T2 exists so the non-assignee case is tested on a ticket the earlier
// reassignment step cannot have quietly added them to.
await adb.collection('tickets').doc('T2').set({
  title: 'Second', type: 'HR', status: 'Open', priority: 'Low',
  assigneeIds: ['mgr-1'], submitterId: 'usr-2',
  participants: ['usr-2', 'mgr-1'], createdAt: admin.firestore.Timestamp.now(),
});
await as('usr-2');
await check('User who is a PARTICIPANT but not assigned updates status', 'DENY',
  () => updateDoc(doc(cdb, 'tickets/T2'), { status: 'Resolved' }));
await check('User who is a participant can still READ the ticket', 'ALLOW',
  () => getDoc(doc(cdb, 'tickets/T2')));
await as('usr-1');
await check('User with no relationship to the ticket updates it', 'DENY',
  () => updateDoc(doc(cdb, 'tickets/T2'), { status: 'Resolved' }));

await as('mgr-1');
await check('MANAGER removes the last Manager (accountability guard)', 'DENY',
  () => updateDoc(doc(cdb, 'tickets/T1'), { assigneeIds: ['usr-1'] }));
await check('Manager unassigns entirely (empty is allowed)', 'ALLOW',
  () => updateDoc(doc(cdb, 'tickets/T1'), { assigneeIds: [] }));

console.log('\nmeta/adminIds must not be client-writable\n');
await as('usr-1');
await check('User overwrites meta/adminIds', 'DENY',
  () => setDoc(doc(cdb, 'meta/adminIds'), { ids: ['usr-1'], count: 1 }));
await check('User reads meta/adminIds', 'ALLOW', () => getDoc(doc(cdb, 'meta/adminIds')));
await check('Ticket counter still works', 'ALLOW',
  () => setDoc(doc(cdb, 'meta/ticketCounter'), { count: 1 }));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
