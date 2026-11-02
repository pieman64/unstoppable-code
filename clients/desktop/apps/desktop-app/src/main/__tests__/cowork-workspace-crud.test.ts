import type * as OrgCoworkBindingDeps from '../lib/org-cowork-binding-deps';
import type * as WorkspaceManifestModule from '../lib/workspace-manifest-repository';
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
// This suite mocks the sidebar index; real profile ownership is covered by the
// profile authority suite and archive/restore Electron flows.
jest.mock('../browser/browser-profile-lifecycle', () => ({
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn().mockResolvedValue([]),
}));
jest.mock('../lib/archived-containers', () => ({
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../lib/workspace-activity', () => ({
  touchAllWorkspaceTargets: jest.fn().mockResolvedValue(undefined),
}));

const mockCancelLocalWorkspace = jest.fn(() => Promise.resolve());
const mockCommitLocalWorkspaceCancellation = jest.fn(() => Promise.resolve());
const mockReleaseLocalWorkspaceFence = jest.fn(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalWorkspace: mockCancelLocalWorkspace,
    commitLocalWorkspaceCancellation: mockCommitLocalWorkspaceCancellation,
    releaseLocalWorkspaceFence: mockReleaseLocalWorkspaceFence,
  })),
}));

let mockSidebarItems: SidebarItem[] = [];
let mockFailedCoworkWorkspaceId: string | null = null;
const mockReadWorkspaceOwnership = jest.fn<
  ReturnType<typeof WorkspacePersistenceModule.readWorkspaceOwnership>,
  Parameters<typeof WorkspacePersistenceModule.readWorkspaceOwnership>
>(() => Promise.resolve({ authority: 'absent' as const }));
const mockWorkspaceConfigs = new Map<string, WorkspaceConfigFile>();
const mockPublishedWithoutConfig = new Set<string>();
function mockConfig(id: string): WorkspaceConfigFile | undefined {
  const stored = mockWorkspaceConfigs.get(id);
  if (stored) return stored;
  if (mockPublishedWithoutConfig.has(id)) return undefined;
  const item = mockSidebarItems.find((item) => item.id === id);
  return item ? { ...item, version: 1, repos: [] } : undefined;
}
const mockIndexCommit = jest.fn((entries: WorkspaceIndexEntry[]) => {
  for (const entry of entries)
    if (
      !mockSidebarItems.some((item) => item.id === entry.id) &&
      !mockWorkspaceConfigs.has(entry.id)
    )
      mockPublishedWithoutConfig.add(entry.id);
  mockSidebarItems = entries
    .filter((entry) => entry.id !== mockFailedCoworkWorkspaceId)
    .map((entry) => ({ ...mockConfig(entry.id), ...entry, type: 'cowork' }));
});
function mockIndexEntries(): WorkspaceIndexEntry[] {
  const entries: WorkspaceIndexEntry[] = mockSidebarItems.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    color: item.color,
    collapsed: item.collapsed,
    order: item.order,
  }));
  if (
    mockFailedCoworkWorkspaceId &&
    !entries.some((entry) => entry.id === mockFailedCoworkWorkspaceId)
  )
    entries.push({
      id: mockFailedCoworkWorkspaceId,
      name: 'Failed Cowork',
      type: 'cowork',
      color: '#7C3AED',
      collapsed: false,
      order: entries.length,
    });
  return entries;
}
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  WorkspaceConfigUnreadableError: jest.requireActual<
    typeof WorkspaceManifestModule
  >('../lib/workspace-manifest-repository').WorkspaceConfigUnreadableError,
  readWorkspaceConfigDetailed: (id: string) =>
    Promise.resolve({
      config: mockConfig(id) ?? { version: 1, repos: [], type: 'multi-repo' },
      authority: mockConfig(id) ? 'ok' : 'absent',
      ownerMalformed: false,
      memoryMalformed: false,
    }),
  getWorkspaceManifestRepository: () => ({
    read: (id: string) =>
      Promise.resolve(
        mockConfig(id)
          ? { authority: 'ok', document: mockConfig(id) }
          : { authority: 'absent' },
      ),
    serialize: (_id: string, work: () => Promise<unknown>) => work(),
  }),
  updateWorkspaceConfig: async <T>(
    id: string,
    update: (
      config: WorkspaceConfigFile,
      read: { authority: 'ok' | 'absent'; ownerMalformed: boolean },
    ) => T | Promise<T>,
    options?: {
      ownership?: WorkspacePersistenceModule.WorkspaceConfigOwnershipWrite;
      shouldWrite?: (result: T) => boolean;
    },
  ) => {
    const existing = mockConfig(id);
    const config: WorkspaceConfigFile = existing
      ? structuredClone(existing)
      : { version: 1, repos: [], type: 'multi-repo' };
    const result = await update(config, {
      authority: existing ? 'ok' : 'absent',
      ownerMalformed: false,
    });
    if (!options?.shouldWrite || options.shouldWrite(result)) {
      const persistence: typeof WorkspacePersistenceModule = jest.requireMock(
        '../lib/workspace-persistence',
      );
      await persistence.writeWorkspaceConfig(id, config, {
        ownership: options?.ownership ?? 'preserve',
      });
      mockSidebarItems = mockSidebarItems.map((item) =>
        item.id === id ? { ...item, ...config, type: 'cowork' } : item,
      );
    }
    return result;
  },
  readWorkspaceConfig: (workspaceId: string) =>
    Promise.resolve(mockWorkspaceConfigs.get(workspaceId)),
  readWorkspaceOwnership: (
    ...args: Parameters<
      typeof WorkspacePersistenceModule.readWorkspaceOwnership
    >
  ) => mockReadWorkspaceOwnership(...args),
  writeWorkspaceConfig: jest.fn(
    (workspaceId: string, config: WorkspaceConfigFile) => {
      mockWorkspaceConfigs.set(workspaceId, config);
      return Promise.resolve();
    },
  ),
}));
let mockWorkspaceContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string } = { kind: 'personal' };
const mockStartOrgDefaultCoworkProvisioning = jest.fn<
  ReturnType<typeof OrgCoworkBindingDeps.startOrgDefaultCoworkProvisioning>,
  Parameters<typeof OrgCoworkBindingDeps.startOrgDefaultCoworkProvisioning>
>(() => Promise.resolve());
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: () => ({
    getState: () => ({ context: mockWorkspaceContext }),
  }),
}));
jest.mock('../lib/org-cowork-binding-deps', () => ({
  startOrgDefaultCoworkProvisioning: (
    ...args: Parameters<
      typeof OrgCoworkBindingDeps.startOrgDefaultCoworkProvisioning
    >
  ) => mockStartOrgDefaultCoworkProvisioning(...args),
}));
function mockSidebarItemsFile(): {
  version: 1;
  items: SidebarItem[];
  warnings?: {
    code: 'workspace-load-failed';
    workspaceId: string;
    workspaceName: string;
    reason: string;
  }[];
} {
  return {
    version: 1,
    items: mockSidebarItems,
    ...(mockFailedCoworkWorkspaceId
      ? {
          warnings: [
            {
              code: 'workspace-load-failed',
              workspaceId: mockFailedCoworkWorkspaceId,
              workspaceName: 'Failed Cowork',
              reason: 'transient failure',
            },
          ],
        }
      : {}),
  };
}
jest.mock('../lib/sidebar-items', () => ({
  getWorkspaceIndexRepository: () => ({
    read: () =>
      Promise.resolve({ entries: mockIndexEntries(), authority: 'ok' }),
    update: async <T>(
      change: (snapshot: {
        entries: WorkspaceIndexEntry[];
        authority: 'ok';
      }) =>
        | { result: T; entries?: WorkspaceIndexEntry[] }
        | Promise<{ result: T; entries?: WorkspaceIndexEntry[] }>,
    ) => {
      const result = await change({
        entries: mockIndexEntries(),
        authority: 'ok',
      });
      if (result.entries) mockIndexCommit(result.entries);
      return result.result;
    },
  }),
  readAllSidebarItems: jest.fn(() => Promise.resolve(mockSidebarItemsFile())),
  readAllSidebarItemsSnapshot: jest.fn(() =>
    Promise.resolve({
      file: mockSidebarItemsFile(),
      authority: mockFailedCoworkWorkspaceId ? 'partial' : 'ok',
      indexAuthority: 'ok',
    }),
  ),
  readWorkspaceIndexEntry: jest.fn((workspaceId: string) => {
    const item = mockSidebarItems.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (item) {
      return Promise.resolve({
        id: item.id,
        name: item.name,
        type: item.type,
        color: item.color,
        collapsed: item.collapsed,
        order: item.order,
      });
    }
    return Promise.resolve(
      workspaceId === mockFailedCoworkWorkspaceId
        ? {
            id: workspaceId,
            name: 'Failed Cowork',
            type: 'cowork',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
          }
        : null,
    );
  }),
  writeAllSidebarItems: jest.fn((items: SidebarItem[]) => {
    mockSidebarItems = items;
    return Promise.resolve({ version: 1, items });
  }),
}));

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  SidebarItem,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
} from '@canopy/desktop-shared/types';
import {
  getCoworkManagedDir,
  getCoworkManagedSubdir,
} from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { withArchivedWorkspaceOperationLock } from '../lib/archived-containers';
import { touchAllWorkspaceTargets } from '../lib/workspace-activity';
import { createWorkEntry } from '../lib/cowork-work-entries';
import { writeAllSidebarItems } from '../lib/sidebar-items';
import { sendToAllWindows } from '../lib/window-send';
import { writeWorkspaceConfig } from '../lib/workspace-persistence';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  getChatProjectProjectFilePath,
  getStandaloneChatDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHomeDir,
} from '../lib/paths';
import { readThroughProjectPluginDefaults } from '../plugins/project-plugin-defaults-cache';
import {
  createCoworkWorkspace,
  deleteCoworkWorkspace,
  discardStagedOrgCoworkWorkspace,
  ensureDefaultCoworkWorkspace,
  listCoworkTemplateInstallsForBackfill,
  listCoworkWorkspacesAsChatProjects,
  publishOrgCoworkWorkspace,
  setCoworkWorkspaceTemplateInstallMetadata,
  stageOrgCoworkWorkspace,
  updateCoworkWorkspace,
} from '../lib/cowork-workspace-crud';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';

const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
const mockedWithArchivedWorkspaceOperationLock = jest.mocked(
  withArchivedWorkspaceOperationLock,
);
const mockedTouchAllWorkspaceTargets = jest.mocked(touchAllWorkspaceTargets);

function coworkItem(overrides: Partial<CoworkSidebarItem>): CoworkSidebarItem {
  return {
    id: 'alpha',
    name: 'Alpha',
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

/** The caller's index commit, as `deleteWorkspace` passes it. */
function indexRemoval(workspaceId: string): {
  commitIndexRemoval: jest.Mock<Promise<void>, []>;
} {
  return {
    commitIndexRemoval: jest.fn(() => {
      mockIndexCommit(
        mockIndexEntries().filter((entry) => entry.id !== workspaceId),
      );
      return Promise.resolve();
    }),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  mockWorkspaceConfigs.clear();
  mockPublishedWithoutConfig.clear();
  mockIndexCommit.mockClear();
  mockFailedCoworkWorkspaceId = null;
});

describe('deleteCoworkWorkspace (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSidebarItems = [];
    mockFailedCoworkWorkspaceId = null;
    mockFailedCoworkWorkspaceId = null;
    mockedCleanupPersistedWorktreeData.mockResolvedValue([]);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-cowork-delete-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('fully removes the metadata tree for a managed project, purges worktree data, and drops the index entry', async () => {
    const kept = coworkItem({ id: 'kept', name: 'Kept' });
    const managed = coworkItem({ id: 'managed-one', name: 'Managed' });
    mockSidebarItems = [kept, managed];

    const workspaceDir = getWorkspaceDir('managed-one');
    await mkdir(path.join(workspaceDir, 'home'), { recursive: true });
    await writeFile(
      path.join(workspaceDir, 'home', 'CLAUDE.md'),
      '# hi',
      'utf8',
    );
    await mkdir(path.join(workspaceDir, 'chats'), { recursive: true });
    await writeFile(
      path.join(workspaceDir, 'chats', 'home.json'),
      '{}',
      'utf8',
    );

    const removal = indexRemoval('managed-one');
    await deleteCoworkWorkspace('managed-one', removal);

    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'managed-one',
      COWORK_HOME_WORKTREE_ID,
      { deferLocalWatcherCancellationCommit: true },
    );
    expect(removal.commitIndexRemoval).toHaveBeenCalledTimes(1);
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    // The caller, `deleteWorkspace`, owns the project's watcher lifecycle.
    expect(mockCancelLocalWorkspace).not.toHaveBeenCalled();
    expect(mockCommitLocalWorkspaceCancellation).not.toHaveBeenCalled();
    expect(mockReleaseLocalWorkspaceFence).not.toHaveBeenCalled();
    expect(await pathExists(workspaceDir)).toBe(false);
    expect(mockSidebarItems.map((item) => item.id)).toEqual(['kept']);
  });

  it('drops the cached plugin defaults of the deleted project', async () => {
    mockSidebarItems = [coworkItem({ id: 'managed-cached', name: 'Cached' })];
    await mkdir(path.join(getWorkspaceDir('managed-cached'), 'home'), {
      recursive: true,
    });
    const configPath = getWorkspaceConfigPath('managed-cached');
    await readThroughProjectPluginDefaults(configPath, () =>
      Promise.resolve({
        defaults: {
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plug-a' }],
          },
        },
        cacheable: true,
      }),
    );

    await deleteCoworkWorkspace(
      'managed-cached',
      indexRemoval('managed-cached'),
    );

    const reload = jest.fn(() =>
      Promise.resolve({ defaults: {}, cacheable: true }),
    );
    expect(await readThroughProjectPluginDefaults(configPath, reload)).toEqual(
      {},
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('detaches an external project: removes Canopy metadata and the index entry, but never touches the folder or its managed subfolder', async () => {
    const kept = coworkItem({ id: 'kept-2', name: 'Kept' });
    const externalFolder = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-external-folder-'),
    );

    try {
      const managedDir = getCoworkManagedDir(externalFolder);
      await mkdir(managedDir, { recursive: true });
      await writeFile(
        path.join(managedDir, 'artifacts-index.json'),
        '{}',
        'utf8',
      );
      await writeFile(
        path.join(externalFolder, 'notes.txt'),
        'keep me',
        'utf8',
      );

      const external = coworkItem({
        id: 'ext-one',
        name: 'External',
        externalPath: externalFolder,
      });
      mockSidebarItems = [kept, external];

      const workspaceDir = getWorkspaceDir('ext-one');
      await mkdir(path.join(workspaceDir, 'chats'), { recursive: true });
      await writeFile(
        path.join(workspaceDir, 'chats', 'home.json'),
        '{}',
        'utf8',
      );

      await deleteCoworkWorkspace('ext-one', indexRemoval('ext-one'));

      expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
        'ext-one',
        COWORK_HOME_WORKTREE_ID,
        { deferLocalWatcherCancellationCommit: true },
      );
      // Canopy-side metadata tree and index entry are gone.
      expect(await pathExists(workspaceDir)).toBe(false);
      expect(mockSidebarItems.map((item) => item.id)).toEqual(['kept-2']);

      // The external folder and its lazily-created `.{brand}/` managed
      // subfolder must survive detach untouched.
      expect(await pathExists(externalFolder)).toBe(true);
      await expect(
        readFile(path.join(externalFolder, 'notes.txt'), 'utf8'),
      ).resolves.toBe('keep me');
      expect(await pathExists(managedDir)).toBe(true);
      await expect(
        readFile(path.join(managedDir, 'artifacts-index.json'), 'utf8'),
      ).resolves.toBe('{}');
    } finally {
      await rm(externalFolder, { recursive: true, force: true });
    }
  });

  it('leaves other projects intact after a managed delete and an external detach', async () => {
    const managedKept = coworkItem({
      id: 'managed-kept',
      name: 'Managed Kept',
    });
    const externalKept = coworkItem({
      id: 'external-kept',
      name: 'External Kept',
      externalPath: path.join(os.tmpdir(), 'unrelated-external-folder'),
    });
    const managedGone = coworkItem({
      id: 'managed-gone',
      name: 'Managed Gone',
    });
    mockSidebarItems = [managedKept, externalKept, managedGone];

    await mkdir(getWorkspaceDir('managed-kept'), { recursive: true });
    await mkdir(getWorkspaceDir('external-kept'), { recursive: true });
    await mkdir(getWorkspaceDir('managed-gone'), { recursive: true });

    await deleteCoworkWorkspace('managed-gone', indexRemoval('managed-gone'));

    expect(mockSidebarItems.map((item) => item.id).sort()).toEqual(
      ['external-kept', 'managed-kept'].sort(),
    );
    expect(await pathExists(getWorkspaceDir('managed-kept'))).toBe(true);
    expect(await pathExists(getWorkspaceDir('external-kept'))).toBe(true);
    expect(await pathExists(getWorkspaceDir('managed-gone'))).toBe(false);
  });

  it('deletes a cowork project whose full configuration failed to load', async () => {
    const kept = coworkItem({ id: 'kept', name: 'Kept' });
    mockSidebarItems = [kept];
    mockFailedCoworkWorkspaceId = 'failed-cowork';
    const workspaceDir = getWorkspaceDir('failed-cowork');
    await mkdir(path.join(workspaceDir, 'home'), { recursive: true });

    await deleteCoworkWorkspace('failed-cowork', indexRemoval('failed-cowork'));

    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'failed-cowork',
      COWORK_HOME_WORKTREE_ID,
      { deferLocalWatcherCancellationCommit: true },
    );
    expect(await pathExists(workspaceDir)).toBe(false);
    expect(mockSidebarItems.map((item) => item.id)).toEqual(['kept']);
  });

  it('rejects deleting the default cowork project without touching disk or the index', async () => {
    mockSidebarItems = [coworkItem({ id: DEFAULT_COWORK_WORKSPACE_ID })];

    const removal = indexRemoval(DEFAULT_COWORK_WORKSPACE_ID);
    await expect(
      deleteCoworkWorkspace(DEFAULT_COWORK_WORKSPACE_ID, removal),
    ).rejects.toThrow('The Chats project cannot be deleted');

    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removal.commitIndexRemoval).not.toHaveBeenCalled();
    expect(mockSidebarItems).toHaveLength(1);
  });

  it('throws when the project does not exist', async () => {
    mockSidebarItems = [];

    const removal = indexRemoval('missing');
    await expect(deleteCoworkWorkspace('missing', removal)).rejects.toThrow(
      'Chat project not found',
    );
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removal.commitIndexRemoval).not.toHaveBeenCalled();
  });

  it('reactivates registry writes and keeps the directory when the index commit fails', async () => {
    const workspaceId = 'delete-rollback';
    mockSidebarItems = [coworkItem({ id: workspaceId, name: 'Rollback' })];
    await mkdir(getWorkspaceDir(workspaceId), { recursive: true });
    const removal = indexRemoval(workspaceId);
    removal.commitIndexRemoval.mockRejectedValueOnce(
      new Error('index commit failed'),
    );

    await expect(deleteCoworkWorkspace(workspaceId, removal)).rejects.toThrow(
      'index commit failed',
    );

    await expect(
      createWorkEntry(workspaceId, { title: 'Still writable' }),
    ).resolves.toMatchObject({ entry: { title: 'Still writable' } });
    expect(await pathExists(getWorkspaceDir(workspaceId))).toBe(true);
    expect(mockSidebarItems.map((item) => item.id)).toEqual([workspaceId]);
    expect(mockReleaseLocalWorkspaceFence).not.toHaveBeenCalled();
  });

  // The project fence itself (cancel, release on failure, retain after
  // removal) is `deleteWorkspace`'s; see workspace-deletion.test.ts.
  it('defers every entry watcher commit to the outer project deletion', async () => {
    const workspaceId = 'deferred-watcher-delete';
    mockSidebarItems = [coworkItem({ id: workspaceId })];
    await mkdir(getWorkspaceDir(workspaceId), { recursive: true });
    await createWorkEntry(workspaceId, { title: 'First entry' });
    await createWorkEntry(workspaceId, { title: 'Second entry' });
    const removal = indexRemoval(workspaceId);
    removal.commitIndexRemoval.mockRejectedValueOnce(
      new Error('index commit failed'),
    );

    await expect(deleteCoworkWorkspace(workspaceId, removal)).rejects.toThrow(
      'index commit failed',
    );

    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledTimes(3);
    for (const [, , options] of mockedCleanupPersistedWorktreeData.mock.calls) {
      expect(options).toEqual({ deferLocalWatcherCancellationCommit: true });
    }
  });
});

describe('project template install subscriptions', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  const mockedRecordInstall = jest.mocked(recordSharedItemInstall);
  const mockedRecordUninstall = jest.mocked(recordSharedItemUninstall);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSidebarItems = [];
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-cowork-template-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers a template install once its metadata is recorded', async () => {
    mockSidebarItems = [coworkItem({ id: 'installed', name: 'Installed' })];
    await setCoworkWorkspaceTemplateInstallMetadata('installed', {
      externalId: 'template-share-a',
      contentHash: 'template-hash',
    });
    expect(mockedRecordInstall).toHaveBeenCalledWith({
      kind: 'workspace-template',
      remoteId: 'template-share-a',
      sourceKind: 'shared',
      contentHash: 'template-hash',
      localId: 'installed',
    });
  });

  it('does not register a template install whose metadata write failed', async () => {
    await expect(
      setCoworkWorkspaceTemplateInstallMetadata('missing', {
        externalId: 'template-share-a',
        contentHash: 'template-hash',
      }),
    ).rejects.toThrow('not found');
    expect(mockedRecordInstall).not.toHaveBeenCalled();
  });

  it('unregisters an installed project when it is deleted', async () => {
    mockSidebarItems = [
      coworkItem({
        id: 'installed',
        name: 'Installed',
        installedFromTemplateExternalId: 'template-share-a',
        installedFromTemplateContentHash: 'template-hash',
      }),
      coworkItem({ id: 'local', name: 'Local', order: 1 }),
    ];
    await deleteCoworkWorkspace('local', indexRemoval('local'));
    expect(mockedRecordUninstall).not.toHaveBeenCalled();
    await deleteCoworkWorkspace('installed', indexRemoval('installed'));
    expect(mockedRecordUninstall).toHaveBeenCalledWith({
      kind: 'workspace-template',
      remoteId: 'template-share-a',
      sourceKind: 'shared',
      localId: 'installed',
    });
  });

  it('does not unregister a project whose removal failed', async () => {
    mockSidebarItems = [
      coworkItem({
        id: 'installed',
        name: 'Installed',
        installedFromTemplateExternalId: 'template-share-a',
      }),
    ];
    const removal = indexRemoval('installed');
    removal.commitIndexRemoval.mockRejectedValueOnce(new Error('disk full'));
    await expect(deleteCoworkWorkspace('installed', removal)).rejects.toThrow(
      'disk full',
    );
    expect(mockedRecordUninstall).not.toHaveBeenCalled();
  });

  it('lists installed projects, with the hash only when one is stored', async () => {
    mockSidebarItems = [
      coworkItem({
        id: 'hashed',
        installedFromTemplateExternalId: 'template-a',
        installedFromTemplateContentHash: 'hash-a',
      }),
      coworkItem({
        id: 'pending',
        order: 1,
        installedFromTemplateExternalId: 'template-b',
      }),
      coworkItem({ id: 'local', order: 2 }),
    ];
    await expect(listCoworkTemplateInstallsForBackfill()).resolves.toEqual([
      {
        workspaceId: 'hashed',
        externalId: 'template-a',
        contentHash: 'hash-a',
      },
      { workspaceId: 'pending', externalId: 'template-b', contentHash: null },
    ]);
  });
});

describe('createCoworkWorkspace (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSidebarItems = [];
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-cowork-create-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates the initial cowork project named for the Chats section', async () => {
    await expect(listCoworkWorkspacesAsChatProjects()).resolves.toEqual([
      expect.objectContaining({
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Chats',
      }),
    ]);
  });

  it('scaffolds the managed home directory without creating a legacy standalone-chat artifact', async () => {
    const project = await createCoworkWorkspace(
      'My New Project',
      '2026-01-01T00:00:00.000Z',
    );

    const homeDir = getWorkspaceHomeDir(project.id);
    expect(await pathExists(path.join(homeDir, 'CLAUDE.md'))).toBe(true);
    expect(await pathExists(getCoworkManagedSubdir(homeDir, 'notes'))).toBe(
      true,
    );

    // A newly created cowork workspace has no legacy on-disk counterpart, so
    // no `standalone-chat/{id}/project.json` artifact should ever appear.
    expect(await pathExists(getStandaloneChatDir())).toBe(false);
    expect(await pathExists(getChatProjectProjectFilePath(project.id))).toBe(
      false,
    );
  });

  it('does not reuse an id reserved by a project that failed to load', async () => {
    mockFailedCoworkWorkspaceId = 'failed-cowork';

    const project = await createCoworkWorkspace(
      'Failed Cowork',
      '2026-01-01T00:00:00.000Z',
    );

    expect(project.id).toBe('failed-cowork-2');
    expect(await pathExists(getWorkspaceDir('failed-cowork'))).toBe(false);
    expect(await pathExists(getWorkspaceDir('failed-cowork-2'))).toBe(true);
  });

  it('does not recreate the default project while its config is unavailable', async () => {
    mockFailedCoworkWorkspaceId = DEFAULT_COWORK_WORKSPACE_ID;

    const projects = await listCoworkWorkspacesAsChatProjects();

    expect(projects).toEqual([
      expect.objectContaining({
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Failed Cowork',
      }),
    ]);
    expect(await pathExists(getWorkspaceDir(DEFAULT_COWORK_WORKSPACE_ID))).toBe(
      false,
    );
  });

  it('persists and reads back Always show for cowork projects', async () => {
    mockSidebarItems = [coworkItem({ alwaysShow: true })];

    await updateCoworkWorkspace({
      projectId: 'alpha',
      alwaysShow: false,
    });

    expect(mockSidebarItems[0]).toMatchObject({
      id: 'alpha',
      alwaysShow: false,
    });
    await expect(listCoworkWorkspacesAsChatProjects()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'alpha', alwaysShow: false }),
      ]),
    );
  });

  it('sets and clears the cowork start page', async () => {
    mockSidebarItems = [coworkItem({ cowork: {} })];

    await updateCoworkWorkspace({
      projectId: 'alpha',
      startPage: { kind: 'file', path: 'README.md' },
    });
    expect(mockSidebarItems[0]).toMatchObject({
      cowork: { startPage: { kind: 'file', path: 'README.md' } },
    });
    await expect(listCoworkWorkspacesAsChatProjects()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'alpha',
          startPage: { kind: 'file', path: 'README.md' },
        }),
      ]),
    );

    await updateCoworkWorkspace({ projectId: 'alpha', startPage: null });
    const updatedItem = mockSidebarItems[0];
    if (!updatedItem || !('cowork' in updatedItem))
      throw new Error('Expected the updated cowork workspace');
    expect(updatedItem.cowork).not.toHaveProperty('startPage');
  });

  it('rejects an invalid cowork start page', async () => {
    mockSidebarItems = [coworkItem({ cowork: {} })];
    await expect(
      updateCoworkWorkspace({
        projectId: 'alpha',
        startPage: { kind: 'file', path: '../secret' },
      }),
    ).rejects.toThrow('Invalid start page');
  });

  it('serializes enabling Auto Delete and its activity baseline', async () => {
    mockSidebarItems = [coworkItem({})];

    await updateCoworkWorkspace({
      projectId: 'alpha',
      autoArchiveDays: 7,
    });

    expect(mockedWithArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      'alpha',
      expect.any(Function),
    );
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(mockedTouchAllWorkspaceTargets).toHaveBeenCalledWith('alpha');
  });

  it('merges a settings update from state re-read inside the workspace lock', async () => {
    mockSidebarItems = [coworkItem({ cowork: { description: 'original' } })];
    mockedWithArchivedWorkspaceOperationLock.mockImplementationOnce(
      async (_workspaceId, operation) => {
        mockSidebarItems = [
          coworkItem({
            color: '#123456',
            cowork: { description: 'concurrent update' },
          }),
        ];
        return operation();
      },
    );

    await updateCoworkWorkspace({
      projectId: 'alpha',
      autoArchiveDays: 7,
    });

    expect(mockSidebarItems[0]).toMatchObject({
      color: '#123456',
      cowork: {
        description: 'concurrent update',
        autoArchiveDays: 7,
      },
    });
  });

  it('does not publish Cowork Auto Delete enablement when baseline seeding fails', async () => {
    mockSidebarItems = [coworkItem({})];
    mockedTouchAllWorkspaceTargets.mockRejectedValueOnce(
      new Error('baseline failed'),
    );

    await expect(
      updateCoworkWorkspace({ projectId: 'alpha', autoArchiveDays: 7 }),
    ).rejects.toThrow('baseline failed');

    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
  });
});

describe('listCoworkWorkspacesAsChatProjects', () => {
  beforeEach(() => {
    mockSidebarItems = [];
    mockWorkspaceConfigs.clear();
    mockFailedCoworkWorkspaceId = null;
    mockWorkspaceContext = { kind: 'personal' };
    mockStartOrgDefaultCoworkProvisioning.mockClear();
    jest.mocked(sendToAllWindows).mockClear();
  });

  it('tells every window about the default Chats workspace it just created', async () => {
    // The renderer's projects store can already hold an index read before
    // this write; the workspace-id event runs its silent full reload so the
    // Chats section does not stay empty until an unrelated reload.
    mockSidebarItems = [];
    jest.mocked(sendToAllWindows).mockClear();
    const projects = await listCoworkWorkspacesAsChatProjects();
    expect(projects.map((project) => project.id)).toEqual(['cowork-default']);
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'cowork-default' },
    );
  });

  it('stays quiet when the default Chats workspace already exists', async () => {
    mockSidebarItems = [
      {
        id: 'cowork-default',
        name: 'Chats',
        type: 'cowork',
        color: '#123456',
        collapsed: false,
        order: 0,
      },
    ];
    jest.mocked(sendToAllWindows).mockClear();
    await listCoworkWorkspacesAsChatProjects();
    expect(sendToAllWindows).not.toHaveBeenCalled();
  });

  it('starts organization default provisioning without awaiting it', async () => {
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockWorkspaceContext = { kind: 'organization', organizationId };

    await listCoworkWorkspacesAsChatProjects();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockStartOrgDefaultCoworkProvisioning).toHaveBeenCalledWith(
      organizationId,
    );
  });

  it('tracks organization default provisioning until it settles', async () => {
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockWorkspaceContext = { kind: 'organization', organizationId };
    let release: (() => void) | undefined;
    let provisioned = false;
    mockStartOrgDefaultCoworkProvisioning.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        provisioned = true;
      }),
    );

    try {
      await listCoworkWorkspacesAsChatProjects();
      let settled = false;
      const settling = settleDetachedWork().then(() => {
        settled = true;
      });
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));

      expect(mockStartOrgDefaultCoworkProvisioning).toHaveBeenCalledWith(
        organizationId,
      );
      expect(settled).toBe(false);
      release?.();
      await settling;
      expect(provisioned).toBe(true);
    } finally {
      release?.();
    }
  });

  it('sorts Personal and organization defaults before ordinary Cowork projects', async () => {
    mockSidebarItems = [
      coworkItem({ id: 'zeta', name: 'A project' }),
      coworkItem({
        id: 'cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Chats',
      }),
      coworkItem({ id: 'cowork-default', name: 'Chats' }),
    ];

    const projects = await listCoworkWorkspacesAsChatProjects();

    expect(projects.slice(0, 2).map((project) => project.id)).toEqual([
      'cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'cowork-default',
    ]);
    expect(projects[2]?.id).toBe('zeta');
  });
});

describe('organization project Cowork staging', () => {
  const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const workspaceId = `cowork-project-${projectId}`;
  const owner = {
    type: 'organization' as const,
    organizationId,
    projectId,
    instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    bindingGeneration: 2,
  };

  beforeEach(() => {
    mockSidebarItems = [];
    mockWorkspaceConfigs.clear();
    mockReadWorkspaceOwnership.mockImplementation((id: string) => {
      const config = mockWorkspaceConfigs.get(id);
      return Promise.resolve(
        config
          ? { authority: 'ok' as const, type: config.type, owner: config.owner }
          : { authority: 'absent' as const },
      );
    });
  });

  it('stages an external folder without writing to it, then publishes idempotently', async () => {
    const externalPath = '/user/project';
    await stageOrgCoworkWorkspace({
      id: workspaceId,
      owner,
      externalPath,
    });
    expect(mockSidebarItems).toEqual([]);
    expect(mockWorkspaceConfigs.get(workspaceId)).toMatchObject({
      type: 'cowork',
      externalPath,
      owner,
    });

    await publishOrgCoworkWorkspace({
      id: workspaceId,
      name: 'Team notes',
      owner,
    });
    await publishOrgCoworkWorkspace({
      id: workspaceId,
      name: 'Team notes',
      owner,
    });

    expect(mockSidebarItems).toHaveLength(1);
    expect(mockSidebarItems[0]).toMatchObject({
      id: workspaceId,
      name: 'Team notes',
      externalPath,
      owner,
    });
  });

  it('updates only the owner when restaging the same project with a newer instance', async () => {
    const newerOwner = {
      ...owner,
      instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      bindingGeneration: 3,
    };
    const coworkMetadata: NonNullable<WorkspaceConfigFile['cowork']> = {
      createdAt: '2026-09-29T00:00:00.000Z',
      archiveRetentionDays: 30,
      description: 'Keep this description',
    };
    // This restage test deliberately preserves the legacy persisted fields.
    Reflect.set(coworkMetadata, 'starterPrompts', ['Keep this prompt']);
    const existingConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'cowork',
      repos: [],
      externalPath: '/user/project',
      cowork: coworkMetadata,
      seededFromBlueprintExternalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      owner,
    };
    Reflect.set(existingConfig, 'defaultPluginSelections', {
      skills: { 'keep-this-skill': true },
      mcpServers: {},
      slashCommands: {},
      subagents: {},
    });
    mockWorkspaceConfigs.set(workspaceId, existingConfig);

    await stageOrgCoworkWorkspace({ id: workspaceId, owner: newerOwner });

    expect(mockWorkspaceConfigs.get(workspaceId)).toEqual({
      ...existingConfig,
      owner: newerOwner,
    });
  });

  it('discards only matching, unpublished metadata', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'org-cowork-stage-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    try {
      await mkdir(getWorkspaceDir(workspaceId), { recursive: true });
      mockWorkspaceConfigs.set(workspaceId, {
        version: 1,
        type: 'cowork',
        repos: [],
        owner,
      });

      await discardStagedOrgCoworkWorkspace(workspaceId, projectId);

      await expect(pathExists(getWorkspaceDir(workspaceId))).resolves.toBe(
        false,
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('organization default Cowork creation', () => {
  const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const workspaceId = `cowork-org-${organizationId}`;
  const owner = {
    type: 'organization' as const,
    organizationId,
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    bindingGeneration: 2,
  };

  beforeEach(() => {
    mockSidebarItems = [];
    mockedWriteAllSidebarItems.mockClear();
    mockedWriteWorkspaceConfig.mockClear();
    mockReadWorkspaceOwnership.mockClear();
    mockReadWorkspaceOwnership.mockResolvedValue({ authority: 'absent' });
  });

  it('writes the owner before appending the Chats index entry and is idempotent', async () => {
    const created = await ensureDefaultCoworkWorkspace([], [], {
      id: workspaceId,
      owner,
    });

    expect(created).toMatchObject({ id: workspaceId, name: 'Chats', owner });
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ type: 'cowork', owner }),
      { ownership: 'replace' },
    );
    expect(mockedWriteWorkspaceConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mockIndexCommit.mock.invocationCallOrder[0] ?? 0,
    );

    await ensureDefaultCoworkWorkspace([created], [], {
      id: workspaceId,
      owner,
    });
    expect(mockIndexCommit).toHaveBeenCalledTimes(1);
  });

  it('can prepare the owner and scaffold without publishing the index entry', async () => {
    await ensureDefaultCoworkWorkspace(
      [],
      [],
      { id: workspaceId, owner },
      { publishToIndex: false },
    );

    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ type: 'cowork', owner }),
      { ownership: 'replace' },
    );
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
  });

  it('repairs an indexed organization default whose configuration is absent', async () => {
    mockFailedCoworkWorkspaceId = workspaceId;

    const repaired = await ensureDefaultCoworkWorkspace(
      [],
      [workspaceId],
      { id: workspaceId, owner },
      { publishToIndex: false },
    );

    expect(repaired).toMatchObject({
      id: workspaceId,
      name: 'Failed Cowork',
      owner,
    });
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ type: 'cowork', owner }),
      { ownership: 'replace' },
    );
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
  });

  it('reconciles a changed owner before republishing an existing default', async () => {
    const changedOwner = {
      ...owner,
      instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      bindingGeneration: 3,
    };
    const existing = {
      id: workspaceId,
      name: 'Chats',
      type: 'cowork' as const,
      color: '#000000',
      collapsed: false,
      order: 0,
      cowork: {
        createdAt: '2025-01-01T00:00:00.000Z',
        archiveRetentionDays: 7,
      },
      owner,
    };

    mockSidebarItems = [existing];
    const reconciled = await ensureDefaultCoworkWorkspace(
      [existing],
      [],
      { id: workspaceId, owner: changedOwner },
      { publishToIndex: false },
    );

    expect(reconciled.owner).toEqual(changedOwner);
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ owner: changedOwner }),
      { ownership: 'replace' },
    );
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
  });

  it('rejects deleting any organization default', async () => {
    await expect(
      deleteCoworkWorkspace(workspaceId, indexRemoval(workspaceId)),
    ).rejects.toThrow('cannot be deleted');
  });
});
