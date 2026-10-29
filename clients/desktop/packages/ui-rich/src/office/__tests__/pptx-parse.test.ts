import {
  buildPptxFixture,
  buildReg2902DocxFixture,
  buildStoredZip,
  PPTX_BULLETS,
  PPTX_GROUP_TEXT,
  PPTX_HIDDEN_BACKGROUND,
  PPTX_MASTER_FILL,
  PPTX_NOTES,
  PPTX_TABLE_CELL,
  PPTX_TITLE,
} from '../../../test/ooxml-fixtures.js';
import {
  parsePptxPresentation,
  PPTX_PREVIEW_MAX_IMAGE_BYTES,
  PPTX_PREVIEW_MAX_SLIDES,
  type PptxElement,
  type PptxSlideModel,
} from '../pptx-parse';

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function slideText(slide: PptxSlideModel): string[] {
  const text: string[] = [];
  const collect = (element: PptxElement): void => {
    if (element.kind === 'shape' && element.text) {
      for (const paragraph of element.text.paragraphs) {
        text.push(paragraph.runs.map((run) => run.text).join(''));
      }
    }
    if (element.kind === 'table') {
      for (const row of element.rows) {
        for (const cell of row.cells) {
          for (const paragraph of cell?.text?.paragraphs ?? []) {
            text.push(paragraph.runs.map((run) => run.text).join(''));
          }
        }
      }
    }
  };
  slide.elements.forEach(collect);
  return text;
}

function findShapeWithText(
  slide: PptxSlideModel,
  text: string,
): Extract<PptxElement, { kind: 'shape' }> | undefined {
  for (const element of slide.elements) {
    if (
      element.kind === 'shape' &&
      element.text?.paragraphs.some((paragraph) =>
        paragraph.runs.some((run) => run.text === text),
      )
    ) {
      return element;
    }
  }
  return undefined;
}

describe('parsePptxPresentation', () => {
  const result = parsePptxPresentation(buffer(buildPptxFixture()));
  const [titleSlide, detailSlide] = result.slides;

  it('orders slides by the presentation slide list, not part names', () => {
    expect(result.kind).toBe('pptx');
    expect(result.slideWidth).toBe(12_192_000);
    expect(result.slideHeight).toBe(6_858_000);
    expect(result.slideCount).toBe(2);
    expect(result.slides.map((slide) => slide.number)).toEqual([1, 2]);
    expect(titleSlide && slideText(titleSlide)).toContain(PPTX_TITLE);
    expect(detailSlide && slideText(detailSlide)).toContain(PPTX_TABLE_CELL);
  });

  it('inherits placeholder geometry and text styles from layout and master', () => {
    if (!titleSlide) throw new Error('Missing title slide.');
    const title = findShapeWithText(titleSlide, PPTX_TITLE);
    // Layout overrides the master title position.
    expect(title?.box).toMatchObject({
      x: 838_200,
      y: 457_200,
      width: 10_515_600,
      height: 1_000_000,
    });
    expect(title?.text?.paragraphs[0]?.runs[0]).toMatchObject({
      sizePt: 44,
      bold: true,
      color: '#1f2937',
      fontFamily: 'Calibri Light',
    });
    // The layout body has no xfrm, so the master position applies.
    const body = findShapeWithText(titleSlide, PPTX_BULLETS[0]);
    expect(body?.box).toMatchObject({ x: 838_200, y: 1_825_625 });
    expect(body?.text?.paragraphs.map((paragraph) => paragraph.bullet)).toEqual(
      ['•', '•'],
    );
    expect(body?.text?.paragraphs[0]?.runs[0]).toMatchObject({
      sizePt: 28,
      color: '#000000',
      fontFamily: 'Calibri',
    });
  });

  it('uses matching layout placeholder paragraph defaults before master text styles', () => {
    const deck = parsePptxPresentation(
      buffer(
        buildPptxFixture({
          layoutTitleParagraph:
            '<a:p><a:pPr algn="ctr"><a:defRPr sz="3600"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr></a:p>',
        }),
      ),
    );
    const firstSlide = deck.slides[0];
    if (!firstSlide) throw new Error('Missing title slide.');
    const title = findShapeWithText(firstSlide, PPTX_TITLE);
    expect(title?.text?.paragraphs[0]).toMatchObject({
      align: 'center',
      runs: [{ sizePt: 36, color: '#ffffff' }],
    });
  });

  it('renders master decoration but not layout or master placeholders', () => {
    if (!titleSlide) throw new Error('Missing title slide.');
    const masterBar = titleSlide.elements.find(
      (element) =>
        element.kind === 'shape' && element.fill === PPTX_MASTER_FILL,
    );
    expect(masterBar).toBeDefined();
    const emptyShapes = titleSlide.elements.filter(
      (element) =>
        element.kind === 'shape' && !element.text && element.fill === undefined,
    );
    expect(emptyShapes).toHaveLength(0);
  });

  it('embeds supported images and collects speaker notes', () => {
    const image = titleSlide?.elements.find(
      (element) => element.kind === 'image',
    );
    expect(image).toMatchObject({ kind: 'image', alt: 'Ticket trend' });
    expect(image?.kind === 'image' ? image.src : undefined).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(titleSlide?.notes).toEqual([PPTX_NOTES]);
    expect(detailSlide?.notes).toEqual([]);
  });

  it('reads tables, groups, connectors, charts, and slide backgrounds', () => {
    if (!detailSlide) throw new Error('Missing detail slide.');
    expect(detailSlide.hidden).toBe(true);
    expect(detailSlide.background).toBe(PPTX_HIDDEN_BACKGROUND);
    const table = detailSlide.elements.find(
      (element) => element.kind === 'table',
    );
    if (table?.kind !== 'table') throw new Error('Missing table.');
    expect(table.columnWidths).toEqual([4_000_000, 2_000_000]);
    expect(table.rows[1]?.cells[0]).toMatchObject({
      colSpan: 2,
      fill: '#e5e7eb',
    });
    expect(table.rows[1]?.cells[1]).toBeNull();
    expect(
      detailSlide.elements.find((element) => element.kind === 'unsupported'),
    ).toMatchObject({ label: 'Chart' });
    // Child space 4,000,000 x 2,000,000 maps onto a 2,000,000 x 1,000,000 group.
    const grouped = findShapeWithText(detailSlide, PPTX_GROUP_TEXT);
    expect(grouped).toMatchObject({
      geometry: 'ellipse',
      box: { x: 2_000_000, y: 4_000_000, width: 1_000_000, height: 1_000_000 },
    });
    // accent2 #DC2626 at 50% luminance.
    expect(grouped?.fill).toBe('#6f1212');
    expect(
      detailSlide.elements.find((element) => element.kind === 'line'),
    ).toMatchObject({
      x1: 0,
      y1: 500_000,
      x2: 1_000_000,
      y2: 0,
      stroke: { color: '#111827', width: 25_400 },
    });
  });

  it('caps the slide list and reports the full count', () => {
    const large = parsePptxPresentation(
      buffer(buildPptxFixture({ extraSlides: PPTX_PREVIEW_MAX_SLIDES })),
    );
    expect(large.slideCount).toBe(PPTX_PREVIEW_MAX_SLIDES + 2);
    expect(large.slides).toHaveLength(PPTX_PREVIEW_MAX_SLIDES);
  });

  it.each([
    ['referenced first slide', 'ppt/slides/slide2.xml'],
    ['referenced second slide', 'ppt/slides/slide1.xml'],
    ['presentation relationship file', 'ppt/_rels/presentation.xml.rels'],
  ])('rejects a missing %s', (_label, omitPart) => {
    expect(() =>
      parsePptxPresentation(buffer(buildPptxFixture({ omitPart }))),
    ).toThrow();
  });

  it('rejects a slide ID without a matching relationship', () => {
    expect(() =>
      parsePptxPresentation(
        buffer(buildPptxFixture({ omitSlideRelationship: true })),
      ),
    ).toThrow('unresolved slide relationship');
  });

  it('omits images once the cumulative image budget is spent', () => {
    const oversized = parsePptxPresentation(
      buffer(
        buildPptxFixture({
          imageBytes: new Uint8Array(PPTX_PREVIEW_MAX_IMAGE_BYTES / 2 + 1),
          imageReferences: 2,
        }),
      ),
    );
    const images = (oversized.slides[0]?.elements ?? []).filter(
      (element) => element.kind === 'image',
    );
    expect(images).toHaveLength(2);
    expect(images[0]?.kind === 'image' ? images[0].src : undefined).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(images[1]).toMatchObject({ kind: 'image', alt: 'Ticket trend' });
    expect(
      images[1]?.kind === 'image' ? images[1].src : 'present',
    ).toBeUndefined();
  });

  it.each([
    ['a DOCX package', buildReg2902DocxFixture()],
    ['an arbitrary zip', buildStoredZip([{ name: 'a.txt', data: 'a' }])],
    ['a macro-enabled deck', buildPptxFixture({ macro: true })],
  ])('rejects %s', (_label, bytes) => {
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow();
  });

  it('rejects presentation parts that declare a DTD', () => {
    const bytes = buildStoredZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: '_rels/.rels', data: '<Relationships/>' },
      {
        name: 'ppt/presentation.xml',
        data: '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x "x">]><p:presentation xmlns:p="urn:p"/>',
      },
    ]);
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow('DTD');
  });
});
