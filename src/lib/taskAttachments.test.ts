import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { partitionFiles, formatFileSize, MAX_FILE_BYTES } from './taskAttachments';

/** partitionFiles only reads name/type/size, so a plain object stands in for a File. */
const f = (name: string, type: string, size: number) => ({ name, type, size }) as File;

describe('partitionFiles', () => {
  it('accepts the four types tasks actually carry', () => {
    const { accepted, rejected } = partitionFiles([
      f('walkthrough.mp4', 'video/mp4', 1_800_000),
      f('signed-lease.pdf', 'application/pdf', 220_000),
      f('floorplan.png', 'image/png', 90_000),
      f('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 40_000),
    ]);
    expect(accepted.map((a) => a.name)).toEqual([
      'walkthrough.mp4', 'signed-lease.pdf', 'floorplan.png', 'budget.xlsx',
    ]);
    expect(rejected).toEqual([]);
  });

  it('rejects an executable, whatever it is named', () => {
    const { accepted, rejected } = partitionFiles([f('totally-safe.exe', 'application/x-msdownload', 10_000)]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['totally-safe.exe (unsupported type)']);
  });

  it('holds the 200MB ceiling exactly at the boundary', () => {
    const { accepted, rejected } = partitionFiles([
      f('at-limit.mp4', 'video/mp4', MAX_FILE_BYTES),
      f('over-limit.mp4', 'video/mp4', MAX_FILE_BYTES + 1),
    ]);
    expect(accepted.map((a) => a.name)).toEqual(['at-limit.mp4']);
    expect(rejected).toEqual(['over-limit.mp4 (over 200MB)']);
  });

  it('keeps the good files when one in the batch is bad', () => {
    const { accepted, rejected } = partitionFiles([
      f('ok.png', 'image/png', 1000),
      f('bad.exe', 'application/x-msdownload', 1000),
    ]);
    expect(accepted.map((a) => a.name)).toEqual(['ok.png']);
    expect(rejected).toHaveLength(1);
  });
});

describe('formatFileSize', () => {
  it('scales units and keeps one decimal below 10', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(40_960)).toBe('40 KB');
    expect(formatFileSize(1_843_200)).toBe('1.8 MB');
  });
});

/**
 * Regression guard for a bug that shipped and was only caught by deleting a real
 * file: `taskAttachments` folded delete into `allow write` alongside
 * `request.resource.size`. A delete has no `request.resource`, so the condition
 * evaluated null.size and denied EVERY delete — while the app removed the
 * metadata doc anyway. Since that doc is the only listing path, the object was
 * left orphaned in Storage with nothing pointing at it: an invisible, unbounded
 * leak, on a portal being adopted because the old tool hit its storage limit.
 *
 * Asserted against the rules text rather than a rules-unit-testing harness,
 * which would mean a new dependency for one check.
 */
describe('storage.rules', () => {
  const rules = readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8');

  it('gives taskAttachments a delete rule separate from the size-checked write', () => {
    const block = rules.split('match /taskAttachments/')[1]?.split('match /')[0] ?? '';
    expect(block, 'taskAttachments block not found').not.toBe('');

    // The payload-checked rule must not be a bare `write` (which includes delete).
    expect(block).toMatch(/allow create,\s*update:/);
    expect(block).not.toMatch(/allow write:/);

    // Delete must be its own rule, and must not reference request.resource.
    const del = block.match(/allow delete:[^;]*;/)?.[0] ?? '';
    expect(del, 'no `allow delete` rule for taskAttachments').not.toBe('');
    expect(del).not.toMatch(/request\.resource/);
  });
});
