import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from './firebase';
import type { RequestType } from '../types';

/** Every request type, active or not, ordered by name. */
export async function loadRequestTypes(): Promise<RequestType[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, 'requestTypes'), orderBy('name')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RequestType));
}

/** The type a ticket's `type` field names, if it still exists. */
export function requestTypeNamed(types: RequestType[], name: string): RequestType | undefined {
  return types.find((rt) => rt.name === name);
}

/**
 * The choices to offer when changing a ticket's type: the active types, plus
 * the ticket's current type if it has since been deactivated or deleted, so
 * the control can still show what the ticket is now.
 */
export function requestTypeChoices(types: RequestType[], currentName: string): string[] {
  const names = types.filter((rt) => rt.active).map((rt) => rt.name);
  if (currentName && !names.includes(currentName)) names.push(currentName);
  return names.sort((a, b) => a.localeCompare(b));
}
