import type { FileSearchResult } from '@/lib/fuzzySearch';
import {
  getFilenameMatchedIndices,
  splitMatchSegments,
} from '../file-search-palette-helpers';

function makeResult(
  overrides: Partial<FileSearchResult> = {},
): FileSearchResult {
  return {
    relativePath: 'src/components/Foo.tsx',
    filename: 'Foo.tsx',
    absolutePath: '/repo/src/components/Foo.tsx',
    repoId: 'main',
    repoName: 'main',
    rootKind: 'git-repo',
    isIgnored: false,
    score: 0,
    matchedIndices: [],
    ...overrides,
  };
}

describe('getFilenameMatchedIndices', () => {
  it('returns indices that fall within the filename portion, offset to filename', () => {
    // matched chars: 's' (0), 'F' (15), 'o' (16) — only F and o are in the filename
    const result = makeResult({
      matchedIndices: [0, 15, 16],
    });

    expect(getFilenameMatchedIndices(result)).toEqual([0, 1]);
  });

  it('returns an empty array when no matches fall in the filename', () => {
    const result = makeResult({
      matchedIndices: [0, 1, 2],
    });

    expect(getFilenameMatchedIndices(result)).toEqual([]);
  });

  it('handles a relativePath equal to the filename (no directory prefix)', () => {
    const result = makeResult({
      relativePath: 'README.md',
      filename: 'README.md',
      matchedIndices: [0, 7],
    });

    expect(getFilenameMatchedIndices(result)).toEqual([0, 7]);
  });
});

describe('splitMatchSegments', () => {
  it('returns an empty array for an empty string', () => {
    expect(splitMatchSegments('', [])).toEqual([]);
  });

  it('returns one non-highlighted segment when there are no matches', () => {
    expect(splitMatchSegments('hello', [])).toEqual([
      { text: 'hello', highlighted: false },
    ]);
  });

  it('groups contiguous matched characters into a single highlighted segment', () => {
    expect(splitMatchSegments('hello', [1, 2, 3])).toEqual([
      { text: 'h', highlighted: false },
      { text: 'ell', highlighted: true },
      { text: 'o', highlighted: false },
    ]);
  });

  it('handles non-contiguous matches', () => {
    expect(splitMatchSegments('foobar', [0, 2, 4])).toEqual([
      { text: 'f', highlighted: true },
      { text: 'o', highlighted: false },
      { text: 'o', highlighted: true },
      { text: 'b', highlighted: false },
      { text: 'a', highlighted: true },
      { text: 'r', highlighted: false },
    ]);
  });

  it('handles a fully matched string', () => {
    expect(splitMatchSegments('abc', [0, 1, 2])).toEqual([
      { text: 'abc', highlighted: true },
    ]);
  });
});
