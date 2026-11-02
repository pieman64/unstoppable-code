import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import {
  COWORK_HOME_WORKTREE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import type * as StandaloneHistoryIndexModule from '../lib/standalone-history-index';
import { registerIpcHandler } from '../ipc/register';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  commitArchivedContainer,
  readArchivedContainerChatArchives,
  readArchivedContainerChats,
} from '../lib/archived-containers';
import { getArchivedContainerDir, getWorkspaceDir } from '../lib/paths';
import { ChatSearchService } from '../chat-search/service';
import { ChatSearchIndexer } from '../chat-search/indexer';
import {
  getChatStateService,
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateRepositoryLoadError } from '../services/chat-state-contracts';
import type { SessionDiagnosticRecord } from '../observability/service';
import { createCoworkWorkspace } from '../lib/cowork-workspace-crud';
import * as coworkWorkspaceCrud from '../lib/cowork-workspace-crud';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { registerStandaloneChatHandlers } from '../ipc/standalone-chat';
import {
  format4Scope,
  snapshotFormat4Files,
} from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import { upsert } from './helpers/chat-delta-journal-scope';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
  dialog: { showOpenDialog: jest.fn() },
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/chat-project-utils', () => ({
  ensureChatProjectDir: jest.fn().mockResolvedValue(undefined),
  ensureCoworkHomeScaffold: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  runClaudeCliProcessOffMain: jest
    .fn()
    .mockRejectedValue(new Error('marketplace not found')),
}));
jest.mock('../plugins/codex-marketplace-service', () => ({
  addCodexMarketplace: jest.fn(),
  codexMarketplaceManifestPath: jest.fn(),
  installCodexPlugin: jest.fn(),
  isStructuralCodexMarketplaceFailure: jest.fn(),
  listCodexPlugins: jest.fn(),
  readCodexMarketplaceInstallMetadata: jest.fn(),
  removeCodexMarketplace: jest
    .fn()
    .mockResolvedValue({ accepted: true, alreadySatisfied: true }),
  resolveCodexPluginInstallRoots: jest.fn(),
  upgradeCodexMarketplace: jest.fn(),
}));
jest.mock('../lib/standalone-history-index', () => {
  const actual = jest.requireActual<typeof StandaloneHistoryIndexModule>(
    '../lib/standalone-history-index',
  );
  return { ...actual, rebuildHistoryIndex: jest.fn().mockResolvedValue([]) };
});
jest.mock('../plugins/workspace-template-import', () => ({
  resolveDesktopWorkspaceTemplate: jest.fn().mockResolvedValue({
    selections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    unresolvedRefs: [],
  }),
}));

const PROJECT_ID = 'reader-lane-workspace';
const SCOPE_ID = 'reader-lane-scope';
const CONTAINER_ID = 'reader-lane-container';
const CURRENT_AT = '2026-10-01T00:00:00.000Z';

describe('format-4 adapter reader lanes', () => {
  let root: string;
  let previousDataDir: string | undefined;
  // The default service records storage diagnostics through the process
  // observability service, whose debounced flush writes under whichever
  // CANOPY_DATA_DIR is current, including a later test's snapshotted root.
  const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-storage-v4-adapter-lanes-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
    resetChatStateServiceForTests(new ChatStateService({ recordDiagnostic }));
    jest.clearAllMocks();
    registerStandaloneChatHandlers();
  });

  afterEach(async () => {
    await getChatStateService()
      .drain()
      .catch(() => undefined);
    resetChatStateServiceForTests();
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function seedScope(
    workspaceRoot: string,
    scopeId: string,
  ): Promise<ChatStorageV2> {
    const { store, backend } = await format4Scope(
      workspaceRoot,
      scopeId,
      scopeSource([
        {
          id: 'chat',
          messages: [
            message('reader-user', 'format-four reader payload', 'user'),
          ],
        },
      ]),
    );
    await backend.flush();
    backend.releaseJournal();
    return store;
  }

  function copyRequest(
    source: ChatStorageV2,
    destinationRoot: string,
  ): ArchiveIoOperationRequest {
    return {
      version: 1,
      requestId: 'reader-lane-request',
      operationId: 'reader-lane-copy',
      projectId: PROJECT_ID,
      containerId: CONTAINER_ID,
      expectedCreatedAt: CURRENT_AT,
      type: 'copy-chat-storage',
      input: {
        source: source.descriptor(),
        destination: { workspaceRoot: destinationRoot, scopeId: SCOPE_ID },
      },
    };
  }

  async function copyWithArchiveIo(
    request: ArchiveIoOperationRequest,
  ): Promise<unknown> {
    return executeArchiveIoRequest(request, new AbortController().signal, {
      progress: () => undefined,
      child: { started: () => undefined, exited: () => undefined },
    });
  }

  async function seedArchivedContainer(): Promise<ChatStorageV2> {
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
    const containerRoot = getArchivedContainerDir(PROJECT_ID, CONTAINER_ID);
    await mkdir(containerRoot, { recursive: true });
    const manifest: ArchivedContainerManifest = {
      version: 1,
      id: CONTAINER_ID,
      kind: 'worktree',
      projectId: PROJECT_ID,
      name: 'Format-four archive reader',
      createdAt: CURRENT_AT,
      archivedAt: CURRENT_AT,
      retentionDays: 365,
      expiresAt: '2099-10-01T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    };
    await commitArchivedContainer(manifest);
    return seedScope(containerRoot, CONTAINER_ID);
  }

  function standaloneHandler(
    channel: string,
  ): (...args: unknown[]) => Promise<unknown> {
    const call = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(([registeredChannel]) => registeredChannel === channel);
    if (!call || typeof call[1] !== 'function')
      throw new Error(`Missing standalone IPC handler: ${channel}`);
    return async (...args: unknown[]): Promise<unknown> =>
      Promise.resolve(Reflect.apply(call[1], undefined, args));
  }

  async function seedCoworkWorkspace(): Promise<{
    id: string;
    store: ChatStorageV2;
  }> {
    const workspace = await createCoworkWorkspace('Format Four Lane');
    const store = await seedScope(
      getWorkspaceDir(workspace.id),
      COWORK_HOME_WORKTREE_ID,
    );
    return { id: workspace.id, store };
  }

  async function exportCoworkWorkspace(
    projectId: string,
    destinationPath: string,
  ): Promise<unknown> {
    return standaloneHandler(IPC_CHANNELS.standaloneChatExportProject)(
      undefined,
      { projectId, destinationPath },
    );
  }

  it('archive I/O reconstructs a descriptor and copies a real format-4 scope', async () => {
    const sourceRoot = join(root, 'archive-source');
    const destinationRoot = join(root, 'archive-copy');
    const source = await seedScope(sourceRoot, SCOPE_ID);

    await expect(
      copyWithArchiveIo(copyRequest(source, destinationRoot)),
    ).resolves.toEqual({
      copied: true,
    });
    const copied = new ChatStorageV2(destinationRoot, SCOPE_ID);
    expect(await copied.format()).toBe('v4');
    expect((await copied.indexes()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
    ]);
  });

  it('archive I/O refuses a format-5 source without changing source or destination files', async () => {
    const sourceRoot = join(root, 'archive-source');
    const destinationRoot = join(root, 'archive-copy');
    const source = await seedScope(sourceRoot, SCOPE_ID);
    const original: unknown = JSON.parse(
      await readFile(source.manifestPath, 'utf8'),
    );
    if (
      typeof original !== 'object' ||
      original === null ||
      Array.isArray(original)
    )
      throw new Error('Expected a manifest object');
    await writeFile(
      source.manifestPath,
      `${JSON.stringify({ ...original, version: 5 })}\n`,
      'utf8',
    );
    const before = await snapshotFormat4Files(root);

    await expect(
      copyWithArchiveIo(copyRequest(source, destinationRoot)),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    expect(await snapshotFormat4Files(root)).toEqual(before);
  });

  it('fails closed without writes on journaled format-4 archived containers pending phase 15', async () => {
    await seedArchivedContainer();
    const containerRoot = getArchivedContainerDir(PROJECT_ID, CONTAINER_ID);
    const before = await snapshotFormat4Files(containerRoot);
    await expect(
      readArchivedContainerChats(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    await expect(
      readArchivedContainerChatArchives(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    expect(await snapshotFormat4Files(containerRoot)).toEqual(before);
  });

  it('archived-container chat reads refuse format 5 without changing its payload', async () => {
    const store = await seedArchivedContainer();
    const original: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    if (
      typeof original !== 'object' ||
      original === null ||
      Array.isArray(original)
    )
      throw new Error('Expected a manifest object');
    await writeFile(
      store.manifestPath,
      `${JSON.stringify({ ...original, version: 5 })}\n`,
      'utf8',
    );
    const containerRoot = getArchivedContainerDir(PROJECT_ID, CONTAINER_ID);
    const before = await snapshotFormat4Files(containerRoot);

    await expect(
      readArchivedContainerChats(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    await expect(
      readArchivedContainerChatArchives(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    expect(await snapshotFormat4Files(containerRoot)).toEqual(before);
  });

  it('standalone IPC export and import stage a real format-4 scope', async () => {
    const destinationPath = join(root, 'exports');
    await mkdir(destinationPath, { recursive: true });
    const source = await seedCoworkWorkspace();
    const exported: unknown = await exportCoworkWorkspace(
      source.id,
      destinationPath,
    );
    if (
      typeof exported !== 'object' ||
      exported === null ||
      !('exportedPath' in exported) ||
      typeof exported.exportedPath !== 'string'
    )
      throw new Error('Expected an exported project path');

    const exportedStore = new ChatStorageV2(
      exported.exportedPath,
      COWORK_HOME_WORKTREE_ID,
    );
    expect(await exportedStore.format()).toBe('v4');
    const imported: unknown = await standaloneHandler(
      IPC_CHANNELS.standaloneChatImportProject,
    )(undefined, { sourcePath: exported.exportedPath });
    if (
      typeof imported !== 'object' ||
      imported === null ||
      !('project' in imported) ||
      typeof imported.project !== 'object' ||
      imported.project === null ||
      !('id' in imported.project) ||
      typeof imported.project.id !== 'string'
    )
      throw new Error('Expected an imported project');
    const entries = await listWorkEntryIds(imported.project.id);
    expect(entries).toHaveLength(1);
    const entryId = entries[0];
    if (!entryId) throw new Error('Missing imported Work Entry');
    expect(
      (
        await getChatStateService().getTranscriptPage({
          projectId: imported.project.id,
          worktreeId: entryId,
          chatId: 'chat',
        })
      ).messages,
    ).toMatchObject([
      {
        id: 'reader-user',
        blocks: [{ type: 'text', text: 'format-four reader payload' }],
      },
    ]);
  });

  it('standalone export refuses a v5 scope before writing an export bundle', async () => {
    const destinationPath = join(root, 'exports');
    await mkdir(destinationPath, { recursive: true });
    const source = await seedCoworkWorkspace();
    const original: unknown = JSON.parse(
      await readFile(source.store.manifestPath, 'utf8'),
    );
    if (
      typeof original !== 'object' ||
      original === null ||
      Array.isArray(original)
    )
      throw new Error('Expected a manifest object');
    await writeFile(
      source.store.manifestPath,
      `${JSON.stringify({ ...original, version: 5 })}\n`,
      'utf8',
    );
    const before = await snapshotFormat4Files(root);

    const error = await exportCoworkWorkspace(source.id, destinationPath).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(
      ChatStorageNewerFormatError,
    );
    expect(await snapshotFormat4Files(root)).toEqual(before);
    // Guards the isolation in beforeEach: this refusal records a storage
    // diagnostic, which must reach the injected sink, not the process
    // observability service writing under the temp data dir.
    expect(recordDiagnostic).toHaveBeenCalled();
  });

  it('standalone IPC import refuses a v5 staged scope before writing workspace files', async () => {
    const destinationPath = join(root, 'exports');
    await mkdir(destinationPath, { recursive: true });
    const source = await seedCoworkWorkspace();
    const exported: unknown = await exportCoworkWorkspace(
      source.id,
      destinationPath,
    );
    if (
      typeof exported !== 'object' ||
      exported === null ||
      !('exportedPath' in exported) ||
      typeof exported.exportedPath !== 'string'
    )
      throw new Error('Expected an exported project path');
    const bundleManifest = join(
      exported.exportedPath,
      'chat-storage-manifests',
      `${COWORK_HOME_WORKTREE_ID}.json`,
    );
    const original: unknown = JSON.parse(
      await readFile(bundleManifest, 'utf8'),
    );
    if (
      typeof original !== 'object' ||
      original === null ||
      Array.isArray(original)
    )
      throw new Error('Expected a bundle manifest object');
    await writeFile(
      bundleManifest,
      `${JSON.stringify({ ...original, version: 5 })}\n`,
      'utf8',
    );
    const before = await snapshotFormat4Files(root);
    const creation = jest.spyOn(coworkWorkspaceCrud, 'createCoworkWorkspace');

    await expect(
      standaloneHandler(IPC_CHANNELS.standaloneChatImportProject)(undefined, {
        sourcePath: exported.exportedPath,
      }),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    const after = await snapshotFormat4Files(root);
    expect({ createdWorkspaces: creation.mock.calls, files: after }).toEqual({
      createdWorkspaces: [],
      files: before,
    });
  });

  it('chat-search scans body text from format 4 and refreshes its journal fingerprint', async () => {
    const workspaceRoot = getWorkspaceDir(PROJECT_ID);
    const store = await seedScope(workspaceRoot, SCOPE_ID);
    const search = new ChatSearchService({
      dbPath: join(root, 'chat-search.sqlite'),
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated: (): void => undefined,
    });
    // Search and the update share the canonical repository writer; a separate
    // backend would leave the search service's cached projection stale.
    const repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(workspaceRoot, 'chats', `${SCOPE_ID}.json`),
        archives: join(workspaceRoot, 'chat-archives', `${SCOPE_ID}.json`),
        journal: join(workspaceRoot, 'chat-journals', `${SCOPE_ID}.jsonl`),
      }),
    });
    const service = new ChatStateService({
      repository,
      recordDiagnostic: jest.fn(),
    });
    resetChatStateServiceForTests(service);
    const scope = { projectId: PROJECT_ID, worktreeId: SCOPE_ID };
    try {
      await search.scanAllSources();
      expect(
        search.query({ query: 'reader payload' }).map((entry) => entry.chatId),
      ).toContain('chat');
      await repository.transactWith(
        scope,
        () => [
          upsert(
            'chat',
            message('reader-user-next', 'zebranium refreshed body', 'user', 2),
          ),
        ],
        { source: 'provider', chatIds: ['chat'] },
      );
      await repository.flushScope(scope);
      await search.scanAllSources();
      expect(
        search.query({ query: 'reader payload' }).map((entry) => entry.chatId),
      ).toContain('chat');
      expect(
        search.query({ query: 'zebranium' }).map((entry) => entry.chatId),
      ).toContain('chat');
      expect(await store.format()).toBe('v4');
    } finally {
      await service.drain();
      await search.close();
    }
  });

  it('chat-search refuses a v5 source before writing fingerprints or index data', async () => {
    const source = await seedScope(getWorkspaceDir(PROJECT_ID), SCOPE_ID);
    const original: unknown = JSON.parse(
      await readFile(source.manifestPath, 'utf8'),
    );
    if (
      typeof original !== 'object' ||
      original === null ||
      Array.isArray(original)
    )
      throw new Error('Expected a manifest object');
    await writeFile(
      source.manifestPath,
      `${JSON.stringify({ ...original, version: 5 })}\n`,
      'utf8',
    );
    const search = new ChatSearchService({
      dbPath: join(root, 'chat-search.sqlite'),
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      broadcastUpdated: (): void => undefined,
    });
    const before = await snapshotFormat4Files(root);
    try {
      await expect(search.scanAllSources()).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      expect(await snapshotFormat4Files(root)).toEqual(before);
    } finally {
      await search.close();
    }
  });
});
