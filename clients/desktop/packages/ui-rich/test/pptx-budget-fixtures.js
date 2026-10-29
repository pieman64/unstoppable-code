'use strict';

// Plain CommonJS lets Jest and the desktop/web Playwright suites share this
// deterministic fixture without loading production parser code in the runner.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildStoredZip } = require('./ooxml-fixtures.js');

const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function textBody(
  paragraphs,
  runsPerParagraph,
  text = 'Budget text',
  numberingStartAt,
) {
  const runs = `<a:r><a:t>${text}</a:t></a:r>`.repeat(runsPerParagraph);
  const numbering =
    numberingStartAt === undefined
      ? ''
      : `<a:pPr><a:buAutoNum type="romanLcPeriod" startAt="${numberingStartAt}"/></a:pPr>`;
  return `<a:bodyPr/><a:lstStyle/>${`<a:p>${numbering}${runs}</a:p>`.repeat(paragraphs)}`;
}

function shape(body) {
  return `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody>${body}</p:txBody></p:sp>`;
}

function buildPptxBudgetFixture(options = {}) {
  const {
    slideCount = 1,
    tableCells = 0,
    tableRows = 1,
    tableColumns = 1,
    mergedCells = false,
    paragraphs = 1,
    runsPerParagraph = 1,
    notesParagraphs = 0,
    inertNodes = 0,
    masterParagraphs = 0,
    textChars,
    numberingStartAt,
    fontFamilyChars = 0,
    lineBreaks = 0,
  } = options;
  const text = textChars === undefined ? 'Budget text' : 'x'.repeat(textChars);
  const shapeBody =
    fontFamilyChars || lineBreaks
      ? `<a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr><a:latin typeface="${'A'.repeat(fontFamilyChars)}"/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p>${'<a:br/>'.repeat(lineBreaks)}</a:p>`
      : textBody(paragraphs, runsPerParagraph, text, numberingStartAt);
  const content = tableCells
    ? `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid>${'<a:gridCol w="1000000"/>'.repeat(tableColumns)}</a:tblGrid>${`<a:tr h="1000000">${(mergedCells ? '<a:tc hMerge="1"/>' : `<a:tc><a:txBody>${textBody(paragraphs, runsPerParagraph, text)}</a:txBody></a:tc>`).repeat(tableCells)}</a:tr>`.repeat(tableRows)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    : shape(shapeBody);
  const entries = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' },
    {
      name: 'ppt/presentation.xml',
      data: `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}"><p:sldIdLst>${Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${index + 1}" r:id="s${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<Relationships>${Array.from({ length: slideCount }, (_, index) => `<Relationship Id="s${index + 1}" Type="${R_NS}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
    },
  ];
  for (let index = 1; index <= slideCount; index += 1) {
    entries.push({
      name: `ppt/slides/slide${index}.xml`,
      data: `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${content}${'<a:unused/>'.repeat(inertNodes)}</p:spTree></p:cSld></p:sld>`,
    });
    const relationships = [];
    if (notesParagraphs) {
      relationships.push(
        `<Relationship Id="n" Type="${R_NS}/notesSlide" Target="../notesSlides/notes${index}.xml"/>`,
      );
      entries.push({
        name: `ppt/notesSlides/notes${index}.xml`,
        data: `<p:notes xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${textBody(notesParagraphs, 1)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      });
    }
    if (masterParagraphs) {
      relationships.push(
        `<Relationship Id="l" Type="${R_NS}/slideLayout" Target="../slideLayouts/layout.xml"/>`,
      );
    }
    if (relationships.length) {
      entries.push({
        name: `ppt/slides/_rels/slide${index}.xml.rels`,
        data: `<Relationships>${relationships.join('')}</Relationships>`,
      });
    }
  }
  if (masterParagraphs) {
    entries.push(
      {
        name: 'ppt/slideLayouts/layout.xml',
        data: `<p:sldLayout xmlns:p="${P_NS}"/>`,
      },
      {
        name: 'ppt/slideLayouts/_rels/layout.xml.rels',
        data: `<Relationships><Relationship Id="m" Type="${R_NS}/slideMaster" Target="../slideMasters/master.xml"/></Relationships>`,
      },
      {
        name: 'ppt/slideMasters/master.xml',
        data: `<p:sldMaster xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${shape(textBody(masterParagraphs, 1, text))}</p:spTree></p:cSld></p:sldMaster>`,
      },
    );
  }
  return buildStoredZip(entries);
}

module.exports = { buildPptxBudgetFixture };
