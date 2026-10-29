import { DOMParser } from '@xmldom/xmldom';
import { buildPptxFixture } from '../../../test/ooxml-fixtures.js';
import { buildPptxBudgetFixture } from '../../../test/pptx-budget-fixtures.js';
import type { OfficeParseResponse } from '../office-parse';
import { parsePptxPresentation } from '../pptx-parse';
import { parseXmlPart } from '../pptx-xml';
import { installOfficeParseWorker, type OfficeWorkerScope } from '../worker';

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe('PPTX nested preview budgets', () => {
  it('rejects numeric XML values that could make Roman numbering unbounded', () => {
    // A million takes only 1,000 iterations in the unchanged parser, keeping
    // the red test finite while exercising the same missing range check as
    // Number.MAX_SAFE_INTEGER (trillions of iterations).
    const bytes = buildPptxBudgetFixture({ numberingStartAt: 1_000_001 });
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(
      /numbering.*budget/i,
    );
  });

  it.each([
    ['table cells', { tableCells: 5_000 }],
    ['merged cell slots', { tableCells: 12_000, mergedCells: true }],
    ['table rows', { tableCells: 1, tableRows: 6_000, mergedCells: true }],
    ['table columns', { tableCells: 1, tableColumns: 6_000 }],
    ['paragraphs', { paragraphs: 6_000 }],
    ['runs in a single paragraph', { runsPerParagraph: 12_000 }],
    ['speaker notes', { notesParagraphs: 10_001 }],
  ])(
    'rejects a slide with excessive %s before returning a model',
    (_name, options) => {
      const bytes = buildPptxBudgetFixture(options);
      // All fixtures fit the existing byte cap; source bytes cannot bound the
      // number of nested nodes sent to the renderer.
      expect(bytes.byteLength).toBeLessThan(8 * 1024 * 1024);
      expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/budget/i);
    },
  );

  it('shares the retained-node budget across independently bounded slides', () => {
    const bytes = buildPptxBudgetFixture({ slideCount: 6, paragraphs: 2_000 });
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/budget/i);
  });

  it('shares the slide budget between text and notes', () => {
    const bytes = buildPptxBudgetFixture({
      paragraphs: 1_200,
      notesParagraphs: 3_000,
    });
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/node.*budget/i);
  });

  it('charges inherited master text each time it is retained on another slide', () => {
    const bytes = buildPptxBudgetFixture({
      slideCount: 6,
      masterParagraphs: 2_000,
    });
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/budget/i);
  });

  it('keeps a reasonable rich table available', () => {
    const result = parsePptxPresentation(
      buffer(
        buildPptxBudgetFixture({
          tableCells: 100,
          paragraphs: 3,
          runsPerParagraph: 2,
        }),
      ),
    );
    const table = result.slides[0]?.elements.find(
      (element) => element.kind === 'table',
    );
    expect(
      table?.kind === 'table' ? table.rows[0]?.cells : undefined,
    ).toHaveLength(100);
  });

  it('bounds repeated master text before constructing an oversized deck output', () => {
    const bytes = buildPptxBudgetFixture({
      slideCount: 5,
      paragraphs: 0,
      masterParagraphs: 1,
      textChars: 2 * 1024 * 1024,
    });
    expect(bytes.byteLength).toBeLessThan(8 * 1024 * 1024);
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/text.*budget/i);
  });

  it('charges inherited font family text on line break runs', () => {
    const bytes = buildPptxBudgetFixture({
      fontFamilyChars: 2 * 1024 * 1024,
      lineBreaks: 6,
    });
    expect(bytes.byteLength).toBeLessThan(8 * 1024 * 1024);
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(/text.*budget/i);
  });

  it('keeps an ordinary multi-slide rich deck available', () => {
    const result = parsePptxPresentation(
      buffer(
        buildPptxBudgetFixture({
          slideCount: 10,
          tableCells: 100,
          paragraphs: 3,
          runsPerParagraph: 2,
          notesParagraphs: 10,
        }),
      ),
    );
    expect(result.slides).toHaveLength(10);
    expect(result.slides.every((slide) => slide.notes.length === 10)).toBe(
      true,
    );
    expect(result.slides.every((slide) => !slide.elementsTruncated)).toBe(true);
  });

  it('fails closed in the worker and can parse a normal deck afterward', async () => {
    const responses: OfficeParseResponse[] = [];
    const scope: OfficeWorkerScope = {
      onmessage: null,
      postMessage: (message): void => {
        responses.push(message);
      },
    };
    installOfficeParseWorker(scope);
    scope.onmessage?.(
      new MessageEvent('message', {
        data: {
          kind: 'pptx',
          bytes: buffer(buildPptxBudgetFixture({ tableCells: 5_000 })),
        },
      }),
    );
    await Promise.resolve();
    const failed = responses[0];
    expect(failed?.ok).toBe(false);
    if (!failed || failed.ok) throw new Error('Expected a budget failure.');
    expect(failed.error).toMatch(/budget/i);
    scope.onmessage?.(
      new MessageEvent('message', {
        data: { kind: 'pptx', bytes: buffer(buildPptxFixture()) },
      }),
    );
    await Promise.resolve();
    expect(responses[1]).toMatchObject({ ok: true, result: { kind: 'pptx' } });
  });
});

describe('PPTX source structure admission', () => {
  it('counts self-closing elements at the XML depth boundary', () => {
    const atLimit = `${'<nested>'.repeat(127)}<leaf/>${'</nested>'.repeat(127)}`;
    expect(parseXmlPart(new TextEncoder().encode(atLimit)).localName).toBe(
      'nested',
    );
    const overLimit = `<root>${atLimit}</root>`;
    expect(() => parseXmlPart(new TextEncoder().encode(overLimit))).toThrow(
      /depth.*budget/i,
    );
  });

  it('accepts shallow XML with comments, CDATA, processing instructions and quoted delimiters', () => {
    const nestedText = '<nested>'.repeat(257);
    const text = `<?xml version="1.0"?><root value=">literal"><!--${nestedText}--><?info ${nestedText}?><![CDATA[${nestedText}]]><leaf/></root>`;
    const root = parseXmlPart(new TextEncoder().encode(text));
    expect(root.localName).toBe('root');
    expect(root.getAttribute('value')).toBe('>literal');
    expect(root.textContent).toContain(nestedText);
  });

  it('rejects dense source XML before invoking xmldom', () => {
    const parse = jest.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      expect(() =>
        parseXmlPart(
          new TextEncoder().encode(
            `<root>${'<unused/>'.repeat(100_001)}</root>`,
          ),
        ),
      ).toThrow(/structure.*budget/i);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('shares source admission across cached parts even for ignored content', () => {
    const bytes = buildPptxBudgetFixture({ slideCount: 4, inertNodes: 60_000 });
    expect(() => parsePptxPresentation(buffer(bytes))).toThrow(
      /structure.*budget/i,
    );
  });

  it('rejects excessive XML nesting before recursive text collection', () => {
    const parse = jest.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      const text = `${'<nested>'.repeat(257)}<t>text</t>${'</nested>'.repeat(257)}`;
      expect(() => parseXmlPart(new TextEncoder().encode(text))).toThrow(
        /depth.*budget/i,
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
