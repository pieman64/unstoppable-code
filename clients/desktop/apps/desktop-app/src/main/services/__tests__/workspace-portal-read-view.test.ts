// CAN-5578: real W5 repositories/worker, with both desktop store bindings.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import { W5AuthorityUnreachableError } from '@canopy/core-runtime/node/w5/file-store';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as PreferencesStore from '../../lib/preferences-store';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (daemon: boolean): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] =
          daemon &&
          ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
            row.id,
          )
            ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
            : row;
      });
    },
  };
});
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
  isCanopyPortalActive: (): boolean => false,
}));
jest.mock('../sidebar-item-groups-service', () => ({
  projectSidebarItemGroups: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../worktree-runtime-status-service', () => ({
  getWorktreeRuntimeStatuses: jest.fn(() => Promise.resolve(new Map())),
}));
jest.mock('../worktree-diff-stats-cache', () => ({
  getCachedWorktreeDiffStats: jest.fn(() => ({ insertions: 3, deletions: 1 })),
}));
jest.mock('../project-avatar-cache', () => ({
  readProjectAvatarUrl: jest.fn(),
  retainProjectAvatarRepoPaths: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStore>(
    '../../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: jest.fn(() =>
      Promise.resolve(actual.DEFAULT_PREFERENCES),
    ),
  };
});

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled(): boolean } => ({
    isEnabled: (): boolean => false,
  }),
}));
jest.mock('../org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));
jest.mock('../worktree-chat-summary-batch', () => ({
  listWorktreeChatSummaryBatch: jest.fn(() => Promise.resolve([])),
}));
let mockWorkspaceContext: WorkspaceContext = { kind: 'personal' };
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    getState(): { context: WorkspaceContext };
  } => ({
    getState: (): { context: WorkspaceContext } => ({
      context: mockWorkspaceContext,
    }),
  }),
}));
jest.mock('../../lib/org-cowork-binding-deps', () => ({
  startOrgDefaultCoworkProvisioning: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
}));
jest.mock('../standalone-chat-service', () => ({
  listStandaloneChats: jest.fn(() => Promise.resolve([])),
  projectStandaloneChatSnapshot: jest.fn(),
}));
// Keep project discovery real; only non-W5 chat metadata/live state is seeded.
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryChatSummaries: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: (): string[] => [],
  getActiveSessionInfos: (): unknown[] => [],
  getSession: (): undefined => undefined,
}));
jest.mock('../chat-queue-service', () => ({
  getChatQueueService: (): {
    isTurnActive(): boolean;
    getWorktreeSnapshots(): unknown[];
  } => ({
    isTurnActive: (): boolean => false,
    getWorktreeSnapshots: (): unknown[] => [],
  }),
}));
jest.mock('../chat-state-service', () => ({
  getChatStateService: (): { getTurnState(): undefined } => ({
    getTurnState: (): undefined => undefined,
  }),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: (): undefined => undefined,
}));

import type {
  PortalSessionShellState,
  WorktreeData,
  WorkspaceIndexEntry,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import {
  startW5DaemonRecordHarness,
  type W5DaemonRecordHarness,
} from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { selectW5ConfinementAddon } from '../../w5-commit-log/confinement-addon';
import * as w5 from '../../lib/w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../../lib/w5-daemon-record-store';
import { nodeW5FileStore } from '../../lib/w5-file-store';
import {
  createW5DegradedStore,
  W5DaemonHandoffError,
} from '../../lib/w5-handoff-store';
import { assertOutsideW5ReadView } from '../../lib/w5-read-view';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItemsSnapshot,
} from '../../lib/sidebar-items';
import {
  withW5ProjectionOnlyRead,
  W5_PROJECTION_ONLY_READ,
} from '../../lib/w5-fallback-read';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktreesDetailed,
  updateWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import { buildDesktopSessionSnapshot } from '../desktop-session-snapshot-service';
import * as standalone from '../standalone-chat-service';
import * as portalWorkspace from '../workspace-portal-service';
import * as coworkRecords from '../../lib/cowork-workspace-records';
import * as workOwner from '../../agents/work-owner';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { listWorkEntryChatSummaries } from '../../lib/cowork-work-entries';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { startOrgDefaultCoworkProvisioning } from '../../lib/org-cowork-binding-deps';
import { sendToAllWindows } from '../../lib/window-send';
import {
  readPreferencesFile,
  DEFAULT_PREFERENCES,
} from '../../lib/preferences-store';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';

const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (daemon: boolean) => void;
}>('@canopy/core-runtime/storage');
jest.setTimeout(60_000);
let dir: string;
let root: string;
let createdAt: string;
let incarnation = 0;
const originalDataDir = process.env.CANOPY_DATA_DIR;
const listPath = (): string => join(root, 'code-0', 'worktrees.json');
const rows = (): WorktreeData[] =>
  [0, 1].map(
    (id): WorktreeData => ({
      id: `row-${id}`,
      branchName: `feature/row-${id}`,
      label: `Label ${id}`,
      createdAt,
      status: 'active',
      ...(id === 1 ? { pinned: true } : {}),
    }),
  );

beforeEach(() => {
  workOwner.__resetSessionWorkOwnersForTests();
  mockWorkspaceContext = { kind: 'personal' };
  jest.mocked(startOrgDefaultCoworkProvisioning).mockClear();
  jest.mocked(sendToAllWindows).mockClear();
  jest.mocked(readPreferencesFile).mockImplementation(() => {
    expect(assertOutsideW5ReadView).not.toThrow();
    return Promise.resolve(DEFAULT_PREFERENCES);
  });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'portal-read-view-')));
  root = join(dir, 'workspaces');
  process.env.CANOPY_DATA_DIR = dir;
  createdAt = new Date(Date.UTC(2026, 10, 2) + incarnation++).toISOString();
  const entries: WorkspaceIndexEntry[] = Array.from(
    { length: 26 },
    (_, order) => ({
      id: order === 25 ? DEFAULT_COWORK_WORKSPACE_ID : `code-${order}`,
      name: `Workspace ${order}`,
      type:
        order === 25 ? 'cowork' : order === 24 ? 'multi-repo' : 'single-repo',
      order,
      collapsed: order === 2,
      color: '#7C3AED',
    }),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({ version: 1, workspaces: entries }),
  );
  for (const entry of entries) {
    mkdirSync(join(root, entry.id));
    writeFileSync(
      join(root, entry.id, 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: entry.type,
        repoPath: join(dir, 'repo'),
        repos:
          entry.type === 'multi-repo'
            ? [{ id: 'repo-a', name: 'Repo A', repoPath: join(dir, 'repo') }]
            : [],
        itemSortMode: 'manual',
        archiveRetentionDays: 14,
      }),
    );
    writeFileSync(
      join(root, entry.id, 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: entry.type === 'cowork' ? [] : rows(),
      }),
    );
  }
  __resetSidebarItemsStateForTests();
  w5.__setDesktopW5FileStoreForTests(nodeW5FileStore);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(standalone.listStandaloneChats).mockReset().mockResolvedValue([]);
  jest.mocked(standalone.projectStandaloneChatSnapshot).mockReset();
  jest.mocked(listWorkEntryChatSummaries).mockReset();
  setDaemonOwnedForTest(false);
  w5.__setDesktopW5FileStoreForTests(nodeW5FileStore);
  __resetSidebarItemsStateForTests();
  registerWorkspaceTypes(new Map());
  registerWorkspaceExternalPaths(new Map());
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

// Legacy oracle: independent live discovery for both consumers, using the
// production readers and projections over the same files.
async function golden(): Promise<Awaited<ReturnType<typeof snapshot>>> {
  const view = jest
    .spyOn(w5, 'runW5ReadView')
    .mockImplementation((_request, work) =>
      work({ status: 'uncaptured', reason: 'direct-store' }),
    );
  const listEntities = portalWorkspace.listWorkspacePortalEntities;
  const entities = jest
    .spyOn(portalWorkspace, 'listWorkspacePortalEntities')
    .mockImplementation((target, options) =>
      listEntities(target, { ...options, sidebarSnapshot: undefined }),
    );
  const listStandalone = jest.mocked(standalone.listStandaloneChats);
  const standaloneImplementation = listStandalone.getMockImplementation();
  listStandalone.mockImplementation(
    (options) =>
      standaloneImplementation?.({
        ...options,
        sidebarSnapshot: undefined,
        ownerEvidence: undefined,
      }) ?? Promise.resolve([]),
  );
  try {
    return await snapshot();
  } finally {
    view.mockRestore();
    entities.mockRestore();
    listStandalone.mockImplementation(
      standaloneImplementation ??
        ((): ReturnType<typeof standalone.listStandaloneChats> =>
          Promise.resolve([])),
    );
  }
}
async function snapshot(): Promise<PortalSessionShellState> {
  return buildDesktopSessionSnapshot();
}

async function withStore(
  side: 'in-process' | 'daemon',
  work: (
    host: W5CommitLogHost,
    store: w5.W5CommitLogFileStore,
  ) => Promise<void>,
): Promise<void> {
  // Jest has no build-time source directory; anchor the dev addon to this checkout.
  const confinementAddon = selectW5ConfinementAddon({
    os: process.platform === 'win32' ? 'win32' : null,
    runtimeMode: 'dev',
    arch: process.arch,
    resourcesPath: undefined,
    sourceDirectory: join(
      __dirname,
      '../../../../../../.cache/native-owned-child',
    ),
  });
  if (
    process.platform === 'win32' &&
    windowsW5ConfinedFileReader('win32', confinementAddon)() === null
  )
    throw new Error(
      `Windows W5 read-view tests require a loadable readConfinedFile addon at ${confinementAddon ?? '(not selected)'}; run pnpm run build:owned-child before running.`,
    );
  const host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
    confinementAddon,
  });
  let harness: W5DaemonRecordHarness | undefined;
  let restore = (): void => undefined;
  try {
    let store: w5.W5CommitLogFileStore;
    if (side === 'daemon') {
      harness = await startW5DaemonRecordHarness({ host });
      setDaemonOwnedForTest(true);
      store = createW5DaemonRecordStore({
        root,
        transport: w5RecordPortTransport(await harness.connect()),
      });
      restore = installW5DaemonRecordStoreForTests(store);
    } else {
      store = w5.createW5CommitLogFileStore(() => host);
      w5.__setDesktopW5FileStoreForTests(store);
    }
    await work(host, store);
  } finally {
    restore();
    setDaemonOwnedForTest(false);
    w5.__setDesktopW5FileStoreForTests(nodeW5FileStore);
    await harness?.close();
    await host.shutdown();
  }
}

function useRealStandaloneDiscovery(): typeof standalone {
  const actualStandalone = jest.requireActual<typeof standalone>(
    '../standalone-chat-service',
  );
  jest
    .mocked(standalone.listStandaloneChats)
    .mockImplementation(actualStandalone.listStandaloneChats);
  jest
    .mocked(standalone.projectStandaloneChatSnapshot)
    .mockImplementation(actualStandalone.projectStandaloneChatSnapshot);
  jest.mocked(listWorkEntryChatSummaries).mockResolvedValue([
    {
      entryId: 'entry-1',
      title: 'Cowork entry',
      order: 0,
      createdAt,
      chats: [
        {
          id: 'chat-1',
          title: 'Standalone chat',
          createdAt,
          lastMessageAt: createdAt,
          lastMessageRole: 'assistant',
        },
      ],
    },
  ]);
  return actualStandalone;
}

function observeResolvedOwners(): (WorkOwner | undefined)[] {
  const owners: (WorkOwner | undefined)[] = [];
  const createResolver = workOwner.createAiCreditsScopeOwnerResolver;
  jest
    .spyOn(workOwner, 'createAiCreditsScopeOwnerResolver')
    .mockImplementation((evidence) => {
      const resolve = createResolver(evidence);
      return async (scope): Promise<WorkOwner | undefined> => {
        const owner = await resolve(scope);
        owners.push(owner);
        return owner;
      };
    });
  return owners;
}

it.each(['in-process', 'daemon'] as const)(
  '%s: a label write refetch captures once and matches the nonempty golden',
  async (side) => {
    await withStore(side, async (host) => {
      await updateWorkspaceWorktrees('code-0', (current) =>
        current.map((row) =>
          row.id === 'row-0' ? { ...row, label: 'Renamed label' } : row,
        ),
      );
      const expected = await golden();
      expect(expected.workspaces).toHaveLength(26);
      expect(
        new Set(expected.workspaces.map((workspace) => workspace.type)),
      ).toEqual(new Set(['single-repo', 'multi-repo', 'cowork']));
      expect(expected.worktrees).toHaveLength(50);
      expect(expected.worktrees).toContainEqual(
        expect.objectContaining({
          workspaceLocalId: 'code-0',
          localId: 'row-0',
          label: 'Renamed label',
        }),
      );
      const capture = jest.spyOn(host, 'capture');
      const live = jest.spyOn(nodeW5FileStore, 'read');
      expect(await snapshot()).toEqual(expected);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith({
        files: [],
        discoverWorkspaces: true,
      });
      expect(live).not.toHaveBeenCalled();
    });
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: a label refetch shares one capture across both real discovery sweeps',
  async (side) => {
    const actualStandalone = useRealStandaloneDiscovery();
    const owners = observeResolvedOwners();
    expect(
      await workOwner.peekSessionWorkOwner({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: 'entry-1',
        chatId: 'chat-1',
      }),
    ).toBeUndefined();
    await withStore(side, async (host) => {
      await updateWorkspaceWorktrees('code-0', (current) =>
        current.map((row) =>
          row.id === 'row-0' ? { ...row, label: 'Renamed label' } : row,
        ),
      );
      const expected = await golden();
      expect(expected.workspaces).toHaveLength(26);
      expect(expected.worktrees).toHaveLength(50);
      expect(expected.standaloneChats).toEqual([
        expect.objectContaining({
          projectLocalId: DEFAULT_COWORK_WORKSPACE_ID,
          localId: 'chat-1',
          title: 'Standalone chat',
          workEntryId: 'entry-1',
        }),
      ]);
      owners.length = 0;

      const capture = jest.spyOn(host, 'capture');
      const live = jest.spyOn(nodeW5FileStore, 'read');
      const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
      let workspaceEntities = 0;
      let standaloneDiscovery = 0;
      const listWorkspaceEntities = portalWorkspace.listWorkspacePortalEntities;
      const workspaceSweep = jest
        .spyOn(portalWorkspace, 'listWorkspacePortalEntities')
        .mockImplementation(async (...args) => {
          const before = capture.mock.calls.length;
          try {
            return await listWorkspaceEntities(...args);
          } finally {
            workspaceEntities += capture.mock.calls.length - before;
          }
        });
      jest.mocked(standalone.listStandaloneChats).mockClear();
      jest
        .mocked(standalone.listStandaloneChats)
        .mockImplementation(async (...args) => {
          const before = capture.mock.calls.length;
          try {
            return await actualStandalone.listStandaloneChats(...args);
          } finally {
            standaloneDiscovery += capture.mock.calls.length - before;
          }
        });

      const result = await snapshot();
      const total = capture.mock.calls.length;
      const counts = {
        side,
        workspaceEntities,
        standaloneDiscovery,
        outsideDiscovery: total - workspaceEntities - standaloneDiscovery,
        total,
      };
      expect(result).toEqual(expected);
      expect(owners).toEqual([{ kind: 'personal' }]);
      expect(workspaceSweep).toHaveBeenCalledTimes(1);
      expect(standalone.listStandaloneChats).toHaveBeenCalledTimes(1);
      expect(live).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(counts).toEqual({
        side,
        workspaceEntities: 0,
        standaloneDiscovery: 0,
        outsideDiscovery: 1,
        total: 1,
      });
      expect(capture).toHaveBeenCalledWith({
        files: [],
        discoverWorkspaces: true,
      });
    });
  },
);

it.each(['direct', 'handoff-degraded'] as const)(
  '%s: fallback preserves the nonempty golden without writes',
  async (side) => {
    useRealStandaloneDiscovery();
    const expected = await golden();
    expect(expected.standaloneChats).toHaveLength(1);
    const store =
      side === 'direct'
        ? nodeW5FileStore
        : createW5DegradedStore(new W5DaemonHandoffError('daemon_unavailable'));
    w5.__setDesktopW5FileStoreForTests(store);
    const replace = jest.spyOn(store, 'replace');
    expect(await snapshot()).toEqual(expected);
    expect(replace).not.toHaveBeenCalled();
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: malformed owner provenance is omitted without a fresh manifest capture',
  async (side) => {
    useRealStandaloneDiscovery();
    const owners = observeResolvedOwners();
    writeFileSync(
      join(root, DEFAULT_COWORK_WORKSPACE_ID, 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        owner: { type: 'organization', organizationId: 17 },
      }),
    );
    await withStore(side, async (host) => {
      const expected = await golden();
      expect(owners).toEqual([undefined]);
      owners.length = 0;
      const captureFiles = host.capture.bind(host);
      const capture = jest
        .spyOn(host, 'capture')
        .mockImplementationOnce(async (request) => {
          const captured = await captureFiles(request);
          // Another writer repairs provenance after capture. This reply must
          // still omit the owner instead of reading that newer manifest.
          writeFileSync(
            join(root, DEFAULT_COWORK_WORKSPACE_ID, 'workspace.json'),
            JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
          );
          return captured;
        });
      const live = jest.spyOn(nodeW5FileStore, 'read');
      const result = await snapshot();
      expect(result).toEqual(expected);
      expect(result.standaloneChats).toHaveLength(1);
      expect(owners).toEqual([undefined]);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(live).not.toHaveBeenCalled();
    });
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: first-use default provisioning stays outside the shared discovery view',
  async (side) => {
    useRealStandaloneDiscovery();
    const index = Array.from({ length: 25 }, (_, order) => ({
      id: `code-${order}`,
      name: `Workspace ${order}`,
      type: order === 24 ? 'multi-repo' : 'single-repo',
      order,
      color: '#7C3AED',
      collapsed: order === 2,
    }));
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({ version: 1, workspaces: index }),
    );
    rmSync(join(root, DEFAULT_COWORK_WORKSPACE_ID), { recursive: true });
    await withStore(side, async () => {
      const provision = coworkRecords.provisionCoworkWorkspaceRecord;
      let provisioningOutsideView = false;
      const provisioning = jest
        .spyOn(coworkRecords, 'provisionCoworkWorkspaceRecord')
        .mockImplementation((record) => {
          expect(assertOutsideW5ReadView).not.toThrow();
          provisioningOutsideView = true;
          return provision(record);
        });
      const result = await snapshot();
      expect(provisioning).toHaveBeenCalledTimes(1);
      expect(provisioningOutsideView).toBe(true);
      expect(result.workspaces).toHaveLength(25);
      expect(result.standaloneChats).toEqual([
        expect.objectContaining({
          projectLocalId: DEFAULT_COWORK_WORKSPACE_ID,
          localId: 'chat-1',
        }),
      ]);
      const persistedIndex: unknown = JSON.parse(
        readFileSync(join(root, 'index.json'), 'utf8'),
      );
      expect(persistedIndex).toHaveProperty(
        'workspaces',
        expect.arrayContaining([
          expect.objectContaining({ id: DEFAULT_COWORK_WORKSPACE_ID }),
        ]),
      );
      const persistedWorkspace: unknown = JSON.parse(
        readFileSync(
          join(root, DEFAULT_COWORK_WORKSPACE_ID, 'workspace.json'),
          'utf8',
        ),
      );
      expect(persistedWorkspace).toEqual(
        expect.objectContaining({ type: 'cowork' }),
      );
      expect(sendToAllWindows).toHaveBeenCalledWith(
        IPC_CHANNELS.workspaceWorktreesUpdated,
        { workspaceId: DEFAULT_COWORK_WORKSPACE_ID },
      );
      expect((await snapshot()).workspaces).toHaveLength(26);
      expect(provisioning).toHaveBeenCalledTimes(1);
    });
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: organization provisioning is scheduled outside the shared discovery view',
  async (side) => {
    useRealStandaloneDiscovery();
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockWorkspaceContext = { kind: 'organization', organizationId };
    let provisioningOutsideView = false;
    jest.mocked(startOrgDefaultCoworkProvisioning).mockImplementation(() => {
      expect(assertOutsideW5ReadView).not.toThrow();
      provisioningOutsideView = true;
      return Promise.resolve();
    });
    await withStore(side, async (host) => {
      const capture = jest.spyOn(host, 'capture');
      const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
      try {
        expect((await snapshot()).standaloneChats).toHaveLength(1);
      } finally {
        await settleDetachedWork();
      }
      expect(startOrgDefaultCoworkProvisioning).toHaveBeenCalledTimes(1);
      expect(provisioningOutsideView).toBe(true);
      expect(startOrgDefaultCoworkProvisioning).toHaveBeenCalledWith(
        organizationId,
      );
      expect(capture).toHaveBeenCalledTimes(1);
      expect(replace).not.toHaveBeenCalled();
    });
  },
);

it.each(['direct', 'handoff-degraded'] as const)(
  '%s: unreadable discovery never provisions a missing default',
  async (side) => {
    useRealStandaloneDiscovery();
    writeFileSync(join(root, 'index.json'), '{');
    if (side === 'handoff-degraded')
      w5.__setDesktopW5FileStoreForTests(
        createW5DegradedStore(new W5DaemonHandoffError('daemon_unavailable')),
      );
    const provision = jest.spyOn(
      coworkRecords,
      'provisionCoworkWorkspaceRecord',
    );
    const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
    await expect(snapshot()).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    await expect(
      portalWorkspace.listWorkspacePortalEntities(),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    expect(provision).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe('{');
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: unreadable captured storage rejects rather than publishing an empty snapshot',
  async (side) => {
    useRealStandaloneDiscovery();
    mockWorkspaceContext = {
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    writeFileSync(join(root, 'index.json'), '{');
    await withStore(side, async (host) => {
      const capture = jest.spyOn(host, 'capture');
      const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
      const provision = jest.spyOn(
        coworkRecords,
        'provisionCoworkWorkspaceRecord',
      );
      await expect(snapshot()).rejects.toMatchObject({
        payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
      });
      expect(capture).toHaveBeenCalledTimes(1);
      await expect(
        portalWorkspace.listWorkspacePortalEntities(),
      ).rejects.toMatchObject({
        payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
      });
      expect(capture).toHaveBeenCalledTimes(2);
      expect(provision).not.toHaveBeenCalled();
      expect(startOrgDefaultCoworkProvisioning).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe('{');
    });
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: authority loss keeps snapshots fail-closed while Electron disk projections stay effect-free',
  async (side) => {
    useRealStandaloneDiscovery();
    mockWorkspaceContext = {
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    await withStore(side, async (host, store) => {
      const failure = new W5AuthorityUnreachableError('refused', 'lost');
      jest.spyOn(store, 'capture').mockRejectedValue(failure);
      const live = jest.spyOn(nodeW5FileStore, 'read');
      const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
      const commit = jest.spyOn(host, 'commit');
      const provision = jest.spyOn(
        coworkRecords,
        'provisionCoworkWorkspaceRecord',
      );
      await expect(snapshot()).rejects.toBe(failure);
      await expect(portalWorkspace.listWorkspacePortalEntities()).rejects.toBe(
        failure,
      );
      markWorkspaceWorktreeRecentlyRemoved('code-0', 'row-0', createdAt);
      const before = readFileSync(listPath(), 'utf8');
      const projected = await withW5ProjectionOnlyRead(
        W5_PROJECTION_ONLY_READ,
        () =>
          w5.runW5ReadView(
            { files: [], discoverWorkspaces: true },
            async () => {
              const result = await readAllSidebarItemsSnapshot();
              // Nested snapshot queries must not inherit fallback bytes or permission.
              await expect(snapshot()).rejects.toBe(failure);
              await expect(
                portalWorkspace.listWorkspacePortalEntities(),
              ).rejects.toBe(failure);
              return result;
            },
          ),
      );
      expect(projected.file.stale).toBe(true);
      expect(projected.file.items).toHaveLength(26);
      expect(
        projected.file.items.find((item) => item.id === 'code-0'),
      ).toMatchObject({
        worktrees: [{ id: 'row-1' }],
      });
      expect(live).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(startOrgDefaultCoworkProvisioning).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(readFileSync(listPath(), 'utf8')).toBe(before);
    });
  },
);

it.each(['in-process', 'daemon'] as const)(
  '%s: defers tombstone cleanup and re-reads a concurrent post-capture update',
  async (side) => {
    await withStore(side, async (host) => {
      markWorkspaceWorktreeRecentlyRemoved('code-0', 'row-0', createdAt);
      const capture = host.capture.bind(host);
      jest.spyOn(host, 'capture').mockImplementationOnce(async (request) => {
        const captured = await capture(request);
        // Another writer after capture: cleanup must not replay captured rows.
        writeFileSync(
          listPath(),
          JSON.stringify({
            version: 1,
            worktrees: rows().map((row) =>
              row.id === 'row-1' ? { ...row, label: 'Concurrent label' } : row,
            ),
          }),
        );
        return captured;
      });
      const realReplace = w5.desktopW5FileStore.replace.bind(
        w5.desktopW5FileStore,
      );
      const replace = jest
        .spyOn(w5.desktopW5FileStore, 'replace')
        .mockImplementation((...args) => {
          expect(assertOutsideW5ReadView).not.toThrow();
          return realReplace(...args);
        });
      const result = await snapshot();
      expect(result.workspaces).toHaveLength(26);
      expect(
        result.worktrees.filter((row) => row.workspaceLocalId === 'code-0'),
      ).toEqual([
        expect.objectContaining({ localId: 'row-1', label: 'Label 1' }),
      ]);
      expect(replace).toHaveBeenCalledTimes(1);
      const persisted: unknown = JSON.parse(readFileSync(listPath(), 'utf8'));
      expect(persisted).toEqual(
        expect.objectContaining({
          worktrees: [
            expect.objectContaining({
              id: 'row-1',
              label: 'Concurrent label',
            }),
          ],
        }),
      );
    });
  },
);

describe.each(['direct', 'handoff-degraded'] as const)(
  '%s projection-only reads',
  (side) => {
    it.each([
      { persistRemovalCleanup: false } as const,
      { includeRecentlyRemoved: true } as const,
    ])('read options %j stay effect-free inside a view', async (options) => {
      if (side === 'handoff-degraded')
        w5.__setDesktopW5FileStoreForTests(
          createW5DegradedStore(new W5DaemonHandoffError('daemon_unavailable')),
        );
      markWorkspaceWorktreeRecentlyRemoved('code-0', 'row-0', createdAt);
      const before = readFileSync(listPath(), 'utf8');
      const replace = jest.spyOn(w5.desktopW5FileStore, 'replace');
      const result = await w5.runW5ReadView(
        { files: [], discoverWorkspaces: true },
        () => readWorkspaceWorktreesDetailed('code-0', options),
      );
      expect(result.worktrees.map((row) => row.id)).toEqual(
        'includeRecentlyRemoved' in options ? ['row-0', 'row-1'] : ['row-1'],
      );
      expect(result.recentlyRemovedWorktreeIds).toEqual(
        'includeRecentlyRemoved' in options ? undefined : ['row-0'],
      );
      expect(readFileSync(listPath(), 'utf8')).toBe(before);
      expect(replace).not.toHaveBeenCalled();
    });
  },
);
