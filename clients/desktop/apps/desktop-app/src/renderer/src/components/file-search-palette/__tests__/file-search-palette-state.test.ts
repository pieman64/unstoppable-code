import { shouldFetchFileSearchPaletteEntry } from '../file-search-palette-state';

describe('shouldFetchFileSearchPaletteEntry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns true when no data has been loaded yet', () => {
    expect(shouldFetchFileSearchPaletteEntry(undefined, false, undefined)).toBe(
      true,
    );
  });

  it('returns false when a fetch is already in progress', () => {
    expect(shouldFetchFileSearchPaletteEntry(undefined, true, undefined)).toBe(
      false,
    );
  });

  it('returns false when cached data is still fresh', () => {
    expect(
      shouldFetchFileSearchPaletteEntry(
        {
          data: { repos: [] },
          fetchedAt: Date.now(),
        },
        false,
        undefined,
      ),
    ).toBe(false);
  });

  it('returns true when cached data is stale', () => {
    expect(
      shouldFetchFileSearchPaletteEntry(
        {
          data: { repos: [] },
          fetchedAt: Date.now() - 61_000,
        },
        false,
        undefined,
      ),
    ).toBe(true);
  });

  it('returns false when the previous fetch failed', () => {
    expect(
      shouldFetchFileSearchPaletteEntry(undefined, false, 'Unable to load'),
    ).toBe(false);
  });
});
