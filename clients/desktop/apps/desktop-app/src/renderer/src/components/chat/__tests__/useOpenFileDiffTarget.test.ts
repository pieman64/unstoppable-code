import type {
  ActivityChangedFilesResponse,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import {
  getChangedFileSources,
  matchChangedFileForPath,
} from '../useOpenFileDiffTarget';

function file(overrides: Partial<ChangedFileInfo>): ChangedFileInfo {
  return {
    path: 'src/app.ts',
    status: 'modified',
    insertions: 1,
    deletions: 0,
    ...overrides,
  };
}

function response(
  overrides: Partial<ActivityChangedFilesResponse>,
): ActivityChangedFilesResponse {
  return { uncommitted: [], committed: [], ...overrides };
}

describe('matchChangedFileForPath', () => {
  it('matches an uncommitted single-repo file by absolute path', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, '/work/tree'],
    ]);
    const changed = response({ uncommitted: [file({ path: 'src/app.ts' })] });

    expect(
      matchChangedFileForPath(changed, roots, '/work/tree/src/app.ts'),
    ).toEqual({ file: changed.uncommitted[0], source: 'uncommitted' });
  });

  it('returns null when the open file is not in the changed list', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, '/work/tree'],
    ]);
    const changed = response({ uncommitted: [file({ path: 'src/app.ts' })] });

    expect(
      matchChangedFileForPath(changed, roots, '/work/tree/src/other.ts'),
    ).toBeNull();
  });

  it('prefers an uncommitted match over a committed one for the same path', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, '/work/tree'],
    ]);
    const changed = response({
      uncommitted: [file({ path: 'src/app.ts', insertions: 5 })],
      committed: [file({ path: 'src/app.ts', insertions: 9 })],
    });

    expect(
      matchChangedFileForPath(changed, roots, '/work/tree/src/app.ts'),
    ).toEqual({ file: changed.uncommitted[0], source: 'uncommitted' });
  });

  it('falls back to a committed match when there is no uncommitted one', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, '/work/tree'],
    ]);
    const changed = response({
      committed: [file({ path: 'src/app.ts' })],
    });

    expect(
      matchChangedFileForPath(changed, roots, '/work/tree/src/app.ts'),
    ).toEqual({ file: changed.committed[0], source: 'committed' });
  });

  it('disambiguates identical relative paths across repos by root', () => {
    const roots = new Map<string | undefined, string>([
      ['repo-a', '/work/tree/repos/repo-a'],
      ['repo-b', '/work/tree/repos/repo-b'],
    ]);
    const changed = response({
      uncommitted: [
        file({ path: 'src/index.ts', repoId: 'repo-a' }),
        file({ path: 'src/index.ts', repoId: 'repo-b' }),
      ],
    });

    expect(
      matchChangedFileForPath(
        changed,
        roots,
        '/work/tree/repos/repo-b/src/index.ts',
      ),
    ).toEqual({ file: changed.uncommitted[1], source: 'uncommitted' });
  });

  it('matches when the open path uses Windows separators', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, 'C:\\work\\tree'],
    ]);
    const changed = response({ uncommitted: [file({ path: 'src/app.ts' })] });

    expect(
      matchChangedFileForPath(changed, roots, 'C:\\work\\tree\\src\\app.ts'),
    ).toEqual({ file: changed.uncommitted[0], source: 'uncommitted' });
  });

  it('matches Windows drive paths case-insensitively', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, 'C:\\Work\\Tree'],
    ]);
    const changed = response({
      uncommitted: [file({ path: 'Src/App.ts' })],
    });

    expect(
      matchChangedFileForPath(changed, roots, 'c:\\work\\tree\\src\\app.ts'),
    ).toEqual({ file: changed.uncommitted[0], source: 'uncommitted' });
  });

  it('matches Windows UNC paths case-insensitively', () => {
    const roots = new Map<string | undefined, string>([
      [undefined, '\\\\Server\\Share\\Worktree'],
    ]);
    const changed = response({
      uncommitted: [file({ path: 'Src/App.ts' })],
    });

    expect(
      matchChangedFileForPath(
        changed,
        roots,
        '\\\\server\\share\\worktree\\src\\app.ts',
      ),
    ).toEqual({ file: changed.uncommitted[0], source: 'uncommitted' });
  });

  it('ignores changed files whose repo root could not be resolved', () => {
    const roots = new Map<string | undefined, string>();
    const changed = response({
      uncommitted: [file({ path: 'src/app.ts', repoId: 'repo-a' })],
    });

    expect(
      matchChangedFileForPath(
        changed,
        roots,
        '/work/tree/repos/repo-a/src/app.ts',
      ),
    ).toBeNull();
  });
});

describe('getChangedFileSources', () => {
  it('only includes sources for this path in its owning repository', () => {
    const target = file({ repoId: 'repo-a' });
    const changes = response({
      uncommitted: [target],
      committed: [
        file({ repoId: 'repo-b' }),
        file({ repoId: 'repo-a', path: 'other.ts' }),
      ],
    });
    expect(getChangedFileSources(changes, target)).toEqual(['uncommitted']);
    changes.committed.push(target);
    expect(getChangedFileSources(changes, target)).toEqual([
      'uncommitted',
      'committed',
    ]);
    changes.uncommitted = [];
    expect(getChangedFileSources(changes, target)).toEqual(['committed']);
    changes.committed = [];
    expect(getChangedFileSources(changes, target)).toEqual([]);
  });
});
