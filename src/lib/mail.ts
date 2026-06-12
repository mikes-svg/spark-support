import { addDoc, collection } from 'firebase/firestore';
import { db } from './firebase';

/** Queue an email via the Firestore `mail` collection (Trigger Email extension). No-op if Firestore is unavailable. */
export async function sendMail(to: string, subject: string, html: string) {
  if (!db) return;
  await addDoc(collection(db, 'mail'), { to, message: { subject, html } });
}

/** Absolute URL to a ticket detail page, using the current origin. */
export function ticketUrl(id: string) {
  return `${window.location.origin}/tickets/${id}`;
}
