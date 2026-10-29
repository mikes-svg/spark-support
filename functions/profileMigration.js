/**
 * Carry an invited person's work across to their real account.
 *
 * Inviting someone from the Team page creates their profile under an
 * email-slug id (`acc1_sparkmanage_com`) so work can be assigned to them before
 * they ever sign in. On first sign-in, ensureProfile creates the real UID
 * profile and deletes the slug one — which, until this module existed, silently
 * orphaned everything that pointed at the slug: tasks they were assigned,
 * tickets routed to them, comments they had authored via the ClickUp import,
 * default-assignee settings naming them. The person would sign in to an empty
 * portal while their work sat assigned to a profile that no longer existed.
 *
 * `rewriteReferences` is the pure part: given one document's data and the id
 * mapping, it returns the minimal patch (or null). `migrateReferences` finds
 * every document that can reference a person and applies that patch in
 * batches. The table of where ids live is here, in one place, because the
 * failure mode is a reference nobody remembered — add a new user-id field
 * anywhere in the app and it must be added here too.
 */
'use strict';

/**
 * Every field in every collection that holds a profile id.
 *
 * `arrays` are queried with array-contains and deduped on rewrite; `scalars`
 * with ==. `nested` are arrays of objects whose own fields hold ids (stages,
 * subtasks) — they cannot be queried, so they are rewritten whenever the
 * document was found through one of the other fields.
 */
const REFERENCES = [
  {
    collection: 'tasks',
    arrays: ['assigneeIds', 'watcherIds', 'participants'],
    scalars: ['creatorId', 'waitingOnUserId'],
    nested: [
      { field: 'stages', arrays: ['assigneeIds'], scalars: ['completedBy'] },
      { field: 'subtasks', arrays: ['assigneeIds'], scalars: ['doneBy'] },
    ],
  },
  {
    collection: 'taskSeries',
    arrays: ['payload.assigneeIds', 'payload.watcherIds'],
    scalars: ['creatorId', 'payload.creatorId', 'payload.waitingOnUserId'],
    nested: [{ field: 'payload.stages', arrays: ['assigneeIds'], scalars: [] }],
  },
  { collection: 'taskComments', arrays: ['mentionedIds'], scalars: ['userId'], nested: [] },
  { collection: 'taskEvents', arrays: ['fromAssigneeIds', 'toAssigneeIds'], scalars: ['actorId'], nested: [] },
  { collection: 'tickets', arrays: ['assigneeIds'], scalars: ['assigneeId', 'submitterId'], nested: [] },
  { collection: 'requestTypes', arrays: ['defaultAssigneeIds'], scalars: ['defaultAssigneeId'], nested: [] },
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function rewriteArray(arr, fromSet, toId) {
  if (!Array.isArray(arr) || !arr.some((v) => fromSet.has(v))) return null;
  const out = [];
  for (const v of arr) {
    const next = fromSet.has(v) ? toId : v;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * The patch that moves every reference in `data` from any of `fromIds` to
 * `toId`, as dotted field paths ready for `update()`. Null when nothing points
 * at the old ids. Pure: never touches Firestore.
 */
function rewriteReferences(spec, data, fromIds, toId) {
  const fromSet = new Set(fromIds);
  const patch = {};
  let changed = false;

  for (const field of spec.arrays) {
    const next = rewriteArray(getPath(data, field), fromSet, toId);
    if (next) { patch[field] = next; changed = true; }
  }
  for (const field of spec.scalars) {
    if (fromSet.has(getPath(data, field))) { patch[field] = toId; changed = true; }
  }
  for (const n of spec.nested || []) {
    const items = getPath(data, n.field);
    if (!Array.isArray(items)) continue;
    let touched = false;
    const rewritten = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      let copy = item;
      for (const f of n.arrays) {
        const next = rewriteArray(item[f], fromSet, toId);
        if (next) { copy = { ...copy, [f]: next }; touched = true; }
      }
      for (const f of n.scalars) {
        if (fromSet.has(item[f])) { copy = { ...copy, [f]: toId }; touched = true; }
      }
      return copy;
    });
    if (touched) { patch[n.field] = rewritten; changed = true; }
  }
  return changed ? patch : null;
}

/**
 * Find and rewrite every document referencing `fromIds`. Returns per-collection
 * counts. Reads are one query per (field × fromId); writes go in batches of
 * 400, under Firestore's 500 cap.
 */
async function migrateReferences(db, fromIds, toId) {
  const counts = {};
  if (!fromIds.length) return counts;
  for (const spec of REFERENCES) {
    const found = new Map(); // path -> snapshot
    for (const fromId of fromIds) {
      const queries = [
        ...spec.arrays.map((f) => db.collection(spec.collection).where(f, 'array-contains', fromId)),
        ...spec.scalars.map((f) => db.collection(spec.collection).where(f, '==', fromId)),
      ];
      for (const q of queries) {
        const snap = await q.get();
        snap.docs.forEach((d) => found.set(d.ref.path, d));
      }
    }
    let batch = db.batch();
    let pending = 0;
    let n = 0;
    for (const d of found.values()) {
      const patch = rewriteReferences(spec, d.data(), fromIds, toId);
      if (!patch) continue;
      batch.update(d.ref, patch);
      n++;
      if (++pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending) await batch.commit();
    if (n) counts[spec.collection] = n;
  }
  return counts;
}

module.exports = { REFERENCES, rewriteReferences, migrateReferences };
