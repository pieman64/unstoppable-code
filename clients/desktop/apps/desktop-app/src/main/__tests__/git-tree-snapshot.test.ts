// Resolve the test Git independently of desktop preferences; this suite tests Git operations.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

jest.unmock('../lib/git-tree-snapshot');
jest.unmock('../lib/git');

import {
  assertWorktreeSnapshotSupported,
  captureHeadCommitSha,
  captureIndexTreeSha,
  captureWorkingTreeSha,
  createSnapshotCommit,
  diffTreeObjects,
  restoreIndexAndWorkingTreeSnapshot,
  streamArchiveTreeDiff,
  streamGitNulTokens,
} from '../lib/git-tree-snapshot';
import {
  cleanupPersistedTurnDiffTreeRefs,
  isRebaseInProgress,
  persistTurnDiffTreeRef,
  restoreToSnapshot,
} from '../lib/git';

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function createRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'canopy-git-tree-'));
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.name', 'Canopy Test']);
  runGit(repoPath, ['config', 'user.email', 'canopy@example.com']);
  runGit(repoPath, ['config', 'commit.gpgsign', 'false']);
  runGit(repoPath, ['config', 'core.autocrlf', 'false']);
  return repoPath;
}

function createGitExecutable(repoPath: string, body: string): string {
  const executable = join(repoPath, 'test-git.sh');
  writeFileSync(executable, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(executable, 0o755);
  return executable;
}

async function waitForPath(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for marker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('git tree snapshots', () => {
  let repoPath = '';
  let worktreePath = '';
  let auxiliaryRepoPath = '';

  afterEach(() => {
    if (worktreePath) {
      rmSync(worktreePath, { recursive: true, force: true });
      worktreePath = '';
    }
    if (repoPath) {
      rmSync(repoPath, { recursive: true, force: true });
      repoPath = '';
    }
    if (auxiliaryRepoPath) {
      rmSync(auxiliaryRepoPath, { recursive: true, force: true });
      auxiliaryRepoPath = '';
    }
  });

  it('captures tracked and untracked changes as tree diffs', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    const startTree = await captureWorkingTreeSha(repoPath);

    writeFileSync(join(repoPath, 'tracked.txt'), 'one\ntwo\n', 'utf8');
    writeFileSync(join(repoPath, 'new-file.txt'), 'fresh\nfile\n', 'utf8');

    const endTree = await captureWorkingTreeSha(repoPath);
    const files = await diffTreeObjects(repoPath, startTree, endTree);

    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'tracked.txt',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        }),
        expect.objectContaining({
          path: 'new-file.txt',
          status: 'added',
          insertions: 2,
          deletions: 0,
        }),
      ]),
    );
  });

  it('waits for scalar Git stdout to close before resolving', async () => {
    repoPath = createRepo();
    const expectedSha = 'a'.repeat(40);
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        `(sleep 0.1; printf '%s\\n' '${expectedSha}') &`,
      );
      await expect(captureHeadCommitSha(repoPath)).resolves.toBe(expectedSha);
    } finally {
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('ignores inherited Git location and index overrides when capturing the requested checkout', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'original\n');
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const expected = runGit(repoPath, ['write-tree']);
    const saved = { ...process.env };
    try {
      process.env.GIT_DIR = join(repoPath, 'nonexistent');
      process.env.GIT_WORK_TREE = join(repoPath, 'elsewhere');
      process.env.GIT_INDEX_FILE = join(repoPath, 'wrong-index');
      await expect(captureIndexTreeSha(repoPath)).resolves.toBe(expected);
      await expect(
        assertWorktreeSnapshotSupported(repoPath),
      ).resolves.toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'captures on-disk edits hidden by %s without changing the live index flag',
    async (flag) => {
      repoPath = createRepo();
      writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      runGit(repoPath, ['commit', '-m', 'initial']);
      runGit(repoPath, ['update-index', flag, 'tracked.txt']);
      const flaggedEntry = runGit(repoPath, ['ls-files', '-v', 'tracked.txt']);
      writeFileSync(join(repoPath, 'tracked.txt'), 'hidden edit\n', 'utf8');

      const snapshotTree = await captureWorkingTreeSha(repoPath);

      expect(runGit(repoPath, ['show', `${snapshotTree}:tracked.txt`])).toBe(
        'hidden edit',
      );
      expect(runGit(repoPath, ['ls-files', '-v', 'tracked.txt'])).toBe(
        flaggedEntry,
      );
    },
  );

  it('preserves absent sparse-checkout entries in working-tree snapshots', async () => {
    repoPath = createRepo();
    const sparsePath = join(repoPath, 'sparse.txt');
    writeFileSync(sparsePath, 'kept in index\n', 'utf8');
    runGit(repoPath, ['add', 'sparse.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    runGit(repoPath, ['update-index', '--skip-worktree', 'sparse.txt']);
    rmSync(sparsePath);

    const snapshotTree = await captureWorkingTreeSha(repoPath);

    expect(runGit(repoPath, ['show', `${snapshotTree}:sparse.txt`])).toBe(
      'kept in index',
    );
    expect(
      runGit(repoPath, ['diff-tree', '--name-only', 'HEAD', snapshotTree]),
    ).toBe('');
    expect(runGit(repoPath, ['ls-files', '-v', 'sparse.txt'])).toMatch(/^S /);
  });

  it('captures working-tree executable changes when core.fileMode is false', async () => {
    repoPath = createRepo();
    const executablePath = join(repoPath, 'script.sh');
    writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executablePath, 0o644);
    runGit(repoPath, ['add', 'script.sh']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    runGit(repoPath, ['config', 'core.fileMode', 'false']);
    chmodSync(executablePath, 0o755);

    const snapshotTree = await captureWorkingTreeSha(repoPath);

    expect(runGit(repoPath, ['ls-tree', snapshotTree, 'script.sh'])).toMatch(
      /^100755 /,
    );
  });

  it('preserves copied index modes without forcing fileMode on Windows', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const argsLog = join(repoPath, 'git-args.log');
    const executable = createGitExecutable(
      repoPath,
      `printf '%s\\n' "$*" >> '${argsLog}'\nexec git "$@"`,
    );
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    process.env.CANOPY_GIT_EXECUTABLE = executable;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });

    try {
      await captureWorkingTreeSha(repoPath);
      expect(readFileSync(argsLog, 'utf8')).not.toContain('core.fileMode=true');
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('captures conflict markers without modifying the live unmerged index', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'conflicted.txt'), 'base\n', 'utf8');
    runGit(repoPath, ['add', 'conflicted.txt']);
    runGit(repoPath, ['commit', '-m', 'base']);
    const initialBranch = runGit(repoPath, ['branch', '--show-current']);
    runGit(repoPath, ['checkout', '-b', 'other']);
    writeFileSync(join(repoPath, 'conflicted.txt'), 'other\n', 'utf8');
    runGit(repoPath, ['add', 'conflicted.txt']);
    runGit(repoPath, ['commit', '-m', 'other']);
    runGit(repoPath, ['checkout', initialBranch]);
    writeFileSync(join(repoPath, 'conflicted.txt'), 'main\n', 'utf8');
    runGit(repoPath, ['add', 'conflicted.txt']);
    runGit(repoPath, ['commit', '-m', 'main']);
    expect(() => runGit(repoPath, ['merge', 'other'])).toThrow();
    const unmergedEntries = runGit(repoPath, [
      'ls-files',
      '--unmerged',
      'conflicted.txt',
    ]);
    const conflictedContents = readFileSync(
      join(repoPath, 'conflicted.txt'),
      'utf8',
    );

    const snapshotTree = await captureWorkingTreeSha(repoPath);

    expect(
      runGit(repoPath, ['cat-file', 'blob', `${snapshotTree}:conflicted.txt`]),
    ).toBe(conflictedContents.trim());
    expect(runGit(repoPath, ['ls-files', '--unmerged', 'conflicted.txt'])).toBe(
      unmergedEntries,
    );
  });

  it('captures unborn repos by seeding the temp index with an empty tree', async () => {
    repoPath = createRepo();

    const startTree = await captureWorkingTreeSha(repoPath);
    writeFileSync(join(repoPath, 'hello.txt'), 'hello\n', 'utf8');
    const endTree = await captureWorkingTreeSha(repoPath);

    const files = await diffTreeObjects(repoPath, startTree, endTree);

    expect(files).toEqual([
      expect.objectContaining({
        path: 'hello.txt',
        status: 'added',
        insertions: 1,
        deletions: 0,
      }),
    ]);
  });

  it('detects in-progress rebases inside linked worktrees', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    worktreePath = mkdtempSync(join(tmpdir(), 'canopy-linked-worktree-'));
    rmSync(worktreePath, { recursive: true, force: true });
    runGit(repoPath, ['worktree', 'add', '-b', 'feature', worktreePath]);
    mkdirSync(
      runGit(worktreePath, ['rev-parse', '--git-path', 'rebase-merge']),
      {
        recursive: true,
      },
    );

    await expect(isRebaseInProgress(worktreePath)).resolves.toBe(true);
  });

  it('captures HEAD commit SHA, falling back to undefined for unborn repos', async () => {
    repoPath = createRepo();

    expect(await captureHeadCommitSha(repoPath)).toBeUndefined();

    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    const headSha = await captureHeadCommitSha(repoPath);
    expect(headSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(headSha).toBe(runGit(repoPath, ['rev-parse', 'HEAD']));
  });

  it('restoreToSnapshot rolls back uncommitted edits and removes new files', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    const headSha = await captureHeadCommitSha(repoPath);
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\nstaged\n', 'utf8');
    const snapshotTree = await captureWorkingTreeSha(repoPath);

    writeFileSync(join(repoPath, 'tracked.txt'), 'one\nbad\n', 'utf8');
    writeFileSync(join(repoPath, 'extra.txt'), 'created later\n', 'utf8');

    await restoreToSnapshot(repoPath, {
      treeSha: snapshotTree,
      headCommitSha: headSha,
    });

    expect(readFileSync(join(repoPath, 'tracked.txt'), 'utf8')).toBe(
      'one\nstaged\n',
    );
    expect(existsSync(join(repoPath, 'extra.txt'))).toBe(false);
  });

  it('restoreToSnapshot rolls back commits made after the snapshot', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    const headSha = await captureHeadCommitSha(repoPath);
    const snapshotTree = await captureWorkingTreeSha(repoPath);

    writeFileSync(join(repoPath, 'tracked.txt'), 'one\nlater\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'agent commit']);

    await restoreToSnapshot(repoPath, {
      treeSha: snapshotTree,
      headCommitSha: headSha,
    });

    expect(runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(headSha);
    expect(readFileSync(join(repoPath, 'tracked.txt'), 'utf8')).toBe('one\n');
  });

  it('restoreToSnapshot leaves gitignored files alone', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, '.gitignore'), 'build/\n', 'utf8');
    runGit(repoPath, ['add', '.gitignore']);
    runGit(repoPath, ['commit', '-m', 'init']);

    const headSha = await captureHeadCommitSha(repoPath);
    const snapshotTree = await captureWorkingTreeSha(repoPath);

    mkdirSync(join(repoPath, 'build'), { recursive: true });
    writeFileSync(join(repoPath, 'build', 'artifact.bin'), 'noise\n', 'utf8');
    writeFileSync(join(repoPath, 'extra.txt'), 'created later\n', 'utf8');

    await restoreToSnapshot(repoPath, {
      treeSha: snapshotTree,
      headCommitSha: headSha,
    });

    expect(existsSync(join(repoPath, 'build', 'artifact.bin'))).toBe(true);
    expect(existsSync(join(repoPath, 'extra.txt'))).toBe(false);
  });

  it('restoreToSnapshot handles unborn repos by seeding an empty tree', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'a.txt'), 'a\n', 'utf8');
    const snapshotTree = await captureWorkingTreeSha(repoPath);

    writeFileSync(join(repoPath, 'b.txt'), 'b\n', 'utf8');

    await restoreToSnapshot(repoPath, { treeSha: snapshotTree });

    expect(existsSync(join(repoPath, 'a.txt'))).toBe(true);
    expect(existsSync(join(repoPath, 'b.txt'))).toBe(false);
  });

  it('restoreToSnapshot returns to unborn state after a first commit', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'a.txt'), 'snapshot\n', 'utf8');
    const snapshotTree = await captureWorkingTreeSha(repoPath);

    writeFileSync(join(repoPath, 'a.txt'), 'agent commit\n', 'utf8');
    writeFileSync(join(repoPath, 'b.txt'), 'created later\n', 'utf8');
    runGit(repoPath, ['add', 'a.txt', 'b.txt']);
    runGit(repoPath, ['commit', '-m', 'agent commit']);

    await restoreToSnapshot(repoPath, { treeSha: snapshotTree });

    expect(() => runGit(repoPath, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf8')).toBe('snapshot\n');
    expect(existsSync(join(repoPath, 'b.txt'))).toBe(false);
  });

  it('pins captured trees under a worktree-scoped ref namespace and cleans them up', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    writeFileSync(join(repoPath, 'scratch.txt'), 'uncommitted\n', 'utf8');

    const treeSha = await captureWorkingTreeSha(repoPath);

    await persistTurnDiffTreeRef(repoPath, 'project-1', 'yak', treeSha);

    expect(
      runGit(repoPath, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/app/turn-diff-trees/project-1/yak',
      ]),
    ).toBe(`refs/app/turn-diff-trees/project-1/yak/${treeSha}`);

    await cleanupPersistedTurnDiffTreeRefs(repoPath, 'project-1', 'yak');

    expect(
      runGit(repoPath, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/app/turn-diff-trees/project-1/yak',
      ]),
    ).toBe('');
  });

  it('settles every turn diff ref deletion before reporting a failed one', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const failingSha = await captureWorkingTreeSha(repoPath);
    // Different sizes keep Git's stat cache from reusing the first tree on
    // filesystems that cannot distinguish these quick successive writes.
    writeFileSync(join(repoPath, 'tracked.txt'), 'second tree\n', 'utf8');
    const pendingSha = await captureWorkingTreeSha(repoPath);
    expect(pendingSha).not.toBe(failingSha);
    await persistTurnDiffTreeRef(repoPath, 'project-1', 'yak', failingSha);
    await persistTurnDiffTreeRef(repoPath, 'project-1', 'yak', pendingSha);
    const started = join(repoPath, 'deletion-started');
    const release = join(repoPath, 'deletion-release');
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
      repoPath,
      [
        'case "$*" in',
        `  *"update-ref -d "*${failingSha}*) exit 1 ;;`,
        `  *"update-ref -d "*) touch '${started}'`,
        `    while [ ! -f '${release}' ]; do sleep 0.02; done ;;`,
        'esac',
        'exec git "$@"',
      ].join('\n'),
    );
    try {
      let settled = false;
      const cleanup = cleanupPersistedTurnDiffTreeRefs(
        repoPath,
        'project-1',
        'yak',
      ).finally(() => {
        settled = true;
      });
      // Observed below; keeps an early assertion failure from leaking it.
      cleanup.catch(() => undefined);
      await waitForPath(started, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(settled).toBe(false);
      writeFileSync(release, '', 'utf8');
      await expect(cleanup).rejects.toThrow();
      expect(
        runGit(repoPath, [
          'for-each-ref',
          '--format=%(refname)',
          'refs/app/turn-diff-trees/project-1/yak',
        ]),
      ).toBe(`refs/app/turn-diff-trees/project-1/yak/${failingSha}`);
    } finally {
      writeFileSync(release, '', 'utf8');
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('reconstructs committed, staged, unstaged, and non-ignored untracked state exactly', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, '.gitignore'), 'ignored.txt\n', 'utf8');
    writeFileSync(join(repoPath, 'both.txt'), 'base\n', 'utf8');
    writeFileSync(join(repoPath, 'deleted.txt'), 'delete me\n', 'utf8');
    runGit(repoPath, ['add', '.gitignore', 'both.txt', 'deleted.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const headCommit = runGit(repoPath, ['rev-parse', 'HEAD']);

    writeFileSync(join(repoPath, 'both.txt'), 'staged\n', 'utf8');
    writeFileSync(join(repoPath, 'staged.txt'), 'staged add\n', 'utf8');
    runGit(repoPath, ['add', 'both.txt', 'staged.txt']);
    writeFileSync(join(repoPath, 'both.txt'), 'working\n', 'utf8');
    rmSync(join(repoPath, 'deleted.txt'));
    writeFileSync(join(repoPath, 'untracked.txt'), 'untracked\n', 'utf8');
    writeFileSync(join(repoPath, 'ignored.txt'), 'ignored\n', 'utf8');

    await assertWorktreeSnapshotSupported(repoPath);
    const indexTree = await captureIndexTreeSha(repoPath);
    const indexCommit = await createSnapshotCommit({
      repoPath,
      treeSha: indexTree,
      parentCommit: headCommit,
      message: 'index',
    });
    const worktreeTree = await captureWorkingTreeSha(repoPath);
    const worktreeCommit = await createSnapshotCommit({
      repoPath,
      treeSha: worktreeTree,
      parentCommit: indexCommit,
      message: 'worktree',
    });
    const expectedStatus = runGit(repoPath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);

    runGit(repoPath, ['reset', '--hard', 'HEAD']);
    rmSync(join(repoPath, 'untracked.txt'), { force: true });
    rmSync(join(repoPath, 'ignored.txt'), { force: true });
    writeFileSync(join(repoPath, 'both.txt'), 'wrong\n', 'utf8');
    await restoreIndexAndWorkingTreeSnapshot({
      repoPath,
      headCommit,
      indexSnapshotCommit: indexCommit,
      worktreeSnapshotCommit: worktreeCommit,
    });

    expect(
      runGit(repoPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
    ).toBe(expectedStatus);
    expect(readFileSync(join(repoPath, 'both.txt'), 'utf8')).toBe('working\n');
    expect(runGit(repoPath, ['show', `:${'both.txt'}`])).toBe('staged');
    expect(readFileSync(join(repoPath, 'untracked.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    expect(existsSync(join(repoPath, 'ignored.txt'))).toBe(false);
  });

  it('reapplies archived staged and unstaged changes without moving an ahead branch', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'base']);
    const archivedHead = runGit(repoPath, ['rev-parse', 'HEAD']);

    writeFileSync(join(repoPath, 'tracked.txt'), 'staged\n', 'utf8');
    writeFileSync(join(repoPath, 'staged.txt'), 'staged add\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt', 'staged.txt']);
    writeFileSync(join(repoPath, 'tracked.txt'), 'working\n', 'utf8');
    writeFileSync(join(repoPath, 'untracked.txt'), 'untracked\n', 'utf8');
    const indexTree = await captureIndexTreeSha(repoPath);
    const indexCommit = await createSnapshotCommit({
      repoPath,
      treeSha: indexTree,
      parentCommit: archivedHead,
      message: 'index',
    });
    const worktreeTree = await captureWorkingTreeSha(repoPath);
    const worktreeCommit = await createSnapshotCommit({
      repoPath,
      treeSha: worktreeTree,
      parentCommit: indexCommit,
      message: 'worktree',
    });

    runGit(repoPath, ['reset', '--hard', archivedHead]);
    rmSync(join(repoPath, 'untracked.txt'), { force: true });
    writeFileSync(join(repoPath, 'ahead.txt'), 'later commit\n', 'utf8');
    runGit(repoPath, ['add', 'ahead.txt']);
    runGit(repoPath, ['commit', '-m', 'ahead']);
    const aheadHead = runGit(repoPath, ['rev-parse', 'HEAD']);

    await restoreIndexAndWorkingTreeSnapshot({
      repoPath,
      headCommit: archivedHead,
      indexSnapshotCommit: indexCommit,
      worktreeSnapshotCommit: worktreeCommit,
      preserveDescendantHead: true,
    });

    expect(runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(aheadHead);
    expect(readFileSync(join(repoPath, 'ahead.txt'), 'utf8')).toBe(
      'later commit\n',
    );
    expect(runGit(repoPath, ['show', ':tracked.txt'])).toBe('staged');
    expect(readFileSync(join(repoPath, 'tracked.txt'), 'utf8')).toBe(
      'working\n',
    );
    expect(runGit(repoPath, ['show', ':staged.txt'])).toBe('staged add');
    expect(readFileSync(join(repoPath, 'untracked.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    expect(
      runGit(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    ).toBe('A  staged.txt\nMM tracked.txt\n?? untracked.txt');
  });

  it('rejects intent-to-add entries before snapshotting', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8');
    runGit(repoPath, ['add', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    writeFileSync(join(repoPath, 'intent.txt'), 'later\n', 'utf8');
    runGit(repoPath, ['add', '--intent-to-add', 'intent.txt']);

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'intent-to-add',
    );
  });

  it('rejects unresolved index entries before snapshotting', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'conflict.txt'), 'base\n', 'utf8');
    runGit(repoPath, ['add', 'conflict.txt']);
    runGit(repoPath, ['commit', '-m', 'base']);
    const originalBranch = runGit(repoPath, ['branch', '--show-current']);
    runGit(repoPath, ['checkout', '-b', 'other']);
    writeFileSync(join(repoPath, 'conflict.txt'), 'other\n', 'utf8');
    runGit(repoPath, ['commit', '-am', 'other']);
    runGit(repoPath, ['checkout', originalBranch]);
    writeFileSync(join(repoPath, 'conflict.txt'), 'original\n', 'utf8');
    runGit(repoPath, ['commit', '-am', 'original']);
    expect(() => runGit(repoPath, ['merge', 'other'])).toThrow();

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'unresolved conflicts',
    );
  });

  it('rejects dirty nested submodules before snapshotting', async () => {
    auxiliaryRepoPath = createRepo();
    writeFileSync(join(auxiliaryRepoPath, 'nested.txt'), 'clean\n', 'utf8');
    runGit(auxiliaryRepoPath, ['add', 'nested.txt']);
    runGit(auxiliaryRepoPath, ['commit', '-m', 'nested']);

    repoPath = createRepo();
    writeFileSync(join(repoPath, 'root.txt'), 'root\n', 'utf8');
    runGit(repoPath, ['add', 'root.txt']);
    runGit(repoPath, ['commit', '-m', 'root']);
    runGit(repoPath, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      auxiliaryRepoPath,
      'nested',
    ]);
    runGit(repoPath, ['commit', '-am', 'submodule']);
    writeFileSync(join(repoPath, 'nested', 'nested.txt'), 'dirty\n', 'utf8');

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'dirty nested submodules',
    );
  });

  it('rejects untracked nested Git repositories before snapshotting', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'root.txt'), 'root\n', 'utf8');
    runGit(repoPath, ['add', 'root.txt']);
    runGit(repoPath, ['commit', '-m', 'root']);
    const nestedPath = join(repoPath, 'nested');
    mkdirSync(nestedPath);
    runGit(nestedPath, ['init']);
    runGit(nestedPath, ['config', 'user.name', 'Canopy Test']);
    runGit(nestedPath, ['config', 'user.email', 'canopy@example.com']);
    runGit(nestedPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(nestedPath, 'nested.txt'), 'nested\n', 'utf8');
    runGit(nestedPath, ['add', 'nested.txt']);
    runGit(nestedPath, ['commit', '-m', 'nested']);

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'untracked nested Git repository: nested/',
    );
  });

  it('rejects nested Git repositories below an untracked wrapper', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'root.txt'), 'root\n', 'utf8');
    runGit(repoPath, ['add', 'root.txt']);
    runGit(repoPath, ['commit', '-m', 'root']);
    const nestedPath = join(repoPath, 'scratch', 'vendor');
    mkdirSync(nestedPath, { recursive: true });
    runGit(nestedPath, ['init']);

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'untracked nested Git repository: scratch/vendor/',
    );
  });

  it('rejects embedded Git repositories containing outer-repository files', async () => {
    repoPath = createRepo();
    const nestedPath = join(repoPath, 'tracked', 'nested');
    mkdirSync(nestedPath, { recursive: true });
    writeFileSync(join(nestedPath, 'outer.txt'), 'outer\n', 'utf8');
    runGit(repoPath, ['add', 'tracked/nested/outer.txt']);
    runGit(repoPath, ['commit', '-m', 'outer tracked file']);

    runGit(nestedPath, ['init']);
    runGit(nestedPath, ['config', 'user.name', 'Canopy Test']);
    runGit(nestedPath, ['config', 'user.email', 'canopy@example.com']);
    runGit(nestedPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(nestedPath, 'nested.txt'), 'nested\n', 'utf8');
    runGit(nestedPath, ['add', 'nested.txt']);
    runGit(nestedPath, ['commit', '-m', 'nested']);

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'embedded Git repository containing outer-repository files: tracked/nested',
    );
  });

  it('rejects transforming Git filters before snapshotting', async () => {
    repoPath = createRepo();
    writeFileSync(
      join(repoPath, '.gitattributes'),
      '*.txt filter=lossy\n',
      'utf8',
    );
    writeFileSync(join(repoPath, 'tracked.txt'), 'original bytes\n', 'utf8');
    runGit(repoPath, [
      'config',
      'filter.lossy.clean',
      'git hash-object --stdin',
    ]);
    runGit(repoPath, ['add', '.gitattributes', 'tracked.txt']);
    runGit(repoPath, ['commit', '-m', 'filtered file']);

    await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
      'transforming Git filter: tracked.txt',
    );
  });

  it.each(['none', 'first', 'last'])(
    'checks attributes beyond 8 MiB of output (unsafe path: %s)',
    async (unsafePathPosition) => {
      repoPath = createRepo();
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repoPath,
        input: 'retained content\n',
        encoding: 'utf8',
      }).trim();
      const paths = Array.from(
        { length: 12_000 },
        (_, index) => `large-${'x'.repeat(100)}-${index}.txt`,
      );
      const lastPath = 'zz-last-été.txt';
      paths.push(lastPath);
      // Missing tracked files are valid snapshot input too. Seed their real
      // index entries without spending the test on thousands of disk writes.
      execFileSync('git', ['update-index', '-z', '--index-info'], {
        cwd: repoPath,
        input: paths.map((name) => `100644 ${blob}\t${name}\0`).join(''),
      });
      const output = execFileSync(
        'git',
        [
          'check-attr',
          '-z',
          '--stdin',
          'filter',
          'text',
          'eol',
          'working-tree-encoding',
          'ident',
          'crlf',
        ],
        {
          cwd: repoPath,
          input: `${paths.join('\0')}\0`,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(output.byteLength).toBeGreaterThan(8 * 1024 * 1024);
      if (unsafePathPosition !== 'none') {
        const unsafePath = unsafePathPosition === 'first' ? paths[0] : lastPath;
        writeFileSync(
          join(repoPath, '.gitattributes'),
          `${unsafePath} filter=lossy\n`,
        );
        await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
          `transforming Git filter: ${unsafePath}`,
        );
      } else {
        await expect(
          assertWorktreeSnapshotSupported(repoPath),
        ).resolves.toBeUndefined();
      }
    },
    30_000,
  );

  it.each(['path\\0text\\0', 'path\\0text'])(
    'rejects incomplete Git attribute output: %s',
    async (output) => {
      repoPath = createRepo();
      const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
      try {
        process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
          repoPath,
          `if [ "$1" = check-attr ]; then printf '${output}'; else exec git "$@"; fi`,
        );
        await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
          'incomplete record',
        );
      } finally {
        if (previousGitExecutable === undefined) {
          delete process.env.CANOPY_GIT_EXECUTABLE;
        } else {
          process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
        }
      }
    },
  );

  it.each([
    ['text', '*.txt text'],
    ['eol', '*.txt eol=lf'],
    ['working-tree-encoding', '*.txt working-tree-encoding=UTF-16'],
    ['ident', '*.txt ident'],
  ])(
    'rejects the transforming %s attribute before snapshotting',
    async (attribute, rule) => {
      repoPath = createRepo();
      writeFileSync(join(repoPath, '.gitattributes'), `${rule}\n`, 'utf8');
      writeFileSync(join(repoPath, 'tracked.txt'), 'original bytes\n', 'utf8');

      await expect(assertWorktreeSnapshotSupported(repoPath)).rejects.toThrow(
        `transforming Git attribute "${attribute}": tracked.txt`,
      );
    },
  );

  it.each(['true', 'input'])(
    'preserves CRLF bytes with core.autocrlf=%s during capture and restore',
    async (autocrlf) => {
      repoPath = createRepo();
      writeFileSync(join(repoPath, 'crlf.txt'), 'base\r\n', 'utf8');
      runGit(repoPath, ['add', 'crlf.txt']);
      runGit(repoPath, ['commit', '-m', 'base']);
      const headCommit = runGit(repoPath, ['rev-parse', 'HEAD']);
      runGit(repoPath, ['config', 'core.autocrlf', autocrlf]);
      writeFileSync(join(repoPath, 'crlf.txt'), 'one\r\ntwo\r\n', 'utf8');

      await expect(assertWorktreeSnapshotSupported(repoPath)).resolves.toBe(
        undefined,
      );
      const indexTree = await captureIndexTreeSha(repoPath);
      const indexCommit = await createSnapshotCommit({
        repoPath,
        treeSha: indexTree,
        parentCommit: headCommit,
        message: 'index',
      });
      const worktreeTree = await captureWorkingTreeSha(repoPath);
      const worktreeCommit = await createSnapshotCommit({
        repoPath,
        treeSha: worktreeTree,
        parentCommit: indexCommit,
        message: 'worktree',
      });
      expect(
        runGit(repoPath, ['cat-file', 'blob', `${worktreeTree}:crlf.txt`]),
      ).toBe('one\r\ntwo');

      writeFileSync(join(repoPath, 'crlf.txt'), 'wrong\n', 'utf8');
      await restoreIndexAndWorkingTreeSnapshot({
        repoPath,
        headCommit,
        indexSnapshotCommit: indexCommit,
        worktreeSnapshotCommit: worktreeCommit,
      });

      expect(readFileSync(join(repoPath, 'crlf.txt'), 'utf8')).toBe(
        'one\r\ntwo\r\n',
      );
    },
  );

  it('preserves stat-clean CRLF bytes when autocrlf normalized the index blob', async () => {
    repoPath = createRepo();
    runGit(repoPath, ['config', 'core.autocrlf', 'true']);
    writeFileSync(join(repoPath, 'crlf.txt'), 'one\r\ntwo\r\n', 'utf8');
    runGit(repoPath, ['add', 'crlf.txt']);
    runGit(repoPath, ['commit', '-m', 'normalized base']);
    expect(runGit(repoPath, ['status', '--porcelain'])).toBe('');
    expect(runGit(repoPath, ['cat-file', 'blob', 'HEAD:crlf.txt'])).toBe(
      'one\ntwo',
    );

    const worktreeTree = await captureWorkingTreeSha(repoPath);

    expect(
      runGit(repoPath, ['cat-file', 'blob', `${worktreeTree}:crlf.txt`]),
    ).toBe('one\r\ntwo');
  });

  it('streams rename metadata and preserves the true total beyond its retention cap', async () => {
    repoPath = createRepo();
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        join(repoPath, `file-${index}.txt`),
        `line ${index}\n`,
        'utf8',
      );
    }
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const start = runGit(repoPath, ['rev-parse', 'HEAD']);
    runGit(repoPath, ['mv', 'file-0.txt', 'renamed.txt']);
    for (let index = 1; index < 5; index += 1) {
      writeFileSync(
        join(repoPath, `file-${index}.txt`),
        `changed ${index}\n`,
        'utf8',
      );
    }
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'changes']);
    const end = runGit(repoPath, ['rev-parse', 'HEAD']);

    const result = await streamArchiveTreeDiff(repoPath, start, end, 2);

    expect(result.totalCount).toBe(5);
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    const complete = await streamArchiveTreeDiff(repoPath, start, end);
    expect(complete.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'renamed.txt',
          previousPath: 'file-0.txt',
          status: 'renamed',
        }),
      ]),
    );
  });

  it('rejects an already-aborted archived diff before spawning Git', async () => {
    const controller = new AbortController();
    controller.abort();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    process.env.CANOPY_GIT_EXECUTABLE = '/path/that/must/not/be/spawned';
    try {
      await expect(
        streamArchiveTreeDiff(
          '/missing/repo',
          'a'.repeat(40),
          'b'.repeat(40),
          1,
          controller.signal,
        ),
      ).rejects.toThrow('Archived Git diff was cancelled.');
    } finally {
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it.each(['name-status', 'numstat'])(
    'waits for child close when cancelling the %s archived Git stream',
    async (stream) => {
      repoPath = createRepo();
      const marker = join(repoPath, 'started');
      const scriptBody =
        stream === 'name-status'
          ? `touch '${marker}'\nexec /bin/sleep 30`
          : `case " $* " in\n  *" --name-status "*) exit 0 ;;\n  *) touch '${marker}'; exec /bin/sleep 30 ;;\nesac`;
      const executable = createGitExecutable(repoPath, scriptBody);
      const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
      process.env.CANOPY_GIT_EXECUTABLE = executable;
      const controller = new AbortController();
      let settled = false;
      try {
        const generation = streamArchiveTreeDiff(
          repoPath,
          'a'.repeat(40),
          'b'.repeat(40),
          10,
          controller.signal,
        );
        void generation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await waitForPath(marker);
        controller.abort();
        expect(settled).toBe(false);
        await expect(generation).rejects.toThrow(
          'Archived Git diff was cancelled.',
        );
        expect(settled).toBe(true);
      } finally {
        controller.abort();
        if (previousGitExecutable === undefined) {
          delete process.env.CANOPY_GIT_EXECUTABLE;
        } else {
          process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
        }
      }
    },
  );

  it('defers timeout and parse failure settlement until process close and removes abort listeners', async () => {
    repoPath = createRepo();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    try {
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        'exec /bin/sleep 30',
      );
      const timedOut = streamGitNulTokens({
        repoPath,
        gitArgs: [],
        timeoutMs: 100,
        signal: controller.signal,
        onToken: () => undefined,
      });
      await expect(timedOut).rejects.toThrow('timed out');
      expect(removeListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );

      removeListener.mockClear();
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "printf 'bad\\0'\nexec /bin/sleep 30",
      );
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          timeoutMs: 2_000,
          signal: controller.signal,
          onToken: () => {
            throw new Error('parse failed');
          },
        }),
      ).rejects.toThrow('parse failed');
      expect(removeListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
    } finally {
      removeListener.mockRestore();
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('prefers completion validation over an early stdin pipe failure', async () => {
    repoPath = createRepo();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "exec 0<&-\nprintf 'path\\0text\\0'",
      );
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          input: 'input'.repeat(1024 * 1024),
          timeoutMs: 2_000,
          onToken: () => undefined,
          validateComplete: () => {
            throw new Error('incomplete record');
          },
        }),
      ).rejects.toThrow('incomplete record');
    } finally {
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('cleans up listeners for successful and failed Git streams', async () => {
    repoPath = createRepo();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    try {
      const tokens: string[] = [];
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "printf 'one\\0two\\0'",
      );
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          timeoutMs: 2_000,
          signal: controller.signal,
          onToken: (token) => tokens.push(token),
        }),
      ).resolves.toBeUndefined();
      expect(tokens).toEqual(['one', 'two']);
      expect(removeListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );

      removeListener.mockClear();
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "printf 'failure' >&2\nexit 7",
      );
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          timeoutMs: 2_000,
          signal: controller.signal,
          onToken: () => undefined,
        }),
      ).rejects.toThrow('failure');
      expect(removeListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
    } finally {
      removeListener.mockRestore();
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('reports incomplete output before a broken stdin pipe', async () => {
    repoPath = createRepo();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "printf 'incomplete'",
      );
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          timeoutMs: 2_000,
          input: 'x'.repeat(16 * 1024 * 1024),
          onToken: () => undefined,
        }),
      ).rejects.toThrow('incomplete record');
    } finally {
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('reports parser-level incomplete output before a broken stdin pipe', async () => {
    repoPath = createRepo();
    const previousGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      process.env.CANOPY_GIT_EXECUTABLE = createGitExecutable(
        repoPath,
        "printf 'path\\0text\\0'",
      );
      let field = 0;
      await expect(
        streamGitNulTokens({
          repoPath,
          gitArgs: [],
          timeoutMs: 2_000,
          input: 'x'.repeat(16 * 1024 * 1024),
          onToken: () => {
            field = (field + 1) % 3;
          },
          validateComplete: () => {
            if (field !== 0) {
              throw new Error('parser returned incomplete output');
            }
          },
        }),
      ).rejects.toThrow('parser returned incomplete output');
    } finally {
      if (previousGitExecutable === undefined) {
        delete process.env.CANOPY_GIT_EXECUTABLE;
      } else {
        process.env.CANOPY_GIT_EXECUTABLE = previousGitExecutable;
      }
    }
  });

  it('retains exactly 50,000 records while counting a larger immutable tree', async () => {
    repoPath = createRepo();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoPath,
      input: 'same contents\n',
      encoding: 'utf8',
    }).trim();
    const emptyTree = execFileSync('git', ['mktree'], {
      cwd: repoPath,
      input: '',
      encoding: 'utf8',
    }).trim();
    const entries = Array.from(
      { length: 50_001 },
      (_, index) =>
        `100644 blob ${blob}\tfile-${String(index).padStart(5, '0')}.txt\0`,
    ).join('');
    const largeTree = execFileSync('git', ['mktree', '-z'], {
      cwd: repoPath,
      input: entries,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).trim();

    const result = await streamArchiveTreeDiff(repoPath, emptyTree, largeTree);

    expect(result.files).toHaveLength(50_000);
    expect(result.totalCount).toBe(50_001);
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.path).toBe('file-00000.txt');
    expect(result.files[result.files.length - 1]?.path).toBe('file-49999.txt');
  }, 60_000);
});
