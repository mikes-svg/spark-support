import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Task, TaskSeries, TaskCopyOnRecur } from '../types';

/**
 * Creating and editing the recurring definition behind a task.
 *
 * The recurrence ENGINE is server-side (functions/recurrence.js) and the editor
 * component already existed — what was missing was any way to get from a task in
 * the UI to a `taskSeries` document, so recurrence was built, deployed and
 * completely unreachable. This module is that seam.
 *
 * `src/lib/tasks.ts` is the pinned contract and deliberately exports a fixed set
 * of names, so series CRUD lives here rather than being bolted onto it.
 */

export const TASK_SERIES = 'taskSeries';

function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized');
  return db;
}

/**
 * ClickUp's defaults, which is what the audited workspace actually used:
 * everything meaningful carries forward, checked items reset, and attachments
 * and activity do not follow an occurrence into the next one.
 */
export const DEFAULT_COPY_ON_RECUR: TaskCopyOnRecur = {
  description: true,
  subtasks: true,
  subtaskAssignees: true,
  remapSubtaskDates: true,
  assignees: true,
  watchers: true,
  comments: false,
  tags: true,
  keepCheckedItems: false,
  carryMode: 'reset',
  attachments: false,
  activity: false,
};

/**
 * Exactly the slice RecurrenceEditor edits, so the editor's value and what we
 * persist cannot drift apart.
 */
export type SeriesSettings = Pick<
  TaskSeries,
  'recurrence' | 'trigger' | 'skipWeekends' | 'weekendShift' | 'startOffsetDays'
  | 'copyOnRecur' | 'missedPolicy' | 'resetStatusTo' | 'endDate' | 'occurrenceLimit'
  | 'active' | 'timezone'
>;

/** A new series, pre-set to the behaviour the team already expects. */
export function defaultSeriesSettings(resetStatusTo: string): SeriesSettings {
  return {
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    // on-completion matches how every audited ClickUp series was configured:
    // the next one appears when you finish this one, not on a calendar tick.
    trigger: 'on-completion',
    resetStatusTo,
    skipWeekends: true,
    weekendShift: 'next',
    startOffsetDays: 0,
    copyOnRecur: { ...DEFAULT_COPY_ON_RECUR },
    // skip-to-next is what stops the "30 unfinished copies" pile-up that the
    // old ClickUp workspace accumulated over a year.
    missedPolicy: 'skip-to-next',
    endDate: null,
    occurrenceLimit: null,
    active: true,
    timezone: 'America/Chicago',
  };
}

/** The series a task belongs to, or null when the task is a one-off. */
export async function getSeriesForTask(task: Pick<Task, 'seriesId'>): Promise<TaskSeries | null> {
  if (!task.seriesId) return null;
  const snap = await getDoc(doc(getDb(), TASK_SERIES, task.seriesId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as TaskSeries) : null;
}

/** Every series whose occurrences land in these lists (for the templates view). */
export async function listSeries(listId?: string): Promise<TaskSeries[]> {
  const col = collection(getDb(), TASK_SERIES);
  const snap = await getDocs(listId ? query(col, where('payload.listId', '==', listId)) : col);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskSeries));
}

/**
 * Turn an existing task into a recurring one.
 *
 * The task keeps its identity and becomes the first occurrence — it is not
 * recreated — so comments, attachments and history survive being made
 * recurring, which is what people expect when they tick "repeat".
 */
export async function makeTaskRecurring(
  task: Task,
  settings: SeriesSettings,
  creatorId: string,
): Promise<string> {
  const database = getDb();
  const ref = await addDoc(collection(database, TASK_SERIES), {
    name: task.title,
    payload: {
      listId: task.listId,
      spaceId: task.spaceId,
      title: task.title,
      description: task.description ?? '',
      priority: task.priority ?? null,
      assigneeIds: task.assigneeIds ?? [],
      watcherIds: task.watcherIds ?? [],
      tagIds: task.tagIds ?? [],
      subtaskTemplate: (task.subtasks ?? []).map((s, i) => ({ title: s.title, order: s.order ?? i * 100 })),
    },
    ...settings,
    creatorId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  // Link the task to its series and stamp the occurrence key, so the generator
  // treats this task as occurrence one rather than minting a duplicate for the
  // same due date.
  await updateDoc(doc(database, 'tasks', task.id), {
    seriesId: ref.id,
    occurrenceKey: task.dueDate ?? null,
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Change the schedule on an existing series. */
export async function updateSeries(seriesId: string, settings: Partial<SeriesSettings>): Promise<void> {
  await updateDoc(doc(getDb(), TASK_SERIES, seriesId), {
    ...settings,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Stop a series without touching the occurrence that is already open.
 *
 * Deliberately a deactivate, not a delete: the open task stays assigned and
 * workable, and the history of what recurred is preserved. Deleting the series
 * would orphan every past occurrence's `seriesId`.
 */
export async function stopSeries(seriesId: string): Promise<void> {
  await updateSeries(seriesId, { active: false });
}

/** Restart a stopped series. */
export async function resumeSeries(seriesId: string): Promise<void> {
  await updateSeries(seriesId, { active: true });
}
