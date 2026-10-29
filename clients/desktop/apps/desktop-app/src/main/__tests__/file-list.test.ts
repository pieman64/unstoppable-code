import {
  access,
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
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
import { promises as fsPromises, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as FileBrowserRootsModule from '../lib/file-browser-roots';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import {
  CanopyOperationError,
  createInProcessCanopyClient,
} from '@canopy/core-runtime';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type FileIndexingPreferences,
  type FileIndexRequest,
  type FileIndexResponse,
  type FileTreeDirectoryRequest,
  type FileTreeDirectoryResponse,
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
import { mutateFileTree } from '../services/files-service';
import { assertNotSplitLocked } from '../services/split-lock-service';
import {
  getFileTreeWatchCount,
  startFileTreeWatch,
  stopFileTreeWatch,
} from '../services/file-tree-watch-service';
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
import { validateId } from '../lib/validation';

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
const mockedValidateId = jest.mocked(validateId);
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
  dispatcher = createDesktopRuntime({
    services: {
      listFileTreeRoots: listRootsService,
      listFileTreeDirectory: listDirectoryService,
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

  it('creates, renames, incrementally copies, moves, and deletes entries', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

    await mutateFileTree({
      ...scope,
      operation: 'create-file',
      target: { repoId: 'project-1', relativePath: 'drafts/notes.txt' },
    });
    expect(await readFile(join(repoRoot, 'drafts', 'notes.txt'), 'utf8')).toBe(
      '',
    );

    await mutateFileTree({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'drafts/notes.txt' },
      target: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
    });
    await expectMissing(join(repoRoot, 'drafts', 'notes.txt'));

    const copied = await mutateFileTree({
      ...scope,
      operation: 'copy',
      source: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
      target: { repoId: 'project-1', relativePath: 'drafts/renamed.txt' },
      conflict: 'increment',
    });
    expect(copied.target?.relativePath).toBe('drafts/renamed copy.txt');

    await mutateFileTree({
      ...scope,
      operation: 'create-directory',
      target: { repoId: 'project-1', relativePath: 'archive' },
    });
    await mutateFileTree({
      ...scope,
      operation: 'move',
      source: { repoId: 'project-1', relativePath: 'drafts/renamed copy.txt' },
      target: { repoId: 'project-1', relativePath: 'archive/copy.txt' },
    });
    expect(await readFile(join(repoRoot, 'archive', 'copy.txt'), 'utf8')).toBe(
      '',
    );

    await mutateFileTree({
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

    await mutateFileTree({
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

    await mutateFileTree({
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

    await mutateFileTree({
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

    const result: unknown = Reflect.apply(mutateFileTree, undefined, [
      malformedRequest,
    ]);
    await expect(Promise.resolve(result)).rejects.toThrow(
      'Unsupported file-tree mutation operation',
    );
    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
    await expectMissing(targetPath);
  });

  it('rejects roots, traversal, conflicts, and symlink escapes', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

    await expect(
      mutateFileTree({
        ...scope,
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: '' },
      }),
    ).rejects.toThrow('cannot be a file-tree root');
    await expect(
      mutateFileTree({
        ...scope,
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: '../escaped.txt' },
      }),
    ).rejects.toThrow('cannot traverse outside');
    await expect(
      mutateFileTree({
        ...scope,
        operation: 'create-file',
        target: { repoId: 'project-1', relativePath: 'src/index.ts' },
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    const outside = join(tempRoot, 'outside-mutations');
    await mkdir(outside);
    await symlink(outside, join(repoRoot, 'outside-link'));
    await expect(
      mutateFileTree({
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
    const trashItem = jest.fn(() => Promise.resolve());

    await mutateFileTree(
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'delete',
        target: { repoId: 'project-1', relativePath: 'src/index.ts' },
        useTrash: true,
      },
      { trashItem },
    );

    expect(trashItem).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]repo[/\\]src[/\\]index\.ts$/),
    );
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
      mutateFileTree({
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

    const copied = await mutateFileTree({
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
      mutateFileTree({
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

  it('does not overwrite a move target created after conflict validation', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'source.txt');
    const targetPath = join(repoRoot, 'target.txt');
    await writeFile(sourcePath, 'source\n');

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: { repoId: 'project-1', relativePath: 'source.txt' },
          target: { repoId: 'project-1', relativePath: 'target.txt' },
          conflict: 'error',
        },
        {
          beforeMove: async () => {
            await writeFile(targetPath, 'concurrent target\n');
          },
        },
      ),
    ).rejects.toThrow('already exists');

    expect(await readFile(targetPath, 'utf8')).toBe('concurrent target\n');
    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
  });

  it('refuses a move when a validated parent is swapped for an escaping symlink', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'race-source.txt');
    const targetParent = join(repoRoot, 'race-target');
    const originalParent = join(repoRoot, 'race-target-original');
    const outside = join(tempRoot, 'race-outside');
    const outsideTarget = join(outside, 'moved.txt');
    await writeFile(sourcePath, 'source\n');
    await mkdir(targetParent);
    await mkdir(outside);

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: { repoId: 'project-1', relativePath: 'race-source.txt' },
          target: {
            repoId: 'project-1',
            relativePath: 'race-target/moved.txt',
          },
          conflict: 'error',
        },
        {
          beforeMove: async () => {
            await rename(targetParent, originalParent);
            await symlink(outside, targetParent);
          },
        },
      ),
    ).rejects.toThrow('outside the selected worktree root');

    await expectMissing(outsideTarget);
    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
  });

  it('copies from the validated source when its lexical alias is swapped', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourceDirectory = join(repoRoot, 'validated-source');
    const lexicalAlias = join(repoRoot, 'source-alias');
    const outsideDirectory = join(tempRoot, 'outside-source');
    const sourcePath = join(sourceDirectory, 'value.txt');
    const targetPath = join(repoRoot, 'copied-value.txt');
    await mkdir(sourceDirectory);
    await mkdir(outsideDirectory);
    await writeFile(sourcePath, 'inside\n');
    await writeFile(join(outsideDirectory, 'value.txt'), 'outside\n');
    await symlink(sourceDirectory, lexicalAlias);
    const copyEntry = jest.fn(
      async (validatedSource: string, target: string) => {
        await rm(lexicalAlias);
        await symlink(outsideDirectory, lexicalAlias);
        await cp(validatedSource, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      },
    );

    await mutateFileTree(
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'copy',
        source: { repoId: 'project-1', relativePath: 'source-alias/value.txt' },
        target: { repoId: 'project-1', relativePath: 'copied-value.txt' },
        conflict: 'error',
      },
      { copyEntry },
    );

    expect(copyEntry).toHaveBeenCalledWith(
      await realpath(sourcePath),
      expect.any(String),
    );
    expect(await readFile(targetPath, 'utf8')).toBe('inside\n');
  });

  it('removes copy staging artifacts after a partial copy failure', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'partial-source.txt');
    const targetPath = join(repoRoot, 'partial-target.txt');
    await writeFile(sourcePath, 'source\n');
    const copyEntry = jest.fn(async (_source: string, target: string) => {
      await writeFile(target, 'partial\n');
      throw new Error('copy interrupted');
    });

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'copy',
          source: { repoId: 'project-1', relativePath: 'partial-source.txt' },
          target: { repoId: 'project-1', relativePath: 'partial-target.txt' },
          conflict: 'error',
        },
        { copyEntry },
      ),
    ).rejects.toThrow('copy interrupted');

    await expectMissing(targetPath);
    expect(
      (await readdir(repoRoot)).some((entry) =>
        entry.startsWith('.canopy-copy-'),
      ),
    ).toBe(false);
  });

  it('does not overwrite a copy target created during staged publication', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'publish-source.txt');
    const targetPath = join(repoRoot, 'publish-target.txt');
    await writeFile(sourcePath, 'source\n');
    const linkEntry = jest.fn(async (stagingPath: string, target: string) => {
      await writeFile(target, 'concurrent target\n', { flag: 'wx' });
      await link(stagingPath, target);
    });

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'copy',
          source: {
            repoId: 'project-1',
            relativePath: 'publish-source.txt',
          },
          target: {
            repoId: 'project-1',
            relativePath: 'publish-target.txt',
          },
          conflict: 'error',
        },
        { publishLinkEntry: linkEntry },
      ),
    ).rejects.toThrow('already exists');

    expect(linkEntry).toHaveBeenCalledWith(expect.any(String), targetPath);
    expect(await readFile(targetPath, 'utf8')).toBe('concurrent target\n');
    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
  });

  it('does not treat source cleanup failure as a hard-link capability failure', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'cleanup-file-source.txt');
    const targetPath = join(repoRoot, 'cleanup-file-target.txt');
    await writeFile(sourcePath, 'source\n');
    const unlinkEntry = jest.fn(async (pathValue: string) => {
      if (pathValue === sourcePath) {
        throw Object.assign(new Error('source cleanup denied'), {
          code: 'EPERM',
        });
      }
      await rm(pathValue);
    });

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: {
            repoId: 'project-1',
            relativePath: 'cleanup-file-source.txt',
          },
          target: {
            repoId: 'project-1',
            relativePath: 'cleanup-file-target.txt',
          },
          conflict: 'error',
        },
        { unlinkEntry },
      ),
    ).rejects.toThrow('source cleanup denied');

    expect(await readFile(sourcePath, 'utf8')).toBe('source\n');
    await expectMissing(targetPath);
  });

  it('keeps a completed cross-device copy when source cleanup fails', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'cleanup-source');
    const targetPath = join(repoRoot, 'cleanup-target');
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'complete.txt'), 'complete\n');
    const renameEntry = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
      ),
    );
    const removeEntry = jest.fn(
      async (pathValue: string, options: { recursive: true; force: false }) => {
        if (pathValue === sourcePath) {
          throw new Error('source cleanup failed');
        }
        await rm(pathValue, options);
      },
    );

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: { repoId: 'project-1', relativePath: 'cleanup-source' },
          target: { repoId: 'project-1', relativePath: 'cleanup-target' },
          conflict: 'error',
        },
        { renameEntry, removeEntry },
      ),
    ).rejects.toThrow('source cleanup failed');

    expect(await readFile(join(targetPath, 'complete.txt'), 'utf8')).toBe(
      'complete\n',
    );
    expect(await readFile(join(sourcePath, 'complete.txt'), 'utf8')).toBe(
      'complete\n',
    );
  });

  it('does not merge a cross-device directory move into a concurrent target', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'cross-device-source');
    const targetPath = join(repoRoot, 'cross-device-target');
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'source.txt'), 'source\n');
    const renameEntry = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
      ),
    );
    const copyEntry = jest.fn(async (source: string, target: string) => {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, 'foreign.txt'), 'foreign\n');
      await cp(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    });

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: {
            repoId: 'project-1',
            relativePath: 'cross-device-source',
          },
          target: {
            repoId: 'project-1',
            relativePath: 'cross-device-target',
          },
          conflict: 'error',
        },
        { renameEntry, copyEntry },
      ),
    ).rejects.toThrow('already exists');

    expect(await readFile(join(targetPath, 'foreign.txt'), 'utf8')).toBe(
      'foreign\n',
    );
    await expectMissing(join(targetPath, 'source.txt'));
    expect(await readFile(join(sourcePath, 'source.txt'), 'utf8')).toBe(
      'source\n',
    );
  });

  it('keeps foreign destination content when a staged EXDEV copy fails', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'failed-cross-device-source');
    const targetPath = join(repoRoot, 'failed-cross-device-target');
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'source.txt'), 'source\n');
    const renameEntry = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
      ),
    );
    const copyEntry = jest.fn(async (_source: string, stagingPath: string) => {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, 'foreign.txt'), 'foreign\n');
      await mkdir(stagingPath, { recursive: true });
      await writeFile(join(stagingPath, 'partial.txt'), 'partial\n');
      throw new Error('copy interrupted');
    });

    await expect(
      mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: {
            repoId: 'project-1',
            relativePath: 'failed-cross-device-source',
          },
          target: {
            repoId: 'project-1',
            relativePath: 'failed-cross-device-target',
          },
          conflict: 'error',
        },
        { renameEntry, copyEntry },
      ),
    ).rejects.toThrow('copy interrupted');

    expect(await readFile(join(targetPath, 'foreign.txt'), 'utf8')).toBe(
      'foreign\n',
    );
    expect(await readFile(join(sourcePath, 'source.txt'), 'utf8')).toBe(
      'source\n',
    );
    expect(
      (await readdir(repoRoot)).some((entry) =>
        entry.startsWith('.canopy-copy-'),
      ),
    ).toBe(false);
  });

  it('falls back when the filesystem does not support hard links', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'unsupported-link.txt');
    const targetPath = join(repoRoot, 'moved-without-link.txt');
    await writeFile(sourcePath, 'move me\n');
    const linkEntry = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('not supported'), { code: 'ENOTSUP' }),
      ),
    );

    await mutateFileTree(
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'move',
        source: {
          repoId: 'project-1',
          relativePath: 'unsupported-link.txt',
        },
        target: {
          repoId: 'project-1',
          relativePath: 'moved-without-link.txt',
        },
        conflict: 'error',
      },
      { linkEntry, publishLinkEntry: linkEntry },
    );

    expect(linkEntry).toHaveBeenCalledWith(sourcePath, targetPath);
    expect(linkEntry).toHaveBeenCalledWith(expect.any(String), targetPath);
    expect(await readFile(targetPath, 'utf8')).toBe('move me\n');
    await expectMissing(sourcePath);
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

    await mutateFileTree({
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

  it('does not pre-create a directory move target on Windows', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const sourcePath = join(repoRoot, 'windows-source');
    const targetPath = join(repoRoot, 'windows-target');
    await mkdir(sourcePath);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const renameEntry = jest.fn(async (source: string, target: string) => {
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await rename(source, target);
    });

    try {
      await mutateFileTree(
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'move',
          source: { repoId: 'project-1', relativePath: 'windows-source' },
          target: { repoId: 'project-1', relativePath: 'windows-target' },
          conflict: 'error',
        },
        { renameEntry },
      );
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }

    expect(renameEntry).toHaveBeenCalledWith(sourcePath, targetPath);
    expect((await lstat(targetPath)).isDirectory()).toBe(true);
    await expectMissing(sourcePath);
  });

  it('preserves relative symlinks when copying a directory', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await mkdir(join(repoRoot, 'linked-dir'));
    await writeFile(join(repoRoot, 'linked-dir', 'target.txt'), 'target\n');
    await symlink('target.txt', join(repoRoot, 'linked-dir', 'link.txt'));

    await mutateFileTree({
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

    const copied = await mutateFileTree({
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
      mutateFileTree({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        operation: 'copy',
        source: { repoId: 'project-1', relativePath: 'transfer' },
        target: { repoId: 'attachments', relativePath: 'copied-transfer' },
        conflict: 'error',
      }),
    ).rejects.toThrow('symlink');
  });

  it('uses Windows path semantics when blocking a folder copied into itself', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    await mkdir(join(repoRoot, 'Folder'));
    await writeFile(join(repoRoot, 'Folder', 'nested.txt'), 'nested\n');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await expect(
        mutateFileTree({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          operation: 'copy',
          source: { repoId: 'project-1', relativePath: 'Folder' },
          target: { repoId: 'project-1', relativePath: 'folder/sub' },
          conflict: 'error',
        }),
      ).rejects.toThrow('cannot be moved or copied into itself');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('file-tree native change detection', () => {
  it('watches an initially empty attachments root for its first file', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    await rm(join(attachmentsRoot, 'note.txt'));
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const listeners = new Map<string, () => void>();
    const watchDirectory = jest.fn(
      (
        pathValue: string,
        _options: { recursive: true },
        listener: () => void,
      ) => {
        listeners.set(pathValue, listener);
        return { close: jest.fn(), on: jest.fn() };
      },
    );
    const onChange = jest.fn();

    await startFileTreeWatch(
      42,
      { projectId: 'project-1', worktreeId: 'wt-1' },
      onChange,
      { watchDirectory, debounceMs: 0 },
    );

    expect(watchDirectory).toHaveBeenCalledWith(
      attachmentsRoot,
      { recursive: true },
      expect.any(Function),
    );
    listeners.get(attachmentsRoot)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ changeCount: 1 }),
    );
    stopFileTreeWatch(42, { projectId: 'project-1', worktreeId: 'wt-1' });
  });

  it('watches an existing parent when the attachments root is not created yet', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    await rm(attachmentsRoot, { recursive: true, force: false });
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const listeners = new Map<string, () => void>();
    const watchDirectory = jest.fn(
      (
        pathValue: string,
        _options: { recursive: true },
        listener: () => void,
      ) => {
        listeners.set(pathValue, listener);
        return { close: jest.fn(), on: jest.fn() };
      },
    );
    const onChange = jest.fn();

    const request = { projectId: 'project-1', worktreeId: 'wt-1' };
    try {
      await startFileTreeWatch(43, request, onChange, {
        watchDirectory,
        debounceMs: 0,
      });

      const parentPath = dirname(attachmentsRoot);
      expect(watchDirectory).toHaveBeenCalledWith(
        parentPath,
        { recursive: true },
        expect.any(Function),
      );
      listeners.get(parentPath)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ changeCount: 1 }),
      );
    } finally {
      stopFileTreeWatch(43, request);
    }
  });

  it('does not climb above a missing attachments hierarchy', async () => {
    const { repoRoot } = await createRepoFixture();
    const missingAttachmentsRoot = join(
      tempRoot,
      'workspace-state',
      'attachments',
      'wt-1',
    );
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(missingAttachmentsRoot);
    const watchDirectory = jest.fn(() => ({
      close: jest.fn(),
      on: jest.fn(),
    }));
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };

    try {
      await startFileTreeWatch(44, request, jest.fn(), { watchDirectory });

      expect(watchDirectory).toHaveBeenCalledTimes(1);
      expect(watchDirectory).toHaveBeenCalledWith(
        repoRoot,
        { recursive: true },
        expect.any(Function),
      );
    } finally {
      stopFileTreeWatch(44, request);
    }
  });

  it('coalesces changes while subscribed and releases every watcher on stop', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };
    const close = jest.fn();
    let emitChange = (): void => undefined;
    const watchDirectory = jest.fn(
      (_path: string, _options: { recursive: true }, listener: () => void) => {
        emitChange = listener;
        return {
          close,
          on: jest.fn(),
        };
      },
    );
    let resolveChange: ((changeCount: number) => void) | undefined;
    const changed = new Promise<number>((resolve) => {
      resolveChange = resolve;
    });

    await startFileTreeWatch(
      42,
      request,
      (event) => {
        resolveChange?.(event.changeCount);
      },
      { watchDirectory, debounceMs: 0 },
    );
    expect(getFileTreeWatchCount()).toBe(1);

    emitChange();
    emitChange();
    await expect(changed).resolves.toBe(2);

    stopFileTreeWatch(42, request);
    expect(watchDirectory).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(watchDirectory.mock.calls.length);
    expect(getFileTreeWatchCount()).toBe(0);
  });

  it('cancels an in-flight start and closes superseded watcher handles', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };
    const actualFileBrowserRoots = jest.requireActual<
      typeof FileBrowserRootsModule
    >('../lib/file-browser-roots');
    const roots = await actualFileBrowserRoots.getFileBrowserRoots(
      request.projectId,
      request.worktreeId,
    );
    let releaseFirst: (() => void) | undefined;
    const firstRoots = new Promise<typeof roots>((resolve) => {
      releaseFirst = (): void => resolve(roots);
    });
    mockedGetFileBrowserRoots
      .mockImplementationOnce(() => firstRoots)
      .mockResolvedValueOnce(roots);
    const watcherCloses: jest.Mock[] = [];
    const watchDirectory = jest.fn((): { close: jest.Mock; on: jest.Mock } => {
      const close = jest.fn();
      watcherCloses.push(close);
      return { close, on: jest.fn() };
    });

    const firstStart = startFileTreeWatch(42, request, jest.fn(), {
      watchDirectory,
    });
    const secondStart = startFileTreeWatch(42, request, jest.fn(), {
      watchDirectory,
    });
    await secondStart;
    releaseFirst?.();
    await firstStart;

    expect(getFileTreeWatchCount()).toBe(1);
    expect(watchDirectory).toHaveBeenCalledTimes(roots.roots.length);
    for (const close of watcherCloses) expect(close).not.toHaveBeenCalled();
    stopFileTreeWatch(42, request);
    for (const close of watcherCloses) expect(close).toHaveBeenCalledTimes(1);
  });

  it('validates watcher stop identifiers', () => {
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };
    stopFileTreeWatch(42, request);
    expect(mockedValidateId).toHaveBeenCalledWith('project-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
  });

  it('registers sender teardown only once across repeated watcher starts', async () => {
    const { repoRoot, attachmentsRoot } = await createRepoFixture();
    mockedResolveWorktreeCwd.mockReturnValue(repoRoot);
    mockedGetWorktreeAttachmentsDir.mockReturnValue(attachmentsRoot);
    const call = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.fileTreeWatchStart,
    );
    if (!call || typeof call[1] !== 'function') {
      throw new Error('Missing file-tree watch-start handler');
    }
    const sender = {
      id: 42,
      once: jest.fn(),
      isDestroyed: jest.fn(() => false),
      send: jest.fn(),
    };
    const request = { projectId: 'project-1', worktreeId: 'wt-1' };

    await Reflect.apply(call[1], undefined, [{ sender }, request]);
    await Reflect.apply(call[1], undefined, [{ sender }, request]);

    expect(sender.once).toHaveBeenCalledTimes(1);
    stopFileTreeWatch(42, request);
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
      path: root,
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

  it('routes roots and directory reads through the dispatcher while leaving the index direct', async () => {
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

    expect(query.mock.calls.map(([name]) => name)).toEqual([
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
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
    expect(legacyRoots).toEqual(directRoots);
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
    await expect(activeRead).resolves.toEqual({ roots: [] });
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
    const result = await handler(null, {
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
    ).resolves.toEqual(rootResponse);
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
