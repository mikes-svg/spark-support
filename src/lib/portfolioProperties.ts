import { addDoc, collection, deleteDoc, doc, getDocs, orderBy, query, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { PROPERTIES as ONBOARDING_PROPERTIES } from './onboarding';
import type { PortfolioProperty } from '../types';

/**
 * The portfolio: every property the company manages, as a plain name list.
 *
 * Distinct from onboardingProperties on purpose. That collection holds only
 * the deals currently being onboarded, with closing dates and checklists, and
 * is gated to onboarding users. This one is the whole portfolio, readable by
 * everyone who is signed in, and exists so task tooling (one subtask per
 * property, e.g. ordering freeze signs for every building) has a complete
 * list to draw from. Administrators maintain it from Task Settings.
 */
export const PORTFOLIO_PROPERTIES = 'portfolioProperties';

function key(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Turn pasted text (one property per line, commas also accepted) into the
 * names worth adding: trimmed, blanks dropped, de-duplicated against each
 * other and against names already in the list, case-insensitively.
 */
export function parsePropertyNames(text: string, existing: string[]): string[] {
  const seen = new Set(existing.map(key));
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const name = raw.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    out.push(name);
  }
  return out;
}

export async function listPortfolioProperties(): Promise<PortfolioProperty[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, PORTFOLIO_PROPERTIES), orderBy('name')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as PortfolioProperty));
}

/** Add several at once; returns the created rows. Names are assumed parsed. */
export async function addPortfolioProperties(names: string[]): Promise<PortfolioProperty[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const created: PortfolioProperty[] = [];
  for (const name of names) {
    const ref = await addDoc(collection(db, PORTFOLIO_PROPERTIES), { name, archived: false });
    created.push({ id: ref.id, name, archived: false });
  }
  return created;
}

export async function renamePortfolioProperty(id: string, name: string): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Property name is required.');
  await updateDoc(doc(db, PORTFOLIO_PROPERTIES, id), { name: trimmed });
}

/** Archived properties stay on record but drop out of pickers (sold, etc.). */
export async function setPortfolioPropertyArchived(id: string, archived: boolean): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  await updateDoc(doc(db, PORTFOLIO_PROPERTIES, id), { archived });
}

export async function deletePortfolioProperty(id: string): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  await deleteDoc(doc(db, PORTFOLIO_PROPERTIES, id));
}

/**
 * Copy any onboarding property names not already in the portfolio. Reads the
 * onboarding collection, so the caller must be an onboarding user (the
 * Administrator using Task Settings always is).
 */
export async function importFromOnboarding(existing: PortfolioProperty[]): Promise<PortfolioProperty[]> {
  if (!db) throw new Error('Firestore is not configured.');
  const snap = await getDocs(collection(db, ONBOARDING_PROPERTIES));
  const names = parsePropertyNames(
    snap.docs.map((d) => String(d.data().name ?? '')).join('\n'),
    existing.map((p) => p.name),
  );
  if (names.length === 0) return [];
  const batch = writeBatch(db);
  const created: PortfolioProperty[] = [];
  for (const name of names) {
    const ref = doc(collection(db, PORTFOLIO_PROPERTIES));
    batch.set(ref, { name, archived: false });
    created.push({ id: ref.id, name, archived: false });
  }
  await batch.commit();
  return created;
}
