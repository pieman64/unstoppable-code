import type { ExternalProjectCandidate } from '@canopy/desktop-shared/types';
import {
  bulkSelection,
  isCurrentSelection,
  orderPickedGroups,
  pickedSummary,
  reconcileSelection,
  selectExclusive,
  type PickedSummary,
} from '../pickedFolders';

function candidate(
  id: string,
  overrides: Partial<ExternalProjectCandidate> = {},
): ExternalProjectCandidate {
  return {
    id,
    providers: [],
    surfaces: ['nested-repository'],
    displayName: id,
    rootPath: `/Users/me/${id}`,
    kind: 'git',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: null,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
    ...overrides,
  };
}

function folder(
  id: string,
  count: number,
  complete = true,
): ExternalProjectCandidate {
  return candidate(id, {
    kind: 'folder',
    surfaces: ['custom-folder'],
    nestedRepositories: { count, complete },
  });
}

function repos(parentIds: string[], count: number): ExternalProjectCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    candidate(`${parentIds[0]}-repo-${String(index).padStart(2, '0')}`, {
      rootPath: `/Users/me/${parentIds[0]}/repo-${String(index).padStart(2, '0')}`,
      parentCandidateIds: parentIds,
    }),
  );
}

function text(summary: PickedSummary | null): string[] {
  if (!summary) return [];
  return [
    ...summary.lines.map(
      (line) => `${line.lead}${line.name ?? ''}${line.tail}`,
    ),
    ...summary.notes,
  ];
}

function summarize(candidates: ExternalProjectCandidate[]): string[] {
  const shown = new Set(
    candidates.filter((c) => c.status === 'available').map((c) => c.id),
  );
  return text(pickedSummary(candidates, shown));
}

describe('pickedSummary', () => {
  it('returns nothing without a pick', () => {
    expect(pickedSummary([candidate('a')], new Set(['a']))).toBeNull();
  });

  it('uses singular and plural wording', () => {
    expect(summarize([folder('one', 1), ...repos(['one'], 1)])).toEqual([
      'Found 1 repository in one',
    ]);
    expect(summarize([folder('box', 3), ...repos(['box'], 3)])).toEqual([
      'Found 3 repositories in box',
    ]);
  });

  it('reports a capped result with guidance', () => {
    expect(summarize([folder('big', 37), ...repos(['big'], 20)])).toEqual([
      'Showing 20 of 37 repositories in big',
      'Choose a repository folder directly to import one that is not listed',
    ]);
  });

  it('marks an incomplete count as a lower bound', () => {
    expect(
      summarize([folder('part', 12, false), ...repos(['part'], 12)]),
    ).toEqual([
      'Found 12 or more repositories in part',
      'Could not finish checking for repositories',
    ]);
    expect(
      summarize([folder('part', 37, false), ...repos(['part'], 20)]),
    ).toEqual([
      'Showing 20 of 37 or more repositories in part',
      'Could not finish checking for repositories',
      'Choose a repository folder directly to import one that is not listed',
    ]);
  });

  it('keeps the summary when no repository can be added', () => {
    const tracked = repos(['done'], 2).map((repo) => ({
      ...repo,
      status: 'already-tracked' as const,
    }));
    expect(summarize([folder('done', 2), ...tracked])).toEqual([
      'Found 2 repositories in done · 2 already added',
    ]);
  });

  it('counts plain picks apart from repositories found', () => {
    expect(summarize([folder('empty', 0)])).toEqual(['You chose 1 folder']);
    expect(
      summarize([
        folder('box', 3),
        ...repos(['box'], 3),
        folder('empty', 0),
        folder('unsure', 0, false),
        candidate('picked-repo', { surfaces: ['custom-folder'] }),
      ]),
    ).toEqual([
      'Found 3 repositories in box',
      'You also chose 3 folders',
      'Could not finish checking for repositories',
    ]);
  });
});

describe('selection rules', () => {
  const parent = folder('box', 2);
  const [first, second] = repos(['box'], 2);
  if (!first || !second) throw new Error('fixture');
  const all = [parent, first, second];

  it('drops a folder when one of its repositories is chosen, and back', () => {
    const withParent = selectExclusive(new Set(), parent.id, all);
    expect(selectExclusive(withParent, first.id, all)).toEqual(
      new Set([first.id]),
    );
    expect(
      selectExclusive(new Set([first.id, second.id]), parent.id, all),
    ).toEqual(new Set([parent.id]));
  });

  it('excludes folders holding repositories from Select all', () => {
    expect(bulkSelection(all)).toEqual(new Set([first.id, second.id]));
  });

  it('keeps repositories over their folder when reconciling', () => {
    expect(reconcileSelection([parent.id, first.id], all, () => true)).toEqual(
      new Set([first.id]),
    );
  });

  it('rejects stale, unavailable and conflicting submissions rather than accepting a subset', () => {
    expect(isCurrentSelection(new Set(['gone']), all, () => true)).toBe(false);
    expect(
      isCurrentSelection(new Set([parent.id, first.id]), all, () => true),
    ).toBe(false);
    expect(isCurrentSelection(new Set([first.id]), all, () => false)).toBe(
      false,
    );
    expect(isCurrentSelection(new Set([first.id]), all, () => true)).toBe(true);
  });

  it('clears every related parent, including one outside the repository family path', () => {
    const otherParent = folder('other', 1);
    const shared = candidate('family', {
      rootPath: '/Users/me/elsewhere',
      parentCandidateIds: [parent.id, otherParent.id],
    });
    expect(
      selectExclusive(new Set([parent.id, otherParent.id]), shared.id, [
        ...all,
        otherParent,
        shared,
      ]),
    ).toEqual(new Set([shared.id]));
  });

  it('treats overlapping picked folders as exclusive', () => {
    const outer = folder('outer', 0);
    const inner = candidate('inner', {
      kind: 'folder',
      surfaces: ['custom-folder'],
      rootPath: '/Users/me/outer/inner',
      nestedRepositories: { count: 0, complete: true },
    });
    expect(bulkSelection([outer, inner])).toEqual(new Set([outer.id]));
  });

  it('excludes directly picked contained repositories even without scan relationships', () => {
    const outer = folder('outer', 0, false);
    const deep = candidate('deep', {
      surfaces: ['custom-folder'],
      rootPath: '/Users/me/outer/one/two/deep',
    });
    expect(
      selectExclusive(new Set([outer.id]), deep.id, [outer, deep]),
    ).toEqual(new Set([deep.id]));
    expect(
      selectExclusive(new Set([deep.id]), outer.id, [outer, deep]),
    ).toEqual(new Set([outer.id]));
  });
});

describe('orderPickedGroups', () => {
  const byName = (
    a: ExternalProjectCandidate,
    b: ExternalProjectCandidate,
  ): number => a.displayName.localeCompare(b.displayName);

  it('shows a repository under several folders once, in the first by path', () => {
    const a = folder('a', 1);
    const b = folder('b', 1);
    const shared = candidate('shared', {
      displayName: 'shared',
      parentCandidateIds: ['a', 'b'],
    });
    const other = candidate('other', { surfaces: ['claude-code'] });
    expect(
      orderPickedGroups([other, b, shared, a], byName).map((c) => c.id),
    ).toEqual(['shared', 'a', 'b', 'other']);
  });

  it('shows a repository normally when its folder is not listed', () => {
    const orphan = candidate('orphan', { parentCandidateIds: ['gone'] });
    expect(orderPickedGroups([orphan], byName).map((c) => c.id)).toEqual([
      'orphan',
    ]);
  });
});
