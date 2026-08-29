import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './firebase';
import { fetchOnboardingPeople } from './onboarding';
import type {
  OnboardingNotebook,
  OnboardingNotebookPage,
  NotebookShareLevel,
  Profile,
} from '../types';

export const NOTEBOOKS = 'onboardingNotebooks';

/** A notebook is one-per-property, keyed by the property id. */
function notebookRef(propertyId: string) {
  return doc(db!, NOTEBOOKS, propertyId);
}
function pagesCol(propertyId: string) {
  return collection(db!, NOTEBOOKS, propertyId, 'pages');
}

// ─── Body codec ──────────────────────────────────────────────────────────────
// A page body is a TipTap/ProseMirror document. It is stored as a JSON STRING,
// not a nested map: rich text (nested lists, tables, pasted content) easily
// exceeds Firestore's 20-level nesting cap, which rejects the write with an
// opaque error. As a single string field only the 1 MiB doc limit applies.

export type TipTapDoc = Record<string, unknown>;

export const EMPTY_BODY: TipTapDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

export function serializeBody(body: TipTapDoc | null | undefined): string {
  return JSON.stringify(body ?? EMPTY_BODY);
}

/** Accepts the stored string (or a legacy object) and returns a TipTap doc. */
export function parseBody(raw: unknown): TipTapDoc {
  if (raw && typeof raw === 'object') return raw as TipTapDoc;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as TipTapDoc;
    } catch {
      /* fall through to empty */
    }
  }
  return EMPTY_BODY;
}

/**
 * Flatten a page body (stored string or TipTap doc) to plain text for search.
 * Walks the ProseMirror node tree, concatenating `text` nodes and inserting a
 * space at block boundaries so words across paragraphs don't run together.
 */
export function bodyPlainText(raw: unknown): string {
  const doc = parseBody(raw);
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      parts.push(' '); // block boundary
    }
  };
  walk(doc);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * If `text` contains `query` (case-insensitive), return a short excerpt centered
 * on the first match, else null. Used to preview which pages a search matched.
 */
export function matchSnippet(text: string, query: string, pad = 32): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + q.length + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ─── Notebook + page reads ───────────────────────────────────────────────────

/**
 * The notebook for a property, or null if none exists yet. Throws with code
 * 'permission-denied' when a notebook exists but is private to someone else —
 * the caller shows "ask the owner to share it" rather than an empty state.
 */
export async function getNotebook(propertyId: string): Promise<OnboardingNotebook | null> {
  if (!db) return null;
  const snap = await getDoc(notebookRef(propertyId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as OnboardingNotebook;
}

/** Create the property's notebook, owned by the caller. Refuses to overwrite. */
export async function createNotebook(propertyId: string, ownerId: string): Promise<OnboardingNotebook> {
  if (!db) throw new Error('Firestore is not configured.');
  const existing = await getNotebook(propertyId);
  if (existing) return existing;
  const data = {
    propertyId,
    ownerId,
    pageOrder: [] as string[],
    sharedWithUserIds: [] as string[],
    editorIds: [] as string[],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(notebookRef(propertyId), data);
  return { id: propertyId, ...data } as unknown as OnboardingNotebook;
}

/** Pages of a notebook, in the notebook's `pageOrder` (stragglers appended). */
export async function fetchPages(notebook: OnboardingNotebook): Promise<OnboardingNotebookPage[]> {
  if (!db) return [];
  const snap = await getDocs(pagesCol(notebook.propertyId));
  const pages = snap.docs.map((d) => ({ id: d.id, ...d.data() } as OnboardingNotebookPage));
  const order = notebook.pageOrder ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return pages.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    // Stragglers (not in pageOrder) fall back to creation order.
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

// ─── Page mutations ──────────────────────────────────────────────────────────

export async function createPage(notebook: OnboardingNotebook, title: string, createdBy: string): Promise<OnboardingNotebookPage> {
  if (!db) throw new Error('Firestore is not configured.');
  const ref = doc(pagesCol(notebook.propertyId));
  const data = {
    title: title.trim() || 'Untitled',
    body: serializeBody(EMPTY_BODY),
    sharedWithUserIds: [] as string[],
    editorIds: [] as string[],
    createdBy,
    order: Date.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(ref, data);
  await updateDoc(notebookRef(notebook.propertyId), {
    pageOrder: arrayUnion(ref.id),
    updatedAt: serverTimestamp(),
  });
  return { id: ref.id, ...data } as unknown as OnboardingNotebookPage;
}

/** Patch a page. `body` is passed as a TipTap doc and serialized here. */
export async function updatePage(
  propertyId: string,
  pageId: string,
  patch: { title?: string; body?: TipTapDoc },
): Promise<void> {
  if (!db) return;
  const data: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.body !== undefined) data.body = serializeBody(patch.body);
  await updateDoc(doc(pagesCol(propertyId), pageId), data);
}

export async function deletePage(notebook: OnboardingNotebook, pageId: string): Promise<void> {
  if (!db) return;
  await deleteDoc(doc(pagesCol(notebook.propertyId), pageId));
  await updateDoc(notebookRef(notebook.propertyId), {
    pageOrder: arrayRemove(pageId),
    updatedAt: serverTimestamp(),
  });
}

/** Persist a new page ordering (array of page ids). */
export async function reorderPages(propertyId: string, pageOrder: string[]): Promise<void> {
  if (!db) return;
  await updateDoc(notebookRef(propertyId), { pageOrder, updatedAt: serverTimestamp() });
}

// ─── Images ──────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // mirrors storage.rules

/**
 * Upload an image pasted/dropped into a notebook to Storage and return its
 * download URL for embedding in the page body. A random filename avoids
 * collisions; the tokenized URL is what gets stored (not base64), keeping the
 * page doc well under Firestore's 1 MiB limit.
 */
export async function uploadNotebookImage(propertyId: string, file: File): Promise<string> {
  if (!storage) throw new Error('Storage is not configured.');
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be added.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Image is too large (max 10 MB).');
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
  const rand = Math.random().toString(36).slice(2);
  const name = `${Date.now()}-${rand}${ext}`;
  const objectRef = storageRef(storage, `notebookImages/${propertyId}/${name}`);
  await uploadBytes(objectRef, file, { contentType: file.type });
  return getDownloadURL(objectRef);
}

// ─── Sharing ─────────────────────────────────────────────────────────────────
// view → the sharedWithUserIds array, edit → the editorIds array, exclusively;
// 'none' removes the person from both. Being an editor implies view (see the
// resolvers below). Only the owner may change these (enforced in the rules).

function shareUpdate(level: NotebookShareLevel, userId: string) {
  if (level === 'edit') return { editorIds: arrayUnion(userId), sharedWithUserIds: arrayRemove(userId) };
  if (level === 'view') return { sharedWithUserIds: arrayUnion(userId), editorIds: arrayRemove(userId) };
  return { sharedWithUserIds: arrayRemove(userId), editorIds: arrayRemove(userId) };
}

export async function shareNotebook(propertyId: string, userId: string, level: NotebookShareLevel): Promise<void> {
  if (!db) return;
  await updateDoc(notebookRef(propertyId), { ...shareUpdate(level, userId), updatedAt: serverTimestamp() });
}

export async function sharePage(propertyId: string, pageId: string, userId: string, level: NotebookShareLevel): Promise<void> {
  if (!db) return;
  await updateDoc(doc(pagesCol(propertyId), pageId), { ...shareUpdate(level, userId), updatedAt: serverTimestamp() });
}

/** Everyone a notebook may be shared with: users who have onboarding access. */
export function fetchShareableUsers(): Promise<Profile[]> {
  return fetchOnboardingPeople();
}

/** The share level a user currently holds on a notebook or page. */
export function shareLevelOf(target: { sharedWithUserIds?: string[]; editorIds?: string[] }, userId: string): NotebookShareLevel {
  if (target.editorIds?.includes(userId)) return 'edit';
  if (target.sharedWithUserIds?.includes(userId)) return 'view';
  return 'none';
}

// ─── Access resolvers (mirror firestore.rules) ───────────────────────────────
// Privacy is strict: not even superadmins see a notebook unless they own it or
// it was shared with them. Editing a notebook lets you add/remove/reorder pages;
// managing shares is owner-only.

export function canViewNotebook(uid: string | undefined, nb: OnboardingNotebook): boolean {
  if (!uid) return false;
  return nb.ownerId === uid || nb.sharedWithUserIds.includes(uid) || nb.editorIds.includes(uid);
}

export function canEditNotebook(uid: string | undefined, nb: OnboardingNotebook): boolean {
  if (!uid) return false;
  return nb.ownerId === uid || nb.editorIds.includes(uid);
}

export function canManageShares(uid: string | undefined, nb: OnboardingNotebook): boolean {
  return !!uid && nb.ownerId === uid;
}

export function canViewPage(uid: string | undefined, nb: OnboardingNotebook, page: OnboardingNotebookPage): boolean {
  if (!uid) return false;
  return canViewNotebook(uid, nb) || page.sharedWithUserIds.includes(uid) || page.editorIds.includes(uid);
}

export function canEditPage(uid: string | undefined, nb: OnboardingNotebook, page: OnboardingNotebookPage): boolean {
  if (!uid) return false;
  return canEditNotebook(uid, nb) || page.editorIds.includes(uid);
}
