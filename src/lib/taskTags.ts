import { addDoc, collection, doc, getDocs, orderBy, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { TASKS } from './tasks';
import type { TaskTag } from '../types';

/**
 * Tags (Phase 7). The audited ClickUp workspace barely used them — Tag Manager
 * was paywalled there — so this stays small on purpose: CRUD, a colour, and
 * assignment onto a task's `tagIds`. No usage analytics, no tag groups.
 */
export const TASK_TAGS = 'taskTags';

export async function listTaskTags(): Promise<TaskTag[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, TASK_TAGS), orderBy('name')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskTag));
}

export async function createTaskTag(name: string, color: string): Promise<TaskTag> {
  if (!db) throw new Error('Firestore is not configured.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Tag name is required.');
  const ref = await addDoc(collection(db, TASK_TAGS), { name: trimmed, color });
  return { id: ref.id, name: trimmed, color };
}

export async function updateTaskTag(id: string, patch: Partial<Pick<TaskTag, 'name' | 'color'>>): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.color !== undefined) data.color = patch.color;
  await updateDoc(doc(db, TASK_TAGS, id), data);
}

/**
 * Delete a tag AND pull it off every task that still carries it — tags are
 * decoration, not a reference tasks should be left pointing at a dead id, and
 * unlike a status (which tasks structurally require) there's nothing to remap
 * a task to. Chunked the same way src/lib/onboarding.ts chunks bulk writes,
 * since a popular tag could touch more tasks than fit in one Firestore batch.
 */
const BATCH_LIMIT = 400;

export async function deleteTaskTag(id: string): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  const affected = await getDocs(query(collection(db, TASKS), where('tagIds', 'array-contains', id)));

  let batch = writeBatch(db);
  let pending = 0;
  for (const taskDoc of affected.docs) {
    const tagIds = ((taskDoc.data().tagIds as string[]) ?? []).filter((t) => t !== id);
    batch.update(taskDoc.ref, { tagIds });
    pending++;
    if (pending >= BATCH_LIMIT) { await batch.commit(); batch = writeBatch(db); pending = 0; }
  }
  batch.delete(doc(db, TASK_TAGS, id));
  await batch.commit();
}
