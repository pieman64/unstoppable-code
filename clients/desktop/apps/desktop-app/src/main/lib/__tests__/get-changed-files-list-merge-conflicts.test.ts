import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChangedFilesList, revertUncommittedFile } from '../git';

// Each case drives dozens of real Git commands, which can outrun the default
// timeout on a loaded worker.
jest.setTimeout(60_000);

function runGit(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
}

async function createRepository(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'canopy-changed-files-'));
  runGit(repoPath, 'init', '--quiet', '--initial-branch=main');
  runGit(repoPath, 'config', 'user.name', 'Canopy Test');
  runGit(repoPath, 'config', 'user.email', 'canopy-test@example.invalid');
  runGit(repoPath, 'config', 'commit.gpgsign', 'false');
  runGit(repoPath, 'config', 'merge.conflictStyle', 'merge');
  return repoPath;
}

function commitAll(repoPath: string, message: string): void {
  runGit(repoPath, 'add', '--all');
  runGit(repoPath, 'commit', '--quiet', '-m', message);
}

function findFile(
  files: Awaited<ReturnType<typeof getChangedFilesList>>,
  path: string,
): Awaited<ReturnType<typeof getChangedFilesList>>[number] {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Changed file not found: ${path}`);
  return file;
}

describe('getChangedFilesList unmerged index entries', () => {
  it('marks merge conflicts unmerged without losing counts or other statuses', async () => {
    const repoPath = await createRepository();

    try {
      await writeFile(join(repoPath, 'content.txt'), 'base\n');
      await writeFile(join(repoPath, 'clean.txt'), 'first\nsecond\nthird\n');
      await writeFile(join(repoPath, 'café.txt'), 'base unicode\n');
      await writeFile(
        join(repoPath, 'binary.bin'),
        Buffer.from('base\0binary\n'),
      );
      await writeFile(
        join(repoPath, 'rename-source.txt'),
        'rename source\nsecond line\nthird line\n',
      );
      await writeFile(
        join(repoPath, 'copy-source.txt'),
        'copy source\nsecond line\nthird line\n',
      );
      commitAll(repoPath, 'base');

      runGit(repoPath, 'switch', '--quiet', '-c', 'feature');
      await writeFile(join(repoPath, 'content.txt'), 'feature\n');
      await writeFile(join(repoPath, 'clean.txt'), 'feature\nsecond\nthird\n');
      await writeFile(join(repoPath, 'add-add.txt'), 'feature add\n');
      await writeFile(join(repoPath, 'café.txt'), 'feature unicode\n');
      await writeFile(
        join(repoPath, 'binary.bin'),
        Buffer.from('feature\0binary\n'),
      );
      commitAll(repoPath, 'feature changes');

      runGit(repoPath, 'switch', '--quiet', 'main');
      await writeFile(join(repoPath, 'content.txt'), 'ours\n');
      await writeFile(join(repoPath, 'clean.txt'), 'first\nsecond\nmain\n');
      await writeFile(join(repoPath, 'add-add.txt'), 'ours add\n');
      await writeFile(join(repoPath, 'café.txt'), 'ours unicode\n');
      await writeFile(
        join(repoPath, 'binary.bin'),
        Buffer.from('ours\0binary\n'),
      );
      commitAll(repoPath, 'main changes');

      expect(() => runGit(repoPath, 'merge', '--no-edit', 'feature')).toThrow();
      expect(
        runGit(repoPath, '-c', 'core.quotePath=false', 'status', '--porcelain')
          .split('\n')
          .filter(Boolean),
      ).toEqual(
        expect.arrayContaining([
          'AA add-add.txt',
          'M  clean.txt',
          'UU binary.bin',
          'UU café.txt',
          'UU content.txt',
        ]),
      );

      await writeFile(
        join(repoPath, 'binary.bin'),
        Buffer.from('manual resolution\0binary\n'),
      );
      await writeFile(join(repoPath, 'untracked.txt'), 'untracked\n');

      const files = await getChangedFilesList(repoPath);

      expect(files.filter(({ path }) => path === 'content.txt')).toHaveLength(
        1,
      );
      expect(findFile(files, 'content.txt')).toEqual(
        expect.objectContaining({
          deletions: 0,
          insertions: 4,
          path: 'content.txt',
          status: 'unmerged',
        }),
      );
      expect(findFile(files, 'add-add.txt')).toEqual(
        expect.objectContaining({
          deletions: 0,
          insertions: 4,
          path: 'add-add.txt',
          status: 'unmerged',
        }),
      );
      expect(findFile(files, 'café.txt').status).toBe('unmerged');
      expect(findFile(files, 'binary.bin')).toEqual(
        expect.objectContaining({
          binary: true,
          deletions: 0,
          insertions: 0,
          status: 'unmerged',
        }),
      );
      expect(findFile(files, 'clean.txt')).toEqual(
        expect.objectContaining({
          deletions: 1,
          insertions: 1,
          path: 'clean.txt',
          status: 'modified',
        }),
      );
      expect(findFile(files, 'untracked.txt')).toEqual(
        expect.objectContaining({
          deletions: 0,
          insertions: 1,
          path: 'untracked.txt',
          status: 'untracked',
        }),
      );

      runGit(repoPath, 'mv', 'rename-source.txt', 'renamed-source.txt');
      await writeFile(
        join(repoPath, 'copy-source.txt'),
        'changed copy source\nsecond line\nthird line\n',
      );
      await writeFile(
        join(repoPath, 'copy-target.txt'),
        'changed copy source\nsecond line\nthird line\n',
      );
      runGit(repoPath, 'add', '--', 'copy-source.txt', 'copy-target.txt');

      const withRenameAndCopy = await getChangedFilesList(repoPath);
      expect(findFile(withRenameAndCopy, 'renamed-source.txt').status).toBe(
        'renamed',
      );
      expect(findFile(withRenameAndCopy, 'copy-target.txt').status).toBe(
        'copied',
      );
      expect(findFile(withRenameAndCopy, 'content.txt').status).toBe(
        'unmerged',
      );

      await writeFile(join(repoPath, 'content.txt'), 'resolved content\n');
      runGit(repoPath, 'add', 'content.txt');
      const afterResolution = await getChangedFilesList(repoPath);
      expect(findFile(afterResolution, 'content.txt').status).toBe('modified');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  const itWhenTabPathsAreSupported =
    process.platform === 'win32' ? it.skip : it;

  itWhenTabPathsAreSupported(
    'uses C-quoted tab paths when the unmerged path is absent from diff HEAD',
    async () => {
      const repoPath = await createRepository();
      const conflictedPath = 'conflict\tname.txt';
      const quotedConflictedPath = '"conflict\\tname.txt"';

      try {
        await writeFile(join(repoPath, conflictedPath), 'base\n');
        commitAll(repoPath, 'base');

        runGit(repoPath, 'switch', '--quiet', '-c', 'feature');
        await writeFile(join(repoPath, conflictedPath), 'feature\n');
        commitAll(repoPath, 'feature changes');

        runGit(repoPath, 'switch', '--quiet', 'main');
        await writeFile(join(repoPath, conflictedPath), 'ours\n');
        commitAll(repoPath, 'main changes');

        expect(() =>
          runGit(repoPath, 'merge', '--no-edit', 'feature'),
        ).toThrow();
        await writeFile(join(repoPath, conflictedPath), 'ours\n');
        expect(runGit(repoPath, 'diff', 'HEAD', '--name-status')).toBe('');

        const files = await getChangedFilesList(repoPath);

        expect(
          files.filter(({ path }) => path === quotedConflictedPath),
        ).toHaveLength(1);
        expect(findFile(files, quotedConflictedPath)).toEqual({
          deletions: 0,
          insertions: 0,
          path: quotedConflictedPath,
          status: 'unmerged',
        });
      } finally {
        await rm(repoPath, { recursive: true, force: true });
      }
    },
  );

  itWhenTabPathsAreSupported(
    'deduplicates C-quoted tab paths when the conflict still differs from HEAD',
    async () => {
      const repoPath = await createRepository();
      const conflictedPath = 'conflict\t"name.txt';
      const quotedConflictedPath = '"conflict\\t\\"name.txt"';

      try {
        await writeFile(join(repoPath, conflictedPath), 'base\n');
        commitAll(repoPath, 'base');

        runGit(repoPath, 'switch', '--quiet', '-c', 'feature');
        await writeFile(join(repoPath, conflictedPath), 'feature\n');
        commitAll(repoPath, 'feature changes');

        runGit(repoPath, 'switch', '--quiet', 'main');
        await writeFile(join(repoPath, conflictedPath), 'ours\n');
        commitAll(repoPath, 'main changes');

        expect(() =>
          runGit(repoPath, 'merge', '--no-edit', 'feature'),
        ).toThrow();
        await expect(
          readFile(join(repoPath, conflictedPath), 'utf8'),
        ).resolves.toContain('<<<<<<< HEAD');

        const files = await getChangedFilesList(repoPath);
        const conflictEntries = files.filter(
          ({ path }) =>
            path === conflictedPath || path === quotedConflictedPath,
        );

        expect(conflictEntries).toHaveLength(1);
        expect(conflictEntries[0]).toEqual(
          expect.objectContaining({
            path: quotedConflictedPath,
            status: 'unmerged',
          }),
        );
        expect(
          (conflictEntries[0]?.insertions ?? 0) +
            (conflictEntries[0]?.deletions ?? 0),
        ).toBeGreaterThan(0);
      } finally {
        await rm(repoPath, { recursive: true, force: true });
      }
    },
  );

  it('includes delete-related conflicts missing from diff HEAD and reverts to HEAD', async () => {
    const repoPath = await createRepository();
    const conflictedPath = 'delete-related.txt';

    try {
      await writeFile(join(repoPath, conflictedPath), 'base\n');
      commitAll(repoPath, 'base');

      runGit(repoPath, 'switch', '--quiet', '-c', 'feature');
      runGit(repoPath, 'rm', '--quiet', conflictedPath);
      commitAll(repoPath, 'feature deletes file');

      runGit(repoPath, 'switch', '--quiet', 'main');
      await writeFile(join(repoPath, conflictedPath), 'ours\n');
      commitAll(repoPath, 'main modifies file');

      expect(() => runGit(repoPath, 'merge', '--no-edit', 'feature')).toThrow();
      expect(runGit(repoPath, 'status', '--porcelain')).toMatch(
        /^(?:DU|UD) delete-related\.txt$/m,
      );
      expect(runGit(repoPath, 'diff', 'HEAD', '--name-status')).toBe('');

      const files = await getChangedFilesList(repoPath);
      const conflict = findFile(files, conflictedPath);
      expect(conflict).toEqual({
        deletions: 0,
        insertions: 0,
        path: conflictedPath,
        status: 'unmerged',
      });

      await revertUncommittedFile(repoPath, conflict.path, conflict.status);

      await expect(
        readFile(join(repoPath, conflictedPath), 'utf8'),
      ).resolves.toBe('ours\n');
      expect(
        runGit(repoPath, 'ls-files', '--unmerged', '--', conflictedPath),
      ).toBe('');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it('marks a cherry-pick conflict unmerged from index state', async () => {
    const repoPath = await createRepository();

    try {
      await writeFile(join(repoPath, 'cherry-pick.txt'), 'base\n');
      commitAll(repoPath, 'base');

      runGit(repoPath, 'switch', '--quiet', '-c', 'topic');
      await writeFile(join(repoPath, 'cherry-pick.txt'), 'topic\n');
      commitAll(repoPath, 'topic changes');

      runGit(repoPath, 'switch', '--quiet', 'main');
      await writeFile(join(repoPath, 'cherry-pick.txt'), 'main\n');
      commitAll(repoPath, 'main changes');

      expect(() => runGit(repoPath, 'cherry-pick', 'topic')).toThrow();

      const files = await getChangedFilesList(repoPath);
      expect(findFile(files, 'cherry-pick.txt').status).toBe('unmerged');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the best-effort Git commands fail', async () => {
    const repoPath = await mkdtemp(
      join(tmpdir(), 'canopy-changed-files-not-git-'),
    );

    try {
      await expect(getChangedFilesList(repoPath)).resolves.toEqual([]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
