import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { promises as fsPromises, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as FileBrowserRootsModule from '../lib/file-browser-roots';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import {
  CanopyOperationError,
  createInProcessCanopyClient,
} from '@canopy/core-runtime';
import { buildCoworkRootCatalog } from '@canopy/core-runtime/node';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type FileIndexingPreferences,
  type FileIndexRequest,
  type FileIndexResponse,
  type FileTreeDirectoryRequest,
  type FileTreeDirectoryResponse,
  type FileTreeMutationRequest,
  type FileTreeMutationResponse,
  type FileTreeRootsRequest,
  type FileTreeRootsResponse,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  DesktopAppWindow,
  DesktopIpcEvent,
} from '../canopy-runtime/desktop-ipc-caller';

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  checkIgnoredPaths: jest.fn(),
  listIgnoredPathEntries: jest.fn(),
}));
jest.mock('../lib/file-browser-roots', () => {
  const actual = jest.requireActual<typeof FileBrowserRootsModule>(
    '../lib/file-browser-roots',
  );
  return {
    ...actual,
    getFileBrowserRoots: jest.fn(actual.getFileBrowserRoots),
  };
});
jest.mock('../lib/paths', () => ({
  getWorkspaceHomeDir: jest.fn(),
  getWorkspaceWorktreeRepoDir: jest.fn(),
  getWorkspaceWorktreeReposDir: jest.fn(),
  getWorkspaceWorktreeRootRepoDir: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readPreferencesFile: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(
    (projectId: string, worktreeId: string) => ({
      projectId,
      worktreeId,
    }),
  ),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
  isCoworkWorkspace: jest.fn(() => false),
}));
jest.mock('../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));

import { registerIpcHandler } from '../ipc/register';
import { registerFileTreeHandlers } from '../ipc/file-tree';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { deriveDesktopIpcCaller } from '../canopy-runtime/desktop-ipc-caller';
import { checkIgnoredPaths, listIgnoredPathEntries } from '../lib/git';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import {
  buildFileIndexResult,
  listDirectory as listFilesystemDirectory,
  type FileSystemReadBoundary,
} from '../lib/file-system-listing';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
} from '../lib/file-glob-matcher';
import { assertNotSplitLocked } from '../services/split-lock-service';
import {
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeReposDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorktreeAttachmentsDir,
} from '../lib/paths';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import {
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../services/files-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedCheckIgnoredPaths = jest.mocked(checkIgnoredPaths);
const mockedListIgnoredPathEntries = jest.mocked(listIgnoredPathEntries);
const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedGetWorkspaceWorktreeAttachmentsDir = jest.mocked(
  getWorkspaceWorktreeAttachmentsDir,
);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);
const mockedGetWorkspaceWorktreeReposDir = jest.mocked(
  getWorkspaceWorktreeReposDir,
);
const mockedGetWorkspaceWorktreeRootRepoDir = jest.mocked(
  getWorkspaceWorktreeRootRepoDir,
);
const mockedGetWorktreeAttachmentsDir = jest.mocked(getWorktreeAttachmentsDir);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveWorktreeTargetIds = jest.mocked(resolveWorktreeTargetIds);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedAssertNotSplitLocked = jest.mocked(assertNotSplitLocked);

type IndexHandler = (
  event: unknown,
  request: FileIndexRequest,
) => Promise<FileIndexResponse>;
type RootsHandler = (
  event: unknown,
  request: FileTreeRootsRequest,
) => Promise<FileTreeRootsResponse>;
type DirectoryHandler = (
  event: unknown,
  request: FileTreeDirectoryRequest,
) => Promise<FileTreeDirectoryResponse>;
let tempRoot: string;
let dispatcher: DesktopCanopyDispatcher;
let trustedEvent: DesktopIpcEvent;
let trustedWindow: DesktopAppWindow;
let listRootsService: jest.MockedFunction<typeof listFileTreeRoots>;
let listDirectoryService: jest.MockedFunction<typeof listFileTreeDirectory>;

function createTrustedIpcFixture(): {
  event: DesktopIpcEvent;
  window: DesktopAppWindow;
} {
  const url = 'file:///app/renderer/index.html';
  const mainFrame = {
    url,
    detached: false,
    isDestroyed: jest.fn(() => false),
  };
  const sender = {
    id: 73,
    getURL: jest.fn(() => url),
    isDestroyed: jest.fn(() => false),
    mainFrame,
  };
  const window = {
    isDestroyed: jest.fn(() => false),
    webContents: sender,
  };
  return {
    event: { sender, senderFrame: mainFrame },
    window,
  };
}

const testOs =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'linux'
      ? 'linux'
      : 'darwin';
const mockTrashItem = jest.fn<Promise<void>, [string]>();

function isMutationResponse(value: unknown): value is FileTreeMutationResponse {
  return isRecord(value) && typeof value.operation === 'string';
}

/**
 * Deletes are `worker.filesystem.entry.delete` (CAN-4101): they run through
 * the most recently registered `file-tree:mutate` projection.
 */
async function mutateThroughIpc(
  request: FileTreeMutationRequest,
): Promise<FileTreeMutationResponse> {
  const call = mockedRegisterIpcHandler.mock.calls
    .filter(([channel]) => channel === IPC_CHANNELS.fileTreeMutate)
    .at(-1);
  if (!call) throw new Error('Missing registered file-tree:mutate handler');
  const result = await invokeHandler(call[1], trustedEvent, request);
  if (!isMutationResponse(result))
    throw new Error('Expected a file-tree mutation response');
  return result;
}

function resolveTrustedCaller(event: DesktopIpcEvent): CanopyCallerDescriptor {
  return deriveDesktopIpcCaller(event, {
    getAppWindows: () => [trustedWindow],
    packagedRendererUrls: ['file:///app/renderer/index.html'],
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileIndexResponse(value: unknown): value is FileIndexResponse {
  return isRecord(value) && Array.isArray(value.repos);
}

function isFileTreeRootsResponse(
  value: unknown,
): value is FileTreeRootsResponse {
  return isRecord(value) && Array.isArray(value.roots);
}

function isFileTreeDirectoryResponse(
  value: unknown,
): value is FileTreeDirectoryResponse {
  return isRecord(value) && Array.isArray(value.entries);
}

async function invokeHandler(
  handler: unknown,
  event: unknown,
  request: unknown,
): Promise<unknown> {
  if (typeof handler !== 'function') {
    throw new Error('Expected registered handler function');
  }
  const result: unknown = Reflect.apply(handler, undefined, [event, request]);
  return Promise.resolve(result);
}

async function captureRejection(
  call: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('Expected call to reject');
}

function getHandler(channel: typeof IPC_CHANNELS.fileIndexGet): IndexHandler;
function getHandler(channel: typeof IPC_CHANNELS.fileTreeRoots): RootsHandler;
function getHandler(
  channel: typeof IPC_CHANNELS.fileTreeDirectory,
): DirectoryHandler;
function getHandler(
  channel: string,
): IndexHandler | RootsHandler | DirectoryHandler {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Missing registered handler for ${channel}`);
  }
  const handler = call[1];
  if (channel === IPC_CHANNELS.fileIndexGet) {
    return async (
      _event: unknown,
      request: FileIndexRequest,
    ): Promise<FileIndexResponse> => {
      const result = await invokeHandler(handler, _event, request);
      if (!isFileIndexResponse(result)) {
        throw new Error('Expected file index response');
      }
      return result;
    };
  }
  if (channel === IPC_CHANNELS.fileTreeRoots) {
    return async (
      _event: unknown,
      request: FileTreeRootsRequest,
    ): Promise<FileTreeRootsResponse> => {
      const result = await invokeHandler(handler, _event, request);
      if (!isFileTreeRootsResponse(result)) {
        throw new Error('Expected file tree roots response');
      }
      return result;
    };
  }
  return async (
    _event: unknown,
    request: FileTreeDirectoryRequest,
  ): Promise<FileTreeDirectoryResponse> => {
    const result = await invokeHandler(handler, _event, request);
    if (!isFileTreeDirectoryResponse(result)) {
      throw new Error('Expected file tree directory response');
    }
    return result;
  };
}

function mockPreferences(fileIndexing: FileIndexingPreferences): void {
  mockedReadPreferencesFile.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    fileIndexing,
  });
}

async function createRepoFixture(): Promise<{
  repoRoot: string;
  attachmentsRoot: string;
}> {
  const repoRoot = join(tempRoot, 'repo');
  const attachmentsRoot = join(tempRoot, 'attachments');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(repoRoot, 'generated'), { recursive: true });
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(join(repoRoot, 'src', 'index.ts'), 'export {};\n');
  await writeFile(join(repoRoot, 'ignored.log'), 'ignored\n');
  await writeFile(join(repoRoot, 'node_modules', 'pkg', 'index.js'), '');
  await writeFile(join(repoRoot, 'generated', 'out.txt'), '');
  await writeFile(join(repoRoot, '.git', 'config'), '');
  await writeFile(join(attachmentsRoot, 'note.txt'), '');
  return { repoRoot, attachmentsRoot };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockedResolveWorktreeTargetIds.mockImplementation(
    (projectId, worktreeId) => ({
      projectId,
      worktreeId,
    }),
  );
  const actualFileBrowserRoots = jest.requireActual<
    typeof FileBrowserRootsModule
  >('../lib/file-browser-roots');
  mockedGetFileBrowserRoots.mockImplementation(
    actualFileBrowserRoots.getFileBrowserRoots,
  );
  tempRoot = await mkdtemp(join(tmpdir(), 'canopy-file-list-'));
  mockPreferences({ disabledBuiltinGlobIds: [], customGlobs: [] });
  mockedCheckIgnoredPaths.mockResolvedValue(new Set(['ignored.log']));
  mockedListIgnoredPathEntries.mockResolvedValue(['ignored.log']);
  mockedIsMultiRepoWorkspace.mockReturnValue(false);
  listRootsService = jest.fn(listFileTreeRoots);
  listDirectoryService = jest.fn(listFileTreeDirectory);
  mockTrashItem.mockResolvedValue(undefined);
  dispatcher = createDesktopRuntime({
    services: {
      listFileTreeRoots: listRootsService,
      listFileTreeDirectory: listDirectoryService,
    },
    platform: {
      os: testOs,
      trash: { trashItem: (path) => mockTrashItem(path) },
    },
    shutdownTimeoutMs: 25,
  });
  const ipcFixture = createTrustedIpcFixture();
  trustedEvent = ipcFixture.event;
  trustedWindow = ipcFixture.window;
  registerFileTreeHandlers(dispatcher, resolveTrustedCaller);
});

afterEach(async () => {
  await dispatcher.shutdown();
  await rm(tempRoot, { recursive: true, force: true });
});

describe('registerFileTreeHandlers', () => {
  it('registers index and tree handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileIndexGet,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileTreeRoots,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileTreeDirectory,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileTreeMutate,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileTreeWatchStart,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileTreeWatchStop,
      expect.any(Function),
    );
  });
});

describe('file-tree mutations', () => {
  async function expectMissing(pathValue: string): Promise<void> {
    await expect(access(pathValue)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  async function expectNoEntry(pathValue: string): Promise<void> {
    await expect(lstat(pathValue)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it('creates, renames, incrementally copies, moves, and deletes entries', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

    await mutateThroughIpc({
      ...scope,
      operation: 'create-file',
      target: { repoId: 'project-1', relativePath: 'drafts/notes.txt' },
    });
    expect(await readFile(join(repoRoot, 'drafts', 'notes.txt'), 'utf8')).toBe(
      '',
    );

    await mutateThroughIpc({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'drafts/notes.txt' },
      target: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
    });
    await expectMissing(join(repoRoot, 'drafts', 'notes.txt'));

    const copied = await mutateThroughIpc({
      ...scope,
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
      target: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
      conflict: 'increment',
    });
    expect(copied.target?.relativePath).toBe('drafts/renamed copy.txt');

    await mutateThroughIpc({
      ...scope,
      operation: 'create-directory',
      target: { repoId: 'project-1', relativePath: 'archive' },
    });
    await mutateThroughIpc({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'drafts/renamed copy.txt' },
      target: { repoId: 'project-1', relativePath: 'archive/copy.txt' },
    });
    expect(await readFile(join(repoRoot, 'archive', 'copy.txt'), 'utf8')).toBe(
      '',
    );

    await mutateThroughIpc({
      ...scope,
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'archive' },
    });
    await expectMissing(join(repoRoot, 'archive'));
  });

  it('creates missing parents for a nested directory target', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'create-directory',
      target: {
        repoId: 'project-1',
        relativePath: 'docs/guides/reference',
      },
    });

    expect(
      (
        await lstat(join(repoRoot, 'docs', 'guides', 'reference'))
      ).isDirectory(),
    ).toBe(true);
  });

  it('checks the authoritative split lock before mutating files', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'create-file',
      target: { repoId: 'project-1', relativePath: 'locked.txt' },
    });

    expect(mockedAssertNotSplitLocked).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      'updating files',
    );
  });

  it('checks the split lock against a managed scopes real worktree', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    mockedResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });

    await mutateThroughIpc({
      projectId: '__code_review__',
      worktreeId: 'managed-scope',
      operation: 'create-file',
      target: { repoId: '__code_review__', relativePath: 'managed.txt' },
    });

    expect(mockedAssertNotSplitLocked).toHaveBeenCalledWith(
      'real-project',
      'real-worktree',
      'updating files',
    );
  });

  it('rejects an unknown mutation operation instead of treating it as a move', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'unknown-operation-source.txt');
    const targetPath = join(repoRoot, 'unknown-operation-target.txt');
    await writeFile(sourcePath, 'source\n');
    const malformedRequest: Record<string, unknown> = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'archive',
      source: {
        repoId: 'project-1',
        relativePath: 'unknown-operation-source.txt',
      },
      target: {
        repoId: 'project-1',
        relativePath: 'unknown-operation-target.txt',
      },
    };

    const call = mockedRegisterIpcHandler.mock.calls
      .filter(([channel]) => channel === IPC_CHANNELS.fileTreeMutate)
      .at(-1);
    if (!call) throw new Error('Missing registered file-tree:mutate handler');
    await expect(
      invokeHandler(call[1], trustedEvent, malformedRequest),
    ).rejects.toThrow('Unsupported file-tree mutation operation');
    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
    await expectMissing(targetPath);
  });

  it('rejects roots, traversal, conflicts, and symlink escapes', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: '' },
      }),
    ).rejects.toThrow('cannot be a file-tree root');
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: '../escaped.txt' },
      }),
    ).rejects.toThrow('cannot traverse outside');
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: 'src/index.ts' },
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    const outside = join(tempRoot, 'outside-mutations');
    await mkdir(outside);
    await symlink(outside, join(repoRoot, 'outside-link'));
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: 'outside-link/nope.txt' },
      }),
    ).rejects.toThrow('outside the selected worktree root');
  });

  it('delegates trash removal without permanently deleting the target itself', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'delete',
      target: { repoId: 'project-1', relativePath: 'src/index.ts' },
      useTrash: true,
    });

    expect(mockTrashItem).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]repo[/\\]src[/\\]index\.ts$/),
    );
    expect(await readFile(join(repoRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('refuses a Trash delete without removing anything when no Trash is available', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const withoutTrash = createDesktopRuntime({
      platform: { os: testOs },
      shutdownTimeoutMs: 25,
    });
    registerFileTreeHandlers(withoutTrash, resolveTrustedCaller);
    try {
      for (const relativePath of ['src/index.ts', 'src']) {
        await expect(
          mutateThroughIpc({
            projectId: 'project-1',
            worktreeId: 'wt-1',
            operation: 'delete',
            target: { repoId: 'project-1', relativePath },
            useTrash: true,
          }),
        ).rejects.toMatchObject({
          name: 'PortalServiceError',
          code: 'execution_failed',
          message:
            "Couldn't move the item to the trash; no trash is available here. Nothing was deleted.",
        });
      }
    } finally {
      await withoutTrash.shutdown();
    }

    expect(mockTrashItem).not.toHaveBeenCalled();
    expect(await readFile(join(repoRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('treats dangling symlinks as occupied mutation targets', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await symlink('missing-target', join(repoRoot, 'dangling.txt'));

    await expect(
      mutateThroughIpc({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'move',
        source: { repoId: 'project-1', relativePath: 'src/index.ts' },
        target: { repoId: 'project-1', relativePath: 'dangling.txt' },
        conflict: 'error',
      }),
    ).rejects.toThrow('already exists');
    expect((await lstat(join(repoRoot, 'dangling.txt'))).isSymbolicLink()).toBe(
      true,
    );

    const copied = await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'src/index.ts' },
      target: { repoId: 'project-1', relativePath: 'dangling.txt' },
      conflict: 'increment',
    });
    expect(copied.target?.relativePath).toBe('dangling copy.txt');
  });

  it('does not treat a symlink alias as a case-only rename', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await writeFile(join(repoRoot, 'real.txt'), 'keep me\n');
    await symlink('real.txt', join(repoRoot, 'link.txt'));

    await expect(
      mutateThroughIpc({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'move',
        source: { repoId: 'project-1', relativePath: 'link.txt' },
        target: { repoId: 'project-1', relativePath: 'real.txt' },
        conflict: 'error',
      }),
    ).rejects.toThrow('already exists');

    expect(await readFile(join(repoRoot, 'real.txt'), 'utf8')).toBe(
      'keep me\n',
    );
    expect((await lstat(join(repoRoot, 'link.txt'))).isSymbolicLink()).toBe(
      true,
    );
  });

  it('keeps a moved or renamed symlink a symlink', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await writeFile(join(repoRoot, 'real.txt'), 'real\n');
    await mkdir(join(repoRoot, 'real-dir'));
    await writeFile(join(repoRoot, 'real-dir', 'inside.txt'), 'inside\n');
    await symlink('real.txt', join(repoRoot, 'file-link'));
    await symlink('real-dir', join(repoRoot, 'dir-link'));
    await mkdir(join(repoRoot, 'links'));
    const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

    await mutateThroughIpc({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'file-link' },
      target: { repoId: 'project-1', relativePath: 'links/file-link' },
      conflict: 'error',
    });
    await mutateThroughIpc({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'dir-link' },
      target: { repoId: 'project-1', relativePath: 'renamed-dir-link' },
      conflict: 'error',
    });

    const movedFileLink = join(repoRoot, 'links', 'file-link');
    const renamedDirLink = join(repoRoot, 'renamed-dir-link');
    expect((await lstat(movedFileLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(movedFileLink)).toBe('real.txt');
    expect((await lstat(renamedDirLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(renamedDirLink)).toBe('real-dir');
    expect(await readFile(join(renamedDirLink, 'inside.txt'), 'utf8')).toBe(
      'inside\n',
    );
    expect((await lstat(join(repoRoot, 'real.txt'))).nlink).toBe(1);
    await expectNoEntry(join(repoRoot, 'file-link'));
    await expectNoEntry(join(repoRoot, 'dir-link'));
  });

  it('preserves directory identity and timestamps for same-filesystem moves', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'source-dir');
    const targetPath = join(repoRoot, 'target-dir');
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'nested.txt'), 'nested\n');
    const timestamp = new Date('2020-01-02T03:04:05.000Z');
    await utimes(sourcePath, timestamp, timestamp);
    const before = await lstat(sourcePath);

    await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'source-dir' },
      target: { repoId: 'project-1', relativePath: 'target-dir' },
      conflict: 'error',
    });

    const after = await lstat(targetPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expectMissing(sourcePath);
  });

  it('preserves relative symlinks when copying a directory', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await mkdir(join(repoRoot, 'linked-dir'));
    await writeFile(join(repoRoot, 'linked-dir', 'target.txt'), 'target\n');
    await symlink('target.txt', join(repoRoot, 'linked-dir', 'link.txt'));

    await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'linked-dir' },
      target: { repoId: 'project-1', relativePath: 'linked-dir-copy' },
      conflict: 'error',
    });

    expect(await readlink(join(repoRoot, 'linked-dir-copy', 'link.txt'))).toBe(
      'target.txt',
    );
    expect(
      await readFile(join(repoRoot, 'linked-dir-copy', 'link.txt'), 'utf8'),
    ).toBe('target\n');
  });

  it('appends copy suffixes after dotted directory names', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await mkdir(join(repoRoot, 'config.v1'));

    const copied = await mutateThroughIpc({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'config.v1' },
      target: { repoId: 'project-1', relativePath: 'config.v1' },
      conflict: 'increment',
    });

    expect(copied.target?.relativePath).toBe('config.v1 copy');
    expect((await lstat(join(repoRoot, 'config.v1 copy'))).isDirectory()).toBe(
      true,
    );
  });

  it('rejects cross-root transfers that would preserve escaping symlinks', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await mkdir(join(repoRoot, 'transfer'));
    await symlink(
      join(repoRoot, 'src', 'index.ts'),
      join(repoRoot, 'transfer', 'link.ts'),
    );

    await expect(
      mutateThroughIpc({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'copy',
        source: { repoId: 'project-1', relativePath: 'transfer' },
        target: { repoId: 'attachments', relativePath: 'copied-transfer' },
        conflict: 'error',
      }),
    ).rejects.toThrow('symlink');
  });

  async function createMultiRepoMutationFixture(): Promise<{
    workspaceRoot: string;
    childRepoRoot: string;
  }> {
    const workspaceRoot = join(tempRoot, 'workspace');
    const reposRoot = join(workspaceRoot, 'repos');
    const childRepoRoot = join(reposRoot, 'app');
    const attachmentsRoot = join(tempRoot, 'workspace-attachments');
    await mkdir(childRepoRoot, { recursive: true });
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'workspace.txt'), 'workspace\n');
    await writeFile(join(childRepoRoot, 'child.txt'), 'child\n');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
    });
    mockedGetWorkspaceWorktreeRootRepoDir.mockReturnValue(workspaceRoot);
    mockedGetWorkspaceWorktreeReposDir.mockReturnValue(reposRoot);
    mockedGetWorkspaceWorktreeRepoDir.mockReturnValue(childRepoRoot);
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    return { workspaceRoot, childRepoRoot };
  }

  it('refuses parent-root mutations at or inside child repo roots', async () => {
    const { workspaceRoot, childRepoRoot } =
      await createMultiRepoMutationFixture();
    const scope = { projectId: 'workspace-1', worktreeId: 'wt-1' };
    const parent = WORKSPACE_ROOT_REPO_ID;
    const refused = 'belongs to another file-tree root';

    for (const relativePath of ['repos', 'repos/app', 'repos/app/child.txt']) {
      await expect(
        mutateThroughIpc({
          ...scope,
          operation: 'delete',
          target: { repoId: parent, relativePath },
          useTrash: true,
        }),
      ).rejects.toThrow(refused);
      await expect(
        mutateThroughIpc({
          ...scope,
          operation: 'delete',
          target: { repoId: parent, relativePath },
        }),
      ).rejects.toThrow(refused);
    }
    for (const operation of ['move', 'copy'] as const) {
      await expect(
        mutateThroughIpc({
          ...scope,
          operation,
          source: { repoId: parent, relativePath: 'repos/app/child.txt' },
          target: { repoId: parent, relativePath: `${operation}-out.txt` },
          conflict: 'error',
        }),
      ).rejects.toThrow(refused);
      await expect(
        mutateThroughIpc({
          ...scope,
          operation,
          source: { repoId: parent, relativePath: 'workspace.txt' },
          target: {
            repoId: parent,
            relativePath: `repos/app/${operation}.txt`,
          },
          conflict: 'error',
        }),
      ).rejects.toThrow(refused);
      await expect(
        mutateThroughIpc({
          ...scope,
          operation,
          source: { repoId: parent, relativePath: 'workspace.txt' },
          target: { repoId: 'app', relativePath: `${operation}-in.txt` },
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ operation });
      if (operation === 'move') {
        await rename(
          join(childRepoRoot, 'move-in.txt'),
          join(workspaceRoot, 'workspace.txt'),
        );
      }
    }

    expect(mockTrashItem).not.toHaveBeenCalled();
    expect(await readFile(join(childRepoRoot, 'child.txt'), 'utf8')).toBe(
      'child\n',
    );
    await expectMissing(join(workspaceRoot, 'move-out.txt'));
    await expectMissing(join(workspaceRoot, 'copy-out.txt'));
    await expectMissing(join(childRepoRoot, 'move.txt'));
    await expectMissing(join(childRepoRoot, 'copy.txt'));
    await mutateThroughIpc({
      ...scope,
      operation: 'delete',
      target: { repoId: 'app', relativePath: 'child.txt' },
    });
    await expectMissing(join(childRepoRoot, 'child.txt'));
  });

  it('refuses parent-root mutations that reach a child repo through a symlink or case alias', async () => {
    const { workspaceRoot, childRepoRoot } =
      await createMultiRepoMutationFixture();
    await symlink(join('repos', 'app'), join(workspaceRoot, 'app-alias'));
    const scope = { projectId: 'workspace-1', worktreeId: 'wt-1' };
    const parent = WORKSPACE_ROOT_REPO_ID;
    const refused = 'belongs to another file-tree root';

    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'delete',
        target: { repoId: parent, relativePath: 'app-alias/child.txt' },
      }),
    ).rejects.toThrow(refused);
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'copy',
        source: { repoId: parent, relativePath: 'app-alias' },
        target: { repoId: parent, relativePath: 'app-copy' },
        conflict: 'error',
      }),
    ).rejects.toThrow(refused);
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'move',
        source: { repoId: parent, relativePath: 'workspace.txt' },
        target: { repoId: parent, relativePath: 'app-alias/moved.txt' },
        conflict: 'error',
      }),
    ).rejects.toThrow(refused);
    // A case-insensitive volume resolves this alias to repos/app; a
    // case-sensitive one has no such path.
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'delete',
        target: { repoId: parent, relativePath: 'Repos/App/child.txt' },
      }),
    ).rejects.toThrow();

    expect(await readFile(join(childRepoRoot, 'child.txt'), 'utf8')).toBe(
      'child\n',
    );
    expect(await readFile(join(workspaceRoot, 'workspace.txt'), 'utf8')).toBe(
      'workspace\n',
    );
    await expectMissing(join(workspaceRoot, 'app-copy'));

    await mutateThroughIpc({
      ...scope,
      operation: 'delete',
      target: { repoId: parent, relativePath: 'app-alias' },
    });
    await expect(lstat(join(workspaceRoot, 'app-alias'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await readFile(join(childRepoRoot, 'child.txt'), 'utf8')).toBe(
      'child\n',
    );
  });

  async function createCoworkMutationFixture(): Promise<{
    home: string;
    managed: string;
  }> {
    const home = join(tempRoot, 'cowork-home');
    const managed = join(home, '.canopy');
    const catalog = buildCoworkRootCatalog({
      workspace: { id: 'workspace', name: 'Cowork', absolutePath: home },
      notesPath: join(managed, 'notes'),
      promptsPath: join(managed, 'prompts'),
      attachments: {
        absolutePath: join(managed, 'attachments'),
        visible: true,
      },
    });
    const roots = catalog.roots.map((root) => ({
      repoId: root.id,
      repoName: root.name,
      absolutePath: root.absolutePath,
      rootKind: root.kind,
      gitAware: root.gitAware,
      excludedDescendantRoots: root.excludedDescendantRoots,
    }));
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots,
      rootMap: new Map(roots.map((root) => [root.repoId, root])),
    });
    for (const managedDir of ['notes', 'prompts', 'attachments']) {
      await mkdir(join(managed, managedDir), { recursive: true });
      await writeFile(join(managed, managedDir, 'kept.md'), 'kept\n');
    }
    await writeFile(join(managed, 'settings.json'), '{}\n');
    await writeFile(join(home, 'draft.md'), 'draft\n');
    return { home, managed };
  }

  it('refuses cowork workspace-root mutations inside managed roots', async () => {
    const { managed } = await createCoworkMutationFixture();
    const scope = { projectId: 'cowork-1', worktreeId: 'wt-1' };
    const refused = 'belongs to another file-tree root';

    for (const managedDir of ['notes', 'prompts', 'attachments']) {
      await expect(
        mutateThroughIpc({
          ...scope,
          operation: 'delete',
          target: {
            repoId: 'workspace',
            relativePath: `.canopy/${managedDir}`,
          },
        }),
      ).rejects.toThrow(refused);
      await expect(
        mutateThroughIpc({
          ...scope,
          operation: 'move',
          source: {
            repoId: 'workspace',
            relativePath: `.canopy/${managedDir}/kept.md`,
          },
          target: { repoId: 'workspace', relativePath: `${managedDir}.md` },
          conflict: 'error',
        }),
      ).rejects.toThrow(refused);
      await expect(
        mutateThroughIpc({
          ...scope,
          operation: 'copy',
          source: { repoId: 'workspace', relativePath: 'draft.md' },
          target: {
            repoId: 'workspace',
            relativePath: `.canopy/${managedDir}/draft.md`,
          },
          conflict: 'error',
        }),
      ).rejects.toThrow(refused);
      expect(await readFile(join(managed, managedDir, 'kept.md'), 'utf8')).toBe(
        'kept\n',
      );
      await expectMissing(join(managed, managedDir, 'draft.md'));
    }

    await mutateThroughIpc({
      ...scope,
      operation: 'copy',
      source: { repoId: 'workspace', relativePath: 'draft.md' },
      target: { repoId: 'notes', relativePath: 'draft.md' },
      conflict: 'error',
    });
    await mutateThroughIpc({
      ...scope,
      operation: 'delete',
      target: { repoId: 'workspace', relativePath: '.canopy/settings.json' },
    });
    expect(await readFile(join(managed, 'notes', 'draft.md'), 'utf8')).toBe(
      'draft\n',
    );
    await expectMissing(join(managed, 'settings.json'));
  });

  it('refuses deleting or moving a folder that contains a managed root', async () => {
    const { home, managed } = await createCoworkMutationFixture();
    const scope = { projectId: 'cowork-1', worktreeId: 'wt-1' };
    const refused = 'contains another file-tree root';
    await symlink('.canopy', join(home, 'managed-alias'));

    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'delete',
        target: { repoId: 'workspace', relativePath: '.canopy' },
        useTrash: true,
      }),
    ).rejects.toThrow(refused);
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'delete',
        target: { repoId: 'workspace', relativePath: '.canopy' },
      }),
    ).rejects.toThrow(refused);
    await expect(
      mutateThroughIpc({
        ...scope,
        operation: 'move',
        source: { repoId: 'workspace', relativePath: '.canopy' },
        target: { repoId: 'workspace', relativePath: 'moved-managed' },
        conflict: 'error',
      }),
    ).rejects.toThrow(refused);
    expect(mockTrashItem).not.toHaveBeenCalled();
    expect(await readFile(join(managed, 'notes', 'kept.md'), 'utf8')).toBe(
      'kept\n',
    );
    await expectMissing(join(home, 'moved-managed'));

    // Copy leaves the managed roots in place; removing an alias keeps them.
    await mutateThroughIpc({
      ...scope,
      operation: 'copy',
      source: { repoId: 'workspace', relativePath: '.canopy' },
      target: { repoId: 'workspace', relativePath: 'managed-copy' },
      conflict: 'error',
    });
    await mutateThroughIpc({
      ...scope,
      operation: 'delete',
      target: { repoId: 'workspace', relativePath: 'managed-alias' },
    });
    expect(
      await readFile(join(home, 'managed-copy', 'notes', 'kept.md'), 'utf8'),
    ).toBe('kept\n');
    await expectNoEntry(join(home, 'managed-alias'));
    expect(await readFile(join(managed, 'notes', 'kept.md'), 'utf8')).toBe(
      'kept\n',
    );
  });

  it('refuses a copy or move whose new folder would contain a managed root', async () => {
    const { home, managed } = await createCoworkMutationFixture();
    await rm(managed, { recursive: true });
    await mkdir(join(home, 'seed', 'notes'), { recursive: true });
    await writeFile(join(home, 'seed', 'notes', 'seeded.md'), 'seeded\n');
    const scope = { projectId: 'cowork-1', worktreeId: 'wt-1' };

    for (const operation of ['copy', 'move'] as const) {
      await expect(
        mutateThroughIpc({
          ...scope,
          operation,
          source: { repoId: 'workspace', relativePath: 'seed' },
          target: { repoId: 'workspace', relativePath: '.canopy' },
          conflict: 'error',
        }),
      ).rejects.toThrow('contains another file-tree root');
    }

    await expectMissing(managed);
    expect(
      await readFile(join(home, 'seed', 'notes', 'seeded.md'), 'utf8'),
    ).toBe('seeded\n');
  });

  // A literal backslash filename exists only on a POSIX filesystem.
  const itOnPosixHost = process.platform === 'win32' ? it.skip : it;

  itOnPosixHost(
    'refuses backslash mutation paths instead of acting on the slash path',
    async () => {
      const { repoRoot, attachmentsRoot } = await createRepoFixture();
      mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
      mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
      await writeFile(join(repoRoot, 'a\\b'), 'literal\n');
      await mkdir(join(repoRoot, 'a'));
      await writeFile(join(repoRoot, 'a', 'b'), 'nested\n');
      const scope = { projectId: 'project-1', worktreeId: 'wt-1' };
      const refused = 'cannot contain a backslash';

      for (const platform of ['darwin', 'linux'] as const) {
        const original = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: platform });
        try {
          await expect(
            mutateThroughIpc({
              ...scope,
              operation: 'delete',
              target: { repoId: 'project-1', relativePath: 'a\\b' },
              useTrash: true,
            }),
          ).rejects.toThrow(refused);
          await expect(
            mutateThroughIpc({
              ...scope,
              operation: 'delete',
              target: { repoId: 'project-1', relativePath: 'a\\b' },
            }),
          ).rejects.toThrow(refused);
          for (const operation of ['move', 'copy'] as const) {
            await expect(
              mutateThroughIpc({
                ...scope,
                operation,
                source: { repoId: 'project-1', relativePath: 'a\\b' },
                target: { repoId: 'project-1', relativePath: 'renamed.txt' },
                conflict: 'error',
              }),
            ).rejects.toThrow(refused);
            await expect(
              mutateThroughIpc({
                ...scope,
                operation,
                source: { repoId: 'project-1', relativePath: 'src/index.ts' },
                target: { repoId: 'project-1', relativePath: 'a\\c' },
                conflict: 'error',
              }),
            ).rejects.toThrow(refused);
          }
          await expect(
            mutateThroughIpc({
              ...scope,
              operation: 'create-file',
              target: { repoId: 'project-1', relativePath: 'new\\file.txt' },
            }),
          ).rejects.toThrow(refused);
        } finally {
          if (original) Object.defineProperty(process, 'platform', original);
        }
      }

      expect(mockTrashItem).not.toHaveBeenCalled();
      expect(await readFile(join(repoRoot, 'a\\b'), 'utf8')).toBe('literal\n');
      expect(await readFile(join(repoRoot, 'a', 'b'), 'utf8')).toBe('nested\n');
      expect(await readFile(join(repoRoot, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
      await expectMissing(join(repoRoot, 'renamed.txt'));
      await expectMissing(join(repoRoot, 'a', 'c'));
      await expectMissing(join(repoRoot, 'new'));
    },
  );

  it('keeps Windows backslash mutation paths as separators', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    // The host's operating system decides, never the process it runs in.
    const windows = createDesktopRuntime({
      platform: { os: 'win32' },
      shutdownTimeoutMs: 25,
    });
    registerFileTreeHandlers(windows, resolveTrustedCaller);
    try {
      const created = await mutateThroughIpc({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: 'windows\\nested.txt' },
      });
      expect(created.target?.relativePath).toBe('windows/nested.txt');
    } finally {
      await windows.shutdown();
    }
    expect(
      await readFile(join(repoRoot, 'windows', 'nested.txt'), 'utf8'),
    ).toBe('');
  });
});

describe('explorer file index bounds', () => {
  it('uses an injected no-follow boundary for replica listings and indexes', async () => {
    const root = join(tempRoot, 'sealed-index');
    const outside = join(tempRoot, 'outside-secret.txt');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'safe.txt'), 'safe');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'linked-secret.txt'));
    const readBoundary = {
      assertDirectory: jest.fn(async (_root: string, target: string) => {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error('not a real directory');
        }
      }),
      readDirectory: jest.fn((_: string, target: string) =>
        readdir(target, { withFileTypes: true }),
      ),
      lstatEntry: jest.fn((_: string, target: string) => lstat(target)),
    };

    const result = await buildFileIndexResult(root, {
      gitAware: false,
      globMatcher: buildFileExplorerGlobMatcher(),
      readBoundary,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(['safe.txt']);
    expect(readBoundary.assertDirectory).toHaveBeenCalledWith(root, root);
    expect(readBoundary.readDirectory).toHaveBeenCalledWith(root, root);
    expect(readBoundary.lstatEntry).toHaveBeenCalledWith(
      root,
      join(root, 'linked-secret.txt'),
    );
  });

  it('indexes a subtree with more files than one call can spread', async () => {
    const root = join(tempRoot, 'virtual-index');
    const dataDir = join(root, 'data');
    const fileNames = Array.from(
      { length: 200_000 },
      (_, index) => `file-${index}.txt`,
    );
    const virtualDirent = (name: string, directory: boolean): Dirent => ({
      name,
      parentPath: root,
      isFile: () => !directory,
      isDirectory: () => directory,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    });
    const isVirtualDirectory = (target: string): boolean =>
      target === root || target === dataDir;
    const readBoundary: FileSystemReadBoundary = {
      assertDirectory: (): Promise<void> => Promise.resolve(),
      readDirectory: (_: string, target: string): Promise<Dirent[]> =>
        Promise.resolve(
          target === root
            ? [virtualDirent('data', true)]
            : target === dataDir
              ? fileNames.map((name) => virtualDirent(name, false))
              : [],
        ),
      lstatEntry: (_, target) =>
        Promise.resolve({
          isFile: (): boolean => !isVirtualDirectory(target),
          isDirectory: (): boolean => isVirtualDirectory(target),
          isSymbolicLink: (): boolean => false,
        }),
    };

    const result = await buildFileIndexResult(root, {
      gitAware: false,
      globMatcher: buildFileExplorerGlobMatcher(),
      readBoundary,
    });

    expect(result.files).toHaveLength(fileNames.length);
    expect(result.truncated).toBe(false);
  }, 60_000);

  it('indexes source paths before dependency paths consume the limit', async () => {
    const root = join(tempRoot, 'bounded-index');
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'a.js'), 'a');
    await writeFile(join(root, 'node_modules', 'pkg', 'b.js'), 'b');
    await writeFile(join(root, 'packages', 'app', 'source.ts'), 'source');

    const result = await buildFileIndexResult(
      root,
      {
        gitAware: false,
        globMatcher: buildFileExplorerGlobMatcher(),
      },
      2,
    );

    expect(result.files).toHaveLength(2);
    expect(result.files.map((file) => file.relativePath)).toContain(
      'packages/app/source.ts',
    );
    expect(
      result.files.some((file) =>
        file.relativePath.startsWith('node_modules/'),
      ),
    ).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('routes roots, directory reads and each root of the index through the dispatcher', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const query = jest.spyOn(dispatcher, 'query');

    await getHandler(IPC_CHANNELS.fileTreeRoots)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    await getHandler(IPC_CHANNELS.fileTreeDirectory)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '',
    });
    await getHandler(IPC_CHANNELS.fileIndexGet)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    // CAN-5037: the index is one search per root (the repo and attachments).
    expect(query.mock.calls.map(([name]) => name)).toEqual([
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
      'worker.filesystem.search',
      'worker.filesystem.search',
    ]);
  });

  it('keeps direct service, in-process client, and legacy IPC projections equivalent', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };
    const directoryRequest = {
      ...request,
      repoId: 'project-1',
      relativeDir: '',
    };
    const client = createInProcessCanopyClient(
      dispatcher,
      resolveTrustedCaller(trustedEvent),
    );

    const directRoots = await listFileTreeRoots(request);
    const canonicalRoots = await client.query('worker.filesystem.roots.list', {
      scope: {
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
      },
    });
    const legacyRoots = await getHandler(IPC_CHANNELS.fileTreeRoots)(
      trustedEvent,
      request,
    );
    expect(legacyRoots).toEqual({
      ...directRoots,
      imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    });
    expect(canonicalRoots.roots).toEqual(
      directRoots.roots.map((root) => ({
        fileRootId: root.repoId,
        name: root.repoName,
        kind: root.rootKind,
      })),
    );
    for (const root of canonicalRoots.roots) {
      expect(root).not.toHaveProperty('hostPath');
    }

    const directDirectory = await listFileTreeDirectory(directoryRequest);
    const canonicalDirectory = await client.query(
      'worker.filesystem.directory.list',
      {
        scope: {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        },
        fileRootId: directoryRequest.repoId,
        relativePath: directoryRequest.relativeDir,
      },
    );
    const legacyDirectory = await getHandler(IPC_CHANNELS.fileTreeDirectory)(
      trustedEvent,
      directoryRequest,
    );
    expect(legacyDirectory).toEqual(directDirectory);
    expect(canonicalDirectory.entries).toEqual(
      directDirectory.entries.map((entry) => ({
        ...entry,
        absolutePath: undefined,
      })),
    );
    for (const entry of canonicalDirectory.entries) {
      expect(entry).not.toHaveProperty('hostPath');
    }
  });

  it('keeps direct service, in-process client, and legacy IPC errors equivalent', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const request = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '../outside',
    };
    const client = createInProcessCanopyClient(
      dispatcher,
      resolveTrustedCaller(trustedEvent),
    );

    const directError = await captureRejection(() =>
      listFileTreeDirectory(request),
    );
    const canonicalError = await captureRejection(() =>
      client.query('worker.filesystem.directory.list', {
        scope: {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        },
        fileRootId: request.repoId,
        relativePath: request.relativeDir,
      }),
    );
    const legacyError = await captureRejection(() =>
      getHandler(IPC_CHANNELS.fileTreeDirectory)(trustedEvent, request),
    );

    expect(directError).toBeInstanceOf(Error);
    expect(canonicalError).toBeInstanceOf(CanopyOperationError);
    expect(canonicalError).toMatchObject({
      payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
    expect(legacyError).toBeInstanceOf(Error);
    if (
      !(canonicalError instanceof Error) ||
      !(directError instanceof Error) ||
      !(legacyError instanceof Error)
    ) {
      throw new Error('Expected equivalent Error instances');
    }
    expect(canonicalError.message).toBe(directError.message);
    expect(legacyError.message).toBe(directError.message);
  });

  it('reads live state on every canonical legacy call without caching', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const handler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const request = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '',
    };

    const before = await handler(trustedEvent, request);
    await writeFile(join(repoRoot, 'created-after-first-read.txt'), 'live\n');
    const after = await handler(trustedEvent, request);

    expect(before.entries.map((entry) => entry.name)).not.toContain(
      'created-after-first-read.txt',
    );
    expect(after.entries.map((entry) => entry.name)).toContain(
      'created-after-first-read.txt',
    );
    expect(listDirectoryService).toHaveBeenCalledTimes(2);
  });

  it('ignores spoofed authority fields and rejects invalid senders before service work', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const query = jest.spyOn(dispatcher, 'query');
    const handler = getHandler(IPC_CHANNELS.fileTreeRoots);

    await Reflect.apply(handler, undefined, [
      trustedEvent,
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        principalId: 'spoofed-user',
        authorityId: 'spoofed-authority',
        grants: ['worker.filesystem.admin'],
      },
    ]);
    const expectedGrants: unknown = expect.arrayContaining([
      'worker.filesystem.read',
      'core.workspace.read',
      'core.chat.read',
      'core.chat.write',
      'core.worktree.read',
      'core.chat.write',
    ]);
    expect(query).toHaveBeenCalledWith(
      'worker.filesystem.roots.list',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-web-contents:73',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: expectedGrants,
        },
      },
    );

    query.mockClear();
    listRootsService.mockClear();
    const invalidEvent: DesktopIpcEvent = {
      ...trustedEvent,
      senderFrame: {
        url: 'file:///app/renderer/index.html',
        detached: false,
        isDestroyed: jest.fn(() => false),
      },
    };
    await expect(
      handler(invalidEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('Untrusted desktop IPC sender.');
    expect(query).not.toHaveBeenCalled();
    expect(listRootsService).not.toHaveBeenCalled();
  });

  it('drains an active legacy read and rejects later reads once shutdown starts', async () => {
    const gate = deferred<FileTreeRootsResponse>();
    const runtime = createDesktopRuntime({
      services: {
        listFileTreeRoots: () => gate.promise,
        listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
      },
      shutdownTimeoutMs: 100,
    });
    mockedRegisterIpcHandler.mockClear();
    registerFileTreeHandlers(runtime, resolveTrustedCaller);
    const handler = getHandler(IPC_CHANNELS.fileTreeRoots);
    const activeRead = handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    const shutdown = runtime.shutdown();

    await expect(
      handler(trustedEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toThrow('The runtime is unavailable.');
    gate.resolve({ roots: [] });
    await expect(activeRead).resolves.toEqual({
      roots: [],
      imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    });
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('rejects an adapter that replaces a filesystem handler', () => {
    expect(() =>
      createDesktopRuntime({
        adapters: [
          {
            queries: {
              'worker.filesystem.roots.list': (): Promise<never> =>
                Promise.reject(new Error('unexpected handler')),
            },
          },
        ],
      }),
    ).toThrow('Duplicate Canopy query handler: worker.filesystem.roots.list');
  });

  it('abandons a read that exceeds the bounded shutdown drain', async () => {
    const runtime = createDesktopRuntime({
      services: {
        listFileTreeRoots: () => new Promise(() => {}),
        listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
      },
      shutdownTimeoutMs: 15,
    });
    mockedRegisterIpcHandler.mockClear();
    registerFileTreeHandlers(runtime, resolveTrustedCaller);
    const activeRead = getHandler(IPC_CHANNELS.fileTreeRoots)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    const startedAt = Date.now();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(activeRead).rejects.toThrow('The operation was cancelled.');
  });
});

describe('file-index:get handler', () => {
  it('walks at most twice for a burst of identical index requests', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const readdirSpy = jest.spyOn(fsPromises, 'readdir');
    const handler = getHandler(IPC_CHANNELS.fileIndexGet);

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handler(trustedEvent, { projectId: 'project-1', worktreeId: 'wt-1' }),
        ),
      );

      expect(
        new Set(results.map((result) => JSON.stringify(result))).size,
      ).toBe(1);
      expect(
        readdirSpy.mock.calls.filter(([directory]) => directory === repoRoot),
      ).toHaveLength(2);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('answers a request made during a walk with a walk that starts after it', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const handler = getHandler(IPC_CHANNELS.fileIndexGet);
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };

    const first = handler(trustedEvent, request);
    await writeFile(join(repoRoot, 'src', 'added.ts'), '');
    const second = await handler(trustedEvent, request);
    await first;

    expect(second.repos[0]?.files.map((file) => file.relativePath)).toContain(
      'src/added.ts',
    );
  });

  it('marks ignored files from one listing instead of checking every path', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    // git reports a wholly ignored directory as one entry ending in "/".
    mockedListIgnoredPathEntries.mockResolvedValue([
      'ignored.log',
      'generated/',
    ]);
    mockedCheckIgnoredPaths.mockClear();

    const result = await getHandler(IPC_CHANNELS.fileIndexGet)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(
      result.repos[0]?.files
        .filter((file) => file.isIgnored)
        .map((file) => file.relativePath)
        .sort(),
    ).toEqual(['generated/out.txt', 'ignored.log']);
    expect(mockedListIgnoredPathEntries).toHaveBeenCalledTimes(1);
    expect(mockedListIgnoredPathEntries).toHaveBeenCalledWith(repoRoot);
    expect(mockedCheckIgnoredPaths).not.toHaveBeenCalled();
  });

  it('leaves files unmarked when the ignored listing fails', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    mockedListIgnoredPathEntries.mockRejectedValue(new Error('git failed'));

    const result = await getHandler(IPC_CHANNELS.fileIndexGet)(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(result.repos[0]?.files.map((file) => file.relativePath)).toContain(
      'ignored.log',
    );
    expect(result.repos[0]?.files.some((file) => file.isIgnored)).toBe(false);
  });

  it('includes git-ignored files but excludes .git and default index globs', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileIndexGet);
    const result = await handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(result.repos[0]?.files).toEqual([
      {
        relativePath: 'generated/out.txt',
        filename: 'out.txt',
        absolutePath: join(repoRoot, 'generated', 'out.txt'),
        isIgnored: false,
      },
      {
        relativePath: 'src/index.ts',
        filename: 'index.ts',
        absolutePath: join(repoRoot, 'src', 'index.ts'),
        isIgnored: false,
      },
      {
        relativePath: 'ignored.log',
        filename: 'ignored.log',
        absolutePath: join(repoRoot, 'ignored.log'),
        isIgnored: true,
      },
    ]);
  });

  it('uses custom globs for the index without hiding explorer entries', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    mockPreferences({
      disabledBuiltinGlobIds: [],
      customGlobs: [
        { id: 'custom-generated', pattern: 'generated/**', enabled: true },
      ],
    });

    const indexHandler = getHandler(IPC_CHANNELS.fileIndexGet);
    const directoryHandler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const indexResult = await indexHandler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    const directoryResult = await directoryHandler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '',
    });

    expect(
      indexResult.repos[0]?.files.map((file) => file.relativePath),
    ).toEqual(['src/index.ts', 'ignored.log']);
    expect(
      directoryResult.entries.find((entry) => entry.name === 'generated'),
    ).toMatchObject({
      kind: 'directory',
      isIndexExcluded: true,
    });
  });

  it('keeps indexing-excluded files searchable from the explorer', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    mockPreferences({
      disabledBuiltinGlobIds: [],
      customGlobs: [
        { id: 'custom-generated', pattern: 'generated/**', enabled: true },
      ],
    });

    const handler = getHandler(IPC_CHANNELS.fileIndexGet);
    // CAN-5037: the index derives its caller from a trusted sender.
    const result = await handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      purpose: 'file-explorer',
    });

    expect(result.repos[0]?.files.map((file) => file.relativePath)).toEqual([
      'generated/out.txt',
      'src/index.ts',
      'ignored.log',
      'node_modules/pkg/index.js',
    ]);
    expect(
      result.repos[0]?.files.map((file) => file.relativePath),
    ).not.toContain('.git/config');
  });

  it('includes node_modules in the index when its built-in glob is disabled', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    mockPreferences({
      disabledBuiltinGlobIds: ['node-modules'],
      customGlobs: [],
    });

    const handler = getHandler(IPC_CHANNELS.fileIndexGet);
    const result = await handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(result.repos[0]?.files.map((file) => file.relativePath)).toContain(
      'node_modules/pkg/index.js',
    );
  });
});

describe('file-tree:directory handler', () => {
  it('preserves literal and leading backslashes in POSIX filenames', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    listDirectoryService.mockResolvedValueOnce({
      entries: [
        {
          name: 'a\\b',
          relativePath: 'a\\b',
          absolutePath: join(repoRoot, 'a\\b'),
          kind: 'file',
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        },
        {
          name: '\\notes',
          relativePath: '\\notes',
          absolutePath: join(repoRoot, '\\notes'),
          kind: 'file',
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        },
      ],
    });

    const result = await getHandler(IPC_CHANNELS.fileTreeDirectory)(
      trustedEvent,
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'project-1',
        relativeDir: '',
      },
    );
    expect(result.entries.map((entry) => entry.absolutePath)).toEqual([
      join(repoRoot, 'a\\b'),
      join(repoRoot, '\\notes'),
    ]);
  });

  it('projects root paths from the dispatched service snapshot without rereading roots', async () => {
    const rootResponse: FileTreeRootsResponse = {
      roots: [
        {
          repoId: 'project-1',
          repoName: 'Repository',
          absolutePath: '/first-snapshot',
          rootKind: 'git-repo',
        },
      ],
    };
    const roots = jest.fn(() => Promise.resolve(rootResponse));
    const runtime = createDesktopRuntime({
      services: {
        listFileTreeRoots: roots,
        listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
      },
    });
    mockedRegisterIpcHandler.mockClear();
    registerFileTreeHandlers(runtime, resolveTrustedCaller);

    await expect(
      getHandler(IPC_CHANNELS.fileTreeRoots)(trustedEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual({
      ...rootResponse,
      imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    });
    expect(roots).toHaveBeenCalledTimes(1);
  });

  it('rejects canonical parent traversal while reconstructing a legacy path', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    listDirectoryService.mockResolvedValueOnce({
      entries: [
        {
          name: 'secret.txt',
          relativePath: '../secret.txt',
          absolutePath: join(tempRoot, 'secret.txt'),
          kind: 'file',
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        },
      ],
    });

    await expect(
      getHandler(IPC_CHANNELS.fileTreeDirectory)(trustedEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'project-1',
        relativeDir: '',
      }),
    ).rejects.toThrow('Invalid canonical file-tree relative path.');
  });

  it('keeps default-excluded directories visible in the explorer', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const result = await handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '',
    });

    expect(result.entries.map((entry) => entry.name)).toEqual([
      'generated',
      'node_modules',
      'src',
      'ignored.log',
    ]);
    expect(
      result.entries.find((entry) => entry.name === 'node_modules'),
    ).toMatchObject({
      isIndexExcluded: true,
    });
    expect(
      result.entries.find((entry) => entry.name === 'ignored.log'),
    ).toMatchObject({
      isIgnored: true,
    });
    expect(result.entries.some((entry) => entry.name === '.git')).toBe(false);
  });

  it('rejects parent traversal in relativeDir', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    await expect(
      handler(trustedEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'project-1',
        relativeDir: '../outside',
      }),
    ).rejects.toThrow('Path cannot traverse outside the worktree.');
  });

  it('omits symlinks that resolve outside the root', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    await mkdir(join(tempRoot, 'outside'), { recursive: true });
    await writeFile(join(tempRoot, 'outside', 'secret.txt'), '');
    await symlink(join(tempRoot, 'outside'), join(repoRoot, 'linked-dir'));
    await symlink(
      join(tempRoot, 'outside', 'secret.txt'),
      join(repoRoot, 'linked-file.txt'),
    );
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const directoryHandler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const indexHandler = getHandler(IPC_CHANNELS.fileIndexGet);
    const directoryResult = await directoryHandler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: 'project-1',
      relativeDir: '',
    });
    const indexResult = await indexHandler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(directoryResult.entries.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining(['linked-dir', 'linked-file.txt']),
    );
    expect(
      indexResult.repos[0]?.files.map((file) => file.relativePath),
    ).not.toContain('linked-dir/secret.txt');
    await expect(
      directoryHandler(trustedEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'project-1',
        relativeDir: 'linked-dir',
      }),
    ).rejects.toThrow('outside the file tree root');
  });

  it('omits the repos directory from multi-repo project root listings and indexes', async () => {
    const workspaceRoot = join(tempRoot, 'workspace');
    const reposRoot = join(workspaceRoot, 'repos');
    const childRepoRoot = join(reposRoot, 'app');
    const attachmentsRoot = join(tempRoot, 'workspace-attachments');
    await mkdir(childRepoRoot, { recursive: true });
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'workspace-output.txt'), 'root\n');
    await writeFile(join(childRepoRoot, 'child-output.txt'), 'child\n');

    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
    };
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    mockedGetWorkspaceWorktreeRootRepoDir.mockReturnValue(workspaceRoot);
    mockedGetWorkspaceWorktreeReposDir.mockReturnValue(reposRoot);
    mockedGetWorkspaceWorktreeRepoDir.mockReturnValue(childRepoRoot);
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const directoryHandler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const indexHandler = getHandler(IPC_CHANNELS.fileIndexGet);
    const directoryResult = await directoryHandler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      repoId: WORKSPACE_ROOT_REPO_ID,
      relativeDir: '',
    });
    const indexResult = await indexHandler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(directoryResult.entries.map((entry) => entry.name)).toEqual([
      'workspace-output.txt',
    ]);
    expect(
      indexResult.repos
        .find((repo) => repo.repoId === WORKSPACE_ROOT_REPO_ID)
        ?.files.map((file) => file.relativePath),
    ).toEqual(['workspace-output.txt']);
  });
});

describe('file-tree:roots handler', () => {
  it('includes the source-backed project root before child repos', async () => {
    const attachmentsRoot = join(tempRoot, 'source-backed-attachments');
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(attachmentsRoot, 'brief.md'), '');

    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
      sourceRepoPath: '/source/workspace',
    };
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    mockedGetWorkspaceWorktreeRootRepoDir.mockReturnValue('/worktree');
    mockedGetWorkspaceWorktreeRepoDir.mockReturnValue('/worktree/repos/app');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileTreeRoots);
    const result = await handler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result.roots.map((root) => root.repoId)).toEqual([
      WORKSPACE_ROOT_REPO_ID,
      'app',
      'attachments',
    ]);
  });

  it('uses a non-colliding id for the synthetic attachments root', async () => {
    const attachmentsRoot = join(tempRoot, 'colliding-attachments');
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(attachmentsRoot, 'brief.md'), '');

    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'attachments',
          name: 'Attachments Repo',
          repoPath: '/source/attachments',
        },
      ],
    };
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    mockedGetWorkspaceWorktreeRootRepoDir.mockReturnValue('/worktree');
    mockedGetWorkspaceWorktreeRepoDir.mockReturnValue(
      '/worktree/repos/attachments',
    );
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const rootsHandler = getHandler(IPC_CHANNELS.fileTreeRoots);
    const directoryHandler = getHandler(IPC_CHANNELS.fileTreeDirectory);
    const rootsResult = await rootsHandler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(rootsResult.roots.map((root) => root.repoId)).toEqual([
      WORKSPACE_ROOT_REPO_ID,
      'attachments',
      'canopy-attachments',
    ]);

    await directoryHandler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      repoId: 'canopy-attachments',
      relativeDir: '',
    });
  });

  it('includes the local project root for local multi-repo projects', async () => {
    const attachmentsRoot = join(tempRoot, 'local-workspace-attachments');
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(attachmentsRoot, 'brief.md'), '');

    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
    };
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    mockedGetWorkspaceWorktreeRootRepoDir.mockReturnValue('/worktree');
    mockedGetWorkspaceWorktreeRepoDir.mockReturnValue('/worktree/repos/app');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileTreeRoots);
    const result = await handler(trustedEvent, {
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result.roots.map((root) => root.repoId)).toEqual([
      WORKSPACE_ROOT_REPO_ID,
      'app',
      'attachments',
    ]);
  });

  it('omits the attachments root when there are no attachments to show', async () => {
    const repoRoot = join(tempRoot, 'repo-with-empty-attachments');
    const attachmentsRoot = join(tempRoot, 'empty-attachments');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(attachmentsRoot, { recursive: true });
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);

    const handler = getHandler(IPC_CHANNELS.fileTreeRoots);
    const result = await handler(trustedEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(result.roots.map((root) => root.repoId)).toEqual(['project-1']);
  });
});

describe('CAN-4070 independent directory golden', () => {
  it('pins ordering and every legacy metadata field', async () => {
    const root = join(tempRoot, 'golden');
    await mkdir(join(root, 'z-folder'), { recursive: true });
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'éclair.txt'), '');
    await writeFile(join(root, 'alpha.txt'), '');
    await symlink(join(root, 'z-folder'), join(root, 'a-link'));
    const entries = await listFilesystemDirectory(root, '', {
      gitAware: true,
      globMatcher: {
        patterns: ['alpha.txt'],
        isIndexExcluded: (path) => path === 'alpha.txt',
      },
    });
    expect(entries).toEqual([
      {
        name: 'a-link',
        relativePath: 'a-link',
        absolutePath: join(root, 'a-link'),
        kind: 'directory',
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: true,
        hasChildren: false,
      },
      {
        name: 'z-folder',
        relativePath: 'z-folder',
        absolutePath: join(root, 'z-folder'),
        kind: 'directory',
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: false,
        hasChildren: true,
      },
      {
        name: 'alpha.txt',
        relativePath: 'alpha.txt',
        absolutePath: join(root, 'alpha.txt'),
        kind: 'file',
        isIgnored: false,
        isIndexExcluded: true,
        isSymlink: false,
        hasChildren: false,
      },
      {
        name: 'éclair.txt',
        relativePath: 'éclair.txt',
        absolutePath: join(root, 'éclair.txt'),
        kind: 'file',
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: false,
        hasChildren: false,
      },
    ]);
  });

  it('rejects an escaping symlink directory and omits its entry', async () => {
    const root = join(tempRoot, 'golden');
    const outside = join(tempRoot, 'golden-sibling');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape'));
    const options = {
      gitAware: false,
      globMatcher: buildFileExplorerGlobMatcher(),
    };
    expect(await listFilesystemDirectory(root, '', options)).toEqual([]);
    await expect(
      listFilesystemDirectory(root, 'escape', options),
    ).rejects.toThrow('outside the file tree root');
    expect(await listFilesystemDirectory(root, 'missing', options)).toEqual([]);
  });
});

describe('literal file glob compatibility', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'preserves path and case semantics on %s',
    (platform) => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        const matcher = buildFileGlobMatcher({
          disabledBuiltinGlobIds: [],
          customGlobs: [
            { id: 'c', pattern: ' café/** ', enabled: true },
            { id: 'n', pattern: '日本語/**', enabled: true },
            { id: 'h', pattern: '.hidden/**', enabled: true },
            { id: 'd', pattern: 'disabled/**', enabled: false },
          ],
        });
        const insensitive = platform !== 'linux';
        for (const [path, expected] of [
          ['', false],
          ['///', false],
          ['\\\\', false],
          [' ', false],
          ['/.git/config', true],
          ['a\\.git\\config', true],
          ['.git', true],
          ['.GIT/config', false],
          ['a/.Git/config', false],
          ['.gitignore', false],
          [' .git/config', false],
          ['a/.git /config', false],
          ['node_modules/x', true],
          ['///node_modules\\x', true],
          ['NODE_MODULES/x', insensitive],
          ['café/x', true],
          ['CAFÉ/x', insensitive],
          ['cafe\u0301/x', false],
          ['日本語/文書.txt', true],
          ['.hidden/x', true],
          ['build/x', false],
          ['dist/x', false],
          ['disabled/x', false],
        ] as const)
          expect(matcher.isIndexExcluded(path, 'file')).toBe(expected);
        expect(matcher.isIndexExcluded('node_modules', 'directory')).toBe(true);
        const suffix = buildFileGlobMatcher({
          disabledBuiltinGlobIds: [],
          customGlobs: [
            { id: 'suffix', pattern: 'only/child', enabled: true },
            { id: 'slash', pattern: 'slash/', enabled: true },
          ],
        });
        expect(suffix.isIndexExcluded('only', 'file')).toBe(false);
        expect(suffix.isIndexExcluded('only', 'directory')).toBe(true);
        expect(suffix.isIndexExcluded('slash', 'file')).toBe(false);
        expect(suffix.isIndexExcluded('slash', 'directory')).toBe(true);
        const explorer = buildFileExplorerGlobMatcher();
        expect(explorer.patterns).toEqual([]);
        for (const path of [
          'node_modules/x',
          'café/x',
          '.hidden/x',
          '日本語/文書.txt',
          '',
          '///',
          '.GIT/config',
        ]) {
          expect(explorer.isIndexExcluded(path, 'file')).toBe(false);
        }
        expect(explorer.isIndexExcluded('a\\.git\\config', 'file')).toBe(true);
        expect(explorer.isTraversalDeferred?.('///node_modules')).toBe(true);
        expect(explorer.isTraversalDeferred?.('NODE_MODULES')).toBe(
          insensitive,
        );
        for (const path of [
          '',
          '///',
          ' ',
          '.git',
          'build',
          'dist',
          'café',
          '日本語',
        ]) {
          expect(explorer.isTraversalDeferred?.(path)).toBe(false);
        }
      } finally {
        if (original) Object.defineProperty(process, 'platform', original);
      }
    },
  );
});
import { DESKTOP_FILE_IMAGE_SAVE_SUPPORT } from '@canopy/protocol/file-image-save';
