import type { WorktreeSummaryData } from '../../types';
import { worktreeSummaryContentHash } from '../worktree-summary-hash';

function makeSummary(
  overrides: Partial<WorktreeSummaryData> = {},
): WorktreeSummaryData {
  return {
    title: 'Title',
    description: 'Description',
    highlights: ['One', 'Two'],
    generatedAt: '2026-06-16T00:00:00.000Z',
    turnCountAtGeneration: 3,
    lastFullRefreshAt: '2026-06-16T00:00:00.000Z',
    lastFullRefreshTurnCount: 3,
    ...overrides,
  };
}

describe('worktreeSummaryContentHash', () => {
  it('is stable for identical narrative content', () => {
    expect(worktreeSummaryContentHash(makeSummary())).toBe(
      worktreeSummaryContentHash(makeSummary()),
    );
  });

  it('ignores volatile bookkeeping fields (generatedAt, turn counters)', () => {
    const a = makeSummary();
    const b = makeSummary({
      generatedAt: '2026-06-16T09:00:00.000Z',
      turnCountAtGeneration: 42,
      lastFullRefreshAt: '2026-06-16T09:00:00.000Z',
      lastFullRefreshTurnCount: 42,
    });
    expect(worktreeSummaryContentHash(a)).toBe(worktreeSummaryContentHash(b));
  });

  it('changes when the title, description, highlights, or repos change', () => {
    const base = worktreeSummaryContentHash(makeSummary());
    expect(
      worktreeSummaryContentHash(makeSummary({ title: 'Other' })),
    ).not.toBe(base);
    expect(
      worktreeSummaryContentHash(makeSummary({ description: 'Other' })),
    ).not.toBe(base);
    expect(
      worktreeSummaryContentHash(makeSummary({ highlights: ['One'] })),
    ).not.toBe(base);
    expect(
      worktreeSummaryContentHash(
        makeSummary({ repos: [{ name: 'api', description: 'x' }] }),
      ),
    ).not.toBe(base);
  });

  it('treats a missing repos list as an empty list', () => {
    expect(worktreeSummaryContentHash(makeSummary({ repos: undefined }))).toBe(
      worktreeSummaryContentHash(makeSummary({ repos: [] })),
    );
  });

  it('ignores surrounding whitespace on hashed fields', () => {
    expect(
      worktreeSummaryContentHash(makeSummary({ title: '  Title  ' })),
    ).toBe(worktreeSummaryContentHash(makeSummary({ title: 'Title' })));
  });
});
