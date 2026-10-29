import XLSX from 'xlsx';
import mammoth from 'mammoth';
import {
  REG2902_DOCX_BULLET,
  REG2902_DOCX_DELETED_TEXT,
  REG2902_DOCX_HEADING,
  REG2902_DOCX_INSERTED_TEXT,
  REG2902_DOCX_SCRIPT_TEXT,
  REG2902_DOCX_TABLE_CELL,
  REG2902_XLSX_LARGE_ROWS,
  REG2902_XLSX_SHEET_NAMES,
  buildReg2902DocxFixture,
  buildReg2902DeflatedDocxFixture,
  buildReg2902XlsxFixture,
  buildStoredZip,
} from '../../../test/ooxml-fixtures.js';
import {
  XLSX_PREVIEW_MAX_COLS,
  XLSX_PREVIEW_MAX_ROWS,
  parseDocxToHtml,
  parseXlsxWorkbook,
} from '../office-parse';

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function storedEntries(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      data: Uint8Array.from(bytes.subarray(dataStart, dataStart + size)),
    });
    offset = dataStart + size;
  }
  return entries;
}

function workbookWithSheets(sheetXmls: readonly string[]): Uint8Array {
  const overrides = sheetXmls
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  const sheets = sheetXmls
    .map(
      (_, index) =>
        `<sheet name="Sheet ${index + 1}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  const relationships = sheetXmls
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
  return buildStoredZip([
    {
      name: '[Content_Types].xml',
      data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    },
    ...sheetXmls.map((data, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data,
    })),
  ]);
}

function singleSheetWorkbook(sheetXml: string): Uint8Array {
  return workbookWithSheets([sheetXml]);
}

describe('parseDocxToHtml', () => {
  it('previews a truthfully sized deflated document', async () => {
    const result = await parseDocxToHtml(
      buffer(buildReg2902DeflatedDocxFixture()),
    );
    expect(result.html).toContain('x'.repeat(128 * 1024));
  });

  it.each([1, 1024 * 1024])(
    'rejects a deflated document declaring %s bytes before Mammoth runs',
    async (declaredDocumentBytes) => {
      const convert = jest.spyOn(mammoth, 'convertToHtml');
      await expect(
        parseDocxToHtml(
          buffer(
            buildReg2902DeflatedDocxFixture({
              declaredDocumentBytes,
            }),
          ),
        ),
      ).rejects.toThrow(
        'Office ZIP expanded size does not match its directory.',
      );
      expect(convert).not.toHaveBeenCalled();
    },
  );
  it('renders headings, lists, tables, inline images, and tracked insertions', async () => {
    const result = await parseDocxToHtml(buffer(buildReg2902DocxFixture()));
    expect(result.kind).toBe('docx');
    expect(result.html).toContain(`<h1>${REG2902_DOCX_HEADING}</h1>`);
    expect(result.html).toMatch(
      new RegExp(`<ul>\\s*<li>${REG2902_DOCX_BULLET}</li>`),
    );
    expect(result.html).toMatch(
      new RegExp(`<td>\\s*<p>${REG2902_DOCX_TABLE_CELL}</p>`),
    );
    expect(result.html).toContain('<img src="data:image/png;base64,');
    expect(result.html).toContain(REG2902_DOCX_INSERTED_TEXT);
    expect(result.html).not.toContain(REG2902_DOCX_DELETED_TEXT);
  });

  it('escapes literal markup but leaves hostile link removal to the sanitizer', async () => {
    const result = await parseDocxToHtml(buffer(buildReg2902DocxFixture()));
    expect(result.html).not.toContain(REG2902_DOCX_SCRIPT_TEXT);
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('href="javascript:');
  });

  it('rejects bytes that are not a DOCX package', async () => {
    await expect(
      parseDocxToHtml(buffer(new TextEncoder().encode('not a docx'))),
    ).rejects.toThrow();
  });

  it('omits unsupported and individually oversized inline images', async () => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const unsupported = storedEntries(buildReg2902DocxFixture()).map(
      (entry) => ({
        name: entry.name,
        data:
          entry.name === '[Content_Types].xml'
            ? encoder.encode(
                decoder
                  .decode(entry.data)
                  .replace('image/png', 'image/svg+xml'),
              )
            : entry.data,
      }),
    );
    const unsupportedResult = await parseDocxToHtml(
      buffer(buildStoredZip(unsupported)),
    );
    expect(unsupportedResult.html).toContain('Unsupported image omitted');
    expect(unsupportedResult.html).not.toContain('data:image/svg+xml');

    const oversized = storedEntries(buildReg2902DocxFixture()).map((entry) => ({
      name: entry.name,
      data:
        entry.name === 'word/media/image1.png'
          ? new Uint8Array(4 * 1024 * 1024 + 1)
          : entry.data,
    }));
    const oversizedResult = await parseDocxToHtml(
      buffer(buildStoredZip(oversized)),
    );
    expect(oversizedResult.html).toContain('Large image omitted');
    expect(oversizedResult.html).not.toContain('data:image/png;base64,');
  });

  it('enforces the cumulative inline-image budget across repeated images', async () => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const image = new Uint8Array(3 * 1024 * 1024);
    const entries = storedEntries(buildReg2902DocxFixture());
    const documentEntry = entries.find(
      (entry) => entry.name === 'word/document.xml',
    );
    const relationshipsEntry = entries.find(
      (entry) => entry.name === 'word/_rels/document.xml.rels',
    );
    if (!documentEntry || !relationshipsEntry)
      throw new Error('DOCX fixture is incomplete.');
    const documentXml = decoder.decode(documentEntry.data);
    const drawing = /<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/.exec(
      documentXml,
    )?.[0];
    if (!drawing) throw new Error('DOCX fixture has no drawing.');
    const doubledDocument = documentXml.replace(
      drawing,
      `${drawing}${drawing.replace('rId2', 'rId5')}`,
    );
    const doubledRelationships = decoder
      .decode(relationshipsEntry.data)
      .replace(
        '</Relationships>',
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>',
      );
    const doubled = entries.map((entry) => ({
      name: entry.name,
      data:
        entry.name === 'word/document.xml'
          ? encoder.encode(doubledDocument)
          : entry.name === 'word/_rels/document.xml.rels'
            ? encoder.encode(doubledRelationships)
            : entry.name === 'word/media/image1.png'
              ? image
              : entry.data,
    }));
    doubled.push({ name: 'word/media/image2.png', data: image });
    const result = await parseDocxToHtml(buffer(buildStoredZip(doubled)));
    expect(result.html.match(/data:image\/png;base64,/g)).toHaveLength(1);
    expect(result.html).toContain('Large image omitted');
  });
});

describe('parseXlsxWorkbook', () => {
  it('previews the exact 10 MiB responsiveness fixture with retained rows', () => {
    const bytes = buildReg2902XlsxFixture({
      largeRows: 10_000,
      cellTextChars: 900,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(bytes.byteLength).toBe(10 * 1024 * 1024);
    const result = parseXlsxWorkbook(buffer(bytes));
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(
      REG2902_XLSX_SHEET_NAMES,
    );
    expect(result.sheets[1].rowCount).toBe(10_000);
    expect(result.sheets[1].rows).toHaveLength(XLSX_PREVIEW_MAX_ROWS);
    expect(result.sheets[1].rows[0][0]).not.toBe('');
  });
  it('rejects sparse cells outside the visible columns before SheetJS reads them', () => {
    const cells = Array.from(
      { length: 2_000 },
      (_, col) => `<c r="${XLSX.utils.encode_col(col)}1"/>`,
    ).join('');
    const rows = Array.from(
      { length: 100 },
      (_, row) =>
        `<row r="${row + 1}">${cells.split('1"').join(`${row + 1}"`)}</row>`,
    ).join('');
    const bytes = buffer(
      singleSheetWorkbook(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:BXX100"/><sheetData>${rows}</sheetData></worksheet>`,
      ),
    );
    expect(bytes.byteLength).toBeLessThan(10 * 1024 * 1024);
    const read = jest.spyOn(XLSX, 'read');
    try {
      expect(() => parseXlsxWorkbook(bytes)).toThrow('structure budget');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('bounds live vendor worksheets when multiple sheets reference the same XML', () => {
    const xml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>';
    const entries = storedEntries(workbookWithSheets([xml, xml])).map(
      (entry) => ({
        ...entry,
        data:
          entry.name === 'xl/_rels/workbook.xml.rels'
            ? new TextEncoder().encode(
                new TextDecoder()
                  .decode(entry.data)
                  .replace('worksheets/sheet2.xml', 'worksheets/sheet1.xml'),
              )
            : entry.data,
      }),
    );
    const originalRead = XLSX.read;
    let maxLiveSheets = 0;
    const read = jest.spyOn(XLSX, 'read').mockImplementation((...args) => {
      const workbook = originalRead(...args);
      maxLiveSheets = Math.max(
        maxLiveSheets,
        Object.keys(workbook.Sheets ?? {}).length,
      );
      return workbook;
    });
    try {
      const result = parseXlsxWorkbook(buffer(buildStoredZip(entries)));
      expect(result.sheets.map((sheet) => sheet.rows)).toEqual([
        [['42']],
        [['42']],
      ]);
      expect(maxLiveSheets).toBeLessThanOrEqual(1);
    } finally {
      read.mockRestore();
    }
  });

  it('exposes every sheet with cached values, merges, and a formula flag', () => {
    const result = parseXlsxWorkbook(buffer(buildReg2902XlsxFixture()));
    expect(result.sheets.map((sheet) => sheet.name)).toEqual([
      ...REG2902_XLSX_SHEET_NAMES,
    ]);
    const summary = result.sheets[0];
    expect(summary.rows[0]).toEqual(['Region', 'Total']);
    expect(summary.rows[3]).toEqual(['Sum', '30']);
    expect(summary.hasFormulas).toBe(true);
    expect(summary.merges).toEqual([
      { startRow: 4, startCol: 0, endRow: 4, endCol: 1 },
    ]);
  });

  it('clips rows to the preview cap while retaining declared dimensions', () => {
    const data = parseXlsxWorkbook(buffer(buildReg2902XlsxFixture())).sheets[1];
    expect(data.rowCount).toBe(REG2902_XLSX_LARGE_ROWS);
    expect(data.rows).toHaveLength(XLSX_PREVIEW_MAX_ROWS);
    expect(data.rows[XLSX_PREVIEW_MAX_ROWS - 1][0]).toBe(
      `row ${XLSX_PREVIEW_MAX_ROWS}`,
    );
    expect(data.hasFormulas).toBe(false);
  });

  it('clips 201 declared columns to 200', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:GS1"/><sheetData><row r="1"><c r="GS1"><v>201</v></c></row></sheetData></worksheet>',
    );
    const sheet = parseXlsxWorkbook(buffer(workbook)).sheets[0];
    expect(sheet.colCount).toBe(201);
    expect(sheet.rows[0]).toHaveLength(XLSX_PREVIEW_MAX_COLS);
  });

  it('renders a formula without a saved value as blank', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
    );
    const sheet = parseXlsxWorkbook(buffer(workbook)).sheets[0];
    expect(sheet.rows[0]).toEqual(['']);
    expect(sheet.hasFormulas).toBe(true);
  });

  it('preserves late-starting dimensions with leading blank cells', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="C3:D3"/><sheetData><row r="3"><c r="C3" t="inlineStr"><is><t>late</t></is></c></row></sheetData></worksheet>',
    );
    const sheet = parseXlsxWorkbook(buffer(workbook)).sheets[0];
    expect({ rowCount: sheet.rowCount, colCount: sheet.colCount }).toEqual({
      rowCount: 3,
      colCount: 4,
    });
    expect(sheet.rows[0]).toEqual(['', '', '', '']);
    expect(sheet.rows[2]).toEqual(['', '', 'late', '']);
  });

  it('returns a zero-sized model for a blank sheet', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    );
    expect(parseXlsxWorkbook(buffer(workbook)).sheets[0]).toEqual({
      name: 'Sheet 1',
      rowCount: 0,
      colCount: 0,
      rows: [],
      merges: [],
      hasFormulas: false,
    });
  });

  it('clips vertical merges to retained rows and rejects overlapping merges', () => {
    const clipped = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B6000"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>anchor</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B6000"/></mergeCells></worksheet>',
    );
    expect(parseXlsxWorkbook(buffer(clipped)).sheets[0].merges).toEqual([
      { startRow: 0, startCol: 0, endRow: 4_999, endCol: 1 },
    ]);

    const overlapping = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C3"/><sheetData/><mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/></mergeCells></worksheet>',
    );
    expect(() => parseXlsxWorkbook(buffer(overlapping))).toThrow('Overlapping');
  });

  it('rejects more than 1,000 merges', () => {
    const merges = Array.from(
      { length: 1_001 },
      (_, index) => `<mergeCell ref="A${index + 1}:B${index + 1}"/>`,
    ).join('');
    const workbook = singleSheetWorkbook(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1001"/><sheetData/><mergeCells count="1001">${merges}</mergeCells></worksheet>`,
    );
    expect(() => parseXlsxWorkbook(buffer(workbook))).toThrow(
      'Too many merged ranges',
    );
  });

  it('rejects malformed merge coordinates', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData/><mergeCells count="1"><mergeCell ref="B2:A1"/></mergeCells></worksheet>',
    );
    expect(() => parseXlsxWorkbook(buffer(workbook))).toThrow(
      'Invalid merged range',
    );
  });

  it('accepts exactly one million retained cells and rejects a second sheet', () => {
    const millionCells =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:GR5000"/><sheetData/></worksheet>';
    expect(
      parseXlsxWorkbook(buffer(workbookWithSheets([millionCells]))).sheets,
    ).toHaveLength(1);
    expect(() =>
      parseXlsxWorkbook(
        buffer(
          workbookWithSheets([
            millionCells,
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData/></worksheet>',
          ]),
        ),
      ),
    ).toThrow('cell budget');
  });

  it('retains full dimensions when formulas fall beyond the row cap', () => {
    const workbook = singleSheetWorkbook(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A5001"/><sheetData><row r="5001"><c r="A5001"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
    );
    const sheet = parseXlsxWorkbook(buffer(workbook)).sheets[0];
    expect(sheet.rowCount).toBe(5_001);
    expect(sheet.rows).toHaveLength(5_000);
    expect(sheet.hasFormulas).toBe(false);
  });

  it('rejects retained cell text beyond the serialized output budget', () => {
    const workbook = buildReg2902XlsxFixture({
      largeRows: 5_000,
      cellTextChars: 1_700,
    });
    expect(() => parseXlsxWorkbook(buffer(workbook))).toThrow('text exceeds');
  });

  it('rejects bytes that are not a workbook', () => {
    expect(() =>
      parseXlsxWorkbook(buffer(new TextEncoder().encode('nope'))),
    ).toThrow();
  });
});
