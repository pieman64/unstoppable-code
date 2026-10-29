'use strict';

/**
 * Deterministic OOXML fixtures shared by root Jest, web Jest, and Playwright for REG-2902 and REG-2944.
 * Files are hand-assembled ZIPs with fixed timestamps, stored by default.
 * The deflated DOCX variant exercises honest and forged expanded sizes.
 *
 * This source stays plain CommonJS because web Jest executes CommonJS while
 * Playwright imports it from TypeScript and ESM specs. Keep its declaration
 * file in sync when changing the public fixture API.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS is the shared Jest/Playwright loader contract.
const { crc32, deflateRawSync } = require('node:zlib');
const REG2902_DOCX_HEADING = 'REG-2902 heading one';
const REG2902_DOCX_BULLET = 'REG-2902 bullet item';
const REG2902_DOCX_TABLE_CELL = 'REG-2902 table cell';
const REG2902_DOCX_INSERTED_TEXT = 'REG-2902 inserted by review';
const REG2902_DOCX_DELETED_TEXT = 'REG-2902 deleted by review';
const REG2902_DOCX_SCRIPT_TEXT =
  '<script>window.__reg2902Injected = true</script>';
const REG2902_DOCX_LINK_TEXT = 'REG-2902 hostile link';
const REG2902_XLSX_SHEET_NAMES = ['Summary', 'Data'];
const REG2902_XLSX_LARGE_ROWS = 5020;
const REG2902_DOCX_DENSE_PARAGRAPHS = 3e4;
const REG2902_DOCX_DENSE_TABLE_ROWS = 2e3;
const REG2902_DOCX_DENSE_LAST_TEXT = 'REG-2902 dense end';
const encoder = new TextEncoder();
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function bytes(data) {
  return typeof data === 'string' ? encoder.encode(data) : data;
}
function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function buildStoredZip(entries) {
  return buildZip(entries);
}
function buildZip(entries, deflatedEntry) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const original = bytes(entry.data);
    const compressed = entry.name === deflatedEntry?.name;
    const data = compressed ? deflateRawSync(original) : original;
    const expandedSize = compressed
      ? (deflatedEntry.expandedSize ?? original.length)
      : original.length;
    const checksum = crc32(original) >>> 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 67324752, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, compressed ? 8 : 0, true);
    lv.setUint16(12, 33, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, expandedSize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 33639248, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, compressed ? 8 : 0, true);
    cv.setUint16(12, 33, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, expandedSize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 101010256, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}
function run(text, properties = '') {
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}
function paragraph(inner, properties = '') {
  return `<w:p>${properties}${inner}</w:p>`;
}
function docxPackage(documentXml, includeImage, deflatedEntry, imageBytes) {
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${includeImage ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
  const rootRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="${R_NS}/styles" Target="styles.xml"/><Relationship Id="rId1" Type="${R_NS}/numbering" Target="numbering.xml"/>${includeImage ? `<Relationship Id="rId2" Type="${R_NS}/image" Target="media/image1.png"/><Relationship Id="rId3" Type="${R_NS}/hyperlink" Target="javascript:window.__reg2902Injected=true" TargetMode="External"/>` : ''}</Relationships>`;
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
    {
      name: 'word/numbering.xml',
      data: `<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    },
    {
      name: 'word/styles.xml',
      data: `<w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    },
  ];
  if (includeImage) {
    entries.push({
      name: 'word/media/image1.png',
      data:
        imageBytes ??
        new Uint8Array(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')),
    });
  }
  return buildZip(entries, deflatedEntry);
}
function buildReg2902DeflatedDocxFixture(options = {}) {
  return docxPackage(
    `<w:document xmlns:w="${W_NS}"><w:body>${paragraph(run('x'.repeat(128 * 1024)))}</w:body></w:document>`,
    false,
    { name: 'word/document.xml', expandedSize: options.declaredDocumentBytes },
  );
}
function buildReg2902DocxFixture(options = {}) {
  const drawing = `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="381000" cy="381000"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const body = [
    paragraph(
      run(REG2902_DOCX_HEADING),
      '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>',
    ),
    paragraph(
      run(REG2902_DOCX_BULLET),
      '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>',
    ),
    `<w:tbl><w:tr><w:tc>${paragraph(run(REG2902_DOCX_TABLE_CELL))}</w:tc><w:tc>${paragraph(run('second cell'))}</w:tc></w:tr></w:tbl>`,
    paragraph(drawing),
    paragraph(run('Basic formatting', '<w:rPr><w:b/><w:i/></w:rPr>')),
    paragraph(
      `<w:ins w:id="1">${run(REG2902_DOCX_INSERTED_TEXT)}</w:ins><w:del w:id="2"><w:r><w:delText>${escapeXml(REG2902_DOCX_DELETED_TEXT)}</w:delText></w:r></w:del>`,
    ),
    paragraph(run(REG2902_DOCX_SCRIPT_TEXT)),
    paragraph(
      `<w:hyperlink r:id="rId3">${run(REG2902_DOCX_LINK_TEXT)}</w:hyperlink>`,
    ),
  ].join('');
  return docxPackage(
    `<?xml version="1.0"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}</w:body></w:document>`,
    true,
    undefined,
    options.imageBytes,
  );
}
function buildReg2902DenseDocxFixture(options = {}) {
  const paragraphCount = options.paragraphs ?? REG2902_DOCX_DENSE_PARAGRAPHS;
  const tableRowCount = options.tableRows ?? REG2902_DOCX_DENSE_TABLE_ROWS;
  const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    const pPr =
      index % 10 === 0
        ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        : index % 5 === 0
          ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
          : '';
    paragraphs.push(
      paragraph(
        [0, 1, 2, 3]
          .map((part) =>
            run(
              `p${index} r${part}`,
              part % 3 === 0
                ? '<w:rPr><w:b/></w:rPr>'
                : part % 3 === 1
                  ? '<w:rPr><w:i/></w:rPr>'
                  : '',
            ),
          )
          .join(''),
        pPr,
      ),
    );
  }
  const rows = [];
  for (let row = 0; row < tableRowCount; row += 1) {
    rows.push(
      `<w:tr>${[0, 1, 2, 3].map((column) => `<w:tc>${paragraph(run(`t${row} c${column}`))}</w:tc>`).join('')}</w:tr>`,
    );
  }
  const body = `${paragraphs.join('')}<w:tbl>${rows.join('')}</w:tbl>${paragraph(run(REG2902_DOCX_DENSE_LAST_TEXT))}`;
  return docxPackage(
    `<?xml version="1.0"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}</w:body></w:document>`,
    false,
  );
}
function inlineCell(ref, text) {
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
}
function buildReg2902XlsxFixture(options = {}) {
  const largeRows = options.largeRows ?? REG2902_XLSX_LARGE_ROWS;
  const summary = `<?xml version="1.0"?><worksheet xmlns="${S_NS}"><dimension ref="A1:B5"/><sheetData><row r="1">${inlineCell('A1', 'Region')}${inlineCell('B1', 'Total')}</row><row r="2">${inlineCell('A2', 'North')}<c r="B2"><v>10</v></c></row><row r="3">${inlineCell('A3', 'South')}<c r="B3"><v>20</v></c></row><row r="4">${inlineCell('A4', 'Sum')}<c r="B4"><f>SUM(B2:B3)</f><v>30</v></c></row><row r="5">${inlineCell('A5', 'Merged footer')}</row></sheetData><mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells></worksheet>`;
  const rows = [];
  for (let index = 1; index <= largeRows; index += 1) {
    rows.push(
      `<row r="${index}">${inlineCell(`A${index}`, `row ${index}`.padEnd(options.cellTextChars ?? 0, 'x'))}<c r="B${index}"><v>${index}</v></c></row>`,
    );
  }
  const data = `<?xml version="1.0"?><worksheet xmlns="${S_NS}"><dimension ref="A1:B${largeRows}"/><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets><sheet name="${REG2902_XLSX_SHEET_NAMES[0]}" sheetId="1" r:id="rId1"/><sheet name="${REG2902_XLSX_SHEET_NAMES[1]}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R_NS}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: summary },
    { name: 'xl/worksheets/sheet2.xml', data },
  ];
  const ordinary = buildStoredZip(entries);
  if (options.targetBytes === void 0) return ordinary;
  const paddingName = 'preview-padding.txt';
  const paddingSize =
    options.targetBytes -
    ordinary.length -
    76 -
    2 * encoder.encode(paddingName).length;
  if (!Number.isSafeInteger(paddingSize) || paddingSize < 0) {
    throw new Error('Fixture target is too small.');
  }
  return buildStoredZip([
    ...entries,
    { name: paddingName, data: new Uint8Array(paddingSize) },
  ]);
}
function buildReg2902ElementBudgetDocxFixture(options = {}) {
  const paragraphCount = options.paragraphs ?? 200001;
  const documentXml =
    `<?xml version="1.0"?><w:document xmlns:w="${W_NS}"><w:body>` +
    '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(paragraphCount) +
    '</w:body></w:document>';
  return docxPackage(documentXml, false);
}
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PKG_RELS_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const PPTX_TITLE = 'Quarterly support review';
const PPTX_BULLETS = ['Tickets down 12%', 'CSAT steady at 94%'];
const PPTX_NOTES = 'Mention the holiday staffing plan.';
const PPTX_TABLE_CELL = 'Urgent bugs';
const PPTX_GROUP_TEXT = 'Grouped callout';
const PPTX_MASTER_FILL = '#2563eb';
const PPTX_HIDDEN_BACKGROUND = '#fef3c7';
function pptxRels(relationships) {
  return `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS_NS}">${relationships
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`,
    )
    .join('')}</Relationships>`;
}
function pptxXfrm(x, y, cx, cy) {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}
function pptxText(paragraphs) {
  return `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
    .map(
      (text) =>
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`,
    )
    .join('')}</p:txBody>`;
}
function pptxPlaceholder(id, type, idx, xfrm, paragraphs) {
  const typeAttr = type ? ` type="${type}"` : '';
  const idxAttr = idx === undefined ? '' : ` idx="${idx}"`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="ph${id}"/><p:cNvSpPr/><p:nvPr><p:ph${typeAttr}${idxAttr}/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr>${pptxText(paragraphs)}</p:sp>`;
}
function pptxPart(rootName, inner, attributes = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:${rootName} xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"${attributes}>${inner}</p:${rootName}>`;
}
function pptxTree(shapes) {
  return `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;
}
function buildPptxFixture(options = {}) {
  const extraSlides = options.extraSlides ?? 0;
  const theme = `<?xml version="1.0"?><a:theme xmlns:a="${A_NS}" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="E5E7EB"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const masterShapes = [
    pptxPlaceholder(
      2,
      'title',
      undefined,
      pptxXfrm(838200, 365125, 10515600, 1325563),
      [],
    ),
    pptxPlaceholder(
      3,
      'body',
      1,
      pptxXfrm(838200, 1825625, 10515600, 4351338),
      [],
    ),
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Brand bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${pptxXfrm(0, 6604000, 12192000, 254000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`,
  ].join('');
  const master = pptxPart(
    'sldMaster',
    `${pptxTree(masterShapes)}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>`,
  );
  const layout = pptxPart(
    'sldLayout',
    pptxTree(
      [
        pptxPlaceholder(
          2,
          'title',
          undefined,
          pptxXfrm(838200, 457200, 10515600, 1000000),
          [],
        ).replace(
          '<a:lstStyle/>',
          `<a:lstStyle/>${options.layoutTitleParagraph ?? ''}`,
        ),
        pptxPlaceholder(3, undefined, 1, '', []),
      ].join(''),
    ),
    ' type="titleAndContent" preserve="1"',
  );
  const titleSlide = pptxPart(
    'sld',
    pptxTree(
      [
        pptxPlaceholder(2, 'title', undefined, '', [PPTX_TITLE]),
        pptxPlaceholder(3, undefined, 1, '', PPTX_BULLETS),
        `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart image" descr="Ticket trend"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${pptxXfrm(8000000, 2000000, 3000000, 2000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`.repeat(
          options.imageReferences ?? 1,
        ),
      ].join(''),
    ),
  );
  const detailSlide = pptxPart(
    'sld',
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FEF3C7"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${[
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1000000"/><a:ext cx="6000000" cy="740000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="4000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="370000"><a:tc>${'<a:txBody><a:bodyPr/><a:p><a:r><a:t>' + PPTX_TABLE_CELL + '</a:t></a:r></a:p></a:txBody>'}<a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>7</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr><a:tr h="370000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Merged total</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:tcPr></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="7200000" y="1000000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`,
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="4000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="5" name="Callout"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${pptxXfrm(2000000, 0, 2000000, 2000000)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr>${pptxText([PPTX_GROUP_TEXT])}</p:sp></p:grpSp>`,
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="6" name="Connector"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`,
    ].join('')}</p:spTree></p:cSld>`,
    ' show="0"',
  );
  const simpleSlide = (index) =>
    pptxPart(
      'sld',
      pptxTree(
        pptxPlaceholder(2, 'title', undefined, '', [`Extra slide ${index}`]),
      ),
    );
  const notes = pptxPart(
    'notes',
    pptxTree(
      [
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`,
        pptxPlaceholder(3, 'body', 1, '', [PPTX_NOTES]),
      ].join(''),
    ),
  );
  const slideCount = 2 + extraSlides;
  const slideIds = [];
  const presentationRels = [
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'theme', 'theme/theme1.xml'],
  ];
  // Slide order follows sldIdLst, not part names: slide2.xml is first.
  for (let index = 0; index < slideCount; index += 1) {
    const partNumber = index === 0 ? 2 : index === 1 ? 1 : index + 1;
    if (!(options.omitSlideRelationship && index === 0)) {
      presentationRels.push([
        `rId${10 + index}`,
        'slide',
        `slides/slide${partNumber}.xml`,
      ]);
    }
    slideIds.push(`<p:sldId id="${256 + index}" r:id="rId${10 + index}"/>`);
  }
  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: pptxRels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    },
    {
      name: 'ppt/presentation.xml',
      data: pptxPart(
        'presentation',
        `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>`,
      ),
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: pptxRels(presentationRels),
    },
    { name: 'ppt/theme/theme1.xml', data: theme },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: pptxRels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'theme', '../theme/theme1.xml'],
      ]),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: pptxRels([
        ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
      ]),
    },
    { name: 'ppt/slides/slide2.xml', data: titleSlide },
    {
      name: 'ppt/slides/_rels/slide2.xml.rels',
      data: pptxRels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', '../media/image1.png'],
        ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ]),
    },
    { name: 'ppt/slides/slide1.xml', data: detailSlide },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: pptxRels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ]),
    },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes },
    {
      name: 'ppt/media/image1.png',
      data:
        options.imageBytes ??
        new Uint8Array(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')),
    },
  ];
  for (let index = 2; index < slideCount; index += 1) {
    entries.push(
      {
        name: `ppt/slides/slide${index + 1}.xml`,
        data: simpleSlide(index + 1),
      },
      {
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: pptxRels([
          ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ]),
      },
    );
  }
  if (options.macro) {
    entries.push({ name: 'ppt/vbaProject.bin', data: new Uint8Array(4) });
  }
  return buildZip(entries.filter((entry) => entry.name !== options.omitPart));
}
module.exports = {
  ONE_PIXEL_PNG_BASE64,
  PPTX_BULLETS,
  PPTX_GROUP_TEXT,
  PPTX_HIDDEN_BACKGROUND,
  PPTX_MASTER_FILL,
  PPTX_NOTES,
  PPTX_TABLE_CELL,
  PPTX_TITLE,
  buildPptxFixture,
  REG2902_DOCX_BULLET,
  REG2902_DOCX_DELETED_TEXT,
  REG2902_DOCX_DENSE_LAST_TEXT,
  REG2902_DOCX_DENSE_PARAGRAPHS,
  REG2902_DOCX_DENSE_TABLE_ROWS,
  REG2902_DOCX_HEADING,
  REG2902_DOCX_INSERTED_TEXT,
  REG2902_DOCX_LINK_TEXT,
  REG2902_DOCX_SCRIPT_TEXT,
  REG2902_DOCX_TABLE_CELL,
  REG2902_XLSX_LARGE_ROWS,
  REG2902_XLSX_SHEET_NAMES,
  buildReg2902DenseDocxFixture,
  buildReg2902DeflatedDocxFixture,
  buildReg2902ElementBudgetDocxFixture,
  buildReg2902DocxFixture,
  buildReg2902XlsxFixture,
  buildStoredZip,
};
