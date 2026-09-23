import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { db, storage } from './firebase';
import type { TaskAttachment } from '../types';

/**
 * Task attachment constraints, mirrored by storage.rules — mirrors the shape
 * of src/lib/attachments.ts, but wider: tasks carry real work product
 * (walkthrough videos, signed PDFs, spreadsheets), not just a screenshot and a
 * PDF, so the ticket 10MB image/PDF ceiling doesn't fit here (plan §6).
 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB
export const ACCEPTED_FILE_TYPE_PATTERN =
  /^(image\/|video\/|application\/pdf$|application\/vnd\.|text\/)/;
export const ATTACHMENT_HINT = 'Allowed: images, video, PDF, and documents, up to 200MB.';

/** Split files into accepted ones and human-readable rejection reasons. */
export function partitionFiles(files: File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!ACCEPTED_FILE_TYPE_PATTERN.test(file.type)) rejected.push(`${file.name} (unsupported type)`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (over 200MB)`);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** Human-readable size, e.g. "4.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIdx]}`;
}

function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized');
  return db;
}

/**
 * Live-listen to a task's attachment metadata docs, newest first. Unlike
 * tickets (whose attachments are listed through a participation-gated Cloud
 * Function, because Storage listing is denied), the metadata doc IS the
 * listing here — no function round-trip, and it's what makes delete possible.
 */
export function watchTaskAttachments(
  taskId: string,
  onChange: (attachments: TaskAttachment[]) => void,
  onError?: (err: unknown) => void,
): Unsubscribe {
  const q = query(
    collection(getDb(), 'tasks', taskId, 'attachments'),
    orderBy('uploadedAt', 'desc'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskAttachment))),
    (err) => {
      console.warn('Task attachments listener failed:', err);
      onError?.(err);
    },
  );
}

/**
 * Upload one file to Storage at `taskAttachments/{taskId}/{filename}`, then
 * write its metadata doc to `tasks/{taskId}/attachments`. A timestamp prefix
 * on the storage filename avoids collisions between two uploads of the same
 * file name, while the metadata doc keeps the original name for display.
 */
export async function uploadTaskAttachment(
  taskId: string,
  file: File,
  uploadedBy: string,
): Promise<TaskAttachment> {
  if (!storage) throw new Error('Storage is not configured.');
  const storagePath = `taskAttachments/${taskId}/${Date.now()}-${file.name}`;
  const objectRef = ref(storage, storagePath);
  await uploadBytes(objectRef, file, { contentType: file.type });
  const url = await getDownloadURL(objectRef);

  const docData = {
    name: file.name,
    contentType: file.type,
    size: file.size,
    storagePath,
    url,
    uploadedBy,
    uploadedAt: serverTimestamp(),
  };
  const metaRef = await addDoc(collection(getDb(), 'tasks', taskId, 'attachments'), docData);
  return { id: metaRef.id, ...docData, uploadedAt: undefined } as TaskAttachment;
}

/**
 * Delete both the metadata doc and the Storage object. The Storage delete runs
 * first: if it fails (e.g. already gone), the metadata delete still proceeds
 * so a broken row doesn't linger in the list forever.
 */
export async function deleteTaskAttachment(taskId: string, attachment: TaskAttachment): Promise<void> {
  if (storage) {
    try {
      await deleteObject(ref(storage, attachment.storagePath));
    } catch (err) {
      console.warn('Failed to delete attachment file (removing metadata anyway):', err);
    }
  }
  await deleteDoc(doc(getDb(), 'tasks', taskId, 'attachments', attachment.id));
}
