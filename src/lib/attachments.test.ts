import { describe, expect, it } from 'vitest';
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { attachmentsZipName, buildAttachmentsZip, partitionFiles } from './attachments';

describe('attachments zip', () => {
  it('names the archive after the ticket', () => {
    expect(attachmentsZipName('TKT-0042')).toBe('TKT-0042-attachments.zip');
  });

  it('bundles every file under its own name with its bytes intact', () => {
    const zip = buildAttachmentsZip([
      { name: 'floorplan.png', data: strToU8('png-bytes') },
      { name: 'lease.pdf', data: strToU8('pdf-bytes') },
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(['floorplan.png', 'lease.pdf']);
    expect(strFromU8(out['floorplan.png'])).toBe('png-bytes');
    expect(strFromU8(out['lease.pdf'])).toBe('pdf-bytes');
  });
});

describe('partitionFiles', () => {
  const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;

  it('accepts PNG/JPG/GIF, PDF, Office documents and text', () => {
    const { accepted, rejected } = partitionFiles([
      file('a.png', 'image/png'),
      file('a2.jpg', 'image/jpeg'),
      file('a3.gif', 'image/gif'),
      file('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      file('c.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      file('d.xls', 'application/vnd.ms-excel'),
      file('e.doc', 'application/msword'),
      file('f.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      file('g.csv', 'text/csv'),
      file('h.pdf', 'application/pdf'),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'a2.jpg', 'a3.gif', 'b.docx', 'c.xlsx', 'd.xls', 'e.doc', 'f.pptx', 'g.csv', 'h.pdf']);
    expect(rejected).toEqual([]);
  });

  it('rejects WebP/HEIC, executables, archives, unknown types and oversized files, with a reason each', () => {
    const { accepted, rejected } = partitionFiles([
      file('shot.webp', 'image/webp'),
      file('IMG_1.heic', 'image/heic'),
      file('setup.exe', 'application/x-msdownload'),
      file('bundle.zip', 'application/zip'),
      file('mystery.bin', ''),
      file('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 26 * 1024 * 1024),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      'shot.webp (unsupported type)',
      'IMG_1.heic (unsupported type)',
      'setup.exe (unsupported type)',
      'bundle.zip (unsupported type)',
      'mystery.bin (unsupported type)',
      'deck.pptx (over 25MB)',
    ]);
  });
});
