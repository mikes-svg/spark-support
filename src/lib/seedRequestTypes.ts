import { collection, getDocs, addDoc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';

const DEFAULT_TYPES = ['HR', 'IT Support', 'Maintenance', 'Other', 'Supplies'];

export async function getOrSeedRequestTypes() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, 'requestTypes'), orderBy('name')));
  if (snap.size > 0) return snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Seed defaults
  const results = [];
  for (const name of DEFAULT_TYPES) {
    const docRef = await addDoc(collection(db, 'requestTypes'), {
      name,
      defaultAssigneeId: null,
      active: true,
      createdAt: serverTimestamp(),
    });
    results.push({ id: docRef.id, name, defaultAssigneeId: null, active: true });
  }
  return results;
}
