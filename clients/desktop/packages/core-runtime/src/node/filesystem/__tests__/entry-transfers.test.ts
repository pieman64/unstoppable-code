import {
  access,
  cp,
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
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  type WorkerFilesystemEntryCopyParams,
  type WorkerFilesystemEntryMoveParams,
} from '@canopy/protocol/canopy-core';
import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import { CanopyOperationError } from '../../../runtime/errors';
import type { FilesystemEntryRoot } from '../entry-mutation-guards';
import type { FilesystemEntryMutationHost } from '../entry-mutations';
import { copyFilesystemEntry, moveFilesystemEntry } from '../entry-transfers';

const posixHost = process.platform !== 'win32';
const itPosix = posixHost ? it : it.skip;
const hostOs: PlatformOperatingSystem =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'linux'
      ? 'linux'
      : 'darwin';

let tempRoot = '';
let repo = '';
let attachments = '';
let outside = '';
const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };
const COPY =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.copy'
  ];
const MOVE =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.move'
  ];
let keySequence = 0;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function expectMissing(pathValue: string): Promise<void> {
  await expect(lstat(pathValue)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function stagingLeftovers(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) =>
    name.startsWith('.canopy-copy-'),
  );
}

function errno(code: string, message = `${code}: injected`): Error {
  return Object.assign(new Error(message), { code });
}

function defaultRoots(): FilesystemEntryRoot[] {
  return [
    { fileRootId: 'repo', absolutePath: repo, excludedDescendantRoots: [] },
    {
      fileRootId: 'attachments',
      absolutePath: attachments,
      excludedDescendantRoots: [],
    },
  ];
}

function host(
  overrides: Partial<FilesystemEntryMutationHost> = {},
  roots: () => FilesystemEntryRoot[] = defaultRoots,
): FilesystemEntryMutationHost & { calls: string[] } {
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
    ...overrides,
    calls,
  };
}

function copyRequest(
  source: string,
  destination: string,
  conflictPolicy: WorkerFilesystemEntryCopyParams['conflictPolicy'] = 'error',
  roots: [string, string] = ['repo', 'repo'],
): WorkerFilesystemEntryCopyParams {
  return {
    scope,
    sourceFileRootId: roots[0],
    sourceRelativePath: source,
    destinationFileRootId: roots[1],
    destinationRelativePath: destination,
    expectedSourceVersion: null,
    conflictPolicy,
    _meta: { idempotencyKey: `copy-${++keySequence}` },
  };
}

function moveRequest(
  source: string,
  destination: string,
  roots: [string, string] = ['repo', 'repo'],
): WorkerFilesystemEntryMoveParams {
  return {
    scope,
    sourceFileRootId: roots[0],
    destinationFileRootId: roots[1],
    fromRelativePath: source,
    toRelativePath: destination,
    expectedSourceVersion: null,
    expectedDestinationAbsent: true,
    conflictPolicy: 'error',
    _meta: { idempotencyKey: `move-${++keySequence}` },
  };
}

/** An engine-authored failure, which must fit the operation's error schema. */
async function failureFor(
  schema: { safeParse(value: unknown): { success: boolean } },
  promise: Promise<unknown>,
): Promise<{ error: CanopyOperationError; cause: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a CanopyOperationError, got ${String(error)}`);
  expect(schema.safeParse(error.payload).success).toBe(true);
  return { error, cause: error.runtimeCause };
}

const copyFailure = (
  promise: Promise<unknown>,
): Promise<{ error: CanopyOperationError; cause: unknown }> =>
  failureFor(COPY.error, promise);
const moveFailure = (
  promise: Promise<unknown>,
): Promise<{ error: CanopyOperationError; cause: unknown }> =>
  failureFor(MOVE.error, promise);

function exists(relativePath: string): Record<string, unknown> {
  return {
    kind: 'already_exists',
    code: 'worker.filesystem.entry.exists',
    message: `A file or folder already exists at ${relativePath}.`,
    retry: { kind: 'never' },
  };
}

/** A copy refuses an occupied destination under the copy page's own code. */
function copyExists(relativePath: string): Record<string, unknown> {
  return {
    ...exists(relativePath),
    code: 'worker.filesystem.destination.exists',
  };
}

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'entry-transfers-')));
  repo = join(tempRoot, 'repo');
  attachments = join(tempRoot, 'attachments');
  outside = join(tempRoot, 'outside');
  await put(join(repo, 'src', 'index.ts'), 'export {};\n');
  await put(join(repo, 'docs', 'guide', 'intro.md'), '# Intro\n');
  await put(join(attachments, 'note.txt'), 'note\n');
  await mkdir(outside);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('copyFilesystemEntry', () => {
  it('copies a folder and reports the requested and effective destinations', async () => {
    const result = await copyFilesystemEntry(
      copyRequest('./docs/', 'archive/docs'),
      { host: host() },
    );
    const { version, ...located } = result;
    expect(located).toEqual({
      sourceFileRootId: 'repo',
      sourceRelativePath: 'docs',
      destinationFileRootId: 'repo',
      requestedDestinationRelativePath: 'archive/docs',
      destinationRelativePath: 'archive/docs',
      copiedEntryCount: 1,
    });
    const published = await lstat(join(repo, 'archive', 'docs'));
    expect(version).toBe(`${published.size}:${Math.round(published.mtimeMs)}`);
    expect(COPY.result.parse(result)).toEqual(result);
    expect(
      await readFile(join(repo, 'archive/docs/guide/intro.md'), 'utf8'),
    ).toBe('# Intro\n');
    expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
      '# Intro\n',
    );
    await expect(stagingLeftovers(join(repo, 'archive'))).resolves.toEqual([]);
  });

  it('names incremental copies of files, dotted folders and nested paths', async () => {
    await mkdir(join(repo, 'config.v1'));
    const target = host();
    for (const [source, expected] of [
      ['src/index.ts', 'src/index copy.ts'],
      ['src/index.ts', 'src/index copy 2.ts'],
      ['config.v1', 'config.v1 copy'],
      ['docs/guide/intro.md', 'docs/guide/intro copy.md'],
    ] as const) {
      await expect(
        copyFilesystemEntry(copyRequest(source, source, 'increment'), {
          host: target,
        }),
      ).resolves.toMatchObject({
        requestedDestinationRelativePath: source,
        destinationRelativePath: expected,
      });
    }
    expect((await lstat(join(repo, 'config.v1 copy'))).isDirectory()).toBe(
      true,
    );
  });

  itPosix('counts a dangling symlink as occupied', async () => {
    await symlink('missing-target', join(repo, 'dangling.txt'));
    const { error } = await copyFailure(
      copyFilesystemEntry(copyRequest('src/index.ts', 'dangling.txt'), {
        host: host(),
      }),
    );
    expect(error.payload).toEqual(copyExists('dangling.txt'));
    await expect(
      copyFilesystemEntry(
        copyRequest('src/index.ts', 'dangling.txt', 'increment'),
        { host: host() },
      ),
    ).resolves.toMatchObject({ destinationRelativePath: 'dangling copy.txt' });
    expect(await readlink(join(repo, 'dangling.txt'))).toBe('missing-target');
  });

  it('reports a conflict, never another name, when an increment pick is taken before publishing', async () => {
    const picked = join(repo, 'src', 'index copy.ts');
    const publishLinkEntry = jest.fn(
      async (stagingPath: string, targetPath: string) => {
        await writeFile(targetPath, 'concurrent\n', { flag: 'wx' });
        await link(stagingPath, targetPath);
      },
    );
    const { error } = await copyFailure(
      copyFilesystemEntry(
        copyRequest('src/index.ts', 'src/index.ts', 'increment'),
        { host: host(), io: { publishLinkEntry } },
      ),
    );
    expect(error.payload).toEqual(copyExists('src/index copy.ts'));
    expect(error.runtimeCause).toBeUndefined();
    expect(publishLinkEntry).toHaveBeenCalledTimes(1);
    expect(await readFile(picked, 'utf8')).toBe('concurrent\n');
    expect((await readdir(join(repo, 'src'))).sort()).toEqual([
      'index copy.ts',
      'index.ts',
    ]);
    await expect(stagingLeftovers(join(repo, 'src'))).resolves.toEqual([]);
  });

  itPosix(
    'copies from the validated real path when its lexical alias is swapped',
    async () => {
      const sourceDirectory = join(repo, 'validated-source');
      const lexicalAlias = join(repo, 'source-alias');
      await put(join(sourceDirectory, 'value.txt'), 'inside\n');
      await put(join(outside, 'value.txt'), 'outside\n');
      await symlink(sourceDirectory, lexicalAlias);
      const copyEntry = jest.fn(
        async (validatedSource: string, stagingPath: string) => {
          await rm(lexicalAlias);
          await symlink(outside, lexicalAlias);
          await cp(validatedSource, stagingPath, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        },
      );
      await copyFilesystemEntry(
        copyRequest('source-alias/value.txt', 'copied-value.txt'),
        { host: host(), io: { copyEntry } },
      );
      expect(copyEntry).toHaveBeenCalledWith(
        join(sourceDirectory, 'value.txt'),
        expect.any(String),
      );
      expect(await readFile(join(repo, 'copied-value.txt'), 'utf8')).toBe(
        'inside\n',
      );
    },
  );

  itPosix(
    'copies a symlink to a file as an independent regular file',
    async () => {
      await symlink('index.ts', join(repo, 'src', 'alias.ts'));
      await copyFilesystemEntry(copyRequest('src/alias.ts', 'copied.ts'), {
        host: host(),
      });
      const copy = await lstat(join(repo, 'copied.ts'));
      expect(copy.isFile()).toBe(true);
      expect(copy.isSymbolicLink()).toBe(false);
      expect((await lstat(join(repo, 'src', 'index.ts'))).nlink).toBe(1);
    },
  );

  itPosix(
    'keeps relative symlinks verbatim inside a copied folder',
    async () => {
      await symlink('intro.md', join(repo, 'docs', 'guide', 'link.md'));
      await copyFilesystemEntry(copyRequest('docs', 'docs-copy'), {
        host: host(),
      });
      expect(await readlink(join(repo, 'docs-copy', 'guide', 'link.md'))).toBe(
        'intro.md',
      );
    },
  );

  it('removes staging and creates no target when the staged copy fails', async () => {
    const copyEntry = jest.fn(async (_source: string, stagingPath: string) => {
      await writeFile(stagingPath, 'partial\n');
      throw new Error('copy interrupted');
    });
    await expect(
      copyFilesystemEntry(copyRequest('src/index.ts', 'partial.ts'), {
        host: host(),
        io: { copyEntry },
      }),
    ).rejects.toThrow('copy interrupted');
    await expectMissing(join(repo, 'partial.ts'));
    await expect(stagingLeftovers(repo)).resolves.toEqual([]);
  });

  it('keeps a target created during publication and reports the conflict', async () => {
    const targetPath = join(repo, 'publish-target.txt');
    const publishLinkEntry = jest.fn(
      async (stagingPath: string, target: string) => {
        await writeFile(target, 'concurrent target\n', { flag: 'wx' });
        await link(stagingPath, target);
      },
    );
    const { error } = await copyFailure(
      copyFilesystemEntry(copyRequest('src/index.ts', 'publish-target.txt'), {
        host: host(),
        io: { publishLinkEntry },
      }),
    );
    expect(error.payload).toEqual(copyExists('publish-target.txt'));
    expect(publishLinkEntry).toHaveBeenCalledWith(
      expect.any(String),
      targetPath,
    );
    expect(await readFile(targetPath, 'utf8')).toBe('concurrent target\n');
    await expect(stagingLeftovers(repo)).resolves.toEqual([]);
  });

  it('publishes a file by exclusive copy when hard links are unsupported', async () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
      const name = `published-${code}.ts`;
      await copyFilesystemEntry(copyRequest('src/index.ts', name), {
        host: host(),
        io: { publishLinkEntry: () => Promise.reject(errno(code)) },
      });
      expect(await readFile(join(repo, name), 'utf8')).toBe('export {};\n');
    }
    await expect(stagingLeftovers(repo)).resolves.toEqual([]);
  });

  itPosix(
    'reserves a folder destination on POSIX and removes only its empty reservation',
    async () => {
      const target = join(repo, 'docs-copy');
      await expect(
        copyFilesystemEntry(copyRequest('docs', 'docs-copy'), {
          host: host({ os: 'linux' }),
          io: {
            publishRenameEntry: async (_staging, destination) => {
              expect((await lstat(destination)).isDirectory()).toBe(true);
              throw errno('EIO');
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'EIO' });
      await expectMissing(target);
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    },
  );

  it('publishes a folder on Windows by rename, without a reservation', async () => {
    const target = join(repo, 'docs-copy');
    const publishRenameEntry = jest.fn(
      async (staging: string, destination: string) => {
        await expect(access(destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await rename(staging, destination);
      },
    );
    await copyFilesystemEntry(copyRequest('docs', 'docs-copy'), {
      host: host({ os: 'win32' }),
      io: { publishRenameEntry },
    });
    expect(publishRenameEntry).toHaveBeenCalledWith(expect.any(String), target);
    expect(await readFile(join(target, 'guide', 'intro.md'), 'utf8')).toBe(
      '# Intro\n',
    );
    // Windows does not map a publish EPERM to a conflict, unlike a move.
    await expect(
      copyFilesystemEntry(copyRequest('docs', 'docs-copy-2'), {
        host: host({ os: 'win32' }),
        io: { publishRenameEntry: () => Promise.reject(errno('EPERM')) },
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    await expectMissing(join(repo, 'docs-copy-2'));
  });

  it('refuses a folder copied into itself, case-folded on Windows only', async () => {
    const { error } = await copyFailure(
      copyFilesystemEntry(copyRequest('docs', 'docs/guide/docs'), {
        host: host(),
      }),
    );
    expect(error.payload).toEqual({
      kind: 'invalid_argument',
      code: 'worker.filesystem.destination.nested',
      message: 'A folder cannot be moved or copied into itself.',
      retry: { kind: 'never' },
    });
    await mkdir(join(repo, 'Folder'));
    const windows = await copyFailure(
      copyFilesystemEntry(copyRequest('Folder', 'folder/sub'), {
        host: host({ os: 'win32' }),
      }),
    );
    expect(windows.error.payload.code).toBe(
      'worker.filesystem.destination.nested',
    );
    // A copy into a separate root is never nested.
    await expect(
      copyFilesystemEntry(
        copyRequest('docs', 'docs', 'error', ['repo', 'attachments']),
        {
          host: host(),
        },
      ),
    ).resolves.toMatchObject({ destinationFileRootId: 'attachments' });
  });

  itPosix(
    'refuses a cross-root transfer of, or containing, a symlink',
    async () => {
      await symlink('intro.md', join(repo, 'docs', 'guide', 'link.md'));
      for (const source of ['docs', 'docs/guide/link.md']) {
        const { error } = await copyFailure(
          copyFilesystemEntry(
            copyRequest(source, 'incoming', 'error', ['repo', 'attachments']),
            { host: host() },
          ),
        );
        expect(error.payload).toEqual({
          kind: 'failed_precondition',
          code: 'worker.filesystem.symlink.rejected',
          message: 'Cross-root transfers cannot contain symlinks.',
          retry: { kind: 'never' },
        });
      }
      expect(await readdir(attachments)).toEqual(['note.txt']);
    },
  );

  it('fails a missing source as source.notFound, keeping the ENOENT cause', async () => {
    const { error, cause } = await copyFailure(
      copyFilesystemEntry(copyRequest('gone.txt', 'copy.txt'), {
        host: host(),
      }),
    );
    expect(error.payload).toMatchObject({
      code: 'worker.filesystem.source.notFound',
    });
    expect(cause).toMatchObject({ code: 'ENOENT' });
  });

  itPosix('refuses a source or destination that leaves the root', async () => {
    await put(join(outside, 'secret.txt'), 'secret\n');
    await symlink(outside, join(repo, 'escape'));
    for (const request of [
      copyRequest('escape/secret.txt', 'secret.txt'),
      copyRequest('src/index.ts', 'escape/index.ts'),
    ]) {
      const { error } = await copyFailure(
        copyFilesystemEntry(request, { host: host() }),
      );
      expect(error.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'worker.filesystem.path.escape',
        message: 'File is outside the selected worktree root.',
      });
    }
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('refuses unknown roots and invalid paths with the explorer labels', async () => {
    for (const [request, code, message] of [
      [
        copyRequest('src', 'x', 'error', ['nope', 'repo']),
        'worker.filesystem.root.notFound',
        'Unknown file root: nope',
      ],
      [
        copyRequest('src', 'x', 'error', ['repo', 'gone']),
        'worker.filesystem.root.notFound',
        'Unknown file root: gone',
      ],
      [
        copyRequest('', 'x'),
        'worker.filesystem.entry.invalidPath',
        'Source cannot be a file-tree root.',
      ],
      [
        copyRequest('src', '.'),
        'worker.filesystem.entry.invalidPath',
        'Target cannot be a file-tree root.',
      ],
      [
        copyRequest('src', '../x'),
        'worker.filesystem.entry.invalidPath',
        'Path cannot traverse outside the worktree.',
      ],
    ] as const) {
      const { error } = await copyFailure(
        copyFilesystemEntry(request, { host: host() }),
      );
      expect(error.payload).toMatchObject({ code, message });
    }
  });

  itPosix(
    'refuses a backslash off Windows and reads it as a separator on Windows',
    async () => {
      await put(join(repo, 'a\\b'), 'literal\n');
      for (const [request, message] of [
        [copyRequest('a\\b', 'x'), 'Source cannot contain a backslash.'],
        [
          copyRequest('src/index.ts', 'a\\c'),
          'Target cannot contain a backslash.',
        ],
      ] as const) {
        const { error } = await copyFailure(
          copyFilesystemEntry(request, { host: host({ os: 'linux' }) }),
        );
        expect(error.payload).toMatchObject({
          code: 'worker.filesystem.entry.invalidPath',
          message,
        });
      }
      await expect(
        copyFilesystemEntry(copyRequest('src/index.ts', 'w\\x.ts'), {
          host: host({ os: 'win32' }),
        }),
      ).resolves.toMatchObject({ destinationRelativePath: 'w/x.ts' });
      expect(await readFile(join(repo, 'w', 'x.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    },
  );

  it('runs the host refusal first, before roots or effects', async () => {
    const refusal = new Error('read-only');
    const target = host({
      assertMutable: () => {
        throw refusal;
      },
    });
    await expect(
      copyFilesystemEntry(copyRequest('src', 'copy'), { host: target }),
    ).rejects.toBe(refusal);
    expect(target.calls).toEqual([]);
    await expectMissing(join(repo, 'copy'));
  });

  it('refuses a source version as capability_unavailable after the host, before roots', async () => {
    const target = host();
    const { error } = await copyFailure(
      copyFilesystemEntry(
        { ...copyRequest('src', 'copy'), expectedSourceVersion: '1:2' },
        { host: target },
      ),
    );
    expect(error.payload).toEqual({
      kind: 'capability_unavailable',
      message:
        "This host can't compare expectedSourceVersion; send null. Nothing was copied.",
      details: { option: 'expectedSourceVersion' },
      retry: { kind: 'never' },
    });
    expect(target.calls).toEqual(['assertMutable']);
    await expectMissing(join(repo, 'copy'));
  });

  describe('cancellation', () => {
    it('makes no folder when aborted before the first effect', async () => {
      const controller = new AbortController();
      controller.abort('caller');
      const { error } = await copyFailure(
        copyFilesystemEntry(copyRequest('src/index.ts', 'new/dir/index.ts'), {
          host: host(),
          signal: controller.signal,
        }),
      );
      expect(error.payload.kind).toBe('cancelled');
      await expectMissing(join(repo, 'new'));
    });

    it('removes staging and publishes nothing when aborted after staging', async () => {
      const controller = new AbortController();
      const publishLinkEntry = jest.fn(() => Promise.resolve());
      const { error } = await copyFailure(
        copyFilesystemEntry(copyRequest('src/index.ts', 'copy.ts'), {
          host: host(),
          signal: controller.signal,
          io: {
            copyEntry: async (source, stagingPath) => {
              await cp(source, stagingPath);
              controller.abort('caller');
            },
            publishLinkEntry,
          },
        }),
      );
      expect(error.payload.kind).toBe('cancelled');
      expect(publishLinkEntry).not.toHaveBeenCalled();
      await expectMissing(join(repo, 'copy.ts'));
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });
  });
});

describe('moveFilesystemEntry', () => {
  it('renames a file in place, keeping its identity and timestamp', async () => {
    const source = join(repo, 'src', 'index.ts');
    const time = new Date('2020-01-02T03:04:05.000Z');
    await utimes(source, time, time);
    const { ino, mtimeMs } = await lstat(source);
    const result = await moveFilesystemEntry(
      moveRequest('src/index.ts', 'src/main.ts'),
      { host: host() },
    );
    const moved = await lstat(join(repo, 'src', 'main.ts'));
    expect(result).toEqual({
      fromRelativePath: 'src/index.ts',
      toRelativePath: 'src/main.ts',
      requestedToRelativePath: 'src/main.ts',
      sourceFileRootId: 'repo',
      destinationFileRootId: 'repo',
      conflictPolicy: 'error',
      version: `${moved.size}:${Math.round(moved.mtimeMs)}`,
    });
    expect(MOVE.result.parse(result)).toEqual(result);
    expect(moved.ino).toBe(ino);
    expect(moved.mtimeMs).toBe(mtimeMs);
    expect(await readdir(join(repo, 'src'))).toEqual(['main.ts']);
  });

  it('refuses options this host cannot honour after the host, before roots', async () => {
    for (const [change, option] of [
      [{ expectedSourceVersion: '1:2' }, 'expectedSourceVersion'],
      [{ expectedDestinationAbsent: false }, 'expectedDestinationAbsent'],
      [{ conflictPolicy: 'increment' }, 'conflictPolicy'],
    ] as const) {
      const target = host();
      const { error } = await moveFailure(
        moveFilesystemEntry(
          { ...moveRequest('src/index.ts', 'moved.ts'), ...change },
          { host: target },
        ),
      );
      expect(error.payload).toMatchObject({
        kind: 'capability_unavailable',
        details: { option },
        retry: { kind: 'never' },
      });
      expect(target.calls).toEqual(['assertMutable']);
    }
    await expectMissing(join(repo, 'moved.ts'));
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('moves a folder into new parents, keeping its identity', async () => {
    const { ino } = await lstat(join(repo, 'docs'));
    await moveFilesystemEntry(moveRequest('docs', 'archive/2020/docs'), {
      host: host(),
    });
    expect((await lstat(join(repo, 'archive', '2020', 'docs'))).ino).toBe(ino);
    await expectMissing(join(repo, 'docs'));
  });

  it('renames by case alone', async () => {
    await put(join(repo, 'readme.md'), 'read me\n');
    await moveFilesystemEntry(moveRequest('readme.md', 'README.md'), {
      host: host(),
    });
    const names = await readdir(repo);
    expect(names).toContain('README.md');
    expect(names).not.toContain('readme.md');
  });

  itPosix(
    'refuses an occupied destination, including a dangling symlink and a symlink alias',
    async () => {
      await symlink('missing', join(repo, 'dangling'));
      await put(join(repo, 'real.txt'), 'keep me\n');
      await symlink('real.txt', join(repo, 'link.txt'));
      for (const [source, destination] of [
        ['src/index.ts', 'dangling'],
        ['src/index.ts', 'docs'],
        ['link.txt', 'real.txt'],
      ] as const) {
        const { error } = await moveFailure(
          moveFilesystemEntry(moveRequest(source, destination), {
            host: host(),
          }),
        );
        expect(error.payload).toEqual(exists(destination));
      }
      expect(await readFile(join(repo, 'real.txt'), 'utf8')).toBe('keep me\n');
      expect((await lstat(join(repo, 'link.txt'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(repo, 'dangling'))).toBe('missing');
    },
  );

  it('does not overwrite a destination created after the conflict check', async () => {
    const target = join(repo, 'target.txt');
    const { error } = await moveFailure(
      moveFilesystemEntry(moveRequest('src/index.ts', 'target.txt'), {
        host: host(),
        io: {
          beforeMove: async () => {
            await writeFile(target, 'concurrent target\n');
          },
        },
      }),
    );
    expect(error.payload).toEqual(exists('target.txt'));
    expect(await readFile(target, 'utf8')).toBe('concurrent target\n');
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  itPosix(
    'refuses a move whose validated destination parent is swapped for an escaping symlink',
    async () => {
      const targetParent = join(repo, 'race-target');
      await mkdir(targetParent);
      const { error } = await moveFailure(
        moveFilesystemEntry(
          moveRequest('src/index.ts', 'race-target/moved.ts'),
          {
            host: host(),
            io: {
              beforeMove: async () => {
                await rename(targetParent, join(repo, 'race-target-original'));
                await symlink(outside, targetParent);
              },
            },
          },
        ),
      );
      expect(error.payload.code).toBe('worker.filesystem.entry.outsideRoot');
      expect(await readdir(outside)).toEqual([]);
      expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    },
  );

  describe('file moves (link, then unlink)', () => {
    it('rolls back when the source cannot be unlinked, while it is still the linked file', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      const unlinkEntry = jest.fn(async (pathValue: string) => {
        if (pathValue === source) throw errno('EPERM', 'source cleanup denied');
        await rm(pathValue);
      });
      await expect(
        moveFilesystemEntry(moveRequest('src/index.ts', 'moved.ts'), {
          host: host(),
          io: { unlinkEntry },
        }),
      ).rejects.toThrow('source cleanup denied');
      expect(unlinkEntry).toHaveBeenCalledWith(target);
      expect(await readFile(source, 'utf8')).toBe('export {};\n');
      expect((await lstat(source)).nlink).toBe(1);
      await expectMissing(target);
    });

    // W2: removing the identity check unlinks the only remaining copy here.
    it('keeps the moved file and reports failure when the source vanishes before unlink', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      const unlinkEntry = jest.fn(async (pathValue: string) => {
        if (pathValue === source) {
          await rm(source);
          throw errno('ENOENT', 'source vanished');
        }
        await rm(pathValue);
      });
      await expect(
        moveFilesystemEntry(moveRequest('src/index.ts', 'moved.ts'), {
          host: host(),
          io: { unlinkEntry },
        }),
      ).rejects.toThrow('source vanished');
      expect(unlinkEntry).not.toHaveBeenCalledWith(target);
      expect(await readFile(target, 'utf8')).toBe('export {};\n');
      await expectMissing(source);
    });

    it('keeps the moved file when its source is replaced before unlink', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      const unlinkEntry = jest.fn(async (pathValue: string) => {
        if (pathValue === source) {
          await rm(source);
          await writeFile(source, 'replacement\n');
          throw errno('EPERM', 'source cleanup denied');
        }
        await rm(pathValue);
      });
      await expect(
        moveFilesystemEntry(moveRequest('src/index.ts', 'moved.ts'), {
          host: host(),
          io: { unlinkEntry },
        }),
      ).rejects.toThrow('source cleanup denied');
      expect(unlinkEntry).not.toHaveBeenCalledWith(target);
      expect(await readFile(target, 'utf8')).toBe('export {};\n');
      expect(await readFile(source, 'utf8')).toBe('replacement\n');
    });

    it('copies, then removes the source, when a hard link is unsupported or crosses devices', async () => {
      for (const code of [
        'EXDEV',
        'EPERM',
        'ENOTSUP',
        'EOPNOTSUPP',
        'ENOSYS',
      ]) {
        const name = `moved-${code}.ts`;
        await put(join(repo, 'src', 'index.ts'), 'export {};\n');
        const linkEntry = jest.fn(() => Promise.reject(errno(code)));
        await moveFilesystemEntry(moveRequest('src/index.ts', name), {
          host: host(),
          io: { linkEntry },
        });
        expect(linkEntry).toHaveBeenCalledWith(
          join(repo, 'src', 'index.ts'),
          join(repo, name),
        );
        expect(await readFile(join(repo, name), 'utf8')).toBe('export {};\n');
        await expectMissing(join(repo, 'src', 'index.ts'));
      }
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    it('reports a link EEXIST as a conflict', async () => {
      const { error } = await moveFailure(
        moveFilesystemEntry(moveRequest('src/index.ts', 'moved.ts'), {
          host: host(),
          io: { linkEntry: () => Promise.reject(errno('EEXIST')) },
        }),
      );
      expect(error.payload).toEqual(exists('moved.ts'));
    });

    it('rolls the link back when aborted before the source is unlinked', async () => {
      const controller = new AbortController();
      const source = join(repo, 'src', 'index.ts');
      const unlinkEntry = jest.fn((pathValue: string) => rm(pathValue));
      const { error } = await moveFailure(
        moveFilesystemEntry(moveRequest('src/index.ts', 'moved.ts'), {
          host: host(),
          signal: controller.signal,
          io: {
            linkEntry: async (from, to) => {
              await link(from, to);
              controller.abort('caller');
            },
            unlinkEntry,
          },
        }),
      );
      expect(error.payload.kind).toBe('cancelled');
      expect(unlinkEntry).not.toHaveBeenCalledWith(source);
      expect(await readFile(source, 'utf8')).toBe('export {};\n');
      expect((await lstat(source)).nlink).toBe(1);
      await expectMissing(join(repo, 'moved.ts'));
    });
  });

  describe('folder moves', () => {
    itPosix(
      'reserves the destination on POSIX and removes only its empty reservation',
      async () => {
        await expect(
          moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
            host: host({ os: 'linux' }),
            io: {
              renameEntry: async (_from, to) => {
                expect((await lstat(to)).isDirectory()).toBe(true);
                throw errno('EIO');
              },
            },
          }),
        ).rejects.toMatchObject({ code: 'EIO' });
        await expectMissing(join(repo, 'moved-docs'));
        expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
          '# Intro\n',
        );
      },
    );

    it('keeps both complete copies when the cross-device source removal fails', async () => {
      const removeEntry = jest.fn(
        async (
          pathValue: string,
          options: { recursive: true; force: false },
        ) => {
          if (pathValue === join(repo, 'docs'))
            throw new Error('source cleanup failed');
          await rm(pathValue, options);
        },
      );
      await expect(
        moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
          host: host(),
          io: {
            renameEntry: () => Promise.reject(errno('EXDEV')),
            removeEntry,
          },
        }),
      ).rejects.toThrow('source cleanup failed');
      for (const folder of ['docs', 'moved-docs'])
        expect(
          await readFile(join(repo, folder, 'guide', 'intro.md'), 'utf8'),
        ).toBe('# Intro\n');
    });

    it('keeps both complete copies when aborted before the cross-device source removal', async () => {
      const controller = new AbortController();
      const removeEntry = jest.fn(() => Promise.resolve());
      const { error } = await moveFailure(
        moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
          host: host(),
          signal: controller.signal,
          io: {
            renameEntry: () => Promise.reject(errno('EXDEV')),
            publishRenameEntry: async (from, to) => {
              await rename(from, to);
              controller.abort('caller');
            },
            removeEntry,
          },
        }),
      );
      expect(error.payload.kind).toBe('cancelled');
      expect(removeEntry).not.toHaveBeenCalled();
      for (const folder of ['docs', 'moved-docs'])
        expect(
          await readFile(join(repo, folder, 'guide', 'intro.md'), 'utf8'),
        ).toBe('# Intro\n');
    });

    it('does not merge a cross-device folder move into a concurrent destination', async () => {
      const target = join(repo, 'moved-docs');
      const { error } = await moveFailure(
        moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
          host: host({ os: 'linux' }),
          io: {
            renameEntry: () => Promise.reject(errno('EXDEV')),
            copyEntry: async (source, stagingPath) => {
              await mkdir(target, { recursive: true });
              await writeFile(join(target, 'foreign.txt'), 'foreign\n');
              await cp(source, stagingPath, {
                recursive: true,
                errorOnExist: true,
                force: false,
              });
            },
          },
        }),
      );
      expect(error.payload).toEqual(exists('moved-docs'));
      expect(await readdir(target)).toEqual(['foreign.txt']);
      expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    it('keeps foreign destination content when a staged cross-device copy fails', async () => {
      const target = join(repo, 'moved-docs');
      await expect(
        moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
          host: host(),
          io: {
            renameEntry: () => Promise.reject(errno('EXDEV')),
            copyEntry: async (_source, stagingPath) => {
              await mkdir(target, { recursive: true });
              await writeFile(join(target, 'foreign.txt'), 'foreign\n');
              await mkdir(stagingPath, { recursive: true });
              await writeFile(join(stagingPath, 'partial.txt'), 'partial\n');
              throw new Error('copy interrupted');
            },
          },
        }),
      ).rejects.toThrow('copy interrupted');
      expect(await readdir(target)).toEqual(['foreign.txt']);
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    it('renames on Windows without pre-creating the destination', async () => {
      const source = join(repo, 'docs');
      const target = join(repo, 'moved-docs');
      const renameEntry = jest.fn(async (from: string, to: string) => {
        await expect(access(to)).rejects.toMatchObject({ code: 'ENOENT' });
        await rename(from, to);
      });
      await moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
        host: host({ os: 'win32' }),
        io: { renameEntry },
      });
      expect(renameEntry).toHaveBeenCalledWith(source, target);
      await expectMissing(source);
    });

    it('maps Windows rename refusals onto an occupied destination to a conflict', async () => {
      const target = join(repo, 'moved-docs');
      for (const [code, createTarget] of [
        ['EEXIST', false],
        ['ENOTEMPTY', false],
        ['EPERM', true],
        ['EACCES', true],
      ] as const) {
        const { error } = await moveFailure(
          moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
            host: host({ os: 'win32' }),
            io: {
              renameEntry: async () => {
                if (createTarget) await mkdir(target);
                throw errno(code);
              },
            },
          }),
        );
        expect(error.payload).toEqual(exists('moved-docs'));
        await rm(target, { recursive: true, force: true });
      }
      // Without a destination, a Windows EPERM is the raw failure.
      await expect(
        moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
          host: host({ os: 'win32' }),
          io: { renameEntry: () => Promise.reject(errno('EPERM')) },
        }),
      ).rejects.toMatchObject({ code: 'EPERM' });
    });

    it('copies, then removes the source, after a Windows EXDEV', async () => {
      await moveFilesystemEntry(moveRequest('docs', 'moved-docs'), {
        host: host({ os: 'win32' }),
        io: { renameEntry: () => Promise.reject(errno('EXDEV')) },
      });
      await expectMissing(join(repo, 'docs'));
      expect(
        await readFile(join(repo, 'moved-docs/guide/intro.md'), 'utf8'),
      ).toBe('# Intro\n');
    });
  });

  describe('symlink moves', () => {
    itPosix('moves file and folder symlinks as links', async () => {
      await symlink('src/index.ts', join(repo, 'file-link'));
      await symlink('docs', join(repo, 'dir-link'));
      await moveFilesystemEntry(moveRequest('file-link', 'src/file-link'), {
        host: host(),
      });
      await moveFilesystemEntry(moveRequest('dir-link', 'renamed-dir-link'), {
        host: host(),
      });
      expect(await readlink(join(repo, 'src', 'file-link'))).toBe(
        'src/index.ts',
      );
      expect(await readlink(join(repo, 'renamed-dir-link'))).toBe('docs');
      expect((await lstat(join(repo, 'src', 'index.ts'))).nlink).toBe(1);
      await expectMissing(join(repo, 'file-link'));
      await expectMissing(join(repo, 'dir-link'));
    });

    // The macOS path recreates the link; any POSIX host can run it.
    itPosix(
      'rolls a recreated link back only while its source link remains',
      async () => {
        const kept = join(repo, 'kept-link');
        const vanishing = join(repo, 'vanishing-link');
        await symlink('src/index.ts', kept);
        await symlink('src/index.ts', vanishing);
        const unlinkEntry = jest.fn(async (pathValue: string) => {
          if (pathValue === kept) throw errno('EPERM', 'source cleanup denied');
          if (pathValue === vanishing) {
            await rm(vanishing);
            throw errno('ENOENT', 'source vanished');
          }
          await rm(pathValue);
        });
        const darwin = host({ os: 'darwin' });
        await expect(
          moveFilesystemEntry(moveRequest('kept-link', 'kept-target'), {
            host: darwin,
            io: { unlinkEntry },
          }),
        ).rejects.toThrow('source cleanup denied');
        await expect(
          moveFilesystemEntry(
            moveRequest('vanishing-link', 'vanishing-target'),
            {
              host: darwin,
              io: { unlinkEntry },
            },
          ),
        ).rejects.toThrow('source vanished');
        expect(await readlink(kept)).toBe('src/index.ts');
        await expectMissing(join(repo, 'kept-target'));
        expect(await readlink(join(repo, 'vanishing-target'))).toBe(
          'src/index.ts',
        );
        await expectMissing(vanishing);
      },
    );

    itPosix(
      'does not overwrite a symlink destination created after the conflict check',
      async () => {
        await symlink('src/index.ts', join(repo, 'race-link'));
        const target = join(repo, 'race-link-target');
        const { error } = await moveFailure(
          moveFilesystemEntry(moveRequest('race-link', 'race-link-target'), {
            host: host({ os: 'darwin' }),
            io: {
              beforeMove: async () => {
                await writeFile(target, 'concurrent target\n');
              },
            },
          }),
        );
        expect(error.payload).toEqual(exists('race-link-target'));
        expect(await readFile(target, 'utf8')).toBe('concurrent target\n');
        expect(await readlink(join(repo, 'race-link'))).toBe('src/index.ts');
      },
    );

    itPosix(
      'rolls the recreated link back when aborted before the source is unlinked',
      async () => {
        const source = join(repo, 'file-link');
        await symlink('src/index.ts', source);
        const controller = new AbortController();
        const originalSymlink = fsPromises.symlink;
        const recreated = jest
          .spyOn(fsPromises, 'symlink')
          .mockImplementation(async (...args) => {
            await originalSymlink(...args);
            controller.abort('caller');
          });
        const unlinkEntry = jest.fn((pathValue: string) => rm(pathValue));
        try {
          const { error } = await moveFailure(
            moveFilesystemEntry(moveRequest('file-link', 'moved-link'), {
              host: host({ os: 'darwin' }),
              signal: controller.signal,
              io: { unlinkEntry },
            }),
          );
          expect(error.payload.kind).toBe('cancelled');
        } finally {
          recreated.mockRestore();
        }
        expect(unlinkEntry).not.toHaveBeenCalledWith(source);
        expect(await readlink(source)).toBe('src/index.ts');
        await expectMissing(join(repo, 'moved-link'));
      },
    );
  });

  describe('excluded descendant roots', () => {
    let child = '';
    const parentRoots = (): FilesystemEntryRoot[] => [
      {
        fileRootId: 'parent',
        absolutePath: repo,
        excludedDescendantRoots: [child],
      },
      { fileRootId: 'child', absolutePath: child, excludedDescendantRoots: [] },
    ];

    beforeEach(async () => {
      child = join(repo, 'repos', 'app');
      await put(join(child, 'child.txt'), 'child\n');
    });

    it('refuses reaching another root through the parent, either way', async () => {
      const target = host({}, parentRoots);
      const belongs =
        'Path belongs to another file-tree root; use that root instead.';
      for (const [source, destination] of [
        ['repos/app/child.txt', 'out.txt'],
        ['src/index.ts', 'repos/app/in.txt'],
      ]) {
        for (const operation of ['copy', 'move'] as const) {
          const call =
            operation === 'copy'
              ? copyFilesystemEntry(
                  {
                    ...copyRequest(source, destination),
                    sourceFileRootId: 'parent',
                    destinationFileRootId: 'parent',
                  },
                  { host: target },
                )
              : moveFilesystemEntry(
                  {
                    ...moveRequest(source, destination),
                    sourceFileRootId: 'parent',
                    destinationFileRootId: 'parent',
                  },
                  { host: target },
                );
          const { error } = await failureFor(
            operation === 'copy' ? COPY.error : MOVE.error,
            call,
          );
          expect(error.payload).toMatchObject({
            kind: 'failed_precondition',
            code: 'worker.filesystem.root.excluded',
            message: belongs,
          });
        }
      }
      await expectMissing(join(repo, 'out.txt'));
      await expectMissing(join(child, 'in.txt'));
      await expect(
        moveFilesystemEntry(
          {
            ...moveRequest('src/index.ts', 'in.txt'),
            sourceFileRootId: 'parent',
            destinationFileRootId: 'child',
          },
          { host: target },
        ),
      ).resolves.toMatchObject({ destinationFileRootId: 'child' });
    });

    it('lets a copy source contain another root, but not a move source', async () => {
      const target = host({}, parentRoots);
      const { error } = await moveFailure(
        moveFilesystemEntry(
          {
            ...moveRequest('repos', 'moved-repos'),
            sourceFileRootId: 'parent',
            destinationFileRootId: 'parent',
          },
          { host: target },
        ),
      );
      expect(error.payload).toMatchObject({
        code: 'worker.filesystem.root.excluded',
        message: 'Path contains another file-tree root.',
      });
      await copyFilesystemEntry(
        {
          ...copyRequest('repos', 'repos-copy'),
          sourceFileRootId: 'parent',
          destinationFileRootId: 'parent',
        },
        { host: target },
      );
      expect(
        await readFile(join(repo, 'repos-copy', 'app', 'child.txt'), 'utf8'),
      ).toBe('child\n');
      expect(await readFile(join(child, 'child.txt'), 'utf8')).toBe('child\n');
    });

    itPosix(
      'refuses a move whose validated destination parent is swapped into another root',
      async () => {
        await mkdir(join(repo, 'staging'));
        const { error } = await moveFailure(
          moveFilesystemEntry(
            {
              ...moveRequest('src/index.ts', 'staging/moved.ts'),
              sourceFileRootId: 'parent',
              destinationFileRootId: 'parent',
            },
            {
              host: host({}, parentRoots),
              io: {
                beforeMove: async () => {
                  await rename(
                    join(repo, 'staging'),
                    join(repo, 'staging-original'),
                  );
                  await symlink(join('repos', 'app'), join(repo, 'staging'));
                },
              },
            },
          ),
        );
        expect(error.payload.code).toBe('worker.filesystem.root.excluded');
        await expectMissing(join(child, 'moved.ts'));
      },
    );
  });
});
