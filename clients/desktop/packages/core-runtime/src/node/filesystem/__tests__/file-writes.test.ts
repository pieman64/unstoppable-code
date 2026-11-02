import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryCreateParams,
  type WorkerFilesystemFileWriteParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { filesystemScopeError } from '../scope-reader';
import type { FilesystemEntryRoot } from '../entry-mutation-guards';
import type { FilesystemEntryMutationHost } from '../entry-mutations';
import {
  createFilesystemDirectory,
  normalizeFileCreatePath,
  writeFilesystemFile,
  type FilesystemFileWriteIo,
} from '../file-writes';

const WRITE =
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.file.write'
  ];
const CREATE =
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.directory.create'
  ];

const itPosix = process.platform === 'win32' ? it.skip : it;
const hostOs = process.platform === 'win32' ? 'win32' : 'darwin';
const OLD_TIME = new Date('2020-01-02T03:04:05.000Z');

let tempRoot = '';
let repo = '';
let outside = '';
const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await utimes(path, OLD_TIME, OLD_TIME);
}

type TestHost = FilesystemEntryMutationHost & { calls: string[] };

function host(
  overrides: Partial<FilesystemEntryMutationHost> = {},
  roots: () => FilesystemEntryRoot[] = () => [
    {
      fileRootId: 'repo',
      absolutePath: repo,
      excludedDescendantRoots: [join(repo, 'child')],
    },
    {
      fileRootId: 'child',
      absolutePath: join(repo, 'child'),
      excludedDescendantRoots: [],
    },
  ],
): TestHost {
  const calls: string[] = [];
  return {
    os: hostOs,
    assertMutable: (): void => {
      calls.push('assertMutable');
    },
    roots: (): Promise<FilesystemEntryRoot[]> => {
      calls.push('roots');
      return Promise.resolve(roots());
    },
    admitWrite: async <Result>(
      _scope: CanopyWorkspaceScope,
      run: () => Promise<Result>,
    ): Promise<Result> => {
      calls.push('admit');
      try {
        return await run();
      } finally {
        calls.push('release');
      }
    },
    beforeReplace: (): Promise<void> => {
      calls.push('beforeReplace');
      return Promise.resolve();
    },
    ...overrides,
    calls,
  };
}

function version(stats: { size: number; mtimeMs: number }): string {
  return `${stats.size}:${Math.round(stats.mtimeMs)}`;
}

async function versionOf(path: string): Promise<string> {
  return version(await stat(path));
}

type ReplaceParams = Extract<
  WorkerFilesystemFileWriteParams,
  { createOnly: false }
>;

function replace(
  relativePath: string,
  content: string | null,
  expectedVersion: string,
  changes: Partial<ReplaceParams> = {},
): ReplaceParams {
  return {
    scope,
    fileRootId: 'repo',
    relativePath,
    content,
    createOnly: false,
    expectedVersion,
    _meta: { idempotencyKey: 'key-1' },
    ...changes,
  };
}

function create(
  relativePath: string,
  content = '',
  fileRootId = 'repo',
): WorkerFilesystemFileWriteParams {
  return {
    scope,
    fileRootId,
    relativePath,
    content,
    createOnly: true,
    _meta: { idempotencyKey: 'key-1' },
  };
}

function directory(
  relativePath: string,
  createParents = true,
  fileRootId = 'repo',
): WorkerFilesystemDirectoryCreateParams {
  return {
    scope,
    fileRootId,
    relativePath,
    createParents,
    expectedAbsent: true,
    _meta: { idempotencyKey: 'key-1' },
  };
}

async function failure(
  promise: Promise<unknown>,
  definition: typeof WRITE | typeof CREATE = WRITE,
): Promise<{ error: CanopyOperationError; cause: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a CanopyOperationError, got ${String(error)}`);
  // The dispatcher forwards only errors its definition declares.
  expect(definition.error.safeParse(error.payload).success).toBe(true);
  expect(error.payload.retry.kind).not.toBe('same_idempotency_key');
  return { error, cause: error.runtimeCause };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'file-writes-')));
  repo = join(tempRoot, 'repo');
  outside = join(tempRoot, 'outside');
  await put(join(repo, 'src', 'index.ts'), 'export {};\n');
  await put(join(repo, 'child', 'child.txt'), 'child\n');
  await put(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('worker.filesystem.file.write replace', () => {
  const file = (): string => join(repo, 'src', 'index.ts');

  it('writes in place under the exact version and answers the new one', async () => {
    const testHost = host();
    const result = await writeFilesystemFile(
      replace('src/index.ts', 'export const a = 1;\n', await versionOf(file())),
      { host: testHost },
    );
    const saved = await stat(file());
    expect(result).toEqual({
      relativePath: 'src/index.ts',
      sizeBytes: 20,
      sha256: sha256('export const a = 1;\n'),
      version: version(saved),
      modifiedAt: new Date(saved.mtimeMs).toISOString(),
    });
    expect(WRITE.result.safeParse(result).success).toBe(true);
    expect(await readFile(file(), 'utf8')).toBe('export const a = 1;\n');
    expect(testHost.calls).toEqual([
      'admit',
      'assertMutable',
      'roots',
      'beforeReplace',
      'release',
    ]);
  });

  itPosix('keeps the inode, hard links and mode', async () => {
    await link(file(), join(repo, 'src', 'hard.ts'));
    await chmod(file(), 0o640);
    const before = await stat(file());
    await writeFilesystemFile(replace('src/index.ts', 'x\n', version(before)), {
      host: host(),
    });
    const after = await stat(file());
    expect([after.ino, after.nlink, after.mode & 0o777]).toEqual([
      before.ino,
      2,
      0o640,
    ]);
    expect(await readFile(join(repo, 'src', 'hard.ts'), 'utf8')).toBe('x\n');
  });

  it('shrinks a longer file and writes empty content', async () => {
    await writeFilesystemFile(
      replace('src/index.ts', 'a\n', await versionOf(file())),
      { host: host() },
    );
    expect(await readFile(file(), 'utf8')).toBe('a\n');
    await writeFilesystemFile(
      replace('src/index.ts', '', await versionOf(file())),
      { host: host() },
    );
    expect(await readFile(file(), 'utf8')).toBe('');
  });

  it('refuses a stale version without writing or touching', async () => {
    const testHost = host();
    for (const stale of ['11:0', '0:0', 'not-a-version', '']) {
      const { error } = await failure(
        writeFilesystemFile(replace('src/index.ts', 'changed\n', stale), {
          host: testHost,
        }),
      );
      expect(error.payload).toMatchObject({
        kind: 'conflict',
        code: 'worker.filesystem.file.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'worker.filesystem.file' },
      });
    }
    expect(await readFile(file(), 'utf8')).toBe('export {};\n');
    expect(testHost.calls).not.toContain('beforeReplace');
  });

  it('succeeds without writing when a stale retry already landed', async () => {
    const testHost = host();
    const before = await stat(file());
    const result = await writeFilesystemFile(
      replace('src/index.ts', 'export {};\n', '1:1'),
      { host: testHost },
    );
    expect(result).toEqual({
      relativePath: 'src/index.ts',
      sizeBytes: 11,
      sha256: sha256('export {};\n'),
      version: version(before),
      modifiedAt: new Date(before.mtimeMs).toISOString(),
    });
    expect((await stat(file())).mtimeMs).toBe(before.mtimeMs);
    expect(testHost.calls).not.toContain('beforeReplace');
  });

  /**
   * Holds each save at its effect until the other arrives there too, or for
   * 200 ms when it never does because it waits behind the first.
   */
  function rendezvous(): FilesystemFileWriteIo {
    let arrived = 0;
    let release = (): void => undefined;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      beforeEffect: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([
          both,
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
        ]);
      },
    };
  }

  it('lets one of two saves under the same version win', async () => {
    const expected = await versionOf(file());
    const io = rendezvous();
    const contents = ['first save\n', 'the second save\n'];
    const outcomes = await Promise.allSettled(
      contents.map((content) =>
        writeFilesystemFile(replace('src/index.ts', content, expected), {
          host: host(),
          io,
        }),
      ),
    );
    const won = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [contents[index]] : [],
    );
    expect(won).toHaveLength(1);
    expect(await readFile(file(), 'utf8')).toBe(won[0]);
    const [lost] = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.filesystem.file.revisionConflict',
      },
    });
  });

  it('lets both of two identical saves under the same version succeed', async () => {
    const expected = await versionOf(file());
    const io = rendezvous();
    const results = await Promise.all(
      [1, 2].map(() =>
        writeFilesystemFile(replace('src/index.ts', 'same\n', expected), {
          host: host(),
          io,
        }),
      ),
    );
    const saved = version(await stat(file()));
    expect(results.map((result) => result.version)).toEqual([saved, saved]);
    expect(await readFile(file(), 'utf8')).toBe('same\n');
  });

  it('lets a waiting save run once the one before it fails', async () => {
    const expected = await versionOf(file());
    let touches = 0;
    const testHost = host({
      beforeReplace: () =>
        (touches += 1) === 1
          ? Promise.reject(new Error('touch failed'))
          : Promise.resolve(),
    });
    const outcomes = await Promise.allSettled(
      ['one\n', 'two\n'].map((content) =>
        writeFilesystemFile(replace('src/index.ts', content, expected), {
          host: testHost,
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(['one\n', 'two\n']).toContain(await readFile(file(), 'utf8'));
  });

  it('refuses a change made in place during host work, keeping it', async () => {
    const { error } = await failure(
      writeFilesystemFile(
        replace('src/index.ts', 'ours\n', await versionOf(file())),
        {
          host: host(),
          io: { beforeEffect: () => writeFile(file(), 'another writer\n') },
        },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'conflict',
      code: 'worker.filesystem.file.revisionConflict',
    });
    expect(await readFile(file(), 'utf8')).toBe('another writer\n');
  });

  it('succeeds when a change made during host work already has its bytes', async () => {
    const result = await writeFilesystemFile(
      replace('src/index.ts', 'ours\n', await versionOf(file())),
      { host: host(), io: { beforeEffect: () => writeFile(file(), 'ours\n') } },
    );
    expect(result.version).toBe(await versionOf(file()));
    expect(await readFile(file(), 'utf8')).toBe('ours\n');
  });

  itPosix(
    'refuses a file renamed over during host work, keeping it',
    async () => {
      const incoming = join(repo, 'src', 'incoming.ts');
      const { error } = await failure(
        writeFilesystemFile(
          replace('src/index.ts', 'ours\n', await versionOf(file())),
          {
            host: host(),
            io: {
              beforeEffect: async () => {
                await writeFile(incoming, 'another writer\n');
                await rename(incoming, file());
              },
            },
          },
        ),
      );
      expect(error.payload).toMatchObject({
        kind: 'conflict',
        code: 'worker.filesystem.file.revisionConflict',
      });
      expect(await readFile(file(), 'utf8')).toBe('another writer\n');
    },
  );

  itPosix('lets one of two saves through two hard links win', async () => {
    const hard = join(repo, 'src', 'hard.ts');
    await link(file(), hard);
    const expected = await versionOf(file());
    const io = rendezvous();
    const saves: Array<[string, string]> = [
      ['src/index.ts', 'first save\n'],
      ['src/hard.ts', 'the second save\n'],
    ];
    const outcomes = await Promise.allSettled(
      saves.map(([path, content]) =>
        writeFilesystemFile(replace(path, content, expected), {
          host: host(),
          io,
        }),
      ),
    );
    const won = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [saves[index]?.[1]] : [],
    );
    expect(won).toHaveLength(1);
    expect(await readFile(hard, 'utf8')).toBe(won[0]);
  });

  it('refuses a missing file, a folder and paths outside the root', async () => {
    const cases: Array<[string, object]> = [
      [
        'src/missing.ts',
        { kind: 'not_found', code: 'worker.filesystem.file.notFound' },
      ],
      [
        'src',
        {
          kind: 'failed_precondition',
          code: 'worker.filesystem.file.invalidState',
          message: 'Path is not a file.',
        },
      ],
      [
        '../outside/secret.txt',
        {
          kind: 'invalid_argument',
          code: 'worker.filesystem.path.invalid',
          message: 'Path cannot traverse outside the worktree.',
        },
      ],
      [
        '/etc/hosts',
        {
          kind: 'invalid_argument',
          code: 'worker.filesystem.path.invalid',
          message: 'Path must be relative.',
        },
      ],
      [
        '',
        {
          code: 'worker.filesystem.path.invalid',
          message: 'Write target cannot be a file-tree root.',
        },
      ],
    ];
    for (const [relativePath, payload] of cases) {
      const { error } = await failure(
        writeFilesystemFile(replace(relativePath, 'x', '0:0'), {
          host: host(),
        }),
      );
      expect(error.payload).toMatchObject(payload);
    }
    const { error } = await failure(
      writeFilesystemFile(
        replace('src/index.ts', 'x', '0:0', { fileRootId: 'nope' }),
        { host: host() },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.root.notFound',
      message: 'Unknown file root: nope',
    });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret\n',
    );
  });

  it('refuses another root reached through this one', async () => {
    const child = join(repo, 'child', 'child.txt');
    const { error } = await failure(
      writeFilesystemFile(
        replace('child/child.txt', 'x', await versionOf(child)),
        { host: host() },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.root.excluded',
    });
    await writeFilesystemFile(
      replace('child.txt', 'through its own root\n', await versionOf(child), {
        fileRootId: 'child',
      }),
      { host: host() },
    );
    expect(await readFile(child, 'utf8')).toBe('through its own root\n');
  });

  itPosix('refuses a symlink that leaves the root', async () => {
    await symlink(join(outside, 'secret.txt'), join(repo, 'leak.txt'));
    const { error } = await failure(
      writeFilesystemFile(
        replace('leak.txt', 'x', await versionOf(join(outside, 'secret.txt'))),
        { host: host() },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.path.escape',
    });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret\n',
    );
  });

  itPosix('writes an in-root symlink target, keeping the link', async () => {
    await symlink('index.ts', join(repo, 'src', 'alias.ts'));
    await writeFilesystemFile(
      replace('src/alias.ts', 'via alias\n', await versionOf(file())),
      { host: host() },
    );
    expect(await readFile(file(), 'utf8')).toBe('via alias\n');
    expect(await readlink(join(repo, 'src', 'alias.ts'))).toBe('index.ts');
  });

  itPosix(
    'refuses, without following, a name swapped to a link mid-call',
    async () => {
      const io: FilesystemFileWriteIo = {
        beforeEffect: async () => {
          await writeFile(join(repo, 'src', 'other.ts'), 'other\n');
          await rm(file());
          await symlink(join(outside, 'secret.txt'), file());
        },
      };
      const { error } = await failure(
        writeFilesystemFile(
          replace('src/index.ts', 'pinned\n', await versionOf(file())),
          { host: host(), io },
        ),
      );
      expect(error.payload).toMatchObject({
        kind: 'conflict',
        code: 'worker.filesystem.file.revisionConflict',
      });
      // The planted link's target took no bytes.
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'secret\n',
      );
    },
  );

  it('refuses unsupported options and missing content before any effect', async () => {
    const v = await versionOf(file());
    const cases: Array<[Partial<ReplaceParams>, object]> = [
      [
        { executable: true },
        {
          kind: 'capability_unavailable',
          details: { option: 'executable' },
        },
      ],
      [
        { sourceArtifactId: 'artifact-1' },
        {
          kind: 'capability_unavailable',
          details: { option: 'sourceArtifactId' },
        },
      ],
      [{ content: null }, { kind: 'invalid_argument' }],
      [{ content: undefined }, { kind: 'invalid_argument' }],
    ];
    for (const [changes, payload] of cases) {
      const testHost = host();
      const { error } = await failure(
        writeFilesystemFile(replace('src/index.ts', 'x', v, changes), {
          host: testHost,
        }),
      );
      expect(error.payload).toMatchObject(payload);
      expect(testHost.calls).toEqual(['admit', 'assertMutable', 'release']);
    }
    await writeFilesystemFile(
      replace('src/index.ts', 'plain\n', v, {
        executable: false,
        sourceArtifactId: null,
      }),
      { host: host() },
    );
    expect(await readFile(file(), 'utf8')).toBe('plain\n');
  });

  it("refuses content over the host's byte cap, counting UTF-8 bytes", async () => {
    const testHost = host({ fileWriteLimitBytes: 4 });
    const { error } = await failure(
      writeFilesystemFile(
        replace('src/index.ts', 'ééé', await versionOf(file())),
        { host: testHost },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'resource_exhausted',
      details: { limitBytes: 4 },
    });
    await writeFilesystemFile(
      replace('src/index.ts', 'éé', await versionOf(file())),
      { host: testHost },
    );
    expect(await readFile(file(), 'utf8')).toBe('éé');
  });

  it('stops before the effect once cancelled', async () => {
    const controller = new AbortController();
    const { error } = await failure(
      writeFilesystemFile(
        replace('src/index.ts', 'late\n', await versionOf(file())),
        {
          host: host(),
          signal: controller.signal,
          io: {
            beforeEffect: () => {
              controller.abort();
              return Promise.resolve();
            },
          },
        },
      ),
    );
    expect(error.payload.kind).toBe('cancelled');
    expect(await readFile(file(), 'utf8')).toBe('export {};\n');
  });

  it('keeps host refusals, dropping codes this instruction lacks', async () => {
    const refused = new CanopyOperationError(
      {
        kind: 'permission_denied',
        message: 'Read-only.',
        retry: { kind: 'never' },
      },
      new Error('cause'),
    );
    const read = await failure(
      writeFilesystemFile(replace('src/index.ts', 'x', '0:0'), {
        host: host({
          assertMutable: () => {
            throw refused;
          },
        }),
      }),
    );
    expect(read.error).toBe(refused);
    const scoped = await failure(
      writeFilesystemFile(replace('src/index.ts', 'x', '0:0'), {
        host: host({
          roots: () =>
            Promise.reject(filesystemScopeError('roots', 'notFound')),
        }),
      }),
    );
    expect(scoped.error.payload).toEqual({
      kind: 'not_found',
      message: 'The selected filesystem scope no longer exists.',
      retry: { kind: 'never' },
    });
  });

  it('fails when the admission refuses, before anything else', async () => {
    const testHost = host({
      admitWrite: () => Promise.reject(new Error('Auto Delete owns it.')),
    });
    await expect(
      writeFilesystemFile(replace('src/index.ts', 'x', '0:0'), {
        host: testHost,
      }),
    ).rejects.toThrow('Auto Delete owns it.');
    expect(testHost.calls).toEqual([]);
  });
});

describe('worker.filesystem.file.write create', () => {
  it('creates exclusively without admission or touch', async () => {
    const testHost = host();
    const result = await writeFilesystemFile(create('src/new.ts', 'new\n'), {
      host: testHost,
    });
    const created = await stat(join(repo, 'src', 'new.ts'));
    expect(result).toEqual({
      relativePath: 'src/new.ts',
      sizeBytes: 4,
      sha256: sha256('new\n'),
      version: version(created),
      modifiedAt: new Date(created.mtimeMs).toISOString(),
    });
    expect(testHost.calls).toEqual(['assertMutable', 'roots']);
  });

  it('normalizes the path it reports', async () => {
    await expect(
      writeFilesystemFile(create('./src//other.ts'), { host: host() }),
    ).resolves.toMatchObject({ relativePath: 'src/other.ts' });
    expect(normalizeFileCreatePath('./a//b', hostOs)).toBe('a/b');
  });

  it('refuses an existing entry as already_exists, keeping the cause', async () => {
    for (const relativePath of ['src/index.ts', 'src']) {
      const { error, cause } = await failure(
        writeFilesystemFile(create(relativePath, 'x'), { host: host() }),
      );
      expect(error.payload).toMatchObject({ kind: 'already_exists' });
      expect(error.payload.code).toBeUndefined();
      expect(cause).toMatchObject({ code: 'EEXIST' });
    }
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  itPosix('refuses a dangling symlink and never follows it', async () => {
    await symlink(join(repo, 'made-by-link.txt'), join(repo, 'dangling'));
    const { error } = await failure(
      writeFilesystemFile(create('dangling', 'x'), { host: host() }),
    );
    expect(error.payload.kind).toBe('already_exists');
    expect(await readdir(repo)).not.toContain('made-by-link.txt');
  });

  it('never creates parent folders', async () => {
    const { error } = await failure(
      writeFilesystemFile(create('a/b/new.ts'), { host: host() }),
    );
    expect(error.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.file.notFound',
      message: 'The parent folder does not exist.',
    });
    expect(await readdir(repo)).not.toContain('a');
  });

  it('refuses paths outside the root, other roots and the root itself', async () => {
    const cases: Array<[string, object]> = [
      ['../outside/new.txt', { code: 'worker.filesystem.path.invalid' }],
      [
        '',
        {
          code: 'worker.filesystem.path.invalid',
          message: 'Create target cannot be a file-tree root.',
        },
      ],
      ['child/new.txt', { code: 'worker.filesystem.root.excluded' }],
    ];
    for (const [relativePath, payload] of cases) {
      const { error } = await failure(
        writeFilesystemFile(create(relativePath), { host: host() }),
      );
      expect(error.payload).toMatchObject(payload);
    }
    expect(await readdir(join(repo, 'child'))).toEqual(['child.txt']);
  });

  itPosix('refuses a folder link that leaves the root', async () => {
    await symlink(outside, join(repo, 'out'));
    const { error } = await failure(
      writeFilesystemFile(create('out/new.txt'), { host: host() }),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.path.escape',
      message: 'File is outside the selected worktree root.',
    });
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  itPosix(
    'refuses when its folder is swapped for an outside link',
    async () => {
      await mkdir(join(repo, 'swap'));
      const { error } = await failure(
        writeFilesystemFile(create('swap/new.txt'), {
          host: host(),
          io: {
            beforeEffect: async () => {
              await rm(join(repo, 'swap'), { recursive: true });
              await symlink(outside, join(repo, 'swap'));
            },
          },
        }),
      );
      expect(error.payload.code).toBe('worker.filesystem.path.escape');
      expect(await readdir(outside)).toEqual(['secret.txt']);
    },
  );
});

describe('worker.filesystem.directory.create', () => {
  it('creates a folder and its missing parents one level at a time', async () => {
    const result = await createFilesystemDirectory(directory('a/b/c'), {
      host: host(),
    });
    expect(result).toEqual({
      fileRootId: 'repo',
      relativePath: 'a/b/c',
      createdParentPaths: ['a', 'a/b'],
      version: version(await lstat(join(repo, 'a', 'b', 'c'))),
    });
    expect(CREATE.result.safeParse(result).success).toBe(true);
    await expect(
      createFilesystemDirectory(directory('src/new'), { host: host() }),
    ).resolves.toMatchObject({ createdParentPaths: [] });
  });

  it('refuses an existing leaf, keeping the cause', async () => {
    for (const relativePath of ['src', 'src/index.ts']) {
      const { error, cause } = await failure(
        createFilesystemDirectory(directory(relativePath), { host: host() }),
        CREATE,
      );
      expect(error.payload).toMatchObject({
        kind: 'already_exists',
        code: 'worker.filesystem.entry.exists',
      });
      expect(cause).toMatchObject({ code: 'EEXIST' });
    }
  });

  it('needs createParents for a missing parent', async () => {
    const { error } = await failure(
      createFilesystemDirectory(directory('a/b', false), { host: host() }),
      CREATE,
    );
    expect(error.payload.kind).toBe('not_found');
    expect(await readdir(repo)).not.toContain('a');
  });

  it('refuses bad paths, unknown roots and other roots', async () => {
    const cases: Array<[WorkerFilesystemDirectoryCreateParams, object]> = [
      [directory('../x'), { code: 'worker.filesystem.path.invalid' }],
      [directory('.'), { code: 'worker.filesystem.path.invalid' }],
      [
        directory('x', true, 'nope'),
        { code: 'worker.filesystem.root.notFound' },
      ],
      [directory('child/new'), { code: 'worker.filesystem.root.excluded' }],
    ];
    for (const [params, payload] of cases) {
      const { error } = await failure(
        createFilesystemDirectory(params, { host: host() }),
        CREATE,
      );
      expect(error.payload).toMatchObject(payload);
    }
    expect(await readdir(join(repo, 'child'))).toEqual(['child.txt']);
  });

  itPosix('creates through an in-root folder link', async () => {
    await symlink('src', join(repo, 'src-link'));
    await createFilesystemDirectory(directory('src-link/a/b'), {
      host: host(),
    });
    expect((await stat(join(repo, 'src', 'a', 'b'))).isDirectory()).toBe(true);
  });

  itPosix(
    'refuses a link planted on the way that leaves the root',
    async () => {
      const { error } = await failure(
        createFilesystemDirectory(directory('planted/inner/leaf'), {
          host: host(),
          io: {
            beforeEffect: () => symlink(outside, join(repo, 'planted')),
          },
        }),
        CREATE,
      );
      expect(error.payload.code).toBe('worker.filesystem.path.escape');
      expect(await readdir(outside)).toEqual(['secret.txt']);
    },
  );

  itPosix('refuses a folder link that leaves the root', async () => {
    await symlink(outside, join(repo, 'out'));
    const { error } = await failure(
      createFilesystemDirectory(directory('out/new'), { host: host() }),
      CREATE,
    );
    expect(error.payload.code).toBe('worker.filesystem.path.escape');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('stops before any folder is made once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { error } = await failure(
      createFilesystemDirectory(directory('a/b'), {
        host: host(),
        signal: controller.signal,
      }),
      CREATE,
    );
    expect(error.payload.kind).toBe('cancelled');
    expect(await readdir(repo)).not.toContain('a');
  });
});

// Suites such as plugin-service.test.ts mock `node:fs` without `constants`;
// importing the engine, or an entry that re-exports it, must not read it.
describe('import with node:fs mocked without constants', () => {
  afterEach(() => {
    // `doMock` outlives `isolateModules`; later requires get the real module.
    jest.dontMock('node:fs');
    jest.dontMock('fs');
  });

  it.each([
    ['the engine', '../file-writes'],
    ['the node entry', '../../index'],
  ])('loads %s', (_label, modulePath) => {
    const withoutConstants = (): object =>
      Object.fromEntries(
        Object.entries(jest.requireActual<object>('node:fs')).filter(
          ([key]) => key !== 'constants',
        ),
      );
    jest.isolateModules(() => {
      jest.doMock('node:fs', withoutConstants);
      jest.doMock('fs', withoutConstants);
      expect((): void => {
        jest.requireActual<object>(modulePath);
      }).not.toThrow();
    });
  });
});
