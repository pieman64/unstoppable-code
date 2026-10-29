jest.mock('node:fs/promises');
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'test-animal'),
}));
jest.mock('../lib/git', () => ({
  cleanupPersistedTurnDiffTreeRefs: jest.fn(() => Promise.resolve()),
  createWorktree: jest.fn(() => Promise.resolve('test-animal')),
  createWorktreeFromStartPoint: jest.fn(() => Promise.resolve('test-animal')),
  deleteBranch: jest.fn(),
  fetchOrigin: jest.fn(() => Promise.resolve()),
  getCanopyJsonHash: jest.fn(() => Promise.resolve(null)),
  getCurrentBranch: jest.fn(),
  getCurrentBranchDisplayName: jest.fn(),
  getDiffStats: jest.fn(),
  getRemoteUrl: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  hasUnpulledCommits: jest.fn(),
  hasBranchBeenPushedToRemote: jest.fn(),
  isBranchNameAvailable: jest.fn(),
  isRegisteredWorktreePath: jest.fn(() => Promise.resolve(false)),
  listBranches: jest.fn(),
  pruneWorktrees: jest.fn(),
  removeWorktree: jest.fn(),
  renameBranch: jest.fn(),
  validateBranchName: jest.fn(),
  checkoutBranch: jest.fn(),
  createBranchAndCheckout: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getChatTabsFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/chats/${worktreeId}.json`,
  ),
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
  getWorktreeDataRootDir: jest.fn(
    (projectId: string) => `/mock/workspaces/${projectId}/worktree-data`,
  ),
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorktreeSummaryFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/summaries/${worktreeId}.json`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (projectId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (projectId: string) => `/mock/workspaces/${projectId}/worktrees`,
  ),
  getArchivedContainersRootDir: jest.fn(
    (projectId: string) => `/mock/workspaces/${projectId}/archived-containers`,
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/workspace-service', () => ({
  listWorkspaceItems: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/code-graph-scheduler', () => ({
  deferCodeGraphRefreshUntilPostCreateSetup: jest.fn(),
  nudgeCodeGraphRefreshAfterDiffStats: jest.fn(),
}));
// `getWorkspaceById` reads the index entry directly (shadow-free); derive it
// from the same `listWorkspaceItems` fixture this suite already sets. The
// rest of sidebar-items stays real.
jest.mock('../lib/sidebar-items', () => ({
  ...jest.requireActual<typeof SidebarItemsModule>('../lib/sidebar-items'),
  readWorkspaceIndexEntry: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(() =>
    Promise.resolve({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    }),
  ),
  resolveEffectiveBaseBranchesForWorktree: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/worktree-health', () => ({
  validateWorktreeHealth: jest.fn(() => Promise.resolve(null)),
  retryWorktreeHealthCheck: jest.fn(() =>
    Promise.resolve({
      healthy: true,
      worktree: {
        id: 'test-animal',
        branchName: 'main',
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    }),
  ),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn((value: string, label: string) => {
    if (!value.startsWith('/')) {
      throw new Error(`Invalid ${label}: must be an absolute path`);
    }
  }),
  validateId: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(() =>
    Promise.resolve('2026-04-22T00:00:00.000Z'),
  ),
  isWorkspaceWorktreeCurrent: jest.fn(() => Promise.resolve(true)),
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
  updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
  updateWorkspaceWorktrees: jest.fn(),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(),
}));
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-events', () => ({
  createProjectScriptDescriptor: jest.fn(
    (scriptName: string, command: string) => ({
      scriptKey: `project:${scriptName}`,
      scriptName,
      label: scriptName,
      command,
      lifecycle: 'custom',
      target: 'project',
    }),
  ),
  createScriptCompleteEvent: jest.fn(() => ({ type: 'complete' })),
  createScriptOutputEvent: jest.fn(() => ({ type: 'output' })),
  createScriptStartedEvent: jest.fn(() => ({ type: 'started' })),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn(() => Promise.resolve()),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      deleteBranchOnArchive: false,
      scriptTimeoutMinutes: 5,
    }),
  ),
}));
jest.mock('../lib/github-poller', () => ({
  stopTracking: jest.fn(),
  getForegroundWorktreeKey: jest.fn(() => null),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../pipelines/worktree-cleanup', () => ({
  cleanupWorktreePipelines: jest.fn(() => Promise.resolve({ warnings: [] })),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/mock/executions',
    tempRootDir: '/mock/executions',
    bundledActionsDir: '/mock/actions',
    getProjectActionsDir: (repoPath: string): string => repoPath,
  })),
}));
jest.mock('../lib/worktree-summary-scheduler', () => ({
  cancelScheduledGeneration: jest.fn(),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/script-log-store', () => ({
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: jest.fn(() => Promise.resolve()),
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
  startScriptRunLog: jest.fn(
    ({
      projectId,
      worktreeId,
      script,
    }: {
      projectId: string;
      worktreeId: string;
      script: { scriptKey: string };
    }) =>
      Promise.resolve({
        projectId,
        worktreeId,
        script,
        runId: 'run-1',
      }),
  ),
}));
jest.mock('../lib/script-resolver', () => ({
  getResolvedScriptDefinition: jest.fn((_scripts, scriptName: string) =>
    scriptName === 'setup' ? { command: 'npm run setup' } : undefined,
  ),
  getResolvedScriptCommand: jest.fn((_scripts, scriptName: string) =>
    scriptName === 'setup' ? 'npm run setup' : undefined,
  ),
  resolveProjectScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(
    (resolved: Record<string, { value?: string; source: string }>) => {
      const overrides: Record<string, string | null> = {};
      for (const [scriptName, field] of Object.entries(resolved)) {
        if (typeof field.value === 'string') {
          overrides[scriptName] = field.value;
        }
      }

      return Object.keys(overrides).length > 0 ? overrides : undefined;
    },
  ),
}));
jest.mock('../lib/hook-resolver', () => ({
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(
    (resolved: Record<string, { actions?: unknown[]; source: string }>) => {
      const overrides: Record<string, unknown[] | null> = {};
      for (const [triggerName, field] of Object.entries(resolved)) {
        if (Array.isArray(field.actions)) {
          overrides[triggerName] = field.actions;
        }
      }

      return Object.keys(overrides).length > 0 ? overrides : undefined;
    },
  ),
}));

import { lstat, mkdir, readFile } from 'node:fs/promises';
import type * as SidebarItemsModule from '../lib/sidebar-items';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  createWorktree,
  createWorktreeFromStartPoint,
  fetchOrigin,
  getCanopyJsonHash,
  getCurrentBranch,
  getCurrentBranchDisplayName,
  getDiffStats,
  getRemoteUrl,
  hasCommitsAhead,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpulledCommits,
  hasUnpushedCommits,
  hasBranchBeenPushedToRemote,
  isBranchNameAvailable,
} from '../lib/git';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  startScriptRunLog,
} from '../lib/script-log-store';
import { resolveProjectHooks } from '../lib/hook-resolver';
import { resolveProjectScripts } from '../lib/script-resolver';
import { runShellScript } from '../lib/script-runner';
import { sendToWindow } from '../lib/window-send';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { listWorkspaceItems } from '../lib/workspace-service';
import { resolveEffectiveBaseBranchesForWorktree } from '../lib/worktree-base-branches';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { registerIpcHandler } from '../ipc/register';
import { registerWorktreeHandlers } from '../ipc/worktrees';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedCreateWorktreeFromStartPoint = jest.mocked(
  createWorktreeFromStartPoint,
);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetCanopyJsonHash = jest.mocked(getCanopyJsonHash);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetCurrentBranchDisplayName = jest.mocked(
  getCurrentBranchDisplayName,
);
const mockedGetDiffStats = jest.mocked(getDiffStats);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedHasCommitsAhead = jest.mocked(hasCommitsAhead);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedHasUnpulledCommits = jest.mocked(hasUnpulledCommits);
const mockedHasBranchBeenPushedToRemote = jest.mocked(
  hasBranchBeenPushedToRemote,
);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedListWorkspaceItems = jest.mocked(listWorkspaceItems);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedAppendScriptRunLogLines = jest.mocked(appendScriptRunLogLines);
const mockedCompleteScriptRunLog = jest.mocked(completeScriptRunLog);
const mockedStartScriptRunLog = jest.mocked(startScriptRunLog);
const mockedResolveProjectHooks = jest.mocked(resolveProjectHooks);
const mockedResolveProjectScripts = jest.mocked(resolveProjectScripts);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedResolveEffectiveBaseBranchesForWorktree = jest.mocked(
  resolveEffectiveBaseBranchesForWorktree,
);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

let createHandler: HandlerFn;
let diffStatsBatchHandler: HandlerFn;
let persistedWorktrees: WorktreeData[] = [];

class MissingFileError extends Error {
  readonly code = 'ENOENT';

  constructor(filePath: string) {
    super(`ENOENT: no such file or directory, open '${filePath}'`);
    this.name = 'Error';
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await flush();
  }
  throw new Error('Timed out waiting for condition');
}

function expectStringCreatedAt(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Expected response with string createdAt');
  }
}

function hasKey<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}

function expectDefaultTestAnimalBranchName(value: unknown): void {
  if (!hasKey(value, 'branchName')) {
    throw new Error('Expected response with branchName');
  }
  expect(value.branchName).toEqual(expect.stringMatching(/^test-animal-\d+$/));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(lstat)
    .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  persistedWorktrees = [];
  mockedMkdir.mockResolvedValue(undefined);
  mockedReadFile.mockImplementation((filePath) => {
    if (typeof filePath !== 'string') {
      return Promise.reject(new Error('Expected string file path'));
    }

    const normalizedPath = filePath;
    if (
      normalizedPath ===
      '/mock/workspaces/project-1/worktrees/test-animal/canopy.json'
    ) {
      return Promise.resolve(JSON.stringify({ version: 1 }));
    }

    return Promise.reject(new MissingFileError(normalizedPath));
  });
  mockedCreateWorktree.mockResolvedValue('test-animal');
  mockedCreateWorktreeFromStartPoint.mockResolvedValue('test-animal');
  mockedReadWorkspaceConfig.mockResolvedValue({
    version: 1,
    type: 'single-repo',
    repoPath: '/repos/tracked-worktree',
    repos: [],
    scripts: {
      launch: 'npm run dev',
    },
    alwaysShow: true,
  });
  mockedResolveProjectReferenceRepoPath.mockResolvedValue('/repos/source');
  mockedReadWorkspaceIndexEntry.mockImplementation(async (workspaceId) => {
    const items = (await mockedListWorkspaceItems()) ?? [];
    const item = items.find((candidate) => candidate.id === workspaceId);
    if (!item) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      collapsed: item.collapsed ?? false,
      order: item.order ?? 0,
    };
  });
  mockedReadWorkspaceWorktrees.mockImplementation(() =>
    Promise.resolve(persistedWorktrees),
  );
  mockedUpdateWorkspaceWorktree.mockResolvedValue(true);
  mockedUpdateWorkspaceWorktrees.mockImplementation(
    async (
      _workspaceId,
      updater: (
        worktrees: WorktreeData[],
      ) => WorktreeData[] | Promise<WorktreeData[]>,
    ) => {
      persistedWorktrees = await Promise.resolve(updater(persistedWorktrees));
      return persistedWorktrees;
    },
  );
  mockedRunShellScript.mockImplementation((options) => {
    options.onChunk?.(['setup line']);
    return Promise.resolve({
      success: true,
      exitCode: 0,
      output: 'setup line',
      timedOut: false,
      durationMs: 40,
    });
  });
  mockedResolveProjectHooks.mockResolvedValue({});
  mockedResolveProjectScripts.mockResolvedValue({});
  mockedSendToWindow.mockReturnValue(true);
  mockedGetCanopyJsonHash.mockResolvedValue(null);
  mockedGetCurrentBranch.mockResolvedValue('main');
  mockedGetCurrentBranchDisplayName.mockResolvedValue('main');
  mockedGetDiffStats.mockResolvedValue({ insertions: 0, deletions: 0 });
  mockedHasCommitsAhead.mockResolvedValue(false);
  mockedHasRemoteTrackingBranch.mockResolvedValue(false);
  mockedHasUncommittedChanges.mockResolvedValue(false);
  mockedHasUnpushedCommits.mockResolvedValue(false);
  mockedHasBranchBeenPushedToRemote.mockResolvedValue(false);
  mockedIsBranchNameAvailable.mockResolvedValue(true);
  mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({});
  mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
  mockedIsMultiRepoWorkspace.mockReturnValue(false);
  mockedListWorkspaceItems.mockResolvedValue([
    {
      type: 'single-repo',
      id: 'project-1',
      name: 'Project One',
      repoPath: '/repos/project-1',
      color: '#abcdef',
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-22T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
    },
  ]);

  registerWorktreeHandlers(() => null);

  const createCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:create',
  );
  if (!createCall) {
    throw new Error('worktree:create handler was not registered');
  }

  const handler = createCall[1];
  if (typeof handler !== 'function') {
    throw new Error('worktree:create handler is not callable');
  }

  createHandler = (event: unknown, request: unknown): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [event, request]));

  const diffStatsBatchCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:diff-stats-batch',
  );
  if (!diffStatsBatchCall) {
    throw new Error('worktree:diff-stats-batch handler was not registered');
  }

  const diffStatsBatch = diffStatsBatchCall[1];
  if (typeof diffStatsBatch !== 'function') {
    throw new Error('worktree:get-diff-stats-batch handler is not callable');
  }

  diffStatsBatchHandler = (
    event: unknown,
    request: unknown,
  ): Promise<unknown> =>
    Promise.resolve(Reflect.apply(diffStatsBatch, undefined, [event, request]));
});

describe('worktree:create script log persistence', () => {
  it('creates the worktree from the canonical single-repo reference path', async () => {
    const result = await createHandler(
      {},
      {
        projectId: 'project-1',
        repoPath: '/repos/tracked-worktree',
        existingWorktreeIds: [],
      },
    );
    expectStringCreatedAt(result);
    expectDefaultTestAnimalBranchName(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedBaseBranch: undefined,
      effectiveScripts: undefined,
      effectiveHooks: undefined,
      setupPhase: 'git-pending',
    });
    await flush();
    await flush();

    expect(mockedResolveProjectReferenceRepoPath).toHaveBeenCalledWith(
      '/repos/tracked-worktree',
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/mock/workspaces/project-1/worktrees/test-animal',
      expect.stringMatching(/^test-animal-\d+$/),
      { backgroundPriority: true },
    );
  });

  it('creates from the selected base worktree branch and returns tracked metadata', async () => {
    mockedGetCurrentBranch.mockResolvedValueOnce('release/1.2');

    const result = await createHandler(
      {},
      {
        projectId: 'project-1',
        repoPath: '/repos/tracked-worktree',
        existingWorktreeIds: [],
        baseWorktreeId: 'base-wt',
      },
    );
    expectStringCreatedAt(result);
    expectDefaultTestAnimalBranchName(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedBaseBranch: 'release/1.2',
      effectiveScripts: undefined,
      effectiveHooks: undefined,
      setupPhase: 'git-pending',
    });
    await flush();
    await flush();

    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/source',
      '/mock/workspaces/project-1/worktrees/test-animal',
      expect.stringMatching(/^test-animal-\d+$/),
      'release/1.2',
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects a relative configured repo path before resolving the reference repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: 'relative/repo',
      repos: [],
      scripts: {},
      alwaysShow: true,
    });

    await expect(
      createHandler(
        {},
        {
          projectId: 'project-1',
          repoPath: '/repos/tracked-worktree',
          existingWorktreeIds: [],
        },
      ),
    ).rejects.toThrow('Invalid repoPath: must be an absolute path');

    expect(mockedResolveProjectReferenceRepoPath).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('persists automatic setup output even when no window is attached', async () => {
    await createHandler(
      {},
      {
        projectId: 'project-1',
        repoPath: '/repos/project-1',
        existingWorktreeIds: [],
      },
    );
    await waitFor(() => mockedStartScriptRunLog.mock.calls.length > 0);

    expect(mockedStartScriptRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'test-animal',
        invocation: 'automatic-setup',
      }),
    );
    expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: ['setup line'],
      }),
    );
    expect(mockedCompleteScriptRunLog).toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('keeps worktree creation successful when effective hydration fails', async () => {
    mockedResolveProjectScripts.mockRejectedValueOnce(
      new Error('invalid canopy.json'),
    );
    mockedResolveProjectHooks.mockRejectedValueOnce(new Error('invalid hooks'));

    const result = await createHandler(
      {},
      {
        projectId: 'project-1',
        repoPath: '/repos/project-1',
        existingWorktreeIds: [],
      },
    );
    expectStringCreatedAt(result);
    expectDefaultTestAnimalBranchName(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedBaseBranch: undefined,
      effectiveScripts: undefined,
      effectiveHooks: undefined,
      setupPhase: 'git-pending',
    });
    await flush();
    await flush();
  });
});

describe('worktree:get-diff-stats-batch', () => {
  it('omits top-level multi-repo base metadata when repos use different bases', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedListWorkspaceItems.mockResolvedValue([
      {
        type: 'multi-repo',
        id: 'project-1',
        name: 'Workspace One',
        color: '#abcdef',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/source/repo-a',
          },
          {
            id: 'repo-b',
            name: 'Repo B',
            repoPath: '/source/repo-b',
          },
        ],
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature/wt-1',
            createdAt: '2026-04-22T00:00:00.000Z',
          },
        ],
        collapsed: false,
        order: 0,
      },
    ]);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/mock/workspaces/project-1/worktrees/wt-1/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath: '/mock/workspaces/project-1/worktrees/wt-1/repos/repo-b',
      },
    ]);
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({
      'repo-a': {
        branch: 'develop',
        existsLocally: true,
        existsInRemote: true,
      },
      'repo-b': {
        branch: 'release/1.2',
        existsLocally: true,
        existsInRemote: false,
      },
    });
    mockedGetDiffStats
      .mockResolvedValueOnce({ insertions: 3, deletions: 1 })
      .mockResolvedValueOnce({ insertions: 5, deletions: 2 });
    mockedGetRemoteUrl.mockResolvedValue(
      'git@github.com:unstoppabledomains/canopy.git',
    );
    mockedGetCurrentBranchDisplayName
      .mockResolvedValueOnce('feature/a')
      .mockResolvedValueOnce('feature/b');
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(true);
    mockedHasUnpulledCommits.mockResolvedValue(false);
    mockedHasBranchBeenPushedToRemote.mockResolvedValue(true);

    await expect(
      diffStatsBatchHandler(
        {},
        {
          worktrees: [{ projectId: 'project-1', worktreeId: 'wt-1' }],
        },
      ),
    ).resolves.toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        insertions: 8,
        deletions: 3,
        baseBranch: null,
        baseBranchExistsLocally: false,
        hasOriginRemote: true,
        hasCommitsAhead: true,
        hasUncommittedChanges: true,
        hasRemoteTrackingBranch: true,
        hasUnpushedCommits: true,
        hasUnpulledCommits: false,
        hasBranchBeenPushed: true,
        baseBranchExistsInRemote: false,
        canopyJsonHash: undefined,
        repoBranches: [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'feature/a',
            baseBranch: 'develop',
            baseBranchExistsLocally: true,
            hasOriginRemote: true,
            insertions: 3,
            deletions: 1,
            commitsAhead: true,
            hasUncommittedChanges: true,
            hasRemoteTrackingBranch: true,
            hasUnpushedCommits: true,
            hasUnpulledCommits: false,
            hasBranchBeenPushed: true,
            baseBranchExistsInRemote: true,
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            branch: 'feature/b',
            baseBranch: 'release/1.2',
            baseBranchExistsLocally: true,
            hasOriginRemote: true,
            insertions: 5,
            deletions: 2,
            commitsAhead: true,
            hasUncommittedChanges: true,
            hasRemoteTrackingBranch: true,
            hasUnpushedCommits: true,
            hasUnpulledCommits: false,
            hasBranchBeenPushed: true,
            baseBranchExistsInRemote: false,
          },
        ],
      },
    ]);
    expect(mockedFetchOrigin).toHaveBeenCalledTimes(2);
    // Automatic diff-stats fetches prune stale refs and pass a TTL so a fleet
    // of worktrees sharing one repo cannot re-fetch the remote every poll cycle.
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1/repos/repo-a',
      { prune: true, ttlMs: 5 * 60_000 },
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1/repos/repo-b',
      { prune: true, ttlMs: 5 * 60_000 },
    );
  });
});
