import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
  WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
  type CanopyCallerDescriptor,
  type WorkerFilesystemDirectoryCreateParams,
  type WorkerFilesystemFileWriteParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  FilesystemEntryMutationHost,
  FilesystemEntryRoot,
} from '@canopy/core-runtime/node';

jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(
    (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
  ),
}));

import { resolveWorktreeTargetIds } from '../../lib/resolve-worktree';
import { PortalServiceError } from '../../services/portal-service-error';
import {
  createFileTreeEntryForLegacyIpc,
  saveTextFileForLegacyIpc,
  toLegacyFileSaveError,
  toLegacyFileTreeMutationError,
  type LegacyTextFileSave,
} from '../worker-filesystem-mutation-adapter';

/**
 * CAN-4100: the `file:save-content` and `file-tree:mutate` create projections
 * over `worker.filesystem.file.write` and `.directory.create`, with recording
 * dispatches. Their end-to-end answers are pinned by the IPC goldens.
 */

const os = process.platform === 'win32' ? 'win32' : 'darwin';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.write'],
};

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'write-projection-')));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function host(roots: FilesystemEntryRoot[]): FilesystemEntryMutationHost & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    os,
    assertMutable: (): void => {
      calls.push('assertMutable');
    },
    roots: (): Promise<FilesystemEntryRoot[]> => {
      calls.push('roots');
      return Promise.resolve(roots);
    },
    calls,
  };
}

function recordingWrite(): {
  calls: Array<[WorkerFilesystemFileWriteParams, unknown]>;
  dispatch: (
    params: WorkerFilesystemFileWriteParams,
    options: unknown,
  ) => Promise<never>;
} {
  const calls: Array<[WorkerFilesystemFileWriteParams, unknown]> = [];
  return {
    calls,
    dispatch: (params, options) => {
      calls.push([params, options]);
      return Promise.reject(new Error('recorded'));
    },
  };
}

describe('saveTextFileForLegacyIpc', () => {
  let repo = '';
  let child = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    child = join(repo, 'repos', 'app');
    await mkdir(join(repo, 'repos', 'stray'), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(join(repo, 'top.ts'), 'top\n');
    await writeFile(join(child, 'app.ts'), 'app\n');
    await writeFile(join(repo, 'repos', 'stray', 'stray.ts'), 'stray\n');
  });

  const roots = (): FilesystemEntryRoot[] => [
    {
      fileRootId: 'workspace',
      absolutePath: repo,
      excludedDescendantRoots: [join(repo, 'repos'), child],
    },
    { fileRootId: 'app', absolutePath: child, excludedDescendantRoots: [] },
  ];

  function save(realPath: string): LegacyTextFileSave {
    return {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      realPath,
      content: 'saved\n',
      expectedVersion: '4:1000',
    };
  }

  async function routed(
    realPath: string,
    testRoots: FilesystemEntryRoot[] = roots(),
  ): Promise<WorkerFilesystemFileWriteParams | 'unrouted'> {
    const write = recordingWrite();
    try {
      const answer = await saveTextFileForLegacyIpc(
        write.dispatch,
        host(testRoots),
        save(realPath),
        { caller },
      );
      if (answer === 'unrouted') return answer;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'recorded')
        throw error;
    }
    const [call] = write.calls;
    if (!call) throw new Error('Expected a dispatched write.');
    return call[0];
  }

  it('writes under the most specific root, with the exact version and a fresh key', async () => {
    const write = recordingWrite();
    await expect(
      saveTextFileForLegacyIpc(
        write.dispatch,
        host(roots()),
        save(join(child, 'app.ts')),
        { caller },
      ),
    ).rejects.toThrow('recorded');
    await expect(
      saveTextFileForLegacyIpc(
        write.dispatch,
        host(roots()),
        save(join(repo, 'top.ts')),
        { caller },
      ),
    ).rejects.toThrow('recorded');
    const [[first, firstOptions], [second]] = write.calls;
    expect(first).toEqual({
      scope: { workspaceId: 'workspace-1', worktreeId: 'wt-1' },
      fileRootId: 'app',
      relativePath: 'app.ts',
      content: 'saved\n',
      createOnly: false,
      expectedVersion: '4:1000',
      _meta: { idempotencyKey: first?._meta.idempotencyKey },
    });
    expect(first?._meta.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstOptions).toEqual({
      caller,
      metadata: { idempotencyKey: first?._meta.idempotencyKey },
    });
    expect(second).toMatchObject({
      fileRootId: 'workspace',
      relativePath: 'top.ts',
    });
    expect(second?._meta.idempotencyKey).not.toBe(first?._meta.idempotencyKey);
  });

  it('leaves save-only paths to the direct write', async () => {
    // Under an excluded folder that is no root, and outside every root.
    await expect(
      routed(join(repo, 'repos', 'stray', 'stray.ts')),
    ).resolves.toBe('unrouted');
    await writeFile(join(tempRoot, 'elsewhere.ts'), 'x');
    await expect(routed(join(tempRoot, 'elsewhere.ts'))).resolves.toBe(
      'unrouted',
    );
    await expect(routed(repo)).resolves.toBe('unrouted');
  });

  it('leaves a managed target that resolves to no worktree to the direct write', async () => {
    jest.mocked(resolveWorktreeTargetIds).mockReturnValueOnce(null);
    await expect(routed(join(repo, 'top.ts'))).resolves.toBe('unrouted');
  });

  it('leaves a scope whose explorer roots fail to read to the direct write', async () => {
    const write = recordingWrite();
    const failing = {
      ...host(roots()),
      roots: (): Promise<never> =>
        Promise.reject(
          new Error('The selected filesystem scope no longer exists.'),
        ),
    };
    await expect(
      saveTextFileForLegacyIpc(
        write.dispatch,
        failing,
        save(join(repo, 'top.ts')),
        {
          caller,
        },
      ),
    ).resolves.toBe('unrouted');
    expect(write.calls).toEqual([]);
  });

  (os === 'win32' ? it.skip : it)(
    'leaves only the POSIX names the write path check refuses to the direct write',
    async () => {
      for (const name of [
        join(repo, 'back\\slash.ts'),
        join(child, 'C:notes.md'),
        join(repo, 'c:folder', 'inner.ts'),
      ])
        await expect(routed(name)).resolves.toBe('unrouted');
      // A drive-like later segment and dots inside a name still route.
      await expect(
        routed(join(repo, 'src', 'C:notes.md')),
      ).resolves.toMatchObject({
        fileRootId: 'workspace',
        relativePath: 'src/C:notes.md',
      });
      await expect(routed(join(child, '..app.ts'))).resolves.toMatchObject({
        fileRootId: 'app',
        relativePath: '..app.ts',
      });
    },
  );

  it('maps a root reached through a symlink by its real path', async () => {
    const alias = join(tempRoot, 'alias');
    await symlink(repo, alias);
    await expect(
      routed(join(repo, 'top.ts'), [
        {
          fileRootId: 'alias',
          absolutePath: alias,
          excludedDescendantRoots: [],
        },
      ]),
    ).resolves.toMatchObject({ fileRootId: 'alias', relativePath: 'top.ts' });
  });

  it('answers a stale version as FileSaveConflictError and keeps causes', () => {
    expect(
      toLegacyFileSaveError(
        new CanopyOperationError({
          kind: 'conflict',
          code: 'worker.filesystem.file.revisionConflict',
          message: 'The file changed since it was read. Nothing was written.',
          retry: { kind: 'after_refresh', resource: 'worker.filesystem.file' },
        }),
      ),
    ).toMatchObject({
      name: 'FileSaveConflictError',
      message: 'File changed on disk since it was loaded.',
    });
    const cause = Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    expect(
      toLegacyFileSaveError(
        new CanopyOperationError(
          {
            kind: 'failed_precondition',
            code: 'worker.filesystem.file.invalidState',
            message: 'Path is not a file.',
            retry: { kind: 'never' },
          },
          cause,
        ),
      ),
    ).toBe(cause);
    expect(
      String(
        toLegacyFileSaveError(
          new CanopyOperationError({
            kind: 'resource_exhausted',
            message: 'The file is too large to write.',
            retry: { kind: 'never' },
          }),
        ),
      ),
    ).toBe('Error: The file is too large to write.');
  });
});

describe('createFileTreeEntryForLegacyIpc', () => {
  let repo = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'index.ts'), 'x');
  });

  function recordingDispatch(): {
    calls: Array<
      [
        string,
        WorkerFilesystemFileWriteParams | WorkerFilesystemDirectoryCreateParams,
      ]
    >;
    dispatch: Parameters<typeof createFileTreeEntryForLegacyIpc>[0];
  } {
    const calls: Array<
      [
        string,
        WorkerFilesystemFileWriteParams | WorkerFilesystemDirectoryCreateParams,
      ]
    > = [];
    return {
      calls,
      dispatch: {
        file: (params) => {
          calls.push(['file', params]);
          return Promise.resolve({
            relativePath: params.relativePath.replace(/^\.\//, ''),
            sizeBytes: 0,
            sha256: '',
            version: '0:0',
            modifiedAt: new Date(0).toISOString(),
          });
        },
        directory: (params) => {
          calls.push(['directory', params]);
          return Promise.resolve({
            fileRootId: params.fileRootId,
            relativePath: params.relativePath,
            createdParentPaths: [],
            version: '0:0',
          });
        },
      },
    };
  }

  const roots = (): FilesystemEntryRoot[] => [
    { fileRootId: 'repo', absolutePath: repo, excludedDescendantRoots: [] },
  ];

  it('creates a missing parent first, each call with its own key', async () => {
    const recorded = recordingDispatch();
    await createFileTreeEntryForLegacyIpc(
      recorded.dispatch,
      host(roots()),
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'create-file',
        target: { repoId: 'repo', relativePath: 'a/b/new.ts' },
      },
      { caller },
    );
    expect(
      recorded.calls.map(([kind, params]) => [kind, params.relativePath]),
    ).toEqual([
      ['directory', 'a/b'],
      ['file', 'a/b/new.ts'],
    ]);
    const [[, folder], [, file]] = recorded.calls;
    expect(folder).toMatchObject({ createParents: true, expectedAbsent: true });
    expect(file).toMatchObject({ createOnly: true, content: '' });
    expect(folder?._meta.idempotencyKey).not.toBe(file?._meta.idempotencyKey);
  });

  it('writes straight into an existing parent, or one that is no folder', async () => {
    for (const relativePath of ['src/new.ts', 'top.ts', 'src/index.ts/inner']) {
      const recorded = recordingDispatch();
      await createFileTreeEntryForLegacyIpc(
        recorded.dispatch,
        host(roots()),
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'create-file',
          target: { repoId: 'repo', relativePath },
        },
        { caller },
      );
      expect(recorded.calls.map(([kind]) => kind)).toEqual(['file']);
    }
  });

  it('refuses an empty folder path with the engine message before dispatch', async () => {
    const recorded = recordingDispatch();
    await expect(
      createFileTreeEntryForLegacyIpc(
        recorded.dispatch,
        host(roots()),
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'create-directory',
          target: { repoId: 'repo', relativePath: '' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      name: 'PortalServiceError',
      code: 'invalid_target',
      message: 'Create target cannot be a file-tree root.',
    });
    expect(recorded.calls).toEqual([]);
  });
});

describe('toLegacyFileTreeMutationError', () => {
  it('maps every file.write and directory.create code to a legacy code', () => {
    const legacyCodes: Record<string, string> = {
      'worker.filesystem.file.invalidState': 'invalid_target',
      'worker.filesystem.file.revisionConflict': 'invalid_target',
      'worker.filesystem.file.notFound': 'not_found',
      'worker.filesystem.root.notFound': 'not_found',
      'worker.filesystem.path.invalid': 'invalid_target',
      'worker.filesystem.path.escape': 'invalid_target',
      'worker.filesystem.split.locked': 'invalid_target',
      'worker.filesystem.root.excluded': 'invalid_target',
      'worker.filesystem.entry.exists': 'invalid_target',
      'worker.filesystem.symlink.rejected': 'invalid_target',
    };
    for (const code of [
      ...WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
      ...WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
    ]) {
      const mapped = toLegacyFileTreeMutationError(
        new CanopyOperationError({
          kind: 'failed_precondition',
          code,
          message: `message for ${code}`,
          retry: { kind: 'never' },
        }),
      );
      expect(mapped).toBeInstanceOf(PortalServiceError);
      expect(mapped).toMatchObject({ code: legacyCodes[code] });
    }
  });
});
