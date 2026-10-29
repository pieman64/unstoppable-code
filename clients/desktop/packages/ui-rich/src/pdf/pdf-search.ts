export interface PdfSearchMatchFragment {
  readonly itemIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PdfSearchMatch {
  readonly pageIndex: number;
  readonly fragments: readonly PdfSearchMatchFragment[];
}

export interface PdfSearchTextItem {
  readonly text: string;
  readonly hasEOL: boolean;
}

interface NormalizedCharacterSource {
  readonly itemIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

function normalizeText(value: string): string {
  let normalized = '';
  for (const character of value) {
    normalized += character.toLocaleLowerCase('en-US');
  }
  return normalized;
}

export function findPdfSearchMatches(
  pageIndex: number,
  items: readonly PdfSearchTextItem[],
  query: string,
): PdfSearchMatch[] {
  const normalized = normalizeText(query.trim());
  if (normalized.length === 0) return [];
  let pageText = '';
  const sourceByCharacter: Array<NormalizedCharacterSource | null> = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (!item) continue;
    let originalOffset = 0;
    for (const character of item.text) {
      const normalizedCharacter = normalizeText(character);
      const endOffset = originalOffset + character.length;
      pageText += normalizedCharacter;
      for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
        sourceByCharacter.push({
          itemIndex,
          startOffset: originalOffset,
          endOffset,
        });
      }
      originalOffset = endOffset;
    }
    if (item.hasEOL) {
      pageText += ' ';
      sourceByCharacter.push(null);
    }
  }
  const matches: PdfSearchMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= pageText.length - normalized.length) {
    const matchStart = pageText.indexOf(normalized, searchFrom);
    if (matchStart < 0) break;
    const fragments: PdfSearchMatchFragment[] = [];
    for (
      let characterIndex = matchStart;
      characterIndex < matchStart + normalized.length;
      characterIndex += 1
    ) {
      const source = sourceByCharacter[characterIndex];
      if (!source) continue;
      const previous = fragments[fragments.length - 1];
      if (
        previous?.itemIndex === source.itemIndex &&
        source.startOffset <= previous.endOffset
      ) {
        fragments[fragments.length - 1] = {
          ...previous,
          endOffset: Math.max(previous.endOffset, source.endOffset),
        };
      } else {
        fragments.push({ ...source });
      }
    }
    matches.push({ pageIndex, fragments });
    searchFrom = matchStart + 1;
  }
  return matches;
}

export function nextPdfSearchMatchIndex(
  currentIndex: number,
  matchCount: number,
  direction: 1 | -1,
): number {
  if (matchCount === 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : matchCount - 1;
  return (currentIndex + direction + matchCount) % matchCount;
}

function defaultYieldBetweenPages(): Promise<void> {
  if (typeof requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function searchPdfPagesIncrementally(args: {
  readonly pageCount: number;
  readonly query: string;
  readonly getPageItems: (
    pageIndex: number,
  ) => Promise<readonly PdfSearchTextItem[]>;
  readonly isCurrent: () => boolean;
  readonly yieldBetweenPages?: () => Promise<void>;
}): Promise<PdfSearchMatch[] | null> {
  const matches: PdfSearchMatch[] = [];
  const yieldBetweenPages = args.yieldBetweenPages ?? defaultYieldBetweenPages;
  for (let pageIndex = 0; pageIndex < args.pageCount; pageIndex += 1) {
    if (!args.isCurrent()) return null;
    const items = await args.getPageItems(pageIndex);
    if (!args.isCurrent()) return null;
    matches.push(...findPdfSearchMatches(pageIndex, items, args.query));
    await yieldBetweenPages();
    if (!args.isCurrent()) return null;
  }
  return matches;
}
