import {
  INITIAL_FACT_CORPUS_FILTERS,
  isDefaultFilters,
  isEmptyCorpus,
  type FactCorpusFilters,
} from '../fact-corpus-filters';

const EMPTY_PAGE = {
  facts: [],
  nextCursor: null,
  readWithDefaultFilters: true,
};

describe('isDefaultFilters', () => {
  it('is true for the initial state', () => {
    expect(isDefaultFilters(INITIAL_FACT_CORPUS_FILTERS)).toBe(true);
  });

  it.each<[string, Partial<FactCorpusFilters>]>([
    ['the retrieval preview mode', { mode: 'preview' }],
    ['typed search text', { query: 'deploy' }],
    ['a submitted search', { submittedQuery: 'deploy' }],
    ['an evidence type', { evidenceType: 'OBSERVED' }],
    ['another liveness', { liveness: 'all' }],
    ['a start date', { from: '2026-08-01' }],
    ['an end date', { to: '2026-08-31' }],
  ])('is false with %s', (_label, change) => {
    expect(
      isDefaultFilters({ ...INITIAL_FACT_CORPUS_FILTERS, ...change }),
    ).toBe(false);
  });
});

describe('isEmptyCorpus', () => {
  it('is true when the unfiltered first page is empty', () => {
    expect(isEmptyCorpus(INITIAL_FACT_CORPUS_FILTERS, EMPTY_PAGE)).toBe(true);
  });

  it('is false when a filter narrows the list', () => {
    expect(
      isEmptyCorpus(
        { ...INITIAL_FACT_CORPUS_FILTERS, liveness: 'superseded' },
        EMPTY_PAGE,
      ),
    ).toBe(false);
  });

  it('is false while the list still holds a filtered read', () => {
    expect(
      isEmptyCorpus(INITIAL_FACT_CORPUS_FILTERS, {
        ...EMPTY_PAGE,
        readWithDefaultFilters: false,
      }),
    ).toBe(false);
  });

  it('is false when the first page has facts or more pages follow', () => {
    expect(
      isEmptyCorpus(INITIAL_FACT_CORPUS_FILTERS, {
        ...EMPTY_PAGE,
        nextCursor: 'cursor-2',
      }),
    ).toBe(false);
  });
});
