import type {
  CanopyApi,
  ClaudeTerminalApi,
  ClaudeTerminalCleanupRequest,
  ClaudeTerminalErrorEvent,
  ClaudeTerminalLaunchRequest,
  ClaudeTerminalLaunchResponse,
  ClaudeTerminalRuntimeState,
  TerminalExitEvent,
  TranscriptSyncResult,
} from '@canopy/desktop-shared/types';
import type {
  ClaudeTerminalStoreState,
  ClaudeTerminalClientState,
} from '../claudeTerminalStore';
import type * as ClaudeTerminalStoreModule from '../claudeTerminalStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

interface FakeBridge {
  api: ClaudeTerminalApi;
  emitStateChanged: (state: ClaudeTerminalRuntimeState) => void;
  emitSyncCompleted: (result: TranscriptSyncResult) => void;
  emitError: (event: ClaudeTerminalErrorEvent) => void;
  emitTerminalExit: (event: TerminalExitEvent) => void;
  launchMock: jest.Mock<
    Promise<ClaudeTerminalLaunchResponse>,
    [ClaudeTerminalLaunchRequest]
  >;
  cleanupMock: jest.Mock<Promise<void>, [ClaudeTerminalCleanupRequest]>;
  interruptMock: jest.Mock<Promise<void>, [unknown]>;
  getStateMock: jest.Mock<
    Promise<ClaudeTerminalRuntimeState | undefined>,
    [string, string, string]
  >;
  listenerCount: () => number;
}

function makeBridge(): FakeBridge {
  const stateListeners = new Set<(s: ClaudeTerminalRuntimeState) => void>();
  const syncListeners = new Set<(s: TranscriptSyncResult) => void>();
  const errorListeners = new Set<(s: ClaudeTerminalErrorEvent) => void>();
  const exitListeners = new Set<(s: TerminalExitEvent) => void>();

  const launchMock = jest.fn<
    Promise<ClaudeTerminalLaunchResponse>,
    [ClaudeTerminalLaunchRequest]
  >();
  const cleanupMock = jest.fn<Promise<void>, [ClaudeTerminalCleanupRequest]>(
    () => Promise.resolve(undefined),
  );
  const interruptMock = jest.fn<Promise<void>, [unknown]>(() =>
    Promise.resolve(undefined),
  );
  const syncTranscriptMock = jest.fn(() =>
    Promise.resolve({ chatId: 'chat', importedEventCount: 0 }),
  );
  const getStateMock = jest.fn<
    Promise<ClaudeTerminalRuntimeState | undefined>,
    [string, string, string]
  >(() => Promise.resolve(undefined));

  const api: ClaudeTerminalApi = {
    launch: launchMock,
    cleanup: cleanupMock,
    interrupt: interruptMock,
    syncTranscript: syncTranscriptMock,
    getState: getStateMock,
    onStateChanged: (listener) => {
      stateListeners.add(listener);
      return (): void => {
        stateListeners.delete(listener);
      };
    },
    onSyncCompleted: (listener) => {
      syncListeners.add(listener);
      return (): void => {
        syncListeners.delete(listener);
      };
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return (): void => {
        errorListeners.delete(listener);
      };
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        claudeTerminal: api,
        terminal: {
          onExit: (listener: (event: TerminalExitEvent) => void) => {
            exitListeners.add(listener);
            return (): void => {
              exitListeners.delete(listener);
            };
          },
        },
      },
    },
  });

  return {
    api,
    emitStateChanged: (s) => stateListeners.forEach((listener) => listener(s)),
    emitSyncCompleted: (r) => syncListeners.forEach((listener) => listener(r)),
    emitError: (e) => errorListeners.forEach((listener) => listener(e)),
    emitTerminalExit: (e) => exitListeners.forEach((listener) => listener(e)),
    launchMock,
    cleanupMock,
    interruptMock,
    getStateMock,
    listenerCount: () =>
      stateListeners.size +
      syncListeners.size +
      errorListeners.size +
      exitListeners.size,
  };
}

describe('claudeTerminalStore', () => {
  let mod: typeof ClaudeTerminalStoreModule;
  let bridge: FakeBridge;

  beforeEach(() => {
    jest.resetModules();
    bridge = makeBridge();
    mod = jest.requireActual<typeof ClaudeTerminalStoreModule>(
      '../claudeTerminalStore',
    );
    mod.__resetClaudeTerminalStoreForTests();
    mod.initClaudeTerminalSubscriptions();
  });

  afterEach(() => {
    mod.__resetClaudeTerminalStoreForTests();
  });

  it('ensureLaunch fires the IPC once and shares the result for concurrent callers', async () => {
    const response: ClaudeTerminalLaunchResponse = {
      terminalId: 'term-1',
      sessionKey: 'sk-1',
      sdkSessionId: 'sdk-1',
      state: { turnState: 'idle' },
    };
    bridge.launchMock.mockResolvedValueOnce(response);
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    };
    const [a, b] = await Promise.all([
      mod.useClaudeTerminalStore.getState().ensureLaunch(request),
      mod.useClaudeTerminalStore.getState().ensureLaunch(request),
    ]);
    expect(bridge.launchMock).toHaveBeenCalledTimes(1);
    expect(a.terminalId).toBe('term-1');
    expect(b.terminalId).toBe('term-1');
    expect(a.launchStatus).toBe('ready');
  });

  it('ensureLaunch surfaces errors and lets the next call retry', async () => {
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    };
    bridge.launchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      mod.useClaudeTerminalStore.getState().ensureLaunch(request),
    ).rejects.toThrow('boom');

    const snapshot = mod.useClaudeTerminalStore
      .getState()
      .getStateForChat('p', 'w', 'c');
    expect(snapshot?.launchStatus).toBe('error');
    expect(snapshot?.errorMessage).toBe('boom');

    // Second attempt should make a fresh IPC call.
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-2',
      sessionKey: 'sk-2',
      sdkSessionId: 'sdk-2',
      state: { turnState: 'idle' },
    });
    const retried = await mod.useClaudeTerminalStore
      .getState()
      .ensureLaunch(request);
    expect(retried.launchStatus).toBe('ready');
    expect(bridge.launchMock).toHaveBeenCalledTimes(2);
  });

  it('routes state-changed events to the matching chat via terminalId', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-3',
      sessionKey: 'sk-3',
      sdkSessionId: 'sdk-3',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });

    bridge.emitStateChanged({
      terminalId: 'term-3',
      turnState: 'running',
      sessionKey: 'sk-3',
      sdkSessionId: 'sdk-3',
    });
    const snapshot = mod.useClaudeTerminalStore
      .getState()
      .getStateForChat('p', 'w', 'c');
    expect(snapshot?.turnState).toBe('running');
  });

  it('drops the per-chat snapshot after cleanup', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-4',
      sessionKey: 'sk-4',
      sdkSessionId: 'sdk-4',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });
    await mod.useClaudeTerminalStore
      .getState()
      .cleanup('p', 'w', 'c', 'manual');
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c'),
    ).toBeUndefined();
  });

  it('disposes all IPC subscriptions on teardown without leaking listeners', () => {
    expect(bridge.listenerCount()).toBeGreaterThan(0);
    mod.disposeClaudeTerminalSubscriptions();
    expect(bridge.listenerCount()).toBe(0);

    // Second dispose is idempotent.
    mod.disposeClaudeTerminalSubscriptions();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('transitions launchStatus to "idle" when the PTY exits', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-5',
      sessionKey: 'sk-5',
      sdkSessionId: 'sdk-5',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });
    bridge.emitTerminalExit({
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'term-5',
      exitCode: 0,
      signal: null,
    });
    const snapshot: ClaudeTerminalClientState | undefined =
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c');
    expect(snapshot?.turnState).toBe('exited');
    expect(snapshot?.launchStatus).toBe('idle');
  });

  it('store type is reachable from a state cast', () => {
    const state: ClaudeTerminalStoreState =
      mod.useClaudeTerminalStore.getState();
    expect(state.byChat).toEqual({});
  });

  it('locks the auto surface to the terminal between send dispatch and turn idle', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-6',
      sessionKey: 'sk-6',
      sdkSessionId: 'sdk-6',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });

    const surface = (): 'canopy' | 'terminal' =>
      mod.resolveChatInterfaceSurface(
        'auto',
        mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c'),
      );

    // Idle terminal with no pending send: auto shows the Canopy transcript.
    expect(surface()).toBe('canopy');

    // Dispatching a prompt locks the surface to the terminal immediately,
    // before any hook flips the turn-state to running.
    mod.useClaudeTerminalStore.getState().markAutoSendPending('p', 'w', 'c');
    expect(surface()).toBe('terminal');

    bridge.emitStateChanged({
      terminalId: 'term-6',
      turnState: 'running',
      sessionKey: 'sk-6',
      sdkSessionId: 'sdk-6',
    });
    expect(surface()).toBe('terminal');

    // The turn settling back to idle releases the surface to Canopy.
    bridge.emitStateChanged({
      terminalId: 'term-6',
      turnState: 'idle',
      sessionKey: 'sk-6',
      sdkSessionId: 'sdk-6',
    });
    expect(surface()).toBe('canopy');

    // A turn restart (e.g. a background task notification re-submitting a
    // user turn) flips the surface back to the terminal until it stops.
    bridge.emitStateChanged({
      terminalId: 'term-6',
      turnState: 'running',
      sessionKey: 'sk-6',
      sdkSessionId: 'sdk-6',
    });
    expect(surface()).toBe('terminal');
  });

  it('releases auto mode to Canopy immediately after a user interrupt', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-12',
      sessionKey: 'sk-12',
      sdkSessionId: 'sdk-12',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });
    const surface = (): 'canopy' | 'terminal' =>
      mod.resolveChatInterfaceSurface(
        'auto',
        mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c'),
      );

    mod.useClaudeTerminalStore.getState().markAutoSendPending('p', 'w', 'c');
    bridge.emitStateChanged({
      terminalId: 'term-12',
      turnState: 'running',
      sessionKey: 'sk-12',
      sdkSessionId: 'sdk-12',
    });
    expect(surface()).toBe('terminal');

    mod.useClaudeTerminalStore.getState().markUserInterrupted('p', 'w', 'c');
    expect(surface()).toBe('canopy');
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.turnState,
    ).toBe('idle');

    // A stale backend running echo after Ctrl-C must not re-pin auto mode.
    bridge.emitStateChanged({
      terminalId: 'term-12',
      turnState: 'running',
      sessionKey: 'sk-12',
      sdkSessionId: 'sdk-12',
    });
    expect(surface()).toBe('canopy');
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.turnState,
    ).toBe('idle');

    bridge.emitStateChanged({
      terminalId: 'term-12',
      turnState: 'idle',
      sessionKey: 'sk-12',
      sdkSessionId: 'sdk-12',
    });
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.userInterruptPending,
    ).toBe(false);
  });

  it('clears a stale user interrupt guard after the safety window', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      bridge.launchMock.mockResolvedValueOnce({
        terminalId: 'term-13',
        sessionKey: 'sk-13',
        sdkSessionId: 'sdk-13',
        state: { turnState: 'idle' },
      });
      await mod.useClaudeTerminalStore.getState().ensureLaunch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cols: 80,
        rows: 24,
      });
      mod.useClaudeTerminalStore.getState().markUserInterrupted('p', 'w', 'c');

      jest.setSystemTime(7_000);
      bridge.emitStateChanged({
        terminalId: 'term-13',
        turnState: 'running',
        sessionKey: 'sk-13',
        sdkSessionId: 'sdk-13',
      });

      const state = mod.useClaudeTerminalStore
        .getState()
        .getStateForChat('p', 'w', 'c');
      expect(state?.turnState).toBe('running');
      expect(state?.userInterruptPending).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves explicit modes independently of runtime state', () => {
    expect(mod.resolveChatInterfaceSurface('canopy', undefined)).toBe('canopy');
    expect(mod.resolveChatInterfaceSurface('claude-code', undefined)).toBe(
      'terminal',
    );
    expect(mod.resolveChatInterfaceSurface('auto', undefined)).toBe('canopy');
  });

  it('records initial prompt consumption from the launch response', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-7',
      sessionKey: 'sk-7',
      sdkSessionId: 'sdk-7',
      initialPromptSubmitted: true,
      state: { turnState: 'idle' },
    });
    const launched = await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      initialPrompt: 'first prompt',
      cols: 80,
      rows: 24,
    });
    expect(launched.lastLaunchConsumedInitialPrompt).toBe(true);
  });

  it('does not report a stale initial-prompt consumption when ensureLaunch reuses a live runtime', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-8',
      sessionKey: 'sk-8',
      sdkSessionId: 'sdk-8',
      initialPromptSubmitted: true,
      state: { turnState: 'idle' },
    });
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      initialPrompt: 'first prompt',
      cols: 80,
      rows: 24,
    };
    await mod.useClaudeTerminalStore.getState().ensureLaunch(request);

    // Main confirms the runtime is alive, so the snapshot is reusable.
    bridge.getStateMock.mockResolvedValue({
      terminalId: 'term-8',
      sessionKey: 'sk-8',
      sdkSessionId: 'sdk-8',
      turnState: 'idle',
      readyForInput: true,
    });

    // A later call early-returns on the live runtime without performing a
    // launch — its initialPrompt was NOT consumed, so the echo must not tell
    // the caller to drop a queued copy.
    const reused = await mod.useClaudeTerminalStore.getState().ensureLaunch({
      ...request,
      initialPrompt: 'second prompt',
    });
    expect(bridge.launchMock).toHaveBeenCalledTimes(1);
    expect(reused.lastLaunchConsumedInitialPrompt).toBe(false);
    expect(reused.readyForInput).toBe(true);
  });

  it('relaunches instead of reusing a ready snapshot when the runtime is gone from main', async () => {
    bridge.launchMock.mockResolvedValue({
      terminalId: 'term-10',
      sessionKey: 'sk-10',
      sdkSessionId: 'sdk-10',
      state: { turnState: 'idle' },
    });
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    };
    await mod.useClaudeTerminalStore.getState().ensureLaunch(request);

    // Main reports no live runtime (idle reaping / app restart): the ready
    // snapshot is stale, so ensureLaunch must perform a fresh launch instead
    // of handing the caller a dead terminal id.
    bridge.getStateMock.mockResolvedValue(undefined);
    await mod.useClaudeTerminalStore
      .getState()
      .ensureLaunch({ ...request, initialPrompt: 'after restart' });
    expect(bridge.launchMock).toHaveBeenCalledTimes(2);
    expect(bridge.launchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialPrompt: 'after restart' }),
    );
  });

  it('mirrors readyForInput from launch responses and state-changed events', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-9',
      sessionKey: 'sk-9',
      sdkSessionId: 'sdk-9',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });
    // Fresh spawn: no hook callback yet, so the CLI is not ready for input.
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.readyForInput,
    ).not.toBe(true);

    bridge.emitStateChanged({
      terminalId: 'term-9',
      turnState: 'idle',
      sessionKey: 'sk-9',
      sdkSessionId: 'sdk-9',
      readyForInput: true,
    });
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.readyForInput,
    ).toBe(true);
  });

  it('mirrors firstOutputAt from state-changed events and keeps it across later events', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-11',
      sessionKey: 'sk-11',
      sdkSessionId: 'sdk-11',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.firstOutputAt,
    ).toBeUndefined();

    bridge.emitStateChanged({
      terminalId: 'term-11',
      turnState: 'idle',
      sessionKey: 'sk-11',
      sdkSessionId: 'sdk-11',
      firstOutputAt: 1234,
    });
    expect(
      mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c')
        ?.firstOutputAt,
    ).toBe(1234);

    // A later event without the field (defensive) must not clear it.
    bridge.emitStateChanged({
      terminalId: 'term-11',
      turnState: 'running',
      sessionKey: 'sk-11',
      sdkSessionId: 'sdk-11',
    });
    const snapshot = mod.useClaudeTerminalStore
      .getState()
      .getStateForChat('p', 'w', 'c');
    expect(snapshot?.turnState).toBe('running');
    expect(snapshot?.firstOutputAt).toBe(1234);
  });

  it('keeps the auto surface on Canopy while an idle terminal is cleaned up', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-13',
      sessionKey: 'sk-13',
      sdkSessionId: 'sdk-13',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });

    // Settings-change restarts tear down hidden idle terminals; teardown
    // must not flash the terminal surface over the Canopy view.
    bridge.emitStateChanged({
      terminalId: 'term-13',
      turnState: 'cleaning_up',
      sessionKey: 'sk-13',
      sdkSessionId: 'sdk-13',
    });
    expect(
      mod.resolveChatInterfaceSurface(
        'auto',
        mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c'),
      ),
    ).toBe('canopy');
  });

  it('releases the auto-surface lock when clearAutoSendPending is called', async () => {
    bridge.launchMock.mockResolvedValueOnce({
      terminalId: 'term-12',
      sessionKey: 'sk-12',
      sdkSessionId: 'sdk-12',
      state: { turnState: 'idle' },
    });
    await mod.useClaudeTerminalStore.getState().ensureLaunch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    });

    mod.useClaudeTerminalStore.getState().markAutoSendPending('p', 'w', 'c');
    const surface = (): 'canopy' | 'terminal' =>
      mod.resolveChatInterfaceSurface(
        'auto',
        mod.useClaudeTerminalStore.getState().getStateForChat('p', 'w', 'c'),
      );
    expect(surface()).toBe('terminal');

    // A paste that never submits leaves the lock dangling; the manual mode
    // toggle clears it so auto lands back on the Canopy view.
    mod.useClaudeTerminalStore.getState().clearAutoSendPending('p', 'w', 'c');
    expect(surface()).toBe('canopy');
  });

  it('clears a pending auto send when the launch fails', async () => {
    mod.useClaudeTerminalStore.getState().markAutoSendPending('p', 'w', 'c');
    bridge.launchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      mod.useClaudeTerminalStore.getState().ensureLaunch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('boom');

    const snapshot = mod.useClaudeTerminalStore
      .getState()
      .getStateForChat('p', 'w', 'c');
    expect(snapshot?.autoSendPending).toBe(false);
    // The auto surface releases back to Canopy so the failure is visible.
    expect(mod.resolveChatInterfaceSurface('auto', snapshot)).toBe('canopy');
  });
});
