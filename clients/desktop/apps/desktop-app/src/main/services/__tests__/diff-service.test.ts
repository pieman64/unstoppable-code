jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

// Command responses below exercise diff behavior independently of discovery.
jest.mock('../../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

jest.mock('node:fs/promises', () => ({
  realpath: jest.fn(),
}));

jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
}));

jest.mock('../../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));

jest.mock('../../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../../lib/untracked-line-estimate', () => ({
  estimateUntrackedChanges: jest.fn(() => Promise.resolve([])),
  MAX_UNTRACKED_FILES: 200,
}));

import { execFile } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { realpath } from 'node:fs/promises';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { resolveEffectiveBaseBranchForRepo } from '../../lib/worktree-base-branches';
import { isMultiRepoWorkspace } from '../../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../../lib/worktree-repo-entries';
import { estimateUntrackedChanges } from '../../lib/untracked-line-estimate';
import {
  getNullDiffSourceForPlatform,
  listChangedFileSets,
  normalizeStatus,
  readDiff,
} from '../diff-service';

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: string; stderr: string },
) => void;

const mockedExecFile = jest.mocked(execFile);
const mockedRealpath = jest.mocked(realpath);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveEffectiveBaseBranch = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

function mockGit(
  responses: Record<string, string | { stdout: string; error?: Error }>,
): void {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb?: ExecFileCallback,
  ) => {
    const key = args.join(' ');
    const unconfiguredKey =
      args[0] === '-c' && args[1] === 'core.quotePath=false'
        ? args.slice(2).join(' ')
        : key;
    const response = responses[key] ?? responses[unconfiguredKey];
    if (response === undefined) {
      cb?.(new Error(`Unexpected git command: ${key}`), {
        stdout: '',
        stderr: '',
      });
      return;
    }
    const stdout = typeof response === 'string' ? response : response.stdout;
    const error =
      typeof response === 'string' ? null : (response.error ?? null);
    if (error) {
      cb?.(error, { stdout, stderr: '' });
      return;
    }
    cb?.(null, { stdout, stderr: '' });
  }) as typeof execFile);
}

describe('Portal diff service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeCwd.mockReturnValue('/repo');
    mockedRealpath.mockImplementation((pathValue) =>
      Promise.resolve(String(pathValue)),
    );
    // No effective base by default: exercises the @{upstream} fallback the
    // pre-existing expectations below were written against.
    mockedResolveEffectiveBaseBranch.mockResolvedValue({
      branch: null,
      existsLocally: false,
      existsInRemote: false,
    });
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
  });

  it.each([
    ['DD', 'unmerged'],
    ['AU', 'unmerged'],
    ['UD', 'unmerged'],
    ['UA', 'unmerged'],
    ['DU', 'unmerged'],
    ['AA', 'unmerged'],
    ['UU', 'unmerged'],
    ['U', 'unmerged'],
    ['A', 'added'],
    ['M', 'modified'],
    ['D', 'deleted'],
    ['R100', 'renamed'],
    ['C100', 'modified'],
    ['T', 'modified'],
    ['X', 'modified'],
    ['B', 'modified'],
    ['??', 'untracked'],
  ] as const)(
    'normalizes Git status %s to %s without changing name-status mappings',
    (status, expected) => {
      expect(normalizeStatus(status)).toBe(expected);
    },
  );

  it.each(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'] as const)(
    'projects porcelain conflict status %s as unmerged in the changed-file set',
    async (status) => {
      mockGit({
        'status --porcelain=v1 --untracked-files=all': `${status} src/conflict.ts\n`,
        'diff --numstat HEAD': '',
        'rev-parse --abbrev-ref @{upstream}': '',
      });

      const result = await listChangedFileSets('ws-1', 'wt-1');

      expect(result.uncommitted).toEqual([
        expect.objectContaining({
          filePath: 'src/conflict.ts',
          status: 'unmerged',
        }),
      ]);
    },
  );

  it('reports real UU and AA merge conflicts as unmerged files', async () => {
    const actual =
      jest.requireActual<typeof ChildProcess>('node:child_process');
    const cwd = mkdtempSync(join(tmpdir(), 'portal-diff-merge-conflict-'));
    const run = (...args: string[]): void => {
      actual.execFileSync('git', args, { cwd, stdio: 'pipe' });
    };
    try {
      run('init', '-b', 'main');
      run('config', 'user.email', 'diff-test@example.invalid');
      run('config', 'user.name', 'Diff test');
      run('config', 'commit.gpgsign', 'false');
      writeFileSync(join(cwd, 'uu.txt'), 'base\n');
      run('add', '.');
      run('commit', '-m', 'base');
      run('checkout', '-b', 'feature');
      writeFileSync(join(cwd, 'uu.txt'), 'feature side\n');
      writeFileSync(join(cwd, 'aa.txt'), 'feature addition\n');
      run('add', '.');
      run('commit', '-m', 'feature changes');
      run('checkout', 'main');
      writeFileSync(join(cwd, 'uu.txt'), 'main side\n');
      writeFileSync(join(cwd, 'aa.txt'), 'main addition\n');
      run('add', '.');
      run('commit', '-m', 'main changes');
      expect(() => run('merge', 'feature')).toThrow();

      const status = actual.execFileSync('git', ['status', '--porcelain=v1'], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(status).toContain('UU uu.txt');
      expect(status).toContain('AA aa.txt');

      mockedResolveWorktreeCwd.mockReturnValue(cwd);
      mockedExecFile.mockImplementation(
        ((
          cmd: string,
          args: string[],
          options: ChildProcess.ExecFileOptions,
          callback: ExecFileCallback | null | undefined,
        ): ChildProcess.ChildProcess =>
          actual.execFile(cmd, args, options, (error, stdout, stderr) =>
            callback?.(
              error
                ? Object.assign(error, {
                    stdout: String(stdout),
                    stderr: String(stderr),
                  })
                : null,
              { stdout: String(stdout), stderr: String(stderr) },
            ),
          )) as typeof execFile,
      );

      const result = await listChangedFileSets('ws-1', 'wt-1');

      expect(result.uncommitted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filePath: 'uu.txt', status: 'unmerged' }),
          expect.objectContaining({ filePath: 'aa.txt', status: 'unmerged' }),
        ]),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves real Git patches and rosters across sources and child repositories', async () => {
    const actual =
      jest.requireActual<typeof ChildProcess>('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'portal-diff-'));
    const measurements: Record<
      string,
      { milliseconds: number; subprocesses: number }[]
    > = {};
    const outputPath = process.env.CAN3100_BENCHMARK_OUTPUT;
    try {
      for (const repo of ['root', 'child']) {
        const cwd = join(root, repo);
        mkdirSync(cwd);
        const run = (...args: string[]): void => {
          actual.execFileSync('git', args, { cwd, stdio: 'pipe' });
        };
        run('init', '-b', 'main');
        run('config', 'user.email', 'diff-test@example.invalid');
        run('config', 'user.name', 'Diff test');
        run('config', 'commit.gpgsign', 'false');
        for (let index = 0; index < 100; index++) {
          writeFileSync(join(cwd, `file-${index}.txt`), `original ${index}\n`);
        }
        writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
        run('add', '.');
        run('commit', '-m', 'base');
        run('checkout', '-b', 'feature');
        writeFileSync(join(cwd, 'file-0.txt'), 'committed marker\n');
        run('mv', 'file-1.txt', 'renamed.txt');
        run('add', '.');
        run('commit', '-m', 'feature');
        for (let index = 2; index < 100; index++) {
          writeFileSync(
            join(cwd, `file-${index}.txt`),
            `local marker ${index}\n`,
          );
        }
        writeFileSync(join(cwd, 'untracked.txt'), 'untracked marker\n');
        writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 4, 5, 6]));
      }
      mockedResolveEffectiveBaseBranch.mockResolvedValue({
        branch: 'main',
        existsLocally: true,
        existsInRemote: false,
      });
      mockedExecFile.mockImplementation(
        ((
          cmd: string,
          args: string[],
          opts: ChildProcess.ExecFileOptions,
          cb: ExecFileCallback | null | undefined,
        ): ChildProcess.ChildProcess =>
          actual.execFile(cmd, args, opts, (error, stdout, stderr) =>
            cb?.(
              error
                ? Object.assign(error, {
                    stdout: String(stdout),
                    stderr: String(stderr),
                  })
                : null,
              { stdout: String(stdout), stderr: String(stderr) },
            ),
          )) as typeof execFile,
      );
      const scenarios = [
        {
          name: 'tracked',
          path: 'file-2.txt',
          source: 'uncommitted' as const,
          marker: '+local marker 2',
        },
        {
          name: 'untracked',
          path: 'untracked.txt',
          source: 'uncommitted' as const,
          marker: '+untracked marker',
        },
        {
          name: 'committed',
          path: 'file-0.txt',
          source: 'committed' as const,
          marker: '+committed marker',
        },
        {
          name: 'multi-repo',
          path: 'file-2.txt',
          source: 'uncommitted' as const,
          repoId: 'child',
          marker: '+local marker 2',
        },
        {
          name: 'binary',
          path: 'binary.bin',
          source: 'uncommitted' as const,
          marker: 'Binary files',
        },
        {
          name: 'rename',
          source: 'committed' as const,
          marker: 'rename from file-1.txt',
        },
        {
          name: 'combined',
          source: 'combined' as const,
          marker: '+committed marker',
        },
      ];
      for (const scenario of scenarios) {
        measurements[scenario.name] = [];
        mockedResolveWorktreeCwd.mockReturnValue(
          join(root, scenario.repoId ?? 'root'),
        );
        // One warm-up, then repeated samples only when explicitly requested.
        for (
          let iteration = 0;
          iteration < (outputPath ? 21 : 2);
          iteration++
        ) {
          mockedExecFile.mockClear();
          const start = performance.now();
          const result = await readDiff({
            workspaceId: 'ws-1',
            worktreeId: 'wt-1',
            ...scenario,
          });
          const milliseconds = performance.now() - start;
          expect(result.patch).toContain(scenario.marker);
          if (scenario.source === 'uncommitted') {
            expect(result.files).toHaveLength(100);
          } else {
            expect(result.files).toContainEqual(
              expect.objectContaining({
                filePath: 'renamed.txt',
                status: 'renamed',
                previousPath: 'file-1.txt',
              }),
            );
          }
          if (iteration > 0)
            measurements[scenario.name].push({
              milliseconds,
              subprocesses: mockedExecFile.mock.calls.length,
            });
        }
      }
      if (outputPath) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(
          outputPath,
          JSON.stringify(
            {
              fixture:
                '100 tracked files, 98 modified text files, one modified binary, one untracked file; local base resolver mocked; real Git subprocesses',
              measurements,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('reads uncommitted changes without resolving committed history', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all':
        ' M src/app.ts\n M src/other.ts\n',
      'diff --numstat HEAD': '1\t0\tsrc/app.ts\n2\t0\tsrc/other.ts\n',
      'diff HEAD -- src/app.ts': '@@ local patch @@',
    });

    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      path: 'src/app.ts',
    });

    expect(result.patch).toBe('@@ local patch @@');
    // The viewer uses the entire roster to switch between files.
    expect(result.files.map((file) => file.filePath)).toEqual([
      'src/app.ts',
      'src/other.ts',
    ]);
    expect(mockedResolveEffectiveBaseBranch).not.toHaveBeenCalled();
    expect(mockedExecFile.mock.calls.map((call) => call[1])).toEqual([
      [
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ],
      ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'],
      ['diff', 'HEAD', '--', 'src/app.ts'],
    ]);
  });

  it('marks a binary file in the roster without line counts (REG-3024)', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all':
        ' M logo.png\n M src/app.ts\n',
      'diff --numstat HEAD': '-\t-\tlogo.png\n1\t0\tsrc/app.ts\n',
      'diff HEAD -- src/app.ts': '@@ local patch @@',
    });

    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      path: 'src/app.ts',
    });

    expect(result.files).toEqual([
      expect.objectContaining({ filePath: 'logo.png', binary: true }),
      expect.objectContaining({ filePath: 'src/app.ts', insertions: 1 }),
    ]);
    expect(result.files[0]).not.toHaveProperty('insertions');
  });

  it.each(['committed', 'combined'] as const)(
    'resolves the %s base once and reuses its SHA for metadata and patch',
    async (source) => {
      mockedResolveEffectiveBaseBranch.mockResolvedValue({
        branch: 'main',
        existsLocally: true,
        existsInRemote: false,
      });
      mockGit({
        'merge-base main HEAD': 'abc1234567890',
        'status --porcelain=v1 --untracked-files=all': ' M src/local.ts',
        'diff --numstat HEAD': '1\t0\tsrc/local.ts',
        'diff --name-status abc1234567890..HEAD': 'M\tsrc/app.ts',
        'diff --numstat abc1234567890..HEAD': '2\t1\tsrc/app.ts',
        [`diff ${source === 'committed' ? 'abc1234567890..HEAD' : 'abc1234567890'} -- src/app.ts`]:
          '@@ patch @@',
      });
      const result = await readDiff({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        path: 'src/app.ts',
        source,
      });
      expect(result.files).toContainEqual({
        filePath: 'src/app.ts',
        status: 'modified',
        staged: true,
        insertions: 2,
        deletions: 1,
      });
      expect(result.patch).toBe('@@ patch @@');
      expect(result.rangeLabel).toBe(
        source === 'committed' ? 'main...HEAD' : 'abc123456789..WORKTREE',
      );
      expect(mockedResolveEffectiveBaseBranch).toHaveBeenCalledTimes(1);
      const commands = mockedExecFile.mock.calls.map(([, args]) => {
        if (!Array.isArray(args)) {
          throw new Error('Expected execFile arguments');
        }
        return args.join(' ');
      });
      expect(
        commands.filter((command) => command.startsWith('merge-base ')),
      ).toEqual(['merge-base main HEAD']);
      expect(commands).toHaveLength(source === 'committed' ? 4 : 6);
      if (source === 'committed') {
        expect(
          commands.some((command) => command.includes('status --porcelain')),
        ).toBe(false);
        expect(commands).not.toContain(
          '-c core.quotePath=false diff --numstat HEAD',
        );
      }
    },
  );

  it('returns an empty committed diff without scanning local changes when no base resolves', async () => {
    mockGit({ 'rev-parse --abbrev-ref @{upstream}': '' });
    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      source: 'committed',
    });
    expect(result).toEqual({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      files: [],
      patch: '',
    });
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it('bounds multi-repository changed-file discovery to four repositories', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        repoId: `repo-${index}`,
        repoName: `Repo ${index}`,
        repoPath: `/workspace/repo-${index}`,
      })),
    );
    const held: Array<() => void> = [];
    let released = false;
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      options: ChildProcess.ExecFileOptions | null | undefined,
      callback: ExecFileCallback | null | undefined,
    ): void => {
      if (!callback) throw new Error('Missing exec callback');
      const cwd =
        options !== null &&
        typeof options === 'object' &&
        typeof options.cwd === 'string'
          ? options.cwd
          : '';
      const finish = (): void => {
        callback(null, {
          stdout: args.join(' ') === 'rev-parse --show-toplevel' ? cwd : '',
          stderr: '',
        });
      };
      if (!released) held.push(finish);
      else finish();
    }) as typeof execFile);
    const request = listChangedFileSets('ws-1', 'wt-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(held).toHaveLength(4);
    } finally {
      released = true;
      held.forEach((finish) => finish());
      await request;
    }
  });

  it('projects repo identity for same-path files in a multi-repo worktree', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'api', repoName: 'API', repoPath: '/workspace/repos/api' },
      { repoId: 'web', repoName: 'Web', repoPath: '/workspace/repos/web' },
      {
        repoId: 'payloads',
        repoName: 'Payloads',
        repoPath: '/workspace/repos/payloads',
      },
    ]);
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      options: ChildProcess.ExecFileOptions | null | undefined,
      callback: ExecFileCallback | null | undefined,
    ): void => {
      if (!callback) throw new Error('Missing exec callback');
      const key = args.join(' ');
      const cwd =
        options !== null &&
        typeof options === 'object' &&
        typeof options.cwd === 'string'
          ? options.cwd
          : '';
      const stdout =
        key === 'rev-parse --show-toplevel'
          ? cwd === '/workspace/repos/payloads'
            ? '/workspace'
            : cwd
          : key.endsWith('status --porcelain=v1 --untracked-files=all')
            ? cwd === '/workspace/repos/api'
              ? 'UU src/index.ts\n'
              : 'AA src/index.ts\n'
            : key === 'diff --numstat HEAD'
              ? '1\t0\tsrc/index.ts\n'
              : '';
      callback(null, { stdout, stderr: '' });
    }) as typeof execFile);

    const result = await listChangedFileSets('ws-1', 'wt-1');

    expect(result.uncommitted).toEqual([
      expect.objectContaining({
        filePath: 'src/index.ts',
        status: 'unmerged',
        repoId: 'api',
        repoName: 'API',
      }),
      expect.objectContaining({
        filePath: 'src/index.ts',
        status: 'unmerged',
        repoId: 'web',
        repoName: 'Web',
      }),
    ]);
  });

  it('reads a committed file diff from the branch range ahead of upstream', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse --abbrev-ref @{upstream}': 'origin/main\n',
      'merge-base origin/main HEAD': 'abc1234567890\n',
      'diff --name-status abc1234567890..HEAD': 'M\tsrc/app.ts\n',
      'diff abc1234567890..HEAD -- src/app.ts':
        'diff --git a/src/app.ts b/src/app.ts\n@@ committed @@\n',
    });

    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      path: 'src/app.ts',
      source: 'committed',
    });

    expect(result).toMatchObject({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      filePath: 'src/app.ts',
      rangeLabel: 'origin/main...HEAD',
      files: [{ filePath: 'src/app.ts', status: 'modified', staged: true }],
      patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ committed @@',
    });
  });

  it('reads a child-repo diff from the owning repo checkout', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/repos/web');
    mockGit({
      'status --porcelain=v1 --untracked-files=all': ' M src/index.ts\n',
      'diff --numstat HEAD': '1\t0\tsrc/index.ts\n',
      'rev-parse --abbrev-ref @{upstream}': '',
      'diff HEAD -- src/index.ts': 'diff --git a/src/index.ts b/src/index.ts\n',
    });

    await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: 'web',
      path: 'src/index.ts',
      source: 'uncommitted',
    });

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'web',
    );
  });

  it('reads a combined diff from the upstream merge-base through the working tree', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all': ' M src/local.ts\n',
      'rev-parse --abbrev-ref @{upstream}': 'origin/main\n',
      'merge-base origin/main HEAD': 'abc1234567890\n',
      'diff --name-status abc1234567890..HEAD': 'A\tsrc/committed.ts\n',
      'diff abc1234567890 --':
        'diff --git a/src/committed.ts b/src/committed.ts\n@@ committed @@\n' +
        'diff --git a/src/local.ts b/src/local.ts\n@@ local @@\n',
    });

    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      source: 'combined',
    });

    expect(result.rangeLabel).toBe('abc123456789..WORKTREE');
    expect(result.files.map((file) => file.filePath)).toEqual([
      'src/committed.ts',
      'src/local.ts',
    ]);
    expect(result.patch).toContain('src/committed.ts');
    expect(result.patch).toContain('src/local.ts');
  });

  it.each(['uncommitted', 'combined'] as const)(
    'includes an unmerged conflict in the %s diff roster',
    async (source) => {
      mockGit({
        'status --porcelain=v1 --untracked-files=all': 'UU src/conflict.ts\n',
        'diff --numstat HEAD': '1\t1\tsrc/conflict.ts\n',
        'rev-parse --abbrev-ref @{upstream}': 'origin/main\n',
        'merge-base origin/main HEAD': 'abc1234567890\n',
        'diff --name-status abc1234567890..HEAD': '',
        'diff --numstat abc1234567890..HEAD': '',
        'diff HEAD --': 'diff --git a/src/conflict.ts b/src/conflict.ts\n',
        'diff abc1234567890 --':
          'diff --git a/src/conflict.ts b/src/conflict.ts\n',
      });

      const result = await readDiff({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        source,
      });

      expect(result.files).toEqual([
        expect.objectContaining({
          filePath: 'src/conflict.ts',
          status: 'unmerged',
        }),
      ]);
    },
  );

  it('projects estimated line counts for untracked files, which numstat omits', async () => {
    jest
      .mocked(estimateUntrackedChanges)
      .mockImplementationOnce((_cwd, files) =>
        Promise.resolve(files.map(() => ({ insertions: 7, binary: false }))),
      );
    mockGit({
      'status --porcelain=v1 --untracked-files=all':
        ' M src/index.ts\n?? src/new.ts\n',
      'diff --numstat HEAD': '1\t0\tsrc/index.ts\n',
      'rev-parse --abbrev-ref @{upstream}': 'origin/main\n',
      'merge-base origin/main HEAD': 'abc1234567890\n',
      'diff --name-status abc1234567890..HEAD': '',
      'diff --numstat abc1234567890..HEAD': '',
    });

    const result = await listChangedFileSets('ws-1', 'wt-1');

    expect(jest.mocked(estimateUntrackedChanges)).toHaveBeenCalledWith(
      '/repo',
      ['src/new.ts'],
    );
    expect(result.uncommitted).toEqual([
      expect.objectContaining({
        filePath: 'src/index.ts',
        insertions: 1,
        deletions: 0,
      }),
      expect.objectContaining({
        filePath: 'src/new.ts',
        status: 'untracked',
        insertions: 7,
        deletions: 0,
      }),
    ]);
  });

  it('disables git path quoting before estimating non-ASCII untracked paths', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '?? src/zażółć.ts\n',
      'diff --numstat HEAD': '',
      'rev-parse --abbrev-ref @{upstream}': '',
    });

    await listChangedFileSets('ws-1', 'wt-1');

    expect(mockedExecFile).toHaveBeenCalledWith(
      expect.any(String),
      [
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ],
      expect.any(Object),
      expect.any(Function),
    );
    expect(jest.mocked(estimateUntrackedChanges)).toHaveBeenCalledWith(
      '/repo',
      ['src/zażółć.ts'],
    );
  });

  it('uses matching unquoted paths when merging tracked non-ASCII numstat', async () => {
    mockGit({
      'status --porcelain=v1 --untracked-files=all': ' M src/zażółć.ts\n',
      'diff --numstat HEAD': '4\t2\tsrc/zażółć.ts\n',
      'rev-parse --abbrev-ref @{upstream}': '',
    });

    const result = await listChangedFileSets('ws-1', 'wt-1');

    expect(mockedExecFile).toHaveBeenCalledWith(
      expect.any(String),
      ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.uncommitted).toEqual([
      expect.objectContaining({
        filePath: 'src/zażółć.ts',
        insertions: 4,
        deletions: 2,
      }),
    ]);
  });

  it('uses matching unquoted paths for committed non-ASCII changes', async () => {
    mockedResolveEffectiveBaseBranch.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '',
      'diff --numstat HEAD': '',
      'merge-base origin/develop HEAD': 'base1234567890\n',
      'diff --name-status base1234567890..HEAD': 'M\tsrc/zażółć.ts\n',
      'diff --numstat base1234567890..HEAD': '3\t1\tsrc/zażółć.ts\n',
    });

    const result = await listChangedFileSets('ws-1', 'wt-1');

    for (const args of [
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        'base1234567890..HEAD',
      ],
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--numstat',
        'base1234567890..HEAD',
      ],
    ]) {
      expect(mockedExecFile).toHaveBeenCalledWith(
        expect.any(String),
        args,
        expect.any(Object),
        expect.any(Function),
      );
    }
    expect(result.committed).toEqual([
      expect.objectContaining({
        filePath: 'src/zażółć.ts',
        insertions: 3,
        deletions: 1,
      }),
    ]);
  });

  it('caps untracked line estimation work for changed-file projections', async () => {
    const untrackedPaths = Array.from(
      { length: 201 },
      (_, index) => `generated/file-${index}.txt`,
    );
    mockGit({
      'status --porcelain=v1 --untracked-files=all': untrackedPaths
        .map((path) => `?? ${path}`)
        .join('\n'),
      'diff --numstat HEAD': '',
      'rev-parse --abbrev-ref @{upstream}': '',
    });

    await listChangedFileSets('ws-1', 'wt-1');

    expect(jest.mocked(estimateUntrackedChanges)).toHaveBeenCalledWith(
      '/repo',
      untrackedPaths.slice(0, 200),
    );
  });

  it('synthesizes an added-file patch for untracked files', async () => {
    const patch =
      'diff --git a/src/new.ts b/src/new.ts\n' +
      'new file mode 100644\n' +
      '@@ untracked @@\n';
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '?? src/new.ts\n',
      'rev-parse --abbrev-ref @{upstream}': 'origin/main\n',
      'merge-base origin/main HEAD': 'abc1234567890\n',
      'diff --name-status abc1234567890..HEAD': '',
      'diff --numstat HEAD': '',
      'diff --numstat abc1234567890..HEAD': '',
      'diff --no-index -- /dev/null src/new.ts': {
        stdout: patch,
        error: Object.assign(new Error('diff exit 1'), { stdout: patch }),
      },
    });

    const result = await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      path: 'src/new.ts',
      source: 'uncommitted',
    });

    expect(result.files).toEqual([
      { filePath: 'src/new.ts', status: 'untracked', staged: false },
    ]);
    expect(result.patch).toBe(patch.trimEnd());
    expect(jest.mocked(estimateUntrackedChanges)).not.toHaveBeenCalled();
  });

  it('diffs committed files against the effective base branch, not @{upstream}', async () => {
    // After `git push -u origin <branch>` the upstream is the branch's OWN
    // remote ref, so an upstream-based diff collapses to zero even though the
    // branch carries commits vs its base. The committed set must use the same
    // effective-base resolution the sidebar diff-stats pill uses.
    mockedResolveEffectiveBaseBranch.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '',
      'diff --numstat HEAD': '',
      'merge-base origin/develop HEAD': 'base1234567890\n',
      'diff --name-status base1234567890..HEAD': 'M\tsrc/app.ts\n',
      'diff --numstat base1234567890..HEAD': '10\t2\tsrc/app.ts\n',
    });

    const result = await listChangedFileSets('ws-1', 'wt-1');

    expect(mockedResolveEffectiveBaseBranch).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoPath: '/repo',
      allowRemoteLookup: false,
    });
    expect(result.uncommitted).toEqual([]);
    expect(result.committed).toEqual([
      {
        filePath: 'src/app.ts',
        status: 'modified',
        staged: true,
        insertions: 10,
        deletions: 2,
      },
    ]);
  });

  it('resolves every committed base without asking a remote', async () => {
    // A Portal worktree snapshot lists these inline in the desktop's serial
    // command loop. A remote default-branch lookup (`git ls-remote`) that
    // waits on a credential helper would stall every later Portal command,
    // so listing and reading committed changes use local branch data only.
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'api', repoName: 'API', repoPath: '/workspace/repos/api' },
      { repoId: 'web', repoName: 'Web', repoPath: '/workspace/repos/web' },
    ]);
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      options: ChildProcess.ExecFileOptions | null | undefined,
      callback: ExecFileCallback | null | undefined,
    ): void => {
      if (!callback) throw new Error('Missing exec callback');
      const cwd =
        options !== null &&
        typeof options === 'object' &&
        typeof options.cwd === 'string'
          ? options.cwd
          : '';
      callback(null, {
        stdout: args.join(' ') === 'rev-parse --show-toplevel' ? cwd : '',
        stderr: '',
      });
    }) as typeof execFile);

    await listChangedFileSets('ws-1', 'wt-1');
    mockedResolveWorktreeCwd.mockReturnValue('/workspace/repos/api');
    // The stubbed git output gives the read nothing to diff, so it may reject;
    // only how it resolves its committed base is under test here.
    await readDiff({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: 'api',
      path: 'src/index.ts',
      source: 'committed',
    }).catch(() => undefined);

    expect(mockedResolveEffectiveBaseBranch.mock.calls).toEqual([
      [
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'api',
          repoPath: '/workspace/repos/api',
          allowRemoteLookup: false,
        },
      ],
      [
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'web',
          repoPath: '/workspace/repos/web',
          allowRemoteLookup: false,
        },
      ],
      [
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'api',
          repoPath: '/workspace/repos/api',
          allowRemoteLookup: false,
        },
      ],
    ]);
  });

  it('falls back to a local-only effective base branch', async () => {
    mockedResolveEffectiveBaseBranch.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: false,
    });
    mockGit({
      'status --porcelain=v1 --untracked-files=all': '',
      'diff --numstat HEAD': '',
      'merge-base develop HEAD': 'base1234567890\n',
      'diff --name-status base1234567890..HEAD': 'A\tsrc/new.ts\n',
      'diff --numstat base1234567890..HEAD': '5\t0\tsrc/new.ts\n',
    });

    const result = await listChangedFileSets('ws-1', 'wt-1');

    expect(result.committed).toEqual([
      {
        filePath: 'src/new.ts',
        status: 'added',
        staged: true,
        insertions: 5,
        deletions: 0,
      },
    ]);
  });

  it('selects the host null device for no-index diffs', () => {
    expect(getNullDiffSourceForPlatform('win32')).toBe('NUL');
    expect(getNullDiffSourceForPlatform('darwin')).toBe('/dev/null');
  });

  it('rejects Windows absolute diff paths instead of treating them as repo-relative', async () => {
    await expect(
      readDiff({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        path: 'C:\\Users\\test\\repo\\src\\app.ts',
        source: 'uncommitted',
      }),
    ).rejects.toThrow('Diff path must be relative.');
  });
});
