import {
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
  writeFile,
} from 'node:fs/promises';
import { promises as fsPromises, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  type WorkerFilesystemEntryDeleteParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { FilesystemEntryRoot } from '../entry-mutation-guards';
import {
  deleteFilesystemEntry,
  normalizeEntryDeletePath,
  type FilesystemEntryDeleteIo,
  type FilesystemEntryMutationHost,
  type FilesystemEntryRemoveOptions,
} from '../entry-mutations';

const DEFINITION =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.delete'
  ];

const posix = process.platform === 'win32' ? describe.skip : describe;
const itPosix = process.platform === 'win32' ? it.skip : it;
const hostOs = process.platform === 'win32' ? 'win32' : 'darwin';

let tempRoot = '';
let repo = '';
let outside = '';
const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function host(
  overrides: Partial<FilesystemEntryMutationHost> = {},
  roots: () => FilesystemEntryRoot[] = () => [
    { fileRootId: 'repo', absolutePath: repo, excludedDescendantRoots: [] },
  ],
): FilesystemEntryMutationHost & {
  trashed: string[];
  calls: string[];
} {
  const trashed: string[] = [];
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
    trash: {
      trashItem: (path): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      },
    },
    ...overrides,
    trashed,
    calls,
  };
}

function request(
  relativePath: string,
  disposition: WorkerFilesystemEntryDeleteParams['disposition'] = 'permanent',
  fileRootId = 'repo',
  changes: Partial<WorkerFilesystemEntryDeleteParams> = {},
): WorkerFilesystemEntryDeleteParams {
  return {
    scope,
    fileRootId,
    relativePath,
    expectedVersion: null,
    recursive: true,
    disposition,
    _meta: { idempotencyKey: 'key-1' },
    ...changes,
  };
}

function deleted(
  disposition: WorkerFilesystemEntryDeleteParams['disposition'],
): object {
  return { deleted: true, deletedEntryCount: 1, disposition };
}

async function failure(
  promise: Promise<unknown>,
): Promise<{ error: CanopyOperationError; cause: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a CanopyOperationError, got ${String(error)}`);
  // Every engine-authored failure fits the operation's error schema, so the
  // dispatcher forwards it instead of a bare internal error.
  expect(DEFINITION.error.safeParse(error.payload).success).toBe(true);
  expect(error.payload.retry.kind).not.toBe('same_idempotency_key');
  return { error, cause: error.runtimeCause };
}

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'entry-mutations-')));
  repo = join(tempRoot, 'repo');
  outside = join(tempRoot, 'outside');
  await put(join(repo, 'src', 'index.ts'), 'export {};\n');
  await put(join(repo, 'docs', 'guide', 'intro.md'), '# Intro\n');
  await put(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('deleteFilesystemEntry', () => {
  it('removes a file and a nested folder permanently, counting one entry', async () => {
    const target = host();
    const result = await deleteFilesystemEntry(request('docs/'), {
      host: target,
    });
    expect(result).toEqual(deleted('permanent'));
    expect(DEFINITION.result.parse(result)).toEqual(result);
    await deleteFilesystemEntry(request('./src/index.ts'), { host: target });
    expect(await readdir(repo)).toEqual(['src']);
    expect(await readdir(join(repo, 'src'))).toEqual([]);
    expect(target.trashed).toEqual([]);
  });

  it('hands a Trash delete the lexical path and removes nothing itself', async () => {
    const target = host();
    await expect(
      deleteFilesystemEntry(request('docs/guide', 'trash'), { host: target }),
    ).resolves.toEqual(deleted('trash'));
    expect(target.trashed).toEqual([join(repo, 'docs', 'guide')]);
    expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
      '# Intro\n',
    );
  });

  it('refuses a Trash delete without a Trash member before any lookup or effect', async () => {
    const target = host({ trash: undefined });
    const removeEntry = jest.fn<
      ReturnType<NonNullable<FilesystemEntryDeleteIo['removeEntry']>>,
      Parameters<NonNullable<FilesystemEntryDeleteIo['removeEntry']>>
    >();
    const { error } = await failure(
      deleteFilesystemEntry(request('src/index.ts', 'trash'), {
        host: target,
        io: { removeEntry },
      }),
    );
    expect(error.payload).toEqual({
      kind: 'capability_unavailable',
      code: 'worker.filesystem.trash.unavailable',
      message:
        "Couldn't move the item to the trash; no trash is available here. Nothing was deleted.",
      retry: { kind: 'never' },
    });
    expect(target.calls).toEqual(['assertMutable']);
    expect(removeEntry).not.toHaveBeenCalled();
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
    // A permanent delete needs no Trash member.
    await deleteFilesystemEntry(request('src/index.ts'), { host: target });
    expect(await readdir(join(repo, 'src'))).toEqual([]);
  });

  it('propagates a Trash rejection as trash.failed and keeps the entry', async () => {
    const rejection = new Error('Trash is unavailable');
    const target = host({
      trash: { trashItem: () => Promise.reject(rejection) },
    });
    const { error, cause } = await failure(
      deleteFilesystemEntry(request('src/index.ts', 'trash'), { host: target }),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.trash.failed',
    });
    expect(cause).toBe(rejection);
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('runs the host refusal first, before roots or effects', async () => {
    const refusal = new Error('read-only');
    const target = host({
      assertMutable: () => {
        throw refusal;
      },
    });
    await expect(
      deleteFilesystemEntry(request('src', 'trash'), { host: target }),
    ).rejects.toBe(refusal);
    expect(target.calls).toEqual([]);
    expect(target.trashed).toEqual([]);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('refuses an unknown root', async () => {
    const { error } = await failure(
      deleteFilesystemEntry(request('src', 'permanent', 'nope'), {
        host: host(),
      }),
    );
    expect(error.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.root.notFound',
      message: 'Unknown file root: nope',
    });
  });

  it('refuses absolute, traversing and root paths', async () => {
    for (const [relativePath, message] of [
      ['/etc/hosts', 'Path must be relative.'],
      ['C:/Windows', 'Path must be relative.'],
      ['C:relative', 'Path must be relative.'],
      ['../outside/secret.txt', 'Path cannot traverse outside the worktree.'],
      ['src/../../outside', 'Path cannot traverse outside the worktree.'],
      ['', 'Delete target cannot be a file-tree root.'],
      ['.', 'Delete target cannot be a file-tree root.'],
      ['./', 'Delete target cannot be a file-tree root.'],
    ]) {
      const { error } = await failure(
        deleteFilesystemEntry(request(relativePath), { host: host() }),
      );
      expect(error.payload).toMatchObject({
        kind: 'invalid_argument',
        code: 'worker.filesystem.entry.invalidPath',
        message,
      });
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret\n',
    );
  });

  itPosix(
    'refuses a backslash off Windows and reads it as a separator on Windows',
    async () => {
      await put(join(repo, 'a\\b'), 'literal\n');
      await put(join(repo, 'a', 'b'), 'nested\n');
      const { error } = await failure(
        deleteFilesystemEntry(request('a\\b'), { host: host({ os: 'linux' }) }),
      );
      expect(error.payload).toMatchObject({
        code: 'worker.filesystem.entry.invalidPath',
        message: 'Delete target cannot contain a backslash.',
      });
      expect((await readdir(repo)).sort()).toEqual([
        'a',
        'a\\b',
        'docs',
        'src',
      ]);
      // The OS is the host's parameter, not the process's.
      await expect(
        deleteFilesystemEntry(request('a\\b'), { host: host({ os: 'win32' }) }),
      ).resolves.toEqual(deleted('permanent'));
      expect(normalizeEntryDeletePath('a\\b', 'win32')).toBe('a/b');
      expect(await readdir(join(repo, 'a'))).toEqual([]);
      expect(await readFile(join(repo, 'a\\b'), 'utf8')).toBe('literal\n');
    },
  );

  it('fails a missing target as entry.notFound, keeping the ENOENT cause', async () => {
    const { error, cause } = await failure(
      deleteFilesystemEntry(request('gone.txt'), { host: host() }),
    );
    expect(error.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.entry.notFound',
    });
    expect(error.payload.message).not.toContain(tempRoot);
    expect(cause).toMatchObject({ code: 'ENOENT' });
  });

  posix('symlinks', () => {
    it('removes an in-root symlink as a link, never its target', async () => {
      await symlink('docs', join(repo, 'docs-alias'));
      const target = host();
      await deleteFilesystemEntry(request('docs-alias'), { host: target });
      await expect(lstat(join(repo, 'docs-alias'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
      await symlink('docs', join(repo, 'trash-alias'));
      await deleteFilesystemEntry(request('trash-alias', 'trash'), {
        host: target,
      });
      expect(target.trashed).toEqual([join(repo, 'trash-alias')]);
    });

    it('refuses a symlink that points outside the root, even to Trash', async () => {
      await symlink(outside, join(repo, 'escape'));
      const target = host();
      for (const disposition of ['trash', 'permanent'] as const) {
        const { error } = await failure(
          deleteFilesystemEntry(request('escape', disposition), {
            host: target,
          }),
        );
        expect(error.payload).toMatchObject({
          kind: 'failed_precondition',
          code: 'worker.filesystem.entry.outsideRoot',
          message: 'File is outside the selected worktree root.',
        });
      }
      expect(target.trashed).toEqual([]);
      expect((await lstat(join(repo, 'escape'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'secret\n',
      );
    });

    it('fails a dangling symlink as missing and leaves it', async () => {
      await symlink('missing', join(repo, 'dangling'));
      const { error, cause } = await failure(
        deleteFilesystemEntry(request('dangling'), { host: host() }),
      );
      expect(error.payload.code).toBe('worker.filesystem.entry.notFound');
      expect(cause).toMatchObject({ code: 'ENOENT' });
      expect(await readlink(join(repo, 'dangling'))).toBe('missing');
    });

    it('refuses an entry reached through a folder outside the root, even when it links back in', async () => {
      // `out` leaves the root; `out/back` resolves inside it again, so the
      // target's own real path is contained but `rm` would act outside.
      await symlink(outside, join(repo, 'out'));
      await symlink(join(repo, 'src', 'index.ts'), join(outside, 'back'));
      const { error } = await failure(
        deleteFilesystemEntry(request('out/back'), { host: host() }),
      );
      expect(error.payload.code).toBe('worker.filesystem.entry.outsideRoot');
      expect(await readlink(join(outside, 'back'))).toBe(
        join(repo, 'src', 'index.ts'),
      );
    });

    it('re-checks the parent folder right before the effect', async () => {
      // Swapped for a symlink out of the root after validation.
      const target = host();
      const { error } = await failure(
        deleteFilesystemEntry(request('docs/guide/intro.md', 'trash'), {
          host: target,
          io: {
            beforeDelete: async () => {
              await rename(join(repo, 'docs', 'guide'), join(repo, 'kept'));
              await mkdir(join(outside, 'guide'));
              await put(join(outside, 'guide', 'intro.md'), 'outside\n');
              await symlink(
                join(outside, 'guide'),
                join(repo, 'docs', 'guide'),
              );
            },
          },
        }),
      );
      expect(error.payload).toMatchObject({
        code: 'worker.filesystem.entry.outsideRoot',
      });
      expect(target.trashed).toEqual([]);
      expect(await readFile(join(outside, 'guide', 'intro.md'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('refuses when the parent folder moved inside the root after validation', async () => {
      const removeEntry = jest.fn<
        Promise<void>,
        [string, FilesystemEntryRemoveOptions]
      >(() => Promise.resolve());
      const { error } = await failure(
        deleteFilesystemEntry(request('docs/guide/intro.md'), {
          host: host(),
          io: {
            removeEntry,
            beforeDelete: async () => {
              await rename(join(repo, 'docs', 'guide'), join(repo, 'kept'));
              await symlink(join(repo, 'src'), join(repo, 'docs', 'guide'));
            },
          },
        }),
      );
      expect(error.payload).toMatchObject({
        kind: 'conflict',
        code: 'worker.filesystem.entry.changed',
      });
      expect(removeEntry).not.toHaveBeenCalled();
    });
  });

  it('stops before the effect once the call is aborted', async () => {
    const controller = new AbortController();
    const target = host();
    for (const disposition of ['trash', 'permanent'] as const) {
      const removeEntry = jest.fn<
        Promise<void>,
        [string, FilesystemEntryRemoveOptions]
      >(() => Promise.resolve());
      const { error } = await failure(
        deleteFilesystemEntry(request('src', disposition), {
          host: target,
          signal: controller.signal,
          io: {
            removeEntry,
            beforeDelete: () => {
              controller.abort('caller');
              return Promise.resolve();
            },
          },
        }),
      );
      expect(error.payload.kind).toBe('cancelled');
      expect(removeEntry).not.toHaveBeenCalled();
    }
    expect(target.trashed).toEqual([]);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('refuses a non-null expectedVersion after the host refusal, before any lookup or effect', async () => {
    for (const disposition of ['trash', 'permanent'] as const) {
      const target = host();
      const { error } = await failure(
        deleteFilesystemEntry(
          request('src/index.ts', disposition, 'repo', {
            expectedVersion: '12:34',
          }),
          { host: target },
        ),
      );
      expect(error.payload).toEqual({
        kind: 'capability_unavailable',
        message:
          "This host can't compare expectedVersion; send null. Nothing was deleted.",
        details: { option: 'expectedVersion' },
        retry: { kind: 'never' },
      });
      expect(target.calls).toEqual(['assertMutable']);
      expect(target.trashed).toEqual([]);
    }
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  describe('recursive: false', () => {
    const shallow = (
      relativePath: string,
      disposition: WorkerFilesystemEntryDeleteParams['disposition'] = 'permanent',
    ): WorkerFilesystemEntryDeleteParams =>
      request(relativePath, disposition, 'repo', { recursive: false });

    it('deletes a file and an empty folder, and trashes a file', async () => {
      await mkdir(join(repo, 'empty'));
      await put(join(repo, 'notes.txt'), 'notes\n');
      const target = host();
      await expect(
        deleteFilesystemEntry(shallow('src/index.ts'), { host: target }),
      ).resolves.toEqual(deleted('permanent'));
      await expect(
        deleteFilesystemEntry(shallow('empty'), { host: target }),
      ).resolves.toEqual(deleted('permanent'));
      await expect(
        deleteFilesystemEntry(shallow('notes.txt', 'trash'), { host: target }),
      ).resolves.toEqual(deleted('trash'));
      expect((await readdir(repo)).sort()).toEqual([
        'docs',
        'notes.txt',
        'src',
      ]);
      expect(await readdir(join(repo, 'src'))).toEqual([]);
      expect(target.trashed).toEqual([join(repo, 'notes.txt')]);
    });

    it('refuses a non-empty folder before any effect, for both dispositions', async () => {
      const target = host();
      for (const disposition of ['trash', 'permanent'] as const) {
        const removeEntry = jest.fn<
          Promise<void>,
          [string, FilesystemEntryRemoveOptions]
        >(() => Promise.resolve());
        const beforeDelete = jest.fn(() => Promise.resolve());
        const { error } = await failure(
          deleteFilesystemEntry(shallow('docs', disposition), {
            host: target,
            io: { removeEntry, beforeDelete },
          }),
        );
        expect(error.payload).toEqual({
          kind: 'failed_precondition',
          code: 'worker.filesystem.entry.invalidState',
          message:
            "The folder isn't empty, and recursive is false. Nothing was deleted.",
          retry: { kind: 'never' },
        });
        expect(beforeDelete).not.toHaveBeenCalled();
        expect(removeEntry).not.toHaveBeenCalled();
      }
      expect(target.trashed).toEqual([]);
      expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
    });

    itPosix('removes a symlink to a non-empty folder as a link', async () => {
      await symlink('docs', join(repo, 'docs-alias'));
      await deleteFilesystemEntry(shallow('docs-alias'), { host: host() });
      await expect(lstat(join(repo, 'docs-alias'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
    });

    it('refuses a folder that filled after the check, keeping its contents', async () => {
      await mkdir(join(repo, 'empty'));
      const { error, cause } = await failure(
        deleteFilesystemEntry(shallow('empty'), {
          host: host(),
          io: {
            beforeDelete: () => put(join(repo, 'empty', 'late.txt'), 'late\n'),
          },
        }),
      );
      expect(error.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'worker.filesystem.entry.invalidState',
      });
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? cause.code
          : undefined;
      expect(['ENOTEMPTY', 'EEXIST']).toContain(code);
      expect(await readFile(join(repo, 'empty', 'late.txt'), 'utf8')).toBe(
        'late\n',
      );
    });

    it('refuses to trash a folder that could fill after the check', async () => {
      await mkdir(join(repo, 'empty'));
      const target = host();
      const beforeDelete = jest.fn(() =>
        put(join(repo, 'empty', 'late.txt'), 'late\n'),
      );
      const { error } = await failure(
        deleteFilesystemEntry(shallow('empty', 'trash'), {
          host: target,
          io: { beforeDelete },
        }),
      );
      expect(error.payload).toEqual({
        kind: 'capability_unavailable',
        message:
          "This host can't move a folder to the trash with recursive false; send recursive true or delete it permanently. Nothing was deleted.",
        details: { option: 'recursive' },
        retry: { kind: 'never' },
      });
      expect(beforeDelete).not.toHaveBeenCalled();
      expect(target.trashed).toEqual([]);
      expect(await readdir(join(repo, 'empty'))).toEqual([]);
    });

    it('refuses to trash a file swapped for a folder after the check', async () => {
      const target = host();
      const { error } = await failure(
        deleteFilesystemEntry(shallow('src/index.ts', 'trash'), {
          host: target,
          io: {
            beforeDelete: async () => {
              await rm(join(repo, 'src', 'index.ts'));
              await put(join(repo, 'src', 'index.ts', 'late.txt'), 'late\n');
            },
          },
        }),
      );
      expect(error.payload).toMatchObject({
        kind: 'capability_unavailable',
        details: { option: 'recursive' },
      });
      expect(target.trashed).toEqual([]);
      expect(
        await readFile(join(repo, 'src', 'index.ts', 'late.txt'), 'utf8'),
      ).toBe('late\n');
    });

    it('passes recursive through to the remove seam', async () => {
      const removeEntry = jest.fn<
        Promise<void>,
        [string, FilesystemEntryRemoveOptions]
      >(() => Promise.resolve());
      await deleteFilesystemEntry(shallow('src/index.ts'), {
        host: host(),
        io: { removeEntry },
      });
      await deleteFilesystemEntry(request('docs'), {
        host: host(),
        io: { removeEntry },
      });
      expect(removeEntry.mock.calls).toEqual([
        [join(repo, 'src', 'index.ts'), { recursive: false, force: false }],
        [join(repo, 'docs'), { recursive: true, force: false }],
      ]);
    });
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

    it('refuses a path at, inside or containing another root through the parent', async () => {
      const target = host({}, parentRoots);
      for (const [relativePath, message] of [
        [
          'repos/app',
          'Path belongs to another file-tree root; use that root instead.',
        ],
        [
          'repos/app/child.txt',
          'Path belongs to another file-tree root; use that root instead.',
        ],
        ['repos', 'Path contains another file-tree root.'],
      ]) {
        for (const disposition of ['trash', 'permanent'] as const) {
          const { error } = await failure(
            deleteFilesystemEntry(
              request(relativePath, disposition, 'parent'),
              { host: target },
            ),
          );
          expect(error.payload).toMatchObject({
            kind: 'failed_precondition',
            code: 'worker.filesystem.root.excluded',
            message,
          });
        }
      }
      expect(target.trashed).toEqual([]);
      expect(await readFile(join(child, 'child.txt'), 'utf8')).toBe('child\n');
      await deleteFilesystemEntry(request('child.txt', 'trash', 'child'), {
        host: target,
      });
      expect(target.trashed).toEqual([join(child, 'child.txt')]);
    });

    itPosix(
      'compares the parent re-check with the folder validated before the other-root check',
      async () => {
        // The swap lands while the other-root check runs, so a parent read
        // after that check would match the re-check and delete src/intro.md.
        await put(join(repo, 'src', 'intro.md'), 'src\n');
        const originalRealpath = fsPromises.realpath;
        let swapped = false;
        const resolved = jest
          .spyOn(fsPromises, 'realpath')
          .mockImplementation(async (...args) => {
            if (!swapped && args[0] === join(repo, 'repos')) {
              swapped = true;
              renameSync(join(repo, 'docs', 'guide'), join(repo, 'kept'));
              symlinkSync(join(repo, 'src'), join(repo, 'docs', 'guide'));
            }
            return originalRealpath(...args);
          });
        try {
          const { error } = await failure(
            deleteFilesystemEntry(
              request('docs/guide/intro.md', 'permanent', 'parent'),
              { host: host({}, parentRoots) },
            ),
          );
          expect(swapped).toBe(true);
          expect(error.payload).toMatchObject({
            kind: 'conflict',
            code: 'worker.filesystem.entry.changed',
          });
        } finally {
          resolved.mockRestore();
        }
        expect(await readFile(join(repo, 'src', 'intro.md'), 'utf8')).toBe(
          'src\n',
        );
      },
    );
  });
});
