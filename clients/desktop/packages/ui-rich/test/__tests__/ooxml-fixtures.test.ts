import {
  REG2902_DOCX_DENSE_PARAGRAPHS,
  REG2902_DOCX_DENSE_TABLE_ROWS,
  buildReg2902DenseDocxFixture,
  buildReg2902DocxFixture,
  buildReg2902XlsxFixture,
  buildStoredZip,
} from '../ooxml-fixtures.js';

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

function storedZipEntry(bytes: Uint8Array, wantedName: string): string {
  let offset = 0;
  while (readUint32(bytes, offset) === 0x04034b50) {
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const size = readUint32(bytes, offset + 18);
    const nameStart = offset + 30;
    const name = Buffer.from(
      bytes.subarray(nameStart, nameStart + nameLength),
    ).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    if (name === wantedName) {
      return Buffer.from(bytes.subarray(dataStart, dataStart + size)).toString(
        'utf8',
      );
    }
    offset = dataStart + size;
  }
  throw new Error(`Missing ZIP entry: ${wantedName}`);
}

describe('buildStoredZip', () => {
  it('emits a stored zip whose end-of-central-directory counts every entry', () => {
    const zip = buildStoredZip([
      { name: 'a.txt', data: 'alpha' },
      { name: 'dir/b.txt', data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(readUint32(zip, 0)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(readUint32(zip, eocd)).toBe(0x06054b50);
    expect(readUint16(zip, eocd + 10)).toBe(2);
  });

  it('is deterministic', () => {
    expect(buildReg2902DocxFixture()).toEqual(buildReg2902DocxFixture());
    expect(buildReg2902XlsxFixture()).toEqual(buildReg2902XlsxFixture());
  });

  it('puts [Content_Types].xml first in both fixtures', () => {
    for (const fixture of [
      buildReg2902DocxFixture(),
      buildReg2902XlsxFixture(),
    ]) {
      const nameLength = readUint16(fixture, 26);
      const name = Buffer.from(fixture.subarray(30, 30 + nameLength)).toString(
        'utf8',
      );
      expect(name).toBe('[Content_Types].xml');
    }
  });

  it('builds a deterministic dense DOCX below the upload cap with the expected paragraphs', () => {
    const fixture = buildReg2902DenseDocxFixture();
    expect(fixture).toEqual(buildReg2902DenseDocxFixture());
    expect(fixture.byteLength).toBeLessThan(10 * 1024 * 1024);
    const documentXml = storedZipEntry(fixture, 'word/document.xml');
    expect(documentXml.match(/<w:p(?:>| )/g)).toHaveLength(
      REG2902_DOCX_DENSE_PARAGRAPHS + REG2902_DOCX_DENSE_TABLE_ROWS * 4 + 1,
    );
  });

  it('builds an exact 10 MiB XLSX with substantial worksheet content', () => {
    const fixture = buildReg2902XlsxFixture({
      largeRows: 10_000,
      cellTextChars: 900,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(fixture.byteLength).toBe(10 * 1024 * 1024);
    const dataSheet = storedZipEntry(fixture, 'xl/worksheets/sheet2.xml');
    expect(dataSheet).toContain('<dimension ref="A1:B10000"/>');
    expect(dataSheet.length).toBeGreaterThan(9_000_000);
  });
});
