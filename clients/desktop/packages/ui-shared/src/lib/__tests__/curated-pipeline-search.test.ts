import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
import {
  curatedPipelineFiltersActive,
  filterCuratedPipelines,
  filterCuratedPipelinesBySearch,
  sameCuratedPipelineFilters,
} from '../curated-pipeline-search';

function summary(
  key: string,
  name: string,
  shortDescription: string,
  overrides: Partial<CuratedPipelineSummary> = {},
): CuratedPipelineSummary {
  return {
    key,
    name,
    shortDescription,
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    jobCount: 1,
    stepCount: 1,
    contentHash: 'a'.repeat(64),
    contentSizeBytes: 1,
    categories: [],
    popular: false,
    sortOrder: 0,
    revision: 1,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    authorName: null,
    authorUrl: null,
    docsUrl: null,
    ...overrides,
  };
}

const ROWS = [
  summary('code-review', 'Code review', 'Flag issues before merging'),
  summary('release-checks', 'Release checks', 'Check readiness', {
    triggerTypes: ['plan_ready'],
    scopes: ['worktree'],
    categories: ['release'],
  }),
  summary('nightly', 'Daily summary', 'Summarize recent work'),
];

describe('filterCuratedPipelinesBySearch', () => {
  it('keeps every row in catalog order for an empty or blank search', () => {
    expect(filterCuratedPipelinesBySearch(ROWS, undefined)).toEqual(ROWS);
    expect(filterCuratedPipelinesBySearch(ROWS, '   ')).toEqual(ROWS);
  });

  it('matches the name, description or key case-insensitively', () => {
    const keys = (search: string): string[] =>
      filterCuratedPipelinesBySearch(ROWS, search).map((row) => row.key);
    expect(keys('CODE REVIEW')).toEqual(['code-review']);
    expect(keys('readiness')).toEqual(['release-checks']);
    expect(keys('nightly')).toEqual(['nightly']);
    expect(keys('e')).toEqual(['code-review', 'release-checks', 'nightly']);
    expect(keys('absent')).toEqual([]);
  });
});

describe('filterCuratedPipelines', () => {
  it('combines the search with category, trigger and scope', () => {
    expect(
      filterCuratedPipelines(ROWS, { q: 'check' }).map((row) => row.key),
    ).toEqual(['release-checks']);
    expect(
      filterCuratedPipelines(ROWS, { triggerType: 'dispatch' }).map(
        (row) => row.key,
      ),
    ).toEqual(['code-review', 'nightly']);
    expect(
      filterCuratedPipelines(ROWS, { scope: 'worktree', category: 'release' }),
    ).toEqual([ROWS[1]]);
    expect(filterCuratedPipelines(ROWS, { category: 'other' })).toEqual([]);
  });
});

describe('curated pipeline query comparison', () => {
  it('treats only a search or filter as active', () => {
    expect(curatedPipelineFiltersActive({ limit: 25 })).toBe(false);
    expect(curatedPipelineFiltersActive({ q: '  ' })).toBe(false);
    expect(curatedPipelineFiltersActive({ q: 'x' })).toBe(true);
    expect(curatedPipelineFiltersActive({ scope: 'worktree' })).toBe(true);
  });

  it('ignores page size and cursor when comparing queries', () => {
    expect(
      sameCuratedPipelineFilters({ limit: 25 }, { cursor: 'next', limit: 100 }),
    ).toBe(true);
    expect(sameCuratedPipelineFilters({ q: 'a ' }, { q: 'a' })).toBe(true);
    expect(sameCuratedPipelineFilters({ q: 'a' }, { q: 'b' })).toBe(false);
    expect(sameCuratedPipelineFilters({ triggerType: 'dispatch' }, {})).toBe(
      false,
    );
  });
});
