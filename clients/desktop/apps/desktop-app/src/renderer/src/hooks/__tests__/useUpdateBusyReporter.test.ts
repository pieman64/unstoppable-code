/**
 * @jest-environment jsdom
 */

type EffectCleanup = () => void;
type EffectCallback = () => void | EffectCleanup;
type StoreSubscriber = (state?: unknown, previousState?: unknown) => void;

let chatBusy = false;
let chatHasPendingQuestion = false;
let pipelineBusy = false;
let pipelineHydrated = true;
let pipelineHydrating = false;
let pipelinePending = false;
let pipelineQueued = false;
let pipelineStateReads = 0;
let gitBusy:
  | null
  | 'creatingPr'
  | 'committingAndPushing'
  | 'mergingLocalBranches'
  | 'mergingPr'
  | 'gitStatsRefreshing'
  | 'commitReviewPending' = null;
let effectCleanups: EffectCleanup[] = [];
let chatSubscribers: StoreSubscriber[] = [];
let pipelineSubscribers: StoreSubscriber[] = [];
let gitSubscribers: StoreSubscriber[] = [];

const reportBusyStateMock = jest.fn<Promise<void>, [boolean]>(() =>
  Promise.resolve(),
);

function emitChatChange(): void {
  for (const subscriber of [...chatSubscribers]) {
    subscriber();
  }
}

function emitPipelineChange(): void {
  const state = pipelineStateSnapshot();
  for (const subscriber of [...pipelineSubscribers]) {
    subscriber(state, {
      ...state,
      hasHydratedGlobalPipelineStatuses:
        !state.hasHydratedGlobalPipelineStatuses,
    });
  }
}

function emitPipelineOutputOnlyChange(): void {
  const state = pipelineStateSnapshot();
  for (const subscriber of [...pipelineSubscribers]) {
    subscriber(state, state);
  }
}

function emitGitChange(): void {
  for (const subscriber of [...gitSubscribers]) {
    subscriber();
  }
}

function resetHarness(): void {
  chatBusy = false;
  chatHasPendingQuestion = false;
  pipelineBusy = false;
  pipelineHydrated = true;
  pipelineHydrating = false;
  pipelinePending = false;
  pipelineQueued = false;
  pipelineStateReads = 0;
  gitBusy = null;
  effectCleanups = [];
  chatSubscribers = [];
  pipelineSubscribers = [];
  gitSubscribers = [];
  reportBusyStateMock.mockClear();
}

function setIfBusy(key: typeof gitBusy): Set<string> {
  return gitBusy === key ? new Set(['project/worktree']) : new Set<string>();
}

function pipelineStateSnapshot(): {
  hasHydratedGlobalPipelineStatuses: boolean;
  isHydratingGlobalPipelineStatuses: boolean;
  runningExecutionsByWorktree: Record<string, Set<string>>;
  pendingExecutions: Record<string, unknown[]>;
  queuedExecutionsByWorktree: Record<string, unknown[]>;
} {
  return {
    hasHydratedGlobalPipelineStatuses: pipelineHydrated,
    isHydratingGlobalPipelineStatuses: pipelineHydrating,
    runningExecutionsByWorktree: pipelineBusy
      ? { worktree: new Set(['execution-1']) }
      : {},
    pendingExecutions: pipelinePending
      ? { worktree: [{ localId: 'pending-1' }] }
      : {},
    queuedExecutionsByWorktree: pipelineQueued
      ? { worktree: [{ queueId: 'queued-1' }] }
      : {},
  };
}

async function loadHook(): Promise<{
  useUpdateBusyReporter: () => void;
}> {
  jest.resetModules();

  jest.doMock('react', () => ({
    useEffect: (effect: EffectCallback): void => {
      const cleanup = effect();
      if (cleanup) {
        effectCleanups.push(cleanup);
      }
    },
  }));

  jest.doMock('@/stores/chatStore', () => ({
    useChatStore: {
      getState: (): {
        worktreeChats: Record<
          string,
          { tabs: Array<{ id: string; status: string }> }
        >;
        pendingQuestions: Record<
          string,
          {
            projectId: string;
            worktreeId: string;
            chatId: string;
            answeredAt?: number;
          }
        >;
      } => ({
        worktreeChats: chatBusy
          ? {
              'project/worktree': {
                tabs: [{ status: 'streaming', id: 'chat-1' }],
              },
            }
          : {
              'project/worktree': {
                tabs: [{ status: 'idle', id: 'chat-1' }],
              },
            },
        pendingQuestions: chatHasPendingQuestion
          ? {
              'request-1': {
                projectId: 'project',
                worktreeId: 'worktree',
                chatId: 'chat-1',
              },
            }
          : {},
      }),
      subscribe: (subscriber: StoreSubscriber): EffectCleanup => {
        chatSubscribers.push(subscriber);
        return (): void => {
          chatSubscribers = chatSubscribers.filter(
            (candidate) => candidate !== subscriber,
          );
        };
      },
    },
  }));

  jest.doMock('@/stores/pipelineRunsStore', () => ({
    usePipelineRunsStore: {
      getState: (): {
        hasHydratedGlobalPipelineStatuses: boolean;
        isHydratingGlobalPipelineStatuses: boolean;
        runningExecutionsByWorktree: Record<string, Set<string>>;
        pendingExecutions: Record<string, unknown[]>;
        queuedExecutionsByWorktree: Record<string, unknown[]>;
      } => {
        pipelineStateReads += 1;
        return pipelineStateSnapshot();
      },
      subscribe: (subscriber: StoreSubscriber): EffectCleanup => {
        pipelineSubscribers.push(subscriber);
        return (): void => {
          pipelineSubscribers = pipelineSubscribers.filter(
            (candidate) => candidate !== subscriber,
          );
        };
      },
    },
  }));

  jest.doMock('@/stores/githubStore', () => ({
    useGitHubStore: {
      getState: (): {
        creatingPr: Set<string>;
        committingAndPushing: Set<string>;
        mergingLocalBranches: Set<string>;
        mergingPr: Set<string>;
        gitStatsRefreshing: Set<string>;
        commitReviewPending: Record<string, unknown>;
      } => ({
        creatingPr: setIfBusy('creatingPr'),
        committingAndPushing: setIfBusy('committingAndPushing'),
        mergingLocalBranches: setIfBusy('mergingLocalBranches'),
        mergingPr: setIfBusy('mergingPr'),
        gitStatsRefreshing: setIfBusy('gitStatsRefreshing'),
        commitReviewPending:
          gitBusy === 'commitReviewPending' ? { 'project/worktree': {} } : {},
      }),
      subscribe: (subscriber: StoreSubscriber): EffectCleanup => {
        gitSubscribers.push(subscriber);
        return (): void => {
          gitSubscribers = gitSubscribers.filter(
            (candidate) => candidate !== subscriber,
          );
        };
      },
    },
  }));

  return import('../useUpdateBusyReporter');
}

describe('useUpdateBusyReporter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetHarness();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        update: {
          reportBusyState: reportBusyStateMock,
        },
      },
    });
  });

  afterEach(() => {
    for (const cleanup of effectCleanups) {
      cleanup();
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.dontMock('react');
    jest.dontMock('@/stores/chatStore');
    jest.dontMock('@/stores/pipelineRunsStore');
    jest.dontMock('@/stores/githubStore');
  });

  it('reports the initial idle snapshot after subscription setup settles', async () => {
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();

    expect(reportBusyStateMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(0);

    expect(reportBusyStateMock).toHaveBeenCalledWith(false);
  });

  it('reports busy until global pipeline statuses hydrate', async () => {
    pipelineHydrated = false;
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);

    expect(reportBusyStateMock).toHaveBeenCalledWith(true);
    reportBusyStateMock.mockClear();

    pipelineHydrated = true;
    emitPipelineChange();
    await jest.advanceTimersByTimeAsync(199);

    expect(reportBusyStateMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(reportBusyStateMock).toHaveBeenCalledWith(false);
  });

  it('treats running, pending, and queued pipelines as busy', async () => {
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);
    reportBusyStateMock.mockClear();

    pipelineBusy = true;
    emitPipelineChange();

    expect(reportBusyStateMock).toHaveBeenCalledWith(true);
    reportBusyStateMock.mockClear();

    pipelineBusy = false;
    pipelinePending = true;
    emitPipelineChange();
    await jest.advanceTimersByTimeAsync(200);

    expect(reportBusyStateMock).not.toHaveBeenCalled();

    pipelinePending = false;
    pipelineQueued = true;
    emitPipelineChange();
    await jest.advanceTimersByTimeAsync(200);

    expect(reportBusyStateMock).not.toHaveBeenCalled();

    pipelineQueued = false;
    emitPipelineChange();
    await jest.advanceTimersByTimeAsync(200);

    expect(reportBusyStateMock).toHaveBeenCalledWith(false);
  });

  it('ignores output-only pipeline store updates', async () => {
    pipelineBusy = true;
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);
    pipelineStateReads = 0;
    reportBusyStateMock.mockClear();

    emitPipelineOutputOnlyChange();

    expect(pipelineStateReads).toBe(0);
    expect(reportBusyStateMock).not.toHaveBeenCalled();
  });

  it.each([
    'creatingPr',
    'committingAndPushing',
    'mergingLocalBranches',
    'mergingPr',
    'gitStatsRefreshing',
    'commitReviewPending',
  ] as const)('treats %s git work as busy', async (busyField) => {
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);
    reportBusyStateMock.mockClear();

    gitBusy = busyField;
    emitGitChange();

    expect(reportBusyStateMock).toHaveBeenCalledWith(true);
    reportBusyStateMock.mockClear();

    gitBusy = null;
    emitGitChange();
    await jest.advanceTimersByTimeAsync(199);

    expect(reportBusyStateMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(reportBusyStateMock).toHaveBeenCalledWith(false);
  });

  it('reports busy transitions immediately and cancels pending idle reports', async () => {
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);
    reportBusyStateMock.mockClear();

    chatBusy = true;
    emitChatChange();

    expect(reportBusyStateMock).toHaveBeenCalledTimes(1);
    expect(reportBusyStateMock).toHaveBeenLastCalledWith(true);

    chatBusy = false;
    emitChatChange();
    await jest.advanceTimersByTimeAsync(199);

    expect(reportBusyStateMock).toHaveBeenCalledTimes(1);

    chatBusy = true;
    emitChatChange();
    await jest.advanceTimersByTimeAsync(200);

    expect(reportBusyStateMock).toHaveBeenCalledTimes(1);
    expect(reportBusyStateMock).toHaveBeenLastCalledWith(true);
  });

  it('treats a streaming chat with a pending question as idle', async () => {
    chatBusy = true;
    chatHasPendingQuestion = true;
    const { useUpdateBusyReporter } = await loadHook();

    useUpdateBusyReporter();
    await jest.advanceTimersByTimeAsync(0);

    expect(reportBusyStateMock).toHaveBeenCalledWith(false);
    reportBusyStateMock.mockClear();

    chatHasPendingQuestion = false;
    emitChatChange();

    expect(reportBusyStateMock).toHaveBeenCalledWith(true);
  });
});
