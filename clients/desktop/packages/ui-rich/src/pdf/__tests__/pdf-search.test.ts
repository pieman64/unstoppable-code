import {
  findPdfSearchMatches,
  nextPdfSearchMatchIndex,
  searchPdfPagesIncrementally,
  type PdfSearchTextItem,
} from '../pdf-search';

function textItems(...texts: string[]): PdfSearchTextItem[] {
  return texts.map((text) => ({ text, hasEOL: false }));
}

describe('PDF search', () => {
  it('returns stable item-level matches with case-insensitive text', () => {
    expect(
      findPdfSearchMatches(
        2,
        textItems('Alpha', 'beta alpha', 'other'),
        'ALPHA',
      ),
    ).toEqual([
      {
        pageIndex: 2,
        fragments: [{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
      },
      {
        pageIndex: 2,
        fragments: [{ itemIndex: 1, startOffset: 5, endOffset: 10 }],
      },
    ]);
  });

  it('keeps case-insensitive matches stable when the host locale is Turkish', () => {
    // Stored before spying so the replacement can delegate to the native
    // implementation with an explicit receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalLowerCase = String.prototype.toLocaleLowerCase;
    const lowerCaseSpy = jest
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(function (
        this: string,
        locales?: Intl.LocalesArgument,
      ): string {
        return originalLowerCase.call(String(this), locales ?? 'tr-TR');
      });
    try {
      expect(
        findPdfSearchMatches(0, textItems('IDENTIFIER'), 'identifier'),
      ).toEqual([
        {
          pageIndex: 0,
          fragments: [{ itemIndex: 0, startOffset: 0, endOffset: 10 }],
        },
      ]);
    } finally {
      lowerCaseSpy.mockRestore();
    }
  });

  it('returns every repeated occurrence within one PDF text item', () => {
    expect(findPdfSearchMatches(1, textItems('alpha alpha'), 'alpha')).toEqual([
      {
        pageIndex: 1,
        fragments: [{ itemIndex: 0, startOffset: 0, endOffset: 5 }],
      },
      {
        pageIndex: 1,
        fragments: [{ itemIndex: 0, startOffset: 6, endOffset: 11 }],
      },
    ]);
  });

  it('finds occurrences split across adjacent PDF text items', () => {
    expect(
      findPdfSearchMatches(
        3,
        textItems('hello ', 'world hello', ' world'),
        'hello world',
      ),
    ).toEqual([
      {
        pageIndex: 3,
        fragments: [
          { itemIndex: 0, startOffset: 0, endOffset: 6 },
          { itemIndex: 1, startOffset: 0, endOffset: 5 },
        ],
      },
      {
        pageIndex: 3,
        fragments: [
          { itemIndex: 1, startOffset: 6, endOffset: 11 },
          { itemIndex: 2, startOffset: 0, endOffset: 6 },
        ],
      },
    ]);
  });

  it('keeps exact ranges for overlapping matches', () => {
    expect(findPdfSearchMatches(0, textItems('aaa'), 'aa')).toEqual([
      {
        pageIndex: 0,
        fragments: [{ itemIndex: 0, startOffset: 0, endOffset: 2 }],
      },
      {
        pageIndex: 0,
        fragments: [{ itemIndex: 0, startOffset: 1, endOffset: 3 }],
      },
    ]);
  });

  it('treats PDF line endings as non-highlighted spaces', () => {
    const items: PdfSearchTextItem[] = [
      { text: 'foo', hasEOL: true },
      { text: 'bar', hasEOL: false },
    ];

    expect(findPdfSearchMatches(0, items, 'foobar')).toEqual([]);
    expect(findPdfSearchMatches(0, items, 'foo bar')).toEqual([
      {
        pageIndex: 0,
        fragments: [
          { itemIndex: 0, startOffset: 0, endOffset: 3 },
          { itemIndex: 1, startOffset: 0, endOffset: 3 },
        ],
      },
    ]);
  });

  it('wraps next and previous navigation', () => {
    expect(nextPdfSearchMatchIndex(2, 3, 1)).toBe(0);
    expect(nextPdfSearchMatchIndex(0, 3, -1)).toBe(2);
    expect(nextPdfSearchMatchIndex(-1, 3, 1)).toBe(0);
    expect(nextPdfSearchMatchIndex(0, 0, 1)).toBe(-1);
  });

  it('abandons a superseded incremental generation without a result update', async () => {
    let current = true;
    const getPageItems = jest.fn((pageIndex: number) =>
      Promise.resolve(textItems(`match page ${String(pageIndex)}`)),
    );
    const yieldBetweenPages = jest.fn(() => {
      current = false;
      return Promise.resolve();
    });

    await expect(
      searchPdfPagesIncrementally({
        pageCount: 500,
        query: 'match',
        getPageItems,
        isCurrent: () => current,
        yieldBetweenPages,
      }),
    ).resolves.toBeNull();
    expect(getPageItems).toHaveBeenCalledTimes(1);
  });
});
