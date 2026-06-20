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

/**
 * Escape user-controlled text before interpolating it into email HTML, so a
 * crafted ticket title or comment body can't inject markup or links into the
 * mail delivered to staff.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
