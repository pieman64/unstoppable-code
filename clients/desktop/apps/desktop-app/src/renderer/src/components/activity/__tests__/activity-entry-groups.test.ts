import {
  buildRepoGroupedRows,
  toggleStringInSet,
} from '../activity-entry-groups';

interface FakeEntry {
  id: string;
  repoId?: string;
  repoName?: string;
  scoped: boolean;
}

const isRepoScoped = (entry: FakeEntry): boolean => entry.scoped;
const getRepoId = (entry: FakeEntry): string | undefined => entry.repoId;
const getRepoName = (entry: FakeEntry): string | undefined => entry.repoName;

describe('buildRepoGroupedRows', () => {
  it('passes through non-repo-scoped entries as plain rows', () => {
    const entries: FakeEntry[] = [
      { id: 'a', scoped: false },
      { id: 'b', scoped: false },
    ];

    const rows = buildRepoGroupedRows({
      entries,
      isRepoScoped,
      getRepoId,
      getRepoName,
    });

    expect(rows).toEqual([
      { kind: 'entry', entry: entries[0] },
      { kind: 'entry', entry: entries[1] },
    ]);
  });

  it('coalesces repo-scoped entries into a repo group preserving first-seen order', () => {
    const entries: FakeEntry[] = [
      { id: 'a', scoped: true, repoId: 'repo-1', repoName: 'Repo One' },
      { id: 'b', scoped: false },
      { id: 'c', scoped: true, repoId: 'repo-1', repoName: 'Repo One' },
      { id: 'd', scoped: true, repoId: 'repo-2', repoName: 'Repo Two' },
    ];

    const rows = buildRepoGroupedRows({
      entries,
      isRepoScoped,
      getRepoId,
      getRepoName,
    });

    expect(rows).toEqual([
      {
        kind: 'repo-group',
        group: {
          repoId: 'repo-1',
          repoName: 'Repo One',
          entries: [entries[0], entries[2]],
        },
      },
      { kind: 'entry', entry: entries[1] },
      // repo-2 only has one entry — flattens back to a plain row.
      { kind: 'entry', entry: entries[3] },
    ]);
  });

  it('falls back to repoId when getRepoName returns undefined', () => {
    const entries: FakeEntry[] = [
      { id: 'a', scoped: true, repoId: 'repo-1' },
      { id: 'b', scoped: true, repoId: 'repo-1' },
    ];

    const rows = buildRepoGroupedRows({
      entries,
      isRepoScoped,
      getRepoId,
      getRepoName,
    });

    expect(rows).toEqual([
      {
        kind: 'repo-group',
        group: {
          repoId: 'repo-1',
          repoName: 'repo-1',
          entries,
        },
      },
    ]);
  });

  it('flattens single-entry repo groups back to plain entries', () => {
    const entries: FakeEntry[] = [
      { id: 'a', scoped: true, repoId: 'repo-1', repoName: 'Repo One' },
    ];

    const rows = buildRepoGroupedRows({
      entries,
      isRepoScoped,
      getRepoId,
      getRepoName,
    });

    expect(rows).toEqual([{ kind: 'entry', entry: entries[0] }]);
  });

  it('treats repo-scoped entries with no repoId as ungrouped rows', () => {
    const entries: FakeEntry[] = [
      { id: 'a', scoped: true, repoName: 'Repo One' },
      { id: 'b', scoped: true, repoName: 'Repo One' },
    ];

    const rows = buildRepoGroupedRows({
      entries,
      isRepoScoped,
      getRepoId,
      getRepoName,
    });

    expect(rows).toEqual([
      { kind: 'entry', entry: entries[0] },
      { kind: 'entry', entry: entries[1] },
    ]);
  });
});

describe('toggleStringInSet', () => {
  it('adds the value when previously absent', () => {
    const previous = new Set<string>(['a']);

    const next = toggleStringInSet(previous, 'b');

    expect(next).toEqual(new Set(['a', 'b']));
    expect(previous).toEqual(new Set(['a']));
  });

  it('removes the value when previously present', () => {
    const previous = new Set<string>(['a', 'b']);

    const next = toggleStringInSet(previous, 'a');

    expect(next).toEqual(new Set(['b']));
    expect(previous).toEqual(new Set(['a', 'b']));
  });

  it('returns a new Set instance', () => {
    const previous = new Set<string>();

    const next = toggleStringInSet(previous, 'a');

    expect(next).not.toBe(previous);
  });
});
