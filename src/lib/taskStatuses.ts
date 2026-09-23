import { addDoc, collection, getDocs, orderBy, query, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import type { TaskStatusDef, TaskStatusSet, TaskStatusType } from '../types';

/**
 * Status sets live in their own collection so a list can swap its whole set
 * without touching its tasks. Exported so src/lib/tasks.ts can re-export it as
 * TASK_STATUS_SETS without importing back the other way (which would make the
 * two modules circular).
 */
export const STATUS_SETS_COLLECTION = 'taskStatusSets';

/**
 * The set every workspace starts with — the union of what the audited ClickUp
 * lists actually used, minus the two statuses that were named after people.
 * `PENDING EDITA` / `PENDING CHLOE'` collapse into one generic **Waiting On**
 * plus the task's `waitingOnUserId`, so the set stops changing when staff do.
 *
 * Deliberately NOT here: a `scheduled` status. Pre-live tasks reuse the
 * ticket Scheduled mechanic and only matter to lists that want them, so a
 * `scheduled`-typed status is added per set from Task Settings rather than
 * shipped to everyone. `TaskStatusType` supports it either way.
 */
export const DEFAULT_STATUS_SET: Omit<TaskStatusSet, 'id'> = {
  name: 'Default',
  statuses: [
    { id: 'todo', name: 'To Do', color: '#6B7280', order: 0, type: 'todo' },
    { id: 'in-progress', name: 'In Progress', color: '#B45309', order: 1, type: 'active' },
    { id: 'waiting', name: 'Waiting On', color: '#7C3AED', order: 2, type: 'waiting' },
    { id: 'complete', name: 'Complete', color: '#16A34A', order: 3, type: 'done' },
    { id: 'closed', name: 'Closed', color: '#9CA3AF', order: 4, type: 'closed' },
  ],
};

/** Accepts a whole set or just its statuses, so callers can pass either. */
type SetOrList = TaskStatusSet | TaskStatusDef[] | null | undefined;

function statusesOf(setOrList: SetOrList): TaskStatusDef[] {
  if (!setOrList) return [];
  return Array.isArray(setOrList) ? setOrList : (setOrList.statuses ?? []);
}

/** The status definition with this id, or null if the set doesn't contain it. */
export function statusDefOf(setOrList: SetOrList, statusId: string | null | undefined): TaskStatusDef | null {
  if (!statusId) return null;
  return statusesOf(setOrList).find((s) => s.id === statusId) ?? null;
}

/**
 * The semantic type behind a status id. Returns null for an unknown id — the
 * caller decides what to do, rather than us guessing a type and quietly
 * mis-filing the task in every downstream count.
 */
export function statusTypeOf(setOrList: SetOrList, statusId: string | null | undefined): TaskStatusType | null {
  return statusDefOf(setOrList, statusId)?.type ?? null;
}

/**
 * Where a new (or reset-by-recurrence) task starts: the lowest-ordered `todo`
 * status, falling back to the lowest-ordered status of any type so a set
 * without an explicit to-do still works.
 */
export function defaultStatusFor(setOrList: SetOrList): TaskStatusDef | null {
  const sorted = [...statusesOf(setOrList)].sort((a, b) => a.order - b.order);
  return sorted.find((s) => s.type === 'todo') ?? sorted[0] ?? null;
}

/**
 * Read every status set, seeding the default one the first time anyone opens a
 * task view. Modelled on getOrSeedRequestTypes: only superadmins can write, so
 * the seed fails silently for everyone else and they simply see an empty list
 * until an admin has been through once.
 */
export async function getOrSeedStatusSets(): Promise<TaskStatusSet[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, STATUS_SETS_COLLECTION), orderBy('name')));
  if (snap.size > 0) {
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskStatusSet));
  }

  try {
    const ref = await addDoc(collection(db, STATUS_SETS_COLLECTION), {
      ...DEFAULT_STATUS_SET,
      createdAt: serverTimestamp(),
    });
    return [{ id: ref.id, ...DEFAULT_STATUS_SET }];
  } catch {
    // Permission denied — a non-superadmin opened a task view before anyone
    // seeded the workspace. Not an error worth surfacing; just nothing to show.
    return [];
  }
}
