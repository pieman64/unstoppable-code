import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerGitBranch } from '@canopy/protocol/canopy-core';
import {
  buildGitBranchList,
  GIT_BRANCH_LIST_REF_ARGS,
  listGitBranches,
  occupiedGitWorktreeBranches,
  parseGitWorktreeListPorcelain,
} from '../branch-list';

const PORCELAIN = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo-feature',
  'HEAD def456',
  'branch refs/heads/feature/foo',
  '',
  'worktree /repo-detached',
  'HEAD 0123456',
  'detached',
  '',
].join('\n');

describe('parseGitWorktreeListPorcelain', () => {
  it('reads every checkout with its local branch, if any', () => {
    expect(parseGitWorktreeListPorcelain(PORCELAIN)).toEqual([
      { worktreePath: '/repo', branchName: 'main' },
      { worktreePath: '/repo-feature', branchName: 'feature/foo' },
      { worktreePath: '/repo-detached', branchName: null },
    ]);
  });

  it('commits the last entry without a trailing blank line', () => {
    expect(
      parseGitWorktreeListPorcelain('worktree /a\nbranch refs/heads/x'),
    ).toEqual([{ worktreePath: '/a', branchName: 'x' }]);
  });

  it('ignores non-local branch refs and empty output', () => {
    expect(
      parseGitWorktreeListPorcelain(
        'worktree /a\nbranch refs/remotes/origin/x\n',
      ),
    ).toEqual([{ worktreePath: '/a', branchName: null }]);
    expect(parseGitWorktreeListPorcelain('')).toEqual([]);
  });
});

describe('occupiedGitWorktreeBranches', () => {
  it('excludes the selected checkout and detached checkouts', () => {
    expect(
      occupiedGitWorktreeBranches(
        parseGitWorktreeListPorcelain(PORCELAIN),
        '/repo-feature',
      ),
    ).toEqual(new Set(['main']));
  });
});

// The base `listBranches` loop over `%(refname:short)%(HEAD)`, unchanged.
function baseListedBranches(
  output: string,
  occupiedBranches: ReadonlySet<string>,
): WorkerGitBranch[] {
  const branchesByName = new Map<string, WorkerGitBranch>();
  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const isCurrent = rawLine.endsWith('*');
    const shortRefName = isCurrent
      ? rawLine.slice(0, -1).trim()
      : rawLine.trim();
    if (!shortRefName || shortRefName === 'origin/HEAD') continue;
    const isRemote = shortRefName.startsWith('origin/');
    const branchName = isRemote
      ? shortRefName.slice('origin/'.length)
      : shortRefName;
    if (!branchName) continue;
    const existingEntry = branchesByName.get(branchName);
    const nextEntry: WorkerGitBranch = {
      name: branchName,
      isRemote: false,
      isCurrent:
        (existingEntry?.isCurrent ?? false) || (!isRemote && isCurrent),
      isUsedByWorktree: occupiedBranches.has(branchName),
      hasLocalRef: (existingEntry?.hasLocalRef ?? false) || !isRemote,
      hasRemoteRef: (existingEntry?.hasRemoteRef ?? false) || isRemote,
    };
    nextEntry.isRemote = nextEntry.hasRemoteRef && !nextEntry.hasLocalRef;
    branchesByName.set(branchName, nextEntry);
  }
  return Array.from(branchesByName.values());
}

describe('buildGitBranchList', () => {
  it("keeps today's short names for shadowed refs and skips origin/HEAD", () => {
    // Base listing: Git's `%(refname:short)`, remote when it starts with
    // `origin/`. Tags and the local `origin/both` shadow branches, so Git
    // qualifies their short names, and the local `origin/local` reads as the
    // remote `local`. Git 2.55 shortens origin/HEAD to `origin`, which the
    // base listed as a local branch; the full refname skips it on every Git.
    const root = mkdtempSync(join(tmpdir(), 'branch-list-'));
    const repo = join(root, 'repo');
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '');
    // Isolated from user config and from hook-inherited GIT_DIR/GIT_INDEX_FILE.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
    };
    const git = (args: readonly string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    try {
      mkdirSync(repo);
      git(['init', '-q', '-b', 'main']);
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'initial',
      ]);
      git(['branch', 'feature/foo']);
      git(['branch', 'origin/local']);
      git(['branch', 'origin/both']);
      git(['tag', 'main']);
      git(['tag', 'origin/remote-only']);
      for (const name of ['main', 'feature/foo', 'remote-only', 'both'])
        git(['update-ref', `refs/remotes/origin/${name}`, 'HEAD']);
      git(['update-ref', 'refs/remotes/upstream/other', 'HEAD']);
      git([
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ]);
      const local = (name: string, overrides: object = {}): object => ({
        name,
        isRemote: false,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: true,
        hasRemoteRef: false,
        ...overrides,
      });
      const remote = (name: string): object => ({
        name,
        isRemote: true,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: false,
        hasRemoteRef: true,
      });
      expect(
        buildGitBranchList(
          git(GIT_BRANCH_LIST_REF_ARGS),
          new Set(['feature/foo']),
          'main',
        ),
      ).toEqual([
        local('heads/main', { isCurrent: true }),
        remote('main'),
        local('feature/foo', { isUsedByWorktree: true, hasRemoteRef: true }),
        local('heads/origin/both'),
        remote('local'),
        local('remotes/origin/both'),
        local('remotes/origin/remote-only'),
      ]);

      // Oracle: the base parser over the base's ref read on this Git, minus
      // the origin/HEAD line, so CI's Git proves equality too.
      const originHeadShortName = git([
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes/origin/HEAD',
      ]).trim();
      expect(originHeadShortName).not.toBe('');
      const baseOutput = git([
        'for-each-ref',
        '--format=%(refname:short)%(HEAD)',
        'refs/heads/',
        'refs/remotes/origin/',
      ])
        .split('\n')
        .filter(
          (line) => line.replace(/\*$/, '').trim() !== originHeadShortName,
        )
        .join('\n');
      const byName = (left: WorkerGitBranch, right: WorkerGitBranch): number =>
        left.name.localeCompare(right.name);
      expect(
        buildGitBranchList(
          git(GIT_BRANCH_LIST_REF_ARGS),
          new Set(['feature/foo']),
          'main',
        ).sort(byName),
      ).toEqual(
        baseListedBranches(baseOutput, new Set(['feature/foo'])).sort(byName),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const refs = [
    'refs/heads/main\tmain ',
    'refs/heads/feature/foo\tfeature/foo*',
    'refs/remotes/origin/main\torigin/main ',
    'refs/remotes/origin/feature/foo\torigin/feature/foo ',
    'refs/remotes/origin/remote-only\torigin/remote-only ',
    'refs/remotes/origin/HEAD\torigin/HEAD ',
    '',
  ].join('\n');

  it('merges local and origin refs and orders current, default, then name', () => {
    expect(buildGitBranchList(refs, new Set(['main']), 'main')).toEqual([
      {
        name: 'feature/foo',
        isRemote: false,
        isCurrent: true,
        isUsedByWorktree: false,
        hasLocalRef: true,
        hasRemoteRef: true,
      },
      {
        name: 'main',
        isRemote: false,
        isCurrent: false,
        isUsedByWorktree: true,
        hasLocalRef: true,
        hasRemoteRef: true,
      },
      {
        name: 'remote-only',
        isRemote: true,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: false,
        hasRemoteRef: true,
      },
    ]);
  });

  it('keeps the field order of the legacy response', () => {
    const [entry] = buildGitBranchList(
      'refs/heads/main\tmain*\n',
      new Set(),
      null,
    );
    expect(Object.keys(entry ?? {})).toEqual([
      'name',
      'isRemote',
      'isCurrent',
      'isUsedByWorktree',
      'hasLocalRef',
      'hasRemoteRef',
    ]);
  });

  it('promotes the default branch above other names but never above current', () => {
    expect(
      buildGitBranchList(
        'refs/heads/alpha\talpha \nrefs/heads/zeta\tzeta*\nrefs/remotes/origin/trunk\torigin/trunk \n',
        new Set(),
        'trunk',
      ).map((branch) => branch.name),
    ).toEqual(['zeta', 'trunk', 'alpha']);
  });

  it('skips origin/HEAD under either short name, blank lines and empty names', () => {
    expect(
      buildGitBranchList(
        [
          '',
          '  ',
          'refs/remotes/origin/HEAD\torigin ',
          'refs/remotes/origin/HEAD\torigin/HEAD ',
          // Qualified when a local origin/HEAD branch shadows it.
          'refs/remotes/origin/HEAD\tremotes/origin/HEAD ',
          // Base parity: the base skipped this short name for any ref.
          'refs/heads/origin/HEAD\torigin/HEAD ',
          'refs/remotes/origin/\torigin/ ',
          'refs/heads/\t*',
        ].join('\n'),
        new Set(),
        null,
      ),
    ).toEqual([]);
  });

  it('ignores lines without the refname field', () => {
    expect(
      buildGitBranchList('main*\nrefs/heads/main \n', new Set(), null),
    ).toEqual([]);
  });

  it('never marks a remote-only ref current', () => {
    expect(
      buildGitBranchList(
        'refs/remotes/origin/main\torigin/main*\n',
        new Set(),
        null,
      ),
    ).toEqual([
      {
        name: 'main',
        isRemote: true,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: false,
        hasRemoteRef: true,
      },
    ]);
  });
});

describe('listGitBranches', () => {
  it('runs the three reads concurrently and returns the default untouched', async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listing = listGitBranches(
      {
        readBranchRefs: async () => {
          started.push('refs');
          await gate;
          return 'refs/heads/main\tmain*\nrefs/heads/feature\tfeature \n';
        },
        readWorktreeList: async () => {
          started.push('worktrees');
          await gate;
          return {
            output:
              'worktree /repo\nbranch refs/heads/main\n\nworktree /other\nbranch refs/heads/feature\n',
            checkoutPath: '/repo',
          };
        },
        resolveDefaultBranch: async () => {
          started.push('default');
          await gate;
          return { defaultBranch: 'feature', source: 'remote' };
        },
      },
      (selection) => selection.defaultBranch,
    );
    expect(started).toEqual(['refs', 'worktrees', 'default']);
    release();
    await expect(listing).resolves.toEqual({
      branches: [
        expect.objectContaining({ name: 'main', isCurrent: true }),
        expect.objectContaining({ name: 'feature', isUsedByWorktree: true }),
      ],
      defaultBranch: { defaultBranch: 'feature', source: 'remote' },
    });
  });

  it('reports no occupied branches when the worktree listing fails', async () => {
    await expect(
      listGitBranches(
        {
          readBranchRefs: () => Promise.resolve('refs/heads/main\tmain*\n'),
          readWorktreeList: () => Promise.reject(new Error('broken')),
          resolveDefaultBranch: () => Promise.resolve(null),
        },
        (value) => value,
      ),
    ).resolves.toEqual({
      branches: [expect.objectContaining({ isUsedByWorktree: false })],
      defaultBranch: null,
    });
  });

  it('fails only when the ref read fails', async () => {
    const failure = new Error('not a git repository');
    await expect(
      listGitBranches(
        {
          readBranchRefs: () => Promise.reject(failure),
          readWorktreeList: () =>
            Promise.resolve({ output: '', checkoutPath: '/repo' }),
          resolveDefaultBranch: () => Promise.resolve(null),
        },
        (value) => value,
      ),
    ).rejects.toBe(failure);
  });
});
