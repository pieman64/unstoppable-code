import type { readCompatibleCodeGraphBase } from '../lib/code-graph-base-store';
import type * as ReadRunner from '../code-graph/read-runner';
import {
  IPC_CHANNELS,
  type CodeGraphGenerationQueueSnapshot,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type {
  CodeGraphSummaryProjectionV1,
  ReadCodeGraphSummaryProjectionResult,
} from '@canopy/code-graph/summary-projection';
import type { ReadonlyCodeGraphSummary } from '@canopy/code-graph/base-graph';
import type {
  CodeGraphWorkerReadInput,
  CodeGraphWorkerReadResponse,
} from '../code-graph/read-runner';

type Handler = (_event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const mockRegisterIpcHandler = jest.fn(
  (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
);
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void =>
    mockRegisterIpcHandler(channel, handler),
}));

const mockGetQueueSnapshot = jest.fn<CodeGraphGenerationQueueSnapshot, []>(
  () => ({
    revision: 7,
    entries: [
      {
        id: 'opaque-id',
        scope: 'worktree',
        workspaceIds: ['workspace-a'],
        worktreeId: 'worktree-a',
        trigger: 'manual',
        queuedAt: 1,
        startedAt: null,
        status: 'queued',
        reorderable: true,
      },
    ],
  }),
);
const mockReorder = jest.fn<CodeGraphReorderGenerationQueueResult, [unknown]>(
  () => mockGetQueueSnapshot(),
);
const mockSetQueueListener = jest.fn<void, [unknown]>();
const mockRequestSummaryRepair = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve(),
);
const mockSummaryRepairActive = jest.fn<boolean, [string]>(() => true);
const mockSourceBuildState = jest.fn<'idle' | 'queued' | 'running', [string]>(
  () => 'idle',
);
jest.mock('../code-graph/build-runner', () => ({
  getCodeGraphSourceBuildState: (key: string): 'idle' | 'queued' | 'running' =>
    mockSourceBuildState(key),
  isCodeGraphSummaryRepairActive: (key: string): boolean =>
    mockSummaryRepairActive(key),
  requestCodeGraphSummaryRepair: (input: unknown): Promise<unknown> =>
    mockRequestSummaryRepair(input),
  setCodeGraphGenerationQueueListener: (listener: unknown): void => {
    mockSetQueueListener(listener);
  },
}));

const mockAvailable = jest.fn<boolean, [string]>(() => true);
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (workspaceId: string): boolean =>
    mockAvailable(workspaceId),
}));
const mockFeatureEnabled = jest.fn<boolean, []>(() => true);
jest.mock('../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: (): boolean => mockFeatureEnabled(),
}));

const workspace: SidebarItem = {
  type: 'single-repo',
  id: 'workspace-a',
  name: 'Workspace A',
  color: '#000000',
  collapsed: false,
  order: 0,
  repoPath: '/private/repo',
  worktrees: [
    {
      id: 'worktree-a',
      branchName: 'feature',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
const mockReadSidebar = jest.fn<
  Promise<{ version: number; items: SidebarItem[] }>,
  []
>(() => Promise.resolve({ version: 1, items: [workspace] }));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<{
    version: number;
    items: SidebarItem[];
  }> => mockReadSidebar(),
}));
const mockDescribeBaseWorkspace = jest.fn<unknown, unknown[]>(() => null);
const mockMaintainBasesForWorkspace = jest.fn<Promise<unknown>, unknown[]>();
const mockResolveWorkspaceFingerprint = jest.fn<
  Promise<string | null>,
  [unknown]
>(() => Promise.resolve('none'));
const mockSyncBaseRepositories = jest.fn<void, [unknown]>();
jest.mock('../lib/code-graph-base-manager', () => ({
  requestCodeGraphBaseSummaryRepair: jest.fn(() => Promise.resolve()),
  describeCodeGraphBaseWorkspace: (...args: unknown[]): unknown =>
    mockDescribeBaseWorkspace(...args),
  maintainCodeGraphBasesForWorkspace: (...args: unknown[]): Promise<unknown> =>
    mockMaintainBasesForWorkspace(...args),
  resolveCodeGraphBaseWorkspaceFingerprint: (
    descriptor: unknown,
  ): Promise<string | null> => mockResolveWorkspaceFingerprint(descriptor),
  syncCodeGraphBaseRepositories: (...args: [unknown]): void => {
    mockSyncBaseRepositories(...args);
  },
}));
const mockRunWorktreeBuild = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../lib/code-graph-build-service', () => ({
  runWorktreeCodeGraphBuild: (input: unknown): Promise<unknown> =>
    mockRunWorktreeBuild(input),
}));
const mockPerformanceSchedulerEnabled = jest.fn<boolean, []>(() => true);
const mockRunPerformanceBuild = jest.fn<Promise<void>, [unknown]>();
jest.mock('../lib/code-graph-scheduler', () => ({
  isCodeGraphPerformanceSchedulerEnabled: (): boolean =>
    mockPerformanceSchedulerEnabled(),
  runCodeGraphPerformanceBuild: (input: unknown): Promise<void> =>
    mockRunPerformanceBuild(input),
}));
const mockReadReadonlySummary = jest.fn<
  ReadonlyCodeGraphSummary | null,
  [string]
>(() => null);
function projectionFixture(
  summary: ReadonlyCodeGraphSummary | null,
): ReadCodeGraphSummaryProjectionResult {
  if (summary === null) return { state: 'missing' };
  const repositories = summary.repositories.map((repo) => ({
    repoId: repo.repoId,
    gitHead: repo.gitHead,
    counts: {
      fileCount: repo.fileCount,
      symbolCount: repo.symbolCount,
      edgeCount: repo.edgeCount,
      contextUnresolvedEdgeCount: repo.unresolvedEdgeCount,
      contextFilesWithErrors: repo.filesWithErrors,
      legacyUnresolvedEdgeCount: repo.unresolvedEdgeCount,
      legacyFilesWithErrors: repo.filesWithErrors,
      communityCount: repo.communityCount,
      flowCount: repo.flowCount,
    },
  }));
  const totals: CodeGraphSummaryProjectionV1['totals'] = {
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    contextUnresolvedEdgeCount: 0,
    contextFilesWithErrors: 0,
    legacyUnresolvedEdgeCount: 0,
    legacyFilesWithErrors: 0,
    communityCount: 0,
    flowCount: 0,
  };
  for (const repo of repositories) {
    const keys: (keyof typeof totals)[] = [
      'fileCount',
      'symbolCount',
      'edgeCount',
      'contextUnresolvedEdgeCount',
      'contextFilesWithErrors',
      'legacyUnresolvedEdgeCount',
      'legacyFilesWithErrors',
      'communityCount',
      'flowCount',
    ];
    for (const key of keys) totals[key] += repo.counts[key];
  }
  return {
    state: 'ready',
    diagnostics: null,
    projection: {
      formatVersion: 1,
      schemaVersion: summary.schemaVersion ?? 1,
      extractorVersion: summary.extractorVersion ?? 1,
      projectionRevision: 1,
      lastBuildAt: summary.lastBuildAt,
      completedBuildAt: summary.lastBuildAt,
      derivedAt: null,
      assembly: 'complete',
      customLanguagesFingerprint: summary.customLanguagesFingerprint,
      repositories,
      totals,
      topCommunities: [],
      customLanguages: null,
    },
  };
}
const mockRunCodeGraphWorkerRead = jest.fn<
  Promise<CodeGraphWorkerReadResponse>,
  [CodeGraphWorkerReadInput]
>((input) => {
  return Promise.resolve({
    ok: true,
    result: {
      kind: 'readonly-summary',
      value: projectionFixture(mockReadReadonlySummary(input.request.dbPath)),
    },
  });
});
jest.mock('../code-graph/read-runner', () => {
  const actual = jest.requireActual<typeof ReadRunner>(
    '../code-graph/read-runner',
  );
  return {
    ...actual,
    runCodeGraphWorkerRead: (
      input: CodeGraphWorkerReadInput,
    ): Promise<CodeGraphWorkerReadResponse> =>
      mockRunCodeGraphWorkerRead(input),
  };
});
const mockFanoutDiagnostic = jest.fn<void, [unknown]>();
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphSummaryFanoutDiagnostic: (input: unknown): void =>
    mockFanoutDiagnostic(input),
}));

const mockHasPublishedBase = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(false),
);
jest.mock('@canopy/code-graph/base-graph', () => ({
  hasPublishedCodeGraphBaseForRepository: (
    identity: unknown,
  ): Promise<boolean> => mockHasPublishedBase(identity),
}));
const mockReadCompatibleBase = jest.fn<
  Promise<unknown>,
  Parameters<typeof readCompatibleCodeGraphBase>
>();
jest.mock('../lib/code-graph-base-store', () => ({
  codeGraphBaseRunnerKey: (
    _root: string,
    identity: { repoId: string },
  ): string => `base/${identity.repoId}`,
  readCompatibleCodeGraphBase: (
    identity: Parameters<typeof readCompatibleCodeGraphBase>[0],
  ): Promise<unknown> => mockReadCompatibleBase(identity),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: jest.fn(() => '/private/graph.db'),
}));
const mockGetHeadCommitSha = jest.fn<Promise<string>, [string]>();
jest.mock('../lib/git', () => ({
  getHeadCommitSha: (repoPath: string): Promise<string> =>
    mockGetHeadCommitSha(repoPath),
}));
const mockGetRepoShadowDir = jest.fn<string, [string]>();
jest.mock('../lib/repo-shadow', () => ({
  getRepoShadowDir: (repoPath: string): string =>
    mockGetRepoShadowDir(repoPath),
}));
const mockResolveWorkspaceReferenceRepoPath = jest.fn<
  Promise<string>,
  [string]
>();
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: (repoPath: string): Promise<string> =>
    mockResolveWorkspaceReferenceRepoPath(repoPath),
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
const mockSelectDaemon = jest.fn<boolean, [unknown]>(() => false);
const mockBuildInDaemon = jest.fn<Promise<unknown>, [unknown]>();
const mockQueryInDaemon = jest.fn<Promise<unknown>, [unknown]>();
const mockNoteDaemonFallback = jest.fn<boolean, [unknown]>(() => false);
jest.mock('../code-graph/daemon-code-graph-route', () => ({
  ...jest.requireActual<object>('../code-graph/daemon-code-graph-route'),
  selectDaemonCodeGraph: (context: unknown): boolean =>
    mockSelectDaemon(context),
  buildCodeGraphInDaemon: (scope: unknown): Promise<unknown> =>
    mockBuildInDaemon(scope),
  queryCodeGraphInDaemon: (params: unknown): Promise<unknown> =>
    mockQueryInDaemon(params),
  noteDaemonCodeGraphFallback: (error: unknown): boolean =>
    mockNoteDaemonFallback(error),
}));
jest.mock('../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));

import {
  createCanopyDispatcher,
  createWorkerExecutorReceipts,
} from '@canopy/core-runtime';
import { createWorkerCodeGraphHandlers } from '@canopy/core-runtime/node/code-graph';
import {
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { CodeGraphReorderGenerationQueueResult } from '@canopy/code-graph/host/build-scheduler';
import {
  createDesktopCodeGraphBuildQueueWorker,
  createWorkerCodeGraphAdapter,
  type DesktopCodeGraphBuildQueue,
} from '../canopy-runtime/worker-code-graph-adapter';
import { buildCodeGraph } from '../lib/code-graph-worker-builds';
import { registerCodeGraphHandlers } from '../ipc/code-graph';
import { CanopyClientError } from '@canopy/core-client';

// The queue channels dispatch the worker's queue controls over the scheduler
// the build-runner mock stands in for.
const desktopQueue = (): DesktopCodeGraphBuildQueue => ({
  queueStatus: () => {
    const snapshot = mockGetQueueSnapshot();
    return {
      revision: snapshot.revision,
      entries: snapshot.entries.map((entry) => ({
        ...entry,
        priority: 'worktree' as const,
      })),
    };
  },
  reorderQueue: (request) => mockReorder(request),
  cancelQueueItem: () => Promise.resolve(null),
  cancelWorktree: () => Promise.resolve(0),
  build: buildCodeGraph,
});
const queueHandlers = createWorkerCodeGraphHandlers(
  createDesktopCodeGraphBuildQueueWorker(desktopQueue()),
);
const queueDispatcher = createCanopyDispatcher({
  profile: 'core+worker',
  definitions: {
    queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
    instructions: WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    streams: {},
  },
  handlers: {
    queries: queueHandlers.queries,
    instructions: createWorkerExecutorReceipts(
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    ).wrap(queueHandlers.instructions),
    streams: {},
  },
});
// Electron main's production adapter, which takes the daemon route.
const adapterHandlers = createWorkerCodeGraphAdapter(() =>
  Promise.resolve(desktopQueue()),
);
const adapterDispatcher = createCanopyDispatcher({
  profile: 'core+worker',
  definitions: {
    queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
    instructions: WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    streams: {},
  },
  handlers: {
    queries: adapterHandlers.queries,
    instructions: createWorkerExecutorReceipts(
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    ).wrap(adapterHandlers.instructions),
    streams: {},
  },
});
const rendererCaller: CanopyCallerDescriptor = {
  principalId: 'renderer',
  clientInstanceId: 'main-window',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing handler ${channel}`);
  return registered;
}

import { installCodeGraphReadDispatcherForTests } from './helpers/code-graph-read-dispatcher';

beforeAll(() => {
  installCodeGraphReadDispatcherForTests();
});

// The generation's cancellation signal and queued callback.
const ANY_SIGNAL: unknown = expect.any(AbortSignal);
const ANY_CALLBACK: unknown = expect.any(Function);

describe('Code Graph IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    mockAvailable.mockReturnValue(true);
    mockSummaryRepairActive.mockReturnValue(true);
    mockSourceBuildState.mockReturnValue('idle');
    mockFeatureEnabled.mockReturnValue(true);
    mockPerformanceSchedulerEnabled.mockReturnValue(true);
    mockRunPerformanceBuild.mockResolvedValue(undefined);
    mockReadSidebar.mockResolvedValue({ version: 1, items: [workspace] });
    mockDescribeBaseWorkspace.mockReturnValue(null);
    mockResolveWorkspaceFingerprint.mockReset();
    mockResolveWorkspaceFingerprint.mockResolvedValue('none');
    mockReadCompatibleBase.mockReset();
    mockHasPublishedBase.mockReset();
    mockHasPublishedBase.mockResolvedValue(false);
    mockReadReadonlySummary.mockReset();
    mockReadReadonlySummary.mockReturnValue(null);
    mockMaintainBasesForWorkspace.mockReset();
    mockGetHeadCommitSha.mockReset();
    mockGetRepoShadowDir.mockReset();
    mockResolveWorkspaceReferenceRepoPath.mockReset();
    registerCodeGraphHandlers({
      dispatcher: queueDispatcher,
      resolveCaller: () => rendererCaller,
    });
  });

  it('rejects malformed and cross-workspace worktree requests without accepting paths', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: '../escape',
          path: '/renderer/path',
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });

    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorktree)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: 'other-worktree',
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'returns actionable missing summaries with generation enabled=%s',
    async (enabled) => {
      mockAvailable.mockReturnValue(enabled);
      for (const [channel, payload, scope] of [
        [
          IPC_CHANNELS.codeGraphGetWorktreeSummary,
          { workspaceId: 'workspace-a', worktreeId: 'worktree-a' },
          'worktree',
        ],
        [
          IPC_CHANNELS.codeGraphGetWorkspaceSummary,
          { workspaceId: 'workspace-a' },
          'workspace-shadow',
        ],
      ] as const) {
        const response = await handler(channel)({}, payload);
        expect(response).toMatchObject({
          scope,
          enabled,
          state: 'missing',
          snapshotState: 'missing',
          buildState: 'idle',
          lastBuildAt: null,
          repositories: [],
        });
        expect(response).not.toHaveProperty('ok');
        expect(response).not.toHaveProperty('readFailure');
      }
      expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
      expect(mockMaintainBasesForWorkspace).not.toHaveBeenCalled();
    },
  );

  it('returns missing when all required published repositories are absent', async () => {
    mockDescribeBaseWorkspace.mockReturnValue({
      workspaceId: 'workspace-a',
      customLanguageRepoPath: null,
      repositories: [
        { repoId: 'repo-a', repoPath: '/private/repo-a' },
        { repoId: 'repo-b', repoPath: '/private/repo-b' },
      ],
    });
    mockResolveWorkspaceReferenceRepoPath.mockImplementation(
      (repoPath: string) => Promise.resolve(repoPath),
    );
    mockReadCompatibleBase.mockResolvedValue(null);
    const response = await handler(IPC_CHANNELS.codeGraphGetWorkspaceSummary)(
      {},
      { workspaceId: 'workspace-a' },
    );
    expect(response).toMatchObject({
      scope: 'workspace-shadow',
      enabled: true,
      state: 'missing',
      snapshotState: 'missing',
      buildState: 'idle',
      lastBuildAt: null,
      repositories: [],
    });
    expect(response).not.toHaveProperty('ok');
    expect(mockReadCompatibleBase).toHaveBeenCalledTimes(2);
    expect(mockFanoutDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          { repoId: 'repo-a', state: 'missing' },
          { repoId: 'repo-b', state: 'missing' },
        ],
      }),
    );
  });

  it('verifies source contents for explicit worktree generation', async () => {
    await handler(IPC_CHANNELS.codeGraphBuildWorktree)(
      {},
      { workspaceId: 'workspace-a', worktreeId: 'worktree-a' },
    );
    expect(mockRunWorktreeBuild).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
      reason: 'manual',
      options: { verifyContent: true },
      signal: ANY_SIGNAL,
      onQueued: ANY_CALLBACK,
    });
  });

  it('enforces project availability for manual generation', async () => {
    mockAvailable.mockReturnValue(false);
    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorktree)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: 'worktree-a',
        },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Code graph tools are not available for this project.',
    });
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it('returns retained worktree counts read-only while generation is disabled', async () => {
    mockAvailable.mockReturnValue(false);
    mockReadReadonlySummary.mockReturnValue({
      completed: true,
      lastBuildAt: 123,
      schemaVersion: 1,
      extractorVersion: 1,
      canonicalRepoRoot: null,
      customLanguagesFingerprint: 'none',
      repositories: [
        {
          repoId: '__workspace_root__',
          gitHead: 'head',
          fileCount: 2,
          symbolCount: 3,
          edgeCount: 4,
          unresolvedEdgeCount: 1,
          filesWithErrors: 0,
          communityCount: 1,
          flowCount: 1,
        },
      ],
    });

    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(
        {},
        { workspaceId: 'workspace-a', worktreeId: 'worktree-a' },
      ),
    ).resolves.toMatchObject({
      enabled: false,
      state: 'ready',
      totals: { fileCount: 2, symbolCount: 3, edgeCount: 4 },
    });
    expect(mockRunCodeGraphWorkerRead).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'workspace-a/worktree-a',
        kind: 'ui-summary',
        request: {
          dbPath: '/private/graph.db',
          task: { kind: 'readonly-summary' },
        },
      }),
    );
    // The dispatcher's request signal cancels the read.
    expect(mockRunCodeGraphWorkerRead.mock.lastCall?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  describe('a retained worktree graph whose summary is not measured', () => {
    const pendingRead: CodeGraphWorkerReadResponse = {
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'pending',
          reason: 'projection-missing',
          observed: {
            schemaVersion: 4,
            extractorVersion: 5,
            projectionRevision: null,
            lastBuildAt: 123,
            completedBuildAt: 123,
            derivedAt: null,
          },
          diagnostics: null,
        },
      },
    };
    const request = { workspaceId: 'workspace-a', worktreeId: 'worktree-a' };

    it('is not enabled, rather than pending, while generation is disabled', async () => {
      // No repair or build runs for a disabled project, so a pending
      // summary could never become ready and its Retry could never succeed.
      mockAvailable.mockReturnValue(false);
      mockRunCodeGraphWorkerRead.mockResolvedValueOnce(pendingRead);

      const response = await handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(
        {},
        request,
      );

      expect(response).toMatchObject({
        scope: 'worktree',
        enabled: false,
        state: 'missing',
        snapshotState: 'missing',
        buildState: 'idle',
        lastBuildAt: 123,
        repositories: [],
        totals: { fileCount: 0, symbolCount: 0, edgeCount: 0 },
      });
      expect(response).not.toHaveProperty('ok');
      expect(mockRequestSummaryRepair).not.toHaveBeenCalled();
    });

    it('stays pending while the repair it requested is working on it', async () => {
      mockRunCodeGraphWorkerRead.mockResolvedValueOnce(pendingRead);

      await expect(
        handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)({}, request),
      ).resolves.toMatchObject({
        ok: false,
        snapshotState: 'summary-pending',
        lastBuildAt: 123,
      });
      expect(mockRequestSummaryRepair).toHaveBeenCalledWith({
        key: 'workspace-a/worktree-a',
        projectId: 'workspace-a',
        worktreeId: 'worktree-a',
        dbPath: '/private/graph.db',
      });
      expect(mockSummaryRepairActive).toHaveBeenCalledWith(
        'workspace-a/worktree-a',
      );
    });

    it.each(['queued', 'running'] as const)(
      'stays pending while a %s source build will publish it',
      async (buildState) => {
        mockSummaryRepairActive.mockReturnValue(false);
        mockSourceBuildState.mockReturnValue(buildState);
        mockRunCodeGraphWorkerRead.mockResolvedValueOnce(pendingRead);

        await expect(
          handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)({}, request),
        ).resolves.toMatchObject({
          ok: false,
          snapshotState: 'summary-pending',
          buildState,
        });
      },
    );

    it('is unreadable, with Update still offered, when no repair or build is working on it', async () => {
      // The repair was refused or is cooling down after a failure, so
      // nothing will make this summary ready without the user.
      mockSummaryRepairActive.mockReturnValue(false);
      mockRunCodeGraphWorkerRead.mockResolvedValueOnce(pendingRead);

      const response = await handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(
        {},
        request,
      );

      expect(response).toMatchObject({
        ok: false,
        code: 'internal',
        snapshotState: 'read-error',
        readFailure: 'database-error',
        buildState: 'idle',
        lastBuildAt: 123,
      });
      expect(mockRequestSummaryRepair).toHaveBeenCalledTimes(1);
    });

    it('is the generate state, not a repair, when no build has committed', async () => {
      mockRunCodeGraphWorkerRead.mockResolvedValueOnce({
        ok: true,
        result: {
          kind: 'readonly-summary',
          value: {
            state: 'pending',
            reason: 'build-incomplete',
            observed: {
              schemaVersion: 5,
              extractorVersion: null,
              projectionRevision: null,
              lastBuildAt: null,
              completedBuildAt: null,
              derivedAt: null,
            },
            diagnostics: null,
          },
        },
      });

      const response = await handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(
        {},
        request,
      );

      expect(response).toMatchObject({
        scope: 'worktree',
        enabled: true,
        state: 'missing',
        snapshotState: 'missing',
        buildState: 'idle',
        lastBuildAt: null,
        repositories: [],
      });
      expect(response).not.toHaveProperty('ok');
      expect(mockRequestSummaryRepair).not.toHaveBeenCalled();
    });
  });

  it('returns an actionable safe error when manual worktree generation times out', async () => {
    mockRunWorktreeBuild.mockRejectedValueOnce({
      reason: 'timeout',
      message: 'worker exceeded timeout at /private/graph.db',
    });

    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorktree)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: 'worktree-a',
        },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'internal',
      message:
        'Code Graph generation timed out. Increase the timeout in Code Graph settings and try again.',
    });
  });

  it('schedules an enabled performance build for a validated worktree', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphSchedulePerformanceBuild)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: 'worktree-a',
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(mockRunPerformanceBuild).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });
  });

  it('rejects performance builds while the E2E scheduler seam is disabled', async () => {
    mockPerformanceSchedulerEnabled.mockReturnValue(false);

    await expect(
      handler(IPC_CHANNELS.codeGraphSchedulePerformanceBuild)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: 'worktree-a',
        },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Code graph tools are not available for this project.',
    });
    expect(mockRunPerformanceBuild).not.toHaveBeenCalled();
  });

  it('validates performance build requests before scheduling', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphSchedulePerformanceBuild)(
        {},
        {
          workspaceId: 'workspace-a',
          worktreeId: '../escape',
        },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'invalid-request',
      message: 'The project or worktree is invalid.',
    });
    expect(mockRunPerformanceBuild).not.toHaveBeenCalled();
  });

  it('returns an empty queue while the feature flag is off', async () => {
    mockFeatureEnabled.mockReturnValue(false);
    await expect(
      handler(IPC_CHANNELS.codeGraphGetGenerationQueue)({}),
    ).resolves.toEqual({
      revision: 7,
      entries: [],
    });
  });

  it('reads the generation queue through the worker queue unchanged', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphGetGenerationQueue)({}),
    ).resolves.toEqual(mockGetQueueSnapshot());
  });

  it('validates reorder payloads before passing only IDs and revision to the runner', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphReorderGenerationQueue)(
        {},
        {
          revision: 7,
          orderedQueuedEntryIds: ['opaque-id'],
          path: '/ignored',
        },
      ),
    ).resolves.toEqual(mockGetQueueSnapshot());
    expect(mockReorder).toHaveBeenCalledWith({
      revision: 7,
      orderedQueuedEntryIds: ['opaque-id'],
    });
    await expect(
      handler(IPC_CHANNELS.codeGraphReorderGenerationQueue)(
        {},
        {
          revision: '7',
          orderedQueuedEntryIds: [],
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });
    await expect(
      handler(IPC_CHANNELS.codeGraphReorderGenerationQueue)(
        {},
        {
          revision: 7,
          orderedQueuedEntryIds: ['../internal-runner-key'],
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });
    expect(mockReorder).toHaveBeenCalledTimes(1);
  });

  it('answers a stale reorder with a conflict and the current queue', async () => {
    mockReorder.mockReturnValueOnce({
      ok: false,
      code: 'conflict',
      message: 'The generation queue changed. Reload it and try again.',
      snapshot: mockGetQueueSnapshot(),
    });

    await expect(
      handler(IPC_CHANNELS.codeGraphReorderGenerationQueue)(
        {},
        { revision: 6, orderedQueuedEntryIds: ['opaque-id'] },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'conflict',
      message: 'The generation queue changed. Reload it and try again.',
      snapshot: mockGetQueueSnapshot(),
    });
  });

  it("keeps the scheduler's message for an invalid order", async () => {
    mockReorder.mockReturnValueOnce({
      ok: false,
      code: 'invalid-request',
      message: 'The reorder contains an unknown or non-queued generation.',
    });

    await expect(
      handler(IPC_CHANNELS.codeGraphReorderGenerationQueue)(
        {},
        { revision: 7, orderedQueuedEntryIds: ['other-id'] },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'invalid-request',
      message: 'The reorder contains an unknown or non-queued generation.',
    });
  });

  it('aggregates independent project repositories and reports stale and missing states', async () => {
    const multiWorkspace: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#000000',
      collapsed: false,
      order: 0,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/private/repo-a',
          source: 'local',
        },
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/private/repo-b',
          source: 'local',
        },
      ],
      worktrees: [],
    };
    mockReadSidebar.mockResolvedValue({
      version: 1,
      items: [multiWorkspace],
    });
    mockDescribeBaseWorkspace.mockReturnValue({
      workspaceId: 'workspace-a',
      customLanguageRepoPath: null,
      repositories: [
        { repoId: 'repo-a', repoPath: '/private/repo-a' },
        { repoId: 'repo-b', repoPath: '/private/repo-b' },
      ],
    });
    mockResolveWorkspaceFingerprint.mockResolvedValue(
      'workspace-a-custom-languages',
    );
    mockResolveWorkspaceReferenceRepoPath.mockImplementation(
      (repoPath: string) => Promise.resolve(`${repoPath}-canonical`),
    );
    mockGetRepoShadowDir.mockImplementation(
      (repoPath: string) => `${repoPath}-shadow`,
    );
    mockReadCompatibleBase.mockImplementation(
      ({ repoId }: Parameters<typeof readCompatibleCodeGraphBase>[0]) =>
        Promise.resolve(
          repoId === 'repo-b'
            ? null
            : {
                dbPath: '/private/published-a.db',
                recovered: true,
                manifest: {
                  gitHead: 'old-head',
                  publishedAt: '2026-07-15T12:00:00.000Z',
                },
              },
        ),
    );
    mockReadReadonlySummary.mockReturnValue({
      completed: true,
      lastBuildAt: 1,
      schemaVersion: 1,
      extractorVersion: 1,
      canonicalRepoRoot: '/private/repo-a-canonical',
      customLanguagesFingerprint: 'none',
      repositories: [
        {
          repoId: 'repo-a',
          gitHead: 'old-head',
          fileCount: 3,
          symbolCount: 5,
          edgeCount: 7,
          unresolvedEdgeCount: 1,
          filesWithErrors: 0,
          communityCount: 2,
          flowCount: 4,
        },
      ],
    });
    mockGetHeadCommitSha.mockResolvedValue('new-head');

    const response = await handler(IPC_CHANNELS.codeGraphGetWorkspaceSummary)(
      {},
      { workspaceId: 'workspace-a' },
    );

    expect(response).toMatchObject({
      ok: false,
      snapshotState: 'summary-pending',
      buildState: 'idle',
      lastBuildAt: 1,
    });
    expect(response).not.toHaveProperty('totals');
    expect(response).not.toHaveProperty('repositories');
    expect(mockFanoutDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            repoId: 'repo-a',
            state: 'ready',
            fileCount: 3,
            symbolCount: 5,
            edgeCount: 7,
          }),
          { repoId: 'repo-b', state: 'missing' },
        ],
      }),
    );
    expect(mockReadCompatibleBase).toHaveBeenCalledWith({
      canonicalRepoRoot: '/private/repo-a-canonical',
      repoId: 'repo-a',
      customLanguagesFingerprint: 'workspace-a-custom-languages',
    });
    expect(mockReadCompatibleBase).toHaveBeenCalledWith({
      canonicalRepoRoot: '/private/repo-b-canonical',
      repoId: 'repo-b',
      customLanguagesFingerprint: 'workspace-a-custom-languages',
    });
    expect(JSON.stringify(response)).not.toContain('/private/');
  });

  it('reports a matching unreadable repository variant as an error', async () => {
    mockDescribeBaseWorkspace.mockReturnValue({
      workspaceId: 'workspace-a',
      customLanguageRepoPath: null,
      repositories: [
        { repoId: '__workspace_root__', repoPath: '/private/repo' },
      ],
    });
    mockResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/private/repo-canonical',
    );
    mockGetRepoShadowDir.mockReturnValue('/private/repo-shadow');
    mockReadCompatibleBase.mockResolvedValue({
      dbPath: '/private/unreadable.db',
      manifest: { gitHead: 'head' },
    });
    mockRunCodeGraphWorkerRead.mockResolvedValueOnce({
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: { state: 'error', classification: 'corrupt' },
      },
    });

    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorkspaceSummary)(
        {},
        { workspaceId: 'workspace-a' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'internal',
      snapshotState: 'read-error',
      readFailure: 'database-error',
      message: 'The retained Code Graph could not be read. Try again.',
    });
  });

  it('reports a refresh failure for a repository that has never published a base', async () => {
    const multiWorkspace: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#000000',
      collapsed: false,
      order: 0,
      sourceRepoPath: '/private/repo',
      repos: [
        {
          id: 'other-repo',
          name: 'Other Repo',
          repoPath: '/private/other-repo',
          source: 'local',
        },
      ],
      worktrees: [],
    };
    mockReadSidebar.mockResolvedValue({
      version: 1,
      items: [multiWorkspace],
    });
    mockDescribeBaseWorkspace.mockReturnValue({
      workspaceId: 'workspace-a',
      customLanguageRepoPath: '/private/repo',
      repositories: [
        { repoId: '__workspace_root__', repoPath: '/private/repo' },
        { repoId: 'other-repo', repoPath: '/private/other-repo' },
      ],
    });
    mockMaintainBasesForWorkspace.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        ok: false,
        message: 'Failed while opening /private/repo/graph.db',
      },
      { repoId: 'other-repo', ok: true },
    ]);
    mockResolveWorkspaceReferenceRepoPath.mockImplementation(
      (repoPath: string) => Promise.resolve(`${repoPath}-canonical`),
    );
    mockGetRepoShadowDir.mockImplementation(
      (repoPath: string) => `${repoPath}-shadow`,
    );
    // The failed repository has no published base to read.
    mockReadCompatibleBase.mockImplementation(
      ({ repoId }: Parameters<typeof readCompatibleCodeGraphBase>[0]) =>
        Promise.resolve(
          repoId === '__workspace_root__'
            ? null
            : {
                dbPath: '/private/other-published.db',
                recovered: true,
                manifest: {
                  gitHead: 'head',
                  publishedAt: '2026-07-15T12:00:00.000Z',
                },
              },
        ),
    );
    mockReadReadonlySummary.mockReturnValue({
      completed: true,
      lastBuildAt: 1,
      schemaVersion: 1,
      extractorVersion: 1,
      canonicalRepoRoot: '/private/other-repo-canonical',
      customLanguagesFingerprint: 'none',
      repositories: [
        {
          repoId: 'other-repo',
          gitHead: 'head',
          fileCount: 1,
          symbolCount: 2,
          edgeCount: 3,
          unresolvedEdgeCount: 0,
          filesWithErrors: 0,
          communityCount: 0,
          flowCount: 0,
        },
      ],
    });
    mockGetHeadCommitSha.mockResolvedValue('head');

    const response = await handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
      {},
      { workspaceId: 'workspace-a' },
    );

    expect(response).toMatchObject({
      scope: 'workspace-shadow',
      enabled: true,
      state: 'partial',
      message: 'Some repository graphs could not be generated.',
      totals: { fileCount: 1, symbolCount: 2, edgeCount: 3 },
      repositories: [
        {
          repoId: '__workspace_root__',
          name: 'Project root',
          state: 'error',
          message: 'Generation failed for this repository. Try again.',
          fileCount: 0,
          lastBuildAt: null,
          gitHead: null,
        },
        expect.objectContaining({ repoId: 'other-repo', state: 'ready' }),
      ],
    });
    expect(response).not.toHaveProperty('ok');
    expect(JSON.stringify(response)).not.toContain('/private/');

    mockMaintainBasesForWorkspace.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        ok: false,
        message: 'worker exceeded timeout at /private/repo/graph.db',
      },
      { repoId: 'other-repo', ok: true },
    ]);
    const timeoutResponse = await handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
      {},
      { workspaceId: 'workspace-a' },
    );
    expect(timeoutResponse).toMatchObject({
      repositories: [
        expect.objectContaining({
          repoId: '__workspace_root__',
          state: 'error',
          message:
            'Generation timed out. Increase the timeout in Code Graph settings and try again.',
        }),
        expect.objectContaining({ repoId: 'other-repo', state: 'ready' }),
      ],
    });
    expect(JSON.stringify(timeoutResponse)).not.toContain('/private/');

    // A read without a refresh failure still treats the same repository as
    // one whose base maintenance will publish it.
    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorkspaceSummary)(
        {},
        { workspaceId: 'workspace-a' },
      ),
    ).resolves.toMatchObject({ ok: false, snapshotState: 'summary-pending' });
  });

  it('returns safe per-repository partial failures from manual project refresh', async () => {
    const multiWorkspace: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#000000',
      collapsed: false,
      order: 0,
      sourceRepoPath: '/private/repo',
      repos: [
        {
          id: 'other-repo',
          name: 'Other Repo',
          repoPath: '/private/other-repo',
          source: 'local',
        },
      ],
      worktrees: [],
    };
    mockReadSidebar.mockResolvedValue({
      version: 1,
      items: [multiWorkspace],
    });
    mockDescribeBaseWorkspace.mockReturnValue({
      workspaceId: 'workspace-a',
      customLanguageRepoPath: '/private/repo',
      repositories: [
        { repoId: '__workspace_root__', repoPath: '/private/repo' },
        { repoId: 'other-repo', repoPath: '/private/other-repo' },
      ],
    });
    mockMaintainBasesForWorkspace.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        ok: false,
        message: 'Failed while opening /private/repo/graph.db',
      },
      { repoId: 'other-repo', ok: true },
    ]);
    mockResolveWorkspaceReferenceRepoPath.mockImplementation(
      (repoPath: string) => Promise.resolve(`${repoPath}-canonical`),
    );
    mockGetRepoShadowDir.mockImplementation(
      (repoPath: string) => `${repoPath}-shadow`,
    );
    mockReadCompatibleBase.mockImplementation(
      ({ repoId }: Parameters<typeof readCompatibleCodeGraphBase>[0]) =>
        Promise.resolve(
          repoId === '__workspace_root__'
            ? {
                dbPath: '/private/root-retained.db',
                recovered: true,
                manifest: {
                  gitHead: 'head',
                  publishedAt: '2026-07-15T12:00:00.000Z',
                },
              }
            : {
                dbPath: '/private/other-published.db',
                recovered: true,
                manifest: {
                  gitHead: 'head',
                  publishedAt: '2026-07-15T12:00:00.000Z',
                },
              },
        ),
    );
    mockReadReadonlySummary.mockReturnValue({
      completed: true,
      lastBuildAt: 1,
      schemaVersion: 1,
      extractorVersion: 1,
      canonicalRepoRoot: '/private/other-repo-canonical',
      customLanguagesFingerprint: 'none',
      repositories: [
        {
          repoId: 'other-repo',
          gitHead: 'head',
          fileCount: 1,
          symbolCount: 2,
          edgeCount: 3,
          unresolvedEdgeCount: 0,
          filesWithErrors: 0,
          communityCount: 0,
          flowCount: 0,
        },
      ],
    });
    const otherSummary = mockReadReadonlySummary('/private/other-published.db');
    if (otherSummary === null)
      throw new Error('Missing retained other-repo fixture.');
    mockReadReadonlySummary.mockImplementation((dbPath: string) =>
      dbPath === '/private/root-retained.db'
        ? {
            ...otherSummary,
            repositories: otherSummary.repositories.map((repo) => ({
              ...repo,
              repoId: '__workspace_root__',
            })),
          }
        : otherSummary,
    );
    mockGetHeadCommitSha.mockResolvedValue('head');

    const response = await handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
      {},
      { workspaceId: 'workspace-a' },
    );

    expect(response).toMatchObject({
      scope: 'workspace-shadow',
      state: 'partial',
      repositories: [
        expect.objectContaining({
          repoId: '__workspace_root__',
          state: 'error',
          message: 'Generation failed for this repository. Try again.',
        }),
        expect.objectContaining({ repoId: 'other-repo', state: 'ready' }),
      ],
    });
    expect(JSON.stringify(response)).not.toContain('/private/');

    mockMaintainBasesForWorkspace.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        ok: false,
        message: 'worker exceeded timeout at /private/repo/graph.db',
      },
      { repoId: 'other-repo', ok: true },
    ]);
    const timeoutResponse = await handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
      {},
      { workspaceId: 'workspace-a' },
    );
    expect(timeoutResponse).toMatchObject({
      repositories: [
        expect.objectContaining({
          repoId: '__workspace_root__',
          message:
            'Generation timed out. Increase the timeout in Code Graph settings and try again.',
        }),
        expect.objectContaining({ repoId: 'other-repo', state: 'ready' }),
      ],
    });
    expect(JSON.stringify(timeoutResponse)).not.toContain('/private/');
  });

  it('returns a sanitized error when a project build throws', async () => {
    mockMaintainBasesForWorkspace.mockRejectedValue(
      new Error('Failed while opening /private/repo/graph.db'),
    );

    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
        {},
        { workspaceId: 'workspace-a' },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'internal',
      message: 'The Code Graph build failed.',
    });
  });

  it('maps unavailable project build exceptions to the typed envelope', async () => {
    mockMaintainBasesForWorkspace.mockRejectedValue({ reason: 'unavailable' });

    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorkspace)(
        {},
        { workspaceId: 'workspace-a' },
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Code graph tools are not available for this project.',
    });
  });
});

describe('Code Graph IPC daemon route (CAN-5089)', () => {
  const sender = { id: 1 };
  const mainWindow = { webContents: sender, isDestroyed: (): boolean => false };
  const request = { workspaceId: 'workspace-a', worktreeId: 'worktree-a' };
  const missing = {
    presence: 'absent',
    buildState: 'running',
    result: { kind: 'readonly-summary', value: { state: 'missing' } },
  };

  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    mockAvailable.mockReturnValue(true);
    mockFeatureEnabled.mockReturnValue(true);
    mockSourceBuildState.mockReturnValue('idle');
    mockReadSidebar.mockResolvedValue({ version: 1, items: [workspace] });
    mockSelectDaemon.mockReturnValue(true);
    mockBuildInDaemon.mockResolvedValue({
      kind: 'worktree',
      filesScanned: 2,
      filesParsed: 2,
      filesUnchanged: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      parseFailures: 0,
      symbolCount: 3,
      edgeCount: 1,
      durationMs: 5,
      lastBuildAt: '2026-11-03T08:00:00.000Z',
      derivedPending: true,
      customLanguageDiagnostics: null,
      derivedWarnings: null,
    });
    mockQueryInDaemon.mockResolvedValue(missing);
    mockNoteDaemonFallback.mockReturnValue(false);
    registerCodeGraphHandlers(
      { dispatcher: adapterDispatcher, resolveCaller: () => rendererCaller },
      {
        getMainWindow: () => mainWindow as never,
        getAppAdvisorWindow: () => null,
      },
    );
  });

  it('sends code-graph:build-worktree as worker.codeGraph.build and its summary as worker.codeGraph.query to the daemon, not in process', async () => {
    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorktree)({ sender }, request),
    ).resolves.toMatchObject({ scope: 'worktree', buildState: 'running' });
    expect(mockSelectDaemon).toHaveBeenCalledWith({ localWindow: true });
    expect(mockBuildInDaemon).toHaveBeenCalledWith({
      kind: 'worktree',
      workspaceId: 'workspace-a',
      worktreeId: 'worktree-a',
      mode: 'verified',
    });
    expect(mockQueryInDaemon).toHaveBeenCalledWith({
      scope: { workspaceId: 'workspace-a', worktreeId: 'worktree-a' },
      queryKind: 'ui-summary',
      read: { kind: 'summary' },
    });
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it('marks another window or no sender as not local', async () => {
    mockSelectDaemon.mockReturnValue(false);
    mockRunWorktreeBuild.mockResolvedValue({ ok: false, message: 'failed' });
    await handler(IPC_CHANNELS.codeGraphBuildWorktree)(
      { sender: { id: 2 } },
      request,
    );
    await handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)(null, request);
    expect(mockSelectDaemon.mock.calls).toEqual([
      [{ localWindow: false }],
      [{ localWindow: false }],
    ]);
    expect(mockBuildInDaemon).not.toHaveBeenCalled();
  });

  it('builds code-graph:build-worktree in process when worker.codeGraph.build cannot reach the daemon', async () => {
    const unreachable = new Error('unreachable');
    mockBuildInDaemon.mockRejectedValue(unreachable);
    mockNoteDaemonFallback.mockReturnValue(true);
    mockRunWorktreeBuild.mockResolvedValue({ ok: false, message: 'failed' });
    await handler(IPC_CHANNELS.codeGraphBuildWorktree)({ sender }, request);
    expect(mockNoteDaemonFallback).toHaveBeenCalledWith(unreachable);
    expect(mockRunWorktreeBuild).toHaveBeenCalledTimes(1);
  });

  it("keeps a reached daemon's refusal as the answer, with no in-process build", async () => {
    mockBuildInDaemon.mockRejectedValue(
      new CanopyClientError({
        kind: 'deadline_exceeded',
        code: 'worker.codeGraph.buildTimedOut',
        message: 'Code graph generation timed out.',
        retry: { kind: 'never' },
      }),
    );
    await expect(
      handler(IPC_CHANNELS.codeGraphBuildWorktree)({ sender }, request),
    ).resolves.toMatchObject({ ok: false, code: 'internal' });
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it("keeps a reached daemon's worker.codeGraph.query refusal kind for code-graph:get-worktree-summary", async () => {
    mockQueryInDaemon.mockRejectedValue(
      new CanopyClientError({
        kind: 'resource_exhausted',
        code: 'worker.codeGraph.read.busy',
        message: 'The retained Code Graph could not be read. Try again.',
        retry: { kind: 'same_request' },
      }),
    );
    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)({ sender }, request),
    ).resolves.toMatchObject({
      ok: false,
      snapshotState: 'read-error',
      readFailure: 'busy',
    });
    expect(mockNoteDaemonFallback).toHaveBeenCalledTimes(1);
  });

  it('reads code-graph:get-worktree-summary in process when worker.codeGraph.query cannot reach the daemon', async () => {
    mockQueryInDaemon.mockRejectedValue(new Error('unreachable'));
    mockNoteDaemonFallback.mockReturnValue(true);
    await expect(
      handler(IPC_CHANNELS.codeGraphGetWorktreeSummary)({ sender }, request),
    ).resolves.toMatchObject({ scope: 'worktree' });
    expect(mockQueryInDaemon).toHaveBeenCalledTimes(1);
  });
});
