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

  it('accepts images and PDFs under the limit and explains each rejection', () => {
    const { accepted, rejected } = partitionFiles([
      file('a.png', 'image/png'),
      file('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      file('c.pdf', 'application/pdf', 11 * 1024 * 1024),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(rejected).toEqual(['b.docx (unsupported type)', 'c.pdf (over 10MB)']);
  });
});
