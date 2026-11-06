import { zipSync } from 'fflate';

/**
 * Attachment constraints, mirrored by the storage.rules write check.
 *
 * PNG, JPG and GIF images (not WebP or HEIC, which do not open on every
 * computer), PDF, Office documents (Word, Excel, PowerPoint: the legacy
 * `application/msword` type plus everything under `application/vnd.`, which
 * covers both the old .xls/.ppt types and the OpenXML .docx/.xlsx/.pptx ones)
 * and text files such as CSV. The browser reports a file's type from its
 * extension, so a file with an unknown extension arrives with an empty type
 * and is rejected.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const ACCEPTED_FILE_TYPE_PATTERN = /^(image\/(png|jpeg|gif)$|text\/|application\/(pdf$|msword$|vnd\.))/;
export const ATTACHMENT_HINT = 'Allowed: PNG, JPG, GIF, PDF, Word, Excel, PowerPoint, CSV and text files up to 25MB.';

/** Split files into accepted ones and human-readable rejection reasons. */
export function partitionFiles(files: File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!ACCEPTED_FILE_TYPE_PATTERN.test(file.type)) rejected.push(`${file.name} (unsupported type)`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (over 25MB)`);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** A listed ticket attachment: its file name and tokenized download URL. */
export interface AttachmentFile { name: string; url: string; }

/** Name of the archive "Download All" produces for a ticket. */
export function attachmentsZipName(ticketId: string): string {
  return `${ticketId}-attachments.zip`;
}

/**
 * Build a zip of already-fetched attachment bytes. Stored, not deflated: the
 * bulk of what tickets carry (images, PDF, Office files, which are zips
 * themselves) is compressed already, so deflate would spend CPU on the main
 * thread for no real size win; a CSV or text file is small either way.
 */
export function buildAttachmentsZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const { name, data } of entries) files[name] = data;
  return zipSync(files, { level: 0 });
}

/**
 * Hand bytes to the browser as a file save. A plain link to a Storage URL can
 * only open the file: Storage serves it inline, and browsers ignore the
 * `download` attribute on cross-origin links, so the bytes are fetched first
 * (the bucket's CORS allows GET from the app origin) and saved from a blob.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke once the browser has had a chance to start the save; revoking
  // synchronously cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Blob parts must be plain ArrayBuffers; copy out the view's exact range. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Save one attachment to the user's downloads under its original name. */
export async function downloadAttachment(att: AttachmentFile): Promise<void> {
  const bytes = await fetchBytes(att.url);
  saveBlob(new Blob([toArrayBuffer(bytes)]), att.name);
}

/**
 * Save every attachment at once. One file is saved as itself; more are
 * bundled into a zip named after the ticket, so the user gets one save
 * prompt instead of one per file.
 */
export async function downloadAllAttachments(atts: AttachmentFile[], ticketId: string): Promise<void> {
  if (atts.length === 0) return;
  if (atts.length === 1) return downloadAttachment(atts[0]);
  const entries = await Promise.all(atts.map(async (att) => ({ name: att.name, data: await fetchBytes(att.url) })));
  const zip = buildAttachmentsZip(entries);
  saveBlob(new Blob([toArrayBuffer(zip)], { type: 'application/zip' }), attachmentsZipName(ticketId));
}
