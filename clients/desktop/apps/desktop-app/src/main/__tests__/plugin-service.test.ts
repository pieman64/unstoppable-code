import * as path from 'path';
import type { NonSharedBuffer } from 'node:buffer';
import type * as NodeUtil from 'node:util';
import type { PluginInstallResponse } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/PluginInstallResponse';
import type { PluginMarketplaceEntry } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/PluginMarketplaceEntry';
import { BRAND } from '@canopy/brand/current';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import type * as AtomicFileModule from '@canopy/desktop-shared/node/lib/atomic-file';

jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  bumpGlobalPluginDefaultsRevision: jest.fn(),
}));

const mockExecFileAsync = jest.fn();
const mockRunClaudeCliProcessOffMain = jest.fn();
const mockGetRemoteHeadCommitSha = jest.fn<
  Promise<string | null>,
  [remoteUrl: string]
>(() => Promise.resolve(null));
let mockMarketplaceLockTail = Promise.resolve();
function runWithMockMarketplaceLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mockMarketplaceLockTail;
  let release!: () => void;
  mockMarketplaceLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(operation).finally(release);
}
const mockWithMarketplaceRefreshLock = jest.fn(runWithMockMarketplaceLock);

jest.mock('fs', () => ({
  copyFileSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  renameSync: jest.fn(),
  rmSync: jest.fn(),
  realpathSync: jest.fn((value: unknown): string => String(value)),
  statSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    mkdtemp: jest.fn(() =>
      Promise.resolve('/mock/data/codex-capability-build-test'),
    ),
    readFile: jest.fn(),
    readdir: jest.fn(),
    rm: jest.fn(() => Promise.resolve()),
    writeFile: jest.fn(),
  },
}));
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('node:util', () => ({
  ...jest.requireActual<typeof NodeUtil>('node:util'),
  promisify: jest.fn(() => mockExecFileAsync),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  get runClaudeCliProcessOffMain(): typeof mockRunClaudeCliProcessOffMain {
    return mockRunClaudeCliProcessOffMain;
  },
}));
jest.mock('../plugins/plugin-scanner', () => ({
  scanPluginDetails: jest.fn(),
}));
jest.mock('../plugins/marketplace-refresh-lock', () => ({
  get withMarketplaceRefreshLock(): typeof mockWithMarketplaceRefreshLock {
    return mockWithMarketplaceRefreshLock;
  },
}));
// Managed-marketplace receipts install through the synchronous atomic writer,
// which the mocked `fs` above does not reach; capture its writes instead.
const mockWriteFileAtomicallySync = jest.fn<
  void,
  [string, string | Uint8Array, unknown?]
>();
jest.mock('@canopy/desktop-shared/node/lib/atomic-file', () => ({
  ...jest.requireActual<typeof AtomicFileModule>(
    '@canopy/desktop-shared/node/lib/atomic-file',
  ),
  get writeFileAtomicallySync(): typeof mockWriteFileAtomicallySync {
    return mockWriteFileAtomicallySync;
  },
}));
jest.mock('../lib/git', () => ({
  cloneRepo: jest.fn(),
  getHeadCommitSha: jest.fn(() => Promise.resolve(null)),
  get getRemoteHeadCommitSha(): typeof mockGetRemoteHeadCommitSha {
    return mockGetRemoteHeadCommitSha;
  },
}));
jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      invalidateRendererPreferencesCache: {
        value: jest.fn(),
        enumerable: true,
      },
      readPreferencesFile: { value: jest.fn(), enumerable: true },
      peekPreferencesLoadError: { value: jest.fn(), enumerable: true },
      updatePreferencesFile: { value: jest.fn(), enumerable: true },
      writePreferencesFile: { value: jest.fn(), enumerable: true },
    },
  );
});
jest.mock('../lib/paths', () => ({
  getBuiltInPluginMarketplacesFilePath: (): string =>
    '/mock/data/built-in-plugin-marketplaces.json',
  getChatProjectChatTabsFilePath: (projectId: string): string =>
    `/mock/data/standalone-chat/projects/${projectId}/chat-tabs.json`,
  getChatProjectHistoryDir: (projectId: string): string =>
    `/mock/data/standalone-chat/projects/${projectId}/history`,
  getChatProjectMetaFilePath: (projectId: string, chatId: string): string =>
    `/mock/data/standalone-chat/projects/${projectId}/history/${chatId}/meta.json`,
  getChatProjectProjectFilePath: (projectId: string): string =>
    `/mock/data/standalone-chat/projects/${projectId}/project.json`,
  getChatProjectsFilePath: (): string =>
    '/mock/data/standalone-chat/projects.json',
  getCuratedPluginsMarketplaceDir: jest.fn(
    () => '/mock/data/curated-plugins/marketplace',
  ),
  getCuratedPluginsSyncLockFilePath: jest.fn(
    () => '/mock/data/curated-plugins/sync-lock.json',
  ),
  getDataDir: jest.fn(() => '/mock/data'),
  getPipelinePluginPreferencesFilePath: (): string =>
    '/mock/data/pipeline-plugin-preferences.json',
  getPluginCacheDir: jest.fn(() => '/mock/data/plugin-cache'),
  getPreferencesFilePath: jest.fn(() => '/mock/data/preferences.json'),
  getWorkspaceChatHistoryMetaFilePath: (
    workspaceId: string,
    chatId: string,
  ): string =>
    `/mock/data/workspaces/${workspaceId}/chat-history/${chatId}/meta.json`,
  getWorkspaceChatHistoryRootDir: (workspaceId: string): string =>
    `/mock/data/workspaces/${workspaceId}/chat-history`,
  getWorkspaceConfigPath: (workspaceId: string): string =>
    `/mock/data/workspaces/${workspaceId}/workspace.json`,
}));
// The manifest repository runs over the mocked `fs` so the prune tests can
// observe and stage `workspace.json` contents.
jest.mock('../lib/workspace-persistence', () => {
  const { createWorkspaceManifestRepository } = jest.requireActual<
    typeof WorkspaceManifestRepositoryModule
  >('../lib/workspace-manifest-repository');
  const mockedFs = jest.requireMock<typeof fs>('fs');
  const repository = createWorkspaceManifestRepository({
    store: {
      read: async (filePath: string): Promise<W5FileRead> => {
        try {
          const raw = await mockedFs.promises.readFile(filePath, 'utf8');
          return { state: 'present', raw: String(raw) };
        } catch {
          return { state: 'absent' };
        }
      },
      remove: (): Promise<void> =>
        Promise.reject(new Error('Pruning never removes manifests')),
      replace: (filePath: string, contents: string): Promise<void> =>
        mockedFs.promises.writeFile(filePath, contents, 'utf8'),
    },
    filePath: (workspaceId: string): string =>
      `/mock/data/workspaces/${workspaceId}/workspace.json`,
    storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
    knownFields: new Set<string>(),
    knownRepoFields: new Set<string>(),
  });
  return {
    getWorkspaceManifestRepository: (): typeof repository => repository,
  };
});
const mockUpdateCompatibilityTab = jest.fn<
  Promise<{ tabsFile: ChatTabsFile; updated: boolean }>,
  [
    ChatScopeKey,
    string,
    (tab: PersistedChatTab) => PersistedChatTab | null,
    string | undefined,
    { metadataOnly?: boolean } | undefined,
  ]
>();
// A plain function: resetAllMocks would clear a jest.fn once any test loads it.
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    updateCompatibilityTab: typeof mockUpdateCompatibilityTab;
  } => ({ updateCompatibilityTab: mockUpdateCompatibilityTab }),
}));
jest.mock('../lib/chat-storage-discovery', () => ({
  chatStorageScopeIds: jest.fn(() => Promise.resolve([])),
  readChatStorageDiscoveryIndex: jest.fn(),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudePluginMarketplaceManifestPath: jest.fn(
    () => '/mock/resources/plugins/.claude-plugin/marketplace.json',
  ),
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledCodexPluginMarketplaceManifestPath: jest.fn(
    () => '/mock/resources/plugins/.agents/plugins/marketplace.json',
  ),
  getBundledPluginsDir: jest.fn(() => '/mock/resources/plugins'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));
jest.mock('../plugins/curated-plugin-sync', () => ({
  getCuratedPluginMarketplaceName: (): string => 'canopy-curated',
  recoverCuratedPluginPromotions: jest.fn(() => Promise.resolve()),
  syncCuratedPlugins: jest.fn(() =>
    Promise.resolve({
      status: 'noop',
      added: [],
      changed: [],
      removed: [],
      errors: [],
    }),
  ),
}));
jest.mock('../plugins/codex-marketplace-service', () => ({
  // Pure path derivation — mirrored rather than stubbed so the install
  // assertions below check a real manifest path, not a sentinel.
  codexMarketplaceManifestPath: (root: string): string =>
    `${root}/.agents/plugins/marketplace.json`,
  addCodexMarketplace: jest.fn(() =>
    Promise.resolve({ accepted: false, error: 'codex unavailable' }),
  ),
  upgradeCodexMarketplace: jest.fn(() =>
    Promise.resolve({ accepted: false, error: 'codex unavailable' }),
  ),
  installCodexPlugin: jest.fn(() => Promise.resolve({})),
  isStructuralCodexMarketplaceFailure: jest.fn(
    (message?: string) =>
      !!message &&
      /(did not contain[^\n]*\.codex-plugin\/plugin\.json|no Codex plugins (?:were )?detected)/i.test(
        message,
      ),
  ),
  readCodexMarketplaceInstallMetadata: jest.fn(() => Promise.resolve(null)),
  removeCodexMarketplace: jest.fn(() =>
    Promise.resolve({ accepted: true, alreadySatisfied: true }),
  ),
  listCodexPlugins: jest.fn(() =>
    Promise.resolve({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    }),
  ),
  resolveCodexPluginInstallRoots: jest.fn(() =>
    Promise.resolve({ locations: [], unresolved: [] }),
  ),
}));
jest.mock('../plugins/codex-plugin-compat', () => ({
  buildCodexQualifiedReferenceMap: jest.fn(() => new Map()),
  ensureCodexCompatibleClaudePlugin: jest.fn(
    (source: {
      marketplaceId: string;
      pluginName: string;
      category: string;
    }) => ({
      cacheDir: `/mock/data/codex-compat/${source.marketplaceId}/${source.pluginName}`,
      pluginName: source.pluginName,
      category: source.category,
      warnings: [],
      freshness: {
        sourceVersion: '1.0.0',
        sourceLastUpdatedAt: '2026-05-01T00:00:00.000Z',
        compatibilityVersion: 3,
      },
      extraEnv: {},
    }),
  ),
  readClaudePluginCompatibilitySource: jest.fn(
    (input: {
      pluginName: string;
      pluginPath: string;
      marketplaceId: string;
      category: string;
    }) => ({
      ...input,
      manifest: null,
      rawManifest: {},
      skills: [],
      commands: [],
      agents: [],
      warnings: [],
      sourceVersion: '1.0.0',
      sourceLastUpdatedAt: '2026-05-01T00:00:00.000Z',
    }),
  ),
}));
jest.mock('../plugins/codex-plugin-materialization-runner', () => ({
  materializeCodexPluginsOffMain: jest.fn(
    (options: {
      plugins: Array<{
        marketplaceId: string;
        pluginName: string;
        category: string;
      }>;
    }) => {
      const plugin = options.plugins[0];
      return Promise.resolve({
        selectedPlugins: plugin
          ? [
              {
                cacheDir: `/mock/data/codex-compat/${plugin.marketplaceId}/${plugin.pluginName}`,
                pluginName: plugin.pluginName,
                category: plugin.category,
                details: {
                  skills: [],
                  agents: [],
                  commands: [],
                  hooks: [],
                  mcpServers: [],
                  lspServers: [],
                  hasReadme: false,
                },
              },
            ]
          : [],
        warnings: [],
      });
    },
  ),
}));

import * as fs from 'fs';
import type { W5FileRead } from '../lib/w5-file-store';
import type * as WorkspaceManifestRepositoryModule from '../lib/workspace-manifest-repository';
import { getWorkspaceManifestRepository } from '../lib/workspace-persistence';
import * as workspacePluginDefaults from '../lib/workspace-plugin-defaults';
import {
  addMarketplace,
  buildCodexCompatDisabledKey,
  flushMarketplaceSelectionPruneForTests,
  installBuiltInPlugin,
  installPlugin,
  loadMarketplaces,
  loadMarketplacesCacheOnly,
  prepareCodexCompatibilityPlugin,
  readComponentContent,
  readClaudeInstalledItemState,
  recordBuiltInPluginInstallError,
  scanManagedMarketplacesFresh,
  refreshMarketplaces,
  removeMarketplace,
  removeInstalledPluginCache,
  pruneSelectionRefsForInstalledItem,
  setClaudeInstalledItemEnabled,
  uninstallClaudeInstalledItem,
  resetBuiltInMarketplaceScanCacheForTests,
  setCodexCompatDisabled,
  syncCuratedPluginsForRefresh,
  updateMarketplace,
} from '../plugins/plugin-service';
import type {
  ChatTabsFile,
  PersistedChatTab,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from '../lib/chat-storage-discovery';
import { cloneRepo, getHeadCommitSha } from '../lib/git';
import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  readPreferencesFile,
  peekPreferencesLoadError,
  updatePreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';
import {
  addCodexMarketplace,
  installCodexPlugin,
  isStructuralCodexMarketplaceFailure,
  listCodexPlugins,
  readCodexMarketplaceInstallMetadata,
  removeCodexMarketplace,
  resolveCodexPluginInstallRoots,
  upgradeCodexMarketplace,
} from '../plugins/codex-marketplace-service';
import {
  buildCodexQualifiedReferenceMap,
  ensureCodexCompatibleClaudePlugin,
  readClaudePluginCompatibilitySource,
} from '../plugins/codex-plugin-compat';
import { materializeCodexPluginsOffMain } from '../plugins/codex-plugin-materialization-runner';
import { syncCuratedPlugins } from '../plugins/curated-plugin-sync';
import { readThroughProjectPluginDefaults } from '../plugins/project-plugin-defaults-cache';
import {
  getGlobalPluginDefaultsRevision,
  getInheritedPluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';
import {
  getCuratedPluginsMarketplaceDir,
  getDataDir,
  getPluginCacheDir,
  getPreferencesFilePath,
} from '../lib/paths';
import {
  getBundledClaudePluginMarketplaceManifestPath,
  getBundledClaudeBinaryPath,
  getBundledCodexPluginMarketplaceManifestPath,
  getBundledPluginsDir,
  getEnhancedEnv,
} from '../pipelines/config-paths';

const chatStorageScopeIdsMock = jest.mocked(chatStorageScopeIds);
const readChatStorageDiscoveryIndexMock = jest.mocked(
  readChatStorageDiscoveryIndex,
);

function mockBufferDirent(
  name: string,
  directory: boolean,
): fs.Dirent<NonSharedBuffer> {
  const dirent: fs.Dirent<NonSharedBuffer> = {
    name: Buffer.from(name),
    parentPath: '',
    isFile: (): boolean => !directory,
    isDirectory: (): boolean => directory,
    isBlockDevice: (): boolean => false,
    isCharacterDevice: (): boolean => false,
    isFIFO: (): boolean => false,
    isSocket: (): boolean => false,
    isSymbolicLink: (): boolean => false,
  };
  // Jest resolves readdir's overloaded mock signature to the buffer variant;
  // these legacy test doubles intentionally keep their runtime string names.
  Reflect.set(dirent, 'name', name);
  Reflect.set(dirent, 'path', '');
  return dirent;
}

type SparseCodexMarketplaceEntry = Omit<
  Partial<PluginMarketplaceEntry>,
  'plugins'
> & {
  name: string;
  plugins: unknown[];
};

/** Keep sparse legacy Codex response fixtures unchanged at this mock boundary. */
function mockCodexMarketplaceEntry(
  entry: SparseCodexMarketplaceEntry,
): PluginMarketplaceEntry {
  return entry as PluginMarketplaceEntry;
}

/** These tests do not exercise the new install-response payload fields. */
function emptyPluginInstallResponse(): PluginInstallResponse {
  return {} as PluginInstallResponse;
}

/** Legacy selections intentionally omit collectionIds and skillRefs. */
function legacyPluginSelections(
  pluginRefs: NonNullable<PersistedChatTab['pluginSelections']>['pluginRefs'],
): NonNullable<PersistedChatTab['pluginSelections']> {
  return { pluginRefs } as NonNullable<PersistedChatTab['pluginSelections']>;
}

const existsSyncMock = jest.mocked(fs.existsSync);
const statSyncMock = jest.mocked(fs.statSync);
const actualFs = jest.requireActual<typeof fs>('fs');
const readFileSyncMock = jest.mocked(fs.readFileSync);
const writeFileSyncMock = jest.mocked(fs.writeFileSync);
const renameSyncMock = jest.mocked(fs.renameSync);
const copyFileSyncMock = jest.mocked(fs.copyFileSync);
const readFileAsyncMock = jest.mocked(fs.promises.readFile);
const readdirAsyncMock = jest.mocked(fs.promises.readdir);
const writeFileAsyncMock = jest.mocked(fs.promises.writeFile);
const cloneRepoMock = jest.mocked(cloneRepo);
const getHeadCommitShaMock = jest.mocked(getHeadCommitSha);
const readPreferencesFileMock = jest.mocked(readPreferencesFile);
const updatePreferencesFileMock = jest.mocked(updatePreferencesFile);
const writePreferencesFileMock = jest.mocked(writePreferencesFile);
const addCodexMarketplaceMock = jest.mocked(addCodexMarketplace);
const installCodexPluginMock = jest.mocked(installCodexPlugin);
const isStructuralCodexMarketplaceFailureMock = jest.mocked(
  isStructuralCodexMarketplaceFailure,
);
const listCodexPluginsMock = jest.mocked(listCodexPlugins);
const readCodexMarketplaceInstallMetadataMock = jest.mocked(
  readCodexMarketplaceInstallMetadata,
);
const removeCodexMarketplaceMock = jest.mocked(removeCodexMarketplace);
const resolveCodexPluginInstallRootsMock = jest.mocked(
  resolveCodexPluginInstallRoots,
);
const upgradeCodexMarketplaceMock = jest.mocked(upgradeCodexMarketplace);
const buildCodexQualifiedReferenceMapMock = jest.mocked(
  buildCodexQualifiedReferenceMap,
);
const ensureCodexCompatibleClaudePluginMock = jest.mocked(
  ensureCodexCompatibleClaudePlugin,
);
const readClaudePluginCompatibilitySourceMock = jest.mocked(
  readClaudePluginCompatibilitySource,
);
const materializeCodexPluginsOffMainMock = jest.mocked(
  materializeCodexPluginsOffMain,
);
const syncCuratedPluginsMock = jest.mocked(syncCuratedPlugins);
const getDataDirMock = jest.mocked(getDataDir);
const getCuratedPluginsMarketplaceDirMock = jest.mocked(
  getCuratedPluginsMarketplaceDir,
);
const getPluginCacheDirMock = jest.mocked(getPluginCacheDir);
const getPreferencesFilePathMock = jest.mocked(getPreferencesFilePath);
const getBundledClaudePluginMarketplaceManifestPathMock = jest.mocked(
  getBundledClaudePluginMarketplaceManifestPath,
);
const getBundledClaudeBinaryPathMock = jest.mocked(getBundledClaudeBinaryPath);
const getBundledCodexPluginMarketplaceManifestPathMock = jest.mocked(
  getBundledCodexPluginMarketplaceManifestPath,
);
const getBundledPluginsDirMock = jest.mocked(getBundledPluginsDir);
const getEnhancedEnvMock = jest.mocked(getEnhancedEnv);

beforeEach(() => {
  jest.resetAllMocks();
  mockMarketplaceLockTail = Promise.resolve();
  mockWithMarketplaceRefreshLock.mockImplementation(runWithMockMarketplaceLock);
  mockExecFileAsync.mockReset();
  mockRunClaudeCliProcessOffMain.mockImplementation(
    (options: {
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    }) =>
      Promise.resolve(
        mockExecFileAsync(options.command, options.args, {
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          env: options.env,
          windowsHide: process.platform === 'win32',
        }) as unknown,
      ),
  );
  resetBuiltInMarketplaceScanCacheForTests();
  syncCuratedPluginsMock.mockResolvedValue({
    status: 'noop',
    added: [],
    changed: [],
    removed: [],
    errors: [],
  });
  // Restore path mocks cleared by resetAllMocks
  getDataDirMock.mockReturnValue('/mock/data');
  getCuratedPluginsMarketplaceDirMock.mockReturnValue(
    '/mock/data/curated-plugins/marketplace',
  );
  getPluginCacheDirMock.mockReturnValue('/mock/data/plugin-cache');
  getPreferencesFilePathMock.mockReturnValue('/mock/data/preferences.json');
  getBundledClaudePluginMarketplaceManifestPathMock.mockReturnValue(
    '/mock/resources/plugins/.claude-plugin/marketplace.json',
  );
  getBundledClaudeBinaryPathMock.mockReturnValue('/mock/claude');
  getBundledCodexPluginMarketplaceManifestPathMock.mockReturnValue(
    '/mock/resources/plugins/.agents/plugins/marketplace.json',
  );
  getBundledPluginsDirMock.mockReturnValue('/mock/resources/plugins');
  getEnhancedEnvMock.mockReturnValue({});
  readFileAsyncMock.mockRejectedValue(new Error('ENOENT'));
  readdirAsyncMock.mockResolvedValue([] as never);
  writeFileAsyncMock.mockResolvedValue(undefined);
  jest
    .mocked(fs.promises.mkdtemp)
    .mockResolvedValue('/mock/data/codex-capability-build-test');
  jest.mocked(fs.promises.rm).mockResolvedValue(undefined);
  materializeCodexPluginsOffMainMock.mockImplementation((options) => {
    const plugin = options.plugins[0];
    return Promise.resolve({
      selectedPlugins: plugin
        ? [
            {
              cacheDir: `/mock/data/codex-compat/${plugin.marketplaceId}/${plugin.pluginName}`,
              pluginName: plugin.pluginName,
              category: plugin.category,
              details: {
                skills: [],
                agents: [],
                commands: [],
                hooks: [],
                mcpServers: [],
                lspServers: [],
                hasReadme: false,
              },
            },
          ]
        : [],
      warnings: [],
    });
  });
  readPreferencesFileMock.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    codexCompatDisabledPlugins: [],
  });
  updatePreferencesFileMock.mockImplementation(async (updater) => ({
    ...DEFAULT_PREFERENCES,
    ...(await updater({
      ...DEFAULT_PREFERENCES,
      codexCompatDisabledPlugins: [],
    })),
  }));
  writePreferencesFileMock.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    codexCompatDisabledPlugins: [],
  });
  addCodexMarketplaceMock.mockResolvedValue({
    accepted: false,
    error: 'codex unavailable',
  });
  installCodexPluginMock.mockResolvedValue(emptyPluginInstallResponse());
  // Kept in sync with the real `isStructuralCodexMarketplaceFailure` in
  // codex-marketplace-service.ts. A drifted copy here silently stops these
  // tests from exercising the classification they exist to cover - it had
  // already fallen behind the `did not report any plugins` branch.
  isStructuralCodexMarketplaceFailureMock.mockImplementation(
    (message?: string) =>
      !!message &&
      /((?:did not contain|missing)[^\n]*\.codex-plugin\/plugin\.json|no Codex plugins (?:were )?detected|did not report any plugins)/i.test(
        message,
      ),
  );
  getHeadCommitShaMock.mockResolvedValue(null);
  mockGetRemoteHeadCommitSha.mockResolvedValue(null);
  readCodexMarketplaceInstallMetadataMock.mockResolvedValue(null);
  upgradeCodexMarketplaceMock.mockResolvedValue({
    accepted: false,
    error: 'codex unavailable',
  });
  removeCodexMarketplaceMock.mockResolvedValue({
    accepted: true,
    alreadySatisfied: true,
  });
  listCodexPluginsMock.mockResolvedValue({
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
  resolveCodexPluginInstallRootsMock.mockResolvedValue({
    locations: [],
    unresolved: [],
  });
  buildCodexQualifiedReferenceMapMock.mockReturnValue(new Map());
  ensureCodexCompatibleClaudePluginMock.mockImplementation(
    (source: {
      marketplaceId: string;
      pluginName: string;
      category: string;
    }) => ({
      cacheDir: `/mock/data/codex-compat/${source.marketplaceId}/${source.pluginName}`,
      pluginName: source.pluginName,
      category: source.category,
      warnings: [],
      freshness: {
        sourceVersion: '1.0.0',
        sourceLastUpdatedAt: '2026-05-01T00:00:00.000Z',
        compatibilityVersion: 3,
      },
      extraEnv: {},
    }),
  );
  readClaudePluginCompatibilitySourceMock.mockImplementation(
    (input: {
      pluginName: string;
      pluginPath: string;
      marketplaceId: string;
      category: string;
    }) => ({
      ...input,
      manifest: null,
      rawManifest: {},
      skills: [],
      commands: [],
      agents: [],
      warnings: [],
      sourceVersion: '1.0.0',
      sourceLastUpdatedAt: '2026-05-01T00:00:00.000Z',
    }),
  );
});

afterEach(async () => {
  await flushMarketplaceSelectionPruneForTests();
});

const CURATED_MARKETPLACE_DIR = '/mock/data/curated-plugins/marketplace';

/**
 * True for reads under the materialized curated marketplace. Fixtures that
 * answer any `.claude-plugin/marketplace.json` read would otherwise serve a
 * phantom curated marketplace as well; tests that want one arm it explicitly
 * with {@link mockCuratedMarketplaceReads}.
 */
function isCuratedMarketplaceRead(filePath: string): boolean {
  return filePath.startsWith(`${CURATED_MARKETPLACE_DIR}/`);
}

/**
 * Runs microtasks until `condition` holds, for assertions about work that is
 * still in flight. Prefer this over a fixed number of `await Promise.resolve()`
 * ticks, which breaks whenever an awaited step is added upstream.
 */
async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function readLastWrittenJson(): unknown {
  const writeCalls = writeFileSyncMock.mock.calls;
  const lastWrite = writeCalls[writeCalls.length - 1];
  expect(lastWrite).toBeDefined();
  if (!lastWrite) {
    throw new Error('Expected plugin cache to be written.');
  }
  const writtenPayload = lastWrite[1];
  if (typeof writtenPayload !== 'string' && !Buffer.isBuffer(writtenPayload)) {
    throw new Error('Expected written plugin cache payload to be text.');
  }
  const parsed: unknown = JSON.parse(writtenPayload.toString());
  return parsed;
}

const CODEX_SECURITY_MARKETPLACE_ROOT = '/mock/codex/.tmp/plugins';
const CODEX_SECURITY_PLUGIN_ROOT = `${CODEX_SECURITY_MARKETPLACE_ROOT}/plugins/codex-security`;

const CODEX_SECURITY_MARKETPLACE_ENTRY = mockCodexMarketplaceEntry({
  name: 'openai-curated',
  path: `${CODEX_SECURITY_MARKETPLACE_ROOT}/.agents/plugins/marketplace.json`,
  interface: { displayName: 'OpenAI Curated' },
  plugins: [
    {
      name: 'codex-security',
      localVersion: '1.0.0',
      installed: true,
      enabled: true,
      interface: {
        displayName: 'Codex Security',
        shortDescription: 'Security review',
        developerName: 'OpenAI',
        category: 'Developer Tools',
      },
      source: { type: 'local' as const, path: CODEX_SECURITY_PLUGIN_ROOT },
    },
  ],
});

function poisonedCodexSecurityMarketplace(
  sourceType?: string,
  sourceUrl = 'openai-curated',
  id = 'openai-curated',
): unknown {
  const resolvedSourceType = arguments.length === 0 ? 'codex' : sourceType;
  return {
    id,
    name: 'OpenAI Curated',
    sourceType: resolvedSourceType,
    sourceUrl,
    installLocation: CODEX_SECURITY_MARKETPLACE_ROOT,
    lastUpdated: '2026-08-20T00:00:00.000Z',
    pluginCount: 0,
    plugins: [],
    validProviders: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '2026-08-20T00:00:00.000Z',
        error: 'Marketplace is available only through Codex.',
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '2026-08-20T00:00:00.000Z',
        marketplaceName: 'openai-curated',
        installLocation: CODEX_SECURITY_MARKETPLACE_ROOT,
        error:
          "marketplace 'openai-curated' is not configured as a Git marketplace",
      },
    },
  };
}

function mockCodexSecurityDiscovery(available = true): void {
  listCodexPluginsMock.mockResolvedValue({
    marketplaces: available ? [CODEX_SECURITY_MARKETPLACE_ENTRY] : [],
    marketplaceLoadErrors: [],
    featuredPluginIds: available ? ['codex-security@openai-curated'] : [],
  });
  resolveCodexPluginInstallRootsMock.mockResolvedValue(
    available
      ? {
          locations: [
            {
              pluginName: 'codex-security',
              marketplaceName: 'openai-curated',
              installRoot: CODEX_SECURITY_PLUGIN_ROOT,
            },
          ],
          unresolved: [],
        }
      : {
          locations: [],
          unresolved: [
            {
              pluginName: 'openai-curated',
              sourceKind: 'local-missing',
              reason:
                'Codex marketplace "openai-curated" was not returned by plugin/list or plugin/installed.',
            },
          ],
        },
  );
}

function mockMarketplaceCache(marketplaces: unknown[]) {
  let cache = {
    version: 2,
    lastRefreshed: '2026-08-20T00:00:00.000Z',
    marketplaces,
  };
  readFileSyncMock.mockImplementation((target) => {
    const filePath = String(target);
    if (filePath.endsWith('plugins-cache.json')) {
      return JSON.stringify(cache);
    }
    if (filePath.endsWith('known_marketplaces.json')) {
      return JSON.stringify({});
    }
    if (filePath.endsWith('.codex-plugin/plugin.json')) {
      return JSON.stringify({
        name: 'codex-security',
        description: 'Security review',
        version: '1.0.0',
        author: { name: 'OpenAI' },
      });
    }
    if (filePath.endsWith('plugin-cache-index.json')) {
      return JSON.stringify({ version: 1, entries: {} });
    }
    throw new Error(`unexpected read: ${filePath}`);
  });
  writeFileSyncMock.mockImplementation((target, value) => {
    if (String(target).endsWith('plugins-cache.json')) {
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
        throw new Error('Expected written plugin cache payload to be text.');
      }
      const parsed: unknown = JSON.parse(value.toString());
      if (
        !isRecord(parsed) ||
        typeof parsed.version !== 'number' ||
        typeof parsed.lastRefreshed !== 'string' ||
        !Array.isArray(parsed.marketplaces)
      ) {
        throw new Error('Expected a valid written plugin cache.');
      }
      cache = {
        version: parsed.version,
        lastRefreshed: parsed.lastRefreshed,
        marketplaces: parsed.marketplaces,
      };
    }
  });
  existsSyncMock.mockImplementation((target) =>
    String(target).endsWith('.codex-plugin/plugin.json'),
  );
  return (): typeof cache => cache;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readFirstWrittenMarketplaceProviderStatus(
  provider: 'claude' | 'codex',
): Record<string, unknown> {
  const written = readLastWrittenJson();
  if (!isRecord(written) || !isUnknownArray(written.marketplaces)) {
    throw new Error('Expected written plugin cache to contain marketplaces.');
  }
  const marketplace = written.marketplaces[0];
  if (!isRecord(marketplace) || !isRecord(marketplace.providerStatus)) {
    throw new Error('Expected written marketplace to contain providerStatus.');
  }
  const status = marketplace.providerStatus[provider];
  if (!isRecord(status)) {
    throw new Error(`Expected written ${provider} provider status.`);
  }
  return status;
}

function dualValidMarketplaceCache(): unknown {
  return {
    version: 2,
    lastRefreshed: '2026-05-01T00:00:00.000Z',
    marketplaces: [
      {
        id: 'acme/plugins',
        name: 'Acme',
        sourceType: 'github',
        sourceUrl: 'https://github.com/acme/plugins',
        installLocation: '/mock/claude/acme',
        pluginCount: 1,
        plugins: [
          {
            name: 'shared',
            sourcePath: 'plugins/shared',
            marketplaceId: 'acme/plugins',
            providerSupport: { claude: 'native', codex: 'native' },
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: 'shared',
                installLocation: '/mock/claude/acme/plugins/shared',
                sourcePath: 'plugins/shared',
              },
              codex: {
                provider: 'codex',
                mode: 'native',
                name: 'shared',
                installLocation: '/mock/codex/shared',
                sourcePath: '/mock/codex/shared',
              },
            },
          },
        ],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-05-01T00:00:00.000Z',
            marketplaceName: 'acme',
            installLocation: '/mock/claude/acme',
          },
          codex: {
            provider: 'codex',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-05-01T00:00:00.000Z',
            marketplaceName: 'acme',
            installLocation: '/mock/codex/acme',
          },
        },
        validProviders: ['claude', 'codex'],
      },
    ],
  };
}

test('cache reads retain a parked Codex installation without claiming provider convergence', async () => {
  readFileSyncMock.mockImplementation((file) => {
    if (String(file).endsWith('plugins-cache.json'))
      return JSON.stringify(dualValidMarketplaceCache());
    throw new Error('ENOENT');
  });
  readPreferencesFileMock.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    parkedCodexPlugins: [
      {
        key: JSON.stringify(['v1', 'plugin', 'acme/plugins', 'shared']),
        pluginId: 'actual-id',
        pluginName: 'shared',
        marketplacePath: '/mock/marketplace',
        remoteMarketplaceName: null,
        state: 'parked',
      },
    ],
  });
  const result = await loadMarketplacesCacheOnly();
  expect(result.data?.marketplaces[0]?.plugins[0]).toMatchObject({
    parked: true,
  });
  readPreferencesFileMock.mockResolvedValue(DEFAULT_PREFERENCES);
  expect(
    (await loadMarketplacesCacheOnly()).data?.marketplaces[0]?.plugins[0]
      .parked,
  ).toBeUndefined();
});

describe('marketplace commands', () => {
  function mockBuiltInMarketplaceReads(
    options: {
      knownMarketplaces?: unknown;
      builtInProviderLedger?: unknown;
      claudeInstalledPlugins?: unknown;
      claudeSettings?: unknown;
      /** Directories that exist, such as a recorded install folder. */
      existingPaths?: readonly string[];
      /** Paths that exist as regular files rather than directories. */
      existingFiles?: readonly string[];
    } = {},
  ): void {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (
        options.claudeInstalledPlugins !== undefined &&
        filePath.endsWith('installed_plugins.json')
      ) {
        return JSON.stringify(options.claudeInstalledPlugins);
      }
      if (
        options.claudeSettings !== undefined &&
        filePath.endsWith(`${path.sep}settings.json`)
      ) {
        return JSON.stringify(options.claudeSettings);
      }
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      if (
        filePath === '/mock/resources/plugins/.claude-plugin/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [{ name: 'built-in', source: './claude-plugins/built-in' }],
        });
      }
      if (
        filePath === '/mock/resources/plugins/.agents/plugins/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [
            {
              name: 'built-in',
              source: { source: 'local', path: './codex-plugins/built-in' },
            },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({
          name: 'built-in',
          version: '1.0.0',
          description: 'Built in',
        });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({
          name: 'built-in',
          version: '1.0.0',
          description: 'Built in',
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify(options.knownMarketplaces ?? {});
      }
      if (filePath.endsWith('built-in-plugin-marketplaces.json')) {
        return JSON.stringify(
          options.builtInProviderLedger ?? { version: 1, entries: [] },
        );
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      return (
        options.existingPaths?.includes(filePath) === true ||
        options.existingFiles?.includes(filePath) === true ||
        (filePath.startsWith('/mock/resources/plugins') &&
          !filePath.endsWith('installed_plugins.json') &&
          !filePath.endsWith('settings.json'))
      );
    });
    statSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (options.existingPaths?.includes(filePath))
        return actualFs.statSync(__dirname);
      if (options.existingFiles?.includes(filePath))
        return actualFs.statSync(__filename);
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    });
  }

  it('injects the built-in marketplace during load without provider registration calls', async () => {
    mockBuiltInMarketplaceReads();

    const result = await loadMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'builtin/app',
      builtIn: true,
      removable: false,
      sourceType: 'builtin',
      sourceUrl: 'builtin:app',
      pluginCount: 1,
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(listCodexPluginsMock).toHaveBeenCalledTimes(1);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('loads deferred-tool marketplaces from cache only without refreshing when cache is absent', async () => {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('preferences.json')) {
        return JSON.stringify(DEFAULT_PREFERENCES);
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await loadMarketplacesCacheOnly();

    expect(result).toEqual({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '',
        marketplaces: [],
      },
    });
    expect(listCodexPluginsMock).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('normalizes stale invalid Codex cache facets that were marked accepted', async () => {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-09-09T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/acme',
              pluginCount: 0,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-09-09T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: true,
                  pluginCount: 0,
                  lastCheckedAt: '2026-09-09T00:00:00.000Z',
                },
              },
              validProviders: ['claude', 'codex'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await loadMarketplacesCacheOnly();

    expect(result.data?.marketplaces[0]?.providerStatus.codex.accepted).toBe(
      false,
    );
    expect(result.data?.marketplaces[0]?.validProviders).toEqual(['claude']);
  });

  it('refreshes cached built-in marketplaces from bundled manifests without provider registration calls', async () => {
    mockBuiltInMarketplaceReads();
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'builtin/app',
              name: 'Stale Built-In',
              sourceType: 'builtin',
              sourceUrl: 'builtin:app',
              installLocation: '/old/resources/plugins',
              pluginCount: 0,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                },
                codex: { provider: 'codex', state: 'invalid', accepted: false },
              },
              validProviders: [],
            },
          ],
        });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      if (
        filePath === '/mock/resources/plugins/.claude-plugin/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [{ name: 'built-in', source: './claude-plugins/built-in' }],
        });
      }
      if (
        filePath === '/mock/resources/plugins/.agents/plugins/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [
            {
              name: 'built-in',
              source: { source: 'local', path: './codex-plugins/built-in' },
            },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'built-in', version: '1.0.0' });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'built-in', version: '1.0.0' });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces).toHaveLength(1);
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'builtin/app',
      installLocation: '/mock/resources/plugins',
      builtIn: true,
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
  });

  it('does not surface a second row when known_marketplaces.json already lists the built-in marketplace by name', async () => {
    mockBuiltInMarketplaceReads({
      knownMarketplaces: {
        'canopy-plugins': {
          source: { source: 'directory', path: '/mock/resources/plugins' },
          installLocation: '/mock/resources/plugins',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
    ]);
    // The managed registration only receives its periodic nudge; nothing is
    // added or removed.
    expect(
      mockExecFileAsync.mock.calls.map((call: unknown[]): unknown => call[1]),
    ).toEqual([['plugin', 'marketplace', 'update', 'canopy-plugins']]);
  });

  it('still surfaces a known_marketplaces entry that reuses the built-in name but points at a different, real location', async () => {
    mockBuiltInMarketplaceReads({
      knownMarketplaces: {
        'canopy-plugins': {
          source: { source: 'directory', path: '/mock/external/clone' },
          installLocation: '/mock/external/clone',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
    });
    const baseReadFileSync = readFileSyncMock.getMockImplementation();
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath === '/mock/external/clone/.claude-plugin/marketplace.json') {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [{ name: 'clone-plugin', source: './clone-plugin' }],
        });
      }
      return baseReadFileSync?.(target) ?? actualFs.readFileSync(target);
    });
    const baseExistsSync = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.startsWith('/mock/external/clone')) {
        return true;
      }
      return baseExistsSync?.(target) ?? false;
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    // A distinct, real location keeps its own row alongside the built-in
    // one instead of being silently dropped just because it shares the
    // built-in marketplace's reserved name.
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'canopy-plugins',
      'builtin/app',
    ]);
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'canopy-plugins',
      pluginCount: 1,
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'update', 'canopy-plugins'],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it('rejects removing the built-in marketplace', async () => {
    const result = await removeMarketplace('builtin/app');

    expect(result).toEqual({
      success: false,
      error: `The built-in marketplace cannot be removed from ${BRAND.displayName}.`,
    });
  });

  it('drops a stale Codex-only marketplace when both providers are already absent', async () => {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-07-10T20:48:51.506Z',
          marketplaces: [
            {
              id: 'canopy-chat-plugins',
              name: 'canopy-chat-plugins',
              description: '',
              sourceType: 'codex',
              sourceUrl: 'canopy-chat-plugins',
              installLocation: '',
              pluginCount: 0,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-10T20:48:25.373Z',
                  error: 'Marketplace is available only through Codex.',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-10T20:48:26.395Z',
                  error:
                    'marketplace `canopy-chat-plugins` is not configured or installed',
                  marketplaceName: 'canopy-chat-plugins',
                },
              },
              validProviders: [],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    mockExecFileAsync.mockRejectedValue(new Error('Marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
      marketplaceName: 'canopy-chat-plugins',
      error: 'marketplace `canopy-chat-plugins` is not configured or installed',
    });

    const result = await removeMarketplace('canopy-chat-plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace).toBeNull();
    expect(result.data?.removedProviders).toEqual(['claude', 'codex']);
    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [],
    });
  });

  it('filters the obsolete internal Codex marketplace from cached loads', async () => {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-07-10T20:48:51.506Z',
          marketplaces: [
            {
              id: 'canopy-chat-plugins',
              name: 'canopy-chat-plugins',
              sourceType: 'codex',
              sourceUrl: 'canopy-chat-plugins',
              installLocation: '',
              pluginCount: 0,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-10T20:48:25.373Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-10T20:48:26.395Z',
                  marketplaceName: 'canopy-chat-plugins',
                },
              },
              validProviders: [],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await loadMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces).toEqual([]);
  });

  it('explicitly installs a built-in plugin into requested providers', async () => {
    mockBuiltInMarketplaceReads();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'canopy-plugins',
      installedRoot: '/mock/codex/canopy-plugins',
    });

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude', 'codex'],
    });

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      [
        'plugin',
        'marketplace',
        'add',
        '/mock/resources/plugins',
        '--scope',
        'user',
      ],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'install', 'built-in@canopy-plugins', '--scope', 'user'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
    expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
      '/mock/resources/plugins',
      expect.any(Object),
    );
    const codexAddOptions = addCodexMarketplaceMock.mock.calls[0]?.[1];
    expect(codexAddOptions?.repairEquivalentSourceConflict).toBe(true);
    expect(typeof codexAddOptions?.repairMissingLocalSourceConflict).toBe(
      'function',
    );
    // Addressed by the on-disk manifest, NOT by `remoteMarketplaceName`: that
    // field names a marketplace served by the remote plugin catalog, so setting
    // it sends the app-server to `chatgpt.com/backend-api/ps/plugins/<name>`,
    // which 404s for a locally managed marketplace.
    expect(installCodexPluginMock).toHaveBeenCalledWith({
      remoteMarketplaceName: null,
      marketplacePath:
        '/mock/resources/plugins/.agents/plugins/marketplace.json',
      pluginName: 'built-in',
    });
  });

  it('keeps a recorded install failure across a marketplace rescan until that provider installs', async () => {
    mockBuiltInMarketplaceReads();
    // Serve back whatever the service last wrote, so a rescan reads the cache
    // the previous write left behind.
    const baseRead = readFileSyncMock.getMockImplementation();
    let cacheText: string | null = null;
    readFileSyncMock.mockImplementation((target, options) =>
      String(target).endsWith('plugins-cache.json') && cacheText !== null
        ? cacheText
        : (baseRead?.(target, options) ??
          actualFs.readFileSync(target, options)),
    );
    writeFileSyncMock.mockImplementation((target, value) => {
      if (!String(target).endsWith('plugins-cache.json')) return;
      if (typeof value !== 'string' && !Buffer.isBuffer(value))
        throw new Error('Expected written plugin cache payload to be text.');
      cacheText = value.toString();
    });
    const cachedClaudeStatus = (): Record<string, unknown> => {
      const cache: unknown = JSON.parse(cacheText ?? 'null');
      if (!isRecord(cache) || !isUnknownArray(cache.marketplaces))
        throw new Error('Expected the plugin cache to be written.');
      const marketplace = cache.marketplaces[0];
      if (!isRecord(marketplace) || !isUnknownArray(marketplace.plugins))
        throw new Error('Expected the built-in marketplace to be cached.');
      const plugin = marketplace.plugins[0];
      if (!isRecord(plugin) || !isRecord(plugin.globalInstallStatus))
        throw new Error('Expected the built-in plugin install status.');
      const claude = plugin.globalInstallStatus.claude;
      if (!isRecord(claude)) throw new Error('Expected the Claude status.');
      return claude;
    };
    const request = { marketplaceId: 'builtin/app', pluginName: 'built-in' };
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'canopy-plugins',
      installedRoot: '/mock/codex/canopy-plugins',
    });
    // A Codex install caches the marketplace; the backfill then records a
    // Claude failure on it.
    await installBuiltInPlugin({ ...request, providers: ['codex'] });
    await recordBuiltInPluginInstallError(
      request,
      'claude',
      'permission denied',
    );
    expect(cachedClaudeStatus()).toMatchObject({
      installed: false,
      installError: 'permission denied',
    });
    // Another Codex install rescans the marketplace: the failure stays.
    await installBuiltInPlugin({ ...request, providers: ['codex'] });
    expect(cachedClaudeStatus()).toMatchObject({
      installed: false,
      installError: 'permission denied',
    });
  });

  it('keeps a recorded install failure when a load is served within the scan memo window', async () => {
    mockBuiltInMarketplaceReads();
    const baseRead = readFileSyncMock.getMockImplementation();
    let cacheText: string | null = null;
    readFileSyncMock.mockImplementation((target, options) =>
      String(target).endsWith('plugins-cache.json') && cacheText !== null
        ? cacheText
        : (baseRead?.(target, options) ??
          actualFs.readFileSync(target, options)),
    );
    writeFileSyncMock.mockImplementation((target, value) => {
      if (!String(target).endsWith('plugins-cache.json')) return;
      if (typeof value !== 'string' && !Buffer.isBuffer(value))
        throw new Error('Expected written plugin cache payload to be text.');
      cacheText = value.toString();
    });
    const cachedClaudeStatus = (): Record<string, unknown> => {
      const cache: unknown = JSON.parse(cacheText ?? 'null');
      if (!isRecord(cache) || !isUnknownArray(cache.marketplaces))
        throw new Error('Expected the plugin cache to be written.');
      const marketplace = cache.marketplaces.find(
        (entry) => isRecord(entry) && entry.id === 'builtin/app',
      );
      if (!isRecord(marketplace) || !isUnknownArray(marketplace.plugins))
        throw new Error('Expected the built-in marketplace to be cached.');
      const plugin = marketplace.plugins[0];
      if (!isRecord(plugin) || !isRecord(plugin.globalInstallStatus))
        throw new Error('Expected the built-in plugin install status.');
      const claude = plugin.globalInstallStatus.claude;
      if (!isRecord(claude)) throw new Error('Expected the Claude status.');
      return claude;
    };
    const request = { marketplaceId: 'builtin/app', pluginName: 'built-in' };
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'canopy-plugins',
      installedRoot: '/mock/codex/canopy-plugins',
    });
    // The install caches the marketplace and fills the scan memo.
    await installBuiltInPlugin({ ...request, providers: ['codex'] });
    await recordBuiltInPluginInstallError(
      request,
      'claude',
      'permission denied',
    );
    // A refresh inside the memo window must not write the pre-record snapshot
    // back over the recorded failure.
    const refreshed = await refreshMarketplaces();
    expect(refreshed.success).toBe(true);
    expect(cachedClaudeStatus()).toMatchObject({
      installed: false,
      installError: 'permission denied',
    });
  });

  it('reads the managed marketplaces fresh, past the scan memo', async () => {
    mockBuiltInMarketplaceReads();
    await loadMarketplaces();
    const scansAfterLoad = listCodexPluginsMock.mock.calls.length;
    // A second load inside the window serves the memo and asks Codex nothing.
    await loadMarketplaces();
    expect(listCodexPluginsMock.mock.calls.length).toBe(scansAfterLoad);
    const fresh = await scanManagedMarketplacesFresh();
    expect(listCodexPluginsMock.mock.calls.length).toBeGreaterThan(
      scansAfterLoad,
    );
    expect(fresh.map((marketplace) => marketplace.id)).toContain('builtin/app');
  });

  const claudeInstallPath =
    '/mock/claude/plugins/cache/canopy-plugins/built-in/1.0.0';
  const claudeInstallFile = '/mock/claude/plugins/cache/built-in.zip';
  const claudeUserInstall = {
    version: 2,
    plugins: {
      'built-in@canopy-plugins': [
        { scope: 'user', installPath: claudeInstallPath, version: '1.0.0' },
      ],
    },
  };

  it('reports a Claude install from the plugins map Claude Code records', async () => {
    mockBuiltInMarketplaceReads({
      claudeInstalledPlugins: claudeUserInstall,
      existingPaths: [claudeInstallPath],
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.plugin.globalInstallStatus?.claude).toMatchObject({
      available: true,
      installed: true,
      enabled: true,
      installPath: claudeInstallPath,
    });
  });

  it('reports a Claude install that settings disable as installed and disabled', async () => {
    mockBuiltInMarketplaceReads({
      claudeInstalledPlugins: claudeUserInstall,
      claudeSettings: { enabledPlugins: { 'built-in@canopy-plugins': false } },
      existingPaths: [claudeInstallPath],
    });

    const result = await loadMarketplaces();

    expect(
      result.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude,
    ).toMatchObject({ installed: true, enabled: false });
  });

  it('confirms a Claude install the CLI reports as already installed', async () => {
    mockBuiltInMarketplaceReads({
      claudeInstalledPlugins: claudeUserInstall,
      existingPaths: [claudeInstallPath],
    });
    mockExecFileAsync.mockImplementation((_binary, args) =>
      Array.isArray(args) && args.includes('install')
        ? Promise.reject(
            new Error('Plugin "built-in@canopy-plugins" is already installed'),
          )
        : Promise.resolve({ stdout: '', stderr: '' }),
    );

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.providerOutcomes.claude).toEqual({ installed: true });
  });

  it('reports a Claude install recorded without a scope', async () => {
    mockBuiltInMarketplaceReads({
      claudeInstalledPlugins: {
        version: 1,
        plugins: {
          'built-in@canopy-plugins': { installPath: claudeInstallPath },
        },
      },
      existingPaths: [claudeInstallPath],
    });

    const result = await loadMarketplaces();

    expect(
      result.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude,
    ).toMatchObject({ installed: true, installPath: claudeInstallPath });
  });

  it.each([
    {
      name: 'an install whose folder is gone',
      installedPlugins: {
        version: 2,
        plugins: {
          'built-in@canopy-plugins': [
            { scope: 'user', installPath: '/mock/claude/missing/1.0.0' },
          ],
        },
      },
    },
    {
      name: 'a key outside the plugins map',
      installedPlugins: {
        'built-in@canopy-plugins': [
          { scope: 'user', installPath: claudeInstallPath },
        ],
      },
    },
    {
      name: 'a project install in another repository',
      installedPlugins: {
        version: 2,
        plugins: {
          'built-in@canopy-plugins': [
            {
              scope: 'project',
              projectPath: '/mock/other-repo',
              installPath: claudeInstallPath,
            },
          ],
        },
      },
    },
    {
      name: 'a local install in another repository',
      installedPlugins: {
        version: 2,
        plugins: {
          'built-in@canopy-plugins': [
            {
              scope: 'local',
              projectPath: '/mock/other-repo',
              installPath: claudeInstallPath,
            },
          ],
        },
      },
    },
    {
      name: 'an install path that is a file',
      installedPlugins: {
        version: 2,
        plugins: {
          'built-in@canopy-plugins': [
            { scope: 'user', installPath: claudeInstallFile },
          ],
        },
      },
    },
  ])(
    'does not report a Claude install for $name',
    async ({ installedPlugins }): Promise<void> => {
      mockBuiltInMarketplaceReads({
        claudeInstalledPlugins: installedPlugins,
        existingPaths: [claudeInstallPath],
        existingFiles: [claudeInstallFile],
      });

      const result = await loadMarketplaces();

      expect(result.success).toBe(true);
      expect(
        result.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude,
      ).toEqual({ available: true, installed: false, version: '1.0.0' });
    },
  );

  it('reports a Codex load failure of the managed marketplace as a status-read error, not as "not installed"', async () => {
    mockBuiltInMarketplaceReads();
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [
        {
          marketplacePath:
            '/mock/resources/plugins/.agents/plugins/marketplace.json',
          message: 'marketplace.json could not be parsed',
        },
      ],
      featuredPluginIds: [],
    });
    const failed = await loadMarketplaces();
    expect(
      failed.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.codex,
    ).toMatchObject({
      available: true,
      installed: false,
      error: 'marketplace.json could not be parsed',
    });
    // Another marketplace failing to load says nothing about this one.
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [
        {
          marketplacePath: '/mock/codex/acme/.agents/plugins/marketplace.json',
          message: 'broken',
        },
      ],
      featuredPluginIds: [],
    });
    const unrelated = await scanManagedMarketplacesFresh();
    expect(
      unrelated.find((marketplace) => marketplace.id === 'builtin/app')
        ?.plugins[0]?.globalInstallStatus?.codex,
    ).toEqual({ available: true, installed: false, version: '1.0.0' });
  });

  it('reports an unreadable Claude installed-plugins file as a status-read error, not as "not installed"', async () => {
    mockBuiltInMarketplaceReads();
    // The file is there but its read fails (the reads mock throws for it).
    const baseExists = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation(
      (target) =>
        String(target).endsWith('installed_plugins.json') ||
        baseExists?.(target) === true,
    );
    const result = await loadMarketplaces();
    const claude =
      result.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude;
    expect(claude).toMatchObject({ available: true, installed: false });
    expect(claude?.error).toContain('installed_plugins.json');
  });

  it('reports an unreadable Claude settings file as a status-read error on an installed plugin, with enabled unknown', async () => {
    mockBuiltInMarketplaceReads({
      claudeInstalledPlugins: claudeUserInstall,
      existingPaths: [claudeInstallPath],
    });
    const baseExists = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation(
      (target) =>
        String(target).endsWith(`${path.sep}settings.json`) ||
        baseExists?.(target) === true,
    );
    const result = await loadMarketplaces();
    const claude =
      result.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude;
    expect(claude).toMatchObject({
      installed: true,
      installPath: claudeInstallPath,
    });
    expect(claude?.enabled).toBeUndefined();
    expect(claude?.error).toContain('settings.json');
  });

  it('rejects malformed built-in install requests before dereferencing payload fields', async () => {
    const progress = jest.fn();

    const result = await installBuiltInPlugin(null as never, progress);

    expect(result).toEqual({
      success: false,
      error: 'Invalid built-in plugin install request.',
    });
    expect(progress).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('rejects built-in Claude install when a same-named missing marketplace was not registered by Canopy', async () => {
    mockBuiltInMarketplaceReads({
      knownMarketplaces: {
        'canopy-plugins': {
          source: { source: 'directory', path: '/old/resources/plugins' },
          installLocation: '/old/resources/plugins',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(false);
    expect(result.data?.providerOutcomes.claude).toEqual({
      installed: false,
      error: `Claude marketplace "canopy-plugins" already exists with a missing different source that ${BRAND.displayName} did not previously register. Remove it from Claude or choose another marketplace name.`,
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('repairs built-in Claude install when the missing marketplace source was previously registered by Canopy', async () => {
    mockBuiltInMarketplaceReads({
      knownMarketplaces: {
        'canopy-plugins': {
          source: { source: 'directory', path: '/old/resources/plugins' },
          installLocation: '/old/resources/plugins',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
      builtInProviderLedger: {
        version: 1,
        entries: [
          {
            provider: 'claude',
            marketplaceName: 'canopy-plugins',
            sourceRoot: '/old/resources/plugins',
            brandId: 'canopy',
            recordedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.providerOutcomes.claude).toEqual({
      installed: true,
    });
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      '/mock/claude',
      ['plugin', 'marketplace', 'remove', 'canopy-plugins'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      '/mock/claude',
      [
        'plugin',
        'marketplace',
        'add',
        '/mock/resources/plugins',
        '--scope',
        'user',
      ],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      3,
      '/mock/claude',
      ['plugin', 'install', 'built-in@canopy-plugins', '--scope', 'user'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
  });

  it('reports a brand-parameterized error when Claude reports already registered but known_marketplaces.json has no matching entry', async () => {
    mockBuiltInMarketplaceReads();
    mockExecFileAsync.mockRejectedValue(new Error('already registered'));

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(false);
    expect(result.data?.providerOutcomes.claude).toEqual({
      installed: false,
      error:
        'Claude marketplace "canopy-plugins" is already registered, but Canopy could not verify that it points at the managed marketplace. Remove it from Claude or choose another marketplace name.',
    });
  });

  it('stops retrying when a repaired Claude marketplace still reports already registered', async () => {
    mockBuiltInMarketplaceReads({
      knownMarketplaces: {
        'canopy-plugins': {
          source: { source: 'directory', path: '/old/resources/plugins' },
          installLocation: '/old/resources/plugins',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
      builtInProviderLedger: {
        version: 1,
        entries: [
          {
            provider: 'claude',
            marketplaceName: 'canopy-plugins',
            sourceRoot: '/old/resources/plugins',
            brandId: 'canopy',
            recordedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    });
    mockExecFileAsync.mockImplementation((_binary, args) => {
      if (Array.isArray(args) && args.includes('remove')) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (Array.isArray(args) && args.includes('add')) {
        return Promise.reject(new Error('already registered'));
      }
      return Promise.reject(new Error(`unexpected args: ${String(args)}`));
    });

    const result = await installBuiltInPlugin({
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
      providers: ['claude'],
    });

    expect(result.success).toBe(false);
    expect(result.data?.providerOutcomes.claude).toEqual({
      installed: false,
      error:
        'The "canopy-plugins" marketplace could not be re-registered after repair.',
    });
    expect(
      mockExecFileAsync.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args.includes('add'),
      ),
    ).toHaveLength(2);
  });

  describe('managed-marketplace receipts', () => {
    const LEDGER_PATH = '/mock/data/built-in-plugin-marketplaces.json';
    const LAST_UPDATED = '2026-05-01T00:00:00.000Z';
    // The managed name follows the build's brand, and recorded roots are
    // resolved (`C:\mock\...` on Windows).
    const MANAGED_NAME = `${BRAND.internalName}-plugins`;
    const RECORDED_MANAGED_ROOT = path.resolve('/mock/resources/plugins');
    const movedRootRegistration = {
      [MANAGED_NAME]: {
        source: { source: 'directory', path: '/old/resources/plugins' },
        installLocation: '/old/resources/plugins',
        lastUpdated: LAST_UPDATED,
      },
    };
    const managedRootRegistration = {
      [MANAGED_NAME]: {
        source: { source: 'directory', path: '/mock/resources/plugins' },
        installLocation: '/mock/resources/plugins',
        lastUpdated: LAST_UPDATED,
      },
    };
    const movedRootReceipt = {
      provider: 'claude',
      marketplaceName: MANAGED_NAME,
      sourceRoot: '/old/resources/plugins',
      brandId: 'canopy',
      recordedAt: LAST_UPDATED,
    };
    const builtInRequest = {
      marketplaceId: 'builtin/app',
      pluginName: 'built-in',
    };

    // The shared reads, matched on `/` paths: on Windows the app joins plugin
    // manifest paths with backslashes.
    function mockReceiptReads(
      options?: Parameters<typeof mockBuiltInMarketplaceReads>[0],
    ): void {
      mockBuiltInMarketplaceReads(options);
      const baseRead = readFileSyncMock.getMockImplementation();
      if (!baseRead) throw new Error('Receipt read mock is not initialized');
      readFileSyncMock.mockImplementation((target, encoding) =>
        baseRead(String(target).replaceAll('\\', '/'), encoding),
      );
    }

    function failLedgerWrites(): void {
      const fail = (target: unknown): void => {
        if (String(target) === LEDGER_PATH) throw new Error('disk full');
      };
      writeFileSyncMock.mockImplementation(fail);
      mockWriteFileAtomicallySync.mockImplementation(fail);
    }

    /** Every ledger payload written, through either writer, in call order. */
    function ledgerWrites(): unknown[] {
      return [
        ...writeFileSyncMock.mock.calls,
        ...mockWriteFileAtomicallySync.mock.calls,
      ].flatMap(([target, data]): unknown[] =>
        String(target) === LEDGER_PATH && typeof data === 'string'
          ? [JSON.parse(data)]
          : [],
      );
    }

    function claudeUpdateCalls(marketplaceName: string): unknown[] {
      return mockExecFileAsync.mock.calls.filter(
        ([, args]) =>
          JSON.stringify(args) ===
          JSON.stringify(['plugin', 'marketplace', 'update', marketplaceName]),
      );
    }

    it('keeps refreshing when the receipt ledger holds a null entry', async () => {
      mockReceiptReads({
        knownMarketplaces: movedRootRegistration,
        builtInProviderLedger: {
          version: 1,
          entries: [null, movedRootReceipt],
        },
      });

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      // The receipt still identifies the moved registration as the managed one.
      expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
        'builtin/app',
      ]);
    });

    it('repairs a moved Claude registration when the receipt ledger holds a null entry', async () => {
      mockReceiptReads({
        knownMarketplaces: movedRootRegistration,
        builtInProviderLedger: {
          version: 1,
          entries: [null, movedRootReceipt],
        },
      });
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await installBuiltInPlugin({
        ...builtInRequest,
        providers: ['claude'],
      });

      expect(result.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        '/mock/claude',
        ['plugin', 'marketplace', 'remove', MANAGED_NAME],
        expect.anything(),
      );
    });

    it.each([
      ['a new registration', {}],
      ['an existing registration at the managed root', managedRootRegistration],
    ])(
      'keeps a Claude install through %s when its receipt cannot be written',
      async (_case, knownMarketplaces) => {
        mockReceiptReads({ knownMarketplaces });
        failLedgerWrites();
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        const result = await installBuiltInPlugin({
          ...builtInRequest,
          providers: ['claude'],
        });

        expect(result.success).toBe(true);
        expect(result.data?.providerOutcomes.claude).toEqual({
          installed: true,
        });
      },
    );

    it('keeps both provider installs when the Codex receipt cannot be written', async () => {
      mockReceiptReads();
      failLedgerWrites();
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: MANAGED_NAME,
        installedRoot: `/mock/codex/${MANAGED_NAME}`,
      });

      const result = await installBuiltInPlugin({
        ...builtInRequest,
        providers: ['claude', 'codex'],
      });

      expect(result.success).toBe(true);
      expect(result.data?.providerOutcomes).toEqual({
        claude: { installed: true },
        codex: { installed: true },
      });
    });

    it('never overwrites a receipt ledger written by a newer version', async () => {
      mockReceiptReads({
        builtInProviderLedger: { version: 2, entries: [] },
      });
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await installBuiltInPlugin({
        ...builtInRequest,
        providers: ['claude'],
      });

      expect(result.success).toBe(true);
      expect(ledgerWrites()).toEqual([]);
      expect(renameSyncMock).not.toHaveBeenCalled();
    });

    it('copies a damaged receipt ledger aside before recording a receipt', async () => {
      mockReceiptReads();
      const baseRead = readFileSyncMock.getMockImplementation();
      if (!baseRead) throw new Error('Receipt read mock is not initialized');
      readFileSyncMock.mockImplementation((target, options) =>
        String(target) === LEDGER_PATH
          ? '{"version": 1, "entries": ['
          : baseRead(target, options),
      );
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await installBuiltInPlugin({
        ...builtInRequest,
        providers: ['claude'],
      });

      expect(result.success).toBe(true);
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        LEDGER_PATH,
        expect.stringMatching(
          /built-in-plugin-marketplaces\.json\.damaged-\d+$/,
        ),
      );
      // The damaged file stays in place until the replacement renames over it.
      expect(renameSyncMock).not.toHaveBeenCalled();
      expect(ledgerWrites()).toEqual([
        {
          version: 1,
          entries: [
            expect.objectContaining({
              provider: 'claude',
              marketplaceName: MANAGED_NAME,
              sourceRoot: RECORDED_MANAGED_ROOT,
            }),
          ],
        },
      ]);
      expect(copyFileSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
        mockWriteFileAtomicallySync.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('nudges a managed Claude registration that has no receipt and records one', async () => {
      mockReceiptReads({
        knownMarketplaces: managedRootRegistration,
      });
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      expect(claudeUpdateCalls(MANAGED_NAME)).toHaveLength(1);
      expect(ledgerWrites()).toEqual([
        {
          version: 1,
          entries: [
            expect.objectContaining({
              provider: 'claude',
              marketplaceName: MANAGED_NAME,
              sourceRoot: RECORDED_MANAGED_ROOT,
            }),
          ],
        },
      ]);
    });

    it('does not nudge a same-named marketplace registered somewhere else', async () => {
      mockReceiptReads({
        knownMarketplaces: {
          [MANAGED_NAME]: {
            source: { source: 'directory', path: '/elsewhere/canopy-plugins' },
            installLocation: '/elsewhere/canopy-plugins',
            lastUpdated: LAST_UPDATED,
          },
        },
        existingPaths: ['/elsewhere/canopy-plugins'],
        builtInProviderLedger: {
          version: 1,
          entries: [
            {
              ...movedRootReceipt,
              sourceRoot: '/mock/resources/plugins',
            },
          ],
        },
      });
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      // Only the foreign row's own source update; no managed nudge.
      expect(claudeUpdateCalls(MANAGED_NAME)).toHaveLength(1);
      expect(ledgerWrites()).toEqual([]);
    });

    it('records a Codex receipt from the provider list a refresh reads', async () => {
      mockReceiptReads({
        builtInProviderLedger: {
          version: 1,
          entries: [
            {
              ...movedRootReceipt,
              sourceRoot: '/mock/resources/plugins',
            },
          ],
        },
      });
      listCodexPluginsMock.mockResolvedValue({
        marketplaces: [
          {
            name: MANAGED_NAME,
            path: '/mock/resources/plugins/.agents/plugins/marketplace.json',
            interface: null,
            plugins: [],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      expect(ledgerWrites()).toEqual([
        {
          version: 1,
          entries: [
            expect.objectContaining({
              provider: 'claude',
              sourceRoot: '/mock/resources/plugins',
            }),
            expect.objectContaining({
              provider: 'codex',
              marketplaceName: MANAGED_NAME,
              sourceRoot: RECORDED_MANAGED_ROOT,
            }),
          ],
        },
      ]);
      expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('rescans the managed marketplace after an install that failed partway', async () => {
      mockReceiptReads();
      // Fill the scan memo with the pre-install snapshot.
      await loadMarketplaces();
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      addCodexMarketplaceMock.mockRejectedValue(new Error('app-server exited'));

      const failed = await installBuiltInPlugin({
        ...builtInRequest,
        providers: ['claude', 'codex'],
      });
      expect(failed.success).toBe(false);

      // Claude kept the plugin installed before Codex failed.
      const managedInstallPath = `/mock/claude/plugins/cache/${MANAGED_NAME}/built-in/1.0.0`;
      mockReceiptReads({
        claudeInstalledPlugins: {
          version: 2,
          plugins: {
            [`built-in@${MANAGED_NAME}`]: [
              {
                scope: 'user',
                installPath: managedInstallPath,
                version: '1.0.0',
              },
            ],
          },
        },
        existingPaths: [managedInstallPath],
      });
      const loaded = await loadMarketplaces();

      expect(
        loaded.data?.marketplaces[0]?.plugins[0]?.globalInstallStatus?.claude,
      ).toMatchObject({ installed: true });
    });
  });

  it('uses the bundled Claude binary when adding a marketplace', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await addMarketplace('owner/repo');

    expect(result).toEqual({
      success: false,
      error:
        'No Claude or Codex plugins were detected in that repository. Claude: rejected. Codex: rejected (codex unavailable).',
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'add', 'owner/repo'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
  });

  it('uses the bundled Claude binary to add an absent marketplace during update retry', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await updateMarketplace('marketplace-name');

    expect(result.success).toBe(true);
    expect(mockWithMarketplaceRefreshLock).toHaveBeenCalledTimes(1);
    expect(result.data?.id).toBe('marketplace-name');
    expect(result.data?.validProviders).toEqual([]);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'add', 'marketplace-name'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
  });

  it('marks a provider invalid when its update command fails even if stale plugin files remain readable', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('Claude update failed'));
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      marketplaceName: 'acme',
      error: 'Codex update failed',
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              pluginCount: 1,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/claude/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/codex/acme',
                },
              },
              validProviders: ['claude', 'codex'],
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [
            {
              name: 'claude-plugin',
              source: 'plugins/claude-plugin',
            },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'claude-plugin' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await updateMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.validProviders).toEqual([]);
    expect(result.data?.providerStatus.claude).toMatchObject({
      state: 'invalid',
      accepted: false,
      pluginCount: 0,
      error: 'Claude update failed',
    });
    expect(result.data?.providerStatus.codex).toMatchObject({
      state: 'invalid',
      accepted: false,
      error: 'Codex update failed',
    });
  });

  it.each([
    'New Relic',
    '  New Relic ',
    '',
    '   ',
    undefined,
    42,
    { label: 'New Relic' },
  ])(
    'reads the Claude marketplace entry display name %s without persisting a slug transform',
    async (displayName): Promise<void> => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      readFileSyncMock.mockImplementation((target) => {
        const filePath = String(target);
        if (filePath.endsWith('plugins-cache.json')) {
          return JSON.stringify({
            version: 1,
            lastRefreshed: '2026-05-01T00:00:00.000Z',
            marketplaces: [
              {
                id: 'acme/plugins',
                name: 'Acme',
                description: '',
                sourceType: 'github',
                sourceUrl: 'https://github.com/acme/plugins',
                installLocation: '/mock/claude/acme',
                lastUpdated: '2026-05-01T00:00:00.000Z',
                pluginCount: 1,
                plugins: [],
              },
            ],
          });
        }
        if (filePath.endsWith('known_marketplaces.json')) {
          return JSON.stringify({});
        }
        if (isCuratedMarketplaceRead(filePath)) {
          throw new Error(`unexpected read: ${filePath}`);
        }
        if (filePath.endsWith('.claude-plugin/marketplace.json')) {
          return JSON.stringify({
            name: 'Acme',
            plugins: [
              {
                name: 'legacy-plugin',
                displayName,
                source: 'plugins/legacy-plugin',
              },
            ],
          });
        }
        if (filePath.endsWith('.claude-plugin/plugin.json')) {
          return JSON.stringify({ name: 'legacy-plugin' });
        }
        if (filePath.endsWith('plugin-cache-index.json')) {
          return JSON.stringify({ version: 1, entries: {} });
        }
        throw new Error(`unexpected read: ${filePath}`);
      });
      existsSyncMock.mockReturnValue(true);

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      expect(result.data?.marketplaces[0]?.plugins[0]?.displayName).toBe(
        typeof displayName === 'string'
          ? displayName.trim() || undefined
          : undefined,
      );
      expect(result.data?.version).toBe(2);
      expect(result.data?.marketplaces[0]?.id).toBe('acme/plugins');
      expect(result.data?.marketplaces[0]?.plugins[0]?.name).toBe(
        'legacy-plugin',
      );
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        '/mock/claude',
        ['plugin', 'marketplace', 'add', 'https://github.com/acme/plugins'],
        expect.objectContaining({
          timeout: 60_000,
          killSignal: 'SIGKILL',
          env: {},
        }),
      );
    },
  );
  it('migrates version 1 cache sources by revalidating providers instead of dropping cached marketplace ids', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 1,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              description: '',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              lastUpdated: '2026-05-01T00:00:00.000Z',
              pluginCount: 1,
              plugins: [],
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [{ name: 'legacy-plugin', source: 'plugins/legacy-plugin' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'legacy-plugin' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.version).toBe(2);
    expect(result.data?.marketplaces[0]?.id).toBe('acme/plugins');
    expect(result.data?.marketplaces[0]?.plugins[0]?.name).toBe(
      'legacy-plugin',
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'add', 'https://github.com/acme/plugins'],
      expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {},
      }),
    );
  });

  describe('startup provider-update gating', () => {
    function mockRegisteredAcmeReads(options: {
      lastProviderRefreshAt?: string;
      curatedMarketplaceExists?: boolean;
      claudeRegistered?: boolean;
      codexRegistered: boolean;
      codexInstallRevision?: string;
      codexStatus?: Record<string, unknown>;
    }): void {
      readFileSyncMock.mockImplementation((target) => {
        const filePath = String(target);
        if (filePath.endsWith('plugins-cache.json')) {
          return JSON.stringify({
            version: 2,
            lastRefreshed: '2026-05-01T00:00:00.000Z',
            ...(options.lastProviderRefreshAt
              ? { lastProviderRefreshAt: options.lastProviderRefreshAt }
              : {}),
            marketplaces: [
              {
                id: 'acme',
                name: 'Acme',
                sourceType: 'github',
                sourceUrl: 'https://github.com/acme/plugins',
                installLocation: '/mock/claude/acme',
                pluginCount: 1,
                plugins: [],
                providerStatus: {
                  claude: {
                    provider: 'claude',
                    state:
                      options.claudeRegistered === false ? 'invalid' : 'valid',
                    accepted: options.claudeRegistered !== false,
                    pluginCount: options.claudeRegistered === false ? 0 : 1,
                    ...(options.claudeRegistered === false
                      ? {
                          error: 'Marketplace is available only through Codex.',
                        }
                      : { marketplaceName: 'acme' }),
                  },
                  codex:
                    options.codexStatus ??
                    (options.codexRegistered
                      ? {
                          provider: 'codex',
                          state: 'valid',
                          accepted: true,
                          pluginCount: 1,
                          marketplaceName: 'acme',
                          installLocation: '/mock/codex/acme',
                        }
                      : {
                          provider: 'codex',
                          state: 'invalid',
                          accepted: false,
                        }),
                },
                validProviders: [
                  ...(options.claudeRegistered === false ? [] : ['claude']),
                  ...(options.codexRegistered ? ['codex'] : []),
                ],
              },
            ],
          });
        }
        if (filePath.endsWith('known_marketplaces.json')) {
          if (options.claudeRegistered === false) {
            return JSON.stringify({});
          }
          return JSON.stringify({
            acme: {
              source: { source: 'github', repo: 'acme/plugins' },
              installLocation: '/mock/claude/acme',
              lastUpdated: '2026-05-01T00:00:00.000Z',
            },
          });
        }
        if (isCuratedMarketplaceRead(filePath)) {
          throw new Error(`unexpected read: ${filePath}`);
        }
        if (filePath.endsWith('.claude-plugin/marketplace.json')) {
          return JSON.stringify({
            name: 'Acme',
            plugins: [{ name: 'acme-plugin', source: 'plugins/acme-plugin' }],
          });
        }
        if (filePath.endsWith('.claude-plugin/plugin.json')) {
          return JSON.stringify({ name: 'acme-plugin' });
        }
        if (filePath.endsWith('plugin-cache-index.json')) {
          return JSON.stringify({ version: 1, entries: {} });
        }
        if (
          options.codexInstallRevision &&
          filePath.endsWith('.codex-marketplace-install.json')
        ) {
          return JSON.stringify({
            source: 'https://github.com/acme/plugins',
            source_type: 'git',
            revision: options.codexInstallRevision,
          });
        }
        throw new Error(`unexpected read: ${filePath}`);
      });
      existsSyncMock.mockReturnValue(true);
    }

    function isRecordValue(value: unknown): value is Record<string, unknown> {
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    }

    function writtenPluginsCachePayloads(): Array<Record<string, unknown>> {
      const payloads: Array<Record<string, unknown>> = [];
      for (const [filePath, contents] of writeFileSyncMock.mock.calls) {
        if (
          typeof filePath !== 'string' ||
          !filePath.endsWith('plugins-cache.json') ||
          typeof contents !== 'string'
        ) {
          continue;
        }
        const parsed: unknown = JSON.parse(contents);
        if (isRecordValue(parsed)) {
          payloads.push(parsed);
        }
      }
      return payloads;
    }

    it('skips provider update commands for registered marketplaces while the stamp is fresh', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const freshStamp = new Date().toISOString();
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: freshStamp,
        codexRegistered: true,
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'if-stale',
      });

      expect(result.success).toBe(true);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
      // Discovery still rebuilt and persisted the cache, keeping the old
      // stamp instead of minting a new one.
      const payloads = writtenPluginsCachePayloads();
      expect(payloads.length).toBeGreaterThan(0);
      expect(payloads[payloads.length - 1]?.lastProviderRefreshAt).toBe(
        freshStamp,
      );
    });

    it('still registers newly supported providers while the stamp is fresh', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: new Date().toISOString(),
        codexRegistered: false,
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'if-stale',
      });

      expect(result.success).toBe(true);
      // Claude is already registered → no update command. Codex is not →
      // discovery still registers the newly supported provider.
      expect(mockExecFileAsync).not.toHaveBeenCalled();
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
    });

    it('runs provider updates and stamps the cache when the stamp is stale', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: '2026-05-01T00:00:00.000Z',
        codexRegistered: true,
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'if-stale',
      });

      expect(result.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        '/mock/claude',
        ['plugin', 'marketplace', 'update', 'acme'],
        expect.objectContaining({ killSignal: 'SIGKILL' }),
      );
      expect(upgradeCodexMarketplaceMock).toHaveBeenCalled();
      const payloads = writtenPluginsCachePayloads();
      const lastPayload = payloads[payloads.length - 1];
      expect(typeof lastPayload?.lastProviderRefreshAt).toBe('string');
      expect(lastPayload?.lastProviderRefreshAt).not.toBe(
        '2026-05-01T00:00:00.000Z',
      );
    });

    it('default refresh skips provider updates while the stamp is fresh', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: new Date().toISOString(),
        codexRegistered: true,
      });

      const result = await refreshMarketplaces();

      expect(result.success).toBe(true);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('deregisters and records a structurally invalid Codex marketplace revision', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
        error:
          'marketplace did not contain .codex-plugin/plugin.json for any plugin',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).toHaveBeenCalledWith('acme');
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        state: 'invalid',
        accepted: false,
        structurallyInvalidAtRevision: 'revision-one',
      });
    });

    it('deregisters a Codex marketplace that reports zero plugins with a present checkout', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      // Codex listed the marketplace and reported zero plugins for it, with
      // the checkout present. Permanent until the revision moves.
      resolveCodexPluginInstallRootsMock.mockResolvedValue({
        locations: [],
        unresolved: [
          {
            pluginName: 'acme',
            sourceKind: 'local-missing',
            reason: 'Codex marketplace "acme" did not report any plugins.',
          },
        ],
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).toHaveBeenCalledWith('acme');
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        accepted: false,
        structurallyInvalidAtRevision: 'revision-one',
      });
    });

    it('does not deregister a mixed marketplace when any entry is transient', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      // A MIXED set: one genuinely structural entry plus one transient entry.
      // The joined reason string still matches the structural regex - that is
      // the whole point - so only the per-entry `local-incomplete` veto can
      // stop the deregistration. Without the veto this marketplace, which
      // really does support Codex, is deregistered whenever its checkout is
      // mid-clone and stays suppressed until the source revision moves.
      resolveCodexPluginInstallRootsMock.mockResolvedValue({
        locations: [],
        unresolved: [
          {
            pluginName: 'claude-only',
            sourceKind: 'local-missing',
            reason:
              'Local Codex plugin "claude-only" did not contain .codex-plugin/plugin.json at /mock/codex/acme/claude-only.',
          },
          {
            pluginName: 'codex-plugin',
            sourceKind: 'local-incomplete',
            reason:
              'Local Codex plugin "codex-plugin" has no checkout at /mock/codex/acme/codex-plugin yet; the marketplace checkout looks incomplete.',
          },
        ],
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(
        result.data?.marketplaces[0]?.providerStatus.codex
          .structurallyInvalidAtRevision,
      ).toBeUndefined();
    });

    it('does not deregister a marketplace whose only unresolved Codex plugin is git-sourced', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      // One genuinely structural entry plus one git-sourced plugin. A git
      // source resolves no install path, so Canopy cannot tell whether a Codex
      // facet exists - "no evidence" must not read as "no facet". The joined
      // string still matches the structural regex, so only per-entry
      // classification can stop this. Deregistering here would remove plugins
      // from Codex's own state that the marketplace really does supply.
      resolveCodexPluginInstallRootsMock.mockResolvedValue({
        locations: [],
        unresolved: [
          {
            pluginName: 'claude-only',
            sourceKind: 'local-missing',
            reason:
              'Local Codex plugin "claude-only" did not contain .codex-plugin/plugin.json at /mock/codex/acme/claude-only.',
          },
          {
            pluginName: 'git-plugin',
            sourceKind: 'git',
            reason:
              'Codex plugin "git-plugin" uses git source; the app-server protocol does not expose a materialized install path for this source type yet.',
          },
        ],
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(
        result.data?.marketplaces[0]?.providerStatus.codex
          .structurallyInvalidAtRevision,
      ).toBeUndefined();
    });

    it('does not treat two individually non-structural reasons as structural when joined', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      // NEITHER reason matches the structural regex on its own, but the regex
      // body (`[^\n]*`) spans the '; ' separator, so the concatenation does.
      // Classifying the join rather than each entry manufactures a structural
      // verdict out of two non-structural facts.
      resolveCodexPluginInstallRootsMock.mockResolvedValue({
        locations: [],
        unresolved: [
          {
            pluginName: 'alpha',
            sourceKind: 'remote',
            reason: 'Codex plugin "alpha" is missing from the manifest',
          },
          {
            pluginName: 'beta',
            sourceKind: 'remote',
            reason: 'Codex plugin "beta" needs .codex-plugin/plugin.json',
          },
        ],
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('does not deregister a healthy marketplace when the upgrade is a silent no-op', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: true,
        codexInstallRevision: 'revision-one',
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      // `marketplace/upgrade` answered `{ selectedMarketplaces: [], errors: [] }`
      // - the name was simply not selected, and no error was reported - so
      // `upgradeCodexMarketplace` yields `accepted: false, error: undefined`.
      // That says nothing about the marketplace's contents.
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
        error: undefined,
      });
      // The scan found real, manifest-verified Codex plugins. `facets` is
      // still empty because it is gated on `accepted`, and `unresolved` is
      // empty so there is nothing to classify per entry - which is exactly how
      // a healthy marketplace used to reach the deregistration branch through
      // the `'No Codex plugins were detected.'` fallback.
      resolveCodexPluginInstallRootsMock.mockResolvedValue({
        locations: [
          {
            pluginName: 'codex-plugin',
            marketplaceName: 'acme',
            installRoot: '/mock/codex/acme/codex-plugin',
          },
        ],
        unresolved: [],
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(
        result.data?.marketplaces[0]?.providerStatus.codex
          .structurallyInvalidAtRevision,
      ).toBeUndefined();
    });

    it('does not retry a structurally invalid Codex marketplace at the same revision', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: false,
        codexInstallRevision: 'revision-one',
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          installLocation: '/mock/codex/acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
        revision: 'revision-one',
      });
      getHeadCommitShaMock.mockResolvedValue('unrelated-claude-revision');

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('does not compare a stale Claude checkout when provider updates are skipped', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: new Date().toISOString(),
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          installLocation: '/mock/codex/acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      getHeadCommitShaMock.mockResolvedValue('stale-claude-revision');

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'if-stale',
      });

      expect(result.success).toBe(true);
      expect(getHeadCommitShaMock).not.toHaveBeenCalled();
      expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('rechecks a structurally invalid Codex marketplace after its revision changes', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          installLocation: '/mock/codex/acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      getHeadCommitShaMock.mockResolvedValue('revision-two');
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        error: 'Codex marketplace operation timed out after 60s.',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        accepted: false,
        structurallyInvalidAtRevision: 'revision-one',
      });
    });

    it('rechecks a structurally invalid Codex-only marketplace after its remote revision changes', async () => {
      mockRegisteredAcmeReads({
        claudeRegistered: false,
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      mockGetRemoteHeadCommitSha.mockResolvedValue('revision-one');
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        error: 'Codex marketplace operation timed out after 60s.',
      });

      const unchangedResult = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(unchangedResult.success).toBe(true);
      expect(mockGetRemoteHeadCommitSha).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(addCodexMarketplaceMock).not.toHaveBeenCalled();

      mockGetRemoteHeadCommitSha.mockResolvedValue('revision-two');
      const changedResult = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(changedResult.success).toBe(true);
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(
        changedResult.data?.marketplaces[0]?.providerStatus.codex,
      ).toMatchObject({
        accepted: false,
        structurallyInvalidAtRevision: 'revision-one',
      });
    });

    it('preserves structural suppression when the retry scan fails transiently', async () => {
      mockRegisteredAcmeReads({
        claudeRegistered: false,
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      mockGetRemoteHeadCommitSha.mockResolvedValue('revision-two');
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
      });
      listCodexPluginsMock.mockRejectedValue(
        new Error('Codex app-server is unavailable.'),
      );

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        accepted: false,
        error: 'Codex app-server is unavailable.',
        structurallyInvalidAtRevision: 'revision-one',
      });
    });

    it('records the changed revision when Codex remains structurally invalid', async () => {
      mockRegisteredAcmeReads({
        claudeRegistered: false,
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      mockGetRemoteHeadCommitSha.mockResolvedValue('revision-two');
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        error:
          'marketplace did not contain .codex-plugin/plugin.json for any plugin',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).toHaveBeenCalledWith('acme');
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        accepted: false,
        structurallyInvalidAtRevision: 'revision-two',
      });
    });

    it('does not deregister a structural failure when no revision can be recorded', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({ codexRegistered: true });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
      });
      getHeadCommitShaMock.mockResolvedValue(null);
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
        error:
          'marketplace did not contain .codex-plugin/plugin.json for any plugin',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
      expect(
        result.data?.marketplaces[0]?.providerStatus.codex
          .structurallyInvalidAtRevision,
      ).toBeUndefined();
    });

    it('uses the installed checkout revision when Codex metadata omits it', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({ codexRegistered: true });
      readCodexMarketplaceInstallMetadataMock.mockResolvedValue({
        source: 'https://github.com/acme/plugins',
      });
      getHeadCommitShaMock.mockResolvedValue('revision-from-checkout');
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
        error:
          'marketplace did not contain .codex-plugin/plugin.json for any plugin',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(getHeadCommitShaMock).toHaveBeenCalledWith('/mock/codex/acme');
      expect(removeCodexMarketplaceMock).toHaveBeenCalledWith('acme');
      expect(result.data?.marketplaces[0]?.providerStatus.codex).toMatchObject({
        accepted: false,
        structurallyInvalidAtRevision: 'revision-from-checkout',
      });
    });

    it('re-registers a structurally deregistered Codex marketplace on an explicit user retry', async () => {
      // The Plugins page tells the user that "Retry refresh" is the escape
      // hatch for a structurally suppressed Codex facet. Phase B already
      // removed the marketplace from Codex, so `marketplace/upgrade` would
      // target a name Codex no longer knows and could never re-register it.
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          installLocation: '/mock/codex/acme',
          error:
            'Marketplace did not contain .codex-plugin/plugin.json for any plugin.',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      getHeadCommitShaMock.mockResolvedValue('revision-one');

      const result = await updateMarketplace('acme');

      expect(result.success).toBe(true);
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('preserves structural suppression when an explicit re-registration fails transiently', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({
        codexRegistered: false,
        codexStatus: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          marketplaceName: 'acme',
          installLocation: '/mock/codex/acme',
          error:
            'Marketplace did not contain .codex-plugin/plugin.json for any plugin.',
          structurallyInvalidAtRevision: 'revision-one',
        },
      });
      addCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        error: 'Codex marketplace operation timed out after 60s.',
      });

      const result = await updateMarketplace('acme');

      expect(result.success).toBe(true);
      expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
        'https://github.com/acme/plugins',
      );
      expect(result.data?.providerStatus.codex).toMatchObject({
        accepted: false,
        error: 'Codex marketplace operation timed out after 60s.',
        structurallyInvalidAtRevision: 'revision-one',
      });
      expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('keeps retrying transient Codex marketplace failures', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockRegisteredAcmeReads({ codexRegistered: true });
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: false,
        marketplaceName: 'acme',
        installedRoot: '/mock/codex/acme',
        error: 'Codex marketplace operation timed out after 60s.',
      });

      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'always',
      });

      expect(result.success).toBe(true);
      expect(upgradeCodexMarketplaceMock).toHaveBeenCalledWith('acme');
      expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
    });

    it('serializes concurrent provider refreshes', async () => {
      let activeClaudeUpdates = 0;
      let maxConcurrentClaudeUpdates = 0;
      mockExecFileAsync.mockImplementation(async () => {
        activeClaudeUpdates += 1;
        maxConcurrentClaudeUpdates = Math.max(
          maxConcurrentClaudeUpdates,
          activeClaudeUpdates,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeClaudeUpdates -= 1;
        return { stdout: '', stderr: '' };
      });
      mockRegisteredAcmeReads({
        lastProviderRefreshAt: '2026-05-01T00:00:00.000Z',
        codexRegistered: true,
      });

      const [first, second] = await Promise.all([
        refreshMarketplaces(),
        refreshMarketplaces(),
      ]);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(maxConcurrentClaudeUpdates).toBe(1);
    });
  });

  it('preserves compatibility facets written while refresh is rebuilding marketplaces', async () => {
    const marketplacePath =
      '/mock/marketplaces/acme/.claude-plugin/marketplace.json';
    const claudeFacet = {
      provider: 'claude' as const,
      mode: 'native' as const,
      name: 'my-plugin',
      installLocation: '/mock/marketplaces/acme/plugins/my-plugin',
      sourcePath: 'plugins/my-plugin',
      marketplacePath,
    };
    let currentCache: unknown = {
      version: 2,
      lastRefreshed: '2026-05-01T00:00:00.000Z',
      marketplaces: [
        {
          id: 'acme/plugins',
          name: 'Acme',
          sourceType: 'github',
          sourceUrl: 'https://github.com/acme/plugins',
          installLocation: '/mock/marketplaces/acme',
          pluginCount: 1,
          plugins: [
            {
              name: 'my-plugin',
              sourcePath: 'plugins/my-plugin',
              marketplaceId: 'acme/plugins',
              providerSupport: { claude: 'native', codex: 'compat' },
              facets: { claude: claudeFacet },
            },
          ],
          providerStatus: {
            claude: {
              provider: 'claude',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              marketplaceName: 'Acme',
              marketplacePath,
              installLocation: '/mock/marketplaces/acme',
            },
            codex: {
              provider: 'codex',
              state: 'invalid',
              accepted: false,
              pluginCount: 0,
            },
          },
          validProviders: ['claude'],
        },
      ],
    };
    let releaseClaudeAdd: () => void = () => {
      throw new Error('Expected Claude add to be pending.');
    };
    mockExecFileAsync.mockImplementation(
      (): Promise<{ stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          releaseClaudeAdd = (): void => {
            resolve({ stdout: '', stderr: '' });
          };
        }),
    );
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(currentCache);
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          'acme/plugins': {
            source: {
              source: 'github',
              repo: 'https://github.com/acme/plugins',
            },
            installLocation: '/mock/marketplaces/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [{ name: 'my-plugin', source: 'plugins/my-plugin' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'my-plugin' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    writeFileSyncMock.mockImplementation((target, payload) => {
      if (String(target).endsWith('plugins-cache.json')) {
        if (typeof payload !== 'string') {
          throw new Error(
            'Expected plugin cache writes to use string payloads.',
          );
        }
        currentCache = JSON.parse(payload);
      }
    });
    existsSyncMock.mockReturnValue(true);

    const refresh = refreshMarketplaces();
    await flushUntil(() => mockExecFileAsync.mock.calls.length > 0);
    expect(mockExecFileAsync).toHaveBeenCalled();

    jest
      .mocked(fs.promises.rm)
      .mockRejectedValueOnce(new Error('temporary directory is busy'));
    const compatibility = await prepareCodexCompatibilityPlugin(
      'acme/plugins',
      'my-plugin',
    );
    if (!compatibility.success) {
      throw new Error(`Compatibility failed: ${JSON.stringify(compatibility)}`);
    }
    expect(materializeCodexPluginsOffMainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [
          expect.objectContaining({
            pluginName: 'my-plugin',
            includeMcpServers: true,
            scanDetails: true,
          }),
        ],
      }),
    );
    expect(readClaudePluginCompatibilitySourceMock).not.toHaveBeenCalled();

    releaseClaudeAdd();
    const refreshResult = await refresh;

    expect(refreshResult.success).toBe(true);
    expect(
      refreshResult.data?.marketplaces[0]?.plugins[0]?.facets,
    ).toHaveProperty('codexCompatibility');
  });

  it('loads a version 1 cache with a fast best-effort migration instead of revalidating providers', async () => {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 1,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              description: 'Legacy cache',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              lastUpdated: '2026-05-01T00:00:00.000Z',
              pluginCount: 1,
              plugins: [
                {
                  name: 'legacy-plugin',
                  description: 'Legacy plugin',
                  version: '1.0.0',
                  author: 'Acme',
                  category: 'dev',
                  homepage: '',
                  sourcePath: 'plugins/legacy-plugin',
                  marketplaceId: 'acme/plugins',
                  details: null,
                  externalSource: null,
                  cachePath: null,
                  cachedAt: null,
                },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await loadMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.version).toBe(2);
    expect(result.data?.marketplaces[0]?.validProviders).toEqual(['claude']);
    expect(result.data?.marketplaces[0]?.providerStatus.codex.error).toContain(
      'Refresh the marketplace to check Codex',
    );
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [{ id: 'acme/plugins' }],
    });
  });

  it('leaves a version 1 cache untouched when migration revalidation fails for every marketplace', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('offline'));
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 1,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              description: '',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              lastUpdated: '2026-05-01T00:00:00.000Z',
              pluginCount: 1,
              plugins: [],
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(false);

    const result = await refreshMarketplaces();

    expect(result).toEqual({
      success: false,
      error:
        'Unable to migrate the version 1 plugin cache because provider revalidation failed for every marketplace.',
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('refresh retry registers a previously absent Codex provider from the marketplace source URL', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/codex/acme',
    });
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/codex/acme',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'acme',
          path: '/mock/codex/acme/.agents/plugins/marketplace.json',
          plugins: [
            {
              name: 'codex-plugin',
              localVersion: '1.0.0',
              interface: { displayName: 'codex-plugin' },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'codex-plugin',
          marketplaceName: 'acme',
          installRoot: '/mock/codex/plugin',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              pluginCount: 1,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/claude/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  error: 'registration failed',
                },
              },
              validProviders: ['claude'],
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({ name: 'Acme', plugins: [] });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'codex-plugin' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    const resolveCall = resolveCodexPluginInstallRootsMock.mock.calls[0];
    expect(resolveCall?.[0]).toBe('acme');
    expect(resolveCall?.[1]?.installedRoot).toBe('/mock/codex/acme');
    expect(resolveCall?.[1]?.listedMarketplace).toMatchObject({
      name: 'acme',
      path: '/mock/codex/acme/.agents/plugins/marketplace.json',
    });
    expect(addCodexMarketplace).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplace).toHaveBeenCalledWith('acme');
    expect(result.data?.marketplaces[0]?.validProviders).toEqual(['codex']);
  });

  it('rescans a built-in Codex marketplace without requesting a Git upgrade', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      marketplaceName: 'openai-curated',
      error:
        "marketplace 'openai-curated' is not configured as a Git marketplace",
    });
    mockCodexSecurityDiscovery();
    mockMarketplaceCache([]);

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalledWith(
      'openai-curated',
    );
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(resolveCodexPluginInstallRootsMock).toHaveBeenCalledWith(
      'openai-curated',
      expect.objectContaining({
        installedRoot: CODEX_SECURITY_MARKETPLACE_ROOT,
        listedMarketplace: CODEX_SECURITY_MARKETPLACE_ENTRY,
      }),
    );
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'openai-curated',
      pluginCount: 1,
      validProviders: ['codex'],
      plugins: [
        {
          name: 'codex-security',
          facets: { codex: { provider: 'codex', mode: 'native' } },
        },
      ],
      providerStatus: {
        codex: {
          accepted: true,
          state: 'valid',
          marketplaceName: 'openai-curated',
          installLocation: CODEX_SECURITY_MARKETPLACE_ROOT,
          error: undefined,
        },
      },
    });
  });

  it('repairs a poisoned built-in Codex cache on repeated refreshes', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      marketplaceName: 'openai-curated',
      error:
        "marketplace 'openai-curated' is not configured as a Git marketplace",
    });
    mockCodexSecurityDiscovery();
    mockMarketplaceCache([poisonedCodexSecurityMarketplace()]);

    const first = await refreshMarketplaces();
    const second = await refreshMarketplaces();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalledWith(
      'openai-curated',
    );
    for (const result of [first, second]) {
      const marketplace = result.data?.marketplaces.find(
        (entry) => entry.id === 'openai-curated',
      );
      expect(marketplace).toMatchObject({
        pluginCount: 1,
        validProviders: ['codex'],
        plugins: [
          {
            name: 'codex-security',
            facets: { codex: { provider: 'codex', mode: 'native' } },
          },
        ],
        providerStatus: {
          codex: {
            accepted: true,
            state: 'valid',
            error: undefined,
          },
        },
      });
    }
  });

  it('repairs a poisoned built-in Codex cache during manual update', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      marketplaceName: 'openai-curated',
      error:
        "marketplace 'openai-curated' is not configured as a Git marketplace",
    });
    mockCodexSecurityDiscovery();
    const readCacheState = mockMarketplaceCache([
      poisonedCodexSecurityMarketplace(),
    ]);

    const result = await updateMarketplace('openai-curated');

    expect(result.success).toBe(true);
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalledWith(
      'openai-curated',
    );
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(listCodexPluginsMock).toHaveBeenCalled();
    expect(result.data).toMatchObject({
      pluginCount: 1,
      validProviders: ['codex'],
      plugins: [{ name: 'codex-security' }],
      providerStatus: {
        codex: { accepted: true, state: 'valid', error: undefined },
      },
    });
    expect(readCacheState().marketplaces[0]).toMatchObject({
      pluginCount: 1,
      plugins: [{ name: 'codex-security' }],
    });
  });

  it('does not promote a missing built-in Codex marketplace during manual update', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      marketplaceName: 'openai-curated',
      error:
        "marketplace 'openai-curated' is not configured as a Git marketplace",
    });
    mockCodexSecurityDiscovery(false);
    mockMarketplaceCache([poisonedCodexSecurityMarketplace()]);

    const result = await updateMarketplace('openai-curated');

    expect(result.success).toBe(true);
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalledWith(
      'openai-curated',
    );
    expect(result.data).toMatchObject({
      pluginCount: 0,
      plugins: [],
      validProviders: [],
      providerStatus: {
        codex: {
          state: 'invalid',
          pluginCount: 0,
        },
      },
    });
  });

  it.each([
    {
      label: 'Codex built-in source',
      sourceType: 'codex',
      sourceUrl: 'openai-curated',
      upgrades: false,
    },
    {
      label: 'local directory source',
      sourceType: 'local',
      sourceUrl: '/mock/local-marketplace',
      upgrades: false,
    },
    {
      label: 'directory source',
      sourceType: 'directory',
      sourceUrl: '/mock/directory-marketplace',
      upgrades: false,
    },
    {
      label: 'owner/repo source',
      sourceType: 'local',
      sourceUrl: 'owner/repo',
      upgrades: true,
    },
    {
      label: 'github.com source',
      sourceType: 'directory',
      sourceUrl: 'github.com/owner/repo',
      upgrades: true,
    },
    {
      label: 'GitHub URL source',
      sourceType: 'local',
      sourceUrl: 'https://github.com/owner/repo',
      upgrades: true,
    },
    {
      label: 'non-GitHub git source',
      sourceType: 'git',
      sourceUrl: 'ssh://git.example.com/owner/repo.git',
      upgrades: true,
    },
    {
      label: 'unrecognized explicit source type',
      sourceType: 'gitlab',
      sourceUrl: 'ssh://gitlab.example.com/owner/repo.git',
      upgrades: true,
    },
    {
      label: 'missing source type',
      sourceType: undefined,
      sourceUrl: 'ssh://git.example.com/owner/repo.git',
      upgrades: true,
    },
  ])(
    'classifies $label for Codex marketplace upgrades',
    async ({ sourceType, sourceUrl, upgrades }) => {
      upgradeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        marketplaceName: 'openai-curated',
        installedRoot: CODEX_SECURITY_MARKETPLACE_ROOT,
      });
      mockCodexSecurityDiscovery();
      mockMarketplaceCache([
        poisonedCodexSecurityMarketplace(
          sourceType,
          sourceUrl,
          'source-classification',
        ),
      ]);

      const result = await updateMarketplace('source-classification');

      expect(result.success).toBe(true);
      if (upgrades) {
        expect(upgradeCodexMarketplaceMock).toHaveBeenCalledWith(
          'openai-curated',
        );
      } else {
        expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalledWith(
          'openai-curated',
        );
      }
    },
  );

  it('discovers Codex-only marketplaces returned by Codex plugin/list', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'openai-curated',
      installedRoot: '/mock/codex/.tmp/plugins',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'openai-curated',
          path: '/mock/codex/.tmp/plugins/.agents/plugins/marketplace.json',
          interface: { displayName: 'Codex official' },
          plugins: [
            {
              name: 'linear',
              localVersion: '0.0.0',
              interface: {
                displayName: 'Linear',
                shortDescription: 'Track issues',
                developerName: 'OpenAI',
                category: 'Productivity',
                websiteUrl: 'https://linear.app',
                logoUrl: 'https://cdn.example.test/linear-logo.png',
              },
              source: {
                type: 'local',
                path: '/mock/codex/.tmp/plugins/plugins/linear',
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: ['linear@openai-curated'],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'linear',
          marketplaceName: 'openai-curated',
          installRoot: '/mock/codex/.tmp/plugins/plugins/linear',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({
          name: 'linear',
          description: 'Track issues',
          version: '0.0.0',
          author: { name: 'OpenAI' },
          homepage: 'https://linear.app',
        });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    const resolveCall = resolveCodexPluginInstallRootsMock.mock.calls[0];
    expect(resolveCall?.[0]).toBe('openai-curated');
    expect(resolveCall?.[1]?.installedRoot).toBe('/mock/codex/.tmp/plugins');
    expect(resolveCall?.[1]?.listedMarketplace).toMatchObject({
      name: 'openai-curated',
    });
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'openai-curated',
      name: 'Codex official',
      sourceType: 'codex',
      sourceUrl: 'openai-curated',
      validProviders: ['codex'],
      plugins: [
        {
          name: 'linear',
          logoUrl: 'https://cdn.example.test/linear-logo.png',
          providerSupport: { claude: 'none', codex: 'native' },
          facets: {
            codex: {
              provider: 'codex',
              mode: 'native',
              name: 'linear',
              logoUrl: 'https://cdn.example.test/linear-logo.png',
              installLocation: '/mock/codex/.tmp/plugins/plugins/linear',
            },
          },
        },
      ],
      providerStatus: {
        claude: {
          accepted: false,
          error: 'Marketplace is available only through Codex.',
        },
        codex: {
          accepted: true,
          marketplaceName: 'openai-curated',
          installLocation: '/mock/codex/.tmp/plugins',
        },
      },
    });
  });

  it('does not register a source-backed Codex-only marketplace with Claude', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'awesome-codex-plugins',
      installedRoot: '/mock/codex/awesome',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'awesome-codex-plugins',
          path: '/mock/codex/awesome/.agents/plugins/marketplace.json',
          interface: { displayName: 'Awesome Codex Plugins' },
          plugins: [
            {
              name: 'aegis',
              localVersion: '1.0.0',
              interface: { displayName: 'Aegis' },
              source: {
                type: 'local',
                path: '/mock/codex/awesome/plugins/aegis',
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'aegis',
          marketplaceName: 'awesome-codex-plugins',
          installRoot: '/mock/codex/awesome/plugins/aegis',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-08-20T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('.codex-marketplace-install.json')) {
        return JSON.stringify({
          source_type: 'git',
          source:
            'https://github.com/hashgraph-online/awesome-codex-plugins.git',
        });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'aegis' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockImplementation(
      (target) => !String(target).endsWith('.claude-plugin/marketplace.json'),
    );

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'hashgraph-online/awesome-codex-plugins',
      sourceType: 'github',
      validProviders: ['codex'],
      providerStatus: {
        claude: {
          accepted: false,
          error: 'Marketplace is available only through Codex.',
        },
      },
    });
  });

  it('keeps a persisted GitHub-shaped Codex-only marketplace scan-only on refresh', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'awesome-codex-plugins',
      installedRoot: '/mock/codex/awesome',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'awesome-codex-plugins',
          path: '/mock/codex/awesome/.agents/plugins/marketplace.json',
          interface: { displayName: 'Awesome Codex Plugins' },
          plugins: [
            {
              name: 'aegis',
              localVersion: '1.0.0',
              interface: { displayName: 'Aegis' },
              source: {
                type: 'local',
                path: '/mock/codex/awesome/plugins/aegis',
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'aegis',
          marketplaceName: 'awesome-codex-plugins',
          installRoot: '/mock/codex/awesome/plugins/aegis',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-08-20T00:00:00.000Z',
          marketplaces: [
            {
              id: 'hashgraph-online/awesome-codex-plugins',
              name: 'Awesome Codex Plugins',
              sourceType: 'github',
              sourceUrl:
                'https://github.com/hashgraph-online/awesome-codex-plugins',
              pluginCount: 0,
              plugins: [],
              validProviders: ['codex'],
              providerStatus: {
                claude: {
                  accepted: false,
                  error: 'Marketplace is available only through Codex.',
                },
                codex: {
                  accepted: true,
                  marketplaceName: 'awesome-codex-plugins',
                  installLocation: '/mock/codex/awesome',
                },
              },
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('.codex-marketplace-install.json')) {
        return JSON.stringify({
          source_type: 'git',
          source:
            'https://github.com/hashgraph-online/awesome-codex-plugins.git',
        });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'aegis' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockImplementation(
      (target) => !String(target).endsWith('.claude-plugin/marketplace.json'),
    );

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).toHaveBeenCalledWith(
      'awesome-codex-plugins',
    );
    expect(result.data?.marketplaces[0]?.validProviders).toEqual(['codex']);
  });

  it('does not register a persisted GitHub-shaped Codex-only marketplace with Claude during manual update', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'awesome-codex-plugins',
      installedRoot: '/mock/codex/awesome',
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-08-20T00:00:00.000Z',
          marketplaces: [
            {
              id: 'hashgraph-online/awesome-codex-plugins',
              name: 'Awesome Codex Plugins',
              sourceType: 'github',
              sourceUrl:
                'https://github.com/hashgraph-online/awesome-codex-plugins',
              pluginCount: 0,
              plugins: [],
              validProviders: ['codex'],
              providerStatus: {
                claude: {
                  accepted: false,
                  error: 'Marketplace is available only through Codex.',
                },
                codex: {
                  accepted: true,
                  marketplaceName: 'awesome-codex-plugins',
                  installLocation: '/mock/codex/awesome',
                },
              },
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await updateMarketplace(
      'hashgraph-online/awesome-codex-plugins',
    );

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).toHaveBeenCalledWith(
      'awesome-codex-plugins',
    );
  });

  it('does not discover the obsolete internal Codex marketplace as a global marketplace', async () => {
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'canopy-chat-plugins',
          path: '/mock/obsolete/.agents/plugins/marketplace.json',
          interface: { displayName: 'Canopy Chat Plugins' },
          plugins: [
            {
              name: 'ud-git',
              localVersion: '1.0.0',
              interface: { displayName: 'ud-git' },
              source: {
                type: 'local',
                path: '/mock/obsolete/sources/ud-git',
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(resolveCodexPluginInstallRootsMock).not.toHaveBeenCalled();
    expect(result.data?.marketplaces).toEqual([]);
    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [],
    });
  });

  it('keeps owner/repo-shaped Codex-only marketplace names separate from GitHub sources', async () => {
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'openai/curated',
      installedRoot: '/mock/codex/.tmp/plugins',
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'openai/curated',
          path: '/mock/codex/.tmp/plugins/.agents/plugins/marketplace.json',
          interface: { displayName: 'Codex curated' },
          plugins: [
            {
              name: 'linear',
              localVersion: '0.0.0',
              interface: { displayName: 'Linear' },
              source: {
                type: 'local',
                path: '/mock/codex/.tmp/plugins/plugins/linear',
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: ['linear@openai/curated'],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'linear',
          marketplaceName: 'openai/curated',
          installRoot: '/mock/codex/.tmp/plugins/plugins/linear',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          'github-curated': {
            source: { source: 'github', repo: 'openai/curated' },
            installLocation: '/mock/claude/openai-curated',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'GitHub curated',
          plugins: [{ name: 'github-plugin', source: 'plugins/github-plugin' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'github-plugin' });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'linear' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    if (!result.success || !result.data) {
      throw new Error('Expected marketplace refresh to succeed.');
    }
    const externalMarketplaces = result.data.marketplaces.filter(
      (marketplace) => marketplace.id !== 'builtin/app',
    );
    expect(externalMarketplaces).toHaveLength(2);

    const githubMarketplace = externalMarketplaces.find(
      (marketplace) => marketplace.id === 'github-curated',
    );
    expect(githubMarketplace).toMatchObject({
      id: 'github-curated',
      sourceType: 'github',
      sourceUrl: 'https://github.com/openai/curated',
      validProviders: ['claude'],
    });

    const codexMarketplace = externalMarketplaces.find(
      (marketplace) => marketplace.id === 'openai/curated',
    );
    expect(codexMarketplace).toMatchObject({
      id: 'openai/curated',
      name: 'Codex curated',
      sourceType: 'codex',
      sourceUrl: 'openai/curated',
      validProviders: ['codex'],
    });
    expect(codexMarketplace?.providerStatus.claude).toMatchObject({
      accepted: false,
      error: 'Marketplace is available only through Codex.',
    });
    expect(codexMarketplace?.providerStatus.codex).toMatchObject({
      accepted: true,
      marketplaceName: 'openai/curated',
      installLocation: '/mock/codex/.tmp/plugins',
    });
  });

  it('dedupes Codex-discovered Git marketplaces into existing Claude rows', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    upgradeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'superpowers-marketplace',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'superpowers-marketplace',
          path: '/mock/codex/super/.claude-plugin/marketplace.json',
          interface: { displayName: 'Superpowers' },
          plugins: [
            {
              name: 'superpowers',
              localVersion: null,
              interface: { displayName: 'Superpowers' },
              source: {
                type: 'git',
                url: 'https://github.com/obra/superpowers.git',
                path: null,
                refName: null,
                sha: null,
              },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [],
      unresolved: [
        {
          pluginName: 'superpowers',
          sourceKind: 'git',
          reason:
            'Codex plugin "superpowers" uses git source; the app-server protocol does not expose a materialized install path for this source type yet.',
        },
      ],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'obra/superpowers',
              name: 'superpowers-marketplace',
              sourceType: 'git',
              sourceUrl: 'https://github.com/obra/superpowers',
              installLocation: '/mock/codex/super',
              pluginCount: 0,
              plugins: [],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: true,
                  pluginCount: 0,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'superpowers-marketplace',
                  installLocation: '/mock/codex/super',
                },
              },
              validProviders: [],
            },
          ],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          'superpowers-marketplace': {
            source: {
              source: 'git',
              url: 'https://github.com/obra/superpowers.git',
            },
            installLocation: '/mock/claude/super',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (filePath.endsWith('.codex-marketplace-install.json')) {
        return JSON.stringify({
          source_type: 'git',
          source: 'https://github.com/obra/superpowers.git',
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Superpowers',
          plugins: [{ name: 'superpowers', source: 'plugins/superpowers' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'superpowers' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    const externalMarketplaces = result.data?.marketplaces.filter(
      (marketplace) => marketplace.id !== 'builtin/app',
    );
    expect(externalMarketplaces).toHaveLength(1);
    expect(externalMarketplaces?.[0]).toMatchObject({
      id: 'superpowers-marketplace',
      sourceType: 'github',
      sourceUrl: 'https://github.com/obra/superpowers',
      validProviders: ['claude'],
      providerStatus: {
        codex: {
          marketplaceName: 'superpowers-marketplace',
        },
      },
    });
    expect(externalMarketplaces?.[0]?.providerStatus.codex.error).toContain(
      'does not expose a materialized install path',
    );
  });

  it('keeps uninstalled external Claude plugins unresolved instead of pointing at the marketplace root', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [
            {
              name: 'remote-plugin',
              source: {
                source: 'github',
                url: 'https://github.com/acme/remote-plugin',
              },
            },
          ],
        });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await addMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(
      result.data?.marketplace.plugins[0]?.facets.claude?.installLocation,
    ).toBe('');
  });

  it('uses the Codex plugin name, not displayName, as the merge identity', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/codex/acme',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'acme',
          path: '/mock/codex/acme/.agents/plugins/marketplace.json',
          plugins: [
            {
              name: 'actual-plugin',
              localVersion: '1.0.0',
              interface: { displayName: 'Pretty Plugin' },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'actual-plugin',
          marketplaceName: 'acme',
          installRoot: '/mock/codex/actual-plugin',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({});
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'actual-plugin' });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await addMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace.plugins[0]?.name).toBe('actual-plugin');
    expect(result.data?.marketplace.plugins[0]?.displayName).toBe(
      'Pretty Plugin',
    );
  });

  it('builds a Claude-only marketplace result with Codex compatibility support', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [{ name: 'claude-only', source: 'plugins/claude-only' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'claude-only' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await addMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace.validProviders).toEqual(['claude']);
    expect(result.data?.marketplace.pluginCount).toBe(1);
    expect(result.data?.marketplace.plugins[0]).toMatchObject({
      name: 'claude-only',
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          name: 'claude-only',
        },
      },
    });
    expect(result.data?.marketplace.plugins[0]?.facets.codex).toBeUndefined();
  });

  it('dedupes dual-provider same-name marketplace plugins into one row', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/codex/acme',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'acme',
          path: '/mock/codex/acme/.agents/plugins/marketplace.json',
          plugins: [
            {
              name: 'shared-plugin',
              localVersion: '1.0.0',
              interface: { displayName: 'shared-plugin' },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'shared-plugin',
          marketplaceName: 'acme',
          installRoot: '/mock/codex/shared-plugin',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [{ name: 'shared-plugin', source: 'plugins/shared-plugin' }],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'shared-plugin' });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'shared-plugin' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await addMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace.validProviders).toEqual([
      'claude',
      'codex',
    ]);
    expect(result.data?.marketplace.pluginCount).toBe(1);
    expect(result.data?.marketplace.plugins).toHaveLength(1);
    expect(result.data?.marketplace.plugins[0]).toMatchObject({
      name: 'shared-plugin',
      providerSupport: { claude: 'native', codex: 'native' },
      facets: {
        claude: { provider: 'claude', mode: 'native', name: 'shared-plugin' },
        codex: { provider: 'codex', mode: 'native', name: 'shared-plugin' },
      },
    });
  });

  it('keeps provider-specific Claude and Codex plugin names as separate rows', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/codex/acme',
    });
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'acme',
          path: '/mock/codex/acme/.agents/plugins/marketplace.json',
          plugins: [
            {
              name: 'codex-specific',
              localVersion: '1.0.0',
              interface: { displayName: 'codex-specific' },
            },
          ],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    resolveCodexPluginInstallRootsMock.mockResolvedValue({
      locations: [
        {
          pluginName: 'codex-specific',
          marketplaceName: 'acme',
          installRoot: '/mock/codex/codex-specific',
        },
      ],
      unresolved: [],
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [],
        });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify({
          acme: {
            source: { source: 'github', repo: 'acme/plugins' },
            installLocation: '/mock/claude/acme',
            lastUpdated: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (isCuratedMarketplaceRead(filePath)) {
        throw new Error(`unexpected read: ${filePath}`);
      }
      if (filePath.endsWith('.claude-plugin/marketplace.json')) {
        return JSON.stringify({
          name: 'Acme',
          plugins: [
            { name: 'claude-specific', source: 'plugins/claude-specific' },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'claude-specific' });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'codex-specific' });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockReturnValue(true);

    const result = await addMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace.pluginCount).toBe(2);
    const plugins = result.data?.marketplace.plugins ?? [];
    const claudePlugin = plugins.find(
      (plugin) => plugin.name === 'claude-specific',
    );
    const codexPlugin = plugins.find(
      (plugin) => plugin.name === 'codex-specific',
    );
    expect(claudePlugin?.providerSupport).toEqual({
      claude: 'native',
      codex: 'compat',
    });
    expect(claudePlugin?.facets.claude?.name).toBe('claude-specific');
    expect(codexPlugin?.providerSupport).toEqual({
      claude: 'none',
      codex: 'native',
    });
    expect(codexPlugin?.facets.codex?.name).toBe('codex-specific');
  });

  it('defaults direct service removal to full marketplace removal when options are omitted or empty', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: false,
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation((target) => {
      if (String(target).endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'shared',
                  sourcePath: 'plugins/shared',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'native', codex: 'native' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '/mock/claude/acme/plugins/shared',
                      sourcePath: 'plugins/shared',
                    },
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '/mock/codex/shared',
                      sourcePath: '/mock/codex/shared',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/claude/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/codex/acme',
                },
              },
              validProviders: ['claude', 'codex'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${String(target)}`);
    });

    for (const options of [undefined, {}]) {
      const result = await removeMarketplace('acme/plugins', options);

      expect(result.success).toBe(true);
      expect(result.data?.marketplace).toBeNull();
      expect(result.data?.removedProviders).toEqual(['claude', 'codex']);
    }
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    expect(removeCodexMarketplace).toHaveBeenCalledTimes(2);
  });

  it('treats already-absent provider removals as idempotent full removal success', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation((target) => {
      if (String(target).endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected read: ${String(target)}`);
    });

    const result = await removeMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace).toBeNull();
    expect(result.data?.removedProviders).toEqual(['claude', 'codex']);
    expect(result.data?.providerOutcomes.claude).toEqual({
      removed: false,
      alreadyAbsent: true,
    });
    expect(result.data?.providerOutcomes.codex).toEqual({
      removed: false,
      alreadyAbsent: true,
      error: undefined,
    });
    expect(readLastWrittenJson()).toMatchObject({
      marketplaces: [],
    });
  });

  it('removes a marketplace before pruning saved selections in the background', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });

    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected sync read: ${filePath}`);
    });
    let preferences: PreferencesData = {
      ...DEFAULT_PREFERENCES,
      globalPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        ...DEFAULT_PREFERENCES.globalPluginSelections,
        pluginRefs: [
          { marketplaceId: 'acme/plugins', pluginName: 'shared' },
          { marketplaceId: 'other/plugins', pluginName: 'other' },
        ],
      },
    };
    updatePreferencesFileMock.mockImplementation(
      async (updater, onCommitted) => {
        const patch = await updater(preferences);
        if (patch !== null) {
          preferences = { ...preferences, ...patch };
          onCommitted?.(preferences);
        }
        return preferences;
      },
    );

    const result = await removeMarketplace('acme/plugins');

    expect(result.success).toBe(true);
    expect(result.data?.marketplace).toBeNull();
    expect(writeFileAsyncMock).not.toHaveBeenCalled();

    await flushMarketplaceSelectionPruneForTests();

    expect(
      readdirAsyncMock.mock.calls.some(([target]) => {
        return typeof target === 'string' && target.includes('chat-plugins');
      }),
    ).toBe(false);
    expect(writeFileAsyncMock).not.toHaveBeenCalled();
    expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
    expect(preferences.globalPluginSelections?.pluginRefs).toEqual([
      { marketplaceId: 'other/plugins', pluginName: 'other' },
    ]);
  });

  it('W-prune: uses the queued preferences value after a global revocation', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    readFileSyncMock.mockImplementation((target) => {
      if (String(target).endsWith('plugins-cache.json'))
        return JSON.stringify(dualValidMarketplaceCache());
      throw new Error('ENOENT');
    });
    readdirAsyncMock.mockResolvedValue([]);
    chatStorageScopeIdsMock.mockResolvedValue([]);
    const acme = { marketplaceId: 'acme/plugins', pluginName: 'shared' };
    const other = { marketplaceId: 'other/plugins', pluginName: 'other' };
    let queuedPreferences: PreferencesData = {
      ...DEFAULT_PREFERENCES,
      sidebarCollapsed: true,
      globalPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        ...DEFAULT_PREFERENCES.globalPluginSelections,
        pluginRefs: [acme, other],
      },
      globalApprovalRules: [
        {
          id: 'R',
          behavior: 'allow' as const,
          origin: 'prompt' as const,
          createdAt: '2026-10-27T00:00:00.000Z',
          target: { kind: 'file-write' as const, path: 'allowed/**' },
        },
      ],
    };
    let latest: unknown = queuedPreferences;
    let lastGood: unknown = structuredClone(latest);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    readFileAsyncMock.mockImplementation(async (target) => {
      if (target !== '/mock/data/preferences.json') throw new Error('ENOENT');
      const stale = JSON.stringify({ version: 1, preferences: latest });
      entered.resolve();
      await release.promise;
      return Buffer.from(stale);
    });
    writeFileAsyncMock.mockImplementation((target, value) => {
      if (target === '/mock/data/preferences.json') {
        if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
          throw new Error('Expected serialized preferences');
        }
        const parsed: unknown = JSON.parse(value.toString());
        if (!isRecord(parsed) || !isRecord(parsed.preferences)) {
          throw new Error('Expected preferences document');
        }
        latest = parsed.preferences;
      }
      return Promise.resolve();
    });
    updatePreferencesFileMock.mockImplementation(
      async (updater, onCommitted) => {
        entered.resolve();
        await release.promise;
        queuedPreferences = {
          ...queuedPreferences,
          ...(await updater(queuedPreferences)),
        };
        latest = queuedPreferences;
        lastGood = structuredClone(latest);
        onCommitted?.(queuedPreferences);
        return queuedPreferences;
      },
    );
    expect((await removeMarketplace('acme/plugins')).success).toBe(true);
    await entered.promise;
    queuedPreferences = { ...queuedPreferences, globalApprovalRules: [] };
    latest = queuedPreferences;
    lastGood = structuredClone(latest);
    release.resolve();
    await flushMarketplaceSelectionPruneForTests();
    expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({
      sidebarCollapsed: true,
      globalApprovalRules: [],
      globalPluginSelections: { pluginRefs: [other] },
    });
    expect(lastGood).toEqual(latest);
    expect(writeFileAsyncMock).not.toHaveBeenCalled();
  });

  it.each(['commit', 'failure', 'no-op'])(
    'W-prune: invalidates global defaults only at commit (%s)',
    async (outcome) => {
      mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
      removeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        alreadySatisfied: true,
      });
      readFileSyncMock.mockImplementation((target) => {
        if (String(target).endsWith('plugins-cache.json'))
          return JSON.stringify(dualValidMarketplaceCache());
        throw new Error('ENOENT');
      });
      readdirAsyncMock.mockResolvedValue([]);
      chatStorageScopeIdsMock.mockResolvedValue([]);
      const before = getGlobalPluginDefaultsRevision();
      const latest = normalizePreferences({
        ...DEFAULT_PREFERENCES,
        globalPluginSelections: {
          ...DEFAULT_PREFERENCES.globalPluginSelections,
          collectionIds: [],
          skillRefs: [],
          pluginRefs:
            outcome === 'no-op'
              ? []
              : [{ marketplaceId: 'acme/plugins', pluginName: 'shared' }],
        },
      });
      let revisionAfterUpdater: number | undefined;
      let updaterReturnedNull: boolean | undefined;
      updatePreferencesFileMock.mockImplementation(
        async (updater, onCommitted) => {
          const patch = await updater(latest);
          revisionAfterUpdater = getGlobalPluginDefaultsRevision();
          updaterReturnedNull = patch === null;
          if (outcome === 'failure') throw new Error('primary commit failed');
          if (outcome === 'no-op') {
            return latest;
          }
          const committed = { ...latest, ...patch };
          onCommitted?.(committed);
          return committed;
        },
      );
      expect((await removeMarketplace('acme/plugins')).success).toBe(true);
      await flushMarketplaceSelectionPruneForTests();
      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      expect(revisionAfterUpdater).toBe(before);
      expect(updaterReturnedNull).toBe(outcome === 'no-op');
      expect(getGlobalPluginDefaultsRevision()).toBe(
        before + (outcome === 'commit' ? 1 : 0),
      );
      expect(writeFileAsyncMock).not.toHaveBeenCalled();
    },
  );

  it('prunes a workspace config inside its manifest queue, so a queued update keeps the prune', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected sync read: ${filePath}`);
    });
    const configPath = '/mock/data/workspaces/ws-1/workspace.json';
    const acme = { marketplaceId: 'acme/plugins', pluginName: 'shared' };
    const other = { marketplaceId: 'other/plugins', pluginName: 'other' };
    const files = new Map<string, string>([
      [
        configPath,
        JSON.stringify({
          version: 1,
          type: 'single-repo',
          repos: [],
          defaultPluginSelections: { pluginRefs: [acme, other] },
        }),
      ],
    ]);
    readdirAsyncMock.mockImplementation((target) =>
      Promise.resolve(
        String(target) === '/mock/data/workspaces'
          ? [mockBufferDirent('ws-1', true)]
          : [],
      ),
    );
    chatStorageScopeIdsMock.mockResolvedValue([]);
    readFileAsyncMock.mockImplementation((target) => {
      const raw = typeof target === 'string' ? files.get(target) : undefined;
      return raw === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(Buffer.from(raw));
    });
    writeFileAsyncMock.mockImplementation((target, data) => {
      if (typeof target === 'string' && typeof data === 'string')
        files.set(target, data);
      return Promise.resolve();
    });

    // Another manifest writer read the config and is about to write it back.
    const manifests = getWorkspaceManifestRepository();
    let releaseUpdate: () => void = () => {};
    let queuedUpdate: Promise<void> = Promise.resolve();
    await new Promise<void>((resolveRead) => {
      queuedUpdate = manifests.serialize('ws-1', async () => {
        const read = await manifests.read('ws-1');
        resolveRead();
        await new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        });
        if (read.authority !== 'ok') throw new Error('unreadable');
        await manifests.replaceDocument(
          'ws-1',
          { ...read.document, alwaysShow: false },
          read,
        );
      });
    });

    const result = await removeMarketplace('acme/plugins');
    expect(result.success).toBe(true);
    // Let the background prune run up to the point the queue holds it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseUpdate();
    await queuedUpdate;
    await flushMarketplaceSelectionPruneForTests();

    expect(JSON.parse(files.get(configPath) ?? '{}')).toMatchObject({
      alwaysShow: false,
      defaultPluginSelections: { pluginRefs: [other] },
    });
  });

  it('drops the cached project defaults of a workspace config it prunes', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected sync read: ${filePath}`);
    });
    const configPath = '/mock/data/workspaces/ws-1/workspace.json';
    const acme = { marketplaceId: 'acme/plugins', pluginName: 'shared' };
    const other = { marketplaceId: 'other/plugins', pluginName: 'other' };
    readdirAsyncMock.mockImplementation((target) =>
      Promise.resolve(
        String(target) === '/mock/data/workspaces'
          ? [mockBufferDirent('ws-1', true)]
          : [],
      ),
    );
    chatStorageScopeIdsMock.mockResolvedValue([]);
    readFileAsyncMock.mockImplementation((target) =>
      target === configPath
        ? Promise.resolve(
            Buffer.from(
              JSON.stringify({
                version: 1,
                type: 'single-repo',
                repos: [],
                defaultPluginSelections: { pluginRefs: [acme, other] },
              }),
            ),
          )
        : Promise.reject(new Error('ENOENT')),
    );
    await readThroughProjectPluginDefaults(configPath, () =>
      Promise.resolve({
        defaults: {
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [acme, other],
          },
        },
        cacheable: true,
      }),
    );

    const result = await removeMarketplace('acme/plugins');
    expect(result.success).toBe(true);
    await flushMarketplaceSelectionPruneForTests();

    expect(writeFileAsyncMock.mock.calls.map(([target]) => target)).toContain(
      configPath,
    );
    const reload = jest.fn(() =>
      Promise.resolve({ defaults: {}, cacheable: true }),
    );
    await readThroughProjectPluginDefaults(configPath, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('passes one fan-out request ID to every workspace prune and removes the marketplace when prunes refuse or fail (CAN-4717)', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected sync read: ${filePath}`);
    });
    readdirAsyncMock.mockImplementation((target) =>
      Promise.resolve(
        String(target) === '/mock/data/workspaces'
          ? ['ws-1', 'ws-2', 'ws-3'].map((id) => mockBufferDirent(id, true))
          : [],
      ),
    );
    chatStorageScopeIdsMock.mockResolvedValue([]);
    readFileAsyncMock.mockImplementation(() =>
      Promise.reject(new Error('ENOENT')),
    );
    const prune = jest
      .spyOn(workspacePluginDefaults, 'updateWorkspacePlugins')
      .mockImplementation(({ workspaceId }) => {
        if (workspaceId === 'ws-2')
          return Promise.reject(
            new workspacePluginDefaults.WorkspacePluginsRefusedError(
              'not-found',
              'Project ws-2 not found.',
            ),
          );
        if (workspaceId === 'ws-3')
          return Promise.reject(new Error('response lost'));
        return Promise.resolve({ workspaceId, written: true });
      });
    try {
      // The cache mock keeps the marketplace, so each call reaches the
      // fan-out: the same request ID twice, then none.
      for (const fanOutRequestId of ['removal', 'removal', undefined]) {
        const result = await removeMarketplace('acme/plugins', {
          fanOutRequestId,
        });
        expect(result.success).toBe(true);
        expect(result.data?.marketplace).toBeNull();
        await flushMarketplaceSelectionPruneForTests();
      }
      const request = (
        workspaceId: string,
        fanOutRequestId: string | undefined,
      ): unknown => ({
        workspaceId,
        change: { kind: 'pruneMarketplace', marketplaceId: 'acme/plugins' },
        source: 'marketplace_removal',
        fanOutRequestId,
      });
      const workspaces = ['ws-1', 'ws-2', 'ws-3'];
      expect(prune.mock.calls.map(([call]) => call)).toEqual([
        ...workspaces.map((id) => request(id, 'removal')),
        ...workspaces.map((id) => request(id, 'removal')),
        // A removal without one stays unkeyed.
        ...workspaces.map((id) => request(id, undefined)),
      ]);
    } finally {
      prune.mockRestore();
    }
  });

  describe('sessions inheriting pruned defaults', () => {
    const acme = { marketplaceId: 'acme/plugins', pluginName: 'shared' };
    const other = { marketplaceId: 'other/plugins', pluginName: 'other' };

    function removeWith(files: Record<string, unknown>): Promise<void> {
      const stored = files['/mock/data/preferences.json'];
      let preferences = normalizePreferences(
        {
          ...DEFAULT_PREFERENCES,
          ...(typeof stored === 'object' && stored !== null ? stored : {}),
        },
        'persisted',
      );
      updatePreferencesFileMock.mockImplementation(
        async (updater, onCommitted) => {
          const patch = await updater(preferences);
          if (patch !== null) {
            preferences = { ...preferences, ...patch };
            onCommitted?.(preferences);
          }
          return preferences;
        },
      );
      mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
      removeCodexMarketplaceMock.mockResolvedValue({
        accepted: true,
        alreadySatisfied: true,
      });
      readFileSyncMock.mockImplementation((target) => {
        const filePath = String(target);
        if (filePath.endsWith('plugins-cache.json')) {
          return JSON.stringify(dualValidMarketplaceCache());
        }
        throw new Error(`unexpected sync read: ${filePath}`);
      });
      const workspaceIds = Object.keys(files).flatMap((filePath) => {
        const match =
          /^\/mock\/data\/workspaces\/([^/]+)\/workspace\.json$/.exec(filePath);
        return match?.[1] ? [match[1]] : [];
      });
      readdirAsyncMock.mockImplementation((target) =>
        Promise.resolve(
          String(target) === '/mock/data/workspaces'
            ? workspaceIds.map((id) => mockBufferDirent(id, true))
            : [],
        ),
      );
      chatStorageScopeIdsMock.mockResolvedValue([]);
      readFileAsyncMock.mockImplementation((target) => {
        const content = typeof target === 'string' ? files[target] : undefined;
        return content === undefined
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve(Buffer.from(JSON.stringify(content)));
      });
      return removeMarketplace('acme/plugins').then(async (result) => {
        expect(result.success).toBe(true);
        await flushMarketplaceSelectionPruneForTests();
      });
    }

    function sessionRevision(workspaceId: string): number {
      return getInheritedPluginDefaultsRevision({
        projectId: workspaceId,
        worktreeId: 'wt-1',
      });
    }

    it('recreates the sessions of chats in workspaces whose defaults or tombstones lost a plugin', async () => {
      const before = {
        defaults: sessionRevision('ws-defaults'),
        tombstones: sessionRevision('ws-tombstones'),
        elsewhere: sessionRevision('ws-elsewhere'),
        untouched: sessionRevision('ws-untouched'),
      };

      await removeWith({
        '/mock/data/workspaces/ws-defaults/workspace.json': {
          version: 1,
          type: 'single-repo',
          repos: [],
          defaultPluginSelections: { pluginRefs: [acme, other] },
        },
        '/mock/data/workspaces/ws-tombstones/workspace.json': {
          version: 1,
          type: 'single-repo',
          repos: [],
          disabledGlobalPluginSelections: { pluginRefs: [acme] },
        },
        '/mock/data/workspaces/ws-elsewhere/workspace.json': {
          version: 1,
          type: 'single-repo',
          repos: [],
          defaultPluginSelections: { pluginRefs: [other] },
          hooks: {
            chat_created: [
              { type: 'chat', pluginSelections: { pluginRefs: [acme] } },
            ],
          },
        },
        '/mock/data/workspaces/ws-untouched/workspace.json': {
          version: 1,
          type: 'single-repo',
          repos: [],
          defaultPluginSelections: { pluginRefs: [other] },
        },
      });

      expect(sessionRevision('ws-defaults')).toBe(before.defaults + 1);
      expect(sessionRevision('ws-tombstones')).toBe(before.tombstones + 1);
      expect(sessionRevision('ws-elsewhere')).toBe(before.elsewhere);
      expect(sessionRevision('ws-untouched')).toBe(before.untouched);
    });

    it('recreates every inheriting session when the global defaults lost a plugin', async () => {
      const before = getGlobalPluginDefaultsRevision();

      await removeWith({
        '/mock/data/preferences.json': {
          globalPluginSelections: { pluginRefs: [acme, other] },
        },
      });

      expect(getGlobalPluginDefaultsRevision()).toBe(before + 1);
    });

    it('leaves sessions alone when pruned preferences kept the global defaults', async () => {
      const before = getGlobalPluginDefaultsRevision();

      await removeWith({
        '/mock/data/preferences.json': {
          globalPluginSelections: { pluginRefs: [other] },
          appAdvisorPluginSelections: { pluginRefs: [acme] },
        },
      });

      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileAsyncMock).not.toHaveBeenCalled();
      expect(getGlobalPluginDefaultsRevision()).toBe(before);
    });

    it('prunes preferences through the preferences store first, never through the generic file loop', async () => {
      const before = getGlobalPluginDefaultsRevision();
      await removeWith({
        '/mock/data/preferences.json': {
          globalPluginSelections: { pluginRefs: [acme, other] },
        },
        '/mock/data/pipeline-plugin-preferences.json': {
          pluginSelections: { pluginRefs: [acme, other] },
        },
      });

      // The generic loop reads and rewrites the files it is given; the
      // preferences path never enters it.
      expect(getPreferencesFilePathMock).not.toHaveBeenCalled();
      for (const mock of [readFileAsyncMock, writeFileAsyncMock])
        expect(mock.mock.calls.map(([target]) => target)).not.toContain(
          '/mock/data/preferences.json',
        );
      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      expect(getGlobalPluginDefaultsRevision()).toBe(before + 1);
      expect(writeFileAsyncMock.mock.calls.map(([target]) => target)).toEqual([
        '/mock/data/pipeline-plugin-preferences.json',
      ]);
      const pipelineRead = readFileAsyncMock.mock.calls.findIndex(
        ([target]) => target === '/mock/data/pipeline-plugin-preferences.json',
      );
      expect(
        updatePreferencesFileMock.mock.invocationCallOrder[0],
      ).toBeLessThan(
        readFileAsyncMock.mock.invocationCallOrder[pipelineRead] ?? 0,
      );
    });

    it('keeps pruning the other files when the preferences prune fails', async () => {
      const files = {
        '/mock/data/pipeline-plugin-preferences.json': {
          pluginSelections: { pluginRefs: [acme, other] },
        },
      };
      const removal = removeWith(files);
      updatePreferencesFileMock.mockRejectedValue(
        Object.assign(new Error('refused'), {
          code: 'PREFERENCES_RECOVERY_REQUIRED',
        }),
      );
      await removal;

      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileAsyncMock.mock.calls.map(([target]) => target)).toEqual([
        '/mock/data/pipeline-plugin-preferences.json',
      ]);
    });
  });

  it('installed-item removal leaves preferences to its caller and prunes the other files', async () => {
    const ref = {
      kind: 'plugin' as const,
      marketplaceId: 'acme/plugins',
      pluginName: 'shared',
    };
    const document = {
      pluginSelections: {
        pluginRefs: [{ marketplaceId: 'acme/plugins', pluginName: 'shared' }],
      },
    };
    readdirAsyncMock.mockResolvedValue([]);
    chatStorageScopeIdsMock.mockResolvedValue([]);
    readFileAsyncMock.mockImplementation((target) =>
      target === '/mock/data/preferences.json' ||
      target === '/mock/data/pipeline-plugin-preferences.json'
        ? Promise.resolve(Buffer.from(JSON.stringify(document)))
        : Promise.reject(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          ),
    );

    await pruneSelectionRefsForInstalledItem(ref);

    expect(getPreferencesFilePathMock).not.toHaveBeenCalled();
    expect(
      readFileAsyncMock.mock.calls.map(([target]) => target),
    ).not.toContain('/mock/data/preferences.json');
    expect(writeFileAsyncMock.mock.calls.map(([target]) => target)).toEqual([
      '/mock/data/pipeline-plugin-preferences.json',
    ]);
    expect(updatePreferencesFileMock).not.toHaveBeenCalled();
  });

  it('prunes marketplace refs from canonical v2 chat scopes without rewriting legacy chat files', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('marketplace not found'));
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: true,
    });
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify(dualValidMarketplaceCache());
      }
      throw new Error(`unexpected sync read: ${filePath}`);
    });
    const acme = { marketplaceId: 'acme/plugins', pluginName: 'shared' };
    const other = { marketplaceId: 'other/plugins', pluginName: 'other' };
    // `wt-1` has migrated to v2 (manifest present) but a stale legacy
    // `chats/wt-1.json` survives beside it; `wt-legacy` is still v1.
    readdirAsyncMock.mockImplementation((target) => {
      const dir = String(target);
      if (dir === '/mock/data/workspaces') {
        return Promise.resolve([mockBufferDirent('ws-1', true)]);
      }
      if (dir === '/mock/data/workspaces/ws-1/chats') {
        return Promise.resolve([
          mockBufferDirent('wt-1.json', false),
          mockBufferDirent('wt-legacy.json', false),
        ]);
      }
      return Promise.resolve([]);
    });
    const legacyTabs = (chatId: string): string =>
      JSON.stringify({
        version: 1,
        activeTabId: chatId,
        tabs: [{ id: chatId, pluginSelections: { pluginRefs: [acme] } }],
      });
    readFileAsyncMock.mockImplementation((target) => {
      const filePath = typeof target === 'string' ? target : '';
      if (filePath.endsWith('/workspaces/ws-1/chats/wt-1.json')) {
        return Promise.resolve(Buffer.from(legacyTabs('stale-chat')));
      }
      if (filePath.endsWith('/workspaces/ws-1/chats/wt-legacy.json')) {
        return Promise.resolve(Buffer.from(legacyTabs('legacy-chat')));
      }
      return Promise.reject(new Error(`ENOENT: ${filePath}`));
    });
    chatStorageScopeIdsMock.mockImplementation((root) =>
      Promise.resolve(root === '/mock/data/workspaces/ws-1' ? ['wt-1'] : []),
    );
    readChatStorageDiscoveryIndexMock.mockResolvedValue({
      tabs: [
        {
          id: 'chat-1',
          pluginSelections: legacyPluginSelections([acme, other]),
        },
        { id: 'chat-2', pluginSelections: legacyPluginSelections([other]) },
      ],
      runtimeByChatId: {},
      pendingJournal: false,
    });
    mockUpdateCompatibilityTab.mockResolvedValue({
      tabsFile: { version: 1, tabs: [], activeTabId: '' },
      updated: true,
    });

    const result = await removeMarketplace('acme/plugins');
    expect(result.success).toBe(true);
    await flushMarketplaceSelectionPruneForTests();

    expect(readChatStorageDiscoveryIndexMock).toHaveBeenCalledWith(
      '/mock/data/workspaces/ws-1',
      'wt-1',
    );
    // Only the tab that actually references the marketplace is mutated,
    // through the canonical metadata-only compatibility mutation.
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledTimes(1);
    const call = mockUpdateCompatibilityTab.mock.calls[0];
    if (!call) throw new Error('canonical prune mutation was not issued');
    const [scope, chatId, update, mutationId, options] = call;
    expect(scope).toEqual({ projectId: 'ws-1', worktreeId: 'wt-1' });
    expect(chatId).toBe('chat-1');
    expect(mutationId).toBeUndefined();
    expect(options).toEqual({ metadataOnly: true });
    const current: PersistedChatTab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-01T00:00:00.000Z',
      messages: [],
      pluginSelections: legacyPluginSelections([acme, other]),
    };
    expect(update(current)).toEqual({
      ...current,
      pluginSelections: { pluginRefs: [other] },
    });
    // The current tab is never mutated in place.
    expect(current.pluginSelections?.pluginRefs).toEqual([acme, other]);
    expect(
      update({ ...current, pluginSelections: legacyPluginSelections([other]) }),
    ).toBeNull();

    // The migrated scope's stale legacy file is a migration input and must
    // not be rewritten; the unmigrated legacy scope still gets pruned in place.
    const legacyWrites = writeFileAsyncMock.mock.calls
      .map(([target]) => (typeof target === 'string' ? target : ''))
      .filter((target) => target.includes('/workspaces/ws-1/chats/'));
    expect(legacyWrites).toEqual([
      '/mock/data/workspaces/ws-1/chats/wt-legacy.json',
    ]);
  });

  it('clears removed provider roots and facets during single-provider removal', async () => {
    const cache = {
      version: 2,
      lastRefreshed: '2026-05-01T00:00:00.000Z',
      marketplaces: [
        {
          id: 'acme/plugins',
          name: 'Acme',
          sourceType: 'github',
          sourceUrl: 'https://github.com/acme/plugins',
          installLocation: '/mock/claude/acme',
          pluginCount: 1,
          plugins: [
            {
              name: 'shared',
              sourcePath: 'plugins/shared',
              marketplaceId: 'acme/plugins',
              providerSupport: { claude: 'native', codex: 'native' },
              facets: {
                claude: {
                  provider: 'claude',
                  mode: 'native',
                  name: 'shared',
                  installLocation: '/mock/claude/acme/plugins/shared',
                  sourcePath: 'plugins/shared',
                },
                codex: {
                  provider: 'codex',
                  mode: 'native',
                  name: 'shared',
                  installLocation: '/mock/codex/shared',
                  sourcePath: '/mock/codex/shared',
                },
              },
            },
          ],
          providerStatus: {
            claude: {
              provider: 'claude',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              lastCheckedAt: '2026-05-01T00:00:00.000Z',
              marketplaceName: 'acme',
              installLocation: '/mock/claude/acme',
            },
            codex: {
              provider: 'codex',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              lastCheckedAt: '2026-05-01T00:00:00.000Z',
              marketplaceName: 'acme',
              installLocation: '/mock/codex/acme',
            },
          },
          validProviders: ['claude', 'codex'],
        },
      ],
    };
    readFileSyncMock.mockImplementation((target) => {
      if (String(target).endsWith('plugins-cache.json')) {
        return JSON.stringify(cache);
      }
      throw new Error(`unexpected read: ${String(target)}`);
    });
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      alreadySatisfied: false,
    });

    const result = await removeMarketplace('acme/plugins', {
      providers: ['codex'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.marketplace?.validProviders).toEqual(['claude']);
    expect(
      result.data?.marketplace?.providerStatus.codex.installLocation,
    ).toBeUndefined();
    expect(result.data?.marketplace?.plugins[0]?.facets.codex).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        readFirstWrittenMarketplaceProviderStatus('codex'),
        'installLocation',
      ),
    ).toBe(false);
  });

  it('persists provider removal errors on the marketplace row for retry diagnostics', async () => {
    readFileSyncMock.mockImplementation((target) => {
      if (String(target).endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/codex/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'codex-only',
                  sourcePath: '/mock/codex/plugin',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'none', codex: 'native' },
                  facets: {
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'codex-only',
                      installLocation: '/mock/codex/plugin',
                      sourcePath: '/mock/codex/plugin',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                  marketplaceName: 'acme',
                  installLocation: '/mock/codex/acme',
                },
              },
              validProviders: ['codex'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${String(target)}`);
    });
    removeCodexMarketplaceMock.mockResolvedValue({
      accepted: false,
      error: 'remove failed',
    });

    const result = await removeMarketplace('acme/plugins', {
      providers: ['codex'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.marketplace?.providerStatus.codex).toMatchObject({
      state: 'valid',
      error: 'remove failed',
    });
    expect(readFirstWrittenMarketplaceProviderStatus('codex').error).toBe(
      'remove failed',
    );
  });

  it('preserves an existing Codex facet in the returned plugin after installing an external Claude facet', async () => {
    cloneRepoMock.mockResolvedValue(undefined);
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'shared',
                  sourcePath: '',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'native', codex: 'native' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '',
                      sourcePath: '',
                      externalSource: {
                        source: 'github',
                        url: 'https://github.com/acme/shared-plugin',
                      },
                    },
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '/mock/codex/shared',
                      sourcePath: '/mock/codex/shared',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
              },
              validProviders: ['claude', 'codex'],
            },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'shared', description: 'Installed' });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await installPlugin(
      'acme/plugins',
      'shared',
      'https://github.com/acme/shared-plugin',
    );

    expect(result.success).toBe(true);
    expect(result.data?.providerSupport.codex).toBe('native');
    expect(result.data?.facets.codex?.installLocation).toBe(
      '/mock/codex/shared',
    );
  });

  it('persists the installed plugin into plugins-cache.json so a reload reflects it', async () => {
    cloneRepoMock.mockResolvedValue(undefined);
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/claude/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'ext',
                  sourcePath: '',
                  marketplaceId: 'acme/plugins',
                  details: null,
                  externalSource: {
                    source: 'github',
                    url: 'https://github.com/acme/ext',
                  },
                  providerSupport: { claude: 'native', codex: 'none' },
                  facets: {},
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-05-01T00:00:00.000Z',
                },
              },
              validProviders: ['claude'],
            },
          ],
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'ext', description: 'Installed' });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = await installPlugin(
      'acme/plugins',
      'ext',
      'https://github.com/acme/ext',
    );
    expect(result.success).toBe(true);

    // The persisted plugins-cache.json must now show the plugin as installed
    // (a local cachePath set), so a fresh load after navigating away and back
    // reflects the install instead of the pre-install state.
    const cacheWrites = writeFileSyncMock.mock.calls.filter(([target]) =>
      String(target).endsWith('plugins-cache.json'),
    );
    const persistedInstalled = cacheWrites.some(([, payload]) => {
      if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
        return false;
      }
      const parsed: unknown = JSON.parse(payload.toString());
      if (!isRecord(parsed) || !isUnknownArray(parsed.marketplaces)) {
        return false;
      }
      const marketplace = parsed.marketplaces[0];
      if (!isRecord(marketplace) || !isUnknownArray(marketplace.plugins)) {
        return false;
      }
      const plugin = marketplace.plugins.find(
        (entry) => isRecord(entry) && entry.name === 'ext',
      );
      if (!isRecord(plugin)) {
        return false;
      }
      return (
        typeof plugin.cachePath === 'string' && plugin.cachePath.length > 0
      );
    });
    expect(persistedInstalled).toBe(true);
  });

  it('clones with redirects enabled by default (trusted callers unchanged)', async () => {
    cloneRepoMock.mockResolvedValue(undefined);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ version: 2, lastRefreshed: '', marketplaces: [] }),
    );

    await installPlugin('acme/plugins', 'ext', 'https://github.com/acme/ext');

    expect(cloneRepoMock).toHaveBeenCalledWith(
      'https://github.com/acme/ext',
      expect.any(String),
      { followRedirects: true },
    );
  });

  it('refuses clone redirects on the portal external-install path (disableRedirects)', async () => {
    cloneRepoMock.mockResolvedValue(undefined);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ version: 2, lastRefreshed: '', marketplaces: [] }),
    );

    await installPlugin('acme/plugins', 'ext', 'https://github.com/acme/ext', {
      disableRedirects: true,
      skipRefresh: true,
    });

    // Redirect-following is disabled so a 3xx into a private host after the
    // allowlisted initial URL cannot be followed.
    expect(cloneRepoMock).toHaveBeenCalledWith(
      'https://github.com/acme/ext',
      expect.any(String),
      { followRedirects: false },
    );
  });
});

describe('readComponentContent', () => {
  // Use the mocked plugin cache dir as the install location (trusted root)
  const install = '/mock/data/plugin-cache';
  const source = 'plugins/my-plugin';
  const component = 'skills/greeting/SKILL.md';

  it('returns error when installLocation is empty string', () => {
    const result = readComponentContent('', source, component);
    expect(result).toEqual({
      success: false,
      error: 'Missing install location.',
    });
  });

  it('returns error when installLocation is not a string', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const result = readComponentContent(undefined as any, source, component);
    expect(result).toEqual({
      success: false,
      error: 'Missing install location.',
    });
  });

  it('returns error when pluginSourcePath is not a string', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const result = readComponentContent(install, 42 as any, component);
    expect(result).toEqual({
      success: false,
      error: 'Missing plugin source path. Try refreshing the marketplace.',
    });
  });

  it('returns error when componentFile is empty string', () => {
    const result = readComponentContent(install, source, '');
    expect(result).toEqual({
      success: false,
      error: 'Missing component file path.',
    });
  });

  it('returns error when componentFile is not a string', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const result = readComponentContent(install, source, null as any);
    expect(result).toEqual({
      success: false,
      error: 'Missing component file path.',
    });
  });

  it('returns error for path traversal in pluginSourcePath', () => {
    const result = readComponentContent(install, '../../etc', component);
    expect(result).toEqual({ success: false, error: 'Invalid plugin path.' });
  });

  it('returns error for path traversal in componentFile', () => {
    const result = readComponentContent(install, source, '../../etc/passwd');
    expect(result).toEqual({
      success: false,
      error: 'Invalid component path.',
    });
  });

  it('allows pluginDir equal to resolvedRoot when pluginSourcePath is empty', () => {
    const filePath = path.resolve(install, component);
    existsSyncMock.mockImplementation((p) => p === filePath);
    readFileSyncMock.mockReturnValue('plain body content');

    const result = readComponentContent(install, '', component);
    expect(result).toEqual({
      success: true,
      data: { frontmatter: {}, body: 'plain body content' },
    });
  });

  it('returns error when file does not exist', () => {
    existsSyncMock.mockReturnValue(false);

    const result = readComponentContent(install, source, component);
    expect(result).toEqual({
      success: false,
      error: 'Component file not found.',
    });
  });

  it('does not trust a relative facet sourcePath anchored on process.cwd()', () => {
    const escapedInstallLocation = path.resolve('plugins/my-plugin');
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/marketplaces/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'my-plugin',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'native', codex: 'unsupported' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'my-plugin',
                      sourcePath: 'plugins/my-plugin',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  installLocation: '/mock/marketplaces/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                },
              },
              validProviders: ['claude'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = readComponentContent(escapedInstallLocation, '', component);

    expect(result).toEqual({
      success: false,
      error: 'Invalid install location.',
    });
  });

  it('does not trust a relative facet sourcePath that escapes its install root', () => {
    const escapedInstallLocation = '/mock/other/etc';
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/marketplaces/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'my-plugin',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'native', codex: 'unsupported' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'my-plugin',
                      installLocation: '/mock/other/base/plugin',
                      sourcePath: '../../etc',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  installLocation: '/mock/marketplaces/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                },
              },
              validProviders: ['claude'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });

    const result = readComponentContent(escapedInstallLocation, '', component);

    expect(result).toEqual({
      success: false,
      error: 'Invalid install location.',
    });
  });

  it('returns body as-is with empty frontmatter when file has no frontmatter', () => {
    const filePath = path.resolve(install, source, component);
    existsSyncMock.mockImplementation((p) => p === filePath);
    readFileSyncMock.mockReturnValue('# Hello World\nSome content here.');

    const result = readComponentContent(install, source, component);
    expect(result).toEqual({
      success: true,
      data: {
        frontmatter: {},
        body: '# Hello World\nSome content here.',
      },
    });
  });

  it('parses valid frontmatter and returns body after closing ---', () => {
    const fileContent =
      '---\nname: Greeting\ndescription: A greeting skill\n---\n# Hello\nBody text.';
    const filePath = path.resolve(install, source, component);
    existsSyncMock.mockImplementation((p) => p === filePath);
    readFileSyncMock.mockReturnValue(fileContent);

    const result = readComponentContent(install, source, component);
    expect(result.success).toBe(true);
    const data = result.data;
    expect(data).toBeDefined();
    expect(data?.frontmatter).toEqual({
      name: 'Greeting',
      description: 'A greeting skill',
    });
    expect(data?.body).toBe('# Hello\nBody text.');
  });

  it('treats entire file as body when YAML in frontmatter is invalid', () => {
    const fileContent =
      '---\n: invalid: yaml: [broken\n---\nBody after bad yaml.';
    const filePath = path.resolve(install, source, component);
    existsSyncMock.mockImplementation((p) => p === filePath);
    readFileSyncMock.mockReturnValue(fileContent);

    const result = readComponentContent(install, source, component);
    expect(result.success).toBe(true);
    expect(result.data?.frontmatter).toEqual({});
    expect(result.data?.body).toBe('Body after bad yaml.');
  });

  it('returns error when fs.readFileSync throws', () => {
    const filePath = path.resolve(install, source, component);
    existsSyncMock.mockImplementation((p) => p === filePath);
    readFileSyncMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = readComponentContent(install, source, component);
    expect(result).toEqual({
      success: false,
      error: 'EACCES: permission denied',
    });
  });
});

describe('buildCodexCompatDisabledKey', () => {
  it('lowercases the plugin name and joins with the marketplace id', () => {
    expect(buildCodexCompatDisabledKey('mkt-1', 'My-Plugin')).toBe(
      'mkt-1/my-plugin',
    );
  });
});

describe('setCodexCompatDisabled and the loadMarketplaces overlay', () => {
  // A version-2 cache containing one Claude-native / Codex-compat-capable
  // plugin. The bundled plugins dir is left absent so mergeBuiltInMarketplace
  // is a no-op and only this marketplace survives into the served result.
  function mockCompatCapableCacheReads(): void {
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          marketplaces: [
            {
              id: 'mkt-1',
              name: 'Marketplace One',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/marketplaces/mkt-1',
              pluginCount: 1,
              plugins: [
                {
                  name: 'My-Plugin',
                  marketplaceId: 'mkt-1',
                  sourcePath: 'plugins/my-plugin',
                  providerSupport: { claude: 'native', codex: 'compat' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'My-Plugin',
                      sourcePath: 'plugins/my-plugin',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  installLocation: '/mock/marketplaces/mkt-1',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                },
              },
              validProviders: ['claude'],
            },
          ],
        });
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    // Bundled plugins dir absent so no built-in marketplace is injected.
    existsSyncMock.mockReturnValue(false);
  }

  describe('setCodexCompatDisabled', () => {
    it('adds the key to preferences and returns the plugin with codexCompatDisabled=true', async () => {
      mockCompatCapableCacheReads();
      readPreferencesFileMock.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: [],
      });

      const result = await setCodexCompatDisabled('mkt-1', 'My-Plugin', true);

      expect(result.success).toBe(true);
      expect(result.data?.codexCompatDisabled).toBe(true);
      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      const updater = updatePreferencesFileMock.mock.calls[0]?.[0];
      expect(updater).toBeDefined();
      if (!updater) throw new Error('Expected curated defaults update');
      const persisted = await updater({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: [],
      });
      expect(persisted?.codexCompatDisabledPlugins).toEqual([
        'mkt-1/my-plugin',
      ]);
    });

    it('removes the key when disabled=false', async () => {
      mockCompatCapableCacheReads();
      readPreferencesFileMock.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: ['mkt-1/my-plugin'],
      });
      updatePreferencesFileMock.mockImplementation(async (updater) => ({
        ...DEFAULT_PREFERENCES,
        ...(await updater({
          ...DEFAULT_PREFERENCES,
          codexCompatDisabledPlugins: ['mkt-1/my-plugin'],
        })),
      }));

      const result = await setCodexCompatDisabled('mkt-1', 'My-Plugin', false);

      expect(result.success).toBe(true);
      expect(result.data?.codexCompatDisabled).toBe(false);
      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      const updater = updatePreferencesFileMock.mock.calls[0]?.[0];
      expect(updater).toBeDefined();
      if (!updater) throw new Error('Expected curated defaults update');
      const persisted = await updater({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: ['mkt-1/my-plugin'],
      });
      expect(persisted?.codexCompatDisabledPlugins).toEqual([]);
    });

    it('returns an error when the plugin is not found', async () => {
      mockCompatCapableCacheReads();

      const result = await setCodexCompatDisabled('mkt-1', 'missing', true);

      expect(result.success).toBe(false);
      expect(updatePreferencesFileMock).not.toHaveBeenCalled();
    });

    it('can toggle a built-in plugin injected into the served marketplace view', async () => {
      readFileSyncMock.mockImplementation((target) => {
        const filePath = String(target);
        if (filePath.endsWith('plugins-cache.json')) {
          return JSON.stringify({
            version: 2,
            lastRefreshed: '2026-05-01T00:00:00.000Z',
            marketplaces: [],
          });
        }
        if (
          filePath === '/mock/resources/plugins/.claude-plugin/marketplace.json'
        ) {
          return JSON.stringify({
            name: 'canopy-plugins',
            plugins: [
              {
                name: 'Built-In Plugin',
                source: 'plugins/built-in-plugin',
                category: 'Utilities',
              },
            ],
          });
        }
        throw new Error(`unexpected read: ${filePath}`);
      });

      const result = await setCodexCompatDisabled(
        'builtin/app',
        'Built-In Plugin',
        true,
      );

      expect(result.success).toBe(true);
      expect(result.data?.builtIn).toBe(true);
      expect(result.data?.codexCompatDisabled).toBe(true);
      expect(updatePreferencesFileMock).toHaveBeenCalledTimes(1);
      const updater = updatePreferencesFileMock.mock.calls[0]?.[0];
      expect(updater).toBeDefined();
      if (!updater) throw new Error('Expected curated defaults update');
      const persisted = await updater({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: [],
      });
      expect(persisted?.codexCompatDisabledPlugins).toEqual([
        'builtin/app/built-in plugin',
      ]);
    });
  });

  describe('loadMarketplaces codexCompatDisabled overlay', () => {
    it('marks served plugins whose key is in codexCompatDisabledPlugins', async () => {
      mockCompatCapableCacheReads();
      readPreferencesFileMock.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: ['mkt-1/my-plugin'],
      });

      const result = await loadMarketplaces();

      const plugin = result.data?.marketplaces
        .find((m) => m.id === 'mkt-1')
        ?.plugins.find((p) => p.name === 'My-Plugin');
      expect(plugin?.codexCompatDisabled).toBe(true);
    });

    it('sets codexCompatDisabled=false for plugins not in the disabled list', async () => {
      mockCompatCapableCacheReads();
      readPreferencesFileMock.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: [],
      });

      const result = await loadMarketplaces();

      const plugin = result.data?.marketplaces
        .find((m) => m.id === 'mkt-1')
        ?.plugins.find((p) => p.name === 'My-Plugin');
      expect(plugin?.codexCompatDisabled).toBe(false);
    });

    it('does not write the derived flag back into the persisted cache', async () => {
      mockCompatCapableCacheReads();
      readPreferencesFileMock.mockResolvedValue({
        ...DEFAULT_PREFERENCES,
        codexCompatDisabledPlugins: ['mkt-1/my-plugin'],
      });

      await loadMarketplaces();

      // The version-2 fast path must not rewrite the cache at all.
      expect(writeFileSyncMock).not.toHaveBeenCalled();
    });
  });
});

describe('curated marketplace', () => {
  const CURATED_CLAUDE_MANIFEST = `${CURATED_MARKETPLACE_DIR}/.claude-plugin/marketplace.json`;
  const CURATED_CODEX_MANIFEST = `${CURATED_MARKETPLACE_DIR}/.agents/plugins/marketplace.json`;

  /**
   * Serves a materialized curated marketplace (one plugin with both provider
   * facets) alongside the bundled built-in marketplace.
   */
  function mockCuratedMarketplaceReads(
    options: {
      cachedMarketplaces?: unknown[];
      builtInProviderLedger?: unknown;
      knownMarketplaces?: unknown;
      lastProviderRefreshAt?: string;
      cacheInitiallyMissing?: boolean;
      curatedMarketplaceExists?: boolean;
    } = {},
  ): void {
    let persistedCache: string | null = null;
    if (options.cacheInitiallyMissing) {
      writeFileSyncMock.mockImplementation((target, data) => {
        if (String(target).endsWith('plugins-cache.json')) {
          if (typeof data !== 'string') {
            throw new Error('Expected the plugin cache payload to be text.');
          }
          persistedCache = data;
        }
      });
    }
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.endsWith('plugins-cache.json')) {
        if (options.cacheInitiallyMissing) {
          if (persistedCache === null) {
            throw new Error(`missing plugin cache: ${filePath}`);
          }
          return persistedCache;
        }
        return JSON.stringify({
          version: 2,
          lastRefreshed: '2026-05-01T00:00:00.000Z',
          ...(options.lastProviderRefreshAt
            ? { lastProviderRefreshAt: options.lastProviderRefreshAt }
            : {}),
          marketplaces: options.cachedMarketplaces ?? [],
        });
      }
      if (filePath.endsWith('plugin-cache-index.json')) {
        return JSON.stringify({ version: 1, entries: {} });
      }
      if (
        filePath === '/mock/resources/plugins/.claude-plugin/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [{ name: 'built-in', source: './claude-plugins/built-in' }],
        });
      }
      if (
        filePath === '/mock/resources/plugins/.agents/plugins/marketplace.json'
      ) {
        return JSON.stringify({
          name: 'canopy-plugins',
          plugins: [
            {
              name: 'built-in',
              source: { source: 'local', path: './codex-plugins/built-in' },
            },
          ],
        });
      }
      if (
        options.curatedMarketplaceExists === false &&
        filePath.startsWith(CURATED_MARKETPLACE_DIR)
      ) {
        throw new Error(`missing curated marketplace: ${filePath}`);
      }
      if (filePath === CURATED_CLAUDE_MANIFEST) {
        return JSON.stringify({
          name: 'canopy-curated',
          version: '1.0.0',
          plugins: [
            {
              name: 'team-tools',
              description: 'Team tools',
              version: '3.1.0',
              source: './team-tools',
            },
          ],
        });
      }
      if (filePath === CURATED_CODEX_MANIFEST) {
        return JSON.stringify({
          name: 'canopy-curated',
          interface: { displayName: 'Canopy Curated Marketplace' },
          plugins: [
            {
              name: 'team-tools',
              source: { source: 'local', path: './team-tools' },
            },
          ],
        });
      }
      if (filePath.startsWith(`${CURATED_MARKETPLACE_DIR}/team-tools/`)) {
        return JSON.stringify({
          name: 'team-tools',
          version: '3.1.0',
          description: 'Team tools',
          interface: { displayName: 'Team Tools' },
        });
      }
      if (filePath.endsWith('.claude-plugin/plugin.json')) {
        return JSON.stringify({ name: 'built-in', version: '1.0.0' });
      }
      if (filePath.endsWith('.codex-plugin/plugin.json')) {
        return JSON.stringify({ name: 'built-in', version: '1.0.0' });
      }
      if (filePath.endsWith('known_marketplaces.json')) {
        return JSON.stringify(options.knownMarketplaces ?? {});
      }
      if (filePath.endsWith('built-in-plugin-marketplaces.json')) {
        return JSON.stringify(
          options.builtInProviderLedger ?? { version: 1, entries: [] },
        );
      }
      throw new Error(`unexpected read: ${filePath}`);
    });
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      return (
        (filePath.startsWith('/mock/resources/plugins') ||
          (filePath.startsWith(CURATED_MARKETPLACE_DIR) &&
            options.curatedMarketplaceExists !== false)) &&
        !filePath.endsWith('installed_plugins.json') &&
        !filePath.endsWith('settings.json')
      );
    });
  }

  /** Claude's registration of a managed marketplace at its managed root. */
  function managedClaudeRegistration(
    name: string,
    root: string,
  ): Record<string, unknown> {
    return {
      [name]: {
        source: { source: 'directory', path: root },
        installLocation: root,
        lastUpdated: '2026-05-01T00:00:00.000Z',
      },
    };
  }

  function curatedClaudeRegistration(): Record<string, unknown> {
    return managedClaudeRegistration('canopy-curated', CURATED_MARKETPLACE_DIR);
  }

  function builtInClaudeRegistration(): Record<string, unknown> {
    return managedClaudeRegistration(
      'canopy-plugins',
      '/mock/resources/plugins',
    );
  }

  function curatedCacheRow(): Record<string, unknown> {
    return {
      id: 'curated/cloud',
      name: 'Stale Curated',
      sourceType: 'curated',
      sourceUrl: 'curated:cloud',
      installLocation: CURATED_MARKETPLACE_DIR,
      curated: true,
      removable: false,
      pluginCount: 0,
      plugins: [],
      providerStatus: {
        claude: { provider: 'claude', state: 'invalid', accepted: false },
        codex: { provider: 'codex', state: 'invalid', accepted: false },
      },
      validProviders: [],
    };
  }

  it('serializes background provider nudges across curated sync entry points', async () => {
    mockCuratedMarketplaceReads({
      knownMarketplaces: curatedClaudeRegistration(),
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: ['team-tools'],
      changed: [],
      removed: [],
      errors: [],
    });
    let activeProviderUpdates = 0;
    let maxConcurrentProviderUpdates = 0;
    mockExecFileAsync.mockImplementation(async () => {
      activeProviderUpdates += 1;
      maxConcurrentProviderUpdates = Math.max(
        maxConcurrentProviderUpdates,
        activeProviderUpdates,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeProviderUpdates -= 1;
      return { stdout: '', stderr: '' };
    });

    await Promise.all([
      syncCuratedPluginsForRefresh({ providerNudge: 'background' }),
      syncCuratedPluginsForRefresh({ providerNudge: 'background' }),
    ]);
    await flushUntil(
      () =>
        mockExecFileAsync.mock.calls.length === 2 &&
        activeProviderUpdates === 0,
    );

    expect(maxConcurrentProviderUpdates).toBe(1);
  });

  it('preserves first-load provider discovery when curated sync runs before a cache exists', async () => {
    mockCuratedMarketplaceReads({
      cacheInitiallyMissing: true,
      knownMarketplaces: {},
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: ['team-tools'],
      changed: [],
      removed: [],
      errors: [],
    });

    await syncCuratedPluginsForRefresh();
    await syncCuratedPluginsForRefresh();
    await loadMarketplaces();

    expect(readFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/known_marketplaces\.json$/),
      'utf-8',
    );
  });

  it('creates a cache for cache-only onboarding reads after a fresh-install sync', async () => {
    mockCuratedMarketplaceReads({
      cacheInitiallyMissing: true,
      knownMarketplaces: {},
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: ['team-tools'],
      changed: [],
      removed: [],
      errors: [],
    });

    await syncCuratedPluginsForRefresh();

    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [{ id: 'curated/cloud', pluginCount: 1 }],
    });
  });

  it('persists the post-sync curated row before cache-only consumers rebuild', async () => {
    mockCuratedMarketplaceReads({
      cachedMarketplaces: [
        { ...curatedCacheRow(), id: 'external/tools', curated: false },
        curatedCacheRow(),
      ],
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: ['team-tools'],
      changed: [],
      removed: [],
      errors: [],
    });

    await syncCuratedPluginsForRefresh();

    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [
        { id: 'external/tools' },
        { id: 'curated/cloud', pluginCount: 1 },
      ],
    });
  });

  it('removes the cached curated row when the post-sync scan is empty', async () => {
    mockCuratedMarketplaceReads({
      cachedMarketplaces: [
        { ...curatedCacheRow(), id: 'external/tools', curated: false },
        curatedCacheRow(),
      ],
      curatedMarketplaceExists: false,
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: [],
      changed: [],
      removed: ['team-tools'],
      errors: [],
    });

    await syncCuratedPluginsForRefresh();

    expect(readLastWrittenJson()).toMatchObject({
      version: 2,
      marketplaces: [{ id: 'external/tools' }],
    });
  });

  it('records the initial catalog without changing legacy selections', async () => {
    mockCuratedMarketplaceReads();
    const legacy = {
      ...DEFAULT_PREFERENCES,
      initializedCuratedPluginDefaults: undefined,
      globalPluginSelections: {
        collectionIds: ['custom'],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'external/tools', pluginName: 'custom' }],
      },
    };
    readPreferencesFileMock.mockResolvedValue(legacy);
    await loadMarketplaces();
    const updater =
      updatePreferencesFileMock.mock.calls[
        updatePreferencesFileMock.mock.calls.length - 1
      ]?.[0];
    expect(updater).toBeDefined();
    if (!updater) throw new Error('Expected curated defaults update');
    expect(updater(legacy)).toEqual({
      initializedCuratedPluginDefaults: ['team-tools'],
    });
  });

  it('keeps a successful catalog load when default persistence fails', async () => {
    mockCuratedMarketplaceReads();
    updatePreferencesFileMock.mockRejectedValueOnce(new Error('disk full'));
    const result = await loadMarketplaces();
    expect(result.success).toBe(true);
    expect(
      result.data?.marketplaces.some((entry) => entry.id === 'curated/cloud'),
    ).toBe(true);
  });

  it('does not initialize defaults from unreadable preferences', async () => {
    mockCuratedMarketplaceReads();
    jest.mocked(peekPreferencesLoadError).mockReturnValue({
      timestamp: '2026-09-15T00:00:00Z',
      reason: 'read',
      message: 'Cannot read preferences',
      filePath: '/mock/data/preferences.json',
    });
    expect((await loadMarketplaces()).success).toBe(true);
    expect(updatePreferencesFileMock).not.toHaveBeenCalled();
  });

  it('enables later catalog additions after legacy migration', async () => {
    mockCuratedMarketplaceReads();
    const migrated = {
      ...DEFAULT_PREFERENCES,
      initializedCuratedPluginDefaults: ['older-plugin'],
    };
    readPreferencesFileMock.mockResolvedValue(migrated);
    await loadMarketplaces();
    const updater =
      updatePreferencesFileMock.mock.calls[
        updatePreferencesFileMock.mock.calls.length - 1
      ]?.[0];
    if (!updater) throw new Error('Expected curated defaults update');
    expect(updater(migrated)).toMatchObject({
      initializedCuratedPluginDefaults: ['older-plugin', 'team-tools'],
      globalPluginSelections: {
        pluginRefs: [
          { marketplaceId: 'curated/cloud', pluginName: 'team-tools' },
        ],
      },
    });
  });

  it('preserves an opt-out when curated defaults were already initialized', async () => {
    mockCuratedMarketplaceReads();
    readPreferencesFileMock.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      initializedCuratedPluginDefaults: ['team-tools'],
    });
    await loadMarketplaces();
    expect(updatePreferencesFileMock).not.toHaveBeenCalled();
  });

  it('initializes defaults on an unchanged catalog sync', async () => {
    mockCuratedMarketplaceReads();
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'noop',
      added: [],
      changed: [],
      removed: [],
      errors: [],
    });
    await syncCuratedPluginsForRefresh();
    expect(updatePreferencesFileMock).toHaveBeenCalled();
  });

  it('enables already materialized curated plugins without a provider install', async () => {
    mockCuratedMarketplaceReads();
    await loadMarketplaces();
    const updater =
      updatePreferencesFileMock.mock.calls[
        updatePreferencesFileMock.mock.calls.length - 1
      ]?.[0];
    expect(updater).toBeDefined();
    if (!updater) throw new Error('Expected curated defaults update');
    expect(
      updater({
        ...DEFAULT_PREFERENCES,
        initializedCuratedPluginDefaults: ['team-tools'],
      }),
    ).toEqual({});
    const updatedPreferences = await updater({
      ...DEFAULT_PREFERENCES,
      globalPluginSelections: {
        collectionIds: ['custom'],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'external/tools', pluginName: 'custom' }],
      },
    });
    if (!updatedPreferences) {
      throw new Error('Expected curated defaults update');
    }
    expect(updatedPreferences.globalPluginSelections).toMatchObject({
      collectionIds: ['custom'],
      pluginRefs: [
        { marketplaceId: 'external/tools', pluginName: 'custom' },
        { marketplaceId: 'curated/cloud', pluginName: 'team-tools' },
      ],
    });

    expect(updater(DEFAULT_PREFERENCES)).toMatchObject({
      globalPluginSelections: {
        pluginRefs: [
          { marketplaceId: 'curated/cloud', pluginName: 'team-tools' },
        ],
      },
      initializedCuratedPluginDefaults: ['team-tools'],
    });
  });

  it('merges the curated marketplace after the built-in row on load', async () => {
    mockCuratedMarketplaceReads();

    const result = await loadMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
      'curated/cloud',
    ]);
    expect(result.data?.marketplaces[1]).toMatchObject({
      id: 'curated/cloud',
      name: 'Canopy Curated Marketplace',
      sourceType: 'curated',
      sourceUrl: 'curated:cloud',
      installLocation: CURATED_MARKETPLACE_DIR,
      builtIn: false,
      curated: true,
      removable: false,
      pluginCount: 1,
      validProviders: ['claude', 'codex'],
    });
    const plugin = result.data?.marketplaces[1]?.plugins[0];
    expect(plugin).toMatchObject({
      name: 'team-tools',
      displayName: 'Team Tools',
      marketplaceId: 'curated/cloud',
      curated: true,
      version: '3.1.0',
    });
    expect(plugin?.builtIn).toBeUndefined();
    expect(plugin?.globalInstallStatus?.claude).toMatchObject({
      available: true,
      installed: false,
    });
    expect(plugin?.globalInstallStatus?.codex).toMatchObject({
      available: true,
      installed: false,
    });
  });

  it('preserves the curated flag on a cache-only read', async () => {
    mockCuratedMarketplaceReads({
      cachedMarketplaces: [
        {
          ...curatedCacheRow(),
          pluginCount: 1,
          plugins: [
            {
              name: 'team-tools',
              sourcePath: './team-tools',
              marketplaceId: 'curated/cloud',
              curated: true,
              providerSupport: { claude: 'native', codex: 'native' },
              facets: {},
            },
          ],
        },
      ],
    });

    const result = await loadMarketplacesCacheOnly();

    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'curated/cloud',
      curated: true,
      removable: false,
      sourceType: 'curated',
    });
    expect(result.data?.marketplaces[0]?.plugins[0]?.curated).toBe(true);
    expect(listCodexPluginsMock).not.toHaveBeenCalled();
  });

  it('never feeds the cached curated row into the provider source upsert loop', async () => {
    mockCuratedMarketplaceReads({ cachedMarketplaces: [curatedCacheRow()] });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    // The stale cached row was replaced by the freshly scanned one.
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
      'curated/cloud',
    ]);
    expect(result.data?.marketplaces[1]).toMatchObject({
      name: 'Canopy Curated Marketplace',
      pluginCount: 1,
    });
  });

  it('does not surface a second row when known_marketplaces.json already lists the curated marketplace by name', async () => {
    mockCuratedMarketplaceReads({
      knownMarketplaces: {
        'canopy-curated': {
          source: { source: 'directory', path: CURATED_MARKETPLACE_DIR },
          installLocation: CURATED_MARKETPLACE_DIR,
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
      'curated/cloud',
    ]);
    // The managed registration only receives its periodic nudge; nothing is
    // added or removed.
    expect(
      mockExecFileAsync.mock.calls.map((call: unknown[]): unknown => call[1]),
    ).toEqual([['plugin', 'marketplace', 'update', 'canopy-curated']]);
  });

  it('does not surface a second row when Codex lists the managed curated marketplace', async () => {
    mockCuratedMarketplaceReads();
    listCodexPluginsMock.mockResolvedValue({
      marketplaces: [
        mockCodexMarketplaceEntry({
          name: 'canopy-curated',
          path: CURATED_CODEX_MANIFEST,
          plugins: [],
        }),
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
      'curated/cloud',
    ]);
    expect(addCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
  });

  it('still surfaces a known_marketplaces entry that reuses the curated name but points at a different, real location', async () => {
    mockCuratedMarketplaceReads({
      knownMarketplaces: {
        'canopy-curated': {
          source: { source: 'directory', path: '/mock/external/clone' },
          installLocation: '/mock/external/clone',
          lastUpdated: '2026-05-01T00:00:00.000Z',
        },
      },
    });
    const baseReadFileSync = readFileSyncMock.getMockImplementation();
    readFileSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath === '/mock/external/clone/.claude-plugin/marketplace.json') {
        return JSON.stringify({
          name: 'canopy-curated',
          plugins: [{ name: 'clone-plugin', source: './clone-plugin' }],
        });
      }
      return baseReadFileSync?.(target) ?? actualFs.readFileSync(target);
    });
    const baseExistsSync = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      if (filePath.startsWith('/mock/external/clone')) {
        return true;
      }
      return baseExistsSync?.(target) ?? false;
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    // A distinct, real location keeps its own row alongside the built-in
    // and curated ones instead of being silently dropped just because it
    // shares the curated marketplace's reserved name.
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'canopy-curated',
      'builtin/app',
      'curated/cloud',
    ]);
    expect(result.data?.marketplaces[0]).toMatchObject({
      id: 'canopy-curated',
      pluginCount: 1,
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'update', 'canopy-curated'],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it('piggybacks the curated sync on refresh without nudging providers on a no-op', async () => {
    mockCuratedMarketplaceReads();

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(syncCuratedPluginsMock).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
  });

  it('nudges only the providers that registered the curated marketplace after a sync', async () => {
    mockCuratedMarketplaceReads({
      knownMarketplaces: curatedClaudeRegistration(),
      builtInProviderLedger: {
        version: 1,
        entries: [
          {
            provider: 'codex',
            marketplaceName: 'canopy-plugins',
            sourceRoot: '/mock/resources/plugins',
            brandId: 'canopy',
            recordedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    });
    syncCuratedPluginsMock.mockResolvedValue({
      status: 'synced',
      added: ['team-tools'],
      changed: [],
      removed: [],
      errors: [],
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'update', 'canopy-curated'],
      expect.objectContaining({ timeout: 60_000 }),
    );
    // Managed Codex marketplaces are local, scan-only catalogs. The later
    // provider scan observes their current contents without a Git upgrade.
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
    // The curated sync already nudged Claude for the curated marketplace, and
    // Claude has no built-in registration here, so that single
    // update is the ONLY Claude shell-out: the periodic managed nudge must not
    // re-run the curated one.
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it('periodically nudges the managed marketplaces even when nothing synced', async () => {
    // The managed marketplaces are excluded from the known_marketplaces
    // source loop, so this stale-gated nudge is their only periodic provider
    // update — and `updateMarketplace` refuses them, so there is no manual
    // heal either.
    mockCuratedMarketplaceReads({
      knownMarketplaces: builtInClaudeRegistration(),
      builtInProviderLedger: {
        version: 1,
        entries: [
          {
            provider: 'codex',
            marketplaceName: 'canopy-curated',
            sourceRoot: CURATED_MARKETPLACE_DIR,
            brandId: 'canopy',
            recordedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(syncCuratedPluginsMock).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'marketplace', 'update', 'canopy-plugins'],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
  });

  it('skips the periodic managed nudge while the provider stamp is fresh', async () => {
    mockCuratedMarketplaceReads({
      lastProviderRefreshAt: new Date().toISOString(),
      knownMarketplaces: builtInClaudeRegistration(),
      builtInProviderLedger: {
        version: 1,
        entries: [
          {
            provider: 'codex',
            marketplaceName: 'canopy-curated',
            sourceRoot: CURATED_MARKETPLACE_DIR,
            brandId: 'canopy',
            recordedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await refreshMarketplaces(undefined, {
      providerUpdates: 'if-stale',
    });

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(upgradeCodexMarketplaceMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the curated sync throws', async () => {
    mockCuratedMarketplaceReads();
    syncCuratedPluginsMock.mockRejectedValue(new Error('cloud unreachable'));

    const result = await refreshMarketplaces();

    expect(result.success).toBe(true);
    expect(result.data?.marketplaces.map((entry) => entry.id)).toEqual([
      'builtin/app',
      'curated/cloud',
    ]);
  });

  it('rejects removing the curated marketplace', async () => {
    const result = await removeMarketplace('curated/cloud');

    expect(result).toEqual({
      success: false,
      error:
        'The curated marketplace is managed by Canopy and cannot be removed.',
    });
    expect(removeCodexMarketplaceMock).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('rejects updating the curated marketplace', async () => {
    const result = await updateMarketplace('curated/cloud');

    expect(result).toEqual({
      success: false,
      error:
        'The curated marketplace is managed by Canopy and updates automatically.',
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('installs a curated plugin through the curated marketplace registration', async () => {
    mockCuratedMarketplaceReads();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    addCodexMarketplaceMock.mockResolvedValue({
      accepted: true,
      marketplaceName: 'canopy-curated',
      installedRoot: '/mock/codex/canopy-curated',
    });

    const result = await installBuiltInPlugin({
      marketplaceId: 'curated/cloud',
      pluginName: 'team-tools',
      providers: ['claude', 'codex'],
    });

    expect(result.success).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      [
        'plugin',
        'marketplace',
        'add',
        CURATED_MARKETPLACE_DIR,
        '--scope',
        'user',
      ],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/mock/claude',
      ['plugin', 'install', 'team-tools@canopy-curated', '--scope', 'user'],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(addCodexMarketplaceMock).toHaveBeenCalledWith(
      CURATED_MARKETPLACE_DIR,
      expect.any(Object),
    );
    // Same contract as the built-in path: a locally managed curated
    // marketplace is addressed by its manifest, never by a remote name.
    expect(installCodexPluginMock).toHaveBeenCalledWith({
      remoteMarketplaceName: null,
      marketplacePath: `${CURATED_MARKETPLACE_DIR}/.agents/plugins/marketplace.json`,
      pluginName: 'team-tools',
    });
    expect(result.data?.plugin).toMatchObject({
      name: 'team-tools',
      curated: true,
    });
    // The refreshed curated row replaces only itself in the cache.
    const written = readLastWrittenJson();
    expect(written).toMatchObject({
      version: 2,
      marketplaces: [{ id: 'curated/cloud', curated: true, pluginCount: 1 }],
    });
  });

  it('rejects managed installs for a marketplace that is neither built-in nor curated', async () => {
    const result = await installBuiltInPlugin({
      marketplaceId: 'acme/plugins',
      pluginName: 'team-tools',
      providers: ['claude'],
    });

    expect(result).toEqual({
      success: false,
      error:
        'Built-in plugin installs require the built-in or curated marketplace.',
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe('recordBuiltInPluginInstallError', () => {
  const checkedAt = '2026-10-09T00:00:00.000Z';
  function curatedMarketplaceWithSlack(): unknown {
    return {
      id: 'curated/cloud',
      name: 'canopy-curated',
      sourceType: 'curated',
      sourceUrl: '',
      installLocation: CURATED_MARKETPLACE_DIR,
      lastUpdated: checkedAt,
      pluginCount: 1,
      plugins: [
        {
          name: 'slack',
          sourcePath: `${CURATED_MARKETPLACE_DIR}/slack`,
          marketplaceId: 'curated/cloud',
          curated: true,
          providerSupport: { claude: 'native', codex: 'native' },
          facets: {},
          globalInstallStatus: {
            checkedAt,
            claude: { available: true, installed: true, enabled: true },
            codex: { available: true, installed: false, version: '1.2.0' },
          },
        },
      ],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: checkedAt,
        },
        codex: {
          provider: 'codex',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: checkedAt,
        },
      },
      validProviders: ['claude', 'codex'],
    };
  }

  it('keeps a failed provider install on the cached plugin and leaves the rest alone', async () => {
    const readCacheState = mockMarketplaceCache([
      curatedMarketplaceWithSlack(),
    ]);

    await recordBuiltInPluginInstallError(
      { marketplaceId: 'curated/cloud', pluginName: 'slack' },
      'codex',
      'marketplace refused',
    );

    expect(readCacheState()).toMatchObject({
      marketplaces: [
        {
          plugins: [
            {
              name: 'slack',
              globalInstallStatus: {
                checkedAt,
                claude: { available: true, installed: true, enabled: true },
                codex: {
                  available: true,
                  installed: false,
                  version: '1.2.0',
                  installError: 'marketplace refused',
                },
              },
            },
          ],
        },
      ],
    });
  });

  it('writes nothing for a plugin the cache does not have', async () => {
    mockMarketplaceCache([curatedMarketplaceWithSlack()]);

    await recordBuiltInPluginInstallError(
      { marketplaceId: 'curated/cloud', pluginName: 'missing' },
      'codex',
      'marketplace refused',
    );

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('installed-item provider and cache boundaries', () => {
  it.each(['mkt-a', 'registered', 'Display name'])(
    'retains an unambiguous Claude installation under %s',
    (name) => {
      const marketplace = {
        id: 'mkt-a',
        name: 'Display name',
        providerStatus: { claude: { marketplaceName: 'registered' } },
        plugins: [{ name: 'alpha' }],
      };
      const id = `alpha@${name}`;
      readFileSyncMock.mockImplementation((target) =>
        String(target).endsWith('installed_plugins.json')
          ? JSON.stringify({
              version: 2,
              plugins: { [id]: [{ scope: 'user' }] },
            })
          : '{}',
      );
      expect(
        readClaudeInstalledItemState(marketplace, 'alpha', [marketplace]),
      ).toEqual({ ids: [id], enabled: true });
    },
  );

  it('does not claim another marketplace installation through a display-name collision', () => {
    const owner = { id: 'mkt-a', plugins: [{ name: 'alpha' }] };
    const other = {
      id: 'mkt-b',
      name: 'mkt-a',
      plugins: [{ name: 'alpha' }],
    };
    readFileSyncMock.mockImplementation((target) =>
      String(target).endsWith('installed_plugins.json')
        ? JSON.stringify({
            version: 2,
            plugins: { 'alpha@mkt-a': [{ scope: 'user' }] },
          })
        : JSON.stringify({ enabledPlugins: { 'alpha@mkt-a': false } }),
    );
    for (const catalog of [
      [owner, other],
      [other, owner],
    ]) {
      expect(readClaudeInstalledItemState(owner, 'ALPHA', catalog)).toEqual({
        ids: ['alpha@mkt-a'],
        enabled: false,
      });
      expect(readClaudeInstalledItemState(other, 'alpha', catalog)).toEqual({
        ids: [],
        enabled: true,
      });
    }
  });

  it('refuses ambiguous provider aliases instead of handing them to status or uninstall', () => {
    const first = {
      id: 'mkt-a',
      name: 'shared',
      plugins: [{ name: 'alpha' }],
    };
    const second = { ...first, id: 'mkt-b' };
    readFileSyncMock.mockImplementation((target) =>
      String(target).endsWith('installed_plugins.json')
        ? JSON.stringify({
            version: 2,
            plugins: { 'alpha@shared': [{ scope: 'user' }] },
          })
        : '{}',
    );
    for (const marketplace of [first, second]) {
      expect(() =>
        readClaudeInstalledItemState(marketplace, 'alpha', [first, second]),
      ).toThrow('Claude marketplace identity is ambiguous');
    }
    expect(mockRunClaudeCliProcessOffMain).not.toHaveBeenCalled();
  });

  it('refuses reinstall while a previous uninstall still owns cleanup', async () => {
    readPreferencesFileMock.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      pendingInstalledItemUninstalls: [
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'market',
            pluginName: 'plugin',
          },
          refs: [
            { kind: 'plugin', marketplaceId: 'market', pluginName: 'plugin' },
          ],
        },
      ],
    });
    const result = await installPlugin(
      'market',
      'Plugin',
      'https://example.test/plugin.git',
    );
    expect(result).toMatchObject({
      success: false,
      error: 'Finish uninstalling this plugin before adding it again.',
    });
  });
  it('clears provider installation flags and managed paths after confirmed removal', async () => {
    existsSyncMock.mockReturnValue(true);
    mockMarketplaceCache([
      {
        id: 'market',
        plugins: [
          {
            name: 'Plugin',
            cachePath: '/mock/data/plugin-cache/plugin',
            details: { skills: [], commands: [] },
            facets: {
              claude: {
                cachePath: '/mock/data/plugin-cache/plugin',
                details: { skills: [], commands: [] },
              },
            },
            globalInstallStatus: {
              claude: { installed: true, available: true },
              codex: { installed: true, available: true },
            },
          },
        ],
      },
    ]);
    await removeInstalledPluginCache('market', 'plugin');
    expect(readLastWrittenJson()).toMatchObject({
      marketplaces: [
        {
          plugins: [
            {
              globalInstallStatus: {
                claude: { installed: false },
                codex: { installed: false },
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(readLastWrittenJson())).not.toContain('cachePath');
    expect(JSON.stringify(readLastWrittenJson())).not.toContain('"details"');
  });
  it('uses the bundled Claude environment with explicit user scope and keeps persistent data on uninstall', async () => {
    await setClaudeInstalledItemEnabled('plugin@provider-name', false);
    await uninstallClaudeInstalledItem('plugin@provider-name');
    expect(mockRunClaudeCliProcessOffMain).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['plugin', 'disable', 'plugin@provider-name', '--scope', 'user'],
        env: {},
      }),
    );
    expect(mockRunClaudeCliProcessOffMain).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'plugin',
          'uninstall',
          'plugin@provider-name',
          '--scope',
          'user',
          '--keep-data',
        ],
        env: {},
      }),
    );
  });
  it('refuses an external source directory even when a corrupted cache index names it', async () => {
    getPluginCacheDirMock.mockReturnValue('/mock/data/plugin-cache');
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation((target) =>
      String(target).endsWith('plugin-cache-index.json')
        ? JSON.stringify({
            version: 1,
            entries: {
              'market/Plugin': {
                cachePath: '/external/source',
                sourceUrl: 'local',
                cachedAt: '',
              },
            },
          })
        : JSON.stringify({ version: 2, lastRefreshed: '', marketplaces: [] }),
    );
    await expect(
      removeInstalledPluginCache('market', 'plugin'),
    ).rejects.toThrow('outside its managed directory');
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});
