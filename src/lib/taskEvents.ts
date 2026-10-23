import {
  addDoc,
  collection,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { db } from './firebase';
import type { TaskEventType, TaskPriority, TaskStatusType } from '../types';

/**
 * Audit-log helpers for `taskEvents` — mirrors src/lib/ticketEvents.ts closely.
 *
 * Most task mutations already log their own event atomically alongside the doc
 * write (createTask → 'created', setStatus → 'status_changed', toggleSubtask →
 * 'subtask_toggled' — see src/lib/tasks.ts). What's left for callers, this lane
 * included, is: (1) events that don't have a dedicated lib/tasks.ts helper
 * (priority/assignees/due-date changes ride on the generic `updateTask`, which
 * deliberately writes no event — "log one yourself when the change deserves
 * history"), and (2) the comment event this lane's TaskComments writes.
 *
 * `type` is `TaskEventType` as pinned in src/types.ts — that union does not
 * currently include an "attachment_added" or "carried_over" variant, so
 * TaskAttachments does not log an audit event for uploads (see the change
 * request appended to CONTRACTS-TASKS.md). The metadata doc under
 * tasks/{id}/attachments is itself the durable record of an upload.
 */
export interface LogTaskEventInput {
  taskId: string;
  type: TaskEventType;
  actorId: string;
  fromStatusId?: string | null;
  toStatusId?: string | null;
  fromStatusType?: TaskStatusType | null;
  toStatusType?: TaskStatusType | null;
  fromPriority?: TaskPriority | null;
  toPriority?: TaskPriority | null;
  fromAssigneeIds?: string[];
  toAssigneeIds?: string[];
  fromDueDate?: string | null;
  toDueDate?: string | null;
  subtaskId?: string | null;
  /** Free-text detail for summary events (mass reassign, missed occurrence). */
  note?: string | null;
}

function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized');
  return db;
}

/**
 * Writes one audit-log entry but never throws — like ticketEvents.ts, this is
 * best-effort. A Firestore hiccup here must not break the surrounding flow
 * (posting a comment, saving an edit), which is why every caller below awaits
 * this instead of the raw Firestore call.
 */
export async function logTaskEvent(event: LogTaskEventInput): Promise<void> {
  try {
    await addDoc(collection(getDb(), 'taskEvents'), {
      ...event,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Failed to write task event (activity feed only, non-fatal):', err);
  }
}

/** Log a priority change. Call after `updateTask`, which writes no event of its own. */
export async function logTaskPriorityChanged(
  taskId: string,
  fromPriority: TaskPriority | null,
  toPriority: TaskPriority | null,
  actorId: string,
): Promise<void> {
  if (fromPriority === toPriority) return;
  await logTaskEvent({ taskId, type: 'priority_changed', actorId, fromPriority, toPriority });
}

/** Log an assignee-set change. Call after `updateTask`. */
export async function logTaskAssigneesChanged(
  taskId: string,
  fromAssigneeIds: string[],
  toAssigneeIds: string[],
  actorId: string,
): Promise<void> {
  const same =
    fromAssigneeIds.length === toAssigneeIds.length &&
    fromAssigneeIds.every((id) => toAssigneeIds.includes(id));
  if (same) return;
  await logTaskEvent({ taskId, type: 'assignees_changed', actorId, fromAssigneeIds, toAssigneeIds });
}

/** Log a due-date change. Dates are 'YYYY-MM-DD' strings — never parsed here. */
export async function logTaskDueDateChanged(
  taskId: string,
  fromDueDate: string | null,
  toDueDate: string | null,
  actorId: string,
): Promise<void> {
  if (fromDueDate === toDueDate) return;
  await logTaskEvent({ taskId, type: 'due_date_changed', actorId, fromDueDate, toDueDate });
}

/** Log a mass-reassign summary event (one per new assignee, not one per task). */
export async function logTaskReassigned(taskId: string, actorId: string, note?: string | null): Promise<void> {
  await logTaskEvent({ taskId, type: 'reassigned', actorId, note: note ?? null });
}

/** Log that a comment was posted — used for future first-response/cycle-time metrics. */
export async function logTaskComment(taskId: string, actorId: string): Promise<void> {
  await logTaskEvent({ taskId, type: 'commented', actorId });
}
