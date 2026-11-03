import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from './firebase';
import type { Department } from '../types';

/**
 * The department directory, alphabetical. A handful of documents, read whole
 * wherever a ticket can be routed or displayed — the same way the pages read
 * the profile directory.
 */
export async function loadDepartments(): Promise<Department[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, 'departments'), orderBy('name')));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, 'id'>) }));
}

/** Members of one department, or none when the id is unset or unknown. */
export function departmentMemberIds(departments: Department[], departmentId?: string | null): string[] {
  if (!departmentId) return [];
  return departments.find((d) => d.id === departmentId)?.memberIds ?? [];
}

/** The department's display name, with a stand-in for one that was deleted. */
export function departmentName(departments: Department[], departmentId?: string | null): string | null {
  if (!departmentId) return null;
  return departments.find((d) => d.id === departmentId)?.name ?? 'Unknown department';
}
