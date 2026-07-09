/** Attachment constraints, mirrored by the storage.rules write check. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const ACCEPTED_FILE_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
export const ATTACHMENT_HINT = 'Allowed: PNG, JPG, PDF up to 10MB.';

/** Split files into accepted ones and human-readable rejection reasons. */
export function partitionFiles(files: File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!ACCEPTED_FILE_TYPES.includes(file.type)) rejected.push(`${file.name} (unsupported type)`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (over 10MB)`);
    else accepted.push(file);
  }
  return { accepted, rejected };
}
