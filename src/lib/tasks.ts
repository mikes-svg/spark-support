import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from './firebase';
import { isAdminRole } from '../types';
import { STATUS_SETS_COLLECTION, defaultStatusFor, statusDefOf } from './taskStatuses';
import type {
  Subtask,
  Task,
  TaskFilter,
  TaskInput,
  TaskList,
  TaskStatusDef,
  TaskStatusSet,
} from '../types';

// ─── Collections ─────────────────────────────────────────────────────────────

export const TASKS = 'tasks';
export const TASK_LISTS = 'taskLists';
export const TASK_SPACES = 'taskSpaces';
/** Re-exported from taskStatuses.ts, which owns the seeding, so the name has
 *  exactly one definition and the two modules stay acyclic. */
export const TASK_STATUS_SETS = STATUS_SETS_COLLECTION;
export const TASK_SERIES = 'taskSeries';
export const TASK_TEMPLATES = 'taskTemplates';

function getDb() {
  if (!db) throw new Error('Firestore is not configured.');
  return db;
}

// ─── Participants ────────────────────────────────────────────────────────────

/**
 * Everyone attached to a task: creator + assignees + watchers, deduped.
 *
 * This array is what firestore.rules checks on update, so it MUST be recomputed
 * by every mutation that touches assignees or watchers — a stale participants
 * list is how a newly-assigned person ends up unable to edit their own task.
 * `waitingOnUserId` is deliberately not included: being blocked on someone
 * doesn't hand them write access, and reads are open to every signed-in user.
 */
export function participantsOf(task: {
  creatorId?: string | null;
  assigneeIds?: string[] | null;
  watcherIds?: string[] | null;
}): string[] {
  return [
    ...new Set(
      [task.creatorId, ...(task.assigneeIds ?? []), ...(task.watcherIds ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
}

/**
 * Who may change a task: anyone already attached to it, or any admin. Mirrors
 * the `tasks` update rule — keep the two in step, or the UI will offer edits
 * Firestore then rejects.
 */
export function canEditTask(
  uid: string | null | undefined,
  task: { participants?: string[] | null; creatorId?: string | null } | null | undefined,
  profile?: { role?: string | null } | null,
): boolean {
  if (!uid || !task) return false;
  if (isAdminRole(profile?.role)) return true;
  if (task.creatorId === uid) return true;
  return (task.participants ?? []).includes(uid);
}

// ─── Status resolution ───────────────────────────────────────────────────────

/**
 * The status set a list draws from. A list normally names one; when it doesn't
 * (imported data, a set that was swapped out) we fall back to scanning every
 * set for the status id, which is cheap at this scale and beats writing a task
 * with a status whose type we had to guess.
 */
async function loadStatusSetForList(listId: string): Promise<TaskStatusSet | null> {
  const database = getDb();
  const listSnap = await getDoc(doc(database, TASK_LISTS, listId));
  const setId = listSnap.exists() ? (listSnap.data() as TaskList).defaultStatusSetId : null;

  if (setId) {
    const setSnap = await getDoc(doc(database, TASK_STATUS_SETS, setId));
    if (setSnap.exists()) return { id: setSnap.id, ...setSnap.data() } as TaskStatusSet;
  }
  const all = await getDocs(collection(database, TASK_STATUS_SETS));
  const sets = all.docs.map((d) => ({ id: d.id, ...d.data() } as TaskStatusSet));
  return sets[0] ?? null;
}

/** Resolve a status id (or the list's default) to a full definition. */
async function resolveStatus(listId: string, statusId?: string | null): Promise<TaskStatusDef> {
  const set = await loadStatusSetForList(listId);
  const def = statusId ? statusDefOf(set, statusId) : defaultStatusFor(set);
  if (!def) {
    throw new Error(
      statusId
        ? `Status "${statusId}" is not in this list's status set.`
        : 'This list has no status set yet — add one in Task Settings.',
    );
  }
  return def;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a task and its 'created' audit event in ONE atomic batch, mirroring
 * activateScheduledTickets in functions/: either the task exists with its
 * history, or nothing was written and the caller can retry cleanly.
 *
 * Everything the caller omits is defaulted here, so callers never have to
 * remember that `participants` must be derived or that dates are day strings.
 */
export async function createTask(input: TaskInput): Promise<Task> {
  const database = getDb();
  const ref = doc(collection(database, TASKS));

  // Trust an explicitly-supplied status triple (the recurrence preview and the
  // importer both have one in hand); otherwise resolve it off the list.
  const status: Pick<Task, 'statusId' | 'statusName' | 'statusType'> =
    input.statusId && input.statusName && input.statusType
      ? { statusId: input.statusId, statusName: input.statusName, statusType: input.statusType }
      : await (async () => {
          const def = await resolveStatus(input.listId, input.statusId);
          return { statusId: def.id, statusName: def.name, statusType: def.type };
        })();

  const draft: Task = {
    id: ref.id,
    listId: input.listId,
    spaceId: input.spaceId,
    title: input.title.trim(),
    description: input.description ?? '',
    ...status,
    waitingOnUserId: input.waitingOnUserId ?? null,
    priority: input.priority ?? null,
    assigneeIds: input.assigneeIds ?? [],
    creatorId: input.creatorId,
    watcherIds: input.watcherIds ?? [],
    participants: [],
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    goLiveDate: input.goLiveDate ?? null,
    tagIds: input.tagIds ?? [],
    subtasks: input.subtasks ?? [],
    order: input.order ?? Date.now(),
    seriesId: input.seriesId ?? null,
    occurrenceKey: input.occurrenceKey ?? null,
    gcalEventId: input.gcalEventId ?? null,
    gcalSyncedAt: null,
    completedAt: null,
  };
  draft.participants = participantsOf(draft);

  const { id: _id, ...data } = draft;
  const batch = writeBatch(database);
  batch.set(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(doc(collection(database, 'taskEvents')), {
    taskId: ref.id,
    type: 'created',
    actorId: input.creatorId,
    toStatusId: draft.statusId,
    toStatusType: draft.statusType,
    createdAt: serverTimestamp(),
  });
  await batch.commit();

  return draft;
}

/**
 * Patch a task. Participants are re-derived whenever assignees, watchers, or
 * the creator move, so write access can never drift out of step with who is on
 * the task. `undefined` values are dropped — Firestore rejects them, and a
 * caller spreading a partial object shouldn't have to pre-clean it.
 */
export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const database = getDb();
  const { id: _ignored, ...rest } = patch;

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) data[key] = value;
  }

  const touchesPeople =
    'assigneeIds' in data || 'watcherIds' in data || 'creatorId' in data;
  if (touchesPeople) {
    const current = await getTask(id);
    if (!current) throw new Error('That task no longer exists.');
    data.participants = participantsOf({
      creatorId: (data.creatorId as string) ?? current.creatorId,
      assigneeIds: (data.assigneeIds as string[]) ?? current.assigneeIds,
      watcherIds: (data.watcherIds as string[]) ?? current.watcherIds,
    });
  }

  data.updatedAt = serverTimestamp();
  const batch = writeBatch(database);
  batch.update(doc(database, TASKS, id), data);
  await batch.commit();
}

/**
 * Delete the task document. Its comments, audit events, and attachment
 * metadata live in sibling/child collections and are NOT removed here — a
 * client can't fan out a subcollection delete safely. Cleanup is a server-side
 * job; until it exists, deleting is a rare superadmin/creator action.
 */
export async function deleteTask(id: string): Promise<void> {
  await deleteDoc(doc(getDb(), TASKS, id));
}

export async function getTask(id: string): Promise<Task | null> {
  const snap = await getDoc(doc(getDb(), TASKS, id));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Task) : null;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Run a filter against Firestore, then finish the job in memory.
 *
 * Firestore allows only one array/disjunction clause per query and needs a
 * composite index for every equality+sort pair, so exactly ONE filter field
 * becomes the server-side constraint — picked by the precedence below, each
 * paired with the sort its index in firestore.indexes.json covers:
 *
 *   seriesId    → orderBy occurrenceKey   listId   → orderBy order
 *   assigneeIds → orderBy dueDate         tagIds   → orderBy dueDate
 *   spaceId     → orderBy dueDate         statusTypes → orderBy dueDate
 *
 * Everything else is applied in memory. That keeps this honest (no query that
 * silently needs an index nobody created) at the cost of over-reading, which is
 * the right trade at a few hundred tasks. `limit` is therefore a display cap
 * applied last, not a read cap.
 */
export async function listTasks(filter: TaskFilter): Promise<Task[]> {
  const database = getDb();
  const constraints: QueryConstraint[] = [];

  // Pick the single server-side constraint and its matching sort.
  let sortedByDueDate = false;
  if (filter.seriesId) {
    constraints.push(where('seriesId', '==', filter.seriesId), orderBy('occurrenceKey'));
  } else if (filter.listId) {
    constraints.push(where('listId', '==', filter.listId), orderBy('order'));
  } else if (filter.assigneeIds?.length) {
    constraints.push(
      where('assigneeIds', 'array-contains-any', filter.assigneeIds.slice(0, 30)),
      orderBy('dueDate'),
    );
    sortedByDueDate = true;
  } else if (filter.tagIds?.length) {
    constraints.push(
      where('tagIds', 'array-contains-any', filter.tagIds.slice(0, 30)),
      orderBy('dueDate'),
    );
    sortedByDueDate = true;
  } else if (filter.spaceId) {
    constraints.push(where('spaceId', '==', filter.spaceId), orderBy('dueDate'));
    sortedByDueDate = true;
  } else if (filter.statusTypes?.length) {
    constraints.push(
      where('statusType', 'in', filter.statusTypes.slice(0, 30)),
      orderBy('dueDate'),
    );
    sortedByDueDate = true;
  }

  // A due-date range only rides along when dueDate is already the sort key;
  // otherwise it would demand an index that doesn't exist, so it's filtered
  // below instead.
  if (sortedByDueDate) {
    if (filter.dueFrom) constraints.push(where('dueDate', '>=', filter.dueFrom));
    if (filter.dueTo) constraints.push(where('dueDate', '<=', filter.dueTo));
  }

  const snap = await getDocs(query(collection(database, TASKS), ...constraints));
  let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task));

  // ── in-memory pass ──
  const search = filter.search?.trim().toLowerCase();
  // Hoisted so the closure below sees narrowed, non-null arrays.
  const wantedAssignees = filter.assigneeIds ?? [];
  const wantedTags = filter.tagIds ?? [];
  const wantedStatusTypes = filter.statusTypes ?? [];
  const wantedPriorities = filter.priorities ?? [];
  rows = rows.filter((t) => {
    if (filter.listId && t.listId !== filter.listId) return false;
    if (filter.spaceId && t.spaceId !== filter.spaceId) return false;
    if (filter.seriesId && t.seriesId !== filter.seriesId) return false;
    if (wantedAssignees.length && !(t.assigneeIds ?? []).some((id) => wantedAssignees.includes(id))) return false;
    if (wantedTags.length && !(t.tagIds ?? []).some((id) => wantedTags.includes(id))) return false;
    if (wantedStatusTypes.length && !wantedStatusTypes.includes(t.statusType)) return false;
    if (wantedPriorities.length && !(t.priority && wantedPriorities.includes(t.priority))) return false;
    // Undated tasks drop out of any date-bounded view — an open-ended task is
    // not "due in this range", and Firestore sorts null before every string,
    // which would otherwise sweep every undated task into the first page.
    if (filter.dueFrom && !(t.dueDate && t.dueDate >= filter.dueFrom)) return false;
    if (filter.dueTo && !(t.dueDate && t.dueDate <= filter.dueTo)) return false;
    if (!filter.includeDone && (t.statusType === 'done' || t.statusType === 'closed')) return false;
    if (!filter.includeScheduled && t.statusType === 'scheduled') return false;
    if (search && !t.title?.toLowerCase().includes(search)) return false;
    return true;
  });

  // Soonest due first, undated last, then by manual order — the same reading
  // order every task view wants, regardless of which constraint ran server-side.
  rows.sort((a, b) => {
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    return (a.order ?? 0) - (b.order ?? 0);
  });

  return filter.limit ? rows.slice(0, filter.limit) : rows;
}

// ─── Mutations that log ──────────────────────────────────────────────────────

/**
 * Move a task to another status, resolving the label and type off the list's
 * status set so the denormalized copy on the task can never disagree with the
 * set. The status change and its audit event commit as one atomic batch, so
 * analytics can't end up with a gap where a transition simply vanished.
 *
 * `completedAt` is stamped on the way into a done/closed status and cleared on
 * the way out, so "completed last 30 days" counts reopens correctly.
 */
export async function setStatus(id: string, statusId: string, actorId: string): Promise<void> {
  const database = getDb();
  const task = await getTask(id);
  if (!task) throw new Error('That task no longer exists.');
  if (task.statusId === statusId) return;

  const def = await resolveStatus(task.listId, statusId);
  const wasDone = task.statusType === 'done' || task.statusType === 'closed';
  const isDone = def.type === 'done' || def.type === 'closed';

  const batch = writeBatch(database);
  batch.update(doc(database, TASKS, id), {
    statusId: def.id,
    statusName: def.name,
    statusType: def.type,
    ...(isDone && !wasDone ? { completedAt: serverTimestamp() } : {}),
    ...(!isDone && wasDone ? { completedAt: null } : {}),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(collection(database, 'taskEvents')), {
    taskId: id,
    type: 'status_changed',
    actorId,
    fromStatusId: task.statusId ?? null,
    fromStatusType: task.statusType ?? null,
    toStatusId: def.id,
    toStatusType: def.type,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

/**
 * Check or uncheck one checklist item. Subtasks are an array field, so the
 * whole array is rewritten — `doneAt` is an ISO string rather than a server
 * timestamp because Firestore refuses sentinel values inside arrays.
 */
export async function toggleSubtask(
  id: string,
  subtaskId: string,
  done: boolean,
  actorId: string,
): Promise<void> {
  const database = getDb();
  const task = await getTask(id);
  if (!task) throw new Error('That task no longer exists.');

  const subtasks: Subtask[] = (task.subtasks ?? []).map((s) =>
    s.id === subtaskId
      ? { ...s, done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? actorId : null }
      : s,
  );

  const batch = writeBatch(database);
  batch.update(doc(database, TASKS, id), { subtasks, updatedAt: serverTimestamp() });
  batch.set(doc(collection(database, 'taskEvents')), {
    taskId: id,
    type: 'subtask_toggled',
    actorId,
    subtaskId,
    note: done ? 'checked' : 'unchecked',
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}
