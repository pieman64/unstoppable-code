import { execFile, spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  countTrackedFiles,
  listUntrackedFilesStrict,
  listWorkingTreeDiffAgainstHead,
  materializeGitCommitRaw,
  repositoryUsesGitLfs,
} from '../lib/git';
import { resolveMaterializedPath } from '../shared-containers/materialize/path-safety';

jest.mock('node:child_process', () => {
  const actual =
    jest.requireActual<typeof ChildProcessModule>('node:child_process');
  const mockedExecFile = jest.fn(actual.execFile);
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const promisifyDescriptor = Object.getOwnPropertyDescriptor(
    actual.execFile,
    promisifyCustom,
  );
  if (promisifyDescriptor) {
    Object.defineProperty(mockedExecFile, promisifyCustom, promisifyDescriptor);
  }
  return {
    ...actual,
    execFile: mockedExecFile,
    spawn: jest.fn(actual.spawn),
  };
});

const execFileAsync = promisify(execFile);
const mockedExecFile = jest.mocked(execFile);
const mockedSpawn = jest.mocked(spawn);

describe('raw shared-container Git materialization', () => {
  beforeEach(() => {
    mockedSpawn.mockClear();
  });

  it.each(['modified', 'deleted'] as const)(
    'detects committed LFS attributes when the working copy is %s',
    async (workingCopyState) => {
      const repo = await mkdtemp(join(tmpdir(), 'shared-lfs-attributes-'));
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: repo,
      });
      await execFileAsync(
        'git',
        ['config', 'user.email', 'test@example.test'],
        { cwd: repo },
      );
      const attributesPath = join(repo, '.gitattributes');
      await writeFile(
        attributesPath,
        '*.bin filter=lfs diff=lfs merge=lfs -text\n',
      );
      await execFileAsync('git', ['add', '.gitattributes'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
      if (workingCopyState === 'modified') {
        await writeFile(attributesPath, '*.txt text\n');
      } else {
        await unlink(attributesPath);
      }

      await expect(
        repositoryUsesGitLfs(repo, {
          timeoutMs: 30_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(true);
    },
  );

  it('streams stored blobs without working-tree-encoding expansion', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-git-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    const attributes = 'payload.txt working-tree-encoding=UTF-16LE\n';
    const storedPayload = Buffer.from('hello\n', 'utf8');
    await writeFile(join(repo, '.gitattributes'), attributes);
    await writeFile(
      join(repo, 'payload.txt'),
      Buffer.from('hello\n', 'utf16le'),
    );
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repo },
    );
    const output = join(repo, 'raw');
    await mkdir(output);

    const usage = await materializeGitCommitRaw(repo, commitSha.trim(), {
      maxFiles: 2,
      maxBytes: BigInt(
        Buffer.byteLength(attributes) + storedPayload.byteLength,
      ),
      resolveDestination: (path) => resolveMaterializedPath(output, path),
    });

    expect(usage).toEqual({
      fileCount: 2,
      totalBytes: BigInt(
        Buffer.byteLength(attributes) + storedPayload.byteLength,
      ),
    });
    expect(await readFile(join(output, 'payload.txt'))).toEqual(storedPayload);
    expect(
      mockedSpawn.mock.calls.filter(([, args]) => args.includes('cat-file')),
    ).toHaveLength(1);
  });

  it('prefetches promisor blobs before one batch materialization process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-raw-promisor-'));
    const remote = join(root, 'remote.git');
    const source = join(root, 'source');
    const replica = join(root, 'replica');
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init', source]);
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: source,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: source,
    });
    await writeFile(join(source, 'first.txt'), 'first');
    await writeFile(join(source, 'second.txt'), 'second');
    await execFileAsync('git', ['add', '.'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: source });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: source },
    );
    await execFileAsync('git', ['remote', 'add', 'origin', remote], {
      cwd: source,
    });
    await execFileAsync('git', ['push', 'origin', 'HEAD:main'], {
      cwd: source,
    });
    await execFileAsync('git', ['config', 'uploadpack.allowFilter', 'true'], {
      cwd: remote,
    });
    await execFileAsync(
      'git',
      ['config', 'uploadpack.allowAnySHA1InWant', 'true'],
      { cwd: remote },
    );
    await execFileAsync('git', ['init', replica]);
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', `file://${remote}`],
      { cwd: replica },
    );
    await execFileAsync(
      'git',
      ['fetch', '--depth=1', '--filter=blob:none', 'origin', commitSha.trim()],
      { cwd: replica },
    );
    const output = join(replica, 'raw');
    mockedSpawn.mockClear();

    await expect(
      materializeGitCommitRaw(replica, commitSha.trim(), {
        maxFiles: 2,
        maxBytes: BigInt(11),
        resolveDestination: (path) => resolveMaterializedPath(output, path),
      }),
    ).resolves.toEqual({ fileCount: 2, totalBytes: BigInt(11) });

    await expect(readFile(join(output, 'first.txt'), 'utf8')).resolves.toBe(
      'first',
    );
    await expect(readFile(join(output, 'second.txt'), 'utf8')).resolves.toBe(
      'second',
    );
    expect(
      mockedSpawn.mock.calls.filter(([, args]) => args.includes('cat-file')),
    ).toHaveLength(1);
  });

  it('restores an already-materialized promisor checkout without remote access', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-local-only-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'local.txt'), 'already local');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repo },
    );
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', join(repo, 'missing-remote.git')],
      { cwd: repo },
    );
    await execFileAsync('git', ['config', 'remote.origin.promisor', 'true'], {
      cwd: repo,
    });
    const output = join(repo, 'raw');
    const localOnlyOptions = {
      allowPromisorFetch: false,
      resolveDestination: (path: string): string =>
        resolveMaterializedPath(output, path),
    };
    mockedExecFile.mockClear();

    await expect(
      materializeGitCommitRaw(repo, commitSha.trim(), localOnlyOptions),
    ).resolves.toEqual({ fileCount: 1, totalBytes: BigInt(13) });
    await expect(readFile(join(output, 'local.txt'), 'utf8')).resolves.toBe(
      'already local',
    );
    expect(
      mockedExecFile.mock.calls.filter(([, args]) => args.includes('fetch')),
    ).toHaveLength(0);
  });

  it('enumerates raw UTF-8 paths and modes without C-quoting', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-status-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'café.txt'), 'before');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    await writeFile(join(repo, 'café.txt'), 'after');
    await chmod(join(repo, 'café.txt'), 0o755);
    await writeFile(join(repo, 'naïve.txt'), 'new');
    const options = {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    };

    await expect(
      listWorkingTreeDiffAgainstHead(repo, options),
    ).resolves.toEqual([
      expect.objectContaining({
        path: 'café.txt',
        status: 'M',
        dstMode: '100755',
      }),
    ]);
    await expect(listUntrackedFilesStrict(repo, options)).resolves.toEqual([
      'naïve.txt',
    ]);
    await expect(countTrackedFiles(repo, options)).resolves.toBe(1);
  });

  it('materializes committed in-repository symlinks and accounts for target bytes', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-symlink-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'target.txt'), 'target');
    await symlink('target.txt', join(repo, 'link.txt'));
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repo },
    );
    const output = join(repo, 'raw');
    await mkdir(output);

    await expect(
      materializeGitCommitRaw(repo, commitSha.trim(), {
        maxFiles: 2,
        maxBytes: BigInt(1024),
        resolveDestination: (path) => resolveMaterializedPath(output, path),
      }),
    ).resolves.toEqual({ fileCount: 2, totalBytes: BigInt(16) });
    await expect(readlink(join(output, 'link.txt'))).resolves.toBe(
      'target.txt',
    );
  });

  it('materializes a valid UTF-8 symlink target containing U+FFFD', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-symlink-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await symlink('missing-\uFFFD.txt', join(repo, 'link.txt'));
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repo },
    );
    const output = join(repo, 'raw');
    await mkdir(output);

    await expect(
      materializeGitCommitRaw(repo, commitSha.trim(), {
        maxFiles: 1,
        maxBytes: BigInt(1024),
        resolveDestination: (path) => resolveMaterializedPath(output, path),
      }),
    ).resolves.toEqual({ fileCount: 1, totalBytes: BigInt(15) });
    await expect(readlink(join(output, 'link.txt'))).resolves.toBe(
      'missing-\uFFFD.txt',
    );
  });

  it('accounts for but does not materialize an escaping committed symlink', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-symlink-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'target.txt'), 'target');
    await symlink('../outside', join(repo, 'escaping-link'));
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repo },
    );
    const output = join(repo, 'raw');
    await mkdir(output);

    await expect(
      materializeGitCommitRaw(repo, commitSha.trim(), {
        maxFiles: 2,
        maxBytes: BigInt(1024),
        resolveDestination: (path) => resolveMaterializedPath(output, path),
      }),
    ).resolves.toEqual({ fileCount: 2, totalBytes: BigInt(16) });
    await expect(readlink(join(output, 'escaping-link'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });

  it('consumes and withholds an oversized committed symlink target', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-raw-symlink-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    const oversizedTarget = `${'nested/'.repeat(10_000)}target.txt`;
    const targetPath = join(repo, 'oversized-target');
    await writeFile(targetPath, oversizedTarget);
    const { stdout: blobSha } = await execFileAsync(
      'git',
      ['hash-object', '-w', 'oversized-target'],
      { cwd: repo },
    );
    await unlink(targetPath);
    await execFileAsync(
      'git',
      [
        'update-index',
        '--add',
        '--cacheinfo',
        '120000',
        blobSha.trim(),
        'oversized-link',
      ],
      { cwd: repo },
    );
    const { stdout: treeSha } = await execFileAsync('git', ['write-tree'], {
      cwd: repo,
    });
    const { stdout: commitSha } = await execFileAsync(
      'git',
      ['commit-tree', treeSha.trim(), '-m', 'fixture'],
      { cwd: repo },
    );
    const output = join(repo, 'raw');
    await mkdir(output);

    await expect(
      materializeGitCommitRaw(repo, commitSha.trim(), {
        maxFiles: 1,
        maxBytes: BigInt(Buffer.byteLength(oversizedTarget)),
        resolveDestination: (path) => resolveMaterializedPath(output, path),
      }),
    ).resolves.toEqual({
      fileCount: 1,
      totalBytes: BigInt(Buffer.byteLength(oversizedTarget)),
    });
    await expect(
      readlink(join(output, 'oversized-link')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
});
