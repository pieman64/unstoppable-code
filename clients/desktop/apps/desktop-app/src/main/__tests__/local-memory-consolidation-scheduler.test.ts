const mockSessions: Array<{
  chatId: string;
  projectId: string;
  worktreeId: string;
  providerType: 'claude';
  turnActive: boolean;
  createdAt: number;
  lastActivityAt: number;
  turnCount: number;
  pendingMessageCount: number;
}> = [];
let mockActivityListener: (() => void) | null = null;
const mockIsE2eBuild = jest.fn<boolean, []>(() => false);
const mockReadPreferencesFile = jest.fn(() =>
  Promise.resolve({
    localMemoryEnabled: true,
    localMemoryModel: 'claude-haiku-4-5-20251001',
    localMemoryThinkingLevel: 'off',
    providerModelConfigDefaults: undefined,
  }),
);
const mockCollectConsolidationInput = jest.fn(() =>
  Promise.resolve({
    memoryMd: '# Index',
    topicFiles: [],
    importFiles: [],
    inboxFiles: [
      {
        fileKey: 'inbox/note.md',
        filename: 'note.md',
        content: 'remember this',
        usage: {
          usageCount: 0,
          lastUsedAt: null,
          createdAt: '2026-08-05T10:00:00.000Z',
        },
      },
    ],
    inputHash: 'a'.repeat(64),
    indexWithinLimits: true,
    usageTrackingSince: null,
  }),
);
const mockRunLocalMemoryConsolidation = jest.fn(() =>
  Promise.resolve({ status: 'success' as const, inputHash: 'a'.repeat(64) }),
);
const mockReadConsolidationState = jest.fn(() => Promise.resolve(null));
const mockWriteConsolidationState = jest.fn(() => Promise.resolve());
const mockBroadcastLocalMemoryChanged = jest.fn();
const mockEnqueueBackgroundHelperTask = jest.fn(
  async (options: { task: () => Promise<void> }): Promise<void> =>
    options.task(),
);
const mockIsLocalMemoryModelBlockedByPolicy = jest.fn<
  Promise<boolean>,
  [string, string | undefined]
>(() => Promise.resolve(false));
const mockResolveMemoryWorkspaceId = jest.fn(
  (options: {
    projectId: string;
    worktreeId: string;
  }): Promise<string | null> => Promise.resolve(options.projectId),
);

jest.mock('../agents/session-manager', () => ({
  getAllActiveSessionInfos: (): typeof mockSessions => [...mockSessions],
  subscribeChatSessionActivity: (listener: () => void): (() => void) => {
    mockActivityListener = listener;
    return (): void => {
      mockActivityListener = null;
    };
  },
}));

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): ReturnType<typeof mockReadPreferencesFile> =>
    mockReadPreferencesFile(),
}));
jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => '/memory/user',
  getWorkspaceMemoryDir: (workspaceId: string): string =>
    `/memory/workspaces/${workspaceId}`,
}));

jest.mock('../lib/background-helper-queue', () => ({
  BACKGROUND_HELPER_PRIORITIES: { memoryConsolidation: 3 },
  enqueueBackgroundHelperTask: (options: {
    priority: number;
    task: () => Promise<void>;
  }): Promise<void> => mockEnqueueBackgroundHelperTask(options),
}));

jest.mock('../memory/local/consolidation-task', () => ({
  collectConsolidationInput: (
    scopeDir: string,
  ): ReturnType<typeof mockCollectConsolidationInput> =>
    mockCollectConsolidationInput(scopeDir),
  runLocalMemoryConsolidation: (
    options: unknown,
  ): ReturnType<typeof mockRunLocalMemoryConsolidation> =>
    mockRunLocalMemoryConsolidation(options),
}));

jest.mock('../memory/local/model-policy', () => ({
  isLocalMemoryModelBlockedByPolicy: (
    model: string,
    workspaceId?: string,
  ): ReturnType<typeof mockIsLocalMemoryModelBlockedByPolicy> =>
    mockIsLocalMemoryModelBlockedByPolicy(model, workspaceId),
}));

jest.mock('../memory/local/workspace-scope', () => ({
  resolveMemoryWorkspaceId: (options: {
    projectId: string;
    worktreeId: string;
  }): Promise<string | null> => mockResolveMemoryWorkspaceId(options),
}));

jest.mock('../memory/local/consolidation-state', () => ({
  readConsolidationState: (
    scopeDir: string,
  ): ReturnType<typeof mockReadConsolidationState> =>
    mockReadConsolidationState(scopeDir),
  // The scheduler persists every finished run through recordConsolidationRun;
  // the existing write assertions observe those calls.
  recordConsolidationRun: (
    scopeDir: string,
    outcome: unknown,
  ): ReturnType<typeof mockWriteConsolidationState> =>
    mockWriteConsolidationState(scopeDir, outcome),
  consolidationRunOutcome: (result: {
    status: string;
    inputHash?: string;
    reason?: string;
  }): unknown =>
    result.status === 'success'
      ? { result: 'success', inputHash: result.inputHash }
      : {
          result: result.status === 'clean' ? 'skipped' : 'failed',
          reason: result.reason ?? result.status,
        },
}));

jest.mock('../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: (...args: unknown[]): unknown =>
    mockBroadcastLocalMemoryChanged(...args),
}));

import { initClaudeModels } from '@canopy/desktop-shared/types';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/desktop-shared/types/local-memory';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
  isLocalMemoryConsolidationRunning,
  localMemoryConsolidationRunTrackerTestExports,
} from '../memory/local/consolidation-run-tracker';
import {
  LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS,
  localMemoryConsolidationSchedulerTestExports,
  requestLocalMemoryConsolidation,
  startLocalMemoryConsolidationScheduler,
  stopLocalMemoryConsolidationScheduler,
} from '../memory/local/consolidation-scheduler';

initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
]);

function activeSession(turnActive: boolean): (typeof mockSessions)[number] {
  return {
    chatId: 'chat-1',
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    providerType: 'claude',
    turnActive,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    turnCount: 1,
    pendingMessageCount: 0,
  };
}

function sentinelSession(turnActive: boolean): (typeof mockSessions)[number] {
  return {
    chatId: 'chat-2',
    projectId: 'plan-explore-chat',
    worktreeId: 'plan-1',
    providerType: 'claude',
    turnActive,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    turnCount: 1,
    pendingMessageCount: 0,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await jest.advanceTimersByTimeAsync(0);
  }
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function emitTurnIdle(): Promise<void> {
  mockSessions.splice(0, mockSessions.length, activeSession(false));
  mockActivityListener?.();
  await settle();
}

describe('local memory consolidation scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    jest.clearAllMocks();
    localMemoryConsolidationSchedulerTestExports.reset();
    localMemoryConsolidationRunTrackerTestExports.reset();
    mockSessions.splice(0, mockSessions.length, activeSession(true));
    mockIsE2eBuild.mockReturnValue(false);
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });
    mockCollectConsolidationInput.mockResolvedValue({
      memoryMd: '# Index',
      topicFiles: [],
      importFiles: [],
      inboxFiles: [
        {
          fileKey: 'inbox/note.md',
          filename: 'note.md',
          content: 'remember this',
          usage: {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-08-05T10:00:00.000Z',
          },
        },
      ],
      inputHash: 'a'.repeat(64),
      indexWithinLimits: true,
      usageTrackingSince: null,
    });
    mockRunLocalMemoryConsolidation.mockResolvedValue({
      status: 'success',
      inputHash: 'a'.repeat(64),
    });
    mockReadConsolidationState.mockResolvedValue(null);
    mockIsLocalMemoryModelBlockedByPolicy.mockResolvedValue(false);
    mockResolveMemoryWorkspaceId.mockImplementation((options) =>
      Promise.resolve(options.projectId),
    );
  });

  afterEach(() => {
    stopLocalMemoryConsolidationScheduler();
    localMemoryConsolidationSchedulerTestExports.reset();
    jest.useRealTimers();
  });

  it('debounces an active-to-idle transition and stamps both dirty scopes', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: { claude: { thinkingLevel: 'low' } },
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();

    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS - 1,
    );
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/user',
        thinkingLevel: 'off',
        modelConfig: {
          thinkingLevel: 'off',
          speed: 'standard',
          fastMode: false,
        },
      }),
    );
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/workspaces/workspace-1',
        workspaceId: 'workspace-1',
      }),
    );
    expect(mockWriteConsolidationState).toHaveBeenCalledTimes(2);
  });

  it('records every finished run and broadcasts when it starts and ends', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockRunLocalMemoryConsolidation.mockResolvedValueOnce({
      status: 'failed',
      inputHash: 'a'.repeat(64),
      reason: 'provider unavailable',
    });
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      {
        scopeDir: '/memory/workspaces/workspace-1',
        workspaceId: 'workspace-1',
      },
    );
    await settle();

    expect(mockWriteConsolidationState).toHaveBeenCalledWith(
      '/memory/workspaces/workspace-1',
      { result: 'failed', reason: 'provider unavailable' },
    );
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledTimes(2);
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'workspace-1',
    });
    expect(
      isLocalMemoryConsolidationRunning('/memory/workspaces/workspace-1'),
    ).toBe(false);
  });

  it('skips with a visible reason and never runs another model when the chosen model is unavailable', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'ollama-offline-model',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();

    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(mockWriteConsolidationState).toHaveBeenCalledTimes(1);
    expect(mockWriteConsolidationState).toHaveBeenCalledWith('/memory/user', {
      result: 'skipped',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'user',
    });
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
  });

  it('skips with the policy reason and runs nothing when the organization blocks the memory model', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockIsLocalMemoryModelBlockedByPolicy.mockResolvedValue(true);
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      {
        scopeDir: '/memory/workspaces/workspace-1',
        workspaceId: 'workspace-1',
      },
    );
    await settle();

    expect(mockIsLocalMemoryModelBlockedByPolicy).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
      'workspace-1',
    );
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(mockWriteConsolidationState).toHaveBeenCalledTimes(1);
    expect(mockWriteConsolidationState).toHaveBeenCalledWith(
      '/memory/workspaces/workspace-1',
      { result: 'skipped', reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE },
    );
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'workspace-1',
    });
    expect(
      isLocalMemoryConsolidationRunning('/memory/workspaces/workspace-1'),
    ).toBe(false);
  });

  it.each(['rebuild', 'restore'] as const)(
    'records no model refusal while a %s owns the scope',
    async (kind) => {
      mockSessions.splice(0, mockSessions.length);
      mockIsLocalMemoryModelBlockedByPolicy.mockResolvedValue(true);
      expect(beginLocalMemoryConsolidationRun('/memory/user', kind)).toBe(true);
      try {
        startLocalMemoryConsolidationScheduler();
        await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
          { scopeDir: '/memory/user' },
        );
        await settle();

        expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
        expect(mockWriteConsolidationState).not.toHaveBeenCalled();
        expect(mockBroadcastLocalMemoryChanged).not.toHaveBeenCalled();
        expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(true);
      } finally {
        endLocalMemoryConsolidationRun('/memory/user');
      }
    },
  );

  describe('when preferences change while the run waits in the queue', () => {
    async function queueUserScope(): Promise<() => Promise<void>> {
      let queued: (() => Promise<void>) | undefined;
      mockEnqueueBackgroundHelperTask.mockImplementationOnce((options) => {
        queued = options.task;
        return Promise.resolve();
      });
      mockSessions.splice(0, mockSessions.length);
      startLocalMemoryConsolidationScheduler();
      await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
        { scopeDir: '/memory/user' },
      );
      if (!queued) throw new Error('Expected a queued run');
      return queued;
    }

    it('runs with the model chosen meanwhile', async () => {
      const queued = await queueUserScope();
      mockReadPreferencesFile.mockResolvedValue({
        localMemoryEnabled: true,
        localMemoryModel: 'claude-sonnet-4-6',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      });

      await queued();

      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      );
    });

    it('skips without running another model when the new choice cannot run', async () => {
      const queued = await queueUserScope();
      mockReadPreferencesFile.mockResolvedValue({
        localMemoryEnabled: true,
        localMemoryModel: 'ollama-offline-model',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      });

      await queued();

      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(mockWriteConsolidationState).toHaveBeenCalledWith('/memory/user', {
        result: 'skipped',
        reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      });
    });
  });

  it('records a scheduler failure so the explorer can show it', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockCollectConsolidationInput.mockRejectedValueOnce(
      new Error('inbox unreadable'),
    );
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();

    expect(mockWriteConsolidationState).toHaveBeenCalledWith('/memory/user', {
      result: 'failed',
      reason: 'inbox unreadable',
    });
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'user',
    });
  });

  it('leaves a scope alone while a manual run already owns it', async () => {
    mockSessions.splice(0, mockSessions.length);
    expect(beginLocalMemoryConsolidationRun('/memory/user')).toBe(true);
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();

    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(mockWriteConsolidationState).not.toHaveBeenCalled();
    expect(mockBroadcastLocalMemoryChanged).not.toHaveBeenCalled();
    endLocalMemoryConsolidationRun('/memory/user');
  });

  it('does not stamp the hourly throttle when a manual run holds the guard', async () => {
    mockSessions.splice(0, mockSessions.length);
    expect(beginLocalMemoryConsolidationRun('/memory/user')).toBe(true);
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();

    // The manual run finishes; the next attempt must proceed right away,
    // not wait out the hourly cap a skipped attempt would have stamped.
    endLocalMemoryConsolidationRun('/memory/user');
    await jest.advanceTimersByTimeAsync(1_000);
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(mockWriteConsolidationState).toHaveBeenCalledWith('/memory/user', {
      result: 'success',
      inputHash: 'a'.repeat(64),
    });

    // Once a run has started, the in-memory stamp throttles the scope.
    await jest.advanceTimersByTimeAsync(1_000);
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: '/memory/user' },
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
  });

  it('arms requested user and project scopes through the existing scheduler debounce', async () => {
    mockSessions.splice(0, mockSessions.length);
    startLocalMemoryConsolidationScheduler();

    await requestLocalMemoryConsolidation({});
    await requestLocalMemoryConsolidation({ workspaceId: 'workspace-1' });
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDir: '/memory/user' }),
    );
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/workspaces/workspace-1',
        workspaceId: 'workspace-1',
      }),
    );
  });

  it('does not arm a requested scope before the scheduler starts', async () => {
    mockSessions.splice(0, mockSessions.length);

    await requestLocalMemoryConsolidation({ workspaceId: 'workspace-1' });
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('cancels the debounce when a new turn starts and restarts it on idle', async () => {
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS - 60_000,
    );

    mockSessions.splice(0, mockSessions.length, activeSession(true));
    mockActivityListener?.();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();

    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
  });

  it('skips a clean scope without enqueuing a helper', async () => {
    mockCollectConsolidationInput.mockResolvedValue({
      memoryMd: '# Within limits',
      topicFiles: [],
      importFiles: [],
      inboxFiles: [],
      inputHash: 'b'.repeat(64),
      indexWithinLimits: true,
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('uses the freshness hash to avoid rerunning after restart', async () => {
    mockReadConsolidationState.mockResolvedValue({
      version: 1,
      lastConsolidatedAt: '2026-08-05T10:00:00.000Z',
      lastInputHash: 'a'.repeat(64),
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
  });

  it('does not skip a scope with staged imports and no inbox notes', async () => {
    mockCollectConsolidationInput.mockResolvedValue({
      memoryMd: '# Within limits',
      topicFiles: [],
      inboxFiles: [],
      importFiles: [
        {
          fileKey: 'imported/claude-memory.md',
          filename: 'claude-memory.md',
          content: 'imported fact',
          modifiedAt: '2026-08-05T10:00:00.000Z',
          usage: {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-08-05T10:00:00.000Z',
          },
        },
      ],
      inputHash: 'b'.repeat(64),
      indexWithinLimits: true,
      usageTrackingSince: null,
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
  });

  it('enforces the hourly cap even when the input changed', async () => {
    mockReadConsolidationState.mockResolvedValue({
      version: 1,
      lastConsolidatedAt: '2026-08-05T11:30:00.000Z',
      lastInputHash: 'c'.repeat(64),
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
  });

  it('retries after the hourly cap when a successful run omitted staged imports', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockCollectConsolidationInput.mockResolvedValue({
      memoryMd: '# Index',
      topicFiles: [],
      importFiles: [],
      omittedImportFiles: { fileCount: 1, totalBytes: 2048 },
      inboxFiles: [
        {
          fileKey: 'inbox/note.md',
          filename: 'note.md',
          content: 'remember this',
          usage: {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-08-05T10:00:00.000Z',
          },
        },
      ],
      inputHash: 'a'.repeat(64),
      indexWithinLimits: true,
      usageTrackingSince: null,
    });
    startLocalMemoryConsolidationScheduler();

    await requestLocalMemoryConsolidation({});
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS - 1,
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
  });

  it.each([
    'Partial consolidation: topicFiles[1].filename: invalid filename',
    'Partial consolidation: topicFiles[0].filename: case-insensitive filename collision; topicFiles[1].filename: case-insensitive filename collision',
  ])(
    'retries partial output after the hourly cap without recording a successful hash: %s',
    async (reason) => {
      mockSessions.splice(0, mockSessions.length);
      mockRunLocalMemoryConsolidation.mockResolvedValue({
        status: 'partial',
        inputHash: 'a'.repeat(64),
        reason,
      });
      startLocalMemoryConsolidationScheduler();
      await requestLocalMemoryConsolidation({});
      await jest.advanceTimersByTimeAsync(
        LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS,
      );
      await settle();
      expect(mockWriteConsolidationState).toHaveBeenCalledWith('/memory/user', {
        result: 'failed',
        reason,
      });
      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(
        LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS - 1,
      );
      await settle();
      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    },
  );

  it('retains the remaining partial retry delay across intervening chat activity', async () => {
    mockRunLocalMemoryConsolidation.mockResolvedValue({
      status: 'partial',
      inputHash: 'a'.repeat(64),
      reason: 'Partial consolidation',
    });
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    mockSessions.splice(0, mockSessions.length, activeSession(true));
    mockActivityListener?.();
    await settle();
    await emitTurnIdle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS -
        LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS,
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(4);
  });

  it('does not retry a successful run when no staged imports were omitted', async () => {
    mockSessions.splice(0, mockSessions.length);
    startLocalMemoryConsolidationScheduler();

    await requestLocalMemoryConsolidation({});
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS,
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
  });

  it('cancels an omitted-import follow-up when the scheduler stops', async () => {
    mockSessions.splice(0, mockSessions.length);
    mockCollectConsolidationInput.mockResolvedValue({
      memoryMd: '# Index',
      topicFiles: [],
      importFiles: [],
      omittedImportFiles: { fileCount: 1, totalBytes: 2048 },
      inboxFiles: [
        {
          fileKey: 'inbox/note.md',
          filename: 'note.md',
          content: 'remember this',
          usage: {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-08-05T10:00:00.000Z',
          },
        },
      ],
      inputHash: 'a'.repeat(64),
      indexWithinLimits: true,
      usageTrackingSince: null,
    });
    startLocalMemoryConsolidationScheduler();

    await requestLocalMemoryConsolidation({});
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);

    stopLocalMemoryConsolidationScheduler();
    await jest.advanceTimersByTimeAsync(
      LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS,
    );
    await settle();
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
  });

  it('applies the hourly cap after a hard preflight failure', async () => {
    mockSessions.splice(0, mockSessions.length);
    const readError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    mockReadConsolidationState.mockRejectedValue(readError);
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    startLocalMemoryConsolidationScheduler();

    try {
      await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
        { scopeDir: '/memory/user' },
      );
      await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
        { scopeDir: '/memory/user' },
      );

      expect(mockReadConsolidationState).toHaveBeenCalledTimes(1);
      expect(emitWarningSpy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(
        LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS,
      );
      await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
        { scopeDir: '/memory/user' },
      );
      expect(mockReadConsolidationState).toHaveBeenCalledTimes(2);
      expect(emitWarningSpy).toHaveBeenCalledTimes(2);
    } finally {
      emitWarningSpy.mockRestore();
    }
  });

  it('does not subscribe or schedule under the E2E build', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    startLocalMemoryConsolidationScheduler();

    expect(mockActivityListener).toBeNull();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('schedules consolidation for the resolved project of a sentinel session', async () => {
    mockResolveMemoryWorkspaceId.mockImplementation((options) =>
      Promise.resolve(
        options.projectId === 'plan-explore-chat'
          ? 'real-workspace'
          : options.projectId,
      ),
    );
    mockSessions.splice(0, mockSessions.length, sentinelSession(true));
    startLocalMemoryConsolidationScheduler();

    mockSessions.splice(0, mockSessions.length, sentinelSession(false));
    mockActivityListener?.();
    await settle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/workspaces/real-workspace',
        workspaceId: 'real-workspace',
      }),
    );
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/workspaces/plan-explore-chat',
      }),
    );
  });

  it('keeps a project scope debounced while a busy sentinel session resolves to it', async () => {
    mockResolveMemoryWorkspaceId.mockImplementation((options) =>
      Promise.resolve(
        options.projectId === 'plan-explore-chat'
          ? 'workspace-1'
          : options.projectId,
      ),
    );
    mockSessions.splice(
      0,
      mockSessions.length,
      activeSession(true),
      sentinelSession(true),
    );
    startLocalMemoryConsolidationScheduler();

    mockSessions.splice(
      0,
      mockSessions.length,
      activeSession(false),
      sentinelSession(true),
    );
    mockActivityListener?.();
    await settle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('schedules only the user scope when a sentinel session resolves to no project', async () => {
    mockResolveMemoryWorkspaceId.mockImplementation((options) =>
      Promise.resolve(
        options.projectId === 'plan-explore-chat' ? null : options.projectId,
      ),
    );
    mockSessions.splice(0, mockSessions.length, sentinelSession(true));
    startLocalMemoryConsolidationScheduler();

    mockSessions.splice(0, mockSessions.length, sentinelSession(false));
    mockActivityListener?.();
    await settle();
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({ scopeDir: '/memory/user' }),
    );
  });

  it('cancels a stale attempt when the scope is cancelled during preflight', async () => {
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    mockCollectConsolidationInput.mockImplementationOnce(async () => {
      // A new turn starts and ends while this attempt's preflight is reading
      // the store: the cancellation must bump the epoch captured before the
      // attempt's first await and stop the stale attempt.
      mockSessions.splice(0, mockSessions.length, activeSession(true));
      mockActivityListener?.();
      await flushMicrotasks();
      mockSessions.splice(0, mockSessions.length, activeSession(false));
      mockActivityListener?.();
      await flushMicrotasks();
      return {
        memoryMd: '# Index',
        topicFiles: [],
        importFiles: [],
        inboxFiles: [
          {
            fileKey: 'inbox/note.md',
            filename: 'note.md',
            content: 'remember this',
          },
        ],
        inputHash: 'a'.repeat(64),
        indexWithinLimits: true,
      };
    });

    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scopeDir: '/memory/workspaces/workspace-1',
      }),
    );
    expect(mockWriteConsolidationState).not.toHaveBeenCalledWith(
      '/memory/workspaces/workspace-1',
      expect.anything(),
    );
  });

  it('denies the write when the scope is cancelled during the preference read', async () => {
    mockSessions.splice(0, mockSessions.length);
    startLocalMemoryConsolidationScheduler();

    // Preference reads for a direct attempt with an inline-run queue:
    // 1) the attempt's early enablement read, 2) the pre-enqueue
    // schedulerMayWrite read, 3) the queued task's schedulerMayWrite read —
    // the last await before the write would be granted. A turn starts and
    // ends during read 3: the cancellation bumps the scope epoch, and the
    // sessions end idle again so only the stale epoch can deny the write.
    let preferenceReads = 0;
    let emittingActivity = false;
    mockReadPreferencesFile.mockImplementation(async () => {
      preferenceReads += 1;
      if (preferenceReads === 3 && !emittingActivity) {
        emittingActivity = true;
        mockSessions.splice(0, mockSessions.length, activeSession(true));
        mockActivityListener?.();
        await flushMicrotasks();
        mockSessions.splice(0, mockSessions.length, activeSession(false));
        mockActivityListener?.();
        await flushMicrotasks();
        emittingActivity = false;
      }
      return {
        localMemoryEnabled: true,
        localMemoryModel: 'claude-haiku-4-5-20251001',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      };
    });

    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      {
        scopeDir: '/memory/workspaces/workspace-1',
        workspaceId: 'workspace-1',
      },
    );
    await flushMicrotasks();

    expect(preferenceReads).toBeGreaterThanOrEqual(3);
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(mockWriteConsolidationState).not.toHaveBeenCalled();
  });

  it('does not write when the preference is toggled off while queued', async () => {
    startLocalMemoryConsolidationScheduler();
    await emitTurnIdle();
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: false,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });
    await jest.advanceTimersByTimeAsync(LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS);
    await settle();

    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(mockWriteConsolidationState).not.toHaveBeenCalled();
  });
});
