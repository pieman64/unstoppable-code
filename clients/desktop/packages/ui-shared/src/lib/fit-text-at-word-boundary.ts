// Spaces a line may break at, including the typographic Zs spaces. No-break
// spaces (U+00A0, figure U+2007, narrow U+202F) are deliberately absent: they
// glue their neighbours into one word, as `\s` would not.
const BREAKABLE_SPACES = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2008',
  '\u2009',
  '\u200A',
  '\u205F',
  '\u3000',
]);

function isBreakableSpace(char: string): boolean {
  return BREAKABLE_SPACES.has(char);
}

/**
 * End index of the longest prefix of `text` that ends at a word boundary and
 * whose width fits `budget`; `null` when no whole word fits. A boundary is the
 * first space of each run, so punctuation stays with its word ("Aug 10.").
 * `measure(end)` returns the rendered width of `text.slice(0, end)` and must
 * grow with `end`. Whether the whole text fits is the caller's check.
 */
export function fitTextAtWordBoundary(
  text: string,
  budget: number,
  measure: (end: number) => number,
): number | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const ends: number[] = [];
  for (let index = 1; index < text.length; index += 1) {
    if (
      isBreakableSpace(text.charAt(index)) &&
      !isBreakableSpace(text.charAt(index - 1))
    ) {
      ends.push(index);
    }
  }
  let fitted: number | null = null;
  let low = 0;
  let high = ends.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = ends[middle];
    if (end === undefined) break;
    if (measure(end) <= budget) {
      fitted = end;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

/**
 * End index of `text` after its `maxWords`-th word, at the same boundary
 * `fitTextAtWordBoundary` uses; `null` when the text has no more words than
 * that, or `maxWords` is not a whole number of at least one.
 */
export function wordLimitEnd(text: string, maxWords: number): number | null {
  if (!Number.isSafeInteger(maxWords) || maxWords < 1) return null;
  let words = 0;
  let limit: number | null = null;
  for (let index = 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (limit !== null) {
      if (!isBreakableSpace(char)) return limit;
    } else if (
      isBreakableSpace(char) &&
      !isBreakableSpace(text.charAt(index - 1))
    ) {
      words += 1;
      if (words === maxWords) limit = index;
    }
  }
  return null;
}
