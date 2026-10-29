import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';
import {
  captureArchiveGit,
  deleteArchiveBranches,
  runArchiveGit,
} from '../archive/archive-git-operations';
import type { ArchiveGitCommandError } from '../archive/archive-git-operations';
import {
  measureDirectoryBytes,
  removeArchiveDirectory,
  removeArchiveTree,
  resetArchiveDirectory,
} from '../archive/archive-file-operations';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';

jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof childProcess>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return {
    ...actual,
    lstat: jest.fn(actual.lstat),
    rm: jest.fn(actual.rm),
    open: jest.fn(actual.open),
  };
});

const IDENTITY = {
  version: 1 as const,
  requestId: 'request-1',
  operationId: 'operation-1',
  projectId: 'project-1',
  containerId: 'container-1',
  expectedCreatedAt: '2026-09-21T12:00:00.000Z',
};

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('archive I/O engine', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-io-engine-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function commandEnvironment(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  async function initializeRepository(name: string): Promise<string> {
    const repository = join(root, name);
    await mkdir(repository, { recursive: true });
    git(repository, 'init', '-q', '-b', 'main');
    git(repository, 'config', 'user.email', 'test@example.com');
    git(repository, 'config', 'user.name', 'Test');
    await writeFile(join(repository, 'README.md'), `${name}\n`);
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'initial');
    return repository;
  }

  it('waits for inherited Git stdout to close before resolving output', async () => {
    const lateOutput = 'late-output-after-parent-exit';
    const descendantMarker = join(root, 'descendant-finished');
    const childScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => { writeFileSync(${JSON.stringify(descendantMarker)}, 'done'); process.stdout.write(${JSON.stringify(lateOutput)}); }, 75);`,
    ].join('\n');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    ].join('\n');
    let descendantFinishedWhenExited = false;

    await expect(
      runArchiveGit({
        git: { executable: process.execPath, env: commandEnvironment() },
        cwd: root,
        arguments: ['-e', parentScript],
        signal: new AbortController().signal,
        child: {
          started: jest.fn(),
          exited: jest.fn(() => {
            descendantFinishedWhenExited = existsSync(descendantMarker);
          }),
        },
      }),
    ).resolves.toBe(lateOutput);
    expect(descendantFinishedWhenExited).toBe(true);
  });

  it('keeps partial byte totals when a nested entry disappears mid-walk', async () => {
    const directory = join(root, 'measurement');
    const retained = join(directory, 'retained.txt');
    const vanished = join(directory, 'vanished.txt');
    await mkdir(directory, { recursive: true });
    await writeFile(retained, 'r'.repeat(17));
    await writeFile(vanished, 'v'.repeat(23));
    const originalLstat =
      jest.requireActual<typeof fsPromises>('node:fs/promises').lstat;
    const lstat = jest.mocked(fsPromises.lstat).mockImplementation((path) => {
      if (String(path) === vanished) {
        return Promise.reject(
          Object.assign(new Error('vanished'), { code: 'ENOENT' }),
        );
      }
      return originalLstat(path);
    });
    try {
      await expect(measureDirectoryBytes(directory)).resolves.toBe(17);
    } finally {
      lstat.mockImplementation(originalLstat);
    }
  });

  it('marks a timed-out Git child for transport to removal recovery', async () => {
    await expect(
      runArchiveGit({
        git: { executable: process.execPath, env: commandEnvironment() },
        cwd: root,
        arguments: ['-e', 'setInterval(() => undefined, 1_000)'],
        signal: new AbortController().signal,
        child: { started: jest.fn(), exited: jest.fn() },
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject<Partial<ArchiveGitCommandError>>({
      name: 'ArchiveGitCommandError',
      timedOut: true,
      message: 'Archive Git command timed out.',
    });
  });

  it.each([
    ['quarantine root', '.container-1.archive-quarantine'],
    ['quarantine child', '.container-1.archive-quarantine/repos/docs'],
  ])(
    'removes an archive %s and tolerates a retry after Git unregistered it',
    async (_kind, relativeCheckout) => {
      const repository = await initializeRepository('remove-repository');
      const checkout = join(root, relativeCheckout);
      const canonicalOccupant = join(root, 'container-1');
      await mkdir(dirname(checkout), { recursive: true });
      await mkdir(canonicalOccupant);
      await writeFile(join(canonicalOccupant, 'untouched.txt'), 'keep');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/archive',
        checkout,
      );
      const request = {
        ...IDENTITY,
        type: 'remove-worktree' as const,
        input: {
          git: { executable: 'git', env: commandEnvironment() },
          referenceRepoPath: repository,
          expectedRepositoryIdentity: await realpath(join(repository, '.git')),
          worktreePath: checkout,
        },
      };
      const hooks = {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      };

      await expect(
        executeArchiveIoRequest(request, new AbortController().signal, hooks),
      ).resolves.toEqual({ removed: true });
      expect(existsSync(checkout)).toBe(false);
      expect(
        await readFile(join(canonicalOccupant, 'untouched.txt'), 'utf8'),
      ).toBe('keep');

      await expect(
        executeArchiveIoRequest(request, new AbortController().signal, hooks),
      ).resolves.toEqual({ removed: true });
      expect(
        await readFile(join(canonicalOccupant, 'untouched.txt'), 'utf8'),
      ).toBe('keep');
    },
  );

  it('preserves an archived checkout when the reference repository identity changed', async () => {
    const repository = await initializeRepository('changed-identity');
    const checkout = join(root, '.container-1.archive-quarantine');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);

    await expect(
      executeArchiveIoRequest(
        {
          ...IDENTITY,
          type: 'remove-worktree',
          input: {
            git: { executable: 'git', env: commandEnvironment() },
            referenceRepoPath: repository,
            expectedRepositoryIdentity: join(
              root,
              'different-repository',
              '.git',
            ),
            worktreePath: checkout,
          },
        },
        new AbortController().signal,
        {
          progress: jest.fn(),
          child: { started: jest.fn(), exited: jest.fn() },
        },
      ),
    ).rejects.toThrow('Archive worktree repository identity changed.');
    expect(existsSync(checkout)).toBe(true);
    expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(
      checkout,
    );
  });

  (process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it)(
    'removes sealed checkout directories without changing external symlink targets',
    async () => {
      const repository = await initializeRepository('sealed-removal');
      const checkout = join(root, '.container-1.archive-quarantine');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/archive',
        checkout,
      );
      const sealed = join(checkout, '.mini-swarm', 'sealed');
      const nested = join(sealed, 'evidence');
      const outside = join(root, 'sealed-outside');
      await mkdir(nested, { recursive: true });
      await mkdir(outside);
      await writeFile(join(nested, 'archive'), 'sealed evidence');
      await writeFile(join(outside, 'keep.txt'), 'keep');
      await chmod(join(nested, 'archive'), 0o444);
      await symlink(outside, join(sealed, 'external'));
      for (const directory of [nested, sealed, outside]) {
        await chmod(directory, 0o555);
      }
      try {
        await expect(
          executeArchiveIoRequest(
            {
              ...IDENTITY,
              type: 'remove-worktree',
              input: {
                git: { executable: 'git', env: commandEnvironment() },
                referenceRepoPath: repository,
                expectedRepositoryIdentity: await realpath(
                  join(repository, '.git'),
                ),
                worktreePath: checkout,
              },
            },
            new AbortController().signal,
            {
              progress: jest.fn(),
              child: { started: jest.fn(), exited: jest.fn() },
            },
          ),
        ).resolves.toEqual({ removed: true });
        expect(existsSync(checkout)).toBe(false);
        expect(
          git(repository, 'worktree', 'list', '--porcelain'),
        ).not.toContain(checkout);
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
        expect((await fsPromises.stat(outside)).mode & 0o777).toBe(0o555);
      } finally {
        for (const directory of [sealed, nested, outside]) {
          if (existsSync(directory)) await chmod(directory, 0o755);
        }
      }
    },
  );

  it('finishes removal when Git cannot delete a dependency tree within its timeout', async () => {
    const repository = await initializeRepository('bulk-removal');
    const checkout = join(root, '.container-1.archive-quarantine');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);
    const dependencies = join(checkout, 'node_modules');
    await mkdir(dependencies);
    await writeFile(join(dependencies, 'dependency.js'), 'dependency');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(checkout, 'linked-dependency'), 'junction');
    const spawn =
      jest.requireActual<typeof childProcess>('node:child_process').spawn;
    let removalCalls = 0;
    const spawnSpy = jest
      .mocked(childProcess.spawn)
      .mockImplementation((...args) => {
        const commandArgs = args[1];
        if (
          Array.isArray(commandArgs) &&
          commandArgs[0] === 'worktree' &&
          commandArgs[1] === 'remove'
        ) {
          removalCalls += 1;
          if (existsSync(dependencies)) {
            return spawn(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              args[2],
            );
          }
        }
        return spawn(...args);
      });
    try {
      await expect(
        executeArchiveIoRequest(
          {
            ...IDENTITY,
            type: 'remove-worktree',
            input: {
              git: {
                executable: 'git',
                env: {
                  ...commandEnvironment(),
                  [brandEnvName('WORKTREE_DELETE_TIMEOUT_MS')]: '1000',
                },
              },
              referenceRepoPath: repository,
              expectedRepositoryIdentity: await realpath(
                join(repository, '.git'),
              ),
              worktreePath: checkout,
            },
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        ),
      ).resolves.toEqual({ removed: true });
      expect(removalCalls).toBe(1);
      expect(existsSync(checkout)).toBe(false);
      expect(git(repository, 'worktree', 'list', '--porcelain')).not.toContain(
        checkout,
      );
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      spawnSpy.mockImplementation(spawn);
    }
  });

  it('stops before Git removal when a junction appears during bulk cleanup', async () => {
    const repository = await initializeRepository('late-junction');
    const checkout = join(root, '.container-1.archive-quarantine');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);
    const outside = join(root, 'late-junction-target');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    const actualRm =
      jest.requireActual<typeof fsPromises>('node:fs/promises').rm;
    const rmMock = jest
      .mocked(fsPromises.rm)
      .mockImplementation(async (target, options) => {
        await actualRm(target, options);
        if (String(target) === join(checkout, 'README.md')) {
          await symlink(outside, join(checkout, 'late-link'), 'junction');
        }
      });
    try {
      await expect(
        executeArchiveIoRequest(
          {
            ...IDENTITY,
            type: 'remove-worktree',
            input: {
              git: { executable: 'git', env: commandEnvironment() },
              referenceRepoPath: repository,
              expectedRepositoryIdentity: await realpath(
                join(repository, '.git'),
              ),
              worktreePath: checkout,
            },
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        ),
      ).rejects.toThrow('Archive worktree contents changed during removal.');
      expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(
        checkout,
      );
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      rmMock.mockImplementation(actualRm);
    }
  });

  it('preserves ignored files inside a populated submodule', async () => {
    const submodule = await initializeRepository('submodule-source');
    await writeFile(join(submodule, '.gitignore'), 'build/\n');
    git(submodule, 'add', '.gitignore');
    git(submodule, 'commit', '-q', '-m', 'ignore build');
    const repository = await initializeRepository('submodule-owner');
    git(
      repository,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      submodule,
      'nested',
    );
    git(repository, 'commit', '-q', '-am', 'add submodule');
    const checkout = join(root, '.container-1.archive-quarantine');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);
    git(
      checkout,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '-q',
    );
    const ignored = join(checkout, 'nested', 'build', 'output.txt');
    await mkdir(dirname(ignored));
    await writeFile(ignored, 'retain');
    await expect(
      executeArchiveIoRequest(
        {
          ...IDENTITY,
          type: 'remove-worktree',
          input: {
            git: { executable: 'git', env: commandEnvironment() },
            referenceRepoPath: repository,
            expectedRepositoryIdentity: await realpath(
              join(repository, '.git'),
            ),
            worktreePath: checkout,
          },
        },
        new AbortController().signal,
        {
          progress: jest.fn(),
          child: { started: jest.fn(), exited: jest.fn() },
        },
      ),
    ).rejects.toThrow('populated submodule');
    expect(await readFile(ignored, 'utf8')).toBe('retain');
  });

  it('keeps a differently cased Git pointer during interrupted cleanup', async () => {
    const repository = await initializeRepository('case-pointer');
    const checkout = join(root, '.container-1.archive-quarantine');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);
    await fsPromises.rename(join(checkout, '.git'), join(checkout, '.GIT'));
    // This filesystem must resolve the lowercase Git lookup to the uppercase entry.
    if (!existsSync(join(checkout, '.git'))) return;
    const controller = new AbortController();
    const actualRm =
      jest.requireActual<typeof fsPromises>('node:fs/promises').rm;
    const rmMock = jest
      .mocked(fsPromises.rm)
      .mockImplementation(async (target, options) => {
        if (String(target) === join(checkout, 'README.md')) controller.abort();
        return actualRm(target, options);
      });
    try {
      await expect(
        executeArchiveIoRequest(
          {
            ...IDENTITY,
            type: 'remove-worktree',
            input: {
              git: { executable: 'git', env: commandEnvironment() },
              referenceRepoPath: repository,
              expectedRepositoryIdentity: await realpath(
                join(repository, '.git'),
              ),
              worktreePath: checkout,
            },
          },
          controller.signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        ),
      ).rejects.toThrow('cancelled');
      expect(existsSync(join(checkout, '.GIT'))).toBe(true);
    } finally {
      rmMock.mockImplementation(actualRm);
    }
  });

  it.each(['I/O failure', 'cancellation'])(
    'retains registration and resumes bulk cleanup after %s',
    async (failure) => {
      const repository = await initializeRepository('interrupted-removal');
      const checkout = join(root, '.container-1.archive-quarantine');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/archive',
        checkout,
      );
      const dependencies = join(checkout, 'node_modules');
      await mkdir(dependencies);
      await writeFile(join(dependencies, 'dependency.js'), 'dependency');
      const controller = new AbortController();
      const request: Extract<
        ArchiveIoOperationRequest,
        { type: 'remove-worktree' }
      > = {
        ...IDENTITY,
        type: 'remove-worktree',
        input: {
          git: { executable: 'git', env: commandEnvironment() },
          referenceRepoPath: repository,
          expectedRepositoryIdentity: await realpath(join(repository, '.git')),
          worktreePath: checkout,
        },
      };
      const hooks = {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      };
      const actualRm =
        jest.requireActual<typeof fsPromises>('node:fs/promises').rm;
      const rmMock = jest
        .mocked(fsPromises.rm)
        .mockImplementation(async (target, options) => {
          if (String(target) === dependencies) {
            if (failure === 'I/O failure')
              throw new Error('Fixture removal failed');
            controller.abort();
          }
          return actualRm(target, options);
        });
      try {
        await expect(
          executeArchiveIoRequest(request, controller.signal, hooks),
        ).rejects.toThrow(
          failure === 'I/O failure' ? 'Fixture removal failed' : 'cancelled',
        );
        expect(existsSync(join(checkout, '.git'))).toBe(true);
        expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(
          checkout,
        );
      } finally {
        rmMock.mockImplementation(actualRm);
      }
      await expect(
        executeArchiveIoRequest(request, new AbortController().signal, hooks),
      ).resolves.toEqual({ removed: true });
      expect(existsSync(checkout)).toBe(false);
    },
  );

  it.each(['locked', 'main', 'symlink', 'foreign-pointer'])(
    'preserves a %s checkout before bulk archive cleanup',
    async (kind) => {
      const repository = await initializeRepository('protected-removal');
      let checkout = join(root, '.container-1.archive-quarantine');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/archive',
        checkout,
      );
      if (kind === 'locked') git(repository, 'worktree', 'lock', checkout);
      if (kind === 'main') checkout = repository;
      const retained = join(checkout, 'README.md');
      if (kind === 'foreign-pointer') {
        const sibling = join(root, 'sibling-checkout');
        git(repository, 'worktree', 'add', '-q', '-b', 'sibling', sibling);
        await writeFile(
          join(checkout, '.git'),
          await readFile(join(sibling, '.git')),
        );
      }
      if (kind === 'symlink') {
        const link = join(root, 'linked-checkout');
        await symlink(checkout, link, 'junction');
        checkout = link;
      }
      await expect(
        executeArchiveIoRequest(
          {
            ...IDENTITY,
            type: 'remove-worktree',
            input: {
              git: { executable: 'git', env: commandEnvironment() },
              referenceRepoPath: repository,
              expectedRepositoryIdentity: await realpath(
                join(repository, '.git'),
              ),
              worktreePath: checkout,
            },
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        ),
      ).rejects.toThrow();
      expect(await readFile(retained, 'utf8')).toBe('protected-removal\n');
    },
  );

  it('removes Windows checkout junctions before archive Git removal', async () => {
    const repository = await initializeRepository('windows-junction-removal');
    const checkout = join(root, '.container-1.archive-quarantine');
    const external = join(root, 'external-target');
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'keep');
    git(repository, 'worktree', 'add', '-q', '-b', 'feature/archive', checkout);
    const junction = join(checkout, 'external-link');
    await symlink(external, junction, 'dir');
    const originalPlatform = process.platform;
    const rmMock = jest.mocked(fsPromises.rm);
    rmMock.mockClear();
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    try {
      await executeArchiveIoRequest(
        {
          ...IDENTITY,
          type: 'remove-worktree',
          input: {
            git: { executable: 'git', env: commandEnvironment() },
            referenceRepoPath: repository,
            expectedRepositoryIdentity: await realpath(
              join(repository, '.git'),
            ),
            worktreePath: checkout,
          },
        },
        new AbortController().signal,
        {
          progress: jest.fn(),
          child: { started: jest.fn(), exited: jest.fn() },
        },
      );
      expect(rmMock).toHaveBeenCalledWith(junction, {
        recursive: true,
        force: true,
      });
      expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it.each([
    ['default', undefined, 300_000],
    ['configured', '1234', 1_234],
  ])(
    'uses the %s worktree delete timeout only for archive Git removal',
    async (_kind, configured, expectedTimeout) => {
      const repository = await initializeRepository('removal-timeout');
      const checkout = join(root, '.container-1.archive-quarantine');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/archive',
        checkout,
      );
      const env = commandEnvironment();
      const timeoutEnvName = brandEnvName('WORKTREE_DELETE_TIMEOUT_MS');
      delete env[timeoutEnvName];
      if (configured !== undefined) env[timeoutEnvName] = configured;
      const timeoutSpy = jest.spyOn(global, 'setTimeout');

      try {
        await executeArchiveIoRequest(
          {
            ...IDENTITY,
            type: 'remove-worktree',
            input: {
              git: { executable: 'git', env },
              referenceRepoPath: repository,
              expectedRepositoryIdentity: await realpath(
                join(repository, '.git'),
              ),
              worktreePath: checkout,
            },
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        );
        const delays = timeoutSpy.mock.calls.map(([, delay]) => delay);
        expect(delays).toContain(expectedTimeout);
        expect(delays).toContain(60_000);
      } finally {
        timeoutSpy.mockRestore();
      }
    },
  );

  it('skips unmerged branches and atomically deletes merged branches', async () => {
    const repository = await initializeRepository('branch-delete');
    git(repository, 'switch', '-q', '-c', 'unmerged');
    await writeFile(join(repository, 'feature.txt'), 'feature\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'feature');
    const unmergedTip = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'switch', '-q', 'main');
    git(repository, 'branch', 'merged');
    const mergedTip = git(repository, 'rev-parse', 'merged');
    const repositoryIdentity = await realpath(join(repository, '.git'));
    const common = {
      git: { executable: 'git', env: commandEnvironment() },
      signal: new AbortController().signal,
      child: { started: jest.fn(), exited: jest.fn() },
    };

    await expect(
      deleteArchiveBranches({
        ...common,
        branches: [
          {
            referenceRepoPath: repository,
            expectedRepositoryIdentity: repositoryIdentity,
            branchName: 'unmerged',
            expectedTip: unmergedTip,
            mode: 'merged-only',
          },
        ],
      }),
    ).resolves.toBe(0);
    expect(
      git(repository, 'rev-parse', '--verify', 'refs/heads/unmerged'),
    ).toBe(unmergedTip);

    await expect(
      deleteArchiveBranches({
        ...common,
        branches: [
          {
            referenceRepoPath: repository,
            expectedRepositoryIdentity: repositoryIdentity,
            branchName: 'merged',
            expectedTip: mergedTip,
            mode: 'merged-only',
          },
        ],
      }),
    ).resolves.toBe(1);
    expect(() =>
      git(repository, 'rev-parse', '--verify', 'refs/heads/merged'),
    ).toThrow();
  });

  it('refuses to delete a branch checked out in another worktree', async () => {
    const repository = await initializeRepository('checked-out-branch-delete');
    const checkout = join(root, 'checked-out-worktree');
    git(repository, 'branch', 'checked-out');
    git(repository, 'worktree', 'add', '-q', checkout, 'checked-out');
    const expectedTip = git(repository, 'rev-parse', 'checked-out');
    const repositoryIdentity = await realpath(join(repository, '.git'));

    try {
      await expect(
        deleteArchiveBranches({
          git: { executable: 'git', env: commandEnvironment() },
          branches: [
            {
              referenceRepoPath: repository,
              expectedRepositoryIdentity: repositoryIdentity,
              branchName: 'checked-out',
              expectedTip,
              mode: 'force',
            },
          ],
          signal: new AbortController().signal,
          child: { started: jest.fn(), exited: jest.fn() },
        }),
      ).rejects.toThrow(/checked out/i);
      expect(
        git(repository, 'rev-parse', '--verify', 'refs/heads/checked-out'),
      ).toBe(expectedTip);
    } finally {
      git(repository, 'worktree', 'remove', '--force', checkout);
    }
  });

  it('rolls back snapshot refs when repository publication fails', async () => {
    const repository = await initializeRepository('capture-rollback');
    const snapshotRef = 'refs/app/archive-test/capture-rollback';

    await expect(
      captureArchiveGit({
        git: { executable: 'git', env: commandEnvironment() },
        stagedDescriptorPath: join(root, 'capture-rollback.json'),
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            relativePath: '.',
            referenceRepoPath: repository,
            worktreeRepoPath: repository,
            comparisonBaseBranch: 'main',
            comparisonBaseRefs: ['main'],
            snapshotRef,
          },
        ],
        signal: new AbortController().signal,
        child: { started: jest.fn(), exited: jest.fn() },
        onProgress: () => {
          throw new Error('publication failed');
        },
      }),
    ).rejects.toThrow('publication failed');
    expect(() =>
      git(repository, 'rev-parse', '--verify', snapshotRef),
    ).toThrow();
  });

  it('copies only explicitly approved payload entries', async () => {
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'payload.txt'), 'archive payload');
    const progress = jest.fn();
    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    > = {
      ...IDENTITY,
      type: 'copy-payload',
      input: {
        sourceRoots: [sourceRoot],
        destinationRoot,
        entries: [
          {
            kind: 'file',
            source: join(sourceRoot, 'payload.txt'),
            destination: join(destinationRoot, 'payload.txt'),
            missingSource: 'error',
          },
        ],
      },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress,
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).resolves.toEqual({ files: 1, directories: 0, bytes: 15 });
    await expect(
      readFile(join(destinationRoot, 'payload.txt'), 'utf8'),
    ).resolves.toBe('archive payload');
    expect(progress).toHaveBeenCalledWith('payload-copying', {
      files: 1,
      bytes: 15,
    });
  });

  it('does not materialize a contents-only destination when every child is excluded', async () => {
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const sourceDirectory = join(sourceRoot, 'repos');
    const destinationDirectory = join(destinationRoot, 'repos');
    await mkdir(join(sourceDirectory, 'managed-repo'), { recursive: true });
    await writeFile(
      join(sourceDirectory, 'managed-repo', 'README.md'),
      'managed elsewhere',
    );
    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    > = {
      ...IDENTITY,
      type: 'copy-payload',
      input: {
        sourceRoots: [sourceRoot],
        destinationRoot,
        entries: [
          {
            kind: 'directory',
            source: sourceDirectory,
            destination: destinationDirectory,
            missingSource: 'ignore',
            contentsOnly: true,
            excludeNames: ['managed-repo'],
          },
        ],
      },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).resolves.toEqual({ files: 0, directories: 1, bytes: 0 });
    await expect(realpath(destinationDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects payload destinations outside the approved archive root', async () => {
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'payload.txt'), 'x');
    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    > = {
      ...IDENTITY,
      type: 'copy-payload',
      input: {
        sourceRoots: [sourceRoot],
        destinationRoot: join(root, 'archive'),
        entries: [
          {
            kind: 'file',
            source: join(sourceRoot, 'payload.txt'),
            destination: join(root, 'outside.txt'),
            missingSource: 'error',
          },
        ],
      },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).rejects.toThrow('outside its approved root');
  });

  it('rejects payload reads through a symlinked source ancestor', async () => {
    const sourceRoot = join(root, 'source');
    const outside = join(root, 'outside-source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(sourceRoot, 'linked'), 'dir');

    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    > = {
      ...IDENTITY,
      type: 'copy-payload',
      input: {
        sourceRoots: [sourceRoot],
        destinationRoot,
        entries: [
          {
            kind: 'file',
            source: join(sourceRoot, 'linked', 'secret.txt'),
            destination: join(destinationRoot, 'secret.txt'),
            missingSource: 'error',
          },
        ],
      },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).rejects.toThrow(/symbolic link|approved root/i);
  });

  it('rejects payload writes through a symlinked destination ancestor', async () => {
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const outside = join(root, 'outside-destination');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(sourceRoot, 'payload.txt'), 'payload');
    await symlink(outside, join(destinationRoot, 'linked'), 'dir');

    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    > = {
      ...IDENTITY,
      type: 'copy-payload',
      input: {
        sourceRoots: [sourceRoot],
        destinationRoot,
        entries: [
          {
            kind: 'file',
            source: join(sourceRoot, 'payload.txt'),
            destination: join(destinationRoot, 'linked', 'payload.txt'),
            missingSource: 'error',
          },
        ],
      },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).rejects.toThrow(/symbolic link|approved root/i);
    await expect(realpath(join(outside, 'payload.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects resetting a symlinked archive directory', async () => {
    const allowedRoot = join(root, 'archives');
    const outside = join(root, 'outside-reset');
    const resetPath = join(allowedRoot, 'container');
    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, resetPath, 'dir');
    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'reset-directory' }
    > = {
      ...IDENTITY,
      type: 'reset-directory',
      input: { path: resetPath, allowedRoot, preserveNames: [] },
    };

    await expect(
      executeArchiveIoRequest(request, new AbortController().signal, {
        progress: jest.fn(),
        child: { started: jest.fn(), exited: jest.fn() },
      }),
    ).rejects.toThrow(/symbolic link|approved root/i);
    await expect(readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe(
      'keep',
    );
  });

  it('resets incomplete Windows archive files and directories while preserving recovery payloads', async () => {
    const allowedRoot = join(root, 'archives');
    const resetPath = join(allowedRoot, 'container');
    await mkdir(join(resetPath, 'attachments'), { recursive: true });
    await mkdir(join(resetPath, 'executions'), { recursive: true });
    await writeFile(join(resetPath, 'summary.json'), '{"version":1}');
    await writeFile(join(resetPath, 'attachments', 'stale.txt'), 'stale');
    const externalDependency = join(root, 'external-dependency');
    await mkdir(externalDependency);
    await writeFile(join(externalDependency, 'untouched.txt'), 'external');
    await symlink(
      externalDependency,
      join(resetPath, 'attachments', 'dependency'),
      'junction',
    );
    await writeFile(join(resetPath, 'executions', 'retained.txt'), 'keep');
    await writeFile(join(resetPath, 'git-state.staged.json'), 'keep git state');
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      await expect(
        resetArchiveDirectory({
          path: resetPath,
          allowedRoot,
          preserveNames: ['executions', 'git-state.staged.json'],
        }),
      ).resolves.toBe(2);
      expect(existsSync(join(resetPath, 'summary.json'))).toBe(false);
      expect(existsSync(join(resetPath, 'attachments'))).toBe(false);
      await expect(
        readFile(join(externalDependency, 'untouched.txt'), 'utf8'),
      ).resolves.toBe('external');
      await expect(
        readFile(join(resetPath, 'executions', 'retained.txt'), 'utf8'),
      ).resolves.toBe('keep');
      await expect(
        readFile(join(resetPath, 'git-state.staged.json'), 'utf8'),
      ).resolves.toBe('keep git state');
      await expect(
        resetArchiveDirectory({
          path: resetPath,
          allowedRoot,
          preserveNames: ['executions', 'git-state.staged.json'],
        }),
      ).resolves.toBe(0);
    } finally {
      if (platformDescriptor)
        Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  (process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it)(
    'removes sealed archive payload directories',
    async () => {
      const payload = join(root, 'payload');
      const sealed = join(payload, 'sealed');
      await mkdir(sealed, { recursive: true });
      await writeFile(join(sealed, 'archive'), 'evidence');
      await chmod(sealed, 0o555);
      try {
        await expect(
          removeArchiveDirectory({ path: payload, allowedRoot: root }),
        ).resolves.toBeUndefined();
        expect(existsSync(payload)).toBe(false);
      } finally {
        if (existsSync(sealed)) await chmod(sealed, 0o755);
      }
    },
  );

  (process.platform === 'win32' ? it.skip : it).each([
    'outside path',
    'symlink ancestor',
    'writable directory',
    'foreign owner',
  ])('does not override permission denial for %s', async (kind) => {
    const payload = join(root, 'payload');
    const outside = join(root, 'outside');
    await mkdir(payload);
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(payload, 'external'), 'junction');
    const canonicalPayload = await realpath(payload);
    const deniedDirectory =
      kind === 'outside path'
        ? outside
        : kind === 'symlink ancestor'
          ? join(canonicalPayload, 'external')
          : canonicalPayload;
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
      syscall: 'unlink',
      path: join(deniedDirectory, 'keep.txt'),
    });
    const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
    const outsideMode = (await actual.stat(outside)).mode;
    const payloadMode = (await actual.stat(payload)).mode;
    const openMock = jest.mocked(fsPromises.open).mockClear();
    const rmMock = jest
      .mocked(fsPromises.rm)
      .mockClear()
      .mockRejectedValue(denied);
    const lstatMock = jest
      .mocked(fsPromises.lstat)
      .mockClear()
      .mockImplementation(async (path) => {
        const info = await actual.lstat(path);
        if (
          kind === 'foreign owner' &&
          (String(path) === payload || String(path) === canonicalPayload)
        ) {
          info.uid = (process.getuid?.() ?? 0) + 1;
          info.mode &= ~0o200;
        }
        return info;
      });
    try {
      const removal = removeArchiveTree(
        canonicalPayload,
        canonicalPayload,
        () => Promise.resolve(),
        { maxRetries: 2 },
      );
      if (kind === 'outside path') {
        await expect(removal).rejects.toThrow(
          'Archive permission recovery target is outside its approved root.',
        );
      } else if (kind === 'symlink ancestor') {
        await expect(removal).rejects.toThrow(
          'Archive permission recovery directory cannot traverse a symbolic link.',
        );
      } else {
        await expect(removal).rejects.toBe(denied);
      }
      expect(lstatMock).toHaveBeenCalledTimes(kind === 'outside path' ? 0 : 2);
      if (kind !== 'outside path') {
        expect(lstatMock).toHaveBeenLastCalledWith(
          kind === 'symlink ancestor'
            ? join(canonicalPayload, 'external')
            : canonicalPayload,
        );
      }
      expect(openMock).not.toHaveBeenCalled();
      expect(rmMock).toHaveBeenCalledTimes(1);
      expect((await actual.stat(outside)).mode).toBe(outsideMode);
      expect((await actual.stat(payload)).mode).toBe(payloadMode);
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      rmMock.mockImplementation(actual.rm);
      lstatMock.mockImplementation(actual.lstat);
    }
  });

  (process.platform === 'win32' ? it.skip : it)(
    'never chmods a symlink substituted immediately before permission recovery opens the directory',
    async () => {
      const payload = join(root, 'payload');
      const sealed = join(payload, 'sealed');
      const retained = join(payload, 'retained');
      const outside = join(root, 'outside');
      await mkdir(sealed, { recursive: true });
      await mkdir(outside);
      await chmod(sealed, 0o555);
      await chmod(outside, 0o555);
      const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
      const denied = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
        syscall: 'unlink',
        path: join(sealed, 'archive'),
      });
      const canonicalSealed = await realpath(sealed);
      const rmMock = jest.mocked(fsPromises.rm).mockRejectedValue(denied);
      let substituted = false;
      const openMock = jest
        .mocked(fsPromises.open)
        .mockImplementation(async (...args) => {
          if (String(args[0]) === canonicalSealed) {
            substituted = true;
            await actual.rename(sealed, retained);
            await symlink(outside, sealed);
          }
          return actual.open(...args);
        });
      try {
        await expect(
          removeArchiveTree(payload, payload, () => Promise.resolve(), {
            maxRetries: 2,
          }),
        ).rejects.toMatchObject({ code: 'ELOOP' });
        expect(substituted).toBe(true);
        expect((await actual.stat(outside)).mode & 0o777).toBe(0o555);
        expect((await actual.stat(retained)).mode & 0o777).toBe(0o555);
      } finally {
        openMock.mockImplementation(actual.open);
        rmMock.mockImplementation(actual.rm);
        for (const directory of [retained, outside]) {
          if (existsSync(directory)) await chmod(directory, 0o755);
        }
      }
    },
  );

  (process.platform === 'win32' ? it.skip : it).each([
    ['remove-directory', 'denial'],
    ['reset-directory', 'denial'],
    ['remove-directory', 'open'],
    ['reset-directory', 'open'],
  ])('cancels %s permission recovery during %s', async (type, stage) => {
    const payload = join(root, 'payload');
    const sealed = join(payload, 'sealed');
    await mkdir(sealed, { recursive: true });
    await writeFile(join(sealed, 'archive'), 'keep');
    await chmod(sealed, 0o555);
    const canonicalSealed = await realpath(sealed);
    const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
    const controller = new AbortController();
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
      syscall: 'unlink',
      path: join(canonicalSealed, 'archive'),
    });
    const rmMock = jest
      .mocked(fsPromises.rm)
      .mockClear()
      .mockImplementation(() => {
        if (stage === 'denial') controller.abort();
        return Promise.reject(denied);
      });
    const openMock = jest
      .mocked(fsPromises.open)
      .mockClear()
      .mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (stage === 'open') controller.abort();
        return handle;
      });
    const request: ArchiveIoOperationRequest =
      type === 'remove-directory'
        ? {
            ...IDENTITY,
            type: 'remove-directory',
            input: { path: payload, allowedRoot: root },
          }
        : {
            ...IDENTITY,
            type: 'reset-directory',
            input: { path: payload, allowedRoot: root, preserveNames: [] },
          };
    try {
      await expect(
        executeArchiveIoRequest(request, controller.signal, {
          progress: jest.fn(),
          child: { started: jest.fn(), exited: jest.fn() },
        }),
      ).rejects.toThrow('Archive I/O request cancelled.');
      expect(rmMock).toHaveBeenCalledTimes(1);
      expect(openMock).toHaveBeenCalledTimes(stage === 'open' ? 1 : 0);
      expect((await actual.stat(sealed)).mode & 0o777).toBe(0o555);
      expect(await readFile(join(sealed, 'archive'), 'utf8')).toBe('keep');
    } finally {
      openMock.mockImplementation(actual.open);
      rmMock.mockImplementation(actual.rm);
      await chmod(sealed, 0o755);
    }
  });

  it('does not change permissions after the removal owner cancels recovery', async () => {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await chmod(payload, 0o555);
    const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
      syscall: 'unlink',
      path: join(payload, 'archive'),
    });
    const rmMock = jest.mocked(fsPromises.rm).mockRejectedValue(denied);
    const cancelled = new Error('Archive I/O request cancelled.');
    try {
      await expect(
        removeArchiveTree(payload, payload, () => Promise.reject(cancelled), {
          maxRetries: 2,
        }),
      ).rejects.toBe(process.getuid ? cancelled : denied);
      if (process.getuid)
        expect((await actual.stat(payload)).mode & 0o777).toBe(0o555);
    } finally {
      rmMock.mockImplementation(actual.rm);
      await chmod(payload, 0o755);
    }
  });

  it('rejects removing a symlinked archive directory before traversing it', async () => {
    const allowedRoot = join(root, 'archives');
    const outside = join(root, 'outside-removal');
    const nestedTarget = join(root, 'nested-target');
    const removalPath = join(allowedRoot, 'container');
    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(nestedTarget, { recursive: true });
    await writeFile(join(nestedTarget, 'keep.txt'), 'keep');
    await symlink(nestedTarget, join(outside, 'nested-link'), 'dir');
    await symlink(outside, removalPath, 'dir');

    await expect(
      removeArchiveDirectory({ path: removalPath, allowedRoot }),
    ).rejects.toThrow(/symbolic link|reparse point|approved root/i);
    await expect(
      readFile(join(nestedTarget, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await expect(realpath(join(outside, 'nested-link'))).resolves.toBe(
      await realpath(nestedTarget),
    );
  });

  it('rejects removal through a symlinked approved root', async () => {
    const outside = join(root, 'outside-removal-root');
    const allowedRoot = join(root, 'archives-link');
    const removalPath = join(allowedRoot, 'container');
    await mkdir(removalPath.replace(allowedRoot, outside), {
      recursive: true,
    });
    await writeFile(join(outside, 'container', 'keep.txt'), 'keep');
    await symlink(outside, allowedRoot, 'dir');

    await expect(
      removeArchiveDirectory({ path: removalPath, allowedRoot }),
    ).rejects.toThrow(
      /approved root.*symbolic link|symbolic link.*approved root/i,
    );
    await expect(
      readFile(join(outside, 'container', 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
  });

  it('rejects reset through a symlinked approved root', async () => {
    const outside = join(root, 'outside-reset-root');
    const allowedRoot = join(root, 'archives-reset-link');
    const resetPath = join(allowedRoot, 'container');
    await mkdir(resetPath.replace(allowedRoot, outside), { recursive: true });
    await writeFile(join(outside, 'container', 'keep.txt'), 'keep');
    await symlink(outside, allowedRoot, 'dir');

    await expect(
      resetArchiveDirectory({
        path: resetPath,
        allowedRoot,
        preserveNames: [],
      }),
    ).rejects.toThrow(
      /approved root.*symbolic link|symbolic link.*approved root/i,
    );
    await expect(
      readFile(join(outside, 'container', 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
  });

  it('persists the existing ready Git descriptor format', async () => {
    const stagedDescriptorPath = join(root, 'git-state.staged.json');
    const request: Extract<
      ArchiveIoOperationRequest,
      { type: 'complete-git-capture' }
    > = {
      ...IDENTITY,
      type: 'complete-git-capture',
      input: {
        stagedDescriptorPath,
        repositories: [],
        gitChanges: {
          status: 'unavailable',
          capturedAt: '2026-09-21T12:01:00.000Z',
        },
        pullRequestMetadata: {
          capturedAt: '2026-09-21T12:02:00.000Z',
          repositories: [],
        },
      },
    };

    await executeArchiveIoRequest(request, new AbortController().signal, {
      progress: jest.fn(),
      child: { started: jest.fn(), exited: jest.fn() },
    });

    await expect(
      readFile(stagedDescriptorPath, 'utf8').then(JSON.parse),
    ).resolves.toMatchObject({ version: 1, status: 'ready' });
  });
});
