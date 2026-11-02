import type {
  CanopyApi,
  DiffStatsBatchResponseItem,
  ScriptRunResponse,
  SidebarItem,
  SingleRepoSidebarItem,
  SplitTemporaryWorkspaceCompleteEvent,
  WorktreeData,
  WorktreeBranchChangedEvent,
  WorktreeGitFailedEvent,
  WorktreeGitReadyEvent,
  WorktreeNeedsRepairEvent,
  WorktreeHealthIssue,
  WorktreePrStatus,
  WorkspaceDriftSummary,
  WorkspaceWorktreesUpdatedEvent,
  WorktreesFileChangedEvent,
  OrgProjectOwnershipChangedEvent,
} from '@canopy/desktop-shared/types';
import type { ProjectLifecycleScriptName } from '@canopy/desktop-shared/scripts';
import { countConfiguredHooks } from '@/components/activity/hook-utils';
import { countConfiguredScripts } from '@/components/activity/script-utils';
import { refreshInAppNotificationPrefs } from '@/lib/osNotifications';
import {
  __resetProjectsStoreArchiveSuppressionForTests,
  useProjectsStore,
} from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { readWorktreeSetupDuration } from '@/lib/worktreeSetupDurations';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useFileListStore } from '@/stores/fileListStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useHooksStore } from '@/stores/hooksStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useActivityStore } from '@/stores/activityStore';
import * as diffStatsHelpers from '@/stores/projectsStore.diffStats';
import { removeDesktopWorktreeInBatch } from '@/components/sidebar/DesktopSharedSidebarHost';
import {
  createSidebarRemovalQueue,
  type WorktreeBatchTarget,
} from '@canopy/ui-app/sidebar';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import type * as AppState from '@canopy/app-state';
import { LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL } from '@canopy/protocol/portal/lifecycle-journal';
import { WorktreeArchiveRefusalError } from '@/lib/worktreeRemovalAdmission';

jest.mock('@/components/worktree/finishWorktreeArchive', () => ({
  finishWorktreeArchive: jest.fn(),
}));
jest.mock('@canopy/app-state', () => {
  const actual = jest.requireActual<typeof AppState>('@canopy/app-state');
  return {
    ...actual,
    offerLifecycleJournalQuarantine: jest.fn(
      actual.offerLifecycleJournalQuarantine,
    ),
  };
});

declare global {
  interface Window {
    api: CanopyApi;
    e2eReportFirstProjectsLoad?: (
      stage: string,
      details: Record<string, unknown>,
    ) => unknown;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | null = null;
  let rejectValue: ((reason: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  const resolve = resolveValue;
  const reject = rejectValue;
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred promise');
  }

  return { promise, resolve, reject };
}

function getSingleRepoProject(
  project: SidebarItem | undefined,
): SingleRepoSidebarItem {
  if (!project || project.type !== 'single-repo') {
    throw new Error('Expected a single-repo project');
  }
  return project;
}

function createScriptRunResponse(
  overrides: Partial<ScriptRunResponse> = {},
): ScriptRunResponse {
  return {
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

function createCleanWorkspaceDriftSummary(): WorkspaceDriftSummary {
  return {
    hasDrift: false,
    blockingIssueCount: 0,
    warningIssueCount: 0,
  };
}

/**
 * Test-only helper: cowork sidebar items have no `worktrees`, so every test
 * that reads a worktree back off a `SidebarItem | undefined` needs to narrow
 * past that variant first. Centralized here instead of inlined at each call
 * site.
 */
function getProjectWorktrees(project: SidebarItem | undefined): WorktreeData[] {
  if (!project || project.type === 'cowork') {
    return [];
  }
  return project.worktrees;
}

function getProjectWorktreeEffective(
  project: SidebarItem | undefined,
): NonNullable<SingleRepoSidebarItem['worktreeEffective']> {
  if (!project || project.type === 'cowork') {
    return {};
  }
  return project.worktreeEffective ?? {};
}

async function runWorkspaceLifecycle(
  lifecycle: ProjectLifecycleScriptName,
): Promise<void> {
  const store = useProjectsStore.getState();
  if (lifecycle === 'setup') {
    await store.setupWorkspace('workspace-a', 'wt-1');
    return;
  }
  if (lifecycle === 'launch') {
    await store.launchWorkspace('workspace-a', 'wt-1');
    return;
  }
  await store.teardownWorkspace('workspace-a', 'wt-1');
}

describe('projectsStore project repo adds', () => {
  const addRepoToWorkspace = jest.fn();
  const addRepoToWorktree = jest.fn();
  const archiveWorktreeRequest = jest.fn();
  const archiveWorkspaceWorktreeRequest = jest.fn();
  const checkWorktreeRemovalAdmission = jest.fn<
    ReturnType<CanopyApi['checkWorktreeRemovalAdmission']>,
    Parameters<CanopyApi['checkWorktreeRemovalAdmission']>
  >();
  const describeWorktreeDiscard = jest.fn<
    ReturnType<CanopyApi['describeWorktreeDiscard']>,
    Parameters<CanopyApi['describeWorktreeDiscard']>
  >();
  const combineWorktreeWithWorkspace = jest.fn();
  const createWorktreeRequest = jest.fn();
  const getDiffStatsBatch = jest.fn();
  const getChangedFiles = jest.fn();
  const importWorkspaceFromRepo = jest.fn();
  const createWorkspaceRequest = jest.fn();
  const loadProjectsRequest = jest.fn();
  const listArchivedContainers = jest.fn();
  const createWorkspaceWorktree = jest.fn();
  const repairWorkspaceWorktree = jest.fn();
  const removeRepoFromWorktree = jest.fn();
  const splitTemporaryWorkspace = jest.fn();
  const saveProjects = jest.fn<
    Promise<void>,
    [items?: SidebarItem[] | undefined]
  >();
  const loadProjects = jest.fn<Promise<void>, []>();
  const refreshDiffStats = jest.fn<Promise<void>, []>();
  const refreshWorktreeDiffStatsFromRemote = jest.fn<
    Promise<void>,
    [string, string]
  >();
  const refreshWorkspaceDrift = jest.fn<
    Promise<void>,
    [items?: SidebarItem[] | undefined]
  >();
  const requestFastRefresh = jest.fn();
  const fetchFileIndex = jest.fn<Promise<void>, [string, string]>();
  const invalidateFileList = jest.fn<void, [string, string]>();
  const inspectHookChatPluginDependencies = jest.fn();
  const inspectRecommendedPlugins = jest.fn();
  const applyRecommendedPlugins = jest.fn();
  const scheduleTaskBranchNaming = jest.fn();
  const onWorktreeGitReady = jest.fn<
    () => void,
    [(event: WorktreeGitReadyEvent) => void]
  >();
  const onWorktreeGitFailed = jest.fn<
    () => void,
    [(event: WorktreeGitFailedEvent) => void]
  >();
  const onWorktreeBranchChanged = jest.fn<
    () => void,
    [(event: WorktreeBranchChangedEvent) => void]
  >();
  const onWorktreeNeedsRepair = jest.fn<
    () => void,
    [(event: WorktreeNeedsRepairEvent) => void]
  >();
  const onWorkspaceWorktreesUpdated = jest.fn<
    () => void,
    [(event: WorkspaceWorktreesUpdatedEvent) => void]
  >();
  const onWorktreesFileChanged = jest.fn<
    () => void,
    [(event: WorktreesFileChangedEvent) => void]
  >();
  const onWorkspaceSplitTemporaryComplete = jest.fn<
    () => void,
    [(event: SplitTemporaryWorkspaceCompleteEvent) => void]
  >();
  const onOrgProjectOwnershipChanged = jest.fn<
    () => void,
    [(event: OrgProjectOwnershipChangedEvent) => void]
  >(() => (): void => {});
  const stopHook = jest.fn();
  const stopScript = jest.fn();
  const cancelWorktreeSetup = jest.fn<
    ReturnType<CanopyApi['cancelWorktreeSetup']>,
    Parameters<CanopyApi['cancelWorktreeSetup']>
  >();
  const runScript = jest.fn<
    ReturnType<CanopyApi['runScript']>,
    Parameters<CanopyApi['runScript']>
  >();
  const selectWorktree = jest.fn<void, [string, string]>();
  const cleanupChatWorktree = jest.fn<void, [string, string]>();
  const flushWorktreeTabs = jest.fn<Promise<void>, [string, string]>();
  const suppressWorktreePersistence = jest.fn<void, [string, string]>();
  const resumeWorktreePersistence = jest.fn<void, [string, string]>();
  const dropWorktreeQueuedState = jest.fn<void, [string, string]>();
  const flushPendingChatsForWorktree = jest.fn<void, [string, string]>();
  const flushPendingForWorktree = jest.fn<Promise<void>, [string, string]>();
  const refreshWorktreeTabDiscoveries = jest.fn<void, [string, string]>();
  const queueWorktreeTabDiscoveryRefresh = jest.fn<void, [string, string]>();
  const syncEmptyChatPluginSelections = jest.fn<
    Promise<void>,
    Parameters<
      ReturnType<typeof useChatStore.getState>['syncEmptyChatPluginSelections']
    >
  >((): Promise<void> => Promise.resolve());
  const dropPendingForWorktree = jest.fn<void, [string, string]>();
  let worktreeGitReadyHandler: ((event: WorktreeGitReadyEvent) => void) | null =
    null;
  let worktreeGitFailedHandler:
    | ((event: WorktreeGitFailedEvent) => void)
    | null = null;
  let worktreeBranchChangedHandler:
    | ((event: WorktreeBranchChangedEvent) => void)
    | null = null;
  let worktreeNeedsRepairHandler:
    | ((event: WorktreeNeedsRepairEvent) => void)
    | null = null;
  let workspaceWorktreesUpdatedHandler:
    | ((event: WorkspaceWorktreesUpdatedEvent) => void)
    | null = null;
  let splitTemporaryWorkspaceCompleteHandler:
    | ((event: SplitTemporaryWorkspaceCompleteEvent) => void)
    | null = null;

  it.each([undefined, false, true])(
    'preserves import activation unless opted out (%s)',
    async (activate): Promise<void> => {
      const activation = jest
        .spyOn(
          useStandaloneChatStore.getState(),
          'activateCreatedCoworkWorkspace',
        )
        .mockResolvedValue(true);
      const addWorkspaceFromFolder = jest
        .fn()
        .mockResolvedValue({ id: 'imported-cowork', type: 'cowork' });
      Object.assign(window.api, { addWorkspaceFromFolder });
      useProjectsStore.setState({ loadProjects });
      try {
        const id = await useProjectsStore
          .getState()
          .addLocalRepo(
            '/notes',
            activate === undefined ? undefined : { activate },
          );
        expect(id).toEqual({ id: 'imported-cowork', type: 'cowork' });
        expect(loadProjects).toHaveBeenCalledTimes(1);
        expect(activation).toHaveBeenCalledTimes(activate === false ? 0 : 1);
      } finally {
        activation.mockRestore();
      }
    },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    __resetProjectsStoreArchiveSuppressionForTests();
    worktreeGitReadyHandler = null;
    worktreeGitFailedHandler = null;
    worktreeBranchChangedHandler = null;
    worktreeNeedsRepairHandler = null;
    workspaceWorktreesUpdatedHandler = null;
    splitTemporaryWorkspaceCompleteHandler = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        addRepoToWorkspace,
        addRepoToWorktree,
        archiveWorktree: archiveWorktreeRequest,
        archiveWorkspaceWorktree: archiveWorkspaceWorktreeRequest,
        checkWorktreeRemovalAdmission,
        describeWorktreeDiscard,
        combineWorktreeWithWorkspace,
        createWorktree: createWorktreeRequest,
        createWorkspaceWorktree,
        getDiffStatsBatch,
        activity: {
          getChangedFiles,
        },
        importWorkspaceFromRepo,
        createWorkspace: createWorkspaceRequest,
        loadProjects: loadProjectsRequest,
        archivedContainers: {
          list: listArchivedContainers,
        },
        saveProjects,
        onWorktreeGitFailed,
        onWorktreeGitReady,
        onWorktreeBranchChanged,
        onWorktreeNeedsRepair,
        onWorkspaceWorktreesUpdated,
        onWorktreesFileChanged,
        onWorkspaceSplitTemporaryComplete,
        orgProjects: { onOwnershipChanged: onOrgProjectOwnershipChanged },
        repairWorkspaceWorktree,
        removeRepoFromWorktree,
        splitTemporaryWorkspace,
        runScript,
        scheduleTaskBranchNaming,
        stopHook,
        stopScript,
        cancelWorktreeSetup,
        inspectHookChatPluginDependencies,
        inspectRecommendedPlugins,
        applyRecommendedPlugins,
      },
    });

    archiveWorktreeRequest.mockResolvedValue({ success: true, warnings: [] });
    checkWorktreeRemovalAdmission.mockResolvedValue({ status: 'admitted' });
    describeWorktreeDiscard.mockRejectedValue(new Error('not described'));
    addRepoToWorktree.mockResolvedValue(undefined);
    archiveWorkspaceWorktreeRequest.mockResolvedValue({
      success: true,
      warnings: [],
    });
    loadProjectsRequest.mockResolvedValue({ version: 1, items: [] });
    listArchivedContainers.mockResolvedValue([]);
    saveProjects.mockResolvedValue(undefined);
    getDiffStatsBatch.mockResolvedValue([]);
    getChangedFiles.mockResolvedValue({ uncommitted: [], committed: [] });
    loadProjects.mockResolvedValue(undefined);
    refreshDiffStats.mockResolvedValue(undefined);
    refreshWorkspaceDrift.mockResolvedValue(undefined);
    fetchFileIndex.mockResolvedValue(undefined);
    inspectHookChatPluginDependencies.mockResolvedValue({ items: [] });
    inspectRecommendedPlugins.mockResolvedValue({
      items: [],
      promptItems: [],
      scopeLabel: '',
      workspaceId: '',
    });
    applyRecommendedPlugins.mockResolvedValue({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-1',
      results: [],
      defaultPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      recommendedPluginOptOutKeys: [],
    });
    scheduleTaskBranchNaming.mockResolvedValue(undefined);
    removeRepoFromWorktree.mockResolvedValue(undefined);
    stopHook.mockResolvedValue(null);
    stopScript.mockResolvedValue(null);
    cancelWorktreeSetup.mockResolvedValue(undefined);
    flushWorktreeTabs.mockResolvedValue(undefined);
    runScript.mockResolvedValue(createScriptRunResponse());
    onWorktreeGitReady.mockImplementation((callback) => {
      worktreeGitReadyHandler = callback;
      return (): void => {};
    });
    onWorktreeGitFailed.mockImplementation((callback) => {
      worktreeGitFailedHandler = callback;
      return (): void => {};
    });
    onWorktreeBranchChanged.mockImplementation((callback) => {
      worktreeBranchChangedHandler = callback;
      return (): void => {};
    });
    onWorktreeNeedsRepair.mockImplementation((callback) => {
      worktreeNeedsRepairHandler = callback;
      return (): void => {};
    });
    onWorkspaceWorktreesUpdated.mockImplementation((callback) => {
      workspaceWorktreesUpdatedHandler = callback;
      return (): void => {};
    });
    onWorktreesFileChanged.mockImplementation(() => (): void => {});
    onWorkspaceSplitTemporaryComplete.mockImplementation((callback) => {
      splitTemporaryWorkspaceCompleteHandler = callback;
      return (): void => {};
    });

    useChatStore.setState({
      cleanupWorktree: cleanupChatWorktree,
      deselectWorktree: jest.fn(),
      dropWorktreeQueuedState,
      flushPendingChatsForWorktree,
      flushWorktreeTabs,
      queueWorktreeTabDiscoveryRefresh,
      refreshWorktreeTabDiscoveries,
      resumeWorktreePersistence,
      selectedWorktree: null,
      selectWorktree,
      suppressWorktreePersistence,
      syncEmptyChatPluginSelections,
    });
    useFileListStore.setState({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set<string>(),
      indexVersions: {},
      rootsCache: {},
      rootsErrors: {},
      rootsLoading: new Set<string>(),
      rootsVersions: {},
      directoryCache: {},
      directoryErrors: {},
      directoryLoading: new Set<string>(),
      directoryVersions: {},
      fetchFileIndex,
      invalidate: invalidateFileList,
    });
    useHooksStore.setState({ runs: {} });
    useScriptsStore.setState({ runs: {} });
    flushPendingForWorktree.mockResolvedValue(undefined);
    usePipelineRunsStore.setState({
      dropPendingForWorktree,
      flushPendingForWorktree,
    });
    useGitHubStore.setState({ requestFastRefresh });
    useActivityStore.setState({ changedFiles: {} });
    useArchivedContainersStore.setState({
      byWorkspace: {},
      loadedWorkspaces: {},
      loadingWorkspaces: {},
      viewer: null,
      changesList: null,
      pullRequestStatusByContainer: {},
      restoringContainer: null,
    });
  });

  it('reconciles a split failure emitted before the fast response', async () => {
    const sourceProject: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-split',
      name: 'Workspace Split',
      color: '#111111',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      worktrees: [
        {
          id: 'wt-source',
          branchName: 'feature/source',
          createdAt: '2026-08-04T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      temporary: true,
    };
    useProjectsStore.setState({
      projects: [sourceProject],
      loadProjects,
    });
    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    splitTemporaryWorkspace.mockImplementation(() => {
      if (!splitTemporaryWorkspaceCompleteHandler) {
        throw new Error('Expected split completion handler to be registered');
      }
      splitTemporaryWorkspaceCompleteHandler({
        workspaceId: 'workspace-split',
        worktreeId: 'wt-source',
        success: false,
        results: [],
        warnings: [],
        error: 'background split failed',
      });
      return Promise.resolve({
        success: true,
        results: [],
        warnings: [],
        navigationTarget: { kind: 'home' },
      });
    });

    await expect(
      useProjectsStore
        .getState()
        .splitTemporaryWorkspaceWorktree(
          'workspace-split',
          'wt-source',
          { 'repo-a': 'split' },
          'delete',
        ),
    ).rejects.toThrow('background split failed');

    expect(useProjectsStore.getState().projects).toEqual([sourceProject]);
    expect(resumeWorktreePersistence).toHaveBeenCalledWith(
      'workspace-split',
      'wt-source',
    );
    expect(cleanupChatWorktree).not.toHaveBeenCalled();
  });

  it('selects the restored source after a background rollback removes the destination', async () => {
    const sourceProject: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-split',
      name: 'Workspace Split',
      color: '#111111',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      worktrees: [
        {
          id: 'wt-source',
          branchName: 'feature/source',
          createdAt: '2026-08-04T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      temporary: true,
    };
    useProjectsStore.setState({ projects: [], loadProjects });
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'destination',
        worktreeId: 'destination-wt',
      },
    });
    loadProjects.mockImplementationOnce(() => {
      useProjectsStore.setState({ projects: [sourceProject] });
      return Promise.resolve();
    });
    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!splitTemporaryWorkspaceCompleteHandler) {
      throw new Error('Expected split completion handler to be registered');
    }

    splitTemporaryWorkspaceCompleteHandler({
      workspaceId: 'workspace-split',
      worktreeId: 'wt-source',
      success: false,
      results: [],
      warnings: [],
      error: 'background split failed',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(selectWorktree).toHaveBeenCalledWith('workspace-split', 'wt-source');
  });

  it('syncs the current empty chat tab after accepting recommendations', async () => {
    const defaultPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'github:owner/repo', skillName: 'recommended' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    applyRecommendedPlugins.mockResolvedValue({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-a',
      results: [
        { key: 'skill:github:owner/repo:recommended', status: 'selected' },
      ],
      defaultPluginSelections,
      recommendedPluginOptOutKeys: [],
    });
    useProjectsStore.setState({ loadProjects });

    const response = await useProjectsStore.getState().applyRecommendedPlugins({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-a',
      selectedKeys: ['skill:github:owner/repo:recommended'],
      optOutKeys: [],
    });

    expect(response.results).toEqual([
      { key: 'skill:github:owner/repo:recommended', status: 'selected' },
    ]);
    expect(response.defaultPluginSelections).toEqual(defaultPluginSelections);
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(syncEmptyChatPluginSelections).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
      defaultPluginSelections,
      { repoId: 'repo-a' },
    );
  });

  it('runs project after-launch only after all child launch scripts settle', async () => {
    const repoA = createDeferred<ScriptRunResponse>();
    const repoB = createDeferred<ScriptRunResponse>();

    runScript.mockImplementation((request) => {
      if (request.target === 'workspace-repo' && request.repoId === 'repo-a') {
        return repoA.promise;
      }
      if (request.target === 'workspace-repo' && request.repoId === 'repo-b') {
        return repoB.promise;
      }
      return Promise.resolve(createScriptRunResponse());
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          effectiveScripts: {
            'after-launch': 'npm run after-launch',
          },
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              effectiveScripts: {
                launch: 'npm run launch:a',
              },
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              repoPath: '/repos/repo-b',
              effectiveScripts: {
                launch: 'npm run launch:b',
              },
            },
          ],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const launchPromise = useProjectsStore
      .getState()
      .launchWorkspace('workspace-a', 'wt-1');

    await Promise.resolve();

    expect(runScript.mock.calls.map(([request]) => request.scriptName)).toEqual(
      ['launch', 'launch'],
    );

    repoA.resolve(createScriptRunResponse());
    await Promise.resolve();

    expect(runScript.mock.calls.map(([request]) => request.scriptName)).toEqual(
      ['launch', 'launch'],
    );

    repoB.resolve(createScriptRunResponse());
    await launchPromise;

    expect(runScript.mock.calls.map(([request]) => request.scriptName)).toEqual(
      ['launch', 'launch', 'after-launch'],
    );
    expect(invalidateFileList).toHaveBeenCalledTimes(3);
    expect(invalidateFileList).toHaveBeenNthCalledWith(
      1,
      'workspace-a',
      'wt-1',
    );
    expect(invalidateFileList).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'wt-1',
    );
    expect(invalidateFileList).toHaveBeenNthCalledWith(
      3,
      'workspace-a',
      'wt-1',
    );
    expect(queueWorktreeTabDiscoveryRefresh).not.toHaveBeenCalled();
  });

  it('skips project after-launch when a child launch fails', async () => {
    const repoA = createDeferred<ScriptRunResponse>();
    const repoB = createDeferred<ScriptRunResponse>();

    runScript.mockImplementation((request) => {
      if (request.target === 'workspace-repo' && request.repoId === 'repo-a') {
        return repoA.promise;
      }
      if (request.target === 'workspace-repo' && request.repoId === 'repo-b') {
        return repoB.promise;
      }
      return Promise.resolve(createScriptRunResponse());
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          effectiveScripts: {
            'after-launch': 'npm run after-launch',
          },
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              effectiveScripts: {
                launch: 'npm run launch:a',
              },
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              repoPath: '/repos/repo-b',
              effectiveScripts: {
                launch: 'npm run launch:b',
              },
            },
          ],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const launchPromise = useProjectsStore
      .getState()
      .launchWorkspace('workspace-a', 'wt-1');

    await Promise.resolve();

    expect(runScript.mock.calls.map(([request]) => request.scriptName)).toEqual(
      ['launch', 'launch'],
    );

    repoA.resolve(createScriptRunResponse());
    repoB.resolve({
      success: false,
      exitCode: 1,
      output: 'repo-b failed',
      timedOut: false,
      durationMs: 10,
    });

    await expect(launchPromise).rejects.toThrow('repo-b failed');
    expect(runScript.mock.calls.map(([request]) => request.scriptName)).toEqual(
      ['launch', 'launch'],
    );
  });

  it.each<ProjectLifecycleScriptName>(['setup', 'teardown'])(
    'runs project after-%s only after all child %s scripts settle',
    async (lifecycle) => {
      const repoA = createDeferred<ScriptRunResponse>();
      const repoB = createDeferred<ScriptRunResponse>();

      runScript.mockImplementation((request) => {
        if (
          request.target === 'workspace-repo' &&
          request.repoId === 'repo-a'
        ) {
          return repoA.promise;
        }
        if (
          request.target === 'workspace-repo' &&
          request.repoId === 'repo-b'
        ) {
          return repoB.promise;
        }
        return Promise.resolve(createScriptRunResponse());
      });

      useProjectsStore.setState({
        projects: [
          {
            type: 'multi-repo',
            id: 'workspace-a',
            name: 'Workspace A',
            color: '#111111',
            effectiveScripts: {
              [`after-${lifecycle}`]: `npm run after-${lifecycle}`,
            },
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                repoPath: '/repos/repo-a',
                effectiveScripts: {
                  [lifecycle]: `npm run ${lifecycle}:a`,
                },
              },
              {
                id: 'repo-b',
                name: 'Repo B',
                repoPath: '/repos/repo-b',
                effectiveScripts: {
                  [lifecycle]: `npm run ${lifecycle}:b`,
                },
              },
            ],
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });

      const lifecyclePromise = runWorkspaceLifecycle(lifecycle);

      await Promise.resolve();

      expect(
        runScript.mock.calls.map(([request]) => request.scriptName),
      ).toEqual([lifecycle, lifecycle]);

      repoA.resolve(createScriptRunResponse());
      await Promise.resolve();

      expect(
        runScript.mock.calls.map(([request]) => request.scriptName),
      ).toEqual([lifecycle, lifecycle]);

      repoB.resolve(createScriptRunResponse());
      await lifecyclePromise;

      expect(
        runScript.mock.calls.map(([request]) => request.scriptName),
      ).toEqual([lifecycle, lifecycle, `after-${lifecycle}`]);
    },
  );

  it('refreshes loaded chat tab discovery after each successful setup script phase', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          effectiveScripts: {
            'before-setup': 'npm run before-setup',
            'after-setup': 'npm run after-setup',
          },
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              effectiveScripts: {
                setup: 'npm run setup:a',
              },
            },
          ],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore.getState().setupWorkspace('workspace-a', 'wt-1');

    expect(queueWorktreeTabDiscoveryRefresh).toHaveBeenCalledTimes(3);
    expect(queueWorktreeTabDiscoveryRefresh).toHaveBeenNthCalledWith(
      1,
      'workspace-a',
      'wt-1',
    );
    expect(queueWorktreeTabDiscoveryRefresh).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'wt-1',
    );
    expect(queueWorktreeTabDiscoveryRefresh).toHaveBeenNthCalledWith(
      3,
      'workspace-a',
      'wt-1',
    );
  });

  it('updates the project without creating a duplicate top-level repo item', async () => {
    addRepoToWorkspace.mockResolvedValue({
      repo: {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repos/repo-b',
      },
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
    });

    await useProjectsStore
      .getState()
      .addRepoToWorkspace('workspace-a', '/repos/repo-b');

    expect(addRepoToWorkspace).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      repoPath: '/repos/repo-b',
      addToSourceControl: undefined,
    });

    const items = useProjectsStore.getState().projects;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'multi-repo',
      id: 'workspace-a',
      repos: [
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/repos/repo-b',
        },
      ],
    });
    expect(saveProjects).toHaveBeenCalledWith(items);
  });

  it('does not create a duplicate single-repo item when the repo already exists', async () => {
    addRepoToWorkspace.mockResolvedValue({
      repo: {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repos/repo-b',
      },
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
        {
          type: 'single-repo',
          id: 'repo-b-project',
          name: 'Repo B',
          repoPath: '/repos/repo-b',
          color: '#222222',
          worktrees: [],
          collapsed: false,
          order: 1,
        },
      ],
      saveProjects,
    });

    await useProjectsStore
      .getState()
      .addRepoToWorkspace('workspace-a', '/repos/repo-b');

    const items = useProjectsStore.getState().projects;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/repos/repo-b',
        },
      ],
    });
    expect(items[1]).toMatchObject({
      type: 'single-repo',
      id: 'repo-b-project',
      repoPath: '/repos/repo-b',
      order: 1,
    });
    expect(saveProjects).toHaveBeenCalledWith(items);
  });

  it('refreshes repo branch snapshots after adding a repo to a worktree', async () => {
    const retryWorktreeHealthCheck = jest.fn().mockResolvedValue({
      healthy: true,
      worktree: { id: 'wt-1', branchName: 'feature' },
    });
    useProjectsStore.setState({
      retryWorktreeHealthCheck,
      refreshDiffStats,
    });

    await useProjectsStore
      .getState()
      .addRepoToWorktree('workspace-a', 'wt-1', 'repo-b');

    expect(addRepoToWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-b',
    });
    expect(retryWorktreeHealthCheck).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
    );
    expect(refreshDiffStats).toHaveBeenCalledTimes(1);
  });

  it('refreshes repo branch snapshots after removing a repo from a worktree', async () => {
    const retryWorktreeHealthCheck = jest.fn().mockResolvedValue({
      healthy: true,
      worktree: { id: 'wt-1', branchName: 'feature' },
    });
    useProjectsStore.setState({
      retryWorktreeHealthCheck,
      refreshDiffStats,
    });

    await useProjectsStore
      .getState()
      .removeRepoFromWorktree('workspace-a', 'wt-1', 'repo-b');

    expect(removeRepoFromWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-1',
      repoId: 'repo-b',
    });
    expect(retryWorktreeHealthCheck).toHaveBeenCalledWith(
      'workspace-a',
      'wt-1',
    );
    expect(refreshDiffStats).toHaveBeenCalledTimes(1);
  });

  it('reloads sidebar state after importing a project', async () => {
    importWorkspaceFromRepo.mockResolvedValue({
      workspace: {
        type: 'multi-repo',
        id: 'workspace-b',
        name: 'Workspace B',
        color: '#111111',
        repos: [],
        worktrees: [],
        collapsed: false,
        order: 0,
        sourceRepoPath: '/repos/workspace-b',
      },
      clonedRepoIds: [],
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      loadProjects,
    });

    const workspaceId = await useProjectsStore
      .getState()
      .importWorkspaceFromRepo('/repos/workspace-b');

    expect(workspaceId).toBe('workspace-b');
    expect(importWorkspaceFromRepo).toHaveBeenCalledWith({
      repoPath: '/repos/workspace-b',
    });
    expect(saveProjects).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledTimes(1);
  });

  it('reloads sidebar state after creating a multi-repo project, without saving it (CAN-3806 D11)', async () => {
    createWorkspaceRequest.mockResolvedValue({
      type: 'multi-repo',
      id: 'workspace-b',
      name: 'Workspace B',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 1,
      sourceRepoPath: '/data/repos/workspace-b',
    });
    useProjectsStore.setState({ projects: [], saveProjects, loadProjects });

    const workspaceId = await useProjectsStore
      .getState()
      .createWorkspace('Workspace B');

    expect(workspaceId).toBe('workspace-b');
    expect(createWorkspaceRequest).toHaveBeenCalledWith({
      name: 'Workspace B',
    });
    // Main indexed the project in the create itself.
    expect(saveProjects).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledTimes(1);
  });

  it('selects a newly created multi-repo worktree', async () => {
    createWorkspaceWorktree.mockResolvedValue({
      id: 'wt-1',
      branchName: 'wt-1',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: true,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore.getState().createWorktree('workspace-a');

    expect(createWorkspaceWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      existingWorktreeIds: [],
    });
    expect(selectWorktree).toHaveBeenCalledWith('workspace-a', 'wt-1', {
      newlyCreated: true,
    });
  });

  it('registers a newly created worktree at the top of its project', async () => {
    createWorkspaceWorktree.mockResolvedValue({
      id: 'wt-new',
      branchName: 'wt-new',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [
            {
              id: 'wt-existing',
              branchName: 'wt-existing',
              createdAt: '2026-05-21T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore.getState().createWorktree('workspace-a');

    const project = useProjectsStore.getState().projects[0];
    expect(
      project?.type === 'cowork'
        ? []
        : project?.worktrees.map((worktree) => worktree.id),
    ).toEqual(['wt-new', 'wt-existing']);
  });

  it('starts git detail refresh after combining without blocking the modal flow', async () => {
    jest.useFakeTimers();
    try {
      const destinationWorktree = {
        id: 'wt-1',
        branchName: 'feature/add-workspace',
        createdAt: '2026-05-21T00:00:00.000Z',
      };
      getDiffStatsBatch.mockResolvedValueOnce([
        {
          projectId: 'temp-workspace',
          worktreeId: 'wt-1',
          insertions: 3,
          deletions: 1,
          hasCommitsAhead: true,
          repoBranches: [
            {
              repoId: 'repo-a',
              repoName: 'Repo A',
              branch: 'feature/add-workspace',
              baseBranch: 'release/2.0',
              insertions: 2,
              deletions: 0,
              commitsAhead: true,
              hasUncommittedChanges: true,
              hasRemoteTrackingBranch: false,
              hasUnpushedCommits: true,
              hasUnpulledCommits: false,
              hasBranchBeenPushed: false,
              baseBranchExistsLocally: true,
              baseBranchExistsInRemote: true,
              hasOriginRemote: true,
            },
          ],
        },
      ]);
      combineWorktreeWithWorkspace.mockResolvedValue({
        sourceWorkspaceId: 'repo-a',
        sourceWorktreeId: 'wt-1',
        destinationWorkspaceId: 'temp-workspace',
        destinationWorktreeId: 'wt-1',
        destinationWorkspace: {
          type: 'multi-repo',
          id: 'temp-workspace',
          name: 'Repo A & Repo B',
          color: '#111111',
          repos: [
            { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
            { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
          ],
          worktrees: [destinationWorktree],
          collapsed: false,
          order: 0,
          temporary: true,
        },
        destinationWorktree,
        repoMappings: [],
        selectedRepoIdRewrites: {},
        filePathRewrites: [],
        compatibilitySymlinks: [],
        createdTemporaryWorkspace: true,
        reusedWorkspace: false,
        removedSourceWorktree: true,
      });

      useProjectsStore.setState({
        loadProjects,
        refreshDiffStats,
        projects: [],
      });

      const result = await useProjectsStore
        .getState()
        .combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'repo-a',
          sourceWorktreeId: 'wt-1',
          joinWorkspaceId: 'repo-b',
          mode: 'temporary',
        });

      expect(result?.destinationWorkspaceId).toBe('temp-workspace');
      expect(loadProjects).toHaveBeenCalledWith({ silent: true });
      expect(getDiffStatsBatch).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
      expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);
      expect(getDiffStatsBatch).toHaveBeenCalledWith({
        worktrees: [{ projectId: 'temp-workspace', worktreeId: 'wt-1' }],
        skipFetch: undefined,
        source: 'renderer-targeted',
      });
      expect(loadProjects.mock.invocationCallOrder[0]).toBeLessThan(
        getDiffStatsBatch.mock.invocationCallOrder[0],
      );
      expect(
        useProjectsStore.getState().diffStats['temp-workspace/wt-1'],
      ).toEqual({ insertions: 3, deletions: 1 });
      expect(
        useProjectsStore.getState().repoBranches['temp-workspace/wt-1'],
      ).toEqual([
        expect.objectContaining({
          repoId: 'repo-a',
          branch: 'feature/add-workspace',
          baseBranch: 'release/2.0',
        }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes a temporary multi-repo project when canceling its only pending repair worktree', async () => {
    archiveWorkspaceWorktreeRequest.mockResolvedValueOnce({
      success: true,
      warnings: [],
      removedTemporaryWorkspaceId: 'workspace-temp',
      removedTemporaryWorkspaceName: 'Repo A & Repo B',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-temp',
          name: 'Repo A & Repo B',
          color: '#111111',
          repos: [
            { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
            { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
          ],
          worktrees: [
            {
              id: 'wt-repair',
              branchName: 'wt-repair',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          temporary: true,
        },
      ],
      pendingWorkspaceRepair: {
        workspaceId: 'workspace-temp',
        workspaceName: 'Repo A & Repo B',
        id: 'wt-repair',
        branchName: 'wt-repair',
        repairIssues: [],
      },
      workspaceRepairPending: false,
    });

    await useProjectsStore.getState().cancelPendingWorkspaceRepair();

    expect(archiveWorkspaceWorktreeRequest).toHaveBeenCalledWith({
      workspaceId: 'workspace-temp',
      worktreeId: 'wt-repair',
    });
    expect(useProjectsStore.getState().pendingWorkspaceRepair).toBeNull();
    expect(useProjectsStore.getState().projects).toEqual([]);
    // Cancelling is the terminal outcome for the kept-alive chat state
    // (including any message queued before setup) — it is torn down here.
    expect(cleanupChatWorktree).toHaveBeenCalledWith(
      'workspace-temp',
      'wt-repair',
    );
    expect(dropWorktreeQueuedState).toHaveBeenCalledWith(
      'workspace-temp',
      'wt-repair',
    );
  });

  it('hydrates single-repo worktree scripts and hooks from the create response', async () => {
    createWorktreeRequest.mockResolvedValue({
      id: 'wt-1',
      branchName: 'wt-1',
      effectiveScripts: {
        launch: 'npm run dev',
      },
      effectiveHooks: {
        'pr:create': [{ type: 'command', command: 'echo hook' }],
      },
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [],
          collapsed: true,
          order: 0,
          effectiveScripts: {},
          effectiveHooks: {},
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore.getState().createWorktree('project-a');

    expect(createWorktreeRequest).toHaveBeenCalledWith({
      projectId: 'project-a',
      repoPath: '/repos/project-a',
      existingWorktreeIds: [],
      baseWorktreeId: undefined,
    });

    const state = useProjectsStore.getState();
    expect(
      countConfiguredScripts(
        state.projects,
        'project-a',
        'wt-1',
        state.appliedProjectWorktreeScripts,
      ),
    ).toBe(1);
    expect(
      countConfiguredHooks(
        state.projects,
        'project-a',
        'wt-1',
        state.appliedProjectWorktreeHooks,
      ),
    ).toBe(1);
  });

  it('selects a newly created multi-repo worktree before async post-create refreshes finish', async () => {
    createWorkspaceWorktree.mockResolvedValue({
      id: 'wt-early',
      branchName: 'wt-early',
    });

    let saveProjectsPending = false;
    let resolveSaveProjects = (): void => {
      throw new Error('Expected saveProjects to be pending');
    };
    saveProjects.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          saveProjectsPending = true;
          resolveSaveProjects = resolve;
        }),
    );

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: true,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    const onRegistered = jest.fn();
    const creationPromise = useProjectsStore
      .getState()
      .createWorktree('workspace-a', { onRegistered });
    await Promise.resolve();
    await Promise.resolve();

    expect(selectWorktree).toHaveBeenCalledWith('workspace-a', 'wt-early', {
      newlyCreated: true,
    });
    expect(onRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wt-early', branchName: 'wt-early' }),
    );
    expect(selectWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      onRegistered.mock.invocationCallOrder[0],
    );
    expect(refreshDiffStats).not.toHaveBeenCalled();

    if (!saveProjectsPending) {
      throw new Error('Expected saveProjects to be pending');
    }
    resolveSaveProjects();
    await creationPromise;
  });

  it('does not run diff or file-list refreshes until a git-pending worktree becomes ready', async () => {
    const backendCreatedAt = '2026-04-29T01:49:50.372Z';
    createWorkspaceWorktree.mockResolvedValue({
      id: 'wt-pending',
      branchName: 'wt-pending',
      createdAt: backendCreatedAt,
      setupPhase: 'git-pending',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    await useProjectsStore.getState().createWorktree('workspace-a');

    const pendingWorktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a'),
    ).find((worktree) => worktree.id === 'wt-pending');
    expect(pendingWorktree?.createdAt).toBe(backendCreatedAt);
    expect(refreshDiffStats).not.toHaveBeenCalled();
    expect(fetchFileIndex).not.toHaveBeenCalled();
    expect(inspectHookChatPluginDependencies).not.toHaveBeenCalled();
    // Task H1: workspace drift is also deferred for a git-pending worktree —
    // its checkout does not exist yet, and awaiting a drift refresh that fans
    // git out across every existing worktree was the "frozen on Home" stall.
    // It must NOT run during the pending-creation finalize.
    expect(refreshWorkspaceDrift).not.toHaveBeenCalled();

    if (!worktreeGitReadyHandler) {
      throw new Error('Expected worktreeGitReady handler to be registered');
    }
    worktreeGitReadyHandler({
      projectId: 'workspace-a',
      worktreeId: 'wt-pending',
      branchName: 'feature/ready',
    });

    const readyWorktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a'),
    ).find((worktree) => worktree.id === 'wt-pending');
    expect(readyWorktree?.setupPhase).toBe('git-ready');
    expect(refreshWorktreeTabDiscoveries).toHaveBeenCalledWith(
      'workspace-a',
      'wt-pending',
    );
    // ...and the deferred drift refresh fires once git setup lands.
    expect(refreshWorkspaceDrift).toHaveBeenCalledTimes(1);
  });

  it.each(['available', 'unavailable'])(
    'samples a pending row without blocking queue dispatch when storage is %s',
    (storage) => {
      const original = useProjectsStore.getState();
      const createdAt = '2026-04-29T01:49:50.000Z';
      const readyAt = Date.parse(createdAt) + 25_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(readyAt);
      try {
        // This suite's window is a plain object; give it a storage to record in.
        const stored = new Map<string, string>();
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: {
            getItem: (key: string): string | null => {
              if (storage === 'unavailable')
                throw new Error('Storage unavailable');
              return stored.get(key) ?? null;
            },
            setItem: (key: string, value: string): void => {
              if (storage === 'unavailable')
                throw new Error('Storage unavailable');
              stored.set(key, value);
            },
          },
        });
        useProjectsStore.setState({
          refreshWorktreeDiffStats: jest.fn().mockResolvedValue(undefined),
          refreshWorkspaceDrift: jest.fn().mockResolvedValue(undefined),
          inspectHookChatPluginDependencies: jest
            .fn()
            .mockResolvedValue(undefined),
          inspectRecommendedPlugins: jest.fn().mockResolvedValue(undefined),
          projects: [
            {
              type: 'multi-repo',
              id: 'workspace-a',
              name: 'Workspace A',
              color: '#111111',
              repos: [],
              worktrees: [
                {
                  id: 'wt-pending',
                  branchName: 'wt-pending',
                  createdAt,
                  setupPhase: 'git-pending',
                },
              ],
              collapsed: false,
              order: 0,
              sourceRepoPath: '/repos/workspace-a',
            },
          ],
        });
        useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
        if (!worktreeGitReadyHandler) {
          throw new Error('Expected worktreeGitReady handler to be registered');
        }
        const event = {
          projectId: 'workspace-a',
          worktreeId: 'wt-pending',
          branchName: 'feature/ready',
        };
        worktreeGitReadyHandler(event);
        expect(readWorktreeSetupDuration('workspace-a')).toBe(
          storage === 'available' ? 25_000 : null,
        );
        expect(
          useChatStore.getState().flushPendingChatsForWorktree,
        ).toHaveBeenCalledWith('workspace-a', 'wt-pending');

        // A replayed event finds the row ready and records nothing new.
        now.mockReturnValue(readyAt + 60_000);
        worktreeGitReadyHandler(event);
        expect(readWorktreeSetupDuration('workspace-a')).toBe(
          storage === 'available' ? 25_000 : null,
        );
      } finally {
        now.mockRestore();
        useProjectsStore.setState({
          refreshWorktreeDiffStats: original.refreshWorktreeDiffStats,
          refreshWorkspaceDrift: original.refreshWorkspaceDrift,
          inspectHookChatPluginDependencies:
            original.inspectHookChatPluginDependencies,
          inspectRecommendedPlugins: original.inspectRecommendedPlugins,
        });
      }
    },
  );

  it('retries hook dependency inspection once a git-pending worktree becomes ready', async () => {
    createWorkspaceWorktree.mockResolvedValue({
      id: 'wt-pending',
      branchName: 'reserved-name',
      setupPhase: 'git-pending',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    await useProjectsStore.getState().createWorktree('workspace-a');

    expect(inspectHookChatPluginDependencies).not.toHaveBeenCalled();
    if (!worktreeGitReadyHandler) {
      throw new Error('Expected worktreeGitReady handler to be registered');
    }

    worktreeGitReadyHandler({
      projectId: 'workspace-a',
      worktreeId: 'wt-pending',
      branchName: 'feature/ready',
    });

    expect(inspectHookChatPluginDependencies).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'wt-pending',
    });
  });

  it('silently re-reads projects when a conversion changes a workspace owner (CAN-3415)', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      const unsubscribe = useProjectsStore
        .getState()
        .subscribeToWorktreeGitLifecycleEvents();
      const handler = onOrgProjectOwnershipChanged.mock.calls.at(-1)?.[0];
      if (!handler) throw new Error('Expected an ownership listener');
      handler({
        workspaceId: 'workspace-a',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        projectId: 'project',
        owner: 'organization',
      });
      jest.runOnlyPendingTimers();

      expect(loadProjectsAction).toHaveBeenCalledWith({ silent: true });
      unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });

  it('silently re-reads the project after the debounce window once a main-initiated worktrees update event fires', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      expect(onWorkspaceWorktreesUpdated).toHaveBeenCalledTimes(1);

      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }
      workspaceWorktreesUpdatedHandler({ workspaceId: 'workspace-a' });

      // The reload is debounced, so it must not fire synchronously.
      expect(loadProjectsAction).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();

      expect(loadProjectsAction).toHaveBeenCalledTimes(1);
      expect(loadProjectsAction).toHaveBeenCalledWith({ silent: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies a concrete worktree update event immediately without reloading projects', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({
        loadProjects: loadProjectsAction,
        projects: [
          {
            type: 'multi-repo',
            id: 'workspace-a',
            name: 'Workspace A',
            color: '#111111',
            repos: [],
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/hooks',
                createdAt: '2026-07-10T00:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
          },
        ],
      });

      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      workspaceWorktreesUpdatedHandler({
        workspaceId: 'workspace-a',
        worktree: {
          id: 'wt-1',
          branchName: 'feature/hooks',
          createdAt: '2026-07-10T00:00:00.000Z',
          pausedHookKeys: ['project:pr:create'],
        },
      });

      const workspace = useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a');
      const worktree =
        workspace?.type !== 'cowork'
          ? workspace?.worktrees.find((candidate) => candidate.id === 'wt-1')
          : undefined;

      expect(worktree?.pausedHookKeys).toEqual(['project:pr:create']);
      jest.runOnlyPendingTimers();
      expect(loadProjectsAction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('replaces a stale worktree snapshot from an authoritative update event', () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/one',
              createdAt: '2026-07-10T00:00:00.000Z',
            },
            {
              id: 'wt-2',
              branchName: 'feature/two',
              createdAt: '2026-07-10T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!workspaceWorktreesUpdatedHandler) {
      throw new Error(
        'Expected workspaceWorktreesUpdated handler to be registered',
      );
    }

    workspaceWorktreesUpdatedHandler({
      workspaceId: 'workspace-a',
      worktrees: [
        {
          id: 'wt-2',
          branchName: 'feature/two',
          createdAt: '2026-07-10T00:00:00.000Z',
          label: 'Portal label',
        },
        {
          id: 'wt-3',
          branchName: 'feature/three',
          createdAt: '2026-07-10T00:00:00.000Z',
        },
      ],
    });

    const workspace = useProjectsStore
      .getState()
      .projects.find((project) => project.id === 'workspace-a');
    const worktrees = workspace?.type === 'cowork' ? [] : workspace?.worktrees;
    expect(worktrees).toEqual([
      expect.objectContaining({ id: 'wt-2', label: 'Portal label' }),
      expect.objectContaining({ id: 'wt-3' }),
    ]);
  });

  it('adds a portal-created row from an authoritative full-list update event without reloading', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({
        loadProjects: loadProjectsAction,
        projects: [
          {
            type: 'multi-repo',
            id: 'workspace-a',
            name: 'Workspace A',
            color: '#111111',
            repos: [],
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/one',
                createdAt: '2026-07-10T00:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
          },
        ],
      });
      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      workspaceWorktreesUpdatedHandler({
        workspaceId: 'workspace-a',
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature/one',
            createdAt: '2026-07-10T00:00:00.000Z',
          },
          {
            id: 'wt-portal',
            branchName: 'feature/portal',
            createdAt: '2026-07-10T01:00:00.000Z',
          },
        ],
      });

      const workspace = useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a');
      const worktrees =
        workspace?.type === 'cowork' ? [] : workspace?.worktrees;
      expect(worktrees?.map((worktree) => worktree.id)).toEqual([
        'wt-1',
        'wt-portal',
      ]);
      jest.runOnlyPendingTimers();
      expect(loadProjectsAction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes a portal-archived row from an authoritative full-list update event without reloading', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({
        loadProjects: loadProjectsAction,
        projects: [
          {
            type: 'multi-repo',
            id: 'workspace-a',
            name: 'Workspace A',
            color: '#111111',
            repos: [],
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/one',
                createdAt: '2026-07-10T00:00:00.000Z',
              },
              {
                id: 'wt-2',
                branchName: 'feature/two',
                createdAt: '2026-07-10T00:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
          },
        ],
      });
      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      workspaceWorktreesUpdatedHandler({
        workspaceId: 'workspace-a',
        worktrees: [
          {
            id: 'wt-2',
            branchName: 'feature/two',
            createdAt: '2026-07-10T00:00:00.000Z',
          },
        ],
      });

      const workspace = useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a');
      const worktrees =
        workspace?.type === 'cowork' ? [] : workspace?.worktrees;
      expect(worktrees?.map((worktree) => worktree.id)).toEqual(['wt-2']);
      jest.runOnlyPendingTimers();
      expect(loadProjectsAction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a worktrees update event with an empty project id', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }
      workspaceWorktreesUpdatedHandler({ workspaceId: '' });

      jest.runOnlyPendingTimers();

      expect(loadProjectsAction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces a burst of worktrees update events into a single debounced reload', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      // Simulate a multi-child split emitting a burst of events for
      // different (and repeated) workspace ids in quick succession, each
      // one arriving before the debounce window elapses.
      const burstWorkspaceIds = [
        'workspace-a',
        'workspace-a',
        'workspace-b',
        'workspace-a',
        'workspace-c',
      ];
      for (const workspaceId of burstWorkspaceIds) {
        workspaceWorktreesUpdatedHandler({ workspaceId });
        jest.advanceTimersByTime(50);
      }

      expect(loadProjectsAction).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();

      expect(loadProjectsAction).toHaveBeenCalledTimes(1);
      expect(loadProjectsAction).toHaveBeenCalledWith({ silent: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules a fresh reload for an event that arrives after the debounce window already fired', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      workspaceWorktreesUpdatedHandler({ workspaceId: 'workspace-a' });
      jest.runOnlyPendingTimers();
      expect(loadProjectsAction).toHaveBeenCalledTimes(1);

      workspaceWorktreesUpdatedHandler({ workspaceId: 'workspace-a' });
      jest.runOnlyPendingTimers();
      expect(loadProjectsAction).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the pending debounced reload on teardown', () => {
    jest.useFakeTimers();
    try {
      const loadProjectsAction = jest.fn<
        Promise<void>,
        [{ silent?: boolean }?]
      >();
      loadProjectsAction.mockResolvedValue(undefined);
      useProjectsStore.setState({ loadProjects: loadProjectsAction });

      const teardown = useProjectsStore
        .getState()
        .subscribeToWorktreeGitLifecycleEvents();
      if (!workspaceWorktreesUpdatedHandler) {
        throw new Error(
          'Expected workspaceWorktreesUpdated handler to be registered',
        );
      }

      workspaceWorktreesUpdatedHandler({ workspaceId: 'workspace-a' });
      teardown();

      jest.runOnlyPendingTimers();

      expect(loadProjectsAction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('updates branch metadata and prioritizes loaded Git info immediately from branch-change events', async () => {
    const stalePrStatus: WorktreePrStatus = {
      repos: [],
      lastCheckedAt: '2026-04-09T00:00:00.000Z',
    };
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'old-branch',
              createdAt: '2026-04-09T00:00:00.000Z',
              status: 'done',
              lastKnownPrStatus: stalePrStatus,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      refreshDiffStats,
      refreshWorktreeDiffStatsFromRemote,
    });
    useGitHubStore.setState({
      prStatuses: { 'project-a/wt-1': stalePrStatus },
    });
    useActivityStore.setState({
      changedFiles: {
        'project-a/wt-1': {
          uncommitted: [],
          committed: [
            {
              path: 'stale.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
        },
      },
    });
    getChangedFiles.mockResolvedValue({
      uncommitted: [],
      committed: [
        {
          path: 'fresh.ts',
          status: 'modified',
          insertions: 2,
          deletions: 0,
        },
      ],
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!worktreeBranchChangedHandler) {
      throw new Error(
        'Expected worktreeBranchChanged handler to be registered',
      );
    }
    worktreeBranchChangedHandler({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      branchName: 'feature/manual-rename',
    });

    const worktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'project-a'),
    ).find((entry) => entry.id === 'wt-1');
    expect(worktree?.branchName).toBe('feature/manual-rename');
    expect(worktree?.status).toBeUndefined();
    expect(worktree?.lastKnownPrStatus).toBeNull();
    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBeNull();
    expect(refreshDiffStats).not.toHaveBeenCalled();
    expect(refreshWorktreeDiffStatsFromRemote).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getChangedFiles).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });
    expect(
      useActivityStore.getState().changedFiles['project-a/wt-1']?.committed,
    ).toEqual([expect.objectContaining({ path: 'fresh.ts' })]);
    expect(requestFastRefresh).toHaveBeenCalledWith('project-a', 'wt-1');
  });

  it('clears stale PR state when the branch rename UI updates local branch metadata', () => {
    const stalePrStatus: WorktreePrStatus = {
      repos: [],
      lastCheckedAt: '2026-04-09T00:00:00.000Z',
    };
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'old-branch',
              createdAt: '2026-04-09T00:00:00.000Z',
              status: 'done',
              lastKnownPrStatus: stalePrStatus,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useGitHubStore.setState({
      prStatuses: { 'project-a/wt-1': stalePrStatus },
    });

    useProjectsStore
      .getState()
      .updateBranchName('project-a', 'wt-1', 'feature/manual-rename');

    const worktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'project-a'),
    ).find((entry) => entry.id === 'wt-1');
    expect(worktree?.branchName).toBe('feature/manual-rename');
    expect(worktree?.status).toBeUndefined();
    expect(worktree?.lastKnownPrStatus).toBeNull();
    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBeNull();
    expect(requestFastRefresh).toHaveBeenCalledWith('project-a', 'wt-1');
  });

  it('schedules pending task branch naming immediately when the worktree is already git-ready', () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-ready',
              branchName: 'feature/ready',
              createdAt: '2026-04-09T00:00:00.000Z',
              setupPhase: 'git-ready',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    useProjectsStore
      .getState()
      .enqueuePendingTaskBranchNaming('project-a', 'wt-ready', 'ship it');

    expect(scheduleTaskBranchNaming).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-ready',
      text: 'ship it',
    });
    expect(useProjectsStore.getState().pendingTaskBranchNamings).toEqual({});
  });

  it('applies a buffered git-ready event before inserting the pending row', async () => {
    createWorkspaceWorktree.mockImplementation(() => {
      if (!worktreeGitReadyHandler) {
        throw new Error('Expected worktreeGitReady handler to be registered');
      }
      worktreeGitReadyHandler({
        projectId: 'workspace-a',
        worktreeId: 'wt-fast',
        branchName: 'feature/ready-fast',
        worktreeEffective: {
          effectiveScripts: {
            'before-launch': 'echo launch',
          },
          repos: {
            repoA: {
              effectiveHooks: {
                'pr:create': [{ type: 'command', command: 'echo repo hook' }],
              },
            },
          },
        },
      });
      return {
        id: 'wt-fast',
        branchName: 'reserved-name',
        setupPhase: 'git-pending',
      };
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    const created = await useProjectsStore
      .getState()
      .createWorktree('workspace-a');

    expect(created).toEqual({ id: 'wt-fast', setupPhase: 'git-ready' });
    const worktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a'),
    ).find((wt) => wt.id === 'wt-fast');
    expect(worktree?.setupPhase).toBe('git-ready');
    expect(worktree?.branchName).toBe('feature/ready-fast');
    expect(
      getProjectWorktreeEffective(useProjectsStore.getState().projects[0])[
        'wt-fast'
      ],
    ).toEqual({
      effectiveScripts: {
        'before-launch': 'echo launch',
      },
      repos: {
        repoA: {
          effectiveHooks: {
            'pr:create': [{ type: 'command', command: 'echo repo hook' }],
          },
        },
      },
    });
  });

  it('applies buffered git-ready data when registering an externally created worktree', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!worktreeGitReadyHandler) {
      throw new Error('Expected worktreeGitReady handler to be registered');
    }

    worktreeGitReadyHandler({
      projectId: 'workspace-a',
      worktreeId: 'wt-temp',
      branchName: 'feature/temp-ready',
      worktreeEffective: {
        repos: {
          'repo-a': {
            effectiveScripts: {
              setup: 'npm install',
            },
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo hook' }],
            },
          },
        },
      },
    });

    const registered = await useProjectsStore
      .getState()
      .registerCreatedWorkspaceWorktree('workspace-a', {
        id: 'wt-temp',
        branchName: 'reserved-name',
        setupPhase: 'git-pending',
      });

    expect(registered?.setupPhase).toBe('git-ready');
    expect(registered?.branchName).toBe('feature/temp-ready');
    expect(
      getProjectWorktreeEffective(useProjectsStore.getState().projects[0])[
        'wt-temp'
      ],
    ).toEqual({
      repos: {
        'repo-a': {
          effectiveScripts: {
            setup: 'npm install',
          },
          effectiveHooks: {
            'pr:create': [{ type: 'command', command: 'echo hook' }],
          },
        },
      },
    });
    expect(selectWorktree).toHaveBeenCalledWith('workspace-a', 'wt-temp');
  });

  it('reloads projects and flushes setup queues when git-ready arrives for an unknown worktree', () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      loadProjects,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!worktreeGitReadyHandler) {
      throw new Error('Expected worktreeGitReady handler to be registered');
    }

    worktreeGitReadyHandler({
      projectId: 'workspace-a',
      worktreeId: 'automation-wt',
      branchName: 'automation-wt',
    });

    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(flushPendingChatsForWorktree).toHaveBeenCalledWith(
      'workspace-a',
      'automation-wt',
    );
    expect(flushPendingForWorktree).toHaveBeenCalledWith(
      'workspace-a',
      'automation-wt',
    );
  });

  it('registers a buffered git-failed worktree as broken instead of removing it', async () => {
    createWorkspaceWorktree.mockImplementation(() => {
      if (!worktreeGitFailedHandler) {
        throw new Error('Expected worktreeGitFailed handler to be registered');
      }
      worktreeGitFailedHandler({
        projectId: 'workspace-a',
        worktreeId: 'wt-fast-fail',
        error: 'phase b exploded',
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: 'Worktree setup failed.',
          checkedAt: '2026-05-22T00:00:00.000Z',
          worktreePath: '/workspace-worktrees/workspace-a/wt-fast-fail',
          gitError: 'phase b exploded',
        },
      });
      return {
        id: 'wt-fast-fail',
        branchName: 'reserved-name',
        setupPhase: 'git-pending',
      };
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    const created = await useProjectsStore
      .getState()
      .createWorktree('workspace-a');

    expect(created).toEqual({
      id: 'wt-fast-fail',
      setupPhase: 'git-ready',
    });
    const failedWorktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a'),
    ).find((worktree) => worktree.id === 'wt-fast-fail');
    expect(failedWorktree).toMatchObject({
      setupPhase: 'git-ready',
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        gitError: 'phase b exploded',
      },
    });
    expect(useProjectsStore.getState().worktreeError).toBe('phase b exploded');
    expect(selectWorktree).toHaveBeenCalledWith('workspace-a', 'wt-fast-fail');
  });

  it('removes the rolled-back row and opens the repair modal on a deferred needs-repair event (Task I1)', () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [
            {
              id: 'wt-repair',
              branchName: 'reserved-name',
              createdAt: '2026-05-22T00:00:00.000Z',
              setupPhase: 'git-pending',
            },
          ],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
      pendingTaskBranchNamings: {
        'workspace-a/wt-repair': {
          text: 'implement queued task',
          chatId: 'chat-1',
          selectedRepoId: 'repo-a',
        },
      },
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!worktreeNeedsRepairHandler) {
      throw new Error('Expected worktreeNeedsRepair handler to be registered');
    }

    const repairIssues = [
      {
        code: 'missing-claude-md' as const,
        message: 'CLAUDE.md missing',
        blocking: true,
      },
    ];
    worktreeNeedsRepairHandler({
      projectId: 'workspace-a',
      worktreeId: 'wt-repair',
      branchName: 'reserved-name',
      repairIssues,
      trackedRepoBaseBranches: { root: 'main' },
    });

    // The reservation was rolled back server-side, so the row is dropped and
    // the repair modal opened with the event payload — but the chat state
    // (queued message and setup-wait state) is deliberately KEPT: the repair
    // flow reuses the same worktree id and flushes the queue on success. Only
    // a cancelled repair tears the chat state down.
    const worktrees = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'workspace-a'),
    );
    expect(worktrees.find((wt) => wt.id === 'wt-repair')).toBeUndefined();
    expect(cleanupChatWorktree).not.toHaveBeenCalled();
    expect(dropWorktreeQueuedState).not.toHaveBeenCalled();
    expect(dropPendingForWorktree).not.toHaveBeenCalled();
    expect(scheduleTaskBranchNaming).not.toHaveBeenCalled();
    expect(
      useProjectsStore.getState().pendingTaskBranchNamings[
        'workspace-a/wt-repair'
      ],
    ).toEqual({
      text: 'implement queued task',
      chatId: 'chat-1',
      selectedRepoId: 'repo-a',
    });
    expect(useProjectsStore.getState().pendingWorkspaceRepair).toEqual({
      workspaceId: 'workspace-a',
      workspaceName: 'Workspace A',
      id: 'wt-repair',
      branchName: 'reserved-name',
      repairIssues,
      trackedRepoBaseBranches: { root: 'main' },
    });
  });

  it('selects a repaired project worktree once repair succeeds', async () => {
    repairWorkspaceWorktree.mockResolvedValue({
      id: 'wt-repair',
      branchName: 'wt-repair',
      createdAt: '2026-10-15T00:00:00.000Z',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      pendingWorkspaceRepair: {
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        id: 'wt-repair',
        branchName: 'wt-repair',
        repairIssues: [],
      },
      workspaceRepairPending: false,
      pendingTaskBranchNamings: {
        'workspace-a/wt-repair': {
          text: 'implement queued task',
          chatId: 'chat-1',
          selectedRepoId: 'repo-a',
        },
      },
    });

    await useProjectsStore.getState().repairPendingWorkspaceWorktree(true);

    expect(repairWorkspaceWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-repair',
      branchName: 'wt-repair',
      restoreClaudeMd: true,
    });
    expect(selectWorktree).toHaveBeenCalledWith('workspace-a', 'wt-repair');
    expect(scheduleTaskBranchNaming).toHaveBeenCalledWith({
      projectId: 'workspace-a',
      worktreeId: 'wt-repair',
      text: 'implement queued task',
      chatId: 'chat-1',
      selectedRepoId: 'repo-a',
    });
    expect(
      useProjectsStore.getState().pendingTaskBranchNamings[
        'workspace-a/wt-repair'
      ],
    ).toBeUndefined();
    // Repair completes git setup synchronously with no `worktree:git-ready`
    // event, so the store must flush any message queued before the
    // needs-repair rollback itself.
    expect(flushPendingChatsForWorktree).toHaveBeenCalledWith(
      'workspace-a',
      'wt-repair',
    );
    expect(flushPendingForWorktree).toHaveBeenCalledWith(
      'workspace-a',
      'wt-repair',
    );
    const repairedProject = useProjectsStore.getState().projects[0];
    expect(
      repairedProject?.type === 'cowork' ? [] : repairedProject?.worktrees,
    ).toEqual([
      expect.objectContaining({
        id: 'wt-repair',
        createdAt: '2026-10-15T00:00:00.000Z',
        setupPhase: 'git-ready',
      }),
    ]);
  });

  it('forwards existingBranch when repairing a deferred existing-branch worktree', async () => {
    repairWorkspaceWorktree.mockResolvedValue({
      id: 'wt-repair',
      branchName: 'feature/foo',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-a',
        },
      ],
      saveProjects,
      refreshDiffStats,
      refreshWorkspaceDrift,
      pendingWorkspaceRepair: {
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        id: 'wt-repair',
        branchName: 'feature/foo',
        existingBranch: 'feature/foo',
        repairIssues: [],
      },
      workspaceRepairPending: false,
    });

    await useProjectsStore.getState().repairPendingWorkspaceWorktree(false);

    expect(repairWorkspaceWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      worktreeId: 'wt-repair',
      branchName: 'feature/foo',
      existingBranch: 'feature/foo',
      restoreClaudeMd: false,
    });
  });

  it('stops active hooks and clears hook state when archiving a worktree', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    useHooksStore.getState().startRun('project-a', 'wt-1', {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [{ type: 'command', command: 'echo hello' }],
      target: 'project',
    });

    stopHook.mockResolvedValue({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 0,
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1', {
      deleteBranch: false,
      lockAfterArchive: true,
    });

    expect(suppressWorktreePersistence).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
    );
    expect(stopHook).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      hookKey: 'project:pr:create',
    });
    expect(useHooksStore.getState().runs['project-a/wt-1']).toBeUndefined();
    expect(cleanupChatWorktree).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(archiveWorktreeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        deleteBranch: false,
        lockAfterArchive: true,
      }),
    );
  });

  // CAN-3039: the sidebar Delete action asks main to delete outright and
  // release the staged Git capture only if main confirms the checkout is gone.
  // Archive omits the intent so the capture stays pinned.
  it('forwards a destructive delete choice to the single-repo archive IPC', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1', {
      deleteWithoutRetentionIfMissing: true,
    });

    expect(archiveWorktreeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ deleteWithoutRetentionIfMissing: true }),
    );
  });

  it('omits deleteWithoutRetentionIfMissing when archiving normally', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1', {
      lockAfterArchive: true,
    });

    expect(archiveWorktreeRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({ deleteWithoutRetentionIfMissing: true }),
    );
  });

  it('reconciles an automatically deleted selected worktree', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    await useProjectsStore
      .getState()
      .reconcileArchivedWorktree('project-a', 'wt-1');

    expect(useChatStore.getState().deselectWorktree).toHaveBeenCalled();
    expect(cleanupChatWorktree).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(dropWorktreeQueuedState).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(loadProjects).toHaveBeenCalled();
    expect(archiveWorktreeRequest).not.toHaveBeenCalled();
  });

  it('drops the temporary project a discard of its last worktree left empty (CAN-5336 review r2)', async () => {
    const temporary: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-temp',
      name: 'Repo A & Repo B',
      color: '#111111',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      temporary: true,
    };
    const other: SidebarItem = {
      type: 'single-repo',
      id: 'project-b',
      name: 'Project B',
      repoPath: '/repos/project-b',
      color: '#222222',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    useProjectsStore.setState({ projects: [temporary, other], loadProjects });
    // A refresh that still returns the pre-discard snapshot must not redraw it.
    loadProjects.mockImplementationOnce(() => {
      useProjectsStore.setState({ projects: [temporary, other] });
      return Promise.resolve();
    });

    await useProjectsStore
      .getState()
      .reconcileArchivedWorktree('workspace-temp', 'wt-1', {
        removedTemporaryWorkspaceId: 'workspace-temp',
      });

    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({ id: 'project-b' }),
    ]);
  });

  it('keeps an Always show temporary project that main reports after a discard of its last worktree', async () => {
    const pinned: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-temp',
      name: 'Repo A & Repo B',
      color: '#111111',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      temporary: true,
      alwaysShow: true,
    };
    useProjectsStore.setState({ projects: [pinned], loadProjects });
    // The authoritative reload keeps the empty project: Always show is set.
    loadProjects.mockImplementationOnce(() => {
      useProjectsStore.setState({ projects: [{ ...pinned, worktrees: [] }] });
      return Promise.resolve();
    });

    await useProjectsStore
      .getState()
      .reconcileArchivedWorktree('workspace-temp', 'wt-1', {
        removedTemporaryWorkspaceId: 'workspace-temp',
      });

    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({ id: 'workspace-temp', worktrees: [] }),
    ]);
  });

  it('removes a temporary multi-repo project from state when archive deletes its last worktree', async () => {
    archiveWorkspaceWorktreeRequest.mockResolvedValueOnce({
      success: true,
      warnings: [],
      removedTemporaryWorkspaceId: 'workspace-temp',
    });
    const originalAddToast = useGitHubStore.getState().addToast;
    const addToast = jest.fn();
    useGitHubStore.setState({ addToast });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-temp',
          name: 'Repo A & Repo B',
          color: '#111111',
          repos: [
            { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
            { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
          ],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          temporary: true,
        },
        {
          type: 'single-repo',
          id: 'project-b',
          name: 'Project B',
          repoPath: '/repos/project-b',
          color: '#222222',
          worktrees: [],
          collapsed: false,
          order: 1,
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await useProjectsStore.getState().archiveWorktree('workspace-temp', 'wt-1');

    expect(archiveWorkspaceWorktreeRequest).toHaveBeenCalledWith({
      workspaceId: 'workspace-temp',
      worktreeId: 'wt-1',
      expectedCreatedAt: '2026-04-09T00:00:00.000Z',
      remainingWorktreeOrder: [],
      expectedRemainingWorktreeOrder: [],
      typedRefusal: true,
    });
    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({ id: 'project-b' }),
    ]);
    const toastCalls = addToast.mock.calls;
    useGitHubStore.setState({ addToast: originalAddToast });
    expect(toastCalls).toContainEqual([
      'Hidden after archiving its last worktree.',
      'info',
      undefined,
      {
        workspaceName: 'Repo A & Repo B',
      },
    ]);
  });

  it('refreshes the authoritative archived-container count after archive success', async () => {
    const previousLoadProjects = useProjectsStore.getState().loadProjects;
    const archivedWorkspace: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-archive-count',
      name: 'Archive Count',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      archivedContainerCount: 1,
    };
    loadProjects.mockImplementationOnce(() => {
      useProjectsStore.setState({ projects: [archivedWorkspace] });
      return Promise.resolve();
    });
    listArchivedContainers
      // Registering the optimistic placeholder starts a pre-archive read.
      .mockResolvedValueOnce([])
      // Archive success then performs the trailing authoritative read.
      .mockResolvedValueOnce([
        {
          id: 'wt-1',
          projectId: 'workspace-archive-count',
          kind: 'worktree',
          name: 'feature/wt-1',
          branchName: 'feature/wt-1',
          archivedAt: '2026-04-09T00:00:00.000Z',
        },
      ]);
    useProjectsStore.setState({
      projects: [
        {
          ...archivedWorkspace,
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          archivedContainerCount: 0,
        },
      ],
      loadProjects,
      refreshWorkspaceDrift,
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    try {
      await useProjectsStore
        .getState()
        .archiveWorktree('workspace-archive-count', 'wt-1');

      expect(loadProjects).toHaveBeenCalledTimes(1);
      expect(listArchivedContainers).toHaveBeenCalledTimes(2);
      expect(listArchivedContainers).toHaveBeenNthCalledWith(1, {
        projectId: 'workspace-archive-count',
      });
      expect(listArchivedContainers).toHaveBeenNthCalledWith(2, {
        projectId: 'workspace-archive-count',
      });
      expect(
        useArchivedContainersStore.getState().byWorkspace[
          'workspace-archive-count'
        ],
      ).toEqual([expect.objectContaining({ id: 'wt-1' })]);
      expect(useProjectsStore.getState().projects).toEqual([archivedWorkspace]);
    } finally {
      useProjectsStore.setState({ loadProjects: previousLoadProjects });
    }
  });

  it('re-enables chat persistence when archive fails', async () => {
    archiveWorktreeRequest.mockRejectedValueOnce(new Error('archive failed'));

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await expect(
      useProjectsStore.getState().archiveWorktree('project-a', 'wt-1'),
    ).rejects.toThrow('archive failed');

    expect(resumeWorktreePersistence).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(
      useProjectsStore.getState().archivingWorktrees.has('project-a/wt-1'),
    ).toBe(false);
  });

  // Bulk removal (CAN-3975) awaits this per worktree and reads a rejection
  // as that item's failure, so a failed archive must both restore the row
  // and reject; only an unknown project resolves without doing anything.
  it('restores the row and rejects when archive fails, and resolves silently for an unknown project', async () => {
    archiveWorktreeRequest.mockRejectedValueOnce(new Error('archive failed'));
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await expect(
      useProjectsStore
        .getState()
        .archiveWorktree('project-a', 'wt-1', { lockAfterArchive: true }),
    ).rejects.toThrow('archive failed');
    const project = useProjectsStore
      .getState()
      .projects.find((item) => item.id === 'project-a');
    expect(
      project && project.type !== 'cowork'
        ? project.worktrees.map((worktree) => worktree.id)
        : [],
    ).toEqual(['wt-1']);

    archiveWorktreeRequest.mockClear();
    await expect(
      useProjectsStore.getState().archiveWorktree('project-missing', 'wt-1'),
    ).resolves.toBeUndefined();
    expect(archiveWorktreeRequest).not.toHaveBeenCalled();
  });

  describe('source admission before renderer effects (CAN-5333)', () => {
    const SOURCE_UNAVAILABLE =
      "Couldn't verify the worktree's source repositories. Check repository access and retry.";

    function seedRefusableWorktree(
      type: 'single-repo' | 'multi-repo',
      setupPhase?: 'git-pending',
    ): void {
      const worktrees: WorktreeData[] = [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
          ...(setupPhase ? { setupPhase } : {}),
        },
      ];
      useProjectsStore.setState({
        projects: [
          type === 'single-repo'
            ? {
                type,
                id: 'project-a',
                name: 'Project A',
                repoPath: '/repos/project-a',
                color: '#111111',
                worktrees,
                collapsed: false,
                order: 0,
                effectiveScripts: { teardown: 'npm run teardown' },
              }
            : {
                type,
                id: 'project-a',
                name: 'Project A',
                color: '#111111',
                repos: [],
                worktrees,
                collapsed: false,
                order: 0,
                scripts: { teardown: 'npm run teardown' },
              },
        ],
        loadProjects,
        saveProjects,
        diffStats: {},
        commitsAhead: {},
        archivingWorktrees: new Set<string>(),
        tearingDownWorktrees: new Set<string>(),
        appliedProjectWorktreeScripts: {
          'project-a/wt-1': { launch: 'npm run dev' },
        },
        appliedProjectWorktreeHooks: {},
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });
      useHooksStore.getState().startRun('project-a', 'wt-1', {
        hookKey: 'project:pr:create',
        triggerName: 'pr:create',
        label: 'PR Created',
        actions: [{ type: 'command', command: 'echo hello' }],
        target: 'project',
      });
      useScriptsStore.getState().startRun('project-a', 'wt-1', {
        scriptKey: 'project:launch',
        scriptName: 'launch',
        label: 'Launch',
        command: 'npm run dev',
        lifecycle: 'launch',
        target: 'project',
      });
    }

    function expectNoRendererEffects(): void {
      expect(cancelWorktreeSetup).not.toHaveBeenCalled();
      expect(stopScript).not.toHaveBeenCalled();
      expect(stopHook).not.toHaveBeenCalled();
      expect(runScript).not.toHaveBeenCalled();
      expect(archiveWorktreeRequest).not.toHaveBeenCalled();
      expect(archiveWorkspaceWorktreeRequest).not.toHaveBeenCalled();
      expect(useChatStore.getState().deselectWorktree).not.toHaveBeenCalled();
      expect(
        useArchivedContainersStore.getState().pendingByWorkspace['project-a'] ??
          [],
      ).toEqual([]);
      const state = useProjectsStore.getState();
      expect(getProjectWorktrees(state.projects[0]).map((wt) => wt.id)).toEqual(
        ['wt-1'],
      );
      expect(state.archivingWorktrees.size).toBe(0);
      expect(state.tearingDownWorktrees.size).toBe(0);
      expect(state.appliedProjectWorktreeScripts).toEqual({
        'project-a/wt-1': { launch: 'npm run dev' },
      });
      expect(useScriptsStore.getState().runs['project-a/wt-1']).toBeDefined();
      expect(useHooksStore.getState().runs['project-a/wt-1']).toBeDefined();
    }

    beforeEach(() => {
      useArchivedContainersStore.setState({ pendingByWorkspace: {} });
      checkWorktreeRemovalAdmission.mockResolvedValue({
        status: 'refused',
        worktreeId: 'wt-1',
        reason: 'source-unavailable',
        message: SOURCE_UNAVAILABLE,
      });
    });

    it.each([
      ['archive', 'single-repo', undefined, { lockAfterArchive: true }],
      ['delete', 'single-repo', undefined, { deleteBranch: true }],
      [
        'delete of a missing checkout (files only)',
        'single-repo',
        undefined,
        { deleteWithoutRetentionIfMissing: true },
      ],
      ['archive of a git-pending worktree', 'single-repo', 'git-pending', {}],
      [
        'multi-repo archive',
        'multi-repo',
        undefined,
        { lockAfterArchive: true },
      ],
      [
        'multi-repo delete of a missing checkout (files only)',
        'multi-repo',
        undefined,
        { deleteWithoutRetentionIfMissing: true },
      ],
    ] as const)(
      'refuses a %s before any renderer effect',
      async (_label, type, setupPhase, options) => {
        seedRefusableWorktree(type, setupPhase);

        await expect(
          useProjectsStore
            .getState()
            .archiveWorktree('project-a', 'wt-1', options),
        ).rejects.toThrow(SOURCE_UNAVAILABLE);

        expect(checkWorktreeRemovalAdmission).toHaveBeenCalledWith({
          workspaceId: 'project-a',
          worktreeIds: ['wt-1'],
          expectedKind: type,
        });
        expectNoRendererEffects();
      },
    );

    it('refuses Delete without teardown before any renderer effect', async () => {
      seedRefusableWorktree('single-repo');

      await expect(
        useProjectsStore.getState().forceArchiveWorktree('project-a', 'wt-1'),
      ).rejects.toThrow(SOURCE_UNAVAILABLE);

      expectNoRendererEffects();
    });

    it('refuses before any renderer effect when the check itself fails', async () => {
      seedRefusableWorktree('single-repo');
      checkWorktreeRemovalAdmission.mockRejectedValueOnce(
        new Error('check failed'),
      );

      await expect(
        useProjectsStore.getState().archiveWorktree('project-a', 'wt-1'),
      ).rejects.toThrow('check failed');

      expectNoRendererEffects();
    });

    it('archives normally when a remote host predates the check', async () => {
      seedRefusableWorktree('single-repo');
      checkWorktreeRemovalAdmission.mockResolvedValueOnce({
        status: 'unchecked',
      });
      runScript.mockResolvedValue(createScriptRunResponse());

      await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1');

      expect(archiveWorktreeRequest).toHaveBeenCalledTimes(1);
      expect(
        getProjectWorktrees(useProjectsStore.getState().projects[0]),
      ).toEqual([]);
    });

    it.each([
      [
        'discardable with a gone source',
        'discardable',
        'Its source repository is missing. Discard it from the row menu.',
      ],
      ['not discardable', 'refused', SOURCE_UNAVAILABLE],
    ] as const)(
      'gives a refused batch row the discard pointer only when it is %s (CAN-5336 Q4)',
      async (_label, status, reason) => {
        seedRefusableWorktree('single-repo');
        checkWorktreeRemovalAdmission.mockResolvedValue({
          status: 'refused',
          worktreeId: 'wt-1',
          reason: 'source-unavailable',
          message: SOURCE_UNAVAILABLE,
        });
        describeWorktreeDiscard.mockResolvedValue({
          version: 1,
          workspaceId: 'project-a',
          worktreeId: 'wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
          status,
          causes: status === 'discardable' ? ['source-gone'] : [],
          sources: [],
          targets: [],
          alsoDeleted: [],
          preserved: [],
          mayRemain: [],
          confirmation: 'token',
        });

        await expect(
          removeDesktopWorktreeInBatch('project-a', 'wt-1', { mode: 'delete' }),
        ).rejects.toThrow(reason);
        expect(describeWorktreeDiscard).toHaveBeenCalledWith({
          projectId: 'project-a',
          worktreeId: 'wt-1',
        });
        expect(archiveWorktreeRequest).not.toHaveBeenCalled();
      },
    );

    it('runs a sidebar batch that mixes healthy and refused worktrees', async () => {
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/repos/project-a',
            color: '#111111',
            worktrees: ['wt-1', 'wt-2', 'wt-3'].map((id) => ({
              id,
              branchName: `feature/${id}`,
              createdAt: '2026-04-09T00:00:00.000Z',
            })),
            collapsed: false,
            order: 0,
            effectiveScripts: {},
          },
        ],
        loadProjects,
        saveProjects,
        diffStats: {},
        commitsAhead: {},
        archivingWorktrees: new Set<string>(),
        tearingDownWorktrees: new Set<string>(),
        appliedProjectWorktreeScripts: {},
        appliedProjectWorktreeHooks: {},
      });
      checkWorktreeRemovalAdmission.mockImplementation(({ worktreeIds }) =>
        Promise.resolve(
          worktreeIds.includes('wt-2')
            ? {
                status: 'refused',
                worktreeId: 'wt-2',
                reason: 'source-unavailable',
                message: SOURCE_UNAVAILABLE,
              }
            : { status: 'admitted' },
        ),
      );
      const queue = createSidebarRemovalQueue<WorktreeBatchTarget>({
        remove:
          () =>
          (target, options): Promise<void> =>
            removeDesktopWorktreeInBatch(
              target.workspaceLocalId,
              target.worktreeLocalId,
              options,
            ),
        blockedReasonFor: () => undefined,
      });

      const result = await queue.enqueue({
        batchId: 'batch-1',
        targets: ['wt-1', 'wt-2', 'wt-3'].map((id) => ({
          key: `project-a/${id}`,
          workspaceLocalId: 'project-a',
          worktreeLocalId: id,
        })),
        options: { mode: 'delete' },
        unit: { singular: 'worktree', plural: 'worktrees' },
      });

      expect(
        result.items.map((item) => [item.target.key, item.status, item.reason]),
      ).toEqual([
        ['project-a/wt-1', 'done', undefined],
        ['project-a/wt-2', 'failed', SOURCE_UNAVAILABLE],
        ['project-a/wt-3', 'done', undefined],
      ]);
      expect(
        archiveWorktreeRequest.mock.calls.map(
          ([request]: [{ worktreeId: string }]) => request.worktreeId,
        ),
      ).toEqual(['wt-1', 'wt-3']);
      expect(
        cancelWorktreeSetup.mock.calls.map(([request]) => request.worktreeId),
      ).toEqual(['wt-1', 'wt-3']);
      expect(
        getProjectWorktrees(useProjectsStore.getState().projects[0]).map(
          (wt) => wt.id,
        ),
      ).toEqual(['wt-2']);
    });

    it('lets one in-flight check serve a duplicate archive call', async () => {
      seedRefusableWorktree('single-repo');

      const first = useProjectsStore
        .getState()
        .archiveWorktree('project-a', 'wt-1');
      const second = useProjectsStore
        .getState()
        .archiveWorktree('project-a', 'wt-1');

      await expect(first).rejects.toThrow(SOURCE_UNAVAILABLE);
      await expect(second).rejects.toThrow(SOURCE_UNAVAILABLE);
      expect(checkWorktreeRemovalAdmission).toHaveBeenCalledTimes(1);
      expectNoRendererEffects();
    });

    it.each(['archiveWorktree', 'forceArchiveWorktree'] as const)(
      '%s keeps the row busy from the click through the check, then releases it on refusal',
      async (action) => {
        seedRefusableWorktree('single-repo');
        let answer: (
          result: Awaited<
            ReturnType<CanopyApi['checkWorktreeRemovalAdmission']>
          >,
        ) => void = () => undefined;
        checkWorktreeRemovalAdmission.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = resolve;
          }),
        );

        const removal = useProjectsStore
          .getState()
          [action]('project-a', 'wt-1');
        expect([...useProjectsStore.getState().archivingWorktrees]).toEqual([
          'project-a/wt-1',
        ]);
        answer({
          status: 'refused',
          worktreeId: 'wt-1',
          reason: 'source-unavailable',
          message: SOURCE_UNAVAILABLE,
        });

        await expect(removal).rejects.toThrow(SOURCE_UNAVAILABLE);
        expectNoRendererEffects();
      },
    );
  });

  it('filters empty temporary multi-repo projects from project loads', async () => {
    useProjectsStore.setState({
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      refreshWorkspaceDrift,
    });
    loadProjectsRequest.mockResolvedValueOnce({
      version: 1,
      items: [
        {
          type: 'multi-repo',
          id: 'workspace-temp',
          name: 'Repo A & Repo B',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          temporary: true,
        },
        {
          type: 'multi-repo',
          id: 'workspace-active',
          name: 'Active Workspace',
          color: '#222222',
          repos: [],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 1,
          temporary: true,
        },
      ],
    });

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(useProjectsStore.getState().projects.map((item) => item.id)).toEqual(
      ['workspace-active'],
    );
  });

  it('archives a git-pending worktree without running renderer teardown', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
              setupPhase: 'git-pending',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {
            teardown: 'npm run teardown',
          },
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    // Pre-populate hook/script runs that would normally be torn down.
    useHooksStore.getState().startRun('project-a', 'wt-1', {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [{ type: 'command', command: 'echo hello' }],
      target: 'project',
    });
    useScriptsStore.getState().startRun('project-a', 'wt-1', {
      scriptKey: 'project:launch',
      scriptName: 'launch',
      label: 'Launch',
      command: 'npm run dev',
      lifecycle: 'launch',
      target: 'project',
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1');

    expect(archiveWorktreeRequest).toHaveBeenCalledWith({
      repoPath: '/repos/project-a',
      projectId: 'project-a',
      worktreeId: 'wt-1',
      expectedCreatedAt: '2026-04-09T00:00:00.000Z',
      remainingWorktreeOrder: [],
      expectedRemainingWorktreeOrder: [],
      typedRefusal: true,
    });
    // Renderer must skip teardown scripts/hooks for git-pending worktrees.
    expect(stopHook).not.toHaveBeenCalled();
    expect(stopScript).not.toHaveBeenCalled();
    expect(runScript).not.toHaveBeenCalled();
  });

  it('does not show teardown state while stopping scripts when no teardown is configured', async () => {
    const stopScriptResult = createDeferred<ScriptRunResponse | null>();
    stopScript.mockReturnValueOnce(stopScriptResult.promise);

    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    useProjectsStore.setState({
      projects: [project],
      loadProjects,
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });
    useScriptsStore.getState().startRun('project-a', 'wt-1', {
      scriptKey: 'project:launch',
      scriptName: 'launch',
      label: 'Launch',
      command: 'npm run dev',
      lifecycle: 'launch',
      target: 'project',
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([expect.objectContaining({ id: 'wt-1' })]);
    expect(useProjectsStore.getState().tearingDownWorktrees.size).toBe(0);

    stopScriptResult.resolve(createScriptRunResponse());
    await archivePromise;

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
  });

  it('keeps the row visible while a configured teardown script runs', async () => {
    const teardownResult = createDeferred<ScriptRunResponse>();
    runScript.mockReturnValueOnce(teardownResult.promise);

    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {
        teardown: 'npm run clean',
      },
    };

    useProjectsStore.setState({
      projects: [project],
      loadProjects,
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([expect.objectContaining({ id: 'wt-1' })]);
    expect(
      useProjectsStore.getState().tearingDownWorktrees.has('project-a/wt-1'),
    ).toBe(true);

    teardownResult.resolve(createScriptRunResponse());
    await archivePromise;

    expect(useProjectsStore.getState().tearingDownWorktrees.size).toBe(0);
    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
  });

  it('cancels the worktree setup before teardown and the archive request', async () => {
    const cancelResult = createDeferred<undefined>();
    cancelWorktreeSetup.mockReturnValueOnce(cancelResult.promise);

    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {
        teardown: 'npm run clean',
      },
    };

    useProjectsStore.setState({
      projects: [project],
      loadProjects,
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // The renderer may not know a setup is running for a row it never
    // loaded, so the cancellation goes to main rather than through the
    // renderer's own list of running scripts.
    expect(cancelWorktreeSetup).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });
    expect(runScript).not.toHaveBeenCalled();
    expect(archiveWorktreeRequest).not.toHaveBeenCalled();

    cancelResult.resolve(undefined);
    await archivePromise;

    expect(runScript).toHaveBeenCalledWith(
      expect.objectContaining({ scriptName: 'teardown' }),
    );
    expect(archiveWorktreeRequest).toHaveBeenCalledTimes(1);
  });

  it('archives the worktree when cancelling its setup fails', async () => {
    cancelWorktreeSetup.mockRejectedValueOnce(new Error('ipc failed'));

    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    useProjectsStore.setState({
      projects: [project],
      loadProjects,
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1');

    expect(archiveWorktreeRequest).toHaveBeenCalledTimes(1);
    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
  });

  it('uses worktree-specific scripts when archiving a single-repo worktree', async () => {
    const teardownResult = createDeferred<ScriptRunResponse>();
    runScript.mockReturnValueOnce(teardownResult.promise);

    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
      worktreeEffective: {
        'wt-1': {
          effectiveScripts: {
            teardown: {
              command: 'npm run teardown:worktree',
              devServerPattern: 'Ready: (http://localhost:\\d+)',
            },
          },
        },
      },
    };

    useProjectsStore.setState({
      projects: [project],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runScript).toHaveBeenCalledWith({
      target: 'project',
      scriptName: 'teardown',
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });
    expect(
      useScriptsStore.getState().runs['project-a/wt-1']?.['project:teardown'],
    ).toEqual(
      expect.objectContaining({
        command: 'npm run teardown:worktree',
        devServerPattern: 'Ready: (http://localhost:\\d+)',
      }),
    );

    teardownResult.resolve(createScriptRunResponse());
    await archivePromise;

    expect(archiveWorktreeRequest).toHaveBeenCalledWith({
      repoPath: '/repos/project-a',
      projectId: 'project-a',
      worktreeId: 'wt-1',
      expectedCreatedAt: '2026-04-09T00:00:00.000Z',
      remainingWorktreeOrder: [],
      expectedRemainingWorktreeOrder: [],
      typedRefusal: true,
    });
  });

  it('flushes chat tabs before archive IPC and clears all per-worktree maps on success', async () => {
    let archiveCalled = false;
    let saveProjectsCallsBeforeArchive = 0;
    saveProjects.mockImplementation(() => {
      if (!archiveCalled) {
        saveProjectsCallsBeforeArchive += 1;
      }
      return Promise.resolve();
    });
    archiveWorktreeRequest.mockImplementation(() => {
      archiveCalled = true;
      return Promise.resolve({ warnings: [] });
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: { 'project-a/wt-1': { insertions: 1, deletions: 2 } },
      commitsAhead: { 'project-a/wt-1': true },
      baseBranches: { 'project-a/wt-1': 'main' },
      uncommittedChanges: { 'project-a/wt-1': true },
      hasRemoteTracking: { 'project-a/wt-1': true },
      hasOriginRemote: { 'project-a/wt-1': true },
      hasBranchBeenPushed: { 'project-a/wt-1': true },
      hasUnpushedCommits: { 'project-a/wt-1': false },
      hasUnpulledCommits: { 'project-a/wt-1': false },
      repoBranches: { 'project-a/wt-1': [] },
      baseBranchExistsLocally: { 'project-a/wt-1': true },
      baseBranchExistsInRemote: { 'project-a/wt-1': true },
      workspaceDrift: {
        'project-a/wt-1': createCleanWorkspaceDriftSummary(),
      },
      pendingTaskBranchNamings: {
        'project-a/wt-1': { text: 'pending-text' },
      },
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await useProjectsStore.getState().archiveWorktree('project-a', 'wt-1');

    expect(flushWorktreeTabs).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(flushWorktreeTabs.mock.invocationCallOrder[0]).toBeLessThan(
      archiveWorktreeRequest.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(saveProjectsCallsBeforeArchive).toBe(0);
    expect(saveProjects).not.toHaveBeenCalled();

    const state = useProjectsStore.getState();
    expect(state.diffStats['project-a/wt-1']).toBeUndefined();
    expect(state.commitsAhead['project-a/wt-1']).toBeUndefined();
    expect(state.baseBranches['project-a/wt-1']).toBeUndefined();
    expect(state.uncommittedChanges['project-a/wt-1']).toBeUndefined();
    expect(state.hasRemoteTracking['project-a/wt-1']).toBeUndefined();
    expect(state.hasOriginRemote['project-a/wt-1']).toBeUndefined();
    expect(state.hasBranchBeenPushed['project-a/wt-1']).toBeUndefined();
    expect(state.hasUnpushedCommits['project-a/wt-1']).toBeUndefined();
    expect(state.hasUnpulledCommits['project-a/wt-1']).toBeUndefined();
    expect(state.repoBranches['project-a/wt-1']).toBeUndefined();
    expect(state.baseBranchExistsLocally['project-a/wt-1']).toBeUndefined();
    expect(state.baseBranchExistsInRemote['project-a/wt-1']).toBeUndefined();
    expect(state.workspaceDrift['project-a/wt-1']).toBeUndefined();
    expect(state.pendingTaskBranchNamings['project-a/wt-1']).toBeUndefined();

    // After archive success the renderer cleans dependent stores.
    expect(cleanupChatWorktree).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(dropWorktreeQueuedState).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(dropPendingForWorktree).toHaveBeenCalledWith('project-a', 'wt-1');
  });

  it('keeps archived worktrees hidden from stale reloads and authoritative updates while archive is in flight', async () => {
    let resolveArchive: ((value: { warnings: string[] }) => void) | undefined;
    archiveWorktreeRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve;
        }),
    );

    const staleProject: SidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-race',
          branchName: 'feature/wt-race',
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    useProjectsStore.setState({
      projects: [staleProject],
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      saveProjects: useProjectsStore.getInitialState().saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });
    loadProjectsRequest.mockResolvedValueOnce({
      version: 1,
      items: [staleProject],
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-race');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
    expect(
      useProjectsStore.getState().archivingWorktrees.has('project-a/wt-race'),
    ).toBe(true);

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!workspaceWorktreesUpdatedHandler) {
      throw new Error(
        'Expected workspaceWorktreesUpdated handler to be registered',
      );
    }
    workspaceWorktreesUpdatedHandler({
      workspaceId: 'project-a',
      worktrees: staleProject.worktrees,
    });
    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
    resolveArchive?.({ warnings: [] });
    await archivePromise;
    expect(useProjectsStore.getState().archivingWorktrees.size).toBe(0);

    loadProjectsRequest.mockReset();
    loadProjectsRequest.mockResolvedValueOnce({
      version: 1,
      items: [staleProject],
    });
    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);

    loadProjectsRequest.mockReset();
    loadProjectsRequest.mockResolvedValueOnce({
      version: 1,
      items: [
        {
          ...staleProject,
          worktrees: [
            {
              id: 'wt-race',
              branchName: 'feature/recreated',
              createdAt: '2026-04-20T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([
      {
        id: 'wt-race',
        branchName: 'feature/recreated',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
  });

  it('keeps an archive hidden when a reload response arrives just before UI removal', async () => {
    const archive = createDeferred<{ warnings: string[] }>();
    const flush = createDeferred<void>();
    const load = createDeferred<{ version: number; items: SidebarItem[] }>();
    archiveWorktreeRequest.mockReturnValueOnce(archive.promise);
    flushWorktreeTabs.mockReturnValueOnce(flush.promise);
    loadProjectsRequest.mockReturnValueOnce(load.promise);
    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      collapsed: false,
      order: 0,
      effectiveScripts: {},
      worktrees: [
        {
          id: 'wt-race',
          branchName: 'feature/wt-race',
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      ],
    };
    useProjectsStore.setState({
      projects: [project],
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });
    const archiving = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-race');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const loading = useProjectsStore.getState().loadProjects({ silent: true });
    load.resolve({ version: 1, items: [project] });
    // Let the IPC response settle, then complete the chat checkpoint that
    // gates optimistic removal before the loaded snapshot is published.
    await Promise.resolve();
    flush.resolve();
    await loading;
    try {
      expect(
        getProjectWorktrees(useProjectsStore.getState().projects[0]),
      ).toEqual([]);
    } finally {
      archive.resolve({ warnings: [] });
      await archiving;
    }
  });

  it('discards project reloads that started before archive success', async () => {
    const staleProject: SidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-race',
          branchName: 'feature/wt-race',
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };
    const staleLoad = createDeferred<{
      version: number;
      items: SidebarItem[];
    }>();
    loadProjectsRequest.mockReturnValueOnce(staleLoad.promise);

    useProjectsStore.setState({
      projects: [staleProject],
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      saveProjects: useProjectsStore.getInitialState().saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const loadPromise = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-race');

    await archivePromise;

    staleLoad.resolve({
      version: 1,
      items: [staleProject],
    });
    await loadPromise;

    expect(useProjectsStore.getState().projects).toEqual([]);
  });

  it('suppresses stale reloads even when the archived worktree is missing locally', async () => {
    let resolveArchive: ((value: { warnings: string[] }) => void) | undefined;
    archiveWorktreeRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve;
        }),
    );

    const projectWithoutWorktree: SidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };
    const staleProject: SidebarItem = {
      ...projectWithoutWorktree,
      worktrees: [
        {
          id: 'wt-race',
          branchName: 'feature/wt-race',
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      ],
    };

    useProjectsStore.setState({
      projects: [projectWithoutWorktree],
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      saveProjects: useProjectsStore.getInitialState().saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });
    loadProjectsRequest.mockResolvedValueOnce({
      version: 1,
      items: [staleProject],
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-race');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(
      getSingleRepoProject(useProjectsStore.getState().projects[0]).worktrees,
    ).toEqual([]);
    resolveArchive?.({ warnings: [] });
    await archivePromise;
  });

  it('does not strip archive-suppressed worktrees from explicit save payloads', async () => {
    let resolveArchive: ((value: { warnings: string[] }) => void) | undefined;
    archiveWorktreeRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve;
        }),
    );

    const project: SidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [
        {
          id: 'wt-race',
          branchName: 'feature/wt-race',
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    useProjectsStore.setState({
      projects: [project],
      loadProjects: useProjectsStore.getInitialState().loadProjects,
      saveProjects: useProjectsStore.getInitialState().saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const archivePromise = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-race');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    await useProjectsStore.getState().saveProjects([project]);

    expect(saveProjects).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'project-a',
        worktrees: [
          expect.objectContaining({
            id: 'wt-race',
          }),
        ],
      }),
    ]);

    resolveArchive?.({ warnings: [] });
    await archivePromise;
  });

  it('makes duplicate normal and forced archive calls await the active failure', async () => {
    const archive = createDeferred<{ success: true; warnings: string[] }>();
    archiveWorktreeRequest.mockReturnValue(archive.promise);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const primary = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    const duplicate = useProjectsStore
      .getState()
      .archiveWorktree('project-a', 'wt-1');
    const forcedDuplicate = useProjectsStore
      .getState()
      .forceArchiveWorktree('project-a', 'wt-1');

    let duplicateSettled = false;
    void duplicate.then(
      () => {
        duplicateSettled = true;
      },
      () => {
        duplicateSettled = true;
      },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(archiveWorktreeRequest).toHaveBeenCalledTimes(1);
    expect(duplicateSettled).toBe(false);

    const failure = new Error('archive failed');
    const assertions = Promise.all([
      expect(primary).rejects.toThrow('archive failed'),
      expect(duplicate).rejects.toThrow('archive failed'),
      expect(forcedDuplicate).rejects.toThrow('archive failed'),
    ]);
    archive.reject(failure);
    await assertions;
    expect(duplicateSettled).toBe(true);
    expect(useProjectsStore.getState().archivingWorktrees.size).toBe(0);
  });

  it.each(['archiveWorktree', 'forceArchiveWorktree'] as const)(
    'offers the lifecycle journal review when %s is refused by an unreadable record (CAN-5335)',
    async (action) => {
      archiveWorktreeRequest.mockRejectedValue(
        new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL),
      );
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/repos/project-a',
            color: '#111111',
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/wt-1',
                createdAt: '2026-04-09T00:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
            effectiveScripts: {},
          },
        ],
        saveProjects,
        diffStats: {},
        commitsAhead: {},
        tearingDownWorktrees: new Set<string>(),
        appliedProjectWorktreeScripts: {},
        appliedProjectWorktreeHooks: {},
      });
      const offer = jest.mocked(offerLifecycleJournalQuarantine);
      offer.mockClear();

      await expect(
        useProjectsStore.getState()[action]('project-a', 'wt-1'),
      ).rejects.toThrow(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL);

      expect(offer).toHaveBeenCalledTimes(1);
      expect(offer.mock.results[0]?.value).toBe(true);
    },
  );

  describe('typed archive refusals (CAN-5336)', () => {
    const discard = {
      version: 1 as const,
      workspaceId: 'project-a',
      worktreeId: 'wt-1',
      createdAt: '2026-04-09T00:00:00.000Z',
      status: 'discardable' as const,
      causes: ['stranded-removal-journal' as const],
      sources: [],
      targets: [],
      alsoDeleted: [],
      preserved: [],
      mayRemain: [],
      confirmation: 'token',
    };
    const refusedMessage =
      'This change was saved but did not finish and needs recovery.';

    function seed(): void {
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/repos/project-a',
            color: '#111111',
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/wt-1',
                createdAt: '2026-04-09T00:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
            effectiveScripts: {},
          },
        ],
        saveProjects,
        diffStats: {},
        commitsAhead: {},
        tearingDownWorktrees: new Set<string>(),
        appliedProjectWorktreeScripts: {},
        appliedProjectWorktreeHooks: {},
      });
    }

    it.each(['archiveWorktree', 'forceArchiveWorktree'] as const)(
      '%s opts in, restores the row and throws the discardable refusal with its message',
      async (action) => {
        archiveWorktreeRequest.mockResolvedValue({
          success: false,
          warnings: [],
          refusal: {
            reason: 'recovery-required',
            message: refusedMessage,
            discard,
          },
        });
        seed();
        const toastsBefore = useGitHubStore.getState().toasts.length;

        const thrown = await useProjectsStore
          .getState()
          [action]('project-a', 'wt-1')
          .then(
            () => undefined,
            (error: unknown) => error,
          );

        expect(archiveWorktreeRequest).toHaveBeenCalledWith(
          expect.objectContaining({ typedRefusal: true }),
        );
        expect(thrown).toBeInstanceOf(WorktreeArchiveRefusalError);
        expect(thrown).toMatchObject({ message: refusedMessage, discard });
        const project = useProjectsStore.getState().projects[0];
        expect(
          project && project.type !== 'cowork'
            ? project.worktrees.map((worktree) => worktree.id)
            : [],
        ).toEqual(['wt-1']);
        expect(useGitHubStore.getState().toasts).toHaveLength(toastsBefore);
        expect(useProjectsStore.getState().archivingWorktrees.size).toBe(0);
      },
    );

    it('fails a non-discardable typed refusal with its message unchanged, so the journal review still opens', async () => {
      archiveWorktreeRequest.mockResolvedValue({
        success: false,
        warnings: [],
        refusal: {
          reason: 'recovery-required',
          message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
          discard: { ...discard, status: 'refused' as const },
        },
      });
      seed();
      const offer = jest.mocked(offerLifecycleJournalQuarantine);
      offer.mockClear();

      const thrown = await useProjectsStore
        .getState()
        .archiveWorktree('project-a', 'wt-1')
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(WorktreeArchiveRefusalError);
      expect(thrown).toMatchObject({
        message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
      });
      expect(offer.mock.results[0]?.value).toBe(true);
    });
  });

  it('keeps a temporary project row (with no worktrees) while its last archive is in flight', async () => {
    const archive = createDeferred<{ success: true; warnings: string[] }>();
    archiveWorkspaceWorktreeRequest.mockReturnValue(archive.promise);

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-temp',
          name: 'Repo A & Repo B',
          color: '#111111',
          repos: [
            { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
            { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
          ],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          temporary: true,
          archiveRetentionDays: null,
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    const primary = useProjectsStore
      .getState()
      .archiveWorktree('workspace-temp', 'wt-1');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Deletion retention is always on (legacy `null` resolves to the default
    // window), so removing the last worktree leaves a retained container and
    // the workspace row stays for its "Archived and deleted" link. Main's
    // response remains authoritative for the actual removal.
    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({ id: 'workspace-temp', worktrees: [] }),
    ]);

    const duplicate = useProjectsStore
      .getState()
      .archiveWorktree('workspace-temp', 'wt-1');
    const forcedDuplicate = useProjectsStore
      .getState()
      .forceArchiveWorktree('workspace-temp', 'wt-1');
    let duplicatesSettled = false;
    void Promise.allSettled([duplicate, forcedDuplicate]).then(() => {
      duplicatesSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(archiveWorkspaceWorktreeRequest).toHaveBeenCalledTimes(1);
    expect(duplicatesSettled).toBe(false);

    const failure = new Error('archive failed');
    const assertions = Promise.all([
      expect(primary).rejects.toThrow('archive failed'),
      expect(duplicate).rejects.toThrow('archive failed'),
      expect(forcedDuplicate).rejects.toThrow('archive failed'),
    ]);
    archive.reject(failure);
    await assertions;
    expect(duplicatesSettled).toBe(true);
    expect(useProjectsStore.getState().archivingWorktrees.size).toBe(0);
  });

  it('restores all snapshotted maps when archive IPC fails', async () => {
    archiveWorktreeRequest.mockRejectedValueOnce(new Error('archive failed'));

    const initialDiffStats = {
      'project-a/wt-1': { insertions: 1, deletions: 2 },
    };
    const initialCommitsAhead = { 'project-a/wt-1': true };
    const initialBaseBranches = { 'project-a/wt-1': 'main' as const };
    const initialUncommittedChanges = { 'project-a/wt-1': true };
    const initialHasRemoteTracking = { 'project-a/wt-1': true };
    const initialHasOriginRemote = { 'project-a/wt-1': true };
    const initialHasBranchBeenPushed = { 'project-a/wt-1': true };
    const initialHasUnpushedCommits = { 'project-a/wt-1': false };
    const initialHasUnpulledCommits = { 'project-a/wt-1': false };
    const initialRepoBranches = { 'project-a/wt-1': [] };
    const initialBaseBranchExistsLocally = { 'project-a/wt-1': true };
    const initialBaseBranchExistsInRemote = { 'project-a/wt-1': true };
    const initialWorkspaceDrift: Record<string, WorkspaceDriftSummary> = {
      'project-a/wt-1': createCleanWorkspaceDriftSummary(),
    };
    const initialPendingTaskBranchNamings = {
      'project-a/wt-1': { text: 'pending-text' },
    };

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: initialDiffStats,
      commitsAhead: initialCommitsAhead,
      baseBranches: initialBaseBranches,
      uncommittedChanges: initialUncommittedChanges,
      hasRemoteTracking: initialHasRemoteTracking,
      hasOriginRemote: initialHasOriginRemote,
      hasBranchBeenPushed: initialHasBranchBeenPushed,
      hasUnpushedCommits: initialHasUnpushedCommits,
      hasUnpulledCommits: initialHasUnpulledCommits,
      repoBranches: initialRepoBranches,
      baseBranchExistsLocally: initialBaseBranchExistsLocally,
      baseBranchExistsInRemote: initialBaseBranchExistsInRemote,
      workspaceDrift: initialWorkspaceDrift,
      pendingTaskBranchNamings: initialPendingTaskBranchNamings,
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {},
      appliedProjectWorktreeHooks: {},
    });

    await expect(
      useProjectsStore.getState().archiveWorktree('project-a', 'wt-1'),
    ).rejects.toThrow('archive failed');

    const state = useProjectsStore.getState();
    expect(getProjectWorktrees(state.projects[0])[0]?.id).toBe('wt-1');
    expect(state.diffStats).toEqual(initialDiffStats);
    expect(state.commitsAhead).toEqual(initialCommitsAhead);
    expect(state.baseBranches).toEqual(initialBaseBranches);
    expect(state.uncommittedChanges).toEqual(initialUncommittedChanges);
    expect(state.hasRemoteTracking).toEqual(initialHasRemoteTracking);
    expect(state.hasOriginRemote).toEqual(initialHasOriginRemote);
    expect(state.hasBranchBeenPushed).toEqual(initialHasBranchBeenPushed);
    expect(state.hasUnpushedCommits).toEqual(initialHasUnpushedCommits);
    expect(state.hasUnpulledCommits).toEqual(initialHasUnpulledCommits);
    expect(state.repoBranches).toEqual(initialRepoBranches);
    expect(state.baseBranchExistsLocally).toEqual(
      initialBaseBranchExistsLocally,
    );
    expect(state.baseBranchExistsInRemote).toEqual(
      initialBaseBranchExistsInRemote,
    );
    expect(state.workspaceDrift).toEqual(initialWorkspaceDrift);
    expect(state.pendingTaskBranchNamings).toEqual(
      initialPendingTaskBranchNamings,
    );
    expect(state.archivingWorktrees.has('project-a/wt-1')).toBe(false);
    // Dependent stores must not have been cleaned up.
    expect(cleanupChatWorktree).not.toHaveBeenCalled();
    expect(dropWorktreeQueuedState).not.toHaveBeenCalled();
    expect(dropPendingForWorktree).not.toHaveBeenCalled();
    // The renderer must not call saveProjects on either path.
    expect(saveProjects).not.toHaveBeenCalled();
  });

  it('stops active hooks and scripts when force-archiving a worktree', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/wt-1',
              createdAt: '2026-04-09T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
          effectiveScripts: {},
        },
      ],
      saveProjects,
      diffStats: {},
      commitsAhead: {},
      tearingDownWorktrees: new Set<string>(),
      appliedProjectWorktreeScripts: {
        'project-a/wt-1': {
          launch: 'npm run dev',
        },
      },
      appliedProjectWorktreeHooks: {
        'project-a/wt-1': {
          'pr:create': [{ type: 'command', command: 'echo hello' }],
        },
      },
    });

    useHooksStore.getState().startRun('project-a', 'wt-1', {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [{ type: 'command', command: 'echo hello' }],
      target: 'project',
    });
    useScriptsStore.getState().startRun('project-a', 'wt-1', {
      scriptKey: 'project:launch',
      scriptName: 'launch',
      label: 'Launch',
      command: 'npm run dev',
      lifecycle: 'launch',
      target: 'project',
    });

    stopHook.mockResolvedValue({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 0,
    });
    stopScript.mockResolvedValue({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 0,
    });

    await useProjectsStore.getState().forceArchiveWorktree('project-a', 'wt-1');

    expect(cancelWorktreeSetup).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });
    expect(stopHook).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      hookKey: 'project:pr:create',
    });
    expect(stopScript).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      scriptKey: 'project:launch',
    });
    expect(useHooksStore.getState().runs['project-a/wt-1']).toBeUndefined();
    expect(useScriptsStore.getState().runs['project-a/wt-1']).toBeUndefined();
    expect(useProjectsStore.getState().tearingDownWorktrees.size).toBe(0);
    expect(
      useProjectsStore.getState().appliedProjectWorktreeHooks['project-a/wt-1'],
    ).toBeUndefined();
    expect(
      useProjectsStore.getState().appliedProjectWorktreeScripts[
        'project-a/wt-1'
      ],
    ).toBeUndefined();
  });
});

describe('projectsStore diff stats', () => {
  const getDiffStatsBatch = jest.fn();
  const inspectRecommendedPlugins = jest.fn();
  const requestRefresh = jest.fn();
  const requestFastRefresh = jest.fn();
  const invalidate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        getDiffStatsBatch,
        inspectRecommendedPlugins,
      },
    });
    inspectRecommendedPlugins.mockResolvedValue({
      items: [],
      promptItems: [],
      scopeLabel: '',
      workspaceId: '',
    });

    useProjectsStore.setState(useProjectsStore.getInitialState());
    useGitHubStore.setState({
      requestRefresh,
      requestFastRefresh,
    });
    useFileListStore.setState({
      invalidate,
    });
  });

  it('stores base branches from diff stat refreshes', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 4,
        deletions: 1,
        branchName: 'wt-1',
        baseBranch: 'main',
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
      commitsAhead: {},
      baseBranches: {},
      repoBranches: {},
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(getDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [{ projectId: 'repo-a', worktreeId: 'wt-1' }],
      source: 'renderer-global-poll',
    });
    expect(useProjectsStore.getState().getBaseBranch('repo-a', 'wt-1')).toBe(
      'main',
    );
  });

  it('bootstraps full scheduled stats when a background row has no metadata snapshot', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-cold',
        worktreeId: 'wt-cold',
        insertions: 0,
        deletions: 0,
        hasOriginRemote: false,
      },
    ]);
    useChatStore.setState({ selectedWorktree: null });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-cold',
          name: 'Cold Repo',
          repoPath: '/repos/repo-cold',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-cold',
              branchName: 'wt-cold',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
      hasOriginRemote: {},
    });

    await useProjectsStore.getState().refreshDiffStatsScheduled();

    expect(getDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [
        {
          projectId: 'repo-cold',
          worktreeId: 'wt-cold',
          mode: 'full',
        },
      ],
      source: 'renderer-global-poll',
    });
  });

  it('uses diff-only scheduled stats for a metadata-warm background worktree', async () => {
    const backgroundHealthIssue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'invalid-git-worktree',
      message: 'Git metadata is bad.',
      checkedAt: '2026-04-22T00:00:00.000Z',
      worktreePath: '/worktrees/repo-scheduled/wt-background',
    };
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-scheduled',
        worktreeId: 'wt-foreground',
        insertions: 3,
        deletions: 1,
      },
      {
        projectId: 'repo-scheduled',
        worktreeId: 'wt-background',
        insertions: 8,
        deletions: 2,
        mode: 'diff_only',
      },
    ]);
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'repo-scheduled',
        worktreeId: 'wt-foreground',
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-scheduled',
          name: 'Scheduled Repo',
          repoPath: '/repos/repo-scheduled',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-foreground',
              branchName: 'wt-foreground',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'wt-background',
              branchName: 'wt-background',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: backgroundHealthIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {
        'repo-scheduled/wt-background': { insertions: 1, deletions: 1 },
      },
      commitsAhead: { 'repo-scheduled/wt-background': true },
      baseBranches: { 'repo-scheduled/wt-background': 'main' },
      hasOriginRemote: { 'repo-scheduled/wt-background': true },
    });

    await useProjectsStore.getState().refreshDiffStatsScheduled();

    expect(getDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [
        {
          projectId: 'repo-scheduled',
          worktreeId: 'wt-foreground',
          mode: 'full',
        },
        {
          projectId: 'repo-scheduled',
          worktreeId: 'wt-background',
          mode: 'diff_only',
        },
      ],
      source: 'renderer-global-poll',
    });
    const state = useProjectsStore.getState();
    expect(state.diffStats['repo-scheduled/wt-background']).toEqual({
      insertions: 8,
      deletions: 2,
    });
    expect(state.commitsAhead['repo-scheduled/wt-background']).toBe(true);
    expect(state.baseBranches['repo-scheduled/wt-background']).toBe('main');
    expect(state.hasOriginRemote['repo-scheduled/wt-background']).toBe(true);
    expect(
      getProjectWorktrees(state.projects[0]).find(
        (worktree) => worktree.id === 'wt-background',
      )?.healthIssue,
    ).toEqual(backgroundHealthIssue);
  });

  it('promotes PR refresh when remote-backed diff stats transition to clean', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-clean-transition',
        worktreeId: 'wt-clean-transition',
        insertions: 0,
        deletions: 0,
        hasOriginRemote: true,
        baseBranchExistsInRemote: true,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-clean-transition',
          name: 'Repo Clean Transition',
          repoPath: '/repos/repo-clean-transition',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-clean-transition',
              branchName: 'feature/merged',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {
        'repo-clean-transition/wt-clean-transition': {
          insertions: 8,
          deletions: 2,
        },
      },
      commitsAhead: {},
      baseBranches: {},
      repoBranches: {},
      hasOriginRemote: {
        'repo-clean-transition/wt-clean-transition': true,
      },
      baseBranchExistsInRemote: {
        'repo-clean-transition/wt-clean-transition': true,
      },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(requestFastRefresh).toHaveBeenCalledWith(
      'repo-clean-transition',
      'wt-clean-transition',
      false,
    );
  });

  it('does not promote PR refresh for local-base clean transitions', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-local-transition',
        worktreeId: 'wt-local-transition',
        insertions: 0,
        deletions: 0,
        hasOriginRemote: true,
        baseBranchExistsInRemote: false,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-local-transition',
          name: 'Repo Local Transition',
          repoPath: '/repos/repo-local-transition',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-local-transition',
              branchName: 'feature/local-base',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {
        'repo-local-transition/wt-local-transition': {
          insertions: 3,
          deletions: 1,
        },
      },
      commitsAhead: {},
      baseBranches: {},
      repoBranches: {},
      hasOriginRemote: {
        'repo-local-transition/wt-local-transition': true,
      },
      baseBranchExistsInRemote: {
        'repo-local-transition/wt-local-transition': false,
      },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(
      requestFastRefresh.mock.calls.some(
        ([projectId, worktreeId]) =>
          projectId === 'repo-local-transition' &&
          worktreeId === 'wt-local-transition',
      ),
    ).toBe(false);
  });

  it('hydrates baseBranchExistsInRemote from batch response', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 2,
        deletions: 0,
        branchName: 'wt-1',
        baseBranch: 'main',
        baseBranchExistsLocally: false,
        baseBranchExistsInRemote: true,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
      baseBranchExistsInRemote: {},
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(
      useProjectsStore.getState().baseBranchExistsInRemote['repo-a/wt-1'],
    ).toBe(true);
  });

  it('hydrates baseBranchExistsLocally from batch response', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 2,
        deletions: 0,
        branchName: 'wt-1',
        baseBranch: 'main',
        baseBranchExistsLocally: true,
        baseBranchExistsInRemote: false,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
      baseBranchExistsLocally: {},
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(
      useProjectsStore.getState().baseBranchExistsLocally['repo-a/wt-1'],
    ).toBe(true);
  });

  it('clears baseBranchExistsInRemote on empty worktrees', async () => {
    useProjectsStore.setState({
      projects: [],
      baseBranchExistsInRemote: { 'repo-a/wt-1': true },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(useProjectsStore.getState().baseBranchExistsInRemote).toEqual({});
  });

  it('clears baseBranchExistsLocally on empty worktrees', async () => {
    useProjectsStore.setState({
      projects: [],
      baseBranchExistsLocally: { 'repo-a/wt-1': true },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(useProjectsStore.getState().baseBranchExistsLocally).toEqual({});
  });

  it('reloads projects when an undefined canopy hash later becomes defined', async () => {
    getDiffStatsBatch
      .mockResolvedValueOnce([
        {
          projectId: 'repo-a',
          worktreeId: 'wt-1',
          insertions: 0,
          deletions: 0,
          canopyJsonHash: undefined,
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: 'repo-a',
          worktreeId: 'wt-1',
          insertions: 0,
          deletions: 0,
          canopyJsonHash: 'hash-1',
        },
      ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore.getState().refreshDiffStats();

    const loadProjects = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ loadProjects });

    await useProjectsStore.getState().refreshDiffStats();

    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
  });

  it('clears dismissed recommendation prompts when canopy hash changes', async () => {
    getDiffStatsBatch
      .mockResolvedValueOnce([
        {
          projectId: 'repo-dismiss',
          worktreeId: 'wt-dismiss',
          insertions: 0,
          deletions: 0,
          canopyJsonHash: 'hash-1',
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: 'repo-dismiss',
          worktreeId: 'wt-dismiss',
          insertions: 0,
          deletions: 0,
          canopyJsonHash: 'hash-2',
        },
      ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-dismiss',
          name: 'Repo Dismiss',
          repoPath: '/repos/repo-dismiss',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-dismiss',
              branchName: 'wt-dismiss',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      pendingRecommendedPluginPrompt: {
        projectId: 'repo-dismiss',
        worktreeId: 'wt-dismiss',
        scopeLabel: 'Repo Dismiss',
        items: [],
        requirements: [],
      },
    });

    useProjectsStore
      .getState()
      .dismissPendingRecommendedPluginPrompt({ remember: true });
    await useProjectsStore
      .getState()
      .inspectRecommendedPlugins('repo-dismiss', 'wt-dismiss');
    expect(inspectRecommendedPlugins).not.toHaveBeenCalled();

    await useProjectsStore.getState().refreshDiffStats();

    const loadProjects = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ loadProjects });

    await useProjectsStore.getState().refreshDiffStats();
    inspectRecommendedPlugins.mockClear();

    await useProjectsStore
      .getState()
      .inspectRecommendedPlugins('repo-dismiss', 'wt-dismiss');

    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(inspectRecommendedPlugins).toHaveBeenCalledWith({
      workspaceId: 'repo-dismiss',
      worktreeId: 'wt-dismiss',
      repoId: undefined,
    });
  });
});

describe('projectsStore worktree health handling', () => {
  const getDiffStatsBatch = jest.fn();
  const fetchFileIndex = jest.fn<Promise<void>, [string, string]>();
  const inspectHookChatPluginDependencies = jest.fn();
  const inspectRecommendedPlugins = jest.fn();
  const onWorktreeGitReady = jest.fn<
    () => void,
    [(event: WorktreeGitReadyEvent) => void]
  >();
  const onWorktreeGitFailed = jest.fn<
    () => void,
    [(event: WorktreeGitFailedEvent) => void]
  >();
  const onWorktreeBranchChanged = jest.fn<
    () => void,
    [(event: WorktreeBranchChangedEvent) => void]
  >();
  const onWorktreeNeedsRepair = jest.fn<
    () => void,
    [(event: WorktreeNeedsRepairEvent) => void]
  >();
  const onWorkspaceWorktreesUpdated = jest.fn<
    () => void,
    [(event: WorkspaceWorktreesUpdatedEvent) => void]
  >();
  const onWorktreesFileChanged = jest.fn<
    () => void,
    [(event: WorktreesFileChangedEvent) => void]
  >();
  const onWorkspaceSplitTemporaryComplete = jest.fn<
    () => void,
    [(event: SplitTemporaryWorkspaceCompleteEvent) => void]
  >();
  const retryWorktreeHealthCheck = jest.fn();
  const loadProjects = jest.fn();
  const requestRefresh = jest.fn();
  const invalidate = jest.fn();
  let worktreeGitReadyHandler: ((event: WorktreeGitReadyEvent) => void) | null =
    null;

  const brokenIssue = {
    status: 'broken' as const,
    code: 'invalid-git-worktree' as const,
    message: 'Git metadata is bad.',
    checkedAt: '2026-04-22T00:00:00.000Z',
    worktreePath: '/worktrees/repo-a/wt-broken',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    loadProjects.mockResolvedValue({ items: [], warnings: [] });
    fetchFileIndex.mockResolvedValue(undefined);
    worktreeGitReadyHandler = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        getDiffStatsBatch,
        inspectHookChatPluginDependencies,
        inspectRecommendedPlugins,
        onWorktreeGitFailed,
        onWorktreeGitReady,
        onWorktreeBranchChanged,
        onWorktreeNeedsRepair,
        onWorkspaceWorktreesUpdated,
        onWorktreesFileChanged,
        onWorkspaceSplitTemporaryComplete,
        orgProjects: { onOwnershipChanged: (): (() => void) => (): void => {} },
        retryWorktreeHealthCheck,
        loadProjects,
      },
    });
    inspectHookChatPluginDependencies.mockResolvedValue({ items: [] });
    inspectRecommendedPlugins.mockResolvedValue({
      items: [],
      promptItems: [],
      scopeLabel: '',
      workspaceId: '',
    });
    onWorktreeGitReady.mockImplementation((callback) => {
      worktreeGitReadyHandler = callback;
      return (): void => {};
    });
    onWorktreeGitFailed.mockImplementation(() => (): void => {});
    onWorktreeBranchChanged.mockImplementation(() => (): void => {});
    onWorktreeNeedsRepair.mockImplementation(() => (): void => {});
    onWorktreesFileChanged.mockImplementation(() => (): void => {});
    onWorkspaceSplitTemporaryComplete.mockImplementation(() => (): void => {});
    onWorkspaceWorktreesUpdated.mockImplementation(() => (): void => {});

    useProjectsStore.setState(useProjectsStore.getInitialState());
    useGitHubStore.setState({ requestRefresh });
    useFileListStore.setState({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set<string>(),
      indexVersions: {},
      rootsCache: {},
      rootsErrors: {},
      rootsLoading: new Set<string>(),
      rootsVersions: {},
      directoryCache: {},
      directoryErrors: {},
      directoryLoading: new Set<string>(),
      directoryVersions: {},
      fetchFileIndex,
      invalidate,
    });
  });

  it('includes broken worktrees in the batch and clears their aggregate stats', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-ok',
        insertions: 1,
        deletions: 0,
      },
      {
        projectId: 'repo-a',
        worktreeId: 'wt-broken',
        insertions: 0,
        deletions: 0,
        healthIssue: brokenIssue,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-ok',
              branchName: 'wt-ok',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'wt-broken',
              branchName: 'wt-broken',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: { 'repo-a/wt-broken': { insertions: 9, deletions: 9 } },
      commitsAhead: { 'repo-a/wt-broken': true },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);
    expect(getDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [
        { projectId: 'repo-a', worktreeId: 'wt-ok' },
        { projectId: 'repo-a', worktreeId: 'wt-broken' },
      ],
      source: 'renderer-global-poll',
    });

    const state = useProjectsStore.getState();
    expect(state.diffStats['repo-a/wt-broken']).toBeUndefined();
    expect(state.commitsAhead['repo-a/wt-broken']).toBeUndefined();
    expect(state.diffStats['repo-a/wt-ok']).toEqual({
      insertions: 1,
      deletions: 0,
    });
  });

  it('applies healthIssue updates returned by the batch response', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 0,
        deletions: 0,
        healthIssue: brokenIssue,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
    });

    await useProjectsStore.getState().refreshDiffStats();

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toEqual(brokenIssue);
    // Broken items should not populate diff stats.
    expect(
      useProjectsStore.getState().diffStats['repo-a/wt-1'],
    ).toBeUndefined();
  });

  it('clears a persisted broken marker when the backend reports healthy', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 0,
        deletions: 0,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: {},
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);
    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toBeUndefined();
  });

  it('refreshes an already-loaded Changed Files list with targeted git stats', async () => {
    const getChangedFilesForActivity = jest.fn().mockResolvedValue({
      uncommitted: [],
      committed: [],
    });
    Object.assign(globalThis.window.api, {
      activity: { getChangedFiles: getChangedFilesForActivity },
    });
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 0,
        deletions: 0,
        hasUncommittedChanges: false,
      },
    ]);
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useActivityStore.setState({
      changedFiles: {
        'repo-a/wt-1': {
          uncommitted: [
            {
              path: 'stale.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
          committed: [],
        },
      },
    });

    await useProjectsStore
      .getState()
      .refreshWorktreeDiffStats('repo-a', 'wt-1');

    expect(getChangedFilesForActivity).toHaveBeenCalledWith({
      projectId: 'repo-a',
      worktreeId: 'wt-1',
    });
    expect(useActivityStore.getState().changedFiles['repo-a/wt-1']).toEqual({
      uncommitted: [],
      committed: [],
    });
  });

  it('keeps a targeted git refresh best-effort when Changed Files reload fails', async () => {
    const getChangedFilesForActivity = jest
      .fn()
      .mockRejectedValue(new Error('getChangedFiles failed'));
    Object.assign(globalThis.window.api, {
      activity: { getChangedFiles: getChangedFilesForActivity },
    });
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 1,
        deletions: 0,
        hasUncommittedChanges: true,
      },
    ]);
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useActivityStore.setState({
      changedFiles: {
        'repo-a/wt-1': { uncommitted: [], committed: [] },
      },
    });

    await expect(
      useProjectsStore.getState().refreshWorktreeDiffStats('repo-a', 'wt-1'),
    ).resolves.toBeUndefined();
    expect(useProjectsStore.getState().diffStats['repo-a/wt-1']).toEqual({
      insertions: 1,
      deletions: 0,
    });
  });

  it('skips git-pending worktrees during the shared diff-stat refresh and clears stale broken markers', async () => {
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-ready',
        insertions: 2,
        deletions: 1,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-ready',
              branchName: 'wt-ready',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'wt-pending',
              branchName: 'wt-pending',
              createdAt: '2026-04-02T00:00:00.000Z',
              setupPhase: 'git-pending',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      diffStats: { 'repo-a/wt-pending': { insertions: 9, deletions: 9 } },
    });

    await useProjectsStore.getState().refreshDiffStats();

    expect(getDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [{ projectId: 'repo-a', worktreeId: 'wt-ready' }],
      source: 'renderer-global-poll',
    });
    expect(
      useProjectsStore.getState().diffStats['repo-a/wt-pending'],
    ).toBeUndefined();
    const pendingWorktree = getProjectWorktrees(
      useProjectsStore.getState().projects[0],
    ).find((worktree) => worktree.id === 'wt-pending');
    expect(pendingWorktree?.healthIssue).toBeUndefined();
  });

  it('skips a targeted health refresh while the selected worktree is git-pending', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-pending',
              branchName: 'wt-pending',
              createdAt: '2026-04-02T00:00:00.000Z',
              setupPhase: 'git-pending',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore
      .getState()
      .refreshWorktreeDiffStats('repo-a', 'wt-pending');

    expect(getDiffStatsBatch).not.toHaveBeenCalled();
  });

  it('reports when a verified targeted diff refresh fails', async () => {
    getDiffStatsBatch.mockRejectedValueOnce(new Error('status unavailable'));

    await expect(
      useProjectsStore
        .getState()
        .refreshWorktreeDiffStatsVerified('repo-a', 'wt-ready'),
    ).resolves.toBe(false);
  });

  it('reports when a verified targeted diff refresh omits the worktree', async () => {
    getDiffStatsBatch.mockResolvedValueOnce([]);

    await expect(
      useProjectsStore
        .getState()
        .refreshWorktreeDiffStatsVerified('repo-a', 'wt-ready'),
    ).resolves.toBe(false);
  });

  it('rejects a diff-stats failure placeholder as verified status', async () => {
    getDiffStatsBatch.mockResolvedValueOnce([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-ready',
        insertions: 0,
        deletions: 0,
      },
    ]);

    await expect(
      useProjectsStore
        .getState()
        .refreshWorktreeDiffStatsVerified('repo-a', 'wt-ready'),
    ).resolves.toBe(false);
  });

  it('retries verified status when a global poll supersedes it', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-ready',
              branchName: 'wt-ready',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    getDiffStatsBatch.mockResolvedValueOnce([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-ready',
        insertions: 0,
        deletions: 0,
        hasUncommittedChanges: false,
      },
    ]);
    await useProjectsStore.getState().refreshDiffStats();
    getDiffStatsBatch.mockReset();

    const firstTargetedResponse =
      createDeferred<DiffStatsBatchResponseItem[]>();
    getDiffStatsBatch
      .mockImplementationOnce(() => firstTargetedResponse.promise)
      .mockResolvedValueOnce([
        {
          projectId: 'repo-a',
          worktreeId: 'wt-ready',
          insertions: 1,
          deletions: 0,
          hasUncommittedChanges: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: 'repo-a',
          worktreeId: 'wt-ready',
          insertions: 0,
          deletions: 0,
          hasUncommittedChanges: false,
        },
      ]);

    const verified = useProjectsStore
      .getState()
      .refreshWorktreeDiffStatsVerified('repo-a', 'wt-ready');
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    await useProjectsStore.getState().refreshDiffStats();
    firstTargetedResponse.resolve([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-ready',
        insertions: 0,
        deletions: 0,
        hasUncommittedChanges: false,
      },
    ]);

    await expect(verified).resolves.toBe(true);
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(3);
    expect(getDiffStatsBatch).toHaveBeenLastCalledWith({
      worktrees: [{ projectId: 'repo-a', worktreeId: 'wt-ready' }],
      skipFetch: true,
      source: 'renderer-targeted',
    });
    expect(
      useProjectsStore.getState().uncommittedChanges['repo-a/wt-ready'],
    ).toBe(false);
  });

  it('clears stale health issues and refreshes deferred worktree data on git-ready', () => {
    const refreshDiffStats = jest.fn<Promise<void>, []>();
    refreshDiffStats.mockResolvedValue(undefined);
    const refreshWorktreeDiffStatsFromRemote = jest.fn<
      Promise<void>,
      [string, string]
    >();
    refreshWorktreeDiffStatsFromRemote.mockResolvedValue(undefined);
    const refreshWorktreeDiffStats = jest.fn<Promise<void>, [string, string]>();
    refreshWorktreeDiffStats.mockResolvedValue(undefined);
    // Task H1: drift is deferred from the pending-creation finalize and
    // refreshed here on git-ready, so it must be stubbed alongside diff stats.
    const refreshWorkspaceDrift = jest.fn<
      Promise<void>,
      [items?: SidebarItem[] | undefined]
    >();
    refreshWorkspaceDrift.mockResolvedValue(undefined);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-pending',
              branchName: 'feature/pending',
              createdAt: '2026-04-09T00:00:00.000Z',
              setupPhase: 'git-pending',
              healthIssue: {
                status: 'broken',
                code: 'missing-worktree-path',
                message: 'Missing worktree path',
                checkedAt: '2026-04-09T00:00:00.000Z',
                worktreePath: '/repos/project-a/.worktrees/wt-pending',
              },
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      refreshDiffStats,
      refreshWorktreeDiffStats,
      refreshWorktreeDiffStatsFromRemote,
      refreshWorkspaceDrift,
    });

    useProjectsStore.getState().subscribeToWorktreeGitLifecycleEvents();
    if (!worktreeGitReadyHandler) {
      throw new Error('Expected worktreeGitReady handler to be registered');
    }

    worktreeGitReadyHandler({
      projectId: 'project-a',
      worktreeId: 'wt-pending',
      branchName: 'feature/ready',
      worktreeEffective: {
        effectiveScripts: {
          launch: 'npm run dev',
        },
        effectiveHooks: {
          'pr:create': [{ type: 'command', command: 'echo hook' }],
        },
      },
    });

    const worktree = getProjectWorktrees(
      useProjectsStore
        .getState()
        .projects.find((project) => project.id === 'project-a'),
    ).find((wt) => wt.id === 'wt-pending');
    expect(worktree?.setupPhase).toBe('git-ready');
    expect(worktree?.branchName).toBe('feature/ready');
    expect(worktree?.healthIssue).toBeUndefined();
    expect(
      getProjectWorktreeEffective(useProjectsStore.getState().projects[0])[
        'wt-pending'
      ],
    ).toEqual({
      effectiveScripts: {
        launch: 'npm run dev',
      },
      effectiveHooks: {
        'pr:create': [{ type: 'command', command: 'echo hook' }],
      },
    });
    expect(refreshDiffStats).not.toHaveBeenCalled();
    expect(refreshWorktreeDiffStats).toHaveBeenCalledWith(
      'project-a',
      'wt-pending',
    );
    expect(refreshWorktreeDiffStatsFromRemote).not.toHaveBeenCalled();
    expect(refreshWorkspaceDrift).toHaveBeenCalledTimes(1);
    // File indexing is deliberately lazy. A real setup script can be
    // materializing tens of thousands of ignored dependency files as this
    // event arrives; Cmd+P / @ fetch when the user actually opens them.
    expect(fetchFileIndex).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshDiffStats calls and reruns once when queued', async () => {
    let firstPending = true;
    let resolveFirst = (): void => {};
    getDiffStatsBatch.mockImplementation(async () => {
      if (firstPending) {
        firstPending = false;
        await new Promise<void>((resolvePromise) => {
          resolveFirst = resolvePromise;
        });
      }
      return [
        {
          projectId: 'repo-a',
          worktreeId: 'wt-1',
          insertions: 0,
          deletions: 0,
        },
      ];
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useProjectsStore.setState({
      loadProjects: jest.fn().mockResolvedValue(undefined),
    });

    const first = useProjectsStore.getState().refreshDiffStats();
    const second = useProjectsStore.getState().refreshDiffStats();
    const third = useProjectsStore.getState().refreshDiffStats();

    // Drain any microtasks so the first mock call starts awaiting the deferred.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    // Coalesced: only the initial call has been dispatched so far.
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);

    // Release the first in-flight call so the trailing pass can run.
    resolveFirst();

    await Promise.all([first, second, third]);

    // One initial call + one trailing pass for the queued callers.
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(2);
  });

  it('serializes targeted refreshes so disjoint results are both applied', async () => {
    const firstResponse = createDeferred<DiffStatsBatchResponseItem[]>();
    const secondResponse = createDeferred<DiffStatsBatchResponseItem[]>();
    getDiffStatsBatch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
            {
              id: 'wt-2',
              branchName: 'wt-2',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const first = useProjectsStore
      .getState()
      .refreshWorktreeDiffStatsFromRemote('repo-a', 'wt-1');
    const second = useProjectsStore
      .getState()
      .refreshWorktreeDiffStatsFromRemote('repo-a', 'wt-2');
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);
    expect(getDiffStatsBatch).toHaveBeenNthCalledWith(1, {
      worktrees: [{ projectId: 'repo-a', worktreeId: 'wt-1' }],
      skipFetch: undefined,
      source: 'renderer-targeted',
    });

    firstResponse.resolve([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 1,
        deletions: 2,
      },
    ]);
    await first;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(getDiffStatsBatch).toHaveBeenCalledTimes(2);
    expect(getDiffStatsBatch).toHaveBeenNthCalledWith(2, {
      worktrees: [{ projectId: 'repo-a', worktreeId: 'wt-2' }],
      skipFetch: undefined,
      source: 'renderer-targeted',
    });

    secondResponse.resolve([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-2',
        insertions: 3,
        deletions: 4,
      },
    ]);
    await second;

    expect(useProjectsStore.getState().diffStats).toMatchObject({
      'repo-a/wt-1': { insertions: 1, deletions: 2 },
      'repo-a/wt-2': { insertions: 3, deletions: 4 },
    });
  });

  it('retryWorktreeHealthCheck updates state and refreshes on healthy result', async () => {
    retryWorktreeHealthCheck.mockResolvedValue({
      healthy: true,
      worktree: {
        id: 'wt-1',
        branchName: 'wt-1',
        createdAt: '2026-04-02T00:00:00.000Z',
      },
    });
    getDiffStatsBatch.mockResolvedValue([]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const response = await useProjectsStore
      .getState()
      .retryWorktreeHealthCheck('repo-a', 'wt-1');

    expect(response.healthy).toBe(true);
    expect(retryWorktreeHealthCheck).toHaveBeenCalledWith({
      projectId: 'repo-a',
      worktreeId: 'wt-1',
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toBeUndefined();
  });

  it('retryWorktreeHealthCheck returns before the follow-up diff refresh completes', async () => {
    let resolveStats: (items: DiffStatsBatchResponseItem[]) => void = () =>
      undefined;
    retryWorktreeHealthCheck.mockResolvedValue({
      healthy: true,
      worktree: {
        id: 'wt-1',
        branchName: 'wt-1',
        createdAt: '2026-04-02T00:00:00.000Z',
      },
    });
    getDiffStatsBatch.mockImplementation(
      () =>
        new Promise<DiffStatsBatchResponseItem[]>((resolvePromise) => {
          resolveStats = resolvePromise;
        }),
    );

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const response = await useProjectsStore
      .getState()
      .retryWorktreeHealthCheck('repo-a', 'wt-1');

    expect(response.healthy).toBe(true);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);

    resolveStats([]);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  });

  it('retryWorktreeHealthCheck keeps broken marker on unhealthy result and still refreshes', async () => {
    retryWorktreeHealthCheck.mockResolvedValue({
      healthy: false,
      worktree: {
        id: 'wt-1',
        branchName: 'wt-1',
        createdAt: '2026-04-02T00:00:00.000Z',
        healthIssue: brokenIssue,
      },
      issue: brokenIssue,
    });
    getDiffStatsBatch.mockResolvedValue([
      {
        projectId: 'repo-a',
        worktreeId: 'wt-1',
        insertions: 0,
        deletions: 0,
        healthIssue: brokenIssue,
      },
    ]);

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'wt-1',
              createdAt: '2026-04-02T00:00:00.000Z',
              healthIssue: brokenIssue,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const response = await useProjectsStore
      .getState()
      .retryWorktreeHealthCheck('repo-a', 'wt-1');

    expect(response.healthy).toBe(false);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(getDiffStatsBatch).toHaveBeenCalledTimes(1);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toEqual(brokenIssue);
  });
});

describe('projectsStore createWorktree with baseWorktreeId', () => {
  const createWorkspaceWorktree2 = jest.fn();
  const saveProjects2 = jest.fn<
    Promise<void>,
    [items?: SidebarItem[] | undefined]
  >();
  const refreshDiffStats2 = jest.fn<Promise<void>, []>();
  const refreshWorkspaceDrift2 = jest.fn<
    Promise<void>,
    [items?: SidebarItem[] | undefined]
  >();
  const selectWorktree2 = jest.fn<void, [string, string]>();
  const fetchFileIndex2 = jest.fn<Promise<void>, [string, string]>();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        createWorkspaceWorktree: createWorkspaceWorktree2,
        inspectHookChatPluginDependencies: jest
          .fn()
          .mockResolvedValue({ items: [] }),
        inspectRecommendedPlugins: jest.fn().mockResolvedValue({
          items: [],
          promptItems: [],
          scopeLabel: '',
          workspaceId: '',
        }),
      },
    });

    saveProjects2.mockResolvedValue(undefined);
    refreshDiffStats2.mockResolvedValue(undefined);
    refreshWorkspaceDrift2.mockResolvedValue(undefined);
    fetchFileIndex2.mockResolvedValue(undefined);

    useChatStore.setState({
      deselectWorktree: jest.fn(),
      selectedWorktree: null,
      selectWorktree: selectWorktree2,
    });
    useFileListStore.setState({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set<string>(),
      indexVersions: {},
      rootsCache: {},
      rootsErrors: {},
      rootsLoading: new Set<string>(),
      rootsVersions: {},
      directoryCache: {},
      directoryErrors: {},
      directoryLoading: new Set<string>(),
      directoryVersions: {},
      fetchFileIndex: fetchFileIndex2,
    });
  });

  it('passes baseWorktreeId through to createWorkspaceWorktree', async () => {
    createWorkspaceWorktree2.mockResolvedValue({
      id: 'wt-new',
      branchName: 'wt-new',
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [
            {
              id: 'wt-base',
              branchName: 'feature-base',
              createdAt: '2026-04-02T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      saveProjects: saveProjects2,
      refreshDiffStats: refreshDiffStats2,
      refreshWorkspaceDrift: refreshWorkspaceDrift2,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore
      .getState()
      .createWorktree('workspace-a', { baseWorktreeId: 'wt-base' });

    expect(createWorkspaceWorktree2).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      existingWorktreeIds: ['wt-base'],
      baseWorktreeId: 'wt-base',
    });
  });

  it('persists trackedRepoBaseBranches from create response via finalizeCreatedWorktree', async () => {
    createWorkspaceWorktree2.mockResolvedValue({
      id: 'wt-new',
      branchName: 'wt-new',
      trackedRepoBaseBranches: { 'repo-1': 'develop' },
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: true,
          order: 0,
        },
      ],
      saveProjects: saveProjects2,
      refreshDiffStats: refreshDiffStats2,
      refreshWorkspaceDrift: refreshWorkspaceDrift2,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore.getState().createWorktree('workspace-a');

    const wt = getProjectWorktrees(
      useProjectsStore.getState().projects.find((p) => p.id === 'workspace-a'),
    ).find((w) => w.id === 'wt-new');
    expect(wt?.trackedRepoBaseBranches).toEqual({ 'repo-1': 'develop' });
  });

  it('preserves trackedRepoBaseBranches through pending repair', async () => {
    createWorkspaceWorktree2.mockResolvedValue({
      id: 'wt-repair',
      branchName: 'wt-repair',
      trackedRepoBaseBranches: { 'repo-1': 'main' },
      needsRepair: true,
      repairIssues: [{ code: 'missing-gitignore', repoId: 'repo-1' }],
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: true,
          order: 0,
        },
      ],
      saveProjects: saveProjects2,
      refreshDiffStats: refreshDiffStats2,
      refreshWorkspaceDrift: refreshWorkspaceDrift2,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
    });

    await useProjectsStore.getState().createWorktree('workspace-a');

    const pending = useProjectsStore.getState().pendingWorkspaceRepair;
    expect(pending).not.toBeNull();
    expect(pending?.trackedRepoBaseBranches).toEqual({ 'repo-1': 'main' });
  });

  function seedEmptyWorkspace(): void {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: true,
          order: 0,
        },
      ],
      saveProjects: saveProjects2,
      refreshDiffStats: refreshDiffStats2,
      refreshWorkspaceDrift: refreshWorkspaceDrift2,
      creatingWorktreeForProject: new Set<string>(),
      pendingWorkspaceRepair: null,
      worktreeError: null,
    });
  }

  it('stores a failed create without the IPC invoke wrapper', async () => {
    createWorkspaceWorktree2.mockRejectedValue(
      new Error(
        "Error invoking remote method 'worktree:create': Error: Command failed while creating the binturong worktree from develop.\nerror: unable to create file a.ts: No space left on device",
      ),
    );
    seedEmptyWorkspace();

    await useProjectsStore.getState().createWorktree('workspace-a');

    expect(useProjectsStore.getState().worktreeError).toBe(
      'Command failed while creating the binturong worktree from develop.\nerror: unable to create file a.ts: No space left on device',
    );
    expect(
      useProjectsStore.getState().creatingWorktreeForProject.has('workspace-a'),
    ).toBe(false);
  });

  it('stores the fallback message when create rejects with a non-Error', async () => {
    createWorkspaceWorktree2.mockRejectedValue('boom');
    seedEmptyWorkspace();

    await useProjectsStore.getState().createWorktree('workspace-a');

    expect(useProjectsStore.getState().worktreeError).toBe(
      'Failed to create worktree',
    );
  });
});

describe('projectsStore loadProjects warnings', () => {
  const loadProjectsApi = jest.fn();
  const saveProjectsApi = jest.fn();
  const observedLoads: Array<{
    stage: string;
    details: Record<string, unknown>;
  }> = [];
  const initialE2eDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_E2E__',
  );

  beforeAll(() => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
  });

  afterAll(() => {
    if (initialE2eDescriptor) {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', initialE2eDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        loadProjects: loadProjectsApi,
        saveProjects: saveProjectsApi,
        e2eReportFirstProjectsLoad: (
          stage: string,
          details: Record<string, unknown>,
        ) => {
          observedLoads.push({ stage, details });
          return Promise.reject(new Error('observer rejection'));
        },
        e2eIsFirstProjectsLoadActive: () => true,
      },
    });
    observedLoads.length = 0;

    useProjectsStore.setState(useProjectsStore.getInitialState());
    useGitHubStore.setState({
      toasts: [],
    });
    saveProjectsApi.mockResolvedValue(undefined);
    refreshInAppNotificationPrefs({
      enabled: true,
      placement: 'bottom-right',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
    });
  });

  it('shows one toast for invalid project manifests and does not repeat it on identical reloads', async () => {
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [],
      warnings: [
        {
          code: 'invalid-canopy-json',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          filePath: '/repos/workspace-a/canopy.json',
          reason: 'Unexpected token ] in JSON at position 19',
        },
      ],
    });

    await useProjectsStore.getState().loadProjects();
    await useProjectsStore.getState().loadProjects({ silent: true });

    const toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('error');
    expect(toasts[0]?.message).toContain(
      'Could not refresh project "Workspace A"',
    );
    expect(toasts[0]?.message).toContain('/repos/workspace-a/canopy.json');
  });

  it('does not let an older project load erase a newer archived-container count', async () => {
    const olderResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const newerResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const project: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-archive-count',
      name: 'Archive Count',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      archivedContainerCount: 0,
    };
    loadProjectsApi
      .mockImplementationOnce(() => olderResponse.promise)
      .mockImplementationOnce(() => newerResponse.promise);

    const olderLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    const newerLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });

    newerResponse.resolve({
      version: 1,
      items: [{ ...project, archivedContainerCount: 1 }],
    });
    await newerLoad;
    olderResponse.resolve({ version: 1, items: [project] });
    await olderLoad;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({
        id: 'workspace-archive-count',
        archivedContainerCount: 1,
      }),
    ]);
    expect(observedLoads.map(({ stage }) => stage)).toEqual(
      expect.arrayContaining([
        'projects-load-renderer-entered',
        'projects-load-renderer-ipc-resolved',
        'projects-load-renderer-superseded',
        'projects-load-renderer-applied',
        'projects-load-renderer-completed',
      ]),
    );
  });

  it('keeps superseded callers pending until the latest project load finishes', async () => {
    const olderResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const newerResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const project: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-load-barrier',
      name: 'Load Barrier',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      archivedContainerCount: 0,
    };
    loadProjectsApi
      .mockImplementationOnce(() => olderResponse.promise)
      .mockImplementationOnce(() => newerResponse.promise);

    let olderSettled = false;
    const olderLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true })
      .then(() => {
        olderSettled = true;
      });
    const newerLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });

    olderResponse.resolve({ version: 1, items: [project] });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(olderSettled).toBe(false);

    newerResponse.resolve({
      version: 1,
      items: [{ ...project, archivedContainerCount: 1 }],
    });
    await Promise.all([olderLoad, newerLoad]);

    expect(olderSettled).toBe(true);
    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({
        id: 'workspace-load-barrier',
        archivedContainerCount: 1,
      }),
    ]);
  });

  it('releases superseded callers when a third load wins before the middle load settles', async () => {
    const oldestResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const middleResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const newestResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const project: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-three-load-barrier',
      name: 'Three Load Barrier',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      archivedContainerCount: 0,
    };
    loadProjectsApi
      .mockImplementationOnce(() => oldestResponse.promise)
      .mockImplementationOnce(() => middleResponse.promise)
      .mockImplementationOnce(() => newestResponse.promise);

    let oldestSettled = false;
    const oldestLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true })
      .then(() => {
        oldestSettled = true;
      });
    const middleLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });

    oldestResponse.resolve({ version: 1, items: [project] });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(oldestSettled).toBe(false);

    const newestLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    newestResponse.resolve({
      version: 1,
      items: [{ ...project, archivedContainerCount: 1 }],
    });
    await newestLoad;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(oldestSettled).toBe(true);

    middleResponse.resolve({ version: 1, items: [project] });
    await Promise.all([oldestLoad, middleLoad]);
    expect(useProjectsStore.getState().projects).toEqual([
      expect.objectContaining({
        id: 'workspace-three-load-barrier',
        archivedContainerCount: 1,
      }),
    ]);
  });

  it('keeps the last good projects when a refresh rejects', async () => {
    const existingProject: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    useProjectsStore.setState({
      projects: [existingProject],
      hasHydratedProjects: true,
    });
    loadProjectsApi.mockRejectedValue(
      new Error('transient project config race'),
    );

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(useProjectsStore.getState()).toMatchObject({
      projects: [existingProject],
      hasHydratedProjects: true,
      isLoading: false,
    });

    await useProjectsStore.getState().saveProjects();

    expect(saveProjectsApi).toHaveBeenCalledWith([existingProject], {
      preserveWorkspaceIds: ['workspace-a'],
    });
    const errorObservation = observedLoads.find(
      ({ stage, details }) =>
        stage === 'projects-load-renderer-error' && details.phase === 'caught',
    );
    expect(errorObservation?.details.errorKind).toBe('error');
    expect(errorObservation?.details.superseded).toBe(false);
    expect(
      observedLoads.some(
        ({ stage }) => stage === 'projects-load-renderer-completed',
      ),
    ).toBe(true);
  });

  it('keeps the last good copy of a project omitted by a load warning', async () => {
    const existingProject: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const updatedProject: SidebarItem = {
      type: 'single-repo',
      id: 'workspace-b',
      name: 'Workspace B updated',
      color: '#222222',
      repoPath: '/repos/workspace-b',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    useProjectsStore.setState({
      projects: [
        existingProject,
        {
          ...updatedProject,
          name: 'Workspace B',
          order: 1,
        },
      ],
      hasHydratedProjects: true,
    });
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [updatedProject],
      warnings: [
        {
          code: 'workspace-load-failed',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          reason: 'Repo repo-a not found in project workspace-a',
        },
      ],
    });

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(
      useProjectsStore
        .getState()
        .projects.map((project) => [project.id, project.name]),
    ).toEqual([
      ['workspace-a', 'Workspace A'],
      ['workspace-b', 'Workspace B updated'],
    ]);
    const resolvedObservation = observedLoads.find(
      ({ stage }) => stage === 'projects-load-renderer-ipc-resolved',
    )?.details;
    expect(typeof resolvedObservation?.generation).toBe('number');
    expect(resolvedObservation).toMatchObject({
      warningCount: 1,
      warningIdentities: [
        {
          workspaceId: 'workspace-a',
          code: 'workspace-load-failed',
        },
      ],
    });
  });

  it('attributes bounded warning identities to their overlapping load generations', async () => {
    const olderResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    const newerResponse =
      createDeferred<Awaited<ReturnType<CanopyApi['loadProjects']>>>();
    loadProjectsApi
      .mockImplementationOnce(() => olderResponse.promise)
      .mockImplementationOnce(() => newerResponse.promise);

    const olderLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    const newerLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    newerResponse.resolve({
      version: 1,
      items: [],
      warnings: [
        {
          code: 'invalid-canopy-json',
          workspaceId: 'workspace-new',
          workspaceName: 'private',
          filePath: '/private/new.json',
          reason: 'private',
        },
      ],
    });
    await newerLoad;
    olderResponse.resolve({
      version: 1,
      items: [],
      warnings: [
        {
          code: 'workspace-load-failed',
          workspaceId: 'workspace-old',
          workspaceName: 'private',
          reason: 'private',
        },
      ],
    });
    await olderLoad;

    const resolutions = observedLoads.filter(
      ({ stage }) => stage === 'projects-load-renderer-ipc-resolved',
    );
    expect(resolutions).toHaveLength(2);
    expect(resolutions.map(({ details }) => details.warningIdentities)).toEqual(
      [
        [
          {
            workspaceId: 'workspace-new',
            code: 'invalid-canopy-json',
          },
        ],
        [
          {
            workspaceId: 'workspace-old',
            code: 'workspace-load-failed',
          },
        ],
      ],
    );
    expect(JSON.stringify(resolutions)).not.toContain('private');
  });

  it('bounds inspected renderer entries independently from accepted ids', async () => {
    const items: SidebarItem[] = Array.from({ length: 40 }, (_, index) => ({
      type: 'single-repo',
      id: `invalid!${index}`,
      name: `Project ${index}`,
      color: '#111111',
      repoPath: `/repo/${index}`,
      worktrees: [],
      collapsed: false,
      order: index,
    }));
    loadProjectsApi.mockResolvedValue({ version: 1, items, warnings: [] });

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(useProjectsStore.getState().projects).toHaveLength(40);
    const loaded = observedLoads.find(
      ({ stage }) => stage === 'projects-load-renderer-ipc-resolved',
    )?.details;
    expect(loaded).toMatchObject({
      itemCount: 40,
      workspaceIds: [],
      workspaceInspectedCount: 16,
      workspaceOmittedCount: 24,
      truncated: true,
    });
  });

  it('does no renderer observation work after the preload producer becomes inactive', async () => {
    const project: SidebarItem = {
      type: 'single-repo',
      id: 'workspace-inactive-observer',
      name: 'Inactive observer',
      color: '#111111',
      repoPath: '/repo/inactive',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [project],
      warnings: [],
    });
    (
      window.api as unknown as Record<string, unknown>
    ).e2eIsFirstProjectsLoadActive = (): boolean => false;
    Object.defineProperty(globalThis.window, 'e2eReportFirstProjectsLoad', {
      configurable: true,
      value: (stage: string, details: Record<string, unknown>) => {
        observedLoads.push({ stage, details });
      },
    });

    await useProjectsStore.getState().loadProjects({ silent: true });

    expect(useProjectsStore.getState().projects).toEqual([project]);
    expect(observedLoads).toEqual([]);
  });

  it('marks preserved failed projects as non-authoritative during saves', async () => {
    const existingProject: SidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    useProjectsStore.setState({
      projects: [existingProject],
      hasHydratedProjects: true,
    });
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [],
      warnings: [
        {
          code: 'workspace-load-failed',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          reason: 'transient config read failure',
        },
      ],
    });

    await useProjectsStore.getState().loadProjects({ silent: true });
    await useProjectsStore.getState().saveProjects();

    expect(saveProjectsApi).toHaveBeenCalledWith([existingProject], {
      preserveWorkspaceIds: ['workspace-a'],
    });
  });

  it('protects failed cold-start projects that are absent from renderer state', async () => {
    const loadedProject: SidebarItem = {
      type: 'single-repo',
      id: 'workspace-b',
      name: 'Workspace B',
      color: '#222222',
      repoPath: '/repos/workspace-b',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [loadedProject],
      warnings: [
        {
          code: 'workspace-load-failed',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          reason: 'transient config read failure',
        },
      ],
    });

    await useProjectsStore.getState().loadProjects({ silent: true });
    await useProjectsStore.getState().saveProjects();

    expect(saveProjectsApi).toHaveBeenCalledWith([loadedProject], {
      preserveWorkspaceIds: ['workspace-a'],
    });
  });
});

describe('projectsStore PR status persistence', () => {
  const loadProjectsApi = jest.fn();
  const saveProjectsApi = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        loadProjects: loadProjectsApi,
        saveProjects: saveProjectsApi,
      },
    });

    useProjectsStore.setState(useProjectsStore.getInitialState());
    useGitHubStore.setState(useGitHubStore.getInitialState());
    saveProjectsApi.mockResolvedValue(undefined);
  });

  it('hydrates github PR status state from persisted worktree data on load', async () => {
    const persistedStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          status: {
            prNumber: 17,
            prUrl: 'https://github.com/acme/repo-a/pull/17',
            state: 'open',
            title: 'Persisted PR',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-04-16T00:00:00.000Z',
    };
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/test',
              createdAt: '2026-04-16T00:00:00.000Z',
              lastKnownPrStatus: persistedStatus,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore.getState().loadProjects();

    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toEqual(
      persistedStatus,
    );
  });

  it('keeps live PR status snapshots when projects reload from stale persisted data', async () => {
    const liveStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          status: {
            prNumber: 823,
            prUrl: 'https://github.com/acme/repo-a/pull/823',
            state: 'open',
            title: 'Live PR',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-04-16T01:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-04-16T01:00:00.000Z',
    };

    useGitHubStore.setState({
      prStatuses: {
        'project-a/wt-1': liveStatus,
      },
    });
    loadProjectsApi.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/test',
              createdAt: '2026-04-16T00:00:00.000Z',
              lastKnownPrStatus: null,
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore.getState().loadProjects({ silent: true });

    const worktree = getProjectWorktrees(
      useProjectsStore.getState().projects[0],
    ).find((candidate) => candidate.id === 'wt-1');
    expect(worktree?.lastKnownPrStatus).toEqual(liveStatus);
    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toEqual(
      liveStatus,
    );
  });

  it('merges live PR status snapshots into saved worktree payloads', async () => {
    const liveStatus: WorktreePrStatus = {
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          status: {
            prNumber: 18,
            prUrl: 'https://github.com/acme/repo-a/pull/18',
            state: 'open',
            title: 'Live PR',
            checkStatus: 'pending',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 2,
            updatedAt: '2026-04-16T01:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-04-16T01:00:00.000Z',
    };

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/test',
              createdAt: '2026-04-16T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useGitHubStore.setState({
      prStatuses: {
        'project-a/wt-1': liveStatus,
      },
    });

    await useProjectsStore.getState().saveProjects();

    expect(saveProjectsApi).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'project-a',
        worktrees: [
          expect.objectContaining({
            id: 'wt-1',
            lastKnownPrStatus: liveStatus,
          }),
        ],
      }),
    ]);
  });
});

describe('projectsStore reference-repo status', () => {
  let capturedCallback:
    | ((event: {
        workspaceId: string;
        status: {
          healthy: boolean;
          warnings: { code: string; message: string }[];
          lastCheckedAt: string;
        };
        didUpdateReferenceRepo?: boolean;
      }) => void)
    | null = null;

  const onWorkspaceReferenceRepoStatus = jest.fn(
    (cb: typeof capturedCallback): (() => void) => {
      capturedCallback = cb;
      return (): void => {
        capturedCallback = null;
      };
    },
  );
  const loadProjects = jest.fn<Promise<void>, []>();

  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        onWorkspaceReferenceRepoStatus,
      },
    });

    loadProjects.mockResolvedValue(undefined);

    useProjectsStore.setState({
      ...useProjectsStore.getInitialState(),
      loadProjects,
      workspaceReferenceRepoStatus: {},
    });
  });

  it('updates the store when a reference-repo status event arrives', () => {
    const unsub = useProjectsStore
      .getState()
      .subscribeToWorkspaceReferenceRepoEvents();

    expect(onWorkspaceReferenceRepoStatus).toHaveBeenCalledTimes(1);
    expect(capturedCallback).toBeTruthy();

    if (!capturedCallback) throw new Error('Expected callback to be set');
    capturedCallback({
      workspaceId: 'ws-1',
      status: {
        healthy: false,
        warnings: [{ code: 'behind-remote', message: 'Behind remote' }],
        lastCheckedAt: '2026-04-03T00:00:00.000Z',
      },
    });

    const stored = useProjectsStore.getState().workspaceReferenceRepoStatus;
    expect(stored['ws-1']).toEqual({
      healthy: false,
      warnings: [{ code: 'behind-remote', message: 'Behind remote' }],
      lastCheckedAt: '2026-04-03T00:00:00.000Z',
    });

    unsub();
  });

  it('calls loadProjects when didUpdateReferenceRepo is true', () => {
    useProjectsStore.getState().subscribeToWorkspaceReferenceRepoEvents();

    if (!capturedCallback) throw new Error('Expected callback to be set');
    capturedCallback({
      workspaceId: 'ws-2',
      status: {
        healthy: true,
        warnings: [],
        lastCheckedAt: '2026-04-03T00:00:00.000Z',
      },
      didUpdateReferenceRepo: true,
    });

    expect(loadProjects).toHaveBeenCalledTimes(1);
  });

  it('does not call loadProjects when didUpdateReferenceRepo is falsy', () => {
    useProjectsStore.getState().subscribeToWorkspaceReferenceRepoEvents();

    if (!capturedCallback) throw new Error('Expected callback to be set');
    capturedCallback({
      workspaceId: 'ws-3',
      status: {
        healthy: false,
        warnings: [{ code: 'not-default-branch', message: 'Not on default' }],
        lastCheckedAt: '2026-04-03T00:00:00.000Z',
      },
    });

    expect(loadProjects).not.toHaveBeenCalled();
  });
});

describe('projectsStore hook chat plugin install prompt', () => {
  const inspectHookChatPluginDependencies = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        inspectHookChatPluginDependencies,
      },
    });

    useProjectsStore.setState({
      pendingHookChatPluginInstallPrompt: null,
      projects: [],
    });
  });

  it('does nothing when the inspector returns no items', async () => {
    inspectHookChatPluginDependencies.mockResolvedValue({ items: [] });

    await useProjectsStore
      .getState()
      .inspectHookChatPluginDependencies('proj-1', 'wt-1');

    expect(
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt,
    ).toBeNull();
  });

  it('sets the pending prompt when only unavailable items are missing', async () => {
    inspectHookChatPluginDependencies.mockResolvedValue({
      items: [
        {
          key: 'skill:github:acme/skills:tool',
          kind: 'skill',
          displayName: 'tool',
          displayDescription: 'tool',
          displaySource: 'acme/skills',
          installState: 'unavailable',
          usedBy: [],
        },
      ],
    });

    await useProjectsStore
      .getState()
      .inspectHookChatPluginDependencies('proj-1', 'wt-1');

    expect(
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt?.items,
    ).toHaveLength(1);
  });

  it('sets the pending prompt with worktree label fallback to branchName', async () => {
    inspectHookChatPluginDependencies.mockResolvedValue({
      items: [
        {
          key: 'skill:github:acme/skills:tool',
          kind: 'skill',
          displayName: 'tool',
          displayDescription: 'tool',
          displaySource: 'acme/skills',
          installState: 'installable',
          installSpec: {
            kind: 'skill',
            repo: 'acme/skills',
            skillName: 'tool',
          },
          usedBy: [{ triggerName: 'pr:create', scope: 'project' }],
        },
      ],
    });

    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'proj-1',
          name: 'Project 1',
          color: '#aabbcc',
          repoPath: '/tmp/repo',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature-branch',
              createdAt: '2026-04-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    await useProjectsStore
      .getState()
      .inspectHookChatPluginDependencies('proj-1', 'wt-1');

    const pending =
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt;
    expect(pending?.projectId).toBe('proj-1');
    expect(pending?.worktreeId).toBe('wt-1');
    expect(pending?.worktreeLabel).toBe('feature-branch');
    expect(pending?.items).toHaveLength(1);
  });

  it('uses the provided worktreeLabel when supplied', async () => {
    inspectHookChatPluginDependencies.mockResolvedValue({
      items: [
        {
          key: 'skill:github:acme/skills:tool',
          kind: 'skill',
          displayName: 'tool',
          displayDescription: 'tool',
          displaySource: 'acme/skills',
          installState: 'installable',
          installSpec: {
            kind: 'skill',
            repo: 'acme/skills',
            skillName: 'tool',
          },
          usedBy: [],
        },
      ],
    });

    await useProjectsStore
      .getState()
      .inspectHookChatPluginDependencies('proj-1', 'wt-1', 'custom-label');

    expect(
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt
        ?.worktreeLabel,
    ).toBe('custom-label');
  });

  it('swallows inspector errors instead of throwing', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    inspectHookChatPluginDependencies.mockRejectedValue(
      new Error('inspector failed'),
    );

    await expect(
      useProjectsStore
        .getState()
        .inspectHookChatPluginDependencies('proj-1', 'wt-1'),
    ).resolves.toBeUndefined();

    expect(
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt,
    ).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it('clears the pending prompt on dismiss', () => {
    useProjectsStore.setState({
      pendingHookChatPluginInstallPrompt: {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        worktreeLabel: 'wt-1',
        items: [],
      },
    });

    useProjectsStore.getState().dismissPendingHookChatPluginInstallPrompt();

    expect(
      useProjectsStore.getState().pendingHookChatPluginInstallPrompt,
    ).toBeNull();
  });
});

describe('projectsStore.diffStats helpers', () => {
  // The store body delegates the bulk of `runRefreshDiffStatsOnce` to these
  // pure helpers. They have no IPC dependency, so we exercise them directly to
  // pin down semantics (broken-key handling, branch/health change detection,
  // file-list invalidation, PR-polling registration) without needing the full
  // store harness.
  const helpers = diffStatsHelpers;

  function makeProject(
    id: string,
    worktrees: WorktreeData[],
  ): SingleRepoSidebarItem {
    return {
      id,
      name: id,
      type: 'single-repo',
      repoPath: `/tmp/${id}`,
      color: '#000000',
      worktrees,
      collapsed: false,
      order: 0,
      scripts: {},
      hooks: {},
    };
  }

  function makeWorktree(
    id: string,
    overrides: Partial<WorktreeData> = {},
  ): WorktreeData {
    return {
      id,
      branchName: id,
      createdAt: '2026-01-01T00:00:00.000Z',
      setupPhase: 'git-ready',
      ...overrides,
    };
  }

  it('collectRefreshableWorktrees splits ready and pending worktrees', () => {
    const projects = [
      makeProject('p1', [
        makeWorktree('w1'),
        makeWorktree('w2', { setupPhase: 'git-pending' }),
      ]),
      makeProject('p2', [makeWorktree('w3')]),
    ];

    const result = helpers.collectRefreshableWorktrees(projects);

    expect(result.totalCount).toBe(3);
    expect(result.refreshableWorktrees).toEqual([
      { projectId: 'p1', worktreeId: 'w1' },
      { projectId: 'p2', worktreeId: 'w3' },
    ]);
    expect(Array.from(result.pendingWorktreeKeys)).toEqual(['p1/w2']);
  });

  it('buildDiffStatsState skips broken aggregate maps but keeps repoBranches', () => {
    const response: DiffStatsBatchResponseItem[] = [
      {
        projectId: 'p1',
        worktreeId: 'w1',
        insertions: 3,
        deletions: 1,
        hasCommitsAhead: true,
        branchName: 'feature/a',
        baseBranch: 'main',
        baseBranchExistsLocally: true,
        baseBranchExistsInRemote: true,
      },
      {
        projectId: 'p1',
        worktreeId: 'w2',
        insertions: 0,
        deletions: 0,
        repoBranches: [
          {
            repoId: 'r1',
            repoName: 'r1',
            branch: 'feature/x',
            insertions: 0,
            deletions: 0,
          },
        ],
        healthIssue: {
          status: 'broken',
          code: 'missing-repository',
          checkedAt: '2026-05-03T00:00:00.000Z',
          message: 'gone',
          worktreePath: '/tmp/p1/w2',
        },
      },
    ];

    const built = helpers.buildDiffStatsState(
      response,
      new Set(['p1/wpending']),
    );

    expect(built.diffStats).toEqual({
      'p1/w1': { insertions: 3, deletions: 1 },
    });
    expect(built.commitsAhead).toEqual({ 'p1/w1': true });
    expect(built.baseBranches).toEqual({ 'p1/w1': 'main' });
    expect(built.brokenKeys.has('p1/w2')).toBe(true);
    expect(built.repoBranches['p1/w2']).toBeDefined();
    expect(built.branchUpdates.get('p1/w1')).toBe('feature/a');
    expect(built.healthUpdates.get('p1/w1')).toBeNull();
    expect(built.healthUpdates.get('p1/wpending')).toBeNull();
    expect(built.healthUpdates.get('p1/w2')?.status).toBe('broken');
  });

  it('detectProjectMetadataChanges flags branch and health diffs', () => {
    const projects = [
      makeProject('p1', [
        makeWorktree('w1', { branchName: 'old' }),
        makeWorktree('w2'),
      ]),
    ];
    const branchUpdates = new Map<string, string>([
      ['p1/w1', 'new'],
      ['p1/w2', 'w2'], // unchanged
    ]);
    const healthUpdates = new Map([['p1/w2', null]]);

    const result = helpers.detectProjectMetadataChanges(
      projects,
      branchUpdates,
      healthUpdates,
    );
    expect(result.hasBranchChange).toBe(true);
    expect(result.hasHealthChange).toBe(false);
  });

  it('applyProjectMetadataChanges rewrites worktree branchName/healthIssue', () => {
    const issue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'missing-repository',
      checkedAt: '2026-05-03T00:00:00.000Z',
      message: 'broken',
      worktreePath: '/tmp/p1/w2',
    };
    const projects = [
      makeProject('p1', [
        makeWorktree('w1', { branchName: 'old' }),
        makeWorktree('w2'),
      ]),
    ];

    const branchUpdates = new Map([['p1/w1', 'new']]);
    const healthUpdates = new Map<string, WorktreeHealthIssue | null>([
      ['p1/w2', issue],
    ]);

    const updated = helpers.applyProjectMetadataChanges(
      projects,
      branchUpdates,
      healthUpdates,
    );
    const updatedWorktrees = getProjectWorktrees(updated[0]);
    expect(updatedWorktrees[0]?.branchName).toBe('new');
    expect(updatedWorktrees[1]?.healthIssue).toEqual(issue);
  });

  it('invalidateChangedFileLists invokes for added, changed, and disappeared keys', () => {
    const previous = {
      'p/a': { insertions: 0, deletions: 0 },
      'p/c': { insertions: 1, deletions: 0 },
    };
    const next = {
      'p/a': { insertions: 1, deletions: 0 }, // changed
      'p/b': { insertions: 0, deletions: 0 }, // added
      // 'p/c' disappeared
    };
    const seen: string[] = [];
    helpers.invalidateChangedFileLists(
      previous,
      next,
      (projectId, worktreeId) => {
        seen.push(`${projectId}/${worktreeId}`);
      },
    );
    expect(seen.sort()).toEqual(['p/a', 'p/b', 'p/c']);
  });

  it('collectRemoteCleanDiffStatTransitions returns only remote-backed clean transitions', () => {
    const result = helpers.collectRemoteCleanDiffStatTransitions(
      {
        'p/clean': { insertions: 3, deletions: 0 },
        'p/still-changed': { insertions: 1, deletions: 0 },
        'p/local-base': { insertions: 2, deletions: 1 },
        'p/local-to-remote': { insertions: 2, deletions: 0 },
        'p/multi-repo': { insertions: 5, deletions: 2 },
      },
      {
        'p/clean': { insertions: 0, deletions: 0 },
        'p/still-changed': { insertions: 1, deletions: 0 },
        'p/local-base': { insertions: 0, deletions: 0 },
        'p/local-to-remote': { insertions: 0, deletions: 0 },
        'p/multi-repo': { insertions: 0, deletions: 0 },
      },
      {
        'p/clean': true,
        'p/still-changed': true,
        'p/local-base': true,
        'p/local-to-remote': true,
        'p/multi-repo': true,
      },
      {
        'p/clean': true,
        'p/still-changed': true,
        'p/local-base': false,
        'p/local-to-remote': false,
        'p/multi-repo': false,
      },
      {
        'p/multi-repo': [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'feature/a',
            insertions: 5,
            deletions: 2,
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
        ],
      },
      {
        'p/clean': true,
        'p/still-changed': true,
        'p/local-base': true,
        'p/local-to-remote': true,
        'p/multi-repo': true,
      },
      {
        'p/clean': true,
        'p/still-changed': true,
        'p/local-base': false,
        'p/local-to-remote': true,
        'p/multi-repo': false,
      },
      {
        'p/multi-repo': [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'feature/a',
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
        ],
      },
    );

    expect(result).toEqual([
      { projectId: 'p', worktreeId: 'clean' },
      { projectId: 'p', worktreeId: 'multi-repo' },
    ]);
  });

  it('collectRemoteCleanDiffStatTransitions ignores local-only multi-repo child transitions', () => {
    const result = helpers.collectRemoteCleanDiffStatTransitions(
      {
        'p/mixed': { insertions: 5, deletions: 0 },
      },
      {
        'p/mixed': { insertions: 0, deletions: 0 },
      },
      {
        'p/mixed': true,
      },
      {
        'p/mixed': false,
      },
      {
        'p/mixed': [
          {
            repoId: 'local-child',
            repoName: 'Local Child',
            branch: 'feature/local',
            insertions: 5,
            deletions: 0,
            baseBranchExistsInRemote: false,
            hasOriginRemote: false,
          },
          {
            repoId: 'remote-child',
            repoName: 'Remote Child',
            branch: 'feature/remote',
            insertions: 0,
            deletions: 0,
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
        ],
      },
      {
        'p/mixed': true,
      },
      {
        'p/mixed': false,
      },
      {
        'p/mixed': [
          {
            repoId: 'local-child',
            repoName: 'Local Child',
            branch: 'feature/local',
            insertions: 0,
            deletions: 0,
            baseBranchExistsInRemote: false,
            hasOriginRemote: false,
          },
          {
            repoId: 'remote-child',
            repoName: 'Remote Child',
            branch: 'feature/remote',
            insertions: 0,
            deletions: 0,
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
        ],
      },
    );

    expect(result).toEqual([]);
  });

  it('registerPrPolling registers each worktree exactly once', () => {
    const registered = new Set<string>();
    const calls: string[] = [];
    helpers.registerPrPolling(
      { 'p/a': false, 'p/b': true },
      registered,
      (projectId, worktreeId) => calls.push(`${projectId}/${worktreeId}`),
    );
    expect(calls.sort()).toEqual(['p/a', 'p/b']);
    helpers.registerPrPolling(
      { 'p/a': true, 'p/c': true },
      registered,
      (projectId, worktreeId) => calls.push(`${projectId}/${worktreeId}`),
    );
    // 'p/a' already registered; only 'p/c' fires
    expect(calls.filter((c) => c === 'p/c')).toEqual(['p/c']);
    expect(calls.filter((c) => c === 'p/a').length).toBe(1);
  });
});
