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
import { DEFAULT_DD_ITEMS } from './ddMaterialsDefaults';
import type {
  OnboardingDdItem,
  OnboardingProperty,
  OnboardingTask,
  OnboardingTemplateItem,
  Profile,
} from '../types';

export const PROPERTIES = 'onboardingProperties';
export const TASKS = 'onboardingTasks';
export const TEMPLATE = 'onboardingTemplate';
export const DD_ITEMS = 'onboardingDdItems';
export const INSPECTION_TASKS = 'inspectionTasks';
export const INSPECTION_TEMPLATE = 'inspectionTemplate';

/**
 * A property carries two checklists with the same shape — PM onboarding and DD
 * inspections — each with its own master template. They live in separate
 * collections so the two templates and task lists never mix.
 */
export type ChecklistKind = 'onboarding' | 'inspections';

export const CHECKLISTS: Record<ChecklistKind, { tasks: string; template: string; label: string }> = {
  onboarding: { tasks: TASKS, template: TEMPLATE, label: 'PM Onboarding' },
  inspections: { tasks: INSPECTION_TASKS, template: INSPECTION_TEMPLATE, label: 'DD Inspections' },
};

export const CHECKLIST_KINDS = Object.keys(CHECKLISTS) as ChecklistKind[];

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

/**
 * A property's checklist of the given kind. Filtered on propertyId alone and
 * sorted here, so the inspections list needs no composite index of its own.
 */
export async function fetchTasksForProperty(propertyId: string, kind: ChecklistKind = 'onboarding'): Promise<OnboardingTask[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, CHECKLISTS[kind].tasks), where('propertyId', '==', propertyId)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as OnboardingTask))
    .sort((a, b) => a.order - b.order);
}

/** Turn template rows into a property's tasks, due dates computed from closing. */
function tasksFromTemplate(
  propertyId: string,
  closingDate: string | null,
  template: OnboardingTemplateItem[],
  idFor: (item: OnboardingTemplateItem) => string,
): OnboardingTask[] {
  return [...template]
    .sort((a, b) => a.order - b.order)
    .map((item) => ({
      id: idFor(item),
      propertyId,
      section: item.section,
      order: item.order,
      code: item.code,
      indent: item.indent,
      title: item.title,
      responsibleIds: item.responsibleIds ?? [],
      daysFromClosing: item.daysFromClosing ?? null,
      dueDate: computeDueDate(closingDate, item.daysFromClosing ?? null),
      status: 'Not Started',
      notes: '',
      delays: [],
    }));
}

/**
 * Copy the inspections template into a property. Task ids are derived from the
 * property and template row, so two people opening an empty tab at once write
 * the same docs rather than doubling the list.
 */
export async function instantiateInspections(
  propertyId: string,
  closingDate: string | null,
  template: OnboardingTemplateItem[],
): Promise<OnboardingTask[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const tasks = tasksFromTemplate(propertyId, closingDate, template, (item) => `${propertyId}_${item.id}`);
  await commitChunks(tasks, (batch, { id, ...data }) =>
    batch.set(doc(db!, INSPECTION_TASKS, id), { ...data, createdAt: serverTimestamp() }),
  );
  return tasks;
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

  const tasks = tasksFromTemplate(propertyRef.id, input.closingDate, template, () => doc(collection(db!, TASKS)).id);

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
 * Apply a new closing date: every task carrying an offset, in both checklists,
 * gets its due date recalculated. Returns the updated tasks of each checklist
 * for optimistic rendering.
 */
export async function applyClosingDate(
  propertyId: string,
  closingDate: string | null,
): Promise<Record<ChecklistKind, OnboardingTask[]>> {
  if (!db) throw new Error('Firestore is not configured.');
  const propertyRef = doc(db, PROPERTIES, propertyId);

  const lists = await Promise.all(CHECKLIST_KINDS.map((kind) => fetchTasksForProperty(propertyId, kind)));
  const affected = CHECKLIST_KINDS.flatMap((kind, i) =>
    lists[i].filter((t) => t.daysFromClosing != null).map((task) => ({ kind, task })),
  );

  const firstBatch = writeBatch(db);
  firstBatch.update(propertyRef, { closingDate });
  await commitChunks(affected, (batch, { kind, task }) => {
    batch.update(doc(db!, CHECKLISTS[kind].tasks, task.id), {
      dueDate: computeDueDate(closingDate, task.daysFromClosing),
      updatedAt: serverTimestamp(),
    });
  }, firstBatch);

  const updated = (tasks: OnboardingTask[]) => tasks.map((t) =>
    t.daysFromClosing == null ? t : { ...t, dueDate: computeDueDate(closingDate, t.daysFromClosing) }
  );
  return { onboarding: updated(lists[0]), inspections: updated(lists[1]) };
}

/** Delete a property and everything under it: both checklists and its DD list. */
export async function deletePropertyWithTasks(propertyId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  for (const kind of CHECKLIST_KINDS) {
    await deleteRows(CHECKLISTS[kind].tasks, await fetchTasksForProperty(propertyId, kind));
  }
  await deleteRows(DD_ITEMS, await fetchDdItems(propertyId));
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
export async function savePropertyChecklistAsTemplate(
  tasks: OnboardingTask[],
  kind: ChecklistKind = 'onboarding',
): Promise<OnboardingTemplateItem[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const templateCollection = CHECKLISTS[kind].template;
  const existing = await getDocs(collection(db, templateCollection));

  const items: OnboardingTemplateItem[] = [...tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({
      id: doc(collection(db!, templateCollection)).id,
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
      batch.set(doc(db!, templateCollection, id), { ...data, createdAt: serverTimestamp() });
    });
    await batch.commit();
  } else {
    // Create first so the template is never empty (an empty collection would
    // re-seed the defaults if the Template page loaded mid-swap).
    await commitChunks(items, (batch, item) => {
      const { id, ...data } = item;
      batch.set(doc(db!, templateCollection, id), { ...data, createdAt: serverTimestamp() });
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

/**
 * A property's DD request list. Filtered on propertyId alone and sorted here,
 * so it needs no composite index.
 */
export async function fetchDdItems(propertyId: string): Promise<OnboardingDdItem[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, DD_ITEMS), where('propertyId', '==', propertyId)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as OnboardingDdItem))
    .sort((a, b) => a.order - b.order);
}

/**
 * Copy the standard DD list into a property. Ids are derived from the property
 * and position, so two people opening an empty tab at once write the same docs
 * rather than doubling the list.
 */
export async function seedDdItems(propertyId: string): Promise<OnboardingDdItem[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const items: OnboardingDdItem[] = DEFAULT_DD_ITEMS.map((item, i) => ({
    id: `${propertyId}_dd_${i + 1}`,
    propertyId,
    order: (i + 1) * 100,
    item,
    status: 'Outstanding',
    notes: '',
  }));
  await commitChunks(items, (batch, { id, ...data }) =>
    batch.set(doc(db!, DD_ITEMS, id), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }),
  );
  return items;
}
