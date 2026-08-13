import {
  collection,
  doc,
  getDocs,
  query,
  where,
  orderBy,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { addDaysStr, diffDaysStr } from './dates';
import { hasOnboardingAccess } from '../types';
import type {
  OnboardingProperty,
  OnboardingTask,
  OnboardingTemplateItem,
  Profile,
} from '../types';

export const PROPERTIES = 'onboardingProperties';
export const TASKS = 'onboardingTasks';
export const TEMPLATE = 'onboardingTemplate';

/** Firestore refuses batches larger than 500 writes; commit in chunks below it. */
const BATCH_LIMIT = 400;

/**
 * The due-date rule, in one place: a task's due date is its property's closing
 * date shifted by the task's "days from closing" offset. Tasks with no offset
 * (or properties with no closing date yet) keep whatever date was typed in.
 */
export function computeDueDate(closingDate: string | null, daysFromClosing: number | null): string | null {
  if (closingDate == null || daysFromClosing == null) return null;
  return addDaysStr(closingDate, daysFromClosing);
}

/**
 * The inverse: when someone types a due date directly, re-derive the offset so
 * the row keeps tracking future closing-date changes instead of falling out of
 * the formula. Returns null when there's no closing date to measure against.
 */
export function deriveDaysFromClosing(closingDate: string | null, dueDate: string | null): number | null {
  if (!closingDate || !dueDate) return null;
  return diffDaysStr(closingDate, dueDate);
}

/**
 * Sort key for a new row placed between two existing ones. Orders are spaced by
 * 100 at seed time so inserts rarely collide; when neighbours are adjacent the
 * midpoint is fractional, which sorts fine and needs no renumbering pass.
 */
export function orderBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 100;
  if (before == null) return (after as number) - 100;
  if (after == null) return before + 100;
  return (before + after) / 2;
}

/** Group rows into their sections, preserving the order the rows came in. */
export function groupBySection<T extends { section: string; order: number }>(rows: T[]): { section: string; rows: T[] }[] {
  const groups: { section: string; rows: T[] }[] = [];
  for (const row of [...rows].sort((a, b) => a.order - b.order)) {
    const last = groups[groups.length - 1];
    if (last && last.section === row.section) last.rows.push(row);
    else groups.push({ section: row.section, rows: [row] });
  }
  return groups;
}

/** A task counts as done for progress purposes when it's Complete or N/A. */
export function isTaskDone(task: { status: string }): boolean {
  return task.status === 'Complete' || task.status === 'N/A';
}

/** True if an incomplete task's due date has passed. */
export function isOverdue(task: { status: string; dueDate?: string | null }, today: string): boolean {
  if (!task.dueDate || isTaskDone(task)) return false;
  return task.dueDate < today;
}

/**
 * The people who can be made responsible for a task: everyone with onboarding
 * access (superadmins included, since access is implicit for them).
 */
export async function fetchOnboardingPeople(): Promise<Profile[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, 'profiles'));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Profile))
    .filter((p) => hasOnboardingAccess(p))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchProperties(): Promise<OnboardingProperty[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, PROPERTIES), orderBy('createdAt')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OnboardingProperty));
}

export async function fetchTasksForProperty(propertyId: string): Promise<OnboardingTask[]> {
  if (!db) return [];
  const snap = await getDocs(
    query(collection(db, TASKS), where('propertyId', '==', propertyId), orderBy('order'))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OnboardingTask));
}

/**
 * Create a property and instantiate every template row as a task, computing due
 * dates from the closing date up front. Returns the new property plus its tasks
 * so the caller can render without a round trip.
 */
export async function createPropertyFromTemplate(
  input: { name: string; closingDate: string | null },
  template: OnboardingTemplateItem[],
  createdBy: string,
): Promise<{ property: OnboardingProperty; tasks: OnboardingTask[] }> {
  if (!db) throw new Error('Firestore is not configured.');

  const propertyRef = doc(collection(db, PROPERTIES));
  const property: OnboardingProperty = {
    id: propertyRef.id,
    name: input.name,
    closingDate: input.closingDate,
    psaExecutionDate: null,
    titleCommitmentDate: null,
    titleNoticeDate: null,
    ddCompletionDate: null,
    extension: '',
    archived: false,
  };

  const tasks: OnboardingTask[] = [...template]
    .sort((a, b) => a.order - b.order)
    .map((item) => ({
      id: doc(collection(db!, TASKS)).id,
      propertyId: propertyRef.id,
      section: item.section,
      order: item.order,
      code: item.code,
      indent: item.indent,
      title: item.title,
      responsibleIds: item.responsibleIds ?? [],
      daysFromClosing: item.daysFromClosing ?? null,
      dueDate: computeDueDate(input.closingDate, item.daysFromClosing ?? null),
      status: 'Not Started',
      notes: '',
      delays: [],
    }));

  const { id: _propertyId, ...propertyData } = property;
  const firstBatch = writeBatch(db);
  firstBatch.set(propertyRef, { ...propertyData, createdBy, createdAt: serverTimestamp() });
  // The property doc rides along with the first chunk of tasks, so a failure
  // can't leave a property with no checklist.
  await commitChunks(tasks, (batch, task) => {
    const { id, ...data } = task;
    batch.set(doc(db!, TASKS, id), { ...data, createdAt: serverTimestamp() });
  }, firstBatch);

  return { property, tasks };
}

/**
 * Apply a new closing date: every task carrying an offset gets its due date
 * recalculated. Returns the updated tasks for optimistic rendering.
 */
export async function applyClosingDate(
  propertyId: string,
  closingDate: string | null,
  tasks: OnboardingTask[],
): Promise<OnboardingTask[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const propertyRef = doc(db, PROPERTIES, propertyId);

  const affected = tasks.filter((t) => t.daysFromClosing != null);
  const updated = tasks.map((t) =>
    t.daysFromClosing == null ? t : { ...t, dueDate: computeDueDate(closingDate, t.daysFromClosing) }
  );

  const firstBatch = writeBatch(db);
  firstBatch.update(propertyRef, { closingDate });
  await commitChunks(affected, (batch, task) => {
    batch.update(doc(db!, TASKS, task.id), {
      dueDate: computeDueDate(closingDate, task.daysFromClosing),
      updatedAt: serverTimestamp(),
    });
  }, firstBatch);

  return updated;
}

/** Delete a property and every task under it. */
export async function deletePropertyWithTasks(propertyId: string, tasks: OnboardingTask[]): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  await commitChunks(tasks, (batch, task) => batch.delete(doc(db!, TASKS, task.id)));
  const batch = writeBatch(db);
  batch.delete(doc(db, PROPERTIES, propertyId));
  await batch.commit();
}

/**
 * Replace the master template with a property's current checklist structure.
 * Only the reusable shape carries over — section, order, code, indent, title,
 * responsibility, and days-from-closing; the per-property notes, statuses, due
 * dates, and delay history are dropped, since a template is a clean starting
 * point. Existing properties are untouched; only ones created afterward inherit
 * this. Returns the new template items for optimistic rendering.
 */
export async function savePropertyChecklistAsTemplate(tasks: OnboardingTask[]): Promise<OnboardingTemplateItem[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const existing = await getDocs(collection(db, TEMPLATE));

  const items: OnboardingTemplateItem[] = [...tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({
      id: doc(collection(db!, TEMPLATE)).id,
      section: t.section,
      order: t.order,
      code: t.code ?? '',
      indent: t.indent,
      title: t.title,
      responsibleIds: t.responsibleIds ?? [],
      daysFromClosing: t.daysFromClosing ?? null,
    }));

  // A checklist is well under 500 rows, so the swap — delete the old template
  // and write the new one — fits a single atomic batch: no window where the
  // collection is empty (which would let a concurrent open re-seed defaults)
  // or holds duplicates. Fall back to create-then-delete only if it can't.
  if (existing.size + items.length <= 450) {
    const batch = writeBatch(db);
    existing.docs.forEach((d) => batch.delete(d.ref));
    items.forEach((item) => {
      const { id, ...data } = item;
      batch.set(doc(db!, TEMPLATE, id), { ...data, createdAt: serverTimestamp() });
    });
    await batch.commit();
  } else {
    // Create first so the template is never empty (an empty collection would
    // re-seed the defaults if the Template page loaded mid-swap).
    await commitChunks(items, (batch, item) => {
      const { id, ...data } = item;
      batch.set(doc(db!, TEMPLATE, id), { ...data, createdAt: serverTimestamp() });
    });
    await commitChunks(existing.docs, (batch, d) => batch.delete(d.ref));
  }

  return items;
}

/** Rename a section across every row that belongs to it. */
export async function renameSection(
  collectionName: string,
  rows: { id: string; section: string }[],
  from: string,
  to: string,
): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  const affected = rows.filter((r) => r.section === from);
  await commitChunks(affected, (batch, row) => {
    batch.update(doc(db!, collectionName, row.id), { section: to, updatedAt: serverTimestamp() });
  });
}

/** Delete every row in a section. */
export async function deleteRows(collectionName: string, rows: { id: string }[]): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  await commitChunks(rows, (batch, row) => batch.delete(doc(db!, collectionName, row.id)));
}

/**
 * Run `apply` over every item, committing in chunks under Firestore's 500-write
 * batch limit. An optional pre-seeded batch (carrying an extra write, e.g. the
 * parent property doc) is used as the first chunk.
 */
async function commitChunks<T>(
  items: T[],
  apply: (batch: ReturnType<typeof writeBatch>, item: T) => void,
  seedBatch?: ReturnType<typeof writeBatch>,
): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  let batch = seedBatch ?? writeBatch(db);
  let pending = seedBatch ? 1 : 0;
  let dirty = pending > 0;

  for (const item of items) {
    apply(batch, item);
    pending++;
    dirty = true;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = writeBatch(db);
      pending = 0;
      dirty = false;
    }
  }
  if (dirty) await batch.commit();
}
