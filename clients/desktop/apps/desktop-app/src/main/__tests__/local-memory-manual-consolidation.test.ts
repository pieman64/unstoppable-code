const mockReadPreferencesFile = jest.fn(() =>
  Promise.resolve({
    localMemoryEnabled: true,
    localMemoryModel: 'claude-sonnet-4-6',
    localMemoryThinkingLevel: 'off',
    providerModelConfigDefaults: undefined,
  }),
);
interface RecordedOutcome {
  result: 'success' | 'skipped' | 'failed' | 'cancelled';
  reason?: string;
  inputHash?: string;
  at?: string;
}

const mockRunLocalMemoryConsolidation = jest.fn<
  Promise<RunConsolidationResult>,
  [options: unknown]
>(() =>
  Promise.resolve({ status: 'success' as const, inputHash: 'a'.repeat(64) }),
);
const mockRecordConsolidationRun = jest.fn<
  Promise<void>,
  [string, RecordedOutcome]
>(() => Promise.resolve());
const mockEnqueueBackgroundHelperTask = jest.fn<
  Promise<unknown>,
  [options: { priority: number; task: () => Promise<unknown> }]
>((options) => options.task());
const mockBroadcast = jest.fn();
const mockWarn = jest.fn();
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined, unknown]
>(() => Promise.resolve(false));
const mockResolveHelperWorkOwner = jest.fn<Promise<undefined>, [unknown]>(() =>
  Promise.resolve(undefined),
);

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    model: string | undefined,
    owner: unknown,
  ): ReturnType<typeof mockIsModelBlockedByStoredPolicy> =>
    mockIsModelBlockedByStoredPolicy(model, owner),
}));

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (
    options: unknown,
  ): ReturnType<typeof mockResolveHelperWorkOwner> =>
    mockResolveHelperWorkOwner(options),
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
    task: () => Promise<unknown>;
  }): Promise<unknown> => mockEnqueueBackgroundHelperTask(options),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): unknown => mockWarn(...args),
}));

jest.mock('../memory/local/consolidation-task', () => ({
  runLocalMemoryConsolidation: (
    options: unknown,
  ): ReturnType<typeof mockRunLocalMemoryConsolidation> =>
    mockRunLocalMemoryConsolidation(options),
}));

jest.mock('../memory/local/consolidation-state', () => {
  const actual = jest.requireActual<typeof ConsolidationStateModule>(
    '../memory/local/consolidation-state',
  );
  return {
    ...actual,
    recordConsolidationRun: (
      scopeDir: string,
      outcome: RecordedOutcome,
    ): ReturnType<typeof mockRecordConsolidationRun> =>
      mockRecordConsolidationRun(scopeDir, outcome),
  };
});

jest.mock('../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: (...args: unknown[]): unknown =>
    mockBroadcast(...args),
}));

import type * as ConsolidationStateModule from '../memory/local/consolidation-state';
import type { RunConsolidationResult } from '../memory/local/consolidation-task';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/desktop-shared/types/local-memory';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
  isLocalMemoryConsolidationRunning,
  isLocalMemoryRebuildRunning,
  localMemoryConsolidationRunTrackerTestExports,
} from '../memory/local/consolidation-run-tracker';
import { runManualLocalMemoryConsolidation } from '../memory/local/manual-consolidation-trigger';

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]);

/** Asserts one recorded outcome: fields match and `at` is an ISO timestamp. */
function expectRecorded(
  scopeDir: string,
  outcome: Omit<RecordedOutcome, 'at'>,
): void {
  const match = mockRecordConsolidationRun.mock.calls.find(
    ([calledScopeDir, called]) =>
      calledScopeDir === scopeDir &&
      called.result === outcome.result &&
      called.reason === outcome.reason &&
      called.inputHash === outcome.inputHash,
  );
  expect(match).toBeDefined();
  expect(Number.isFinite(Date.parse(match?.[1].at ?? ''))).toBe(true);
}

describe('manual local memory consolidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    localMemoryConsolidationRunTrackerTestExports.reset();
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-sonnet-4-6',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });
    mockRunLocalMemoryConsolidation.mockResolvedValue({
      status: 'success',
      inputHash: 'a'.repeat(64),
    });
  });

  it('runs the production task immediately for the user scope and records success', async () => {
    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({ status: 'completed' });

    const queued = mockEnqueueBackgroundHelperTask.mock.calls[0]?.[0];
    expect(queued?.priority).toBe(3);
    expect(typeof queued?.task).toBe('function');
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith({
      scopeDir: '/memory/user',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      modelConfig: { thinkingLevel: 'off', speed: 'standard', fastMode: false },
    });
    expectRecorded('/memory/user', {
      result: 'success',
      inputHash: 'a'.repeat(64),
    });
    // Once when the run starts, once when it finishes.
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).toHaveBeenCalledWith({ scope: 'user' });
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
  });

  it('runs the production task immediately for a project scope', async () => {
    mockRunLocalMemoryConsolidation.mockResolvedValueOnce({
      status: 'clean',
      inputHash: 'b'.repeat(64),
    });

    await expect(
      runManualLocalMemoryConsolidation({
        scope: 'workspace',
        workspaceId: 'workspace-1',
      }),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'clean' });

    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith({
      scopeDir: '/memory/workspaces/workspace-1',
      workspaceId: 'workspace-1',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      modelConfig: { thinkingLevel: 'off', speed: 'standard', fastMode: false },
    });
    expectRecorded('/memory/workspaces/workspace-1', {
      result: 'skipped',
      reason: 'clean',
    });
    expect(mockBroadcast).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'workspace-1',
    });
  });

  it('maps an invalid production task outcome to a recorded failure', async () => {
    mockRunLocalMemoryConsolidation.mockResolvedValueOnce({
      status: 'invalid-output',
      reason: 'topicFiles: expected an array',
      inputHash: 'c'.repeat(64),
    });

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'invalid-output' });
    expectRecorded('/memory/user', {
      result: 'failed',
      reason: 'invalid-output',
    });
  });

  it('records the generation error message when the task fails', async () => {
    mockRunLocalMemoryConsolidation.mockResolvedValueOnce({
      status: 'failed',
      inputHash: 'c'.repeat(64),
      reason: 'Memory consolidation was skipped: this model is blocked.',
    });

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Memory consolidation was skipped: this model is blocked.',
    });
    expectRecorded('/memory/user', {
      result: 'failed',
      reason: 'Memory consolidation was skipped: this model is blocked.',
    });
  });

  it('records a thrown task error, releases the running guard, and still broadcasts', async () => {
    mockRunLocalMemoryConsolidation.mockRejectedValueOnce(
      new Error('provider unavailable'),
    );

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'provider unavailable',
    });
    expectRecorded('/memory/user', {
      result: 'failed',
      reason: 'provider unavailable',
    });
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
  });

  it('skips without running when local memory is disabled', async () => {
    mockReadPreferencesFile.mockResolvedValueOnce({
      localMemoryEnabled: false,
      localMemoryModel: 'claude-sonnet-4-6',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: 'local-memory-disabled',
    });
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expectRecorded('/memory/user', {
      result: 'skipped',
      reason: 'local-memory-disabled',
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('skips with a visible reason instead of switching models when the chosen model is unavailable', async () => {
    mockReadPreferencesFile.mockResolvedValueOnce({
      localMemoryEnabled: true,
      localMemoryModel: 'ollama-offline-model',
      localMemoryThinkingLevel: 'off',
      providerModelConfigDefaults: undefined,
    });

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      recorded: true,
    });
    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expectRecorded('/memory/user', {
      result: 'skipped',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
    expect(mockBroadcast).toHaveBeenCalledWith({ scope: 'user' });
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
  });

  it('skips before queueing when organization policy blocks the memory model for the scope', async () => {
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    await expect(
      runManualLocalMemoryConsolidation({
        scope: 'workspace',
        workspaceId: 'workspace-1',
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
      recorded: true,
    });
    expect(mockResolveHelperWorkOwner).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-sonnet-4-6',
      undefined,
    );
    expect(mockEnqueueBackgroundHelperTask).not.toHaveBeenCalled();
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expectRecorded('/memory/workspaces/workspace-1', {
      result: 'skipped',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });
    expect(
      isLocalMemoryConsolidationRunning('/memory/workspaces/workspace-1'),
    ).toBe(false);
  });

  it.each(['rebuild', 'restore'] as const)(
    'leaves the saved status alone when a %s owns the scope and the model is refused',
    async (kind) => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
      expect(beginLocalMemoryConsolidationRun('/memory/user', kind)).toBe(true);
      try {
        await expect(
          runManualLocalMemoryConsolidation({ scope: 'user' }),
        ).resolves.toMatchObject({
          status: 'skipped',
          reason: 'already-running',
          recorded: false,
        });
        expect(mockReadPreferencesFile).not.toHaveBeenCalled();
        expect(mockRecordConsolidationRun).not.toHaveBeenCalled();
        expect(mockBroadcast).not.toHaveBeenCalled();
        // The owner keeps the scope.
        expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(true);
        expect(isLocalMemoryRebuildRunning('/memory/user')).toBe(
          kind === 'rebuild',
        );
      } finally {
        endLocalMemoryConsolidationRun('/memory/user');
      }
    },
  );

  it('releases the scope when the preferences cannot be read', async () => {
    mockReadPreferencesFile.mockRejectedValueOnce(new Error('EACCES'));

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({ status: 'failed', recorded: false });
    expect(mockRecordConsolidationRun).not.toHaveBeenCalled();
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
  });

  describe('when preferences change while the run waits in the queue', () => {
    function changePreferencesWhileQueued(
      preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>,
    ): void {
      mockEnqueueBackgroundHelperTask.mockImplementationOnce(
        async (options) => {
          mockReadPreferencesFile.mockResolvedValue(preferences);
          return options.task();
        },
      );
    }

    it('runs with the model chosen meanwhile', async () => {
      changePreferencesWhileQueued({
        localMemoryEnabled: true,
        localMemoryModel: 'claude-haiku-4-5-20251001',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      });

      await expect(
        runManualLocalMemoryConsolidation({ scope: 'user' }),
      ).resolves.toMatchObject({ status: 'completed' });

      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
      expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });

    it('skips without running another model when the new choice cannot run', async () => {
      changePreferencesWhileQueued({
        localMemoryEnabled: true,
        localMemoryModel: 'ollama-offline-model',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      });

      await expect(
        runManualLocalMemoryConsolidation({ scope: 'user' }),
      ).resolves.toMatchObject({
        status: 'skipped',
        reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      });

      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expectRecorded('/memory/user', {
        result: 'skipped',
        reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      });
      expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
    });

    it('skips when memory was turned off meanwhile', async () => {
      changePreferencesWhileQueued({
        localMemoryEnabled: false,
        localMemoryModel: 'claude-sonnet-4-6',
        localMemoryThinkingLevel: 'off',
        providerModelConfigDefaults: undefined,
      });

      await expect(
        runManualLocalMemoryConsolidation({ scope: 'user' }),
      ).resolves.toMatchObject({
        status: 'skipped',
        reason: 'local-memory-disabled',
      });
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    });
  });

  it('does not start a second run for a scope that is already consolidating', async () => {
    let finish: (() => void) | undefined;
    mockRunLocalMemoryConsolidation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = (): void =>
            resolve({ status: 'success', inputHash: 'a'.repeat(64) });
        }),
    );
    const first = runManualLocalMemoryConsolidation({ scope: 'user' });
    // Wait for the first run to reach the task, past its model checks.
    while (finish === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(true);

    await expect(
      runManualLocalMemoryConsolidation({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: 'already-running',
      recorded: false,
    });
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);

    finish?.();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
    expect(mockRecordConsolidationRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcome when persisting the state fails', async () => {
    mockRecordConsolidationRun.mockRejectedValueOnce(new Error('EACCES'));

    const result = await runManualLocalMemoryConsolidation({ scope: 'user' });
    expect(result).toMatchObject({
      status: 'completed',
      recorded: true,
      outcome: { result: 'success', inputHash: 'a'.repeat(64) },
    });
    expect(Number.isFinite(Date.parse(result.finishedAt))).toBe(true);
    expect(mockRecordConsolidationRun).toHaveBeenCalledWith('/memory/user', {
      result: 'success',
      inputHash: 'a'.repeat(64),
      at: result.finishedAt,
    });
    expect(mockWarn).toHaveBeenCalledWith(
      'Local memory consolidation outcome was not saved',
      expect.objectContaining({ scopeDir: '/memory/user', error: 'EACCES' }),
    );
    expect(isLocalMemoryConsolidationRunning('/memory/user')).toBe(false);
  });
});
