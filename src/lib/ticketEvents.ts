import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { db } from './firebase';
import type { TicketStatus, TicketPriority } from '../types';

/**
 * One audit-log entry per meaningful ticket change. Written alongside the
 * ticket update so the analytics page can compute time-to-first-response,
 * time-to-resolve, reopen rate, and per-assignee/per-status flow over time.
 *
 * Schema kept intentionally narrow — we add fields if and when we need them,
 * not preemptively.
 */
export type TicketEventType =
  | 'created'
  | 'status_changed'
  | 'priority_changed'
  | 'assignees_changed'
  | 'commented';

export interface TicketEvent {
  ticketId: string;
  type: TicketEventType;
  actorId: string;
  /** Snapshot of relevant before/after values. Only the fields that changed are set. */
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  fromPriority?: TicketPriority;
  toPriority?: TicketPriority;
  fromAssigneeIds?: string[];
  toAssigneeIds?: string[];
  /** First commenter on a ticket — used to compute time-to-first-response. */
  isFirstResponse?: boolean;
  createdAt: ReturnType<typeof serverTimestamp>;
}

function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized');
  return db;
}

export async function logTicketEvent(event: Omit<TicketEvent, 'createdAt'>): Promise<void> {
  await addDoc(collection(getDb(), 'ticketEvents'), {
    ...event,
    createdAt: serverTimestamp(),
  });
}

/**
 * Updates a ticket and writes a corresponding audit event. Use this instead
 * of calling updateDoc on tickets directly, so analytics stay accurate.
 */
export async function updateTicketStatus(
  ticketId: string,
  fromStatus: TicketStatus,
  toStatus: TicketStatus,
  actorId: string,
): Promise<void> {
  const database = getDb();
  await updateDoc(doc(database, 'tickets', ticketId), {
    status: toStatus,
    updatedAt: serverTimestamp(),
  });
  if (fromStatus !== toStatus) {
    await logTicketEvent({
      ticketId,
      type: 'status_changed',
      actorId,
      fromStatus,
      toStatus,
    });
  }
}

export async function updateTicketPriority(
  ticketId: string,
  fromPriority: TicketPriority,
  toPriority: TicketPriority,
  actorId: string,
): Promise<void> {
  const database = getDb();
  await updateDoc(doc(database, 'tickets', ticketId), {
    priority: toPriority,
    updatedAt: serverTimestamp(),
  });
  if (fromPriority !== toPriority) {
    await logTicketEvent({
      ticketId,
      type: 'priority_changed',
      actorId,
      fromPriority,
      toPriority,
    });
  }
}

export async function updateTicketAssignees(
  ticketId: string,
  fromAssigneeIds: string[],
  toAssigneeIds: string[],
  participants: string[],
  actorId: string,
): Promise<void> {
  const database = getDb();
  await updateDoc(doc(database, 'tickets', ticketId), {
    assigneeIds: toAssigneeIds,
    assigneeId: null,
    participants,
    updatedAt: serverTimestamp(),
  });
  const same =
    fromAssigneeIds.length === toAssigneeIds.length &&
    fromAssigneeIds.every((id) => toAssigneeIds.includes(id));
  if (!same) {
    await logTicketEvent({
      ticketId,
      type: 'assignees_changed',
      actorId,
      fromAssigneeIds,
      toAssigneeIds,
    });
  }
}

export async function logTicketCreated(ticketId: string, actorId: string): Promise<void> {
  await logTicketEvent({ ticketId, type: 'created', actorId });
}

export async function logTicketComment(
  ticketId: string,
  actorId: string,
  isFirstResponse: boolean,
): Promise<void> {
  await logTicketEvent({ ticketId, type: 'commented', actorId, isFirstResponse });
}
