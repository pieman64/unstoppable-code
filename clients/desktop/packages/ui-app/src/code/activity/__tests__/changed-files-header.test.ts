import {
  changedFilesHeaderHasContent,
  changedFilesHeaderSubtitle,
} from '../changed-files-header';

describe('changedFilesHeaderSubtitle', () => {
  it.each([
    [{ totalCount: 0 }, 'No local changes'],
    [{ totalCount: 1 }, '1 file'],
    [{ totalCount: 9 }, '9 files'],
    // A host filter (desktop's label filter) shows how many remain visible.
    [{ totalCount: 9, visibleCount: 3 }, '9 files (3)'],
    [{ totalCount: 9, visibleCount: 9 }, '9 files'],
    // An incomplete answer never reads as complete.
    [{ totalCount: 1, notices: [{ kind: 'truncated' as const }] }, '1+ files'],
    [
      {
        totalCount: 9,
        visibleCount: 3,
        notices: [{ kind: 'truncated' as const }],
      },
      '9+ files (3)',
    ],
    [{ totalCount: 0, notices: [{ kind: 'sleeping' as const }] }, 'Sleeping'],
    [
      { totalCount: 0, notices: [{ kind: 'unavailable' as const }] },
      'Unavailable',
    ],
    [
      { totalCount: 0, notices: [{ kind: 'base_unavailable' as const }] },
      'Unavailable',
    ],
    [
      { totalCount: 0, notices: [{ kind: 'truncated' as const }] },
      'Incomplete',
    ],
  ])('heads %j as %s', (input, expected) => {
    expect(changedFilesHeaderSubtitle(input)).toBe(expected);
  });
});

describe('changedFilesHeaderHasContent', () => {
  it('counts rows or a notice, never an empty complete answer', () => {
    expect(changedFilesHeaderHasContent({ totalCount: 0 })).toBe(false);
    expect(changedFilesHeaderHasContent({ totalCount: 2 })).toBe(true);
    expect(
      changedFilesHeaderHasContent({
        totalCount: 0,
        notices: [{ kind: 'sleeping' }],
      }),
    ).toBe(true);
  });
});
