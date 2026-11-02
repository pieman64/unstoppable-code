import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ExecCallback = (
  error: (Error & { code?: number; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;
const mockRuns: {
  match: (args: string[], env: NodeJS.ProcessEnv) => boolean;
  code: number;
  stdout?: string;
  stderr?: string;
}[] = [];
jest.mock('node:child_process', () => ({
  execFile: jest.fn(
    (
      _file: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
      callback: ExecCallback,
    ) => {
      const run = mockRuns.find((candidate) =>
        candidate.match(args, options.env),
      );
      if (!run) {
        callback(Object.assign(new Error('spawn failed'), {}), '', '');
        return;
      }
      if (run.code === 0) callback(null, run.stdout ?? '', run.stderr ?? '');
      else
        callback(
          Object.assign(new Error('git failed'), {
            code: run.code,
            killed: false,
          }),
          run.stdout ?? '',
          run.stderr ?? '',
        );
    },
  ),
}));
jest.mock('../git-executable', () => ({
  getResolvedGitExecutableForSpawn: jest.fn(() => Promise.resolve('git')),
}));
/**
 * lstat results for paths no test can create, such as mount points: an errno
 * code, or a stat-like entry.
 */
const mockLstat = new Map<string, object | string>();
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    lstat: jest.fn((path: string) => {
      const mocked = mockLstat.get(path);
      if (typeof mocked === 'string')
        return Promise.reject(
          Object.assign(new Error(mocked), { code: mocked }),
        );
      if (mocked) return Promise.resolve(mocked);
      return actual.lstat(path);
    }),
  };
});

import {
  classifyWorktreeSource,
  isGitUsable,
  readUncommittedChanges,
  sourcePathStep,
  type SourcePathStep,
} from '../worktree-source-classification';

/** A stat-like entry of one kind, as `lstat` reports it (a junction lstats as a link). */
function entryOf(
  kind:
    | 'directory'
    | 'symlink'
    | 'file'
    | 'fifo'
    | 'socket'
    | 'char'
    | 'block'
    | 'none',
): Pick<
  Stats,
  | 'dev'
  | 'isDirectory'
  | 'isSymbolicLink'
  | 'isFile'
  | 'isFIFO'
  | 'isSocket'
  | 'isCharacterDevice'
  | 'isBlockDevice'
> {
  return {
    dev: 1,
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
    isFile: () => kind === 'file',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
    isCharacterDevice: () => kind === 'char',
    isBlockDevice: () => kind === 'block',
  };
}

const ceiling = (env: NodeJS.ProcessEnv): boolean =>
  env.GIT_CEILING_DIRECTORIES !== undefined;
const revParse = (args: string[]): boolean => args[0] === 'rev-parse';
const NOT_A_REPO =
  'fatal: not a git repository (or any of the parent directories): .git\n';

let dir: string;
beforeEach(() => {
  mockRuns.length = 0;
  mockLstat.clear();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'source-class-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CAN-5334 source classification', () => {
  describe('the first step for what lstat finds (review r3 finding 1 family)', () => {
    it.each([
      ['a directory', { stats: entryOf('directory') }, 'probe-git'],
      ['a symlink', { stats: entryOf('symlink') }, 'probe-git'],
      [
        'a junction (a link to lstat)',
        { stats: entryOf('symlink') },
        'probe-git',
      ],
      ['a regular file', { stats: entryOf('file') }, 'not-a-repository'],
      ['a FIFO', { stats: entryOf('fifo') }, 'not-a-repository'],
      ['a socket', { stats: entryOf('socket') }, 'not-a-repository'],
      ['a character device', { stats: entryOf('char') }, 'not-a-repository'],
      ['a block device', { stats: entryOf('block') }, 'not-a-repository'],
      ['an entry of no known kind', { stats: entryOf('none') }, 'unverified'],
      ['ENOENT', { errorCode: 'ENOENT' }, 'check-absent'],
      [
        'ENOTDIR (an ancestor is no directory)',
        { errorCode: 'ENOTDIR' },
        'check-absent',
      ],
      ['EACCES', { errorCode: 'EACCES' }, 'unverified'],
      ['EPERM', { errorCode: 'EPERM' }, 'unverified'],
      ['ELOOP', { errorCode: 'ELOOP' }, 'unverified'],
      ['EIO', { errorCode: 'EIO' }, 'unverified'],
      ['an error with no code', { errorCode: undefined }, 'unverified'],
    ] as const)('%s: %p', (_label, entry, step: SourcePathStep) => {
      expect(sourcePathStep(entry)).toBe(step);
    });

    it.each([
      ['a FIFO', 'fifo'],
      ['a socket', 'socket'],
    ] as const)(
      '%s at the source path is not a repository, so gone',
      async (_label, kind) => {
        mockLstat.set(join(dir, 'repo'), entryOf(kind));
        await expect(
          classifyWorktreeSource(join(dir, 'repo')),
        ).resolves.toEqual({
          state: 'gone-not-a-repository',
        });
      },
    );

    it.each([
      ['directly', ['repo']],
      ['deeper', ['nested', 'repo']],
    ] as const)(
      'a source under a regular file (%s) is absent, so gone',
      async (_label, rest) => {
        writeFileSync(join(dir, 'blocker'), 'not a directory');
        await expect(
          classifyWorktreeSource(join(dir, 'blocker', ...rest)),
        ).resolves.toEqual({ state: 'gone-absent' });
      },
    );

    it.each(['EPERM', 'ELOOP'])(
      'a source lstat refuses with %s is unverified',
      async (code) => {
        mockLstat.set(join(dir, 'repo'), code);
        await expect(
          classifyWorktreeSource(join(dir, 'repo')),
        ).resolves.toEqual({
          state: 'unverified',
        });
      },
    );
  });

  it('Git that fails to run proves nothing', async () => {
    mockRuns.push({ match: (args) => args[0] === '--version', code: 1 });
    await expect(isGitUsable()).resolves.toBe(false);
    mockRuns.length = 0;
    mockRuns.push({
      match: (args) => args[0] === '--version',
      code: 0,
      stdout: 'git version 2.50.0\n',
    });
    await expect(isGitUsable()).resolves.toBe(true);
  });

  it('an absent path under an existing ordinary directory is gone', async () => {
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'gone-absent',
    });
  });

  it.each([
    ['/Volumes/canopy-no-such-volume/repo'],
    ['/media/canopy-no-such-user/drive/repo'],
    ['/mnt/canopy-no-such-mount/repo'],
  ])(
    'an absent path under a missing mount root (%s) is unverified (Q2 B)',
    async (path) => {
      if (process.platform === 'win32') return;
      await expect(classifyWorktreeSource(path)).resolves.toEqual({
        state: 'unverified',
      });
    },
  );

  it.each([
    ['unmounted (on its parent device): unverified', 1, 'unverified'],
    ['mounted (its own device): gone', 2, 'gone-absent'],
  ] as const)(
    'an absent path under an existing mount point that is %s',
    async (_label, mountDevice, state) => {
      if (process.platform === 'win32') return;
      mockLstat.set('/mnt/canopy-mount/repo', 'ENOENT');
      mockLstat.set('/mnt/canopy-mount', { dev: mountDevice });
      mockLstat.set('/mnt', { dev: 1 });
      await expect(
        classifyWorktreeSource('/mnt/canopy-mount/repo'),
      ).resolves.toEqual({ state });
    },
  );

  it('reads uncommitted changes without Git optional locks, so describe never writes the index', async () => {
    mockRuns.push({
      match: (args) =>
        args[0] === '--no-optional-locks' && args.includes('status'),
      code: 0,
      stdout: ' M file.txt\n',
    });
    await expect(readUncommittedChanges(dir)).resolves.toBe(true);
  });

  it('a relative path is unverified', async () => {
    await expect(classifyWorktreeSource('repo')).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('a directory Git calls no repository, with or without its parents, is gone', async () => {
    mkdirSync(join(dir, 'repo'));
    mockRuns.push({ match: revParse, code: 128, stderr: NOT_A_REPO });
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'gone-not-a-repository',
    });
  });

  it('a regular file at the source path is not a repository, so gone', async () => {
    writeFileSync(join(dir, 'repo'), 'not a checkout');
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'gone-not-a-repository',
    });
  });

  it('a symlink at the source path is unverified, even to a regular file', async () => {
    if (process.platform === 'win32') return;
    writeFileSync(join(dir, 'target'), 'not a checkout');
    symlinkSync(join(dir, 'target'), join(dir, 'repo'));
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('a source path that cannot be inspected is unverified', async () => {
    mockLstat.set(join(dir, 'repo'), 'EACCES');
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('a directory inside an enclosing repository is unverified', async () => {
    mkdirSync(join(dir, 'repo'));
    mockRuns.push(
      {
        match: (args, env) => revParse(args) && ceiling(env),
        code: 128,
        stderr: NOT_A_REPO,
      },
      {
        match: (args, env) => revParse(args) && !ceiling(env),
        code: 0,
        stdout: `${dir}/.git\n`,
      },
    );
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'unverified',
    });
  });

  it.each([
    [
      'dubious ownership',
      "fatal: detected dubious ownership in repository at '/x'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /x\n",
      128,
    ],
    ['another fatal error', 'fatal: unable to read config\n', 128],
    ['another exit status', '', 1],
  ])('%s is unverified', async (_label, stderr, code) => {
    mkdirSync(join(dir, 'repo'));
    mockRuns.push({ match: revParse, code, stderr });
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('a spawn failure is unverified', async () => {
    mkdirSync(join(dir, 'repo'));
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('a repository is available with its real common directory', async () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mockRuns.push({ match: revParse, code: 0, stdout: '.git\n' });
    await expect(classifyWorktreeSource(join(dir, 'repo'))).resolves.toEqual({
      state: 'available',
      gitCommonDir: join(dir, 'repo', '.git'),
    });
  });
});
