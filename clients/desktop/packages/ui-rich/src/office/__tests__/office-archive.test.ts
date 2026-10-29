import { deflateRawSync } from 'node:zlib';
import {
  assertXlsxStructure,
  XLSX_MAX_STRUCTURE_MARKERS,
} from '../xlsx-admission';
import { buildStoredZip } from '../../../test/ooxml-fixtures.js';
import { assertOfficeArchive } from '../office-archive';
import { assertOfficeArchiveExpansion } from '../office-expansion';

const CONTENT_TYPES = '<Types/>';
const ROOT_RELS = '<Relationships/>';

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const PACKAGE_ROOTS = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
} as const;

function officeZip(
  kind: 'docx' | 'xlsx' | 'pptx',
  extras: ReadonlyArray<{ name: string; data: string | Uint8Array }> = [],
): Uint8Array {
  const root = PACKAGE_ROOTS[kind];
  return buildStoredZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: root, data: '<root/>' },
    ...extras,
  ]);
}

function centralOffset(bytes: Uint8Array): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(bytes.length - 6, true);
}

function setEveryExpandedSize(bytes: Uint8Array, size: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = centralOffset(bytes);
  const entries = view.getUint16(bytes.length - 12, true);
  for (let index = 0; index < entries; index += 1) {
    const local = view.getUint32(cursor + 42, true);
    view.setUint16(cursor + 8, 8, true);
    view.setUint16(local + 6, 8, true);
    view.setUint32(local + 14, 0, true);
    view.setUint32(local + 18, 0, true);
    view.setUint32(local + 22, 0, true);
    view.setUint32(cursor + 24, size, true);
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
}

describe('assertOfficeArchive', () => {
  it.each(['docx', 'xlsx', 'pptx'] as const)(
    'admits the required %s package root',
    (kind) => {
      expect(() =>
        assertOfficeArchive(buffer(officeZip(kind)), kind),
      ).not.toThrow();
    },
  );

  it.each([
    ['plain text', new TextEncoder().encode('not a zip')],
    [
      'legacy CFB',
      Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    ],
    ['arbitrary zip', buildStoredZip([{ name: 'hello.txt', data: 'hello' }])],
  ])('rejects %s input', (_label, bytes) => {
    expect(() => assertOfficeArchive(buffer(bytes), 'docx')).toThrow();
  });

  it('rejects a package whose root belongs to the other Office kind', () => {
    expect(() =>
      assertOfficeArchive(buffer(officeZip('xlsx')), 'docx'),
    ).toThrow();
    expect(() =>
      assertOfficeArchive(buffer(officeZip('docx')), 'xlsx'),
    ).toThrow();
    expect(() =>
      assertOfficeArchive(buffer(officeZip('docx')), 'pptx'),
    ).toThrow();
    expect(() =>
      assertOfficeArchive(
        buffer(
          officeZip('pptx', [{ name: 'word/document.xml', data: '<root/>' }]),
        ),
        'pptx',
      ),
    ).toThrow('not a PPTX package');
  });

  it('names admitted entries so presentation parts can be looked up', () => {
    const names = assertOfficeArchive(buffer(officeZip('pptx')), 'pptx').map(
      (entry) => entry.name,
    );
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
    ]);
  });

  it('rejects a macro payload in a presentation', () => {
    expect(() =>
      assertOfficeArchive(
        buffer(officeZip('pptx', [{ name: 'ppt/vbaProject.bin', data: 'm' }])),
        'pptx',
      ),
    ).toThrow('Macro-enabled');
  });

  it.each(['word/vbaProject.bin', 'xl/vbaProject.bin'])(
    'rejects macro payload %s',
    (name) => {
      expect(() =>
        assertOfficeArchive(
          buffer(
            officeZip(name.startsWith('word/') ? 'docx' : 'xlsx', [
              { name, data: 'macro' },
            ]),
          ),
          name.startsWith('word/') ? 'docx' : 'xlsx',
        ),
      ).toThrow();
    },
  );

  it('rejects binary XLSX parts that bypass XML structure accounting', () => {
    expect(() =>
      assertOfficeArchive(
        buffer(
          officeZip('xlsx', [
            {
              name: 'xl/worksheets/sheet1.bin',
              data: new Uint8Array([1, 2, 3]),
            },
          ]),
        ),
        'xlsx',
      ),
    ).toThrow('Binary workbook parts');
  });

  it('rejects duplicate entry names', () => {
    expect(() =>
      assertOfficeArchive(
        buffer(
          officeZip('docx', [{ name: 'word/document.xml', data: 'duplicate' }]),
        ),
        'docx',
      ),
    ).toThrow();
  });

  it('rejects more than 2,000 entries and accepts the boundary', () => {
    const filler = Array.from({ length: 1_997 }, (_, index) => ({
      name: `f/${index}`,
      data: '',
    }));
    expect(() =>
      assertOfficeArchive(buffer(officeZip('docx', filler)), 'docx'),
    ).not.toThrow();
    expect(() =>
      assertOfficeArchive(
        buffer(
          officeZip('docx', [...filler, { name: 'f/overflow', data: '' }]),
        ),
        'docx',
      ),
    ).toThrow();
  });

  it.each([
    ['encrypted', 8, 1],
    ['unsupported compression', 10, 99],
  ])('rejects an %s central directory entry', (_label, fieldOffset, value) => {
    const bytes = officeZip('docx');
    new DataView(bytes.buffer).setUint16(
      centralOffset(bytes) + fieldOffset,
      value,
      true,
    );
    expect(() => assertOfficeArchive(buffer(bytes), 'docx')).toThrow();
  });

  it('rejects multi-disk archives and ZIP64 sentinels', () => {
    for (const [offset, value] of [
      [4, 1],
      [8, 0xffff],
      [12, 0xffffffff],
    ] as const) {
      const bytes = officeZip('docx');
      const view = new DataView(bytes.buffer);
      if (offset === 12)
        view.setUint32(bytes.length - 22 + offset, value, true);
      else view.setUint16(bytes.length - 22 + offset, value, true);
      expect(() => assertOfficeArchive(buffer(bytes), 'docx')).toThrow();
    }
  });

  it('rejects malformed central offsets and declared expanded entry limits', () => {
    const malformed = officeZip('docx');
    new DataView(malformed.buffer).setUint32(
      malformed.length - 6,
      malformed.length,
      true,
    );
    expect(() => assertOfficeArchive(buffer(malformed), 'docx')).toThrow();

    const expanded = officeZip('docx');
    new DataView(expanded.buffer).setUint32(
      centralOffset(expanded) + 24,
      16 * 1024 * 1024 + 1,
      true,
    );
    expect(() => assertOfficeArchive(buffer(expanded), 'docx')).toThrow();
  });

  it('accepts exactly 64 MiB declared expansion and rejects one additional entry', () => {
    const boundary = officeZip('docx', [{ name: 'f/fourth', data: '' }]);
    setEveryExpandedSize(boundary, 16 * 1024 * 1024);
    expect(() => assertOfficeArchive(buffer(boundary), 'docx')).not.toThrow();

    const overflow = officeZip('docx', [
      { name: 'f/fourth', data: '' },
      { name: 'f/fifth', data: '' },
    ]);
    setEveryExpandedSize(overflow, 16 * 1024 * 1024);
    expect(() => assertOfficeArchive(buffer(overflow), 'docx')).toThrow();
  });

  it('rejects a central entry pointing outside a valid local header', () => {
    const bytes = officeZip('docx');
    const central = centralOffset(bytes);
    new DataView(bytes.buffer).setUint32(central + 42, central, true);
    expect(() => assertOfficeArchive(buffer(bytes), 'docx')).toThrow();
  });

  it('rejects conflicting and oversized local entry declarations', () => {
    for (const [offset, value] of [
      [18, 1],
      [22, 16 * 1024 * 1024 + 1],
    ] as const) {
      const bytes = officeZip('docx');
      new DataView(bytes.buffer).setUint32(offset, value, true);
      expect(() => assertOfficeArchive(buffer(bytes), 'docx')).toThrow();
    }
  });

  it('rejects a ZIP64 extra field in central metadata', () => {
    const original = officeZip('docx');
    const central = centralOffset(original);
    const nameLength = new DataView(original.buffer).getUint16(
      central + 28,
      true,
    );
    const insertAt = central + 46 + nameLength;
    const expanded = new Uint8Array(original.length + 4);
    expanded.set(original.subarray(0, insertAt));
    expanded.set([1, 0, 0, 0], insertAt);
    expanded.set(original.subarray(insertAt), insertAt + 4);
    const view = new DataView(expanded.buffer);
    view.setUint16(central + 30, 4, true);
    const end = expanded.length - 22;
    view.setUint32(end + 12, view.getUint32(end + 12, true) + 4, true);
    expect(() => assertOfficeArchive(buffer(expanded), 'docx')).toThrow();
  });

  it('rejects an end-record signature hidden in the ZIP comment', () => {
    const original = officeZip('docx');
    const expanded = new Uint8Array(original.length + 22);
    expanded.set(original);
    const view = new DataView(expanded.buffer);
    view.setUint16(original.length - 2, 22, true);
    view.setUint32(original.length, 0x06054b50, true);
    expect(() => assertOfficeArchive(buffer(expanded), 'docx')).toThrow();
  });

  it('rejects a fake end record overlapping the real comment-length field', () => {
    const original = officeZip('docx');
    const commentLength = 0x4b50;
    const expanded = new Uint8Array(original.length + commentLength);
    expanded.set(original);
    const view = new DataView(expanded.buffer);
    view.setUint16(original.length - 2, commentLength, true);
    expanded[original.length] = 0x05;
    expanded[original.length + 1] = 0x06;
    expect(() => assertOfficeArchive(buffer(expanded), 'docx')).toThrow();
  });
});

describe('XLSX source structure admission', () => {
  it.each([0, 8])(
    'accepts the exact structure boundary with compression method %s',
    (method) => {
      const expanded = new TextEncoder().encode(
        '<'.repeat(XLSX_MAX_STRUCTURE_MARKERS),
      );
      const entry = {
        data: method === 8 ? deflateRawSync(expanded) : expanded,
        method,
        expandedSize: expanded.length,
      };
      expect(() => assertXlsxStructure([entry])).not.toThrow();
      expect(() =>
        assertXlsxStructure([
          entry,
          { data: new Uint8Array([60]), method: 0, expandedSize: 1 },
        ]),
      ).toThrow('structure budget');
    },
  );

  it('rejects dishonest compressed sizes before retaining expanded output', () => {
    const data = deflateRawSync(new Uint8Array(1024 * 1024));
    expect(() =>
      assertXlsxStructure([{ data, method: 8, expandedSize: 1 }]),
    ).toThrow('expanded size');
  });

  it('rejects truncated deflate streams and mismatched stored sizes', () => {
    const data = deflateRawSync(new Uint8Array(1024));
    expect(() =>
      assertXlsxStructure([
        {
          data: data.subarray(0, data.length - 1),
          method: 8,
          expandedSize: 1024,
        },
      ]),
    ).toThrow('Incomplete');
    expect(() =>
      assertXlsxStructure([
        { data: new Uint8Array(1), method: 0, expandedSize: 2 },
      ]),
    ).toThrow('expanded size');
  });
});

// DOCX shares expansion verification without adopting the XLSX marker budget.
describe('Office archive expansion', () => {
  it.each([0, 8])(
    'admits truthful DOCX-sized structure without an XLSX marker cap (%s)',
    (method) => {
      const expanded = new TextEncoder().encode(
        '<'.repeat(XLSX_MAX_STRUCTURE_MARKERS + 1),
      );
      const entry = {
        data: method === 8 ? deflateRawSync(expanded) : expanded,
        method,
        expandedSize: expanded.length,
      };
      expect(() => assertOfficeArchiveExpansion([entry])).not.toThrow();
      expect(() => assertXlsxStructure([entry])).toThrow('structure budget');
    },
  );
});
