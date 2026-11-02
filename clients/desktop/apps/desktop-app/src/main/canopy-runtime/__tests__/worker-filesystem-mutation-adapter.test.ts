import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(
    (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
  ),
}));

jest.mock('../../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn(() => Promise.resolve()),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  withWorkspaceTargetArchiveDrain,
  withWorkspaceTargetAutoArchiveLease,
} from '../../lib/workspace-target-exclusion';
import { registerFileTreeHandlers } from '../../ipc/file-tree';
import { PortalServiceError } from '../../services/portal-service-error';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  deriveDesktopIpcCaller,
  type DesktopAppWindow,
  type DesktopIpcEvent,
} from '../desktop-ipc-caller';
import {
  createDesktopEntryMutationHost,
  createWorkerFilesystemMutationAdapter,
  toLegacyFileTreeMutationError,
} from '../worker-filesystem-mutation-adapter';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const APP_URL = 'file:///app/renderer/index.html';
const os = process.platform === 'win32' ? 'win32' : 'darwin';

function createEvent(id: number): DesktopIpcEvent {
  const mainFrame = {
    url: APP_URL,
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id,
      mainFrame,
      getURL: (): string => APP_URL,
      isDestroyed: (): boolean => false,
    },
    senderFrame: mainFrame,
  };
}

const windowEvent = createEvent(41);
const untrackedEvent = createEvent(42);
const appWindow: DesktopAppWindow = {
  isDestroyed: () => false,
  webContents: windowEvent.sender,
};

let tempRoot = '';
let repo = '';
let attachments = '';
let runtime: DesktopCanopyDispatcher | undefined;
const trashed: string[] = [];

function root(repoId: string, absolutePath: string): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
}

function useRoots(roots: FileBrowserRoot[]): void {
  mockedGetFileBrowserRoots.mockResolvedValue({
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  });
}

function start(
  options: Parameters<typeof createDesktopRuntime>[0] = {},
): DesktopCanopyDispatcher {
  const created = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    platform: {
      os,
      trash: {
        trashItem: (path) => {
          trashed.push(path);
          return Promise.resolve();
        },
      },
    },
    ...options,
  });
  runtime = created;
  registerFileTreeHandlers(created, (event) =>
    deriveDesktopIpcCaller(event, {
      getAppWindows: () => [appWindow],
      packagedRendererUrls: [APP_URL],
    }),
  );
  return created;
}

async function mutate(
  request: Record<string, unknown>,
  event: DesktopIpcEvent = windowEvent,
): Promise<FileTreeMutationResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileTreeMutate);
  if (!handler) throw new Error('file-tree:mutate is not registered.');
  const response = await handler(event, request);
  if (typeof response !== 'object' || response === null)
    throw new Error('Expected a mutation response.');
  return { operation: 'delete', ...response };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection.');
    },
    (error: unknown) => error,
  );
}

const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

beforeEach(async () => {
  jest.clearAllMocks();
  handlers.clear();
  trashed.length = 0;
  tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'entry-delete-projection-')),
  );
  repo = join(tempRoot, 'repo');
  attachments = join(tempRoot, 'attachments');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'export {};\n');
  await mkdir(attachments);
  useRoots([root('project-1', repo), root('attachments', attachments)]);
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

describe('file-tree:mutate delete projection', () => {
  it('refuses an untracked sender before any lookup or effect', async () => {
    start();
    const error = await rejection(
      mutate(
        {
          ...scope,
          operation: 'delete',
          target: { repoId: 'project-1', relativePath: 'src' },
          useTrash: true,
        },
        untrackedEvent,
      ),
    );
    expect(String(error)).toBe('Error: Untrusted desktop IPC sender.');
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(trashed).toEqual([]);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('dispatches with exactly the write grant, a key and no deadline or signal', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    await expect(
      mutate({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: 'src/index.ts' },
        useTrash: true,
      }),
    ).resolves.toEqual({
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'src/index.ts' },
    });
    expect(instruction).toHaveBeenCalledTimes(1);
    const [name, params, options] = instruction.mock.calls[0] ?? [];
    expect(name).toBe('worker.filesystem.entry.delete');
    const idempotencyKey = options?.metadata?.idempotencyKey;
    expect(idempotencyKey).toEqual(expect.any(String));
    expect(params).toEqual({
      scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      fileRootId: 'project-1',
      relativePath: 'src/index.ts',
      expectedVersion: null,
      recursive: true,
      disposition: 'trash',
      _meta: { idempotencyKey },
    });
    // The caller and the key, nothing else: no deadline and no signal.
    expect(Object.keys(options ?? {})).toEqual(['caller', 'metadata']);
    expect(options?.metadata).toEqual({ idempotencyKey });
    expect(options?.caller.principalId).toBe('local-desktop-user');
    expect(options?.caller.grants).toEqual(['worker.filesystem.write']);
    expect(trashed).toEqual([join(repo, 'src', 'index.ts')]);
  });

  it('mints a fresh idempotency key for every call', async () => {
    await mkdir(join(repo, 'more'));
    await writeFile(join(repo, 'more', 'a.ts'), '');
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    for (const relativePath of ['src/index.ts', 'more/a.ts'])
      await mutate({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath },
      });
    const keys = instruction.mock.calls.map(
      ([, , options]) => options.metadata?.idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    instruction.mock.calls.forEach(([, params], index) =>
      expect(params).toMatchObject({
        _meta: { idempotencyKey: keys[index] },
      }),
    );
  });

  it('reports the normalized path, as mutateFileTree did', async () => {
    start();
    await expect(
      mutate({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: './src//index.ts' },
      }),
    ).resolves.toEqual({
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'src/index.ts' },
    });
    expect(await readdir(join(repo, 'src'))).toEqual([]);
  });

  it('maps a falsy useTrash to a permanent delete', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    await mutate({
      ...scope,
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'src' },
    });
    expect(instruction.mock.calls[0]?.[1]).toMatchObject({
      disposition: 'permanent',
    });
    expect(await readdir(repo)).toEqual([]);
    expect(trashed).toEqual([]);
  });

  it('uses the only root when repoId is omitted, after the host refusals', async () => {
    useRoots([root('project-1', repo)]);
    start();
    await expect(
      mutate({
        ...scope,
        operation: 'delete',
        target: { relativePath: 'src/index.ts' },
      }),
    ).resolves.toEqual({
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'src/index.ts' },
    });
    mockedGetFileBrowserRoots.mockClear();
    // The read-only refusal still comes first, as it did in mutateFileTree.
    await expect(
      rejection(
        mutate({
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'wt-1',
          operation: 'delete',
          target: { relativePath: 'src' },
        }),
      ).then(String),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('refuses ./ as the root instead of deleting the whole root', async () => {
    useRoots([root('project-1', repo)]);
    start();
    for (const relativePath of ['./', './/']) {
      for (const useTrash of [true, false]) {
        await expect(
          rejection(
            mutate({
              ...scope,
              operation: 'delete',
              target: { repoId: 'project-1', relativePath },
              useTrash,
            }),
          ).then(String),
        ).resolves.toBe(
          'PortalServiceError: Delete target cannot be a file-tree root.',
        );
      }
    }
    expect(trashed).toEqual([]);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('refuses a missing, null or non-object target as invalid_payload', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    const targets: Record<string, unknown>[] = [
      {},
      { target: undefined },
      { target: null },
      { target: 'x' },
      { target: 1 },
      { target: ['project-1', 'src'] },
    ];
    for (const target of targets) {
      const error = await rejection(
        mutate({ ...scope, operation: 'delete', ...target, useTrash: true }),
      );
      expect(error).toBeInstanceOf(PortalServiceError);
      expect(error).toMatchObject({ code: 'invalid_payload' });
      expect(String(error)).toBe(
        'PortalServiceError: Mutation target is missing.',
      );
    }
    // The read-only refusal still comes first, as it did in mutateFileTree.
    await expect(
      rejection(
        mutate({
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'wt-1',
          operation: 'delete',
          target: null,
        }),
      ).then(String),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
    expect(instruction).not.toHaveBeenCalled();
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(trashed).toEqual([]);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('refuses a delete once the runtime shuts down', async () => {
    const created = start();
    await created.shutdown();
    const error = await rejection(
      mutate({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: 'src' },
      }),
    );
    expect(String(error)).toBe('Error: The runtime is unavailable.');
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  // CAN-4100: create is a projection too, with the same caller narrowing.
  it('creates through directory.create and file.write with only the write grant', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    await mutate({
      ...scope,
      operation: 'create-file',
      target: { repoId: 'project-1', relativePath: 'lib/new.ts' },
    });
    await mutate({
      ...scope,
      operation: 'create-directory',
      target: { repoId: 'project-1', relativePath: 'empty' },
    });
    expect(
      instruction.mock.calls.map(([method, , options]) => [
        method,
        options.caller.grants,
      ]),
    ).toEqual([
      ['worker.filesystem.directory.create', ['worker.filesystem.write']],
      ['worker.filesystem.file.write', ['worker.filesystem.write']],
      ['worker.filesystem.directory.create', ['worker.filesystem.write']],
    ]);
    expect((await readdir(repo)).sort()).toEqual(['empty', 'lib', 'src']);
    expect(await readdir(join(repo, 'lib'))).toEqual(['new.ts']);
  });

  it('refuses an untracked sender before any create lookup or effect', async () => {
    start();
    for (const operation of ['create-file', 'create-directory'] as const) {
      const error = await rejection(
        mutate(
          {
            ...scope,
            operation,
            target: { repoId: 'project-1', relativePath: 'out' },
          },
          untrackedEvent,
        ),
      );
      expect(String(error)).toBe('Error: Untrusted desktop IPC sender.');
    }
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(repo)).toEqual(['src']);
  });
});

describe('file-tree:mutate copy and move projection', () => {
  const transfer = (
    operation: 'copy' | 'move',
    target: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ...scope,
    operation,
    source: { repoId: 'project-1', relativePath: 'src/index.ts' },
    target: { repoId: 'project-1', relativePath: target },
    ...extra,
  });

  it('refuses an untracked sender before any lookup or effect', async () => {
    start();
    for (const operation of ['copy', 'move'] as const) {
      const error = await rejection(
        mutate(transfer(operation, 'out.ts'), untrackedEvent),
      );
      expect(String(error)).toBe('Error: Untrusted desktop IPC sender.');
    }
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('dispatches copy and move with exactly the write grant, a fresh key and no deadline or signal', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    await expect(
      mutate(transfer('copy', 'src/index.ts', { conflict: 'increment' })),
    ).resolves.toEqual({
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'src/index.ts' },
      target: { repoId: 'project-1', relativePath: 'src/index copy.ts' },
    });
    await expect(
      mutate(
        transfer('move', 'moved.ts', {
          target: { repoId: 'attachments', relativePath: 'moved.ts' },
          conflict: 'increment',
        }),
      ),
    ).resolves.toEqual({
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'src/index.ts' },
      target: { repoId: 'attachments', relativePath: 'moved.ts' },
    });
    const keys = instruction.mock.calls.map(
      ([, , options]) => options.metadata?.idempotencyKey,
    );
    expect(keys).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(keys).size).toBe(2);
    expect(
      instruction.mock.calls.map(([name, params]) => [name, params]),
    ).toEqual([
      [
        'worker.filesystem.entry.copy',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
          sourceFileRootId: 'project-1',
          sourceRelativePath: 'src/index.ts',
          destinationFileRootId: 'project-1',
          destinationRelativePath: 'src/index.ts',
          expectedSourceVersion: null,
          conflictPolicy: 'increment',
          _meta: { idempotencyKey: keys[0] },
        },
      ],
      [
        'worker.filesystem.entry.move',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
          sourceFileRootId: 'project-1',
          destinationFileRootId: 'attachments',
          fromRelativePath: 'src/index.ts',
          toRelativePath: 'moved.ts',
          expectedSourceVersion: null,
          expectedDestinationAbsent: true,
          // A move never increments, whatever the request says.
          conflictPolicy: 'error',
          _meta: { idempotencyKey: keys[1] },
        },
      ],
    ]);
    instruction.mock.calls.forEach(([, , options], index) => {
      // The caller and the key, nothing else: no deadline and no signal.
      expect(Object.keys(options ?? {})).toEqual(['caller', 'metadata']);
      expect(options?.metadata).toEqual({ idempotencyKey: keys[index] });
      expect(options?.caller.grants).toEqual(['worker.filesystem.write']);
    });
    expect(await readdir(join(repo, 'src'))).toEqual(['index copy.ts']);
    expect((await readdir(attachments)).sort()).toEqual(['moved.ts']);
  });

  it('copies with the error policy unless increment is asked for', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    for (const conflict of [undefined, 'error', 'replace']) {
      await expect(
        rejection(mutate(transfer('copy', 'src/index.ts', { conflict }))).then(
          String,
        ),
      ).resolves.toBe(
        'PortalServiceError: A file or folder already exists at src/index.ts.',
      );
    }
    expect(instruction).toHaveBeenCalledTimes(3);
    for (const [, params] of instruction.mock.calls)
      expect(params).toMatchObject({ conflictPolicy: 'error' });
  });

  it('resolves omitted roots by the ambiguity rule, after the host refusals', async () => {
    start();
    const omitted = {
      source: { relativePath: 'src/index.ts' },
      target: { relativePath: 'copy.ts' },
    };
    await expect(
      rejection(mutate(transfer('copy', 'copy.ts', omitted))).then(String),
    ).resolves.toBe(
      'PortalServiceError: File root is ambiguous; provide fileRootLocalId or repoId.',
    );
    await expect(
      rejection(
        mutate(
          transfer('move', 'copy.ts', {
            source: { repoId: 'nope', relativePath: 'src/index.ts' },
            target: { relativePath: 'copy.ts' },
          }),
        ),
      ).then(String),
    ).resolves.toBe('PortalServiceError: Unknown file root: nope');
    useRoots([root('project-1', repo)]);
    await expect(
      mutate(transfer('copy', 'copy.ts', omitted)),
    ).resolves.toMatchObject({
      target: { repoId: 'project-1', relativePath: 'copy.ts' },
    });
    mockedGetFileBrowserRoots.mockClear();
    await expect(
      rejection(
        mutate({
          ...transfer('move', 'x.ts', omitted),
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        }),
      ).then(String),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('refuses an empty copy or move path with the engine message, after the host and root checks', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    for (const operation of ['copy', 'move'] as const) {
      for (const [source, target, rendered] of [
        ['', 'x.ts', 'Source cannot be a file-tree root.'],
        ['src/index.ts', '', 'Target cannot be a file-tree root.'],
        ['a\\b', '', 'Source cannot contain a backslash.'],
      ] as const) {
        if (source.includes('\\') && os === 'win32') continue;
        const error = await rejection(
          mutate({
            ...scope,
            operation,
            source: { repoId: 'project-1', relativePath: source },
            target: { repoId: 'project-1', relativePath: target },
          }),
        );
        expect(error).toMatchObject({ code: 'invalid_target' });
        expect(String(error)).toBe(`PortalServiceError: ${rendered}`);
      }
      await expect(
        rejection(
          mutate({
            ...scope,
            operation,
            source: { repoId: 'project-1', relativePath: '' },
            target: { repoId: 'nope', relativePath: 'x.ts' },
          }),
        ).then(String),
      ).resolves.toBe('PortalServiceError: Unknown file root: nope');
      await expect(
        rejection(
          mutate({
            ...scope,
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            operation,
            source: { repoId: 'project-1', relativePath: '' },
            target: { repoId: 'project-1', relativePath: 'x.ts' },
          }),
        ).then(String),
      ).resolves.toBe(
        'Error: Shared-container recipient workspaces are read-only',
      );
    }
    // A copy's empty path never reaches the dispatcher, whose schema refuses it.
    expect(
      instruction.mock.calls
        .map(([name]) => name)
        .every((name) => name === 'worker.filesystem.entry.move'),
    ).toBe(true);
    expect(await readdir(repo)).toEqual(['src']);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('reports a missing source only after the host refusals', async () => {
    start();
    const missingSource = {
      ...scope,
      operation: 'move',
      target: { repoId: 'project-1', relativePath: 'x.ts' },
    };
    await expect(rejection(mutate(missingSource)).then(String)).resolves.toBe(
      'PortalServiceError: Mutation source is missing.',
    );
    await expect(
      rejection(
        mutate({
          ...missingSource,
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        }),
      ).then(String),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
  });

  it('reports an absent, null or non-object endpoint as a malformed payload, after the host refusals', async () => {
    const created = start();
    const instruction = jest.spyOn(created, 'instruction');
    const without = (
      request: Record<string, unknown>,
      key: 'source' | 'target',
    ): Record<string, unknown> =>
      Object.fromEntries(Object.entries(request).filter(([k]) => k !== key));
    for (const operation of ['copy', 'move'] as const) {
      const request = transfer(operation, 'out.ts');
      for (const [malformed, rendered] of [
        [without(request, 'source'), 'Mutation source is missing.'],
        [{ ...request, source: null }, 'Mutation source is missing.'],
        [{ ...request, source: 'src/index.ts' }, 'Mutation source is missing.'],
        [{ ...request, source: [] }, 'Mutation source is missing.'],
        // JSON over the remote-control bridge drops an `undefined` endpoint.
        [without(request, 'target'), 'Mutation target is missing.'],
        [{ ...request, target: null }, 'Mutation target is missing.'],
        [{ ...request, target: ['out.ts'] }, 'Mutation target is missing.'],
      ] as const) {
        const error = await rejection(mutate(malformed));
        expect(error).toBeInstanceOf(PortalServiceError);
        expect(error).toMatchObject({ code: 'invalid_payload' });
        expect(String(error)).toBe(`PortalServiceError: ${rendered}`);
        await expect(
          rejection(
            mutate({
              ...malformed,
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            }),
          ).then(String),
        ).resolves.toBe(
          'Error: Shared-container recipient workspaces are read-only',
        );
      }
    }
    expect(instruction).not.toHaveBeenCalled();
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(repo)).toEqual(['src']);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('refuses a copy or move once the runtime shuts down', async () => {
    const created = start();
    await created.shutdown();
    for (const operation of ['copy', 'move'] as const) {
      const error = await rejection(mutate(transfer(operation, 'out.ts')));
      expect(String(error)).toBe('Error: The runtime is unavailable.');
    }
    expect(await readdir(repo)).toEqual(['src']);
  });

  it('rethrows Node failures as themselves', async () => {
    start({
      entryTransferIo: {
        linkEntry: () =>
          Promise.reject(
            Object.assign(new Error('EIO: injected'), { code: 'EIO' }),
          ),
      },
    });
    const error = await rejection(mutate(transfer('move', 'moved.ts')));
    expect(String(error)).toBe('Error: EIO: injected');
    expect(error).toMatchObject({ code: 'EIO' });
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });
});

describe('worker.filesystem.entry.delete on the desktop dispatcher', () => {
  const caller = (
    grants: CanopyCallerDescriptor['grants'],
  ): CanopyCallerDescriptor => ({
    principalId: 'local-desktop-user',
    clientInstanceId: 'test',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants,
  });
  const params = {
    scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
    fileRootId: 'project-1',
    relativePath: 'src',
    expectedVersion: null,
    recursive: true,
    disposition: 'permanent' as const,
    _meta: { idempotencyKey: 'k1' },
  };
  const keyed = { idempotencyKey: 'k1' };

  it('requires worker.filesystem.write; the desktop window grants alone are refused', async () => {
    const created = start();
    await expect(
      created.instruction('worker.filesystem.entry.delete', params, {
        caller: caller([
          'worker.filesystem.read',
          'core.workspace.read',
          'core.chat.read',
          'core.chat.write',
          'core.worktree.read',
        ]),
        metadata: keyed,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
    await expect(
      created.instruction('worker.filesystem.entry.delete', params, {
        caller: caller(['worker.filesystem.write']),
        metadata: keyed,
      }),
    ).resolves.toEqual({
      deleted: true,
      deletedEntryCount: 1,
      disposition: 'permanent',
    });
  });

  it('requires an idempotency key in the metadata and in params', async () => {
    const created = start();
    const options = { caller: caller(['worker.filesystem.write']) };
    for (const metadata of [undefined, {}])
      await expect(
        created.instruction('worker.filesystem.entry.delete', params, {
          ...options,
          ...(metadata && { metadata }),
        }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    const unkeyed = {
      scope: params.scope,
      fileRootId: params.fileRootId,
      relativePath: params.relativePath,
      expectedVersion: null,
      recursive: true,
      disposition: params.disposition,
    };
    await expect(
      created.instruction(
        'worker.filesystem.entry.delete',
        // @ts-expect-error -- `_meta` is required; the dispatcher checks it too.
        unkeyed,
        { ...options, metadata: keyed },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  // Pins accepted debt (q-14 D3, until CAN-4733), not the keyed contract:
  // CAN-4733 replaces this with a replay of the first outcome.
  it('accepted debt: a reused key re-executes, then fails safe as missing', async () => {
    const created = start();
    const call = (): Promise<unknown> =>
      created.instruction(
        'worker.filesystem.entry.delete',
        { ...params, relativePath: 'src/index.ts' },
        { caller: caller(['worker.filesystem.write']), metadata: keyed },
      );
    await expect(call()).resolves.toMatchObject({ deleted: true });
    await expect(call()).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'worker.filesystem.entry.notFound',
        retry: { kind: 'never' },
      },
    });
  });

  it('refuses a non-null expectedVersion before any effect', async () => {
    const created = start();
    await expect(
      created.instruction(
        'worker.filesystem.entry.delete',
        { ...params, expectedVersion: '1:2' },
        { caller: caller(['worker.filesystem.write']), metadata: keyed },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { option: 'expectedVersion' },
      },
    });
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('honours recursive: false, refusing a non-empty folder with its typed code', async () => {
    const created = start();
    await expect(
      created.instruction(
        'worker.filesystem.entry.delete',
        { ...params, recursive: false },
        { caller: caller(['worker.filesystem.write']), metadata: keyed },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.filesystem.entry.invalidState',
      },
    });
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('answers a Trash request without a Trash member as capability_unavailable', async () => {
    const created = start({ platform: { os } });
    await expect(
      created.instruction(
        'worker.filesystem.entry.delete',
        { ...params, disposition: 'trash' },
        { caller: caller(['worker.filesystem.write']), metadata: keyed },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        code: 'worker.filesystem.trash.unavailable',
      },
    });
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('gives other callers typed host refusals that keep the host error', async () => {
    const created = start();
    const error = await rejection(
      created.instruction(
        'worker.filesystem.entry.delete',
        {
          ...params,
          scope: {
            workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'wt-1',
          },
        },
        { caller: caller(['worker.filesystem.write']), metadata: keyed },
      ),
    );
    expect(error).toBeInstanceOf(CanopyOperationError);
    if (!(error instanceof CanopyOperationError)) return;
    expect(error.payload.kind).toBe('permission_denied');
    expect(String(error.runtimeCause)).toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
  });

  const copyParams = {
    scope: params.scope,
    sourceFileRootId: 'project-1',
    sourceRelativePath: 'src/index.ts',
    destinationFileRootId: 'project-1',
    destinationRelativePath: 'copy.ts',
    expectedSourceVersion: null,
    conflictPolicy: 'error' as const,
    _meta: { idempotencyKey: 'k1' },
  };
  const moveParams = {
    scope: params.scope,
    sourceFileRootId: 'project-1',
    destinationFileRootId: 'project-1',
    fromRelativePath: 'src/index.ts',
    toRelativePath: 'copy.ts',
    expectedSourceVersion: null,
    expectedDestinationAbsent: true,
    conflictPolicy: 'error' as const,
    _meta: { idempotencyKey: 'k1' },
  };

  it('requires worker.filesystem.write and a key for copy and move', async () => {
    const created = start();
    const write = caller(['worker.filesystem.write']);
    await expect(
      created.instruction('worker.filesystem.entry.copy', copyParams, {
        caller: caller(['worker.filesystem.read', 'core.workspace.read']),
        metadata: keyed,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      created.instruction('worker.filesystem.entry.move', moveParams, {
        caller: caller(['worker.filesystem.read', 'core.workspace.read']),
        metadata: keyed,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      created.instruction('worker.filesystem.entry.copy', copyParams, {
        caller: write,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      created.instruction('worker.filesystem.entry.move', moveParams, {
        caller: write,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
    const { version, ...copied } = await created.instruction(
      'worker.filesystem.entry.copy',
      copyParams,
      { caller: write, metadata: keyed },
    );
    expect(copied).toEqual({
      sourceFileRootId: 'project-1',
      sourceRelativePath: 'src/index.ts',
      destinationFileRootId: 'project-1',
      requestedDestinationRelativePath: 'copy.ts',
      destinationRelativePath: 'copy.ts',
      copiedEntryCount: 1,
    });
    expect(version).toMatch(/^\d+:\d+$/);
    // An occupied destination is a typed, schema-valid conflict on each page.
    await expect(
      created.instruction(
        'worker.filesystem.entry.copy',
        { ...copyParams, _meta: { idempotencyKey: 'k2' } },
        { caller: write, metadata: { idempotencyKey: 'k2' } },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'already_exists',
        code: 'worker.filesystem.destination.exists',
        retry: { kind: 'never' },
      },
    });
    await expect(
      created.instruction('worker.filesystem.entry.move', moveParams, {
        caller: write,
        metadata: keyed,
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'already_exists',
        code: 'worker.filesystem.entry.exists',
        retry: { kind: 'never' },
      },
    });
  });

  it('retains no copy or move outcome: the same key acts again', async () => {
    const created = start();
    const write = caller(['worker.filesystem.write']);
    const copy = (): Promise<unknown> =>
      created.instruction(
        'worker.filesystem.entry.copy',
        { ...copyParams, conflictPolicy: 'increment' },
        { caller: write, metadata: keyed },
      );
    await expect(copy()).resolves.toMatchObject({
      destinationRelativePath: 'copy.ts',
    });
    await expect(copy()).resolves.toMatchObject({
      destinationRelativePath: 'copy copy.ts',
    });
    const move = (): Promise<unknown> =>
      created.instruction(
        'worker.filesystem.entry.move',
        { ...moveParams, toRelativePath: 'moved.ts' },
        { caller: write, metadata: keyed },
      );
    await expect(move()).resolves.toMatchObject({
      toRelativePath: 'moved.ts',
    });
    await expect(move()).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'worker.filesystem.entry.notFound',
        retry: { kind: 'never' },
      },
    });
  });

  it('refuses copy and move options this host cannot honour before any root lookup', async () => {
    const created = start();
    const options = {
      caller: caller(['worker.filesystem.write']),
      metadata: keyed,
    };
    await expect(
      created.instruction(
        'worker.filesystem.entry.copy',
        { ...copyParams, expectedSourceVersion: '1:2' },
        options,
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { option: 'expectedSourceVersion' },
      },
    });
    for (const [change, option] of [
      [{ expectedSourceVersion: '1:2' }, 'expectedSourceVersion'],
      [{ expectedDestinationAbsent: false }, 'expectedDestinationAbsent'],
      [{ conflictPolicy: 'increment' as const }, 'conflictPolicy'],
    ] as const)
      await expect(
        created.instruction(
          'worker.filesystem.entry.move',
          { ...moveParams, ...change },
          options,
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable', details: { option } },
      });
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(await readdir(repo)).toEqual(['src']);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('hands the call signal to the copy and move engines', async () => {
    const controller = new AbortController();
    controller.abort('caller');
    const handlersMap = createWorkerFilesystemMutationAdapter(
      createDesktopEntryMutationHost({ os }),
    );
    const context = {
      requestId: 'r1',
      caller: caller(['worker.filesystem.write']),
      metadata: keyed,
      signal: controller.signal,
    };
    await expect(
      handlersMap['worker.filesystem.entry.copy'](
        { ...copyParams, destinationRelativePath: 'new/copy.ts' },
        context,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    await expect(
      handlersMap['worker.filesystem.entry.move'](
        { ...moveParams, toRelativePath: 'new/copy.ts' },
        context,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(await readdir(repo)).toEqual(['src']);
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });

  it('hands the call signal to the engine, which stops before the effect', async () => {
    const controller = new AbortController();
    const removeEntry = jest.fn(() => Promise.resolve());
    const handlersMap = createWorkerFilesystemMutationAdapter(
      createDesktopEntryMutationHost({ os }),
      {
        removeEntry,
        beforeDelete: () => {
          controller.abort('caller');
          return Promise.resolve();
        },
      },
    );
    await expect(
      handlersMap['worker.filesystem.entry.delete'](params, {
        requestId: 'r1',
        caller: caller(['worker.filesystem.write']),
        metadata: keyed,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(removeEntry).not.toHaveBeenCalled();
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });
});

describe('worker.filesystem.file.write admission on the desktop host', () => {
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'test',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.write'],
  };

  async function replace(
    created: DesktopCanopyDispatcher,
    content: string,
  ): Promise<unknown> {
    const current = await stat(join(repo, 'src', 'index.ts'));
    return created.instruction(
      'worker.filesystem.file.write',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
        fileRootId: 'project-1',
        relativePath: 'src/index.ts',
        content,
        createOnly: false,
        expectedVersion: `${current.size}:${Math.round(current.mtimeMs)}`,
        _meta: { idempotencyKey: content },
      },
      { caller, metadata: { idempotencyKey: content } },
    );
  }

  it('refuses a replace while Auto Delete owns the worktree', async () => {
    const created = start();
    await withWorkspaceTargetAutoArchiveLease('project-1', 'wt-1', () =>
      expect(replace(created, 'leased\n')).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          message:
            'This workspace target is being automatically deleted. Retry after deletion finishes.',
        },
      }),
    );
    expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('holds archiving off until a replace in flight has written', async () => {
    let archived: Promise<string> | undefined;
    const created = start({
      fileWriteIo: {
        beforeEffect: () => {
          // A synchronous read: it sees the bytes as the drain is let in.
          archived = withWorkspaceTargetArchiveDrain('project-1', 'wt-1', () =>
            Promise.resolve(
              readFileSync(join(repo, 'src', 'index.ts'), 'utf8'),
            ),
          );
          return Promise.resolve();
        },
      },
    });
    await replace(created, 'in flight\n');
    await expect(archived).resolves.toBe('in flight\n');
  });
});

// CAN-5502: the local worker transport carries every worker instruction, so
// the entry handlers must record receipts; without one, a cancelled dispatch
// would be recorded as never received although the handler ran.
describe('the entry instructions on the local worker transport', () => {
  it('resolves a cancelled delete by its executor receipt, before the effect', async () => {
    const operationAdapter = createCoreOperationAdapter({
      ledgerPath: () => join(tempRoot, 'operations', 'operation-ledger.sqlite'),
    });
    operationAdapter.service.registerDomain({
      domain: 'pipeline',
      kinds: ['core.pipeline.run'],
      restartClass: 'lost',
      cancel: () => Promise.resolve('cancelled'),
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removeEntry = jest.fn(() => Promise.resolve());
    const created = start({
      operationAdapter,
      entryDeleteIo: {
        removeEntry,
        beforeDelete: () => {
          entered();
          return gate;
        },
      },
    });
    const { operation: parent } = await operationAdapter.service.admit({
      kind: 'core.pipeline.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'window-1' },
      owner: { kind: 'principal', id: 'local-desktop-user' },
      scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      receipt: {
        caller: 'local-desktop-user',
        idempotencyKey: 'run-1',
        fingerprint: 'params',
      },
    });
    const dispatched = created.localWorker.dispatch({
      parentOperationId: parent.operationId,
      operation: 'worker.filesystem.entry.delete',
      params: {
        scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
        fileRootId: 'project-1',
        relativePath: 'src',
        expectedVersion: null,
        recursive: true,
        disposition: 'permanent',
        _meta: { idempotencyKey: 'step-1' },
      },
      idempotencyKey: 'step-1',
    });
    await reached;
    const [child] = await created.localWorker.listDelegations(
      parent.operationId,
    );
    await expect(
      operationAdapter.service.cancel(child.childOperationId, {
        reason: 'Stop the delete.',
        requestedBy: 'local-desktop-user',
      }),
    ).resolves.toMatchObject({ outcome: 'requested' });
    release();
    await expect(dispatched).resolves.toMatchObject({
      operation: { status: 'cancelled' },
      delegation: { state: 'cancelled', resolution: 'executor-receipt' },
    });
    expect(removeEntry).not.toHaveBeenCalled();
    expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  });
});

describe('toLegacyFileTreeMutationError', () => {
  it('rethrows a runtime cause and maps every engine code to a legacy code', () => {
    const cause = Object.assign(new Error('ENOENT: missing'), {
      code: 'ENOENT',
    });
    expect(
      toLegacyFileTreeMutationError(
        new CanopyOperationError(
          {
            kind: 'not_found',
            code: 'worker.filesystem.entry.notFound',
            message: 'The file or folder does not exist.',
            retry: { kind: 'never' },
          },
          cause,
        ),
      ),
    ).toBe(cause);
    // The codes mutateFileTree threw for the same refusals.
    const legacyCodes = {
      // Not emitted by this host; mapped so the projection stays total.
      'worker.filesystem.entry.invalidState': 'invalid_target',
      'worker.filesystem.entry.revisionConflict': 'invalid_target',
      'worker.filesystem.entry.notFound': 'not_found',
      'worker.filesystem.entry.invalidPath': 'invalid_target',
      'worker.filesystem.entry.outsideRoot': 'invalid_target',
      'worker.filesystem.entry.changed': 'invalid_target',
      'worker.filesystem.root.notFound': 'not_found',
      'worker.filesystem.root.excluded': 'invalid_target',
      'worker.filesystem.trash.unavailable': 'execution_failed',
      'worker.filesystem.trash.failed': 'execution_failed',
      'worker.filesystem.entry.exists': 'invalid_target',
      'worker.filesystem.entry.nested': 'invalid_target',
      'worker.filesystem.entry.crossRootSymlink': 'invalid_target',
    } as const;
    expect(Object.keys(legacyCodes)).toEqual([
      ...WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
    ]);
    for (const code of WORKER_FILESYSTEM_ENTRY_ERROR_CODES) {
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
      expect(String(mapped)).toBe(`PortalServiceError: message for ${code}`);
    }
    const legacyCopyCodes = {
      'worker.filesystem.root.notFound': 'not_found',
      'worker.filesystem.source.notFound': 'not_found',
      // Not emitted by this host; mapped so the projection stays total.
      'worker.filesystem.source.conflict': 'invalid_target',
      'worker.filesystem.destination.exists': 'invalid_target',
      'worker.filesystem.path.escape': 'invalid_target',
      'worker.filesystem.destination.nested': 'invalid_target',
      'worker.filesystem.symlink.rejected': 'invalid_target',
      // A split lock fails as the host's own error, never this code.
      'worker.filesystem.split.locked': 'invalid_target',
      'worker.filesystem.entry.invalidPath': 'invalid_target',
      'worker.filesystem.root.excluded': 'invalid_target',
    } as const;
    expect(Object.keys(legacyCopyCodes)).toEqual([
      ...WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES,
    ]);
    for (const code of WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES) {
      const mapped = toLegacyFileTreeMutationError(
        new CanopyOperationError({
          kind: 'failed_precondition',
          code,
          message: `message for ${code}`,
          retry: { kind: 'never' },
        }),
      );
      expect(mapped).toBeInstanceOf(PortalServiceError);
      expect(mapped).toMatchObject({ code: legacyCopyCodes[code] });
      expect(String(mapped)).toBe(`PortalServiceError: message for ${code}`);
    }
    const plain = new Error('plain');
    expect(toLegacyFileTreeMutationError(plain)).toBe(plain);
    expect(
      String(
        toLegacyFileTreeMutationError(
          new CanopyOperationError({
            kind: 'invalid_argument',
            message: 'Invalid operation parameters.',
            retry: { kind: 'never' },
          }),
        ),
      ),
    ).toBe('Error: Invalid operation parameters.');
  });
});
